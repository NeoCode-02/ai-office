import { describe, expect, it } from 'vitest'
import type { Agent, OfficeEvent } from '../../shared/types'
import { autoLayout, belowOf, buildTree, CARD, canDrag, canMoveUnder, edgePath, liveStatus, maxTokensFrom, moveUnder, orgProblem, sameJson, subtreeOf, type OrgNode } from './orgchart'

const agent = (id: string, reportsTo: string | null, extra: Partial<Agent> = {}): Agent => ({
  id,
  name: id.toUpperCase(),
  title: 'x',
  department: '',
  reportsTo,
  instructions: '',
  providerId: 'p',
  model: 'm',
  tools: [],
  ...extra
})

// ceo ─┬─ cto ── dev
//      └─ mkt
const team = () => [agent('ceo', null), agent('cto', 'ceo'), agent('mkt', 'ceo'), agent('dev', 'cto')]
const shape = (nodes: OrgNode[]): unknown => nodes.map((n) => (n.kids.length ? { [n.agent.id]: shape(n.kids) } : n.agent.id))

describe('buildTree', () => {
  it('nests members under their managers in order', () => {
    expect(shape(buildTree(team()))).toEqual([{ ceo: [{ cto: ['dev'] }, 'mkt'] }])
  })

  it('shows members with a missing manager as extra roots', () => {
    expect(shape(buildTree([...team(), agent('lost', 'gone')]))).toEqual([{ ceo: [{ cto: ['dev'] }, 'mkt'] }, 'lost'])
  })

  it('shows members in a reporting loop once instead of hiding them or looping forever', () => {
    const tree = buildTree([agent('ceo', null), agent('a', 'b'), agent('b', 'a'), agent('self', 'self')])
    expect(shape(tree)).toEqual(['ceo', { a: ['b'] }, 'self'])
  })
})

describe('autoLayout', () => {
  it('puts managers above and centred over their reports, with no two cards overlapping', () => {
    const pos = autoLayout(team())
    const at = (id: string) => pos.get(id)!
    expect(at('ceo').y).toBeLessThan(at('cto').y)
    expect(at('cto').y).toBeLessThan(at('dev').y)
    expect(at('cto').x).toBe(at('dev').x)
    expect(at('ceo').x).toBe((at('cto').x + at('mkt').x) / 2)
    const cards = [...pos.values()]
    for (const a of cards) for (const b of cards) {
      if (a === b) continue
      expect(Math.abs(a.x - b.x) >= CARD.w || Math.abs(a.y - b.y) >= CARD.h, JSON.stringify([a, b])).toBe(true)
    }
  })

  it('draws a line as a rounded elbow, and as a straight drop when the report is right below', () => {
    const boss = { x: 0, y: 0 }
    const mid = CARD.h + 32
    expect(edgePath(boss, { x: 0, y: CARD.h + 64 })).toBe(`M100 ${CARD.h} V${mid} Q100 ${mid} 100 ${mid} H100 Q100 ${mid} 100 ${mid} V${CARD.h + 64}`)
    expect(edgePath(boss, { x: 300, y: CARD.h + 64 })).toBe(`M100 ${CARD.h} V${mid - 10} Q100 ${mid} 110 ${mid} H390 Q400 ${mid} 400 ${mid + 10} V${CARD.h + 64}`)
    // The same commands whatever the positions (a report placed above its manager too), so lines can animate.
    const shape = (d: string) => d.replace(/[-\d. ]+/g, '')
    expect(shape(edgePath(boss, { x: -500, y: -300 }))).toBe(shape(edgePath(boss, { x: 300, y: 156 })))
  })

  it('places a new report one row below its manager, next to the ones already there', () => {
    expect(belowOf({ x: 100, y: 0 }, 0)).toEqual({ x: 100, y: CARD.h + 64 })
    expect(belowOf({ x: 100, y: 0 }, 2).x).toBeGreaterThan(100 + CARD.w)
  })
})

