import { USER, type AgentStatus, type FileChange, type OfficeEvent, type RunSummary } from '../../../shared/types'
import type { Dict } from '../i18n'

export type Ev<T extends OfficeEvent['type']> = Extract<OfficeEvent, { type: T }>
export type ToolEv = Ev<'tool'>
export type RunEv = Ev<'run'>

/** One row of the feed. `key` stays the same while the run grows, so React keeps each row's state. */
export type Item =
  | { kind: 'message'; key: string; e: Ev<'message'> }
  | { kind: 'tools'; key: string; agentId: string; list: ToolEv[] }
  | { kind: 'approval'; key: string; e: Ev<'approval'>; done?: Ev<'approval_done'> }
  /** open: the owner can still answer it. replaced: a newer plan took its place. */
  | { kind: 'plan'; key: string; e: Ev<'plan'>; done?: Ev<'plan_done'>; open: boolean; replaced: boolean }
  | { kind: 'end'; key: string; e: RunEv }
  | { kind: 'notice'; key: string; e: Ev<'notice'> }
  | { kind: 'switch'; key: string; e: Ev<'switch'> }
  | { kind: 'compact'; key: string; e: Ev<'compact'> }
  | { kind: 'blocked'; key: string; e: Ev<'blocked'>; resolved: boolean }

// Saved runs are plain JSON, so an id may be missing in old or hand-edited logs.
const keyOf = (prefix: string, id: string | undefined, i: number) => `${prefix}:${id || `#${i}`}`

export function buildItems(events: readonly OfficeEvent[]): Item[] {
  const approvals = new Map<string, Ev<'approval_done'>>()
  const plans = new Map<string, Ev<'plan_done'>>()
  const unblocked = new Set<string>()
  let lastPlan = ''
  let lastRun: RunEv | undefined
  for (const e of events) {
    if (e.type === 'approval_done') approvals.set(e.id, e)
    else if (e.type === 'plan_done') plans.set(e.id, e)
    else if (e.type === 'unblocked') unblocked.add(e.id)
    else if (e.type === 'plan') lastPlan = e.id
    else if (e.type === 'run') lastRun = e
  }
  const planWaits = lastRun?.state === 'running' || (lastRun?.state === 'done' && lastRun.reason === 'plan')

  const out: Item[] = []
  events.forEach((e, i) => {
    const last = out.at(-1)
    switch (e.type) {
      case 'message':
        out.push({ kind: 'message', key: keyOf('m', e.id, i), e })
        break
      case 'tool':
        if (last?.kind === 'tools' && last.agentId === e.agentId) last.list.push(e)
        else out.push({ kind: 'tools', key: keyOf('t', e.id, i), agentId: e.agentId, list: [e] })
        break
      case 'approval':
        out.push({ kind: 'approval', key: keyOf('a', e.id, i), e, done: approvals.get(e.id) })
        break
      case 'plan': {
        const done = plans.get(e.id)
        const latest = e.id === lastPlan
        const replaced = !latest && (!done || (!done.approved && !done.feedback))
        out.push({ kind: 'plan', key: keyOf('p', e.id, i), e, done, open: !done && latest && planWaits, replaced })
        break
      }
      case 'run':
        if (e.state !== 'running') out.push({ kind: 'end', key: `r:${i}`, e })
        break
      case 'notice':
        // Only the latest retry of a member is worth a line; it keeps the first line's key.
        if (last?.kind === 'notice' && last.e.agentId === e.agentId) out[out.length - 1] = { ...last, e }
        else out.push({ kind: 'notice', key: `n:${i}`, e })
        break
      case 'switch':
        out.push({ kind: 'switch', key: `s:${i}`, e })
        break
      case 'compact':
        out.push({ kind: 'compact', key: `c:${i}`, e })
        break
      case 'blocked':
        out.push({ kind: 'blocked', key: keyOf('b', e.id, i), e, resolved: unblocked.has(e.id) })
        break
    }
  })
  return out
}

