import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Project, Provider } from '../../shared/types'
import { errText, getLang, LANGS, useT } from './i18n'
import { applyLive, createBatcher, officeState, type Live, type LiveItem } from './live'
import Prefs, { type PrefsTab } from './Prefs'
import { withExecs } from './roles'
import Settings, { NewProject } from './Settings'
import { httpsUrl, rovingStep } from './shellUtils'
import Team from './Team'
import { Empty, Icon, Mark, Menu, type IconName } from './ui'
import Usage from './Usage'
import Work from './Work'

export type { Live } from './live'

type Tab = 'work' | 'team' | 'settings'
const TABS: readonly Tab[] = ['work', 'team', 'settings']
const tabId = (t: Tab) => `office-tab-${t}`

/** The saved log of the office's run that is still going, if any. */
async function snapshot(projectId: string): Promise<LiveItem | null> {
  try {
    const runId = await window.office.activeRun(projectId)
    if (runId) return { projectId, runId, snapshot: await window.office.readRun(projectId, runId) }
  } catch {
    // The run shows up with its next event.
  }
  return null
}

/**
 * Offices made before every office had its executives get them once, saved so the main process runs
 * the same team. An office that can't be saved is shown as it is.
 */
async function withExecsSaved(list: Project[]): Promise<Project[]> {
  const names = LANGS[getLang()].names
  return Promise.all(
    list.map(async (p) => {
      const agents = withExecs(p.agents, names)
      if (agents === p.agents) return p
      const next = { ...p, agents }
      try {
        await window.office.saveProject(next)
        return next
      } catch {
        return p
      }
    })
  )
}

