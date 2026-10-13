import { randomUUID } from 'node:crypto'
import os from 'node:os'
import {
  DEFAULT_LIMITS,
  DEFAULT_SANDBOX,
  SYSTEM,
  USER,
  type Agent,
  type Limits,
  type ModelRef,
  type OfficeEvent,
  type Project,
  type Sandbox,
  type ToolName,
  type Usage
} from '../shared/types'
import { classify, type Classified } from './errors'
import type { McpToolbox } from './mcp'
import { openChat, type Chat, type Conn, type ToolCall, type ToolResult } from './providers'
import { clip, runTool, TOOL_DEFS, type ToolOutcome } from './tools'

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
  /** The reply a member is writing right now (not saved); null when it is finished. */
  stream?(agentId: string, text: string | null): void
  /** Keep an allow-list entry the owner granted with "always". */
  allow?(rule: string): void
  skills?(): SkillInfo[]
  mcp?(serverIds: string[]): Promise<McpToolbox>
  openChat?: typeof openChat
  /** Replaces the retry wait (tests). */
  sleep?(ms: number): Promise<void>
}

export type ApprovalKind = 'command' | 'mcp' | 'fetch'

const MAX_STEPS = 40 // tool-loop steps per wake-up
// Waits between retries of a temporary error; a provider's retry-after wins, up to MAX_WAIT.
const RETRY_DELAYS = [5, 15, 30, 60, 120, 120].map((s) => s * 1000)
const MAX_WAIT = 300_000
const LOG_CHARS = 30_000 // work log handed to a backup model
const MCP_CHARS = 20_000
const DETAIL_CHARS = 2000
const DIFF_CHARS = 8000
const COMPACT =
  'Your conversation is getting long and will be restarted. Write a complete summary of your work so far: the task and who gave it, decisions, files you created or changed, what is verified, open problems and the exact next steps. Do not call tools.'
