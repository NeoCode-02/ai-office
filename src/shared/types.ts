export type ProviderKind = 'openai' | 'anthropic'

/** Renderer never sees the key itself, only whether one is stored. */
export interface Provider {
  id: string
  name: string
  kind: ProviderKind
  baseURL: string
  hasKey: boolean
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
  | { type: 'cost'; agentId: string; usd: number; inTok: number; outTok: number; at: number }
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
