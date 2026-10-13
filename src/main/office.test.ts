import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Agent, OfficeEvent, Project } from '../shared/types'
import { Office, validateOrg } from './office'
import type { Chat, ToolCall, ToolResult, Turn } from './providers'
import { inside } from './tools'

const agent = (id: string, reportsTo: string | null, extra: Partial<Agent> = {}): Agent => ({
  id,
  name: id,
  title: id,
  department: '',
  reportsTo,
  instructions: '',
  providerId: 'p',
  model: 'm',
  priceIn: 1,
  priceOut: 1,
  tools: ['read_file', 'write_file', 'run_command'],
  ...extra
})

type Script = (input: string | undefined, results: ToolResult[]) => Partial<Turn> & { calls?: ToolCall[] }
const call = (name: string, input: Record<string, unknown>): ToolCall => ({ id: Math.random().toString(36), name, input })

function setup(agents: Agent[], scripts: Record<string, Script>, extra: Partial<Project> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-'))
  const events: OfficeEvent[] = []
  const project: Project = { id: 'x', name: 'Acme', workspaceDir: dir, briefing: 'b', approval: 'auto', budgetUsd: 0, agents, ...extra }
  const office = new Office(project, {
    conn: () => ({ kind: 'openai', baseURL: '', apiKey: '' }),
    readNotes: () => '',
    appendNote: () => {},
    emit: (e) => events.push(e),
    openChat: (_c, _m, system): Chat => {
      const name = /^You are (\w+),/.exec(system)![1]
      return {
        step: async (results, input) => ({ text: '', calls: [], inTok: 1000, outTok: 1000, ...scripts[name](input, results) })
      }
    }
  })
  const finished = () =>
    new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (!office.isRunning) {
          clearInterval(t)
          resolve()
        }
      }, 5)
    })
  return { office, events, dir, finished }
}

describe('office', () => {
  it('delegates down the chain and reports up to the owner', async () => {
    const { office, events, dir, finished } = setup(
      [agent('ceo', null), agent('lead', 'ceo'), agent('dev', 'lead')],
      {
        ceo: (input) =>
          input?.includes('[From the owner]')
            ? { calls: [call('message', { to: ['lead'], text: 'build hello' })] }
            : input?.includes('[From lead')
              ? { calls: [call('report_to_user', { summary: 'done: hello.txt' })] }
              : {},
        lead: (input) =>
          input?.includes('[From ceo') ? { calls: [call('message', { to: ['dev'], text: 'write hello.txt' })] } : input?.includes('[From dev') ? { text: 'dev finished hello.txt' } : {},
        dev: (input, results) =>
          input ? { calls: [call('write_file', { path: 'hello.txt', content: 'hi' })] } : results.length ? { text: 'wrote hello.txt' } : {}
      }
    )
    office.start('make hello')
    await finished()
    expect(fs.readFileSync(path.join(dir, 'hello.txt'), 'utf8')).toBe('hi')
    const last = events.filter((e) => e.type === 'message').at(-1)
    expect(last).toMatchObject({ from: 'ceo', to: ['user'], text: 'done: hello.txt' })
    expect(events.filter((e) => e.type === 'run').at(-1)).toMatchObject({ type: 'run', state: 'done' })
  })

  it('stops when the budget is spent', async () => {
    const { office, events, finished } = setup(
      [agent('ceo', null)],
      { ceo: () => ({ calls: [call('read_file', { path: 'nope' })] }) },
      { budgetUsd: 0.01 }
    )
    office.start('loop forever')
    await finished()
    expect(events.filter((e) => e.type === 'run').at(-1)).toMatchObject({ type: 'run', state: 'stopped' })
  })

  it('only the top executive can message the owner or report', async () => {
    let reply = ''
    const { office, finished } = setup([agent('ceo', null), agent('dev', 'ceo')], {
      ceo: (input) => (input?.includes('owner') ? { calls: [call('message', { to: ['dev'], text: 'go' })] } : {}),
      dev: (input, results) => {
        if (input) return { calls: [call('report_to_user', { summary: 'x' })] }
        reply = results[0]?.content ?? ''
        return {}
      }
    })
    office.start('g')
    await finished()
    expect(reply).toMatch(/berilmagan/)
  })

  it('owner can continue a finished run', async () => {
    const seen: string[] = []
    const { office, finished } = setup([agent('ceo', null)], {
      ceo: (input) => {
        if (input) seen.push(input)
        return { text: input ? 'ok' : '' }
      }
    })
    office.start('first')
    await finished()
    office.post('second')
    await finished()
    expect(seen).toEqual(['[From the owner] first', '[From the owner] second'])
  })
})

describe('org + sandbox', () => {
  it('rejects two CEOs and cycles', () => {
    expect(validateOrg([agent('a', null), agent('b', null)])).toBeTruthy()
    expect(validateOrg([agent('ceo', null), agent('a', 'b'), agent('b', 'a')])).toMatch(/aylana/)
    expect(validateOrg([agent('ceo', null), agent('a', 'ceo')])).toBeNull()
  })

  it('keeps file paths inside the workspace', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'))
    expect(() => inside(dir, '../x')).toThrow()
    expect(() => inside(dir, path.resolve('/etc/passwd'))).toThrow()
    expect(inside(dir, 'a/b.txt')).toBe(path.join(fs.realpathSync(dir), 'a', 'b.txt'))
  })
})
