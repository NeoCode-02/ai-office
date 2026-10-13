import dns from 'node:dns'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Sandbox, ToolName } from '../shared/types'
import { unifiedDiff } from './diff'
import { dockerArgs, exec, MAX_OUT } from './exec'
import { classifyAddress, webFetch } from './fetch'
import { searchFiles } from './search'
import { inside, runTool, type ToolCtx } from './tools'

const win = process.platform === 'win32'
const tmp = (p: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)))
const write = (f: string, text: string | Buffer) => {
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, text)
}
/** Junctions need no admin rights on Windows. */
const dirLink = (target: string, p: string) => fs.symlinkSync(target, p, win ? 'junction' : 'dir')

const ALL: ToolName[] = ['list_files', 'read_file', 'search_files', 'write_file', 'edit_file', 'run_command', 'web_fetch', 'use_skill', 'read_skill_file']
const ctx = (root: string, extra: Partial<ToolCtx> = {}): ToolCtx => ({
  root,
  send: () => '',
  remember: () => {},
  report: () => {},
  approve: async () => true,
  skill: () => undefined,
  ...extra
})
const run = (root: string, name: string, input: Record<string, unknown>, extra: Partial<ToolCtx> = {}) =>
  runTool({ id: '1', name, input }, ALL, ctx(root, extra))

describe('inside', () => {
  it('keeps paths inside the root', () => {
    const root = tmp('ws-')
    expect(() => inside(root, '../x')).toThrow(/outside/)
    expect(() => inside(root, ['..', 'x'].join(path.sep))).toThrow(/outside/)
    expect(() => inside(root, path.resolve('/etc/passwd'))).toThrow(/outside/)
    expect(inside(root, ['sub', 'f.txt'].join(path.sep))).toBe(path.join(root, 'sub', 'f.txt'))
    expect(inside(root, 'a/../b.txt')).toBe(path.join(root, 'b.txt'))
    expect(() => inside(root, 'a\0b')).toThrow(/NUL/)
  })

  it('rejects writing through a symlinked folder that points outside, even to new files', async () => {
    const root = tmp('ws-')
    const outside = tmp('outside-')
    dirLink(outside, path.join(root, 'link'))
    expect(() => inside(root, 'link/new.txt')).toThrow(/outside/)
    expect(() => inside(root, 'link/a/b/new.txt')).toThrow(/outside/)
    const r = await run(root, 'write_file', { path: 'link/new.txt', content: 'x' })
    expect(r.isError).toBe(true)
    expect(fs.existsSync(path.join(outside, 'new.txt'))).toBe(false)
  })

  it('follows symlinks that stay inside', () => {
    const root = tmp('ws-')
    fs.mkdirSync(path.join(root, 'real'))
    dirLink(path.join(root, 'real'), path.join(root, 'alias'))
    expect(inside(root, 'alias/new.txt')).toBe(path.join(root, 'real', 'new.txt'))
  })

  it.skipIf(win)('rejects a dangling symlink whose target is outside', async () => {
    const root = tmp('ws-')
    const outside = tmp('outside-')
    fs.symlinkSync(path.join(outside, 'created.txt'), path.join(root, 'dangling'))
    expect(() => inside(root, 'dangling')).toThrow(/outside/)
    expect((await run(root, 'write_file', { path: 'dangling', content: 'x' })).isError).toBe(true)
    expect(fs.existsSync(path.join(outside, 'created.txt'))).toBe(false)
  })
})

describe('list_files', () => {
  it('marks folders and links, skips node_modules/.git and never enters links', async () => {
    const root = tmp('ws-')
    const outside = tmp('outside-')
    write(path.join(outside, 'secret.txt'), 'secret')
    write(path.join(root, 'src/a.ts'), 'a')
    write(path.join(root, 'node_modules/x/index.js'), 'x')
    write(path.join(root, '.git/HEAD'), 'ref')
    dirLink(outside, path.join(root, 'out'))
    const r = await run(root, 'list_files', { path: '.' })
    expect(r.content.split('\n')).toEqual(['out@', 'src/', 'src/a.ts'])
  })

  it('stops at 500 entries and says so', async () => {
    const root = tmp('ws-')
    for (let i = 0; i < 510; i++) write(path.join(root, `f${String(i).padStart(3, '0')}.txt`), '')
    const lines = (await run(root, 'list_files', { path: '.' })).content.split('\n')
    expect(lines).toHaveLength(501)
    expect(lines[500]).toMatch(/more entries/)
  })

  it('does not list links in a skill folder', async () => {
    const root = tmp('ws-')
    const dir = tmp('skill-')
    write(path.join(dir, 'SKILL.md'), 'body')
    write(path.join(dir, 'ref.md'), 'ref')
    dirLink(tmp('outside-'), path.join(dir, 'escape'))
    const r = await run(root, 'use_skill', { name: 's' }, { skill: () => ({ body: 'Do it', dir }) })
    expect(r.content).toBe('Do it\n\nFiles in this skill (read_skill_file):\nref.md')
  })
})

