import { useEffect, useMemo, useRef, useState } from 'react'
import { SYSTEM, USER, type Agent, type AgentStatus, type OfficeEvent, type Project, type Provider, type RunSummary } from '../../shared/types'
import type { Live } from './App'
import { errText, useT } from './i18n'
import { Avatar, baseName, clock, dateTime, Empty, Icon, Markdown, Modal, Sheet, tokens, usd, type IconName } from './ui'

const TOOL_ICON: Record<string, IconName> = {
  list_files: 'folder',
  read_file: 'eye',
  search_files: 'search',
  write_file: 'file',
  edit_file: 'edit',
  run_command: 'terminal',
  web_fetch: 'globe',
  remember: 'bookmark',
  use_skill: 'book',
  read_skill_file: 'book'
}

type ToolEv = Extract<OfficeEvent, { type: 'tool' }>
type Item =
  | { kind: 'message'; e: Extract<OfficeEvent, { type: 'message' }> }
  | { kind: 'tools'; id: string; agentId: string; list: ToolEv[] }
  | { kind: 'approval'; e: Extract<OfficeEvent, { type: 'approval' }>; answer?: boolean }
  | { kind: 'end'; e: Extract<OfficeEvent, { type: 'run' }> }

interface Props {
  project: Project
  providers: Provider[]
  live?: Live
  notify(t: string): void
  goTeam(): void
}

