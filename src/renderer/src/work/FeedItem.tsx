import { memo, useId, useState } from 'react'
import { SYSTEM, USER, type Agent, type ModelRef, type Project, type Provider } from '../../../shared/types'
import { errText, useT } from '../i18n'
import { Markdown } from '../markdown'
import { ModelInput } from '../Team'
import { Avatar, baseName, clock, Icon, tokens, type IconName } from '../ui'
import { endText, firstFiles, hasShellControl, hostOf, sameItem, systemWarn, type Ev, type Item, type ToolEv } from './logic'
import { DiffView } from './parts'

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
  read_skill_file: 'book',
  propose_plan: 'clipboard'
}

/** What every feed row needs from the view. Kept in one memoized object so rows can skip re-rendering. */
export interface FeedCtx {
  project: Project
  providers: Provider[]
  byId: Map<string, Agent>
  nameOf(id: string): string
  /** The shown run is the live one and it is running. */
  running: boolean
  /** A past run from History is shown. */
  viewing: boolean
  onSave(p: Project): Promise<void>
  notify(text: string): void
  onAnswer(id: string, ok: boolean, always?: boolean): void
  onPlan(id: string, approved: boolean, feedback?: string): Promise<boolean>
}

interface Props {
  item: Item
  ctx: FeedCtx
  /** The owner answered this approval or plan; waiting for the main process to confirm. */
  sent: boolean
  /** Alt+A / Alt+D act on this approval. */
  shortcut: boolean
}

export const FeedItem = memo(function FeedItem({ item, ctx, sent, shortcut }: Props) {
  const t = useT()
  const { nameOf } = ctx
  switch (item.kind) {
    case 'notice': {
      const e = item.e
      return (
        <div className="event-line" role="status">
          <Icon name="clock" size={13} />
          <span>{t.work.notice(nameOf(e.agentId), t.work.kinds[e.kind], Math.round(e.waitMs / 1000), e.attempt, e.of)}</span>
        </div>
      )
    }
    case 'switch': {
      const e = item.e
      return (
        <div className="event-line" title={e.detail}>
          <Icon name="swap" size={13} />
          <span>{t.work.switched(nameOf(e.agentId), modelLabel(e.to, ctx.providers), t.work.kinds[e.kind])}</span>
        </div>
      )
    }
    case 'compact':
      return (
        <div className="event-line" title={t.run.compactAt(tokens(item.e.tokens))}>
          <Icon name="book" size={13} />
          <span>{t.run.compacted(nameOf(item.e.agentId))}</span>
        </div>
      )
    case 'end':
      return <div className="divider">{endText(item.e, t)}</div>
    case 'blocked':
      return <BlockedCard e={item.e} resolved={item.resolved || !ctx.running} ctx={ctx} />
    case 'tools':
      return <ToolActivity list={item.list} who={nameOf(item.agentId)} />
    case 'approval':
      return <ApprovalCard e={item.e} done={item.done} ctx={ctx} sent={sent} shortcut={shortcut} />
    case 'plan':
      return <PlanCard item={item} ctx={ctx} sent={sent} />
    case 'message':
      return <Message e={item.e} ctx={ctx} />
  }
}, (a, b) => a.ctx === b.ctx && a.sent === b.sent && a.shortcut === b.shortcut && sameItem(a.item, b.item))

const modelLabel = (m: ModelRef, providers: Provider[]) => `${providers.find((p) => p.id === m.providerId)?.name ?? '?'} · ${m.model}`