describe('read_file', () => {
  it('reads text, describes binary files and refuses files over 5 MB', async () => {
    const root = tmp('ws-')
    write(path.join(root, 'a.txt'), 'hello')
    write(path.join(root, 'img.bin'), Buffer.from([0x89, 0x50, 0, 1, 2]))
    write(path.join(root, 'big.log'), Buffer.alloc(5 * 1024 * 1024 + 1, 'a'))
    expect(await run(root, 'read_file', { path: 'a.txt' })).toEqual({ content: 'hello', isError: false })
    expect((await run(root, 'read_file', { path: 'img.bin' })).content).toBe('binary file, 5 bytes')
    const big = await run(root, 'read_file', { path: 'big.log' })
    expect(big.isError).toBe(true)
    expect(big.content).toMatch(/search_files/)
    expect((await run(root, 'read_file', { path: '.' })).content).toMatch(/folder/)
  })
})

describe('write_file / edit_file', () => {
  it('returns a diff and the workspace-relative path of the changed file', async () => {
    const root = tmp('ws-')
    const created = await run(root, 'write_file', { path: 'sub/new.txt', content: 'one\ntwo\n' })
    expect(created).toMatchObject({ isError: false, changed: 'sub/new.txt' })
    expect(created.diff).toBe('--- a/sub/new.txt\n+++ b/sub/new.txt\n@@ -0,0 +1,2 @@\n+one\n+two')

    const edited = await run(root, 'edit_file', { path: 'sub/new.txt', old_text: 'two', new_text: 'three' })
    expect(edited).toMatchObject({ isError: false, changed: 'sub/new.txt' })
    expect(edited.diff).toBe('--- a/sub/new.txt\n+++ b/sub/new.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+three')
    expect(fs.readFileSync(path.join(root, 'sub/new.txt'), 'utf8')).toBe('one\nthree\n')

    const replaced = await run(root, 'write_file', { path: 'sub/new.txt', content: 'one\nthree\n' })
    expect(replaced.diff).toBe('')
    expect((await run(root, 'edit_file', { path: 'sub/new.txt', old_text: '', new_text: 'x' })).isError).toBe(true)
  })

  it('does not diff a binary file it overwrites', async () => {
    const root = tmp('ws-')
    write(path.join(root, 'b.bin'), Buffer.from([0, 1, 2]))
    const r = await run(root, 'write_file', { path: 'b.bin', content: 'text' })
    expect(r).toMatchObject({ isError: false, changed: 'b.bin' })
    expect(r.diff).toBeUndefined()
    write(path.join(root, 'c.bin'), Buffer.from([0x74, 0x65, 0]))
    const edit = await run(root, 'edit_file', { path: 'c.bin', old_text: 'te', new_text: 'x' })
    expect(edit).toEqual({ content: 'This is a binary file; it cannot be edited as text', isError: true })
  })

  it('keeps .git read-only', async () => {
    const root = tmp('ws-')
    write(path.join(root, '.git/config'), '[core]')
    for (const p of ['.git/config', '.git/hooks/pre-commit', '.GIT/hooks/x', 'sub/.git/HEAD', 'a/../.git/x', '.git', '.git./x', 'sub\\.git\\x']) {
      const r = await run(root, 'write_file', { path: p, content: 'evil' })
      expect(r, p).toEqual({ content: 'Writing inside .git is not allowed; use git commands with run_command', isError: true })
    }
    const edit = await run(root, 'edit_file', { path: '.git/config', old_text: '[core]', new_text: 'evil' })
    expect(edit.content).toMatch(/inside \.git/)
    expect(fs.readFileSync(path.join(root, '.git/config'), 'utf8')).toBe('[core]')
    expect(fs.existsSync(path.join(root, '.git/hooks'))).toBe(false)
    expect((await run(root, 'write_file', { path: '.gitignore', content: 'out\n' })).isError).toBe(false)
    expect((await run(root, 'write_file', { path: 'docs/.github/x.yml', content: 'x' })).isError).toBe(false)
  })

  it('keeps .git read-only through a symlink', async () => {
    const root = tmp('ws-')
    write(path.join(root, '.git/config'), '[core]')
    dirLink(path.join(root, '.git'), path.join(root, 'innocent'))
    expect((await run(root, 'write_file', { path: 'innocent/config', content: 'evil' })).content).toMatch(/inside \.git/)
    expect(fs.readFileSync(path.join(root, '.git/config'), 'utf8')).toBe('[core]')
  })
})

