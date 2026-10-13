import { app, BrowserWindow, dialog, ipcMain, nativeTheme, safeStorage, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Api } from '../shared/api'
import { DEFAULT_SETTINGS, SYSTEM, type AppSettings, type McpServer, type ModelRef, type OfficeEvent, type Price, type Project, type Provider } from '../shared/types'
import { balance } from './balance'
import { charge, fetchCatalog, matchCatalog, priceOf } from './billing'
import { quotaUse, stats, windowStart } from './stats'
import { createExtensions } from './extensions'
import { McpClient, McpPool } from './mcp'
import { Office } from './office'
import { listModels, PRESETS } from './providers'
import { createStore } from './store'

// Separate data folder for tests / portable use.
if (process.env.AI_OFFICE_DATA) app.setPath('userData', process.env.AI_OFFICE_DATA)

const dataDir = path.join(app.getPath('userData'), 'data')
const cipher = {
  encrypt: (s: string) => safeStorage.encryptString(s).toString('base64'),
  decrypt: (s: string) => safeStorage.decryptString(Buffer.from(s, 'base64'))
}
const store = createStore(dataDir, cipher)
store.migrate()
const ext = createExtensions(dataDir, cipher)

const offices = new Map<string, { office: Office; pool: McpPool }>()
let win: BrowserWindow | null = null

const overlay = () => ({ color: '#00000000', symbolColor: nativeTheme.shouldUseDarkColors ? '#a1a4ab' : '#3f4148', height: 48 })

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

function emit(projectId: string, runId: string, ev: OfficeEvent) {
  store.appendEvent(projectId, runId, ev)
  if (ev.type === 'cost' && ev.usage && ev.providerId && ev.model) {
    const agent = store.listProjects().find((p) => p.id === projectId)?.agents.find((a) => a.id === ev.agentId)?.name ?? ev.agentId
    store.appendUsage({ ...ev.usage, at: ev.at, projectId, runId, agentId: ev.agentId, agent, providerId: ev.providerId, model: ev.model, usd: ev.usd })
  }
  if (ev.type === 'run') {
    const run = store.listRuns(projectId).find((r) => r.id === runId)
    if (run) store.saveRun(projectId, { ...run, state: ev.state })
    if (ev.state !== 'running') offices.get(projectId)?.pool.closeAll()
  }
  win?.webContents.send('office:event', projectId, runId, ev)
}

// Contract stub: replaced when the feature lands.
const todo = (): never => {
  throw new Error('E_NOT_IMPLEMENTED')
}

