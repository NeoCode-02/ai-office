import { useEffect, useMemo, useRef, useState } from 'react'
import type { Agent, McpServer, Project, Provider, RoleTemplate, ToolName } from '../../shared/types'
import { errText, useT } from './i18n'
import { KNOWN_PRICES, newAgent, roleByTitle, ROLES, uid } from './roles'
import { Avatar, ConfirmButton, Empty, Field, Icon, Sheet } from './ui'

const EDITABLE: ToolName[] = ['list_files', 'read_file', 'search_files', 'write_file', 'edit_file', 'run_command', 'web_fetch']

const modelCache = new Map<string, Promise<string[]>>()

export function ModelInput({ providerId, value, onChange }: { providerId: string; value: string; onChange(v: string): void }) {
  const [models, setModels] = useState<string[]>([])
  const listId = `models-${providerId}`
  useEffect(() => {
    if (!providerId) return
    if (!modelCache.has(providerId)) modelCache.set(providerId, window.office.listModels(providerId).catch(() => []))
    let live = true
    void modelCache.get(providerId)!.then((m) => live && setModels(m))
    return () => {
      live = false
    }
  }, [providerId])
  return (
    <>
      <input className="input mono" list={listId} value={value} onChange={(e) => onChange(e.target.value)} placeholder={models[0] ?? 'model-id'} />
      <datalist id={listId}>{models.map((m) => <option key={m} value={m} />)}</datalist>
    </>
  )
}

interface Props {
  project: Project
  providers: Provider[]
  onSave(p: Project): Promise<void>
  notify(t: string): void
}

