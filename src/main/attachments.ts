import fs from 'node:fs'
import path from 'node:path'
import { inside } from './tools'

const DIR = 'attachments'
export const MAX_ATTACHMENT = 50 * 1024 * 1024

/** "name.ext", or "name (2).ext" … when that is taken. */
function freeName(dir: string, base: string): string {
  const ext = path.extname(base)
  const stem = base.slice(0, base.length - ext.length)
  for (let i = 1; ; i++) {
    const name = i === 1 ? base : `${stem} (${i})${ext}`
    if (!fs.existsSync(path.join(dir, name))) return name
  }
}

/**
 * Copies the owner's files into <workspace>/attachments, where the team can open them, and returns
 * their workspace paths ("attachments/a.png"). All are checked before any is copied.
 * Throws E_ATTACH_NOT_FILE|name or E_ATTACH_TOO_BIG|name.
 */
export function attach(workspace: string, files: string[]): string[] {
  for (const src of files) {
    const st = fs.statSync(src, { throwIfNoEntry: false })
    if (!st?.isFile()) throw new Error(`E_ATTACH_NOT_FILE|${path.basename(src)}`)
    if (st.size > MAX_ATTACHMENT) throw new Error(`E_ATTACH_TOO_BIG|${path.basename(src)}`)
  }
  // Resolved like the team's own file tools: a link that leads out of the workspace is refused.
  const dir = inside(workspace, DIR)
  fs.mkdirSync(dir, { recursive: true })
  return files.map((src) => {
    const name = freeName(dir, path.basename(src))
    fs.copyFileSync(src, path.join(dir, name), fs.constants.COPYFILE_EXCL)
    return `${DIR}/${name}`
  })
}
