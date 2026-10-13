import type { AppSettings, OfficeEvent, Project, UsageRecord } from '../shared/types'
import { capUse } from './stats'

/** What waits for the owner (approvals, plans, blocked members) per office: drives the badge. */
export function createAttention() {
  const pending = new Map<string, Set<string>>()
  const of = (projectId: string) => pending.get(projectId) ?? pending.set(projectId, new Set()).get(projectId)!
  return {
    /** Returns true when the count may have changed. */
    track(projectId: string, ev: OfficeEvent): boolean {
      const set = of(projectId)
      if (ev.type === 'approval' || ev.type === 'plan' || ev.type === 'blocked') set.add(ev.id)
      else if (ev.type === 'approval_done' || ev.type === 'plan_done' || ev.type === 'unblocked') set.delete(ev.id)
      else if (ev.type === 'run' && ev.state !== 'running' && ev.reason !== 'plan') set.clear()
      else return false
      return true
    },
    forget: (projectId: string) => pending.delete(projectId),
    count: () => [...pending.values()].reduce((n, s) => n + s.size, 0)
  }
}

/**
 * At most one send per key per `ms`; the latest value always arrives, and null (finished)
 * is sent at once after any pending value.
 */
export function throttle(send: (key: string, value: string | null) => void, ms = 50) {
  const last = new Map<string, number>()
  const timers = new Map<string, { timer: ReturnType<typeof setTimeout>; value: string }>()
  const flush = (key: string) => {
    const t = timers.get(key)
    if (!t) return
    clearTimeout(t.timer)
    timers.delete(key)
    last.set(key, Date.now())
    send(key, t.value)
  }
  return (key: string, value: string | null) => {
    if (value === null) {
      flush(key)
      last.delete(key)
      send(key, null)
      return
    }
    const pending = timers.get(key)
    if (pending) {
      pending.value = value
      return
    }
    const wait = (last.get(key) ?? 0) + ms - Date.now()
    if (wait <= 0) {
      last.set(key, Date.now())
      send(key, value)
    } else timers.set(key, { timer: setTimeout(() => flush(key), wait), value })
  }
}

/** App-wide spend caps: today's and this month's spend kept in memory, seeded from the usage log. */
export function createCaps(records: UsageRecord[], now = Date.now()) {
  let day = 0
  let month = 0
  let dayKey = ''
  let monthKey = ''
  const keys = (t: number) => {
    const d = new Date(t)
    return [`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`, `${d.getFullYear()}-${d.getMonth()}`]
  }
  const roll = (t: number) => {
    const [dk, mk] = keys(t)
    if (dk !== dayKey) day = 0
    if (mk !== monthKey) month = 0
    dayKey = dk
    monthKey = mk
  }
  const seed = capUse(records, { dailyCapUsd: 0, monthlyCapUsd: 0 }, now)
  roll(now)
  day = seed.day
  month = seed.month
  return {
    add(usd: number, at = Date.now()) {
      roll(at)
      if (Number.isFinite(usd) && usd > 0) {
        day += usd
        month += usd
      }
    },
    use(s: Pick<AppSettings, 'dailyCapUsd' | 'monthlyCapUsd'>, at = Date.now()) {
      roll(at)
      return { day, month, dailyCapUsd: s.dailyCapUsd, monthlyCapUsd: s.monthlyCapUsd }
    },
    /** Which cap is reached ('day' wins), or null. A cap of 0 means none. */
    reached(s: Pick<AppSettings, 'dailyCapUsd' | 'monthlyCapUsd'>, at = Date.now()): 'day' | 'month' | null {
      roll(at)
      if (s.dailyCapUsd > 0 && day >= s.dailyCapUsd) return 'day'
      if (s.monthlyCapUsd > 0 && month >= s.monthlyCapUsd) return 'month'
      return null
    }
  }
}

/** "Name (Office), …" for every member using the provider, as main model or backup. */
export function providerUsers(projects: Project[], providerId: string): string {
  return projects
    .flatMap((p) => p.agents.filter((a) => a.providerId === providerId || a.backup?.providerId === providerId).map((a) => `${a.name} (${p.name})`))
    .join(', ')
}

/** The project with one more allow-list rule (unchanged when it is already there). */
export function withRule(p: Project, rule: string): Project {
  const list = p.allowCommands ?? []
  return list.includes(rule) ? p : { ...p, allowCommands: [...list, rule] }
}

/** A file name from free text: no path or reserved characters, not empty, not too long. */
export function fileName(text: string, ext: string, fallback = 'ai-office'): string {
  const base = [...text]
    .map((c) => (c.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(c) ? ' ' : c))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 60)
    .trim()
  // Windows refuses these names whatever the extension.
  return `${base && !/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(base) ? base : fallback}${ext}`
}
