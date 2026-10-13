import { useEffect, useState } from 'react'
import type { Provider } from '../../shared/types'
import Extensions from './Extensions'
import { LANGS, setLang, useT, getLang, type Lang } from './i18n'
import Providers from './Providers'
import { Icon, Mark, type IconName } from './ui'

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
      <nav className="prefs-nav">
        {items.map(([id, label, icon]) => (
          <button key={id} className={`rail-item ${tab === id ? 'on' : ''}`} onClick={() => onTab(id)}>
            <Icon name={icon} />
            <span className="label">{label}</span>
          </button>
        ))}
      </nav>
      <div className="prefs-body">
        {tab === 'providers' && <Providers providers={providers} onChange={onProviders} notify={notify} />}
        {tab === 'extensions' && <Extensions notify={notify} />}
        {tab === 'general' && <General />}
      </div>
    </div>
  )
}

function General() {
  const t = useT()
  const [info, setInfo] = useState<{ version: string } | null>(null)
  useEffect(() => {
    void window.office.appInfo().then(setInfo)
  }, [])
  return (
    <div className="page">
      <div className="page-head">
        <h2>{t.prefs.general}</h2>
      </div>
      <div className="list">
        <div className="list-row">
          <div className="spacer">
            <div style={{ fontWeight: 600 }}>{t.prefs.language}</div>
            <div className="muted small">{t.prefs.languageHint}</div>
          </div>
          <div className="seg">
            {(Object.keys(LANGS) as Lang[]).map((l) => (
              <button key={l} className={getLang() === l ? 'on' : ''} onClick={() => setLang(l)}>{LANGS[l].lang}</button>
            ))}
          </div>
        </div>
        <div className="list-row">
          <div className="spacer">
            <div style={{ fontWeight: 600 }}>{t.prefs.theme}</div>
            <div className="muted small">{t.prefs.themeHint}</div>
          </div>
        </div>
      </div>

      <div className="section">
        <div className="list">
          <div className="list-row">
            <Mark size={32} />
            <div className="spacer">
              <div style={{ fontWeight: 600 }}>AI Office</div>
              <div className="muted small">{info ? t.prefs.version(info.version) : ''} · {t.prefs.license}</div>
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
