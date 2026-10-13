import { app, BrowserWindow, dialog, ipcMain, nativeTheme, safeStorage, shell } from 'electron'
import path from 'node:path'
import type { OfficeEvent, Project, Provider } from '../shared/types'
import { Office } from './office'
import { listModels, PRESETS } from './providers'
import { createStore } from './store'

const store = createStore(path.join(app.getPath('userData'), 'data'), {
  encrypt: (s) => safeStorage.encryptString(s).toString('base64'),
  decrypt: (s) => safeStorage.decryptString(Buffer.from(s, 'base64'))
})

const offices = new Map<string, Office>()
let win: BrowserWindow | null = null

function createWindow() {
  const dark = nativeTheme.shouldUseDarkColors
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    show: false,
    title: 'AI Office',
    backgroundColor: dark ? '#0d0f14' : '#f6f7f9',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: dark ? '#c9ced8' : '#3b4252', height: 44 },
    webPreferences: { preload: path.join(__dirname, '../preload/index.js'), sandbox: true, contextIsolation: true }
  })
  win.once('ready-to-show', () => win?.show())
  // Links never open inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'))
}

nativeTheme.on('updated', () => {
  win?.setTitleBarOverlay({ color: '#00000000', symbolColor: nativeTheme.shouldUseDarkColors ? '#c9ced8' : '#3b4252', height: 44 })
})

function project(id: string): Project {
  const p = store.listProjects().find((x) => x.id === id)
  if (!p) throw new Error('Loyiha topilmadi')
  return p
}

function emit(projectId: string, runId: string, ev: OfficeEvent) {
  store.appendEvent(projectId, runId, ev)
  if (ev.type === 'run') {
    const run = store.listRuns(projectId).find((r) => r.id === runId)
    if (run) store.saveRun(projectId, { ...run, state: ev.state })
  }
  win?.webContents.send('office:event', projectId, runId, ev)
}

const handlers = {
  presets: () => PRESETS,
  listProviders: () => store.listProviders(),
  saveProvider: (p: Omit<Provider, 'hasKey'>, key: string) => store.saveProvider(p, key),
  deleteProvider: (id: string) => store.deleteProvider(id),
  listModels: (id: string) => listModels(store.conn(id)),

  listProjects: () => store.listProjects(),
  saveProject: (p: Project) => store.saveProject(p),
  deleteProject: (id: string) => {
    offices.get(id)?.stop()
    offices.delete(id)
    store.deleteProject(id)
  },
  pickFolder: async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  },
  openFolder: (dir: string) => shell.openPath(dir),

  listRuns: (projectId: string) => store.listRuns(projectId),
  readRun: (projectId: string, runId: string) => store.readRun(projectId, runId),
  activeRun: (projectId: string) => offices.get(projectId)?.runId ?? null,

  start(projectId: string, goal: string) {
    offices.get(projectId)?.stop('Yangi vazifa boshlandi')
    const p = project(projectId)
    if (!p.workspaceDir) throw new Error('Avval ish papkasini tanlang')
    let runId = ''
    const office = new Office(p, {
      conn: (id) => store.conn(id),
      readNotes: (agentId) => store.readNotes(projectId, agentId),
      appendNote: (agentId, note) => store.appendNote(projectId, agentId, note),
      emit: (ev) => emit(projectId, runId, ev)
    })
    runId = office.runId
    offices.set(projectId, office)
    store.saveRun(projectId, { id: runId, goal, startedAt: Date.now(), state: 'running' })
    office.start(goal)
    return runId
  },
  post: (projectId: string, text: string, to?: string) => {
    const o = offices.get(projectId)
    if (!o) throw new Error('Faol ish yo‘q')
    o.post(text, to)
  },
  stop: (projectId: string) => offices.get(projectId)?.stop(),
  answer: (projectId: string, approvalId: string, ok: boolean) => offices.get(projectId)?.answer(approvalId, ok)
}
export type Api = typeof handlers

for (const [name, fn] of Object.entries(handlers)) {
  ipcMain.handle(name, (_e, ...args: unknown[]) => (fn as (...a: unknown[]) => unknown)(...args))
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => app.quit())
