import { useEffect, useId, useMemo, useRef, useState, type DragEvent, type PointerEvent, type ReactNode } from 'react'
import type { Agent, Effort, McpServer, Price, Project, Provider, RoleTemplate, Skill, ToolName } from '../../shared/types'
import type { Live } from './App'
import { errText, useT } from './i18n'
import { createModelCache } from './modelList'
import { latestProject } from './officeForm'
import { autoLayout, belowOf, CARD, canMoveUnder, edgePath, liveStatus, maxTokensFrom, moveUnder, orgProblem, sameJson, subtreeOf, type Point } from './orgchart'
import { byDepartment, changeRole, headFor, newAgent, roleByTitle, roleDefaults, roleFrom, ROLES, STAFF_ROLES, starterRole, uid, type Role } from './roles'
import { isOpenRouter, num } from './Pricing'
import { Avatar, ConfirmButton, Field, Icon, Sheet } from './ui'

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

const ROLE_MIME = 'application/x-ai-office-role'
/** Room around the cards inside the canvas. */
const PAD = 40
const ZOOM = { min: 0.4, max: 1.5, step: 0.1 }
const clampZoom = (z: number) => Math.round(Math.min(ZOOM.max, Math.max(ZOOM.min, z)) * 10) / 10

/** Widths of the rail and the role palette beside the canvas (styles.css). */
const RAIL = 232
const PALETTE = 176
const PALETTE_KEY = 'ai-office.palette'

/** localStorage can be unavailable; the setting is only a convenience. */
function stored(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

/** The canvas area the cards need, with the room around them. */
function sizeOf(agents: Agent[], auto: Map<string, Point>) {
  let w = 0
  let h = 0
  for (const a of agents) {
    const p = a.pos ?? auto.get(a.id)
    if (p) {
      w = Math.max(w, p.x + CARD.w)
      h = Math.max(h, p.y + CARD.h)
    }
  }
  return { w: w + PAD * 2, h: h + PAD * 2 }
}

/** The member card under a screen point, if any. */
const memberAt = (x: number, y: number) => document.elementFromPoint(x, y)?.closest('[data-member]')?.getAttribute('data-member') ?? null

/** Follows the pointer until it is released; `done` is false when the gesture was cancelled. */
function follow(move: (e: globalThis.PointerEvent) => void, end: (e: globalThis.PointerEvent, done: boolean) => void) {
  const onMove = (e: globalThis.PointerEvent) => move(e)
  const onEnd = (e: globalThis.PointerEvent) => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onEnd)
    window.removeEventListener('pointercancel', onEnd)
    end(e, e.type === 'pointerup')
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onEnd)
  window.addEventListener('pointercancel', onEnd)
}

interface Props {
  project: Project
  providers: Provider[]
  /** The office's current work, for live status on the chart. */
  live?: Live
  onSave(p: Project): Promise<void>
  notify(t: string): void
  /** Told whenever the team differs from the saved one. */
  onDirty?(dirty: boolean): void
}

