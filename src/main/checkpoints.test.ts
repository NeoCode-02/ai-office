import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { cleanPath, commitWorkspace, createCheckpoints } from './checkpoints'

const T = 30_000
const posix = process.platform !== 'win32'
const tmp = (p: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)))
const put = (root: string, rel: string, data: string | Buffer) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  fs.writeFileSync(path.join(root, rel), data)
}
const read = (root: string, rel: string) => fs.readFileSync(path.join(root, rel), 'utf8')
const exists = (root: string, rel: string) => fs.lstatSync(path.join(root, rel), { throwIfNoEntry: false }) !== undefined
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Owner', '-c', 'user.email=owner@example.com', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' }).trim()

/** Every entry under `root` except .git folders, with its content: what "the same as the snapshot" means. */
function tree(root: string, skip = '.git'): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === skip) continue
      const full = path.join(dir, e.name)
      const rel = path.relative(root, full).replaceAll('\\', '/')
      if (e.isSymbolicLink()) out[rel] = `-> ${fs.readlinkSync(full)}`
      else if (e.isDirectory()) walk(full)
      else out[rel] = fs.readFileSync(full).toString('base64')
    }
  }
  walk(root)
  return out
}

/** Folder names with spaces and non-ASCII letters, like "Application Support/AI Office" on macOS. */
function setup(opts: { maxFiles?: number; maxBytes?: number } = {}) {
  const data = tmp('cp data (AI Office) ')
  const ws = tmp('cp ishchi papka ü ')
  return { data, ws, cp: createCheckpoints(data, 'git', opts) }
}

