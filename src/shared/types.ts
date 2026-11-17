export type ProviderKind = 'openai' | 'anthropic'

/** A provider the "Add provider" dialog offers. */
export interface Preset {
  name: string
  kind: ProviderKind
  baseURL: string
  keyUrl: string
}

/**
 * How the account is paid. payg = per token (needs prices), subscription = flat fee,
 * free = local or free tier. `quota` is the user's own limit, tracked from this app's usage.
 */
export interface Billing {
  mode: 'payg' | 'subscription' | 'free'
  /** Subscription fee, USD per month. */
  fee?: number
  quota?: { amount: number; unit: 'usd' | 'requests' | 'tokens'; window: '5h' | 'day' | 'week' | 'month' }
}

/** Renderer never sees the key itself, only whether one is stored. */
export interface Provider {
  id: string
  name: string
  kind: ProviderKind
  baseURL: string
  hasKey: boolean
  billing: Billing
  /** Model id → price. Built-in prices fill in for Anthropic's own API. */
  prices: Record<string, Price>
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
  'report_to_user',
  'propose_plan'
] as const
export type ToolName = (typeof TOOL_NAMES)[number]

/** Anthropic `output_config.effort`. Unset = the model's default. */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** The executives every office has: they can't be removed, and their role and place in the chart are fixed. */
export const EXEC_KINDS = ['ceo', 'cto', 'cfo', 'coo', 'cmo'] as const
export type Exec = (typeof EXEC_KINDS)[number]

export interface Agent {
  id: string
  name: string
  title: string
  department: string
  reportsTo: string | null
  instructions: string
  providerId: string
  model: string
  /** Used for the rest of a run when the main model fails (no credit, bad key, model gone). */
  backup?: ModelRef
  tools: ToolName[]
  /** MCP server ids this agent may use. */
  mcpServers?: string[]
  /** Anthropic providers only. Unset = the model's default effort. */
  effort?: Effort
  /** Longest reply in tokens. Unset = the adapter's default. */
  maxTokens?: number
  /** Skill names this member may load. Unset = every enabled skill. */
  skills?: string[]
  /** Set on the fixed executives; see EXEC_KINDS. */
  exec?: Exec
  /** Where the card sits on the team canvas. Unset = laid out automatically. */
  pos?: { x: number; y: number }
}

/** Guards that end a run which is not getting anywhere. 0 turns a guard off. */
export interface Limits {
  /** Model requests per run, all members together. */
  maxRequests: number
  /** Messages two members may trade in a row while neither does any other work. */
  maxChatter: number
  /** Prompt size (tokens) at which a member's conversation is summarized and restarted. */
  compactAt: number
}
export const DEFAULT_LIMITS: Limits = { maxRequests: 300, maxChatter: 8, compactAt: 120_000 }

/** Where run_command executes. Docker mounts only the workspace folder. */
export interface Sandbox {
  kind: 'none' | 'docker'
  image: string
  network: boolean
}
export const DEFAULT_SANDBOX: Sandbox = { kind: 'none', image: 'node:22-bookworm', network: true }

export interface Project {
  id: string
  name: string
  workspaceDir: string
  briefing: string
  approval: 'ask' | 'auto'
  budgetUsd: number
  agents: Agent[]
  /** Missing on offices saved before v0.3: use DEFAULT_LIMITS. */
  limits?: Limits
  /** The CEO must get the owner's approval of a plan before delegating or changing files. */
  planFirst?: boolean
  /**
   * Things the owner allowed for good in "ask" mode: a command prefix (`npm test`),
   * `mcp:<server › tool>` or `fetch:<host>`.
   */
  allowCommands?: string[]
  /** Missing = DEFAULT_SANDBOX. */
  sandbox?: Sandbox
  /** Snapshot the workspace before each task so its changes can be reviewed and undone. Missing = on. */
  checkpoints?: boolean
}

/** App-wide preferences (data/settings.json). */
export interface AppSettings {
  theme: 'system' | 'light' | 'dark'
  /** Spend caps over all offices in USD, from this app's usage log. 0 = no cap. */
  dailyCapUsd: number
  monthlyCapUsd: number
  /** Desktop notifications when the window is in the background. */
  notifications: boolean
  /** Look for a newer release on GitHub at startup (at most once a day). */
  checkUpdates: boolean
}
export const DEFAULT_SETTINGS: AppSettings = { theme: 'system', dailyCapUsd: 0, monthlyCapUsd: 0, notifications: true, checkUpdates: true }

export interface CapUse {
  day: number
  month: number
  dailyCapUsd: number
  monthlyCapUsd: number
}

export interface UpdateInfo {
  current: string
  /** Latest release version, null when there is none. */
  latest: string | null
  url: string | null
  newer: boolean
}

