import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { FileChange, RunChanges } from '../shared/types'
import { isId } from './validate'

/**
 * Workspace snapshots in a shadow Git repository per office (<dataDir>/checkpoints/<projectId>.git),
 * so a task's changes can be listed, diffed and undone without touching the user's own repository.
 */

const TIMEOUT = 60_000
/** The exact file count runs only when the quick walk found too many files; a giant tree must not hang the start. */
const COUNT_TIMEOUT = 20_000
const MAX_FILES = 20_000
const MAX_DIFF_LINES = 2000
const KEEP = 64 * 1024 * 1024
const DIFF_KEEP = 2 * 1024 * 1024
const BASE_EXCLUDE = 'node_modules/\n'
/** Highest-precedence attributes: no line-ending conversion or filters, so a restore is byte-exact. */
const ATTRIBUTES = '* -text -filter -ident -working-tree-encoding\n'
const IDENTITY = { GIT_AUTHOR_NAME: 'AI Office', GIT_AUTHOR_EMAIL: 'ai-office@localhost', GIT_COMMITTER_NAME: 'AI Office', GIT_COMMITTER_EMAIL: 'ai-office@localhost' }

interface Result {
  code: number
  out: Buffer
  err: string
  /** Newlines in the whole output, also past `keep`. */
  lines: number
  truncated: boolean
  timedOut: boolean
}
interface RunOpts {
  cwd: string
  env: NodeJS.ProcessEnv
  input?: string
  timeout?: number
  /** Bytes of stdout to keep; the rest is read and counted, not stored. */
  keep?: number
}

const fail = (code: string) => new Error(code)
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Never a shell: arguments go to git as they are. */
function run(bin: string, args: string[], o: RunOpts): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const keep = o.keep ?? KEEP
    const chunks: Buffer[] = []
    let kept = 0
    let lines = 0
    let truncated = false
    let timedOut = false
    let err = ''
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, o.timeout ?? TIMEOUT)
    child.stdout.on('data', (d: Buffer) => {
      for (let i = d.indexOf(10); i !== -1; i = d.indexOf(10, i + 1)) lines++
      if (kept + d.length <= keep) {
        chunks.push(d)
        kept += d.length
      } else {
        if (kept < keep) chunks.push(d.subarray(0, keep - kept))
        kept = keep
        truncated = true
      }
    })
    child.stderr.on('data', (d: Buffer) => {
      if (err.length < 65_536) err += d.toString()
    })
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      // A missing working folder is reported as ENOENT too.
      reject(e.code !== 'ENOENT' ? fail(`E_GIT|${e.message}`) : isDir(o.cwd) ? fail('E_NO_GIT') : fail('E_NO_WORKSPACE'))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, out: Buffer.concat(chunks), err, lines, truncated, timedOut })
    })
    // git may exit before it reads all of its input
    child.stdin.on('error', () => {})
    child.stdin.end(o.input ?? '')
  })
}

function gitError(r: Result): Error {
  if (r.timedOut) return fail(`E_GIT|no answer after ${TIMEOUT / 1000} s`)
  const text = r.err || r.out.subarray(0, 4096).toString()
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const line = lines.find((l) => /^(fatal|error):/i.test(l)) ?? lines[0] ?? `exit ${r.code}`
  return fail(`E_GIT|${line.slice(0, 300)}`)
}

/** Inherited GIT_DIR, GIT_INDEX_FILE, … would point git at another repository. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (!/^GIT_/i.test(k)) env[k] = v
  env.GIT_TERMINAL_PROMPT = '0'
  return env
}

const paths = (b: Buffer) => b.toString('utf8').split('\0').filter(Boolean)
const isDir = (p: string) => fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() === true

function within(base: string, target: string): boolean {
  const fold = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p)
  const rel = path.relative(fold(base), fold(target))
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel))
}

/** A workspace-relative path as git prints it (forward slashes); null for anything that could leave the workspace. */
export function cleanPath(p: unknown): string | null {
  if (typeof p !== 'string' || !p || p.length > 4096 || p.includes('\0')) return null
  if (path.isAbsolute(p) || path.win32.isAbsolute(p) || p.startsWith('/') || p.startsWith('\\')) return null
  const parts = p.split('/')
  if (parts.some((x) => x === '' || x === '.' || x.split('\\').includes('..'))) return null
  return p
}

