import fs from 'node:fs'
import path from 'node:path'
import type { McpServer, Plugin, RoleTemplate, Skill } from '../shared/types'
import type { McpConfig } from './mcp'
import type { Cipher } from './store'

const BUILTIN = import.meta.glob('./skills/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

export interface SkillDoc extends Skill {
  body: string
  dir?: string
}

/** `---\nkey: value\n---\nbody` → meta + body. Enough for SKILL.md / agent .md files. */
export function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!m) return { meta: {}, body: text.trim() }
  const meta: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line)
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^(["'])(.*)\1$/, '$2')
  }
  return { meta, body: m[2].trim() }
}

const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'item'
const readJson = <T>(f: string, fallback: T): T => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8')) as T
  } catch {
    return fallback
  }
}
const subdirs = (d: string) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(d, e.name)) : [])

/** `KEY=value` / `Header: value` lines → object. */
export function parsePairs(text: string, sep: '=' | ':'): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(sep)
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
}

interface StoredMcp extends Omit<McpServer, 'hasSecrets' | 'plugin'> {
  secrets: string // encrypted
}
interface State {
  mcp: StoredMcp[]
  disabledSkills: string[]
  plugins: Record<string, boolean>
}

interface PluginMcp {
  type?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}

function readSkillDir(dir: string): { name: string; description: string; body: string } | null {
  const f = path.join(dir, 'SKILL.md')
  if (!fs.existsSync(f)) return null
  const { meta, body } = parseFrontmatter(fs.readFileSync(f, 'utf8'))
  return { name: meta.name || path.basename(dir), description: meta.description || '', body }
}

/** Reads a plugin folder laid out like a Claude Code plugin. */
export function readPlugin(dir: string) {
  const manifest = readJson<{ name?: string; description?: string; version?: string }>(path.join(dir, '.claude-plugin', 'plugin.json'), {})
  const name = slug(manifest.name || path.basename(dir))
  const skills = subdirs(path.join(dir, 'skills')).flatMap((d) => {
    const s = readSkillDir(d)
    return s ? [{ ...s, dir: d }] : []
  })
  const agentsDir = path.join(dir, 'agents')
  const roles: RoleTemplate[] = fs.existsSync(agentsDir)
    ? fs.readdirSync(agentsDir).filter((f) => f.endsWith('.md')).map((f) => {
        const { meta, body } = parseFrontmatter(fs.readFileSync(path.join(agentsDir, f), 'utf8'))
        return { title: meta.name || f.replace(/\.md$/, ''), description: meta.description || '', instructions: body, plugin: name }
      })
    : []
  const raw = readJson<Record<string, unknown>>(path.join(dir, '.mcp.json'), {})
  const servers = (raw.mcpServers ?? raw) as Record<string, PluginMcp>
  const expand = (s: string) => s.replace(/\$\{([A-Z0-9_]+)\}/g, (_, v: string) => (v === 'CLAUDE_PLUGIN_ROOT' ? dir : (process.env[v] ?? '')))
  const mapVals = (o: Record<string, string> = {}) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, expand(String(v))]))
  const mcp: (McpConfig & { id: string })[] = Object.entries(servers)
    .filter(([, s]) => s && typeof s === 'object' && (s.command || s.url))
    .map(([key, s]) => ({
      id: `plugin:${name}:${key}`,
      name: key,
      transport: s.url ? 'http' : 'stdio',
      command: expand(s.command ?? ''),
      args: (s.args ?? []).map((a) => expand(String(a))),
      env: mapVals(s.env),
      url: expand(s.url ?? ''),
      headers: mapVals(s.headers)
    }))
  const ignored = ['commands', 'hooks'].filter((d) => fs.existsSync(path.join(dir, d)) || fs.existsSync(path.join(dir, `${d}.json`)))
  return { name, description: manifest.description ?? '', version: manifest.version ?? '', skills, roles, mcp, ignored }
}

