import { contextBridge, ipcRenderer } from 'electron'
import type { Api } from '../main/index'
import type { OfficeEvent } from '../shared/types'

type Async<T> = { [K in keyof T]: T[K] extends (...a: infer A) => infer R ? (...a: A) => Promise<Awaited<R>> : never }

// Record (not an array) so TypeScript fails when a handler is missing here.
const names: Record<keyof Api, true> = {
  appInfo: true, presets: true, listProviders: true, saveProvider: true, deleteProvider: true, listModels: true, priceInfo: true, catalogPrices: true, usageStats: true, balance: true,
  listProjects: true, saveProject: true, deleteProject: true, pickFolder: true, openFolder: true,
  listSkills: true, setSkillEnabled: true, createSkill: true, importSkill: true, deleteSkill: true,
  listPlugins: true, importPlugin: true, setPluginEnabled: true, deletePlugin: true, pluginRoles: true,
  listMcp: true, saveMcp: true, deleteMcp: true, testMcp: true,
  listRuns: true, readRun: true, activeRun: true, start: true, post: true, stop: true, answer: true
}

const api = Object.fromEntries(Object.keys(names).map((n) => [n, (...a: unknown[]) => ipcRenderer.invoke(n, ...a)])) as Async<Api>

const bridge = {
  ...api,
  onEvent(cb: (projectId: string, runId: string, ev: OfficeEvent) => void) {
    const fn = (_e: unknown, p: string, r: string, ev: OfficeEvent) => cb(p, r, ev)
    ipcRenderer.on('office:event', fn)
    return () => {
      ipcRenderer.removeListener('office:event', fn)
    }
  }
}
export type Bridge = typeof bridge

contextBridge.exposeInMainWorld('office', bridge)
