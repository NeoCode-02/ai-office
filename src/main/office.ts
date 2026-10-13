import { randomUUID } from 'node:crypto'
import os from 'node:os'
import { SYSTEM, USER, type Agent, type ModelRef, type OfficeEvent, type Project, type ToolName, type Usage } from '../shared/types'
import { classify, type Classified } from './errors'
import type { McpToolbox } from './mcp'
import { openChat, type Chat, type Conn, type ToolResult } from './providers'
import { runTool, TOOL_DEFS } from './tools'

export interface SkillInfo {
  name: string
  description: string
  body: string
  dir?: string
}

export interface OfficeDeps {
  conn(providerId: string): Conn
  /** USD for a request, 0 on flat-fee accounts, null when the price is unknown. */
  charge(providerId: string, model: string, usage: Usage): number | null
  readNotes(agentId: string): string
  appendNote(agentId: string, note: string): void
  emit(ev: OfficeEvent): void
  skills?(): SkillInfo[]
  mcp?(serverIds: string[]): Promise<McpToolbox>
  openChat?: typeof openChat
  /** Replaces the retry wait (tests). */
  sleep?(ms: number): Promise<void>
}

const MAX_STEPS = 40 // tool-loop steps per wake-up
// Waits between retries of a temporary error; a provider's retry-after wins, up to MAX_WAIT.
const RETRY_DELAYS = [5, 15, 30, 60, 120, 120].map((s) => s * 1000)
const MAX_WAIT = 300_000
const LOG_CHARS = 30_000 // work log handed to a backup model

/** Checks the org chart. Returns an error code (`CODE` or `CODE|name`) or null. */
export function validateOrg(agents: Agent[]): string | null {
  if (agents.length === 0) return 'E_ORG_EMPTY'
  if (agents.filter((a) => !a.reportsTo).length !== 1) return 'E_ORG_CEO'
  const byId = new Map(agents.map((a) => [a.id, a]))
  const names = new Set<string>()
  for (const a of agents) {
    const key = a.name.trim().toLowerCase()
    if (!key) return 'E_ORG_NAME'
    if (names.has(key)) return `E_ORG_DUP|${a.name}`
    names.add(key)
    if (!a.model.trim() || !a.providerId) return `E_ORG_MODEL|${a.name}`
    const seen = new Set<string>()
    for (let cur: Agent | undefined = a; cur?.reportsTo; cur = byId.get(cur.reportsTo)) {
      if (!byId.has(cur.reportsTo)) return `E_ORG_BOSS|${cur.name}`
      if (seen.has(cur.id)) return `E_ORG_CYCLE|${a.name}`
      seen.add(cur.id)
    }
  }
  return null
}

export function orgChart(agents: Agent[], me?: Agent): string {
  const lines: string[] = []
  const walk = (boss: string | null, depth: number) => {
    for (const a of agents.filter((x) => (x.reportsTo ?? null) === boss)) {
      const you = a.id === me?.id ? '  ← you' : ''
      lines.push(`${'  '.repeat(depth)}- ${a.name} — ${a.title}${a.department ? ` (${a.department})` : ''}${you}`)
      walk(a.id, depth + 1)
    }
  }
  walk(null, 0)
  return lines.join('\n')
}

