import { EXEC_KINDS, type Agent, type Exec, type ModelRef, type RoleTemplate, type ToolName } from '../../shared/types'
import { sameJson } from './orgchart'

const DEV: ToolName[] = ['list_files', 'read_file', 'write_file', 'edit_file', 'run_command']
const DOCS: ToolName[] = ['list_files', 'read_file', 'write_file', 'edit_file']

export interface Role {
  title: string
  department: string
  tools: ToolName[]
  instructions: string
}

/** Suggestions only: title and department are free text, any profession works. */
export const ROLES: Role[] = [
  { title: 'CEO', department: 'Leadership', tools: DOCS, instructions: 'Own the goal end to end. Turn it into department-level objectives, assign them to department heads, keep everyone aligned, and deliver one verified final report to the owner.' },
  { title: 'CTO', department: 'Engineering', tools: DEV, instructions: 'Own technical direction. Choose the stack and architecture, split engineering work into tasks with acceptance criteria, review code and test results before accepting.' },
  { title: 'CFO', department: 'Finance', tools: DOCS, instructions: 'Own money matters: budgets, pricing, forecasts and costs. Give finance and legal work to your reports, check every number before it goes up, and state your assumptions.' },
  { title: 'COO', department: 'Operations', tools: DOCS, instructions: 'Own how the work gets done: plans, processes, people and support. Turn goals into schedules with owners, remove blockers and make sure every task has a clear definition of done.' },
  { title: 'CMO', department: 'Marketing', tools: DOCS, instructions: 'Own positioning, audience and growth. Give marketing and sales work to your reports, keep the message specific and consistent, and judge results by evidence.' },
  { title: 'Project Manager', department: 'Leadership', tools: DOCS, instructions: 'Keep a written plan (PLAN.md) with tasks, owners and status. Chase blockers, keep scope tight, make sure every task has a clear definition of done.' },
  { title: 'Software Engineer', department: 'Engineering', tools: DEV, instructions: 'Write clean, working code with tests. Run the build and tests before reporting. Report what changed, which files, and the test output.' },
  { title: 'Frontend Engineer', department: 'Engineering', tools: DEV, instructions: 'Build accessible, responsive UI. Match the design spec. Verify it builds and renders without errors.' },
  { title: 'Backend Engineer', department: 'Engineering', tools: DEV, instructions: 'Build APIs and data models. Validate input, handle errors, write tests for the main paths.' },
  { title: 'Mobile Developer', department: 'Engineering', tools: DEV, instructions: 'Build the mobile app. Keep it simple and native-feeling, verify it compiles.' },
  { title: 'Data Engineer', department: 'Data', tools: DEV, instructions: 'Design data pipelines and schemas. Make transformations reproducible and document data sources.' },
  { title: 'QA Engineer', department: 'Engineering', tools: DEV, instructions: 'Try to break things. Write and run tests, report reproducible bugs with exact steps and output.' },
  { title: 'Reviewer', department: 'Engineering', tools: DEV, instructions: 'Review every change before it is accepted: read the changed files, run the build and tests, and try the edge cases. Report each problem with file, exact steps and output, or approve explicitly.' },
  { title: 'DevOps Engineer', department: 'Engineering', tools: DEV, instructions: 'Own builds, CI, containers and deployment scripts. Never run destructive commands without saying why.' },
  { title: 'Security Engineer', department: 'Security', tools: DEV, instructions: 'Review code and configs for vulnerabilities (injection, auth, secrets, dependencies). Report findings with file, impact and fix.' },
  { title: 'Pentester', department: 'Security', tools: DEV, instructions: 'Test only the project in the workspace. Find exploitable weaknesses, prove them safely, and write a report with severity and remediation.' },
  { title: 'Product Designer', department: 'Design', tools: DOCS, instructions: 'Define user flows, layout, colors and copy. Deliver a clear design spec (DESIGN.md) engineers can build from.' },
  { title: 'Marketing Manager', department: 'Marketing', tools: DOCS, instructions: 'Define positioning, audience and channels. Produce a launch plan and messaging that is specific, not generic.' },
  { title: 'Copywriter', department: 'Marketing', tools: DOCS, instructions: 'Write clear, persuasive copy in the brand voice. Short sentences, concrete benefits, no filler.' },
  { title: 'SMM Specialist', department: 'Marketing', tools: DOCS, instructions: 'Plan social media content: post ideas, captions, schedule per channel.' },
  { title: 'Financial Analyst', department: 'Finance', tools: DOCS, instructions: 'Build budgets, forecasts and unit economics. Show assumptions explicitly and keep numbers consistent.' },
  { title: 'Accountant', department: 'Finance', tools: DOCS, instructions: 'Keep accurate records, prepare statements and check every total. Flag anything that does not reconcile.' },
  { title: 'Lawyer', department: 'Legal', tools: DOCS, instructions: 'Draft and review contracts, terms and policies. Point out risks plainly. Note that output is not a substitute for a licensed attorney.' },
  { title: 'HR Manager', department: 'HR', tools: DOCS, instructions: 'Write job descriptions, onboarding docs and policies.' },
  { title: 'Sales Manager', department: 'Sales', tools: DOCS, instructions: 'Define ideal customers, write outreach sequences and objection handling.' },
  { title: 'Support Specialist', department: 'Support', tools: DOCS, instructions: 'Write help-center articles and canned replies that solve real user problems.' }
]

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

