import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type OfficeEvent, type Project } from '../shared/types'
import { createExtensions } from './extensions'
import { createStore } from './store'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'store-'))
const plain = { encrypt: (s: string) => s, decrypt: (s: string) => s }
const office = (id = 'p1'): Project => ({ id, name: 'Office', workspaceDir: '', briefing: '', approval: 'ask', budgetUsd: 0, agents: [] })
const msg = (text: string): OfficeEvent => ({ type: 'message', id: text, at: 1, from: 'user', to: ['a'], text })

describe('store', () => {
  it('treats a key it can no longer decrypt as missing, with a clear error', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-'))
    createStore(dir, { encrypt: (s) => `enc:${s}`, decrypt: (s) => s.slice(4) }).saveProvider({ id: 'p', name: 'DeepSeek', kind: 'openai', baseURL: 'https://x', billing: { mode: 'payg' }, prices: {} }, 'sk-1')
    const broken = createStore(dir, { encrypt: (s) => s, decrypt: () => { throw new Error('bad ciphertext') } })
    expect(broken.listProviders()[0].hasKey).toBe(false)
    expect(() => broken.conn('p')).toThrow('E_KEY_UNREADABLE|DeepSeek')
  })
})

describe('migration', () => {
  it('moves per-agent prices onto the provider and strips them', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-'))
    const plain = { encrypt: (s: string) => s, decrypt: (s: string) => s }
    fs.writeFileSync(path.join(dir, 'providers.json'), JSON.stringify([{ id: 'p', name: 'X', kind: 'openai', baseURL: 'https://x', key: 'k' }]))
    const agent = (id: string, priceIn: number) => ({ id, name: id, title: '', department: '', reportsTo: null, instructions: '', providerId: 'p', model: 'm1', priceIn, priceOut: priceIn * 2, tools: [] })
    fs.mkdirSync(path.join(dir, 'projects', 'a'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'projects', 'a', 'project.json'), JSON.stringify({ id: 'a', name: 'A', workspaceDir: '', briefing: '', approval: 'ask', budgetUsd: 0, agents: [agent('x', 0), agent('y', 3)] }))
    const store = createStore(dir, plain)
    store.migrate()
    expect(store.listProviders()[0]).toMatchObject({ billing: { mode: 'payg' }, prices: { m1: { in: 3, out: 6 } } })
    expect(store.listProjects()[0].agents.some((a) => 'priceIn' in a)).toBe(false)
  })
})

describe('settings', () => {
  it('starts from the defaults', () => {
    expect(createStore(tmp(), plain).getSettings()).toEqual(DEFAULT_SETTINGS)
  })

  it('merges saved values over the defaults and ignores wrong types', () => {
    const dir = tmp()
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ theme: 'dark', dailyCapUsd: 'lots', monthlyCapUsd: 50, notifications: 0, extra: true }))
    expect(createStore(dir, plain).getSettings()).toEqual({ ...DEFAULT_SETTINGS, theme: 'dark', monthlyCapUsd: 50 })
    fs.writeFileSync(path.join(dir, 'settings.json'), '{"theme": "dark", "dailyCap')
    expect(createStore(dir, plain).getSettings()).toEqual(DEFAULT_SETTINGS)
    fs.writeFileSync(path.join(dir, 'settings.json'), '[1, 2]')
    expect(createStore(dir, plain).getSettings()).toEqual(DEFAULT_SETTINGS)
  })

  it('saves, keeping the stored value for a field with a wrong type', () => {
    const store = createStore(tmp(), plain)
    store.saveSettings({ theme: 'light', dailyCapUsd: 3, monthlyCapUsd: 0, notifications: false, checkUpdates: true })
    expect(store.getSettings()).toEqual({ theme: 'light', dailyCapUsd: 3, monthlyCapUsd: 0, notifications: false, checkUpdates: true })
    store.saveSettings({ ...store.getSettings(), theme: 'neon' as 'dark', dailyCapUsd: -1, monthlyCapUsd: NaN })
    expect(store.getSettings()).toMatchObject({ theme: 'light', dailyCapUsd: 3, monthlyCapUsd: 0 })
  })
})

