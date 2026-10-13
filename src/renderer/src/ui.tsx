import { useEffect, useState, type ReactNode } from 'react'
import type { AgentStatus } from '../../shared/types'
import { useT } from './i18n'

const PATHS = {
  plus: 'M12 5v14M5 12h14',
  x: 'M18 6 6 18M6 6l12 12',
  arrowUp: 'M12 19V5M5 12l7-7 7 7',
  stop: 'M7 7h10v10H7z',
  key: 'M2.6 18.4A2 2 0 0 0 2 19.8V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.2a2 2 0 0 0 1.4-.6l.8-.8a6.5 6.5 0 1 0-4-4ZM16.5 7.5h.01',
  users: 'M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM22 19v-1a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  chat: 'M21 12a8 8 0 0 1-11.9 7L4 20l1-4.6A8 8 0 1 1 21 12Z',
  sliders: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4',
  history: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z',
  file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8ZM14 3v5h5',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z',
  terminal: 'M4 17l6-5-6-5M12 19h8',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM20 20l-4-4',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18',
  bookmark: 'M6 3h12v18l-6-4-6 4Z',
  book: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5ZM4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5',
  plug: 'M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0ZM12 18v4',
  puzzle: 'M10 3h4v3a2 2 0 1 0 4 0h0V3h3v7h-3a2 2 0 1 0 0 4h3v7h-7v-3a2 2 0 1 0-4 0v3H3v-7h3a2 2 0 1 0 0-4H3V3h7Z',
  check: 'M20 6 9 17l-5-5',
  trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  external: 'M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6',
  spark: 'M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8',
  chevron: 'M9 6l6 6-6 6',
  alert: 'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
  crown: 'M3 7l4 4 5-7 5 7 4-4-2 12H5Z',
  download: 'M12 3v12M7 10l5 5 5-5M5 21h14'
} as const
export type IconName = keyof typeof PATHS

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d={PATHS[name]} />
    </svg>
  )
}

/** Brand mark: three stacked desks/people, monochrome. */
export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className="brand-mark" aria-hidden>
      <rect x="2.5" y="2.5" width="19" height="19" rx="6" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="12" cy="9" r="2.4" fill="currentColor" />
      <circle cx="7.6" cy="15.2" r="1.9" fill="currentColor" opacity="0.55" />
      <circle cx="16.4" cy="15.2" r="1.9" fill="var(--accent)" />
    </svg>
  )
}

function hash(s: string) {
  let h = 0
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return h
}
export const hue = (s: string) => hash(s || '?') % 360

export function Avatar({ name, seed, size = 28, status }: { name: string; seed?: string; size?: number; status?: AgentStatus }) {
  const h = hue(seed ?? name)
  const initials = name.trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '?'
  return (
    <span
      className={`avatar ${status === 'working' ? 'ring' : status === 'waiting' ? 'wait' : ''}`}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.38),
        background: `color-mix(in oklab, hsl(${h} 40% 55%) 20%, var(--surface))`,
        color: `color-mix(in oklab, hsl(${h} 45% 40%) 60%, var(--text))`
      }}
    >
      {initials}
    </span>
  )
}

export function Modal({ title, onClose, children, footer, width }: { title: string; onClose(): void; children: ReactNode; footer?: ReactNode; width?: number }) {
  const t = useT()
  useEscape(onClose)
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal aria-label={title} style={width ? { width: `min(${width}px, 100%)` } : undefined}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="btn quiet icon sm" onClick={onClose} aria-label={t.common.close}>
            <Icon name="x" />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  )
}

/** Right-hand slide-over panel, positioned inside the nearest `position: relative` container. */
export function Sheet({ head, onClose, children }: { head: ReactNode; onClose(): void; children: ReactNode }) {
  const t = useT()
  useEscape(onClose)
  return (
    <aside className="sheet" role="dialog" aria-modal={false}>
      <div className="sheet-head">
        {head}
        <button className="btn quiet icon sm" onClick={onClose} aria-label={t.common.close}>
          <Icon name="x" />
        </button>
      </div>
      <div className="sheet-body">{children}</div>
    </aside>
  )
}

