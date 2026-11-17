import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SYSTEM, type Agent, type Limits, type OfficeEvent, type Project } from '../shared/types'
import type { McpToolbox } from './mcp'
import { allowRule, isAllowed, Office, type OfficeDeps, type SkillInfo } from './office'
import type { Chat, ChatOpts, StepOpts, ToolCall, ToolResult, Turn } from './providers'

const agent = (id: string, reportsTo: string | null, extra: Partial<Agent> = {}): Agent => ({
  id,
  name: id,
  title: id,
  department: '',
  reportsTo,
  instructions: '',
  providerId: 'p',
  model: 'm',
  tools: ['read_file', 'write_file', 'edit_file', 'run_command', 'web_fetch'],
  ...extra
})
const call = (name: string, input: Record<string, unknown>): ToolCall => ({ id: Math.random().toString(36).slice(2), name, input })
const report = (summary: string): Partial<Turn> => ({ calls: [call('report_to_user', { summary })] })
const usage = (n: number) => ({ in: n, cacheRead: 0, cacheWrite: 0, out: 1000 })
const apiError = (status: number, error: unknown) => Object.assign(new Error(`${status} error`), { status, error, headers: new Headers() })
const limits = (l: Partial<Limits>): Limits => ({ maxRequests: 0, maxChatter: 0, compactAt: 0, ...l })

type Step = (input: string | undefined, results: ToolResult[], opts?: StepOpts) => Partial<Turn> | Promise<Partial<Turn>>
interface Opened {
  name: string
  system: string
  tools: string[]
  opts?: ChatOpts
}

function setup(agents: Agent[], scripts: Record<string, Step>, extra: Partial<Project> = {}, deps: Partial<OfficeDeps> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guards-'))
  const events: OfficeEvent[] = []
  const opened: Opened[] = []
  const project: Project = { id: 'x', name: 'Acme', workspaceDir: dir, briefing: 'b', approval: 'auto', budgetUsd: 0, agents, ...extra }
  const office = new Office(project, {
    conn: () => ({ kind: 'openai', baseURL: '', apiKey: '' }),
    charge: (_p, _m, u) => (u.in + u.out) / 1e6,
    readNotes: () => '',
    appendNote: () => {},
    emit: (e) => events.push(e),
    sleep: async () => {},
    openChat: (_c, _m, system, tools, opts): Chat => {
      const name = /^You are (\w+),/.exec(system)![1]
      opened.push({ name, system, tools: tools.map((t) => t.name), opts })
      return {
        step: async (results, input, o) => ({ text: '', calls: [], usage: usage(1000), ...(await scripts[name](input, results, o)) })
      }
    },
    ...deps
  })
  return { office, events, opened, dir, project }
}

async function until(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 2))
  }
}

const of = <T extends OfficeEvent['type']>(events: OfficeEvent[], type: T) => events.filter((e): e is Extract<OfficeEvent, { type: T }> => e.type === type)
const lastRun = (events: OfficeEvent[]) => of(events, 'run').at(-1)

describe('chatter guard', () => {
  it('stops a ping-pong at exactly the threshold (a forwarded reply counts as a message)', async () => {
    const { office, events } = setup([agent('ceo', null), agent('dev', 'ceo')], {
      ceo: (input) => (input ? { calls: [call('message', { to: ['dev'], text: 'status?' })] } : {}),
      dev: (input) => (input ? { text: 'all fine' } : {})
    }, { limits: limits({ maxChatter: 4 }) })
    office.start('go')
    await until(() => !office.isRunning)
    const chat = of(events, 'message').filter((e) => e.from !== 'user' && e.from !== SYSTEM)
    expect(chat).toHaveLength(4)
    expect(lastRun(events)).toMatchObject({ state: 'stopped', reason: 'loop', agents: ['dev', 'ceo'] })
  })

  it('does not stop a manager/report review cycle in which files are read and written', async () => {
    let round = 0
    const { office, events } = setup([agent('ceo', null), agent('dev', 'ceo')], {
      ceo: (input) => {
        if (input?.includes('[From the owner]')) return { calls: [call('message', { to: ['dev'], text: 'write out.txt' })] }
        if (!input?.includes('[From dev')) return {}
        if (++round < 6) return { calls: [call('read_file', { path: 'out.txt' }), call('message', { to: ['dev'], text: 'fix it' })] }
        return report('done')
      },
      dev: (input) => (input ? { calls: [call('write_file', { path: 'out.txt', content: `v${round}` }), call('message', { to: ['ceo'], text: 'updated' })] } : {})
    }, { limits: limits({ maxChatter: 3 }) })
    office.start('go')
    await until(() => !office.isRunning)
    expect(round).toBe(6)
    expect(lastRun(events)).toMatchObject({ state: 'done', reason: 'report' })
  })
})