/** Next animation frame; a hidden window gets no frames, so it falls back to a timer there. */
function nextFrame(fn: () => void): () => void {
  if (document.hidden) {
    const id = setTimeout(fn, 250)
    return () => clearTimeout(id)
  }
  const id = requestAnimationFrame(fn)
  return () => cancelAnimationFrame(id)
}

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
  const [loadErr, setLoadErr] = useState('')
  const [update, setUpdate] = useState<{ version: string; url: string | null } | null>(null)
  const feed = useRef<ReturnType<typeof createBatcher<LiveItem>> | null>(null)
  const known = useRef<Project[]>([])

  const notify = useCallback((msg: string) => {
    setToast(msg)
    setTimeout(() => setToast((x) => (x === msg ? '' : x)), 3500)
  }, [])

  const reload = useCallback(
    () =>
      Promise.all([window.office.listProviders(), window.office.listProjects().then(withExecsSaved)]).then(([pv, pj]) => {
        setProviders(pv)
        setProjects(pj)
        return pj
      }),
    []
  )

  const show = useCallback((id: string, to: Tab) => {
    setSel(id)
    setTab(to)
    setPrefs(null)
    setUsage(false)
  }, [])

  const load = useCallback(
    () =>
      reload()
        .then(
          (pj) => {
            setLoadErr('')
            setSel((s) => s ?? pj[0]?.id ?? null)
            // Re-attach to runs still alive in the main process (e.g. after a reload).
            return Promise.all(pj.map((p) => snapshot(p.id).then((item) => item && feed.current?.push(item))))
          },
          (e) => setLoadErr(errText(e))
        )
        .finally(() => setReady(true)),
    [reload]
  )

  useEffect(() => {
    // Events arrive in bursts while a team works: one state update per frame, not per event.
    const batcher = createBatcher<LiveItem>((items) => setLive((l) => applyLive(l, items)), nextFrame)
    feed.current = batcher
    const off = window.office.onEvent((projectId, runId, ev) => batcher.push({ projectId, runId, ev }))
    void load()
    return () => {
      off()
      batcher.dispose()
      feed.current = null
    }
  }, [load])

  useEffect(() => {
    known.current = projects
  }, [projects])

  // "Always allow" adds a rule to the saved office in the main process; reload so a later save keeps it.
  useEffect(
    () =>
      window.office.onEvent((_p, _r, ev) => {
        if (ev.type === 'approval_done' && ev.always) void reload().catch(() => undefined)
      }),
    [reload]
  )

  // A notification was clicked.
  useEffect(
    () =>
      window.office.onOpenProject((id) => {
        show(id, 'work')
        if (!known.current.some((p) => p.id === id)) void reload().catch(() => undefined)
      }),
    [show, reload]
  )

  useEffect(
    () =>
      window.office.onUpdate((info) => {
        if (info.newer && info.latest) setUpdate({ version: info.latest, url: httpsUrl(info.url) })
      }),
    []
  )

  const project = projects.find((p) => p.id === sel)

  const saveProject = async (p: Project) => {
    await window.office.saveProject(p)
    setProjects((all) => (all.some((x) => x.id === p.id) ? all.map((x) => (x.id === p.id ? p : x)) : [...all, p]))
  }

  const deleteProject = async (id: string) => {
    try {
      await window.office.deleteProject(id)
      setLive(({ [id]: _gone, ...rest }) => rest)
      const pj = await reload()
      setSel(pj[0]?.id ?? null)
      setTab('work')
    } catch (e) {
      notify(errText(e, t))
    }
  }

  const importOffice = async () => {
    try {
      const imported = await window.office.importProject()
      if (!imported) return
      const [p] = await withExecsSaved([imported])
      setProjects((all) => [...all.filter((x) => x.id !== p.id), p])
      // Its workspace folder may not exist on this computer: show where to change it.
      show(p.id, 'settings')
      notify(t.shell.imported(p.name))
    } catch (e) {
      notify(errText(e, t))
    }
  }

  const tabs: [Tab, string, IconName][] = [
    ['work', t.nav.work, 'chat'],
    ['team', t.nav.team, 'users'],
    ['settings', t.nav.officeSettings, 'sliders']
  ]

  let view: { title?: string; head?: ReactNode; className: string; panel?: boolean; body: ReactNode }
  if (usage) {
    view = {
      title: t.nav.usage,
      className: '',
      body: (
        <Usage
          providers={providers}
          projects={projects}
          openProviders={() => {
            setUsage(false)
            setPrefs('providers')
          }}
          openCaps={() => {
            setUsage(false)
            setPrefs('general')
          }}
        />
      )
    }
  } else if (prefs) {
    view = { title: t.prefs.title, className: 'fixed', body: <Prefs tab={prefs} onTab={setPrefs} providers={providers} onProviders={reload} notify={notify} /> }
  } else if (project) {
    view = {
      title: project.name,
      className: tab === 'settings' ? '' : 'fixed',
      panel: true,
      head: (
        <div
          className="tabs"
          role="tablist"
          aria-label={project.name}
          onKeyDown={(e) => {
            const to = rovingStep(TABS, tab, e.key, 'x')
            if (!to) return
            e.preventDefault()
            setTab(to)
            document.getElementById(tabId(to))?.focus()
          }}
        >
          {tabs.map(([id, label, icon]) => (
            <button
              key={id}
              id={tabId(id)}
              role="tab"
              aria-selected={tab === id}
              aria-controls="office-panel"
              tabIndex={tab === id ? 0 : -1}
              className={`tab ${tab === id ? 'on' : ''}`}
              onClick={() => setTab(id)}
            >
              <Icon name={icon} size={14} />
              {label}
            </button>
          ))}
        </div>
      ),
      body: (
        <>
          {tab === 'work' && <Work key={project.id} project={project} providers={providers} live={live[project.id]} notify={notify} goTeam={() => setTab('team')} onSave={saveProject} />}
          {tab === 'team' && <Team key={project.id} project={project} providers={providers} live={live[project.id]} onSave={saveProject} notify={notify} />}
          {tab === 'settings' && <Settings key={project.id} project={project} onSave={saveProject} notify={notify} onDelete={() => deleteProject(project.id)} />}
        </>
      )
    }
  } else {
    view = {
      className: '',
      body: loadErr ? (
        <Empty icon="alert" title={t.shell.loadFailed} body={loadErr}>
          <button className="btn primary" onClick={() => void load()}>
            <Icon name="refresh" size={14} /> {t.shell.retry}
          </button>
        </Empty>
      ) : (
        ready && <Welcome providers={providers} onProviders={() => setPrefs('providers')} onCreate={() => setCreating(true)} />
      )
    }
  }

  return (
    <div className="app">
      <nav className="rail" aria-label={t.nav.offices}>
        <div className="brand drag">
          <Mark />
          AI Office
        </div>
        <div className="rail-head">
          {t.nav.offices}
          <Menu
            label={t.shell.addOffice}
            icon="plus"
            items={[
              { label: t.nav.newOffice, icon: 'plus', onSelect: () => setCreating(true) },
              { label: t.shell.importOffice, icon: 'download', onSelect: () => void importOffice() }
            ]}
          />
        </div>
        <div className="rail-list">
          {projects.map((p) => {
            const on = !prefs && !usage && sel === p.id
            const s = officeState(live[p.id])
            return (
              <button key={p.id} className={`rail-item ${on ? 'on' : ''}`} aria-current={on ? 'page' : undefined} onClick={() => show(p.id, tab)}>
                <span className="label">{p.name}</span>
                {s.waiting > 0 ? (
                  <span className="dot warn" role="img" aria-label={t.shell.waiting(s.waiting)} title={t.shell.waiting(s.waiting)} />
                ) : s.running ? (
                  <span className="dot live" role="img" aria-label={t.work.running} title={t.work.running} />
                ) : (
                  <span className="meta">{p.agents.length}</span>
                )}
              </button>
            )
          })}
          {ready && !projects.length && !loadErr && <p className="rail-empty">{t.nav.noOffices}</p>}
        </div>
        <div className="rail-foot">
          <button
            className={`rail-item ${usage ? 'on' : ''}`}
            aria-current={usage ? 'page' : undefined}
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
            aria-current={prefs ? 'page' : undefined}
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
        <header className="topbar drag">
          {view.title && <h1>{view.title}</h1>}
          {view.head}
        </header>
        {update && (
          <div className="banner" role="status">
            <Icon name="download" size={14} />
            <span className="spacer">{t.shell.updateAvailable(update.version)}</span>
            {update.url && (
              <a className="btn sm" href={update.url} target="_blank" rel="noreferrer">
                {t.shell.download} <Icon name="external" size={12} />
              </a>
            )}
            <button className="btn quiet icon sm" onClick={() => setUpdate(null)} aria-label={t.shell.dismiss} title={t.shell.dismiss}>
              <Icon name="x" size={14} />
            </button>
          </div>
        )}
        <div
          className={`content ${view.className}`}
          {...(view.panel ? { id: 'office-panel', role: 'tabpanel', 'aria-labelledby': tabId(tab) } : {})}
        >
          {view.body}
        </div>
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
            show(p.id, 'team')
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
