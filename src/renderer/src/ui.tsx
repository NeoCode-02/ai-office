import { useEffect, type ReactNode } from 'react'
import type { AgentStatus } from '../../shared/types'

const PATHS = {
  plus: 'M12 5v14M5 12h14',
  x: 'M18 6 6 18M6 6l12 12',
  send: 'M5 12h14M13 6l6 6-6 6',
  stop: 'M7 7h10v10H7z',
  play: 'M8 5v14l11-7z',
  key: 'M2.6 18.4A2 2 0 0 0 2 19.8V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.2a2 2 0 0 0 1.4-.6l.8-.8a6.5 6.5 0 1 0-4-4ZM16.5 7.5h.01',
  users: 'M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM22 19v-1a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  chat: 'M21 12a8 8 0 0 1-11.9 7L4 20l1-4.6A8 8 0 1 1 21 12Z',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z',
  history: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z',
  file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8ZM14 3v5h5',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z',
  terminal: 'M4 17l6-5-6-5M12 19h8',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  brain: 'M9.5 2A2.5 2.5 0 0 0 7 4.5v.3A3 3 0 0 0 4.5 9a3 3 0 0 0 0 6A3 3 0 0 0 7 19.2v.3a2.5 2.5 0 0 0 5 0V4.5A2.5 2.5 0 0 0 9.5 2ZM14.5 2A2.5 2.5 0 0 1 17 4.5v.3A3 3 0 0 1 19.5 9a3 3 0 0 1 0 6 3 3 0 0 1-2.5 4.2v.3a2.5 2.5 0 0 1-5 0',
  check: 'M20 6 9 17l-5-5',
  trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  external: 'M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6',
  sparkle: 'M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4ZM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8Z',
  building: 'M4 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16M16 9h2a2 2 0 0 1 2 2v10M2 21h20M8 7h4M8 11h4M8 15h4',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z',
  refresh: 'M21 12a9 9 0 0 1-15 6.7L3 16M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M3 21v-5h5',
  zap: 'M13 2 3 14h9l-1 8 10-12h-9Z',
  crown: 'M3 7l4 4 5-7 5 7 4-4-2 12H5Z'
} as const
export type IconName = keyof typeof PATHS

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d={PATHS[name]} />
    </svg>
  )
}

function hash(s: string) {
  let h = 0
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return h
}
export const hue = (s: string) => hash(s || '?') % 360

export function Avatar({ name, size = 32, status, seed }: { name: string; size?: number; status?: AgentStatus; seed?: string }) {
  const h = hue(seed ?? name)
  const initials = name.trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '?'
  return (
    <div className="avatar" style={{ width: size, height: size, fontSize: size * 0.38, background: `linear-gradient(135deg, hsl(${h} 62% 56%), hsl(${(h + 40) % 360} 62% 46%))` }}>
      {initials}
      {status && <span className={`dot ${status}`} />}
    </div>
  )
}

export function Dept({ name }: { name: string }) {
  if (!name) return null
  const h = hue(name)
  return (
    <span className="dept" style={{ color: `hsl(${h} 60% 45%)`, background: `hsl(${h} 70% 50% / 0.12)` }}>
      {name}
    </span>
  )
}

export function Modal({ title, onClose, children, footer, width }: { title: string; onClose(): void; children: ReactNode; footer?: ReactNode; width?: number }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label={title} style={width ? { width: `min(${width}px, calc(100vw - 48px))` } : undefined}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="btn ghost icon" onClick={onClose} aria-label="Yopish">
            <Icon name="x" />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  )
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

/** Minimal markdown → React (no innerHTML): code blocks, inline code, bold, headings, lists. */
export function Markdown({ text }: { text: string }) {
  const out: ReactNode[] = []
  const parts = text.split(/```[^\n]*\n?/)
  parts.forEach((part, i) => {
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
      const h = /^#{1,4}\s+(.*)/.exec(b)
      out.push(h ? <h4 key={k}>{inline(h[1])}</h4> : <p key={k}>{lines(b)}</p>)
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
export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
