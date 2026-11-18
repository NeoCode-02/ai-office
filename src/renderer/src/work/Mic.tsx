import { useEffect, useRef, useState } from 'react'
import { useT } from '../i18n'
import { Icon } from '../ui'

/** Shorter than this is a tap, not speech: nothing is sent. */
const MIN_MS = 400
const MIME = 'audio/webm;codecs=opus'

type State = 'idle' | 'recording' | 'working'

/**
 * Push to talk: hold the button (or Space/Enter on it) to record, release to send the recording,
 * Esc to throw it away.
 */
export function Mic({ onAudio, canRecord, onError, onState, disabled }: {
  /** Recorded speech (webm/opus); the button shows it is busy until this settles. */
  onAudio(audio: Uint8Array): Promise<void>
  /** Asked before the microphone opens, so nobody talks into a recording that can't be used. */
  canRecord(): Promise<boolean>
  onError(message: string): void
  /** Seconds recorded so far while recording, null otherwise. */
  onState(recording: number | null, working: boolean): void
  disabled?: boolean
}) {
  const t = useT()
  const [state, setState] = useState<State>('idle')
  const held = useRef(false)
  const rec = useRef<{ recorder: MediaRecorder; chunks: Blob[]; started: number } | null>(null)

  useEffect(() => {
    if (state !== 'recording') return onState(null, state === 'working')
    const started = Date.now()
    onState(0, false)
    const timer = setInterval(() => onState(Math.floor((Date.now() - started) / 1000), false), 250)
    return () => clearInterval(timer)
  }, [state, onState])

  // Closing the view mid-recording releases the microphone.
  useEffect(() => () => rec.current?.recorder.stream.getTracks().forEach((tr) => tr.stop()), [])

  /** at: the pressing event's timeStamp, to tell a tap from speech. */
  const begin = async (at: number) => {
    if (held.current || state !== 'idle' || disabled) return
    held.current = true
    if (!(await canRecord())) {
      held.current = false
      return
    }
    setState('recording')
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      held.current = false
      setState('idle')
      return onError(t.media.noMic)
    }
    const recorder = new MediaRecorder(stream, MediaRecorder.isTypeSupported(MIME) ? { mimeType: MIME } : undefined)
    const chunks: Blob[] = []
    recorder.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data)
    recorder.start()
    rec.current = { recorder, chunks, started: at }
    // Released while the microphone was still opening.
    if (!held.current) void end(false)
  }

  const end = async (keep: boolean, at = 0) => {
    held.current = false
    const r = rec.current
    if (!r) return
    rec.current = null
    const stopped = new Promise<void>((resolve) => r.recorder.addEventListener('stop', () => resolve(), { once: true }))
    r.recorder.stop()
    r.recorder.stream.getTracks().forEach((tr) => tr.stop())
    await stopped
    if (!keep || at - r.started < MIN_MS || !r.chunks.length) {
      if (keep) onError(t.media.tooShort)
      return setState('idle')
    }
    setState('working')
    try {
      await onAudio(new Uint8Array(await new Blob(r.chunks, { type: r.recorder.mimeType }).arrayBuffer()))
    } finally {
      setState('idle')
    }
  }

  const label = state === 'working' ? t.media.transcribing : t.media.mic
  return (
    <button
      type="button"
      className={`composer-tool mic ${state}`}
      disabled={disabled && state === 'idle'}
      aria-label={label}
      aria-pressed={state === 'recording'}
      aria-busy={state === 'working'}
      title={label}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        void begin(e.timeStamp)
      }}
      onPointerUp={(e) => void end(true, e.timeStamp)}
      onPointerCancel={() => void end(false)}
      onKeyDown={(e) => {
        if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
          e.preventDefault()
          void begin(e.timeStamp)
        } else if (e.key === 'Escape' && state === 'recording') {
          e.preventDefault()
          void end(false)
        }
      }}
      onKeyUp={(e) => {
        if (e.key === ' ' || e.key === 'Enter') void end(true, e.timeStamp)
      }}
    >
      <Icon name={state === 'working' ? 'refresh' : 'mic'} size={17} />
    </button>
  )
}
