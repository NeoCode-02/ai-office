import type { Agent, AgentStatus, OfficeEvent } from '../../shared/types'

export interface OrgNode {
  agent: Agent
  kids: OrgNode[]
}

/**
 * The chart as nested nodes. Members whose manager is missing (or who sit in a reporting loop, which
 * older or imported offices can contain) are shown as extra roots, so nobody disappears from the chart.
 */
export function buildTree(agents: Agent[]): OrgNode[] {
  const ids = new Set(agents.map((a) => a.id))
  const kids = new Map<string, Agent[]>()
  for (const a of agents) if (a.reportsTo && ids.has(a.reportsTo)) kids.set(a.reportsTo, [...(kids.get(a.reportsTo) ?? []), a])
  const seen = new Set<string>()
  const node = (a: Agent): OrgNode => {
    seen.add(a.id)
    return { agent: a, kids: (kids.get(a.id) ?? []).filter((k) => !seen.has(k.id)).map(node) }
  }
  const roots = agents.filter((a) => !a.reportsTo || !ids.has(a.reportsTo)).map(node)
  for (const a of agents) if (!seen.has(a.id)) roots.push(node(a))
  return roots
}

export interface Point {
  x: number
  y: number
}

/** Card size and spacing on the team canvas (CSS uses the same card size). */
export const CARD = { w: 200, h: 92 }
const GAP = { x: 28, y: 64 }

/**
 * Default card positions: each leaf gets its own column, a manager sits centred over their reports,
 * one row per level. Cards never overlap.
 */
export function autoLayout(agents: Agent[]): Map<string, Point> {
  const out = new Map<string, Point>()
  let column = 0
  const place = (n: OrgNode, depth: number): number => {
    const xs = n.kids.map((k) => place(k, depth + 1))
    const x = xs.length ? (xs[0] + xs[xs.length - 1]) / 2 : column++ * (CARD.w + GAP.x)
    out.set(n.agent.id, { x, y: depth * (CARD.h + GAP.y) })
    return x
  }
  for (const root of buildTree(agents)) place(root, 0)
  return out
}

/** Where a new report of `boss` goes: one row below, right of the reports already there. */
export function belowOf(boss: Point, reports: number): Point {
  return { x: boss.x + reports * (CARD.w + GAP.x), y: boss.y + CARD.h + GAP.y }
}

/** A manager → report line: from the bottom middle of one card to the top middle of the other. */
export function edgePath(from: Point, to: Point): string {
  const x1 = from.x + CARD.w / 2
  const y1 = from.y + CARD.h
  const x2 = to.x + CARD.w / 2
  const bend = Math.max(30, Math.abs(to.y - y1) / 2)
  return `M${x1} ${y1} C${x1} ${y1 + bend} ${x2} ${to.y - bend} ${x2} ${to.y}`
}

/** The member and everyone below them. Safe on reporting loops. */
export function subtreeOf(agents: Agent[], id: string): Set<string> {
  const out = new Set<string>()
  const todo = [id]
  while (todo.length) {
    const cur = todo.pop()!
    if (out.has(cur)) continue
    out.add(cur)
    for (const a of agents) if (a.reportsTo === cur) todo.push(a.id)
  }
  return out
}

const tops = (agents: Agent[]) => agents.filter((a) => !a.reportsTo).length

/** The fixed executives never move; a top member can only move under someone while another top remains. */
export const canDrag = (agents: Agent[], id: string) => {
  const a = agents.find((x) => x.id === id)
  return !!a && !a.exec && (!!a.reportsTo || tops(agents) > 1)
}

/** Whether `id` may be dropped onto `boss`: not onto themselves or anyone below them, and not a no-op. */
export function canMoveUnder(agents: Agent[], id: string, boss: string): boolean {
  if (id === boss || !canDrag(agents, id)) return false
  const a = agents.find((x) => x.id === id)
  if (!a || a.reportsTo === boss || !agents.some((x) => x.id === boss)) return false
  return !subtreeOf(agents, id).has(boss)
}

export function moveUnder(agents: Agent[], id: string, boss: string): Agent[] {
  if (!canMoveUnder(agents, id, boss)) return agents
  return agents.map((a) => (a.id === id ? { ...a, reportsTo: boss } : a))
}

/** Each member's latest status in a run (the same rule the Work view uses). */
export function liveStatus(events: OfficeEvent[] | undefined): Map<string, AgentStatus> {
  const out = new Map<string, AgentStatus>()
  for (const e of events ?? []) if (e.type === 'status') out.set(e.agentId, e.status)
  return out
}

/**
 * Problems that would stop a task from starting, as an error code for errText (the same checks as
 * the main process), or null when the team is fine.
 */
export function orgProblem(agents: Agent[]): string | null {
  if (!agents.length) return 'E_ORG_EMPTY'
  if (tops(agents) !== 1) return 'E_ORG_CEO'
  const byId = new Map(agents.map((a) => [a.id, a]))
  const names = new Set<string>()
  for (const a of agents) {
    const key = a.name.trim().toLowerCase()
    if (!key) return 'E_ORG_NAME'
    if (names.has(key)) return `E_ORG_DUP|${a.name}`
    names.add(key)
    if (!a.model.trim() || !a.providerId) return `E_ORG_MODEL|${a.name}`
    if (a.backup && (!a.backup.providerId || !a.backup.model.trim())) return `E_ORG_MODEL|${a.name}`
    const seen = new Set<string>()
    for (let cur: Agent | undefined = a; cur?.reportsTo; cur = byId.get(cur.reportsTo)) {
      if (!byId.has(cur.reportsTo)) return `E_ORG_BOSS|${cur.name}`
      if (seen.has(cur.id)) return `E_ORG_CYCLE|${a.name}`
      seen.add(cur.id)
    }
  }
  return null
}

/** "Longest reply" field text → a positive whole number of tokens, or undefined (the default). */
export function maxTokensFrom(s: string): number | undefined {
  const n = Math.floor(Number(s.trim()))
  return s.trim() && Number.isFinite(n) && n >= 1 ? n : undefined
}

/** Deep equality of JSON data, ignoring key order and undefined fields. */
export function sameJson(a: unknown, b: unknown): boolean {
  return canon(a) === canon(b)
}

function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canon(x))).join(',')}]`
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon(o[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v) ?? 'null'
}
