import { describe, expect, it } from 'vitest'
import type { OfficeEvent } from '../../shared/types'
import { applyLive, createBatcher, officeState, waitingCount, type Live, type LiveItem } from './live'

const msg = (id: string, at = 1): OfficeEvent => ({ type: 'message', id, at, from: 'a', to: ['b'], text: id })
const run = (state: 'running' | 'done' | 'stopped', reason?: string, at = 1): OfficeEvent => ({ type: 'run', runId: 'r1', state, reason, at })
const ev = (projectId: string, runId: string, e: OfficeEvent): LiveItem => ({ projectId, runId, ev: e })

describe('applyLive', () => {
  it('appends a batch with one copy per office and leaves the old state alone', () => {
    const before: Record<string, Live> = { p1: { runId: 'r1', events: [msg('a')] } }
    const frozen = before.p1.events
    const after = applyLive(before, [ev('p1', 'r1', msg('b')), ev('p1', 'r1', msg('c')), ev('p2', 'r9', msg('x'))])
    expect(after.p1.events.map((e) => (e.type === 'message' ? e.id : ''))).toEqual(['a', 'b', 'c'])
    expect(after.p2).toEqual({ runId: 'r9', events: [msg('x')] })
    expect(frozen).toHaveLength(1)
    expect(before.p1.events).toBe(frozen)
    expect(before.p2).toBeUndefined()
  })

  it('starts over when a new run begins', () => {
    const after = applyLive({ p1: { runId: 'r1', events: [msg('a'), msg('b')] } }, [ev('p1', 'r2', msg('c')), ev('p1', 'r2', msg('d'))])
    expect(after.p1).toEqual({ runId: 'r2', events: [msg('c'), msg('d')] })
  })

  it('returns the same object for an empty batch', () => {
    const live = { p1: { runId: 'r1', events: [msg('a')] } }
    expect(applyLive(live, [])).toBe(live)
  })

  it('merges a saved log with events that were pushed while it was read, without duplicates', () => {
    const saved = [run('running', undefined, 1), msg('a', 2), msg('b', 3)]
    const pushed: Live = { runId: 'r1', events: [msg('b', 3), msg('c', 3), msg('d', 4)] }
    const after = applyLive({ p1: pushed }, [{ projectId: 'p1', runId: 'r1', snapshot: saved }, ev('p1', 'r1', msg('e', 5))])
    expect(after.p1.events).toEqual([...saved, msg('c', 3), msg('d', 4), msg('e', 5)])
    expect(pushed.events).toHaveLength(3)
  })

  it('takes a saved log as is when nothing was pushed yet, and ignores it once a newer run is live', () => {
    const saved = [msg('a')]
    const first = applyLive({}, [{ projectId: 'p1', runId: 'r1', snapshot: saved }])
    expect(first.p1).toEqual({ runId: 'r1', events: [msg('a')] })
    expect(first.p1.events).not.toBe(saved)
    const newer = { p1: { runId: 'r2', events: [msg('z')] } }
    expect(applyLive(newer, [{ projectId: 'p1', runId: 'r1', snapshot: saved }]).p1).toBe(newer.p1)
  })
})

describe('createBatcher', () => {
  it('delivers everything pushed before a tick in one call, in order', () => {
    const ticks: (() => void)[] = []
    const got: number[][] = []
    const b = createBatcher<number>(
      (items) => got.push(items),
      (fn) => {
        ticks.push(fn)
        return () => undefined
      }
    )
    b.push(1)
    b.push(2)
    b.push(3)
    expect(ticks).toHaveLength(1)
    ticks[0]()
    expect(got).toEqual([[1, 2, 3]])
    b.push(4)
    expect(ticks).toHaveLength(2)
    ticks[1]()
    expect(got).toEqual([[1, 2, 3], [4]])
  })

  it('drops pending items and cancels the tick on dispose', () => {
    let cancelled = false
    let tick: (() => void) | undefined
    const got: number[][] = []
    const b = createBatcher<number>(
      (items) => got.push(items),
      (fn) => {
        tick = fn
        return () => {
          cancelled = true
        }
      }
    )
    b.push(1)
    b.dispose()
    expect(cancelled).toBe(true)
    tick?.()
    expect(got).toEqual([])
  })
})

describe('waitingCount', () => {
  const approval = (id: string): OfficeEvent => ({ type: 'approval', id, agentId: 'a', kind: 'command', command: 'ls', at: 2 })
  const blocked = (id: string): OfficeEvent => ({ type: 'blocked', id, agentId: 'a', providerId: 'p', model: 'm', kind: 'quota', detail: '', at: 2 })
  const plan = (id: string): OfficeEvent => ({ type: 'plan', id, agentId: 'a', text: '1. Build', at: 2 })

  it('counts open approvals, plans and stopped members while the run works', () => {
    expect(waitingCount([run('running'), approval('x'), blocked('y'), plan('z')])).toBe(3)
    expect(
      waitingCount([
        run('running'),
        approval('x'),
        { type: 'approval_done', id: 'x', approved: true, at: 3 },
        blocked('y'),
        { type: 'unblocked', id: 'y', agentId: 'a', at: 3 },
        plan('z'),
        { type: 'plan_done', id: 'z', approved: false, feedback: 'smaller', at: 3 }
      ])
    ).toBe(0)
  })

  it('keeps a plan waiting after the office went idle for it, and nothing else after the run ended', () => {
    expect(waitingCount([run('running'), plan('z'), run('done', 'plan')])).toBe(1)
    // Older versions ended a run without answering its open approvals.
    expect(waitingCount([run('running'), approval('x'), run('stopped', 'owner_stopped')])).toBe(0)
    expect(waitingCount([])).toBe(0)
  })
})

describe('officeState', () => {
  it('reports a running office and reuses the answer for the same event list', () => {
    const live: Live = { runId: 'r1', events: [run('running')] }
    const a = officeState(live)
    expect(a).toEqual({ running: true, waiting: 0 })
    expect(officeState(live)).toBe(a)
    expect(officeState({ runId: 'r1', events: [run('running'), run('done', 'idle')] })).toEqual({ running: false, waiting: 0 })
    expect(officeState(undefined)).toEqual({ running: false, waiting: 0 })
  })
})
