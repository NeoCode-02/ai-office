import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { Markdown } from './markdown'

it('renders hostile markdown in reasonable time', () => {
  const inputs = ['*'.repeat(30000), '['.repeat(30000), '`'.repeat(30000), '_a'.repeat(20000), '[a]('.repeat(10000), '**a'.repeat(15000), '| a '.repeat(5000) + '\n|---|\n', '> '.repeat(20000), '- '.repeat(20000), 'http://a.b/' + '('.repeat(20000), '~~'.repeat(20000), '<'.repeat(30000)]
  for (const text of inputs) {
    const t = performance.now()
    renderToStaticMarkup(<Markdown text={text} />)
    const ms = performance.now() - t
    expect(ms, text.slice(0, 12)).toBeLessThan(1500)
  }
})
