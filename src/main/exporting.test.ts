import { describe, expect, it } from 'vitest'
import type { Agent, OfficeEvent, Project, RunSummary } from '../shared/types'
import { projectFromJson, projectToJson, runToMarkdown } from './exporting'

const agent = (x: Partial<Agent>): Agent => ({
  id: 'x', name: 'X', title: 'Engineer', department: 'Engineering', reportsTo: null, instructions: 'Work.', providerId: 'p1', model: 'm1', tools: ['read_file'], ...x
})
const office: Project = {
  id: 'office1', name: 'Acme', workspaceDir: '/home/me/acme', briefing: 'We sell shoes.', approval: 'auto', budgetUsd: 7.5,
  agents: [
    agent({ id: 'ceo', name: 'Ann', title: 'CEO', effort: 'high', maxTokens: 64000, skills: ['report-writing'] }),
    agent({ id: 'cto', name: 'Bob', title: 'CTO', reportsTo: 'ceo', backup: { providerId: 'p2', model: 'cheap' }, mcpServers: ['github'], tools: ['read_file', 'run_command'] }),
    agent({ id: 'dev', name: 'Cem', reportsTo: 'cto' })
  ],
  limits: { maxRequests: 100, maxChatter: 6, compactAt: 90_000 },
  planFirst: true,
  allowCommands: ['npm test', 'fetch:localhost'],
  sandbox: { kind: 'docker', image: 'node:22-bookworm', network: false },
  checkpoints: false
}
let n = 0
const newId = () => `new${++n}`

