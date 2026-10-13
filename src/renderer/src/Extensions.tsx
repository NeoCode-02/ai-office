import { useEffect, useState } from 'react'
import type { McpServer, Plugin, Skill } from '../../shared/types'
import { errText, useT } from './i18n'
import { uid } from './roles'
import { ConfirmButton, Field, Icon, Modal, Switch } from './ui'

export default function Extensions({ notify }: { notify(t: string): void }) {
  const t = useT()
  const [mcp, setMcp] = useState<McpServer[]>([])
  const [skills, setSkills] = useState<Skill[]>([])
  const [plugins, setPlugins] = useState<Plugin[]>([])
  const [editMcp, setEditMcp] = useState<McpServer | 'new' | null>(null)
  const [newSkill, setNewSkill] = useState(false)
  const [testing, setTesting] = useState<string | null>(null)

  const [tick, setTick] = useState(0)
  const reload = () => setTick((n) => n + 1)
  useEffect(() => {
    void Promise.all([window.office.listMcp(), window.office.listSkills(), window.office.listPlugins()]).then(([m, s, p]) => {
      setMcp(m)
      setSkills(s)
      setPlugins(p)
    })
  }, [tick])

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn()
      if (ok) notify(ok)
    } catch (e) {
      notify(errText(e, t))
    }
    reload()
  }

  const importFrom = async (kind: 'skill' | 'plugin') => {
    const dir = await window.office.pickFolder()
    if (!dir) return
    await run(async () => {
      const name = kind === 'skill' ? await window.office.importSkill(dir) : await window.office.importPlugin(dir)
      notify(`${name} ✓`)
    })
  }

  const test = async (m: McpServer) => {
    setTesting(m.id)
    try {
      notify(`${m.name}: ${t.ext.tools((await window.office.testMcp(m.id)).length)}`)
    } catch (e) {
      notify(errText(e, t))
    } finally {
      setTesting(null)
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>{t.prefs.extensions}</h2>
          <p>{t.ext.subtitle}</p>
        </div>
      </div>

      <div className="panel panel-pad row" style={{ alignItems: 'flex-start' }}>
        <Icon name="check" size={18} />
        <div>
          <div style={{ fontWeight: 600 }}>{t.ext.builtIn}</div>
          <p className="muted small" style={{ marginTop: 2 }}>{t.ext.builtInBody}</p>
        </div>
      </div>

      <section className="section">
        <div className="section-head">
          <div>
            <h3>{t.ext.mcp}</h3>
            <p>{t.ext.mcpBody}</p>
          </div>
          <button className="btn sm" onClick={() => setEditMcp('new')}>
            <Icon name="plus" size={13} /> {t.ext.addMcp}
          </button>
        </div>
        <div className="list">
          {mcp.length === 0 && <div className="list-empty">{t.ext.noneMcp}</div>}
          {mcp.map((m) => (
            <div key={m.id} className="list-row">
              <Icon name="plug" />
              <div className="spacer ellipsis">
                <div style={{ fontWeight: 600 }}>{m.name}</div>
                <div className="faint small mono ellipsis">{m.transport === 'http' ? m.url : [m.command, ...m.args].join(' ')}</div>
              </div>
              {m.plugin && <span className="tag">{t.ext.fromPlugin(m.plugin)}</span>}
              <button className="btn sm" disabled={!m.enabled || testing === m.id} onClick={() => test(m)}>
                {testing === m.id ? t.common.testing : t.common.test}
              </button>
              {!m.plugin && (
                <button className="btn quiet icon sm" onClick={() => setEditMcp(m)} aria-label={`${t.common.edit} ${m.name}`}>
                  <Icon name="edit" size={14} />
                </button>
              )}
              <Switch on={m.enabled} label={m.name} onChange={(on) => run(() => window.office.saveMcp({ ...m, enabled: on }, ''))} />
            </div>
          ))}
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <div>
            <h3>{t.ext.skills}</h3>
            <p>{t.ext.skillsBody}</p>
          </div>
          <div className="row">
            <button className="btn sm" onClick={() => importFrom('skill')}>
              <Icon name="download" size={13} /> {t.ext.importFolder}
            </button>
            <button className="btn sm" onClick={() => setNewSkill(true)}>
              <Icon name="plus" size={13} /> {t.ext.newSkill}
            </button>
          </div>
        </div>
        <div className="list">
          {skills.map((s) => (
            <div key={s.name} className="list-row">
              <Icon name="book" />
              <div className="spacer ellipsis">
                <div className="row">
                  <span style={{ fontWeight: 600 }}>{s.name}</span>
                  <span className="tag">{s.plugin ? t.ext.fromPlugin(s.plugin) : t.ext.sources[s.source]}</span>
                </div>
                <div className="muted small ellipsis" title={s.description}>{s.description}</div>
              </div>
              {s.source === 'user' && (
                <button className="btn quiet icon sm" aria-label={`${t.common.delete} ${s.name}`} title={t.common.delete} onClick={() => run(() => window.office.deleteSkill(s.name))}>
                  <Icon name="trash" size={14} />
                </button>
              )}
              <Switch on={s.enabled} label={s.name} onChange={(on) => run(() => window.office.setSkillEnabled(s.name, on))} />
            </div>
          ))}
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <div>
            <h3>{t.ext.plugins}</h3>
            <p>{t.ext.pluginsBody}</p>
          </div>
          <button className="btn sm" onClick={() => importFrom('plugin')}>
            <Icon name="download" size={13} /> {t.ext.importPlugin}
          </button>
        </div>
        <div className="list">
          {plugins.length === 0 && <div className="list-empty">{t.ext.nonePlugins}</div>}
          {plugins.map((p) => (
            <div key={p.name} className="list-row">
              <Icon name="puzzle" />
              <div className="spacer ellipsis">
                <div className="row">
                  <span style={{ fontWeight: 600 }}>{p.name}</span>
                  {p.version && <span className="faint small">v{p.version}</span>}
                </div>
                <div className="muted small ellipsis">
                  {[p.description, t.ext.pluginParts(p.mcpServers.length, p.skills.length, p.roles.length)].filter(Boolean).join(' · ')}
                </div>
                {p.ignored.length > 0 && <div className="faint small">{t.ext.ignored(p.ignored.join(', '))}</div>}
              </div>
              <ConfirmButton className="sm" onConfirm={() => run(() => window.office.deletePlugin(p.name))}>{t.common.delete}</ConfirmButton>
              <Switch on={p.enabled} label={p.name} onChange={(on) => run(() => window.office.setPluginEnabled(p.name, on))} />
            </div>
          ))}
        </div>
        <p className="faint small" style={{ marginTop: 10 }}>{t.ext.trustWarn}</p>
      </section>

      {editMcp && <McpModal initial={editMcp === 'new' ? null : editMcp} onClose={() => setEditMcp(null)} onSaved={() => { setEditMcp(null); reload() }} />}
      {newSkill && <SkillModal onClose={() => setNewSkill(false)} onSaved={() => { setNewSkill(false); reload() }} />}
    </div>
  )
}

