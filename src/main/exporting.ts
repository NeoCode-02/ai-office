import { SYSTEM, USER, type Agent, type OfficeEvent, type Project, type RunSummary } from '../shared/types'
import { isProject, obj } from './validate'

const FORMAT = 'ai-office/project'

export function projectToJson(p: Project): string {
  return JSON.stringify({ format: FORMAT, version: 1, project: p }, null, 2)
}

/**
 * Reads an exported office as a new one: new ids, known fields only. Permissions don't travel: the
 * allow list is dropped, commands ask again, and the owner picks the workspace folder on this computer.
 */
export function projectFromJson(text: string, newId: () => string): Project {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    throw new Error('E_BAD_FILE')
  }
  if (!obj(doc) || doc.format !== FORMAT || doc.version !== 1 || !isProject(doc.project)) throw new Error('E_BAD_FILE')
  const p = doc.project
  const ids = new Map(p.agents.map((a) => [a.id, newId()]))
  const agents = p.agents.map((a): Agent => {
    if (a.reportsTo !== null && !ids.has(a.reportsTo)) throw new Error('E_BAD_FILE')
    return {
      id: ids.get(a.id)!,
      name: a.name,
      title: a.title,
      department: a.department,
      reportsTo: a.reportsTo === null ? null : ids.get(a.reportsTo)!,
      instructions: a.instructions,
      providerId: a.providerId,
      model: a.model,
      ...(a.backup && { backup: { providerId: a.backup.providerId, model: a.backup.model } }),
      tools: [...a.tools],
      // Access to this computer's MCP servers is the owner's choice here, not the file's.
      ...(a.effort && { effort: a.effort }),
      ...(a.maxTokens !== undefined && { maxTokens: a.maxTokens }),
      ...(a.skills && { skills: [...a.skills] })
    }
  })
  return {
    id: newId(),
    name: p.name,
    workspaceDir: '',
    briefing: p.briefing,
    approval: 'ask',
    budgetUsd: p.budgetUsd,
    agents,
    ...(p.limits && { limits: { maxRequests: p.limits.maxRequests, maxChatter: p.limits.maxChatter, compactAt: p.limits.compactAt } }),
    ...(p.planFirst !== undefined && { planFirst: p.planFirst }),
    ...(p.sandbox && { sandbox: { kind: p.sandbox.kind, image: p.sandbox.image, network: p.sandbox.network } }),
    ...(p.checkpoints !== undefined && { checkpoints: p.checkpoints })
  }
}

const pad = (n: number) => String(n).padStart(2, '0')
const clock = (at: number) => `${pad(new Date(at).getHours())}:${pad(new Date(at).getMinutes())}`
const date = (at: number) => {
  const d = new Date(at)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${clock(at)}`
}
const money = (usd: number) => `$${usd.toFixed(usd > 0 && usd < 0.01 ? 4 : 2)}`

/** Inline code that survives backticks inside it. */
function code(s: string): string {
  const t = s.replace(/\s*\r?\n\s*/g, ' ')
  const fence = '`'.repeat(Math.max(0, ...[...t.matchAll(/`+/g)].map((m) => m[0].length)) + 1)
  return fence.length > 1 || t.startsWith('`') || t.endsWith('`') ? `${fence} ${t} ${fence}` : `${fence}${t}${fence}`
}
const quote = (s: string) => s.split(/\r?\n/).map((l) => (l ? `> ${l}` : '>')).join('\n')

const ENDS: Record<string, (e: Extract<OfficeEvent, { type: 'run' }>) => string> = {
  owner_stopped: () => 'The owner stopped the work',
  new_task: () => 'A new task was started',
  idle: () => 'The team finished',
  report: () => 'Final report delivered',
  plan: () => 'Waiting for the owner to approve the plan',
  budget: (e) => `The budget was reached (${money(e.usd ?? 0)})`,
  limit: (e) => `The request limit was reached (${e.requests ?? 0} requests)`,
  loop: (e) => `Stopped: ${(e.agents ?? []).join(' and ')} kept messaging each other without doing work`,
  cap: (e) => `The spending cap was reached (${money(e.usd ?? 0)})`,
  app_closed: () => 'The app was closed'
}
const ASKS = { command: 'wants to run', mcp: 'wants to use', fetch: 'wants to open a local address:' }

