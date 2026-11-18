import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import type { Effort, Preset, ProviderKind, Usage } from '../shared/types'

export interface ToolDef {
  name: string
  description: string
  parameters: { type: 'object'; properties: Record<string, unknown>; required: string[] }
}
export interface ToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}
/** An image or PDF for the model to look at; data is base64. */
export interface Media {
  mime: string
  name: string
  data: string
}
export interface ToolResult {
  id: string
  content: string
  isError?: boolean
  media?: Media
}
export interface Turn {
  text: string
  calls: ToolCall[]
  usage: Usage
  /** The model that wrote the reply, when the API says it differs (server-side fallback). */
  model?: string
}
export interface Conn {
  kind: ProviderKind
  baseURL: string
  apiKey: string
}

/** Per-member request settings, fixed for the life of a chat. */
export interface ChatOpts {
  /** Anthropic only; unset = the model's default effort. */
  effort?: Effort
  /** Longest reply in tokens; unset = the adapter's default. */
  maxTokens?: number
}
export interface StepOpts {
  signal?: AbortSignal
  /** The reply so far, while it streams (Anthropic only). */
  onText?(snapshot: string): void
}

/**
 * One agent's private conversation. History stays in the provider's native
 * format so provider-specific blocks (thinking, reasoning_content) replay intact.
 * A failed or aborted step leaves the history unchanged, so the same step can be retried.
 */
export interface Chat {
  step(results: ToolResult[], text?: string, opts?: StepOpts): Promise<Turn>
}

export function openChat(conn: Conn, model: string, system: string, tools: ToolDef[], opts: ChatOpts = {}): Chat {
  return conn.kind === 'anthropic'
    ? anthropicChat(conn, model, system, tools, opts)
    : openaiChat(conn, model, system, tools, opts)
}

/** Lists model ids for the "Model" picker; empty when the endpoint has no /models. */
export async function listModels(conn: Conn): Promise<string[]> {
  if (conn.kind === 'anthropic') {
    const client = new Anthropic({ apiKey: conn.apiKey, baseURL: conn.baseURL || undefined })
    const ids: string[] = []
    for await (const m of client.models.list()) ids.push(m.id)
    return ids
  }
  const client = new OpenAI({ apiKey: conn.apiKey, baseURL: conn.baseURL || undefined })
  const ids: string[] = []
  for await (const m of client.models.list()) ids.push(m.id)
  return ids.sort()
}

// Opus 5.x / Fable 5.x / Sonnet 5.5 can refuse on safety classifiers; let the API reroute.
const FALLBACK_MODELS = /^claude-(fable-5|opus-5|sonnet-5-5)/

function anthropicChat(conn: Conn, model: string, system: string, tools: ToolDef[], opts: ChatOpts): Chat {
  const client = new Anthropic({ apiKey: conn.apiKey, baseURL: conn.baseURL || undefined })
  const messages: Anthropic.Beta.BetaMessageParam[] = []
  const defs: Anthropic.Beta.BetaTool[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters
  }))
  const fallback = FALLBACK_MODELS.test(model)
    ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }
    : {}
  // Older models (Haiku 4.5, Sonnet 4.5) reject effort, so it is sent only when the owner chose one.
  const effort = opts.effort ? { output_config: { effort: opts.effort } } : {}
  const maxTokens = tokenLimit(opts.maxTokens) ?? 32000
  // tool_use ids from a refused or cut-off turn: never run, but each still needs a tool_result.
  let orphans: string[] = []

  return {
    async step(results, text, { signal, onText } = {}) {
      const mark = messages.length
      const prevOrphans = orphans
      results = [...orphans.map((id) => ({ id, content: CUT_OFF, isError: true })), ...results]
      orphans = []
      const content: Anthropic.Beta.BetaContentBlockParam[] = results.map((r) => ({
        type: 'tool_result',
        tool_use_id: r.id,
        content: r.media ? [{ type: 'text', text: r.content }, anthropicMedia(r.media)] : r.content,
        is_error: r.isError
      }))
      if (text) content.push({ type: 'text', text })
      messages.push({ role: 'user', content })

      let msg: Anthropic.Beta.BetaMessage
      try {
        const stream = client.beta.messages.stream(
          {
            model,
            max_tokens: maxTokens,
            system,
            tools: defs,
            messages,
            cache_control: { type: 'ephemeral' },
            ...effort,
            ...fallback
          },
          { signal }
        )
        if (onText) stream.on('text', () => live(onText, textOf(stream.currentMessage?.content ?? [])))
        msg = await stream.finalMessage()
      } catch (e) {
        messages.length = mark
        orphans = prevOrphans
        throw e
      }
      // History keeps every block verbatim (the server validates the fallback boundary).
      messages.push({ role: 'assistant', content: msg.content })
      // After a mid-reply fallback only what follows the last fallback block counts.
      const cut = msg.content.map((b) => b.type).lastIndexOf('fallback')
      const served = cut < 0 ? msg.content : msg.content.slice(cut + 1)

      const turn: Turn = {
        text: textOf(served),
        calls: [],
        usage: {
          in: msg.usage.input_tokens,
          cacheRead: msg.usage.cache_read_input_tokens ?? 0,
          cacheWrite: msg.usage.cache_creation_input_tokens ?? 0,
          out: msg.usage.output_tokens
        },
        ...(cut >= 0 && msg.model !== model ? { model: msg.model } : {})
      }
      // Refused or cut-off turns may hold a partial tool_use: never run it.
      if (msg.stop_reason === 'refusal' || msg.stop_reason === 'max_tokens') {
        turn.text ||= msg.stop_reason === 'refusal' ? '(the model declined this request)' : '(the reply hit the length limit)'
        orphans = msg.content.flatMap((b) => (b.type === 'tool_use' ? [b.id] : []))
        return turn
      }
      for (const b of served) {
        if (b.type === 'tool_use') turn.calls.push({ id: b.id, name: b.name, input: asObject(b.input) })
      }
      return turn
    }
  }
}