describe('search_files', () => {
  it('searches a folder or a single file', async () => {
    const root = tmp('ws-')
    write(path.join(root, 'src/a.ts'), 'const token = 1\nexport {}')
    write(path.join(root, 'src/b.ts'), 'no match here')
    expect((await run(root, 'search_files', { pattern: 'TOKEN', path: '.' })).content).toBe('src/a.ts:1: const token = 1')
    expect(await run(root, 'search_files', { pattern: 'export', path: 'src/a.ts' })).toEqual({ content: 'src/a.ts:2: export {}', isError: false })
    expect((await run(root, 'search_files', { pattern: 'zzz', path: 'src' })).content).toBe('No matches')
    expect((await run(root, 'search_files', { pattern: 'x', path: '..' })).isError).toBe(true)
  })

  it('reports an invalid pattern', async () => {
    const root = tmp('ws-')
    const r = await run(root, 'search_files', { pattern: '(unclosed', path: '.' })
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/Invalid regular expression/)
  })

  it('never follows symlinks: an outside file is not read and a folder link does not break the search', async () => {
    const root = tmp('ws-')
    const outside = tmp('outside-')
    write(path.join(outside, 'secret.txt'), 'password=hunter2')
    write(path.join(root, 'a.txt'), 'password=placeholder')
    dirLink(outside, path.join(root, 'dirlink'))
    if (!win) fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'filelink.txt'))
    const r = await run(root, 'search_files', { pattern: 'password', path: '.' })
    expect(r).toEqual({ content: 'a.txt:1: password=placeholder', isError: false })
  })

  it('skips node_modules, .git, binary files and big files in folders, but searches a big file named directly', async () => {
    const root = tmp('ws-')
    write(path.join(root, 'node_modules/x.js'), 'needle')
    write(path.join(root, '.git/config'), 'needle')
    write(path.join(root, 'bin.dat'), Buffer.concat([Buffer.from('needle'), Buffer.from([0])]))
    write(path.join(root, 'big.log'), 'x'.repeat(1_100_000) + '\nneedle\n')
    write(path.join(root, 'ok.txt'), 'a\nneedle')
    expect((await run(root, 'search_files', { pattern: 'needle', path: '.' })).content).toBe('ok.txt:2: needle')
    expect((await run(root, 'search_files', { pattern: 'needle', path: 'big.log' })).content).toBe('big.log:2: needle')
  })

  it('stops at 200 matches', async () => {
    const root = tmp('ws-')
    write(path.join(root, 'many.txt'), Array.from({ length: 300 }, (_, i) => `hit ${i}`).join('\n'))
    const lines = (await run(root, 'search_files', { pattern: 'hit', path: '.' })).content.split('\n')
    expect(lines).toHaveLength(200)
    expect(lines[199]).toBe('many.txt:200: hit 199')
  })

  it('times out on a catastrophic pattern instead of freezing', async () => {
    const root = tmp('ws-')
    write(path.join(root, 'a.txt'), 'a'.repeat(40) + '!')
    const t0 = Date.now()
    await expect(searchFiles(root, root, '^(a+)+$', { timeoutMs: 300 })).rejects.toThrow(
      'Search timed out after 0.3 s; use a simpler pattern or a smaller folder'
    )
    expect(Date.now() - t0).toBeLessThan(3000)
  })

  it('can be stopped', async () => {
    const root = tmp('ws-')
    write(path.join(root, 'a.txt'), 'a'.repeat(40) + '!')
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 100)
    const t0 = Date.now()
    await expect(searchFiles(root, root, '^(a+)+$', { signal: ac.signal })).rejects.toThrow('Search stopped')
    expect(Date.now() - t0).toBeLessThan(3000)
  })
})

/** True once the process is gone (or a zombie nobody reaped yet). */
function gone(pid: number) {
  try {
    process.kill(pid, 0)
  } catch {
    return true
  }
  try {
    return /\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'))
  } catch {
    return false
  }
}
// Generous: process teardown is slow on a loaded CI runner; a process that never dies still fails.
async function waitFor(check: () => boolean, ms = 10_000) {
  const end = Date.now() + ms
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 25))
  return check()
}