export default function Team({ project, providers, onSave, notify }: Props) {
  const t = useT()
  const [agents, setAgents] = useState(project.agents)
  const [sel, setSel] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [mcp, setMcp] = useState<McpServer[]>([])
  const [pluginRoles, setPluginRoles] = useState<RoleTemplate[]>([])
  const dirty = JSON.stringify(agents) !== JSON.stringify(project.agents)
  const agent = agents.find((a) => a.id === sel)

  const canvas = useRef<HTMLDivElement>(null)
  // Start with the CEO in view when the chart is wider than the window.
  useEffect(() => {
    const el = canvas.current
    if (el) el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2
  }, [])

  useEffect(() => {
    void window.office.listMcp().then((m) => setMcp(m.filter((x) => x.enabled)))
    void window.office.pluginRoles().then(setPluginRoles)
  }, [])

  const update = (patch: Partial<Agent>) => setAgents((all) => all.map((a) => (a.id === sel ? { ...a, ...patch } : a)))

  const add = (boss: Agent | undefined) => {
    const base = boss ?? agents[0]
    const role = boss ? ROLES.find((r) => r.title === 'Software Engineer')! : ROLES[0]
    const used = new Set(agents.map((a) => a.name))
    const name = t.names.find((n) => !used.has(n)) ?? `${t.names[0]} ${agents.length + 1}`
    const a = newAgent(name, role, boss?.id ?? null, base?.providerId, base?.model)
    Object.assign(a, { priceIn: base?.priceIn ?? 0, priceOut: base?.priceOut ?? 0, department: boss?.department || a.department })
    setAgents((all) => [...all, a])
    setSel(a.id)
  }

  const duplicate = (a: Agent) => {
    const copy = { ...a, id: uid(), name: `${a.name} 2`, tools: [...a.tools], mcpServers: [...(a.mcpServers ?? [])] }
    setAgents((all) => [...all, copy])
    setSel(copy.id)
  }

  const remove = (a: Agent) => {
    // Reports move up to the removed person's manager.
    setAgents((all) => all.filter((x) => x.id !== a.id).map((x) => (x.reportsTo === a.id ? { ...x, reportsTo: a.reportsTo } : x)))
    setSel(null)
  }

  const save = async () => {
    const names = agents.map((a) => a.name.trim().toLowerCase())
    if (agents.filter((a) => !a.reportsTo).length !== 1) return notify(t.team.errors.ceo)
    if (new Set(names).size !== names.length) return notify(t.team.errors.dup)
    if (agents.some((a) => !a.model.trim() || !a.providerId)) return notify(t.team.errors.model)
    setBusy(true)
    try {
      await onSave({ ...project, agents })
      notify(t.common.saved)
    } catch (e) {
      notify(errText(e, t))
    } finally {
      setBusy(false)
    }
  }

  // A manager can't report to someone in their own subtree.
  const subtree = useMemo(() => {
    const ids = new Set<string>()
    const walk = (id: string) => {
      ids.add(id)
      agents.filter((a) => a.reportsTo === id).forEach((a) => walk(a.id))
    }
    if (sel) walk(sel)
    return ids
  }, [agents, sel])

  const depts = new Set(agents.map((a) => a.department).filter(Boolean)).size
  const roles = [...ROLES.map((r) => r.title), ...pluginRoles.map((r) => r.title)]

  const tree = (boss: string | null) => {
    const kids = agents.filter((a) => (a.reportsTo ?? null) === boss)
    if (!kids.length) return null
    return (
      <ul className={boss ? undefined : 'tree'}>
        {kids.map((a) => (
          <li key={a.id}>
            <div className="node-wrap">
              <button className={`node ${sel === a.id ? 'on' : ''}`} onClick={() => setSel(a.id)}>
                <div className="row">
                  <Avatar name={a.name} seed={a.id} size={32} />
                  <div className="ellipsis">
                    <div className="node-name ellipsis">{a.name}</div>
                    <div className="node-title ellipsis">{a.title}</div>
                  </div>
                  {!a.reportsTo && <Icon name="crown" size={13} className="faint" />}
                </div>
                <div className="node-foot">
                  <span className="ellipsis">{a.department || '—'}</span>
                  <span className="ellipsis mono">{a.model || '—'}</span>
                </div>
              </button>
              <button className="node-add" onClick={() => add(a)} title={t.team.addReport(a.name)} aria-label={t.team.addReport(a.name)}>
                <Icon name="plus" size={13} />
              </button>
            </div>
            {tree(a.id)}
          </li>
        ))}
      </ul>
    )
  }

  const reports = agent ? agents.filter((a) => a.reportsTo === agent.id).length : 0
  const boss = agent?.reportsTo ? agents.find((a) => a.id === agent.reportsTo) : undefined

  return (
    <div className="org">
      <div className="org-meta">{t.team.summary(agents.length, depts)}</div>
      <div className="org-canvas" ref={canvas} onClick={(e) => e.target === e.currentTarget && setSel(null)}>
        {agents.length ? (
          tree(null)
        ) : (
          <Empty icon="users" title={t.work.emptyTeam}>
            <button className="btn primary" onClick={() => add(undefined)}>
              <Icon name="plus" size={14} /> {t.team.addCeo}
            </button>
          </Empty>
        )}
      </div>

      {dirty && (
        <div className="savebar" role="status">
          {t.common.unsaved}
          <button className="btn quiet sm" onClick={() => setAgents(project.agents)}>{t.common.discard}</button>
          <button className="btn primary sm" onClick={save} disabled={busy}>{busy ? t.common.saving : t.common.save}</button>
        </div>
      )}

      {agent && (
        <Sheet
          onClose={() => setSel(null)}
          head={
            <>
              <Avatar name={agent.name} seed={agent.id} size={36} />
              <div className="spacer ellipsis">
                <div style={{ fontWeight: 600 }} className="ellipsis">{agent.name}</div>
                <div className="faint small ellipsis">
                  {boss ? t.team.reportsTo(boss.name) : t.team.reportsToYou}
                  {reports ? ` · ${t.team.directReports(reports)}` : ''}
                </div>
              </div>
              <button className="btn quiet icon sm" title={t.team.duplicate} aria-label={t.team.duplicate} onClick={() => duplicate(agent)}>
                <Icon name="copy" size={15} />
              </button>
            </>
          }
        >
          <section className="sheet-group stack">
            <h4>{t.team.basics}</h4>
            <div className="grid2">
              <Field label={t.team.name}>
                <input className="input" value={agent.name} onChange={(e) => update({ name: e.target.value })} />
              </Field>
              <Field label={t.team.manager}>
                <select className="select" value={agent.reportsTo ?? ''} onChange={(e) => update({ reportsTo: e.target.value || null })}>
                  <option value="">{t.team.noManager}</option>
                  {agents.filter((a) => !subtree.has(a.id)).map((a) => <option key={a.id} value={a.id}>{a.name} — {a.title}</option>)}
                </select>
              </Field>
            </div>
            <Field label={t.team.role} hint={t.team.roleHint}>
              <input
                className="input"
                list="role-list"
                value={agent.title}
                onChange={(e) => {
                  const r = roleByTitle(e.target.value)
                  const pr = pluginRoles.find((x) => x.title === e.target.value)
                  if (r) update({ title: r.title, department: agent.department || r.department, instructions: r.instructions, tools: [...r.tools] })
                  else if (pr) update({ title: pr.title, instructions: pr.instructions })
                  else update({ title: e.target.value })
                }}
              />
              <datalist id="role-list">{roles.map((r) => <option key={r} value={r} />)}</datalist>
            </Field>
            <Field label={t.team.department}>
              <input className="input" list="dept-list" value={agent.department} onChange={(e) => update({ department: e.target.value })} />
              <datalist id="dept-list">{[...new Set([...agents.map((a) => a.department), ...ROLES.map((r) => r.department)])].filter(Boolean).map((d) => <option key={d} value={d} />)}</datalist>
            </Field>
          </section>

          <section className="sheet-group stack">
            <h4>{t.team.brain}</h4>
            <div className="grid2">
              <Field label={t.team.provider}>
                <select className="select" value={agent.providerId} onChange={(e) => update({ providerId: e.target.value })}>
                  <option value="">{t.team.choose}</option>
                  {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </Field>
              <Field label={t.team.model}>
                <ModelInput
                  providerId={agent.providerId}
                  value={agent.model}
                  onChange={(m) => {
                    const price = KNOWN_PRICES[m]
                    update(price ? { model: m, priceIn: price[0], priceOut: price[1] } : { model: m })
                  }}
                />
              </Field>
            </div>
          </section>

          <section className="sheet-group">
            <details className="more">
              <summary><Icon name="chevron" size={12} /> {t.team.advanced}</summary>
              <div className="stack">
                <div className="grid2">
                  <Field label={t.team.priceIn}>
                    <input className="input num" type="number" min={0} step={0.01} value={agent.priceIn} onChange={(e) => update({ priceIn: Math.max(0, Number(e.target.value)) })} />
                  </Field>
                  <Field label={t.team.priceOut}>
                    <input className="input num" type="number" min={0} step={0.01} value={agent.priceOut} onChange={(e) => update({ priceOut: Math.max(0, Number(e.target.value)) })} />
                  </Field>
                </div>
                {!agent.priceIn && !agent.priceOut && <div className="note">{t.team.noPrice}</div>}

                <Field label={t.team.tools} hint={t.team.toolsHint}>
                  <div className="checks">
                    {EDITABLE.map((tool) => {
                      const on = agent.tools.includes(tool)
                      return (
                        <label key={tool} className={`check ${on ? 'on' : ''}`}>
                          <input type="checkbox" checked={on} onChange={() => update({ tools: on ? agent.tools.filter((x) => x !== tool) : [...agent.tools, tool] })} />
                          {t.team.toolNames[tool]}
                        </label>
                      )
                    })}
                  </div>
                </Field>

                <Field label={t.team.mcp}>
                  {mcp.length ? (
                    <div className="checks">
                      {mcp.map((m) => {
                        const list = agent.mcpServers ?? []
                        const on = list.includes(m.id)
                        return (
                          <label key={m.id} className={`check ${on ? 'on' : ''}`}>
                            <input type="checkbox" checked={on} onChange={() => update({ mcpServers: on ? list.filter((x) => x !== m.id) : [...list, m.id] })} />
                            <span className="ellipsis">{m.name}</span>
                          </label>
                        )
                      })}
                    </div>
                  ) : (
                    <small>{t.team.mcpNone}</small>
                  )}
                </Field>

                <Field label={t.team.instructions} hint={t.team.instructionsHint}>
                  <textarea className="textarea" rows={7} value={agent.instructions} onChange={(e) => update({ instructions: e.target.value })} />
                </Field>
              </div>
            </details>
          </section>

          {(agent.reportsTo || agents.length === 1) && (
            <section className="sheet-group">
              <ConfirmButton onConfirm={() => remove(agent)}>{t.common.delete}</ConfirmButton>
            </section>
          )}
        </Sheet>
      )}
    </div>
  )
}
