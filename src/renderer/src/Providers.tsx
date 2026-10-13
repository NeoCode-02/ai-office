import { useEffect, useState } from 'react'
import type { Preset } from '../../main/providers'
import type { Provider } from '../../shared/types'
import { errText, useT } from './i18n'
import { uid } from './roles'
import { ConfirmButton, Empty, Field, hue, Icon, Modal } from './ui'

const BRAND: Record<string, string> = {
  anthropic: '#c96442',
  openai: '#10a37f',
  google: '#4285f4',
  deepseek: '#4d6bfe',
  kimi: '#27272a',
  glm: '#2d5bff',
  openrouter: '#6467f2',
  xai: '#3f3f46',
  mistral: '#fa520f',
  groq: '#f55036',
  ollama: '#52525b'
}

export function Logo({ name }: { name: string }) {
  const key = name.split(/[\s(]/)[0].toLowerCase()
  return (
    <span className="logo" style={{ background: BRAND[key] ?? `hsl(${hue(key)} 35% 42%)` }}>
      {name[0]?.toUpperCase()}
    </span>
  )
}

interface Props {
  providers: Provider[]
  onChange(): void
  notify(t: string): void
}

export default function Providers({ providers, onChange, notify }: Props) {
  const t = useT()
  const [edit, setEdit] = useState<Provider | 'new' | null>(null)
  const [testing, setTesting] = useState<string | null>(null)

  const test = async (p: Provider) => {
    setTesting(p.id)
    try {
      notify(t.providers.ok(p.name, (await window.office.listModels(p.id)).length))
    } catch (e) {
      notify(`${p.name}: ${errText(e, t)}`)
    } finally {
      setTesting(null)
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>{t.prefs.providers}</h2>
          <p>{t.providers.subtitle}</p>
        </div>
        {providers.length > 0 && (
          <button className="btn primary" onClick={() => setEdit('new')}>
            <Icon name="plus" size={14} /> {t.providers.add}
          </button>
        )}
      </div>

      {providers.length === 0 ? (
        <div className="list">
          <Empty icon="key" title={t.providers.none} body={t.providers.noneBody}>
            <button className="btn primary" onClick={() => setEdit('new')}>
              <Icon name="plus" size={14} /> {t.providers.add}
            </button>
          </Empty>
        </div>
      ) : (
        <div className="list">
          {providers.map((p) => (
            <div key={p.id} className="list-row">
              <Logo name={p.name} />
              <div className="spacer ellipsis">
                <div style={{ fontWeight: 600 }}>{p.name}</div>
                <div className="faint small mono ellipsis">{p.baseURL || 'api.anthropic.com'}</div>
              </div>
              {p.hasKey ? <span className="tag ok"><Icon name="check" size={11} /> {t.providers.keySaved}</span> : <span className="tag">{t.providers.noKey}</span>}
              <button className="btn sm" onClick={() => test(p)} disabled={testing === p.id}>
                {testing === p.id ? t.common.testing : t.common.test}
              </button>
              <button className="btn quiet icon sm" onClick={() => setEdit(p)} aria-label={`${t.common.edit} ${p.name}`} title={t.common.edit}>
                <Icon name="edit" size={14} />
              </button>
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
  const t = useT()
  const [presets, setPresets] = useState<Preset[]>([])
  const [preset, setPreset] = useState<Preset | null>(null)
  const [custom, setCustom] = useState(false)
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
    setCustom(!p)
    setName(p?.name ?? '')
    setBaseURL(p?.baseURL ?? '')
    setKind(p?.kind ?? 'openai')
    setErr('')
  }

  const save = async () => {
    if (!name.trim()) return setErr(t.providers.errName)
    if (kind === 'openai' && !/^https?:\/\//.test(baseURL)) return setErr(t.providers.errUrl)
    if (!initial && !key.trim() && !baseURL.includes('localhost')) return setErr(t.providers.errKey)
    setBusy(true)
    try {
      await window.office.saveProvider(
        { id: initial?.id ?? uid(), name: name.trim(), kind, baseURL: baseURL.trim(), billing: initial?.billing ?? { mode: 'payg' }, prices: initial?.prices ?? {} },
        key.trim()
      )
      onSaved()
    } catch (e) {
      setErr(errText(e, t))
      setBusy(false)
    }
  }

  const showForm = Boolean(initial || preset || custom)

  return (
    <Modal
      title={initial ? initial.name : t.providers.add}
      onClose={onClose}
      width={600}
      footer={
        <>
          {initial && (
            <span className="spacer">
              <ConfirmButton
                onConfirm={async () => {
                  await window.office.deleteProvider(initial.id)
                  onSaved()
                }}
              >
                {t.common.delete}
              </ConfirmButton>
            </span>
          )}
          <button className="btn" onClick={onClose}>{t.common.cancel}</button>
          <button className="btn primary" onClick={save} disabled={busy || !showForm}>
            {busy ? t.common.saving : t.common.save}
          </button>
        </>
      }
    >
      <div className="stack">
        {!initial && (
          <div className="presets">
            {presets.map((p) => (
              <button key={p.name} className={`preset ${preset?.name === p.name ? 'on' : ''}`} onClick={() => pick(p)}>
                <Logo name={p.name} />
                <span className="ellipsis">{p.name}</span>
              </button>
            ))}
            <button className={`preset ${custom ? 'on' : ''}`} onClick={() => pick(null)}>
              <span className="logo" style={{ background: 'var(--sunken)', color: 'var(--text-2)' }}>
                <Icon name="plus" size={13} />
              </span>
              {t.providers.custom}
            </button>
          </div>
        )}

        {showForm && (
          <>
            {(custom || initial) && (
              <div className="grid2">
                <Field label={t.providers.name}>
                  <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
                </Field>
                <Field label={t.providers.apiType}>
                  <select className="select" value={kind} onChange={(e) => setKind(e.target.value as Provider['kind'])}>
                    <option value="openai">OpenAI-compatible</option>
                    <option value="anthropic">Anthropic</option>
                  </select>
                </Field>
              </div>
            )}
            {(custom || initial) && (
              <Field label={t.providers.baseUrl} hint={kind === 'anthropic' ? t.providers.baseUrlHint : undefined}>
                <input className="input mono" value={baseURL} onChange={(e) => setBaseURL(e.target.value)} placeholder="https://…/v1" />
              </Field>
            )}
            <Field
              label={t.providers.key}
              hint={
                initial?.hasKey ? t.providers.keyKeep : preset?.keyUrl ? (
                  <a href={preset.keyUrl} target="_blank" rel="noreferrer">
                    {t.providers.getKey} <Icon name="external" size={11} />
                  </a>
                ) : undefined
              }
            >
              <input className="input mono" type="password" autoFocus value={key} onChange={(e) => setKey(e.target.value)} placeholder={initial?.hasKey ? '••••••••' : 'sk-…'} autoComplete="off" />
            </Field>
          </>
        )}
        {err && <div className="note danger" role="alert">{err}</div>}
      </div>
    </Modal>
  )
}
