import { useState } from 'react'
import type { Project, Provider } from '../../shared/types'
import { ModelInput } from './Team'
import { KNOWN_PRICES, TEMPLATES, uid } from './roles'
import { Field, Icon, Modal } from './ui'

export function FolderField({ value, onChange }: { value: string; onChange(v: string): void }) {
  return (
    <Field label="Ish papkasi (workspace)" hint="Xodimlar faqat shu papka ichida fayl o‘qiydi va yozadi.">
      <div className="row">
        <input className="input mono" value={value} onChange={(e) => onChange(e.target.value)} placeholder="D:\loyihalar\mening-ishim" />
        <button className="btn" type="button" onClick={async () => { const d = await window.office.pickFolder(); if (d) onChange(d) }}>
          <Icon name="folder" size={15} /> Tanlash
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
  const [p, setP] = useState(project)
  const dirty = JSON.stringify(p) !== JSON.stringify(project)
  const set = <K extends keyof Project>(k: K, v: Project[K]) => setP((x) => ({ ...x, [k]: v }))

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>Ofis sozlamalari</h2>
          <p>Brifing — har bir xodim ishga kirganda o‘qiydigan kompaniya haqidagi to‘liq ma’lumot.</p>
        </div>
        <button className="btn primary" disabled={!dirty} onClick={async () => { await onSave(p); notify('Saqlandi') }}>
          <Icon name="check" /> Saqlash
        </button>
      </div>

      <div className="stack">
        <div className="card card-pad stack">
          <div className="grid2">
            <Field label="Ofis nomi">
              <input className="input" value={p.name} onChange={(e) => set('name', e.target.value)} />
            </Field>
            <Field label="Byudjet (USD, har bir vazifa uchun)" hint="0 — cheklovsiz. Tugaganda ish avtomatik to‘xtaydi.">
              <input className="input" type="number" min={0} step={0.5} value={p.budgetUsd} onChange={(e) => set('budgetUsd', Math.max(0, Number(e.target.value)))} />
            </Field>
          </div>
          <FolderField value={p.workspaceDir} onChange={(v) => set('workspaceDir', v)} />
          <Field label="Kompaniya brifingi" hint="Nima qilasiz, mijozlar kim, texnologiyalar, qoidalar, sifat talablari. Qancha aniq bo‘lsa, natija shuncha yaxshi.">
            <textarea className="textarea" rows={12} value={p.briefing} onChange={(e) => set('briefing', e.target.value)} placeholder={'Masalan:\nBiz — o‘zbek tilidagi ta’lim platformasi. Stack: Next.js + PostgreSQL.\nKod sifati: testlar majburiy, TypeScript strict.\nMijozlar: maktab o‘quvchilari va o‘qituvchilar.'} />
          </Field>
        </div>

        <div className="card card-pad stack">
          <div>
            <div style={{ fontWeight: 650 }}>Terminal buyruqlari</div>
            <div className="muted small">Xodimlar ish papkasida buyruq (build, test, git…) ishga tushirishidan oldin.</div>
          </div>
          <div className="seg">
            <button className={p.approval === 'ask' ? 'on' : ''} onClick={() => set('approval', 'ask')}>Har safar so‘rasin</button>
            <button className={p.approval === 'auto' ? 'on' : ''} onClick={() => set('approval', 'auto')}>Avtomatik ruxsat</button>
          </div>
          {p.approval === 'auto' && (
            <div className="alert warn">
              Avtomatik rejimda xodimlar buyruqlarni sizsiz ishga tushiradi. Bu sandbox emas: buyruq butun kompyuterga ta’sir qilishi mumkin. Faqat ishonchli vazifalar uchun yoqing.
            </div>
          )}
        </div>

        <div className="card card-pad row">
          <div>
            <div style={{ fontWeight: 650 }}>Ofisni o‘chirish</div>
            <div className="muted small">Jamoa, tarix va eslatmalar o‘chadi. Ish papkasidagi fayllarga tegilmaydi.</div>
          </div>
          <div className="spacer" />
          <button className="btn danger" onClick={() => confirm(`"${project.name}" o‘chirilsinmi?`) && onDelete()}>
            <Icon name="trash" size={14} /> O‘chirish
          </button>
        </div>
      </div>
    </div>
  )
}

export function NewProject({ providers, onClose, onCreate, onProviders }: { providers: Provider[]; onClose(): void; onCreate(p: Project): void; onProviders(): void }) {
  const usable = providers.filter((p) => p.hasKey || p.baseURL.includes('localhost'))
  const [name, setName] = useState('')
  const [tpl, setTpl] = useState(0)
  const [providerId, setProviderId] = useState(usable[0]?.id ?? '')
  const [model, setModel] = useState('')
  const [dir, setDir] = useState('')
  const [err, setErr] = useState('')

  const create = () => {
    if (!name.trim()) return setErr('Ofis nomini kiriting')
    if (!dir) return setErr('Ish papkasini tanlang')
    if (!providerId || !model.trim()) return setErr('Standart provayder va modelni tanlang')
    const [pin, pout] = KNOWN_PRICES[model.trim()] ?? [0, 0]
    const agents = TEMPLATES[tpl].build(providerId, model.trim()).map((a) => ({ ...a, priceIn: pin, priceOut: pout }))
    onCreate({ id: uid(), name: name.trim(), workspaceDir: dir, briefing: '', approval: 'ask', budgetUsd: 5, agents })
  }

  if (!usable.length) {
    return (
      <Modal title="Yangi ofis" onClose={onClose}>
        <div className="empty" style={{ padding: 24 }}>
          <div className="empty-icon"><Icon name="key" size={24} /></div>
          <h3>Avval provayder ulang</h3>
          <p style={{ margin: '0 0 16px' }}>Xodimlar ishlashi uchun kamida bitta AI provayder kaliti kerak.</p>
          <button className="btn primary" onClick={onProviders}>Provayder qo‘shish</button>
        </div>
      </Modal>
    )
  }

  return (
    <Modal
      title="Yangi ofis"
      onClose={onClose}
      width={620}
      footer={
        <>
          <button className="btn" onClick={onClose}>Bekor qilish</button>
          <button className="btn primary" onClick={create}>Yaratish</button>
        </>
      }
    >
      <div className="stack">
        <Field label="Ofis nomi">
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Masalan: Startap studiyasi" />
        </Field>
        <Field label="Jamoa shabloni" hint="Keyin istalgan xodimni qo‘shish, o‘chirish, lavozimini va modelini almashtirish mumkin.">
          <div className="stack" style={{ gap: 6 }}>
            {TEMPLATES.map((t, i) => (
              <label key={t.name} className={`check ${tpl === i ? 'on' : ''}`} style={{ padding: '10px 12px' }}>
                <input type="radio" name="tpl" checked={tpl === i} onChange={() => setTpl(i)} />
                <div>
                  <div style={{ fontWeight: 600 }}>{t.name}</div>
                  <div className="faint small">{t.description}</div>
                </div>
              </label>
            ))}
          </div>
        </Field>
        <div className="grid2">
          <Field label="Standart provayder">
            <select className="select" value={providerId} onChange={(e) => setProviderId(e.target.value)}>
              {usable.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
          <Field label="Standart model" hint="Hammaga beriladi; keyin har biriga alohida tanlaysiz.">
            <ModelInput providerId={providerId} value={model} onChange={setModel} />
          </Field>
        </div>
        <FolderField value={dir} onChange={setDir} />
        {err && <div className="alert">{err}</div>}
      </div>
    </Modal>
  )
}