function useEscape(fn: () => void) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && fn()
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [fn])
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  )
}

export function Switch({ on, onChange, label }: { on: boolean; onChange(v: boolean): void; label: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} className={`switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)} />
}

/** Destructive action that needs a second click within 3 s. */
export function ConfirmButton({ onConfirm, children, className = '' }: { onConfirm(): void; children: ReactNode; className?: string }) {
  const t = useT()
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const id = setTimeout(() => setArmed(false), 3000)
    return () => clearTimeout(id)
  }, [armed])
  return (
    <button type="button" className={`btn danger ${armed ? 'armed' : ''} ${className}`} onClick={() => (armed ? onConfirm() : setArmed(true))}>
      <Icon name="trash" size={14} />
      {armed ? t.common.confirmDelete : children}
    </button>
  )
}

export function Empty({ icon, title, body, children }: { icon: IconName; title: string; body?: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-mark">
        <Icon name={icon} size={20} />
      </div>
      <h3>{title}</h3>
      {body && <p>{body}</p>}
      {children && <div className="row" style={{ marginTop: 8 }}>{children}</div>}
    </div>
  )
}

/** Minimal markdown → React (no innerHTML): code blocks, inline code, bold, headings, lists. */
export function Markdown({ text }: { text: string }) {
  const out: ReactNode[] = []
  text.split(/```[^\n]*\n?/).forEach((part, i) => {
    if (i % 2 === 1) {
      out.push(<pre key={i}><code>{part.replace(/\n$/, '')}</code></pre>)
      return
    }
    let list: { ordered: boolean; items: string[] } | null = null
    const flush = (k: string) => {
      if (!list) return
      const items = list.items.map((t, j) => <li key={j}>{inline(t)}</li>)
      out.push(list.ordered ? <ol key={k}>{items}</ol> : <ul key={k}>{items}</ul>)
      list = null
    }
    part.split(/\n{2,}|\n(?=\s*(?:[-*•]|\d+\.)\s)|\n(?=#{1,4}\s)/).forEach((block, j) => {
      const k = `${i}-${j}`
      const b = block.trim()
      if (!b) return
      const li = /^\s*(?:([-*•])|(\d+)\.)\s+([\s\S]*)$/.exec(b)
      if (li) {
        const ordered = Boolean(li[2])
        if (list && list.ordered !== ordered) flush(k + 'f')
        list ??= { ordered, items: [] }
        list.items.push(li[3])
        return
      }
      flush(k + 'f')
      // A heading may be followed by text on the next line in the same block.
      const h = /^#{1,4}\s+(.*)(?:\n([\s\S]*))?$/.exec(b)
      if (!h) return void out.push(<p key={k}>{lines(b)}</p>)
      out.push(<h4 key={k}>{inline(h[1])}</h4>)
      if (h[2]?.trim()) out.push(<p key={`${k}p`}>{lines(h[2].trim())}</p>)
    })
    flush(`${i}-end`)
  })
  return <div className="md">{out}</div>
}

function lines(s: string) {
  return s.split('\n').flatMap((l, i) => (i ? [<br key={`b${i}`} />, ...inline(l)] : inline(l)))
}

function inline(s: string): ReactNode[] {
  return s.split(/(`[^`]+`|\*\*[^*]+\*\*)/).map((t, i) =>
    t.startsWith('`') && t.endsWith('`') && t.length > 1 ? (
      <code key={i}>{t.slice(1, -1)}</code>
    ) : t.startsWith('**') && t.endsWith('**') && t.length > 3 ? (
      <strong key={i}>{t.slice(2, -2)}</strong>
    ) : (
      t
    )
  )
}

export const usd = (n: number) => (n === 0 ? '$0' : n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`)
export const tokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n))
export const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
export const dateTime = (t: number) => new Date(t).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
export const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p
