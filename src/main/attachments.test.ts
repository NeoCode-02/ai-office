import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { attach } from './attachments'

const tmp = (p: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)))

describe('attach', () => {
  it('copies files into attachments/ and never overwrites one already there', () => {
    const ws = tmp('ws-')
    const src = tmp('src-')
    fs.writeFileSync(path.join(src, 'notes.md'), 'one')
    expect(attach(ws, [path.join(src, 'notes.md')])).toEqual(['attachments/notes.md'])
    fs.writeFileSync(path.join(src, 'notes.md'), 'two')
    expect(attach(ws, [path.join(src, 'notes.md'), path.join(src, 'notes.md')])).toEqual(['attachments/notes (2).md', 'attachments/notes (3).md'])
    expect(fs.readFileSync(path.join(ws, 'attachments', 'notes.md'), 'utf8')).toBe('one')
    expect(fs.readFileSync(path.join(ws, 'attachments', 'notes (2).md'), 'utf8')).toBe('two')
  })

  it('refuses folders and missing files before copying anything', () => {
    const ws = tmp('ws-')
    const src = tmp('src-')
    fs.writeFileSync(path.join(src, 'ok.txt'), 'x')
    expect(() => attach(ws, [path.join(src, 'ok.txt'), src])).toThrow(/^E_ATTACH_NOT_FILE\|/)
    expect(() => attach(ws, [path.join(src, 'gone.txt')])).toThrow('E_ATTACH_NOT_FILE|gone.txt')
    expect(fs.existsSync(path.join(ws, 'attachments'))).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('refuses an attachments folder that links out of the workspace', () => {
    const ws = tmp('ws-')
    const outside = tmp('out-')
    const src = tmp('src-')
    fs.writeFileSync(path.join(src, 'a.txt'), 'x')
    fs.symlinkSync(outside, path.join(ws, 'attachments'))
    expect(() => attach(ws, [path.join(src, 'a.txt')])).toThrow(/outside/)
    expect(fs.readdirSync(outside)).toEqual([])
  })
})
