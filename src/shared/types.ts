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
  'write_file',
  'edit_file',
  'run_command',
  'message',
  'remember',
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
  | { type: 'approval'; id: string; agentId: string; command: string; at: number }
  | { type: 'approval_done'; id: string; approved: boolean; at: number }
  | { type: 'run'; runId: string; state: RunState; reason?: string; at: number }

export interface RunSummary {
  id: string
  goal: string
  startedAt: number
  state: RunState
}

/** Senders that are not agents. */
export const USER = 'user'
export const SYSTEM = 'system'