function openaiChat(conn: Conn, model: string, system: string, tools: ToolDef[], opts: ChatOpts): Chat {
  const client = new OpenAI({ apiKey: conn.apiKey, baseURL: conn.baseURL || undefined })
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: 'system', content: system }]
  const defs: OpenAI.Chat.ChatCompletionTool[] = tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters }
  }))
  const limit = tokenLimit(opts.maxTokens)
  // OpenAI's reasoning models reject max_tokens; most other compatible APIs only know max_tokens.
  const cap = limit === undefined ? {} : isOpenAI(conn.baseURL) ? { max_completion_tokens: limit } : { max_tokens: limit }
  // tool_call ids from a cut-off reply: never run, but each still needs a tool message.
  let orphans: string[] = []

  return {
    // No streaming: providers differ in whether a stream reports usage, and the cost must be right.
    async step(results, text, { signal } = {}) {
      const mark = messages.length
      const prevOrphans = orphans
      results = [...orphans.map((id) => ({ id, content: CUT_OFF })), ...results]
      orphans = []
      // Tool messages carry text only: images (and PDFs where the API takes them) follow in one user message.
      const parts: OpenAI.Chat.ChatCompletionContentPart[] = []
      for (const r of results) {
        const part = r.media && openaiMedia(r.media, conn.baseURL)
        if (part) parts.push(part)
        const note = r.media && !part ? `\n${NO_PDF}` : ''
        messages.push({ role: 'tool', tool_call_id: r.id, content: r.content + note })
      }
      if (parts.length) messages.push({ role: 'user', content: [{ type: 'text', text: 'The files you opened:' }, ...parts, ...(text ? [{ type: 'text' as const, text }] : [])] })
      else if (text) messages.push({ role: 'user', content: text })

      let res: OpenAI.Chat.ChatCompletion
      try {
        res = await client.chat.completions.create({ model, messages, ...(defs.length ? { tools: defs } : {}), ...cap }, { signal })
        if (!res.choices[0]) throw new Error('The provider returned an empty response')
      } catch (e) {
        messages.length = mark
        orphans = prevOrphans
        throw e
      }
      const choice = res.choices[0]
      messages.push(replayable(choice.message))

      const turn: Turn = { text: choice.message.content ?? '', calls: [], usage: openaiUsage(res.usage) }
      // A cut-off reply may hold a partial tool call: never run it.
      if (choice.finish_reason === 'length') {
        turn.text ||= '(the reply hit the length limit)'
        orphans = (choice.message.tool_calls ?? []).map((c) => c.id)
        return turn
      }
      for (const c of choice.message.tool_calls ?? []) {
        if (c.type !== 'function') continue
        turn.calls.push({ id: c.id, name: c.function.name, input: parseArgs(c.function.arguments) })
      }
      return turn
    }
  }
}

/**
 * The assistant message as returned (keeps extra fields like DeepSeek's reasoning_content),
 * except tool arguments that are not a JSON object: some servers (Ollama) refuse them on replay.
 */
function replayable(m: OpenAI.Chat.ChatCompletionMessage): OpenAI.Chat.ChatCompletionAssistantMessageParam {
  const msg = m as OpenAI.Chat.ChatCompletionAssistantMessageParam
  const broken = (c: OpenAI.Chat.ChatCompletionMessageToolCall) => c.type === 'function' && !isJsonObject(c.function.arguments)
  if (!m.tool_calls?.some(broken)) return msg
  return {
    ...msg,
    tool_calls: m.tool_calls.map((c) => (c.type === 'function' && broken(c) ? { ...c, function: { ...c.function, arguments: '{}' } } : c))
  }
}

function isJsonObject(s: unknown): boolean {
  if (typeof s !== 'string') return false
  try {
    const v: unknown = JSON.parse(s)
    return !!v && typeof v === 'object' && !Array.isArray(v)
  } catch {
    return false
  }
}

/** OpenAI's own API, which is also where the SDK goes without a base URL. */
function isOpenAI(baseURL: string): boolean {
  if (!baseURL) return true
  try {
    return new URL(baseURL).hostname.toLowerCase() === 'api.openai.com'
  } catch {
    return false
  }
}

