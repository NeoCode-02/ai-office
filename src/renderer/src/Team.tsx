import { useEffect, useId, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import type { Agent, Effort, McpServer, Price, Project, Provider, RoleTemplate, Skill, ToolName } from '../../shared/types'
import type { Live } from './App'
import { errText, useT } from './i18n'
import { createModelCache } from './modelList'
import { latestProject } from './officeForm'
import { buildTree, canDrag, canMoveUnder, liveStatus, maxTokensFrom, moveUnder, orgProblem, sameJson, subtreeOf, type OrgNode } from './orgchart'
import { changeRole, newAgent, roleDefaults, ROLES, uid } from './roles'
import { isOpenRouter, num } from './Pricing'
import { Avatar, ConfirmButton, Empty, Field, Icon, Sheet } from './ui'

const EDITABLE: ToolName[] = ['list_files', 'read_file', 'search_files', 'write_file', 'edit_file', 'run_command', 'web_fetch']
const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

const modelCache = createModelCache((id) => window.office.listModels(id))

/**
 * Model id with the provider's list as suggestions. `hasKey` (when known) is part of the cache key,
 * so the list is fetched again once a key is added.
 */
export function ModelInput({ providerId, value, onChange, hasKey }: { providerId: string; value: string; onChange(v: string): void; hasKey?: boolean }) {
  const t = useT()
  const listId = useId()
  const version = hasKey === undefined ? '' : String(hasKey)
  const [nonce, setNonce] = useState(0)
  const want = `${providerId}|${version}|${nonce}`
  const [res, setRes] = useState<{ key: string; models: string[]; error?: unknown } | null>(null)
  useEffect(() => {
    if (!providerId) return
    let live = true
    modelCache.get(providerId, version).then(
      (models) => live && setRes({ key: want, models }),
      (error: unknown) => live && setRes({ key: want, models: [], error })
    )
    return () => {
      live = false
    }
  }, [providerId, version, want])
  const cur = res?.key === want ? res : null
  const loading = !!providerId && !cur
  const models = cur?.models ?? []
  const reload = () => {
    if (!providerId || loading) return
    modelCache.forget(providerId)
    setNonce((n) => n + 1)
  }
  const label = loading ? t.org.loadingModels : cur?.error !== undefined ? t.org.modelsFailed(errText(cur.error, t)) : t.org.reloadModels
  return (
    <div className="model-input">
      <input
        className="input mono"
        list={listId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => !models.length && reload()}
        placeholder={models[0] ?? 'model-id'}
      />
      <datalist id={listId}>{models.map((m) => <option key={m} value={m} />)}</datalist>
      {providerId && (
        <button
          type="button"
          className={`model-reload ${loading ? 'busy' : ''} ${cur?.error !== undefined ? 'warn' : ''}`}
          onClick={reload}
          aria-busy={loading}
          title={label}
          aria-label={label}
        >
          <Icon name={cur?.error !== undefined ? 'alert' : 'refresh'} size={13} />
        </button>
      )}
    </div>
  )
}

/** What this member's requests cost, as the stats will count it. */
function PriceLine({ provider, model }: { provider?: Provider; model: string }) {
  const t = useT()
  const id = model.trim()
  const [price, setPrice] = useState<{ id: string; price?: Price } | null>(null)
  useEffect(() => {
    if (!provider || !id) return
    let live = true
    void window.office.priceInfo(provider, [id]).then(
      (r) => live && setPrice({ id, price: r[id]?.price }),
      () => undefined
    )
    return () => {
      live = false
    }
  }, [provider, id])
  if (!provider || !id) return null
  if (provider.billing.mode === 'subscription') return <small className="faint">{t.team.priceSub}</small>
  if (provider.billing.mode === 'free') return <small className="faint">{t.team.priceFree}</small>
  if (isOpenRouter(provider.baseURL)) return <small className="faint">{t.team.priceRouter}</small>
  if (price?.id !== id) return null
  return price.price ? <small className="faint num">{t.team.priceLine(num(price.price.in), num(price.price.out))}</small> : <div className="note warn">{t.team.noPrice}</div>
}

/** A labelled group of checkboxes. Not a <label>: that would toggle the first box when its title is clicked. */
function Group({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  const id = useId()
  return (
    <div className="field" role="group" aria-labelledby={id}>
      <span id={id}>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </div>
  )
}

interface Props {
  project: Project
  providers: Provider[]
  /** The office's current work, for live status on the chart. */
  live?: Live
  onSave(p: Project): Promise<void>
  notify(t: string): void
}

export default function Team({ project, providers, live, onSave, notify }: Props) {
  const t = useT()
  const [agents, setAgents] = useState(project.agents)
  const [sel, setSel] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [mcp, setMcp] = useState<McpServer[]>([])
  const [pluginRoles, setPluginRoles] = useState<RoleTemplate[]>([])
  const [skills, setSkills] = useState<{ list: Skill[]; error?: unknown } | null>(null)
  const [drag, setDrag] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const dirty = !sameJson(agents, project.agents)
  const agent = agents.find((a) => a.id === sel)
  const status = useMemo(() => liveStatus(live?.events), [live?.events])
  const chart = useMemo(() => buildTree(agents), [agents])

  const canvas = useRef<HTMLDivElement>(null)
  // Start with the CEO in view when the chart is wider than the window.
  useEffect(() => {
    const el = canvas.current
    if (el) el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2
  }, [])

  useEffect(() => {
    void window.office.listMcp().then((m) => setMcp(m.filter((x) => x.enabled)), () => undefined)
    void window.office.pluginRoles().then(setPluginRoles, () => undefined)
    void window.office.listSkills().then(
      (s) => setSkills({ list: s.filter((x) => x.enabled) }),
      (error: unknown) => setSkills({ list: [], error })
    )
  }, [])

  const update = (patch: Partial<Agent>) => setAgents((all) => all.map((a) => (a.id === sel ? { ...a, ...patch } : a)))

  const add = (boss: Agent | undefined) => {
    const base = boss ?? agents[0]
    const role = boss ? ROLES.find((r) => r.title === 'Software Engineer')! : ROLES[0]
    const used = new Set(agents.map((a) => a.name))
    const name = t.names.find((n) => !used.has(n)) ?? `${t.names[0]} ${agents.length + 1}`
    const a = newAgent(name, role, boss?.id ?? null, base?.providerId, base?.model)
    a.department = boss?.department || a.department
    setAgents((all) => [...all, a])
    setSel(a.id)
  }

  const duplicate = (a: Agent) => {
    const used = new Set(agents.map((x) => x.name.trim().toLowerCase()))
    let n = 2
    while (used.has(`${a.name} ${n}`.trim().toLowerCase())) n++
    const copy: Agent = {
      ...a,
      exec: undefined,
      pos: undefined,
      id: uid(),
      name: `${a.name} ${n}`,
      // A copy of the top executive becomes their deputy: there can be only one top.
      reportsTo: a.reportsTo ?? a.id,
      tools: [...a.tools],
      mcpServers: a.mcpServers && [...a.mcpServers],
      skills: a.skills && [...a.skills],
      backup: a.backup && { ...a.backup }
    }
    setAgents((all) => [...all, copy])
    setSel(copy.id)
  }

  const remove = (a: Agent) => {
    // Reports move up to the removed person's manager.
    setAgents((all) => all.filter((x) => x.id !== a.id).map((x) => (x.reportsTo === a.id ? { ...x, reportsTo: a.reportsTo } : x)))
    setSel(null)
  }

  const save = async () => {
    const problem = orgProblem(agents)
    if (problem) return notify(errText(problem, t))
    setBusy(true)
    try {
      // Keep what was saved elsewhere meanwhile (e.g. permissions granted for good during a task).
      await onSave({ ...(await latestProject(project)), agents })
      notify(t.common.saved)
    } catch (e) {
      notify(errText(e, t))
    } finally {
      setBusy(false)
    }
  }

  // Drag a card onto another one to change the manager. The manager field in the sheet does the same from the keyboard.
  const endDrag = () => {
    setDrag(null)
    setOver(null)
  }
  const accept = (e: DragEvent, a: Agent) => {
    if (!drag || !canMoveUnder(agents, drag, a.id)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (over !== a.id) setOver(a.id)
  }
  const dropProps = (a: Agent) => ({
    draggable: canDrag(agents, a.id),
    onDragStart: (e: DragEvent) => {
      e.dataTransfer.effectAllowed = 'move'
      // A private type: dropping a member on a text field elsewhere inserts nothing.
      e.dataTransfer.setData('application/x-ai-office-member', a.id)
      setDrag(a.id)
    },
    onDragEnd: endDrag,
    onDragEnter: (e: DragEvent) => accept(e, a),
    onDragOver: (e: DragEvent) => accept(e, a),
    onDragLeave: (e: DragEvent) => {
      if (over === a.id && !e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null)
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault()
      if (drag && canMoveUnder(agents, drag, a.id)) {
        const who = agents.find((x) => x.id === drag)
        setAgents((all) => moveUnder(all, drag, a.id))
        if (who) notify(t.org.moved(who.name, a.name))
      }
      endDrag()
    }
  })

  // A manager can't report to someone in their own subtree.
  const subtree = useMemo(() => (sel ? subtreeOf(agents, sel) : new Set<string>()), [agents, sel])

  const depts = new Set(agents.map((a) => a.department).filter(Boolean)).size
  const roles = [...ROLES.map((r) => r.title), ...pluginRoles.map((r) => r.title)]

  const tree = (nodes: OrgNode[], top: boolean) => {
    if (!nodes.length) return null
    return (
      <ul className={top ? 'tree' : undefined}>
        {nodes.map(({ agent: a, kids }) => {
          const st = status.get(a.id)
          return (
            <li key={a.id}>
              <div className="node-wrap">
                <button
                  className={`node ${sel === a.id ? 'on' : ''} ${drag === a.id ? 'dragging' : ''} ${over === a.id ? 'drop' : ''}`}
                  onClick={() => setSel(a.id)}
                  {...dropProps(a)}
                >
                  <div className="row">
                    <Avatar name={a.name} seed={a.id} size={32} status={st} />
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
                  {st && st !== 'idle' && <span className="org-sr">{t.work.status[st]}</span>}
                </button>
                <button className="node-add" onClick={() => add(a)} title={t.team.addReport(a.name)} aria-label={t.team.addReport(a.name)}>
                  <Icon name="plus" size={13} />
                </button>
              </div>
              {tree(kids, false)}
            </li>
          )
        })}
      </ul>
    )
  }

  const reports = agent ? agents.filter((a) => a.reportsTo === agent.id).length : 0
  const boss = agent?.reportsTo ? agents.find((a) => a.id === agent.reportsTo) : undefined
  const provider = agent ? providers.find((p) => p.id === agent.providerId) : undefined
  const defaults = agent ? roleDefaults(agent, pluginRoles) : null

  return (
    <div className="org">
      <div className="org-meta">
        {drag ? (
          t.org.dropHint
        ) : (
          <>
            {t.team.summary(agents.length, depts)}
            {agents.length > 1 && <span className="org-hint"> · {t.org.dragHint}</span>}
          </>
        )}
      </div>
      <div className="org-canvas" ref={canvas} onClick={(e) => e.target === e.currentTarget && setSel(null)}>
        {agents.length ? (
          tree(chart, true)
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
              <Avatar name={agent.name} seed={agent.id} size={36} status={status.get(agent.id)} />
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
                <select className="select" value={agent.reportsTo ?? ''} disabled={!!agent.exec} onChange={(e) => update({ reportsTo: e.target.value || null })}>
                  <option value="">{t.team.noManager}</option>
                  {agents.filter((a) => !subtree.has(a.id)).map((a) => <option key={a.id} value={a.id}>{a.name} — {a.title}</option>)}
                </select>
              </Field>
            </div>
            <Field label={t.team.role} hint={agent.exec ? t.org.execLocked : t.team.roleHint}>
              <input className="input" list="role-list" value={agent.title} readOnly={!!agent.exec} onChange={(e) => update(changeRole(agent, e.target.value, pluginRoles))} />
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
                <select
                  className="select"
                  value={agent.providerId}
                  onChange={(e) => {
                    const providerId = e.target.value
                    // Effort is an Anthropic setting; don't keep a hidden value for other APIs.
                    const anthropic = providers.find((p) => p.id === providerId)?.kind === 'anthropic'
                    update(anthropic ? { providerId } : { providerId, effort: undefined })
                  }}
                >
                  <option value="">{t.team.choose}</option>
                  {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </Field>
              <Field label={t.team.model}>
                <ModelInput providerId={agent.providerId} hasKey={provider?.hasKey} value={agent.model} onChange={(m) => update({ model: m })} />
              </Field>
            </div>
            <PriceLine provider={provider} model={agent.model} />
            <div className="grid2">
              {provider?.kind === 'anthropic' && (
                <Field label={t.org.effort}>
                  <select className="select" value={agent.effort ?? ''} onChange={(e) => update({ effort: (e.target.value || undefined) as Effort | undefined })}>
                    <option value="">{t.org.effortDefault}</option>
                    {EFFORTS.map((x) => <option key={x} value={x}>{t.org.efforts[x]}</option>)}
                  </select>
                </Field>
              )}
              <Field label={t.org.maxTokens}>
                <input
                  className="input num"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  step={1000}
                  value={agent.maxTokens ?? ''}
                  placeholder={t.org.maxTokensPh}
                  onChange={(e) => update({ maxTokens: maxTokensFrom(e.target.value) })}
                />
              </Field>
            </div>
            <small className="faint">{provider?.kind === 'anthropic' ? `${t.org.effortHint} ${t.org.maxTokensHint}` : t.org.maxTokensHint}</small>
            <div className="grid2">
              <Field label={t.team.backup}>
                <select
                  className="select"
                  value={agent.backup?.providerId ?? ''}
                  onChange={(e) => update({ backup: e.target.value ? { providerId: e.target.value, model: agent.backup?.model ?? '' } : undefined })}
                >
                  <option value="">{t.team.noBackup}</option>
                  {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </Field>
              {agent.backup && (
                <Field label={t.team.model}>
                  <ModelInput
                    providerId={agent.backup.providerId}
                    hasKey={providers.find((p) => p.id === agent.backup?.providerId)?.hasKey}
                    value={agent.backup.model}
                    onChange={(m) => update({ backup: { providerId: agent.backup!.providerId, model: m } })}
                  />
                </Field>
              )}
            </div>
            <small className="faint">{t.team.backupHint}</small>
          </section>

          <section className="sheet-group">
            <details className="more">
              <summary><Icon name="chevron" size={12} /> {t.team.advanced}</summary>
              <div className="stack">

                <Group label={t.team.tools} hint={t.team.toolsHint}>
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
                </Group>

                <Group label={t.team.mcp}>
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
                </Group>

                <SkillsField agent={agent} skills={skills} onChange={(s) => update({ skills: s })} />

                <Field label={t.team.instructions} hint={t.team.instructionsHint}>
                  <textarea className="textarea" rows={7} value={agent.instructions} onChange={(e) => update({ instructions: e.target.value })} />
                </Field>
                {defaults && (
                  <button type="button" className="btn quiet sm org-reset" onClick={() => update(defaults)}>
                    <Icon name="undo" size={13} /> {t.org.resetRole}
                  </button>
                )}
              </div>
            </details>
          </section>

          {!agent.exec && agent.reportsTo && (
            <section className="sheet-group">
              <ConfirmButton onConfirm={() => remove(agent)}>{t.common.delete}</ConfirmButton>
            </section>
          )}
        </Sheet>
      )}
    </div>
  )
}

/** Which enabled skills the member may load. `undefined` = all of them, including ones turned on later. */
function SkillsField({ agent, skills, onChange }: { agent: Agent; skills: { list: Skill[]; error?: unknown } | null; onChange(s: string[] | undefined): void }) {
  const t = useT()
  if (!skills) return null
  if (skills.error !== undefined) {
    return (
      <Group label={t.org.skills}>
        <div className="note danger">{errText(skills.error, t)}</div>
      </Group>
    )
  }
  if (!skills.list.length) {
    return (
      <Group label={t.org.skills}>
        <small>{t.org.skillsNone}</small>
      </Group>
    )
  }
  const all = agent.skills === undefined
  const chosen = agent.skills ?? []
  const picked = skills.list.filter((s) => chosen.includes(s.name)).length
  return (
    <Group label={t.org.skills} hint={!all && !picked ? t.org.skillsEmpty : t.org.skillsHint}>
      <label className={`check ${all ? 'on' : ''}`}>
        <input type="checkbox" checked={all} onChange={() => onChange(all ? skills.list.map((s) => s.name) : undefined)} />
        {t.org.allSkills}
      </label>
      {!all && (
        <div className="checks">
          {skills.list.map((s) => {
            const on = chosen.includes(s.name)
            return (
              <label key={s.name} className={`check ${on ? 'on' : ''}`} title={s.description}>
                <input type="checkbox" checked={on} onChange={() => onChange(on ? chosen.filter((x) => x !== s.name) : [...chosen, s.name])} />
                <span className="ellipsis">{s.name}</span>
              </label>
            )
          })}
        </div>
      )}
    </Group>
  )
}
