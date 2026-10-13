import { app, BrowserWindow, dialog, ipcMain, nativeTheme, Notification, safeStorage, shell, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { CHANNELS, type Api } from '../shared/api'
import { SYSTEM, type AppSettings, type McpServer, type ModelRef, type OfficeEvent, type Price, type Project, type Provider } from '../shared/types'
import { balance } from './balance'
import { charge, fetchCatalog, matchCatalog, priceOf } from './billing'
import { createCheckpoints } from './checkpoints'
import { projectFromJson, projectToJson, runToMarkdown } from './exporting'
import { createExtensions } from './extensions'
import { McpClient, McpPool } from './mcp'
import { Office } from './office'
import { listModels, PRESETS } from './providers'
import { quotaUse, stats, windowStart } from './stats'
import { createStore } from './store'
import { checkUpdate } from './updates'
import { bool, isId, isMcp, isModelRef, isPrices, isProject, isProvider, isSettings, num, obj, optStr, str, strArr } from './validate'
import { createAttention, createCaps, fileName, providerUsers, throttle, withRule } from './wiring'

// Separate data folder for tests / portable use.
if (process.env.AI_OFFICE_DATA) app.setPath('userData', process.env.AI_OFFICE_DATA)

const primary = app.requestSingleInstanceLock()
if (!primary) app.quit()

const dataDir = path.join(app.getPath('userData'), 'data')
const cipher = {
  encrypt: (s: string) => {
    // Linux without GNOME Keyring/KWallet: say so instead of Chromium's raw error.
    if (!safeStorage.isEncryptionAvailable()) throw new Error('E_NO_KEYCHAIN')
    return safeStorage.encryptString(s).toString('base64')
  },
  decrypt: (s: string) => safeStorage.decryptString(Buffer.from(s, 'base64'))
}
const store = createStore(dataDir, cipher)
store.migrate()
store.reconcileRuns()
const ext = createExtensions(dataDir, cipher)
const checkpoints = createCheckpoints(dataDir)

let settings = store.getSettings()
nativeTheme.themeSource = settings.theme

const caps = createCaps(store.readUsage(windowStart('month', Date.now()), Date.now() + 1))
const attention = createAttention()

interface Running {
  office: Office
  pool: McpPool
  /** The office as it was started (kept current by saveProject); used for names in events. */
  project: Project
}
const offices = new Map<string, Running>()
let win: BrowserWindow | null = null

const overlay = () => ({ color: '#00000000', symbolColor: nativeTheme.shouldUseDarkColors ? '#a1a4ab' : '#3f4148', height: 48 })
const rendererFile = pathToFileURL(path.join(__dirname, '../renderer/index.html')).href

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 960,
    minHeight: 620,
    show: false,
    title: 'AI Office',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#111214' : '#f7f7f5',
    titleBarStyle: 'hidden',
    titleBarOverlay: overlay(),
    trafficLightPosition: { x: 16, y: 17 },
    webPreferences: { preload: path.join(__dirname, '../preload/index.js'), sandbox: true, contextIsolation: true }
  })
  win.once('ready-to-show', () => win?.show())
  // Links never open inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win?.webContents.getURL()) e.preventDefault()
  })
  win.on('focus', () => win?.flashFrame(false))
  win.webContents.once('did-finish-load', () => void updateAtStartup())
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'))
}

nativeTheme.on('updated', () => {
  if (process.platform !== 'darwin') win?.setTitleBarOverlay(overlay())
})

function project(id: string): Project {
  const p = store.listProjects().find((x) => x.id === id)
  if (!p) throw new Error('E_NO_PROJECT')
  return p
}

function send(channel: string, ...args: unknown[]) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
}

// --- attention: notifications and the badge ---

function updateBadge() {
  const n = attention.count()
  app.setBadgeCount(n)
  if (process.platform === 'win32' && win && !win.isFocused()) win.flashFrame(n > 0)
}

const STOPPED: Record<string, string> = {
  budget: 'Stopped: the budget was reached',
  limit: 'Stopped: the request limit was reached',
  loop: 'Stopped: members kept messaging without doing work',
  cap: 'Stopped: the spending cap was reached'
}

/** Short English text for the OS notification (it is OS chrome, not app UI). */
function notice(p: Project, ev: OfficeEvent): string | null {
  const who = (id: string) => p.agents.find((a) => a.id === id)?.name ?? 'A member'
  if (ev.type === 'approval') return `${who(ev.agentId)} asks for your approval`
  if (ev.type === 'plan') return `${who(ev.agentId)} proposed a plan`
  if (ev.type === 'blocked') return `${who(ev.agentId)} stopped and needs you`
  if (ev.type === 'run' && ev.reason === 'report') return 'The final report is ready'
  if (ev.type === 'run' && ev.reason) return STOPPED[ev.reason] ?? null
  return null
}

