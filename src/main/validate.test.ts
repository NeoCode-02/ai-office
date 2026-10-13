import { describe, expect, it } from 'vitest'
import { DEFAULT_LIMITS, DEFAULT_SANDBOX, DEFAULT_SETTINGS, type Agent, type Project } from '../shared/types'
import { bool, isAgent, isId, isMcp, isModelRef, isProject, isProvider, isSandbox, isSettings, num, obj, optStr, str, strArr } from './validate'

const agent = (x: Partial<Agent> = {}): Agent => ({
  id: 'a1b2c3d4', name: 'Ann', title: 'CEO', department: 'Leadership', reportsTo: null, instructions: 'Lead.',
  providerId: 'p1', model: 'claude-opus-5', tools: ['list_files', 'read_file'], ...x
})
const project = (x: Partial<Project> = {}): Project => ({
  id: 'f00dcafe', name: 'Office', workspaceDir: '/tmp/ws', briefing: '', approval: 'ask', budgetUsd: 5,
  agents: [agent(), agent({ id: 'b2', name: 'Bob', reportsTo: 'a1b2c3d4', backup: { providerId: 'p2', model: 'm' } })],
  ...x
})
/** What a hostile JSON file or renderer can send: an own "__proto__" key. */
const polluted = (base: object) => JSON.parse(JSON.stringify(base).replace(/^\{/, '{"__proto__":{"admin":true},'))

describe('primitives', () => {
  it('str / optStr bound the length and the type', () => {
    expect(str('abc')).toBe(true)
    expect(str('')).toBe(true)
    expect(str('x'.repeat(100_001))).toBe(false)
    expect(str('abcd', 3)).toBe(false)
    expect(str(1)).toBe(false)
    expect(str(null)).toBe(false)
    expect(optStr(undefined)).toBe(true)
    expect(optStr(null)).toBe(false)
    expect(optStr('x'.repeat(11), 10)).toBe(false)
  })
  it('num rejects NaN, Infinity and non-numbers, and checks the range', () => {
    expect(num(0)).toBe(true)
    expect(num(-3.5)).toBe(true)
    expect(num(NaN)).toBe(false)
    expect(num(Infinity)).toBe(false)
    expect(num(-Infinity)).toBe(false)
    expect(num('1')).toBe(false)
    expect(num(-1, 0)).toBe(false)
    expect(num(11, 0, 10)).toBe(false)
  })
  it('bool is strict', () => {
    expect(bool(false)).toBe(true)
    expect(bool(0)).toBe(false)
    expect(bool('true')).toBe(false)
  })
  it('ids are safe file names', () => {
    expect(isId('a1b2c3d4')).toBe(true)
    expect(isId('0d6f-4e1a_x')).toBe(true)
    for (const bad of ['', '.', '..', '../x', 'a/b', 'a\\b', 'a b', 'x'.repeat(65), 'a\0', 7]) expect(isId(bad)).toBe(false)
  })
  it('obj accepts plain objects only, without polluting keys', () => {
    expect(obj({ a: 1 })).toBe(true)
    expect(obj(Object.create(null))).toBe(true)
    expect(obj([])).toBe(false)
    expect(obj(null)).toBe(false)
    expect(obj(new Date())).toBe(false)
    expect(obj(polluted({ a: 1 }))).toBe(false)
    expect(obj(JSON.parse('{"constructor":{"prototype":{}}}'))).toBe(false)
    expect(obj(JSON.parse('{"prototype":1}'))).toBe(false)
  })
  it('strArr checks every item, including holes of a sparse array', () => {
    expect(strArr(['a', 'b'])).toBe(true)
    expect(strArr(['a', 1])).toBe(false)
    // eslint-disable-next-line no-sparse-arrays
    expect(strArr(['a', , 'b'])).toBe(false)
    expect(strArr(['a'], 0)).toBe(false)
    expect(strArr(['abc'], 5, 2)).toBe(false)
    expect(strArr('a')).toBe(false)
  })
})

describe('isProject', () => {
  it('accepts a valid office, with or without the v0.3 fields', () => {
    expect(isProject(project())).toBe(true)
    const full = project({ limits: DEFAULT_LIMITS, planFirst: true, allowCommands: ['npm test', 'mcp:github › list', 'fetch:localhost'], sandbox: DEFAULT_SANDBOX, checkpoints: false })
    full.agents[0] = agent({ effort: 'xhigh', maxTokens: 64000, skills: ['testing'], mcpServers: ['plugin:acme:echo'] })
    expect(isProject(full)).toBe(true)
    expect(isProject({ ...project(), extra: 'kept' })).toBe(true)
  })

  it('rejects wrong types and out-of-range values in every field', () => {
    const bad: unknown[] = [
      null, 'x', [], project({ id: '../../x' }), project({ id: '' }), { ...project(), name: 5 }, { ...project(), workspaceDir: null },
      { ...project(), briefing: 'x'.repeat(100_001) }, { ...project(), approval: 'always' }, project({ budgetUsd: -1 }),
      project({ budgetUsd: NaN }), project({ budgetUsd: Infinity }), { ...project(), budgetUsd: '5' }, { ...project(), agents: {} },
      project({ limits: { maxRequests: -1, maxChatter: 8, compactAt: 0 } }), project({ limits: { maxRequests: 10, maxChatter: NaN, compactAt: 0 } }),
      { ...project(), limits: { maxRequests: 10, maxChatter: 8 } }, { ...project(), planFirst: 'yes' }, { ...project(), allowCommands: 'npm test' },
      { ...project(), allowCommands: [1] }, { ...project(), checkpoints: 1 }, project({ sandbox: { kind: 'vm' as 'docker', image: 'x', network: true } })
    ]
    for (const p of bad) expect(isProject(p), JSON.stringify(p)?.slice(0, 120)).toBe(false)
  })

  it('checks every member', () => {
    const withAgent = (a: unknown) => ({ ...project(), agents: [a] })
    expect(isProject(withAgent(agent()))).toBe(true)
    const bad: unknown[] = [
      { ...agent(), id: 'a/b' }, { ...agent(), id: undefined }, { ...agent(), name: null }, { ...agent(), name: 'x'.repeat(201) },
      { ...agent(), reportsTo: undefined }, { ...agent(), reportsTo: '../up' }, { ...agent(), title: 1 }, { ...agent(), instructions: [] },
      agent({ tools: ['read_file', 'rm_rf' as 'read_file'] }), { ...agent(), tools: 'read_file' }, agent({ effort: 'extreme' as 'max' }),
      agent({ maxTokens: 0 }), agent({ maxTokens: -5 }), agent({ maxTokens: 1.5 }), agent({ maxTokens: NaN }), { ...agent(), maxTokens: '100' },
      { ...agent(), skills: [null] }, { ...agent(), mcpServers: 'all' }, { ...agent(), backup: { providerId: 'p' } }, { ...agent(), backup: null }
    ]
    for (const a of bad) expect(isAgent(a), JSON.stringify(a)?.slice(0, 160)).toBe(false)
    for (const a of bad) expect(isProject(withAgent(a))).toBe(false)
  })

  it('rejects duplicate member ids', () => {
    expect(isProject(project({ agents: [agent(), agent({ name: 'Twin' })] }))).toBe(false)
  })

  it('rejects prototype-pollution keys at any level it reads', () => {
    expect(isProject(polluted(project()))).toBe(false)
    const p = project()
    expect(isProject({ ...p, agents: [polluted(agent())] })).toBe(false)
    expect(isProject({ ...p, limits: polluted(DEFAULT_LIMITS) })).toBe(false)
    expect(isProject({ ...p, agents: [{ ...agent(), backup: polluted({ providerId: 'p', model: 'm' }) }] })).toBe(false)
    expect(({} as Record<string, unknown>).admin).toBeUndefined()
  })

  it('rejects huge strings and arrays', () => {
    expect(isProject(project({ agents: Array.from({ length: 201 }, (_, i) => agent({ id: `a${i}` })) }))).toBe(false)
    expect(isProject(project({ agents: [agent({ instructions: 'x'.repeat(200_000) })] }))).toBe(false)
    expect(isProject(project({ allowCommands: Array.from({ length: 1001 }, () => 'ls') }))).toBe(false)
    expect(isProject(project({ workspaceDir: 'x'.repeat(5000) }))).toBe(false)
  })
})

describe('sandbox', () => {
  it('needs an image for Docker that cannot pass for a docker option', () => {
    expect(isSandbox(DEFAULT_SANDBOX)).toBe(true)
    expect(isSandbox({ kind: 'docker', image: 'ghcr.io/acme/build:1.2@sha256:abc', network: false })).toBe(true)
    expect(isSandbox({ kind: 'none', image: '', network: true })).toBe(true)
    expect(isSandbox({ kind: 'docker', image: '', network: true })).toBe(false)
    expect(isSandbox({ kind: 'docker', image: '--privileged', network: true })).toBe(false)
    expect(isSandbox({ kind: 'docker', image: 'node:22 -v /:/host', network: true })).toBe(false)
    expect(isSandbox({ kind: 'docker', image: 'node', network: 'no' })).toBe(false)
  })
})

describe('isProvider / isModelRef', () => {
  const provider = { id: 'p1', name: 'DeepSeek', kind: 'openai', baseURL: 'https://api.deepseek.com', billing: { mode: 'payg' }, prices: { 'deepseek-chat': { in: 0.27, out: 1.1, cacheRead: 0.07 } } }
  it('accepts what the providers screen saves', () => {
    expect(isProvider(provider)).toBe(true)
    expect(isProvider({ ...provider, kind: 'anthropic', baseURL: '', hasKey: true })).toBe(true)
    expect(isProvider({ ...provider, billing: { mode: 'subscription', fee: 20, quota: { amount: 120, unit: 'requests', window: '5h' } } })).toBe(true)
    expect(isProvider({ ...provider, prices: { m: { in: 1, out: 2, long: { above: 200_000, in: 2, out: 4 } } } })).toBe(true)
  })
  it('rejects bad kinds, URLs, billing and prices', () => {
    const bad: unknown[] = [
      { ...provider, id: '' }, { ...provider, kind: 'gemini' }, { ...provider, baseURL: 'file:///etc/passwd' }, { ...provider, baseURL: 'javascript:alert(1)' },
      { ...provider, baseURL: 'not a url' }, { ...provider, billing: { mode: 'free', fee: -1 } }, { ...provider, billing: { mode: 'payg', quota: { amount: 1, unit: 'usd', window: 'year' } } },
      { ...provider, prices: { m: { in: -1, out: 1 } } }, { ...provider, prices: { m: { in: NaN, out: 1 } } }, { ...provider, prices: { m: { in: 1 } } },
      { ...provider, prices: JSON.parse('{"__proto__":{"in":1,"out":1}}') }, { ...provider, prices: { '': { in: 1, out: 1 } } }, { ...provider, prices: [] },
      { ...provider, prices: { m: { in: 1, out: 1, long: { above: 'x', in: 1, out: 1 } } } }
    ]
    for (const p of bad) expect(isProvider(p), JSON.stringify(p)?.slice(0, 160)).toBe(false)
  })
  it('model refs are two bounded strings', () => {
    expect(isModelRef({ providerId: 'p', model: 'm' })).toBe(true)
    expect(isModelRef({ providerId: 'p', model: '' })).toBe(true)
    expect(isModelRef({ providerId: 'p' })).toBe(false)
    expect(isModelRef({ providerId: 'p', model: 'x'.repeat(501) })).toBe(false)
    expect(isModelRef(polluted({ providerId: 'p', model: 'm' }))).toBe(false)
  })
})

describe('isMcp / isSettings', () => {
  const mcp = { id: 'm1', name: 'GitHub', transport: 'stdio', command: 'npx', args: ['-y', 'server'], url: '', enabled: true }
  it('MCP servers', () => {
    expect(isMcp(mcp)).toBe(true)
    expect(isMcp({ ...mcp, id: 'plugin:acme:echo', transport: 'http', url: 'https://mcp.example.com/mcp' })).toBe(true)
    expect(isMcp({ ...mcp, transport: 'ws' })).toBe(false)
    expect(isMcp({ ...mcp, args: 'a b' })).toBe(false)
    expect(isMcp({ ...mcp, url: 'file:///x' })).toBe(false)
    expect(isMcp({ ...mcp, enabled: 'yes' })).toBe(false)
    expect(isMcp({ ...mcp, id: '' })).toBe(false)
  })
  it('settings', () => {
    expect(isSettings(DEFAULT_SETTINGS)).toBe(true)
    expect(isSettings({ ...DEFAULT_SETTINGS, theme: 'dark', dailyCapUsd: 2.5, monthlyCapUsd: 40 })).toBe(true)
    for (const bad of [{ ...DEFAULT_SETTINGS, theme: 'blue' }, { ...DEFAULT_SETTINGS, dailyCapUsd: -1 }, { ...DEFAULT_SETTINGS, monthlyCapUsd: Infinity },
      { ...DEFAULT_SETTINGS, notifications: 1 }, { theme: 'system' }, polluted(DEFAULT_SETTINGS), null]) {
      expect(isSettings(bad)).toBe(false)
    }
  })
})
