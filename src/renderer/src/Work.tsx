import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { SYSTEM, USER, type Agent, type AgentStatus, type OfficeEvent, type Project, type Provider, type RunSummary } from '../../shared/types'
import type { Live } from './App'
import { errText, getLang, useT } from './i18n'
import { Avatar, dateTime, Empty, Icon, Sheet, usd } from './ui'
import { BudgetPill, RaiseBudget } from './work/Budget'
import { ChangesSheet, useRunChanges } from './work/Changes'
import { Composer } from './work/Composer'
import { FeedItem, type FeedCtx } from './work/FeedItem'
import { HistoryModal } from './work/History'
import { LiveReplies, useDeltas } from './work/Live'
import { createSpeaker } from './work/speech'
import { approvalShortcut, buildItems, errCode, forMember, isEditable, summarize, type Item } from './work/logic'

interface Props {
  project: Project
  providers: Provider[]
  live?: Live
  notify(t: string): void
  goTeam(): void
  onSave(p: Project): Promise<void>
}

type Panel = { kind: 'person'; id: string } | { kind: 'changes' } | null
const TALK_KEY = 'ai-office.talk'

/** localStorage can be unavailable; Talk being remembered is only a convenience. */
function stored(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // not remembered; still applies until the app closes
  }
}
const NO_DELTAS: Record<string, string> = {}

