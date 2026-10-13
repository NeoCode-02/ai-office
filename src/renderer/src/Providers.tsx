import { useEffect, useState } from 'react'
import type { Provider } from '../../shared/types'
import type { Preset } from '../../main/providers'
import { uid } from './roles'
import { errText, Field, hue, Icon, Modal } from './ui'

const BRAND: Record<string, string> = {
  anthropic: '#d97757',
  openai: '#10a37f',
  google: '#4285f4',
  deepseek: '#4d6bfe',
  kimi: '#1f2937',
  glm: '#2d5bff',
  openrouter: '#6467f2',
  xai: '#374151',
  mistral: '#fa520f',
  groq: '#f55036',
  ollama: '#6b7280'
}

export function Logo({ name, size }: { name: string; size?: number }) {
  const key = name.split(/[\s(]/)[0].toLowerCase()
  const h = hue(key)
  const bg = BRAND[key] ?? `hsl(${h} 55% 48%)`
  return (
    <div className="logo" style={{ background: bg, ...(size ? { width: size, height: size } : {}) }}>
      {name[0]}
    </div>
  )
}

interface Props {
  providers: Provider[]
  onChange(): void
  notify(t: string): void
}

export default function Providers({ providers, onChange, notify }: Props) {
  const [edit, setEdit] = useState<Provider | 'new' | null>(null)
  const [testing, setTesting] = useState<string | null>(null)

  const test = async (p: Provider) => {
    setTesting(p.id)
    try {
      const models = await window.office.listModels(p.id)
      notify(`${p.name}: ulanish ishlayapti, ${models.length} ta model`)
    } catch (e) {
      notify(`${p.name}: ${errText(e)}`)
    } finally {
      setTesting(null)
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>AI provayderlar</h2>
          <p>Kalitlar faqat shu kompyuterda, Windows shifrlashi (DPAPI) bilan saqlanadi.</p>
        </div>
        <button className="btn primary" onClick={() => setEdit('new')}>
          <Icon name="plus" /> Provayder qo‘shish
        </button>
      </div>

      {providers.length === 0 ? (
        <div className="card empty">
          <div className="empty-icon">
            <Icon name="key" size={24} />
          </div>
          <h3>Hali provayder yo‘q</h3>
          <p style={{ maxWidth: 420, margin: '0 0 16px' }}>Kamida bitta AI provayderning API kalitini qo‘shing. Bitta provayder modelini istalgancha xodimga berish mumkin.</p>
          <button className="btn primary" onClick={() => setEdit('new')}>
            <Icon name="plus" /> Provayder qo‘shish
          </button>
        </div>
      ) : (
        <div className="prov-grid">
          {providers.map((p) => (
            <div key={p.id} className="card prov">
              <div className="row">
                <Logo name={p.name} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 650 }}>{p.name}</div>
                  <div className="faint small mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {p.baseURL || 'api.anthropic.com'}
                  </div>
                </div>
              </div>
              <div className="row">
                {p.hasKey ? <span className="badge ok"><Icon name="check" size={12} /> Kalit saqlangan</span> : <span className="badge warn">Kalit yo‘q</span>}
                <span className="badge">{p.kind === 'anthropic' ? 'Anthropic API' : 'OpenAI-compatible'}</span>
              </div>
              <div className="row">
                <button className="btn sm" onClick={() => test(p)} disabled={testing === p.id}>
                  <Icon name="zap" size={14} /> {testing === p.id ? 'Tekshirilmoqda…' : 'Tekshirish'}
                </button>
                <button className="btn sm ghost" onClick={() => setEdit(p)}>
                  <Icon name="edit" size={14} /> Tahrirlash
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {edit && (
        <ProviderModal
          initial={edit === 'new' ? null : edit}
          onClose={() => setEdit(null)}
          onSaved={() => {
            setEdit(null)
            onChange()
          }}
        />
      )}
    </div>
  )
}

function ProviderModal({ initial, onClose, onSaved }: { initial: Provider | null; onClose(): void; onSaved(): void }) {
  const [presets, setPresets] = useState<Preset[]>([])
  const [preset, setPreset] = useState<Preset | null>(null)
  const [name, setName] = useState(initial?.name ?? '')
  const [baseURL, setBaseURL] = useState(initial?.baseURL ?? '')
  const [kind, setKind] = useState(initial?.kind ?? 'openai')
  const [key, setKey] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.office.presets().then(setPresets)
  }, [])

  const pick = (p: Preset | null) => {
    setPreset(p)
    setName(p?.name ?? 'Custom')
    setBaseURL(p?.baseURL ?? '')
    setKind(p?.kind ?? 'openai')
  }

  const save = async () => {
    if (!name.trim()) return setErr('Nom kiriting')
    if (kind === 'openai' && !/^https?:\/\//.test(baseURL)) return setErr('Base URL http(s):// bilan boshlanishi kerak')
    if (!initial && !key.trim() && !baseURL.includes('localhost')) return setErr('API kalitni kiriting')
    setBusy(true)
    const id = initial?.id ?? uid()
    try {
      await window.office.saveProvider({ id, name: name.trim(), kind, baseURL: baseURL.trim() }, key.trim())
      onSaved()
    } catch (e) {
      setErr(errText(e))
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!initial || !confirm(`${initial.name} o‘chirilsinmi? Undan foydalanayotgan xodimlar ishlamay qoladi.`)) return
    await window.office.deleteProvider(initial.id)
    onSaved()
  }

  const showForm = initial || preset || name

  return (
    <Modal
      title={initial ? `${initial.name}` : 'Provayder qo‘shish'}
      onClose={onClose}
      width={620}
      footer={
        <>
          {initial && (
            <button className="btn danger ghost" onClick={remove} style={{ marginRight: 'auto' }}>
              <Icon name="trash" size={14} /> O‘chirish
            </button>
          )}
          <button className="btn" onClick={onClose}>Bekor qilish</button>
          <button className="btn primary" onClick={save} disabled={busy || !showForm}>
            {busy ? 'Saqlanmoqda…' : 'Saqlash'}
          </button>
        </>
      }
    >
      <div className="stack">
        {!initial && (
          <div className="preset-grid">
            {presets.map((p) => (
              <button key={p.name} className={`preset ${preset?.name === p.name ? 'on' : ''}`} onClick={() => pick(p)}>
                <Logo name={p.name} />
                {p.name}
              </button>
            ))}
            <button className={`preset ${showForm && !preset ? 'on' : ''}`} onClick={() => pick(null)}>
              <div className="logo" style={{ background: 'var(--text-3)' }}>
                <Icon name="plus" size={14} />
              </div>
              Boshqa (custom)
            </button>
          </div>
        )}

        {showForm && (
          <>
            <div className="grid2">
              <Field label="Nomi">
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
              <Field label="API turi">
                <select className="select" value={kind} onChange={(e) => setKind(e.target.value as Provider['kind'])}>
                  <option value="openai">OpenAI-compatible</option>
                  <option value="anthropic">Anthropic</option>
                </select>
              </Field>
            </div>
            <Field label="Base URL" hint={kind === 'anthropic' ? 'Bo‘sh qoldirsangiz — rasmiy Anthropic API' : undefined}>
              <input className="input mono" value={baseURL} onChange={(e) => setBaseURL(e.target.value)} placeholder="https://…/v1" />
            </Field>
            <Field
              label="API kalit"
              hint={
                <>
                  {initial?.hasKey ? 'Saqlangan kalit bor — almashtirish uchun yangisini kiriting. ' : ''}
                  {preset?.keyUrl && (
                    <a href={preset.keyUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--accent-text)' }}>
                      Kalitni qayerdan olish <Icon name="external" size={11} />
                    </a>
                  )}
                </>
              }
            >
              <input className="input mono" type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={initial?.hasKey ? '••••••••' : 'sk-…'} autoComplete="off" />
            </Field>
          </>
        )}
        {err && <div className="alert">{err}</div>}
      </div>
    </Modal>
  )
}
