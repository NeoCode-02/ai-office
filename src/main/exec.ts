import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { Sandbox } from '../shared/types'

/** Longest tool output (characters) a model gets back. */
export const MAX_OUT = 20_000
export const clip = (s: string, n = MAX_OUT) => (s.length > n ? s.slice(0, n) + `\n…[${s.length - n} more characters truncated]` : s)

const TIMEOUT = 120_000
const DOCKER_TIMEOUT = 600_000
/** After the command exits, how long processes it left in the background may keep its output open. */
const GRACE = 1_000
const DAEMON_DOWN = /connect to the Docker daemon|failed to connect to the docker API|error during connect/i
/** A Docker image reference; a leading "-" would be read as an option of `docker run`. */
const IMAGE = /^[a-z0-9][\w.\-/:@]*$/i

export interface ExecOpts {
  /** Default: 120 s, or 600 s in the Docker sandbox. */
  timeoutMs?: number
  signal?: AbortSignal
  sandbox?: Sandbox
}

export interface ExecResult {
  content: string
  isError: boolean
}

const posixUser = () => (process.getuid && process.getgid ? `${process.getuid()}:${process.getgid()}` : undefined)

/** `docker run` arguments: only the workspace is mounted; the command runs in a login shell. */
export function dockerArgs(root: string, command: string, sandbox: Sandbox, name: string, user = posixUser(), hasGit = fs.existsSync(path.join(root, '.git'))): string[] {
  if (!IMAGE.test(sandbox.image) || sandbox.image.length > 255) throw new Error(`Invalid Docker image name "${sandbox.image}"`)
  // ":" separates the parts of -v; a Windows drive letter is the one place Docker expects it.
  if ((/^[a-z]:[\\/]/i.test(root) ? root.slice(2) : root).includes(':')) throw new Error('The workspace path contains ":", which Docker cannot mount')
  return [
    'run',
    '--rm',
    '--name',
    name,
    '-v',
    `${root}:/workspace`,
    // Read-only, so a sandboxed command can't plant git hooks that later run on the host.
    ...(hasGit ? ['-v', `${path.join(root, '.git')}:/workspace/.git:ro`] : []),
    '-w',
    '/workspace',
    ...(sandbox.network ? [] : ['--network', 'none']),
    // A uid without a passwd entry has no home; tools that write there need one.
    ...(user ? ['--user', user, '-e', 'HOME=/tmp'] : []),
    sandbox.image,
    'sh',
    '-lc',
    command
  ]
}

const running = (child: ChildProcess) => child.exitCode === null && child.signalCode === null

/** Kills the command and everything it started. */
function killTree(child: ChildProcess) {
  const pid = child.pid
  if (pid === undefined) return
  if (process.platform === 'win32') {
    // After exit the pid may already belong to another program.
    if (running(child)) spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {})
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ESRCH' && running(child)) child.kill('SIGKILL')
  }
}

function dockerKill(name: string) {
  spawn('docker', ['kill', name], { stdio: 'ignore', windowsHide: true }).on('error', () => {})
}

const noDocker = (detail: string): ExecResult => ({
  content: `E_NO_DOCKER: Docker is not available (${detail}). Start Docker, or turn off the Docker sandbox in the office settings.`,
  isError: true
})

/** Collects a capped amount of interleaved stdout/stderr without splitting UTF-8 characters. */
function collector() {
  const decoders = { out: new StringDecoder('utf8'), err: new StringDecoder('utf8') }
  let text = ''
  let dropped = 0
  const add = (s: string) => {
    // A little more than MAX_OUT is kept so trimming leading blanks never shortens the result.
    const room = MAX_OUT + 1000 - text.length
    text += s.slice(0, Math.max(0, room))
    dropped += Math.max(0, s.length - Math.max(0, room))
  }
  return {
    add: (from: 'out' | 'err', d: Buffer) => add(decoders[from].write(d)),
    /** Output followed by the status line, which is never clipped away. */
    result(status: string) {
      add(decoders.out.end() + decoders.err.end())
      const body = text.trim()
      const total = body.length + dropped
      const shown = total > MAX_OUT ? body.slice(0, MAX_OUT) + `\n…[${total - MAX_OUT} more characters truncated]` : body
      return shown ? `${shown}\n${status}` : status
    }
  }
}

/**
 * Runs a shell command (or `docker run` in the sandbox) with stdin closed. On timeout or abort the
 * whole process tree is killed. The result ends with `[exit N]`, `[timed out after N s]` or `[stopped]`.
 */
export function exec(command: string, cwd: string, opts: ExecOpts = {}): Promise<ExecResult> {
  const docker = opts.sandbox?.kind === 'docker' ? opts.sandbox : undefined
  const limit = opts.timeoutMs ?? (docker ? DOCKER_TIMEOUT : TIMEOUT)
  const name = `aioffice-${randomBytes(8).toString('hex')}`
  if (opts.signal?.aborted) return Promise.resolve({ content: '[stopped]', isError: true })
  let child: ChildProcess
  try {
    if (!fs.statSync(cwd).isDirectory()) throw new Error(`The workspace "${cwd}" is not a folder`)
    const common: SpawnOptions = { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' }
    child = docker ? spawn('docker', dockerArgs(cwd, command, docker, name), { ...common, shell: false }) : spawn(command, { ...common, shell: true })
  } catch (e) {
    return Promise.resolve({ content: `Error: ${e instanceof Error ? e.message : String(e)}`, isError: true })
  }

  return new Promise((resolve) => {
    const out = collector()
    let stderrHead = ''
    let ended: 'timeout' | 'stopped' | undefined
    let settled = false
    let grace: NodeJS.Timeout | undefined

    const stop = (why: 'timeout' | 'stopped') => {
      if (ended || settled) return
      ended = why
      killTree(child)
      if (docker) dockerKill(name)
    }
    const timer = setTimeout(() => stop('timeout'), limit)
    const onAbort = () => stop('stopped')
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    const finish = (r: ExecResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(grace)
      opts.signal?.removeEventListener('abort', onAbort)
      resolve(r)
    }
    const done = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return
      if (ended === 'timeout') return finish({ content: out.result(`[timed out after ${limit / 1000} s]`), isError: true })
      if (ended === 'stopped') return finish({ content: out.result('[stopped]'), isError: true })
      if (docker && code !== 0 && DAEMON_DOWN.test(stderrHead)) return finish(noDocker(stderrHead.trim().split('\n')[0]))
      finish({ content: out.result(`[exit ${code ?? signal}]`), isError: false })
    }

    child.stdout!.on('data', (d: Buffer) => out.add('out', d))
    child.stderr!.on('data', (d: Buffer) => {
      out.add('err', d)
      if (docker && stderrHead.length < 4000) stderrHead += d.toString()
    })
    child.on('error', (e: NodeJS.ErrnoException) => {
      if (docker && e.code === 'ENOENT') finish(noDocker('the docker command was not found'))
      else finish({ content: `Error: ${e.message}`, isError: true })
    })
    child.on('exit', (code, signal) => {
      // Something it started in the background still holds the output open: stop it and report.
      grace = setTimeout(() => {
        killTree(child)
        child.stdout?.destroy()
        child.stderr?.destroy()
        done(code, signal)
      }, GRACE)
    })
    child.on('close', (code, signal) => done(code, signal))
  })
}
