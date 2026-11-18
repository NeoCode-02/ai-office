import fs from 'node:fs'
import path from 'node:path'
import type { Sandbox, ToolName } from '../shared/types'
import { unifiedDiff } from './diff'
import { clip, exec } from './exec'
import { webFetch } from './fetch'
import type { Media, ToolCall, ToolDef } from './providers'
import { searchFiles } from './search'

export { clip } from './exec'
export { htmlToText, webFetch } from './fetch'

const str = (description: string) => ({ type: 'string', description })
const params = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object' as const, properties, required })

export const TOOL_DEFS: Record<ToolName, ToolDef> = {
  list_files: {
    name: 'list_files',
    description:
      'List files and folders in the shared workspace (recursive, up to 500 entries, skips node_modules/.git). Folders end with "/", symbolic links with "@" (links are not followed).',
    parameters: params({ path: str('Folder relative to the workspace, "." for root') }, ['path'])
  },
  read_file: {
    name: 'read_file',
    description: 'Read a file from the shared workspace (up to 5 MB; for bigger text files use search_files on the file). Images (png, jpg, gif, webp) and PDFs are shown to you as they are, so you can look at them.',
    parameters: params({ path: str('File path relative to the workspace') }, ['path'])
  },
  search_files: {
    name: 'search_files',
    description:
      'Search file contents with a regular expression (case-insensitive) in a folder or in one file. Returns path:line: text for each match (up to 200). Skips node_modules, .git, symbolic links, binary files and, in folders, files over 1 MB.',
    parameters: params({ pattern: str('Regular expression'), path: str('Folder or file to search, "." for the whole workspace') }, ['pattern', 'path'])
  },
  write_file: {
    name: 'write_file',
    description: 'Create or overwrite a text file in the shared workspace. Parent folders are created. Files inside .git cannot be written.',
    parameters: params({ path: str('File path relative to the workspace'), content: str('Full file content') }, ['path', 'content'])
  },
  edit_file: {
    name: 'edit_file',
    description: 'Replace one exact, unique occurrence of old_text with new_text in a file. Prefer this over write_file for small changes.',
    parameters: params(
      { path: str('File path relative to the workspace'), old_text: str('Exact text to replace, must occur once'), new_text: str('Replacement text') },
      ['path', 'old_text', 'new_text']
    )
  },
  run_command: {
    name: 'run_command',
    description: `Run a shell command in the workspace folder (${process.platform === 'win32' ? 'Windows cmd.exe' : 'sh'}). It is stopped after 2 minutes (10 minutes in the Docker sandbox). Input is closed, so commands must not wait for answers. When it ends, is stopped or times out, the processes it started are ended where possible, but programs that detach themselves (daemons, setsid) may keep running. Use for builds, tests, git, scripts.`,
    parameters: params({ command: str('The command line') }, ['command'])
  },
  web_fetch: {
    name: 'web_fetch',
    description:
      'Download a web page or file over http(s) and return its text (HTML is converted to plain text, at most 2 MB is read). The owner may have to allow the host first. Use for documentation, APIs, references.',
    parameters: params({ url: str('Full http:// or https:// URL') }, ['url'])
  },
  message: {
    name: 'message',
    description:
      'Send a message to colleagues by name (or "owner" for the human owner, CEO only). This is the ONLY way others see what you say: assign tasks, ask questions, report results, give review feedback.',
    parameters: params({ to: { type: 'array', items: { type: 'string' }, description: 'Recipient names' }, text: str('Message text') }, ['to', 'text'])
  },
  remember: {
    name: 'remember',
    description: 'Save a durable lesson about this company/project (convention, decision, pitfall). Shown to you in all future work.',
    parameters: params({ note: str('One concise lesson') }, ['note'])
  },
  use_skill: {
    name: 'use_skill',
    description: 'Load the full instructions of a skill listed in your system prompt. Do this before doing work the skill covers.',
    parameters: params({ name: str('Skill name') }, ['name'])
  },
  read_skill_file: {
    name: 'read_skill_file',
    description: 'Read an extra file bundled with a skill (templates, references) when its instructions point to one.',
    parameters: params({ name: str('Skill name'), path: str('File path inside the skill folder') }, ['name', 'path'])
  },
  report_to_user: {
    name: 'report_to_user',
    description: 'CEO only. Final report to the owner once the goal is fully done and verified. Ends the work session.',
    parameters: params({ summary: str('What was delivered, where, how it was verified, open issues') }, ['summary'])
  },
  propose_plan: {
    name: 'propose_plan',
    description:
      'CEO only, when the owner wants to approve a plan first. Send the plan (steps, who does what, deliverables, how it will be verified). Then end your turn and wait: you cannot delegate or change files until the owner approves.',
    parameters: params({ text: str('The plan') }, ['text'])
  }
}