function McpModal({ initial, onClose, onSaved }: { initial: McpServer | null; onClose(): void; onSaved(): void }) {
  const t = useT()
  const [name, setName] = useState(initial?.name ?? '')
  const [transport, setTransport] = useState<McpServer['transport']>(initial?.transport ?? 'stdio')
  const [command, setCommand] = useState(initial?.command ?? '')
  const [args, setArgs] = useState((initial?.args ?? []).join('\n'))
  const [url, setUrl] = useState(initial?.url ?? '')
  const [secrets, setSecrets] = useState('')
  const [err, setErr] = useState('')

  const save = async () => {
    if (!name.trim()) return setErr(t.providers.errName)
    if (transport === 'http' && !/^https?:\/\//.test(url)) return setErr(t.providers.errUrl)
    if (transport === 'stdio' && !command.trim()) return setErr(t.ext.command)
    try {
      await window.office.saveMcp(
        { id: initial?.id ?? uid(), name: name.trim(), transport, command: command.trim(), args: args.split('\n').map((a) => a.trim()).filter(Boolean), url: url.trim(), enabled: initial?.enabled ?? true },
        secrets
      )
      onSaved()
    } catch (e) {
      setErr(errText(e, t))
    }
  }

  return (
    <Modal
      title={initial?.name ?? t.ext.addMcp}
      onClose={onClose}
      width={580}
      footer={
        <>
          {initial && (
            <span className="spacer">
              <ConfirmButton onConfirm={async () => { await window.office.deleteMcp(initial.id); onSaved() }}>{t.common.delete}</ConfirmButton>
            </span>
          )}
          <button className="btn" onClick={onClose}>{t.common.cancel}</button>
          <button className="btn primary" onClick={save}>{t.common.save}</button>
        </>
      }
    >
      <div className="stack">
        <Field label={t.providers.name}>
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="GitHub" />
        </Field>
        <Field label={t.ext.transport}>
          <div className="seg">
            <button className={transport === 'stdio' ? 'on' : ''} onClick={() => setTransport('stdio')}>{t.ext.stdio}</button>
            <button className={transport === 'http' ? 'on' : ''} onClick={() => setTransport('http')}>{t.ext.http}</button>
          </div>
        </Field>
        {transport === 'stdio' ? (
          <>
            <Field label={t.ext.command}>
              <input className="input mono" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" />
            </Field>
            <Field label={t.ext.args} hint={t.ext.argsHint}>
              <textarea className="textarea mono" rows={3} value={args} onChange={(e) => setArgs(e.target.value)} placeholder={'-y\n@modelcontextprotocol/server-filesystem\nC:\\projects'} />
            </Field>
          </>
        ) : (
          <Field label={t.ext.url}>
            <input className="input mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/mcp" />
          </Field>
        )}
        <Field label={transport === 'stdio' ? t.ext.env : t.ext.headers} hint={initial?.hasSecrets ? t.ext.secretsKeep : transport === 'stdio' ? t.ext.envHint : t.ext.headersHint}>
          <textarea className="textarea mono" rows={3} value={secrets} onChange={(e) => setSecrets(e.target.value)} placeholder={transport === 'stdio' ? 'GITHUB_TOKEN=…' : 'Authorization: Bearer …'} />
        </Field>
        {err && <div className="note danger" role="alert">{err}</div>}
      </div>
    </Modal>
  )
}

function SkillModal({ onClose, onSaved }: { onClose(): void; onSaved(): void }) {
  const t = useT()
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [body, setBody] = useState('')
  const valid = name.trim() && desc.trim() && body.trim()
  return (
    <Modal
      title={t.ext.newSkill}
      onClose={onClose}
      width={620}
      footer={
        <>
          <button className="btn" onClick={onClose}>{t.common.cancel}</button>
          <button className="btn primary" disabled={!valid} onClick={async () => { await window.office.createSkill(name, desc, body); onSaved() }}>{t.common.save}</button>
        </>
      }
    >
      <div className="stack">
        <Field label={t.ext.skillName}>
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="release-checklist" />
        </Field>
        <Field label={t.ext.skillDesc} hint={t.ext.skillDescHint}>
          <input className="input" value={desc} onChange={(e) => setDesc(e.target.value)} />
        </Field>
        <Field label={t.ext.skillBody}>
          <textarea className="textarea mono" rows={10} value={body} onChange={(e) => setBody(e.target.value)} placeholder={'# Release checklist\n1. …'} />
        </Field>
      </div>
    </Modal>
  )
}
