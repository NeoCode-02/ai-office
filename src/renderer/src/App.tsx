import { useCallback, useEffect, useState } from 'react'
import type { OfficeEvent, Project, Provider } from '../../shared/types'
import OfficeView from './OfficeView'
import Providers from './Providers'
import Settings, { NewProject } from './Settings'
import Team from './Team'
import { Icon, type IconName } from './ui'

export interface Live {
  runId: string
  events: OfficeEvent[]
}
type Tab = 'office' | 'team' | 'settings'
const TABS: [Tab, string, IconName][] = [
  ['office', 'Ofis', 'chat'],
  ['team', 'Jamoa', 'users'],
  ['settings', 'Sozlamalar', 'settings']
]

export default function App() {
  const [providers, setProviders] = useState<Provider[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [sel, setSel] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('office')
  const [page, setPage] = useState<'project' | 'providers'>('project')
  const [live, setLive] = useState<Record<string, Live>>({})
  const [creating, setCreating] = useState(false)
  const [toast, setToast] = useState('')
  const [ready, setReady] = useState(false)

  const notify = useCallback((t: string) => {
    setToast(t)
    setTimeout(() => setToast((x) => (x === t ? '' : x)), 3500)
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
        const events = cur?.runId === runId ? [...cur.events, ev] : [ev]
        return { ...l, [projectId]: { runId, events } }
      })
    )
  }, [reload])

  const project = projects.find((p) => p.id === sel)

  const saveProject = async (p: Project) => {
    await window.office.saveProject(p)
    setProjects((all) => (all.some((x) => x.id === p.id) ? all.map((x) => (x.id === p.id ? p : x)) : [...all, p]))
  }

  const running = (id: string) => {
    const evs = live[id]?.events ?? []
    const last = evs.findLast((e) => e.type === 'run')
    return last?.type === 'run' && last.state === 'running'
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="titlebar-drag brand">
          <div className="brand-mark">
            <Icon name="building" size={15} />
          </div>
          AI Office
        </div>
        <div className="side-section">
          Ofislar
          <button className="btn ghost icon sm" onClick={() => setCreating(true)} aria-label="Yangi ofis" title="Yangi ofis">
            <Icon name="plus" />
          </button>
        </div>
        <div className="side-list">
          {projects.map((p) => (
            <button
              key={p.id}
              className={`side-item ${page === 'project' && sel === p.id ? 'active' : ''}`}
              onClick={() => {
                setSel(p.id)
                setPage('project')
              }}
            >
              <Icon name="building" />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
              <span className="meta">{running(p.id) ? <span className="dot working" /> : p.agents.length}</span>
            </button>
          ))}
          {ready && !projects.length && <p className="faint small" style={{ padding: '4px 10px' }}>Hali ofis yo‘q</p>}
        </div>
        <div className="side-foot">
          <button className={`side-item ${page === 'providers' ? 'active' : ''}`} onClick={() => setPage('providers')}>
            <Icon name="key" />
            AI provayderlar
            <span className="meta">{providers.length}</span>
          </button>
        </div>
      </aside>

      <main className="main">
        {page === 'providers' ? (
          <>
            <div className="titlebar-drag topbar">
              <h1>AI provayderlar</h1>
            </div>
            <div className="content">
              <Providers providers={providers} onChange={reload} notify={notify} />
            </div>
          </>
        ) : project ? (
          <>
            <div className="titlebar-drag topbar">
              <h1>{project.name}</h1>
              <nav className="tabs">
                {TABS.map(([id, label, icon]) => (
                  <button key={id} className={`tab ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)}>
                    <Icon name={icon} size={15} />
                    {label}
                  </button>
                ))}
              </nav>
            </div>
            <div className="content" style={tab === 'settings' ? undefined : { overflow: 'hidden' }}>
              {tab === 'office' && <OfficeView key={project.id} project={project} providers={providers} live={live[project.id]} notify={notify} goTeam={() => setTab('team')} />}
              {tab === 'team' && <Team key={project.id} project={project} providers={providers} onSave={saveProject} notify={notify} />}
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
                    setTab('office')
                  }}
                />
              )}
            </div>
          </>
        ) : (
          <>
            <div className="titlebar-drag topbar" />
            <div className="content">{ready && <Welcome providers={providers} onProviders={() => setPage('providers')} onCreate={() => setCreating(true)} />}</div>
          </>
        )}
      </main>

      {creating && (
        <NewProject
          providers={providers}
          onClose={() => setCreating(false)}
          onProviders={() => {
            setCreating(false)
            setPage('providers')
          }}
          onCreate={async (p) => {
            await saveProject(p)
            setSel(p.id)
            setPage('project')
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
  const hasKey = providers.some((p) => p.hasKey)
  return (
    <div className="page">
      <div className="empty" style={{ paddingBottom: 0 }}>
        <div className="empty-icon">
          <Icon name="building" size={26} />
        </div>
        <h3 style={{ fontSize: 26, letterSpacing: '-0.02em' }}>AI xodimlaringiz uchun ofis</h3>
        <p style={{ maxWidth: 560, margin: 0 }}>
          Turli AI modellarni bitta jamoaga yig‘ing: har biriga lavozim bering, bo‘limlarga ajrating, boshliqlar tayinlang. Siz faqat maqsadni aytasiz — ular o‘zaro gaplashib, ishni bo‘lib, bajarib, tekshirib, sizga hisobot beradi.
        </p>
      </div>
      <div className="steps">
        <div className={`card step ${hasKey ? 'done' : ''}`}>
          <div className="step-n">{hasKey ? <Icon name="check" size={14} /> : 1}</div>
          <h4>Provayder ulang</h4>
          <p>Claude, GPT, Gemini, DeepSeek, Kimi, GLM yoki boshqa — API kalitingizni kiriting.</p>
          <button className={`btn sm ${hasKey ? '' : 'primary'}`} onClick={onProviders}>
            <Icon name="key" size={14} /> Provayderlar
          </button>
        </div>
        <div className="card step">
          <div className="step-n">2</div>
          <h4>Ofis va jamoa tuzing</h4>
          <p>Tayyor shablondan boshlang yoki noldan: CEO, bo‘lim boshliqlari, xodimlar.</p>
          <button className={`btn sm ${hasKey ? 'primary' : ''}`} onClick={onCreate} disabled={!hasKey}>
            <Icon name="plus" size={14} /> Yangi ofis
          </button>
        </div>
        <div className="card step">
          <div className="step-n">3</div>
          <h4>Maqsad bering</h4>
          <p>Bosh rahbarga vazifani yozing va jarayonni jonli kuzating. Yakunda hisobot olasiz.</p>
        </div>
      </div>
    </div>
  )
}
