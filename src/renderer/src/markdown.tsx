import type { ReactNode } from 'react'

/** Minimal markdown → React (no innerHTML): code blocks, inline code, bold, headings, lists. */
export function Markdown({ text }: { text: string }) {
  const out: ReactNode[] = []
  text.split(/```[^\n]*\n?/).forEach((part, i) => {
    if (i % 2 === 1) {
      out.push(<pre key={i}><code>{part.replace(/\n$/, '')}</code></pre>)
      return
    }
    let list: { ordered: boolean; items: string[] } | null = null
    const flush = (k: string) => {
      if (!list) return
      const items = list.items.map((t, j) => <li key={j}>{inline(t)}</li>)
      out.push(list.ordered ? <ol key={k}>{items}</ol> : <ul key={k}>{items}</ul>)
      list = null
    }
    part.split(/\n{2,}|\n(?=\s*(?:[-*•]|\d+\.)\s)|\n(?=#{1,4}\s)/).forEach((block, j) => {
      const k = `${i}-${j}`
      const b = block.trim()
      if (!b) return
      const li = /^\s*(?:([-*•])|(\d+)\.)\s+([\s\S]*)$/.exec(b)
      if (li) {
        const ordered = Boolean(li[2])
        if (list && list.ordered !== ordered) flush(k + 'f')
        list ??= { ordered, items: [] }
        list.items.push(li[3])
        return
      }
      flush(k + 'f')
      // A heading may be followed by text on the next line in the same block.
      const h = /^#{1,4}\s+(.*)(?:\n([\s\S]*))?$/.exec(b)
      if (!h) return void out.push(<p key={k}>{lines(b)}</p>)
      out.push(<h4 key={k}>{inline(h[1])}</h4>)
      if (h[2]?.trim()) out.push(<p key={`${k}p`}>{lines(h[2].trim())}</p>)
    })
    flush(`${i}-end`)
  })
  return <div className="md">{out}</div>
}

function lines(s: string) {
  return s.split('\n').flatMap((l, i) => (i ? [<br key={`b${i}`} />, ...inline(l)] : inline(l)))
}

function inline(s: string): ReactNode[] {
  return s.split(/(`[^`]+`|\*\*[^*]+\*\*)/).map((t, i) =>
    t.startsWith('`') && t.endsWith('`') && t.length > 1 ? (
      <code key={i}>{t.slice(1, -1)}</code>
    ) : t.startsWith('**') && t.endsWith('**') && t.length > 3 ? (
      <strong key={i}>{t.slice(2, -2)}</strong>
    ) : (
      t
    )
  )
}
