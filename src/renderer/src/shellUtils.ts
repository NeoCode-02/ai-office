import { DEFAULT_SETTINGS, type AppSettings, type UpdateInfo } from '../../shared/types'
import { voiceFrom } from '../../shared/voice'

/** `E_CODE` of an error thrown by the main process (`E_CODE` or `E_CODE|param`), else null. */
export function errCode(e: unknown): string | null {
  const raw = (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
  return /^(E_[A-Z_]+)(?:\||$)/.exec(raw)?.[1] ?? null
}

/** A dollar amount typed by the owner: empty = 0, comma decimals allowed; null when invalid. */
export function parseUsd(s: string): number | null {
  const raw = s.trim()
  // "1,000" could be a thousand or one: refuse it instead of guessing. A comma works as a decimal point otherwise.
  if (/,\d{3}$/.test(raw) || (raw.match(/[.,]/g)?.length ?? 0) > 1) return null
  const v = raw.replace(',', '.')
  if (v === '') return 0
  if (!/^\d*\.?\d*$/.test(v) || v === '.') return null
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/** Fill level of a limit: percent used (0–100) and whether it is nearly (≥80%) or fully used. */
export function meter(used: number, limit: number): { pct: number; level: '' | 'high' | 'full' } {
  if (!(limit > 0)) return { pct: 0, level: '' }
  const ratio = Math.max(0, used) / limit
  return { pct: Math.min(100, ratio * 100), level: ratio >= 1 ? 'full' : ratio >= 0.8 ? 'high' : '' }
}

/** Only https links leave the app (the main process opens them in the browser). */
export const httpsUrl = (url: string | null | undefined): string | null => (url && /^https:\/\/[^\s]+$/.test(url) ? url : null)

/** Settings saved by an older version may miss fields or hold wrong types. */
export function withDefaults(s: Partial<AppSettings> | null | undefined): AppSettings {
  const d = DEFAULT_SETTINGS
  const v = s ?? {}
  const cap = (n: unknown, fallback: number) => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : fallback)
  return {
    theme: v.theme === 'light' || v.theme === 'dark' || v.theme === 'system' ? v.theme : d.theme,
    dailyCapUsd: cap(v.dailyCapUsd, d.dailyCapUsd),
    monthlyCapUsd: cap(v.monthlyCapUsd, d.monthlyCapUsd),
    notifications: typeof v.notifications === 'boolean' ? v.notifications : d.notifications,
    checkUpdates: typeof v.checkUpdates === 'boolean' ? v.checkUpdates : d.checkUpdates,
    voice: voiceFrom(v.voice)
  }
}

/** What a finished update check means for the owner. */
export function updateState(info: UpdateInfo): 'newer' | 'latest' | 'none' {
  if (info.newer && info.latest) return 'newer'
  return info.latest ? 'latest' : 'none'
}

/**
 * Roving focus in a tab list (axis x: Left/Right) or menu (axis y: Up/Down), wrapping around,
 * with Home/End. Returns the item to move to, or null when the key does not move.
 */
export function rovingStep<T>(items: readonly T[], current: T | null, key: string, axis: 'x' | 'y'): T | null {
  if (!items.length) return null
  if (key === 'Home') return items[0]
  if (key === 'End') return items[items.length - 1]
  const [prev, next] = axis === 'x' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown']
  if (key !== prev && key !== next) return null
  const i = current === null ? -1 : items.indexOf(current)
  if (i < 0) return key === next ? items[0] : items[items.length - 1]
  return items[(i + (key === next ? 1 : -1) + items.length) % items.length]
}
