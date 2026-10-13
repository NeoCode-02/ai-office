import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createStore } from './store'

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
