import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Balance, Project, Provider, QuotaUse, UsageRow, UsageStats } from '../../shared/types'
import { errText, getLang, useT } from './i18n'
import { Logo } from './Providers'
import { Empty, Icon, tokens, usd } from './ui'

type Range = 'today' | 'week' | 'month30' | 'month'

function rangeStart(r: Range): number {
  const d = new Date()
  const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  if (r === 'week') midnight.setDate(midnight.getDate() - 6)
  if (r === 'month30') midnight.setDate(midnight.getDate() - 29)
  if (r === 'month') midnight.setDate(1)
  return midnight.getTime()
}

const promptTokens = (r: UsageRow) => r.in + r.cacheRead + r.cacheWrite
const money = (n: number) => (n > 0 && n < 0.01 ? `$${n.toFixed(4)}` : usd(n))

interface Props {
  providers: Provider[]
  projects: Project[]
  openProviders(): void
}

export default function Usage({ providers, projects, openProviders }: Props) {
  const t = useT()
  const u = t.usage
  const [range, setRange] = useState<Range>('week')
  const [office, setOffice] = useState('')
  const [data, setData] = useState<{ stats: UsageStats; quotas: Record<string, QuotaUse | null> } | null>(null)

  useEffect(() => {
    let live = true
    void window.office.usageStats(rangeStart(range), Date.now() + 1, office || undefined).then((d) => live && setData(d))
    return () => {
      live = false
    }
  }, [range, office])

  const s = data?.stats
  const fees = providers.filter((p) => p.billing.mode === 'subscription').reduce((n, p) => n + (p.billing.fee ?? 0), 0)
  const officeName = (id: string) => projects.find((p) => p.id === id)?.name ?? '—'

  return (
    <div className="page wide usage">
      <div className="page-head">
        <div>
          <h2>{u.title}</h2>
          <p>{u.subtitle}</p>
        </div>
        <div className="row">
          {projects.length > 1 && (
            <select className="select sm" value={office} onChange={(e) => setOffice(e.target.value)} aria-label={u.office}>
              <option value="">{u.allOffices}</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}
          <div className="seg">
            {(['today', 'week', 'month30', 'month'] as const).map((r) => (
              <button key={r} className={range === r ? 'on' : ''} onClick={() => setRange(r)}>{u.ranges[r]}</button>
            ))}
          </div>
        </div>
      </div>

      {s && (
        <>
          <div className="kpis">
            <div className="kpi">
              <span>{u.spend}</span>
              <strong>{money(s.total.usd)}{s.total.unpriced > 0 && '+'}</strong>
              <small>{s.total.unpriced > 0 ? u.unpriced(s.total.unpriced) : u.spendNote}</small>
            </div>
            <div className="kpi">
              <span>{u.subscriptions}</span>
              <strong>{fees ? `${usd(fees)}` : '—'}</strong>
              <small>{fees ? u.perMonth : u.noSubscriptions}</small>
            </div>
            <div className="kpi">
              <span>{u.tokens}</span>
              <strong>{tokens(promptTokens(s.total) + s.total.out)}</strong>
              <small>{u.inOut(tokens(promptTokens(s.total)), tokens(s.total.out))}</small>
            </div>
            <div className="kpi">
              <span>{u.requests}</span>
              <strong>{s.total.requests.toLocaleString()}</strong>
              <small>{u.cachedShare(promptTokens(s.total) ? Math.round((s.total.cacheRead / promptTokens(s.total)) * 100) : 0)}</small>
            </div>
          </div>

          {s.total.unpriced > 0 && (
            <div className="note warn row">
              <Icon name="alert" size={14} />
              <span className="spacer">{u.unpricedNote}</span>
              <button className="btn sm" onClick={openProviders}>{u.setPrices}</button>
            </div>
          )}

          {range !== 'today' && s.total.requests > 0 && <DailyChart days={s.byDay} />}
        </>
      )}

      <section className="usage-section">
        <h3>{u.providers}</h3>
        {providers.length === 0 ? (
          <div className="panel"><Empty icon="key" title={t.providers.none} body={t.providers.noneBody} /></div>
        ) : (
          <div className="stack tight">
            {providers.map((p) => (
              <ProviderCard key={p.id} provider={p} rows={s?.byModel.filter((m) => m.providerId === p.id) ?? []} quota={data?.quotas[p.id] ?? null} />
            ))}
            {s?.byModel.some((m) => !providers.some((p) => p.id === m.providerId)) && (
              <p className="faint small">{u.removedNote}</p>
            )}
          </div>
        )}
      </section>

      {s && s.byAgent.length > 0 && (
        <section className="usage-section">
          <h3>{u.people}</h3>
          <div className="panel">
            <table className="table">
              <thead>
                <tr>
                  <th>{u.person}</th>
                  <th>{u.office}</th>
                  <th>{u.model}</th>
                  <th className="r">{u.requests}</th>
                  <th className="r">{u.tokens}</th>
                  <th className="r">{u.cost}</th>
                </tr>
              </thead>
              <tbody>
                {s.byAgent.map((a) => (
                  <tr key={`${a.projectId}-${a.agentId}`}>
                    <td>{a.agent}</td>
                    <td className="muted">{officeName(a.projectId)}</td>
                    <td className="mono muted">{a.model}</td>
                    <td className="r num">{a.requests.toLocaleString()}</td>
                    <td className="r num">{tokens(promptTokens(a) + a.out)}</td>
                    <td className="r num">{money(a.usd)}{a.unpriced > 0 && '+'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {s && s.total.requests === 0 && <p className="muted" style={{ marginTop: 20 }}>{u.empty}</p>}
      <p className="faint small usage-foot">{u.howCounted}</p>
    </div>
  )
}

/** One series (spend per day): amber columns, recessive grid, tooltip on hover/focus. */
function DailyChart({ days }: { days: UsageStats['byDay'] }) {
  const t = useT()
  const [hover, setHover] = useState<number | null>(null)
  const max = Math.max(...days.map((d) => d.usd), 0)
  const top = max > 0 ? niceCeil(max) : 1
  const label = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString(getLang(), { month: 'short', day: 'numeric' })
  const every = Math.ceil(days.length / 8)
  const h = hover !== null ? days[hover] : null

  return (
    <div className="panel panel-pad chart">
      <div className="chart-head">
        <h3>{t.usage.daily}</h3>
        {h && <span className="chart-tip num">{label(h.day)} · {money(h.usd)} · {tokens(h.tokens)} {t.work.tokens}</span>}
      </div>
      <div className="chart-plot" onMouseLeave={() => setHover(null)}>
        <div className="chart-grid" aria-hidden>
          {[top, top / 2, 0].map((v) => <span key={v}>{usd(v)}</span>)}
        </div>
        <div className="chart-cols" role="list">
          {days.map((d, i) => (
            <div
              key={d.day}
              role="listitem"
              tabIndex={0}
              className={`chart-col ${hover === i ? 'on' : ''}`}
              aria-label={`${label(d.day)}: ${money(d.usd)}`}
              onMouseEnter={() => setHover(i)}
              onFocus={() => setHover(i)}
            >
              <div className="chart-bar" style={{ height: `${(d.usd / top) * 100}%` }} />
              <span className="chart-x">{i % every === 0 || i === days.length - 1 ? label(d.day) : ''}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/** 0.037 → 0.04, 3.2 → 4, 27 → 30 */
function niceCeil(n: number) {
  const p = 10 ** Math.floor(Math.log10(n))
  return [1, 2, 2.5, 4, 5, 10].map((m) => m * p).find((v) => v >= n)!
}

function ProviderCard({ provider: p, rows, quota }: { provider: Provider; rows: UsageStats['byModel']; quota: QuotaUse | null }) {
  const t = useT()
  const u = t.usage
  const [balance, setBalance] = useState<Balance | null | 'none'>('none')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const fetchBalance = useCallback(
    (live: () => boolean) =>
      window.office.balance(p.id).then(
        (b) => {
          if (!live()) return
          setBalance(b)
          setErr('')
        },
        (e) => live() && setErr(errText(e, t))
      ),
    [p.id, t]
  )

  useEffect(() => {
    if (!p.hasKey) return
    let live = true
    void fetchBalance(() => live)
    return () => {
      live = false
    }
  }, [p.hasKey, fetchBalance])

  const load = async () => {
    setBusy(true)
    await fetchBalance(() => true)
    setBusy(false)
  }

  const pct = quota ? Math.min(100, (quota.used / quota.amount) * 100) : 0
  const fmtQuota = (n: number) => (quota?.unit === 'usd' ? money(n) : quota?.unit === 'tokens' ? tokens(n) : Math.round(n).toLocaleString())
  const total = useMemo(() => rows.reduce((n, r) => n + r.usd, 0), [rows])

  return (
    <div className="panel">
      <div className="prov-head">
        <Logo name={p.name} />
        <div className="spacer ellipsis">
          <div style={{ fontWeight: 600 }}>{p.name}</div>
          <div className="faint small">
            {p.billing.mode === 'subscription' && p.billing.fee ? t.providers.subTag(usd(p.billing.fee)) : t.providers.modes[p.billing.mode]}
            {rows.length > 0 && p.billing.mode === 'payg' && ` · ${u.spentHere(money(total))}`}
          </div>
        </div>
        <div className="prov-left">
          {balance && balance !== 'none' ? (
            balance.kind === 'balance' ? (
              <span><span className="faint small">{u.balance}</span> <strong className="num">{balance.currency === 'USD' ? usd(balance.amount) : `${balance.amount.toFixed(2)} ${balance.currency}`}</strong></span>
            ) : (
              <span><span className="faint small">{u.keyLimit}</span> <strong className="num">{balance.remaining === null ? u.unlimited : usd(balance.remaining)}</strong></span>
            )
          ) : err ? (
            <span className="faint small" title={err}>{u.balanceFailed}</span>
          ) : balance === null && p.billing.mode === 'payg' && !quota ? (
            <span className="faint small">{u.noBalanceApi}</span>
          ) : null}
          {balance !== null && balance !== 'none' && (
            <button className="btn quiet icon sm" onClick={load} disabled={busy} aria-label={u.refresh} title={u.refresh}>
              <Icon name="refresh" size={13} />
            </button>
          )}
        </div>
      </div>
      {quota && (
        <div className="quota">
          <div className="row small">
            <span className="muted">{u.quota(t.providers.windows[quota.window])}</span>
            <span className="spacer" />
            <span className="num">{fmtQuota(quota.used)} / {fmtQuota(quota.amount)}</span>
          </div>
          <div className={`meter ${pct >= 100 ? 'full' : pct >= 80 ? 'high' : ''}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label={u.quota(t.providers.windows[quota.window])}>
            <span style={{ width: `${pct}%` }} />
          </div>
          {pct >= 80 && <small className={pct >= 100 ? 'danger' : 'warn'}>{pct >= 100 ? u.quotaFull : u.quotaHigh}</small>}
        </div>
      )}
      {rows.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>{u.model}</th>
              <th className="r">{u.requests}</th>
              <th className="r">{u.input}</th>
              <th className="r">{u.output}</th>
              <th className="r">{u.cost}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.model}>
                <td className="mono">{r.model}</td>
                <td className="r num">{r.requests.toLocaleString()}</td>
                <td className="r num" title={u.inputTitle(tokens(r.in), tokens(r.cacheRead), tokens(r.cacheWrite))}>
                  {tokens(promptTokens(r))}
                  {r.cacheRead > 0 && <span className="faint"> · {u.cached(Math.round((r.cacheRead / promptTokens(r)) * 100))}</span>}
                </td>
                <td className="r num">{tokens(r.out)}</td>
                <td className="r num">
                  {p.billing.mode !== 'payg' ? (
                    <span className="faint">{t.providers.modes[p.billing.mode]}</span>
                  ) : r.unpriced === r.requests ? (
                    <span className="tag danger">{u.noPrice}</span>
                  ) : (
                    `${money(r.usd)}${r.unpriced ? '+' : ''}`
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