describe('exec', { timeout: 20_000 }, () => {
  it('reports the exit code after the output', async () => {
    const root = tmp('ws-')
    expect(await exec('echo hi&& exit 3', root)).toEqual({ content: 'hi\n[exit 3]', isError: false })
  })

  it('caps long output but keeps the status line', async () => {
    const root = tmp('ws-')
    const r = await exec(`"${process.execPath}" -e "process.stdout.write('x'.repeat(50000))"`, root)
    expect(r.content.startsWith('x'.repeat(MAX_OUT) + '\n…[30000 more characters truncated]')).toBe(true)
    expect(r.content.endsWith('\n[exit 0]')).toBe(true)
  })

  it.skipIf(win)('closes stdin, so a command waiting for input ends at once', async () => {
    const t0 = Date.now()
    expect(await exec('cat', tmp('ws-'), { timeoutMs: 10_000 })).toEqual({ content: '[exit 0]', isError: false })
    expect(Date.now() - t0).toBeLessThan(3000)
  })

  it.skipIf(win)('kills the whole process tree on timeout', async () => {
    const t0 = Date.now()
    const r = await exec('sleep 30 & echo $!; sleep 30', tmp('ws-'), { timeoutMs: 500 })
    expect(Date.now() - t0).toBeLessThan(3000)
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/^\d+\n\[timed out after 0\.5 s\]$/)
    const grandchild = Number(r.content.split('\n')[0])
    expect(await waitFor(() => gone(grandchild))).toBe(true)
  })

  it.skipIf(win)('stops on abort', async () => {
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 200)
    const t0 = Date.now()
    const r = await exec('echo started; sleep 30', tmp('ws-'), { signal: ac.signal })
    expect(r).toEqual({ content: 'started\n[stopped]', isError: true })
    expect(Date.now() - t0).toBeLessThan(3000)
    expect(await exec('echo never', tmp('ws-'), { signal: ac.signal })).toEqual({ content: '[stopped]', isError: true })
  })

  it.skipIf(win)('does not wait for background processes that keep the output open', async () => {
    const t0 = Date.now()
    const r = await exec('sleep 30 & echo $!', tmp('ws-'), { timeoutMs: 20_000 })
    expect(Date.now() - t0).toBeLessThan(5000)
    expect(r.content).toMatch(/^\d+\n\[exit 0\]$/)
    expect(await waitFor(() => gone(Number(r.content.split('\n')[0])))).toBe(true)
  })
})

describe('run_command', () => {
  it('asks first and passes the signal and the sandbox on', async () => {
    const root = tmp('ws-')
    expect(await run(root, 'run_command', { command: 'echo hi' }, { approve: async () => false })).toEqual({
      content: 'The owner declined this command',
      isError: true
    })
    const ac = new AbortController()
    ac.abort()
    expect(await run(root, 'run_command', { command: 'echo hi' }, { signal: ac.signal })).toEqual({ content: '[stopped]', isError: true })
    const saved = process.env.PATH
    process.env.PATH = tmp('empty-')
    try {
      const pending = run(root, 'run_command', { command: 'ls' }, { sandbox: { kind: 'docker', image: 'alpine', network: true } })
      await new Promise((r) => setTimeout(r, 0))
      process.env.PATH = saved
      expect((await pending).content).toMatch(/^E_NO_DOCKER: /)
    } finally {
      process.env.PATH = saved
    }
  })

  it.skipIf(win)('does not hang on a command that reads input', async () => {
    const t0 = Date.now()
    expect(await run(tmp('ws-'), 'run_command', { command: 'cat' })).toEqual({ content: '[exit 0]', isError: false })
    expect(Date.now() - t0).toBeLessThan(3000)
  })
})

