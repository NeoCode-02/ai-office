import { useId, useState } from 'react'
import { useT } from '../i18n'
import { Icon, tokens, usd } from '../ui'
import { budgetMeter, parseBudget, suggestBudget } from './logic'

/** Cost of the shown task; with a budget, a thin meter that turns amber at 80 % and red when used up. */
export function BudgetPill({ total, toks, unpriced, budget }: { total: number; toks: number; unpriced: number; budget: number }) {
  const t = useT()
  const meter = budgetMeter(total, budget)
  const used = budget > 0 ? Math.round((total / budget) * 100) : 0
  const title = [`${tokens(toks)} ${t.work.tokens}`, unpriced ? t.work.unpriced(unpriced) : '', meter ? t.run.budgetUsed(used) : ''].filter(Boolean).join(' · ')
  return (
    <span className={`pill ${meter ? `metered ${meter.level}` : ''}`} title={title}>
      {unpriced > 0 && '~'}
      {usd(total)}
      {budget > 0 && <span className="faint">{t.work.budget(budget)}</span>}
      {meter && (
        <span className="pill-meter" role="meter" aria-label={t.run.budgetUsed(used)} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(meter.pct)}>
          <span style={{ width: `${meter.pct}%` }} />
        </span>
      )}
    </span>
  )
}

/** Shown when the budget stopped the task or refused a message. Saving retries that message. */
export function RaiseBudget({ budget, spent, pending, onRaise }: { budget: number; spent: number; pending: boolean; onRaise(v: number): Promise<void> }) {
  const t = useT()
  const [value, setValue] = useState(() => suggestBudget(budget, spent))
  const [busy, setBusy] = useState(false)
  const id = useId()
  const v = parseBudget(value, spent)
  return (
    <form
      className="raise"
      onSubmit={async (e) => {
        e.preventDefault()
        if (v === null || busy) return
        setBusy(true)
        try {
          await onRaise(v)
        } finally {
          setBusy(false)
        }
      }}
    >
      <Icon name="alert" size={14} />
      <span className="raise-text" role="alert">{t.run.budgetOut(String(budget))}</span>
      <span className="spacer" />
      <label htmlFor={id} className="raise-label">
        {t.run.newBudget}
      </label>
      <input
        id={id}
        className="input sm num"
        type="number"
        min={0}
        step="any"
        inputMode="decimal"
        value={value}
        aria-invalid={v === null}
        aria-describedby={`${id}-hint`}
        onChange={(e) => setValue(e.target.value)}
      />
      <button type="submit" className="btn primary sm" disabled={v === null || busy}>
        {pending ? t.run.raiseAndSend : t.run.raise}
      </button>
      <small id={`${id}-hint`}>{t.run.budgetRule(usd(spent))}</small>
    </form>
  )
}
