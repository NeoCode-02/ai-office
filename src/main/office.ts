import { randomUUID } from 'node:crypto'
import os from 'node:os'
import { SYSTEM, USER, type Agent, type OfficeEvent, type Project, type ToolName } from '../shared/types'
import { openChat, type Chat, type Conn, type ToolResult } from './providers'
import { runTool, TOOL_DEFS } from './tools'

export interface OfficeDeps {
  conn(providerId: string): Conn
  readNotes(agentId: string): string
  appendNote(agentId: string, note: string): void
  emit(ev: OfficeEvent): void
  openChat?: typeof openChat
}

const MAX_STEPS = 40 // tool-loop steps per wake-up

/** Checks the org chart: exactly one CEO, every manager exists, no cycles. */
export function validateOrg(agents: Agent[]): string | null {
  if (agents.length === 0) return 'Jamoada hech kim yo‘q'
  const ceos = agents.filter((a) => !a.reportsTo)
  if (ceos.length !== 1) return 'Aynan bitta bosh rahbar (hech kimga hisobot bermaydigan) bo‘lishi kerak'
  const byId = new Map(agents.map((a) => [a.id, a]))
  const names = new Set<string>()
  for (const a of agents) {
    const key = a.name.trim().toLowerCase()
    if (!key) return 'Har bir xodimga ism bering'
    if (names.has(key)) return `"${a.name}" ismi takrorlangan`
    names.add(key)
    if (!a.model.trim() || !a.providerId) return `${a.name}: provayder va model tanlang`
    const seen = new Set<string>()
    for (let cur: Agent | undefined = a; cur?.reportsTo; cur = byId.get(cur.reportsTo)) {
      if (!byId.has(cur.reportsTo)) return `${cur.name}: boshlig‘i topilmadi`
      if (seen.has(cur.id)) return `${a.name}: hisobot zanjirida aylana bor`
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

export function systemPrompt(p: Project, a: Agent, notes: string): string {
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

# Your role
${a.instructions.trim() || a.title}
${notes.trim() ? `\n# Your notes from earlier work\n${notes.trim()}` : ''}`
}

interface Member {
  agent: Agent
  chat?: Chat
  inbox: string[]
  open: ToolResult[]
  busy: boolean
}

export class Office {
  readonly runId = randomUUID()
  private members = new Map<string, Member>()
  private approvals = new Map<string, (ok: boolean) => void>()
  private running = false
  private spent = 0
  private ceo: Agent

  constructor(
    private project: Project,
    private deps: OfficeDeps
  ) {
    const err = validateOrg(project.agents)
    if (err) throw new Error(err)
    for (const a of project.agents) this.members.set(a.id, { agent: a, inbox: [], open: [], busy: false })
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

  stop(reason = 'Egasi to‘xtatdi') {
    if (!this.running) return
    for (const resolve of this.approvals.values()) resolve(false)
    this.approvals.clear()
    for (const m of this.members.values()) m.inbox = []
    this.running = false
    this.emit({ type: 'run', runId: this.runId, state: 'stopped', reason, at: Date.now() })
  }

  answer(approvalId: string, ok: boolean) {
    this.approvals.get(approvalId)?.(ok)
    this.approvals.delete(approvalId)
    this.emit({ type: 'approval_done', id: approvalId, approved: ok, at: Date.now() })
  }

  private emit(ev: OfficeEvent) {
    this.deps.emit(ev)
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
      while (this.running && m.inbox.length) {
        const text = m.inbox.splice(0).join('\n\n')
        await this.work(m, text)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.emit({ type: 'message', id: randomUUID(), at: Date.now(), from: SYSTEM, to: [], text: `${m.agent.name}: ${msg}` })
    } finally {
      m.busy = false
      this.emit({ type: 'status', agentId: m.agent.id, status: 'idle', at: Date.now() })
      this.checkIdle()
    }
  }

  private checkIdle() {
    if (!this.running) return
    for (const m of this.members.values()) if (m.busy || m.inbox.length) return
    this.setRunning(false, 'Jamoa ishni tugatdi — yangi xabar yozsangiz davom etadi')
  }

  private tools(a: Agent): ToolName[] {
    const extra: ToolName[] = a.reportsTo ? ['message', 'remember'] : ['message', 'remember', 'report_to_user']
    return [...new Set([...a.tools.filter((t) => t !== 'report_to_user'), ...extra])]
  }

  /** One wake-up: model ↔ tools until it stops calling tools. */
  private async work(m: Member, text: string) {
    const a = m.agent
    const allowed = this.tools(a)
    m.chat ??= (this.deps.openChat ?? openChat)(
      this.deps.conn(a.providerId),
      a.model,
      systemPrompt(this.project, a, this.deps.readNotes(a.id)),
      allowed.map((t) => TOOL_DEFS[t])
    )
    let sent = false
    let results = m.open.splice(0)
    let input: string | undefined = text

    for (let step = 0; ; step++) {
      if (step === MAX_STEPS) input = 'Step limit reached. Stop now and report your progress.'
      const turn = await m.chat.step(results, input)
      input = undefined
      this.charge(a, turn.inTok, turn.outTok)
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
        const r = await runTool(call, allowed, {
          root: this.project.workspaceDir,
          send: (to, body) => {
            const err = this.send(a, to, body)
            if (!err) sent = true
            return err
          },
          remember: (note) => this.deps.appendNote(a.id, note),
          report: (summary) => this.report(summary),
          approve: (command) => this.approve(a, command)
        })
        if (call.name !== 'message' && call.name !== 'report_to_user') {
          this.emit({ type: 'tool', id: randomUUID(), at: Date.now(), agentId: a.id, name: call.name, summary: summarize(call.input), ok: !r.isError })
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
      if (/^(owner|user|egasi)$/i.test(name.trim())) {
        if (from.reportsTo) return 'Faqat bosh rahbar egaga yoza oladi; boshlig‘ingizga yozing'
        ids.push(USER)
        continue
      }
      const target = this.findByName(name)
      if (!target) return `"${name}" degan xodim yo‘q. Mavjud: ${this.project.agents.map((x) => x.name).join(', ')}`
      if (target.id !== from.id) ids.push(target.id)
    }
    if (!ids.length) return 'Qabul qiluvchi yo‘q'
    this.emit({ type: 'message', id: randomUUID(), at: Date.now(), from: from.id, to: ids, text })
    const names = ids.map((id) => (id === USER ? 'owner' : this.members.get(id)!.agent.name)).join(', ')
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
    this.emit({ type: 'message', id: randomUUID(), at: Date.now(), from: this.ceo.id, to: [USER], text: summary })
    for (const m of this.members.values()) m.inbox = []
    this.setRunning(false, 'Yakuniy hisobot topshirildi')
  }

  private approve(a: Agent, command: string): Promise<boolean> {
    if (this.project.approval === 'auto') return Promise.resolve(true)
    const id = randomUUID()
    this.emit({ type: 'approval', id, agentId: a.id, command, at: Date.now() })
    this.emit({ type: 'status', agentId: a.id, status: 'waiting', at: Date.now() })
    return new Promise((resolve) =>
      this.approvals.set(id, (ok) => {
        this.emit({ type: 'status', agentId: a.id, status: 'working', at: Date.now() })
        resolve(ok)
      })
    )
  }

  private charge(a: Agent, inTok: number, outTok: number) {
    const usd = (inTok * a.priceIn + outTok * a.priceOut) / 1e6
    this.spent += usd
    this.emit({ type: 'cost', agentId: a.id, usd, inTok, outTok, at: Date.now() })
    if (this.project.budgetUsd > 0 && this.spent >= this.project.budgetUsd) {
      this.stop(`Byudjet tugadi ($${this.spent.toFixed(2)})`)
    }
  }
}

function summarize(input: Record<string, unknown>): string {
  const v = input.command ?? input.path ?? input.note ?? input.summary ?? ''
  return String(v).slice(0, 200)
}
