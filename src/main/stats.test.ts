import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { UsageRecord } from '../shared/types'
import { deepseek, moonshot, openrouter } from './balance'
import { quotaUse, stats } from './stats'
import { createStore } from './store'

const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime()
const rec = (x: Partial<UsageRecord>): UsageRecord => ({
  at: at(2026, 10, 10), projectId: 'p1', runId: 'r', agentId: 'a1', agent: 'Aziz', providerId: 'ds', model: 'deepseek-chat',
  in: 100, cacheRead: 50, cacheWrite: 0, out: 10, usd: 0.01, ...x
})

describe('stats', () => {
  const records = [
    rec({}),
    rec({ at: at(2026, 10, 11), usd: 0.02 }),
    rec({ agentId: 'a2', agent: 'Bobur', providerId: 'cl', model: 'claude-opus-5-5', usd: 0.5 }),
    rec({ agentId: 'a2', agent: 'Bobur', usd: null }),
    rec({ projectId: 'p2', usd: 1 }),
    rec({ at: at(2026, 10, 13), usd: 9 }) // outside the range
  ]
  const s = stats(records, at(2026, 10, 10, 0), at(2026, 10, 12, 0))

  it('totals tokens and money, counting unknown prices separately', () => {
    expect(s.total).toEqual({ requests: 5, in: 500, cacheRead: 250, cacheWrite: 0, out: 50, usd: 1.53, unpriced: 1 })
  })
  it('groups by model and by person, most expensive first', () => {
    expect(s.byModel.map((m) => [m.model, m.requests, m.usd])).toEqual([['deepseek-chat', 4, 1.03], ['claude-opus-5-5', 1, 0.5]])
    expect(s.byAgent.map((a) => [a.projectId, a.agent, a.requests])).toEqual([['p2', 'Aziz', 1], ['p1', 'Bobur', 2], ['p1', 'Aziz', 2]])
  })
  it('lists every day of the range', () => {
    expect(s.byDay.map((d) => [d.day, d.usd])).toEqual([['2026-10-10', 1.51], ['2026-10-11', 0.02]])
  })
  it('filters by office', () => {
    expect(stats(records, at(2026, 10, 10, 0), at(2026, 10, 12, 0), 'p2').total.requests).toBe(1)
  })
})

describe('quota', () => {
  const now = at(2026, 10, 10, 18)
  const records = [rec({ at: at(2026, 10, 10, 14) }), rec({ at: at(2026, 10, 10, 9) }), rec({ at: at(2026, 9, 30) }), rec({ providerId: 'other' })]
  it('counts requests in a rolling 5-hour window', () => {
    expect(quotaUse(records, 'ds', { mode: 'subscription', quota: { amount: 100, unit: 'requests', window: '5h' } }, now)?.used).toBe(1)
  })
  it('counts tokens since local midnight and dollars since the 1st', () => {
    expect(quotaUse(records, 'ds', { mode: 'subscription', quota: { amount: 1e6, unit: 'tokens', window: 'day' } }, now)?.used).toBe(320)
    expect(quotaUse(records, 'ds', { mode: 'payg', quota: { amount: 50, unit: 'usd', window: 'month' } }, now)?.used).toBeCloseTo(0.02)
  })
  it('is null without a quota', () => {
    expect(quotaUse(records, 'ds', { mode: 'payg' }, now)).toBeNull()
  })
})

describe('usage log', () => {
  it('reads records across month files and skips a torn line', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-'))
    const store = createStore(dir, { encrypt: (s) => s, decrypt: (s) => s })
    store.appendUsage(rec({ at: at(2026, 9, 30) }))
    store.appendUsage(rec({ at: at(2026, 10, 1) }))
    fs.appendFileSync(path.join(dir, 'usage', '2026-10.jsonl'), '{"at":')
    store.appendUsage(rec({ at: at(2026, 11, 2) }))
    expect(store.readUsage(at(2026, 9, 1), at(2026, 10, 31)).map((r) => new Date(r.at).getMonth() + 1)).toEqual([9, 10])
  })
})

describe('balance parsers', () => {
  it('DeepSeek prefers the USD balance', () => {
    expect(deepseek({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '10.00' }, { currency: 'USD', total_balance: '4.20' }] })).toEqual({ kind: 'balance', amount: 4.2, currency: 'USD' })
  })
  it('Kimi available balance', () => {
    expect(moonshot({ code: 0, data: { available_balance: 49.58894, voucher_balance: 0, cash_balance: 49.58894 }, status: true })).toEqual({ kind: 'balance', amount: 49.58894, currency: 'USD' })
  })
  it('OpenRouter key limit, null when unlimited', () => {
    expect(openrouter({ data: { usage: 1.5, limit: 10, limit_remaining: 8.5 } })).toEqual({ kind: 'key', remaining: 8.5, used: 1.5 })
    expect(openrouter({ data: { usage: 1.5, limit: null, limit_remaining: null } })).toEqual({ kind: 'key', remaining: null, used: 1.5 })
  })
  it('unknown shapes give null, not zero', () => {
    expect(deepseek({})).toBeNull()
    expect(moonshot({ data: {} })).toBeNull()
  })
})