describe('request cap and budget', () => {
  it('stops when the request cap is reached', async () => {
    let n = 0
    const { office, events } = setup([agent('ceo', null)], {
      ceo: () => {
        n++
        return { calls: [call('read_file', { path: 'nope' })] }
      }
    }, { limits: limits({ maxRequests: 3 }) })
    office.start('loop')
    await until(() => !office.isRunning)
    expect(n).toBe(3)
    expect(office.requests).toBe(3)
    expect(lastRun(events)).toMatchObject({ state: 'stopped', reason: 'limit', requests: 3 })
    // The owner can continue: the cap counts from their latest message.
    office.post('keep going')
    await until(() => !office.isRunning)
    expect(n).toBe(6)
    expect(lastRun(events)).toMatchObject({ state: 'stopped', reason: 'limit', requests: 3 })
  })

  it('counts a request without a price at the estimate, so the budget still stops the work', async () => {
    let n = 0
    const { office, events } = setup([agent('ceo', null)], {
      ceo: () => {
        n++
        return { calls: [call('read_file', { path: 'nope' })] }
      }
    }, { budgetUsd: 0.03 }, { charge: () => null })
    office.start('loop')
    await until(() => !office.isRunning)
    // 1000 in + 1000 out at $3 / $15 per 1M = $0.018 a request: the second one passes $0.03.
    expect(n).toBe(2)
    expect(of(events, 'cost').map((e) => [e.usd, e.est])).toEqual([[null, 0.018], [null, 0.018]])
    expect(lastRun(events)).toMatchObject({ state: 'stopped', reason: 'budget' })
  })

  it('refuses new work once the budget is spent; raising it with configure() continues the run', async () => {
    const { office, events, project } = setup([agent('ceo', null)], {
      ceo: (input) => (input?.includes('more') ? report('finished') : { calls: [call('read_file', { path: 'nope' })] })
    }, { budgetUsd: 0.004 })
    office.start('loop')
    await until(() => !office.isRunning)
    expect(lastRun(events)).toMatchObject({ state: 'stopped', reason: 'budget' })
    expect(office.spentUsd).toBeCloseTo(0.004)
    const costs = of(events, 'cost').length
    expect(() => office.post('more')).toThrow('E_BUDGET_SPENT|0.004')
    expect(of(events, 'cost')).toHaveLength(costs)
    office.configure({ ...project, budgetUsd: 1 })
    office.post('more')
    await until(() => !office.isRunning)
    expect(lastRun(events)).toMatchObject({ state: 'done', reason: 'report' })
  })
})