export const roleByTitle = (t: string) => ROLES.find((r) => same(r.title, t))

/** Empty or some role's stock text: replacing it loses nothing the owner wrote. */
export function isStockInstructions(text: string, pluginRoles: Pick<RoleTemplate, 'instructions'>[] = []): boolean {
  const s = text.trim()
  return !s || [...ROLES, ...pluginRoles].some((r) => r.instructions.trim() === s)
}

const stockDepartment = (d: string) => !d.trim() || ROLES.some((r) => same(r.department, d))

/**
 * What changes when the role field is set to `title`. A known role brings its instructions and tools
 * only when the current instructions are stock; its department replaces a stock department name but
 * never one the owner typed.
 */
export function changeRole(agent: Agent, title: string, pluginRoles: RoleTemplate[] = []): Partial<Agent> {
  const r = roleByTitle(title)
  const role = r ?? pluginRoles.find((x) => same(x.title, title))
  // The title stays as typed: matching a role only fills in its defaults.
  if (!role) return { title }
  const patch: Partial<Agent> = { title }
  if (r && stockDepartment(agent.department)) patch.department = r.department
  if (isStockInstructions(agent.instructions, pluginRoles)) {
    patch.instructions = role.instructions
    if (r) patch.tools = [...r.tools]
  }
  return patch
}

/** The current role's default instructions, when the member's differ from them; null otherwise. Tools are left alone. */
export function roleDefaults(agent: Agent, pluginRoles: RoleTemplate[] = []): Partial<Agent> | null {
  const role = roleByTitle(agent.title) ?? pluginRoles.find((x) => same(x.title, agent.title))
  if (!role || agent.instructions.trim() === role.instructions.trim()) return null
  return { instructions: role.instructions }
}

export const uid = () => crypto.randomUUID().slice(0, 8)

export function newAgent(name: string, role: Role, reportsTo: string | null, providerId = '', model = ''): Agent {
  return { id: uid(), name, title: role.title, department: role.department, reportsTo, instructions: role.instructions, providerId, model, tools: [...role.tools] }
}

/** Gives everyone except the top executive another model (usually a cheaper one). */
export function withWorkerModel(agents: Agent[], worker?: ModelRef | null): Agent[] {
  const model = worker?.model.trim()
  if (!worker?.providerId || !model) return agents
  return agents.map((a) => (a.reportsTo ? { ...a, providerId: worker.providerId, model } : a))
}

