import type { Agent, ModelRef, RoleTemplate, ToolName } from '../../shared/types'

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
  if (!role) return { title }
  const patch: Partial<Agent> = { title: role.title }
  if (r && stockDepartment(agent.department)) patch.department = r.department
  if (isStockInstructions(agent.instructions, pluginRoles)) {
    patch.instructions = role.instructions
    if (r) patch.tools = [...r.tools]
  }
  return patch
}

/** The current role's defaults, when the member's instructions differ from them; null otherwise. */
export function roleDefaults(agent: Agent, pluginRoles: RoleTemplate[] = []): Partial<Agent> | null {
  const r = roleByTitle(agent.title)
  const role = r ?? pluginRoles.find((x) => same(x.title, agent.title))
  if (!role || agent.instructions.trim() === role.instructions.trim()) return null
  return r ? { instructions: r.instructions, tools: [...r.tools] } : { instructions: role.instructions }
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

export interface TeamTemplate {
  id: 'software' | 'lite' | 'security' | 'blank'
  /** `n` = localized first names, so templates feel native in each language. */
  build(n: string[], providerId: string, model: string): Agent[]
}

export const TEMPLATES: TeamTemplate[] = [
  {
    id: 'software',
    build(n, p, m) {
      const ceo = newAgent(n[0], R('CEO'), null, p, m)
      const cto = newAgent(n[1], R('CTO'), ceo.id, p, m)
      const mkt = newAgent(n[2], R('Marketing Manager'), ceo.id, p, m)
      return [
        ceo, cto, mkt,
        newAgent(n[3], R('Software Engineer'), cto.id, p, m),
        newAgent(n[4], R('Frontend Engineer'), cto.id, p, m),
        newAgent(n[5], R('QA Engineer'), cto.id, p, m),
        newAgent(n[6], R('Product Designer'), ceo.id, p, m),
        newAgent(n[7], R('Copywriter'), mkt.id, p, m)
      ]
    }
  },
  {
    id: 'lite',
    build(n, p, m) {
      const ceo = newAgent(n[0], R('CEO'), null, p, m)
      return [ceo, newAgent(n[1], R('Software Engineer'), ceo.id, p, m), newAgent(n[2], R('Reviewer'), ceo.id, p, m)]
    }
  },
  {
    id: 'security',
    build(n, p, m) {
      const ceo = newAgent(n[0], R('CEO'), null, p, m)
      const head = newAgent(n[9], { ...R('Security Engineer'), title: 'Head of Security' }, ceo.id, p, m)
      return [ceo, head, newAgent(n[1], R('Pentester'), head.id, p, m), newAgent(n[4], R('Security Engineer'), head.id, p, m), newAgent(n[8], R('Lawyer'), ceo.id, p, m)]
    }
  },
  { id: 'blank', build: (n, p, m) => [newAgent(n[0], R('CEO'), null, p, m)] }
]