export interface ToolCtx {
  root: string
  send(to: string[], text: string): string
  remember(note: string): void
  report(summary: string): void
  /** propose_plan; returns the text the model gets back. */
  plan?(text: string): string
  approve(command: string): Promise<boolean>
  skill(name: string): { body: string; dir?: string } | undefined
  /** Stops a running command, search or download. */
  signal?: AbortSignal
  /** Where run_command executes; missing = on this computer. */
  sandbox?: Sandbox
  /** Asked before web_fetch opens a host; missing = this computer and the local network are refused, other hosts allowed. */
  approveFetch?(url: string): Promise<boolean>
}

/**
 * diff: unified diff of a write_file / edit_file; changed: the file, workspace-relative with "/";
 * media: an image or PDF that read_file hands to the model itself.
 */
export interface ToolOutcome {
  content: string
  isError: boolean
  diff?: string
  changed?: string
  media?: Media
}

const MAX_READ = 5 * 1024 * 1024
const MAX_LIST = 500
const GIT_ONLY = 'Writing inside .git is not allowed; use git commands with run_command'
/** ".git" as Windows also accepts it: trailing dots/spaces, an NTFS stream suffix, the 8.3 short name. */
const GIT_SEGMENT = /^(\.git[. ]*(:.*)?|git~\d+)$/i

const isMissing = (e: unknown) => ['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? '')

/** Where `p` really points: symlinks resolved, including in the part of the path that does not exist yet. */
function realTarget(p: string, depth = 0): string {
  try {
    return fs.realpathSync(p)
  } catch (e) {
    if (!isMissing(e)) throw e
  }
  let st: fs.Stats | undefined
  try {
    st = fs.lstatSync(p)
  } catch (e) {
    if (!isMissing(e)) throw e
  }
  // A link to something missing: writing through it would create its target.
  if (st?.isSymbolicLink()) {
    if (depth > 40) throw new Error(`Too many symbolic links in "${p}"`)
    return realTarget(path.resolve(path.dirname(p), fs.readlinkSync(p)), depth + 1)
  }
  const parent = path.dirname(p)
  return parent === p ? p : path.join(realTarget(parent, depth), path.basename(p))
}

function resolveIn(root: string, p: string): { base: string; target: string } {
  if (p.includes('\0') || root.includes('\0')) throw new Error('Invalid path: it contains a NUL character')
  const base = fs.realpathSync(root)
  const target = realTarget(path.resolve(base, p))
  const r = path.relative(base, target)
  if (r === '..' || r.startsWith('..' + path.sep) || path.isAbsolute(r)) {
    throw new Error(`"${p}" is outside the allowed folder`)
  }
  return { base, target }
}

/** Rejects paths that escape `root`, including through symlinks (also in not-yet-existing parts). */
export function inside(root: string, p: string): string {
  return resolveIn(root, p).target
}

const rel = (root: string, f: string) => path.relative(root, f).replaceAll('\\', '/')

/** A file the agents may write: inside the workspace and not inside any .git folder. */
function writable(root: string, p: string): { file: string; changed: string } {
  const { base, target } = resolveIn(root, p)
  const r = path.relative(base, target)
  if (r.split(/[\\/]/).some((s) => GIT_SEGMENT.test(s))) throw new Error(GIT_ONLY)
  return { file: target, changed: rel(base, target) }
}

/** Never follows symbolic links: they are reported to `visit` but not entered. */
function walk(dir: string, visit: (full: string, e: fs.Dirent) => boolean): boolean {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return true
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.toLowerCase() === '.git') continue
    const full = path.join(dir, e.name)
    if (!visit(full, e)) return false
    if (e.isDirectory() && !e.isSymbolicLink() && !walk(full, visit)) return false
  }
  return true
}

