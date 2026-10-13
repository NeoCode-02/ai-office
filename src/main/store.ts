import fs from 'node:fs'
import path from 'node:path'
import type { OfficeEvent, Project, Provider, RunSummary } from '../shared/types'
import type { Conn } from './providers'

interface StoredProvider extends Omit<Provider, 'hasKey'> {
  key: string // encrypted
}
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
  const providers = () => read<StoredProvider[]>(file('providers.json'), [])
  const projectDir = (id: string) => file('projects', path.basename(id))

  return {
    listProviders: (): Provider[] =>
      providers().map(({ key, ...p }) => ({ ...p, hasKey: Boolean(key) })),

    /** Empty `key` keeps the stored one. */
    saveProvider(p: Omit<Provider, 'hasKey'>, key: string) {
      const all = providers()
      const old = all.find((x) => x.id === p.id)
      const next = { ...p, key: key ? cipher.encrypt(key) : (old?.key ?? '') }
      write(file('providers.json'), old ? all.map((x) => (x.id === p.id ? next : x)) : [...all, next])
    },

    deleteProvider: (id: string) =>
      write(file('providers.json'), providers().filter((x) => x.id !== id)),

    conn(id: string): Conn {
      const p = providers().find((x) => x.id === id)
      if (!p) throw new Error('Provayder topilmadi')
      return { kind: p.kind, baseURL: p.baseURL, apiKey: p.key ? cipher.decrypt(p.key) : '' }
    },

    listProjects: (): Project[] => {
      if (!fs.existsSync(file('projects'))) return []
      return fs
        .readdirSync(file('projects'))
        .map((id) => read<Project | null>(path.join(projectDir(id), 'project.json'), null))
        .filter((p): p is Project => p !== null)
    },

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
