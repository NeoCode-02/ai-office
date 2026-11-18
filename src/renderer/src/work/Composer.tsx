import { useCallback, useEffect, useRef, useState } from 'react'
import { useT } from '../i18n'
import { Icon } from '../ui'
import { Mic } from './Mic'

const name = (p: string) => p.split('/').pop() ?? p

export function Composer({ value, onChange, onSend, busy, placeholder, hint, autoFocus, files, onAttach, onRemoveFile, onAudio, canRecord, onError }: {
  value: string
  onChange(v: string): void
  onSend(): void
  busy: boolean
  placeholder: string
  hint: string
  autoFocus?: boolean
  /** Workspace paths of files attached to the message being written. */
  files: string[]
  /** Paths of files dropped on the box, or none to pick them in a dialog. */
  onAttach(paths?: string[]): void
  onRemoveFile(path: string): void
  /** Recorded speech from the microphone button. */
  onAudio(audio: Uint8Array): Promise<void>
  canRecord(): Promise<boolean>
  onError(message: string): void
}) {
  const t = useT()
  const ref = useRef<HTMLTextAreaElement>(null)
  const [dropping, setDropping] = useState(false)
  const [voice, setVoice] = useState<{ recording: number | null; working: boolean }>({ recording: null, working: false })
  const onVoice = useCallback((recording: number | null, working: boolean) => setVoice({ recording, working }), [])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [value])
  const hasFiles = (e: React.DragEvent) => e.dataTransfer.types.includes('Files')
  return (
    <div className="composer-inner">
      {files.length > 0 && (
        <ul className="attachments" aria-label={t.media.attach}>
          {files.map((f) => (
            <li key={f} className="attachment" title={f}>
              <Icon name="file" size={13} />
              <span className="ellipsis">{name(f)}</span>
              <button type="button" onClick={() => onRemoveFile(f)} aria-label={t.media.removeFile(name(f))} title={t.media.removeFile(name(f))}>
                <Icon name="x" size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div
        className={`composer-box ${dropping ? 'dropping' : ''}`}
        onDragOver={(e) => {
          if (!hasFiles(e)) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
          setDropping(true)
        }}
        onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setDropping(false)}
        onDrop={(e) => {
          if (!hasFiles(e)) return
          e.preventDefault()
          setDropping(false)
          const paths = [...e.dataTransfer.files].map((f) => window.office.pathOf(f)).filter(Boolean)
          if (paths.length) onAttach(paths)
        }}
      >
        <button type="button" className="composer-tool" onClick={() => onAttach()} aria-label={t.media.attach} title={`${t.media.attach}. ${t.media.attachNote}`}>
          <Icon name="paperclip" size={17} />
        </button>
        <textarea
          ref={ref}
          rows={1}
          value={value}
          autoFocus={autoFocus}
          placeholder={dropping ? t.media.dropHere : placeholder}
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
        <Mic onAudio={onAudio} canRecord={canRecord} onError={onError} onState={onVoice} disabled={busy} />
        <button type="button" className="send" onClick={onSend} disabled={(!value.trim() && !files.length) || busy} aria-label={t.work.send}>
          <Icon name="arrowUp" size={17} />
        </button>
      </div>
      <div className="composer-hint">
        {voice.recording !== null ? (
          <span className="recording" role="status">
            <span className="rec-dot" aria-hidden /> {t.media.recording(voice.recording)}
          </span>
        ) : voice.working ? (
          <span role="status">{t.media.transcribing}</span>
        ) : (
          <span>{t.work.hint}</span>
        )}
        <span className="spacer" />
        <span>{hint}</span>
      </div>
    </div>
  )
}