describe('stop', () => {
  it('aborts an in-flight request, which is neither retried nor charged; the next run gets a fresh signal', async () => {
    const signals: AbortSignal[] = []
    const { office, events } = setup([agent('ceo', null)], {
      ceo: (_input, _results, o) => {
        signals.push(o!.signal!)
        if (signals.length > 1) return { text: 'ok' }
        return new Promise((_, reject) =>
          o!.signal!.addEventListener('abort', () => reject(Object.assign(new Error('Request was aborted.'), { name: 'AbortError' })))
        )
      }
    })
    office.start('go')
    await until(() => signals.length === 1)
    office.stop()
    expect(signals[0].aborted).toBe(true)
    await until(() => of(events, 'status').at(-1)?.status === 'idle')
    expect(signals).toHaveLength(1)
    expect(of(events, 'notice')).toHaveLength(0)
    expect(of(events, 'blocked')).toHaveLength(0)
    expect(of(events, 'cost')).toHaveLength(0)
    expect(lastRun(events)).toMatchObject({ state: 'stopped', reason: 'owner_stopped' })

    office.post('again')
    await until(() => !office.isRunning)
    expect(signals).toHaveLength(2)
    expect(signals[1].aborted).toBe(false)
    expect(of(events, 'cost')).toHaveLength(1)
  })

  it.skipIf(process.platform === 'win32')('kills a running command', async () => {
    const { office, events } = setup([agent('ceo', null)], {
      ceo: (input) => (input ? { calls: [call('run_command', { command: 'sleep 30' })] } : {})
    })
    office.start('go')
    await until(() => of(events, 'status').some((e) => e.status === 'working'))
    await new Promise((r) => setTimeout(r, 100))
    const t = Date.now()
    office.stop()
    await until(() => of(events, 'tool').length === 1)
    expect(Date.now() - t).toBeLessThan(3000)
    expect(of(events, 'tool')[0].detail).toContain('[stopped]')
  })

  it('report_to_user declines pending approvals, unblocks members and clears live replies', async () => {
    const streamed: [string, string | null][] = []
    let devResult = ''
    const { office, events } = setup(
      [agent('ceo', null), agent('dev', 'ceo'), agent('qa', 'ceo')],
      {
        ceo: (input) =>
          input?.includes('wrap up') ? report('final') : input?.includes('[From the owner]') ? { calls: [call('message', { to: ['dev', 'qa'], text: 'work' })] } : {},
        dev: (input, results) => {
          if (input) return { calls: [call('run_command', { command: 'echo hi' })] }
          devResult = results[0]?.content ?? ''
          return {}
        },
        qa: () => {
          throw apiError(401, { error: { type: 'authentication_error' } })
        }
      },
      { approval: 'ask' },
      { stream: (id, text) => streamed.push([id, text]) }
    )
    office.start('go')
    await until(() => of(events, 'approval').length === 1 && of(events, 'blocked').length === 1)
    const approval = of(events, 'approval')[0]
    office.post('wrap up')
    await until(() => !office.isRunning)
    expect(lastRun(events)).toMatchObject({ state: 'done', reason: 'report' })
    expect(of(events, 'approval_done')).toEqual([expect.objectContaining({ id: approval.id, approved: false })])
    expect(of(events, 'unblocked')).toHaveLength(1)
    expect(streamed).toContainEqual(['dev', null])
    expect(streamed).toContainEqual(['qa', null])
    await until(() => devResult !== '' || of(events, 'status').filter((e) => e.agentId === 'dev').at(-1)?.status === 'idle')
    // A late answer does nothing and does not throw.
    office.answer(approval.id, true, true)
    expect(of(events, 'approval_done')).toHaveLength(1)
  })
})