const PLAN_FIRST = "Propose your plan with propose_plan and wait for the owner's approval first"
const PLAN_GATED = new Set<string>(['write_file', 'edit_file', 'run_command'])
const MANAGED: ToolName[] = ['report_to_user', 'use_skill', 'read_skill_file', 'propose_plan']
// A command with any of these could run more than the allowed prefix says.
const CONTROL = /[;&|`$<>(){}\n\r]/

const normalize = (command: string) => command.trim().replace(/\s+/g, ' ')

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/** Whether `allowCommands` lets this through without asking. key: the command, the MCP label or the host. */
export function isAllowed(list: string[], kind: ApprovalKind, key: string): boolean {
  if (kind === 'mcp') return list.includes(`mcp:${key}`)
  if (kind === 'fetch') return !!key && list.includes(`fetch:${key}`)
  if (CONTROL.test(key)) return false
  const cmd = normalize(key)
  return list.some((entry) => {
    const e = normalize(entry)
    return !!e && !/^(mcp|fetch):/.test(e) && (cmd === e || cmd.startsWith(`${e} `))
  })
}

/** The allow-list entry an "always" answer adds; undefined when it must not be allowed for good. */
export function allowRule(kind: ApprovalKind, key: string): string | undefined {
  if (kind === 'mcp') return `mcp:${key}`
  if (kind === 'fetch') return key ? `fetch:${key}` : undefined
  const cmd = normalize(key)
  return cmd && !CONTROL.test(key) ? cmd : undefined
}

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
${boss ? '' : '- When the whole goal is done and verified, call `report_to_user` with the final report. Message "owner" only if you are truly blocked on a decision.\n'}${!boss && p.planFirst ? '- This office works plan-first: before delegating or changing anything, send your plan to the owner with `propose_plan` and wait for their approval.\n' : ''}- If you end your turn without sending any message, your last reply is forwarded to ${boss ? boss.name : 'the owner'} automatically.
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
  /** The next chat starts with the work log: on a new model, or after a context restart. */
  handoff?: 'switch' | 'compact'
  /** The next chat starts with this summary of the compacted one. */
  summary?: string
  /** Prompt tokens of the last request on the current chat. */
  promptSize: number
  /** One context error already restarted the chat; the next one goes to the backup. */
  contextRestarted?: boolean
  /** This wake-up called a tool other than message/remember. */
  worked?: boolean
  blocked?: { id: string; input?: string; results: ToolResult[] }
  resume?: { input?: string; results: ToolResult[] }
}

interface Pending {
  resolve(ok: boolean): void
  rule?: string
}

type StopExtra = { usd?: number; requests?: number; agents?: string[] }

export class Office {
  readonly runId = randomUUID()
  private members = new Map<string, Member>()
  private approvals = new Map<string, Pending>()
  private running = false
  private wakers = new Set<() => void>()
  private spent = 0
  private requestCount = 0
  /** The request cap counts from the owner's latest message, so continuing after a 'limit' stop works. */
  private capBase = 0
  private ceo: Agent
  /** Aborted by stop(); a new one for each running period. */
  private ac = new AbortController()
  /** Consecutive messages per pair of members without other work. */
  private chatter = new Map<string, number>()
  /** Workspace files changed since the last approved command. */
  private changed = new Set<string>()
  private plan?: { id: string }
  private planApproved = false
  private dockerWarned = false

  constructor(
    private project: Project,
    private deps: OfficeDeps
  ) {
    const err = validateOrg(project.agents)
    if (err) throw new Error(err)
    for (const a of project.agents) this.members.set(a.id, { agent: a, inbox: [], open: [], busy: false, log: [], promptSize: 0 })
    this.ceo = project.agents.find((a) => !a.reportsTo)!
  }

  get isRunning() {
    return this.running
  }

  /** Completed model requests in this run. */
  get requests() {
    return this.requestCount
  }

  get spentUsd() {
    return this.spent
  }

  private get limits(): Limits {
    return this.project.limits ?? DEFAULT_LIMITS
  }

  private get sandbox(): Sandbox {
    return this.project.sandbox ?? DEFAULT_SANDBOX
  }

  start(goal: string) {
    this.post(goal)
  }

  /** Owner writes to the CEO (or any colleague). Resumes a finished run. */
  post(text: string, to: string = this.ceo.id) {
    this.checkBudget()
    this.chatter.clear()
    this.capBase = this.requestCount
    this.emit({ type: 'message', id: randomUUID(), at: Date.now(), from: USER, to: [to], text })
    this.setRunning(true)
    this.deliver(to, `[From the owner] ${text}`)
  }

  stop(reason = 'owner_stopped', extra: StopExtra = {}) {
    if (!this.running) return
    this.running = false
    this.cleanup()
    this.emit({ type: 'run', runId: this.runId, state: 'stopped', reason, ...extra, at: Date.now() })
  }

  /** Settings the owner may change while the office runs; members and their models stay. */
  configure(p: Project) {
    const { budgetUsd, limits, approval, allowCommands, planFirst, sandbox } = p
    this.project = { ...this.project, budgetUsd, limits, approval, allowCommands, planFirst, sandbox }
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
      m.handoff = 'switch'
    }
    m.resume = { input, results: m.chat ? results : [] }
    void this.wake(m)
  }

  answer(approvalId: string, ok: boolean, always = false) {
    const p = this.approvals.get(approvalId)
    if (!p) return
    this.approvals.delete(approvalId)
    const keep = ok && always && p.rule !== undefined
    if (keep) this.addRule(p.rule!)
    this.emit({ type: 'approval_done', id: approvalId, approved: ok, ...(keep ? { always: true } : {}), at: Date.now() })
    p.resolve(ok)
  }

  answerPlan(planId: string, approved: boolean, feedback?: string) {
    if (this.plan?.id !== planId) return
    this.checkBudget()
    this.plan = undefined
    const fb = feedback?.trim()
    this.emit({ type: 'plan_done', id: planId, approved, ...(!approved && fb ? { feedback: fb } : {}), at: Date.now() })
    if (approved) this.planApproved = true
    this.post(approved ? 'Plan approved. Go ahead.' : `The plan needs changes: ${fb || '(no details given)'}`)
  }

  private checkBudget() {
    const budget = this.project.budgetUsd
    if (budget > 0 && this.spent >= budget) throw new Error(`E_BUDGET_SPENT|${budget}`)
  }

  private addRule(rule: string) {
    const list = this.project.allowCommands ?? []
    if (list.includes(rule)) return
    this.project = { ...this.project, allowCommands: [...list, rule] }
    this.deps.allow?.(rule)
  }

  /** Shared by stop() and the final report: nothing may keep waiting or running. */
  private cleanup() {
    this.ac.abort()
    const pending = [...this.approvals]
    this.approvals.clear()
    for (const [id, p] of pending) {
      this.emit({ type: 'approval_done', id, approved: false, at: Date.now() })
      p.resolve(false)
    }
    if (this.plan) {
      this.emit({ type: 'plan_done', id: this.plan.id, approved: false, at: Date.now() })
      this.plan = undefined
    }
    for (const w of [...this.wakers]) w()
    for (const m of this.members.values()) {
      m.inbox = []
      m.resume = undefined
      if (m.blocked) {
        m.open = m.chat ? m.blocked.results : []
        this.emit({ type: 'unblocked', id: m.blocked.id, agentId: m.agent.id, at: Date.now() })
        m.blocked = undefined
      }
      this.deps.stream?.(m.agent.id, null)
    }
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
    if (on) this.ac = new AbortController()
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
    this.setRunning(false, this.plan ? 'plan' : 'idle')
  }

  private tools(a: Agent, hasSkills: boolean): ToolName[] {
    const extra: ToolName[] = ['message', 'remember']
    if (!a.reportsTo) extra.push('report_to_user')
    if (!a.reportsTo && this.project.planFirst) extra.push('propose_plan')
    if (hasSkills) extra.push('use_skill', 'read_skill_file')
    const own = a.tools.filter((t) => !MANAGED.includes(t))
    return [...new Set([...own, ...extra])]
  }

  /** Enabled skills, narrowed to the member's own list when it has one. */
  private skillsFor(a: Agent): SkillInfo[] {
    const all = this.deps.skills?.() ?? []
    return a.skills ? all.filter((s) => a.skills!.includes(s.name)) : all
  }

  /** The CEO may only read until the owner approves a plan. */
  private gated(a: Agent): boolean {
    return !!this.project.planFirst && !a.reportsTo && !this.planApproved
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

  /** Settles with `stopped` as soon as the run is stopped (for work that takes no signal). */
  private race<T>(p: Promise<T>, stopped: T): Promise<T> {
    const signal = this.ac.signal
    if (signal.aborted) return Promise.resolve(stopped)
    return new Promise((resolve) => {
      const onAbort = () => resolve(stopped)
      signal.addEventListener('abort', onAbort, { once: true })
      void p.then(resolve).finally(() => signal.removeEventListener('abort', onAbort))
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
      m.handoff = 'switch'
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
    const a = m.agent
    for (;;) {
      const cur = this.current(m)
      try {
        m.chat = (this.deps.openChat ?? openChat)(
          this.deps.conn(cur.providerId),
          cur.model,
          systemPrompt(this.project, a, this.deps.readNotes(a.id), skills),
          [...allowed.map((t) => TOOL_DEFS[t]), ...(m.mcp?.defs ?? [])],
          { effort: a.effort, maxTokens: a.maxTokens }
        )
        m.promptSize = 0
        return true
      } catch (e) {
        if (this.fail(m, classify(e)) === 'blocked') return false
      }
    }
  }

  /** One model request, retrying temporary errors. Aborted requests are never retried. */
  private async ask(m: Member, results: ToolResult[], input?: string) {
    const id = m.agent.id
    const signal = this.ac.signal
    const stream = this.deps.stream
    const onText = stream && ((s: string) => stream(id, s))
    for (let attempt = 0; ; attempt++) {
      try {
        const turn = await m.chat!.step(results, input, { signal, onText })
        m.contextRestarted = false
        return turn
      } catch (e) {
        const c = classify(e)
        if (c.aborted || signal.aborted || !this.running) return 'stopped'
        if (c.kind === 'context' && !m.contextRestarted) {
          // First try a fresh conversation from the work log on the same model.
          m.contextRestarted = true
          m.chat = undefined
          m.handoff = 'compact'
          this.emit({ type: 'compact', agentId: id, tokens: m.promptSize, at: Date.now() })
          return 'switched'
        }
        if (!c.retry || attempt >= RETRY_DELAYS.length) return this.fail(m, c)
        const waitMs = Math.min(c.retryAfterMs ?? RETRY_DELAYS[attempt], MAX_WAIT)
        this.emit({ type: 'notice', agentId: id, kind: c.kind, attempt: attempt + 1, of: RETRY_DELAYS.length, waitMs, at: Date.now() })
        await this.pause(waitMs)
        if (!this.running || signal.aborted) return 'stopped'
      } finally {
        stream?.(id, null)
      }
    }
  }

  private handoff(m: Member, kind: 'switch' | 'compact', input?: string): string {
    const log = m.log.join('\n\n')
    const extra = input && !log.includes(input) ? `\n\n${input}` : ''
    const why =
      kind === 'switch' ? 'Your previous AI model stopped working, so you now run on a different model.' : 'Your conversation got too long, so it was restarted.'
    return `${why} Your earlier conversation is not available; this is your recent work log:\n\n${log || '(empty)'}\n\nContinue your job from where you left off.${extra}`
  }

  /** One wake-up: model ↔ tools until it stops calling tools. */
  private async work(m: Member, text?: string, carried?: ToolResult[]) {
    const a = m.agent
    const skills = this.skillsFor(a)
    const allowed = this.tools(a, skills.length > 0)
    let results = carried ?? m.open.splice(0)
    let input: string | undefined = text
    m.worked = false
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
      input = this.handoff(m, m.handoff, input)
      m.handoff = undefined
      results = []
    } else if (m.summary !== undefined) {
      input = `Summary of your work so far (your earlier conversation was compacted):\n\n${m.summary}${input ? `\n\n${input}` : ''}`
      m.summary = undefined
      results = []
    }
    let sent = false

    for (let step = 0; ; step++) {
      if (step === MAX_STEPS) input = 'Step limit reached. Stop now and report your progress.'
      const compactAt = this.limits.compactAt
      const tokens = m.promptSize
      const compacting = compactAt > 0 && tokens >= compactAt
      const turn = await this.ask(m, results, compacting ? COMPACT : input)
      if (turn === 'stopped') {
        m.open = results
        return
      }
      if (turn === 'blocked') return park()
      if (turn === 'switched') {
        m.resume = { input, results: [] }
        return
      }
      if (compacting) {
        // The pending input goes to a fresh chat that starts from the summary.
        m.chat = undefined
        if (turn.text.trim()) m.summary = turn.text.trim()
        else m.handoff = 'compact'
        m.resume = { input, results: [] }
        this.emit({ type: 'compact', agentId: a.id, tokens, at: Date.now() })
        this.charge(m, turn.usage, turn.model)
        return
      }
      input = undefined
      m.promptSize = turn.usage.in + turn.usage.cacheRead + turn.usage.cacheWrite
      this.charge(m, turn.usage, turn.model)
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
        if (call.name !== 'message' && call.name !== 'remember') this.didWork(m)
        const { r, summary } = await this.call(m, call, allowed, skills, () => (sent = true))
        if (call.name !== 'message' && call.name !== 'report_to_user') {
          this.log(m, `[You used ${call.name}${summary ? `: ${summary}` : ''} — ${r.isError ? 'failed' : 'ok'}]`)
          const detail = call.name === 'propose_plan' ? '' : r.content.slice(0, DETAIL_CHARS)
          this.emit({
            type: 'tool',
            id: randomUUID(),
            at: Date.now(),
            agentId: a.id,
            name: call.name,
            summary,
            ok: !r.isError,
            ...(detail ? { detail } : {}),
            ...(r.diff ? { diff: clip(r.diff, DIFF_CHARS) } : {})
          })
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

  /** Runs one tool call (built-in or MCP) for a member. */
  private async call(m: Member, call: ToolCall, allowed: ToolName[], skills: SkillInfo[], onSent: () => void): Promise<{ r: ToolOutcome; summary: string }> {
    const a = m.agent
    const mcp = m.mcp?.has(call.name) ? m.mcp : undefined
    const summary = mcp ? mcp.label(call.name) : summarize(call.input)
    if (this.gated(a) && (mcp || PLAN_GATED.has(call.name))) return { r: { content: PLAN_FIRST, isError: true }, summary }
    if (mcp) {
      const go = await this.approve(a, 'mcp', `${summary} ${JSON.stringify(call.input)}`, summary)
      const r = go
        ? await this.race(
            mcp.call(call.name, call.input).catch((e: Error) => ({ content: e.message, isError: true })),
            { content: 'Stopped', isError: true }
          )
        : { content: 'The owner declined this tool call', isError: true }
      return { r: { content: clip(r.content, MCP_CHARS), isError: r.isError }, summary }
    }
    const r = await runTool(call, allowed, {
      root: this.project.workspaceDir,
      send: (to, body) => {
        if (this.gated(a) && to.some((n) => !isOwner(n))) return PLAN_FIRST
        const err = this.send(a, to, body)
        if (!err) onSent()
        return err
      },
      remember: (note) => this.deps.appendNote(a.id, note),
      report: (s) => this.report(s),
      plan: (text) => this.proposePlan(a, text),
      approve: (command) => this.approve(a, 'command', command),
      approveFetch: (url) => this.approve(a, 'fetch', url, hostOf(url)),
      skill: (name) => skills.find((s) => s.name === name),
      signal: this.ac.signal,
      sandbox: this.sandbox
    })
    if (r.changed) this.changed.add(r.changed)
    if (call.name === 'run_command' && r.content.startsWith('E_NO_DOCKER:') && !this.dockerWarned) {
      this.dockerWarned = true
      this.system('E_NO_DOCKER')
    }
    return { r, summary }
  }

  /** Real work ends any back-and-forth this member was part of. */
  private didWork(m: Member) {
    m.worked = true
    for (const key of [...this.chatter.keys()]) if (key.split('\n').includes(m.agent.id)) this.chatter.delete(key)
  }

  /** Counts a message without other work; returns the pair's names when it is a loop. */
  private countChatter(from: Member, ids: string[]): string[] | undefined {
    if (from.worked) return
    const max = this.limits.maxChatter
    for (const id of ids) {
      if (id === USER) continue
      const key = [from.agent.id, id].sort().join('\n')
      const n = (this.chatter.get(key) ?? 0) + 1
      this.chatter.set(key, n)
      if (max > 0 && n >= max) return [from.agent.name, this.members.get(id)!.agent.name]
    }
  }

  private send(from: Agent, to: string[], text: string): string {
    const ids: string[] = []
    for (const name of to) {
      if (isOwner(name)) {
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
    const m = this.members.get(from.id)!
    this.log(m, `[You → ${names}] ${text}`)
    const loop = this.countChatter(m, ids)
    if (loop) {
      this.stop('loop', { agents: loop })
      return ''
    }
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
    this.cleanup()
    this.setRunning(false, 'report')
  }

  private proposePlan(a: Agent, text: string): string {
    if (this.plan) this.emit({ type: 'plan_done', id: this.plan.id, approved: false, at: Date.now() })
    this.plan = { id: randomUUID() }
    this.emit({ type: 'plan', id: this.plan.id, agentId: a.id, text, at: Date.now() })
    return 'Plan sent to the owner. End your turn now and wait for their answer.'
  }

  /** key: the command, the MCP tool label or the fetched host (what an allow-list entry names). */
  private approve(a: Agent, kind: ApprovalKind, command: string, key = command): Promise<boolean> {
    const approved = (ok: boolean) => {
      if (ok && kind === 'command') this.changed.clear()
      return ok
    }
    if (this.project.approval === 'auto' || isAllowed(this.project.allowCommands ?? [], kind, key)) return Promise.resolve(approved(true))
    const id = randomUUID()
    const files = kind === 'command' && this.changed.size ? { files: [...this.changed] } : {}
    const sandbox = kind === 'command' && this.sandbox.kind === 'docker' ? { sandbox: true } : {}
    this.emit({ type: 'approval', id, agentId: a.id, kind, command, ...files, ...sandbox, at: Date.now() })
    this.emit({ type: 'status', agentId: a.id, status: 'waiting', at: Date.now() })
    return new Promise((resolve) =>
      this.approvals.set(id, {
        rule: allowRule(kind, key),
        resolve: (ok) => {
          this.emit({ type: 'status', agentId: a.id, status: 'working', at: Date.now() })
          resolve(approved(ok))
        }
      })
    )
  }

  /** `served`: the model that really answered (a server-side fallback), priced instead of the requested one. */
  private charge(m: Member, usage: Usage, served?: string) {
    const a = m.agent
    const { providerId, model: asked } = this.current(m)
    const model = served ?? asked
    const usd = this.deps.charge(providerId, model, usage)
    this.spent += usd ?? 0
    this.requestCount++
    this.emit({ type: 'cost', agentId: a.id, providerId, model, usd, usage, at: Date.now() })
    const max = this.limits.maxRequests
    if (this.project.budgetUsd > 0 && this.spent >= this.project.budgetUsd) this.stop('budget', { usd: this.spent })
    else if (max > 0 && this.requestCount - this.capBase >= max) this.stop('limit', { requests: this.requestCount - this.capBase })
  }
}

const isOwner = (name: string) => /^(owner|user)$/i.test(name.trim())

function summarize(input: Record<string, unknown>): string {
  const v = input.command ?? input.path ?? input.url ?? input.pattern ?? input.name ?? input.note ?? ''
  return String(v).slice(0, 200)
}
