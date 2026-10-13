import { memo, useState, type ReactNode } from 'react'
import { useT } from './i18n'
import { Icon } from './ui'

/**
 * Markdown → React elements, never innerHTML: headings, lists (nested, tasks), quotes, rules, GFM tables,
 * fenced code, inline code, bold, italics, strikethrough and links (http, https and mailto only).
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return <div className="md">{blocks(text.replace(/\r\n?/g, '\n').split('\n'), 'b', 0)}</div>
})

// Model text can nest quotes or lists without end; past this depth the rest is shown as text.
const MAX_DEPTH = 6

const FENCE = /^( {0,3})(`{3,}|~{3,})[ \t]*([^\s`]*)[^`]*$/
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/
const QUOTE = /^ {0,3}> ?(.*)$/
const ITEM = /^([ \t]*)([-*+•]|\d{1,9}[.)])[ \t]+(.*)$/
const SEP_CELL = /^:?-+:?$/
const TASK = /^\[([ xX])\][ \t]+/

type Align = 'left' | 'center' | 'right' | undefined

function indentOf(line: string) {
  let w = 0
  for (const c of line) {
    if (c === ' ') w++
    else if (c === '\t') w += 4 - (w % 4)
    else break
  }
  return w
}

function dedent(line: string, n: number) {
  let w = 0
  let i = 0
  while (i < line.length && w < n) {
    if (line[i] === ' ') w++
    else if (line[i] === '\t') w += 4 - (w % 4)
    else break
    i++
  }
  return line.slice(i)
}

const closer = (marker: string) => new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[ \\t]*$`)

function cells(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'))
}

function tableAt(lines: string[], i: number): { head: string[]; align: Align[] } | null {
  const sep = lines[i + 1]
  if (sep === undefined || !lines[i].includes('|') || !sep.includes('|')) return null
  const marks = cells(sep)
  const head = cells(lines[i])
  if (head.length !== marks.length || !marks.every((c) => SEP_CELL.test(c))) return null
  const align = marks.map((c): Align => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : undefined))
  return { head, align }
}

function startsBlock(lines: string[], i: number) {
  const l = lines[i]
  return FENCE.test(l) || HR.test(l) || HEADING.test(l) || QUOTE.test(l) || ITEM.test(l) || tableAt(lines, i) !== null
}

function blocks(lines: string[], key: string, depth: number): ReactNode[] {
  const out: ReactNode[] = []
  let i = 0
  while (i < lines.length) {
    const l = lines[i]
    const k = `${key}.${out.length}`
    if (!l.trim()) {
      i++
      continue
    }
    const fence = FENCE.exec(l)
    if (fence) {
      i = code(lines, i, fence, k, out)
      continue
    }
    if (HR.test(l)) {
      out.push(<hr key={k} />)
      i++
      continue
    }
    const h = HEADING.exec(l)
    if (h) {
      const Tag = (['h3', 'h4', 'h5', 'h6', 'h6', 'h6'] as const)[h[1].length - 1]
      out.push(<Tag key={k}>{inline(h[2] ?? '', k, 0, true)}</Tag>)
      i++
      continue
    }
    if (depth < MAX_DEPTH && QUOTE.test(l)) {
      const quoted: string[] = []
      for (let m = QUOTE.exec(lines[i]); m; m = i < lines.length ? QUOTE.exec(lines[i]) : null) {
        quoted.push(m[1])
        i++
      }
      out.push(<blockquote key={k}>{blocks(quoted, k, depth + 1)}</blockquote>)
      continue
    }
    const table = tableAt(lines, i)
    if (table) {
      i = tableBlock(lines, i, table, k, out)
      continue
    }
    if (depth < MAX_DEPTH && ITEM.test(l)) {
      i = list(lines, i, k, depth, out)
      continue
    }
    const para = [l.trim()]
    i++
    while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) para.push(lines[i++].trim())
    out.push(<p key={k}>{text(para.join('\n'), k)}</p>)
  }
  return out
}

/** A fence without its closing line runs to the end: that is how a reply still being written looks. */
function code(lines: string[], i: number, m: RegExpExecArray, k: string, out: ReactNode[]) {
  const [, indent, marker, lang] = m
  const close = closer(marker)
  const body: string[] = []
  let j = i + 1
  while (j < lines.length && !close.test(lines[j])) body.push(dedent(lines[j++], indent.length))
  const src = body.join('\n')
  out.push(lang ? <CodeBlock key={k} lang={lang.slice(0, 40)} code={src} /> : <pre key={k}><code>{src}</code></pre>)
  return j + 1
}

