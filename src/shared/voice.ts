import { DEFAULT_VOICE, type Voice } from './types'

const field = (v: unknown, fallback: string) => (typeof v === 'string' && v.length <= 200 ? v : fallback)

/** Known voice settings of the right type over `base` (a settings file is plain JSON). */
export function voiceFrom(v: unknown, base: Voice = DEFAULT_VOICE): Voice {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ...base }
  const o = v as Record<string, unknown>
  return {
    sttProvider: field(o.sttProvider, base.sttProvider),
    sttModel: field(o.sttModel, base.sttModel),
    tts: o.tts === 'system' || o.tts === 'provider' ? o.tts : base.tts,
    ttsProvider: field(o.ttsProvider, base.ttsProvider),
    ttsModel: field(o.ttsModel, base.ttsModel),
    ttsVoice: field(o.ttsVoice, base.ttsVoice)
  }
}

/** The speech-to-text model used when none is set: what the provider's API is known to offer. */
export function sttModelFor(baseURL: string): string {
  if (/api\.groq\.com/.test(baseURL)) return 'whisper-large-v3-turbo'
  if (!baseURL || /api\.openai\.com/.test(baseURL)) return 'gpt-4o-mini-transcribe'
  return 'whisper-1'
}

export const TTS_MODEL = 'gpt-4o-mini-tts'
export const TTS_VOICES = ['alloy', 'ash', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'] as const