describe('docker sandbox', () => {
  const sandbox: Sandbox = { kind: 'docker', image: 'node:22-bookworm', network: false }

  it('builds docker run arguments that mount only the workspace', () => {
    expect(dockerArgs('/home/me/ws', 'npm test && echo "ok"', sandbox, 'aioffice-1', '1000:1000')).toEqual([
      'run',
      '--rm',
      '--name',
      'aioffice-1',
      '-v',
      '/home/me/ws:/workspace',
      '-w',
      '/workspace',
      '--network',
      'none',
      '--user',
      '1000:1000',
      'node:22-bookworm',
      'sh',
      '-lc',
      'npm test && echo "ok"'
    ])
    const open = dockerArgs('C:\\Users\\me\\ws', 'ls', { ...sandbox, network: true, image: 'ghcr.io/acme/tools:1.2@sha256:abc' }, 'n', '')
    expect(open).toEqual(['run', '--rm', '--name', 'n', '-v', 'C:\\Users\\me\\ws:/workspace', '-w', '/workspace', 'ghcr.io/acme/tools:1.2@sha256:abc', 'sh', '-lc', 'ls'])
    if (!win) expect(dockerArgs('/ws', 'ls', sandbox, 'n')).toContain(`${process.getuid!()}:${process.getgid!()}`)
  })

  it('refuses image names that docker would read as options, and paths it cannot mount', () => {
    for (const image of ['--privileged', '-v=/:/host', '', 'img name', 'a;b']) {
      expect(() => dockerArgs('/ws', 'ls', { ...sandbox, image }, 'n'), image).toThrow(/Invalid Docker image/)
    }
    expect(() => dockerArgs('/ws:/etc', 'ls', sandbox, 'n')).toThrow(/":"/)
  })

  describe.skipIf(win)('with a fake docker command', () => {
    let bin: string
    let savedPath: string | undefined
    const fakeDocker = (script: string) => {
      bin = tmp('bin-')
      write(path.join(bin, 'docker'), `#!/bin/sh\n${script}\n`)
      fs.chmodSync(path.join(bin, 'docker'), 0o755)
      savedPath = process.env.PATH
      process.env.PATH = `${bin}${path.delimiter}${savedPath}`
    }
    afterEach(() => {
      process.env.PATH = savedPath
    })

    it('runs the command through docker without a host shell', async () => {
      fakeDocker('for a in "$@"; do printf "<%s>" "$a"; done')
      const root = tmp('ws-')
      const r = await exec('echo $HOME; rm -rf /', root, { sandbox })
      expect(r.isError).toBe(false)
      expect(r.content).toMatch(/^<run><--rm><--name><aioffice-[0-9a-f]{16}><-v><.+:\/workspace><-w><\/workspace><--network><none>/)
      expect(r.content).toContain('<node:22-bookworm><sh><-lc><echo $HOME; rm -rf />\n[exit 0]')
    })

    it('reports E_NO_DOCKER when the daemon is down', async () => {
      fakeDocker('echo "docker: Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" >&2; exit 125')
      const r = await exec('ls', tmp('ws-'), { sandbox })
      expect(r.isError).toBe(true)
      expect(r.content).toMatch(/^E_NO_DOCKER: Docker is not available \(docker: Cannot connect to the Docker daemon/)
    })

    it('kills the container by name on timeout', async () => {
      fakeDocker(`if [ "$1" = kill ]; then echo "$2" > "${'$'}(dirname "$0")/killed"; exit 0; fi\nsleep 30`)
      const r = await exec('sleep 100', tmp('ws-'), { sandbox, timeoutMs: 300 })
      expect(r).toEqual({ content: '[timed out after 0.3 s]', isError: true })
      expect(await waitFor(() => fs.existsSync(path.join(bin, 'killed')))).toBe(true)
      expect(fs.readFileSync(path.join(bin, 'killed'), 'utf8')).toMatch(/^aioffice-[0-9a-f]{16}\n$/)
    })
  })

  it('reports E_NO_DOCKER when docker is not installed', async () => {
    const saved = process.env.PATH
    process.env.PATH = tmp('empty-')
    try {
      const pending = exec('ls', tmp('ws-'), { sandbox })
      process.env.PATH = saved
      const r = await pending
      expect(r.isError).toBe(true)
      expect(r.content).toMatch(/^E_NO_DOCKER: /)
    } finally {
      process.env.PATH = saved
    }
  })
})

describe('classifyAddress', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.255.0.9', 'loopback'],
    ['::1', 'loopback'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:7f00:1', 'loopback'],
    ['[::1]', 'loopback'],
    ['10.1.2.3', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.10', 'private'],
    ['100.64.0.1', 'private'],
    ['100.127.255.255', 'private'],
    ['fd00::1', 'private'],
    ['fc00::1', 'private'],
    ['::ffff:10.0.0.1', 'private'],
    ['169.254.169.254', 'link-local'],
    ['::ffff:169.254.169.254', 'link-local'],
    ['64:ff9b::a9fe:a9fe', 'link-local'],
    ['fe80::1', 'link-local'],
    ['fe80::1%eth0', 'link-local'],
    ['febf::1', 'link-local'],
    ['0.0.0.0', 'unspecified'],
    ['0.1.2.3', 'unspecified'],
    ['::', 'unspecified'],
    ['224.0.0.1', 'multicast'],
    ['239.255.255.250', 'multicast'],
    ['ff02::1', 'multicast'],
    ['240.0.0.1', 'reserved'],
    ['255.255.255.255', 'reserved'],
    ['::127.0.0.1', 'reserved'],
    ['not-an-ip', 'reserved'],
    ['8.8.8.8', 'public'],
    ['1.1.1.1', 'public'],
    ['172.32.0.1', 'public'],
    ['172.15.255.255', 'public'],
    ['100.128.0.1', 'public'],
    ['192.169.0.1', 'public'],
    ['2606:4700:4700::1111', 'public'],
    ['2001:4860:4860::8888', 'public'],
    ['::ffff:8.8.8.8', 'public']
  ])('%s is %s', (ip, cls) => {
    expect(classifyAddress(ip)).toBe(cls)
  })
})

