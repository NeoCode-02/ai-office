import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Agent, OfficeEvent, Project } from '../../../shared/types'
import { BudgetPill, RaiseBudget } from './Budget'
import { FeedItem, type FeedCtx } from './FeedItem'
import { LiveReplies } from './Live'
import { buildItems, type Item } from './logic'
import { DiffView } from './parts'

// useT subscribes with useSyncExternalStore, which server rendering can't do; the app renders on the client.
vi.mock('../i18n', async (load) => {
  const m = await load<typeof import('../i18n')>()
  return { ...m, useT: () => m.LANGS.en }
})

const agent = (id: string, name: string, reportsTo: string | null = null): Agent => ({
  id,
  name,
  title: 'Engineer',
  department: '',
  reportsTo,
  instructions: '',
  providerId: 'p',
  model: 'm',
  tools: []
})
const ann = agent('a', 'Ann')
const bob = agent('b', 'Bob', 'a')
const project: Project = { id: 'p1', name: 'Office', workspaceDir: '/work/site', briefing: '', approval: 'ask', budgetUsd: 5, agents: [ann, bob] }
const ctx = (over: Partial<FeedCtx> = {}): FeedCtx => ({
  project,
  providers: [],
  byId: new Map(project.agents.map((a) => [a.id, a])),
  nameOf: (id) => (id === 'a' ? 'Ann' : id === 'b' ? 'Bob' : id),
  running: true,
  viewing: false,
  onSave: async () => {},
  notify: () => {},
  onAnswer: () => {},
  onPlan: async () => true,
  ...over
})
const render = (item: Item, over: Partial<FeedCtx> = {}, extra: { sent?: boolean; shortcut?: boolean } = {}) =>
  renderToStaticMarkup(<FeedItem item={item} ctx={ctx(over)} sent={extra.sent ?? false} shortcut={extra.shortcut ?? false} />)
const one = (evs: OfficeEvent[]) => buildItems(evs)[0]

describe('tool rows', () => {
  it('stay plain for runs saved before tool details existed', () => {
    const out = render(one([{ type: 'tool', id: 't', at: 1, agentId: 'a', name: 'read_file', summary: 'a.txt', ok: true }]))
    expect(out).not.toContain('<button')
    expect(out).toContain('Ann read<span class="mono"> a.txt</span>')
  })

  it('open to the result and the diff when the event carries them', () => {
    const out = render(
      one([{ type: 'tool', id: 't', at: 1, agentId: 'a', name: 'write_file', summary: 'b.txt', ok: true, detail: 'Wrote 3 bytes', diff: '--- a/b.txt\n+++ b/b.txt\n@@ -0,0 +1 @@\n+hi' }])
    )
    expect(out).toContain('aria-expanded="false"')
    expect(out).not.toContain('Wrote 3 bytes')
  })

  it('group several actions behind one toggle', () => {
    const out = render(
      one([
        { type: 'tool', id: 't1', at: 1, agentId: 'a', name: 'read_file', summary: 'a', ok: true },
        { type: 'tool', id: 't2', at: 2, agentId: 'a', name: 'run_command', summary: 'npm test', ok: false }
      ])
    )
    expect(out).toContain('Ann · 2 actions')
    expect(out).toContain('failed')
  })
})

describe('diff view', () => {
  it('marks added, removed and hunk lines', () => {
    const out = renderToStaticMarkup(<DiffView text={'--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new'} />)
    expect(out).toContain('<span class="dl meta">--- a/x</span>')
    expect(out).toContain('<span class="dl hunk">@@ -1 +1 @@</span>')
    expect(out).toContain('<span class="dl del">-old</span><span class="dl add">+new</span>')
    expect(renderToStaticMarkup(<DiffView text="" />)).toBe('')
  })
})

