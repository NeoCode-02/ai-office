import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { FileChange, RunChanges } from '../../../shared/types'
import { errText, useT } from '../i18n'
import { Icon, Sheet } from '../ui'
import { changeTotals, errCode } from './logic'
import { DiffView, TwoStep } from './parts'

export interface ChangesData {
  runId: string
  res: RunChanges | null
  err: string | null
}

/**
 * What the shown task changed. Fetched for a new run, when it ends, after an explicit refresh,
 * and while it runs a little after each burst of file writes.
 */
export function useRunChanges(projectId: string, runId: string | null, running: boolean, writes: number, endedAt: number) {
  const [data, setData] = useState<ChangesData | null>(null)
  const [version, setVersion] = useState(0)
  const seen = useRef(version)
  useEffect(() => {
    if (!runId) return
    let live = true
    const wait = running && seen.current === version ? 1500 : 0
    seen.current = version
    const id = setTimeout(() => {
      window.office.runChanges(projectId, runId).then(
        (res) => live && setData({ runId, res, err: null }),
        (e: unknown) => live && setData({ runId, res: null, err: errText(e) })
      )
    }, wait)
    return () => {
      live = false
      clearTimeout(id)
    }
  }, [projectId, runId, running, version, writes, endedAt])
  const refresh = useCallback(() => setVersion((v) => v + 1), [])
  const current = data && data.runId === runId ? data : null
  const count = current?.res?.available ? current.res.files.length : null
  return { data: current, count, refresh }
}

const TONE: Record<FileChange['status'], string> = { added: 'ok', modified: 'accent', deleted: 'danger' }

export function ChangesSheet({ projectId, runId, running, past, goal, data, onRefresh, onClose, notify }: {
  projectId: string
  runId: string
  running: boolean
  /** An older task: its snapshot is compared with today's workspace. */
  past: boolean
  goal: string
  data: ChangesData | null
  onRefresh(): void
  onClose(): void
  notify(text: string): void
}) {
  const t = useT()
  const [file, setFile] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [committing, setCommitting] = useState(false)
  const res = data?.res
  const files = res?.available ? res.files : []
  const totals = changeTotals(files)
  const locked = running || busy
  const lockNote = running ? t.run.stopFirst : undefined

  const revert = async (paths?: string[]) => {
    setBusy(true)
    try {
      await (paths ? window.office.revertRun(projectId, runId, paths) : window.office.revertRun(projectId, runId))
      notify(t.run.undone)
      setFile(null)
    } catch (e) {
      notify(errText(e))
    } finally {
      setBusy(false)
      onRefresh()
    }
  }

  const selected = file ? files.find((f) => f.path === file) : undefined
  const head = selected ? (
    <>
      <button type="button" className="btn quiet sm" onClick={() => setFile(null)}>
        <Icon name="chevron" size={12} className="back" /> {t.run.allFiles}
      </button>
      <span className="spacer" />
    </>
  ) : (
    <>
      <h3 className="sheet-title">
        <Icon name="diff" size={15} /> {t.run.changes}
      </h3>
      <span className="spacer" />
      <button type="button" className="btn quiet icon sm" onClick={onRefresh} aria-label={t.run.refresh} title={t.run.refresh}>
        <Icon name="refresh" size={14} />
      </button>
    </>
  )

  return (
    <Sheet head={head} onClose={onClose}>
      <div className="changes">
        {selected ? (
          <FileDiff projectId={projectId} runId={runId} file={selected} locked={locked} lockNote={lockNote} onUndo={() => revert([selected.path])} />
        ) : (
          <>
            {past && <p className="note small">{t.run.pastNote}</p>}
            {!data ? (
              <p className="faint" role="status">{t.run.checking}</p>
            ) : data.err ? (
              <div className="note danger" role="alert">{data.err}</div>
            ) : !res?.available ? (
              <div className="note">{errText(res?.reason || 'E_NO_CHECKPOINT')}</div>
            ) : !files.length ? (
              <p className="muted">{t.run.noChanges}</p>
            ) : (
              <>
                <div className="changes-sum small">
                  <span>{t.run.changedFiles(files.length)}</span>
                  <span className="mono n-add">+{totals.add}</span>
                  <span className="mono n-del">−{totals.del}</span>
                </div>
                <ul className="list change-list">
                  {files.map((f) => (
                    <li key={f.path} className="change-row">
                      <button type="button" className="change-open" onClick={() => setFile(f.path)} title={f.path}>
                        <span className={`tag ${TONE[f.status]}`}>{t.run.fileStatus[f.status]}</span>
                        <span className="mono ellipsis change-path">{f.path}</span>
                        <Counts f={f} />
                      </button>
                      <TwoStep
                        iconOnly
                        icon="undo"
                        label={t.run.undoFile(f.path)}
                        armedLabel={t.run.confirmUndo}
                        title={lockNote}
                        disabled={locked}
                        onConfirm={() => void revert([f.path])}
                      />
                    </li>
                  ))}
                </ul>
              </>
            )}
            {data && !data.err && (
              <div className="changes-actions">
                {files.length > 0 && <TwoStep icon="undo" label={t.run.undoAll} armedLabel={t.run.confirmUndo} title={lockNote} disabled={locked} onConfirm={() => void revert()} />}
                <button type="button" className="btn sm" disabled={running || committing} title={lockNote} onClick={() => setCommitting(true)}>
                  <Icon name="branch" size={13} /> {t.run.commit}
                </button>
                {running && <span className="faint small">{t.run.stopFirst}</span>}
              </div>
            )}
            {committing && !running && <CommitForm projectId={projectId} goal={goal} onClose={() => setCommitting(false)} />}
          </>
        )}
      </div>
    </Sheet>
  )
}