/** Anchored gitignore pattern matching exactly this path (a trailing "/" means a folder). */
const pattern = (p: string) => '/' + p.replace(/[\\*?[\] ]/g, '\\$&') + '\n'
const patterns = (list: string[]) => list.filter((p) => !/[\r\n]/.test(p)).map(pattern).join('')

/**
 * `ls-files -i --directory` lists a folder that merely holds ignored files and then those files;
 * only folders listed without contents are ignored as a whole.
 */
function ignoredSet(entries: string[]): string[] {
  const holders = new Set<string>()
  for (const e of entries) {
    for (let i = e.indexOf('/'); i !== -1 && i < e.length - 1; i = e.indexOf('/', i + 1)) holders.add(e.slice(0, i + 1))
  }
  return entries.filter((e) => !holders.has(e))
}

/** Files under `dir` without node_modules/.git and without following symlinks; stops past `limit`. */
function quickCount(dir: string, limit: number): number {
  let n = 0
  const stack = [dir]
  while (stack.length && n <= limit) {
    const d = stack.pop()!
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.toLowerCase() === '.git') continue
      if (e.isDirectory()) stack.push(path.join(d, e.name))
      else n++
    }
  }
  return n
}

function parseChanges(raw: Buffer, numstat: Buffer): FileChange[] {
  const counts = new Map<string, { additions: number; deletions: number; binary: boolean }>()
  for (const rec of numstat.toString('utf8').split('\0')) {
    const a = rec.indexOf('\t')
    const b = rec.indexOf('\t', a + 1)
    if (a < 0 || b < 0) continue
    const add = rec.slice(0, a)
    const del = rec.slice(a + 1, b)
    const prev = counts.get(rec.slice(b + 1))
    const binary = add === '-' || prev?.binary === true
    counts.set(rec.slice(b + 1), { additions: (prev?.additions ?? 0) + (Number(add) || 0), deletions: (prev?.deletions ?? 0) + (Number(del) || 0), binary })
  }
  const t = raw.toString('utf8').split('\0')
  const out: FileChange[] = []
  for (let i = 0; i + 1 < t.length && t[i].startsWith(':'); i += 2) {
    const [srcMode, dstMode, , , status] = t[i].slice(1).split(' ')
    // A folder that is its own repository (gitlink) has no content here to show or restore.
    if (srcMode === '160000' || dstMode === '160000') continue
    const p = t[i + 1]
    const c = counts.get(p) ?? { additions: 0, deletions: 0, binary: false }
    out.push({ path: p, status: status[0] === 'A' ? 'added' : status[0] === 'D' ? 'deleted' : 'modified', ...c })
  }
  return out
}

function clipLines(r: Result): string {
  const text = r.out.toString('utf8')
  if (!r.truncated && r.lines <= MAX_DIFF_LINES) return text
  const complete = text.split('\n').slice(0, r.truncated ? -1 : undefined)
  if (complete.at(-1) === '') complete.pop()
  const shown = complete.slice(0, MAX_DIFF_LINES)
  return `${shown.join('\n')}\n… ${r.lines - shown.length} more lines`
}

/** Throws E_GIT on an exit code outside `ok` (default 0) and on a timeout, unless `allowTimeout`. */
type Git = (args: string[], o?: { input?: string; ok?: number[]; keep?: number; timeout?: number; allowTimeout?: boolean }) => Promise<Result>

