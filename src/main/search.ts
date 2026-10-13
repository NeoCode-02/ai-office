import { Worker } from 'node:worker_threads'

export interface SearchOpts {
  /** Default 10 s. */
  timeoutMs?: number
  signal?: AbortSignal
}

const MAX_HITS = 200
/** Files above this size are skipped when a folder is searched (a file named directly is always searched). */
const MAX_FILE = 1_000_000

/**
 * Runs inside a worker thread, so it is plain JavaScript with no imports from our bundle.
 * Never follows symbolic links; skips node_modules, .git, binary files and big files in folders.
 */
const SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
const fs = require('node:fs')
const path = require('node:path')
const { StringDecoder } = require('node:string_decoder')
const { root, target, pattern, maxHits, maxFile } = workerData
const re = new RegExp(pattern, 'i')
const hits = []
const buf = Buffer.allocUnsafe(1 << 20)
const rel = (f) => path.relative(root, f).split(path.sep).join('/')

function scan(file, limit) {
  let fd
  try {
    // A file swapped for a link or a FIFO after listing must not be followed or block the search.
    const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants
    fd = fs.openSync(file, O_RDONLY | (O_NOFOLLOW || 0) | (O_NONBLOCK || 0))
  } catch {
    return
  }
  try {
    const st = fs.fstatSync(fd)
    if (!st.isFile() || st.size > limit) return
    const dec = new StringDecoder('utf8')
    let carry = ''
    let line = 0
    let first = true
    const test = (text) => {
      line++
      if (re.test(text)) hits.push(rel(file) + ':' + line + ': ' + text.trim().slice(0, 200))
    }
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null)
      if (n === 0) break
      const chunk = buf.subarray(0, n)
      if (first && chunk.includes(0)) return
      first = false
      const lines = (carry + dec.write(chunk)).split('\\n')
      carry = lines.pop()
      for (const text of lines) {
        test(text)
        if (hits.length >= maxHits) return
      }
    }
    carry += dec.end()
    if (carry) test(carry)
  } catch {
    // Unreadable files are skipped like binary ones.
  } finally {
    fs.closeSync(fd)
  }
}

function walk(dir) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const e of entries) {
    if (hits.length >= maxHits) return
    if (e.isSymbolicLink() || e.name === 'node_modules' || e.name.toLowerCase() === '.git') continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full)
    else if (e.isFile()) scan(full, maxFile)
  }
}

try {
  const st = fs.lstatSync(target)
  if (st.isDirectory()) walk(target)
  else if (st.isFile()) scan(target, Infinity)
  else throw new Error('"' + rel(target) + '" is not a file or folder')
  parentPort.postMessage({ text: hits.join('\\n') || 'No matches' })
} catch (e) {
  parentPort.postMessage({ error: e && e.message ? e.message : String(e) })
}
`

/**
 * Searches `target` (a folder or one file, already checked to be inside `root`) for lines matching
 * `pattern`, case-insensitively, as `path:line: text`. Runs in a worker with a time limit, so a
 * catastrophic pattern or a huge tree cannot freeze the main process.
 */
export function searchFiles(root: string, target: string, pattern: string, opts: SearchOpts = {}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 10_000
  try {
    new RegExp(pattern, 'i')
  } catch (e) {
    return Promise.reject(new Error((e as Error).message))
  }
  if (opts.signal?.aborted) return Promise.reject(new Error('Search stopped'))

  return new Promise((resolve, reject) => {
    const worker = new Worker(SOURCE, {
      eval: true,
      workerData: { root, target, pattern, maxHits: MAX_HITS, maxFile: MAX_FILE },
      resourceLimits: { maxOldGenerationSizeMb: 512 }
    })
    let settled = false
    const finish = (f: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      void worker.terminate()
      f()
    }
    const timer = setTimeout(
      () => finish(() => reject(new Error(`Search timed out after ${timeoutMs / 1000} s; use a simpler pattern or a smaller folder`))),
      timeoutMs
    )
    const onAbort = () => finish(() => reject(new Error('Search stopped')))
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    worker.on('message', (m: { text?: string; error?: string }) =>
      finish(() => (m.error !== undefined ? reject(new Error(m.error)) : resolve(m.text ?? 'No matches')))
    )
    worker.on('error', (e) => finish(() => reject(e)))
    worker.on('exit', (code) => finish(() => reject(new Error(`Search failed (worker exited with code ${code})`))))
  })
}
