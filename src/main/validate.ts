import { EXEC_KINDS, TOOL_NAMES, type Agent, type AppSettings, type Billing, type Effort, type Limits, type McpServer, type ModelRef, type Price, type Project, type Provider, type Sandbox } from '../shared/types'

/**
 * Shape checks for values that cross a trust boundary (IPC arguments, imported files).
 * Every check returns a boolean and never throws. Unknown extra keys are tolerated; keys that
 * could pollute prototypes are not.
 */

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype'])
const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
/** Docker image reference; never starts with "-", so it can't be read as a docker option. */
const IMAGE = /^[A-Za-z0-9][A-Za-z0-9._\-/:@]*$/
/** Ids name folders and files, so only plain characters. */
const ID = /^[A-Za-z0-9_-]{1,64}$/

export const str = (v: unknown, max = 100_000): v is string => typeof v === 'string' && v.length <= max
export const optStr = (v: unknown, max = 100_000): v is string | undefined => v === undefined || str(v, max)
export const bool = (v: unknown): v is boolean => typeof v === 'boolean'
/** A finite number in [min, max]. */
export const num = (v: unknown, min = -Infinity, max = Infinity): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
export const isId = (v: unknown): v is string => typeof v === 'string' && ID.test(v)

const filled = (v: unknown, max: number): v is string => str(v, max) && v.trim().length > 0
const oneOf = <T extends string>(v: unknown, list: readonly T[]): v is T => typeof v === 'string' && (list as readonly string[]).includes(v)
const rate = (v: unknown) => num(v, 0)
const optRate = (v: unknown) => v === undefined || rate(v)

/** A plain object (JSON / structured clone) without prototype-polluting keys. */
export function obj(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  if (proto !== Object.prototype && proto !== null) return false
  return !Object.keys(v).some((k) => FORBIDDEN.has(k))
}

/** Index loop on purpose: `every` would skip the holes of a sparse array. */
function arr(v: unknown, max: number, each: (x: unknown) => boolean): v is unknown[] {
  if (!Array.isArray(v) || v.length > max) return false
  for (let i = 0; i < v.length; i++) if (!each(v[i])) return false
  return true
}

export const strArr = (v: unknown, maxItems = 1000, maxLen = 1000): v is string[] => arr(v, maxItems, (x) => str(x, maxLen))

/** '' or an http(s) URL. */
function httpUrl(v: unknown, max = 2048): v is string {
  if (!str(v, max)) return false
  if (!v) return true
  try {
    const u = new URL(v)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/** Shape only: a backup being set up in the team editor may still have an empty model. */
export const isModelRef = (v: unknown): v is ModelRef => obj(v) && str(v.providerId, 200) && str(v.model, 500)

export function isPrice(v: unknown): v is Price {
  if (!obj(v) || !rate(v.in) || !rate(v.out) || !optRate(v.cacheRead) || !optRate(v.cacheWrite)) return false
  const l = v.long
  return l === undefined || (obj(l) && rate(l.above) && rate(l.in) && rate(l.out) && optRate(l.cacheRead) && optRate(l.cacheWrite))
}

export function isPrices(v: unknown): v is Record<string, Price> {
  if (!obj(v)) return false
  const keys = Object.keys(v)
  return keys.length <= 5000 && keys.every((k) => filled(k, 500) && isPrice(v[k]))
}

export function isBilling(v: unknown): v is Billing {
  if (!obj(v) || !oneOf(v.mode, ['payg', 'subscription', 'free'] as const) || !optRate(v.fee)) return false
  const q = v.quota
  return (
    q === undefined ||
    (obj(q) && rate(q.amount) && oneOf(q.unit, ['usd', 'requests', 'tokens'] as const) && oneOf(q.window, ['5h', 'day', 'week', 'month'] as const))
  )
}

/** What saveProvider receives (the UI may send `hasKey` along; it is ignored). */
export const isProvider = (v: unknown): v is Omit<Provider, 'hasKey'> =>
  obj(v) &&
  filled(v.id, 200) &&
  str(v.name, 200) &&
  oneOf(v.kind, ['openai', 'anthropic'] as const) &&
  httpUrl(v.baseURL) &&
  isBilling(v.billing) &&
  isPrices(v.prices)

/** What saveMcp receives. Plugin servers have ids like `plugin:name:key`. */
export const isMcp = (v: unknown): v is Omit<McpServer, 'hasSecrets' | 'plugin'> =>
  obj(v) &&
  filled(v.id, 300) &&
  str(v.name, 200) &&
  oneOf(v.transport, ['stdio', 'http'] as const) &&
  str(v.command, 4096) &&
  strArr(v.args, 200, 4096) &&
  httpUrl(v.url, 4096) &&
  bool(v.enabled)

export const isSettings = (v: unknown): v is AppSettings =>
  obj(v) &&
  oneOf(v.theme, ['system', 'light', 'dark'] as const) &&
  rate(v.dailyCapUsd) &&
  rate(v.monthlyCapUsd) &&
  bool(v.notifications) &&
  bool(v.checkUpdates)

export const isLimits = (v: unknown): v is Limits => obj(v) && rate(v.maxRequests) && rate(v.maxChatter) && rate(v.compactAt)

export const isSandbox = (v: unknown): v is Sandbox =>
  obj(v) &&
  oneOf(v.kind, ['none', 'docker'] as const) &&
  str(v.image, 255) &&
  (v.image === '' ? v.kind === 'none' : IMAGE.test(v.image)) &&
  bool(v.network)

/** Names may be empty here: the org chart check (E_ORG_NAME) reports that in words. */
export const isAgent = (v: unknown): v is Agent =>
  obj(v) &&
  isId(v.id) &&
  str(v.name, 200) &&
  str(v.title, 200) &&
  str(v.department, 200) &&
  (v.reportsTo === null || isId(v.reportsTo)) &&
  str(v.instructions) &&
  str(v.providerId, 200) &&
  str(v.model, 500) &&
  (v.backup === undefined || isModelRef(v.backup)) &&
  arr(v.tools, 50, (t) => oneOf(t, TOOL_NAMES)) &&
  (v.mcpServers === undefined || strArr(v.mcpServers, 200, 300)) &&
  (v.effort === undefined || oneOf(v.effort, EFFORTS)) &&
  (v.maxTokens === undefined || (Number.isSafeInteger(v.maxTokens) && (v.maxTokens as number) > 0)) &&
  (v.skills === undefined || strArr(v.skills, 1000, 200)) &&
  (v.exec === undefined || oneOf(v.exec, EXEC_KINDS)) &&
  (v.pos === undefined || (obj(v.pos) && num(v.pos.x, -1e6, 1e6) && num(v.pos.y, -1e6, 1e6)))

export function isProject(v: unknown): v is Project {
  if (
    !obj(v) ||
    !isId(v.id) ||
    !str(v.name, 200) ||
    !str(v.workspaceDir, 4096) ||
    !str(v.briefing) ||
    !oneOf(v.approval, ['ask', 'auto'] as const) ||
    !rate(v.budgetUsd) ||
    !arr(v.agents, 200, isAgent) ||
    (v.limits !== undefined && !isLimits(v.limits)) ||
    (v.planFirst !== undefined && !bool(v.planFirst)) ||
    (v.allowCommands !== undefined && !strArr(v.allowCommands, 1000, 4096)) ||
    (v.sandbox !== undefined && !isSandbox(v.sandbox)) ||
    (v.checkpoints !== undefined && !bool(v.checkpoints))
  ) {
    return false
  }
  const ids = (v.agents as Agent[]).map((a) => a.id)
  return new Set(ids).size === ids.length
}