export default function Work({ project, providers, live, notify, goTeam, onSave }: Props) {
  const t = useT()
  const projectId = project.id
  const [text, setText] = useState('')
  /** Workspace paths of the files attached to the message being written. */
  const [files, setFiles] = useState<string[]>([])
  const [talk, setTalk] = useState(() => stored(TALK_KEY) === '1')
  const [speaker] = useState(() => createSpeaker(() => window.office.getSettings().then((s) => s.voice), getLang))
  useEffect(() => speaker.onError((e) => notify(errText(e))), [speaker, notify])
  const speaking = useSyncExternalStore(speaker.subscribe, speaker.speaking)
  useEffect(() => () => speaker.stop(), [speaker])
  const [focus, setFocus] = useState<string | null>(null)
  const [panel, setPanel] = useState<Panel>(null)
  const [fresh, setFresh] = useState(false)
  const [viewing, setViewing] = useState<{ run: RunSummary; events: OfficeEvent[] } | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  // Approvals and plans answered here, until the main process confirms them.
  const [answered, setAnswered] = useState<ReadonlySet<string>>(() => new Set())
  // A message the budget refused; it is sent again once the budget is raised.
  const [refused, setRefused] = useState<{ text: string; to?: string } | null>(null)
  const feedRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  // App hands a new onSave on every render; rows get a stable one so they can skip re-rendering.
  const saveRef = useRef(onSave)
  useEffect(() => {
    saveRef.current = onSave
  })
  const deltas = useDeltas(projectId)

  const events = useMemo(() => viewing?.events ?? live?.events ?? [], [viewing, live])
  const byId = useMemo(() => new Map(project.agents.map((a) => [a.id, a])), [project.agents])
  const ceo = project.agents.find((a) => !a.reportsTo)
  const s = useMemo(() => summarize(events), [events])
  const allItems = useMemo(() => buildItems(events), [events])
  const items = useMemo(() => forMember(allItems, focus), [allItems, focus])
  const liveRunning = useMemo(() => {
    const last = live?.events.findLast((e) => e.type === 'run')
    return last?.type === 'run' && last.state === 'running'
  }, [live])

  const showStart = !viewing && (fresh || !live)
  const canContinue = !showStart && !viewing
  const running = !viewing && s.lastRun?.state === 'running'
  const waitingPlan = !viewing && s.lastRun?.state === 'done' && s.lastRun.reason === 'plan'
  const runId = viewing?.run.id ?? (showStart ? null : (live?.runId ?? null))
  const changes = useRunChanges(projectId, runId, running, s.writes, s.lastRun && s.lastRun.state !== 'running' ? s.lastRun.at : 0)
  const liveDeltas = running ? deltas : NO_DELTAS

  const nameOf = useCallback((id: string) => (id === USER ? t.work.you : id === SYSTEM ? t.work.system : (byId.get(id)?.name ?? t.work.formerMember)), [t, byId])
  const save = useCallback((p: Project) => saveRef.current(p), [])

  const onAnswer = useCallback(
    async (id: string, ok: boolean, always?: boolean) => {
      setAnswered((a) => new Set(a).add(id))
      try {
        await window.office.answer(projectId, id, ok, always)
      } catch (e) {
        notify(errText(e))
        setAnswered((a) => new Set([...a].filter((x) => x !== id)))
      }
    },
    [projectId, notify]
  )

  const onPlan = useCallback(
    async (id: string, approved: boolean, feedback?: string) => {
      setAnswered((a) => new Set(a).add(id))
      try {
        await window.office.answerPlan(projectId, id, approved, feedback)
        return true
      } catch (e) {
        notify(errText(e))
        setAnswered((a) => new Set([...a].filter((x) => x !== id)))
        return false
      }
    },
    [projectId, notify]
  )

  const ctx = useMemo<FeedCtx>(
    () => ({ project, providers, byId, nameOf, running, viewing: viewing !== null, onSave: save, notify, onAnswer, onPlan }),
    [project, providers, byId, nameOf, running, viewing, save, notify, onAnswer, onPlan]
  )

  const pending = running ? allItems.filter((i): i is Extract<Item, { kind: 'approval' }> => i.kind === 'approval' && !i.done && !answered.has(i.e.id)) : []
  // Only for a card the owner can see: not from the new-task screen.
  const only = pending.length === 1 && !showStart ? pending[0].e.id : null

  useEffect(() => {
    if (!only || historyOpen) return
    const onKey = (e: KeyboardEvent) => {
      const act = approvalShortcut(e)
      if (!act || isEditable(document.activeElement)) return
      e.preventDefault()
      void onAnswer(only, act === 'allow')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [only, historyOpen, onAnswer])

  const spoken = useRef<Set<string> | null>(null)
  useEffect(() => {
    const toOwner = (live?.events ?? []).filter((e): e is Extract<OfficeEvent, { type: 'message' }> => e.type === 'message' && e.from !== USER && e.from !== SYSTEM && e.to.includes(USER))
    if (!talk || spoken.current === null) {
      spoken.current = new Set(toOwner.map((e) => e.id))
      return
    }
    for (const e of toOwner) {
      if (spoken.current.has(e.id)) continue
      spoken.current.add(e.id)
      speaker.say(e.text)
    }
  }, [live?.events, talk, speaker])

  useEffect(() => {
    const el = feedRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [items.length, events.length, liveDeltas])

  const target = focus && focus !== ceo?.id ? byId.get(focus) : ceo
  const overBudget = project.budgetUsd > 0 && s.total >= project.budgetUsd

  const attach = async (paths?: string[]) => {
    try {
      const added = await window.office.attach(projectId, paths)
      setFiles((cur) => [...cur, ...added.filter((p) => !cur.includes(p))])
    } catch (e) {
      notify(errText(e, t))
    }
  }

  /** Speech becomes text in the message box, to check before sending. */
  const listen = async (audio: Uint8Array) => {
    try {
      const said = await window.office.transcribe(audio)
      if (!said) return notify(t.media.heardNothing)
      // In Talk, speaking is sending; otherwise the words wait in the box to be checked.
      if (talk) await send(said)
      else setText((cur) => (cur.trim() ? `${cur.trimEnd()} ${said}` : said))
    } catch (e) {
      notify(errText(e, t))
    }
  }

  const canRecord = async () => {
    // Nobody talks over the reply being read.
    speaker.stop()
    try {
      if ((await window.office.getSettings()).voice.sttProvider) return true
      notify(errText(new Error('E_NO_STT'), t))
    } catch (e) {
      notify(errText(e, t))
    }
    return false
  }

  /** spoken: words from the microphone in Talk, sent instead of the box's text (which stays as it is). */
  const send = async (spoken?: string) => {
    // The paths are for the team, so this line stays in English like the rest of their instructions.
    const msg = [(spoken ?? text).trim(), files.length ? `Attached files: ${files.join(', ')}` : ''].filter(Boolean).join('\n\n')
    if (!msg || busy) return
    const to = canContinue && target && target.id !== ceo?.id ? target.id : undefined
    setBusy(true)
    try {
      if (canContinue) await window.office.post(projectId, msg, to)
      else {
        await window.office.start(projectId, msg)
        setFresh(false)
        setViewing(null)
        setFocus(null)
      }
      setRefused(null)
      if (spoken === undefined) setText('')
      setFiles([])
      stick.current = true
    } catch (e) {
      if (canContinue && errCode(e) === 'E_BUDGET_SPENT') {
        setRefused({ text: msg, to })
        // The inline control explains it when the numbers agree; otherwise say what main said.
        if (!overBudget) notify(errText(e, t))
      } else notify(errText(e, t))
    } finally {
      setBusy(false)
    }
  }

  const raise = async (budgetUsd: number) => {
    try {
      await onSave({ ...project, budgetUsd })
    } catch (e) {
      notify(errText(e, t))
      return
    }
    const p = refused
    if (!p) return notify(t.run.budgetSaved)
    try {
      await window.office.post(projectId, p.text, p.to)
      setRefused(null)
      setText((cur) => (cur.trim() === p.text ? '' : cur))
      stick.current = true
    } catch (e) {
      if (errCode(e) !== 'E_BUDGET_SPENT') setRefused(null)
      notify(errText(e, t))
    }
  }

  const openRun = async (r: RunSummary) => {
    try {
      const run = r.id === live?.runId ? null : { run: r, events: await window.office.readRun(projectId, r.id) }
      setViewing(run)
      setFresh(false)
      setHistoryOpen(false)
      setPanel(null)
      stick.current = true
    } catch (e) {
      notify(errText(e, t))
    }
  }

  const runAgain = (goal: string) => {
    setHistoryOpen(false)
    setViewing(null)
    setFocus(null)
    setPanel(null)
    setFresh(true)
    setText(goal)
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
      onSend={() => void send()}
      busy={busy}
      autoFocus={fresh}
      placeholder={canContinue ? t.work.placeholderTo(target?.name ?? '') : t.work.placeholderGoal}
      hint={project.approval === 'ask' ? t.work.approvalAsk : t.work.approvalAuto}
      files={files}
      onAttach={(paths) => void attach(paths)}
      onRemoveFile={(p) => setFiles((cur) => cur.filter((x) => x !== p))}
      onAudio={listen}
      canRecord={canRecord}
      onError={notify}
    />
  )

  const attention = running && ([...s.status.values()].includes('blocked') || pending.length > 0)
  const state = s.lastRun?.state
  const stateLabel = viewing
    ? t.work.viewing
    : attention
      ? t.work.attention
      : running
        ? t.work.running
        : showStart
          ? t.work.idle
          : waitingPlan
            ? t.run.waitingPlan
            : state === 'stopped' || state === 'error'
              ? t.work.stopped
              : state === 'done'
                ? t.work.done
                : t.work.idle
  const dot = attention ? 'warn' : running ? 'live' : showStart ? '' : waitingPlan ? 'wait' : state === 'done' ? 'ok' : ''
  const shown = project.agents.slice(0, 7)
  const changesOpen = panel?.kind === 'changes'
  const person = panel?.kind === 'person' ? byId.get(panel.id) : undefined
  const showRaise = canContinue && project.budgetUsd > 0 && (refused !== null || (s.lastRun?.reason === 'budget' && overBudget))

  return (
    <div className="work">
      <div className="workbar">
        <span className="status">
          <span className={`dot ${dot}`} />
          {stateLabel}
        </span>
        {!showStart && (
          <span className="goal ellipsis" title={s.goal}>
            {viewing ? `${dateTime(viewing.run.startedAt)} · ${s.goal}` : s.goal}
          </span>
        )}
        {focus && (
          <span className="filter-chip">
            {nameOf(focus)}
            <button onClick={() => setFocus(null)} aria-label={t.common.close}>
              <Icon name="x" size={12} />
            </button>
          </span>
        )}
        <span className="spacer" />
        <div className="stack-avatars">
          {shown.map((a) => (
            <button key={a.id} onClick={() => setPanel({ kind: 'person', id: a.id })} title={`${a.name} · ${a.title}`} aria-label={`${a.name} · ${a.title}`}>
              <Avatar name={a.name} seed={a.id} size={26} status={running ? s.status.get(a.id) : undefined} />
            </button>
          ))}
          {project.agents.length > shown.length && <span className="stack-more">+{project.agents.length - shown.length}</span>}
        </div>
        {!showStart && <BudgetPill total={s.total} toks={s.toks} unpriced={s.unpriced} budget={project.budgetUsd} />}
        {running && (
          <button className="btn sm" onClick={() => window.office.stop(projectId).catch((e: unknown) => notify(errText(e, t)))}>
            <Icon name="stop" size={12} /> {t.work.stop}
          </button>
        )}
        {runId && (
          <button
            type="button"
            className={`btn sm changes-btn ${changesOpen ? 'on' : ''}`}
            aria-label={t.run.changesAria(changes.count)}
            aria-expanded={changesOpen}
            onClick={() => {
              if (changesOpen) return setPanel(null)
              setPanel({ kind: 'changes' })
              changes.refresh()
            }}
          >
            <Icon name="diff" size={13} /> {t.run.changes}
            {changes.count !== null && changes.count > 0 && <span className="count">{changes.count}</span>}
          </button>
        )}
        {(viewing || (fresh && live)) && (
          <button
            className="btn sm"
            onClick={() => {
              setViewing(null)
              setFresh(false)
              stick.current = true
            }}
          >
            {t.work.backToCurrent}
          </button>
        )}
        {!viewing && !showStart && !running && (
          <button className="btn sm" onClick={() => setFresh(true)}>
            <Icon name="plus" size={13} /> {t.work.newTask}
          </button>
        )}
        <button
          className={`btn sm talk ${talk ? 'on' : ''} ${speaking ? 'speaking' : ''}`}
          aria-pressed={talk}
          title={speaking ? t.media.stopSpeaking : t.media.talkHint(ceo?.name ?? '')}
          onClick={() => {
            if (speaking) return speaker.stop()
            setTalk(!talk)
            store(TALK_KEY, talk ? '0' : '1')
          }}
        >
          <Icon name={speaking ? 'stop' : 'speaker'} size={13} /> {speaking ? t.media.stopSpeaking : t.media.talk}
        </button>
        <button className="btn quiet icon sm" title={t.work.history} aria-label={t.work.history} onClick={() => setHistoryOpen(true)}>
          <Icon name="history" />
        </button>
      </div>

      {showStart ? (
        <div className="feed">
          <div className="start">
            <div className="stack-avatars">
              {project.agents.slice(0, 5).map((a) => (
                <Avatar key={a.id} name={a.name} seed={a.id} size={36} />
              ))}
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
                <FeedItem
                  key={i.key}
                  item={i}
                  ctx={ctx}
                  sent={(i.kind === 'approval' || i.kind === 'plan') && answered.has(i.e.id)}
                  shortcut={i.kind === 'approval' && i.e.id === only}
                />
              ))}
              {running && <LiveReplies agents={focus ? project.agents.filter((a) => a.id === focus) : project.agents} status={s.status} since={s.since} deltas={liveDeltas} />}
            </div>
          </div>
          {!viewing && (
            <div className="composer">
              {showRaise && <RaiseBudget key={project.budgetUsd} budget={project.budgetUsd} spent={s.total} pending={refused !== null} onRaise={raise} />}
              {composer}
            </div>
          )}
        </>
      )}

      {person && (
        <PersonSheet
          agent={person}
          provider={providers.find((p) => p.id === person.providerId)?.name ?? ''}
          manager={nameOf(person.reportsTo ?? USER)}
          status={(running && s.status.get(person.id)) || 'idle'}
          cost={s.cost.get(person.id) ?? 0}
          focused={focus === person.id}
          onFocus={(on) => setFocus(on ? person.id : null)}
          onClose={() => setPanel(null)}
        />
      )}

      {changesOpen && runId && (
        <ChangesSheet
          projectId={projectId}
          runId={runId}
          running={liveRunning}
          past={viewing !== null}
          goal={s.goal}
          data={changes.data}
          onRefresh={changes.refresh}
          onClose={() => setPanel(null)}
          notify={notify}
        />
      )}

      {historyOpen && (
        <HistoryModal
          projectId={projectId}
          currentRunId={live?.runId ?? null}
          onOpen={(r) => void openRun(r)}
          onRunAgain={runAgain}
          onDeleted={(id) => {
            if (viewing?.run.id === id) setViewing(null)
          }}
          onClose={() => setHistoryOpen(false)}
          notify={notify}
        />
      )}
    </div>
  )
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
        <div className="muted">
          {agent.title}
          {agent.department ? ` · ${agent.department}` : ''}
        </div>
      </div>
      <dl className="facts">
        <dt>{t.team.manager}</dt>
        <dd>{agent.reportsTo ? manager : t.work.you}</dd>
        <dt>{t.team.provider}</dt>
        <dd>{provider || '—'}</dd>
        <dt>{t.team.model}</dt>
        <dd className="mono">{agent.model}</dd>
        <dt>{t.work.spent}</dt>
        <dd className="num">{usd(cost)}</dd>
        <dt>{t.work.statusLabel}</dt>
        <dd>{t.work.status[status]}</dd>
      </dl>
      <div className="stack tight" style={{ marginTop: 24 }}>
        <button
          className={`btn ${focused ? '' : 'primary'}`}
          onClick={() => {
            onFocus(!focused)
            onClose()
          }}
        >
          <Icon name={focused ? 'x' : 'chat'} size={14} />
          {focused ? t.common.close : t.work.messageThem(agent.name)}
        </button>
        <p className="faint small" style={{ textAlign: 'center' }}>{t.work.onlyTheirs}</p>
      </div>
    </Sheet>
  )
}
