import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, OfficeEvent, Project, UsageRecord } from '../shared/types'
import { createAttention, createCaps, fileName, providerUsers, throttle, withRule } from './wiring'

describe('attention', () => {
  it('counts approvals, plans and blocked members until they are answered', () => {
    const a = createAttention()
    const at = 1
    a.track('p1', { type: 'approval', id: 'x', agentId: 'a', kind: 'command', command: 'ls', at })
    a.track('p1', { type: 'plan', id: 'y', agentId: 'a', text: 'plan', at })
    a.track('p2', { type: 'blocked', id: 'z', agentId: 'b', providerId: 'p', model: 'm', kind: 'quota', detail: '', at })
    expect(a.count()).toBe(3)
    a.track('p1', { type: 'approval_done', id: 'x', approved: true, at })
    a.track('p2', { type: 'unblocked', id: 'z', agentId: 'b', at })
    expect(a.count()).toBe(1)
    // Waiting for the plan keeps it pending; a real end clears the office.
    a.track('p1', { type: 'run', runId: 'r', state: 'done', reason: 'plan', at })
    expect(a.count()).toBe(1)
    a.track('p1', { type: 'run', runId: 'r', state: 'stopped', reason: 'owner_stopped', at })
    expect(a.count()).toBe(0)
  })

  it('reports only events that can change the count', () => {
    const a = createAttention()
    const msg: OfficeEvent = { type: 'message', id: 'm', at: 1, from: 'a', to: ['b'], text: 'hi' }
    expect(a.track('p', msg)).toBe(false)
  })
})

describe('throttle', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('sends at most once per 50 ms per key, always the latest value, and null right away', () => {
    const sent: [string, string | null][] = []
    const push = throttle((k, v) => sent.push([k, v]), 50)
    push('a', '1')
    push('a', '12')
    push('a', '123')
    push('b', 'x')
    expect(sent).toEqual([['a', '1'], ['b', 'x']])
    vi.advanceTimersByTime(50)
    expect(sent.at(-1)).toEqual(['a', '123'])
    push('a', '1234')
    push('a', null)
    expect(sent.slice(-2)).toEqual([['a', '1234'], ['a', null]])
    vi.advanceTimersByTime(100)
    expect(sent).toHaveLength(5)
  })
})

describe('caps', () => {
  const rec = (at: number, usd: number | null): UsageRecord => ({ at, usd, projectId: 'p', runId: 'r', agentId: 'a', agent: 'A', providerId: 'x', model: 'm', in: 0, cacheRead: 0, cacheWrite: 0, out: 0 })
  const now = new Date(2026, 9, 13, 15).getTime()

  it('starts from today and this month in the log, then adds each charge', () => {
    const caps = createCaps([rec(new Date(2026, 9, 13, 9).getTime(), 2), rec(new Date(2026, 9, 2).getTime(), 5), rec(now, null)], now)
    expect(caps.use({ dailyCapUsd: 0, monthlyCapUsd: 0 }, now)).toMatchObject({ day: 2, month: 7 })
    expect(caps.reached({ dailyCapUsd: 3, monthlyCapUsd: 0 }, now)).toBeNull()
    caps.add(1, now)
    expect(caps.reached({ dailyCapUsd: 3, monthlyCapUsd: 0 }, now)).toBe('day')
    expect(caps.reached({ dailyCapUsd: 0, monthlyCapUsd: 8 }, now)).toBe('month')
  })

  it('resets the day at midnight and the month on the 1st', () => {
    const caps = createCaps([rec(now, 4)], now)
    const tomorrow = new Date(2026, 9, 14, 1).getTime()
    expect(caps.use({ dailyCapUsd: 0, monthlyCapUsd: 0 }, tomorrow)).toMatchObject({ day: 0, month: 4 })
    expect(caps.use({ dailyCapUsd: 0, monthlyCapUsd: 0 }, new Date(2026, 10, 1).getTime())).toMatchObject({ day: 0, month: 0 })
  })

  it('ignores bad amounts', () => {
    const caps = createCaps([], now)
    caps.add(Number.NaN, now)
    caps.add(-5, now)
    expect(caps.use({ dailyCapUsd: 0, monthlyCapUsd: 0 }, now)).toMatchObject({ day: 0, month: 0 })
  })
})

const agent = (id: string, providerId: string, backup?: string): Agent => ({
  id, name: id.toUpperCase(), title: '', department: '', reportsTo: null, instructions: '', providerId, model: 'm', tools: [],
  ...(backup ? { backup: { providerId: backup, model: 'b' } } : {})
})
const office = (id: string, agents: Agent[]): Project => ({ id, name: `Office ${id}`, workspaceDir: '', briefing: '', approval: 'ask', budgetUsd: 0, agents })

describe('providerUsers', () => {
  it('names members using a provider as main or backup model', () => {
    const projects = [office('1', [agent('a', 'x'), agent('b', 'y', 'x')]), office('2', [agent('c', 'y')])]
    expect(providerUsers(projects, 'x')).toBe('A (Office 1), B (Office 1)')
    expect(providerUsers(projects, 'z')).toBe('')
  })
})

describe('withRule', () => {
  it('adds a rule once and keeps the same object when nothing changes', () => {
    const p = office('1', [])
    const once = withRule(p, 'command:npm test')
    expect(once.allowCommands).toEqual(['command:npm test'])
    expect(withRule(once, 'command:npm test')).toBe(once)
  })
})

describe('fileName', () => {
  it('makes a safe file name from free text', () => {
    expect(fileName('Build: the "site" / v2?', '.md')).toBe('Build the site v2.md')
    expect(fileName('  ..  ', '.json', 'office')).toBe('office.json')
    expect(fileName('con', '.md')).toBe('ai-office.md')
    expect(fileName('a\u0000b\nc', '.md')).toBe('a b c.md')
    expect(fileName('x'.repeat(200), '.md')).toHaveLength(63)
  })
})
