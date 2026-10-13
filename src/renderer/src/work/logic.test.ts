import { describe, expect, it } from 'vitest'
import type { OfficeEvent, RunSummary } from '../../../shared/types'
import { LANGS } from '../i18n'
import {
  approvalShortcut,
  budgetMeter,
  buildItems,
  changeTotals,
  diffLines,
  elapsed,
  endText,
  errCode,
  firstFiles,
  forMember,
  hasShellControl,
  hostOf,
  isEditable,
  matchRuns,
  parseBudget,
  sameItem,
  suggestBudget,
  summarize,
  systemWarn,
  type RunEv
} from './logic'

const t = LANGS.en
const msg = (id: string, from: string, to: string[], at = 1): OfficeEvent => ({ type: 'message', id, at, from, to, text: id })
const tool = (id: string, agentId: string, name = 'read_file'): OfficeEvent => ({ type: 'tool', id, at: 1, agentId, name, summary: 'a.txt', ok: true })
const run = (state: RunEv['state'], reason?: string, extra: Partial<RunEv> = {}): RunEv => ({ type: 'run', runId: 'r', state, reason, at: 9, ...extra })

describe('buildItems', () => {
  it('groups consecutive tools of one member and keeps keys stable as the run grows', () => {
    const evs: OfficeEvent[] = [run('running'), msg('m1', 'user', ['ceo']), tool('t1', 'ceo'), { type: 'status', agentId: 'ceo', status: 'working', at: 2 }, tool('t2', 'ceo'), tool('t3', 'dev')]
    const a = buildItems(evs)
    expect(a.map((i) => i.kind)).toEqual(['message', 'tools', 'tools'])
    expect(a[1].kind === 'tools' && a[1].list.map((x) => x.id)).toEqual(['t1', 't2'])
    const b = buildItems([...evs, tool('t4', 'dev')])
    expect(b.map((i) => i.key)).toEqual(a.map((i) => i.key))
    expect(sameItem(a[0], b[0])).toBe(true)
    expect(sameItem(a[2], b[2])).toBe(false)
  })

  it('gives unique keys to events without ids, including old logs with missing ids', () => {
    const old = { type: 'message', at: 1, from: 'a', to: ['b'], text: 'x' } as unknown as OfficeEvent
    const evs: OfficeEvent[] = [
      old,
      old,
      { type: 'notice', agentId: 'a', kind: 'rate', attempt: 1, of: 3, waitMs: 1000, at: 5 },
      { type: 'compact', agentId: 'a', tokens: 1000, at: 5 },
      run('stopped', 'owner_stopped'),
      run('running'),
      run('done', 'idle')
    ]
    const keys = buildItems(evs).map((i) => i.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('collapses retries of one member into the latest notice, keeping its key', () => {
    const n = (attempt: number): OfficeEvent => ({ type: 'notice', agentId: 'a', kind: 'rate', attempt, of: 3, waitMs: 1000, at: attempt })
    const items = buildItems([n(1), n(2), n(3)])
    expect(items).toHaveLength(1)
    expect(items[0].kind === 'notice' && items[0].e.attempt).toBe(3)
    expect(items[0].key).toBe(buildItems([n(1)])[0].key)
  })

  it('attaches answers to approvals', () => {
    const items = buildItems([
      { type: 'approval', id: 'p1', agentId: 'a', kind: 'command', command: 'ls', at: 1 },
      { type: 'approval', id: 'p2', agentId: 'a', kind: 'fetch', command: 'http://localhost', at: 2 },
      { type: 'approval_done', id: 'p1', approved: true, always: true, at: 3 }
    ])
    expect(items.map((i) => (i.kind === 'approval' ? i.done?.always ?? null : '?'))).toEqual([true, null])
  })

  it('knows which plan can still be answered', () => {
    const plan = (id: string): OfficeEvent => ({ type: 'plan', id, agentId: 'ceo', text: id, at: 1 })
    const state = (evs: OfficeEvent[]) => buildItems(evs).flatMap((i) => (i.kind === 'plan' ? [{ open: i.open, replaced: i.replaced, done: i.done?.approved }] : []))
    // Waiting at idle with reason "plan".
    expect(state([run('running'), plan('a'), run('done', 'plan')])).toEqual([{ open: true, replaced: false, done: undefined }])
    // A second plan replaces the first.
    expect(state([run('running'), plan('a'), { type: 'plan_done', id: 'a', approved: false, at: 2 }, plan('b')])).toEqual([
      { open: false, replaced: true, done: false },
      { open: true, replaced: false, done: undefined }
    ])
    // Changes requested stays "changes requested" even after the new plan.
    expect(state([run('running'), plan('a'), { type: 'plan_done', id: 'a', approved: false, feedback: 'smaller', at: 2 }, plan('b')])[0]).toEqual({ open: false, replaced: false, done: false })
    // Stopped runs can't take an answer.
    expect(state([run('running'), plan('a'), run('stopped', 'owner_stopped')])).toEqual([{ open: false, replaced: false, done: undefined }])
    expect(state([run('running'), plan('a'), { type: 'plan_done', id: 'a', approved: true, at: 2 }])).toEqual([{ open: false, replaced: false, done: true }])
  })

  it('marks blocked members resolved once unblocked', () => {
    const items = buildItems([
      { type: 'blocked', id: 'b1', agentId: 'a', providerId: 'p', model: 'm', kind: 'auth', detail: '', at: 1 },
      { type: 'unblocked', id: 'b1', agentId: 'a', at: 2 }
    ])
    expect(items[0].kind === 'blocked' && items[0].resolved).toBe(true)
  })

  it('filters for one member and keeps the run lines', () => {
    const items = buildItems([msg('m1', 'a', ['b']), msg('m2', 'c', ['d']), tool('t1', 'a'), tool('t2', 'c'), run('done', 'idle')])
    expect(forMember(items, 'a').map((i) => i.key)).toEqual(['m:m1', 't:t1', 'r:4'])
    expect(forMember(items, 'b').map((i) => i.key)).toEqual(['m:m1', 'r:4'])
    expect(forMember(items, null)).toBe(items)
  })
})

describe('summarize', () => {
  it('adds up cost and tokens, including runs saved before v0.3', () => {
    const s = summarize([
      run('running'),
      msg('goal', 'user', ['ceo']),
      { type: 'status', agentId: 'a', status: 'working', at: 100 },
      { type: 'status', agentId: 'a', status: 'working', at: 200 },
      { type: 'cost', agentId: 'a', usd: 0.5, usage: { in: 10, cacheRead: 5, cacheWrite: 0, out: 3 }, at: 3 },
      { type: 'cost', agentId: 'a', usd: null, inTok: 7, outTok: 1, at: 4 },
      tool('w', 'a', 'write_file'),
      tool('e', 'a', 'edit_file'),
      tool('r', 'a', 'read_file'),
      tool('c', 'a', 'run_command'),
      run('done', 'report')
    ])
    expect(s).toMatchObject({ total: 0.5, toks: 26, unpriced: 1, goal: 'goal', writes: 3 })
    expect(s.since.get('a')).toBe(100)
    expect(s.lastRun?.reason).toBe('report')
  })
})

describe('endText', () => {
  it('explains the v0.3 reasons and keeps the old ones', () => {
    expect(endText(run('stopped', 'limit', { requests: 300 }), t)).toContain('300 model requests')
    expect(endText(run('stopped', 'loop', { agents: ['Ann', 'Bob'] }), t)).toContain('Ann and Bob')
    expect(endText(run('stopped', 'loop'), t)).toContain('members')
    expect(endText(run('stopped', 'cap', { usd: 12 }), t)).toContain('$12.00')
    expect(endText(run('done', 'plan'), t)).toBe(t.run.reasons.plan)
    expect(endText(run('stopped', 'app_closed'), t)).toBe(t.run.reasons.app_closed)
    expect(endText(run('stopped', 'budget', { usd: 2 }), t)).toBe('Budget reached ($2.00)')
    expect(endText(run('done', 'report'), t)).toBe(t.work.reasons.report)
    expect(endText(run('stopped', 'something_new'), t)).toBe(t.work.stopped)
    expect(endText(run('done'), t)).toBe(t.work.done)
  })

  it('has every reason in Uzbek too', () => {
    expect(endText(run('stopped', 'loop', { agents: ['Ann', 'Bob'] }), LANGS.uz)).toContain('Ann va Bob')
  })
})

describe('approvals', () => {
  it('flags the same shell control characters as the main process', () => {
    for (const c of ['a; b', 'a & b', 'a | b', 'echo `x`', 'echo $HOME', 'a > f', 'a < f', '(a)', '{a}', 'a\nb', 'a\rb']) expect(hasShellControl(c)).toBe(true)
    for (const c of ['npm test', 'git status --short', 'python -m pytest -q "tests/a b.py"']) expect(hasShellControl(c)).toBe(false)
  })

  it('shows the host of a fetch and a short file list', () => {
    expect(hostOf('http://localhost:3000/a')).toBe('localhost:3000')
    expect(hostOf('not a url')).toBe('not a url')
    expect(firstFiles(['a', 'b', 'c'], 2)).toEqual({ shown: ['a', 'b'], more: 1 })
    expect(firstFiles(undefined)).toEqual({ shown: [], more: 0 })
  })

  it('maps Alt+A / Alt+D by key position and ignores other combinations', () => {
    const k = (code: string, mods: Partial<{ altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; repeat: boolean }> = {}) => ({
      altKey: true,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      code,
      ...mods
    })
    expect(approvalShortcut(k('KeyA'))).toBe('allow')
    expect(approvalShortcut(k('KeyD'))).toBe('deny')
    expect(approvalShortcut(k('KeyA', { altKey: false }))).toBeNull()
    expect(approvalShortcut(k('KeyA', { ctrlKey: true }))).toBeNull()
    expect(approvalShortcut(k('KeyD', { repeat: true }))).toBeNull()
    expect(approvalShortcut(k('KeyX'))).toBeNull()
  })

  it('does not take shortcuts while the owner types', () => {
    expect(isEditable({ tagName: 'TEXTAREA' })).toBe(true)
    expect(isEditable({ tagName: 'INPUT' })).toBe(true)
    expect(isEditable({ tagName: 'DIV', isContentEditable: true })).toBe(true)
    expect(isEditable({ tagName: 'BUTTON' })).toBe(false)
    expect(isEditable(null)).toBe(false)
  })
})

describe('diffLines', () => {
  it('colours only lines inside hunks, so header-like content lines stay changes', () => {
    const d = ['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -1,2 +1,2 @@', ' same', '-old', '+new', '--- not a header', '\\ No newline at end of file', '… 4 more lines', ''].join('\n')
    expect(diffLines(d).map((l) => l.kind)).toEqual(['meta', 'meta', 'meta', 'hunk', 'ctx', 'del', 'add', 'del', 'meta', 'meta'])
    expect(diffLines('')).toEqual([])
    expect(diffLines('@@ 5000 lines → 5001 lines @@')[0].kind).toBe('hunk')
  })

  it('totals additions and deletions', () => {
    expect(
      changeTotals([
        { path: 'a', status: 'added', additions: 3, deletions: 0, binary: false },
        { path: 'b', status: 'modified', additions: 1, deletions: 2, binary: false }
      ])
    ).toEqual({ add: 4, del: 2 })
  })
})

describe('budget', () => {
  it('turns amber at 80 % and red when used up', () => {
    expect(budgetMeter(1, 0)).toBeNull()
    expect(budgetMeter(1, 10)).toEqual({ pct: 10, level: 'ok' })
    expect(budgetMeter(8, 10)?.level).toBe('high')
    expect(budgetMeter(10, 10)).toEqual({ pct: 100, level: 'full' })
    expect(budgetMeter(15, 10)).toEqual({ pct: 100, level: 'full' })
  })

  it('suggests twice the budget, but always more than was spent', () => {
    expect(suggestBudget(5, 5.01)).toBe('10')
    expect(suggestBudget(2.5, 3)).toBe('5')
    expect(suggestBudget(1, 7.2)).toBe('9')
  })

  it('accepts only a budget that leaves room, or 0 for no limit', () => {
    expect(parseBudget('10', 5)).toBe(10)
    expect(parseBudget('7,5', 5)).toBe(7.5)
    expect(parseBudget('0', 5)).toBe(0)
    expect(parseBudget('5', 5)).toBeNull()
    expect(parseBudget('', 5)).toBeNull()
    expect(parseBudget('-3', 1)).toBeNull()
    expect(parseBudget('1e9', 1)).toBeNull()
    expect(parseBudget('abc', 1)).toBeNull()
  })
})

describe('history search', () => {
  const runs: RunSummary[] = [
    { id: '1', goal: 'Build a TODO app', startedAt: 1, state: 'done' },
    { id: '2', goal: 'O‘zbekcha matnni tekshir', startedAt: 2, state: 'stopped' }
  ]
  it('matches every word, case- and apostrophe-insensitive', () => {
    expect(matchRuns(runs, '').map((r) => r.id)).toEqual(['1', '2'])
    expect(matchRuns(runs, 'todo build').map((r) => r.id)).toEqual(['1'])
    expect(matchRuns(runs, "o'zbekcha").map((r) => r.id)).toEqual(['2'])
    expect(matchRuns(runs, 'todo tekshir')).toEqual([])
  })
})

describe('misc', () => {
  it('reads error codes from IPC errors', () => {
    expect(errCode(new Error("Error invoking remote method 'post': Error: E_BUDGET_SPENT|5"))).toBe('E_BUDGET_SPENT')
    expect(errCode(new Error('E_NOT_GIT_REPO'))).toBe('E_NOT_GIT_REPO')
    expect(errCode(new Error('boom'))).toBeNull()
  })

  it('counts seconds since a status began', () => {
    expect(elapsed(5000, 2100)).toBe(2)
    expect(elapsed(1000, 2000)).toBe(0)
    expect(elapsed(1000, undefined)).toBeNull()
  })

  it('shows setup notices as warnings, failures as errors', () => {
    expect(systemWarn('E_UNPRICED|Ann (x)')).toBe(true)
    expect(systemWarn('E_NO_GIT')).toBe(true)
    expect(systemWarn('E_CHECKPOINT_TOO_BIG')).toBe(true)
    expect(systemWarn('Ann: E_NO_DOCKER')).toBe(false)
    expect(systemWarn('E_NO_DOCKER')).toBe(false)
  })
})