describe('web_fetch', () => {
  let server: http.Server
  let base: string
  const big = Buffer.alloc(3 * 1024 * 1024, 'a')

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const send = (type: string, body: string | Buffer, headers: Record<string, string> = {}) => {
        res.writeHead(200, { 'content-type': type, ...headers })
        res.end(body)
      }
      const go = (location: string) => {
        res.writeHead(302, { location })
        res.end()
      }
      res.on('error', () => {})
      switch (req.url) {
        case '/hello':
          return send('text/plain', 'hello')
        case '/html':
          return send('text/html; charset=utf-8', '<p>Hi &amp; bye</p><script>x()</script><div>next</div>')
        case '/png':
          return send('image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))
        case '/cp1251':
          return send('text/plain; charset=windows-1251', Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]))
        case '/gzip':
          return send('text/plain', zlib.gzipSync('zipped'), { 'content-encoding': 'gzip' })
        case '/deflate':
          return send('text/plain', zlib.deflateSync('deflated'), { 'content-encoding': 'deflate' })
        case '/deflate-raw':
          return send('text/plain', zlib.deflateRawSync('raw deflated'), { 'content-encoding': 'deflate' })
        case '/br':
          return send('application/json', zlib.brotliCompressSync('{"a":1}'), { 'content-encoding': 'br' })
        case '/big':
          return send('text/plain', big)
        case '/bomb':
          return send('text/plain', zlib.gzipSync(Buffer.alloc(20 * 1024 * 1024, 'b')), { 'content-encoding': 'gzip' })
        case '/redir-meta':
          return go('http://169.254.169.254/latest/meta-data/')
        case '/redir-local':
          return go('/hello')
        case '/redir-file':
          return go('file:///etc/passwd')
        case '/loop':
          return go('/loop')
        case '/slow':
          return // never answers
      }
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => {
    server.closeAllConnections()
    server.close()
  })
  const yes = async () => true

  it('refuses non-http URLs', async () => {
    await expect(webFetch('file:///etc/passwd')).rejects.toThrow(/http/)
  })

  it('refuses this computer and the local network unless the owner allows it', async () => {
    await expect(webFetch(`${base}/hello`)).rejects.toThrow(/^Refused: 127\.0\.0\.1/)
    await expect(webFetch(`${base}/hello`, { approveLocal: async () => false })).rejects.toThrow(/Refused/)
    await expect(webFetch('http://localhost:1/x')).rejects.toThrow(/Refused/)
    await expect(webFetch('http://[::ffff:127.0.0.1]:1/x')).rejects.toThrow(/Refused/)
    const asked: string[] = []
    const text = await webFetch(`${base}/hello`, { approveLocal: async (url) => (asked.push(url), true) })
    expect(text).toBe('HTTP 200\n\nhello')
    expect(asked).toEqual([`${base}/hello`])
  })

  it('never fetches link-local, unspecified or multicast addresses, even when allowed', async () => {
    await expect(webFetch('http://169.254.169.254/latest/meta-data/', { approveLocal: yes })).rejects.toThrow(/^Blocked: .*link-local/)
    await expect(webFetch('http://0.0.0.0:1/', { approveLocal: yes })).rejects.toThrow(/^Blocked/)
    await expect(webFetch('http://[::ffff:169.254.169.254]/', { approveLocal: yes })).rejects.toThrow(/^Blocked/)
    await expect(webFetch('http://224.0.0.1/', { approveLocal: yes })).rejects.toThrow(/^Blocked/)
  })

  it('checks every redirect', async () => {
    await expect(webFetch(`${base}/redir-meta`, { approveLocal: yes })).rejects.toThrow(/^Blocked: 169\.254\.169\.254/)
    await expect(webFetch(`${base}/redir-file`, { approveLocal: yes })).rejects.toThrow(/Only http and https/)
    await expect(webFetch(`${base}/loop`, { approveLocal: yes })).rejects.toThrow(/Too many redirects/)
    let asked = 0
    expect(await webFetch(`${base}/redir-local`, { approveLocal: async () => (asked++, true) })).toBe('HTTP 200\n\nhello')
    expect(asked).toBe(1)
  })

  it('connects to the address it checked, resolving the name only once', async () => {
    const port = (server.address() as AddressInfo).port
    const lookup = vi
      .spyOn(dns.promises, 'lookup')
      .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }] as never)
      .mockResolvedValue([{ address: '169.254.169.254', family: 4 }] as never)
    try {
      expect(await webFetch(`http://rebind.example:${port}/hello`, { approveLocal: yes })).toBe('HTTP 200\n\nhello')
      expect(lookup).toHaveBeenCalledTimes(1)
    } finally {
      lookup.mockRestore()
    }
  })

  it('converts HTML, skips binary content and honours the charset', async () => {
    expect(await webFetch(`${base}/html`, { approveLocal: yes })).toBe('HTTP 200\n\nHi & bye\nnext')
    expect(await webFetch(`${base}/png`, { approveLocal: yes })).toBe('HTTP 200, image/png: binary content not shown')
    expect(await webFetch(`${base}/cp1251`, { approveLocal: yes })).toBe('HTTP 200\n\nПривет')
    expect(await webFetch(`${base}/nope`, { approveLocal: yes })).toBe('HTTP 404\n\nnot found')
  })

  it('decompresses gzip, deflate (with or without the zlib header) and brotli', async () => {
    expect(await webFetch(`${base}/gzip`, { approveLocal: yes })).toBe('HTTP 200\n\nzipped')
    expect(await webFetch(`${base}/deflate`, { approveLocal: yes })).toBe('HTTP 200\n\ndeflated')
    expect(await webFetch(`${base}/deflate-raw`, { approveLocal: yes })).toBe('HTTP 200\n\nraw deflated')
    expect(await webFetch(`${base}/br`, { approveLocal: yes })).toBe('HTTP 200\n\n{"a":1}')
  })

  it('stops reading after 2 MB, also of decompressed data', async () => {
    const text = await webFetch(`${base}/big`, { approveLocal: yes })
    expect(text.endsWith('\n[truncated]')).toBe(true)
    expect(text).toMatch(/more characters truncated/)
    expect(await webFetch(`${base}/big`, { approveLocal: yes, maxBytes: 10 })).toBe('HTTP 200\n\naaaaaaaaaa\n[truncated]')
    expect((await webFetch(`${base}/bomb`, { approveLocal: yes })).endsWith('\n[truncated]')).toBe(true)
  })

  it('times out and can be stopped', async () => {
    await expect(webFetch(`${base}/slow`, { approveLocal: yes, timeoutMs: 300 })).rejects.toThrow('Timed out after 0.3 s')
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 100)
    await expect(webFetch(`${base}/slow`, { approveLocal: yes, signal: ac.signal })).rejects.toThrow('Stopped')
  })

  it('asks the owner through the tool context', async () => {
    const root = tmp('ws-')
    expect(await run(root, 'web_fetch', { url: `${base}/hello` })).toMatchObject({ isError: true })
    expect(await run(root, 'web_fetch', { url: `${base}/hello` }, { approveFetch: yes })).toEqual({ content: 'HTTP 200\n\nhello', isError: false })
  })
})

