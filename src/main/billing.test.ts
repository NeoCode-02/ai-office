import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { charge, cost, matchCatalog, priceOf, type CatalogModel } from './billing'
import { openaiUsage, openChat } from './providers'

const u = (inT: number, cacheRead: number, cacheWrite: number, out: number) => ({ in: inT, cacheRead, cacheWrite, out })

describe('cost', () => {
  it('prices Anthropic cache reads and writes with the published multipliers', () => {
    // Sonnet 5.5: $2 in, $10 out → read 0.2, write 2.5
    expect(cost({ in: 2, out: 10 }, 'anthropic', u(1e6, 1e6, 1e6, 1e6))).toBeCloseTo(2 + 0.2 + 2.5 + 10)
    // explicit cache price wins (Opus 5.5 reads at $0.20 = 0.05×)
    expect(cost({ in: 4, out: 20, cacheRead: 0.2 }, 'anthropic', u(0, 1e6, 0, 0))).toBeCloseTo(0.2)
  })

  it('never under-counts cached tokens of other providers without a cache price', () => {
    expect(cost({ in: 1, out: 2 }, 'openai', u(1e6, 1e6, 0, 0))).toBeCloseTo(2)
    expect(cost({ in: 1, out: 2, cacheRead: 0.1 }, 'openai', u(1e6, 1e6, 0, 0))).toBeCloseTo(1.1)
  })

  it('switches the whole request to the long-context tier above the threshold', () => {
    const haiku = { in: 0.1, out: 0.5, long: { above: 100_000, in: 0.5, out: 2.5 } }
    expect(cost(haiku, 'anthropic', u(100_000, 0, 0, 1000))).toBeCloseTo((100_000 * 0.1 + 1000 * 0.5) / 1e6)
    expect(cost(haiku, 'anthropic', u(50_000, 40_000, 10_001, 1000))).toBeCloseTo((50_000 * 0.5 + 40_000 * 0.05 + 10_001 * 0.625 + 1000 * 2.5) / 1e6)
  })
})

describe('openaiUsage', () => {
  it('splits cached prompt tokens (OpenAI, GLM)', () => {
    expect(openaiUsage({ prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050, prompt_tokens_details: { cached_tokens: 800 } })).toEqual(u(200, 800, 0, 50))
  })
  it('reads DeepSeek and Kimi cache fields', () => {
    expect(openaiUsage({ prompt_tokens: 1000, completion_tokens: 5, prompt_cache_hit_tokens: 600 })).toEqual(u(400, 600, 0, 5))
    expect(openaiUsage({ prompt_tokens: 1000, completion_tokens: 5, cached_tokens: 300 })).toEqual(u(700, 300, 0, 5))
  })
  it('keeps the billed cost and cache writes from OpenRouter', () => {
    expect(openaiUsage({ prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 20, cache_write_tokens: 30 }, cost: 0.0042 })).toEqual({ ...u(50, 20, 30, 10), usd: 0.0042 })
  })
  it('counts reasoning tokens that only show up in the total (Gemini)', () => {
    expect(openaiUsage({ prompt_tokens: 100, completion_tokens: 10, total_tokens: 190 })).toEqual(u(100, 0, 0, 90))
  })
  it('handles a missing usage block', () => {
    expect(openaiUsage(undefined)).toEqual(u(0, 0, 0, 0))
  })
})

/** Server that rejects every request with 400 and records the bodies. */
async function rejecting() {
  const bodies: { messages: unknown[] }[] = []
  const server = http.createServer((req, res) => {
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', () => {
      bodies.push(JSON.parse(b))
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'nope' } }))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { url, bodies, close: () => server.close() }
}

describe('failed step', () => {
  for (const kind of ['openai', 'anthropic'] as const) {
    it(`leaves the ${kind} history unchanged so the step can be retried`, async () => {
      const s = await rejecting()
      try {
        const chat = openChat({ kind, baseURL: kind === 'openai' ? `${s.url}/v1` : s.url, apiKey: 'k' }, 'm', 'sys', [])
        await expect(chat.step([], 'hello')).rejects.toThrow()
        await expect(chat.step([], 'hello')).rejects.toThrow()
        expect(s.bodies).toHaveLength(2)
        expect(s.bodies[1].messages).toEqual(s.bodies[0].messages)
      } finally {
        s.close()
      }
    })
  }
})