export interface FileChange {
  path: string
  status: 'added' | 'modified' | 'deleted'
  additions: number
  deletions: number
  binary: boolean
}

/** What a task changed in the workspace, against the snapshot taken when it started. */
export interface RunChanges {
  available: boolean
  /** Error code when not available: E_NO_GIT | E_CHECKPOINT_TOO_BIG | E_NO_CHECKPOINT. */
  reason?: string
  files: FileChange[]
}

export type AgentStatus = 'idle' | 'working' | 'waiting' | 'blocked'
/** Why a model request failed; see src/main/errors.ts. */
export type ErrorKind = 'rate' | 'server' | 'network' | 'quota' | 'auth' | 'model' | 'context' | 'config' | 'other'
export interface ModelRef {
  providerId: string
  model: string
}
export type RunState = 'running' | 'done' | 'stopped' | 'error'

export type OfficeEvent =
  | { type: 'message'; id: string; at: number; from: string; to: string[]; text: string }
  /** detail: the start of the tool's result; diff: unified diff of a write_file / edit_file. */
  | { type: 'tool'; id: string; at: number; agentId: string; name: string; summary: string; ok: boolean; detail?: string; diff?: string }
  | { type: 'status'; agentId: string; status: AgentStatus; at: number }
  /**
   * usd is null when the price is unknown; est is then what the budget and caps counted instead
   * (billing.ts ESTIMATE). Runs saved before v0.3 have inTok/outTok instead of usage.
   */
  | { type: 'cost'; agentId: string; providerId?: string; model?: string; usd: number | null; est?: number; usage?: Usage; inTok?: number; outTok?: number; at: number }
  /**
   * fetch = web_fetch to this computer or the local network. sandbox: the command runs in Docker.
   * files: workspace files the team changed since the last approved command (they may affect what it runs).
   */
  | { type: 'approval'; id: string; agentId: string; kind: 'command' | 'mcp' | 'fetch'; command: string; files?: string[]; sandbox?: boolean; at: number }
  /** always: the owner allowed this for good (see Project.allowCommands). */
  | { type: 'approval_done'; id: string; approved: boolean; always?: boolean; at: number }
  /** The CEO's plan, waiting for the owner (Project.planFirst). */
  | { type: 'plan'; id: string; agentId: string; text: string; at: number }
  | { type: 'plan_done'; id: string; approved: boolean; feedback?: string; at: number }
  /** A member's conversation was summarized and restarted. tokens = prompt size that triggered it. */
  | { type: 'compact'; agentId: string; tokens: number; at: number }
  /** A request failed with a temporary error; the member retries after waitMs. */
  | { type: 'notice'; agentId: string; kind: ErrorKind; attempt: number; of: number; waitMs: number; at: number }
  /** The member moved to its backup model for the rest of the run. */
  | { type: 'switch'; agentId: string; from: ModelRef; to: ModelRef; kind: ErrorKind; detail: string; at: number }
  /** The member stopped and waits for the owner (retry or another model). */
  | { type: 'blocked'; id: string; agentId: string; providerId: string; model: string; kind: ErrorKind; detail: string; at: number }
  | { type: 'unblocked'; id: string; agentId: string; at: number }
  /**
   * reason is a code: owner_stopped | new_task | idle | report | plan (waits for plan approval)
   * | budget (usd set) | limit (requests set) | loop (agents named in `agents`) | cap (usd set) | app_closed
   */
  | { type: 'run'; runId: string; state: RunState; reason?: string; usd?: number; requests?: number; agents?: string[]; at: number }

/** One model request, as kept in the usage log. */
export interface UsageRecord extends Omit<Usage, 'usd'> {
  at: number
  projectId: string
  runId: string
  agentId: string
  agent: string
  providerId: string
  model: string
  usd: number | null
}

export interface UsageRow {
  requests: number
  in: number
  cacheRead: number
  cacheWrite: number
  out: number
  usd: number
  /** Requests whose price was unknown; their cost is not in `usd`. */
  unpriced: number
}

export interface UsageStats {
  total: UsageRow
  byModel: (UsageRow & { providerId: string; model: string })[]
  byAgent: (UsageRow & { projectId: string; agentId: string; agent: string; model: string })[]
  byDay: { day: string; usd: number; tokens: number }[]
}

export interface QuotaUse {
  used: number
  amount: number
  unit: 'usd' | 'requests' | 'tokens'
  window: '5h' | 'day' | 'week' | 'month'
}

/** What the provider's own API says is left. */
export type Balance = { kind: 'balance'; amount: number; currency: string } | { kind: 'key'; remaining: number | null; used: number }

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
