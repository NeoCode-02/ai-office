import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { Markdown } from './markdown'

it('renders hostile markdown in reasonable time', () => {
  // Big enough that anything quadratic takes seconds (80K "[" took 2.2 s before the link rule was fixed).
  const n = 80_000
  const inputs = ['*', '[', '`', '_a', '[a](', '**a', '> ', '- ', '~~', '<', '[a', '](x'].map((s) => s.repeat(n / s.length))
  inputs.push(`| a ${'| a '.repeat(5000)}\n|---|\n`, `http://a.b/${'('.repeat(n)}`)
  for (const text of inputs) {
    const t = performance.now()
    renderToStaticMarkup(<Markdown text={text} />)
    const ms = performance.now() - t
    expect(ms, text.slice(0, 12)).toBeLessThan(1500)
  }
})