function listTree(dir: string, root: string, links: boolean): string[] {
  if (!fs.statSync(dir).isDirectory()) throw new Error(`"${rel(root, dir) || '.'}" is a file, not a folder; use read_file`)
  const out: string[] = []
  const complete = walk(dir, (full, e) => {
    if (e.isSymbolicLink() && !links) return true
    if (out.length >= MAX_LIST) return false
    out.push(rel(root, full) + (e.isSymbolicLink() ? '@' : e.isDirectory() ? '/' : ''))
    return true
  })
  if (!complete) out.push(`… more entries not shown; list a subfolder`)
  return out
}

type Text = { text: string; size: number } | { binary: true; size: number }

// Not on Windows (0 there). NOFOLLOW: a link swapped in after the path check is refused, not followed.
// NONBLOCK: opening a FIFO returns at once instead of freezing the app.
const { O_RDONLY, O_WRONLY, O_CREAT, O_TRUNC } = fs.constants
const SAFE = (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0)

/** Opens only regular files; checked on the open descriptor, so the check can't be raced. */
function openRegular(f: string, flags: number): number {
  const fd = fs.openSync(f, flags | SAFE)
  const st = fs.fstatSync(fd)
  if (st.isFile()) return fd
  fs.closeSync(fd)
  throw new Error(st.isDirectory() ? 'This is a folder; use list_files' : 'This is not a regular file')
}

