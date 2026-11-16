import { useEffect, useId, useState, type ReactNode } from 'react'
import { DEFAULT_SANDBOX, type ModelRef, type Project, type Provider } from '../../shared/types'
import { errText, useT } from './i18n'
import { allowEntry, isDirty, latestProject, saveForm, toForm, type AllowKind, type OfficeForm } from './officeForm'
import { sameJson } from './orgchart'
import { uid, withExecs, withWorkerModel } from './roles'
import { ModelInput } from './Team'
import { baseName, ConfirmButton, Empty, Field, Icon, Modal, Switch, type IconName } from './ui'

export function FolderField({ value, onChange }: { value: string; onChange(v: string): void }) {
  const t = useT()
  const pick = async () => {
    const d = await window.office.pickFolder()
    if (d) onChange(d)
  }
  return (
    <Field label={t.office.folder} hint={t.office.folderHint}>
      <div className="row">
        <input className="input mono" value={value} onChange={(e) => onChange(e.target.value)} placeholder={t.office.folderPlaceholder} />
        <button className="btn" type="button" onClick={pick}>
          <Icon name="folder" size={15} /> {t.common.browse}
        </button>
      </div>
    </Field>
  )
}

/** A settings line: title and hint on the left, the control on the right. The whole line labels the control. */
function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="list-row org-row">
      <span className="spacer">
        <span className="org-row-title">{label}</span>
        {hint && <span className="org-row-hint muted small">{hint}</span>}
      </span>
      {children}
    </label>
  )
}

/** Segmented choice with pressed state for assistive tech. */
function Seg<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange(v: T): void }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} type="button" className={value === v ? 'on' : ''} aria-pressed={value === v} onClick={() => onChange(v)}>
          {text}
        </button>
      ))}
    </div>
  )
}

const ALLOW_ICONS: Record<AllowKind, IconName> = { command: 'terminal', mcp: 'plug', fetch: 'globe' }

interface Props {
  project: Project
  onSave(p: Project): Promise<void>
  onDelete(): void | Promise<void>
  notify(t: string): void
  /** Told whenever the form differs from the saved office. */
  onDirty?(dirty: boolean): void
}