describe('checkpoints', () => {
  it('lists, diffs and undoes what a task changed', async () => {
    const { data, ws, cp } = setup()
    const tempIndexes = () => fs.readdirSync(os.tmpdir()).filter((f) => /^ai-office-.*\.index/.test(f))
    const leftover = tempIndexes()
    put(ws, 'README.md', '# Hello\n')
    put(ws, 'src/edit.ts', 'const a = 1\nold line\nconst b = 2\n')
    put(ws, 'src/keep.ts', 'keep\n')
    put(ws, 'docs/old.md', 'one\ntwo\n')
    put(ws, 'space dir/ünï cödé [1].txt', 'before\n')
    const before = tree(ws)
    await cp.snapshot('p1', 'run-1', ws)

    put(ws, 'src/edit.ts', 'const a = 1\nnew line\nconst b = 2\n')
    fs.rmSync(path.join(ws, 'docs/old.md'))
    put(ws, 'new/deep/file.ts', 'x\ny\nz\n')
    put(ws, 'bin.dat', Buffer.from([0, 1, 2, 3, 0, 5]))
    put(ws, 'space dir/ünï cödé [1].txt', 'after\n')

    const c = await cp.changes('p1', 'run-1', ws)
    expect(c).toEqual({
      available: true,
      files: [
        { path: 'bin.dat', status: 'added', additions: 0, deletions: 0, binary: true },
        { path: 'docs/old.md', status: 'deleted', additions: 0, deletions: 2, binary: false },
        { path: 'new/deep/file.ts', status: 'added', additions: 3, deletions: 0, binary: false },
        { path: 'space dir/ünï cödé [1].txt', status: 'modified', additions: 1, deletions: 1, binary: false },
        { path: 'src/edit.ts', status: 'modified', additions: 1, deletions: 1, binary: false }
      ]
    })

    const d = await cp.diff('p1', 'run-1', ws, 'src/edit.ts')
    expect(d).toContain('--- a/src/edit.ts\n+++ b/src/edit.ts\n')
    expect(d).toContain('\n-old line\n+new line\n')
    expect(await cp.diff('p1', 'run-1', ws, 'docs/old.md')).toContain('+++ /dev/null')
    expect(await cp.diff('p1', 'run-1', ws, 'space dir/ünï cödé [1].txt')).toContain('+after')
    expect(await cp.diff('p1', 'run-1', ws, 'src/keep.ts')).toBe('')
    expect(await cp.diff('p1', 'run-1', ws, 'never/existed.txt')).toBe('')

    await cp.revert('p1', 'run-1', ws, ['src/edit.ts', 'not/changed.txt'])
    expect(read(ws, 'src/edit.ts')).toBe('const a = 1\nold line\nconst b = 2\n')
    expect((await cp.changes('p1', 'run-1', ws)).files.map((f) => f.path)).toEqual(['bin.dat', 'docs/old.md', 'new/deep/file.ts', 'space dir/ünï cödé [1].txt'])

    await cp.revert('p1', 'run-1', ws)
    expect(tree(ws)).toEqual(before)
    expect(exists(ws, 'new')).toBe(false)
    expect((await cp.changes('p1', 'run-1', ws)).files).toEqual([])
    // Every operation used an index of its own and removed it.
    expect(fs.existsSync(path.join(data, 'checkpoints', 'p1.git', 'index'))).toBe(false)
    expect(tempIndexes()).toEqual(leftover)
  }, T)

  it('snapshots an empty workspace', async () => {
    const { ws, cp } = setup()
    await cp.snapshot('p1', 'r1', ws)
    expect(await cp.changes('p1', 'r1', ws)).toEqual({ available: true, files: [] })
    put(ws, 'first.txt', 'hello\n')
    expect((await cp.changes('p1', 'r1', ws)).files).toEqual([{ path: 'first.txt', status: 'added', additions: 1, deletions: 0, binary: false }])
    await cp.revert('p1', 'r1', ws)
    expect(fs.readdirSync(ws)).toEqual([])
  }, T)

  it('never touches a workspace that is a Git repository itself', async () => {
    const { ws, cp } = setup()
    git(ws, 'init', '-q')
    put(ws, 'app.js', 'v1\n')
    put(ws, '.gitignore', 'dist/\n')
    git(ws, 'add', '-A')
    git(ws, 'commit', '-q', '-m', 'first')
    put(ws, 'staged.txt', 'staged by the owner\n')
    git(ws, 'add', 'staged.txt')
    const head = git(ws, 'rev-parse', 'HEAD')
    const dotGit = tree(path.join(ws, '.git'), '')

    await cp.snapshot('p1', 'r1', ws)
    put(ws, 'app.js', 'v2\n')
    put(ws, 'dist/bundle.js', 'built\n')
    const c = await cp.changes('p1', 'r1', ws)
    expect(c.files.map((f) => [f.path, f.status])).toEqual([['app.js', 'modified']])
    expect(await cp.diff('p1', 'r1', ws, 'app.js')).toContain('+v2')
    await cp.revert('p1', 'r1', ws)

    expect(read(ws, 'app.js')).toBe('v1\n')
    expect(git(ws, 'rev-parse', 'HEAD')).toBe(head)
    expect(tree(path.join(ws, '.git'), '')).toEqual(dotGit)
    expect(git(ws, 'diff', '--cached', '--name-only')).toBe('staged.txt')
  }, T)

  it('restores bytes exactly, whatever .gitattributes says about line endings', async () => {
    const { ws, cp } = setup()
    put(ws, '.gitattributes', '* text=auto eol=lf\n')
    put(ws, 'win.txt', 'one\r\ntwo\r\n')
    await cp.snapshot('p1', 'r1', ws)
    put(ws, 'win.txt', 'changed\r\n')
    await cp.revert('p1', 'r1', ws)
    expect(fs.readFileSync(path.join(ws, 'win.txt'))).toEqual(Buffer.from('one\r\ntwo\r\n'))
  }, T)

  it('honours .gitignore, and never deletes a file that was ignored when the task started', async () => {
    const { ws, cp } = setup()
    put(ws, '.gitignore', '.env\n*.log\nbuild/\n')
    put(ws, '.env', 'SECRET=1\n')
    put(ws, 'logs/old.log', 'old\n')
    put(ws, 'build/out.js', 'out\n')
    put(ws, 'node_modules/pkg/index.js', 'module\n')
    put(ws, 'main.py', 'print(1)\n')
    await cp.snapshot('p1', 'r1', ws)

    put(ws, 'node_modules/pkg/new.js', 'installed\n')
    put(ws, 'ignored.log', 'new, and ignored\n')
    expect((await cp.changes('p1', 'r1', ws)).files).toEqual([])

    // The team rewrites .gitignore: what was ignored before the task is still not "new".
    put(ws, '.gitignore', '# rewritten from a template\n__pycache__/\n')
    put(ws, 'logs/new.txt', 'a real new file\n')
    expect((await cp.changes('p1', 'r1', ws)).files.map((f) => [f.path, f.status])).toEqual([
      ['.gitignore', 'modified'],
      ['ignored.log', 'added'],
      ['logs/new.txt', 'added']
    ])
    await cp.revert('p1', 'r1', ws)
    expect(read(ws, '.env')).toBe('SECRET=1\n')
    expect(read(ws, 'logs/old.log')).toBe('old\n')
    expect(read(ws, 'build/out.js')).toBe('out\n')
    expect(read(ws, 'node_modules/pkg/new.js')).toBe('installed\n')
    expect(read(ws, '.gitignore')).toBe('.env\n*.log\nbuild/\n')
    expect(exists(ws, 'logs/new.txt')).toBe(false)
    expect(exists(ws, 'ignored.log')).toBe(false)
  }, T)

  it('works around folders that are repositories of their own, and leaves them alone', async () => {
    const { ws, cp } = setup()
    put(ws, 'tools/a.txt', 'a\n')
    git(path.join(ws, 'tools'), 'init', '-q') // no commit: plain `git add -A` fails on this
    put(ws, 'main.txt', 'main\n')
    await cp.snapshot('p1', 'r1', ws)

    put(ws, 'app/src/index.js', 'new app\n')
    git(path.join(ws, 'app'), 'init', '-q')
    put(ws, 'tools/a.txt', 'changed inside the other repository\n')
    put(ws, 'main.txt', 'main 2\n')
    expect((await cp.changes('p1', 'r1', ws)).files.map((f) => f.path)).toEqual(['main.txt'])
    await cp.revert('p1', 'r1', ws)
    expect(read(ws, 'main.txt')).toBe('main\n')
    expect(read(ws, 'app/src/index.js')).toBe('new app\n')
    expect(exists(ws, 'tools/.git')).toBe(true)
  }, T)

  it.skipIf(!posix)('never writes or deletes through a symlink that leads out of the workspace', async () => {
    const { ws, cp } = setup()
    const outside = tmp('cp-outside-')
    put(outside, 'a.txt', 'outside\n')
    put(outside, 'secret.txt', 'keep me\n')
    put(ws, 'src/a.txt', 'inside\n')
    await cp.snapshot('p1', 'r1', ws)

    fs.rmSync(path.join(ws, 'src'), { recursive: true })
    fs.symlinkSync(outside, path.join(ws, 'src'))
    fs.symlinkSync(outside, path.join(ws, 'link'))
    expect((await cp.changes('p1', 'r1', ws)).files.map((f) => [f.path, f.status])).toEqual([
      ['link', 'added'],
      ['src', 'added'],
      ['src/a.txt', 'deleted']
    ])
    await cp.revert('p1', 'r1', ws, ['src/a.txt'])
    expect(fs.lstatSync(path.join(ws, 'src')).isDirectory()).toBe(true)
    expect(read(ws, 'src/a.txt')).toBe('inside\n')
    await cp.revert('p1', 'r1', ws)
    expect(exists(ws, 'link')).toBe(false)
    expect(tree(outside)).toEqual({ 'a.txt': Buffer.from('outside\n').toString('base64'), 'secret.txt': Buffer.from('keep me\n').toString('base64') })
  }, T)

  it('refuses paths outside the workspace', async () => {
    const { ws, cp } = setup()
    const outside = tmp('cp-outside-')
    put(outside, 'victim.txt', 'safe\n')
    put(ws, 'a.txt', 'a\n')
    await cp.snapshot('p1', 'r1', ws)
    const rel = path.relative(ws, path.join(outside, 'victim.txt')).replaceAll('\\', '/')
    for (const bad of [rel, '../x', 'a/../../x', path.join(outside, 'victim.txt'), '/etc/passwd', 'C:\\Windows\\win.ini', '..\\x', '', 'a\0b']) {
      await expect(cp.revert('p1', 'r1', ws, [bad])).rejects.toThrow('E_BAD_ARGS')
      await expect(cp.diff('p1', 'r1', ws, bad)).rejects.toThrow('E_BAD_ARGS')
    }
    expect(read(outside, 'victim.txt')).toBe('safe\n')
    expect(cleanPath('src/a b/ü.ts')).toBe('src/a b/ü.ts')
  }, T)

  it('refuses a workspace that is too big, but does not count ignored files', async () => {
    const { ws, cp } = setup({ maxFiles: 3 })
    for (let i = 0; i < 5; i++) put(ws, `f${i}.txt`, String(i))
    await expect(cp.snapshot('p1', 'r1', ws)).rejects.toThrow('E_CHECKPOINT_TOO_BIG')
    expect(await cp.changes('p1', 'r1', ws)).toEqual({ available: false, reason: 'E_CHECKPOINT_TOO_BIG', files: [] })

    const small = setup({ maxFiles: 3 })
    put(small.ws, '.gitignore', 'dist/\n')
    put(small.ws, 'a.txt', 'a')
    put(small.ws, 'b.txt', 'b')
    for (let i = 0; i < 10; i++) put(small.ws, `dist/chunk${i}.js`, String(i))
    await small.cp.snapshot('p1', 'r1', small.ws)
    expect((await small.cp.changes('p1', 'r1', small.ws)).available).toBe(true)
  }, T)

  it('refuses a workspace whose files are too large to copy, ignored files not counted', async () => {
    const { ws, cp } = setup({ maxBytes: 1000 })
    put(ws, 'big.bin', 'x'.repeat(2000))
    await expect(cp.snapshot('p1', 'r1', ws)).rejects.toThrow('E_CHECKPOINT_TOO_BIG')

    const small = setup({ maxBytes: 1000 })
    put(small.ws, '.gitignore', 'data/\n')
    put(small.ws, 'a.txt', 'a')
    put(small.ws, 'data/huge.bin', 'x'.repeat(5000))
    await small.cp.snapshot('p1', 'r1', small.ws)
    expect((await small.cp.changes('p1', 'r1', small.ws)).available).toBe(true)
  }, T)

  it('reports a missing Git, a missing snapshot and a missing workspace instead of failing', async () => {
    const { data, ws, cp } = setup()
    put(ws, 'a.txt', 'a')
    const noGit = createCheckpoints(data, 'definitely-not-git')
    await expect(noGit.snapshot('p1', 'r1', ws)).rejects.toThrow('E_NO_GIT')
    expect(await noGit.changes('p1', 'r1', ws)).toEqual({ available: false, reason: 'E_NO_GIT', files: [] })
    await expect(commitWorkspace(ws, 'x', 'definitely-not-git')).rejects.toThrow('E_NO_GIT')

    expect(await cp.changes('p1', 'never', ws)).toEqual({ available: false, reason: 'E_NO_CHECKPOINT', files: [] })
    await cp.snapshot('p1', 'r1', ws)
    expect(await noGit.changes('p1', 'r1', ws)).toEqual({ available: false, reason: 'E_NO_GIT', files: [] })
    expect(await cp.changes('p1', 'r2', ws)).toMatchObject({ available: false, reason: 'E_NO_CHECKPOINT' })
    expect(await cp.changes('p1', '../r1', ws)).toMatchObject({ available: false, reason: 'E_NO_CHECKPOINT' })
    expect(await cp.changes('p1', 'r1', path.join(ws, 'gone'))).toMatchObject({ available: false, reason: 'E_NO_WORKSPACE' })
    await expect(cp.revert('p1', 'r2', ws)).rejects.toThrow('E_NO_CHECKPOINT')
    await expect(cp.snapshot('../p1', 'r3', ws)).rejects.toThrow('E_BAD_ARGS')

    await cp.remove('p1')
    expect(fs.existsSync(path.join(data, 'checkpoints', 'p1.git'))).toBe(false)
    expect(await cp.changes('p1', 'r1', ws)).toMatchObject({ available: false, reason: 'E_NO_CHECKPOINT' })
  }, T)

  it('runs operations side by side without sharing an index', async () => {
    const { ws, cp } = setup()
    for (let i = 0; i < 20; i++) put(ws, `f${i}.txt`, `${i}\n`)
    await Promise.all([cp.snapshot('p1', 'r1', ws), cp.snapshot('p1', 'r2', ws)])
    put(ws, 'f1.txt', 'changed\n')
    const results = await Promise.all([cp.changes('p1', 'r1', ws), cp.changes('p1', 'r2', ws), cp.diff('p1', 'r1', ws, 'f1.txt'), cp.changes('p1', 'r1', ws)])
    expect(results[0]).toEqual(results[1])
    expect(results[0]).toEqual(results[3])
    expect(results[2]).toContain('+changed')
  }, T)

  it('clips a long diff', async () => {
    const { ws, cp } = setup()
    const lines = (p: string) => Array.from({ length: 3000 }, (_, i) => `${p}${i}`).join('\n') + '\n'
    put(ws, 'big.txt', lines('a'))
    await cp.snapshot('p1', 'r1', ws)
    put(ws, 'big.txt', lines('b'))
    const d = await cp.diff('p1', 'r1', ws, 'big.txt')
    const out = d.split('\n')
    expect(out).toHaveLength(2001)
    expect(out.at(-1)).toMatch(/^… \d+ more lines$/)
    const total = 2000 + Number(/(\d+) more/.exec(out.at(-1)!)![1])
    expect(total).toBeGreaterThan(6000)
  }, T)
})