const CUT_OFF = 'Not run: the previous reply was cut off'
const NO_PDF = 'This provider cannot show PDF files to you. Ask a colleague on another model, or extract the text with a command.'

function anthropicMedia(m: Media): Anthropic.Beta.BetaImageBlockParam | Anthropic.Beta.BetaRequestDocumentBlock {
  if (m.mime === 'application/pdf') return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: m.data } }
  return { type: 'image', source: { type: 'base64', media_type: m.mime as 'image/png', data: m.data } }
}

/** null for a PDF on an API that takes no files in chat (only OpenAI's own and OpenRouter do). */
function openaiMedia(m: Media, baseURL: string): OpenAI.Chat.ChatCompletionContentPart | null {
  const url = `data:${m.mime};base64,${m.data}`
  if (m.mime !== 'application/pdf') return { type: 'image_url', image_url: { url } }
  return isOpenAI(baseURL) || /openrouter\.ai/.test(baseURL) ? { type: 'file', file: { filename: m.name, file_data: url } } : null
}

/** A usable reply limit, or undefined for the adapter's default. */
function tokenLimit(n: number | undefined): number | undefined {
  return typeof n === 'number' && Number.isFinite(n) && n >= 1 ? Math.floor(n) : undefined
}

function textOf(content: Anthropic.Beta.BetaContentBlock[]): string {
  return content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n')
}

/** A failing live view must never fail the request itself. */
function live(onText: (snapshot: string) => void, snapshot: string) {
  try {
    onText(snapshot)
  } catch {
    // the final reply still arrives through the step's result
  }
}

type Num = number | null | undefined
interface CompatUsage {
  prompt_tokens?: Num
  completion_tokens?: Num
  total_tokens?: Num
  prompt_tokens_details?: { cached_tokens?: Num; cache_write_tokens?: Num } | null
  prompt_cache_hit_tokens?: Num // DeepSeek
  cached_tokens?: Num // Kimi
  cost?: Num // OpenRouter: the amount actually billed
}

/** Normalizes the usage block of OpenAI-compatible APIs; `in` excludes cached tokens. */
export function openaiUsage(u: CompatUsage | null | undefined): Usage {
  const n = (v: Num) => (typeof v === 'number' && v > 0 ? v : 0)
  const prompt = n(u?.prompt_tokens)
  const completion = n(u?.completion_tokens)
  const cacheRead = Math.min(prompt, n(u?.prompt_tokens_details?.cached_tokens) || n(u?.prompt_cache_hit_tokens) || n(u?.cached_tokens))
  const cacheWrite = Math.min(prompt - cacheRead, n(u?.prompt_tokens_details?.cache_write_tokens))
  // Some APIs (Gemini) leave hidden reasoning out of completion_tokens but count it in the total.
  const hidden = Math.max(0, n(u?.total_tokens) - prompt - completion)
  const usage: Usage = { in: prompt - cacheRead - cacheWrite, cacheRead, cacheWrite, out: completion + hidden }
  if (typeof u?.cost === 'number') usage.usd = u.cost
  return usage
}

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

/** Bad JSON becomes a marker the tool validator rejects with a clear error. */
function parseArgs(s: string): Record<string, unknown> {
  try {
    return asObject(JSON.parse(s || '{}'))
  } catch {
    return { __invalid_json: s }
  }
}

/** Where users get keys. Any other OpenAI-compatible endpoint can be added as "Custom". */
export const PRESETS: Preset[] = [
  { name: 'Anthropic (Claude)', kind: 'anthropic', baseURL: '', keyUrl: 'https://console.anthropic.com/settings/keys' },
  { name: 'OpenAI', kind: 'openai', baseURL: 'https://api.openai.com/v1', keyUrl: 'https://platform.openai.com/api-keys' },
  { name: 'Google Gemini', kind: 'openai', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/', keyUrl: 'https://aistudio.google.com/apikey' },
  { name: 'DeepSeek', kind: 'openai', baseURL: 'https://api.deepseek.com', keyUrl: 'https://platform.deepseek.com/api_keys' },
  { name: 'Kimi (Moonshot)', kind: 'openai', baseURL: 'https://api.moonshot.ai/v1', keyUrl: 'https://platform.moonshot.ai/console/api-keys' },
  { name: 'GLM (Z.ai)', kind: 'openai', baseURL: 'https://api.z.ai/api/paas/v4', keyUrl: 'https://z.ai/manage-apikey/apikey-list' },
  { name: 'OpenRouter', kind: 'openai', baseURL: 'https://openrouter.ai/api/v1', keyUrl: 'https://openrouter.ai/keys' },
  { name: 'xAI (Grok)', kind: 'openai', baseURL: 'https://api.x.ai/v1', keyUrl: 'https://console.x.ai' },
  { name: 'Mistral', kind: 'openai', baseURL: 'https://api.mistral.ai/v1', keyUrl: 'https://console.mistral.ai/api-keys' },
  { name: 'Groq', kind: 'openai', baseURL: 'https://api.groq.com/openai/v1', keyUrl: 'https://console.groq.com/keys' },
  { name: 'Ollama (local)', kind: 'openai', baseURL: 'http://localhost:11434/v1', keyUrl: '' }
]
