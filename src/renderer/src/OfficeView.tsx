import { useEffect, useMemo, useRef, useState } from 'react'
import { SYSTEM, USER, type Agent, type AgentStatus, type OfficeEvent, type Project, type Provider, type RunSummary } from '../../shared/types'
import type { Live } from './App'
import { Avatar, clock, dateTime, Dept, errText, Icon, Markdown, Modal, tokens, usd, type IconName } from './ui'

const TOOL_ICON: Record<string, IconName> = {
  list_files: 'folder',
  read_file: 'eye',
  write_file: 'file',
  edit_file: 'edit',
  run_command: 'terminal',
  remember: 'brain',
  report_to_user: 'check'
}
const TOOL_VERB: Record<string, string> = {
  list_files: 'papkani ko‘rdi',
  read_file: 'o‘qidi',
  write_file: 'yozdi',
  edit_file: 'tahrirladi',
  run_command: 'ishga tushirdi',
  remember: 'eslab qoldi',
  report_to_user: 'hisobot berdi'
}
const EXAMPLES = [
  'Ish papkasida oddiy TODO veb-ilova yarating: HTML/CSS/JS, localStorage, testlar bilan.',
  'Mahsulotimiz uchun landing sahifa matni, marketing rejasi va narx strategiyasini tayyorlang.',
  'Ish papkasidagi loyihani xavfsizlik nuqtai nazaridan tekshiring va hisobot yozing.'
]

interface Props {
  project: Project
  providers: Provider[]
  live?: Live
  notify(t: string): void
  goTeam(): void
}

