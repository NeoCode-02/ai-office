import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createExtensions, parseFrontmatter, parsePairs } from './extensions'
import { McpClient, McpPool, mcpToolName } from './mcp'
import { htmlToText, inside, runTool, webFetch } from './tools'

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p))
const write = (f: string, text: string) => {
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, text)
}
const plain = { encrypt: (s: string) => `enc:${s}`, decrypt: (s: string) => s.slice(4) }
const server = path.resolve('test/mcp-server.mjs')

describe('skills and plugins', () => {
  it('parses SKILL.md frontmatter', () => {
    expect(parseFrontmatter('---\nname: x\ndescription: "Does y"\n---\n\nBody')).toEqual({ meta: { name: 'x', description: 'Does y' }, body: 'Body' })
    expect(parseFrontmatter('no meta').body).toBe('no meta')
    expect(parsePairs('Authorization: Bearer a:b\nno separator', ':')).toEqual({ Authorization: 'Bearer a:b' })
    expect(parsePairs('TOKEN=x=y', '=')).toEqual({ TOKEN: 'x=y' })
  })

  it('ships built-in skills and lets users add and disable their own', () => {
    const ext = createExtensions(tmp('ext-'), plain)
    expect(ext.listSkills().map((s) => s.name)).toEqual(expect.arrayContaining(['code-review', 'testing', 'security-review', 'report-writing']))
    ext.createSkill('Deploy', 'How we deploy', 'Run make deploy')
    expect(ext.enabledSkills().find((s) => s.name === 'Deploy')?.body).toBe('Run make deploy')
    ext.setSkillEnabled('Deploy', false)
    expect(ext.enabledSkills().some((s) => s.name === 'Deploy')).toBe(false)
  })

  it('imports a Claude Code style plugin: skills, agents, .mcp.json', () => {
    const src = tmp('plugin-')
    write(path.join(src, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'Acme Tools', description: 'd', version: '1.2.0' }))
    write(path.join(src, 'skills/brand/SKILL.md'), '---\nname: brand\ndescription: Brand voice\n---\nUse short words.')
    write(path.join(src, 'agents/reviewer.md'), '---\nname: Reviewer\ndescription: Reviews\n---\nBe strict.')
    write(path.join(src, '.mcp.json'), JSON.stringify({ mcpServers: { echo: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/s.mjs'] } } }))
    write(path.join(src, 'commands/x.md'), 'ignored')

    const ext = createExtensions(tmp('ext-'), plain)
    expect(ext.importPlugin(src)).toBe('acme-tools')
    const [p] = ext.listPlugins()
    expect(p).toMatchObject({ name: 'acme-tools', version: '1.2.0', skills: ['brand'], roles: ['Reviewer'], mcpServers: ['echo'], ignored: ['commands'] })
    expect(ext.pluginRoles()[0]).toMatchObject({ title: 'Reviewer', instructions: 'Be strict.' })
    const cfg = ext.mcpConfig('plugin:acme-tools:echo')!
    expect(cfg.args[0]).not.toContain('${')
    expect(cfg.args[0]).toContain(path.join('plugins', 'acme-tools'))

    ext.setPluginEnabled('acme-tools', false)
    expect(ext.enabledSkills().some((s) => s.name === 'brand')).toBe(false)
    expect(ext.listMcp()).toEqual([])
  })

  it('rejects an empty plugin folder', () => {
    expect(() => createExtensions(tmp('ext-'), plain).importPlugin(tmp('empty-'))).toThrow('E_PLUGIN_EMPTY')
  })

  it('keeps MCP secrets encrypted and hidden from the UI', () => {
    const dir = tmp('ext-')
    const ext = createExtensions(dir, plain)
    ext.saveMcp({ id: 'gh', name: 'GitHub', transport: 'http', command: '', args: [], url: 'https://x', enabled: true }, 'Authorization: Bearer secret')
    expect(ext.listMcp()[0]).toMatchObject({ hasSecrets: true })
    expect(JSON.stringify(ext.listMcp())).not.toContain('secret')
    expect(fs.readFileSync(path.join(dir, 'extensions.json'), 'utf8')).toContain('enc:')
    expect(ext.mcpConfig('gh')!.headers).toEqual({ Authorization: 'Bearer secret' })
    // Blank secrets keep the stored ones.
    ext.saveMcp({ id: 'gh', name: 'GitHub', transport: 'http', command: '', args: [], url: 'https://y', enabled: true }, '')
    expect(ext.mcpConfig('gh')!.headers.Authorization).toBe('Bearer secret')
  })
})

describe('mcp client', () => {
  const cfg = { name: 'Echo', transport: 'stdio' as const, command: process.execPath, args: [server], env: {}, url: '', headers: {} }

  it('initializes, lists and calls tools over stdio', async () => {
    const c = await McpClient.connect(cfg)
    expect((await c.listTools()).map((t) => t.name)).toEqual(['echo'])
    expect(await c.call('echo', { text: 'hi' })).toEqual({ content: 'echo: hi', isError: false })
    c.close()
  })

  it('exposes namespaced tools through the pool', async () => {
    const pool = new McpPool(() => cfg)
    const box = await pool.toolbox(['echo'])
    expect(box.defs.map((d) => d.name)).toEqual(['mcp_echo_echo'])
    expect((await box.call('mcp_echo_echo', { text: 'x' })).content).toBe('echo: x')
    pool.closeAll()
  })

  it('starts a server again after it died', async () => {
    const pool = new McpPool(() => cfg)
    const box = await pool.toolbox(['echo'])
    await expect(box.call('mcp_echo_echo', { text: 'crash' })).rejects.toThrow(/exited/)
    expect((await box.call('mcp_echo_echo', { text: 'again' })).content).toBe('echo: again')
    pool.closeAll()
  })

  it('reports a server that fails to start', async () => {
    const pool = new McpPool(() => ({ ...cfg, args: ['-e', 'process.exit(1)'] }))
    const box = await pool.toolbox(['bad'])
    expect(box.defs).toEqual([])
    expect(box.errors[0]).toMatch(/exited/)
  })

  it('makes provider-safe tool names', () => {
    expect(mcpToolName('My Server!', 'get.issue')).toBe('mcp_my_server_get_issue')
    expect(mcpToolName('s'.repeat(80), 't').length).toBe(64)
  })
})

describe('built-in tools', () => {
  const ctx = (root: string) => ({ root, send: () => '', remember: () => {}, report: () => {}, approve: async () => true, skill: () => undefined })

  it('search_files finds matches and stays inside the workspace', async () => {
    const root = tmp('ws-')
    write(path.join(root, 'src/a.ts'), 'const token = 1\nexport {}')
    const call = (input: Record<string, unknown>) => runTool({ id: '1', name: 'search_files', input }, ['search_files'], ctx(root))
    expect((await call({ pattern: 'TOKEN', path: '.' })).content).toBe('src/a.ts:1: const token = 1')
    expect((await call({ pattern: 'x', path: '..' })).isError).toBe(true)
    expect(() => inside(root, '../x')).toThrow()
  })

  it('web_fetch refuses non-http URLs and strips HTML', async () => {
    await expect(webFetch('file:///etc/passwd')).rejects.toThrow(/http/)
    expect(htmlToText('<p>Hi &amp; bye</p><script>x()</script><div>next</div>')).toBe('Hi & bye\nnext')
  })
})
