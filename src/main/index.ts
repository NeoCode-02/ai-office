import { app, BrowserWindow, dialog, ipcMain, nativeTheme, safeStorage, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { McpServer, OfficeEvent, Price, Project, Provider } from '../shared/types'
import { charge, fetchCatalog, matchCatalog, priceOf } from './billing'
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
  if (ev.type === 'run') {
    const run = store.listRuns(projectId).find((r) => r.id === runId)
    if (run) store.saveRun(projectId, { ...run, state: ev.state })
    if (ev.state !== 'running') offices.get(projectId)?.pool.closeAll()
  }
  win?.webContents.send('office:event', projectId, runId, ev)
}

const handlers = {
  appInfo: () => ({ version: app.getVersion(), platform: process.platform }),
  presets: () => PRESETS,
  listProviders: () => store.listProviders(),
  saveProvider: (p: Omit<Provider, 'hasKey'>, key: string) => store.saveProvider(p, key),
  deleteProvider: (id: string) => store.deleteProvider(id),
  listModels: (id: string) => listModels(store.conn(id)),
  /** Effective price per model and where it comes from. */
  priceInfo: (id: string, models: string[]) => {
    const p = store.provider(id)
    return Object.fromEntries(
      models.map((m) => [m, { price: p && priceOf(p, m), source: !p ? 'none' : p.prices[m] ? 'own' : priceOf(p, m) ? 'builtin' : 'none' }])
    ) as Record<string, { price?: Price; source: 'own' | 'builtin' | 'none' }>
  },
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

  listProjects: () => store.listProjects(),
  saveProject: (p: Project) => store.saveProject(p),
  deleteProject: (id: string) => {
    offices.get(id)?.office.stop()
    offices.delete(id)
    store.deleteProject(id)
  },
  pickFolder: async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  },
  openFolder: (dir: string) => shell.openPath(dir),

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
  activeRun: (projectId: string) => offices.get(projectId)?.office.runId ?? null,

  start(projectId: string, goal: string) {
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
    return runId
  },
  post: (projectId: string, text: string, to?: string) => {
    const o = offices.get(projectId)
    if (!o) throw new Error('E_NO_RUN')
    o.office.post(text, to)
  },
  stop: (projectId: string) => offices.get(projectId)?.office.stop(),
  answer: (projectId: string, approvalId: string, ok: boolean) => offices.get(projectId)?.office.answer(approvalId, ok)
}
export type Api = typeof handlers

for (const [name, fn] of Object.entries(handlers)) {
  ipcMain.handle(name, (_e, ...args: unknown[]) => (fn as (...a: unknown[]) => unknown)(...args))
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => {
  for (const o of offices.values()) o.pool.closeAll()
  app.quit()
})
