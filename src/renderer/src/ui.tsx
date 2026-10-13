import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import type { AgentStatus } from '../../shared/types'
import { useT } from './i18n'
import { createLayers, trapStep } from './layers'
import { rovingStep } from './shellUtils'

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
  clock: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  swap: 'M7 4 3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7',
  refresh: 'M21 12a9 9 0 1 1-2.6-6.4M21 4v5h-5',
  chart: 'M5 20v-8M11 20V5M17 20v-5M3 20h18',
  crown: 'M3 7l4 4 5-7 5 7 4-4-2 12H5Z',
  download: 'M12 3v12M7 10l5 5 5-5M5 21h14',
  upload: 'M12 21V9M7 14l5-5 5 5M5 3h14',
  undo: 'M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
  branch: 'M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM18 9a9 9 0 0 1-9 9',
  diff: 'M12 3v10M7 8h10M7 21h10',
  bell: 'M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z',
  monitor: 'M3 4h18v12H3zM8 20h8M12 16v4',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z',
  clipboard: 'M9 4h6v3H9zM9 5H6a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-3M9 12h6M9 16h4',
  grip: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01',
  more: 'M5 12h.01M12 12h.01M19 12h.01'
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
      className={`avatar ${status === 'working' ? 'ring' : status === 'waiting' ? 'wait' : status === 'blocked' ? 'stuck' : ''}`}
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
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  // Read while rendering: an autoFocus field inside takes focus before any effect runs.
  const [opener] = useState(() => (typeof document === 'undefined' ? null : document.activeElement))
  useLayer(onClose, ref, 2)

  useEffect(() => {
    const node = ref.current
    if (!node) return
    if (!node.contains(document.activeElement)) {
      const body = node.querySelector('.modal-body')
      ;((body && focusables(body)[0]) ?? focusables(node)[0] ?? node).focus()
    }
    return () => {
      // Still in the page = React re-running effects (StrictMode), not a close.
      if (node.isConnected) return
      const active = document.activeElement
      if (active && active !== document.body) return
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus()
    }
  }, [opener])

  const trap = (e: KeyboardEvent<HTMLDivElement>) => {
    const node = ref.current
    if (e.key !== 'Tab' || e.defaultPrevented || !node) return
    const items = focusables(node)
    const next = trapStep(items.indexOf(document.activeElement as HTMLElement), items.length, e.shiftKey)
    if (next === null) return
    e.preventDefault()
    ;(items[next] ?? node).focus()
  }

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        className="modal"
        role="dialog"
        aria-modal
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={trap}
        style={width ? { width: `min(${width}px, 100%)` } : undefined}
      >
        <div className="modal-head">
          <h3 id={titleId}>{title}</h3>
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
export function Sheet({ head, onClose, children, label }: { head: ReactNode; onClose(): void; children: ReactNode; label?: string }) {
  const t = useT()
  const ref = useRef<HTMLElement>(null)
  useLayer(onClose, ref, 1)
  return (
    <aside ref={ref} className="sheet" role="dialog" aria-modal={false} aria-label={label}>
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

export interface MenuItem {
  label: string
  icon?: IconName
  onSelect(): void
}

/** A button that opens a short list of actions (arrow keys move, Escape or a click outside closes). */
export function Menu({ label, icon = 'more', items }: { label: string; icon?: IconName; items: MenuItem[] }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const wrap = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const close = useCallback((refocus: boolean) => {
    setOpen(false)
    if (refocus) button.current?.focus()
  }, [])
  return (
    <div className="menu-wrap" ref={wrap}>
      <button
        ref={button}
        type="button"
        className="btn quiet icon sm"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
          e.preventDefault()
          setOpen(true)
        }}
      >
        <Icon name={icon} />
      </button>
      {open && <MenuList id={id} label={label} items={items} wrap={wrap} onClose={close} />}
    </div>
  )
}

function MenuList({ id, label, items, wrap, onClose }: { id: string; label: string; items: MenuItem[]; wrap: RefObject<HTMLDivElement | null>; onClose(refocus: boolean): void }) {
  const ref = useRef<HTMLDivElement>(null)
  const escape = useCallback(() => onClose(true), [onClose])
  useLayer(escape, ref, 3)

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    const outside = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) onClose(false)
    }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [wrap, onClose])

  const move = (e: KeyboardEvent<HTMLDivElement>) => {
    // Back on the button, so Tab carries on from there once the list is gone.
    if (e.key === 'Tab') return onClose(true)
    const all = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
    const to = rovingStep(all, document.activeElement as HTMLElement, e.key, 'y')
    if (!to) return
    e.preventDefault()
    to.focus()
  }

  return (
    <div ref={ref} id={id} className="menu" role="menu" aria-label={label} onKeyDown={move}>
      {items.map((it) => (
        <button
          key={it.label}
          type="button"
          role="menuitem"
          tabIndex={-1}
          onClick={() => {
            onClose(true)
            it.onSelect()
          }}
        >
          {it.icon && <Icon name={it.icon} size={14} />}
          {it.label}
        </button>
      ))}
    </div>
  )
}

const layers = createLayers()

function onEscape(e: globalThis.KeyboardEvent) {
  if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return
  const top = layers.top()
  if (!top) return
  e.preventDefault()
  top.close()
}

/** Registers an open menu, modal or sheet; Escape closes only the top-most one. */
function useLayer(close: () => void, ref: RefObject<Element | null>, level: number) {
  const latest = useRef(close)
  useEffect(() => {
    latest.current = close
  })
  useEffect(() => {
    if (!layers.size) window.addEventListener('keydown', onEscape)
    const remove = layers.add({ level, el: () => ref.current, close: () => latest.current() })
    return () => {
      remove()
      if (!layers.size) window.removeEventListener('keydown', onEscape)
    }
  }, [ref, level])
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'

/** Elements Tab can reach inside `root`, in document order (hidden ones and closed <details> skipped). */
function focusables(root: Element): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.tabIndex >= 0 && el.getClientRects().length > 0)
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
/** `label` names what is deleted ("Delete Aziz"), for screen readers; the armed state is announced. */
export function ConfirmButton({ onConfirm, children, className = '', label }: { onConfirm(): void; children: ReactNode; className?: string; label?: string }) {
  const t = useT()
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const id = setTimeout(() => setArmed(false), 3000)
    return () => clearTimeout(id)
  }, [armed])
  return (
    <button
      type="button"
      className={`btn danger ${armed ? 'armed' : ''} ${className}`}
      aria-label={armed ? t.common.confirmDelete : label}
      aria-live="polite"
      onClick={() => (armed ? onConfirm() : setArmed(true))}
    >
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

export const usd = (n: number) => (n === 0 ? '$0' : n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`)
export const tokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n))
export const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
export const dateTime = (t: number) => new Date(t).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
export const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p
