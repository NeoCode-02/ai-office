import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import zlib from 'node:zlib'
import { clip } from './exec'

export type AddressClass = 'public' | 'loopback' | 'private' | 'link-local' | 'unspecified' | 'multicast' | 'reserved'

export interface FetchOpts {
  signal?: AbortSignal
  /** Asked before connecting to this computer or the local network; absent = refused. */
  approveLocal?(url: string): Promise<boolean>
  /** Default 20 s, not counting the time the owner takes to answer. */
  timeoutMs?: number
  /** Default 2 MB of (decompressed) body. */
  maxBytes?: number
}

const MAX_REDIRECTS = 5
const MAX_BYTES = 2 * 1024 * 1024
/** Never fetched, approved or not: cloud metadata services live on link-local addresses. */
const BLOCKED = new Set<AddressClass>(['link-local', 'unspecified', 'multicast', 'reserved'])
const TEXTUAL = /text|json|xml|javascript/

const V4_RANGES: [string, number, AddressClass][] = [
  ['0.0.0.0', 8, 'unspecified'],
  ['10.0.0.0', 8, 'private'],
  ['100.64.0.0', 10, 'private'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local'],
  ['172.16.0.0', 12, 'private'],
  ['192.168.0.0', 16, 'private'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved']
]

const v4Number = (ip: string) => ip.split('.').reduce((n, part) => n * 256 + Number(part), 0)

function classifyV4(n: number): AddressClass {
  for (const [base, bits, cls] of V4_RANGES) {
    const size = 2 ** (32 - bits)
    if (Math.floor(n / size) === Math.floor(v4Number(base) / size)) return cls
  }
  return 'public'
}

/** The eight 16-bit groups of a valid IPv6 address (dotted IPv4 tail allowed). */
function v6Groups(ip: string): number[] {
  let s = ip.toLowerCase()
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s)
  if (dotted) {
    const n = v4Number(dotted[2])
    s = `${dotted[1]}${Math.floor(n / 65536).toString(16)}:${(n % 65536).toString(16)}`
  }
  const [head, tail] = s.split('::')
  const h = head ? head.split(':') : []
  const t = tail ? tail.split(':') : []
  const groups = tail === undefined ? h : [...h, ...Array<string>(8 - h.length - t.length).fill('0'), ...t]
  return groups.map((g) => parseInt(g, 16))
}

function classifyV6(g: number[]): AddressClass {
  const zeros = (from: number, to: number) => g.slice(from, to).every((x) => x === 0)
  const v4 = () => classifyV4(g[6] * 65536 + g[7])
  if (zeros(0, 8)) return 'unspecified'
  if (zeros(0, 7) && g[7] === 1) return 'loopback'
  if (zeros(0, 5) && g[5] === 0xffff) return v4() // IPv4-mapped ::ffff:a.b.c.d
  if (zeros(0, 6)) return 'reserved' // deprecated IPv4-compatible ::a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return v4() // NAT64
  if ((g[0] & 0xffc0) === 0xfe80) return 'link-local'
  if ((g[0] & 0xffc0) === 0xfec0) return 'private' // deprecated site-local
  if ((g[0] & 0xfe00) === 0xfc00) return 'private'
  if ((g[0] & 0xff00) === 0xff00) return 'multicast'
  return 'public'
}

/** What kind of network an IP address is on; anything that is not an IP address is 'reserved'. */
export function classifyAddress(ip: string): AddressClass {
  const bare = ip.replace(/^\[(.*)\]$/, '$1').replace(/%.*$/, '')
  const family = net.isIP(bare)
  if (family === 4) return classifyV4(v4Number(bare))
  if (family === 6) return classifyV6(v6Groups(bare))
  return 'reserved'
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' }

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, '')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e: string) => ENTITIES[e])
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim()
}

function httpUrl(href: string): URL {
  const u = new URL(href)
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http and https URLs are allowed')
  return u
}

function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

/** Network time left; the owner's think time is not counted. */
interface Clock {
  total: number
  left: number
}

/** Runs one network step under the remaining time and the caller's signal. */
async function timed<T>(clock: Clock, outer: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctl = new AbortController()
  const started = Date.now()
  const timer = setTimeout(() => ctl.abort(new Error(`Timed out after ${clock.total / 1000} s`)), Math.max(0, clock.left))
  const stop = () => ctl.abort(new Error('Stopped'))
  if (outer?.aborted) stop()
  else outer?.addEventListener('abort', stop, { once: true })
  try {
    return await run(ctl.signal)
  } finally {
    clearTimeout(timer)
    outer?.removeEventListener('abort', stop)
    clock.left -= Date.now() - started
  }
}

async function resolveHost(host: string, signal: AbortSignal): Promise<dns.LookupAddress[]> {
  const family = net.isIP(host)
  if (family) return [{ address: host, family }]
  return abortable(dns.promises.lookup(host, { all: true }), signal)
}

/** Lookup for the connection: the addresses already checked, so DNS cannot change its answer in between. */
function pinned(addrs: dns.LookupAddress[]): net.LookupFunction {
  return (host, options, callback) => {
    const want = options.family === 4 || options.family === 'IPv4' ? 4 : options.family === 6 || options.family === 'IPv6' ? 6 : 0
    const list = want ? addrs.filter((a) => a.family === want) : addrs
    if (!list.length) return callback(Object.assign(new Error(`No IPv${want} address for ${host}`), { code: 'ENOTFOUND' }), '')
    if (options.all) callback(null, list)
    else callback(null, list[0].address, list[0].family)
  }
}

interface Reply {
  status: number
  type: string
  location?: string
  body?: Buffer
  truncated?: boolean
}

