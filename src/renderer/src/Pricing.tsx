import { useState } from 'react'
import type { Billing, Price, Provider } from '../../shared/types'
import { errText, useT } from './i18n'
import { Field, Icon } from './ui'

/** 4 → "4", 0.2 → "0.2", 0.000125 → "0.000125" */
export const num = (n: number) => String(Number(n.toPrecision(6)))

export const isOpenRouter = (baseURL: string) => /openrouter\.ai/.test(baseURL)

export function BillingFields({ value, onChange }: { value: Billing; onChange(b: Billing): void }) {
  const t = useT()
  const p = t.providers
  const q = value.quota
  const amount = (s: string) => (s === '' ? undefined : Math.max(0, Number(s)))
  const setQuota = (patch: Partial<NonNullable<Billing['quota']>>) => {
    const next = { amount: q?.amount ?? 0, unit: q?.unit ?? 'requests', window: q?.window ?? '5h', ...patch }
    onChange({ ...value, quota: next.amount > 0 ? next : undefined })
  }
  return (
    <div className="stack">
      <Field label={p.billing} hint={p.modeHints[value.mode]}>
        <div className="seg">
          {(['payg', 'subscription', 'free'] as const).map((m) => (
            <button key={m} type="button" className={value.mode === m ? 'on' : ''} onClick={() => onChange({ mode: m })}>
              {p.modes[m]}
            </button>
          ))}
        </div>
      </Field>

      {value.mode === 'subscription' && (
        <div className="grid2">
          <Field label={p.fee}>
            <input className="input num" type="number" min={0} step={1} value={value.fee ?? ''} onChange={(e) => onChange({ ...value, fee: amount(e.target.value) })} />
          </Field>
          <Field label={p.quota}>
            <div className="quota-row">
              <input className="input num" type="number" min={0} value={q?.amount || ''} placeholder="—" onChange={(e) => setQuota({ amount: amount(e.target.value) ?? 0 })} />
              <select className="select" value={q?.unit ?? 'requests'} onChange={(e) => setQuota({ unit: e.target.value as 'requests' | 'tokens' })}>
                <option value="requests">{p.units.requests}</option>
                <option value="tokens">{p.units.tokens}</option>
              </select>
              <select className="select" value={q?.window ?? '5h'} onChange={(e) => setQuota({ window: e.target.value as NonNullable<Billing['quota']>['window'] })}>
                {(['5h', 'day', 'week', 'month'] as const).map((w) => <option key={w} value={w}>{p.windows[w]}</option>)}
              </select>
            </div>
          </Field>
        </div>
      )}
      {value.mode === 'payg' && (
        <Field label={p.monthlyLimit} hint={p.limitHint}>
          <input
            className="input num"
            type="number"
            min={0}
            value={q?.unit === 'usd' ? q.amount : ''}
            placeholder="—"
            onChange={(e) => {
              const a = amount(e.target.value)
              onChange({ ...value, quota: a ? { amount: a, unit: 'usd', window: 'month' } : undefined })
            }}
          />
        </Field>
      )}
      {value.mode === 'subscription' && q && <small className="faint">{p.limitHint}</small>}
    </div>
  )
}

export interface PriceRow {
  model: string
  in: string
  cacheRead: string
  cacheWrite: string
  out: string
  long?: Price['long']
  /** Built-in price shown as a placeholder (applies while the row is empty). */
  builtin?: Price
}

export const toRow = (model: string, own?: Price, builtin?: Price): PriceRow => ({
  model,
  in: own ? num(own.in) : '',
  out: own ? num(own.out) : '',
  cacheRead: own?.cacheRead !== undefined ? num(own.cacheRead) : '',
  cacheWrite: own?.cacheWrite !== undefined ? num(own.cacheWrite) : '',
  long: own?.long,
  builtin: own ? undefined : builtin
})

/** Rows → prices. Empty rows are skipped; throws E_PRICE when a row is half filled or not a number. */
export function fromRows(rows: PriceRow[]): Record<string, Price> {
  const out: Record<string, Price> = {}
  const parse = (s: string) => {
    const n = Number(s)
    if (s.trim() === '' || !Number.isFinite(n) || n < 0) throw new Error('E_PRICE')
    return n
  }
  for (const r of rows) {
    if (![r.in, r.out, r.cacheRead, r.cacheWrite].some((s) => s.trim())) continue
    const p: Price = { in: parse(r.in), out: parse(r.out) }
    if (r.cacheRead.trim()) p.cacheRead = parse(r.cacheRead)
    if (r.cacheWrite.trim()) p.cacheWrite = parse(r.cacheWrite)
    if (r.long) p.long = r.long
    out[r.model] = p
  }
  return out
}

