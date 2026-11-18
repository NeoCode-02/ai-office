import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { CHANNELS, type Api } from '../shared/api'
import type { OfficeEvent, UpdateInfo } from '../shared/types'

type Async<T> = { [K in keyof T]: T[K] extends (...a: infer A) => infer R ? (...a: A) => Promise<Awaited<R>> : never }

// Record (not an array) so TypeScript fails when a handler is missing here.
const names: Record<keyof Api, true> = {
  appInfo: true, presets: true, getSettings: true, saveSettings: true, checkUpdate: true,
  listProviders: true, saveProvider: true, deleteProvider: true, listModels: true, priceInfo: true, catalogPrices: true, usageStats: true, balance: true,
  listProjects: true, saveProject: true, deleteProject: true, exportProject: true, importProject: true, pickFolder: true, openWorkspace: true, attach: true,
  listSkills: true, setSkillEnabled: true, createSkill: true, importSkill: true, deleteSkill: true,
  listPlugins: true, importPlugin: true, setPluginEnabled: true, deletePlugin: true, pluginRoles: true,
  listMcp: true, saveMcp: true, deleteMcp: true, testMcp: true,
  listRuns: true, readRun: true, deleteRun: true, exportRun: true, activeRun: true, start: true, post: true, stop: true, retryAgent: true, answer: true, answerPlan: true,
  runChanges: true, fileDiff: true, revertRun: true, commitWorkspace: true
}

const api = Object.fromEntries(Object.keys(names).map((n) => [n, (...a: unknown[]) => ipcRenderer.invoke(n, ...a)])) as Async<Api>

function listen<A extends unknown[]>(channel: string, cb: (...a: A) => void) {
  const fn = (_e: unknown, ...a: unknown[]) => cb(...(a as A))
  ipcRenderer.on(channel, fn)
  return () => {
    ipcRenderer.removeListener(channel, fn)
  }
}

const bridge = {
  ...api,
  onEvent: (cb: (projectId: string, runId: string, ev: OfficeEvent) => void) => listen(CHANNELS.event, cb),
  onDelta: (cb: (projectId: string, agentId: string, text: string | null) => void) => listen(CHANNELS.delta, cb),
  onOpenProject: (cb: (projectId: string) => void) => listen(CHANNELS.openProject, cb),
  onUpdate: (cb: (info: UpdateInfo) => void) => listen(CHANNELS.update, cb),
  /** Where a file dropped on the window lives on disk ('' for one that isn't a file on disk). */
  pathOf: (file: File) => webUtils.getPathForFile(file)
}
export type Bridge = typeof bridge

contextBridge.exposeInMainWorld('office', bridge)