export function createCheckpoints(dataDir: string, gitBin = 'git', opts: { maxFiles?: number } = {}) {
  const maxFiles = opts.maxFiles ?? MAX_FILES
  const home = path.join(dataDir, 'checkpoints')
  const hooks = path.join(home, 'no-hooks')
  const queues = new Map<string, Promise<unknown>>()

  const gitDir = (projectId: string) => {
    if (!isId(projectId)) throw fail('E_BAD_ARGS')
    return path.join(home, `${projectId}.git`)
  }
  const meta = (dir: string, runId: string, ext: string) => path.join(dir, 'ai-office', `${runId}.${ext}`)
  const writeMeta = (dir: string, runId: string, ext: string, text: string) => {
    fs.mkdirSync(path.join(dir, 'ai-office'), { recursive: true })
    fs.writeFileSync(meta(dir, runId, ext), text)
  }
  const readMeta = (dir: string, runId: string, ext: string) => {
    try {
      return fs.readFileSync(meta(dir, runId, ext), 'utf8')
    } catch {
      return ''
    }
  }
  const setExcludes = (dir: string, extra: string) => {
    fs.mkdirSync(path.join(dir, 'info'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'info', 'exclude'), BASE_EXCLUDE + extra)
  }

  /** info/exclude is per repository, so one office's operations run one at a time. */
  function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const next = (queues.get(key) ?? Promise.resolve()).then(fn)
    const tail = next.then(
      () => undefined,
      () => undefined
    )
    queues.set(key, tail)
    void tail.then(() => queues.get(key) === tail && queues.delete(key))
    return next
  }

  function workspace(ws: string): string {
    const root = path.resolve(ws)
    if (!isDir(root)) throw fail('E_NO_WORKSPACE')
    return fs.realpathSync(root)
  }

  /** A git bound to the shadow repository and the workspace, with a fresh index of its own. */
  async function withGit<T>(dir: string, root: string, fn: (git: Git) => Promise<T>): Promise<T> {
    const index = path.join(os.tmpdir(), `ai-office-${randomUUID()}.index`)
    const env = { ...cleanEnv(), ...IDENTITY, GIT_INDEX_FILE: index, GIT_LITERAL_PATHSPECS: '1' }
    const base = [
      `--git-dir=${dir}`, `--work-tree=${root}`,
      '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'core.quotepath=false', '-c', 'core.longpaths=true',
      '-c', `core.hooksPath=${hooks}`, '-c', 'commit.gpgsign=false', '-c', 'core.fsmonitor=false'
    ]
    const git: Git = async (args, o = {}) => {
      const r = await run(gitBin, [...base, ...args], { cwd: root, env, input: o.input, keep: o.keep, timeout: o.timeout })
      if (r.timedOut ? !o.allowTimeout : !(o.ok ?? [0]).includes(r.code)) throw gitError(r)
      return r
    }
    try {
      return await fn(git)
    } finally {
      fs.rmSync(index, { force: true })
      fs.rmSync(index + '.lock', { force: true })
    }
  }

  async function ensureRepo(dir: string) {
    if (!fs.existsSync(path.join(dir, 'HEAD'))) {
      fs.mkdirSync(home, { recursive: true })
      const r = await run(gitBin, ['init', '--bare', '-q', dir], { cwd: home, env: cleanEnv() })
      if (r.timedOut || r.code !== 0) throw gitError(r)
    }
    fs.mkdirSync(hooks, { recursive: true })
    fs.mkdirSync(path.join(dir, 'info'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'info', 'attributes'), ATTRIBUTES)
  }

  /**
   * Opens a task's snapshot: excludes = what was ignored when it was taken (so a file the team later
   * un-ignores is never treated as new, and never deleted on undo) plus folders that are now separate
   * repositories (git add refuses those). The index starts as the snapshot.
   */
  async function openRun<T>(projectId: string, runId: string, ws: string, nested: boolean, fn: (git: Git, ref: string, root: string) => Promise<T>): Promise<T> {
    if (!isId(runId)) throw fail('E_NO_CHECKPOINT')
    const dir = gitDir(projectId)
    const root = workspace(ws)
    const ref = `refs/runs/${runId}`
    return withGit(dir, root, async (git) => {
      const found = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { ok: [0, 1, 128] })
      if (found.code !== 0) throw fail(readMeta(dir, runId, 'reason') === 'E_CHECKPOINT_TOO_BIG' ? 'E_CHECKPOINT_TOO_BIG' : 'E_NO_CHECKPOINT')
      const frozen = readMeta(dir, runId, 'exclude')
      setExcludes(dir, frozen)
      await git(['read-tree', ref])
      if (nested) {
        const repos = paths((await git(['ls-files', '-o', '--exclude-standard', '-z'])).out).filter((p) => p.endsWith('/'))
        if (repos.length) setExcludes(dir, frozen + patterns(repos))
      }
      return fn(git, ref, root)
    })
  }

  async function currentChanges(git: Git, ref: string): Promise<FileChange[]> {
    await git(['add', '-A'])
    const flags = ['--cached', '--no-renames', '--no-ext-diff', '--no-color', '-z']
    const raw = await git(['diff', ...flags, '--raw', ref])
    const numstat = await git(['diff', ...flags, '--numstat', ref])
    return parseChanges(raw.out, numstat.out)
  }

  /** Deletes a file the task added; never follows a symlinked folder out of the workspace. */
  function removeAdded(root: string, rel: string) {
    const full = path.join(root, ...rel.split('/'))
    const parent = path.dirname(full)
    if (!within(root, parent)) return
    let real: string
    try {
      real = fs.realpathSync(parent)
    } catch {
      return
    }
    if (!within(root, real)) return
    const st = fs.lstatSync(full, { throwIfNoEntry: false })
    if (!st || st.isDirectory()) return
    fs.unlinkSync(full)
    for (let d = parent; d !== root && within(root, d); d = path.dirname(d)) {
      try {
        fs.rmdirSync(d)
      } catch {
        break
      }
    }
  }

  async function changes(projectId: string, runId: string, workspaceDir: string): Promise<RunChanges> {
    try {
      const files = await serial(projectId, () => openRun(projectId, runId, workspaceDir, true, (git, ref) => currentChanges(git, ref)))
      return { available: true, files }
    } catch (e) {
      const code = message(e)
      if (['E_NO_GIT', 'E_NO_CHECKPOINT', 'E_CHECKPOINT_TOO_BIG', 'E_NO_WORKSPACE', 'E_BAD_ARGS'].includes(code)) {
        return { available: false, reason: code === 'E_BAD_ARGS' ? 'E_NO_CHECKPOINT' : code, files: [] }
      }
      throw e
    }
  }

  return {
    /** Records the workspace as it is now under refs/runs/<runId>. Throws E_NO_GIT, E_CHECKPOINT_TOO_BIG, E_NO_WORKSPACE. */
    async snapshot(projectId: string, runId: string, workspaceDir: string): Promise<void> {
      if (!isId(runId)) throw fail('E_BAD_ARGS')
      const dir = gitDir(projectId)
      return serial(projectId, async () => {
        const root = workspace(workspaceDir)
        // The walk is quick but counts ignored files too; when it finds too many, git counts exactly.
        const big = quickCount(root, maxFiles) > maxFiles
        await ensureRepo(dir)
        await withGit(dir, root, async (git) => {
          setExcludes(dir, '')
          const listed = await git(['ls-files', '-o', '--exclude-standard', '-z'], big ? { timeout: COUNT_TIMEOUT, allowTimeout: true } : {})
          const found = paths(listed.out)
          if (listed.timedOut || found.length > maxFiles) {
            writeMeta(dir, runId, 'reason', 'E_CHECKPOINT_TOO_BIG')
            throw fail('E_CHECKPOINT_TOO_BIG')
          }
          setExcludes(dir, patterns(found.filter((p) => p.endsWith('/'))))
          await git(['add', '-A'])
          const ignored = ignoredSet(paths((await git(['ls-files', '-o', '-i', '--exclude-standard', '--directory', '-z'])).out))
          const tree = (await git(['write-tree'])).out.toString().trim()
          // Plumbing instead of `commit`: HEAD is never moved, so two snapshots can't race on it.
          const commit = (await git(['commit-tree', tree, '-m', runId])).out.toString().trim()
          writeMeta(dir, runId, 'exclude', patterns(ignored))
          await git(['update-ref', `refs/runs/${runId}`, commit])
        })
      })
    },

    /** What changed since the snapshot. Not available (with a reason) instead of throwing for the expected cases. */
    changes,

    /** Unified diff of one file between the snapshot and now, clipped to 2000 lines; '' when unchanged. */
    async diff(projectId: string, runId: string, workspaceDir: string, file: string): Promise<string> {
      const rel = cleanPath(file)
      if (!rel) throw fail('E_BAD_ARGS')
      return serial(projectId, () =>
        openRun(projectId, runId, workspaceDir, false, async (git, ref, root) => {
          const there = fs.lstatSync(path.join(root, ...rel.split('/')), { throwIfNoEntry: false }) !== undefined
          const before = (await git(['cat-file', '-e', `${ref}:${rel}`], { ok: [0, 1, 128] })).code === 0
          if (!there && !before) return ''
          // Exit 1: the path is ignored now and was not in the snapshot, so it is no change of this task.
          await git(['add', '-A', '--', rel], { ok: [0, 1] })
          const r = await git(['diff', '--cached', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', ref, '--', rel], { keep: DIFF_KEEP })
          return clipLines(r)
        })
      )
    },

    /**
     * Puts files back as they were in the snapshot: changed and deleted files are restored, added ones
     * deleted (with folders left empty). Only paths the task changed are touched; `paths` defaults to all.
     */
    async revert(projectId: string, runId: string, workspaceDir: string, paths?: string[]): Promise<void> {
      const wanted = paths?.map(cleanPath)
      if (wanted?.some((p) => p === null)) throw fail('E_BAD_ARGS')
      return serial(projectId, () =>
        openRun(projectId, runId, workspaceDir, true, async (git, ref, root) => {
          const set = wanted && new Set(wanted)
          const files = (await currentChanges(git, ref)).filter((f) => !set || set.has(f.path))
          for (const f of files) if (f.status === 'added') removeAdded(root, f.path)
          const restore = files.filter((f) => f.status !== 'added').map((f) => f.path)
          if (!restore.length) return
          await git(['read-tree', ref])
          // checkout-index takes literal paths and replaces a symlinked folder instead of writing through it.
          await git(['checkout-index', '-f', '-z', '--stdin'], { input: restore.join('\0') + '\0' })
        })
      )
    },

    /** Deletes the office's shadow repository. */
    async remove(projectId: string): Promise<void> {
      const dir = gitDir(projectId)
      return serial(projectId, async () => fs.rmSync(dir, { recursive: true, force: true }))
    },

    commitWorkspace: (workspaceDir: string, message: string) => commitWorkspace(workspaceDir, message, gitBin)
  }
}

export type Checkpoints = ReturnType<typeof createCheckpoints>

/**
 * `git add -A` and `git commit` in the workspace's own repository, with the user's identity and hooks
 * (their repository, their click). Only the workspace folder is staged and committed. Returns the short id.
 */
export async function commitWorkspace(workspaceDir: string, message: string, gitBin = 'git'): Promise<string> {
  const root = path.resolve(workspaceDir)
  if (!isDir(root)) throw fail('E_NO_WORKSPACE')
  const env = cleanEnv()
  const git = async (args: string[], ok = [0]) => {
    const r = await run(gitBin, args, { cwd: root, env })
    if (r.timedOut || !ok.includes(r.code)) throw gitError(r)
    return r
  }
  const inside = await run(gitBin, ['rev-parse', '--is-inside-work-tree'], { cwd: root, env })
  if (inside.code !== 0 || inside.out.toString().trim() !== 'true') throw fail('E_NOT_GIT_REPO')
  const top = (await git(['rev-parse', '--show-toplevel'])).out.toString().trim()
  const topReal = fs.realpathSync(top)
  const wsReal = fs.realpathSync(root)
  if (!within(topReal, wsReal)) throw fail('E_NOT_GIT_REPO')
  await git(['add', '-A', '--', '.'])
  if ((await git(['diff', '--cached', '--quiet', '--no-ext-diff', '--', '.'], [0, 1])).code === 0) throw fail('E_NOTHING_TO_COMMIT')
  const text = message.trim() || 'Changes by AI Office'
  const whole = within(wsReal, topReal)
  // In a subfolder of a bigger repository, `-- .` keeps what the user staged elsewhere out of this commit.
  await git(['commit', '-q', '-m', text, ...(whole ? [] : ['--', '.'])])
  return (await git(['rev-parse', '--short', 'HEAD'])).out.toString().trim()
}
