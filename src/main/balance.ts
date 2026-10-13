import type { Balance } from '../shared/types'
import type { Conn } from './providers'

/** Only these providers report the account balance to a normal API key. */
const SOURCES: { host: RegExp; url: (base: string) => string; parse(j: unknown): Balance | null }[] = [
  { host: /api\.deepseek\.com/, url: () => 'https://api.deepseek.com/user/balance', parse: deepseek },
  { host: /api\.moonshot\.ai/, url: () => 'https://api.moonshot.ai/v1/users/me/balance', parse: (j) => moonshot(j) },
  { host: /api\.moonshot\.cn/, url: () => 'https://api.moonshot.cn/v1/users/me/balance', parse: (j) => moonshot(j, true) },
  { host: /openrouter\.ai/, url: () => 'https://openrouter.ai/api/v1/key', parse: openrouter }
]

export const hasBalanceApi = (baseURL: string) => SOURCES.some((s) => s.host.test(baseURL))

export async function balance(conn: Conn): Promise<Balance | null> {
  const src = SOURCES.find((s) => s.host.test(conn.baseURL))
  if (!src) return null
  const res = await fetch(src.url(conn.baseURL), { headers: { Authorization: `Bearer ${conn.apiKey}` }, signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`E_BALANCE|${res.status}`)
  return src.parse(await res.json())
}

const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null)
const obj = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})

/** `{ is_available, balance_infos: [{ currency, total_balance }] }`; prefers USD. */
export function deepseek(j: unknown): Balance | null {
  const infos = (obj(j).balance_infos as unknown[] | undefined) ?? []
  const all = infos.map(obj)
  const pick = all.find((x) => x.currency === 'USD') ?? all[0]
  const amount = pick && num(pick.total_balance)
  return amount === null || amount === undefined ? null : { kind: 'balance', amount, currency: String(pick.currency ?? '') }
}

/** `{ data: { available_balance } }`; USD on api.moonshot.ai, CNY on api.moonshot.cn. */
export function moonshot(j: unknown, cn = false): Balance | null {
  const amount = num(obj(obj(j).data).available_balance)
  return amount === null ? null : { kind: 'balance', amount, currency: cn ? 'CNY' : 'USD' }
}

/** `{ data: { limit_remaining, usage } }` — the key's own limit; null remaining = unlimited key. */
export function openrouter(j: unknown): Balance | null {
  const d = obj(obj(j).data)
  const used = num(d.usage)
  return used === null ? null : { kind: 'key', remaining: num(d.limit_remaining), used }
}