/** The feed while the owner looks at one member: their messages and work, plus the run's end lines. */
export function forMember(items: Item[], focus: string | null): Item[] {
  if (!focus) return items
  return items.filter((i) => {
    if (i.kind === 'message') return i.e.from === focus || i.e.to.includes(focus)
    if (i.kind === 'tools') return i.agentId === focus
    if (i.kind === 'end') return true
    return i.e.agentId === focus
  })
}

/** Rows are rebuilt on every event; this tells which ones actually changed. */
export function sameItem(a: Item, b: Item): boolean {
  if (a.kind !== b.kind || a.key !== b.key) return false
  switch (a.kind) {
    case 'tools': {
      const l = (b as typeof a).list
      return a.list.length === l.length && a.list.at(-1) === l.at(-1)
    }
    case 'approval': {
      const o = b as typeof a
      return a.e === o.e && a.done === o.done
    }
    case 'plan': {
      const o = b as typeof a
      return a.e === o.e && a.done === o.done && a.open === o.open && a.replaced === o.replaced
    }
    case 'blocked': {
      const o = b as typeof a
      return a.e === o.e && a.resolved === o.resolved
    }
    default:
      return a.e === (b as typeof a).e
  }
}

export interface Summary {
  status: Map<string, AgentStatus>
  /** When each member's current status began. */
  since: Map<string, number>
  cost: Map<string, number>
  total: number
  toks: number
  unpriced: number
  lastRun: RunEv | null
  goal: string
  /** Calls that may change workspace files (writes, edits, commands), to know when to look again. */
  writes: number
}

const WRITES = new Set(['write_file', 'edit_file', 'run_command'])

export function summarize(events: readonly OfficeEvent[]): Summary {
  const s: Summary = { status: new Map(), since: new Map(), cost: new Map(), total: 0, toks: 0, unpriced: 0, lastRun: null, goal: '', writes: 0 }
  for (const e of events) {
    if (e.type === 'status') {
      if (s.status.get(e.agentId) !== e.status) s.since.set(e.agentId, e.at)
      s.status.set(e.agentId, e.status)
    } else if (e.type === 'cost') {
      // Without a price, the estimate the budget counted, so the meter agrees with when the budget stops.
      const usd = e.usd ?? e.est ?? 0
      s.cost.set(e.agentId, (s.cost.get(e.agentId) ?? 0) + usd)
      s.total += usd
      if (e.usd === null) s.unpriced++
      s.toks += e.usage ? e.usage.in + e.usage.cacheRead + e.usage.cacheWrite + e.usage.out : (e.inTok ?? 0) + (e.outTok ?? 0)
    } else if (e.type === 'run') s.lastRun = e
    else if (e.type === 'message' && !s.goal && e.from === USER) s.goal = e.text
    else if (e.type === 'tool' && WRITES.has(e.name)) s.writes++
  }
  return s
}

/** What a run's end line says. Codes added in v0.3 live in t.run.reasons, the older ones in t.work.reasons. */
export function endText(e: RunEv, t: Dict): string {
  const r = t.run.reasons
  switch (e.reason) {
    case 'limit':
      return r.limit(e.requests ?? 0)
    case 'loop':
      return r.loop(e.agents ?? [])
    case 'cap':
      return r.cap(e.usd ?? 0)
    case 'plan':
      return r.plan
    case 'app_closed':
      return r.app_closed
  }
  const old = t.work.reasons[e.reason ?? '']
  if (typeof old === 'function') return old(e.usd ?? 0)
  return old ?? (e.state === 'done' ? t.work.done : t.work.stopped)
}

