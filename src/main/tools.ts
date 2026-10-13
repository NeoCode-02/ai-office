import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { ToolName } from '../shared/types'
import type { ToolCall, ToolDef } from './providers'

const str = (description: string) => ({ type: 'string', description })

export const TOOL_DEFS: Record<ToolName, ToolDef> = {
  list_files: {
    name: 'list_files',
    description: 'List files and folders in the shared workspace (recursive, skips node_modules/.git).',
    parameters: { type: 'object', properties: { path: str('Folder relative to the workspace, "." for root') }, required: ['path'] }
  },
  read_file: {
    name: 'read_file',
    description: 'Read a text file from the shared workspace.',
    parameters: { type: 'object', properties: { path: str('File path relative to the workspace') }, required: ['path'] }
  },
  write_file: {
    name: 'write_file',
    description: 'Create or overwrite a text file in the shared workspace. Parent folders are created.',
    parameters: {
      type: 'object',
      properties: { path: str('File path relative to the workspace'), content: str('Full file content') },
      required: ['path', 'content']
    }
  },
  edit_file: {
    name: 'edit_file',
    description: 'Replace one exact, unique occurrence of old_text with new_text in a file. Prefer this over write_file for small changes.',
    parameters: {
      type: 'object',
      properties: { path: str('File path relative to the workspace'), old_text: str('Exact text to replace, must occur once'), new_text: str('Replacement text') },
      required: ['path', 'old_text', 'new_text']
    }
  },
  run_command: {
    name: 'run_command',
    description: 'Run a shell command in the workspace folder (Windows cmd.exe; 2 min timeout). Use for builds, tests, git, scripts.',
    parameters: { type: 'object', properties: { command: str('The command line') }, required: ['command'] }
  },
  message: {
    name: 'message',
    description: 'Send a message to colleagues by name (or "owner" for the human owner, CEO only). This is the ONLY way others see what you say: assign tasks, ask questions, report results, give review feedback.',
    parameters: {
      type: 'object',
      properties: { to: { type: 'array', items: { type: 'string' }, description: 'Recipient names' }, text: str('Message text') },
      required: ['to', 'text']
    }
  },
  remember: {
    name: 'remember',
    description: 'Save a durable lesson about this company/project (convention, decision, pitfall). Shown to you in all future work.',
    parameters: { type: 'object', properties: { note: str('One concise lesson') }, required: ['note'] }
  },
  report_to_user: {
    name: 'report_to_user',
    description: 'CEO only. Final report to the owner once the goal is fully done and verified. Ends the work session.',
    parameters: { type: 'object', properties: { summary: str('What was delivered, where, how it was verified, open issues') }, required: ['summary'] }
  }
}

export interface ToolCtx {
  root: string
  send(to: string[], text: string): string
  remember(note: string): void
  report(summary: string): void
  approve(command: string): Promise<boolean>
}

const MAX_OUT = 20_000
const clip = (s: string, n = MAX_OUT) => (s.length > n ? s.slice(0, n) + `\n…[${s.length - n} belgi qisqartirildi]` : s)

/** Rejects paths that escape the workspace, including through symlinks. */
export function inside(root: string, p: string): string {
  const base = fs.realpathSync(root)
  let target = path.resolve(base, p)
  if (fs.existsSync(target)) target = fs.realpathSync(target)
  const rel = path.relative(base, target)
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    throw new Error(`"${p}" ish papkasidan tashqarida`)
  }
  return target
}

function listTree(dir: string, root: string, out: string[]) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (out.length >= 500) return
    if (e.name === 'node_modules' || e.name === '.git') continue
    const full = path.join(dir, e.name)
    out.push(path.relative(root, full).replaceAll('\\', '/') + (e.isDirectory() ? '/' : ''))
    if (e.isDirectory()) listTree(full, root, out)
  }
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
    child.on('error', (e) => resolve(`Xato: ${e.message}`))
    child.on('close', (code, signal) =>
      resolve(clip(`${out}\n[exit ${code ?? signal}]`.trim()))
    )
  })
}

/** Runs one call; failures come back as error results so the agent can recover. */
export async function runTool(
  call: ToolCall,
  allowed: ToolName[],
  ctx: ToolCtx
): Promise<{ content: string; isError: boolean }> {
  const def = TOOL_DEFS[call.name as ToolName]
  if (!def || !allowed.includes(def.name as ToolName)) {
    return { content: `"${call.name}" asbobi sizga berilmagan`, isError: true }
  }
  const a = call.input
  for (const k of def.parameters.required) {
    const bad = k === 'to' ? !Array.isArray(a.to) : typeof a[k] !== 'string'
    if (bad) return { content: `Noto‘g‘ri argument: "${k}" kerak`, isError: true }
  }
  const s = (k: string) => a[k] as string

  try {
    switch (def.name as ToolName) {
      case 'list_files': {
        const out: string[] = []
        listTree(inside(ctx.root, s('path')), fs.realpathSync(ctx.root), out)
        return { content: out.join('\n') || '(bo‘sh)', isError: false }
      }
      case 'read_file':
        return { content: clip(fs.readFileSync(inside(ctx.root, s('path')), 'utf8'), 100_000), isError: false }
      case 'write_file': {
        const f = inside(ctx.root, s('path'))
        fs.mkdirSync(path.dirname(f), { recursive: true })
        fs.writeFileSync(f, s('content'))
        return { content: `Yozildi: ${s('path')}`, isError: false }
      }
      case 'edit_file': {
        const f = inside(ctx.root, s('path'))
        const text = fs.readFileSync(f, 'utf8')
        const n = text.split(s('old_text')).length - 1
        if (n !== 1) return { content: `old_text ${n} marta topildi, aynan 1 bo‘lishi kerak`, isError: true }
        fs.writeFileSync(f, text.replace(s('old_text'), () => s('new_text')))
        return { content: `Tahrirlandi: ${s('path')}`, isError: false }
      }
      case 'run_command': {
        if (!(await ctx.approve(s('command')))) return { content: 'Egasi bu buyruqni rad etdi', isError: true }
        return { content: await exec(s('command'), ctx.root), isError: false }
      }
      case 'message': {
        const err = ctx.send((a.to as unknown[]).map(String), s('text'))
        return { content: err || 'Yuborildi', isError: Boolean(err) }
      }
      case 'remember':
        ctx.remember(s('note'))
        return { content: 'Saqlandi', isError: false }
      case 'report_to_user':
        ctx.report(s('summary'))
        return { content: 'Hisobot egaga yuborildi', isError: false }
    }
  } catch (e) {
    return { content: e instanceof Error ? e.message : String(e), isError: true }
  }
  return { content: 'Noma’lum asbob', isError: true }
}
