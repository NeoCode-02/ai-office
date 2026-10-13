import { describe, expect, it } from 'vitest'
import { checkUpdate, compareVersions, parseVersion, RELEASES_URL } from './updates'

/** A fetch that answers once and remembers what it was asked. */
function fake(status: number, body: unknown) {
  const calls: { url: string; init?: RequestInit }[] = []
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { impl, calls }
}

describe('versions', () => {
  it('parses a leading v, missing parts, pre-releases and build metadata', () => {
    expect(parseVersion('v1.2.3')).toEqual({ core: [1, 2, 3], pre: [] })
    expect(parseVersion('1.2')).toEqual({ core: [1, 2, 0], pre: [] })
    expect(parseVersion('2.0.0-rc.1+build.7')).toEqual({ core: [2, 0, 0], pre: ['rc', '1'] })
    expect(parseVersion('nightly')).toBeNull()
    expect(parseVersion('1.2.3.4')).toBeNull()
    expect(parseVersion('1.2.3-')).toBeNull()
  })

  it('orders numerically and by semver pre-release rules', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1)
    expect(compareVersions('0.2.0', '0.3.0')).toBe(-1)
    expect(compareVersions('v1.2', '1.2.0')).toBe(0)
    expect(compareVersions('1.0.0+a', '1.0.0+b')).toBe(0)
    const order = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1']
    for (let i = 0; i < order.length - 1; i++) {
      expect(compareVersions(order[i], order[i + 1]), `${order[i]} < ${order[i + 1]}`).toBe(-1)
      expect(compareVersions(order[i + 1], order[i])).toBe(1)
    }
  })
})

describe('checkUpdate', () => {
  it('asks GitHub for the latest release and reports a newer one', async () => {
    const f = fake(200, { tag_name: 'v0.3.0', html_url: 'https://github.com/NeoCode-02/ai-office/releases/tag/v0.3.0' })
    expect(await checkUpdate('0.2.0', f.impl)).toEqual({ current: '0.2.0', latest: '0.3.0', url: 'https://github.com/NeoCode-02/ai-office/releases/tag/v0.3.0', newer: true })
    expect(f.calls[0].url).toBe(RELEASES_URL)
    expect(new Headers(f.calls[0].init?.headers).get('accept')).toBe('application/vnd.github+json')
    expect(f.calls[0].init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('is not newer for the same, an older, a pre-release of the same or an unreadable version', async () => {
    expect((await checkUpdate('0.3.0', fake(200, { tag_name: 'v0.3.0' }).impl)).newer).toBe(false)
    expect((await checkUpdate('0.3.0', fake(200, { tag_name: '0.2.9' }).impl)).newer).toBe(false)
    expect((await checkUpdate('0.3.0', fake(200, { tag_name: 'v0.3.0-rc.2' }).impl)).newer).toBe(false)
    expect((await checkUpdate('0.3.0-rc.1', fake(200, { tag_name: 'v0.3.0' }).impl)).newer).toBe(true)
    expect(await checkUpdate('0.3.0', fake(200, { tag_name: 'nightly-2026' }).impl)).toMatchObject({ latest: 'nightly-2026', newer: false })
    expect(await checkUpdate('0.3.0', fake(200, {}).impl)).toEqual({ current: '0.3.0', latest: null, url: null, newer: false })
  })

  it('only passes on a GitHub page as the link', async () => {
    expect((await checkUpdate('0.1.0', fake(200, { tag_name: 'v1.0.0', html_url: 'https://evil.example/x' }).impl)).url).toBeNull()
    expect((await checkUpdate('0.1.0', fake(200, { tag_name: 'v1.0.0', html_url: 'javascript:alert(1)' }).impl)).url).toBeNull()
  })

  it('treats "no release yet" as no update and other failures as E_UPDATE', async () => {
    expect(await checkUpdate('0.2.0', fake(404, { message: 'Not Found' }).impl)).toEqual({ current: '0.2.0', latest: null, url: null, newer: false })
    await expect(checkUpdate('0.2.0', fake(403, { message: 'rate limit' }).impl)).rejects.toThrow('E_UPDATE|403')
    await expect(checkUpdate('0.2.0', fake(500, {}).impl)).rejects.toThrow('E_UPDATE|500')
  })
})