export default function Team({ project, providers, live, onSave, notify, onDirty }: Props) {
  const t = useT()
  const [agents, setAgents] = useState(project.agents)
  const [sel, setSel] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [mcp, setMcp] = useState<McpServer[]>([])
  const [pluginRoles, setPluginRoles] = useState<RoleTemplate[]>([])
  const [skills, setSkills] = useState<{ list: Skill[]; error?: unknown } | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(() => stored(PALETTE_KEY) !== '0')
  // Open with the whole width of the chart in view (down to 60%).
  const [zoom, setZoom] = useState(() => clampZoom(Math.max(0.6, Math.min(1, Math.floor(((window.innerWidth - RAIL - (paletteOpen ? PALETTE : 0)) / sizeOf(project.agents, autoLayout(project.agents)).w) * 10) / 10))))
  /** A line being drawn from a manager's port; `to` is the pointer in canvas units. */
  const [link, setLink] = useState<{ from: string; to: Point } | null>(null)
  /** The card a line or a role from the palette would land on. */
  const [over, setOver] = useState<string | null>(null)
  const [hiring, setHiring] = useState(false)
  const dirty = !sameJson(agents, project.agents)
  useEffect(() => onDirty?.(dirty), [dirty, onDirty])
  const agent = agents.find((a) => a.id === sel)
  const status = useMemo(() => liveStatus(live?.events), [live?.events])
  const auto = useMemo(() => autoLayout(agents), [agents])
  const byId = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents])
  const at = (a: Agent): Point => a.pos ?? auto.get(a.id) ?? { x: 0, y: 0 }
  const size = useMemo(() => sizeOf(agents, auto), [agents, auto])

  const canvas = useRef<HTMLDivElement>(null)
  const plane = useRef<HTMLDivElement>(null)
  /** The last pointer gesture on a card moved it: the click that follows is not a selection. */
  const moved = useRef(false)

  // Start with the CEO in view when the chart is wider than the window.
  useEffect(() => {
    const el = canvas.current
    if (el) el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2
  }, [])

  // Ctrl + wheel zooms; React's wheel listener is passive, so the page zoom can't be prevented there.
  useEffect(() => {
    const el = canvas.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      setZoom((z) => clampZoom(z - Math.sign(e.deltaY) * ZOOM.step))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
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

  /** Pointer position in canvas units (the same units as `pos`). */
  const toWorld = (clientX: number, clientY: number): Point => {
    const r = plane.current!.getBoundingClientRect()
    return { x: (clientX - r.left) / zoom - PAD, y: (clientY - r.top) / zoom - PAD }
  }

  const hire = (role: Role, boss: Agent | undefined, pos?: Point) => {
    if (!boss) return
    const used = new Set(agents.map((a) => a.name.trim().toLowerCase()))
    const name = t.names.find((n) => !used.has(n.toLowerCase())) ?? `${t.names[0]} ${agents.length + 1}`
    const a = newAgent(name, role, boss.id, boss.providerId, boss.model)
    a.department = role.department || boss.department
    a.pos = pos ?? belowOf(at(boss), agents.filter((x) => x.reportsTo === boss.id).length)
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
      id: uid(),
      name: `${a.name} ${n}`,
      // A copy of the top executive becomes their deputy: there can be only one top.
      reportsTo: a.reportsTo ?? a.id,
      tools: [...a.tools],
      mcpServers: a.mcpServers && [...a.mcpServers],
      skills: a.skills && [...a.skills],
      backup: a.backup && { ...a.backup },
      pos: { x: at(a).x + 24, y: at(a).y + 24 }
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

  // --- pointer gestures: move a card, draw a manager → report line, pan the canvas ---

  const startMove = (e: PointerEvent, a: Agent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    const start = at(a)
    const sx = e.clientX
    const sy = e.clientY
    moved.current = false
    follow(
      (ev) => {
        const dx = (ev.clientX - sx) / zoom
        const dy = (ev.clientY - sy) / zoom
        if (!moved.current && Math.hypot(dx, dy) < 4) return
        moved.current = true
        const pos = { x: Math.max(0, Math.round(start.x + dx)), y: Math.max(0, Math.round(start.y + dy)) }
        setAgents((all) => all.map((x) => (x.id === a.id ? { ...x, pos } : x)))
      },
      () => undefined
    )
  }

  const startLink = (e: PointerEvent, boss: Agent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    setLink({ from: boss.id, to: toWorld(e.clientX, e.clientY) })
    follow(
      (ev) => {
        setLink({ from: boss.id, to: toWorld(ev.clientX, ev.clientY) })
        const id = memberAt(ev.clientX, ev.clientY)
        setOver(id && canMoveUnder(agents, id, boss.id) ? id : null)
      },
      (ev, done) => {
        setLink(null)
        setOver(null)
        const id = done ? memberAt(ev.clientX, ev.clientY) : null
        const who = id ? byId.get(id) : undefined
        if (!who || who.id === boss.id || who.reportsTo === boss.id) return
        if (!canMoveUnder(agents, who.id, boss.id)) return notify(t.org.cantLink(who.name, boss.name))
        setAgents((all) => moveUnder(all, who.id, boss.id))
        notify(t.org.moved(who.name, boss.name))
      }
    )
  }

  const startPan = (e: PointerEvent) => {
    if (e.button !== 0 || (e.target as Element).closest('[data-member]')) return
    const el = canvas.current!
    const sx = e.clientX
    const sy = e.clientY
    const left = el.scrollLeft
    const top = el.scrollTop
    let panned = false
    follow(
      (ev) => {
        panned ||= Math.hypot(ev.clientX - sx, ev.clientY - sy) > 3
        el.scrollLeft = left - (ev.clientX - sx)
        el.scrollTop = top - (ev.clientY - sy)
      },
      () => !panned && setSel(null)
    )
  }

  // --- roles dragged in from the palette (HTML5 drag and drop) ---

  const roleOver = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes(ROLE_MIME)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    const id = memberAt(e.clientX, e.clientY)
    if (id !== over) setOver(id)
  }
  const roleDrop = (e: DragEvent) => {
    const role = roleFrom(e.dataTransfer.getData(ROLE_MIME), pluginRoles)
    setOver(null)
    setHiring(false)
    if (!role) return
    e.preventDefault()
    const onto = byId.get(memberAt(e.clientX, e.clientY) ?? '')
    const p = toWorld(e.clientX, e.clientY)
    hire(role, onto ?? headFor(agents, role.department), onto ? undefined : { x: Math.max(0, Math.round(p.x - CARD.w / 2)), y: Math.max(0, Math.round(p.y - CARD.h / 2)) })
  }

  const togglePalette = () => {
    const open = !paletteOpen
    setPaletteOpen(open)
    try {
      localStorage.setItem(PALETTE_KEY, open ? '1' : '0')
    } catch {
      // not persisted; still applies until the app closes
    }
  }

  const fit = () => {
    const el = canvas.current
    if (el) setZoom(clampZoom(Math.floor(Math.min(el.clientWidth / size.w, el.clientHeight / size.h) * 10) / 10))
  }
  const arranged = agents.some((a) => a.pos)
  const depts = new Set(agents.map((a) => a.department).filter(Boolean)).size
  const roles = [...ROLES.map((r) => r.title), ...pluginRoles.map((r) => r.title)]
  const palette = [...STAFF_ROLES, ...pluginRoles.map((r) => roleFrom(r.title, pluginRoles)!).filter((r) => !roleByTitle(r.title))]
  // A manager can't report to someone in their own subtree.
  const subtree = useMemo(() => (sel ? subtreeOf(agents, sel) : new Set<string>()), [agents, sel])

  const reports = agent ? agents.filter((a) => a.reportsTo === agent.id).length : 0
  const boss = agent?.reportsTo ? agents.find((a) => a.id === agent.reportsTo) : undefined
  const provider = agent ? providers.find((p) => p.id === agent.providerId) : undefined
  const defaults = agent ? roleDefaults(agent, pluginRoles) : null

  return (
    <div className={`org ${paletteOpen ? '' : 'bare'}`}>
      {paletteOpen && (
        <aside className="org-palette" aria-label={t.org.palette}>
          <h4>{t.org.palette}</h4>
          <div className="org-roles">
            {byDepartment(palette).map(([dept, list]) => (
              <section key={dept}>
                <h5>{dept || t.org.otherRoles}</h5>
                {list.map((r) => (
                  <button
                    key={r.title}
                    type="button"
                    className="org-role"
                    draggable
                    title={t.org.hireRole(r.title)}
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = 'copy'
                      // A private type: dropping a role on a text field elsewhere inserts nothing.
                      e.dataTransfer.setData(ROLE_MIME, r.title)
                      setHiring(true)
                    }}
                    onDragEnd={() => {
                      setHiring(false)
                      setOver(null)
                    }}
                    onClick={() => hire(r, headFor(agents, r.department))}
                  >
                    <span className="ellipsis">{r.title}</span>
                    <Icon name="grip" size={12} />
                  </button>
                ))}
              </section>
            ))}
          </div>
          <p className="org-palette-hint">{t.org.paletteHint}</p>
        </aside>
      )}

      <div className="org-main">
        <div className="org-meta">
          {link ? t.org.linkHint : hiring ? t.org.dropHint : t.team.summary(agents.length, depts)}
        </div>
        <div className="org-tools" role="toolbar" aria-label={t.org.view}>
          <button className="btn quiet sm" aria-pressed={paletteOpen} onClick={togglePalette}>
            <Icon name="users" size={14} /> {t.org.palette}
          </button>
          <span className="org-tools-sep" aria-hidden />
          <button className="btn quiet icon sm" onClick={() => setZoom((z) => clampZoom(z - ZOOM.step))} disabled={zoom <= ZOOM.min} title={t.org.zoomOut} aria-label={t.org.zoomOut}>
            <Icon name="minus" size={14} />
          </button>
          <button className="btn quiet sm num" onClick={() => setZoom(1)} title={t.org.zoomReset}>{Math.round(zoom * 100)}%</button>
          <button className="btn quiet icon sm" onClick={() => setZoom((z) => clampZoom(z + ZOOM.step))} disabled={zoom >= ZOOM.max} title={t.org.zoomIn} aria-label={t.org.zoomIn}>
            <Icon name="plus" size={14} />
          </button>
          <button className="btn quiet icon sm" onClick={fit} title={t.org.fit} aria-label={t.org.fit}>
            <Icon name="fit" size={14} />
          </button>
          {arranged && (
            <button className="btn quiet sm" onClick={() => setAgents((all) => all.map(({ pos, ...a }) => a))} title={t.org.tidyHint}>
              {t.org.tidy}
            </button>
          )}
        </div>
        <div
          className={`org-canvas ${link ? 'linking' : ''}`}
          ref={canvas}
          onPointerDown={startPan}
          onDragOver={roleOver}
          onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setOver(null)}
          onDrop={roleDrop}
        >
          <div className="org-plane" ref={plane} style={{ width: size.w * zoom, height: size.h * zoom }}>
            <div className="org-world" style={{ width: size.w, height: size.h, transform: `scale(${zoom})` }}>
              <svg className="org-edges" width={size.w} height={size.h} aria-hidden>
                <g transform={`translate(${PAD} ${PAD})`}>
                  {agents.map((a) => {
                    const boss = a.reportsTo ? byId.get(a.reportsTo) : undefined
                    return boss ? <path key={a.id} d={edgePath(at(boss), at(a))} className={sel === a.id || sel === boss.id ? 'on' : undefined} /> : null
                  })}
                  {link && byId.get(link.from) && <path className="temp" d={edgePath(at(byId.get(link.from)!), { x: link.to.x - CARD.w / 2, y: link.to.y })} />}
                </g>
              </svg>
              {agents.map((a) => {
                const p = at(a)
                const st = status.get(a.id)
                return (
                  <div key={a.id} className="org-card" style={{ left: p.x + PAD, top: p.y + PAD }} data-member={a.id}>
                    <button
                      className={`node ${a.exec ? 'exec' : ''} ${sel === a.id ? 'on' : ''} ${over === a.id ? 'drop' : ''}`}
                      onPointerDown={(e) => startMove(e, a)}
                      onClick={() => {
                        if (moved.current) moved.current = false
                        else setSel(a.id)
                      }}
                    >
                      <div className="row">
                        <Avatar name={a.name} seed={a.id} size={32} status={st} />
                        <div className="ellipsis">
                          <div className="node-name ellipsis">{a.name}</div>
                          <div className="node-title ellipsis">{a.title}</div>
                        </div>
                        {a.exec === 'ceo' && <Icon name="crown" size={13} className="faint" />}
                      </div>
                      <div className="node-foot">
                        <span className="ellipsis">{a.department || '—'}</span>
                        <span className="ellipsis mono">{a.model || '—'}</span>
                      </div>
                      {st && st !== 'idle' && <span className="org-sr">{t.work.status[st]}</span>}
                    </button>
                    {/* Pointer only: the manager field in the member's sheet does the same from the keyboard. */}
                    <button className="org-port" tabIndex={-1} aria-hidden onPointerDown={(e) => startLink(e, a)} title={t.org.linkFrom(a.name)} />
                    <button className="node-add" onClick={() => hire(starterRole(agents, a), a)} title={t.team.addReport(a.name)} aria-label={t.team.addReport(a.name)}>
                      <Icon name="plus" size={13} />
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
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
