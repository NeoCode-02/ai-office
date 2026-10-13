import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createStore } from './store'

describe('store', () => {
  it('treats a key it can no longer decrypt as missing, with a clear error', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-'))
    createStore(dir, { encrypt: (s) => `enc:${s}`, decrypt: (s) => s.slice(4) }).saveProvider({ id: 'p', name: 'DeepSeek', kind: 'openai', baseURL: 'https://x' }, 'sk-1')
    const broken = createStore(dir, { encrypt: (s) => s, decrypt: () => { throw new Error('bad ciphertext') } })
    expect(broken.listProviders()[0].hasKey).toBe(false)
    expect(() => broken.conn('p')).toThrow('E_KEY_UNREADABLE|DeepSeek')
  })
})
