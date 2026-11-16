import { describe, expect, it } from 'vitest'
import type { Agent, RoleTemplate } from '../../shared/types'
import { orgProblem } from './orgchart'
import { changeRole, headFor, isStockInstructions, newAgent, roleByTitle, roleDefaults, STAFF_ROLES, withExecs, withWorkerModel } from './roles'

const R = (t: string) => roleByTitle(t)!
const names = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']
const plugin: RoleTemplate = { title: 'Data Scientist', description: '', instructions: 'Model the data and explain it.', plugin: 'ds' }

describe('changing the role field', () => {
  it('brings the new role\'s instructions, tools and department when nothing was customised', () => {
    const a = newAgent('A', R('Software Engineer'), 'x')
    // The title stays as typed (no recasing mid-word); the role's defaults still come along.
    expect(changeRole(a, 'copywriter')).toEqual({ title: 'copywriter', department: 'Marketing', instructions: R('Copywriter').instructions, tools: R('Copywriter').tools })
    expect(changeRole({ ...a, instructions: '  ' }, 'CTO').instructions).toBe(R('CTO').instructions)
  })

  it('keeps instructions and tools the owner wrote', () => {
    const a: Agent = { ...newAgent('A', R('Software Engineer'), 'x'), instructions: 'Only write Rust.', tools: ['read_file'] }
    expect(changeRole(a, 'Backend Engineer')).toEqual({ title: 'Backend Engineer', department: 'Engineering' })
  })

  it('keeps a department name the owner typed', () => {
    const a: Agent = { ...newAgent('A', R('Software Engineer'), 'x'), department: 'Platform team' }
    expect(changeRole(a, 'Copywriter').department).toBeUndefined()
  })

  it('only changes the title for unknown roles', () => {
    const a = newAgent('A', R('Software Engineer'), 'x')
    expect(changeRole(a, 'Chief Vibes Officer')).toEqual({ title: 'Chief Vibes Officer' })
  })

  it('uses plugin roles, treating their instructions as stock too', () => {
    const a = newAgent('A', R('Software Engineer'), 'x')
    expect(changeRole(a, 'data scientist', [plugin])).toEqual({ title: 'data scientist', instructions: plugin.instructions })
    const fromPlugin = { ...a, instructions: plugin.instructions }
    expect(changeRole(fromPlugin, 'QA Engineer', [plugin]).instructions).toBe(R('QA Engineer').instructions)
    expect(isStockInstructions(plugin.instructions)).toBe(false)
    expect(isStockInstructions(plugin.instructions, [plugin])).toBe(true)
  })

  it('offers the role defaults only when the instructions differ from them', () => {
    const a = newAgent('A', R('QA Engineer'), 'x')
    expect(roleDefaults(a)).toBeNull()
    // The button says "instructions": the member's tools stay as the owner set them.
    expect(roleDefaults({ ...a, instructions: 'Mine', tools: [] })).toEqual({ instructions: R('QA Engineer').instructions })
    expect(roleDefaults({ ...a, title: 'Data Scientist', instructions: 'Mine' }, [plugin])).toEqual({ instructions: plugin.instructions })
    expect(roleDefaults({ ...a, title: 'Unknown' })).toBeNull()
  })
})

