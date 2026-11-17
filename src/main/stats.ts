import type { AppSettings, Billing, CapUse, QuotaUse, UsageRecord, UsageRow, UsageStats } from '../shared/types'
import { estimate } from './billing'

const row = (): UsageRow => ({ requests: 0, in: 0, cacheRead: 0, cacheWrite: 0, out: 0, usd: 0, unpriced: 0 })

function add(r: UsageRow, x: UsageRecord) {
  r.requests++
  r.in += x.in
  r.cacheRead += x.cacheRead
  r.cacheWrite += x.cacheWrite
  r.out += x.out
  if (x.usd === null) r.unpriced++
  else r.usd += x.usd
}

const tokensOf = (x: UsageRecord) => x.in + x.cacheRead + x.cacheWrite + x.out

/** Local calendar day, YYYY-MM-DD. */
export function dayKey(at: number) {
  const d = new Date(at)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Aggregates records in [from, to). Days without usage are included as zeros. */
export function stats(records: UsageRecord[], from: number, to: number, projectId?: string): UsageStats {
  const total = row()
  const models = new Map<string, UsageStats['byModel'][number]>()
  const agents = new Map<string, UsageStats['byAgent'][number]>()
  const days = new Map<string, { day: string; usd: number; tokens: number }>()
  for (let d = new Date(from); d.getTime() < to; d.setDate(d.getDate() + 1)) {
    const k = dayKey(d.getTime())
    days.set(k, { day: k, usd: 0, tokens: 0 })
  }
  for (const x of records) {
    if (x.at < from || x.at >= to || (projectId && x.projectId !== projectId)) continue
    add(total, x)
    const mk = `${x.providerId}\n${x.model}`
    if (!models.has(mk)) models.set(mk, { ...row(), providerId: x.providerId, model: x.model })
    add(models.get(mk)!, x)
    const ak = `${x.projectId}\n${x.agentId}`
    if (!agents.has(ak)) agents.set(ak, { ...row(), projectId: x.projectId, agentId: x.agentId, agent: x.agent, model: x.model })
    const a = agents.get(ak)!
    add(a, x)
    a.agent = x.agent
    a.model = x.model
    const day = days.get(dayKey(x.at))
    if (day) {
      day.usd += x.usd ?? 0
      day.tokens += tokensOf(x)
    }
  }
  const order = (a: UsageRow, b: UsageRow) => b.usd - a.usd || b.in + b.out - (a.in + a.out)
  return { total, byModel: [...models.values()].sort(order), byAgent: [...agents.values()].sort(order), byDay: [...days.values()] }
}

/** Start of the quota window that contains `now`. 5h and week are rolling; day and month are calendar. */
export function windowStart(window: QuotaUse['window'], now: number): number {
  const d = new Date(now)
  if (window === '5h') return now - 5 * 3600_000
  if (window === 'week') return now - 7 * 86400_000
  if (window === 'day') return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime()
}

/** How much of the user's own quota this app has used (usage outside the app is not visible). */
export function quotaUse(records: UsageRecord[], providerId: string, billing: Billing, now: number): QuotaUse | null {
  const q = billing.quota
  if (!q || !(q.amount > 0)) return null
  const from = windowStart(q.window, now)
  let used = 0
  for (const x of records) {
    if (x.providerId !== providerId || x.at < from || x.at > now) continue
    used += q.unit === 'requests' ? 1 : q.unit === 'tokens' ? tokensOf(x) : (x.usd ?? 0)
  }
  return { used, amount: q.amount, unit: q.unit, window: q.window }
}

/**
 * App-wide spend for the caps: this local calendar day and this calendar month, around `now`.
 * Unknown prices (null) count as $0.
 */
export function capUse(records: UsageRecord[], settings: Pick<AppSettings, 'dailyCapUsd' | 'monthlyCapUsd'>, now: number): CapUse {
  const d = new Date(now)
  const dayFrom = windowStart('day', now)
  const dayTo = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
  const monthFrom = windowStart('month', now)
  const monthTo = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime()
  let day = 0
  let month = 0
  for (const x of records) {
    // A request without a price counts at the estimate, as it did while it ran. A damaged record must not turn the sum into NaN.
    const est = x.usd === null ? estimate({ in: x.in, cacheRead: x.cacheRead, cacheWrite: x.cacheWrite, out: x.out }) : 0
    const usd = typeof x.usd === 'number' && Number.isFinite(x.usd) ? x.usd : Number.isFinite(est) ? est : 0
    if (x.at >= monthFrom && x.at < monthTo) month += usd
    if (x.at >= dayFrom && x.at < dayTo) day += usd
  }
  return { day, month, dailyCapUsd: settings.dailyCapUsd, monthlyCapUsd: settings.monthlyCapUsd }
}