describe('commit to the workspace repository', () => {
  it('commits everything in the workspace with the owner identity and returns the short id', async () => {
    const ws = tmp('commit-')
    await expect(commitWorkspace(ws, 'x')).rejects.toThrow('E_NOT_GIT_REPO')
    git(ws, 'init', '-q')
    git(ws, 'config', 'user.name', 'Owner')
    git(ws, 'config', 'user.email', 'owner@example.com')
    put(ws, 'a.txt', 'a\n')
    put(ws, 'sub/b.txt', 'b\n')
    const sha = await commitWorkspace(ws, '  Build the landing page  ')
    expect(sha).toBe(git(ws, 'rev-parse', '--short', 'HEAD'))
    expect(git(ws, 'log', '-1', '--format=%s|%an')).toBe('Build the landing page|Owner')
    expect(git(ws, 'ls-files')).toBe('a.txt\nsub/b.txt')
    await expect(commitWorkspace(ws, 'again')).rejects.toThrow('E_NOTHING_TO_COMMIT')
    await expect(commitWorkspace(path.join(ws, '.git'), 'x')).rejects.toThrow('E_NOT_GIT_REPO')
  }, T)

  it('in a subfolder of a bigger repository, commits only that folder', async () => {
    const repo = tmp('commit-')
    git(repo, 'init', '-q')
    git(repo, 'config', 'user.name', 'Owner')
    git(repo, 'config', 'user.email', 'owner@example.com')
    put(repo, 'other/x.txt', 'x\n')
    put(repo, 'office/readme.md', 'r\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'base')
    put(repo, 'other/x.txt', 'staged elsewhere\n')
    git(repo, 'add', 'other/x.txt')
    put(repo, 'office/new.md', 'n\n')
    await commitWorkspace(path.join(repo, 'office'), 'Office work')
    expect(git(repo, 'show', '--name-only', '--format=', 'HEAD')).toBe('office/new.md')
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('other/x.txt')
  }, T)

  it.skipIf(!posix)('runs the owner’s hooks and reports their failure', async () => {
    const ws = tmp('commit-')
    git(ws, 'init', '-q')
    git(ws, 'config', 'user.name', 'Owner')
    git(ws, 'config', 'user.email', 'owner@example.com')
    put(ws, '.git/hooks/pre-commit', '#!/bin/sh\necho "lint failed: 2 problems" >&2\nexit 1\n')
    fs.chmodSync(path.join(ws, '.git/hooks/pre-commit'), 0o755)
    put(ws, 'a.txt', 'a\n')
    await expect(commitWorkspace(ws, 'x')).rejects.toThrow('E_GIT|lint failed: 2 problems')
  }, T)
})
