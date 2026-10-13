import { describe, expect, it } from 'vitest'
import { createModelCache } from './modelList'

function fake(results: (string[] | Error)[]) {
  const calls: string[] = []
  const load = async (id: string) => {
    calls.push(id)
    const r = results.shift() ?? []
    if (r instanceof Error) throw r
    return r
  }
  return { calls, cache: createModelCache(load) }
}

describe('model list cache', () => {
  it('asks a provider once', async () => {
    const { calls, cache } = fake([['a', 'b']])
    expect(await cache.get('p1')).toEqual(['a', 'b'])
    expect(await cache.get('p1')).toEqual(['a', 'b'])
    expect(calls).toEqual(['p1'])
  })

  it('does not keep a failure, so the next ask retries', async () => {
    const { calls, cache } = fake([new Error('401'), ['m']])
    await expect(cache.get('p1')).rejects.toThrow('401')
    expect(await cache.get('p1')).toEqual(['m'])
    expect(calls).toEqual(['p1', 'p1'])
  })

  it('fetches again when the version changes (a key was added)', async () => {
    const { calls, cache } = fake([[], ['m']])
    expect(await cache.get('p1', 'false')).toEqual([])
    expect(await cache.get('p1', 'true')).toEqual(['m'])
    expect(await cache.get('p1', 'true')).toEqual(['m'])
    expect(calls).toEqual(['p1', 'p1'])
  })

  it('forgets only the given provider', async () => {
    const { calls, cache } = fake([['a'], ['b'], ['a2']])
    await cache.get('p1')
    await cache.get('p2', 'true')
    cache.forget('p1')
    expect(await cache.get('p1')).toEqual(['a2'])
    expect(await cache.get('p2', 'true')).toEqual(['b'])
    expect(calls).toEqual(['p1', 'p2', 'p1'])
  })
})
