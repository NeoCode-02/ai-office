import { DEFAULT_LIMITS, DEFAULT_SANDBOX, type Project, type Sandbox } from '../../shared/types'
import { sameJson } from './orgchart'

/** Office settings while they are edited. Numbers stay text so a field can be empty while typing. */
export interface OfficeForm {
  name: string
  workspaceDir: string
  briefing: string
  approval: Project['approval']
  budget: string
  maxRequests: string
  maxChatter: string
  compactAt: string
  planFirst: boolean
  sandbox: Sandbox
  allowCommands: string[]
  checkpoints: boolean
}

export function toForm(p: Project): OfficeForm {
  const limits = { ...DEFAULT_LIMITS, ...p.limits }
  return {
    name: p.name,
    workspaceDir: p.workspaceDir,
    briefing: p.briefing,
    approval: p.approval,
    budget: String(p.budgetUsd ?? 0),
    maxRequests: String(limits.maxRequests),
    maxChatter: String(limits.maxChatter),
    compactAt: String(limits.compactAt),
    planFirst: p.planFirst ?? false,
    sandbox: { ...DEFAULT_SANDBOX, ...p.sandbox },
    allowCommands: [...(p.allowCommands ?? [])],
    checkpoints: p.checkpoints ?? true
  }
}

/** Text → a number ≥ 0; empty or invalid text is 0 ("off" / "no limit"). */
export function amount(s: string, whole = false): number {
  const n = Number(s.trim())
  if (!s.trim() || !Number.isFinite(n) || n < 0) return 0
  return whole ? Math.floor(n) : n
}

/** Leaves a setting missing when it was missing and is still the default, so untouched old offices stay as they were. */
const keep = <T>(before: T | undefined, value: T, def: T): T | undefined => (before === undefined && sameJson(value, def) ? undefined : value)

/** The project with the form applied on top of `base`. */
export function fromForm(f: OfficeForm, base: Project): Project {
  const limits = { maxRequests: amount(f.maxRequests, true), maxChatter: amount(f.maxChatter, true), compactAt: amount(f.compactAt, true) }
  // Docker needs an image (the page checks it); with Docker off an emptied field falls back to the default.
  const image = f.sandbox.image.trim() || (f.sandbox.kind === 'none' ? DEFAULT_SANDBOX.image : '')
  const sandbox: Sandbox = { kind: f.sandbox.kind, image, network: f.sandbox.network }
  return {
    ...base,
    name: f.name,
    workspaceDir: f.workspaceDir,
    briefing: f.briefing,
    approval: f.approval,
    budgetUsd: amount(f.budget),
    limits: keep(base.limits, limits, DEFAULT_LIMITS),
    planFirst: keep(base.planFirst, f.planFirst, false),
    sandbox: keep(base.sandbox, sandbox, DEFAULT_SANDBOX),
    allowCommands: keep(base.allowCommands, f.allowCommands, []),
    checkpoints: keep(base.checkpoints, f.checkpoints, true)
  }
}

export const isDirty = (f: OfficeForm, base: Project) => !sameJson(fromForm(f, base), base)

/**
 * Three-way merge of the allow list: the main process adds entries while this page is open (the owner
 * clicks "always allow" in the work view). Keep the owner's removals and the entries added meanwhile.
 */
export function mergeAllow(loaded: string[] = [], edited: string[] = [], latest: string[] = []): string[] {
  const added = latest.filter((x) => !loaded.includes(x))
  return [...new Set([...edited, ...added])]
}

/**
 * What to save: the owner's edits on top of the latest saved office. Fields they did not touch take
 * the latest value (the budget may have been raised from the work view, the team saved from the Team
 * page, permissions added by the main process), and the allow list is merged.
 */
export function saveForm(f: OfficeForm, loaded: Project, latest: Project): Project {
  const was = toForm(loaded)
  const now = toForm(latest)
  const keys = Object.keys(f) as (keyof OfficeForm)[]
  const merged = Object.fromEntries(keys.map((k) => [k, sameJson(f[k], was[k]) ? now[k] : f[k]])) as unknown as OfficeForm
  merged.allowCommands = mergeAllow(loaded.allowCommands, f.allowCommands, latest.allowCommands)
  return fromForm(merged, latest)
}

/** The office as last saved: the app's copy can lag behind the main process. Falls back to `p`. */
export async function latestProject(p: Project): Promise<Project> {
  try {
    return (await window.office.listProjects()).find((x) => x.id === p.id) ?? p
  } catch {
    return p
  }
}

export type AllowKind = 'command' | 'mcp' | 'fetch'

/** An allow-list entry: `mcp:<server › tool>`, `fetch:<host>` or a command prefix. */
export function allowEntry(entry: string): { kind: AllowKind; text: string } {
  if (entry.startsWith('mcp:')) return { kind: 'mcp', text: entry.slice(4) }
  if (entry.startsWith('fetch:')) return { kind: 'fetch', text: entry.slice(6) }
  return { kind: 'command', text: entry }
}
