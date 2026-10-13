import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import type { ProviderKind, Usage } from '../shared/types'

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
export interface ToolResult {
  id: string
  content: string
  isError?: boolean
}
export interface Turn {
  text: string
  calls: ToolCall[]
  usage: Usage
}
export interface Conn {
  kind: ProviderKind
  baseURL: string
  apiKey: string
}

/**
 * One agent's private conversation. History stays in the provider's native
 * format so provider-specific blocks (thinking, reasoning_content) replay intact.
 * A failed step leaves the history unchanged, so the same step can be retried.
 */
export interface Chat {
  step(results: ToolResult[], text?: string): Promise<Turn>
}

export function openChat(conn: Conn, model: string, system: string, tools: ToolDef[]): Chat {
  return conn.kind === 'anthropic'
    ? anthropicChat(conn, model, system, tools)
    : openaiChat(conn, model, system, tools)
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

function anthropicChat(conn: Conn, model: string, system: string, tools: ToolDef[]): Chat {
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
  // tool_use ids from a refused turn: never run, but each still needs a tool_result.
  let orphans: string[] = []

  return {
    async step(results, text) {
      const mark = messages.length
      const prevOrphans = orphans
      results = [...orphans.map((id) => ({ id, content: 'Not run: the previous reply was cut off', isError: true })), ...results]
      orphans = []
      const content: Anthropic.Beta.BetaContentBlockParam[] = results.map((r) => ({
        type: 'tool_result',
        tool_use_id: r.id,
        content: r.content,
        is_error: r.isError
      }))
      if (text) content.push({ type: 'text', text })
      messages.push({ role: 'user', content })

      let msg: Anthropic.Beta.BetaMessage
      try {
        msg = await client.beta.messages
          .stream({
          model,
          max_tokens: 32000,
          system,
          tools: defs,
          messages,
          cache_control: { type: 'ephemeral' },
          ...fallback
        })
          .finalMessage()
      } catch (e) {
        messages.length = mark
        orphans = prevOrphans
        throw e
      }
      messages.push({ role: 'assistant', content: msg.content })

      const turn: Turn = {
        text: msg.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n'),
        calls: [],
        usage: {
          in: msg.usage.input_tokens,
          cacheRead: msg.usage.cache_read_input_tokens ?? 0,
          cacheWrite: msg.usage.cache_creation_input_tokens ?? 0,
          out: msg.usage.output_tokens
        }
      }
      // Refused or cut-off turns may hold a partial tool_use: never run it.
      if (msg.stop_reason === 'refusal' || msg.stop_reason === 'max_tokens') {
        turn.text ||= msg.stop_reason === 'refusal' ? '(the model declined this request)' : '(the reply hit the length limit)'
        orphans = msg.content.flatMap((b) => (b.type === 'tool_use' ? [b.id] : []))
        return turn
      }
      for (const b of msg.content) {
        if (b.type === 'tool_use') turn.calls.push({ id: b.id, name: b.name, input: asObject(b.input) })
      }
      return turn
    }
  }
}

function openaiChat(conn: Conn, model: string, system: string, tools: ToolDef[]): Chat {
  const client = new OpenAI({ apiKey: conn.apiKey, baseURL: conn.baseURL || undefined })
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: 'system', content: system }]
  const defs: OpenAI.Chat.ChatCompletionTool[] = tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters }
  }))

  return {
    async step(results, text) {
      const mark = messages.length
      for (const r of results) messages.push({ role: 'tool', tool_call_id: r.id, content: r.content })
      if (text) messages.push({ role: 'user', content: text })

      let res: OpenAI.Chat.ChatCompletion
      try {
        res = await client.chat.completions.create({ model, messages, tools: defs })
        if (!res.choices[0]) throw new Error('The provider returned an empty response')
      } catch (e) {
        messages.length = mark
        throw e
      }
      const choice = res.choices[0]
      // Push as returned: keeps extra fields like DeepSeek's reasoning_content.
      messages.push(choice.message as OpenAI.Chat.ChatCompletionAssistantMessageParam)

      const calls: ToolCall[] = []
      for (const c of choice.message.tool_calls ?? []) {
        if (c.type !== 'function') continue
        calls.push({ id: c.id, name: c.function.name, input: parseArgs(c.function.arguments) })
      }
      return {
        text: choice.message.content ?? '',
        calls,
        usage: openaiUsage(res.usage)
      }
    }
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

export interface Preset {
  name: string
  kind: ProviderKind
  baseURL: string
  keyUrl: string
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
  { name: 'Ollama (lokal)', kind: 'openai', baseURL: 'http://localhost:11434/v1', keyUrl: '' }
]