/** Lines with the missing final newline kept as a trailing "\n" (as `\ No newline at end of file` says). */
const toLines = (t: string) => {
  const l = t ? t.split('\n') : []
  if (l.length && l[l.length - 1] === '') l.pop()
  else if (l.length) l[l.length - 1] += '\n'
  return l
}
const fromLines = (l: string[]) => l.map((x) => (x.endsWith('\n') ? x.slice(0, -1) : x + '\n')).join('')

/** Applies a unified diff the way `patch` would, checking every hunk header, context and removed line. */
function applyDiff(before: string, diff: string): string {
  if (!diff) return before
  const src = toLines(before)
  const out: string[] = []
  let at = 0
  const lines = diff.split('\n')
  expect(lines.slice(0, 2)).toEqual(['--- a/f', '+++ b/f'])
  for (let i = 2; i < lines.length; ) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@$/.exec(lines[i++])
    if (!m) throw new Error(`bad hunk header ${lines[i - 1]}`)
    const [aStart, aCount, bStart, bCount] = [Number(m[1]), Number(m[2] ?? 1), Number(m[3]), Number(m[4] ?? 1)]
    const start = aCount ? aStart - 1 : aStart
    if (start < at) throw new Error('overlapping hunks')
    out.push(...src.slice(at, start))
    at = start
    if (out.length !== (bCount ? bStart - 1 : bStart)) throw new Error(`wrong +start in ${m[0]}`)
    let seenA = 0
    let seenB = 0
    while (i < lines.length && !lines[i].startsWith('@@')) {
      const l = lines[i++]
      let line = l.slice(1)
      if (lines[i]?.startsWith('\\')) {
        line += '\n'
        i++
      }
      if (l[0] === ' ' || l[0] === '-') {
        if (src[at] !== line) throw new Error(`line ${at + 1} is ${JSON.stringify(src[at])}, diff says ${JSON.stringify(line)}`)
        at++
        seenA++
      }
      if (l[0] === ' ' || l[0] === '+') {
        out.push(line)
        seenB++
      }
    }
    if (seenA !== aCount || seenB !== bCount) throw new Error(`counts in ${m[0]} do not match its lines`)
  }
  out.push(...src.slice(at))
  return fromLines(out)
}