describe('plan mode', () => {
  it('keeps the CEO to reading until the owner approves a plan', async () => {
    const firstResults: ToolResult[] = []
    const { office, events, opened, dir } = setup(
      [agent('ceo', null), agent('dev', 'ceo')],
      {
        ceo: (input, results) => {
          if (input?.includes('Go ahead')) return { calls: [call('message', { to: ['dev'], text: 'build it' })] }
          if (input?.includes('needs changes')) return { calls: [call('propose_plan', { text: 'P2' }), call('propose_plan', { text: 'P3' })] }
          if (input?.includes('[From dev')) return report('done')
          if (input)
            return {
              calls: [
                call('message', { to: ['dev'], text: 'start' }),
                call('write_file', { path: 'a.txt', content: 'a' }),
                call('run_command', { command: 'echo hi' }),
                call('read_file', { path: 'r.txt' }),
                call('message', { to: ['owner'], text: 'reading first' }),
                call('propose_plan', { text: 'P1' })
              ]
            }
          if (!firstResults.length) firstResults.push(...results)
          return {}
        },
        dev: (input) => (input ? { text: 'built' } : {})
      },
      { planFirst: true }
    )
    fs.writeFileSync(path.join(dir, 'r.txt'), 'readme')
    office.start('goal')
    await until(() => !office.isRunning)
    expect(lastRun(events)).toMatchObject({ state: 'done', reason: 'plan' })
    const gate = "Propose your plan with propose_plan and wait for the owner's approval first"
    expect(firstResults.map((r) => r.content)).toEqual([gate, gate, gate, 'readme', 'Sent', 'Plan sent to the owner. End your turn now and wait for their answer.'])
    expect(fs.existsSync(path.join(dir, 'a.txt'))).toBe(false)
    expect(of(events, 'tool').find((e) => e.name === 'propose_plan')?.detail).toBeUndefined()
    expect(opened.find((o) => o.name === 'ceo')!.tools).toContain('propose_plan')

    const p1 = of(events, 'plan')[0]
    expect(p1).toMatchObject({ agentId: 'ceo', text: 'P1' })
    office.answerPlan(p1.id, false, 'add tests')
    await until(() => !office.isRunning)
    const [, p2, p3] = of(events, 'plan')
    expect(of(events, 'plan_done')).toEqual([
      expect.objectContaining({ id: p1.id, approved: false, feedback: 'add tests' }),
      expect.objectContaining({ id: p2.id, approved: false })
    ])
    expect(lastRun(events)).toMatchObject({ reason: 'plan' })

    office.answerPlan(p2.id, true) // replaced: ignored
    expect(office.isRunning).toBe(false)
    office.answerPlan(p3.id, true)
    await until(() => !office.isRunning)
    expect(of(events, 'plan_done').at(-1)).toMatchObject({ id: p3.id, approved: true })
    expect(of(events, 'message').some((e) => e.from === 'ceo' && e.to[0] === 'dev' && e.text === 'build it')).toBe(true)
    expect(lastRun(events)).toMatchObject({ state: 'done', reason: 'report' })
    expect(opened.find((o) => o.name === 'dev')!.tools).not.toContain('propose_plan')
  })

  it('offers no propose_plan without planFirst', async () => {
    let result = ''
    const { office, opened } = setup([agent('ceo', null)], {
      ceo: (input, results) => {
        if (input) return { calls: [call('propose_plan', { text: 'P' })] }
        result = results[0]?.content ?? ''
        return {}
      }
    })
    office.start('go')
    await until(() => !office.isRunning)
    expect(opened[0].tools).not.toContain('propose_plan')
    expect(result).toMatch(/not available/)
  })
})

