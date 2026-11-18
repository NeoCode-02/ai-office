import type {
  AppSettings,
  Balance,
  CapUse,
  McpServer,
  ModelRef,
  OfficeEvent,
  Plugin,
  Preset,
  Price,
  Project,
  Provider,
  QuotaUse,
  RoleTemplate,
  RunChanges,
  RunSummary,
  Skill,
  UpdateInfo,
  UsageStats
} from './types'

/**
 * Everything the UI can ask the main process for. Each method is one IPC handler of the same
 * name (src/main/index.ts); the preload bridge exposes it as an async function.
 * Errors are thrown as `E_CODE` or `E_CODE|param` (translated in the renderer's i18n).
 */
export interface Api {
  appInfo(): { version: string; platform: string }
  presets(): Preset[]
  getSettings(): AppSettings
  /** Applies the theme and caps right away. */
  saveSettings(s: AppSettings): void
  /** Latest GitHub release; throws E_UPDATE|status. */
  checkUpdate(): Promise<UpdateInfo>

  listProviders(): Provider[]
  saveProvider(p: Omit<Provider, 'hasKey'>, key: string): void
  /** Throws E_PROVIDER_IN_USE|names when a member still uses it, unless `force`. */
  deleteProvider(id: string, force?: boolean): void
  listModels(id: string): Promise<string[]>
  /** Effective price per model (the provider's own, else built-in). */
  priceInfo(p: Pick<Provider, 'kind' | 'baseURL' | 'prices'>, models: string[]): Record<string, { price?: Price }>
  /** Prices from OpenRouter's public catalog for the models it can match unambiguously. */
  catalogPrices(p: Pick<Provider, 'kind' | 'baseURL'>, models: string[]): Promise<Record<string, Price>>
  /** Usage in [from, to) plus each provider's quota use and the app-wide caps right now. */
  usageStats(from: number, to: number, projectId?: string): { stats: UsageStats; quotas: Record<string, QuotaUse | null>; caps: CapUse }
  balance(id: string): Promise<Balance | null>

  listProjects(): Project[]
  /** Also updates a running office (budget, limits, approval mode, allow list, plan mode, sandbox). */
  saveProject(p: Project): void
  deleteProject(id: string): void
  /** Save dialog; returns the file written, null when cancelled. */
  exportProject(id: string): Promise<string | null>
  /** Open dialog; saves and returns the imported office (new ids), null when cancelled. Throws E_BAD_FILE. */
  importProject(): Promise<Project | null>
  pickFolder(): Promise<string | null>
  /** Opens the office's workspace folder in the system file manager. */
  openWorkspace(projectId: string): Promise<void>
  /**
   * Copies files into the workspace's attachments/ folder and returns their workspace paths; without
   * `paths` it asks with an open dialog ([] when cancelled). Throws E_NO_WORKSPACE, E_ATTACH_NOT_FILE|name, E_ATTACH_TOO_BIG|name.
   */
  attach(projectId: string, paths?: string[]): Promise<string[]>

  listSkills(): Skill[]
  setSkillEnabled(name: string, on: boolean): void
  createSkill(name: string, description: string, body: string): void
  importSkill(dir: string): string
  deleteSkill(name: string): void
  listPlugins(): Plugin[]
  importPlugin(dir: string): string
  setPluginEnabled(name: string, on: boolean): void
  deletePlugin(name: string): void
  pluginRoles(): RoleTemplate[]
  listMcp(): McpServer[]
  saveMcp(m: Omit<McpServer, 'hasSecrets' | 'plugin'>, secrets: string): void
  deleteMcp(id: string): void
  testMcp(id: string): Promise<string[]>

  listRuns(projectId: string): RunSummary[]
  readRun(projectId: string, runId: string): OfficeEvent[]
  /** Throws E_RUN_ACTIVE for the running task. */
  deleteRun(projectId: string, runId: string): void
  /** Save dialog with the task as Markdown; null when cancelled. */
  exportRun(projectId: string, runId: string): Promise<string | null>
  activeRun(projectId: string): string | null
  /** Snapshots the workspace (when checkpoints are on), then starts. Throws E_NO_WORKSPACE, E_CAP_REACHED|… */
  start(projectId: string, goal: string): Promise<string>
  /** Throws E_NO_RUN, E_BUDGET_SPENT|usd, E_CAP_REACHED|… */
  post(projectId: string, text: string, to?: string): void
  stop(projectId: string): void
  retryAgent(projectId: string, agentId: string, model?: ModelRef): void
  /** `always`: remember the permission in Project.allowCommands. */
  answer(projectId: string, approvalId: string, ok: boolean, always?: boolean): void
  answerPlan(projectId: string, planId: string, approved: boolean, feedback?: string): void

  /** Files the task changed since its snapshot. */
  runChanges(projectId: string, runId: string): Promise<RunChanges>
  fileDiff(projectId: string, runId: string, path: string): Promise<string>
  /** Puts files (all when `paths` is missing) back as they were when the task started. Throws E_RUN_ACTIVE. */
  revertRun(projectId: string, runId: string, paths?: string[]): Promise<void>
  /** `git add -A && git commit` in the workspace's own repository; returns the commit id. Throws E_NOT_GIT_REPO, E_NOTHING_TO_COMMIT. */
  commitWorkspace(projectId: string, message: string): Promise<string>
}

/** Main → renderer push channels (besides the IPC handlers above). */
export const CHANNELS = {
  /** (projectId, runId, event) — every OfficeEvent, also written to the run log. */
  event: 'office:event',
  /** (projectId, agentId, text | null) — the reply a member is writing right now; null clears it. Not saved. */
  delta: 'office:delta',
  /** (projectId) — a notification was clicked: show this office. */
  openProject: 'app:open-project',
  /** (UpdateInfo) — a newer release was found at startup. */
  update: 'app:update'
} as const
