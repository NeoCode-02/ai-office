import type { UpdateInfo } from '../shared/types'
import { obj } from './validate'

export const RELEASES_URL = 'https://api.github.com/repos/NeoCode-02/ai-office/releases/latest'

interface Version {
  core: [number, number, number]
  pre: string[]
}

/** `v1.2.3-beta.1+build.5` → parts (missing minor/patch = 0); null when it is not a version. */
export function parseVersion(v: string): Version | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/i.exec(v.trim())
  if (!m) return null
  return { core: [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)], pre: m[4] ? m[4].split('.') : [] }
}

/** Semver precedence: negative when `a` is older than `b`, 0 when equal (or either is not a version). */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x || !y) return 0
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return Math.sign(x.core[i] - y.core[i])
  // A pre-release is older than the release itself.
  if (!x.pre.length || !y.pre.length) return Math.sign(y.pre.length - x.pre.length)
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i]
    const q = y.pre[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    const pn = /^\d+$/.test(p)
    const qn = /^\d+$/.test(q)
    if (pn && qn && Number(p) !== Number(q)) return Math.sign(Number(p) - Number(q))
    if (pn !== qn) return pn ? -1 : 1
    if (!pn && p !== q) return p < q ? -1 : 1
  }
  return 0
}

/** The latest GitHub release. No release yet (404) is not an error; other failures throw E_UPDATE|status. */
export async function checkUpdate(current: string, fetchImpl: typeof fetch = fetch): Promise<UpdateInfo> {
  const res = await fetchImpl(RELEASES_URL, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'AI-Office' },
    signal: AbortSignal.timeout(15_000)
  })
  if (res.status === 404) return { current, latest: null, url: null, newer: false }
  if (!res.ok) throw new Error(`E_UPDATE|${res.status}`)
  const body: unknown = await res.json()
  const tag = obj(body) && typeof body.tag_name === 'string' ? body.tag_name.trim() : ''
  const latest = tag ? tag.replace(/^v/i, '') : null
  // The page is opened in the browser: only ever a GitHub page.
  const url = obj(body) && typeof body.html_url === 'string' && body.html_url.startsWith('https://github.com/') ? body.html_url : null
  const newer = latest !== null && parseVersion(latest) !== null && parseVersion(current) !== null && compareVersions(latest, current) > 0
  return { current, latest, url, newer }
}