describe('prices', () => {
  const anthropic = { kind: 'anthropic' as const, baseURL: '', prices: {}, billing: { mode: 'payg' as const } }
  const usage = u(1e6, 0, 0, 0)

  it('uses built-in prices only for Anthropic\'s own API', () => {
    expect(priceOf(anthropic, 'claude-opus-5-5')?.in).toBe(4)
    expect(priceOf({ ...anthropic, baseURL: 'https://proxy.example/anthropic' }, 'claude-opus-5-5')).toBeUndefined()
    expect(priceOf({ ...anthropic, prices: { 'claude-opus-5-5': { in: 3, out: 9 } } }, 'claude-opus-5-5')?.in).toBe(3)
  })

  it('charges per billing mode', () => {
    expect(charge(anthropic, 'claude-opus-5-5', usage)).toBeCloseTo(4)
    expect(charge(anthropic, 'unknown-model', usage)).toBeNull()
    expect(charge({ ...anthropic, billing: { mode: 'subscription', fee: 20 } }, 'unknown-model', usage)).toBe(0)
    expect(charge({ ...anthropic, billing: { mode: 'free' } }, 'claude-opus-5-5', usage)).toBe(0)
    expect(charge(anthropic, 'unknown-model', { ...usage, usd: 0.5 })).toBe(0.5)
  })

  // Shape copied from https://openrouter.ai/api/v1/models (2026-10-13).
  const list: CatalogModel[] = [
    { id: 'anthropic/claude-haiku-5.5', pricing: { prompt: '0.0000001', completion: '0.0000005', input_cache_read: '0.00000001', input_cache_write: '0.000000125', overrides: [{ min_prompt_tokens: 100000, prompt: '0.0000005', completion: '0.0000025', input_cache_read: '0.00000005', input_cache_write: '0.000000625' }] } },
    { id: 'anthropic/claude-haiku-5.5:batch', pricing: { prompt: '0.00000005', completion: '0.00000025' } },
    { id: 'deepseek/deepseek-chat', pricing: { prompt: '0.00000027', completion: '0.0000011' } },
    { id: 'someone/deepseek-chat', pricing: { prompt: '0.000001', completion: '0.000001' } },
    { id: 'z-ai/glm-4.6', pricing: { prompt: '0.0000006', completion: '0.0000022', input_cache_read: '0.00000011' } }
  ]

  it('reads catalog prices per 1M tokens, including the long-context tier', () => {
    expect(matchCatalog(list, anthropic, 'claude-haiku-5-5')).toEqual({
      in: 0.1, out: 0.5, cacheRead: 0.01, cacheWrite: 0.125,
      long: { above: 99_999, in: 0.5, out: 2.5, cacheRead: 0.05, cacheWrite: 0.625 }
    })
  })

  it('matches by vendor and never guesses', () => {
    expect(matchCatalog(list, { kind: 'openai', baseURL: 'https://api.deepseek.com' }, 'deepseek-chat')?.in).toBe(0.27)
    expect(matchCatalog(list, { kind: 'openai', baseURL: 'https://my-proxy.local/v1' }, 'deepseek-chat')).toBeUndefined() // two candidates
    expect(matchCatalog(list, { kind: 'openai', baseURL: 'https://api.z.ai/api/paas/v4' }, 'glm-4.6')?.cacheRead).toBe(0.11)
    expect(matchCatalog(list, { kind: 'openai', baseURL: 'https://openrouter.ai/api/v1' }, 'z-ai/glm-4.6')?.in).toBe(0.6)
    expect(matchCatalog(list, { kind: 'openai', baseURL: 'https://openrouter.ai/api/v1' }, 'glm-4.6')).toBeUndefined()
  })
})
