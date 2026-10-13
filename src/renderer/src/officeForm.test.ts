import { describe, expect, it } from 'vitest'
import { DEFAULT_LIMITS, DEFAULT_SANDBOX, type Project } from '../../shared/types'
import { allowEntry, amount, fromForm, isDirty, mergeAllow, saveForm, toForm } from './officeForm'

// An office saved before v0.3: none of the new optional fields.
const old: Project = { id: 'p1', name: 'Studio', workspaceDir: '/w', briefing: 'b', approval: 'ask', budgetUsd: 5, agents: [] }

describe('office settings form', () => {
  it('fills defaults for offices saved before the new settings existed', () => {
    const f = toForm(old)
    expect(f).toMatchObject({ budget: '5', planFirst: false, checkpoints: true, sandbox: DEFAULT_SANDBOX, allowCommands: [] })
    expect([f.maxRequests, f.maxChatter, f.compactAt]).toEqual([DEFAULT_LIMITS.maxRequests, DEFAULT_LIMITS.maxChatter, DEFAULT_LIMITS.compactAt].map(String))
    // Opening the page changes nothing: no "unsaved changes", no defaults written into the file.
    expect(isDirty(f, old)).toBe(false)
    expect(fromForm(f, old)).toEqual(old)
  })

  it('fills a partly saved limits object', () => {
    const f = toForm({ ...old, limits: { maxRequests: 50 } as Project['limits'] })
    expect([f.maxRequests, f.maxChatter]).toEqual(['50', String(DEFAULT_LIMITS.maxChatter)])
  })

  it('keeps an empty budget while typing and saves it as 0', () => {
    const f = { ...toForm(old), budget: '' }
    expect(f.budget).toBe('')
    expect(fromForm(f, old).budgetUsd).toBe(0)
    expect(isDirty(f, old)).toBe(true)
    expect(isDirty(f, { ...old, budgetUsd: 0 })).toBe(false)
  })

  it('reads numbers as 0 or more, limits as whole numbers', () => {
    expect([amount(''), amount(' 2.5 '), amount('-3'), amount('abc'), amount('Infinity'), amount('7.9', true)]).toEqual([0, 2.5, 0, 0, 0, 7])
    const p = fromForm({ ...toForm(old), maxRequests: '120.6', maxChatter: '', compactAt: '-1' }, old)
    expect(p.limits).toEqual({ maxRequests: 120, maxChatter: 0, compactAt: 0 })
  })

  it('writes a setting once it is changed, and keeps saved values even when they equal the default', () => {
    const f = { ...toForm(old), planFirst: true, sandbox: { kind: 'docker' as const, image: ' python:3.13 ', network: false } }
    const p = fromForm(f, old)
    expect(p.planFirst).toBe(true)
    expect(p.sandbox).toEqual({ kind: 'docker', image: 'python:3.13', network: false })
    expect(p.limits).toBeUndefined()
    const saved = { ...old, planFirst: false, checkpoints: true }
    expect(fromForm(toForm(saved), saved)).toEqual(saved)
  })

  it('falls back to the default image when Docker is off and the field was emptied', () => {
    const f = { ...toForm(old), sandbox: { ...DEFAULT_SANDBOX, image: '' } }
    expect(fromForm(f, old).sandbox).toBeUndefined()
    expect(fromForm({ ...f, sandbox: { ...f.sandbox, kind: 'docker' } }, old).sandbox).toEqual({ kind: 'docker', image: '', network: true })
  })
})

describe('allow list', () => {
  it('keeps removals and entries added elsewhere meanwhile', () => {
    expect(mergeAllow(['npm test', 'mcp:gh › issues'], ['npm test'], ['npm test', 'mcp:gh › issues', 'fetch:localhost'])).toEqual(['npm test', 'fetch:localhost'])
    expect(mergeAllow(undefined, undefined, undefined)).toEqual([])
    expect(mergeAllow([], ['a'], ['a'])).toEqual(['a'])
  })

  it('names the kind of each entry', () => {
    expect(allowEntry('npm test')).toEqual({ kind: 'command', text: 'npm test' })
    expect(allowEntry('mcp:github › create_issue')).toEqual({ kind: 'mcp', text: 'github › create_issue' })
    expect(allowEntry('fetch:127.0.0.1:3000')).toEqual({ kind: 'fetch', text: '127.0.0.1:3000' })
  })
})

describe('saveForm', () => {
  const loaded: Project = { ...old, allowCommands: ['npm test', 'npm run build'] }
  // Saved by others while the page was open: the team, a raised budget and a new permission.
  const latest: Project = { ...loaded, budgetUsd: 10, allowCommands: ['npm test', 'npm run build', 'fetch:localhost'], agents: [{ id: 'a' } as Project['agents'][number]] }

  it('applies the owner\'s edits on top of the latest saved office', () => {
    const f = { ...toForm(loaded), name: 'Renamed', allowCommands: ['npm test'] }
    const p = saveForm(f, loaded, latest)
    expect(p.name).toBe('Renamed')
    expect(p.budgetUsd).toBe(10)
    expect(p.agents).toBe(latest.agents)
    expect(p.allowCommands).toEqual(['npm test', 'fetch:localhost'])
  })

  it('keeps a field the owner changed even when it was also changed elsewhere', () => {
    const p = saveForm({ ...toForm(loaded), budget: '3' }, loaded, latest)
    expect(p.budgetUsd).toBe(3)
  })

  it('saves nothing new for an untouched form', () => {
    expect(saveForm(toForm(old), old, old)).toEqual(old)
  })
})
