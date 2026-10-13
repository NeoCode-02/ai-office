import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_SETTINGS, type AppSettings, type OfficeEvent, type Project, type Provider, type RunSummary, type UsageRecord } from '../shared/types'
import type { Conn } from './providers'
import { bool, num, obj } from './validate'

interface StoredProvider extends Omit<Provider, 'hasKey'> {
  key: string // encrypted
}
/** Before v0.3 prices lived on each agent. */
type LegacyAgent = Project['agents'][number] & { priceIn?: number; priceOut?: number }
export interface Cipher {
  encrypt(s: string): string
  decrypt(s: string): string
}

/** Whether a file is empty or ends with a newline. */
function endsLine(f: string): boolean {
  const fd = fs.openSync(f, 'r')
  try {
    const size = fs.fstatSync(fd).size
    if (size === 0) return true
    const last = Buffer.alloc(1)
    fs.readSync(fd, last, 0, 1, size - 1)
    return last[0] === 0x0a
  } finally {
    fs.closeSync(fd)
  }
}

/** Known fields of `v` that have the right type, over `base`. */
function settingsFrom(v: unknown, base: AppSettings): AppSettings {
  const s = { ...base }
  if (!obj(v)) return s
  if (v.theme === 'system' || v.theme === 'light' || v.theme === 'dark') s.theme = v.theme
  if (num(v.dailyCapUsd, 0)) s.dailyCapUsd = v.dailyCapUsd
  if (num(v.monthlyCapUsd, 0)) s.monthlyCapUsd = v.monthlyCapUsd
  if (bool(v.notifications)) s.notifications = v.notifications
  if (bool(v.checkUpdates)) s.checkUpdates = v.checkUpdates
  return s
}

