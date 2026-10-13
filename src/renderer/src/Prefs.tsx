import { useCallback, useEffect, useId, useState, type ReactNode } from 'react'
import type { AppSettings, Provider, UpdateInfo } from '../../shared/types'
import Extensions from './Extensions'
import { errText, LANGS, setLang, useT, getLang, type Lang } from './i18n'
import Providers from './Providers'
import { httpsUrl, parseUsd, updateState, withDefaults } from './shellUtils'
import { Field, Icon, Mark, Switch, type IconName } from './ui'

export type PrefsTab = 'providers' | 'extensions' | 'general'

interface Props {
  tab: PrefsTab
  onTab(t: PrefsTab): void
  providers: Provider[]
  onProviders(): void
  notify(t: string): void
}

export default function Prefs({ tab, onTab, providers, onProviders, notify }: Props) {
  const t = useT()
  const items: [PrefsTab, string, IconName][] = [
    ['providers', t.prefs.providers, 'key'],
    ['extensions', t.prefs.extensions, 'puzzle'],
    ['general', t.prefs.general, 'sliders']
  ]
  return (
    <div className="prefs">
      <nav className="prefs-nav" aria-label={t.prefs.title}>
        {items.map(([id, label, icon]) => (
          <button key={id} className={`rail-item ${tab === id ? 'on' : ''}`} aria-current={tab === id ? 'page' : undefined} onClick={() => onTab(id)}>
            <Icon name={icon} />
            <span className="label">{label}</span>
          </button>
        ))}
      </nav>
      <div className="prefs-body">
        {tab === 'providers' && <Providers providers={providers} onChange={onProviders} notify={notify} />}
        {tab === 'extensions' && <Extensions notify={notify} />}
        {tab === 'general' && <General notify={notify} />}
      </div>
    </div>
  )
}

const THEMES: [AppSettings['theme'], IconName][] = [
  ['system', 'monitor'],
  ['light', 'sun'],
  ['dark', 'moon']
]

function General({ notify }: { notify(t: string): void }) {
  const t = useT()
  const s = t.shell
  const [info, setInfo] = useState<{ version: string } | null>(null)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [loadErr, setLoadErr] = useState('')

  const load = useCallback(
    () =>
      window.office.getSettings().then(
        (v) => {
          setSettings(withDefaults(v))
          setLoadErr('')
        },
        (e) => setLoadErr(errText(e))
      ),
    []
  )

  useEffect(() => {
    void window.office.appInfo().then(setInfo, () => undefined)
    void load()
  }, [load])

  const save = async (patch: Partial<AppSettings>) => {
    if (!settings) return
    const next = { ...settings, ...patch }
    setSettings(next)
    try {
      await window.office.saveSettings(next)
    } catch (e) {
      notify(errText(e, t))
      // Show what is really saved, not what failed to save.
      await window.office.getSettings().then((v) => setSettings(withDefaults(v)), () => setSettings(settings))
    }
  }

  const row = (title: string, hint: string, control: ReactNode) => (
    <div className="list-row">
      <div className="spacer">
        <div style={{ fontWeight: 600 }}>{title}</div>
        <div className="muted small">{hint}</div>
      </div>
      {control}
    </div>
  )

  return (
    <div className="page">
      <div className="page-head">
        <h2>{t.prefs.general}</h2>
      </div>
      <div className="list">
        {row(
          t.prefs.language,
          t.prefs.languageHint,
          <div className="seg" role="group" aria-label={t.prefs.language}>
            {(Object.keys(LANGS) as Lang[]).map((l) => (
              <button key={l} type="button" className={getLang() === l ? 'on' : ''} aria-pressed={getLang() === l} onClick={() => setLang(l)}>
                {LANGS[l].lang}
              </button>
            ))}
          </div>
        )}
        {settings && (
          <>
            {row(
              t.prefs.theme,
              s.themeHint,
              <div className="seg" role="group" aria-label={t.prefs.theme}>
                {THEMES.map(([id, icon]) => (
                  <button key={id} type="button" className={`seg-icon ${settings.theme === id ? 'on' : ''}`} aria-pressed={settings.theme === id} onClick={() => settings.theme !== id && void save({ theme: id })}>
                    <Icon name={icon} size={14} />
                    {s.themes[id]}
                  </button>
                ))}
              </div>
            )}
            {row(s.notifications, s.notificationsHint, <Switch on={settings.notifications} label={s.notifications} onChange={(on) => void save({ notifications: on })} />)}
          </>
        )}
        {!settings && !loadErr && <div className="list-empty" role="status">{s.loading}</div>}
        {loadErr && (
          <div className="list-row">
            <div className="spacer note danger" role="alert">
              {s.settingsFailed} {loadErr}
            </div>
            <button className="btn sm" onClick={() => void load()}>
              <Icon name="refresh" size={13} /> {s.retry}
            </button>
          </div>
        )}
      </div>

      {settings && (
        <>
          <section className="section">
            <div className="section-head">
              <div>
                <h3>{s.caps}</h3>
                <p>{s.capsHint}</p>
              </div>
            </div>
            <Caps settings={settings} onSave={(dailyCapUsd, monthlyCapUsd) => save({ dailyCapUsd, monthlyCapUsd })} />
          </section>

          <section className="section">
            <div className="list">
              {row(s.updates, s.updatesHint, <Switch on={settings.checkUpdates} label={s.updates} onChange={(on) => void save({ checkUpdates: on })} />)}
              <UpdateCheck />
            </div>
          </section>
        </>
      )}

      <div className="section">
        <div className="list">
          <div className="list-row">
            <Mark size={32} />
            <div className="spacer">
              <div style={{ fontWeight: 600 }}>AI Office</div>
              <div className="muted small">{info ? `${t.prefs.version(info.version)} · ` : ''}{t.prefs.license}</div>
            </div>
            <a className="btn sm" href="https://github.com/NeoCode-02/ai-office" target="_blank" rel="noreferrer">
              {t.prefs.source} <Icon name="external" size={12} />
            </a>
          </div>
        </div>
      </div>
    </div>
  )
}