export function PriceTable({ rows, onChange, provider, notify }: {
  rows: PriceRow[]
  onChange(rows: PriceRow[]): void
  provider: Pick<Provider, 'kind' | 'baseURL'>
  notify(text: string): void
}) {
  const t = useT()
  const p = t.providers
  const [adding, setAdding] = useState('')
  const [busy, setBusy] = useState(false)
  const anthropic = provider.kind === 'anthropic'
  const set = (i: number, patch: Partial<PriceRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const empty = (r: PriceRow) => !r.in.trim() && !r.out.trim() && !r.builtin

  const fill = async () => {
    setBusy(true)
    try {
      const want = rows.filter(empty).map((r) => r.model)
      const found = await window.office.catalogPrices({ kind: provider.kind, baseURL: provider.baseURL }, want)
      onChange(rows.map((r) => (found[r.model] && empty(r) ? toRow(r.model, found[r.model]) : r)))
      const n = Object.keys(found).length
      notify(n ? p.filled(n) : p.noneFilled)
    } catch (e) {
      notify(errText(e, t))
    } finally {
      setBusy(false)
    }
  }

  const add = () => {
    const m = adding.trim()
    if (!m || rows.some((r) => r.model === m)) return
    onChange([...rows, toRow(m)])
    setAdding('')
  }

  const cell = (i: number, key: 'in' | 'cacheRead' | 'cacheWrite' | 'out', label: string, ph?: number) => (
    <input
      className="input num sm"
      inputMode="decimal"
      aria-label={`${rows[i].model} ${label}`}
      value={rows[i][key]}
      placeholder={ph !== undefined ? num(ph) : '—'}
      onChange={(e) => set(i, { [key]: e.target.value.replace(',', '.') })}
    />
  )

  return (
    <div className="stack tight">
      {isOpenRouter(provider.baseURL) && <div className="note">{p.openrouterNote}</div>}
      {rows.length > 0 && (
        <div className={`prices ${anthropic ? 'four' : ''}`}>
          <span />
          <span>{p.priceIn}</span>
          <span>{p.priceCached}</span>
          {anthropic && <span>{p.priceWrite}</span>}
          <span>{p.priceOut}</span>
          <span />
          {rows.map((r, i) => (
            <div key={r.model} className="price-row">
              <div className="ellipsis">
                <div className="mono small ellipsis" title={r.model}>{r.model}</div>
                {r.builtin ? (
                  <span className="faint small">{p.builtin}</span>
                ) : empty(r) ? (
                  <span className="tag danger">{p.noPriceTag}</span>
                ) : r.long ? (
                  <span className="faint small">{p.longTier(r.long.above + 1, num(r.long.in), num(r.long.out))}</span>
                ) : null}
              </div>
              {cell(i, 'in', p.priceIn, r.builtin?.in)}
              {cell(i, 'cacheRead', p.priceCached, r.builtin && (r.builtin.cacheRead ?? r.builtin.in * 0.1))}
              {anthropic && cell(i, 'cacheWrite', p.priceWrite, r.builtin && (r.builtin.cacheWrite ?? r.builtin.in * 1.25))}
              {cell(i, 'out', p.priceOut, r.builtin?.out)}
              <button type="button" className="btn quiet icon sm" aria-label={`${t.common.delete} ${r.model}`} onClick={() => onChange(rows.filter((_, j) => j !== i))}>
                <Icon name="x" size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="row">
        <input className="input mono sm spacer" value={adding} placeholder={p.modelPh} onChange={(e) => setAdding(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), add())} />
        <button type="button" className="btn sm" onClick={add} disabled={!adding.trim()}>
          <Icon name="plus" size={12} /> {p.addModel}
        </button>
        <button type="button" className="btn sm" onClick={fill} disabled={busy || !rows.some(empty)}>
          {busy ? p.filling : p.fill}
        </button>
      </div>
      <small className="faint">{anthropic ? p.pricesHintAnthropic : p.pricesHint}</small>
    </div>
  )
}