function notifyOwner(p: Project, ev: OfficeEvent) {
  if (!settings.notifications || !Notification.isSupported() || win?.isFocused()) return
  const body = notice(p, ev)
  if (!body) return
  const n = new Notification({ title: `AI Office — ${p.name}`, body })
  n.on('click', () => {
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    // The office may have been deleted since.
    if (store.listProjects().some((x) => x.id === p.id)) send(CHANNELS.openProject, p.id)
  })
  n.show()
}

// --- events ---

function stopAll(reason: string, usd?: number) {
  for (const o of offices.values()) if (o.office.isRunning) o.office.stop(reason, { usd })
}

function capError(): Error | null {
  const which = caps.reached(settings)
  return which ? new Error(`E_CAP_REACHED|${which}`) : null
}

function capSpent(which: 'day' | 'month') {
  const use = caps.use(settings)
  return which === 'day' ? use.day : use.month
}

function emit(projectId: string, runId: string, ev: OfficeEvent) {
  store.appendEvent(projectId, runId, ev)
  const p = offices.get(projectId)?.project ?? store.listProjects().find((x) => x.id === projectId)
  if (ev.type === 'cost' && ev.usage && ev.providerId && ev.model) {
    const agent = p?.agents.find((a) => a.id === ev.agentId)?.name ?? ev.agentId
    store.appendUsage({ ...ev.usage, at: ev.at, projectId, runId, agentId: ev.agentId, agent, providerId: ev.providerId, model: ev.model, usd: ev.usd })
    const before = caps.reached(settings)
    caps.add(ev.usd ?? 0, ev.at)
    const which = caps.reached(settings)
    // Stopping from inside the office's own emit would re-enter it; do it right after.
    if (which && !before) queueMicrotask(() => stopAll('cap', capSpent(which)))
  }
  if (ev.type === 'run') {
    const run = store.listRuns(projectId).find((r) => r.id === runId)
    if (run) store.saveRun(projectId, { ...run, state: ev.state })
    if (ev.state !== 'running') offices.get(projectId)?.pool.closeAll()
  }
  if (attention.track(projectId, ev)) updateBadge()
  if (p) notifyOwner(p, ev)
  send(CHANNELS.event, projectId, runId, ev)
}

const sendDelta = throttle((key, text) => {
  const [projectId, agentId] = key.split('\n')
  send(CHANNELS.delta, projectId, agentId, text)
})

// --- updates ---

const updateFile = path.join(dataDir, 'update-check.json')

async function updateAtStartup() {
  if (!settings.checkUpdates) return
  try {
    const last = Number((JSON.parse(fs.readFileSync(updateFile, 'utf8')) as { at?: unknown }).at)
    if (Date.now() - last < 24 * 3600_000) return
  } catch {
    // never checked yet
  }
  try {
    const info = await checkUpdate(app.getVersion())
    fs.writeFileSync(updateFile, JSON.stringify({ at: Date.now() }))
    if (info.newer) send(CHANNELS.update, info)
  } catch {
    // Offline or GitHub unreachable: try again at the next start.
  }
}

// --- handlers ---

async function saveDialog(defaultName: string, filter: { name: string; extensions: string[] }, text: string): Promise<string | null> {
  const r = await dialog.showSaveDialog(win!, { defaultPath: defaultName, filters: [filter] })
  if (r.canceled || !r.filePath) return null
  fs.writeFileSync(r.filePath, text)
  return r.filePath
}

function activeRunning(projectId: string, runId: string) {
  const o = offices.get(projectId)
  return o?.office.runId === runId && o.office.isRunning
}

