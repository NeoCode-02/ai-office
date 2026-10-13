import { useState } from 'react'
import type { Project, Provider } from '../../shared/types'
import { useT } from './i18n'
import { TEMPLATES, uid } from './roles'
import { ModelInput } from './Team'
import { ConfirmButton, Empty, Field, Icon, Modal } from './ui'

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

interface Props {
  project: Project
  onSave(p: Project): Promise<void>
  onDelete(): void
  notify(t: string): void
}

export default function Settings({ project, onSave, onDelete, notify }: Props) {
  const t = useT()
  const [p, setP] = useState(project)
  const dirty = JSON.stringify(p) !== JSON.stringify(project)
  const set = <K extends keyof Project>(k: K, v: Project[K]) => setP((x) => ({ ...x, [k]: v }))

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
            <input className="input" value={p.name} onChange={(e) => set('name', e.target.value)} />
          </Field>
          <Field label={t.office.budget} hint={t.office.budgetHint}>
            <input className="input num" type="number" min={0} step={0.5} value={p.budgetUsd} onChange={(e) => set('budgetUsd', Math.max(0, Number(e.target.value)))} />
          </Field>
        </div>
        <FolderField value={p.workspaceDir} onChange={(v) => set('workspaceDir', v)} />
        <Field label={t.office.briefing} hint={t.office.briefingHint}>
          <textarea className="textarea" rows={10} value={p.briefing} onChange={(e) => set('briefing', e.target.value)} placeholder={t.office.briefingPlaceholder} />
        </Field>
      </div>

      <div className="section">
        <div className="section-head">
          <div>
            <h3>{t.office.commands}</h3>
            <p>{t.office.commandsHint}</p>
          </div>
        </div>
        <div className="stack tight">
          <div className="seg">
            <button className={p.approval === 'ask' ? 'on' : ''} onClick={() => set('approval', 'ask')}>{t.office.ask}</button>
            <button className={p.approval === 'auto' ? 'on' : ''} onClick={() => set('approval', 'auto')}>{t.office.auto}</button>
          </div>
          {p.approval === 'auto' && <div className="note warn">{t.office.autoWarn}</div>}
        </div>
      </div>

      <div className="section">
        <div className="list">
          <div className="list-row">
            <div className="spacer">
              <div style={{ fontWeight: 600 }}>{t.office.danger}</div>
              <div className="muted small">{t.office.dangerHint}</div>
            </div>
            <ConfirmButton onConfirm={onDelete}>{t.common.delete}</ConfirmButton>
          </div>
        </div>
      </div>

      {dirty && (
        <div className="savebar inline" role="status">
          {t.common.unsaved}
          <button className="btn quiet sm" onClick={() => setP(project)}>{t.common.discard}</button>
          <button className="btn primary sm" onClick={async () => { await onSave(p); notify(t.common.saved) }}>{t.common.save}</button>
        </div>
      )}
    </div>
  )
}

export function NewProject({ providers, onClose, onCreate, onProviders }: { providers: Provider[]; onClose(): void; onCreate(p: Project): void; onProviders(): void }) {
  const t = useT()
  const usable = providers.filter((p) => p.hasKey || p.baseURL.includes('localhost'))
  const [name, setName] = useState('')
  const [tpl, setTpl] = useState(0)
  const [providerId, setProviderId] = useState(usable[0]?.id ?? '')
  const [model, setModel] = useState('')
  const [dir, setDir] = useState('')
  const [err, setErr] = useState('')

  if (!usable.length) {
    return (
      <Modal title={t.office.newTitle} onClose={onClose}>
        <Empty icon="key" title={t.office.needProvider} body={t.office.needProviderBody}>
          <button className="btn primary" onClick={onProviders}>{t.providers.add}</button>
        </Empty>
      </Modal>
    )
  }

  const create = () => {
    if (!name.trim()) return setErr(t.office.errName)
    if (!dir.trim()) return setErr(t.office.errFolder)
    if (!providerId || !model.trim()) return setErr(t.office.errModel)
    const agents = TEMPLATES[tpl].build(t.names, providerId, model.trim())
    onCreate({ id: uid(), name: name.trim(), workspaceDir: dir.trim(), briefing: '', approval: 'ask', budgetUsd: 5, agents })
  }

  return (
    <Modal
      title={t.office.newTitle}
      onClose={onClose}
      width={600}
      footer={
        <>
          <button className="btn" onClick={onClose}>{t.common.cancel}</button>
          <button className="btn primary" onClick={create}>{t.office.create}</button>
        </>
      }
    >
      <div className="stack">
        <Field label={t.office.name}>
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t.office.namePlaceholder} />
        </Field>
        <FolderField value={dir} onChange={setDir} />
        <Field label={t.office.template} hint={t.office.templateHint}>
          <div className="stack tight">
            {TEMPLATES.map((tp, i) => {
              const [title, desc] = t.templates[tp.id]
              return (
                <button key={tp.id} type="button" className={`choice ${tpl === i ? 'on' : ''}`} onClick={() => setTpl(i)}>
                  <div>
                    <div className="t">{title}</div>
                    <div className="d">{desc}</div>
                  </div>
                </button>
              )
            })}
          </div>
        </Field>
        <div className="grid2">
          <Field label={t.office.defaultProvider}>
            <select className="select" value={providerId} onChange={(e) => setProviderId(e.target.value)}>
              {usable.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
          <Field label={t.office.defaultModel} hint={t.office.defaultModelHint}>
            <ModelInput providerId={providerId} value={model} onChange={setModel} />
          </Field>
        </div>
        {err && <div className="note danger" role="alert">{err}</div>}
      </div>
    </Modal>
  )
}
