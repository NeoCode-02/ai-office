import { useEffect, useRef } from 'react'
import { useT } from '../i18n'
import { Icon } from '../ui'

export function Composer({ value, onChange, onSend, busy, placeholder, hint, autoFocus }: {
  value: string
  onChange(v: string): void
  onSend(): void
  busy: boolean
  placeholder: string
  hint: string
  autoFocus?: boolean
}) {
  const t = useT()
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [value])
  return (
    <div className="composer-inner">
      <div className="composer-box">
        <textarea
          ref={ref}
          rows={1}
          value={value}
          autoFocus={autoFocus}
          placeholder={placeholder}
          aria-label={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            // Enter also confirms an IME composition (Chinese, Japanese, …); that one must not send.
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              onSend()
            }
          }}
        />
        <button type="button" className="send" onClick={onSend} disabled={!value.trim() || busy} aria-label={t.work.send}>
          <Icon name="arrowUp" size={17} />
        </button>
      </div>
      <div className="composer-hint">
        <span>{t.work.hint}</span>
        <span className="spacer" />
        <span>{hint}</span>
      </div>
    </div>
  )
}