/** Same characters as the main process: a command with any of them can't be allowed for good. */
const CONTROL = /[;&|`$<>(){}\n\r]/
export const hasShellControl = (command: string) => CONTROL.test(command)

export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export function firstFiles(files: readonly string[] | undefined, n = 8) {
  const all = files ?? []
  return { shown: all.slice(0, n), more: Math.max(0, all.length - n) }
}

export type DiffKind = 'add' | 'del' | 'hunk' | 'meta' | 'ctx'

/** Unified diff lines with their role. Headers only count as headers before the first hunk. */
export function diffLines(text: string): { kind: DiffKind; text: string }[] {
  if (!text) return []
  let inHunk = false
  return text.replace(/\n$/, '').split('\n').map((line) => {
    if (line.startsWith('diff ')) inHunk = false
    else if (line.startsWith('@@')) {
      inHunk = true
      return { kind: 'hunk' as const, text: line }
    }
    if (!inHunk || line.startsWith('\\') || line.startsWith('… ')) return { kind: 'meta' as const, text: line }
    const kind: DiffKind = line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : 'ctx'
    return { kind, text: line }
  })
}

export function changeTotals(files: readonly FileChange[]) {
  return files.reduce((t, f) => ({ add: t.add + f.additions, del: t.del + f.deletions }), { add: 0, del: 0 })
}

/** Budget meter: amber from 80 %, red once it is used up. */
export function budgetMeter(spent: number, budget: number): { pct: number; level: 'ok' | 'high' | 'full' } | null {
  if (!(budget > 0)) return null
  const r = spent / budget
  return { pct: Math.min(100, Math.max(0, r * 100)), level: r >= 1 ? 'full' : r >= 0.8 ? 'high' : 'ok' }
}

/** The raise-budget field starts at twice the budget, but always above what is already spent. */
export function suggestBudget(budget: number, spent: number): string {
  const v = budget * 2 > spent ? budget * 2 : Math.ceil(spent) + 1
  return String(Math.round(v * 100) / 100)
}

/** A new budget must leave room to work (or be 0 = no limit). */
export function parseBudget(input: string, spent: number): number | null {
  const s = input.trim().replace(',', '.')
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(s)) return null
  const v = Number(s)
  return Number.isFinite(v) && (v === 0 || v > spent) ? v : null
}

// Uzbek is typed with any of these apostrophes; search should not care which.
const fold = (s: string) => s.toLocaleLowerCase().replace(/[‘’ʻʼ`´]/g, "'")

export function matchRuns(runs: readonly RunSummary[], query: string): RunSummary[] {
  const terms = fold(query).split(/\s+/).filter(Boolean)
  if (!terms.length) return [...runs]
  return runs.filter((r) => {
    const goal = fold(r.goal)
    return terms.every((t) => goal.includes(t))
  })
}

/** Alt+A / Alt+D answer the only pending approval. `code` keeps it working on layouts where Alt changes the character. */
export function approvalShortcut(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; code: string; repeat?: boolean }): 'allow' | 'deny' | null {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.repeat) return null
  return e.code === 'KeyA' ? 'allow' : e.code === 'KeyD' ? 'deny' : null
}

/** Typing somewhere: shortcuts must not steal the keys. */
export function isEditable(el: { tagName?: string; isContentEditable?: boolean } | null | undefined): boolean {
  if (!el) return false
  return el.isContentEditable === true || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName ?? '')
}

export const elapsed = (now: number, since: number | undefined) => (since === undefined ? null : Math.max(0, Math.floor((now - since) / 1000)))

/** The `E_CODE` of a main-process error (same unwrapping as errText), to react to specific errors. */
export function errCode(e: unknown): string | null {
  const raw = (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
  return /^(E_[A-Z_]+)(?:\||$)/.exec(raw)?.[1] ?? null
}

/** System lines that inform rather than report a failure. */
const WARN_CODES = /^(?:[^:]*: )?(E_UNPRICED|E_NO_GIT|E_CHECKPOINT_TOO_BIG)\b/
export const systemWarn = (text: string) => WARN_CODES.test(text)
