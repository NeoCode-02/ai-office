import { contextBridge, ipcRenderer } from 'electron'
import type { Api } from '../main/index'
import type { OfficeEvent } from '../shared/types'

type Async<T> = { [K in keyof T]: T[K] extends (...a: infer A) => infer R ? (...a: A) => Promise<Awaited<R>> : never }

const names: (keyof Api)[] = [
  'presets', 'listProviders', 'saveProvider', 'deleteProvider', 'listModels',
  'listProjects', 'saveProject', 'deleteProject', 'pickFolder', 'openFolder',
  'listRuns', 'readRun', 'activeRun', 'start', 'post', 'stop', 'answer'
]

const api = Object.fromEntries(names.map((n) => [n, (...a: unknown[]) => ipcRenderer.invoke(n, ...a)])) as Async<Api>

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
