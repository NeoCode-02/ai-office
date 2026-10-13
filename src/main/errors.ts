import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import type { ErrorKind } from '../shared/types'

export interface Classified {
  kind: ErrorKind
  /** Worth waiting and trying the same request again. */
  retry: boolean
  retryAfterMs?: number
  /** The provider's own words (or an app error code), shown under "Details". */
  detail: string
  /** The office cancelled the request itself (stop): never retried, never charged. */
  aborted?: boolean
}

// Provider wording differs, so the body and message are matched as text.
// Sources: OpenAI/Anthropic/DeepSeek/OpenRouter/Kimi/Gemini error docs, z.ai business codes (11xx/12xx/13xx).
const QUOTA = /insufficient_quota|exceeded_current_quota|exceeded your current quota|insufficient[ _-]?(balance|credits?|funds)|credit balance is too low|billing_error|payment required|quota exceeded|usage limit|"code":"?(1113|1308|1310)\b/i
const CONTEXT = /context[_ ]length|context window|maximum context|prompt is too long|input is too long|too many (input )?tokens|reduce the length|"code":"?1261\b/i
const AUTH = /invalid[_ ]api[_ ]key|incorrect api key|api key not valid|authentication_error|unauthorized/i
const RATE = /rate[_ ]limit|too many requests|overloaded|resource_exhausted|"code":"?(1302|1305|1312)\b/i
const MODEL = /model_not_found|model[^.]{0,40}(does not exist|not found|not available)/i
// Gemini says "exceeded your current quota" for per-minute limits too; those carry a retry delay.
const PER_MINUTE = /PerMinute|per minute|retryDelay/i
const NETWORK = /connection error|timed? ?out|ECONN|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|network/i
// Default messages of the SDKs' and the platform's abort errors.
const ABORTED = /^(request was |this operation was |the operation was )?aborted\.?$/i

interface ApiErrorLike {
  status?: number
  headers?: { get?(name: string): string | null } | Record<string, string>
  error?: unknown
  message?: string
  name?: string
  code?: unknown
}

function isAbort(e: unknown, err: ApiErrorLike): boolean {
  if (e instanceof Anthropic.APIUserAbortError || e instanceof OpenAI.APIUserAbortError) return true
  if (err.name === 'AbortError') return true
  // Node's http client also says "aborted" when the server drops the connection; that one is a network error.
  return ABORTED.test(err.message ?? '') && err.code !== 'ECONNRESET'
}

function header(h: ApiErrorLike['headers'], name: string): string | null {
  if (!h) return null
  if (typeof h.get === 'function') return h.get(name)
  return (h as Record<string, string>)[name] ?? null
}

export function retryAfter(h: ApiErrorLike['headers']): number | undefined {
  const ms = Number(header(h, 'retry-after-ms'))
  if (ms > 0) return ms
  const v = header(h, 'retry-after')
  if (!v) return undefined
  const s = Number(v)
  if (s >= 0) return s * 1000
  const date = Date.parse(v)
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now())
}

export function classify(e: unknown): Classified {
  const err = (e && typeof e === 'object' ? e : { message: String(e) }) as ApiErrorLike
  const message = typeof err.message === 'string' ? err.message : ''
  if (isAbort(e, err)) return { kind: 'other', retry: false, detail: message.slice(0, 1000) || 'aborted', aborted: true }
  if (/^E_[A-Z_]+(\|.*)?$/.test(message)) return { kind: 'config', retry: false, detail: message }
  const status = typeof err.status === 'number' ? err.status : undefined
  const text = `${JSON.stringify(err.error ?? '')} ${message}`
  const detail = message.slice(0, 1000)
  const delay = /"retryDelay":"(\d+(?:\.\d+)?)s"/.exec(text)
  const after = retryAfter(err.headers) ?? (delay ? Number(delay[1]) * 1000 : undefined)
  const out = (kind: ErrorKind, retry = false): Classified => ({ kind, retry, detail, ...(retry && after !== undefined ? { retryAfterMs: after } : {}) })

  if (status === 429 && PER_MINUTE.test(text)) return out('rate', true)
  if (status === 402 || QUOTA.test(text)) return out('quota')
  if (status === 401 || status === 403 || AUTH.test(text)) return out('auth')
  if (status === 413 || CONTEXT.test(text)) return out('context')
  if (status === 404 || MODEL.test(text)) return out('model')
  if (status === 429 || status === 529 || RATE.test(text)) return out('rate', true)
  if (status !== undefined && (status >= 500 || status === 408 || status === 409)) return out('server', true)
  if (status === undefined && NETWORK.test(`${message} ${typeof err.code === 'string' ? err.code : ''}`)) return out('network', true)
  return out('other')
}
