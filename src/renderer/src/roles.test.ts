import { describe, expect, it } from 'vitest'
import type { Agent, RoleTemplate } from '../../shared/types'
import { orgProblem } from './orgchart'
import { changeRole, isStockInstructions, newAgent, roleByTitle, roleDefaults, TEMPLATES, withWorkerModel } from './roles'

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

describe('templates', () => {
  it('build valid teams with one top executive', () => {
    for (const tpl of TEMPLATES) expect(orgProblem(tpl.build(names, 'p', 'm')), tpl.id).toBeNull()
  })

  it('has a three-person Lite team: CEO, engineer and reviewer, both reporting to the CEO', () => {
    const team = TEMPLATES.find((t) => t.id === 'lite')!.build(names, 'p', 'm')
    expect(team.map((a) => a.title)).toEqual(['CEO', 'Software Engineer', 'Reviewer'])
    expect(team.slice(1).every((a) => a.reportsTo === team[0].id)).toBe(true)
    expect(team.find((a) => a.title === 'Reviewer')!.tools).toContain('run_command')
  })
})

describe('withWorkerModel', () => {
  const team = TEMPLATES[0].build(names, 'big', 'opus')

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
