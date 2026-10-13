import { useEffect, useState } from 'react'
import type { Agent, AgentStatus } from '../../../shared/types'
import { useT } from '../i18n'
import { Markdown } from '../markdown'
import { Avatar } from '../ui'
import { elapsed } from './logic'

/** Replies members are writing right now (office:delta). Kept apart from the events so typing never re-parses the feed. */
export function useDeltas(projectId: string) {
  const [deltas, setDeltas] = useState<Record<string, string>>({})
  useEffect(
    () =>
      window.office.onDelta((pid, agentId, text) => {
        if (pid !== projectId) return
        setDeltas((d) => {
          if (text === null) {
            if (!(agentId in d)) return d
            const next = { ...d }
            delete next[agentId]
            return next
          }
          return d[agentId] === text ? d : { ...d, [agentId]: text }
        })
      }),
    [projectId]
  )
  return deltas
}

/**
 * One line per working member under the feed: the reply as it is written, or how long they have been thinking.
 * Only working members show, so a reply whose end was never announced can't linger.
 */
export function LiveReplies({ agents, status, since, deltas }: { agents: Agent[]; status: Map<string, AgentStatus>; since: Map<string, number>; deltas: Record<string, string> }) {
  const t = useT()
  const rows = agents.filter((a) => status.get(a.id) === 'working')
  const ticking = rows.some((a) => !deltas[a.id])
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!ticking) return
    const tick = () => setNow(Date.now())
    // The clock was paused while nobody was thinking; catch up right away.
    const first = setTimeout(tick, 0)
    const id = setInterval(tick, 1000)
    return () => {
      clearTimeout(first)
      clearInterval(id)
    }
  }, [ticking])
  if (!rows.length) return null
  return (
    <div className="live" role="group" aria-label={t.run.liveLabel}>
      {rows.map((a) =>
        deltas[a.id] ? (
          <div key={a.id} className="msg live-msg" aria-busy="true">
            <Avatar name={a.name} seed={a.id} size={28} status="working" />
            <div className="msg-main">
              <div className="msg-head">
                <span className="msg-name">{a.name}</span>
                <span className="msg-meta">{t.run.writing}</span>
              </div>
              <div className="msg-body live-text">
                <Markdown text={deltas[a.id]} />
              </div>
            </div>
          </div>
        ) : (
          <div key={a.id} className="typing live-line">
            <Avatar name={a.name} seed={a.id} size={20} status="working" />
            <span className="live-name">{a.name}</span>
            <span className="num">{t.run.thinking(elapsed(now, since.get(a.id)))}</span>
          </div>
        )
      )}
    </div>
  )
}
