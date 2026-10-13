import { useEffect, useState } from 'react'
import type { RunSummary } from '../../../shared/types'
import { errText, useT } from '../i18n'
import { dateTime, Icon, Modal } from '../ui'
import { matchRuns } from './logic'
import { TwoStep } from './parts'

export function HistoryModal({ projectId, currentRunId, onOpen, onRunAgain, onDeleted, onClose, notify }: {
  projectId: string
  /** The live task: it can't be deleted from here. */
  currentRunId: string | null
  onOpen(run: RunSummary): void
  onRunAgain(goal: string): void
  onDeleted(runId: string): void
  onClose(): void
  notify(text: string): void
}) {
  const t = useT()
  const [runs, setRuns] = useState<RunSummary[] | null>(null)
  const [err, setErr] = useState('')
  const [query, setQuery] = useState('')

  useEffect(() => {
    let live = true
    window.office.listRuns(projectId).then(
      (r) => live && setRuns(r),
      (e: unknown) => live && setErr(errText(e))
    )
    return () => {
      live = false
    }
  }, [projectId])

  const shown = runs ? matchRuns(runs, query) : []
  const stateText = { running: t.work.running, done: t.work.done, stopped: t.work.stopped, error: t.work.stopped }

  const remove = async (r: RunSummary) => {
    try {
      await window.office.deleteRun(projectId, r.id)
      setRuns((all) => all?.filter((x) => x.id !== r.id) ?? null)
      onDeleted(r.id)
      notify(t.run.deleted)
    } catch (e) {
      notify(errText(e))
    }
  }

  const exportRun = async (r: RunSummary) => {
    try {
      const file = await window.office.exportRun(projectId, r.id)
      if (file) notify(t.run.exported(file))
    } catch (e) {
      notify(errText(e))
    }
  }

  return (
    <Modal title={t.work.history} onClose={onClose} width={640}>
      {err ? (
        <div className="note danger" role="alert">{err}</div>
      ) : !runs ? (
        <p className="faint" role="status">{t.run.loading}</p>
      ) : !runs.length ? (
        <p className="muted">{t.work.noHistory}</p>
      ) : (
        <div className="stack tight">
          <div className="history-search">
            <Icon name="search" size={14} />
            <input className="input" type="search" autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t.run.search} aria-label={t.run.search} />
          </div>
          {shown.length ? (
            <ul className="list history-list">
              {shown.map((r) => (
                <li key={r.id} className="list-row history-row">
                  <button type="button" className="history-open" onClick={() => onOpen(r)}>
                    <span className="ellipsis history-goal" title={r.goal}>{r.goal}</span>
                    <span className="faint small">{dateTime(r.startedAt)}</span>
                  </button>
                  <span className={`tag ${r.state === 'running' ? 'accent' : r.state === 'stopped' || r.state === 'error' ? 'danger' : ''}`}>{stateText[r.state] ?? r.state}</span>
                  <div className="history-actions">
                    <button type="button" className="btn quiet icon sm" title={t.run.runAgain} aria-label={`${t.run.runAgain}: ${r.goal}`} onClick={() => onRunAgain(r.goal)}>
                      <Icon name="refresh" size={14} />
                    </button>
                    <button type="button" className="btn quiet icon sm" title={t.run.exportMd} aria-label={`${t.run.exportMd}: ${r.goal}`} onClick={() => void exportRun(r)}>
                      <Icon name="download" size={14} />
                    </button>
                    {r.id !== currentRunId && <TwoStep iconOnly icon="trash" label={`${t.run.deleteRun}: ${r.goal}`} armedLabel={t.common.confirmDelete} onConfirm={() => void remove(r)} />}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">{t.run.noMatches}</p>
          )}
        </div>
      )}
    </Modal>
  )
}