const handlers: Api = {
  appInfo: () => ({ version: app.getVersion(), platform: process.platform }),
  presets: () => PRESETS,
  getSettings: (): AppSettings => settings,
  saveSettings: (s: AppSettings) => {
    settings = store.saveSettings(s)
    nativeTheme.themeSource = settings.theme
    const which = caps.reached(settings)
    if (which) stopAll('cap', capSpent(which))
  },
  checkUpdate: () => checkUpdate(app.getVersion()),
  listProviders: () => store.listProviders(),
  saveProvider: (p: Omit<Provider, 'hasKey'>, key: string) => store.saveProvider(p, key),
  deleteProvider: (id: string, force?: boolean) => {
    const users = force ? '' : providerUsers(store.listProjects(), id)
    if (users) throw new Error(`E_PROVIDER_IN_USE|${users}`)
    store.deleteProvider(id)
  },
  listModels: (id: string) => listModels(store.conn(id)),
  priceInfo: (p: Pick<Provider, 'kind' | 'baseURL' | 'prices'>, models: string[]) =>
    Object.fromEntries(models.map((m) => [m, { price: priceOf(p, m) }])) as Record<string, { price?: Price }>,
  catalogPrices: async (p: Pick<Provider, 'kind' | 'baseURL'>, models: string[]) => {
    const list = await fetchCatalog()
    const out: Record<string, Price> = {}
    for (const m of models) {
      const price = matchCatalog(list, p, m)
      if (price) out[m] = price
    }
    return out
  },
  usageStats: (from: number, to: number, projectId?: string) => {
    const now = Date.now()
    const providers = store.listProviders()
    const windowFrom = Math.min(from, ...providers.map((p) => (p.billing.quota ? windowStart(p.billing.quota.window, now) : now)))
    const records = store.readUsage(windowFrom, Math.max(to, now + 1))
    return {
      stats: stats(records, from, to, projectId),
      quotas: Object.fromEntries(providers.map((p) => [p.id, quotaUse(records, p.id, p.billing, now)])),
      caps: caps.use(settings, now)
    }
  },
  balance: (id: string) => balance(store.conn(id)),

  listProjects: () => store.listProjects(),
  saveProject: (p: Project) => {
    store.saveProject(p)
    const o = offices.get(p.id)
    if (o) {
      o.project = p
      if (o.office.isRunning) o.office.configure(p)
    }
  },
  deleteProject: (id: string) => {
    const o = offices.get(id)
    o?.office.stop()
    o?.pool.closeAll()
    offices.delete(id)
    store.deleteProject(id)
    attention.forget(id)
    updateBadge()
    void checkpoints.remove(id).catch(() => {})
  },
  exportProject: async (id: string) => {
    const p = project(id)
    return saveDialog(fileName(p.name, '.json', 'office'), { name: 'AI Office', extensions: ['json'] }, projectToJson(p))
  },
  importProject: async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openFile'], filters: [{ name: 'AI Office', extensions: ['json'] }] })
    const file = r.filePaths[0]
    if (r.canceled || !file) return null
    if ((fs.statSync(file, { throwIfNoEntry: false })?.size ?? Infinity) > 1024 * 1024) throw new Error('E_BAD_FILE')
    const p = projectFromJson(fs.readFileSync(file, 'utf8'), () => randomUUID().slice(0, 8))
    store.saveProject(p)
    return p
  },
  pickFolder: async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  },
  openWorkspace: async (projectId: string) => {
    const err = await shell.openPath(project(projectId).workspaceDir)
    if (err) throw new Error(err)
  },

  listSkills: () => ext.listSkills(),
  setSkillEnabled: (name: string, on: boolean) => ext.setSkillEnabled(name, on),
  createSkill: (name: string, description: string, body: string) => ext.createSkill(name, description, body),
  importSkill: (dir: string) => ext.importSkill(dir),
  deleteSkill: (name: string) => ext.deleteSkill(name),
  listPlugins: () => ext.listPlugins(),
  importPlugin: (dir: string) => ext.importPlugin(dir),
  setPluginEnabled: (name: string, on: boolean) => ext.setPluginEnabled(name, on),
  deletePlugin: (name: string) => ext.deletePlugin(name),
  pluginRoles: () => ext.pluginRoles(),
  listMcp: () => ext.listMcp(),
  saveMcp: (m: Omit<McpServer, 'hasSecrets' | 'plugin'>, secrets: string) => ext.saveMcp(m, secrets),
  deleteMcp: (id: string) => ext.deleteMcp(id),
  testMcp: async (id: string) => {
    const cfg = ext.mcpConfig(id)
    if (!cfg) throw new Error('E_MCP_DISABLED')
    const c = await McpClient.connect(cfg, app.getVersion())
    try {
      return (await c.listTools()).map((t) => t.name)
    } finally {
      c.close()
    }
  },

  listRuns: (projectId: string) => store.listRuns(projectId),
  readRun: (projectId: string, runId: string) => store.readRun(projectId, runId),
  deleteRun: (projectId: string, runId: string) => {
    if (activeRunning(projectId, runId)) throw new Error('E_RUN_ACTIVE')
    store.deleteRun(projectId, runId)
  },
  exportRun: async (projectId: string, runId: string) => {
    const p = project(projectId)
    const run = store.listRuns(projectId).find((r) => r.id === runId)
    if (!run) throw new Error('E_NO_RUN')
    return saveDialog(fileName(run.goal, '.md', 'task'), { name: 'Markdown', extensions: ['md'] }, runToMarkdown(p, run, store.readRun(projectId, runId)))
  },
  activeRun: (projectId: string) => offices.get(projectId)?.office.runId ?? null,

  async start(projectId: string, goal: string) {
    const capped = capError()
    if (capped) throw capped
    offices.get(projectId)?.office.stop('new_task')
    const p = project(projectId)
    if (!p.workspaceDir || !fs.statSync(p.workspaceDir, { throwIfNoEntry: false })?.isDirectory()) throw new Error('E_NO_WORKSPACE')
    let runId = ''
    const pool = new McpPool((id) => ext.mcpConfig(id), app.getVersion())
    const office = new Office(p, {
      conn: (id) => store.conn(id),
      charge: (id, model, usage) => {
        const prov = store.provider(id)
        return prov ? charge(prov, model, usage) : null
      },
      readNotes: (agentId) => store.readNotes(projectId, agentId),
      appendNote: (agentId, note) => store.appendNote(projectId, agentId, note),
      emit: (ev) => emit(projectId, runId, ev),
      stream: (agentId, text) => sendDelta(`${projectId}\n${agentId}`, text),
      allow: (rule) => {
        const cur = store.listProjects().find((x) => x.id === projectId)
        if (!cur) return
        const next = withRule(cur, rule)
        if (next !== cur) store.saveProject(next)
        const o = offices.get(projectId)
        if (o) o.project = next
      },
      skills: () => ext.enabledSkills(),
      mcp: (ids) => pool.toolbox(ids)
    })
    runId = office.runId
    // A failed snapshot only means "no undo" for this task; it never blocks the work.
    let snapshotError = ''
    if (p.checkpoints !== false) {
      await checkpoints.snapshot(projectId, runId, p.workspaceDir).catch((e: unknown) => {
        snapshotError = e instanceof Error && /^E_[A-Z_]+/.test(e.message) ? e.message : `E_GIT|${String(e)}`
      })
    }
    // Another start may have run while the snapshot was taken.
    offices.get(projectId)?.office.stop('new_task')
    offices.set(projectId, { office, pool, project: p })
    store.saveRun(projectId, { id: runId, goal, startedAt: Date.now(), state: 'running' })
    office.start(goal)
    const system = (text: string) => emit(projectId, runId, { type: 'message', id: randomUUID(), at: Date.now(), from: SYSTEM, to: [], text })
    if (snapshotError) system(snapshotError)
    // OpenRouter reports the billed cost itself; elsewhere pay-per-token needs a price.
    const unpriced = p.agents.filter((a) => {
      const prov = store.provider(a.providerId)
      return prov?.billing.mode === 'payg' && !/openrouter\.ai/.test(prov.baseURL) && !priceOf(prov, a.model)
    })
    if (unpriced.length) system(`E_UNPRICED|${unpriced.map((a) => `${a.name} (${a.model})`).join(', ')}`)
    return runId
  },
  post: (projectId: string, text: string, to?: string) => {
    const o = offices.get(projectId)
    if (!o) throw new Error('E_NO_RUN')
    const capped = capError()
    if (capped) throw capped
    o.office.post(text, to)
  },
  stop: (projectId: string) => offices.get(projectId)?.office.stop(),
  retryAgent: (projectId: string, agentId: string, model?: ModelRef) => offices.get(projectId)?.office.retry(agentId, model),
  answer: (projectId: string, approvalId: string, ok: boolean, always?: boolean) => offices.get(projectId)?.office.answer(approvalId, ok, always ?? false),
  answerPlan: (projectId: string, planId: string, approved: boolean, feedback?: string) =>
    offices.get(projectId)?.office.answerPlan(planId, approved, feedback),

  runChanges: (projectId: string, runId: string) => checkpoints.changes(projectId, runId, project(projectId).workspaceDir),
  fileDiff: (projectId: string, runId: string, file: string) => checkpoints.diff(projectId, runId, project(projectId).workspaceDir, file),
  revertRun: async (projectId: string, runId: string, paths?: string[]) => {
    if (activeRunning(projectId, runId)) throw new Error('E_RUN_ACTIVE')
    await checkpoints.revert(projectId, runId, project(projectId).workspaceDir, paths)
  },
  commitWorkspace: (projectId: string, message: string) => checkpoints.commitWorkspace(project(projectId).workspaceDir, message)
}

