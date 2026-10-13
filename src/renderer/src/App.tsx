import { useCallback, useEffect, useState } from 'react'
import type { OfficeEvent, Project, Provider } from '../../shared/types'
import { useT } from './i18n'
import Prefs, { type PrefsTab } from './Prefs'
import Settings, { NewProject } from './Settings'
import Team from './Team'
import { Icon, Mark, type IconName } from './ui'
import Usage from './Usage'
import Work from './Work'

export interface Live {
  runId: string
  events: OfficeEvent[]
}
type Tab = 'work' | 'team' | 'settings'

export default function App() {
  const t = useT()
  const [providers, setProviders] = useState<Provider[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [sel, setSel] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('work')
  const [prefs, setPrefs] = useState<PrefsTab | null>(null)
  const [usage, setUsage] = useState(false)
  const [live, setLive] = useState<Record<string, Live>>({})
  const [creating, setCreating] = useState(false)
  const [toast, setToast] = useState('')
  const [ready, setReady] = useState(false)

  const notify = useCallback((msg: string) => {
    setToast(msg)
    setTimeout(() => setToast((x) => (x === msg ? '' : x)), 3500)
  }, [])

  const reload = useCallback(async () => {
    const [pv, pj] = await Promise.all([window.office.listProviders(), window.office.listProjects()])
    setProviders(pv)
    setProjects(pj)
    return pj
  }, [])

  useEffect(() => {
    void (async () => {
      const pj = await reload()
      setSel((s) => s ?? pj[0]?.id ?? null)
      // Re-attach to runs still alive in the main process (e.g. after a reload).
      for (const p of pj) {
        const runId = await window.office.activeRun(p.id)
        if (runId) {
          const events = await window.office.readRun(p.id, runId)
          setLive((l) => ({ ...l, [p.id]: { runId, events } }))
        }
      }
      setReady(true)
    })()
    return window.office.onEvent((projectId, runId, ev) =>
      setLive((l) => {
        const cur = l[projectId]
        return { ...l, [projectId]: { runId, events: cur?.runId === runId ? [...cur.events, ev] : [ev] } }
      })
    )
  }, [reload])

  const project = projects.find((p) => p.id === sel)

  const saveProject = async (p: Project) => {
    await window.office.saveProject(p)
    setProjects((all) => (all.some((x) => x.id === p.id) ? all.map((x) => (x.id === p.id ? p : x)) : [...all, p]))
  }

  const running = (id: string) => {
    const last = live[id]?.events.findLast((e) => e.type === 'run')
    return last?.type === 'run' && last.state === 'running'
  }

  const tabs: [Tab, string, IconName][] = [
    ['work', t.nav.work, 'chat'],
    ['team', t.nav.team, 'users'],
    ['settings', t.nav.officeSettings, 'sliders']
  ]

  return (
    <div className="app">
      <nav className="rail" aria-label={t.nav.offices}>
        <div className="brand drag">
          <Mark />
          AI Office
        </div>
        <div className="rail-head">
          {t.nav.offices}
          <button className="btn quiet icon sm" onClick={() => setCreating(true)} aria-label={t.nav.newOffice} title={t.nav.newOffice}>
            <Icon name="plus" />
          </button>
        </div>
        <div className="rail-list">
          {projects.map((p) => (
            <button
              key={p.id}
              className={`rail-item ${!prefs && !usage && sel === p.id ? 'on' : ''}`}
              onClick={() => {
                setSel(p.id)
                setPrefs(null)
                setUsage(false)
              }}
            >
              <span className="label">{p.name}</span>
              {running(p.id) ? <span className="dot live" /> : <span className="meta">{p.agents.length}</span>}
            </button>
          ))}
          {ready && !projects.length && <p className="rail-empty">{t.nav.noOffices}</p>}
        </div>
        <div className="rail-foot">
          <button
            className={`rail-item ${usage ? 'on' : ''}`}
            onClick={() => {
              setUsage(true)
              setPrefs(null)
            }}
          >
            <Icon name="chart" />
            <span className="label">{t.nav.usage}</span>
          </button>
          <button
            className={`rail-item ${prefs ? 'on' : ''}`}
            onClick={() => {
              setPrefs('providers')
              setUsage(false)
            }}
          >
            <Icon name="sliders" />
            <span className="label">{t.nav.settings}</span>
          </button>
        </div>
      </nav>

      <main className="main">
        {usage ? (
          <>
            <header className="topbar drag">
              <h1>{t.nav.usage}</h1>
            </header>
            <div className="content">
              <Usage
                providers={providers}
                projects={projects}
                openProviders={() => {
                  setUsage(false)
                  setPrefs('providers')
                }}
              />
            </div>
          </>
        ) : prefs ? (
          <>
            <header className="topbar drag">
              <h1>{t.prefs.title}</h1>
            </header>
            <div className="content fixed">
              <Prefs tab={prefs} onTab={setPrefs} providers={providers} onProviders={reload} notify={notify} />
            </div>
          </>
        ) : project ? (
          <>
            <header className="topbar drag">
              <h1>{project.name}</h1>
              <div className="tabs" role="tablist">
                {tabs.map(([id, label, icon]) => (
                  <button key={id} role="tab" aria-selected={tab === id} className={`tab ${tab === id ? 'on' : ''}`} onClick={() => setTab(id)}>
                    <Icon name={icon} size={14} />
                    {label}
                  </button>
                ))}
              </div>
            </header>
            <div className={`content ${tab === 'settings' ? '' : 'fixed'}`}>
              {tab === 'work' && <Work key={project.id} project={project} providers={providers} live={live[project.id]} notify={notify} goTeam={() => setTab('team')} onSave={saveProject} />}
              {tab === 'team' && <Team key={project.id} project={project} providers={providers} live={live[project.id]} onSave={saveProject} notify={notify} />}
              {tab === 'settings' && (
                <Settings
                  key={project.id}
                  project={project}
                  onSave={saveProject}
                  notify={notify}
                  onDelete={async () => {
                    await window.office.deleteProject(project.id)
                    const pj = await reload()
                    setSel(pj[0]?.id ?? null)
                    setTab('work')
                  }}
                />
              )}
            </div>
          </>
        ) : (
          <>
            <header className="topbar drag" />
            <div className="content">{ready && <Welcome providers={providers} onProviders={() => setPrefs('providers')} onCreate={() => setCreating(true)} />}</div>
          </>
        )}
      </main>

      {creating && (
        <NewProject
          providers={providers}
          onClose={() => setCreating(false)}
          onProviders={() => {
            setCreating(false)
            setPrefs('providers')
          }}
          onCreate={async (p) => {
            await saveProject(p)
            setSel(p.id)
            setPrefs(null)
            setTab('team')
            setCreating(false)
          }}
        />
      )}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  )
}

function Welcome({ providers, onProviders, onCreate }: { providers: Provider[]; onProviders(): void; onCreate(): void }) {
  const t = useT()
  const hasKey = providers.some((p) => p.hasKey || p.baseURL.includes('localhost'))
  const steps: [string, string, boolean, (() => void) | null, string][] = [
    [t.welcome.step1, t.welcome.step1Body, hasKey, onProviders, t.welcome.connect],
    [t.welcome.step2, t.welcome.step2Body, false, hasKey ? onCreate : null, t.welcome.create],
    [t.welcome.step3, t.welcome.step3Body, false, null, '']
  ]
  return (
    <div className="welcome">
      <Mark size={40} />
      <h2>{t.welcome.title}</h2>
      <p>{t.welcome.body}</p>
      <div className="list steps">
        {steps.map(([title, body, done, action, label], i) => (
          <div key={title} className={`step ${done ? 'done' : ''}`}>
            <span className="step-n">{done ? <Icon name="check" size={13} /> : i + 1}</span>
            <div>
              <h4>{title}</h4>
              <p>{body}</p>
            </div>
            {action && !done && (
              <button className={`btn ${i === (hasKey ? 1 : 0) ? 'primary' : ''}`} onClick={action}>
                {label}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
