import { useEffect, useMemo, useState } from 'react'
import { TOOL_NAMES, type Agent, type Project, type Provider, type ToolName } from '../../shared/types'
import { KNOWN_PRICES, newAgent, roleByTitle, ROLES, uid } from './roles'
import { Avatar, Dept, errText, Field, Icon } from './ui'

const TOOL_LABELS: Record<ToolName, string> = {
  list_files: 'Fayllar ro‘yxati',
  read_file: 'Fayl o‘qish',
  write_file: 'Fayl yozish',
  edit_file: 'Fayl tahrirlash',
  run_command: 'Terminal buyruqlari',
  message: 'Xabar yuborish',
  remember: 'Eslab qolish',
  report_to_user: 'Egaga hisobot'
}
const EDITABLE_TOOLS = TOOL_NAMES.filter((t) => !['message', 'remember', 'report_to_user'].includes(t))

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
  const [agents, setAgents] = useState(project.agents)
  const [sel, setSel] = useState<string | null>(project.agents.find((a) => !a.reportsTo)?.id ?? null)
  const [err, setErr] = useState('')
  const dirty = JSON.stringify(agents) !== JSON.stringify(project.agents)
  const agent = agents.find((a) => a.id === sel)
  const providerName = (id: string) => providers.find((p) => p.id === id)?.name ?? '—'

  const update = (patch: Partial<Agent>) => setAgents((all) => all.map((a) => (a.id === sel ? { ...a, ...patch } : a)))

  const add = (boss: Agent | undefined) => {
    const base = boss ?? agents[0]
    const a = newAgent(`Xodim ${agents.length + 1}`, ROLES.find((r) => r.title === 'Software Engineer')!, boss?.id ?? null, base?.providerId, base?.model)
    a.priceIn = base?.priceIn ?? 0
    a.priceOut = base?.priceOut ?? 0
    a.department = boss?.department ?? ''
    setAgents((all) => [...all, a])
    setSel(a.id)
  }

  const duplicate = (a: Agent) => {
    const copy = { ...a, id: uid(), name: `${a.name} 2`, tools: [...a.tools] }
    setAgents((all) => [...all, copy])
    setSel(copy.id)
  }

  const remove = (a: Agent) => {
    // Reports move up to the removed person's manager.
    setAgents((all) => all.filter((x) => x.id !== a.id).map((x) => (x.reportsTo === a.id ? { ...x, reportsTo: a.reportsTo } : x)))
    setSel(a.reportsTo)
  }

  const save = async () => {
    setErr('')
    const ceos = agents.filter((a) => !a.reportsTo)
    if (ceos.length !== 1) return setErr('Aynan bitta bosh rahbar bo‘lishi kerak (boshlig‘i yo‘q xodim)')
    const names = agents.map((a) => a.name.trim().toLowerCase())
    if (new Set(names).size !== names.length) return setErr('Xodimlar ismlari takrorlanmasligi kerak')
    if (agents.some((a) => !a.model.trim() || !a.providerId)) return setErr('Har bir xodimga provayder va model tanlang')
    try {
      await onSave({ ...project, agents })
      notify('Jamoa saqlandi')
    } catch (e) {
      setErr(errText(e))
    }
  }

  // Managers can't report to someone in their own subtree.
  const subtree = useMemo(() => {
    const ids = new Set<string>()
    const walk = (id: string) => {
      ids.add(id)
      agents.filter((a) => a.reportsTo === id).forEach((a) => walk(a.id))
    }
    if (sel) walk(sel)
    return ids
  }, [agents, sel])

  const tree = (boss: string | null) => {
    const kids = agents.filter((a) => (a.reportsTo ?? null) === boss)
    if (!kids.length) return null
    return (
      <ul className={boss ? undefined : 'tree'}>
        {kids.map((a) => (
          <li key={a.id}>
            <button className={`card node ${sel === a.id ? 'sel' : ''}`} onClick={() => setSel(a.id)}>
              <div className="node-top">
                <Avatar name={a.name} seed={a.id} size={34} />
                <div style={{ minWidth: 0 }}>
                  <div className="node-name">{a.name}</div>
                  <div className="node-title">{a.title}</div>
                </div>
                {!a.reportsTo && <Icon name="crown" size={14} className="faint" />}
              </div>
              <Dept name={a.department} />
              <div className="node-model" title={`${providerName(a.providerId)} · ${a.model}`}>
                {a.model || 'model tanlanmagan'}
              </div>
            </button>
            {tree(a.id)}
          </li>
        ))}
      </ul>
    )
  }

  const reportsCount = agent ? agents.filter((a) => a.reportsTo === agent.id).length : 0

  return (
    <div className="org-wrap">
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div className="runbar">
          <div>
            <div style={{ fontWeight: 650 }}>Tashkiliy tuzilma</div>
            <div className="faint small">{agents.length} xodim · {new Set(agents.map((a) => a.department).filter(Boolean)).size} bo‘lim</div>
          </div>
          <div className="spacer" />
          {err && <span className="badge danger">{err}</span>}
          <button className="btn" onClick={() => add(agent)}>
            <Icon name="plus" size={15} /> {agent ? `${agent.name}ga xodim` : 'Xodim'}
          </button>
          <button className="btn primary" onClick={save} disabled={!dirty}>
            <Icon name="check" size={15} /> Saqlash
          </button>
        </div>
        <div className="org-canvas" style={{ flex: 1 }}>
          {agents.length ? tree(null) : (
            <div className="empty">
              <h3>Jamoa bo‘sh</h3>
              <button className="btn primary" onClick={() => add(undefined)}><Icon name="plus" /> Bosh rahbar qo‘shish</button>
            </div>
          )}
        </div>
      </div>

      <aside className="drawer">
        {agent ? (
          <>
            <div className="drawer-head">
              <Avatar name={agent.name} seed={agent.id} size={40} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 650, fontSize: 15 }}>{agent.name}</div>
                <div className="faint small">{agent.reportsTo ? `${agents.find((a) => a.id === agent.reportsTo)?.name ?? '?'}ga hisobot beradi` : 'Bosh rahbar · sizga hisobot beradi'}{reportsCount ? ` · ${reportsCount} qo‘l ostida` : ''}</div>
              </div>
              <button className="btn ghost icon" title="Nusxa olish" aria-label="Nusxa olish" onClick={() => duplicate(agent)}><Icon name="copy" /></button>
              <button className="btn ghost icon danger" title="O‘chirish" aria-label="O‘chirish" onClick={() => remove(agent)} disabled={!agent.reportsTo && agents.length > 1}><Icon name="trash" /></button>
            </div>
            <div className="drawer-body stack">
              <div className="grid2">
                <Field label="Ism">
                  <input className="input" value={agent.name} onChange={(e) => update({ name: e.target.value })} />
                </Field>
                <Field label="Boshlig‘i">
                  <select className="select" value={agent.reportsTo ?? ''} onChange={(e) => update({ reportsTo: e.target.value || null })}>
                    <option value="">— Hech kim (bosh rahbar)</option>
                    {agents.filter((a) => !subtree.has(a.id)).map((a) => <option key={a.id} value={a.id}>{a.name} — {a.title}</option>)}
                  </select>
                </Field>
              </div>
              <div className="grid2">
                <Field label="Lavozim" hint="Istalgan kasb: ro‘yxatdan tanlang yoki yozing">
                  <input
                    className="input"
                    list="role-list"
                    value={agent.title}
                    onChange={(e) => {
                      const r = roleByTitle(e.target.value)
                      update(r ? { title: r.title, department: agent.department || r.department, instructions: r.instructions, tools: [...r.tools] } : { title: e.target.value })
                    }}
                  />
                  <datalist id="role-list">{ROLES.map((r) => <option key={r.title} value={r.title} />)}</datalist>
                </Field>
                <Field label="Bo‘lim">
                  <input className="input" list="dept-list" value={agent.department} onChange={(e) => update({ department: e.target.value })} />
                  <datalist id="dept-list">{[...new Set([...agents.map((a) => a.department), ...ROLES.map((r) => r.department)])].filter(Boolean).map((d) => <option key={d} value={d} />)}</datalist>
                </Field>
              </div>

              <div className="grid2">
                <Field label="Provayder">
                  <select className="select" value={agent.providerId} onChange={(e) => update({ providerId: e.target.value })}>
                    <option value="">Tanlang…</option>
                    {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </Field>
                <Field label="Model">
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
              <div className="grid2">
                <Field label="Kirish narxi ($ / 1M token)">
                  <input className="input" type="number" min={0} step={0.01} value={agent.priceIn} onChange={(e) => update({ priceIn: Math.max(0, Number(e.target.value)) })} />
                </Field>
                <Field label="Chiqish narxi ($ / 1M token)">
                  <input className="input" type="number" min={0} step={0.01} value={agent.priceOut} onChange={(e) => update({ priceOut: Math.max(0, Number(e.target.value)) })} />
                </Field>
              </div>
              {!agent.priceIn && !agent.priceOut && <div className="alert warn">Narx kiritilmagan — byudjet bu xodim xarajatini hisoblay olmaydi. Narxni provayder sahifasidan oling.</div>}

              <Field label="Ruxsat etilgan asboblar" hint="Xabar yuborish va eslab qolish hammaga ochiq.">
                <div className="tools-grid">
                  {EDITABLE_TOOLS.map((t) => {
                    const on = agent.tools.includes(t)
                    return (
                      <label key={t} className={`check ${on ? 'on' : ''}`}>
                        <input type="checkbox" checked={on} onChange={() => update({ tools: on ? agent.tools.filter((x) => x !== t) : [...agent.tools, t] })} />
                        {TOOL_LABELS[t]}
                      </label>
                    )
                  })}
                </div>
              </Field>

              <Field label="Yo‘riqnoma (rol tavsifi)" hint="Bu xodim nimaga javobgar, qanday ishlaydi, sifat mezonlari.">
                <textarea className="textarea" rows={7} value={agent.instructions} onChange={(e) => update({ instructions: e.target.value })} />
              </Field>
            </div>
          </>
        ) : (
          <div className="empty">
            <Icon name="users" size={28} />
            <p>Tahrirlash uchun xodimni tanlang</p>
          </div>
        )}
      </aside>
    </div>
  )
}