// --- IPC: argument shapes per handler; a Record so a new handler can't skip its check ---

const none = (a: unknown[]) => a.length === 0
const connLike = (v: unknown) => obj(v) && (v.kind === 'openai' || v.kind === 'anthropic') && str(v.baseURL, 2000)
const label = (v: unknown) => str(v, 300)
const filePath = (v: unknown) => str(v, 4096)
const optId = (v: unknown) => v === undefined || isId(v)
const optBool = (v: unknown) => v === undefined || bool(v)

const ARGS: Record<keyof Api, (a: unknown[]) => boolean> = {
  appInfo: none,
  presets: none,
  getSettings: none,
  saveSettings: (a) => isSettings(a[0]),
  checkUpdate: none,
  listProviders: none,
  saveProvider: (a) => isProvider(a[0]) && str(a[1], 10_000),
  deleteProvider: (a) => label(a[0]) && optBool(a[1]),
  listModels: (a) => label(a[0]),
  priceInfo: (a) => connLike(a[0]) && obj(a[0]) && isPrices(a[0].prices) && strArr(a[1], 1000, 500),
  catalogPrices: (a) => connLike(a[0]) && strArr(a[1], 1000, 500),
  usageStats: (a) => num(a[0]) && num(a[1]) && optId(a[2]),
  balance: (a) => label(a[0]),
  listProjects: none,
  saveProject: (a) => isProject(a[0]),
  deleteProject: (a) => isId(a[0]),
  exportProject: (a) => isId(a[0]),
  importProject: none,
  pickFolder: none,
  openWorkspace: (a) => isId(a[0]),
  listSkills: none,
  setSkillEnabled: (a) => label(a[0]) && bool(a[1]),
  createSkill: (a) => label(a[0]) && str(a[1], 2000) && str(a[2]),
  importSkill: (a) => filePath(a[0]),
  deleteSkill: (a) => label(a[0]),
  listPlugins: none,
  importPlugin: (a) => filePath(a[0]),
  setPluginEnabled: (a) => label(a[0]) && bool(a[1]),
  deletePlugin: (a) => label(a[0]),
  pluginRoles: none,
  listMcp: none,
  saveMcp: (a) => isMcp(a[0]) && str(a[1]),
  deleteMcp: (a) => label(a[0]),
  testMcp: (a) => label(a[0]),
  listRuns: (a) => isId(a[0]),
  readRun: (a) => isId(a[0]) && isId(a[1]),
  deleteRun: (a) => isId(a[0]) && isId(a[1]),
  exportRun: (a) => isId(a[0]) && isId(a[1]),
  activeRun: (a) => isId(a[0]),
  start: (a) => isId(a[0]) && str(a[1]),
  post: (a) => isId(a[0]) && str(a[1]) && optId(a[2]),
  stop: (a) => isId(a[0]),
  retryAgent: (a) => isId(a[0]) && isId(a[1]) && (a[2] === undefined || isModelRef(a[2])),
  answer: (a) => isId(a[0]) && isId(a[1]) && bool(a[2]) && optBool(a[3]),
  answerPlan: (a) => isId(a[0]) && isId(a[1]) && bool(a[2]) && optStr(a[3]),
  runChanges: (a) => isId(a[0]) && isId(a[1]),
  fileDiff: (a) => isId(a[0]) && isId(a[1]) && filePath(a[2]),
  revertRun: (a) => isId(a[0]) && isId(a[1]) && (a[2] === undefined || strArr(a[2], 10_000, 4096)),
  commitWorkspace: (a) => isId(a[0]) && str(a[1], 5000)
}

/** Only our own window's page may call the main process. */
function trusted(e: IpcMainInvokeEvent): boolean {
  if (!win || e.sender !== win.webContents) return false
  const url = e.senderFrame?.url ?? ''
  const dev = process.env.ELECTRON_RENDERER_URL
  if (dev) {
    try {
      return new URL(url).origin === new URL(dev).origin
    } catch {
      return false
    }
  }
  return url.split(/[?#]/)[0] === rendererFile
}

for (const [key, fn] of Object.entries(handlers)) {
  const check = ARGS[key as keyof Api]
  ipcMain.handle(key, (e, ...args: unknown[]) => {
    if (!trusted(e) || !check(args)) throw new Error('E_BAD_ARGS')
    return (fn as (...a: unknown[]) => unknown)(...args)
  })
}

app.on('second-instance', () => {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
})

if (primary) void app.whenReady().then(createWindow)
app.on('before-quit', () => {
  for (const o of offices.values()) {
    o.office.stop('app_closed')
    o.pool.closeAll()
  }
})
app.on('window-all-closed', () => app.quit())