describe('unifiedDiff', () => {
  it('is empty for identical input', () => {
    expect(unifiedDiff('a.txt', 'same\n', 'same\n')).toBe('')
    expect(unifiedDiff('a.txt', '', '')).toBe('')
  })

  it('shows a new file and a deleted one', () => {
    expect(unifiedDiff('n.txt', '', 'x\ny\n')).toBe('--- a/n.txt\n+++ b/n.txt\n@@ -0,0 +1,2 @@\n+x\n+y')
    expect(unifiedDiff('n.txt', 'x\n', '')).toBe('--- a/n.txt\n+++ b/n.txt\n@@ -1 +0,0 @@\n-x')
  })

  it('keeps three lines of context and merges nearby changes', () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join('\n') + '\n'
    const after = before.replace('l5\n', 'L5\n').replace('l17\n', 'L17\n')
    expect(unifiedDiff('f', before, after)).toBe(
      ['--- a/f', '+++ b/f', '@@ -2,7 +2,7 @@', ' l2', ' l3', ' l4', '-l5', '+L5', ' l6', ' l7', ' l8', '@@ -14,7 +14,7 @@', ' l14', ' l15', ' l16', '-l17', '+L17', ' l18', ' l19', ' l20'].join(
        '\n'
      )
    )
    const near = before.replace('l5\n', 'L5\n').replace('l11\n', 'L11\n')
    expect(unifiedDiff('f', before, near).split('\n')[2]).toBe('@@ -2,13 +2,13 @@')
    expect(unifiedDiff('f', before, after, { context: 0 }).split('\n')[2]).toBe('@@ -5 +5 @@')
  })

  it('marks a missing newline at the end', () => {
    expect(unifiedDiff('f', 'a', 'a\n')).toBe('--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+a')
  })

  it('clips long diffs and summarizes huge inputs', () => {
    const many = Array.from({ length: 1000 }, (_, i) => `n${i}\n`).join('')
    const d = unifiedDiff('f', '', many, { maxLines: 10 })
    expect(d.split('\n')).toHaveLength(11)
    expect(d.split('\n')[10]).toBe('… 993 more lines')
    const huge = 'x\n'.repeat(4001)
    expect(unifiedDiff('f', huge, huge + 'y\n')).toBe('--- a/f\n+++ b/f\n@@ 4001 lines → 4002 lines @@')
  })

  it('produces patches that turn before into after', () => {
    let seed = 7
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31
      return seed % n
    }
    const text = (n: number) => Array.from({ length: n }, () => 'abcde'[rnd(5)]).join('\n') + (rnd(2) ? '\n' : '')
    for (let i = 0; i < 300; i++) {
      const before = rnd(4) ? text(rnd(30)) : ''
      const after = rnd(4) ? text(rnd(30)) : ''
      const d = unifiedDiff('f', before, after, { context: rnd(4), maxLines: 10_000 })
      expect(applyDiff(before, d), JSON.stringify({ before, after, d })).toBe(after)
    }
  })

  it('stays correct when the files have nothing in common', () => {
    const before = Array.from({ length: 1500 }, (_, i) => `old ${i}`).join('\n') + '\n'
    const after = Array.from({ length: 1500 }, (_, i) => `new ${i}`).join('\n') + '\n'
    expect(applyDiff(before, unifiedDiff('f', before, after, { maxLines: 100_000 }))).toBe(after)
  })
})