describe('approvals', () => {
  it('matches allow-list entries by whole words and never with shell control characters', () => {
    const list = ['npm test', ' git  status ', 'mcp:srv › read', 'fetch:localhost:3000', '']
    expect(isAllowed(list, 'command', 'npm test')).toBe(true)
    expect(isAllowed(list, 'command', '  npm   test -- --run ')).toBe(true)
    expect(isAllowed(list, 'command', 'git status')).toBe(true)
    expect(isAllowed(list, 'command', 'npm testing')).toBe(false)
    expect(isAllowed(list, 'command', 'npm')).toBe(false)
    expect(isAllowed(list, 'command', 'rm -rf /')).toBe(false)
    for (const bad of ['npm test; rm x', 'npm test && rm x', 'npm test | sh', 'npm test `rm x`', 'npm test $(rm x)', 'npm test > f', 'npm test < f', 'npm test\nrm x', 'npm test\rrm x', 'npm test {a}', 'npm test (x)', 'npm test & x'])
      expect(isAllowed(list, 'command', bad)).toBe(false)
    expect(isAllowed(list, 'command', 'mcp:srv › read')).toBe(false)
    expect(isAllowed(list, 'mcp', 'srv › read')).toBe(true)
    expect(isAllowed(list, 'mcp', 'srv › write')).toBe(false)
    expect(isAllowed(list, 'fetch', 'localhost:3000')).toBe(true)
    expect(isAllowed(list, 'fetch', 'localhost')).toBe(false)
    expect(isAllowed(list, 'fetch', '')).toBe(false)
    expect(allowRule('command', '  npm   run build ')).toBe('npm run build')
    expect(allowRule('command', 'npm test; rm x')).toBeUndefined()
    expect(allowRule('mcp', 'srv › read')).toBe('mcp:srv › read')
    expect(allowRule('fetch', 'example.com')).toBe('fetch:example.com')
  })

  it('"always" grows the allow list; files changed since the last approved command are shown', async () => {
    const allowed: string[] = []
    let step = 0
    const { office, events } = setup(
      [agent('ceo', null)],
      {
        ceo: () => {
          step++
          if (step === 1) return { calls: [call('write_file', { path: 'src/a.txt', content: 'a' }), call('run_command', { command: 'echo bye' })] }
          if (step === 2) return { calls: [call('run_command', { command: 'echo bye now' }), call('run_command', { command: 'echo x; echo y' })] }
          if (step === 3) return { calls: [call('run_command', { command: 'echo hi there' })] }
          return { text: 'done' }
        }
      },
      { approval: 'ask', allowCommands: ['echo hi'] },
      { allow: (r) => allowed.push(r) }
    )
    office.start('go')
    await until(() => of(events, 'approval').length === 1)
    const first = of(events, 'approval')[0]
    expect(first).toMatchObject({ kind: 'command', command: 'echo bye', files: ['src/a.txt'] })
    expect(first.sandbox).toBeUndefined()
    office.answer(first.id, true, true)
    expect(allowed).toEqual(['echo bye'])
    expect(of(events, 'approval_done')[0]).toMatchObject({ id: first.id, approved: true, always: true })

    await until(() => of(events, 'approval').length === 2)
    const second = of(events, 'approval')[1]
    expect(second).toMatchObject({ command: 'echo x; echo y' })
    expect(second.files).toBeUndefined()
    office.answer(second.id, true, true)
    expect(allowed).toEqual(['echo bye']) // control characters: never allowed for good
    expect(of(events, 'approval_done')[1].always).toBeUndefined()

    office.answer('unknown', true)
    await until(() => !office.isRunning)
    expect(of(events, 'approval')).toHaveLength(2)
    expect(of(events, 'approval_done')).toHaveLength(2)
    expect(of(events, 'tool').filter((e) => e.name === 'run_command')).toHaveLength(4)
  })

  it('marks commands that run in the Docker sandbox', async () => {
    const { office, events } = setup([agent('ceo', null)], { ceo: (input) => (input?.includes('[From the owner]') ? { calls: [call('run_command', { command: 'ls' })] } : {}) }, {
      approval: 'ask',
      sandbox: { kind: 'docker', image: 'node:22', network: false }
    })
    office.start('go')
    await until(() => of(events, 'approval').length === 1)
    expect(of(events, 'approval')[0].sandbox).toBe(true)
    office.answer(of(events, 'approval')[0].id, false)
    await until(() => !office.isRunning)
  })

  it('asks before fetching from this computer and remembers the host', async () => {
    const server = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/plain' }).end('local page'))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/x`
    const allowed: string[] = []
    const seen: string[] = []
    let step = 0
    const { office, events } = setup(
      [agent('ceo', null)],
      {
        ceo: (_i, results) => {
          seen.push(...results.map((r) => r.content))
          return ++step <= 2 ? { calls: [call('web_fetch', { url })] } : {}
        }
      },
      { approval: 'ask' },
      { allow: (r) => allowed.push(r) }
    )
    try {
      office.start('go')
      await until(() => of(events, 'approval').length === 1)
      expect(of(events, 'approval')[0]).toMatchObject({ kind: 'fetch', command: url })
      office.answer(of(events, 'approval')[0].id, true, true)
      await until(() => !office.isRunning)
      expect(allowed).toEqual([`fetch:${new URL(url).host}`])
      expect(of(events, 'approval')).toHaveLength(1)
      expect(seen.filter((s) => s.includes('local page'))).toHaveLength(2)
    } finally {
      server.close()
    }
  })
})

