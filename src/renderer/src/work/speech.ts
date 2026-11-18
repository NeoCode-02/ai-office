import type { Voice } from '../../../shared/types'

/** What is worth reading aloud in a Markdown reply: words, not markup, links or code. */
export function plain(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`\n]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/^\s*\|?\s*:?-{3,}.*$/gm, '')
    .replace(/(\*\*|__|\*|_|~~)(\S(?:[^\n]*?\S)?)\1/g, '$2')
    .replace(/\|/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/^ +| +$/gm, '')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

interface Playing {
  done: Promise<void>
  stop(): void
}

/** One of the system's voices, in the app's language when it has one. */
function system(text: string, lang: string): Playing {
  const u = new SpeechSynthesisUtterance(text)
  const voice = speechSynthesis.getVoices().find((v) => v.lang.toLowerCase().startsWith(lang))
  if (voice) u.voice = voice
  u.lang = voice?.lang ?? (lang === 'uz' ? 'uz-UZ' : 'en-US')
  const done = new Promise<void>((resolve) => {
    u.onend = () => resolve()
    u.onerror = () => resolve()
  })
  speechSynthesis.speak(u)
  return { done, stop: () => speechSynthesis.cancel() }
}

/** The provider's voice: mp3 from the main process, played here. */
async function provider(text: string): Promise<Playing> {
  const bytes = await window.office.speak(text)
  const url = URL.createObjectURL(new Blob([bytes.slice()], { type: 'audio/mpeg' }))
  const audio = new Audio(url)
  let finish = () => {}
  const done = new Promise<void>((resolve) => {
    finish = () => {
      URL.revokeObjectURL(url)
      resolve()
    }
  })
  audio.onended = finish
  audio.onerror = finish
  try {
    await audio.play()
  } catch {
    finish()
  }
  return {
    done,
    stop: () => {
      audio.pause()
      finish()
    }
  }
}

/**
 * Reads replies aloud one after another. `settings` is asked before each reply, so a change in
 * Settings applies to the next one.
 */
export function createSpeaker(settings: () => Promise<Voice>, lang: () => string) {
  const queue: string[] = []
  let onError: (e: unknown) => void = () => {}
  const listeners = new Set<() => void>()
  let current: Playing | null = null
  let busy = false
  const changed = () => listeners.forEach((f) => f())

  const next = async () => {
    if (busy) return
    busy = true
    changed()
    try {
      for (let text = queue.shift(); text !== undefined; text = queue.shift()) {
        const voice = await settings()
        current = voice.tts === 'provider' ? await provider(text) : system(text, lang())
        await current.done
        current = null
      }
    } catch (e) {
      queue.length = 0
      onError(e)
    } finally {
      current = null
      busy = false
      changed()
    }
  }

  return {
    /** Where a failure goes (no voice provider, a network error); the waiting replies are dropped. */
    onError(f: (e: unknown) => void) {
      onError = f
    },
    say(markdown: string) {
      const text = plain(markdown)
      if (!text) return
      queue.push(text)
      void next()
    },
    /** Stops the reply being read and drops the ones waiting. */
    stop() {
      queue.length = 0
      current?.stop()
    },
    speaking: () => busy,
    subscribe(f: () => void) {
      listeners.add(f)
      return () => {
        listeners.delete(f)
      }
    }
  }
}

export type Speaker = ReturnType<typeof createSpeaker>