/** Daily and monthly caps. Not remounted on save, so typed values survive a failed save. */
function Caps({ settings, onSave }: { settings: AppSettings; onSave(day: number, month: number): Promise<void> }) {
  const t = useT()
  const s = t.shell
  const [day, setDay] = useState(settings.dailyCapUsd ? String(settings.dailyCapUsd) : '')
  const [month, setMonth] = useState(settings.monthlyCapUsd ? String(settings.monthlyCapUsd) : '')
  const [busy, setBusy] = useState(false)
  const errId = useId()
  const d = parseUsd(day)
  const m = parseUsd(month)
  const invalid = d === null || m === null
  const dirty = d !== settings.dailyCapUsd || m !== settings.monthlyCapUsd

  const submit = async () => {
    if (invalid || !dirty) return
    setBusy(true)
    await onSave(d, m)
    setBusy(false)
  }

  return (
    <form
      className="panel panel-pad stack"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <div className="grid2">
        <Field label={s.dailyCap}>
          <input className="input num" inputMode="decimal" value={day} placeholder="0" onChange={(e) => setDay(e.target.value)} aria-invalid={d === null} aria-describedby={invalid ? errId : undefined} />
        </Field>
        <Field label={s.monthlyCap}>
          <input className="input num" inputMode="decimal" value={month} placeholder="0" onChange={(e) => setMonth(e.target.value)} aria-invalid={m === null} aria-describedby={invalid ? errId : undefined} />
        </Field>
      </div>
      {invalid && (
        <div className="note danger" id={errId} role="alert">
          {s.capsInvalid}
        </div>
      )}
      <div className="row">
        <span className="spacer" />
        <button type="submit" className="btn primary sm" disabled={invalid || !dirty || busy}>
          {busy ? t.common.saving : t.common.save}
        </button>
      </div>
    </form>
  )
}

function UpdateCheck() {
  const t = useT()
  const s = t.shell
  const [state, setState] = useState<{ busy: boolean; info?: UpdateInfo; err?: string }>({ busy: false })

  const check = async () => {
    setState({ busy: true })
    try {
      setState({ busy: false, info: await window.office.checkUpdate() })
    } catch (e) {
      setState({ busy: false, err: errText(e, t) })
    }
  }

  const info = state.info
  const kind = info && updateState(info)
  const url = info && httpsUrl(info.url)
  return (
    <div className="list-row">
      <div className="spacer small" aria-live="polite">
        {state.busy ? (
          <span className="muted">{s.checking}</span>
        ) : state.err ? (
          <span className="danger-text">{state.err}</span>
        ) : info && kind === 'newer' ? (
          <span className="row">
            <strong>{s.newer(info.latest ?? '')}</strong>
            {url && (
              <a href={url} target="_blank" rel="noreferrer">
                {s.download} <Icon name="external" size={11} />
              </a>
            )}
          </span>
        ) : info && kind === 'latest' ? (
          <span className="muted">{s.upToDate(info.current)}</span>
        ) : info ? (
          <span className="muted">{s.noReleases}</span>
        ) : null}
      </div>
      <button className="btn sm" onClick={() => void check()} disabled={state.busy}>
        <Icon name="refresh" size={13} /> {state.busy ? s.checking : s.checkNow}
      </button>
    </div>
  )
}
