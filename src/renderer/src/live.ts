import type { OfficeEvent } from '../../shared/types'

/** The current (or last) run of an office as the renderer knows it. */
export interface Live {
  runId: string
  events: OfficeEvent[]
}

/** One pushed event, or the saved log of a run read back after a reload. */
export type LiveItem = { projectId: string; runId: string; ev: OfficeEvent } | { projectId: string; runId: string; snapshot: OfficeEvent[] }

/**
 * Applies a batch in arrival order, copying each office's event list at most once per batch.
 * Never mutates `live` (it is React state).
 */
export function applyLive(live: Record<string, Live>, batch: LiveItem[]): Record<string, Live> {
  if (!batch.length) return live
  const next = { ...live }
  const owned = new Set<string>()
  for (const item of batch) {
    const cur = next[item.projectId]
    if ('snapshot' in item) {
      // A newer run already pushed events: the snapshot is stale.
      if (cur && cur.runId !== item.runId) continue
      next[item.projectId] = { runId: item.runId, events: cur ? withSnapshot(item.snapshot, cur.events) : [...item.snapshot] }
      owned.add(item.projectId)
    } else if (cur?.runId === item.runId && owned.has(item.projectId)) {
      cur.events.push(item.ev)
    } else {
      next[item.projectId] = { runId: item.runId, events: cur?.runId === item.runId ? [...cur.events, item.ev] : [item.ev] }
      owned.add(item.projectId)
    }
  }
  return next
}

/** The saved log plus pushed events it does not contain yet (they may overlap at its end). */
function withSnapshot(saved: OfficeEvent[], pushed: OfficeEvent[]): OfficeEvent[] {
  const lastAt = saved.at(-1)?.at ?? -Infinity
  const tail = new Set(saved.filter((e) => e.at >= lastAt).map((e) => JSON.stringify(e)))
  return [...saved, ...pushed.filter((e) => e.at > lastAt || (e.at === lastAt && !tail.has(JSON.stringify(e))))]
}

/**
 * Collects items and hands them over in one call per scheduled tick (an animation frame in the app),
 * so a burst of events causes one React update instead of one per event.
 */
export function createBatcher<T>(flush: (items: T[]) => void, schedule: (fn: () => void) => () => void) {
  let items: T[] = []
  let cancel: (() => void) | null = null
  const run = () => {
    cancel = null
    const batch = items
    items = []
    if (batch.length) flush(batch)
  }
  return {
    push(item: T) {
      items.push(item)
      if (!cancel) cancel = schedule(run)
    },
    dispose() {
      cancel?.()
      cancel = null
      items = []
    }
  }
}

/** Approvals, plans and stopped members waiting for the owner in this run. */
export function waitingCount(events: OfficeEvent[]): number {
  const open = new Set<string>()
  const plans = new Set<string>()
  let state: string | undefined
  let reason: string | undefined
  for (const e of events) {
    if (e.type === 'approval' || e.type === 'blocked') open.add(e.id)
    else if (e.type === 'approval_done' || e.type === 'unblocked') open.delete(e.id)
    else if (e.type === 'plan') plans.add(e.id)
    else if (e.type === 'plan_done') plans.delete(e.id)
    else if (e.type === 'run') {
      state = e.state
      reason = e.reason
    }
  }
  if (state === 'running') return open.size + plans.size
  // An office that went idle with a plan waits for its approval; anything else ended with the run.
  return reason === 'plan' ? plans.size : 0
}

export const isRunning = (events: OfficeEvent[]) => {
  const last = events.findLast((e) => e.type === 'run')
  return last?.type === 'run' && last.state === 'running'
}

// applyLive never changes a list after handing it out, so a list's state can be kept.
const states = new WeakMap<OfficeEvent[], { running: boolean; waiting: number }>()

/** Whether the office works right now and how many things wait for the owner (for the sidebar). */
export function officeState(live?: Live): { running: boolean; waiting: number } {
  if (!live) return { running: false, waiting: 0 }
  let s = states.get(live.events)
  if (!s) {
    s = { running: isRunning(live.events), waiting: waitingCount(live.events) }
    states.set(live.events, s)
  }
  return s
}