const R = (t: string) => roleByTitle(t)!

export const EXEC_TITLES: Record<Exec, string> = { ceo: 'CEO', cto: 'CTO', cfo: 'CFO', coo: 'COO', cmo: 'CMO' }
const isExecTitle = (t: string) => Object.values(EXEC_TITLES).some((x) => same(x, t))

/** Roles the owner can add (the executives are always there already). */
export const STAFF_ROLES = ROLES.filter((r) => !isExecTitle(r.title))

/**
 * The office with its five executives in place, the one invariant every team keeps: one CEO at the top,
 * CTO/CFO/COO/CMO reporting to the CEO. Old offices are fixed up: the top member becomes the CEO, a
 * member with an executive's title becomes that executive, a missing one is hired (`names`, the CEO's
 * model, or `model` for an empty team), and anyone without a manager reports to the CEO.
 * Returns `agents` itself when nothing had to change.
 */
export function withExecs(agents: Agent[], names: string[], model: ModelRef = { providerId: '', model: '' }): Agent[] {
  const list = agents.map((a) => ({ ...a }))
  const taken = new Set<Exec>()
  for (const a of list) {
    if (!a.exec) continue
    if (taken.has(a.exec)) delete a.exec
    else taken.add(a.exec)
  }
  const used = new Set(list.map((a) => a.name.trim().toLowerCase()))
  const hire = (title: string, base: ModelRef) => {
    let name = names.find((n) => !used.has(n.toLowerCase())) ?? title
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${title} ${i}`
    used.add(name.toLowerCase())
    const a = newAgent(name, R(title), null, base.providerId, base.model)
    list.push(a)
    return a
  }
  let ceo: Agent | undefined
  for (const kind of EXEC_KINDS) {
    const title = EXEC_TITLES[kind]
    const a =
      list.find((x) => x.exec === kind) ??
      list.find((x) => !x.exec && (kind === 'ceo' ? !x.reportsTo : same(x.title, title))) ??
      hire(title, ceo ?? model)
    a.exec = kind
    a.title = title
    ceo ??= a
  }
  const ids = new Set(list.map((a) => a.id))
  for (const a of list) {
    if (a === ceo) a.reportsTo = null
    else if (a.exec || !a.reportsTo || !ids.has(a.reportsTo)) a.reportsTo = ceo!.id
  }
  return sameJson(list, agents) ? agents : list
}

const HEADS: [RegExp, Exec][] = [
  [/^(engineering|data|security|design|it|product)$/i, 'cto'],
  [/^(finance|legal|accounting)$/i, 'cfo'],
  [/^(marketing|sales|growth)$/i, 'cmo'],
  [/^(operations|hr|support|leadership)$/i, 'coo']
]

/** A role by title: a built-in one, or a plugin role (document tools; the department comes from the manager). */
export function roleFrom(title: string, pluginRoles: RoleTemplate[] = []): Role | undefined {
  const plugin = pluginRoles.find((x) => same(x.title, title))
  return roleByTitle(title) ?? (plugin && { title: plugin.title, department: '', tools: [...DOCS], instructions: plugin.instructions })
}

/** The role "+" on a card hires: the first staff role of that executive's department, else an engineer. */
export function starterRole(agents: Agent[], boss: Agent): Role {
  return STAFF_ROLES.find((r) => headFor(agents, r.department)?.id === boss.id) ?? R('Software Engineer')
}

/** Who a new member of `department` reports to when dropped on empty canvas: their executive, else the CEO. */
export function headFor(agents: Agent[], department: string): Agent | undefined {
  const kind = HEADS.find(([re]) => re.test(department.trim()))?.[1] ?? 'ceo'
  return agents.find((a) => a.exec === kind) ?? agents.find((a) => a.exec === 'ceo') ?? agents.find((a) => !a.reportsTo)
}