export default function Work({ project, providers, live, notify, goTeam }: Props) {
  const t = useT()
  const [text, setText] = useState('')
  const [focus, setFocus] = useState<string | null>(null)
  const [person, setPerson] = useState<string | null>(null)
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
    let total = 0
    let toks = 0
    let state: string | null = null
    for (const e of events) {
      if (e.type === 'status') status.set(e.agentId, e.status)
      if (e.type === 'cost') {
        cost.set(e.agentId, (cost.get(e.agentId) ?? 0) + e.usd)
        total += e.usd
        toks += e.inTok + e.outTok
      }
      if (e.type === 'run') state = e.state
    }
    const goal = events.find((e) => e.type === 'message' && e.from === USER)
    return { status, cost, total, toks, state, goal: goal?.type === 'message' ? goal.text : '' }
  }, [events])

  const items = useMemo(() => {
    const out: Item[] = []
    const answers = new Map<string, boolean>()
    for (const e of events) if (e.type === 'approval_done') answers.set(e.id, e.approved)
    for (const e of events) {
      if (e.type === 'message') out.push({ kind: 'message', e })
      else if (e.type === 'tool') {
        const last = out.at(-1)
        if (last?.kind === 'tools' && last.agentId === e.agentId) last.list.push(e)
        else out.push({ kind: 'tools', id: e.id, agentId: e.agentId, list: [e] })
      } else if (e.type === 'approval') out.push({ kind: 'approval', e, answer: answers.get(e.id) })
      else if (e.type === 'run' && e.state !== 'running') out.push({ kind: 'end', e })
    }
    if (!focus) return out
    return out.filter((i) =>
      i.kind === 'message' ? i.e.from === focus || i.e.to.includes(focus) : i.kind === 'tools' ? i.agentId === focus : i.kind === 'approval' ? i.e.agentId === focus : true
    )
  }, [events, focus])

  const running = !viewing && s.state === 'running'
  const showStart = !viewing && (fresh || !live)
  const canContinue = !showStart && !viewing

  useEffect(() => {
    const el = feedRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [items.length])

  const nameOf = (id: string) => (id === USER ? t.work.you : id === SYSTEM ? t.work.system : (byId.get(id)?.name ?? t.work.formerMember))
  const working = project.agents.filter((a) => s.status.get(a.id) === 'working')
  const target = focus && focus !== ceo?.id ? byId.get(focus) : ceo

  const send = async () => {
    const msg = text.trim()
    if (!msg || busy) return
    setBusy(true)
    try {
      if (canContinue) await window.office.post(project.id, msg, target && target.id !== ceo?.id ? target.id : undefined)
      else {
        await window.office.start(project.id, msg)
        setFresh(false)
        setViewing(null)
        setFocus(null)
      }
      setText('')
      stick.current = true
    } catch (e) {
      notify(errText(e, t))
    } finally {
      setBusy(false)
    }
  }

  if (!project.agents.length) {
    return (
      <Empty icon="users" title={t.work.emptyTeam}>
        <button className="btn primary" onClick={goTeam}>{t.work.buildTeam}</button>
      </Empty>
    )
  }

  const composer = (
    <Composer
      value={text}
      onChange={setText}
      onSend={send}
      busy={busy}
      placeholder={canContinue ? t.work.placeholderTo(target?.name ?? '') : t.work.placeholderGoal}
      hint={project.approval === 'ask' ? t.work.approvalAsk : t.work.approvalAuto}
    />
  )

  const stateLabel = viewing ? t.work.viewing : running ? t.work.running : s.state === 'stopped' ? t.work.stopped : s.state === 'done' ? t.work.done : t.work.idle
  const shown = project.agents.slice(0, 7)

  return (
    <div className="work">
      <div className="workbar">
        <span className="status">
          <span className={`dot ${running ? 'live' : s.state === 'done' ? 'ok' : ''}`} />
          {stateLabel}
        </span>
        {!showStart && <span className="goal ellipsis" title={s.goal}>{viewing ? `${dateTime(viewing.run.startedAt)} · ${s.goal}` : s.goal}</span>}
        {focus && (
          <span className="filter-chip">
            {nameOf(focus)}
            <button onClick={() => setFocus(null)} aria-label={t.common.close}><Icon name="x" size={12} /></button>
          </span>
        )}
        <span className="spacer" />
        <div className="stack-avatars">
          {shown.map((a) => (
            <button key={a.id} onClick={() => setPerson(a.id)} title={`${a.name} · ${a.title}`}>
              <Avatar name={a.name} seed={a.id} size={26} status={showStart ? undefined : s.status.get(a.id)} />
            </button>
          ))}
          {project.agents.length > shown.length && <span className="stack-more">+{project.agents.length - shown.length}</span>}
        </div>
        {!showStart && (
          <span className="pill" title={`${tokens(s.toks)} ${t.work.tokens}`}>
            {usd(s.total)}
            {project.budgetUsd > 0 && <span className="faint">{t.work.budget(project.budgetUsd)}</span>}
          </span>
        )}
        {running && (
          <button className="btn sm" onClick={() => window.office.stop(project.id)}>
            <Icon name="stop" size={12} /> {t.work.stop}
          </button>
        )}
        {viewing && <button className="btn sm" onClick={() => setViewing(null)}>{t.work.backToCurrent}</button>}
        {!viewing && !showStart && !running && (
          <button className="btn sm" onClick={() => setFresh(true)}>
            <Icon name="plus" size={13} /> {t.work.newTask}
          </button>
        )}
        <button className="btn quiet icon sm" title={t.work.history} aria-label={t.work.history} onClick={async () => setHistory(await window.office.listRuns(project.id))}>
          <Icon name="history" />
        </button>
      </div>

      {showStart ? (
        <div className="feed">
          <div className="start">
            <div className="stack-avatars">
              {project.agents.slice(0, 5).map((a) => <Avatar key={a.id} name={a.name} seed={a.id} size={36} />)}
            </div>
            <h2>{t.work.askTitle}</h2>
            <p>{t.work.ready(ceo?.name ?? '', project.agents.length)}</p>
            {composer}
            <div className="suggestions">
              {t.work.examples.map((ex) => (
                <button key={ex} className="suggestion" onClick={() => setText(ex)}>
                  <Icon name="spark" size={14} />
                  {ex}
                </button>
              ))}
            </div>
            {!project.briefing.trim() && <p className="tip">{t.work.briefingTip}</p>}
          </div>
        </div>
      ) : (
        <>
          <div
            className="feed"
            ref={feedRef}
            onScroll={(e) => {
              const el = e.currentTarget
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
            }}
          >
            <div className="feed-inner">
              {items.map((i) => (
                <FeedItem key={i.kind === 'tools' ? i.id : i.kind === 'end' ? `end-${i.e.at}` : i.e.id} item={i} byId={byId} nameOf={nameOf} project={project} active={running} />
              ))}
              {running && working.length > 0 && (
                <div className="typing">
                  <span className="dot live" />
                  {t.work.working(working.map((a) => a.name).join(', '))}
                </div>
              )}
            </div>
          </div>
          {!viewing && <div className="composer">{composer}</div>}
        </>
      )}

      {person && byId.get(person) && (
        <PersonSheet
          agent={byId.get(person)!}
          provider={providers.find((p) => p.id === byId.get(person)!.providerId)?.name ?? ''}
          manager={nameOf(byId.get(person)!.reportsTo ?? USER)}
          status={s.status.get(person) ?? 'idle'}
          cost={s.cost.get(person) ?? 0}
          focused={focus === person}
          onFocus={(on) => setFocus(on ? person : null)}
          onClose={() => setPerson(null)}
        />
      )}

      {history && (
        <Modal title={t.work.history} onClose={() => setHistory(null)} width={620}>
          {history.length ? (
            <div className="list">
              {history.map((r) => (
                <div
                  key={r.id}
                  className="list-row click"
                  onClick={async () => {
                    const evs = await window.office.readRun(project.id, r.id)
                    setViewing(r.id === live?.runId ? null : { run: r, events: evs })
                    setFresh(false)
                    setHistory(null)
                  }}
                >
                  <div className="spacer ellipsis">
                    <div className="ellipsis" style={{ fontWeight: 550 }}>{r.goal}</div>
                    <div className="faint small">{dateTime(r.startedAt)}</div>
                  </div>
                  <span className={`tag ${r.state === 'running' ? 'accent' : r.state === 'stopped' ? 'danger' : ''}`}>
                    {{ running: t.work.running, done: t.work.done, stopped: t.work.stopped, error: t.work.stopped }[r.state]}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted">{t.work.noHistory}</p>
          )}
        </Modal>
      )}
    </div>
  )
}

function Composer({ value, onChange, onSend, busy, placeholder, hint }: { value: string; onChange(v: string): void; onSend(): void; busy: boolean; placeholder: string; hint: string }) {
  const t = useT()
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [value])
  return (
    <div className="composer-inner">
      <div className="composer-box">
        <textarea
          ref={ref}
          rows={1}
          value={value}
          placeholder={placeholder}
          aria-label={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              onSend()
            }
          }}
        />
        <button className="send" onClick={onSend} disabled={!value.trim() || busy} aria-label={t.work.send}>
          <Icon name="arrowUp" size={17} />
        </button>
      </div>
      <div className="composer-hint">
        <span>{t.work.hint}</span>
        <span className="spacer" />
        <span>{hint}</span>
      </div>
    </div>
  )
}