export default function Settings({ project, onSave, onDelete, notify, onDirty }: Props) {
  const t = useT()
  // The saved office the form was loaded from (what "unsaved changes" compares against).
  const [loaded, setLoaded] = useState(project)
  const [form, setForm] = useState<OfficeForm>(() => toForm(project))
  const [busy, setBusy] = useState(false)
  const [exporting, setExporting] = useState(false)
  const dirty = isDirty(form, loaded)
  useEffect(() => onDirty?.(dirty), [dirty, onDirty])
  const set = <K extends keyof OfficeForm>(k: K, v: OfficeForm[K]) => setForm((f) => ({ ...f, [k]: v }))
  const setSandbox = (patch: Partial<OfficeForm['sandbox']>) => setForm((f) => ({ ...f, sandbox: { ...f.sandbox, ...patch } }))
  const limitsId = useId()
  const allowId = useId()

  // The app's copy can lag behind the main process (e.g. a permission granted for good during a task).
  useEffect(() => {
    let live = true
    void latestProject(project).then((p) => {
      if (!live || sameJson(p, project)) return
      setLoaded(p)
      setForm((f) => (sameJson(f, toForm(project)) ? toForm(p) : f))
    })
    return () => {
      live = false
    }
  }, [project])

  const save = async () => {
    const f = { ...form, name: form.name.trim(), workspaceDir: form.workspaceDir.trim() }
    if (!f.name) return notify(t.office.errName)
    if (!f.workspaceDir) return notify(t.office.errFolder)
    if (f.sandbox.kind === 'docker' && !f.sandbox.image.trim()) return notify(t.org.errImage)
    setBusy(true)
    try {
      const next = saveForm(f, loaded, await latestProject(loaded))
      await onSave(next)
      setLoaded(next)
      setForm(toForm(next))
      notify(t.common.saved)
    } catch (e) {
      notify(errText(e, t))
    } finally {
      setBusy(false)
    }
  }

  const exportOffice = async () => {
    setExporting(true)
    try {
      const file = await window.office.exportProject(project.id)
      if (file) notify(t.org.exported(baseName(file)))
    } catch (e) {
      notify(errText(e, t))
    } finally {
      setExporting(false)
    }
  }

  const remove = async () => {
    try {
      await onDelete()
    } catch (e) {
      notify(errText(e, t))
    }
  }

  const docker = form.sandbox.kind === 'docker'
  const limit = (k: 'maxRequests' | 'maxChatter' | 'compactAt', label: string, hint: string, step: number) => (
    <Row label={label} hint={hint}>
      <input className="input num org-num" type="number" min={0} step={step} inputMode="numeric" value={form[k]} placeholder="0" onChange={(e) => set(k, e.target.value)} />
    </Row>
  )

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>{t.office.title}</h2>
          <p>{t.office.subtitle}</p>
        </div>
      </div>

      <div className="stack">
        <div className="grid2">
          <Field label={t.office.name}>
            <input className="input" value={form.name} onChange={(e) => set('name', e.target.value)} />
          </Field>
          <Field label={t.office.budget} hint={t.office.budgetHint}>
            <input className="input num" type="number" min={0} step={0.5} value={form.budget} placeholder="0" onChange={(e) => set('budget', e.target.value)} />
          </Field>
        </div>
        <FolderField value={form.workspaceDir} onChange={(v) => set('workspaceDir', v)} />
        <Field label={t.office.briefing} hint={t.office.briefingHint}>
          <textarea className="textarea" rows={10} value={form.briefing} onChange={(e) => set('briefing', e.target.value)} placeholder={t.office.briefingPlaceholder} />
        </Field>
      </div>

      <div className="section">
        <div className="section-head">
          <h3>{t.org.workflow}</h3>
        </div>
        <div className="list">
          <Row label={t.org.planFirst} hint={t.org.planFirstHint}>
            <Switch on={form.planFirst} label={t.org.planFirst} onChange={(v) => set('planFirst', v)} />
          </Row>
          <Row label={t.org.checkpoints} hint={t.org.checkpointsHint}>
            <Switch on={form.checkpoints} label={t.org.checkpoints} onChange={(v) => set('checkpoints', v)} />
          </Row>
        </div>
      </div>

      <section className="section" aria-labelledby={limitsId}>
        <div className="section-head">
          <div>
            <h3 id={limitsId}>{t.org.limits}</h3>
            <p>{t.org.limitsHint}</p>
          </div>
        </div>
        <div className="list">
          {limit('maxRequests', t.org.maxRequests, t.org.maxRequestsHint, 10)}
          {limit('maxChatter', t.org.maxChatter, t.org.maxChatterHint, 1)}
          {limit('compactAt', t.org.compactAt, t.org.compactAtHint, 10_000)}
        </div>
      </section>

      <div className="section">
        <div className="section-head">
          <div>
            <h3>{t.office.commands}</h3>
            <p>{t.office.commandsHint}</p>
          </div>
        </div>
        <div className="stack">
          <div className="stack tight">
            <Seg
              label={t.office.commands}
              value={form.approval}
              options={[['ask', t.office.ask], ['auto', t.office.auto]]}
              onChange={(v) => set('approval', v)}
            />
            {form.approval === 'auto' && <div className="note warn">{docker ? t.org.autoDocker : t.office.autoWarn}</div>}
          </div>
          <div className="field">
            <span>{t.org.sandbox}</span>
            <Seg
              label={t.org.sandbox}
              value={form.sandbox.kind}
              options={[['none', t.org.sandboxNone], ['docker', t.org.sandboxDocker]]}
              onChange={(kind) => setSandbox({ kind, image: form.sandbox.image.trim() || DEFAULT_SANDBOX.image })}
            />
          </div>
          {docker && (
            <div className="stack tight">
              <div className="list">
                <Row label={t.org.image} hint={t.org.imageHint}>
                  <input
                    className="input mono org-image"
                    value={form.sandbox.image}
                    placeholder={DEFAULT_SANDBOX.image}
                    aria-invalid={!form.sandbox.image.trim()}
                    onChange={(e) => setSandbox({ image: e.target.value })}
                  />
                </Row>
                <Row label={t.org.network} hint={t.org.networkHint}>
                  <Switch on={form.sandbox.network} label={t.org.network} onChange={(network) => setSandbox({ network })} />
                </Row>
              </div>
              <div className="note">{t.org.dockerNote}</div>
            </div>
          )}
        </div>
      </div>

      <section className="section" aria-labelledby={allowId}>
        <div className="section-head">
          <div>
            <h3 id={allowId}>{t.org.allowed}</h3>
            <p>{t.org.allowedHint}</p>
          </div>
        </div>
        <div className="list">
          {form.allowCommands.length ? (
            <ul className="org-allow">
              {form.allowCommands.map((entry) => {
                const { kind, text } = allowEntry(entry)
                return (
                  <li key={entry} className="list-row">
                    <Icon name={ALLOW_ICONS[kind]} size={15} className="faint" />
                    <span className={`spacer ellipsis ${kind === 'mcp' ? '' : 'mono'}`} title={text}>{text}</span>
                    <span className="tag">{t.org.allowKinds[kind]}</span>
                    <button
                      type="button"
                      className="btn quiet icon sm"
                      title={t.org.remove(text)}
                      aria-label={t.org.remove(text)}
                      onClick={() => set('allowCommands', form.allowCommands.filter((x) => x !== entry))}
                    >
                      <Icon name="x" size={14} />
                    </button>
                  </li>
                )
              })}
            </ul>
          ) : (
            <div className="list-empty">{t.org.allowedNone}</div>
          )}
        </div>
      </section>

      <div className="section">
        <div className="list">
          <div className="list-row">
            <div className="spacer">
              <div style={{ fontWeight: 600 }}>{t.org.exportTitle}</div>
              <div className="muted small">{t.org.exportHint}</div>
              {dirty && <div className="small org-warn">{t.org.exportSaveFirst}</div>}
            </div>
            <button type="button" className="btn" onClick={exportOffice} disabled={dirty || exporting}>
              <Icon name="download" size={14} /> {t.org.exportButton}
            </button>
          </div>
        </div>
      </div>

      <div className="section">
        <div className="list">
          <div className="list-row">
            <div className="spacer">
              <div style={{ fontWeight: 600 }}>{t.office.danger}</div>
              <div className="muted small">{t.office.dangerHint}</div>
            </div>
            <ConfirmButton onConfirm={remove}>{t.common.delete}</ConfirmButton>
          </div>
        </div>
      </div>

      {dirty && (
        <div className="savebar inline" role="status">
          {t.common.unsaved}
          <button className="btn quiet sm" onClick={() => setForm(toForm(loaded))} disabled={busy}>{t.common.discard}</button>
          <button className="btn primary sm" onClick={save} disabled={busy}>{busy ? t.common.saving : t.common.save}</button>
        </div>
      )}
    </div>
  )
}

