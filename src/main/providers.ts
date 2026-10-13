import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import type { ProviderKind } from '../shared/types'

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
  inTok: number
  outTok: number
}
export interface Conn {
  kind: ProviderKind
  baseURL: string
  apiKey: string
}

/**
 * One agent's private conversation. History stays in the provider's native
 * format so provider-specific blocks (thinking, reasoning_content) replay intact.
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
      results = [...orphans.map((id) => ({ id, content: 'Bekor qilindi', isError: true })), ...results]
      orphans = []
      const content: Anthropic.Beta.BetaContentBlockParam[] = results.map((r) => ({
        type: 'tool_result',
        tool_use_id: r.id,
        content: r.content,
        is_error: r.isError
      }))
      if (text) content.push({ type: 'text', text })
      messages.push({ role: 'user', content })

      const msg = await client.beta.messages
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
      messages.push({ role: 'assistant', content: msg.content })

      const turn: Turn = {
        text: msg.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n'),
        calls: [],
        inTok: msg.usage.input_tokens + (msg.usage.cache_read_input_tokens ?? 0),
        outTok: msg.usage.output_tokens
      }
      // Refused or cut-off turns may hold a partial tool_use: never run it.
      if (msg.stop_reason === 'refusal' || msg.stop_reason === 'max_tokens') {
        turn.text ||= msg.stop_reason === 'refusal' ? '(model so‘rovni rad etdi)' : '(javob uzunlik limitiga yetdi)'
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
      for (const r of results) messages.push({ role: 'tool', tool_call_id: r.id, content: r.content })
      if (text) messages.push({ role: 'user', content: text })

      const res = await client.chat.completions.create({ model, messages, tools: defs })
      const choice = res.choices[0]
      if (!choice) throw new Error('Provayder bo‘sh javob qaytardi')
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
        inTok: res.usage?.prompt_tokens ?? 0,
        outTok: res.usage?.completion_tokens ?? 0
      }
    }
  }
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