describe('runs', () => {
  it('deletes one run from the list and its event log', () => {
    const dir = tmp()
    const store = createStore(dir, plain)
    store.saveProject(office())
    store.saveRun('p1', { id: 'r1', goal: 'one', startedAt: 1, state: 'done' })
    store.saveRun('p1', { id: 'r2', goal: 'two', startedAt: 2, state: 'done' })
    store.appendEvent('p1', 'r1', msg('a'))
    store.appendEvent('p1', 'r2', msg('b'))
    store.deleteRun('p1', 'r1')
    expect(store.listRuns('p1').map((r) => r.id)).toEqual(['r2'])
    expect(store.readRun('p1', 'r1')).toEqual([])
    expect(fs.existsSync(path.join(dir, 'projects', 'p1', 'runs', 'r1.jsonl'))).toBe(false)
    expect(store.readRun('p1', 'r2')).toHaveLength(1)
  })

  it('marks runs cut off by a crash as stopped, with a final event', () => {
    const dir = tmp()
    const store = createStore(dir, plain)
    store.saveProject(office())
    store.saveRun('p1', { id: 'done', goal: 'g', startedAt: 1, state: 'done' })
    store.saveRun('p1', { id: 'live', goal: 'g', startedAt: 2, state: 'running' })
    store.appendEvent('p1', 'live', msg('hello'))
    // The crash happened in the middle of writing an event.
    fs.appendFileSync(path.join(dir, 'projects', 'p1', 'runs', 'live.jsonl'), '{"type":"tool","id":"x","at":')

    expect(createStore(dir, plain).reconcileRuns()).toBe(1)
    expect(store.listRuns('p1').map((r) => [r.id, r.state])).toEqual([['live', 'stopped'], ['done', 'done']])
    const events = store.readRun('p1', 'live')
    expect(events[0]).toMatchObject({ type: 'message', text: 'hello' })
    expect(events.at(-1)).toMatchObject({ type: 'run', runId: 'live', state: 'stopped', reason: 'app_closed' })
    expect(store.readRun('p1', 'done')).toEqual([])
    expect(store.reconcileRuns()).toBe(0)
  })

  it('does not stop startup over a damaged office', () => {
    const dir = tmp()
    fs.mkdirSync(path.join(dir, 'projects', 'bad'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'projects', 'bad', 'project.json'), JSON.stringify({ ...office(), id: '..' }))
    const store = createStore(dir, plain)
    store.saveProject(office('ok'))
    store.saveRun('ok', { id: 'r', goal: 'g', startedAt: 1, state: 'running' })
    expect(store.reconcileRuns()).toBe(1)
  })

  it('never recreates the folder of a deleted office for a late event', () => {
    const dir = tmp()
    const store = createStore(dir, plain)
    store.saveProject(office())
    expect(store.hasProject('p1')).toBe(true)
    store.deleteProject('p1')
    expect(store.hasProject('p1')).toBe(false)
    store.appendEvent('p1', 'r1', msg('late reply'))
    store.saveRun('p1', { id: 'r1', goal: 'g', startedAt: 1, state: 'stopped' })
    store.appendNote('p1', 'a1', 'a lesson')
    expect(fs.existsSync(path.join(dir, 'projects', 'p1'))).toBe(false)
    expect(store.listProjects()).toEqual([])
  })

  it('refuses ids that point at the data folder itself', () => {
    const dir = tmp()
    const store = createStore(dir, plain)
    store.saveProject(office())
    for (const id of ['..', '.', '']) {
      expect(() => store.deleteProject(id)).toThrow('E_BAD_ARGS')
      expect(store.hasProject(id)).toBe(false)
    }
    expect(fs.existsSync(path.join(dir, 'projects', 'p1', 'project.json'))).toBe(true)
  })
})

describe('extensions state', () => {
  it('survives a crash in the middle of saving', () => {
    const dir = tmp()
    const ext = createExtensions(dir, plain)
    ext.saveMcp({ id: 'm1', name: 'GitHub', transport: 'stdio', command: 'npx', args: [], url: '', enabled: true }, '')
    const real = fs.writeFileSync
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation(((f: fs.PathOrFileDescriptor, data: string) => {
      real(f, data.slice(0, 10)) // the process dies halfway through the write
      throw new Error('crash')
    }) as typeof fs.writeFileSync)
    try {
      expect(() => ext.setSkillEnabled('testing', false)).toThrow('crash')
    } finally {
      spy.mockRestore()
    }
    expect(createExtensions(dir, plain).listMcp().map((m) => m.name)).toEqual(['GitHub'])
  })
})