describe('MCP', () => {
  const toolbox = (call: McpToolbox['call']): McpToolbox => ({
    defs: [{ name: 'srv__big', description: 'big', parameters: { type: 'object', properties: {}, required: [] } }],
    errors: [],
    has: (n) => n === 'srv__big',
    label: () => 'srv › big',
    call
  })

  it('clips results and honours an mcp: allow-list entry', async () => {
    let got: ToolResult | undefined
    const { office, events } = setup(
      [agent('ceo', null, { mcpServers: ['srv'] })],
      {
        ceo: (input, results) => {
          if (input) return { calls: [call('srv__big', {})] }
          got = results[0]
          return {}
        }
      },
      { approval: 'ask', allowCommands: ['mcp:srv › big'] },
      { mcp: async () => toolbox(async () => ({ content: 'x'.repeat(50_000), isError: false })) }
    )
    office.start('go')
    await until(() => !office.isRunning)
    expect(of(events, 'approval')).toHaveLength(0)
    expect(got!.content.length).toBeLessThan(20_100)
    expect(got!.content).toContain('more characters truncated')
  })

  it('stop ends a hanging MCP call', async () => {
    let got: ToolResult | undefined
    const { office, events } = setup(
      [agent('ceo', null, { mcpServers: ['srv'] })],
      {
        ceo: (input, results) => {
          if (input) return { calls: [call('srv__big', {})] }
          got = results[0]
          return {}
        }
      },
      {},
      { mcp: async () => toolbox(() => new Promise(() => {})) }
    )
    office.start('go')
    await until(() => of(events, 'status').some((e) => e.status === 'working'))
    await new Promise((r) => setTimeout(r, 20))
    office.stop()
    await until(() => of(events, 'tool').length === 1)
    expect(of(events, 'tool')[0]).toMatchObject({ name: 'srv__big', summary: 'srv › big', ok: false, detail: 'Stopped' })
    expect(got).toBeUndefined()
  })
})

describe('context', () => {
  it('summarizes and restarts a long conversation, keeping pending tool results and input', async () => {
    const inputs: (string | undefined)[] = []
    const resultsSeen: ToolResult[][] = []
    const { office, events, opened, dir } = setup([agent('ceo', null)], {
      ceo: (input, results) => {
        inputs.push(input)
        resultsSeen.push(results)
        switch (inputs.length) {
          case 1:
            return { calls: [call('read_file', { path: 'r.txt' })], usage: usage(6000) }
          case 2:
            return { text: 'SUMMARY: read r.txt', usage: usage(6000) }
          default:
            return report('done')
        }
      }
    }, { limits: limits({ compactAt: 5000 }) })
    fs.writeFileSync(path.join(dir, 'r.txt'), 'data')
    office.start('go')
    await until(() => !office.isRunning)
    expect(inputs[1]).toContain('Write a complete summary of your work so far')
    expect(resultsSeen[1].map((r) => r.content)).toEqual(['data'])
    expect(inputs[2]).toMatch(/^Summary of your work so far \(your earlier conversation was compacted\):\n\nSUMMARY: read r.txt$/)
    expect(opened).toHaveLength(2)
    expect(of(events, 'compact')).toEqual([expect.objectContaining({ agentId: 'ceo', tokens: 6000 })])
    expect(of(events, 'cost')).toHaveLength(3)
    expect(lastRun(events)).toMatchObject({ reason: 'report' })
  })

  it('uses the work log when the summary is empty, and passes on the owner\'s new message', async () => {
    const inputs: (string | undefined)[] = []
    const { office } = setup([agent('ceo', null)], {
      ceo: (input) => {
        inputs.push(input)
        if (inputs.length === 1) return { text: 'ok', usage: usage(9000) }
        return {}
      }
    }, { limits: limits({ compactAt: 5000 }) })
    office.start('first')
    await until(() => !office.isRunning)
    office.post('second')
    await until(() => !office.isRunning)
    expect(inputs[1]).toContain('Write a complete summary')
    expect(inputs[2]).toContain('Your conversation got too long')
    expect(inputs[2]).toContain('[From the owner] first')
    expect(inputs[2]).toContain('[From the owner] second')
  })

  it('a context error restarts from the work log once; a second one blocks', async () => {
    const inputs: (string | undefined)[] = []
    const { office, events, opened } = setup([agent('ceo', null)], {
      ceo: (input) => {
        inputs.push(input)
        throw apiError(400, { error: { message: 'prompt is too long: 250000 tokens > 200000 maximum' } })
      }
    })
    office.start('task')
    await until(() => of(events, 'blocked').length === 1)
    expect(of(events, 'compact')).toHaveLength(1)
    expect(opened).toHaveLength(2)
    expect(inputs[1]).toContain('Your conversation got too long')
    expect(inputs[1]).toContain('[From the owner] task')
    expect(of(events, 'blocked')[0]).toMatchObject({ kind: 'context', model: 'm' })
  })
})