describe('office export / import', () => {
  it('writes a versioned document', () => {
    expect(JSON.parse(projectToJson(office))).toEqual({ format: 'ai-office/project', version: 1, project: office })
  })

  it('imports as a new office with new ids and the same reporting lines', () => {
    n = 0
    const p = projectFromJson(projectToJson(office), newId)
    expect(p.id).toBe('new4')
    expect(p.agents.map((a) => a.id)).toEqual(['new1', 'new2', 'new3'])
    expect(p.agents.map((a) => a.reportsTo)).toEqual([null, 'new1', 'new2'])
    expect(p.agents[1].backup).toEqual({ providerId: 'p2', model: 'cheap' })
    expect(p.agents[0]).toMatchObject({ name: 'Ann', title: 'CEO', effort: 'high', maxTokens: 64000, skills: ['report-writing'] })
    expect(p.agents[1]).toMatchObject({ tools: ['read_file', 'run_command'] })
    // A shared file must not hand its members this computer's MCP servers.
    expect(p.agents[1].mcpServers).toBeUndefined()
    expect(p).toMatchObject({ name: 'Acme', briefing: 'We sell shoes.', budgetUsd: 7.5, limits: office.limits, planFirst: true, sandbox: office.sandbox, checkpoints: false })
  })

  it('does not carry permissions over', () => {
    const p = projectFromJson(projectToJson(office), newId)
    expect(p.allowCommands).toBeUndefined()
    expect(p.approval).toBe('ask')
    expect(p.workspaceDir).toBe('')
  })

  it('keeps only known fields', () => {
    const doc = JSON.parse(projectToJson(office))
    doc.project.secret = 'x'
    doc.project.agents[0].injected = { a: 1 }
    const p = projectFromJson(JSON.stringify(doc), newId) as unknown as Record<string, unknown>
    expect(p.secret).toBeUndefined()
    expect((p.agents as Record<string, unknown>[])[0].injected).toBeUndefined()
    expect(Object.keys(projectFromJson(projectToJson({ ...office, limits: undefined, sandbox: undefined, planFirst: undefined, checkpoints: undefined }), newId)).sort())
      .toEqual(['agents', 'approval', 'briefing', 'budgetUsd', 'id', 'name', 'workspaceDir'])
  })

  it('rejects anything that is not a valid export with E_BAD_FILE', () => {
    const doc = () => JSON.parse(projectToJson(office))
    const bad: string[] = [
      'not json', '[]', 'null', '"text"',
      JSON.stringify({ ...doc(), format: 'something-else' }),
      JSON.stringify({ ...doc(), version: 2 }),
      JSON.stringify({ format: 'ai-office/project', version: 1 }),
      JSON.stringify({ ...doc(), project: { ...office, budgetUsd: -1 } }),
      JSON.stringify({ ...doc(), project: { ...office, agents: [agent({ id: 'a', tools: ['rm_rf' as 'read_file'] })] } }),
      JSON.stringify({ ...doc(), project: { ...office, agents: [agent({ id: 'a', reportsTo: 'nobody' })] } }),
      JSON.stringify({ ...doc(), project: { ...office, agents: [agent({ id: '../../a' })] } }),
      JSON.stringify({ ...doc(), project: { ...office, briefing: 'x'.repeat(200_000) } }),
      projectToJson(office).replace('"project": {', '"project": {"__proto__": {"polluted": true},')
    ]
    for (const text of bad) expect(() => projectFromJson(text, newId), text.slice(0, 80)).toThrow('E_BAD_FILE')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})

describe('task as Markdown', () => {
  const at = (h: number, m: number) => new Date(2026, 9, 10, h, m).getTime()
  const run: RunSummary = { id: 'r1', goal: 'Build a landing page\nwith a signup form', startedAt: at(9, 5), state: 'done' }
  const events: OfficeEvent[] = [
    { type: 'run', runId: 'r1', state: 'running', at: at(9, 5) },
    { type: 'message', id: 'm1', at: at(9, 5), from: 'user', to: ['ceo'], text: 'Build a landing page\nwith a signup form' },
    { type: 'status', agentId: 'ceo', status: 'working', at: at(9, 5) },
    { type: 'cost', agentId: 'ceo', providerId: 'p1', model: 'm1', usd: 0.42, usage: { in: 1, out: 1, cacheRead: 0, cacheWrite: 0 }, at: at(9, 6) },
    { type: 'plan', id: 'pl1', agentId: 'ceo', text: 'Step 1: design\nStep 2: build', at: at(9, 6) },
    { type: 'plan_done', id: 'pl1', approved: false, feedback: 'Add tests\nfirst', at: at(9, 7) },
    { type: 'message', id: 'm2', at: at(9, 8), from: 'ceo', to: ['cto', 'dev'], text: 'Please build it.' },
    { type: 'tool', id: 't1', at: at(9, 9), agentId: 'cto', name: 'read_file', summary: 'src/index.html', ok: true },
    { type: 'tool', id: 't2', at: at(9, 9), agentId: 'cto', name: 'run_command', summary: 'echo `date`', ok: false },
    { type: 'approval', id: 'ap1', agentId: 'cto', kind: 'command', command: 'npm test', at: at(9, 10) },
    { type: 'approval_done', id: 'ap1', approved: true, always: true, at: at(9, 10) },
    { type: 'approval', id: 'ap2', agentId: 'cto', kind: 'fetch', command: 'http://localhost:3000', at: at(9, 11) },
    { type: 'approval_done', id: 'ap2', approved: false, at: at(9, 11) },
    { type: 'tool', id: 't3', at: at(9, 12), agentId: 'dev', name: 'write_file', summary: 'index.html', ok: true },
    { type: 'cost', agentId: 'dev', usd: null, at: at(9, 12) },
    { type: 'message', id: 'm3', at: at(9, 13), from: 'gone', to: ['ceo'], text: 'I left the company.' },
    { type: 'message', id: 'm4', at: at(9, 14), from: 'system', to: [], text: 'E_UNPRICED|Cem (m1)' },
    { type: 'message', id: 'm5', at: at(9, 15), from: 'ceo', to: ['user'], text: 'Quick question: which colour?' },
    { type: 'message', id: 'm6', at: at(9, 16), from: 'user', to: ['ceo'], text: 'Blue.' },
    { type: 'message', id: 'm7', at: at(9, 20), from: 'ceo', to: ['user'], text: 'All done. The page is in index.html.' },
    { type: 'approval_done', id: 'stale', approved: false, at: at(9, 20) },
    { type: 'run', runId: 'r1', state: 'done', reason: 'report', at: at(9, 20) },
    { type: 'tool', id: 't4', at: at(9, 20), agentId: 'ceo', name: 'report_to_user', summary: '', ok: true }
  ]
  const md = runToMarkdown(office, run, events)

  it('starts with the goal, the date and the office', () => {
    expect(md.startsWith('# Build a landing page\n\n2026-10-10 09:05 · Acme\n\n')).toBe(true)
  })
  it('writes each message with sender, recipients and time', () => {
    expect(md).toContain('**Owner → Ann** (09:05)\n\nBuild a landing page\nwith a signup form')
    expect(md).toContain('**Ann → Bob, Cem** (09:08)\n\nPlease build it.')
    expect(md).toContain('**Former member → Ann** (09:13)')
    expect(md).toContain('**System** (09:14)\n\nE_UNPRICED|Cem (m1)')
  })
  it('lists tool work as bullets per member', () => {
    expect(md).toContain('- Bob · read_file `src/index.html`\n- Bob · run_command `` echo `date` `` — failed\n\n')
    expect(md).toContain('- Cem · write_file `index.html`')
    expect(md).not.toContain('report_to_user')
  })
  it('shows approvals and the plan with their outcome', () => {
    expect(md).toContain('> **Approval:** Bob wants to run `npm test` — allowed for good')
    expect(md).toContain('> **Approval:** Bob wants to open a local address: `http://localhost:3000` — denied')
    expect(md).toContain('**Plan from Ann** (09:06)\n\n> Step 1: design\n> Step 2: build\n\n_Changes requested: Add tests first_')
  })
  it('highlights only the final report', () => {
    expect(md).toContain('## Final report\n\n**Ann** (09:20)\n\nAll done. The page is in index.html.')
    expect(md).toContain('**Ann → Owner** (09:15)\n\nQuick question: which colour?')
    expect(md.match(/## Final report/g)).toHaveLength(1)
    expect(md).toContain('_Final report delivered_')
  })
  it('ends with the total cost, counting unpriced requests separately', () => {
    expect(md.endsWith('---\n\n**Total cost:** $0.42 (2 requests, 1 without a price (not included))\n')).toBe(true)
  })
  it('names the newer end reasons', () => {
    const end = (e: Partial<Extract<OfficeEvent, { type: 'run' }>>) => runToMarkdown(office, run, [{ type: 'run', runId: 'r1', state: 'stopped', at: 1, ...e }])
    expect(end({ reason: 'loop', agents: ['Bob', 'Cem'] })).toContain('_Stopped: Bob and Cem kept messaging each other without doing work_')
    expect(end({ reason: 'limit', requests: 300 })).toContain('(300 requests)')
    expect(end({ reason: 'cap', usd: 20 })).toContain('spending cap was reached ($20.00)')
    expect(end({ reason: 'app_closed' })).toContain('_The app was closed_')
    expect(end({ reason: 'something-new' })).toContain('_The work ended_')
    expect(end({ reason: 'owner_stopped' })).toContain('**Total cost:** $0.00 (0 requests)')
  })
})