function Counts({ f }: { f: FileChange }) {
  const t = useT()
  if (f.binary) return <span className="change-num faint">{t.run.binary}</span>
  return (
    <span className="change-num mono">
      <span className="n-add">+{f.additions}</span> <span className="n-del">−{f.deletions}</span>
    </span>
  )
}

function FileDiff({ projectId, runId, file, locked, lockNote, onUndo }: { projectId: string; runId: string; file: FileChange; locked: boolean; lockNote?: string; onUndo(): void }) {
  const t = useT()
  const [diff, setDiff] = useState<{ path: string; text?: string; err?: string } | null>(null)
  useEffect(() => {
    let live = true
    window.office.fileDiff(projectId, runId, file.path).then(
      (text) => live && setDiff({ path: file.path, text }),
      (e: unknown) => live && setDiff({ path: file.path, err: errText(e) })
    )
    return () => {
      live = false
    }
  }, [projectId, runId, file.path])
  const shown = diff?.path === file.path ? diff : null
  return (
    <>
      <div className="diff-head">
        <span className={`tag ${TONE[file.status]}`}>{t.run.fileStatus[file.status]}</span>
        <span className="mono ellipsis change-path" title={file.path}>{file.path}</span>
        <Counts f={file} />
        <TwoStep icon="undo" label={t.run.undo} armedLabel={t.run.confirmUndo} title={lockNote ?? t.run.undoFile(file.path)} disabled={locked} onConfirm={onUndo} />
      </div>
      {!shown ? (
        <p className="faint" role="status">{t.run.loadingDiff}</p>
      ) : shown.err ? (
        <div className="note danger" role="alert">{shown.err}</div>
      ) : shown.text?.trim() ? (
        <DiffView text={shown.text} label={file.path} />
      ) : (
        <p className="muted">{t.run.noDiff}</p>
      )}
    </>
  )
}

function CommitForm({ projectId, goal, onClose }: { projectId: string; goal: string; onClose(): void }) {
  const t = useT()
  const [message, setMessage] = useState(goal.trim())
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const id = useId()
  return (
    <form
      className="commit-form stack tight"
      onSubmit={async (e) => {
        e.preventDefault()
        if (!message.trim() || busy) return
        setBusy(true)
        setResult(null)
        try {
          const sha = await window.office.commitWorkspace(projectId, message.trim())
          setResult({ ok: true, text: t.run.committed(sha) })
        } catch (x) {
          setResult({ ok: false, text: errCode(x) === 'E_NOT_GIT_REPO' ? t.run.notRepo : errText(x) })
        } finally {
          setBusy(false)
        }
      }}
    >
      <label htmlFor={id} className="small" style={{ fontWeight: 550 }}>
        {t.run.commitMessage}
      </label>
      <textarea id={id} className="textarea" rows={3} autoFocus value={message} onChange={(e) => setMessage(e.target.value)} />
      {result && (
        <div className={`note ${result.ok ? 'ok' : 'danger'}`} role={result.ok ? 'status' : 'alert'}>
          {result.text}
        </div>
      )}
      <div className="row">
        <button type="submit" className="btn primary sm" disabled={!message.trim() || busy || result?.ok}>
          <Icon name="branch" size={13} /> {busy ? t.run.committing : t.run.commitDo}
        </button>
        <button type="button" className="btn sm" onClick={onClose}>
          {result?.ok ? t.common.close : t.common.cancel}
        </button>
      </div>
    </form>
  )
}
