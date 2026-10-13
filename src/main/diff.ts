/** Above this many lines on either side only a summary is shown. */
const MAX_INPUT = 4000
/** Edit distance at which the exact search gives up; past it the rest is shown as replaced. */
const MAX_EDITS = 1000

type Op = { t: ' ' | '-' | '+'; key: string; a: number; b: number }

/**
 * Lines as comparison keys. A last line without a newline keeps a trailing "\n" in its key
 * (a real line never contains one), so "a" and "a\n" differ the way `diff` reports them.
 */
function lines(text: string): string[] {
  if (!text) return []
  const out = text.split('\n')
  if (out[out.length - 1] === '') out.pop()
  else out[out.length - 1] += '\n'
  return out
}

/** Myers' O(ND) shortest edit script; null when it needs more than `maxD` edits. */
function myers(a: string[], b: string[], maxD: number): (' ' | '-' | '+')[] | null {
  const n = a.length
  const m = b.length
  const max = Math.min(n + m, maxD)
  const off = max + 1
  const v = new Int32Array(2 * max + 3)
  const trace: Int32Array[] = []
  for (let d = 0; d <= max; d++) {
    // Only diagonals -d..d are read when backtracking from step d.
    trace.push(v.slice(off - d, off + d + 1))
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[off + k] = x
      if (x >= n && y >= m) return backtrack(trace, n, m)
    }
  }
  return null
}

function backtrack(trace: Int32Array[], n: number, m: number): (' ' | '-' | '+')[] {
  const ops: (' ' | '-' | '+')[] = []
  let x = n
  let y = m
  for (let d = trace.length - 1; d > 0; d--) {
    const at = (k: number) => trace[d][k + d]
    const k = x - y
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
    const prevX = at(prevK)
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      ops.push(' ')
      x--
      y--
    }
    ops.push(x === prevX ? '+' : '-')
    x = prevX
    y = prevY
  }
  while (x-- > 0) ops.push(' ')
  return ops.reverse()
}

function editScript(a: string[], b: string[]): Op[] {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)
  const mid = myers(midA, midB, MAX_EDITS) ?? [...midA.map(() => '-' as const), ...midB.map(() => '+' as const)]

  const ops: Op[] = []
  let i = 0
  let j = 0
  const push = (t: Op['t']) => {
    ops.push({ t, key: t === '+' ? b[j] : a[i], a: i, b: j })
    if (t !== '+') i++
    if (t !== '-') j++
  }
  for (let s = 0; s < start; s++) push(' ')
  for (const t of mid) push(t)
  while (i < a.length) push(' ')
  return ops
}

const range = (start: number, count: number) => (count === 1 ? `${start}` : `${start},${count}`)

function hunk(ops: Op[]): string[] {
  const aCount = ops.filter((o) => o.t !== '+').length
  const bCount = ops.filter((o) => o.t !== '-').length
  const out = [`@@ -${range(aCount ? ops[0].a + 1 : ops[0].a, aCount)} +${range(bCount ? ops[0].b + 1 : ops[0].b, bCount)} @@`]
  for (const o of ops) {
    if (o.key.endsWith('\n')) out.push(o.t + o.key.slice(0, -1), '\\ No newline at end of file')
    else out.push(o.t + o.key)
  }
  return out
}

function hunks(ops: Op[], context: number): string[] {
  const out: string[] = []
  let i = 0
  for (;;) {
    while (i < ops.length && ops[i].t === ' ') i++
    if (i >= ops.length) return out
    const start = Math.max(0, i - context)
    let j = i
    for (;;) {
      while (j < ops.length && ops[j].t !== ' ') j++
      let e = j
      while (e < ops.length && ops[e].t === ' ') e++
      // Changes separated by at most 2×context unchanged lines share one hunk.
      if (e < ops.length && e - j <= 2 * context) j = e
      else break
    }
    const end = Math.min(ops.length, j + context)
    out.push(...hunk(ops.slice(start, end)))
    i = end
  }
}

/** Unified diff of one file ('' when nothing changed), clipped to `maxLines`. */
export function unifiedDiff(path: string, before: string, after: string, { context = 3, maxLines = 400 } = {}): string {
  if (before === after) return ''
  const a = lines(before)
  const b = lines(after)
  const head = [`--- a/${path}`, `+++ b/${path}`]
  if (a.length > MAX_INPUT || b.length > MAX_INPUT) return [...head, `@@ ${a.length} lines → ${b.length} lines @@`].join('\n')
  const out = [...head, ...hunks(editScript(a, b), Math.max(0, context))]
  if (out.length <= maxLines) return out.join('\n')
  return [...out.slice(0, maxLines), `… ${out.length - maxLines} more lines`].join('\n')
}