function ToolActivity({ list, who }: { list: ToolEv[]; who: string }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const id = useId()
  if (list.length === 1) {
    return (
      <div className="activity">
        <ToolRow tool={list[0]} who={who} />
      </div>
    )
  }
  return (
    <div className={`activity ${open ? 'open' : ''}`}>
      <button type="button" className="tool-row" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        <Icon name="chevron" size={12} className="chev" />
        <span className="ellipsis">
          {who} · {t.work.actions(list.length)}
        </span>
        {list.some((x) => !x.ok) && <span className="tag danger">{t.work.error}</span>}
      </button>
      {open && (
        <ul id={id}>
          {list.map((x, i) => (
            <li key={x.id || i}>
              <ToolRow tool={x} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** One tool call. Rows with a result or a diff open; runs saved before v0.3 have neither and stay plain. */
function ToolRow({ tool, who }: { tool: ToolEv; who?: string }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const id = useId()
  const more = Boolean(tool.detail || tool.diff)
  const head = (
    <>
      <Icon name={TOOL_ICON[tool.name] ?? 'plug'} size={13} />
      <span className="ellipsis">
        {who && `${who} `}
        {t.work.tools[tool.name] ?? t.work.usedTool}
        {tool.summary && <span className="mono"> {tool.summary}</span>}
      </span>
      {!tool.ok && <span className="tag danger">{t.work.error}</span>}
      {more && <Icon name="chevron" size={11} className="chev" />}
    </>
  )
  if (!more) {
    return (
      <div className="tool-row" title={tool.summary}>
        {head}
      </div>
    )
  }
  return (
    <>
      <button type="button" className={`tool-row ${open ? 'open' : ''}`} title={tool.summary} aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        {head}
      </button>
      {open && (
        <div className="tool-more" id={id}>
          {tool.detail && (
            <pre className="tool-detail" tabIndex={0}>
              {tool.detail}
            </pre>
          )}
          {tool.diff && <DiffView text={tool.diff} />}
        </div>
      )}
    </>
  )
}

function ApprovalCard({ e, done, ctx, sent, shortcut }: { e: Ev<'approval'>; done?: Ev<'approval_done'>; ctx: FeedCtx; sent: boolean; shortcut: boolean }) {
  const t = useT()
  const name = ctx.nameOf(e.agentId)
  const settled = done !== undefined || !ctx.running
  const title = e.kind === 'mcp' ? t.work.approvalMcp(name) : e.kind === 'fetch' ? t.run.approvalFetch(name) : t.work.approvalCommand(name)
  // The main process ignores "always" for commands it can't match safely, so don't offer it.
  const always = e.kind === 'mcp' ? t.run.alwaysTool : e.kind === 'fetch' ? t.run.alwaysHost(hostOf(e.command)) : hasShellControl(e.command) ? null : t.run.alwaysCommand(e.command)
  const files = firstFiles(e.files)
  const hint = (label: string, key: string) => (shortcut ? t.run.shortcut(label, key) : undefined)
  return (
    // A new request interrupts like an alert; answered ones are just part of the log.
    <div className="card approval" role={settled ? 'group' : 'alert'} aria-label={title}>
      <div className="card-head">
        <Icon name={e.kind === 'mcp' ? 'plug' : e.kind === 'fetch' ? 'globe' : 'terminal'} size={14} />
        <span className="ellipsis">{title}</span>
        {e.sandbox && (
          <span className="tag" title={t.run.dockerNote}>
            <Icon name="shield" size={11} /> {t.run.inDocker}
          </span>
        )}
        <span className="spacer" />
        <span className="faint small" title={ctx.project.workspaceDir} style={{ fontWeight: 400 }}>
          {baseName(ctx.project.workspaceDir)}
        </span>
      </div>
      <div className="card-body">
        <pre>{e.command}</pre>
        {e.kind === 'fetch' && !settled && <p className="approval-note">{t.run.fetchNote}</p>}
        {files.shown.length > 0 && (
          <div className="approval-files">
            <span>{t.run.filesSince}</span>
            <ul>
              {files.shown.map((f, i) => (
                <li key={i} className="mono">
                  {f}
                </li>
              ))}
              {files.more > 0 && <li className="faint">{t.run.andMore(files.more)}</li>}
            </ul>
          </div>
        )}
        {settled ? (
          done && (
            <div className="row small faint">
              <Icon name={done.approved ? 'check' : 'x'} size={13} />
              {done.approved ? (done.always ? t.run.allowedAlways : t.work.allowed) : t.work.denied}
            </div>
          )
        ) : (
          <div className="row">
            <button className="btn primary sm" disabled={sent} title={hint(t.work.allow, 'A')} aria-keyshortcuts={shortcut ? 'Alt+A' : undefined} onClick={() => ctx.onAnswer(e.id, true)}>
              <Icon name="check" size={13} /> {t.work.allow}
            </button>
            <button className="btn sm" disabled={sent} title={hint(t.work.deny, 'D')} aria-keyshortcuts={shortcut ? 'Alt+D' : undefined} onClick={() => ctx.onAnswer(e.id, false)}>
              {t.work.deny}
            </button>
            <span className="spacer" />
            {always && (
              <button className="btn quiet sm" disabled={sent} title={always} onClick={() => ctx.onAnswer(e.id, true, true)}>
                <Icon name="shield" size={13} /> {t.run.alwaysAllow}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function PlanCard({ item, ctx, sent }: { item: Extract<Item, { kind: 'plan' }>; ctx: FeedCtx; sent: boolean }) {
  const t = useT()
  const [writing, setWriting] = useState(false)
  const [feedback, setFeedback] = useState('')
  const fieldId = useId()
  const { e, done, replaced } = item
  const a = ctx.byId.get(e.agentId)
  const name = a?.name ?? t.work.formerMember
  const canAnswer = item.open && !ctx.viewing

  const answer = async (approved: boolean) => {
    const ok = await ctx.onPlan(e.id, approved, approved ? undefined : feedback.trim())
    if (ok) setWriting(false)
  }

  let footer
  if (done && !replaced) {
    footer = (
      <div className="plan-status">
        <div className="row small faint">
          <Icon name={done.approved ? 'check' : 'edit'} size={13} />
          {done.approved ? t.run.planApproved : t.run.planChanges}
        </div>
        {!done.approved && done.feedback && <blockquote className="plan-feedback">{done.feedback}</blockquote>}
      </div>
    )
  } else if (replaced) {
    footer = <div className="row small faint plan-status">{t.run.planReplaced}</div>
  } else if (!canAnswer) {
    footer = <div className="row small faint plan-status">{t.run.planUnanswered}</div>
  } else if (writing) {
    footer = (
      <form
        className="plan-form stack tight"
        onSubmit={(x) => {
          x.preventDefault()
          if (feedback.trim() && !sent) void answer(false)
        }}
      >
        <label htmlFor={fieldId} className="small" style={{ fontWeight: 550 }}>
          {t.run.feedback}
        </label>
        <textarea
          id={fieldId}
          className="textarea"
          rows={3}
          autoFocus
          value={feedback}
          placeholder={t.run.feedbackPlaceholder}
          onChange={(x) => setFeedback(x.target.value)}
          onKeyDown={(x) => {
            if (x.key === 'Enter' && (x.ctrlKey || x.metaKey) && !x.nativeEvent.isComposing) {
              x.preventDefault()
              x.currentTarget.form?.requestSubmit()
            } else if (x.key === 'Escape') {
              x.stopPropagation()
              setWriting(false)
            }
          }}
        />
        <div className="row">
          <button type="submit" className="btn primary sm" disabled={!feedback.trim() || sent}>
            {t.run.sendFeedback}
          </button>
          <button type="button" className="btn sm" onClick={() => setWriting(false)}>
            {t.common.cancel}
          </button>
        </div>
      </form>
    )
  } else {
    footer = (
      <div className="row plan-actions">
        <button className="btn primary sm" disabled={sent} onClick={() => void answer(true)}>
          <Icon name="check" size={13} /> {t.run.approvePlan}
        </button>
        <button className="btn sm" disabled={sent} onClick={() => setWriting(true)}>
          <Icon name="edit" size={13} /> {t.run.requestChanges}
        </button>
      </div>
    )
  }

  return (
    <div className="msg">
      <Avatar name={name} seed={a?.id} size={28} />
      <div className="msg-main">
        <div className="msg-head">
          <span className="msg-name">{name}</span>
          {a && <span className="msg-meta">{a.title}</span>}
          <span className="msg-meta">→ {t.work.you}</span>
          <span className="msg-time">{clock(e.at)}</span>
        </div>
        <div className="card plan" role="group" aria-label={t.run.planTitle(name)}>
          <div className="card-head">
            <Icon name="clipboard" size={14} /> {t.run.planTitle(name)}
          </div>
          <div className="card-body">
            <Markdown text={e.text} />
            {footer}
          </div>
        </div>
      </div>
    </div>
  )
}

function Message({ e, ctx }: { e: Ev<'message'>; ctx: FeedCtx }) {
  const t = useT()
  const [copied, setCopied] = useState(false)
  const { nameOf } = ctx
  if (e.from === USER) {
    return (
      <div className="msg owner">
        <div className="bubble">
          <div className="to">
            {t.work.you} → {e.to.map(nameOf).join(', ')}
          </div>
          <Markdown text={e.text} />
        </div>
      </div>
    )
  }
  if (e.from === SYSTEM) {
    const warn = systemWarn(e.text)
    return (
      <div className={`msg system ${warn ? 'warn' : ''}`}>
        <span className="avatar" style={warn ? { width: 28, height: 28, background: 'var(--accent-soft)', color: 'var(--accent-text)' } : { width: 28, height: 28, background: 'var(--danger-soft)', color: 'var(--danger)' }}>
          <Icon name="alert" size={14} />
        </span>
        <div className="msg-main">
          <div className="msg-head">
            <span className="msg-name">{t.work.system}</span>
            <span className="msg-time">{clock(e.at)}</span>
          </div>
          <div className="msg-body">{systemText(e.text)}</div>
        </div>
      </div>
    )
  }
  const a = ctx.byId.get(e.from)
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
                  try {
                    await navigator.clipboard.writeText(e.text)
                    setCopied(true)
                    setTimeout(() => setCopied(false), 1500)
                  } catch (x) {
                    ctx.notify(errText(x))
                  }
                }}
              >
                <Icon name={copied ? 'check' : 'copy'} size={13} /> {copied ? t.common.copied : t.common.copy}
              </button>
              <button className="btn quiet sm" onClick={() => window.office.openWorkspace(ctx.project.id).catch((x: unknown) => ctx.notify(errText(x)))}>
                <Icon name="folder" size={13} /> {t.work.openFolder}
              </button>
            </div>
            <div className="card-body">
              <Markdown text={e.text} />
            </div>
          </div>
        ) : (
          <div className="msg-body">
            <Markdown text={e.text} />
          </div>
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

function BlockedCard({ e, resolved, ctx }: { e: Ev<'blocked'>; resolved: boolean; ctx: FeedCtx }) {
  const t = useT()
  const { project, providers } = ctx
  const [picking, setPicking] = useState(false)
  const [providerId, setProviderId] = useState(e.providerId)
  const [model, setModel] = useState(e.model)
  const [busy, setBusy] = useState(false)
  const advice = e.kind === 'config' ? errText(e.detail) : t.work.advice[e.kind]

  const go = async (to?: ModelRef) => {
    setBusy(true)
    try {
      // The new model sticks: the member keeps it in later tasks too.
      if (to) await ctx.onSave({ ...project, agents: project.agents.map((a) => (a.id === e.agentId ? { ...a, ...to } : a)) })
      await window.office.retryAgent(project.id, e.agentId, to)
    } catch (x) {
      ctx.notify(errText(x))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card blocked" role="alert">
      <div className="card-head">
        <Icon name="alert" size={14} />
        <span className="ellipsis">{t.work.blockedTitle(ctx.nameOf(e.agentId), t.work.kinds[e.kind])}</span>
        <span className="spacer" />
        <span className="faint small mono" style={{ fontWeight: 400 }}>
          {modelLabel(e, providers)}
        </span>
      </div>
      <div className="card-body stack tight">
        <p>{advice}</p>
        {e.kind !== 'config' && e.detail && (
          <details className="more">
            <summary>
              <Icon name="chevron" size={12} /> {t.work.details}
            </summary>
            <pre>{e.detail}</pre>
          </details>
        )}
        {resolved ? (
          <div className="row small faint">
            <Icon name="check" size={13} /> {t.work.resolved}
          </div>
        ) : picking ? (
          <div className="stack tight">
            <div className="grid2">
              <select className="select" value={providerId} onChange={(x) => setProviderId(x.target.value)} aria-label={t.team.provider}>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <ModelInput providerId={providerId} hasKey={providers.find((p) => p.id === providerId)?.hasKey} value={model} onChange={setModel} />
            </div>
            <div className="row">
              <button className="btn primary sm" disabled={busy || !model.trim()} onClick={() => go({ providerId, model: model.trim() })}>
                {t.work.switchTo}
              </button>
              <button className="btn sm" onClick={() => setPicking(false)}>
                {t.common.cancel}
              </button>
            </div>
          </div>
        ) : (
          <div className="row">
            <button className="btn primary sm" disabled={busy} onClick={() => go()}>
              <Icon name="refresh" size={13} /> {t.work.retry}
            </button>
            <button className="btn sm" onClick={() => setPicking(true)}>
              <Icon name="swap" size={13} /> {t.work.otherModel}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