/** A finished task as a Markdown document the owner can keep or share. */
export function runToMarkdown(project: Project, run: RunSummary, events: OfficeEvent[]): string {
  const agents = new Map(project.agents.map((a) => [a.id, a]))
  const name = (id: string) => (id === USER ? 'Owner' : id === SYSTEM ? 'System' : (agents.get(id)?.name ?? 'Former member'))
  const answers = new Map<string, Extract<OfficeEvent, { type: 'approval_done' }>>()
  const plans = new Map<string, Extract<OfficeEvent, { type: 'plan_done' }>>()
  for (const e of events) {
    if (e.type === 'approval_done') answers.set(e.id, e)
    if (e.type === 'plan_done') plans.set(e.id, e)
  }
  // A final report is a member's message directly followed (among messages and run events) by the end with reason "report".
  const reports = new Set<number>()
  let endsOnReport = false
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.type === 'run') endsOnReport = e.reason === 'report'
    if (e.type !== 'message') continue
    if (endsOnReport && e.from !== USER && e.from !== SYSTEM) reports.add(i)
    endsOnReport = false
  }

  const title = run.goal.split(/\r?\n/).find((l) => l.trim())?.trim() || 'Task'
  const out: string[] = [`# ${title}`, `${date(run.startedAt)} · ${project.name}`]
  let tools: string[] = []
  let toolsBy = ''
  const flush = () => {
    if (tools.length) out.push(tools.join('\n'))
    tools = []
  }
  let usd = 0
  let requests = 0
  let unpriced = 0

  events.forEach((e, i) => {
    if (e.type === 'cost') {
      requests++
      if (e.usd === null) unpriced++
      else usd += e.usd
      return
    }
    if (e.type === 'tool') {
      // These already appear as the message or the plan itself.
      if (e.name === 'message' || e.name === 'report_to_user' || e.name === 'propose_plan') return
      if (toolsBy !== e.agentId) flush()
      toolsBy = e.agentId
      tools.push(`- ${name(e.agentId)} · ${e.name}${e.summary ? ` ${code(e.summary)}` : ''}${e.ok ? '' : ' — failed'}`)
      return
    }
    if (!['message', 'approval', 'plan', 'run'].includes(e.type)) return
    flush()
    toolsBy = ''
    if (e.type === 'message') {
      if (reports.has(i)) {
        out.push(`## Final report`, `**${name(e.from)}** (${clock(e.at)})`, e.text)
      } else {
        const to = e.to.length ? ` → ${e.to.map(name).join(', ')}` : ''
        out.push(`**${name(e.from)}${to}** (${clock(e.at)})`, e.text)
      }
    } else if (e.type === 'approval') {
      const a = answers.get(e.id)
      const result = !a ? 'no answer' : a.approved ? (a.always ? 'allowed for good' : 'allowed') : 'denied'
      out.push(`> **Approval:** ${name(e.agentId)} ${ASKS[e.kind]} ${code(e.command)} — ${result}`)
    } else if (e.type === 'plan') {
      const d = plans.get(e.id)
      const result = !d ? 'Waiting for approval' : d.approved ? 'Plan approved' : `Changes requested${d.feedback ? `: ${d.feedback.replace(/\s+/g, ' ').trim()}` : ''}`
      out.push(`**Plan from ${name(e.agentId)}** (${clock(e.at)})`, quote(e.text), `_${result}_`)
    } else if (e.type === 'run' && e.state !== 'running') {
      out.push(`_${(ENDS[e.reason ?? ''] ?? (() => 'The work ended'))(e)}_`)
    }
  })
  flush()

  const extra = unpriced ? `, ${unpriced} without a price (not included)` : ''
  out.push('---', `**Total cost:** ${money(usd)} (${requests} ${requests === 1 ? 'request' : 'requests'}${extra})`)
  return out.join('\n\n') + '\n'
}