describe('moving a member under another manager', () => {
  it('lists a member and everyone below them, even with a loop', () => {
    expect([...subtreeOf(team(), 'cto')].sort()).toEqual(['cto', 'dev'])
    expect([...subtreeOf([agent('a', 'b'), agent('b', 'a')], 'a')].sort()).toEqual(['a', 'b'])
  })

  it('refuses drops onto themselves, below themselves, or onto the current manager', () => {
    const all = team()
    expect(canMoveUnder(all, 'cto', 'cto')).toBe(false)
    expect(canMoveUnder(all, 'cto', 'dev')).toBe(false)
    expect(canMoveUnder(all, 'dev', 'cto')).toBe(false)
    expect(canMoveUnder(all, 'dev', 'nobody')).toBe(false)
    expect(canMoveUnder(all, 'dev', 'mkt')).toBe(true)
    expect(canMoveUnder(all, 'cto', 'mkt')).toBe(true)
  })

  it('keeps exactly one top executive', () => {
    expect(canDrag(team(), 'ceo')).toBe(false)
    expect(canMoveUnder(team(), 'ceo', 'mkt')).toBe(false)
    // With a second top (e.g. the manager field set to nobody), one of them may move under the other's tree.
    const two = [...team(), agent('cfo', null), agent('acc', 'cfo')]
    expect(canDrag(two, 'ceo')).toBe(true)
    expect(canMoveUnder(two, 'cfo', 'dev')).toBe(true)
    expect(canMoveUnder(two, 'cfo', 'acc')).toBe(false)
    expect(orgProblem(moveUnder(two, 'cfo', 'dev'))).toBeNull()
  })

  it('never moves a fixed executive', () => {
    const all = team().map((a) => (a.id === 'cto' ? { ...a, exec: 'cto' as const } : a))
    expect(canDrag(all, 'cto')).toBe(false)
    expect(canMoveUnder(all, 'cto', 'mkt')).toBe(false)
    // Others may still move under them.
    expect(canMoveUnder(all, 'mkt', 'cto')).toBe(true)
  })

  it('moves only the dragged member and leaves the input untouched', () => {
    const all = team()
    const next = moveUnder(all, 'dev', 'mkt')
    expect(next.find((a) => a.id === 'dev')?.reportsTo).toBe('mkt')
    expect(next.filter((a) => a.id !== 'dev')).toEqual(all.filter((a) => a.id !== 'dev'))
    expect(all.find((a) => a.id === 'dev')?.reportsTo).toBe('cto')
    expect(moveUnder(all, 'cto', 'dev')).toBe(all)
  })
})

describe('liveStatus', () => {
  it('keeps the latest status of each member and ignores other events', () => {
    const ev: OfficeEvent[] = [
      { type: 'status', agentId: 'a', status: 'working', at: 1 },
      { type: 'message', id: 'm', at: 2, from: 'a', to: ['b'], text: 'hi' },
      { type: 'status', agentId: 'b', status: 'blocked', at: 3 },
      { type: 'status', agentId: 'a', status: 'idle', at: 4 }
    ]
    expect(Object.fromEntries(liveStatus(ev))).toEqual({ a: 'idle', b: 'blocked' })
    expect(liveStatus(undefined).size).toBe(0)
  })
})

describe('orgProblem', () => {
  it('accepts a valid team', () => {
    expect(orgProblem(team())).toBeNull()
  })

  it('reports the same codes as the main process', () => {
    expect(orgProblem([])).toBe('E_ORG_EMPTY')
    expect(orgProblem([...team(), agent('cfo', null)])).toBe('E_ORG_CEO')
    expect(orgProblem([...team(), agent('x', 'ceo', { name: ' ' })])).toBe('E_ORG_NAME')
    expect(orgProblem([...team(), agent('x', 'ceo', { name: 'cto ' })])).toBe('E_ORG_DUP|cto ')
    expect(orgProblem([...team(), agent('x', 'ceo', { model: ' ' })])).toBe('E_ORG_MODEL|X')
    expect(orgProblem([...team(), agent('x', 'ceo', { providerId: '' })])).toBe('E_ORG_MODEL|X')
    expect(orgProblem([...team(), agent('x', 'gone')])).toBe('E_ORG_BOSS|X')
    expect(orgProblem([...team(), agent('a', 'b'), agent('b', 'a')])).toBe('E_ORG_CYCLE|A')
  })

  it('wants a model for a chosen backup provider', () => {
    expect(orgProblem([agent('ceo', null, { backup: { providerId: 'q', model: '' } })])).toBe('E_ORG_MODEL|CEO')
    expect(orgProblem([agent('ceo', null, { backup: { providerId: 'q', model: 'small' } })])).toBeNull()
  })
})

describe('maxTokensFrom', () => {
  it('keeps positive whole numbers and treats the rest as the default', () => {
    expect(['', ' ', '0', '-5', 'abc', '1e999'].map(maxTokensFrom)).toEqual([undefined, undefined, undefined, undefined, undefined, undefined])
    expect(['1', '16000', ' 64000 ', '1500.7'].map(maxTokensFrom)).toEqual([1, 16000, 64000, 1500])
  })
})

describe('sameJson', () => {
  it('ignores key order and undefined fields but not values', () => {
    expect(sameJson({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 })).toBe(true)
    expect(sameJson({ a: 1, effort: undefined }, { a: 1 })).toBe(true)
    expect(sameJson({ a: [1, 2] }, { a: [2, 1] })).toBe(false)
    expect(sameJson({ a: 1 }, { a: '1' })).toBe(false)
    expect(sameJson({ a: null }, { a: undefined })).toBe(false)
  })
})