describe('executives', () => {
  const shape = (team: Agent[]) => team.map((a) => [a.name, a.exec ?? '', a.title, team.find((x) => x.id === a.reportsTo)?.name ?? null])

  it('a new office is the CEO with the CTO, CFO, COO and CMO reporting to them, and is a valid team', () => {
    const team = withExecs([], names, { providerId: 'p', model: 'm' })
    expect(shape(team)).toEqual([
      ['A', 'ceo', 'CEO', null], ['B', 'cto', 'CTO', 'A'], ['C', 'cfo', 'CFO', 'A'], ['D', 'coo', 'COO', 'A'], ['E', 'cmo', 'CMO', 'A']
    ])
    expect(team.every((a) => a.providerId === 'p' && a.model === 'm')).toBe(true)
    expect(team[1].tools).toContain('run_command')
    expect(orgProblem(team)).toBeNull()
  })

  it('fixes up an older office: the top becomes CEO, a CTO by title is kept with their reports, the rest are hired', () => {
    const ceo = { ...newAgent('Ann', R('Project Manager'), null, 'big', 'opus'), id: 'ceo' }
    const cto = { ...newAgent('Bob', R('CTO'), 'pm', 'big', 'opus'), id: 'cto' }
    const pm = { ...newAgent('Pat', R('Project Manager'), 'ceo', 'big', 'opus'), id: 'pm' }
    const dev = { ...newAgent('Dee', R('Software Engineer'), 'cto', 'big', 'opus'), id: 'dev' }
    const lost = { ...newAgent('Lou', R('Copywriter'), 'gone', 'big', 'opus'), id: 'lost' }
    const team = withExecs([ceo, cto, pm, dev, lost], ['Ann', 'Zed', 'Yan', 'Xu'])
    expect(shape(team)).toEqual([
      ['Ann', 'ceo', 'CEO', null], ['Bob', 'cto', 'CTO', 'Ann'], ['Pat', '', 'Project Manager', 'Ann'], ['Dee', '', 'Software Engineer', 'Bob'],
      ['Lou', '', 'Copywriter', 'Ann'], ['Zed', 'cfo', 'CFO', 'Ann'], ['Yan', 'coo', 'COO', 'Ann'], ['Xu', 'cmo', 'CMO', 'Ann']
    ])
    // Hired executives get the CEO's model.
    expect(team.slice(5).every((a) => a.providerId === 'big' && a.model === 'opus')).toBe(true)
    expect(orgProblem(team)).toBeNull()
  })

  it('keeps one of each executive, puts them back in place and leaves a correct team untouched', () => {
    const team = withExecs([], names, { providerId: 'p', model: 'm' })
    expect(withExecs(team, names)).toBe(team)
    const broken = team.map((a) => (a.exec === 'cfo' ? { ...a, title: 'Chief Money', reportsTo: team[1].id } : a.exec === 'cmo' ? { ...a, exec: 'cto' as const } : a))
    const fixed = withExecs(broken, names)
    expect(fixed.find((a) => a.exec === 'cfo')).toMatchObject({ title: 'CFO', reportsTo: team[0].id })
    expect(fixed.filter((a) => a.exec === 'cto').map((a) => a.name)).toEqual(['B'])
    // The second "CTO" lost the flag and, still titled CMO, is the CMO again: nobody new is hired.
    expect(fixed.find((a) => a.exec === 'cmo')!.name).toBe('E')
    expect(fixed).toHaveLength(5)
  })

  it('sends a new member to the head of their department', () => {
    const team = withExecs([], names, { providerId: 'p', model: 'm' })
    const head = (d: string) => headFor(team, d)?.exec
    expect([head('Engineering'), head('Finance'), head(' marketing '), head('Support'), head('Underwater basket weaving')]).toEqual(['cto', 'cfo', 'cmo', 'coo', 'ceo'])
    expect(STAFF_ROLES.some((r) => ['CEO', 'CTO', 'CFO', 'COO', 'CMO'].includes(r.title))).toBe(false)
  })
})

describe('withWorkerModel', () => {
  const team = withExecs([], names, { providerId: 'big', model: 'opus' })

  it('gives everyone but the top executive the worker model', () => {
    const out = withWorkerModel(team, { providerId: 'cheap', model: ' haiku ' })
    expect(out.filter((a) => !a.reportsTo).map((a) => [a.providerId, a.model])).toEqual([['big', 'opus']])
    expect(out.filter((a) => a.reportsTo).every((a) => a.providerId === 'cheap' && a.model === 'haiku')).toBe(true)
  })

  it('changes nothing without a complete worker model', () => {
    expect(withWorkerModel(team, null)).toBe(team)
    expect(withWorkerModel(team, { providerId: '', model: 'x' })).toBe(team)
    expect(withWorkerModel(team, { providerId: 'cheap', model: ' ' })).toBe(team)
  })
})
