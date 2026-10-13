import fs from 'node:fs'
import path from 'node:path'
import type { OfficeEvent, Project, Provider, RunSummary, UsageRecord } from '../shared/types'
import type { Conn } from './providers'

interface StoredProvider extends Omit<Provider, 'hasKey'> {
  key: string // encrypted
}
/** Before v0.3 prices lived on each agent. */
type LegacyAgent = Project['agents'][number] & { priceIn?: number; priceOut?: number }
export interface Cipher {
  encrypt(s: string): string
  decrypt(s: string): string
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
  const projectDir = (id: string) => file('projects', path.basename(id))
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

    listRuns: (projectId: string) => read<RunSummary[]>(path.join(projectDir(projectId), 'runs.json'), []),

    saveRun(projectId: string, run: RunSummary) {
      const f = path.join(projectDir(projectId), 'runs.json')
      const runs = read<RunSummary[]>(f, []).filter((r) => r.id !== run.id)
      write(f, [run, ...runs])
    },

    appendEvent(projectId: string, runId: string, ev: OfficeEvent) {
      const f = path.join(projectDir(projectId), 'runs', path.basename(runId) + '.jsonl')
      fs.mkdirSync(path.dirname(f), { recursive: true })
      fs.appendFileSync(f, JSON.stringify(ev) + '\n')
    },

    readRun(projectId: string, runId: string): OfficeEvent[] {
      const f = path.join(projectDir(projectId), 'runs', path.basename(runId) + '.jsonl')
      if (!fs.existsSync(f)) return []
      return fs
        .readFileSync(f, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as OfficeEvent)
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
      const f = path.join(projectDir(projectId), 'notes', path.basename(agentId) + '.md')
      fs.mkdirSync(path.dirname(f), { recursive: true })
      fs.appendFileSync(f, `- ${note.replace(/\s+/g, ' ').trim()}\n`)
    }
  }
}

export type Store = ReturnType<typeof createStore>