describe('members', () => {
  it('passes effort/maxTokens, filters skills per member and streams live replies', async () => {
    const skills: SkillInfo[] = [
      { name: 'alpha', description: 'A skill', body: 'a' },
      { name: 'beta', description: 'B skill', body: 'b' }
    ]
    const streamed: [string, string | null][] = []
    let ceoResults: ToolResult[] = []
    const { office, opened } = setup(
      [agent('ceo', null, { skills: ['beta'], effort: 'high', maxTokens: 1234 }), agent('dev', 'ceo', { skills: [] }), agent('qa', 'ceo')],
      {
        ceo: (input, results, o) => {
          o?.onText?.('Hel')
          o?.onText?.('Hello')
          if (input) return { calls: [call('use_skill', { name: 'alpha' }), call('use_skill', { name: 'beta' }), call('message', { to: ['dev', 'qa'], text: 'hi' })] }
          if (results.length) ceoResults = results
          return {}
        },
        dev: () => ({}),
        qa: () => ({})
      },
      {},
      { skills: () => skills, stream: (id, t) => streamed.push([id, t]) }
    )
    office.start('go')
    await until(() => !office.isRunning)
    const by = (n: string) => opened.find((o) => o.name === n)!
    expect(by('ceo').opts).toEqual({ effort: 'high', maxTokens: 1234 })
    expect(by('ceo').system).toContain('- beta: B skill')
    expect(by('ceo').system).not.toContain('- alpha:')
    expect(by('ceo').tools).toContain('use_skill')
    expect(by('dev').system).not.toContain('# Skills')
    expect(by('dev').tools).not.toContain('use_skill')
    expect(by('qa').system).toContain('- alpha: A skill')
    expect(ceoResults.map((r) => r.content.slice(0, 20))).toEqual(['No skill named "alph', 'b', 'Sent'])
    expect(streamed.slice(0, 3)).toEqual([['ceo', 'Hel'], ['ceo', 'Hello'], ['ceo', null]])
  })

  it('tool events carry the start of the result and the clipped diff', async () => {
    const big = Array.from({ length: 300 }, (_, i) => `line ${i} `.padEnd(50, 'x')).join('\n')
    const { office, events, dir } = setup([agent('ceo', null)], {
      ceo: (input) =>
        input
          ? {
              calls: [
                call('read_file', { path: 'long.txt' }),
                call('edit_file', { path: 'note.txt', old_text: 'hello', new_text: 'bye' }),
                call('edit_file', { path: 'big.txt', old_text: big, new_text: big.replace(/x/g, 'y') })
              ]
            }
          : {}
    })
    fs.writeFileSync(path.join(dir, 'long.txt'), 'z'.repeat(3000))
    fs.writeFileSync(path.join(dir, 'note.txt'), 'hello\n')
    fs.writeFileSync(path.join(dir, 'big.txt'), big)
    office.start('go')
    await until(() => !office.isRunning)
    const [read, edit, bigEdit] = of(events, 'tool')
    expect(read.detail).toBe('z'.repeat(2000))
    expect(read.diff).toBeUndefined()
    expect(edit.detail).toBe('Edited note.txt')
    expect(edit.diff).toContain('-hello')
    expect(edit.diff).toContain('+bye')
    expect(bigEdit.diff!.length).toBeLessThan(8100)
    expect(bigEdit.diff).toContain('more characters truncated')
  })

  it('reports a missing Docker once per run', async () => {
    const saved = process.env.PATH
    process.env.PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'nopath-'))
    try {
      const { office, events } = setup([agent('ceo', null)], {
        ceo: (input) => (input?.includes('[From the owner]') ? { calls: [call('run_command', { command: 'ls' }), call('run_command', { command: 'ls' })] } : {})
      }, { sandbox: { kind: 'docker', image: 'node:22', network: false } })
      office.start('go')
      await until(() => !office.isRunning)
      expect(of(events, 'tool').map((e) => e.detail?.slice(0, 12))).toEqual(['E_NO_DOCKER:', 'E_NO_DOCKER:'])
      expect(of(events, 'message').filter((e) => e.from === SYSTEM && e.text === 'E_NO_DOCKER')).toHaveLength(1)
    } finally {
      process.env.PATH = saved
    }
  })
})