function tableBlock(lines: string[], i: number, table: { head: string[]; align: Align[] }, k: string, out: ReactNode[]) {
  const rows: string[][] = []
  let j = i + 2
  while (j < lines.length && lines[j].trim() && lines[j].includes('|')) rows.push(cells(lines[j++]))
  const style = (c: number) => (table.align[c] ? { textAlign: table.align[c] } : undefined)
  out.push(
    <div key={k} className="md-table">
      <table>
        <thead>
          <tr>{table.head.map((c, n) => <th key={n} style={style(n)}>{inline(c, `${k}h${n}`, 0, true)}</th>)}</tr>
        </thead>
        {rows.length > 0 && (
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri}>{table.head.map((_, n) => <td key={n} style={style(n)}>{inline(r[n] ?? '', `${k}r${ri}c${n}`, 0, true)}</td>)}</tr>
            ))}
          </tbody>
        )}
      </table>
    </div>
  )
  return j
}

/**
 * A list item is its first line plus the lines that belong to it: lazy continuations of its text, and anything
 * indented under it (nested lists, code, paragraphs), which is parsed again as blocks.
 */
function list(lines: string[], start: number, k: string, depth: number, out: ReactNode[]) {
  const first = ITEM.exec(lines[start])!
  const indent = indentOf(first[1])
  const ordered = /\d/.test(first[2])
  const items: ReactNode[] = []
  let i = start
  while (i < lines.length) {
    const m = ITEM.exec(lines[i])
    if (!m || HR.test(lines[i]) || indentOf(m[1]) >= indent + 2 || /\d/.test(m[2]) !== ordered) break
    const contentAt = indentOf(m[1]) + m[2].length + 1
    const head = [m[3]]
    const body: string[] = []
    let blank = false
    let fence: RegExp | null = null
    i++
    while (i < lines.length) {
      const l = lines[i]
      if (fence) {
        const d = dedent(l, contentAt)
        body.push(d)
        if (fence.test(d)) fence = null
        i++
        continue
      }
      if (!l.trim()) {
        blank = true
        i++
        continue
      }
      const sub = ITEM.exec(l)
      if (sub && indentOf(sub[1]) < indent + 2) break
      if (indentOf(l) >= indent + 2) {
        const d = dedent(l, contentAt)
        if (blank || body.length || startsBlock([d], 0)) {
          if (blank && body.length) body.push('')
          body.push(d)
          const f = FENCE.exec(d)
          if (f) fence = closer(f[2])
        } else head.push(d.trim())
      } else if (!blank && !body.length && !startsBlock(lines, i)) head.push(l.trim())
      else break
      blank = false
      i++
    }
    const task = TASK.exec(head[0])
    if (task) head[0] = head[0].slice(task[0].length)
    const ik = `${k}.${items.length}`
    items.push(
      <li key={ik} className={task ? 'task' : undefined}>
        {task && <input type="checkbox" checked={task[1] !== ' '} disabled readOnly />}
        {text(head.join('\n'), ik)}
        {body.length > 0 && blocks(body, ik, depth + 1)}
      </li>
    )
  }
  const n = Number.parseInt(first[2], 10)
  out.push(ordered ? <ol key={k} start={n !== 1 ? n : undefined}>{items}</ol> : <ul key={k}>{items}</ul>)
  return i
}

function text(s: string, key: string): ReactNode[] {
  const out: ReactNode[] = []
  s.split('\n').forEach((line, i) => {
    if (i) out.push(<br key={`${key}n${i}`} />)
    out.push(...inline(line, `${key}l${i}`, 0, true))
  })
  return out
}

/** Only absolute http(s) and mailto links become links; anything else (javascript:, data:, relative) stays text. */
export function safeUrl(raw: string): string | null {
  try {
    const u = new URL(raw)
    return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:' ? u.href : null
  } catch {
    return null
  }
}

const anchor = (href: string, children: ReactNode, key: string) => (
  <a key={key} href={href} target="_blank" rel="noreferrer" title={href}>
    {children}
  </a>
)

const count = (s: string, c: string) => s.split(c).length - 1

