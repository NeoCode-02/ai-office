export type ProviderKind = 'openai' | 'anthropic'

/** Renderer never sees the key itself, only whether one is stored. */
export interface Provider {
  id: string
  name: string
  kind: ProviderKind
  baseURL: string
  hasKey: boolean
}

/** Tokens of one model request. `in` is the uncached part of the prompt. */
export interface Usage {
  in: number
  cacheRead: number
  cacheWrite: number
  out: number
  /** What the provider says it billed (OpenRouter), when it says so. */
  usd?: number
}

/** USD per 1M tokens. `long` applies to the whole request once its prompt is above `above` tokens. */
export interface Price {
  in: number
  out: number
  cacheRead?: number
  cacheWrite?: number
  long?: { above: number; in: number; out: number; cacheRead?: number; cacheWrite?: number }
}

export const TOOL_NAMES = [
  'list_files',
  'read_file',
  'search_files',
  'write_file',
  'edit_file',
  'run_command',
  'web_fetch',
  'message',
  'remember',
  'use_skill',
  'read_skill_file',
  'report_to_user'
] as const
export type ToolName = (typeof TOOL_NAMES)[number]

export interface Agent {
  id: string
  name: string
  title: string
  department: string
  reportsTo: string | null
  instructions: string
  providerId: string
  model: string
  /** USD per 1M tokens */
  priceIn: number
  priceOut: number
  tools: ToolName[]
  /** MCP server ids this agent may use. */
  mcpServers?: string[]
}

export interface Project {
  id: string
  name: string
  workspaceDir: string
  briefing: string
  approval: 'ask' | 'auto'
  budgetUsd: number
  agents: Agent[]
}

export type AgentStatus = 'idle' | 'working' | 'waiting'
export type RunState = 'running' | 'done' | 'stopped' | 'error'

export type OfficeEvent =
  | { type: 'message'; id: string; at: number; from: string; to: string[]; text: string }
  | { type: 'tool'; id: string; at: number; agentId: string; name: string; summary: string; ok: boolean }
  | { type: 'status'; agentId: string; status: AgentStatus; at: number }
  /** usd is null when the price is unknown. Runs saved before v0.3 have inTok/outTok instead of usage. */
  | { type: 'cost'; agentId: string; usd: number | null; usage?: Usage; inTok?: number; outTok?: number; at: number }
  | { type: 'approval'; id: string; agentId: string; kind: 'command' | 'mcp'; command: string; at: number }
  | { type: 'approval_done'; id: string; approved: boolean; at: number }
  /** reason is a code: owner_stopped | new_task | idle | report | budget (usd set) */
  | { type: 'run'; runId: string; state: RunState; reason?: string; usd?: number; at: number }

export interface RunSummary {
  id: string
  goal: string
  startedAt: number
  state: RunState
}

/** Senders that are not agents. */
export const USER = 'user'
export const SYSTEM = 'system'

export interface McpServer {
  id: string
  name: string
  transport: 'stdio' | 'http'
  command: string
  args: string[]
  url: string
  enabled: boolean
  /** Env vars (stdio) or headers (http) are stored encrypted; the UI only sees whether any exist. */
  hasSecrets: boolean
  /** Plugin name when the server comes from a plugin (read-only in the UI). */
  plugin?: string
}

export interface Skill {
  name: string
  description: string
  source: 'builtin' | 'user' | 'plugin'
  plugin?: string
  enabled: boolean
}

export interface RoleTemplate {
  title: string
  description: string
  instructions: string
  plugin: string
}

export interface Plugin {
  name: string
  description: string
  version: string
  enabled: boolean
  skills: string[]
  mcpServers: string[]
  roles: string[]
  /** Parts of a Claude Code plugin this app does not run (commands, hooks). */
  ignored: string[]
}
