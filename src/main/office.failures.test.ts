import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Agent, OfficeEvent } from '../shared/types'
import { Office } from './office'
import type { Chat, ToolResult, Turn } from './providers'

const agent = (id: string, extra: Partial<Agent> = {}): Agent => ({
  id, name: id, title: id, department: '', reportsTo: null, instructions: '', providerId: 'p', model: 'main', tools: [], ...extra
})
const apiError = (status: number, error: unknown, headers: Record<string, string> = {}) =>
  Object.assign(new Error(`${status} error`), { status, error, headers: new Headers(headers) })
const report = (summary: string): Partial<Turn> => ({ calls: [{ id: 'r', name: 'report_to_user', input: { summary } }] })

/** step() per model id; each gets the input it was called with. */
type Step = (input: string | undefined, results: ToolResult[]) => Partial<Turn> | Promise<Partial<Turn>>

function setup(a: Agent, steps: Record<string, Step>, conn?: (id: string) => void) {
  const events: OfficeEvent[] = []
  const waits: number[] = []
  const office = new Office(
    { id: 'x', name: 'Acme', workspaceDir: fs.mkdtempSync(path.join(os.tmpdir(), 'fail-')), briefing: '', approval: 'auto', budgetUsd: 0, agents: [a] },
    {
      conn: (id) => {
        conn?.(id)
        return { kind: 'openai', baseURL: '', apiKey: '' }
      },
      charge: () => 0,
      readNotes: () => '',
      appendNote: () => {},
      emit: (e) => events.push(e),
      sleep: async (ms) => {
        waits.push(ms)
      },
      openChat: (_c, model): Chat => ({
        step: async (results, input) => ({ text: '', calls: [], usage: { in: 1, cacheRead: 0, cacheWrite: 0, out: 1 }, ...(await steps[model](input, results)) })
      })
    }
  )
  const settle = () => new Promise((r) => setTimeout(r, 20))
  return { office, events, waits, settle }
}

describe('model failures', () => {
  it('prices a reply by the model that wrote it after a server-side fallback', async () => {
    const { office, events, settle } = setup(agent('ceo'), { main: () => ({ ...report('done'), model: 'served-model' }) })
    office.start('go')
    await settle()
    expect(events.find((e) => e.type === 'cost')).toMatchObject({ providerId: 'p', model: 'served-model' })
  })

  it('retries a rate limit with the same input and the provider\'s delay', async () => {
    const inputs: (string | undefined)[] = []
    let n = 0
    const { office, events, waits, settle } = setup(agent('ceo'), {
      main: (input) => {
        inputs.push(input)
        if (++n <= 2) throw apiError(429, { error: { type: 'rate_limit_error' } }, { 'retry-after': '3' })
        return report('done')
      }
    })
    office.start('go')
    await settle()
    expect(waits).toEqual([3000, 3000])
    expect(inputs).toEqual(['[From the owner] go', '[From the owner] go', '[From the owner] go'])
    expect(events.filter((e) => e.type === 'notice').map((e) => e.type === 'notice' && e.attempt)).toEqual([1, 2])
    expect(events.filter((e) => e.type === 'run').at(-1)).toMatchObject({ state: 'done', reason: 'report' })
  })

  it('moves to the backup model with a work log when credit runs out', async () => {
    let handoff = ''
    const { office, events, settle } = setup(agent('ceo', { backup: { providerId: 'p2', model: 'spare' } }), {
      main: () => {
        throw apiError(402, { error: { message: 'Insufficient Balance' } })
      },
      spare: (input) => {
        handoff = input ?? ''
        return report('done on spare')
      }
    })
    office.start('build the site')
    await settle()
    expect(events.find((e) => e.type === 'switch')).toMatchObject({ from: { providerId: 'p', model: 'main' }, to: { providerId: 'p2', model: 'spare' }, kind: 'quota' })
    expect(handoff).toContain('different model')
    expect(handoff).toContain('[From the owner] build the site')
    expect(events.find((e) => e.type === 'cost')).toMatchObject({ providerId: 'p2', model: 'spare' })
    expect(office.isRunning).toBe(false)
  })

  it('without a backup it waits for the owner, then continues on the model they pick', async () => {
    let fixedInput = ''
    const { office, events, settle } = setup(agent('ceo'), {
      main: () => {
        throw apiError(401, { error: { type: 'authentication_error', message: 'invalid x-api-key' } })
      },
      fixed: (input) => {
        fixedInput = input ?? ''
        return report('ok')
      }
    })
    office.start('task')
    await settle()
    const blocked = events.find((e) => e.type === 'blocked')
    expect(blocked).toMatchObject({ agentId: 'ceo', kind: 'auth', model: 'main' })
    expect(events.filter((e) => e.type === 'status').at(-1)).toMatchObject({ status: 'blocked' })
    expect(office.isRunning).toBe(true) // the run stays open for the owner

    office.retry('ceo', { providerId: 'p', model: 'fixed' })
    await settle()
    expect(events.some((e) => e.type === 'unblocked' && blocked?.type === 'blocked' && e.id === blocked.id)).toBe(true)
    expect(fixedInput).toContain('[From the owner] task')
    expect(events.filter((e) => e.type === 'run').at(-1)).toMatchObject({ state: 'done', reason: 'report' })
  })

  it('a plain retry resends the same request on the same chat', async () => {
    let n = 0
    const inputs: (string | undefined)[] = []
    const { office, events, settle } = setup(agent('ceo'), {
      main: (input) => {
        inputs.push(input)
        if (++n === 1) throw apiError(402, { error: { message: 'Insufficient Balance' } })
        return report('ok')
      }
    })
    office.start('task')
    await settle()
    office.retry('ceo')
    await settle()
    expect(inputs).toEqual(['[From the owner] task', '[From the owner] task'])
    expect(events.filter((e) => e.type === 'run').at(-1)).toMatchObject({ state: 'done' })
  })

  it('an unreadable key blocks before any request, and stop clears the block', async () => {
    const { office, events, settle } = setup(agent('ceo'), { main: () => report('x') }, () => {
      throw new Error('E_KEY_UNREADABLE|DeepSeek')
    })
    office.start('task')
    await settle()
    expect(events.find((e) => e.type === 'blocked')).toMatchObject({ kind: 'config', detail: 'E_KEY_UNREADABLE|DeepSeek' })
    office.stop()
    expect(events.filter((e) => e.type === 'unblocked')).toHaveLength(1)
    expect(office.isRunning).toBe(false)
  })
})