function FeedItem({ item, byId, nameOf, project, active }: { item: Item; byId: Map<string, Agent>; nameOf(id: string): string; project: Project; active: boolean }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)

  if (item.kind === 'end') {
    const r = t.work.reasons[item.e.reason ?? '']
    return <div className="divider">{typeof r === 'function' ? r(item.e.usd ?? 0) : (r ?? t.work.done)}</div>
  }

  if (item.kind === 'tools') {
    const verb = (n: string) => t.work.tools[n] ?? t.work.usedTool
    const one = item.list.length === 1 ? item.list[0] : null
    return (
      <div className={`activity ${open ? 'open' : ''}`}>
        <button onClick={() => !one && setOpen(!open)} aria-expanded={one ? undefined : open}>
          {one ? <Icon name={TOOL_ICON[one.name] ?? 'plug'} size={13} /> : <Icon name="chevron" size={12} className="chev" />}
          <span className="ellipsis">
            {nameOf(item.agentId)} {one ? verb(one.name) : `· ${t.work.actions(item.list.length)}`}
            {one?.summary && <span className="mono"> {one.summary}</span>}
          </span>
          {item.list.some((x) => !x.ok) && <span className="tag danger">{t.work.error}</span>}
        </button>
        {open && !one && (
          <ul>
            {item.list.map((x) => (
              <li key={x.id} title={x.summary}>
                <Icon name={TOOL_ICON[x.name] ?? 'plug'} size={13} />
                <span>{verb(x.name)}</span>
                <span className="mono ellipsis">{x.summary}</span>
                {!x.ok && <span className="tag danger">{t.work.error}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    )
  }

  if (item.kind === 'approval') {
    const e = item.e
    const done = item.answer !== undefined || !active
    return (
      <div className="card approval">
        <div className="card-head">
          <Icon name={e.kind === 'mcp' ? 'plug' : 'terminal'} size={14} />
          {e.kind === 'mcp' ? t.work.approvalMcp(nameOf(e.agentId)) : t.work.approvalCommand(nameOf(e.agentId))}
          <span className="spacer" />
          <span className="faint small" title={project.workspaceDir} style={{ fontWeight: 400 }}>{baseName(project.workspaceDir)}</span>
        </div>
        <div className="card-body">
          <pre>{e.command}</pre>
          {done ? (
            item.answer !== undefined && (
              <div className="row small faint">
                <Icon name={item.answer ? 'check' : 'x'} size={13} />
                {item.answer ? t.work.allowed : t.work.denied}
              </div>
            )
          ) : (
            <div className="row">
              <button className="btn primary sm" onClick={() => window.office.answer(project.id, e.id, true)}>
                <Icon name="check" size={13} /> {t.work.allow}
              </button>
              <button className="btn sm" onClick={() => window.office.answer(project.id, e.id, false)}>{t.work.deny}</button>
            </div>
          )}
        </div>
      </div>
    )
  }

  const e = item.e
  if (e.from === USER) {
    return (
      <div className="msg owner">
        <div className="bubble">
          <div className="to">{t.work.you} → {e.to.map(nameOf).join(', ')}</div>
          <Markdown text={e.text} />
        </div>
      </div>
    )
  }
  if (e.from === SYSTEM) {
    return (
      <div className="msg system">
        <span className="avatar" style={{ width: 28, height: 28, background: 'var(--danger-soft)', color: 'var(--danger)' }}>
          <Icon name="alert" size={14} />
        </span>
        <div className="msg-main">
          <div className="msg-head"><span className="msg-name">{t.work.system}</span><span className="msg-time">{clock(e.at)}</span></div>
          <div className="msg-body">{systemText(e.text)}</div>
        </div>
      </div>
    )
  }
  const a = byId.get(e.from)
  const report = e.to.includes(USER) && a && !a.reportsTo
  return (
    <div className="msg">
      <Avatar name={a?.name ?? '?'} seed={a?.id} size={28} />
      <div className="msg-main">
        <div className="msg-head">
          <span className="msg-name">{a?.name ?? t.work.formerMember}</span>
          {a && <span className="msg-meta">{a.title}</span>}
          <span className="msg-meta">→ {e.to.map(nameOf).join(', ')}</span>
          <span className="msg-time">{clock(e.at)}</span>
        </div>
        {report ? (
          <div className="card report">
            <div className="card-head">
              <Icon name="check" size={14} /> {t.work.finalReport}
              <span className="spacer" />
              <button
                className="btn quiet sm"
                onClick={async () => {
                  await navigator.clipboard.writeText(e.text)
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1500)
                }}
              >
                <Icon name={copied ? 'check' : 'copy'} size={13} /> {copied ? t.common.copied : t.common.copy}
              </button>
              <button className="btn quiet sm" onClick={() => window.office.openFolder(project.workspaceDir)}>
                <Icon name="folder" size={13} /> {t.work.openFolder}
              </button>
            </div>
            <div className="card-body"><Markdown text={e.text} /></div>
          </div>
        ) : (
          <div className="msg-body"><Markdown text={e.text} /></div>
        )}
      </div>
    </div>
  )
}

/** System lines look like `Name: message`; the message may be an error code from main. */
function systemText(text: string) {
  const i = text.indexOf(': ')
  return i < 0 ? errText(text) : `${text.slice(0, i)}: ${errText(text.slice(i + 2))}`
}

function PersonSheet({ agent, provider, manager, status, cost, focused, onFocus, onClose }: {
  agent: Agent
  provider: string
  manager: string
  status: AgentStatus
  cost: number
  focused: boolean
  onFocus(on: boolean): void
  onClose(): void
}) {
  const t = useT()
  return (
    <Sheet head={<span className="spacer" />} onClose={onClose}>
      <div className="person">
        <Avatar name={agent.name} seed={agent.id} size={64} status={status} />
        <h3>{agent.name}</h3>
        <div className="muted">{agent.title}{agent.department ? ` · ${agent.department}` : ''}</div>
      </div>
      <dl className="facts">
        <dt>{t.team.manager}</dt><dd>{agent.reportsTo ? manager : t.work.you}</dd>
        <dt>{t.team.provider}</dt><dd>{provider || '—'}</dd>
        <dt>{t.team.model}</dt><dd className="mono">{agent.model}</dd>
        <dt>{t.work.spent}</dt><dd className="num">{usd(cost)}</dd>
        <dt>{t.work.statusLabel}</dt><dd>{t.work.status[status]}</dd>
      </dl>
      <div className="stack tight" style={{ marginTop: 24 }}>
        <button className={`btn ${focused ? '' : 'primary'}`} onClick={() => { onFocus(!focused); onClose() }}>
          <Icon name={focused ? 'x' : 'chat'} size={14} />
          {focused ? t.common.close : t.work.messageThem(agent.name)}
        </button>
        <p className="faint small" style={{ textAlign: 'center' }}>{t.work.onlyTheirs}</p>
      </div>
    </Sheet>
  )
}
