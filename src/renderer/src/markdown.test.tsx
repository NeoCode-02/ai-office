import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Markdown } from './markdown'

const html = (text: string) => renderToStaticMarkup(<Markdown text={text} />)

describe('Markdown', () => {
  it('keeps text that follows a heading in the same block', () => {
    expect(html('## Result\nIt works.\n\n- a\n- b')).toBe('<div class="md"><h4>Result</h4><p>It works.</p><ul><li>a</li><li>b</li></ul></div>')
  })

  it('renders code, bold and fenced blocks without raw HTML', () => {
    expect(html('Run `x` **now** <b>\n```\nhi\n```')).toBe('<div class="md"><p>Run <code>x</code> <strong>now</strong> &lt;b&gt;</p><pre><code>hi</code></pre></div>')
  })
})