/** A regular file's bytes, up to MAX_READ. */
function readBytes(f: string): Buffer {
  const fd = openRegular(f, O_RDONLY)
  try {
    const size = fs.fstatSync(fd).size
    if (size > MAX_READ) {
      throw new Error(`The file is too large to read (${(size / 1024 / 1024).toFixed(1)} MB, limit 5 MB); use search_files on it to find the lines you need`)
    }
    return fs.readFileSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

/** A regular file's text; binary files (NUL in the first 8 KB) are not decoded. */
function readText(f: string): Text {
  const buf = readBytes(f)
  if (buf.subarray(0, 8192).includes(0)) return { binary: true, size: buf.length }
  return { text: buf.toString('utf8'), size: buf.length }
}

/** Files read_file hands to the model itself rather than as text. */
const MEDIA: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf'
}

/** Writes a regular file; refuses FIFOs, devices and folders instead of blocking on them. */
function writeRegular(f: string, content: string) {
  let st: fs.Stats | undefined
  try {
    st = fs.lstatSync(f)
  } catch (e) {
    if (!isMissing(e)) throw e
  }
  if (st && !st.isFile()) throw new Error(st.isDirectory() ? 'This is a folder, not a file' : 'This is not a regular file')
  const fd = openRegular(f, O_WRONLY | O_CREAT | O_TRUNC)
  try {
    fs.writeFileSync(fd, content)
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Commands and file tools never overlap in one workspace: a command could swap a folder for a
 * symlink between a file tool's path check and its open. Commands may overlap each other.
 */
const gates = new Map<string, { commands: number; waiting: (() => void)[] }>()
const gateOf = (root: string) => gates.get(root) ?? gates.set(root, { commands: 0, waiting: [] }).get(root)!

async function noCommandRunning(root: string) {
  const g = gateOf(root)
  while (g.commands > 0) await new Promise<void>((resolve) => g.waiting.push(resolve))
}

async function asCommand<T>(root: string, run: () => Promise<T>): Promise<T> {
  const g = gateOf(root)
  g.commands++
  try {
    return await run()
  } finally {
    g.commands--
    if (g.commands === 0) for (const resolve of g.waiting.splice(0)) resolve()
  }
}

const FILE_TOOLS = new Set<string>(['list_files', 'read_file', 'write_file', 'edit_file'])

const shown = (t: Text) => ('binary' in t ? `binary file, ${t.size} bytes` : clip(t.text, 100_000))

/** The current text of a file about to be overwritten, for the diff; undefined when it cannot be shown. */
function previous(f: string): string | undefined {
  try {
    const t = readText(f)
    return 'binary' in t ? undefined : t.text
  } catch (e) {
    return isMissing(e) ? '' : undefined
  }
}

const ok = (content: string): ToolOutcome => ({ content, isError: false })
const fail = (content: string): ToolOutcome => ({ content, isError: true })

/** Runs one built-in call; failures come back as error results so the agent can recover. */
export async function runTool(call: ToolCall, allowed: ToolName[], ctx: ToolCtx): Promise<ToolOutcome> {
  const def = TOOL_DEFS[call.name as ToolName]
  if (!def || !allowed.includes(def.name as ToolName)) return fail(`Tool "${call.name}" is not available to you`)
  const a = call.input
  for (const k of def.parameters.required) {
    const bad = k === 'to' ? !Array.isArray(a.to) : typeof a[k] !== 'string'
    if (bad) return fail(`Invalid arguments: "${k}" is required`)
  }
  const s = (k: string) => a[k] as string

  try {
    const gate = fs.realpathSync(ctx.root)
    // The bodies below are synchronous, so no command can start while one runs.
    if (FILE_TOOLS.has(def.name)) await noCommandRunning(gate)
    switch (def.name as ToolName) {
      case 'list_files': {
        const { base, target } = resolveIn(ctx.root, s('path'))
        return ok(listTree(target, base, true).join('\n') || '(empty)')
      }
      case 'read_file': {
        const f = inside(ctx.root, s('path'))
        const mime = MEDIA[path.extname(f).toLowerCase()]
        if (!mime) return ok(shown(readText(f)))
        const data = readBytes(f)
        return { ...ok(`${s('path')} (${mime}, ${data.length} bytes) is shown to you below.`), media: { mime, name: path.basename(f), data: data.toString('base64') } }
      }
      case 'search_files': {
        const { base, target } = resolveIn(ctx.root, s('path'))
        return ok(await searchFiles(base, target, s('pattern'), { signal: ctx.signal }))
      }
      case 'write_file': {
        const { file, changed } = writable(ctx.root, s('path'))
        const before = previous(file)
        fs.mkdirSync(path.dirname(file), { recursive: true })
        writeRegular(file, s('content'))
        return { ...ok(`Wrote ${s('path')}`), changed, diff: before === undefined ? undefined : unifiedDiff(changed, before, s('content')) }
      }
      case 'edit_file': {
        const { file, changed } = writable(ctx.root, s('path'))
        const t = readText(file)
        if ('binary' in t) return fail('This is a binary file; it cannot be edited as text')
        if (!s('old_text')) return fail('old_text must not be empty')
        const n = t.text.split(s('old_text')).length - 1
        if (n !== 1) return fail(`old_text found ${n} times; it must match exactly once`)
        const after = t.text.replace(s('old_text'), () => s('new_text'))
        writeRegular(file, after)
        return { ...ok(`Edited ${s('path')}`), changed, diff: unifiedDiff(changed, t.text, after) }
      }
      case 'run_command':
        if (!(await ctx.approve(s('command')))) return fail('The owner declined this command')
        return await asCommand(gate, () => exec(s('command'), ctx.root, { signal: ctx.signal, sandbox: ctx.sandbox }))
      case 'web_fetch': {
        const ask = ctx.approveFetch && ((url: string) => ctx.approveFetch!(url))
        return ok(await webFetch(s('url'), { signal: ctx.signal, approveLocal: ask, approvePublic: ask }))
      }
      case 'message': {
        const err = ctx.send((a.to as unknown[]).map(String), s('text'))
        return err ? fail(err) : ok('Sent')
      }
      case 'remember':
        ctx.remember(s('note'))
        return ok('Saved')
      case 'use_skill': {
        const sk = ctx.skill(s('name'))
        if (!sk) return fail(`No skill named "${s('name')}"`)
        const files = sk.dir ? listTree(sk.dir, sk.dir, false).filter((f) => f !== 'SKILL.md') : []
        return ok(sk.body + (files.length ? `\n\nFiles in this skill (read_skill_file):\n${files.join('\n')}` : ''))
      }
      case 'read_skill_file': {
        const sk = ctx.skill(s('name'))
        if (!sk?.dir) return fail(`Skill "${s('name')}" has no files`)
        return ok(shown(readText(inside(sk.dir, s('path')))))
      }
      case 'report_to_user':
        ctx.report(s('summary'))
        return ok('Report delivered to the owner')
      case 'propose_plan':
        return ctx.plan ? ok(ctx.plan(s('text'))) : fail('Plans are not used in this office')
    }
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  }
  return fail('Unknown tool')
}