/** Plain JSON/JSONL files: small data, no native modules, easy to back up. */
export function createStore(dir: string, cipher: Cipher) {
  fs.mkdirSync(dir, { recursive: true })
  const file = (...p: string[]) => path.join(dir, ...p)
  const read = <T>(f: string, fallback: T): T => {
    try {
      return JSON.parse(fs.readFileSync(f, 'utf8')) as T
    } catch {
      return fallback
    }
  }
  const write = (f: string, data: unknown) => {
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f + '.tmp', JSON.stringify(data, null, 2))
    fs.renameSync(f + '.tmp', f)
  }
  const providers = () =>
    read<StoredProvider[]>(file('providers.json'), []).map((p) => ({ ...p, billing: p.billing ?? { mode: 'payg' as const }, prices: p.prices ?? {} }))
  const readable = (enc: string) => {
    try {
      cipher.decrypt(enc)
      return true
    } catch {
      return false
    }
  }
  const projectDir = (id: string) => {
    // basename alone lets '', '.' and '..' through, which would point at the data folder itself.
    const name = path.basename(String(id))
    if (!name || name === '.' || name === '..') throw new Error('E_BAD_ARGS')
    return file('projects', name)
  }
  const hasProject = (id: string) => {
    try {
      return fs.existsSync(path.join(projectDir(id), 'project.json'))
    } catch {
      return false
    }
  }
  const runsFile = (projectId: string) => path.join(projectDir(projectId), 'runs.json')
  const runFile = (projectId: string, runId: string) => path.join(projectDir(projectId), 'runs', path.basename(runId) + '.jsonl')
  const listRuns = (projectId: string) => read<RunSummary[]>(runsFile(projectId), [])
  /** A request can finish after its office was deleted; never recreate the folder for it. */
  const appendEvent = (projectId: string, runId: string, ev: OfficeEvent) => {
    if (!hasProject(projectId)) return
    const f = runFile(projectId, runId)
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.appendFileSync(f, JSON.stringify(ev) + '\n')
  }
  const projects = (): Project[] => {
    if (!fs.existsSync(file('projects'))) return []
    return fs
      .readdirSync(file('projects'))
      .map((id) => read<Project | null>(path.join(projectDir(id), 'project.json'), null))
      .filter((p): p is Project => p !== null)
  }

  return {
    /** Moves pre-v0.3 per-agent prices onto the provider (first price seen per model wins). */
    migrate() {
      const all = providers()
      let changed = false
      for (const p of projects()) {
        const agents = p.agents as LegacyAgent[]
        if (!agents.some((a) => 'priceIn' in a || 'priceOut' in a)) continue
        for (const a of agents) {
          const prov = all.find((x) => x.id === a.providerId)
          if (prov && a.model && !prov.prices[a.model] && ((a.priceIn ?? 0) > 0 || (a.priceOut ?? 0) > 0)) {
            prov.prices[a.model] = { in: a.priceIn ?? 0, out: a.priceOut ?? 0 }
            changed = true
          }
          delete a.priceIn
          delete a.priceOut
        }
        write(path.join(projectDir(p.id), 'project.json'), p)
      }
      if (changed) write(file('providers.json'), all)
    },

    /** A key that can't be decrypted (e.g. OS keychain reset) counts as missing. */
    listProviders: (): Provider[] => providers().map(({ key, ...p }) => ({ ...p, hasKey: Boolean(key) && readable(key) })),

    /** Empty `key` keeps the stored one. */
    saveProvider(p: Omit<Provider, 'hasKey'>, key: string) {
      const all = providers()
      const old = all.find((x) => x.id === p.id)
      const next = { ...p, key: key ? cipher.encrypt(key) : (old?.key ?? '') }
      write(file('providers.json'), old ? all.map((x) => (x.id === p.id ? next : x)) : [...all, next])
    },

    deleteProvider: (id: string) =>
      write(file('providers.json'), providers().filter((x) => x.id !== id)),

    provider: (id: string): Omit<Provider, 'hasKey'> | undefined => providers().map(({ key, ...p }) => p).find((p) => p.id === id),

    conn(id: string): Conn {
      const p = providers().find((x) => x.id === id)
      if (!p) throw new Error('E_NO_PROVIDER')
      if (p.key && !readable(p.key)) throw new Error(`E_KEY_UNREADABLE|${p.name}`)
      return { kind: p.kind, baseURL: p.baseURL, apiKey: p.key ? cipher.decrypt(p.key) : '' }
    },

    listProjects: projects,

    saveProject: (p: Project) => write(path.join(projectDir(p.id), 'project.json'), p),

    deleteProject: (id: string) => fs.rmSync(projectDir(id), { recursive: true, force: true }),

    hasProject,

    getSettings: (): AppSettings => settingsFrom(read<unknown>(file('settings.json'), null), DEFAULT_SETTINGS),

    /** Fields with a wrong type keep their saved value. Returns what was saved. */
    saveSettings(s: AppSettings): AppSettings {
      const next = settingsFrom(s, settingsFrom(read<unknown>(file('settings.json'), null), DEFAULT_SETTINGS))
      write(file('settings.json'), next)
      return next
    },

    listRuns,

    saveRun(projectId: string, run: RunSummary) {
      if (!hasProject(projectId)) return
      const runs = listRuns(projectId).filter((r) => r.id !== run.id)
      write(runsFile(projectId), [run, ...runs])
    },

    deleteRun(projectId: string, runId: string) {
      if (!hasProject(projectId)) return
      const runs = listRuns(projectId)
      if (runs.some((r) => r.id === runId)) write(runsFile(projectId), runs.filter((r) => r.id !== runId))
      fs.rmSync(runFile(projectId, runId), { force: true })
    },

    /** At startup: runs still marked running were cut off when the app closed or crashed. Returns how many. */
    reconcileRuns(): number {
      let count = 0
      for (const p of projects()) {
        try {
          const runs = listRuns(p.id)
          if (!Array.isArray(runs) || !runs.some((r) => r?.state === 'running')) continue
          const next = runs.map((r) => {
            if (r?.state !== 'running') return r
            const f = runFile(p.id, r.id)
            // A crash can leave half a line behind; the event goes on a line of its own.
            if (fs.existsSync(f) && !endsLine(f)) fs.appendFileSync(f, '\n')
            appendEvent(p.id, r.id, { type: 'run', runId: r.id, state: 'stopped', reason: 'app_closed', at: Date.now() })
            count++
            return { ...r, state: 'stopped' as const }
          })
          write(runsFile(p.id), next)
        } catch {
          // A damaged office must not stop the app from starting.
        }
      }
      return count
    },

    appendEvent,

    readRun(projectId: string, runId: string): OfficeEvent[] {
      const f = runFile(projectId, runId)
      if (!fs.existsSync(f)) return []
      const out: OfficeEvent[] = []
      for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
        if (!line) continue
        try {
          out.push(JSON.parse(line) as OfficeEvent)
        } catch {
          // a line cut off by a crash; skip it
        }
      }
      return out
    },

    /** One JSONL file per month keeps reads proportional to the range asked for. */
    appendUsage(r: UsageRecord) {
      const d = new Date(r.at)
      const f = file('usage', `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}.jsonl`)
      fs.mkdirSync(path.dirname(f), { recursive: true })
      fs.appendFileSync(f, JSON.stringify(r) + '\n')
    },

    readUsage(from: number, to: number): UsageRecord[] {
      const out: UsageRecord[] = []
      const end = new Date(to)
      for (let d = new Date(new Date(from).getFullYear(), new Date(from).getMonth(), 1); d <= end; d.setMonth(d.getMonth() + 1)) {
        const f = file('usage', `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}.jsonl`)
        if (!fs.existsSync(f)) continue
        for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
          if (!line) continue
          try {
            const r = JSON.parse(line) as UsageRecord
            if (r.at >= from && r.at < to) out.push(r)
          } catch {
            // a line cut off by a crash; skip it
          }
        }
      }
      return out
    },

    readNotes(projectId: string, agentId: string): string {
      const f = path.join(projectDir(projectId), 'notes', path.basename(agentId) + '.md')
      return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''
    },

    appendNote(projectId: string, agentId: string, note: string) {
      if (!hasProject(projectId)) return
      const f = path.join(projectDir(projectId), 'notes', path.basename(agentId) + '.md')
      fs.mkdirSync(path.dirname(f), { recursive: true })
      fs.appendFileSync(f, `- ${note.replace(/\s+/g, ' ').trim()}\n`)
    }
  }
}

export type Store = ReturnType<typeof createStore>