export function createExtensions(dataDir: string, cipher: Cipher) {
  const stateFile = path.join(dataDir, 'extensions.json')
  const skillsDir = path.join(dataDir, 'skills')
  const pluginsDir = path.join(dataDir, 'plugins')
  const state = (): State => ({ mcp: [], disabledSkills: [], plugins: {}, ...readJson<Partial<State>>(stateFile, {}) })
  const save = (s: State) => {
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(stateFile, JSON.stringify(s, null, 2))
  }
  const plugins = () => subdirs(pluginsDir).map(readPlugin)
  const enabledPlugins = () => {
    const on = state().plugins
    return plugins().filter((p) => on[p.name] !== false)
  }

  function allSkills(): SkillDoc[] {
    const disabled = new Set(state().disabledSkills)
    const out: SkillDoc[] = []
    const add = (s: Omit<SkillDoc, 'enabled'>) => {
      const name = out.some((x) => x.name === s.name) && s.plugin ? `${s.plugin}:${s.name}` : s.name
      if (!out.some((x) => x.name === name)) out.push({ ...s, name, enabled: !disabled.has(name) })
    }
    for (const [file, text] of Object.entries(BUILTIN)) {
      const { meta, body } = parseFrontmatter(text)
      add({ name: meta.name || path.basename(file, '.md'), description: meta.description || '', body, source: 'builtin' })
    }
    for (const d of subdirs(skillsDir)) {
      const s = readSkillDir(d)
      if (s) add({ ...s, dir: d, source: 'user' })
    }
    for (const p of enabledPlugins()) for (const s of p.skills) add({ ...s, source: 'plugin', plugin: p.name })
    return out
  }

  const storedMcp = (): (McpConfig & { id: string; enabled: boolean; plugin?: string })[] => {
    const s = state()
    const user = s.mcp.map((m) => {
      let secrets = ''
      try {
        secrets = m.secrets ? cipher.decrypt(m.secrets) : ''
      } catch {
        // Unreadable after an OS keychain reset: behave as if no secrets were saved.
      }
      return {
        ...m,
        env: m.transport === 'stdio' ? parsePairs(secrets, '=') : {},
        headers: m.transport === 'http' ? parsePairs(secrets, ':') : {}
      }
    })
    const fromPlugins = enabledPlugins().flatMap((p) => p.mcp.map((m) => ({ ...m, enabled: s.plugins[`mcp:${m.id}`] !== false, plugin: p.name })))
    return [...user, ...fromPlugins]
  }

  return {
    listSkills: (): Skill[] => allSkills().map(({ name, description, source, plugin, enabled }) => ({ name, description, source, plugin, enabled })),
    enabledSkills: () => allSkills().filter((s) => s.enabled),

    setSkillEnabled(name: string, on: boolean) {
      const s = state()
      s.disabledSkills = on ? s.disabledSkills.filter((n) => n !== name) : [...new Set([...s.disabledSkills, name])]
      save(s)
    },

    createSkill(name: string, description: string, body: string) {
      const dir = path.join(skillsDir, slug(name))
      fs.mkdirSync(dir, { recursive: true })
      const safe = (v: string) => v.replace(/\r?\n/g, ' ').trim()
      fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${safe(name)}\ndescription: ${safe(description)}\n---\n\n${body.trim()}\n`)
    },

    importSkill(src: string) {
      const s = readSkillDir(src)
      if (!s) throw new Error('E_NO_SKILL_MD')
      fs.cpSync(src, path.join(skillsDir, slug(s.name)), { recursive: true })
      return s.name
    },

    deleteSkill(name: string) {
      const s = allSkills().find((x) => x.name === name && x.source === 'user')
      if (s?.dir) fs.rmSync(s.dir, { recursive: true, force: true })
    },

    listPlugins: (): Plugin[] => {
      const on = state().plugins
      return plugins().map((p) => ({
        name: p.name,
        description: p.description,
        version: p.version,
        enabled: on[p.name] !== false,
        skills: p.skills.map((s) => s.name),
        mcpServers: p.mcp.map((m) => m.name),
        roles: p.roles.map((r) => r.title),
        ignored: p.ignored
      }))
    },

    importPlugin(src: string) {
      const p = readPlugin(src)
      if (!p.skills.length && !p.roles.length && !p.mcp.length) throw new Error('E_PLUGIN_EMPTY')
      const dest = path.join(pluginsDir, p.name)
      fs.rmSync(dest, { recursive: true, force: true })
      fs.cpSync(src, dest, { recursive: true })
      return p.name
    },

    setPluginEnabled(name: string, on: boolean) {
      const s = state()
      s.plugins[name] = on
      save(s)
    },

    deletePlugin(name: string) {
      fs.rmSync(path.join(pluginsDir, slug(name)), { recursive: true, force: true })
    },

    pluginRoles: (): RoleTemplate[] => enabledPlugins().flatMap((p) => p.roles),

    listMcp: (): McpServer[] =>
      storedMcp().map((m) => ({
        id: m.id,
        name: m.name,
        transport: m.transport,
        command: m.command,
        args: m.args,
        url: m.url,
        enabled: m.enabled,
        hasSecrets: Object.keys(m.transport === 'stdio' ? m.env : m.headers).length > 0,
        plugin: m.plugin
      })),

    /** Empty `secrets` keeps the stored ones. */
    saveMcp(m: Omit<McpServer, 'hasSecrets' | 'plugin'>, secrets: string) {
      const s = state()
      if (m.id.startsWith('plugin:')) {
        s.plugins[`mcp:${m.id}`] = m.enabled
        return save(s)
      }
      const old = s.mcp.find((x) => x.id === m.id)
      const next: StoredMcp = { ...m, secrets: secrets.trim() ? cipher.encrypt(secrets) : (old?.secrets ?? '') }
      s.mcp = old ? s.mcp.map((x) => (x.id === m.id ? next : x)) : [...s.mcp, next]
      save(s)
    },

    deleteMcp(id: string) {
      const s = state()
      s.mcp = s.mcp.filter((x) => x.id !== id)
      save(s)
    },

    mcpConfig(id: string): McpConfig | null {
      const m = storedMcp().find((x) => x.id === id && x.enabled)
      return m ?? null
    }
  }
}

export type Extensions = ReturnType<typeof createExtensions>
