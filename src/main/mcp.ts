import { spawn, type ChildProcess } from 'node:child_process'
import type { ToolDef } from './providers'

/** Minimal MCP client: tools only, stdio + Streamable HTTP. No OAuth (use a header token). */
export interface McpConfig {
  name: string
  transport: 'stdio' | 'http'
  command: string
  args: string[]
  env: Record<string, string>
  url: string
  headers: Record<string, string>
}

export interface McpTool {
  name: string
  description?: string
  inputSchema?: { type?: string; properties?: Record<string, unknown>; required?: string[] }
}

interface RpcMessage {
  jsonrpc: '2.0'
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string }
}

const PROTOCOL = '2025-06-18'
const TIMEOUT = 120_000

export class McpClient {
  private nextId = 1
  private pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>()
  private child?: ChildProcess
  private stderr = ''
  private session?: string
  private version = PROTOCOL

  private constructor(private cfg: McpConfig) {}

  static async connect(cfg: McpConfig, clientVersion = '0.0.0'): Promise<McpClient> {
    const c = new McpClient(cfg)
    if (cfg.transport === 'stdio') c.spawn()
    try {
      const init = (await c.request('initialize', {
        protocolVersion: PROTOCOL,
        capabilities: {},
        clientInfo: { name: 'ai-office', version: clientVersion }
      })) as { protocolVersion?: string }
      if (init.protocolVersion) c.version = init.protocolVersion
      await c.notify('notifications/initialized')
      return c
    } catch (e) {
      c.close()
      throw e
    }
  }

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = []
    let cursor: string | undefined
    do {
      const r = (await this.request('tools/list', cursor ? { cursor } : {})) as { tools: McpTool[]; nextCursor?: string }
      tools.push(...r.tools)
      cursor = r.nextCursor
    } while (cursor)
    return tools
  }

  async call(name: string, args: Record<string, unknown>): Promise<{ content: string; isError: boolean }> {
    const r = (await this.request('tools/call', { name, arguments: args })) as {
      content?: { type: string; text?: string; resource?: { text?: string; uri?: string } }[]
      structuredContent?: unknown
      isError?: boolean
    }
    const parts = (r.content ?? []).map((c) =>
      c.type === 'text' ? (c.text ?? '') : c.type === 'resource' ? (c.resource?.text ?? c.resource?.uri ?? '') : `[${c.type}]`
    )
    if (!parts.length && r.structuredContent) parts.push(JSON.stringify(r.structuredContent))
    return { content: parts.join('\n') || '(empty result)', isError: Boolean(r.isError) }
  }

  close() {
    for (const p of this.pending.values()) p.reject(new Error('MCP connection closed'))
    this.pending.clear()
    this.child?.kill()
    this.child = undefined
  }

  private spawn() {
    const win = process.platform === 'win32'
    // .cmd shims (npx, uvx) need a shell on Windows; quote args ourselves.
    const q = (s: string) => (win && /[\s"&|<>^]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
    const child = spawn(win ? [this.cfg.command, ...this.cfg.args].map(q).join(' ') : this.cfg.command, win ? [] : this.cfg.args, {
      env: { ...process.env, ...this.cfg.env },
      shell: win,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.child = child
    let buf = ''
    child.stdout!.on('data', (d: Buffer) => {
      buf += d.toString()
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (line) this.onMessage(line)
      }
    })
    child.stderr!.on('data', (d: Buffer) => (this.stderr = (this.stderr + d.toString()).slice(-2000)))
    const fail = (why: string) => {
      for (const p of this.pending.values()) p.reject(new Error(`${this.cfg.name}: ${why}${this.stderr ? `\n${this.stderr.trim()}` : ''}`))
      this.pending.clear()
    }
    child.on('error', (e) => fail(e.message))
    child.on('exit', (code) => fail(`process exited (${code})`))
  }

  private onMessage(line: string) {
    let msg: RpcMessage
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    // Server → client request (e.g. ping): answer so the server doesn't hang.
    if (msg.method && msg.id !== undefined) {
      const reply = msg.method === 'ping' ? { result: {} } : { error: { code: -32601, message: 'Method not found' } }
      this.child?.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...reply }) + '\n')
      return
    }
    if (typeof msg.id !== 'number') return
    const p = this.pending.get(msg.id)
    if (!p) return
    this.pending.delete(msg.id)
    if (msg.error) p.reject(new Error(`${this.cfg.name}: ${msg.error.message}`))
    else p.resolve(msg.result)
  }

  private async notify(method: string) {
    const msg = { jsonrpc: '2.0', method }
    if (this.cfg.transport === 'stdio') this.child?.stdin?.write(JSON.stringify(msg) + '\n')
    else await this.post(msg)
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++
    const msg: RpcMessage = { jsonrpc: '2.0', id, method, params }
    if (this.cfg.transport === 'http') return this.httpRequest(msg)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${this.cfg.name}: ${method} timed out`))
      }, TIMEOUT)
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e))
      })
      if (!this.child?.stdin?.writable) return this.pending.get(id)!.reject(new Error(`${this.cfg.name}: not running`))
      this.child.stdin.write(JSON.stringify(msg) + '\n')
    })
  }

  private async post(msg: object): Promise<Response> {
    const res = await fetch(this.cfg.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': this.version,
        ...(this.session ? { 'Mcp-Session-Id': this.session } : {}),
        ...this.cfg.headers
      },
      body: JSON.stringify(msg),
      signal: AbortSignal.timeout(TIMEOUT)
    })
    this.session = res.headers.get('mcp-session-id') ?? this.session
    if (!res.ok && res.status !== 202) throw new Error(`${this.cfg.name}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`)
    return res
  }

  private async httpRequest(msg: RpcMessage): Promise<unknown> {
    const res = await this.post(msg)
    const body = await res.text()
    const messages: RpcMessage[] = (res.headers.get('content-type') ?? '').includes('text/event-stream')
      ? body.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5)))
      : [JSON.parse(body)]
    const reply = messages.find((m) => m.id === msg.id)
    if (!reply) throw new Error(`${this.cfg.name}: no response to ${msg.method}`)
    if (reply.error) throw new Error(`${this.cfg.name}: ${reply.error.message}`)
    return reply.result
  }
}

/** Tool name the model sees: provider APIs allow [a-zA-Z0-9_-]{1,64}. */
export function mcpToolName(server: string, tool: string): string {
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '')
  return `mcp_${slug(server)}_${slug(tool)}`.slice(0, 64)
}

export function mcpToolDef(server: string, t: McpTool): ToolDef {
  const schema = t.inputSchema ?? {}
  return {
    name: mcpToolName(server, t.name),
    description: `[${server}] ${t.description ?? t.name}`.slice(0, 1024),
    parameters: { ...schema, type: 'object', properties: schema.properties ?? {}, required: schema.required ?? [] }
  }
}

export interface McpToolbox {
  defs: ToolDef[]
  errors: string[]
  has(name: string): boolean
  label(name: string): string
  call(name: string, args: Record<string, unknown>): Promise<{ content: string; isError: boolean }>
}

/** Shares one connection per server across a run's agents; reconnects lazily after closeAll(). */
export class McpPool {
  private clients = new Map<string, Promise<McpClient>>()

  constructor(
    private config: (id: string) => McpConfig | null,
    private clientVersion?: string
  ) {}

  private get(id: string, cfg: McpConfig): Promise<McpClient> {
    let c = this.clients.get(id)
    if (!c) {
      c = McpClient.connect(cfg, this.clientVersion)
      c.catch(() => this.clients.delete(id))
      this.clients.set(id, c)
    }
    return c
  }

  async toolbox(ids: string[]): Promise<McpToolbox> {
    const defs: ToolDef[] = []
    const errors: string[] = []
    const routes = new Map<string, { id: string; cfg: McpConfig; tool: string }>()
    for (const id of ids) {
      const cfg = this.config(id)
      if (!cfg) continue
      try {
        for (const t of await (await this.get(id, cfg)).listTools()) {
          const def = mcpToolDef(cfg.name, t)
          if (routes.has(def.name)) continue
          routes.set(def.name, { id, cfg, tool: t.name })
          defs.push(def)
        }
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e))
      }
    }
    return {
      defs,
      errors,
      has: (name) => routes.has(name),
      label: (name) => `${routes.get(name)?.cfg.name} › ${routes.get(name)?.tool}`,
      call: async (name, args) => {
        const r = routes.get(name)!
        return (await this.get(r.id, r.cfg)).call(r.tool, args)
      }
    }
  }

  closeAll() {
    for (const c of this.clients.values()) void c.then((x) => x.close(), () => {})
    this.clients.clear()
  }
}
