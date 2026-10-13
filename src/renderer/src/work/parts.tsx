import { useEffect, useMemo, useState } from 'react'
import { Icon, type IconName } from '../ui'
import { diffLines } from './logic'

/** Destructive action that needs a second click within 3 s (like ConfirmButton, with any label and icon). */
export function TwoStep({ onConfirm, icon, label, armedLabel, title, disabled, iconOnly }: {
  onConfirm(): void
  icon: IconName
  label: string
  armedLabel: string
  title?: string
  disabled?: boolean
  /** Show just the icon until armed; `label` becomes the accessible name. */
  iconOnly?: boolean
}) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const id = setTimeout(() => setArmed(false), 3000)
    return () => clearTimeout(id)
  }, [armed])
  const compact = iconOnly && !armed
  return (
    <button
      type="button"
      className={`btn danger sm ${armed ? 'armed' : ''} ${compact ? 'icon quiet' : ''}`}
      disabled={disabled}
      title={title ?? (compact ? label : undefined)}
      aria-label={compact ? label : undefined}
      onBlur={() => setArmed(false)}
      onClick={() => {
        if (!armed) return setArmed(true)
        setArmed(false)
        onConfirm()
      }}
    >
      <Icon name={icon} size={13} />
      {!compact && (armed ? armedLabel : label)}
    </button>
  )
}

/** Unified diff with added / removed lines tinted; the +/- prefix stays, so colour is not the only cue. */
export function DiffView({ text, label }: { text: string; label?: string }) {
  const lines = useMemo(() => diffLines(text), [text])
  if (!lines.length) return null
  return (
    // Focusable so the keyboard can scroll long lines.
    <pre className="diff" role={label ? 'region' : undefined} aria-label={label} tabIndex={0}>
      <code className="diff-inner">
        {lines.map((l, i) => (
          <span key={i} className={`dl ${l.kind}`}>
            {l.text || ' '}
          </span>
        ))}
      </code>
    </pre>
  )
}