function decoder(encoding: string, first: Buffer): zlib.Gunzip | zlib.Inflate | zlib.InflateRaw | zlib.BrotliDecompress {
  if (encoding === 'br') return zlib.createBrotliDecompress()
  if (encoding === 'deflate') return (first[0] & 0x0f) === 8 ? zlib.createInflate() : zlib.createInflateRaw() // some servers omit the zlib header
  return zlib.createGunzip()
}

/** One GET to already-checked addresses; redirects are returned, not followed. */
function get(u: URL, addrs: dns.LookupAddress[], signal: AbortSignal, maxBytes: number): Promise<Reply> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const lib = u.protocol === 'https:' ? https : http
    const req = lib.request(u, {
      method: 'GET',
      agent: false,
      lookup: pinned(addrs),
      headers: { 'User-Agent': 'AI-Office', Accept: '*/*', 'Accept-Encoding': 'gzip, deflate, br' }
    })
    let settled = false
    let res: http.IncomingMessage | undefined
    let dec: ReturnType<typeof decoder> | undefined
    const settle = (f: () => void) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      dec?.destroy()
      res?.destroy()
      req.destroy()
      f()
    }
    const fail = (e: Error) => settle(() => reject(e))
    const onAbort = () => fail(signal.reason as Error)
    signal.addEventListener('abort', onAbort, { once: true })
    req.on('error', fail)
    req.on('response', (r) => {
      res = r
      r.on('error', fail)
      const status = r.statusCode ?? 0
      const type = String(r.headers['content-type'] ?? '')
      if ([301, 302, 303, 307, 308].includes(status) && r.headers.location) return settle(() => resolve({ status, type, location: r.headers.location }))
      if (!TEXTUAL.test(type.toLowerCase())) return settle(() => resolve({ status, type }))
      const encoding = String(r.headers['content-encoding'] ?? '')
        .trim()
        .toLowerCase()
      const plain = encoding === '' || encoding === 'identity'
      if (!plain && !['gzip', 'x-gzip', 'deflate', 'br'].includes(encoding)) return fail(new Error(`Unsupported content encoding "${encoding}"`))

      const chunks: Buffer[] = []
      let size = 0
      const done = (truncated: boolean) => settle(() => resolve({ status, type, body: Buffer.concat(chunks), truncated }))
      const take = (c: Buffer) => {
        if (settled) return
        if (c.length > maxBytes - size) {
          chunks.push(c.subarray(0, maxBytes - size))
          return done(true)
        }
        chunks.push(c)
        size += c.length
      }
      r.on('data', (c: Buffer) => {
        if (settled) return
        if (plain) return take(c)
        if (!dec) {
          dec = decoder(encoding, c)
          dec.on('data', take)
          dec.on('end', () => done(false))
          dec.on('error', (e) => fail(new Error(`Could not decompress the response: ${e.message}`)))
        }
        dec.write(c)
      })
      r.on('end', () => (dec ? dec.end() : done(false)))
    })
    req.end()
  })
}

function decode(body: Buffer, type: string): string {
  const charset = /charset=["']?([\w.:-]+)/i.exec(type)?.[1]
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(body)
  } catch {
    return body.toString('utf8')
  }
}

async function askOwner(url: string, opts: FetchOpts): Promise<boolean> {
  if (!opts.approveLocal) return false
  if (!opts.signal) return opts.approveLocal(url)
  try {
    return await abortable(opts.approveLocal(url), opts.signal)
  } catch (e) {
    throw opts.signal.aborted ? new Error('Stopped') : e
  }
}

/**
 * GET over http(s) and return the body as text. Each host is resolved once and its addresses are
 * checked before connecting (and on every redirect): link-local, multicast and reserved addresses
 * are always refused, this computer and the local network only with `approveLocal`.
 */
export async function webFetch(url: string, opts: FetchOpts = {}): Promise<string> {
  let u = httpUrl(url)
  const clock: Clock = { total: opts.timeoutMs ?? 20_000, left: opts.timeoutMs ?? 20_000 }
  const approved = new Set<string>()
  for (let redirects = 0; ; redirects++) {
    const host = u.hostname.replace(/^\[(.*)\]$/, '$1')
    const addrs = await timed(clock, opts.signal, (signal) => resolveHost(host, signal))
    if (!addrs.length) throw new Error(`Could not resolve ${host}`)
    const where = (address: string) => (address === host ? host : `${host} (${address})`)
    let local: string | undefined
    for (const a of addrs) {
      const cls = classifyAddress(a.address)
      if (BLOCKED.has(cls)) throw new Error(`Blocked: ${where(a.address)} is ${cls === 'unspecified' ? 'an' : 'a'} ${cls} address; such addresses are never fetched`)
      if (cls !== 'public') local ??= a.address
    }
    if (local && !approved.has(`${u.host} ${local}`)) {
      if (!(await askOwner(u.href, opts))) throw new Error(`Refused: ${where(local)} is on this computer or the local network, and the owner did not allow it`)
      approved.add(`${u.host} ${local}`)
    }

    const r = await timed(clock, opts.signal, (signal) => get(u, addrs, signal, opts.maxBytes ?? MAX_BYTES))
    if (r.location !== undefined) {
      if (redirects >= MAX_REDIRECTS) throw new Error(`Too many redirects (more than ${MAX_REDIRECTS})`)
      u = httpUrl(new URL(r.location, u).href)
      continue
    }
    if (!r.body) return `HTTP ${r.status}, ${r.type || 'unknown type'}: binary content not shown`
    const text = decode(r.body, r.type)
    return clip(`HTTP ${r.status}\n\n${r.type.toLowerCase().includes('html') ? htmlToText(text) : text}`, 100_000) + (r.truncated ? '\n[truncated]' : '')
  }
}