export function systemPrompt(p: Project, a: Agent, notes: string, skills: SkillInfo[] = []): string {
  const boss = p.agents.find((x) => x.id === a.reportsTo)
  const reports = p.agents.filter((x) => x.reportsTo === a.id).map((x) => x.name)
  return `You are ${a.name}, ${a.title}${a.department ? ` in the ${a.department} department` : ''} at "${p.name}", a company staffed by AI colleagues. You are a full team member who owns your work, not a chat assistant.

# Company briefing
${p.briefing.trim() || '(none)'}

# Organisation
${orgChart(p.agents, a)}

${boss ? `Your manager: ${boss.name}.` : 'You are the top executive. You report directly to the owner (the human who set the goal).'}
${reports.length ? `Your direct reports: ${reports.join(', ')}.` : 'You have no direct reports.'}

# How work happens here
- Others only see what you send with the \`message\` tool. Address people by name.
- Take tasks from your manager. Delegate only to your direct reports; you may ask any colleague a question directly, across departments.
${reports.length ? `- As a manager: split work into clear tasks with acceptance criteria and give each to the best-suited report. Review every deliverable critically (open the files, run the checks). Send it back with concrete feedback until it meets the bar, then report upward. Do not do your reports' work yourself.\n` : ''}- When you finish a task, report to ${boss ? boss.name : 'the owner'}: what you did, where the output is, how you verified it.
${boss ? '' : '- When the whole goal is done and verified, call `report_to_user` with the final report. Message "owner" only if you are truly blocked on a decision.\n'}- If you end your turn without sending any message, your last reply is forwarded to ${boss ? boss.name : 'the owner'} automatically.
- Shared workspace: every file path is relative to it. OS: ${os.platform() === 'win32' ? 'Windows (run_command uses cmd.exe)' : os.platform()}.
- Use \`remember\` for durable lessons about this company (conventions, decisions, pitfalls).
- Reply in the language of the briefing and the goal.
${skills.length ? `\n# Skills\nLoad a skill with \`use_skill\` before doing work it covers:\n${skills.map((s) => `- ${s.name}: ${s.description}`).join('\n')}\n` : ''}
# Your role
${a.instructions.trim() || a.title}
${notes.trim() ? `\n# Your notes from earlier work\n${notes.trim()}` : ''}`
}

interface Member {
  agent: Agent
  chat?: Chat
  mcp?: McpToolbox
  inbox: string[]
  open: ToolResult[]
  busy: boolean
  /** Plain-text record of the member's work, for handing over to another model. */
  log: string[]
  /** Model in use when it is not the agent's own (backup or owner's choice). */
  override?: ModelRef
  onBackup?: boolean
  /** The next chat starts on a new model and gets the work log first. */
  handoff?: boolean
  blocked?: { id: string; input?: string; results: ToolResult[] }
  resume?: { input?: string; results: ToolResult[] }
}

export class Office {
  readonly runId = randomUUID()
  private members = new Map<string, Member>()
  private approvals = new Map<string, (ok: boolean) => void>()
  private running = false
  private wakers = new Set<() => void>()
  private spent = 0
  private ceo: Agent

  constructor(
    private project: Project,
    private deps: OfficeDeps
  ) {
    const err = validateOrg(project.agents)
    if (err) throw new Error(err)
    for (const a of project.agents) this.members.set(a.id, { agent: a, inbox: [], open: [], busy: false, log: [] })
    this.ceo = project.agents.find((a) => !a.reportsTo)!
  }

  get isRunning() {
    return this.running
  }

  start(goal: string) {
    this.post(goal)
  }

  /** Owner writes to the CEO (or any colleague). Resumes a finished run. */
  post(text: string, to: string = this.ceo.id) {
    this.emit({ type: 'message', id: randomUUID(), at: Date.now(), from: USER, to: [to], text })
    this.setRunning(true)
    this.deliver(to, `[From the owner] ${text}`)
  }

  stop(reason = 'owner_stopped', usd?: number) {
    if (!this.running) return
    for (const resolve of this.approvals.values()) resolve(false)
    this.approvals.clear()
    for (const w of [...this.wakers]) w()
    for (const m of this.members.values()) {
      m.inbox = []
      m.resume = undefined
      if (m.blocked) {
        m.open = m.chat ? m.blocked.results : []
        this.emit({ type: 'unblocked', id: m.blocked.id, agentId: m.agent.id, at: Date.now() })
        m.blocked = undefined
      }
    }
    this.running = false
    this.emit({ type: 'run', runId: this.runId, state: 'stopped', reason, usd, at: Date.now() })
  }

  /** Owner's answer to a blocked member: try again, optionally on another model. */
  retry(agentId: string, model?: ModelRef) {
    const m = this.members.get(agentId)
    if (!m?.blocked || !this.running) return
    const { id, input, results } = m.blocked
    m.blocked = undefined
    this.emit({ type: 'unblocked', id, agentId, at: Date.now() })
    if (model) {
      m.override = model
      m.chat = undefined
      m.handoff = true
    }
    m.resume = { input, results: m.chat ? results : [] }
    void this.wake(m)
  }

  answer(approvalId: string, ok: boolean) {
    this.approvals.get(approvalId)?.(ok)
    this.approvals.delete(approvalId)
    this.emit({ type: 'approval_done', id: approvalId, approved: ok, at: Date.now() })
  }

  private emit(ev: OfficeEvent) {
    this.deps.emit(ev)
  }

  private system(text: string) {
    this.emit({ type: 'message', id: randomUUID(), at: Date.now(), from: SYSTEM, to: [], text })
  }

  private setRunning(on: boolean, reason?: string) {
    if (this.running === on) return
    this.running = on
    this.emit({ type: 'run', runId: this.runId, state: on ? 'running' : 'done', reason, at: Date.now() })
  }

  private deliver(agentId: string, text: string) {
    const m = this.members.get(agentId)
    if (!m) return
    m.inbox.push(text)
    void this.wake(m)
  }

  private findByName(name: string): Agent | undefined {
    const key = name.trim().replace(/^@/, '').toLowerCase()
    return this.project.agents.find((a) => a.name.toLowerCase() === key || a.id === key)
  }

  private async wake(m: Member) {
    if (m.busy || !this.running) return
    m.busy = true
    this.emit({ type: 'status', agentId: m.agent.id, status: 'working', at: Date.now() })
    try {
      while (this.running && !m.blocked && (m.resume || m.inbox.length)) {
        const r = m.resume
        m.resume = undefined
        if (r) await this.work(m, r.input, r.results)
        else await this.work(m, m.inbox.splice(0).join('\n\n'))
      }
    } catch (e) {
      this.system(`${m.agent.name}: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      m.busy = false
      this.emit({ type: 'status', agentId: m.agent.id, status: m.blocked ? 'blocked' : 'idle', at: Date.now() })
      this.checkIdle()
    }
  }

  private checkIdle() {
    if (!this.running) return
    // A blocked member keeps the run open until the owner answers.
    for (const m of this.members.values()) if (m.busy || m.inbox.length || m.blocked) return
    this.setRunning(false, 'idle')
  }

  private tools(a: Agent, hasSkills: boolean): ToolName[] {
    const extra: ToolName[] = ['message', 'remember']
    if (!a.reportsTo) extra.push('report_to_user')
    if (hasSkills) extra.push('use_skill', 'read_skill_file')
    const own = a.tools.filter((t) => !['report_to_user', 'use_skill', 'read_skill_file'].includes(t))
    return [...new Set([...own, ...extra])]
  }

  private current(m: Member): ModelRef {
    return m.override ?? { providerId: m.agent.providerId, model: m.agent.model }
  }

  private log(m: Member, entry: string) {
    m.log.push(entry.length > 4000 ? `${entry.slice(0, 4000)}…` : entry)
    let size = m.log.reduce((n, e) => n + e.length, 0)
    while (size > LOG_CHARS && m.log.length > 1) size -= m.log.shift()!.length
  }

  /** Cancelled by stop(), so a long retry wait never outlives the run. */
  private pause(ms: number): Promise<void> {
    if (this.deps.sleep) return this.deps.sleep(ms)
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        this.wakers.delete(done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      this.wakers.add(done)
    })
  }

  /** A hard failure: move to the backup model once, otherwise stop and ask the owner. */
  private fail(m: Member, c: Classified): 'switched' | 'blocked' {
    const from = this.current(m)
    const b = m.agent.backup
    if (b?.providerId && b.model.trim() && !m.onBackup) {
      m.onBackup = true
      m.override = { providerId: b.providerId, model: b.model.trim() }
      m.chat = undefined
      m.handoff = true
      this.emit({ type: 'switch', agentId: m.agent.id, from, to: m.override, kind: c.kind, detail: c.detail, at: Date.now() })
      return 'switched'
    }
    const id = randomUUID()
    m.blocked = { id, results: [] }
    this.emit({ type: 'blocked', id, agentId: m.agent.id, ...from, kind: c.kind, detail: c.detail, at: Date.now() })
    return 'blocked'
  }

  /** Opens the chat on the member's current model; false when it ended up blocked. */
  private connect(m: Member, allowed: ToolName[], skills: SkillInfo[]): boolean {
    for (;;) {
      const cur = this.current(m)
      try {
        m.chat = (this.deps.openChat ?? openChat)(
          this.deps.conn(cur.providerId),
          cur.model,
          systemPrompt(this.project, m.agent, this.deps.readNotes(m.agent.id), skills),
          [...allowed.map((t) => TOOL_DEFS[t]), ...(m.mcp?.defs ?? [])]
        )
        return true
      } catch (e) {
        if (this.fail(m, classify(e)) === 'blocked') return false
      }
    }
  }

  /** One model request, retrying temporary errors. */
  private async ask(m: Member, results: ToolResult[], input?: string) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await m.chat!.step(results, input)
      } catch (e) {
        if (!this.running) return 'stopped'
        const c = classify(e)
        if (!c.retry || attempt >= RETRY_DELAYS.length) return this.fail(m, c)
        const waitMs = Math.min(c.retryAfterMs ?? RETRY_DELAYS[attempt], MAX_WAIT)
        this.emit({ type: 'notice', agentId: m.agent.id, kind: c.kind, attempt: attempt + 1, of: RETRY_DELAYS.length, waitMs, at: Date.now() })
        await this.pause(waitMs)
        if (!this.running) return 'stopped'
      }
    }
  }

  private handoff(m: Member, input?: string): string {
    const log = m.log.join('\n\n')
    const extra = input && !log.includes(input) ? `\n\n${input}` : ''
    return `Your previous AI model stopped working, so you now run on a different model. Your earlier conversation is not available; this is your recent work log:\n\n${log || '(empty)'}\n\nContinue your job from where you left off.${extra}`
  }

  /** One wake-up: model ↔ tools until it stops calling tools. */
  private async work(m: Member, text?: string, carried?: ToolResult[]) {
    const a = m.agent
    const skills = this.deps.skills?.() ?? []
    const allowed = this.tools(a, skills.length > 0)
    let results = carried ?? m.open.splice(0)
    let input: string | undefined = text
    if (text && !carried) this.log(m, text)
    const park = () => {
      m.blocked!.input = input
      m.blocked!.results = results
    }

    if (!m.mcp && a.mcpServers?.length && this.deps.mcp) {
      m.mcp = await this.deps.mcp(a.mcpServers)
      for (const err of m.mcp.errors) this.system(`${a.name}: MCP ${err}`)
    }
    if (!m.chat && !this.connect(m, allowed, skills)) return park()
    if (m.handoff) {
      m.handoff = false
      input = this.handoff(m, input)
      results = []
    }
    let sent = false

    for (let step = 0; ; step++) {
      if (step === MAX_STEPS) input = 'Step limit reached. Stop now and report your progress.'
      const turn = await this.ask(m, results, input)
      if (turn === 'stopped') {
        m.open = results
        return
      }
      if (turn === 'blocked') return park()
      if (turn === 'switched') {
        m.resume = { input, results: [] }
        return
      }
      input = undefined
      this.charge(m, turn.usage)
      if (!turn.calls.length) {
        if (!sent && turn.text.trim() && this.running) this.forward(a, turn.text)
        return
      }
      results = []
      for (const call of turn.calls) {
        if (!this.running || step >= MAX_STEPS) {
          results.push({ id: call.id, content: 'Interrupted', isError: true })
          continue
        }
        let r: { content: string; isError: boolean }
        let summary = summarize(call.input)
        if (m.mcp?.has(call.name)) {
          const label = m.mcp.label(call.name)
          summary = label
          r = (await this.approve(a, `${label} ${JSON.stringify(call.input)}`, 'mcp'))
            ? await m.mcp.call(call.name, call.input).catch((e: Error) => ({ content: e.message, isError: true }))
            : { content: 'The owner declined this tool call', isError: true }
        } else {
          r = await runTool(call, allowed, {
            root: this.project.workspaceDir,
            send: (to, body) => {
              const err = this.send(a, to, body)
              if (!err) sent = true
              return err
            },
            remember: (note) => this.deps.appendNote(a.id, note),
            report: (s) => this.report(s),
            approve: (command) => this.approve(a, command, 'command'),
            skill: (name) => skills.find((s) => s.name === name)
          })
        }
        if (call.name !== 'message' && call.name !== 'report_to_user') {
          this.log(m, `[You used ${call.name}${summary ? `: ${summary}` : ''} — ${r.isError ? 'failed' : 'ok'}]`)
          this.emit({ type: 'tool', id: randomUUID(), at: Date.now(), agentId: a.id, name: call.name, summary, ok: !r.isError })
        }
        results.push({ id: call.id, content: r.content, isError: r.isError })
      }
      // Unanswered calls are sent with the next wake-up so the history stays valid.
      if (!this.running || step >= MAX_STEPS) {
        m.open = results
        return
      }
    }
  }

  private send(from: Agent, to: string[], text: string): string {
    const ids: string[] = []
    for (const name of to) {
      if (/^(owner|user)$/i.test(name.trim())) {
        if (from.reportsTo) return 'Only the top executive can message the owner; report to your manager instead'
        ids.push(USER)
        continue
      }
      const target = this.findByName(name)
      if (!target) return `No colleague named "${name}". Colleagues: ${this.project.agents.map((x) => x.name).join(', ')}`
      if (target.id !== from.id) ids.push(target.id)
    }
    if (!ids.length) return 'No recipients'
    this.emit({ type: 'message', id: randomUUID(), at: Date.now(), from: from.id, to: ids, text })
    const names = ids.map((id) => (id === USER ? 'owner' : this.members.get(id)!.agent.name)).join(', ')
    this.log(this.members.get(from.id)!, `[You → ${names}] ${text}`)
    for (const id of ids) {
      if (id !== USER) this.deliver(id, `[From ${from.name} — ${from.title} → ${names}] ${text}`)
    }
    return ''
  }

  private forward(a: Agent, text: string) {
    if (a.reportsTo) this.send(a, [a.reportsTo], text)
    else this.emit({ type: 'message', id: randomUUID(), at: Date.now(), from: a.id, to: [USER], text })
  }

  private report(summary: string) {
    this.log(this.members.get(this.ceo.id)!, `[You → owner, final report] ${summary}`)
    this.emit({ type: 'message', id: randomUUID(), at: Date.now(), from: this.ceo.id, to: [USER], text: summary })
    for (const m of this.members.values()) m.inbox = []
    this.setRunning(false, 'report')
  }

  private approve(a: Agent, command: string, kind: 'command' | 'mcp'): Promise<boolean> {
    if (this.project.approval === 'auto') return Promise.resolve(true)
    const id = randomUUID()
    this.emit({ type: 'approval', id, agentId: a.id, kind, command, at: Date.now() })
    this.emit({ type: 'status', agentId: a.id, status: 'waiting', at: Date.now() })
    return new Promise((resolve) =>
      this.approvals.set(id, (ok) => {
        this.emit({ type: 'status', agentId: a.id, status: 'working', at: Date.now() })
        resolve(ok)
      })
    )
  }

  private charge(m: Member, usage: Usage) {
    const a = m.agent
    const { providerId, model } = this.current(m)
    const usd = this.deps.charge(providerId, model, usage)
    this.spent += usd ?? 0
    this.emit({ type: 'cost', agentId: a.id, providerId, model, usd, usage, at: Date.now() })
    if (this.project.budgetUsd > 0 && this.spent >= this.project.budgetUsd) this.stop('budget', this.spent)
  }
}

function summarize(input: Record<string, unknown>): string {
  const v = input.command ?? input.path ?? input.url ?? input.pattern ?? input.name ?? input.note ?? ''
  return String(v).slice(0, 200)
}