describe('approval card', () => {
  const files = Array.from({ length: 11 }, (_, i) => `src/f${i}.ts`)
  it('lists the first 8 changed files, the Docker badge and the shortcut hints', () => {
    const out = render(one([{ type: 'approval', id: 'x', agentId: 'b', kind: 'command', command: 'npm test', files, sandbox: true, at: 1 }]), {}, { shortcut: true })
    expect(out).toContain('Bob wants to run a command')
    expect(out).toContain('src/f7.ts')
    expect(out).not.toContain('src/f8.ts')
    expect(out).toContain('and 3 more')
    expect(out).toContain('in Docker')
    expect(out).toContain('title="Allow (Alt+A)"')
    expect(out).toContain('title="Deny (Alt+D)"')
    expect(out).toContain('Always allow')
    expect(out).toContain('role="alert"')
  })

  it('hides "Always allow" for commands with shell control characters', () => {
    const out = render(one([{ type: 'approval', id: 'x', agentId: 'b', kind: 'command', command: 'npm test && rm -rf /', at: 1 }]))
    expect(out).not.toContain('Always allow')
    expect(out).not.toContain('Alt+A')
  })

  it('explains local fetches and offers the host for good', () => {
    const out = render(one([{ type: 'approval', id: 'x', agentId: 'b', kind: 'fetch', command: 'http://localhost:8080/admin', at: 1 }]))
    expect(out).toContain('Bob wants to open a local address')
    expect(out).toContain('localhost:8080')
    expect(out).toContain('private services')
  })

  it('shows the answer, including "for good"', () => {
    const evs: OfficeEvent[] = [
      { type: 'approval', id: 'x', agentId: 'b', kind: 'mcp', command: 'db › query {}', at: 1 },
      { type: 'approval_done', id: 'x', approved: true, always: true, at: 2 }
    ]
    const out = render(one(evs))
    expect(out).toContain('Allowed for good')
    expect(out).not.toContain('<button')
  })

  it('disables the buttons once answered here', () => {
    expect(render(one([{ type: 'approval', id: 'x', agentId: 'b', kind: 'command', command: 'ls', at: 1 }]), {}, { sent: true })).toContain('disabled=""')
  })
})

describe('plan card', () => {
  const plan: OfficeEvent = { type: 'plan', id: 'p', agentId: 'a', text: '1. Build\n2. Test', at: 1 }
  const running: OfficeEvent = { type: 'run', runId: 'r', state: 'running', at: 0 }
  it('offers approve and request changes while it waits', () => {
    const out = render(buildItems([running, plan, { type: 'run', runId: 'r', state: 'done', reason: 'plan', at: 2 }])[0], { running: false })
    expect(out).toContain('Ann’s plan')
    expect(out).toContain('<ol><li>Build</li><li>Test</li></ol>')
    expect(out).toContain('Approve plan')
    expect(out).toContain('Request changes')
  })

  it('shows the feedback once changes were requested', () => {
    const out = render(buildItems([running, plan, { type: 'plan_done', id: 'p', approved: false, feedback: 'Add docs', at: 2 }])[0])
    expect(out).toContain('Changes requested')
    expect(out).toContain('Add docs')
    expect(out).not.toContain('Approve plan')
  })

  it('cannot be answered from a past run', () => {
    const out = render(buildItems([running, plan])[0], { viewing: true, running: false })
    expect(out).toContain('Not answered')
    expect(out).not.toContain('Approve plan')
  })
})

describe('event lines', () => {
  it('render summaries and the new end reasons', () => {
    expect(render(one([{ type: 'compact', agentId: 'b', tokens: 120_000, at: 1 }]))).toContain('Bob’s conversation was summarized to save space')
    expect(render(one([{ type: 'run', runId: 'r', state: 'stopped', reason: 'loop', agents: ['Ann', 'Bob'], at: 1 }]))).toContain('Ann and Bob kept messaging')
  })

  it('shows setup notices as warnings', () => {
    expect(render(one([{ type: 'message', id: 'm', at: 1, from: 'system', to: [], text: 'E_NO_GIT' }]))).toContain('msg system warn')
    expect(render(one([{ type: 'message', id: 'm', at: 1, from: 'system', to: [], text: 'E_NO_DOCKER' }]))).not.toContain('warn')
  })
})

describe('budget', () => {
  it('meters spending against the budget', () => {
    expect(renderToStaticMarkup(<BudgetPill total={4.5} toks={1000} unpriced={0} budget={5} />)).toContain('class="pill metered high"')
    expect(renderToStaticMarkup(<BudgetPill total={5} toks={1000} unpriced={0} budget={5} />)).toContain('aria-valuenow="100"')
    expect(renderToStaticMarkup(<BudgetPill total={1} toks={1000} unpriced={2} budget={0} />)).not.toContain('meter')
  })

  it('suggests twice the budget and says the message will be sent', () => {
    const out = renderToStaticMarkup(<RaiseBudget budget={5} spent={5.2} pending onRaise={async () => {}} />)
    expect(out).toContain('value="10"')
    expect(out).toContain('Raise and send')
    expect(out).toContain('The budget of $5 is used up.')
  })
})

describe('live replies', () => {
  it('streams a reply and counts thinking time for the others', () => {
    const status = new Map([
      ['a', 'working' as const],
      ['b', 'working' as const]
    ])
    const out = renderToStaticMarkup(<LiveReplies agents={[ann, bob]} status={status} since={new Map([['b', Date.now() - 12_400]])} deltas={{ a: 'Working on **it**' }} />)
    expect(out).toContain('Working on <strong>it</strong>')
    expect(out).toMatch(/thinking… 1[23] s/)
  })

  it('ignores replies of members who are no longer working', () => {
    expect(renderToStaticMarkup(<LiveReplies agents={[ann]} status={new Map([['a', 'idle' as const]])} since={new Map()} deltas={{ a: 'stale' }} />)).toBe('')
  })
})