/** Punctuation after a bare URL belongs to the sentence; a closing bracket only to the URL when it opened one. */
function trimUrl(url: string) {
  for (;;) {
    const last = url.at(-1) ?? ''
    if (/[.,:;!?'"*_~]/.test(last)) url = url.slice(0, -1)
    else if (last === ')' && count(url, ')') > count(url, '(')) url = url.slice(0, -1)
    else if (last === ']' && count(url, ']') > count(url, '[')) url = url.slice(0, -1)
    else return url
  }
}

type Made = { node: ReactNode; used?: number } | null
interface Rule {
  re: RegExp
  link?: boolean
  make(m: RegExpExecArray, key: string, depth: number, links: boolean): Made
}

const wrap = (Tag: 'strong' | 'em' | 'del') => (m: RegExpExecArray, key: string, depth: number, links: boolean): Made => ({
  node: <Tag key={key}>{inline(m[1], key, depth + 1, links)}</Tag>
})

// Earliest match wins; on a tie, the rule listed first. Emphasis bodies can't cross their own marker, which keeps matching linear.
const RULES: Rule[] = [
  {
    re: /(`+)([^`\n]|[^`\n][^\n]*?[^`\n])\1(?!`)/,
    make: (m, key) => {
      const c = m[2]
      return { node: <code key={key}>{c.length > 2 && c.startsWith(' ') && c.endsWith(' ') && c.trim() ? c.slice(1, -1) : c}</code> }
    }
  },
  {
    // Link text can't hold "[": from every "[" the scan stops at the next one, so "[[[[…" stays linear.
    re: /\[([^[\]\n]+)\]\([ \t]*([^\s()]*(?:\([^\s()]*\)[^\s()]*)*)[ \t]*\)/,
    link: true,
    make: (m, key, depth) => {
      const href = safeUrl(m[2])
      return href ? { node: anchor(href, inline(m[1], key, depth + 1, false), key) } : null
    }
  },
  {
    re: /\bhttps?:\/\/[^\s<>"'`]+/i,
    link: true,
    make: (m, key) => {
      const url = trimUrl(m[0])
      const href = safeUrl(url)
      return href ? { node: anchor(href, url, key), used: url.length } : null
    }
  },
  {
    re: /\*\*\*(?=[^\s*])([^*\n]*?[^\s*])\*\*\*/,
    make: (m, key, depth, links) => ({ node: <strong key={key}><em>{inline(m[1], key, depth + 1, links)}</em></strong> })
  },
  { re: /\*\*(?=[^\s*])((?:[^*\n]|\*(?!\*))*?[^\s*])\*\*/, make: wrap('strong') },
  { re: /~~(?=[^\s~])((?:[^~\n]|~(?!~))*?[^\s~])~~/, make: wrap('del') },
  { re: /\*(?=[^\s*])([^*\n]*?[^\s*])\*/, make: wrap('em') },
  // `_` only at word edges, so snake_case names stay as they are.
  { re: /(?<![\p{L}\p{N}_])_(?=[^\s_])([^_\n]*?[^\s_])_(?![\p{L}\p{N}_])/u, make: wrap('em') }
]

/** The rules as global regexes, so a search can start anywhere in the string (lookbehind sees the real text). */
const SEARCH = RULES.map((r) => new RegExp(r.re.source, r.re.flags.includes('g') ? r.re.flags : `${r.re.flags}g`))

function inline(s: string, key: string, depth: number, links: boolean): ReactNode[] {
  const out: ReactNode[] = []
  // Adjacent strings would render with comment separators; keep text in one piece.
  const push = (n: ReactNode) => {
    const last = out.length - 1
    if (typeof n === 'string' && typeof out[last] === 'string') out[last] = (out[last] as string) + n
    else out.push(n)
  }
  // Each rule searches the whole string from `pos` and its result is kept until `pos` passes it: a rule
  // with no match is never run again, so text full of unclosed markers stays linear.
  const found: (RegExpExecArray | null | undefined)[] = []
  let pos = 0
  let n = 0
  while (pos < s.length) {
    let best = -1
    if (depth < MAX_DEPTH) {
      for (let i = 0; i < RULES.length; i++) {
        if (RULES[i].link && !links) continue
        let m = found[i]
        if (m === undefined || (m && m.index < pos)) {
          SEARCH[i].lastIndex = pos
          m = found[i] = SEARCH[i].exec(s)
        }
        if (m && (best < 0 || m.index < found[best]!.index)) best = i
      }
    }
    if (best < 0) {
      push(s.slice(pos))
      break
    }
    const m = found[best]!
    if (m.index > pos) push(s.slice(pos, m.index))
    const made = RULES[best].make(m, `${key}.${n++}`, depth, links)
    push(made ? made.node : m[0])
    pos = m.index + (made?.used ?? m[0].length)
  }
  return out
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const t = useT()
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard refused: the code is still there to select by hand.
    }
  }
  return (
    <div className="md-code">
      <div className="md-code-head">
        <span className="ellipsis">{lang}</span>
        <button type="button" className="md-copy" onClick={copy} aria-label={copied ? t.common.copied : t.run.copyCode(lang)}>
          <Icon name={copied ? 'check' : 'copy'} size={12} />
          {copied ? t.common.copied : t.common.copy}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  )
}