export function NewProject({ providers, onClose, onCreate, onProviders }: { providers: Provider[]; onClose(): void; onCreate(p: Project): void | Promise<void>; onProviders(): void }) {
  const t = useT()
  const usable = providers.filter((p) => p.hasKey || p.baseURL.includes('localhost'))
  const [name, setName] = useState('')
  const [providerId, setProviderId] = useState(usable[0]?.id ?? '')
  const [model, setModel] = useState('')
  const [worker, setWorker] = useState<ModelRef>({ providerId: '', model: '' })
  const [dir, setDir] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  if (!usable.length) {
    return (
      <Modal title={t.office.newTitle} onClose={onClose}>
        <Empty icon="key" title={t.office.needProvider} body={t.office.needProviderBody}>
          <button className="btn primary" onClick={onProviders}>{t.providers.add}</button>
        </Empty>
      </Modal>
    )
  }

  const hasKey = (id: string) => providers.find((p) => p.id === id)?.hasKey

  const create = async () => {
    if (!name.trim()) return setErr(t.office.errName)
    if (!dir.trim()) return setErr(t.office.errFolder)
    if (!providerId || !model.trim()) return setErr(t.office.errModel)
    if (worker.providerId && !worker.model.trim()) return setErr(t.org.errWorkerModel)
    // Every office starts with its executives; the owner adds everyone else on the Team canvas.
    const agents = withWorkerModel(withExecs([], t.names, { providerId, model: model.trim() }), worker)
    setErr('')
    setBusy(true)
    try {
      await onCreate({ id: uid(), name: name.trim(), workspaceDir: dir.trim(), briefing: '', approval: 'ask', budgetUsd: 5, agents })
    } catch (e) {
      setErr(errText(e, t))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={t.office.newTitle}
      onClose={onClose}
      width={600}
      footer={
        <>
          <button className="btn" onClick={onClose}>{t.common.cancel}</button>
          <button className="btn primary" onClick={create} disabled={busy}>{t.office.create}</button>
        </>
      }
    >
      <div className="stack">
        <Field label={t.office.name}>
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t.office.namePlaceholder} />
        </Field>
        <FolderField value={dir} onChange={setDir} />
        <p className="faint small">{t.office.execsHint}</p>
        <div className="grid2">
          <Field label={t.office.defaultProvider}>
            <select className="select" value={providerId} onChange={(e) => setProviderId(e.target.value)}>
              {usable.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
          <Field label={t.office.defaultModel} hint={worker.providerId ? t.org.ceoModelHint : t.office.defaultModelHint}>
            <ModelInput providerId={providerId} hasKey={hasKey(providerId)} value={model} onChange={setModel} />
          </Field>
        </div>
        <div className="stack tight">
          <div className="grid2">
            <Field label={t.org.workerModel}>
              <select className="select" value={worker.providerId} onChange={(e) => setWorker({ providerId: e.target.value, model: e.target.value ? worker.model : '' })}>
                <option value="">{t.org.sameAsCeo}</option>
                {usable.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Field>
            {worker.providerId && (
              <Field label={t.team.model}>
                <ModelInput providerId={worker.providerId} hasKey={hasKey(worker.providerId)} value={worker.model} onChange={(m) => setWorker({ ...worker, model: m })} />
              </Field>
            )}
          </div>
          <small className="faint">{t.org.workerModelHint}</small>
        </div>
        {err && <div className="note danger" role="alert">{err}</div>}
      </div>
    </Modal>
  )
}