const handlers: Api = {
  appInfo: () => ({ version: app.getVersion(), platform: process.platform }),
  presets: () => PRESETS,
  getSettings: (): AppSettings => DEFAULT_SETTINGS,
  saveSettings: () => todo(),
  checkUpdate: async () => todo(),
  listProviders: () => store.listProviders(),
  saveProvider: (p: Omit<Provider, 'hasKey'>, key: string) => store.saveProvider(p, key),
  deleteProvider: (id: string) => store.deleteProvider(id),
  listModels: (id: string) => listModels(store.conn(id)),
  /** Effective price per model (the provider's own, else built-in). */
  priceInfo: (p: Pick<Provider, 'kind' | 'baseURL' | 'prices'>, models: string[]) =>
    Object.fromEntries(models.map((m) => [m, { price: priceOf(p, m) }])) as Record<string, { price?: Price }>,
  /** Prices from OpenRouter's public catalog for the models it can match unambiguously. */
  catalogPrices: async (p: Pick<Provider, 'kind' | 'baseURL'>, models: string[]) => {
    const list = await fetchCatalog()
    const out: Record<string, Price> = {}
    for (const m of models) {
      const price = matchCatalog(list, p, m)
      if (price) out[m] = price
    }
    return out
  },

  /** Usage in [from, to) plus each provider's quota use right now. */
  usageStats: (from: number, to: number, projectId?: string) => {
    const now = Date.now()
    const providers = store.listProviders()
    const windowFrom = Math.min(from, ...providers.map((p) => (p.billing.quota ? windowStart(p.billing.quota.window, now) : now)))
    const records = store.readUsage(windowFrom, Math.max(to, now + 1))
    return {
      stats: stats(records, from, to, projectId),
      quotas: Object.fromEntries(providers.map((p) => [p.id, quotaUse(records, p.id, p.billing, now)])),
      caps: { day: 0, month: 0, dailyCapUsd: 0, monthlyCapUsd: 0 }
    }
  },
  balance: (id: string) => balance(store.conn(id)),

  listProjects: () => store.listProjects(),
  saveProject: (p: Project) => store.saveProject(p),
  deleteProject: (id: string) => {
    offices.get(id)?.office.stop()
    offices.delete(id)
    store.deleteProject(id)
  },
  exportProject: async () => todo(),
  importProject: async () => todo(),
  pickFolder: async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  },
  openWorkspace: async (projectId: string) => {
    await shell.openPath(project(projectId).workspaceDir)
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
    const c = await McpClient.connect(cfg)
    try {
      return (await c.listTools()).map((t) => t.name)
    } finally {
      c.close()
    }
  },

  listRuns: (projectId: string) => store.listRuns(projectId),
  readRun: (projectId: string, runId: string) => store.readRun(projectId, runId),
  deleteRun: () => todo(),
  exportRun: async () => todo(),
  activeRun: (projectId: string) => offices.get(projectId)?.office.runId ?? null,

  async start(projectId: string, goal: string) {
    offices.get(projectId)?.office.stop('new_task')
    const p = project(projectId)
    if (!p.workspaceDir || !fs.statSync(p.workspaceDir, { throwIfNoEntry: false })?.isDirectory()) throw new Error('E_NO_WORKSPACE')
    let runId = ''
    const pool = new McpPool((id) => ext.mcpConfig(id))
    const office = new Office(p, {
      conn: (id) => store.conn(id),
      charge: (id, model, usage) => {
        const prov = store.provider(id)
        return prov ? charge(prov, model, usage) : null
      },
      readNotes: (agentId) => store.readNotes(projectId, agentId),
      appendNote: (agentId, note) => store.appendNote(projectId, agentId, note),
      emit: (ev) => emit(projectId, runId, ev),
      skills: () => ext.enabledSkills(),
      mcp: (ids) => pool.toolbox(ids)
    })
    runId = office.runId
    offices.set(projectId, { office, pool })
    store.saveRun(projectId, { id: runId, goal, startedAt: Date.now(), state: 'running' })
    office.start(goal)
    // OpenRouter reports the billed cost itself; elsewhere pay-per-token needs a price.
    const unpriced = p.agents.filter((a) => {
      const prov = store.provider(a.providerId)
      return prov?.billing.mode === 'payg' && !/openrouter\.ai/.test(prov.baseURL) && !priceOf(prov, a.model)
    })
    if (unpriced.length) {
      const text = `E_UNPRICED|${unpriced.map((a) => `${a.name} (${a.model})`).join(', ')}`
      emit(projectId, runId, { type: 'message', id: randomUUID(), at: Date.now(), from: SYSTEM, to: [], text })
    }
    return runId
  },
  post: (projectId: string, text: string, to?: string) => {
    const o = offices.get(projectId)
    if (!o) throw new Error('E_NO_RUN')
    o.office.post(text, to)
  },
  stop: (projectId: string) => offices.get(projectId)?.office.stop(),
  retryAgent: (projectId: string, agentId: string, model?: ModelRef) => offices.get(projectId)?.office.retry(agentId, model),
  answer: (projectId: string, approvalId: string, ok: boolean) => offices.get(projectId)?.office.answer(approvalId, ok),
  answerPlan: () => todo(),
  runChanges: async () => todo(),
  fileDiff: async () => todo(),
  revertRun: async () => todo(),
  commitWorkspace: async () => todo()
}

for (const [name, fn] of Object.entries(handlers)) {
  ipcMain.handle(name, (_e, ...args: unknown[]) => (fn as (...a: unknown[]) => unknown)(...args))
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => {
  for (const o of offices.values()) o.pool.closeAll()
  app.quit()
})
