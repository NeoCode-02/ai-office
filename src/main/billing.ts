import type { Price, Provider, ProviderKind, Usage } from '../shared/types'

const M = 1e6

/**
 * USD for one request. Unset cache prices fall back to Anthropic's published
 * multipliers, or to the full input price elsewhere (never under-counts).
 */
export function cost(price: Price, kind: ProviderKind, u: Usage): number {
  const prompt = u.in + u.cacheRead + u.cacheWrite
  const tier = price.long && prompt > price.long.above ? price.long : price
  const read = tier.cacheRead ?? (kind === 'anthropic' ? tier.in * 0.1 : tier.in)
  const write = tier.cacheWrite ?? (kind === 'anthropic' ? tier.in * 1.25 : tier.in)
  return (u.in * tier.in + u.cacheRead * read + u.cacheWrite * write + u.out * tier.out) / M
}

export const totalTokens = (u: Usage) => u.in + u.cacheRead + u.cacheWrite + u.out

/**
 * Anthropic list prices, USD / 1M tokens (platform docs as cached on 2026-10-06; list updated 2026-10-13).
 * Cache reads are 0.1× input unless set here, cache writes 1.25× input.
 */
export const BUILTIN: Record<string, Price> = {
  'claude-fable-5-1': { in: 10, out: 50, cacheRead: 0.25 },
  'claude-opus-5-5': { in: 4, out: 20, cacheRead: 0.2 },
  'claude-sonnet-5-5': { in: 2, out: 10, cacheRead: 0.2 },
  'claude-haiku-5-5': { in: 0.1, out: 0.5, long: { above: 100_000, in: 0.5, out: 2.5 } },
  'claude-fable-5': { in: 10, out: 50 },
  'claude-opus-5': { in: 5, out: 25 },
  'claude-opus-4-8': { in: 5, out: 25 },
  'claude-opus-4-7': { in: 5, out: 25 },
  'claude-opus-4-6': { in: 5, out: 25 },
  'claude-sonnet-5': { in: 2, out: 10 },
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 }
}

const isAnthropicApi = (p: Pick<Provider, 'kind' | 'baseURL'>) =>
  p.kind === 'anthropic' && (!p.baseURL || /^https:\/\/api\.anthropic\.com\/?$/.test(p.baseURL))

// Own keys only: a model named "constructor" must not find Object.prototype's.
const own = (r: Record<string, Price> | undefined, k: string) => (r && Object.hasOwn(r, k) ? r[k] : undefined)

export function priceOf(p: Pick<Provider, 'kind' | 'baseURL' | 'prices'>, model: string): Price | undefined {
  if (own(p.prices, model)) return own(p.prices, model)
  if (!isAnthropicApi(p)) return undefined
  // The model list shows dated snapshots (claude-haiku-4-5-20251001); they cost the same as their alias.
  return own(BUILTIN, model) ?? own(BUILTIN, model.replace(/-\d{8}$/, ''))
}

/** What a request costs the user: 0 on flat-fee or free accounts, null when no price is known. */
export function charge(p: Pick<Provider, 'kind' | 'baseURL' | 'prices' | 'billing'>, model: string, u: Usage): number | null {
  if (p.billing.mode !== 'payg') return 0
  if (u.usd !== undefined) return u.usd
  const price = priceOf(p, model)
  return price ? cost(price, p.kind, u) : null
}

// --- Price catalog (OpenRouter's public model list, no key needed) ---

interface CatalogPrice {
  prompt?: string
  completion?: string
  input_cache_read?: string
  input_cache_write?: string
  overrides?: (CatalogPrice & { min_prompt_tokens?: number })[]
}
export interface CatalogModel {
  id: string
  pricing?: CatalogPrice
}

const perM = (s: string | undefined) => {
  const n = Number(s)
  return s !== undefined && Number.isFinite(n) && n >= 0 ? Math.round(n * M * M) / M : undefined
}

function toPrice(c: CatalogPrice): Price | undefined {
  const inP = perM(c.prompt)
  const out = perM(c.completion)
  if (inP === undefined || out === undefined) return undefined
  const p: Price = { in: inP, out }
  const read = perM(c.input_cache_read)
  const write = perM(c.input_cache_write)
  if (read !== undefined) p.cacheRead = read
  if (write !== undefined) p.cacheWrite = write
  const o = c.overrides?.find((x) => typeof x.min_prompt_tokens === 'number')
  const long = o && toPrice({ prompt: o.prompt ?? c.prompt, completion: o.completion ?? c.completion, input_cache_read: o.input_cache_read, input_cache_write: o.input_cache_write })
  if (o && long) p.long = { ...long, above: o.min_prompt_tokens! - 1 }
  return p
}

const VENDORS: [RegExp, string][] = [
  [/api\.anthropic\.com/, 'anthropic'],
  [/api\.openai\.com/, 'openai'],
  [/generativelanguage\.googleapis\.com/, 'google'],
  [/api\.deepseek\.com/, 'deepseek'],
  [/api\.moonshot\./, 'moonshotai'],
  [/api\.z\.ai|bigmodel\.cn/, 'z-ai'],
  [/api\.x\.ai/, 'x-ai'],
  [/api\.mistral\.ai/, 'mistralai']
]
const norm = (s: string) => s.toLowerCase().replace(/\./g, '-')

// Ids that always point at the provider's newest model; the catalog's entry of the same name may be an older one.
const MOVING = /-latest$|^deepseek-(chat|reasoner)$/i

/** Finds a model's catalog price. Ambiguous or missing matches return undefined, never a guess. */
export function matchCatalog(list: CatalogModel[], p: Pick<Provider, 'kind' | 'baseURL'>, model: string): Price | undefined {
  if (MOVING.test(model) && !/openrouter\.ai/.test(p.baseURL)) return undefined
  const plain = list.filter((m) => !m.id.includes(':') && m.pricing)
  let hits: CatalogModel[]
  if (/openrouter\.ai/.test(p.baseURL)) hits = plain.filter((m) => m.id === model)
  else {
    const vendor = p.kind === 'anthropic' ? 'anthropic' : VENDORS.find(([re]) => re.test(p.baseURL))?.[1]
    hits = plain.filter((m) => norm(m.id.split('/').pop()!) === norm(model) && (!vendor || m.id.startsWith(`${vendor}/`)))
  }
  return hits.length === 1 ? toPrice(hits[0].pricing!) : undefined
}

let catalog: { at: number; list: CatalogModel[] } | null = null

export async function fetchCatalog(): Promise<CatalogModel[]> {
  if (catalog && Date.now() - catalog.at < 3600_000) return catalog.list
  const res = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`E_CATALOG|${res.status}`)
  const list = ((await res.json()) as { data?: CatalogModel[] }).data ?? []
  catalog = { at: Date.now(), list }
  return list
}