export default function OfficeView({ project, providers, live, notify, goTeam }: Props) {
  const [text, setText] = useState('')
  const [focus, setFocus] = useState<string | null>(null)
  const [fresh, setFresh] = useState(false)
  const [viewing, setViewing] = useState<{ run: RunSummary; events: OfficeEvent[] } | null>(null)
  const [history, setHistory] = useState<RunSummary[] | null>(null)
  const [busy, setBusy] = useState(false)
  const feedRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  const events = useMemo(() => viewing?.events ?? live?.events ?? [], [viewing, live])
  const byId = useMemo(() => new Map(project.agents.map((a) => [a.id, a])), [project.agents])
  const ceo = project.agents.find((a) => !a.reportsTo)

  const s = useMemo(() => {
    const status = new Map<string, AgentStatus>()
    const cost = new Map<string, number>()
    const answered = new Set<string>()
    let total = 0
    let toks = 0
    let state: string | null = null
    let reason = ''
    for (const e of events) {
      if (e.type === 'status') status.set(e.agentId, e.status)
      if (e.type === 'cost') {
        cost.set(e.agentId, (cost.get(e.agentId) ?? 0) + e.usd)
        total += e.usd
        toks += e.inTok + e.outTok
      }
      if (e.type === 'approval_done') answered.add(e.id)
      if (e.type === 'run') {
        state = e.state
        reason = e.reason ?? ''
      }
    }
    const goal = events.find((e) => e.type === 'message' && e.from === USER)
    return { status, cost, answered, total, toks, state, reason, goal: goal?.type === 'message' ? goal.text : '' }
  }, [events])

  const running = !viewing && s.state === 'running'
  const canContinue = !viewing && !fresh && Boolean(live)

  useEffect(() => {
    const el = feedRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [events.length])

  const send = async () => {
    const t = text.trim()
    if (!t || busy) return
    setBusy(true)
    try {
      if (canContinue) await window.office.post(project.id, t, focus && focus !== ceo?.id ? focus : undefined)
      else {
        await window.office.start(project.id, t)
        setFresh(false)
        setViewing(null)
      }
      setText('')
      stick.current = true
    } catch (e) {
      notify(errText(e))
    } finally {
      setBusy(false)
    }
  }

  const openHistory = async () => setHistory(await window.office.listRuns(project.id))

  const departments = useMemo(() => {
    const m = new Map<string, Agent[]>()
    for (const a of project.agents) m.set(a.department || 'Boshqa', [...(m.get(a.department || 'Boshqa') ?? []), a])
    // CEO's department first.
    return [...m.entries()].sort(([a], [b]) => (a === ceo?.department ? -1 : b === ceo?.department ? 1 : a.localeCompare(b)))
  }, [project.agents, ceo])

  const visible = focus
    ? events.filter((e) =>
        e.type === 'message' ? e.from === focus || e.to.includes(focus) : e.type === 'tool' || e.type === 'approval' ? e.agentId === focus : e.type === 'run'
      )
    : events

  const nameOf = (id: string) => (id === USER ? 'Siz' : id === SYSTEM ? 'Tizim' : (byId.get(id)?.name ?? 'Sobiq xodim'))
  const providerName = (a: Agent) => providers.find((p) => p.id === a.providerId)?.name ?? ''
  const showEmpty = !viewing && (fresh || !live)

  if (!project.agents.length) {
    return (
      <div className="empty" style={{ height: '100%' }}>
        <div className="empty-icon"><Icon name="users" size={24} /></div>
        <h3>Jamoa hali tuzilmagan</h3>
        <button className="btn primary" onClick={goTeam}>Jamoa tuzish</button>
      </div>
    )
  }

  return (
    <div className="office">
      <aside className="people">
        <button className={`person ${focus === null ? 'on' : ''}`} onClick={() => setFocus(null)}>
          <div className="avatar" style={{ width: 30, height: 30, background: 'var(--bg-sunken)', color: 'var(--text-2)' }}>
            <Icon name="chat" size={15} />
          </div>
          <div>
            <div className="person-name">Umumiy kanal</div>
            <div className="person-sub">Hamma xabarlar</div>
          </div>
          {!showEmpty && <span className="person-cost">{usd(s.total)}</span>}
        </button>
        {departments.map(([dept, list]) => (
          <div key={dept}>
            <div className="dept-label">{dept}</div>
            {list.map((a) => (
              <button key={a.id} className={`person ${focus === a.id ? 'on' : ''}`} onClick={() => setFocus(focus === a.id ? null : a.id)} title={`${a.title} · ${providerName(a)} ${a.model}`}>
                <Avatar name={a.name} seed={a.id} size={30} status={showEmpty ? undefined : (s.status.get(a.id) ?? 'idle')} />
                <div style={{ minWidth: 0 }}>
                  <div className="person-name">{a.name} {!a.reportsTo && <Icon name="crown" size={11} className="faint" />}</div>
                  <div className="person-sub">{s.status.get(a.id) === 'working' && !showEmpty ? 'ishlamoqda…' : s.status.get(a.id) === 'waiting' && !showEmpty ? 'ruxsat kutmoqda' : a.title}</div>
                </div>
                {!showEmpty && (s.cost.get(a.id) ?? 0) > 0 && <span className="person-cost">{usd(s.cost.get(a.id)!)}</span>}
              </button>
            ))}
          </div>
        ))}
      </aside>

      <section className="feed-col">
        <div className="runbar">
          {viewing ? <span className="badge"><Icon name="history" size={12} /> Tarix · {dateTime(viewing.run.startedAt)}</span> : running ? <span className="badge ok"><span className="dot working" /> Ishlamoqda</span> : s.state === 'stopped' ? <span className="badge danger">To‘xtatildi</span> : s.state === 'done' && !showEmpty ? <span className="badge accent">Tugadi</span> : <span className="badge">Kutish rejimi</span>}
          <div className="goal" title={s.goal}>{showEmpty ? 'Yangi vazifa' : s.goal}</div>
          <div className="spacer" />
          {!showEmpty && (
            <>
              <div className="stat"><b>{usd(s.total)}</b><span>{project.budgetUsd ? `/ $${project.budgetUsd} byudjet` : 'sarflandi'}</span></div>
              <div className="stat"><b>{tokens(s.toks)}</b><span>token</span></div>
            </>
          )}
          {running && (
            <button className="btn danger sm" onClick={() => window.office.stop(project.id)}>
              <Icon name="stop" size={13} /> To‘xtatish
            </button>
          )}
          {viewing ? (
            <button className="btn sm" onClick={() => setViewing(null)}>Joriy ishga qaytish</button>
          ) : (
            !showEmpty && !running && (
              <button className="btn sm" onClick={() => setFresh(true)}>
                <Icon name="plus" size={13} /> Yangi vazifa
              </button>
            )
          )}
          <button className="btn ghost icon sm" title="Tarix" aria-label="Tarix" onClick={openHistory}>
            <Icon name="history" size={15} />
          </button>
        </div>

        <div className="feed" ref={feedRef} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80 }}>
          {showEmpty ? (
            <div className="empty" style={{ margin: 'auto' }}>
              <div className="empty-icon"><Icon name="sparkle" size={24} /></div>
              <h3>{ceo?.name ?? 'Bosh rahbar'}ga maqsad bering</h3>
              <p style={{ maxWidth: 520, margin: '0 0 18px' }}>
                {ceo?.name} ishni bo‘limlarga bo‘ladi, {project.agents.length - 1} xodim bajaradi va tekshiradi, yakunda sizga hisobot keladi.
                {!project.briefing.trim() && ' Maslahat: sozlamalarda kompaniya brifingini to‘ldiring.'}
              </p>
              <div className="stack" style={{ gap: 8, width: 'min(560px, 100%)' }}>
                {EXAMPLES.map((ex) => (
                  <button key={ex} className="card preset" style={{ fontWeight: 500 }} onClick={() => setText(ex)}>
                    <Icon name="sparkle" size={14} className="faint" /> {ex}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            visible.map((e) => <Item key={'id' in e ? e.id : `${e.type}-${e.at}-${'agentId' in e ? e.agentId : ''}`} e={e} byId={byId} nameOf={nameOf} answered={s.answered} project={project} active={running} />)
          )}
          {running && !visible.some((e) => e.type === 'approval' && !s.answered.has(e.id)) && <Typing working={project.agents.filter((a) => s.status.get(a.id) === 'working')} />}
        </div>

        {!viewing && (
          <div className="composer">
            <div className="composer-box">
              <textarea
                rows={1}
                value={text}
                placeholder={canContinue ? `${focus ? nameOf(focus) : ceo?.name}ga yozing…` : 'Maqsadni yozing: nima qilinishi kerak, natija qanday bo‘lishi kerak…'}
                onChange={(e) => {
                  setText(e.target.value)
                  e.target.style.height = 'auto'
                  e.target.style.height = `${e.target.scrollHeight}px`
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void send()
                  }
                }}
              />
              <button className="btn primary" onClick={send} disabled={!text.trim() || busy}>
                {canContinue ? <><Icon name="send" size={15} /> Yuborish</> : <><Icon name="play" size={14} /> Boshlash</>}
              </button>
            </div>
            <div className="composer-hint">
              <span>Enter — yuborish · Shift+Enter — yangi qator</span>
              <span className="spacer" />
              <span>{project.approval === 'ask' ? 'Terminal buyruqlari sizdan so‘raladi' : 'Terminal buyruqlari avtomatik'}</span>
            </div>
          </div>
        )}
      </section>

      {history && (
        <Modal title="Ishlar tarixi" onClose={() => setHistory(null)} width={640}>
          {history.length ? (
            <div className="card" style={{ boxShadow: 'none' }}>
              {history.map((r) => (
                <div
                  key={r.id}
                  className="history-row"
                  onClick={async () => {
                    const evs = await window.office.readRun(project.id, r.id)
                    if (r.id === live?.runId) setViewing(null)
                    else setViewing({ run: r, events: evs })
                    setFresh(false)
                    setHistory(null)
                  }}
                >
                  <Icon name="history" className="faint" />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.goal}</div>
                    <div className="faint small">{dateTime(r.startedAt)}</div>
                  </div>
                  <span className={`badge ${r.state === 'done' ? 'accent' : r.state === 'running' ? 'ok' : r.state === 'stopped' ? 'danger' : ''}`}>{{ running: 'Ishlamoqda', done: 'Tugadi', stopped: 'To‘xtatildi', error: 'Xato' }[r.state]}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted">Hali ish bo‘lmagan.</p>
          )}
        </Modal>
      )}
    </div>
  )
}

function Typing({ working }: { working: Agent[] }) {
  if (!working.length) return null
  return (
    <div className="activity" style={{ paddingTop: 8 }}>
      <span className="dot working" />
      {working.map((a) => a.name).join(', ')} ishlamoqda…
    </div>
  )
}

function Item({ e, byId, nameOf, answered, project, active }: { e: OfficeEvent; byId: Map<string, Agent>; nameOf(id: string): string; answered: Set<string>; project: Project; active: boolean }) {
  if (e.type === 'message') {
    if (e.from === USER) {
      return (
        <div className="msg owner">
          <div className="bubble">
            <div className="small" style={{ opacity: 0.8, marginBottom: 2 }}>Siz → {e.to.map(nameOf).join(', ')}</div>
            <Markdown text={e.text} />
          </div>
        </div>
      )
    }
    if (e.from === SYSTEM) {
      return (
        <div className="msg system">
          <div className="avatar" style={{ width: 32, height: 32, background: 'var(--danger-soft)', color: 'var(--danger)' }}><Icon name="shield" size={15} /></div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="msg-head"><span className="msg-name">Tizim</span><span className="msg-time">{clock(e.at)}</span></div>
            <div className="msg-body">{e.text}</div>
          </div>
        </div>
      )
    }
    const a = byId.get(e.from)
    const report = e.to.includes(USER) && a && !a.reportsTo
    return (
      <div className={`msg ${report ? 'report' : ''}`}>
        <Avatar name={a?.name ?? '?'} seed={a?.id} size={32} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="msg-head">
            <span className="msg-name">{a?.name ?? 'Sobiq xodim'}</span>
            {a && <span className="faint small">{a.title}</span>}
            {a && <Dept name={a.department} />}
            <span className="msg-to">→ {e.to.map(nameOf).join(', ')}</span>
            <span className="msg-time">{clock(e.at)}</span>
          </div>
          <div className="msg-body">
            {report && <div className="row small" style={{ color: 'var(--ok)', fontWeight: 650, marginBottom: 6 }}><Icon name="check" size={14} /> Sizga hisobot</div>}
            <Markdown text={e.text} />
          </div>
        </div>
      </div>
    )
  }
  if (e.type === 'tool') {
    return (
      <div className="activity" title={e.summary}>
        <Icon name={TOOL_ICON[e.name] ?? 'zap'} size={13} />
        <span>{nameOf(e.agentId)} {TOOL_VERB[e.name] ?? e.name}</span>
        {e.summary && <span className="mono">{e.summary}</span>}
        {!e.ok && <span className="badge danger" style={{ height: 18 }}>xato</span>}
      </div>
    )
  }
  if (e.type === 'approval') {
    const done = answered.has(e.id) || !active
    return (
      <div className="approval" style={done ? { opacity: 0.6 } : undefined}>
        <div className="row small" style={{ fontWeight: 600 }}>
          <Icon name="terminal" size={15} /> {nameOf(e.agentId)} buyruq ishga tushirmoqchi
          <span className="faint" style={{ fontWeight: 400 }} title={project.workspaceDir}>· {project.workspaceDir.split(/[\\/]/).filter(Boolean).pop()}</span>
        </div>
        <pre>{e.command}</pre>
        {!done && (
          <div className="row">
            <button className="btn primary sm" onClick={() => window.office.answer(project.id, e.id, true)}><Icon name="check" size={13} /> Ruxsat berish</button>
            <button className="btn sm" onClick={() => window.office.answer(project.id, e.id, false)}>Rad etish</button>
          </div>
        )}
      </div>
    )
  }
  if (e.type === 'run' && e.state !== 'running') {
    return <div className="divider">{e.reason ?? (e.state === 'done' ? 'Ish tugadi' : 'To‘xtatildi')}</div>
  }
  return null
}
