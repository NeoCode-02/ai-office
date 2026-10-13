import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { ToolName } from '../shared/types'
import type { ToolCall, ToolDef } from './providers'

const str = (description: string) => ({ type: 'string', description })
const params = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object' as const, properties, required })

export const TOOL_DEFS: Record<ToolName, ToolDef> = {
  list_files: {
    name: 'list_files',
    description: 'List files and folders in the shared workspace (recursive, skips node_modules/.git).',
    parameters: params({ path: str('Folder relative to the workspace, "." for root') }, ['path'])
  },
  read_file: {
    name: 'read_file',
    description: 'Read a text file from the shared workspace.',
    parameters: params({ path: str('File path relative to the workspace') }, ['path'])
  },
  search_files: {
    name: 'search_files',
    description: 'Search file contents in the workspace with a regular expression (case-insensitive). Returns path:line: text for each match.',
    parameters: params({ pattern: str('Regular expression'), path: str('Folder to search, "." for the whole workspace') }, ['pattern', 'path'])
  },
  write_file: {
    name: 'write_file',
    description: 'Create or overwrite a text file in the shared workspace. Parent folders are created.',
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
    description: `Run a shell command in the workspace folder (${process.platform === 'win32' ? 'Windows cmd.exe' : 'sh'}; 2 min timeout). Use for builds, tests, git, scripts.`,
    parameters: params({ command: str('The command line') }, ['command'])
  },
  web_fetch: {
    name: 'web_fetch',
    description: 'Download a web page or file over http(s) and return its text (HTML is converted to plain text). Use for documentation, APIs, references.',
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
}

const MAX_OUT = 20_000
const clip = (s: string, n = MAX_OUT) => (s.length > n ? s.slice(0, n) + `\n…[${s.length - n} more characters truncated]` : s)

/** Rejects paths that escape `root`, including through symlinks. */
export function inside(root: string, p: string): string {
  const base = fs.realpathSync(root)
  let target = path.resolve(base, p)
  if (fs.existsSync(target)) target = fs.realpathSync(target)
  const rel = path.relative(base, target)
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    throw new Error(`"${p}" is outside the allowed folder`)
  }
  return target
}

function walk(dir: string, visit: (full: string, isDir: boolean) => boolean) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue
    const full = path.join(dir, e.name)
    if (!visit(full, e.isDirectory())) return false
    if (e.isDirectory() && walk(full, visit) === false) return false
  }
}

const rel = (root: string, f: string) => path.relative(root, f).replaceAll('\\', '/')

function listTree(dir: string, root: string): string[] {
  const out: string[] = []
  walk(dir, (full, isDir) => {
    out.push(rel(root, full) + (isDir ? '/' : ''))
    return out.length < 500
  })
  return out
}

function search(root: string, dir: string, pattern: string): string {
  const re = new RegExp(pattern, 'i')
  const hits: string[] = []
  walk(dir, (full, isDir) => {
    if (isDir || fs.statSync(full).size > 1_000_000) return true
    const text = fs.readFileSync(full, 'utf8')
    if (text.includes('\0')) return true
    const lines = text.split('\n')
    for (let i = 0; i < lines.length && hits.length < 200; i++) {
      if (re.test(lines[i])) hits.push(`${rel(root, full)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`)
    }
    return hits.length < 200
  })
  return hits.join('\n') || 'No matches'
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

export async function webFetch(url: string): Promise<string> {
  const u = new URL(url)
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http and https URLs are allowed')
  const res = await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(20_000), headers: { 'User-Agent': 'AI-Office' } })
  const type = res.headers.get('content-type') ?? ''
  if (!/text|json|xml|javascript/.test(type)) return `HTTP ${res.status}, ${type || 'unknown type'}: binary content not shown`
  const body = await res.text()
  return clip(`HTTP ${res.status}\n\n${type.includes('html') ? htmlToText(body) : body}`, 100_000)
}

function exec(command: string, cwd: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, timeout: 120_000, windowsHide: true })
    let out = ''
    const add = (d: Buffer) => {
      if (out.length < MAX_OUT * 2) out += d.toString()
    }
    child.stdout.on('data', add)
    child.stderr.on('data', add)
    child.on('error', (e) => resolve(`Error: ${e.message}`))
    child.on('close', (code, signal) => resolve(clip(`${out}\n[exit ${code ?? signal}]`.trim())))
  })
}

const ok = (content: string) => ({ content, isError: false })
const fail = (content: string) => ({ content, isError: true })

/** Runs one built-in call; failures come back as error results so the agent can recover. */
export async function runTool(call: ToolCall, allowed: ToolName[], ctx: ToolCtx): Promise<{ content: string; isError: boolean }> {
  const def = TOOL_DEFS[call.name as ToolName]
  if (!def || !allowed.includes(def.name as ToolName)) return fail(`Tool "${call.name}" is not available to you`)
  const a = call.input
  for (const k of def.parameters.required) {
    const bad = k === 'to' ? !Array.isArray(a.to) : typeof a[k] !== 'string'
    if (bad) return fail(`Invalid arguments: "${k}" is required`)
  }
  const s = (k: string) => a[k] as string

  try {
    switch (def.name as ToolName) {
      case 'list_files':
        return ok(listTree(inside(ctx.root, s('path')), fs.realpathSync(ctx.root)).join('\n') || '(empty)')
      case 'read_file':
        return ok(clip(fs.readFileSync(inside(ctx.root, s('path')), 'utf8'), 100_000))
      case 'search_files':
        return ok(search(fs.realpathSync(ctx.root), inside(ctx.root, s('path')), s('pattern')))
      case 'write_file': {
        const f = inside(ctx.root, s('path'))
        fs.mkdirSync(path.dirname(f), { recursive: true })
        fs.writeFileSync(f, s('content'))
        return ok(`Wrote ${s('path')}`)
      }
      case 'edit_file': {
        const f = inside(ctx.root, s('path'))
        const text = fs.readFileSync(f, 'utf8')
        const n = text.split(s('old_text')).length - 1
        if (n !== 1) return fail(`old_text found ${n} times; it must match exactly once`)
        fs.writeFileSync(f, text.replace(s('old_text'), () => s('new_text')))
        return ok(`Edited ${s('path')}`)
      }
      case 'run_command':
        if (!(await ctx.approve(s('command')))) return fail('The owner declined this command')
        return ok(await exec(s('command'), ctx.root))
      case 'web_fetch':
        return ok(await webFetch(s('url')))
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
        const files = sk.dir ? listTree(sk.dir, sk.dir).filter((f) => f !== 'SKILL.md') : []
        return ok(sk.body + (files.length ? `\n\nFiles in this skill (read_skill_file):\n${files.join('\n')}` : ''))
      }
      case 'read_skill_file': {
        const sk = ctx.skill(s('name'))
        if (!sk?.dir) return fail(`Skill "${s('name')}" has no files`)
        return ok(clip(fs.readFileSync(inside(sk.dir, s('path')), 'utf8'), 100_000))
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
