import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { Markdown, safeUrl } from './markdown'

// useT subscribes with useSyncExternalStore, which server rendering can't do; the app renders on the client.
vi.mock('./i18n', async (load) => {
  const m = await load<typeof import('./i18n')>()
  return { ...m, useT: () => m.LANGS.en }
})

const html = (text: string) => renderToStaticMarkup(<Markdown text={text} />)
const inner = (text: string) => html(text).replace(/^<div class="md">|<\/div>$/g, '')

describe('Markdown', () => {
  it('keeps text that follows a heading in the same block', () => {
    expect(html('## Result\nIt works.\n\n- a\n- b')).toBe('<div class="md"><h4>Result</h4><p>It works.</p><ul><li>a</li><li>b</li></ul></div>')
  })

  it('renders code, bold and fenced blocks without raw HTML', () => {
    expect(html('Run `x` **now** <b>\n```\nhi\n```')).toBe('<div class="md"><p>Run <code>x</code> <strong>now</strong> &lt;b&gt;</p><pre><code>hi</code></pre></div>')
  })

  it('links only http, https and mailto, opening outside the app', () => {
    expect(inner('[docs](https://example.com/a?b=1)')).toBe(
      '<p><a href="https://example.com/a?b=1" target="_blank" rel="noreferrer" title="https://example.com/a?b=1">docs</a></p>'
    )
    expect(inner('[mail](mailto:team@example.com)')).toContain('href="mailto:team@example.com"')
    expect(inner('[wiki](https://en.wikipedia.org/wiki/Tree_(graph))')).toContain('href="https://en.wikipedia.org/wiki/Tree_(graph)"')
  })

  it('renders javascript:, data: and relative links as plain text', () => {
    for (const bad of ['[click](javascript:alert(1))', '[x](JavaScript:alert(1))', '[x](data:text/html,hi)', '[x](/etc/passwd)', '[x](//evil.example)']) {
      const out = html(bad)
      expect(out).not.toContain('<a')
      expect(out).toContain(bad.replace(/&/g, '&amp;'))
    }
    expect(safeUrl('java\tscript:alert(1)')).toBeNull()
    expect(safeUrl('https://')).toBeNull()
    expect(safeUrl('http://localhost:3000/x')).toBe('http://localhost:3000/x')
  })

  it('links bare URLs without the punctuation around them', () => {
    expect(inner('See https://example.com/a.')).toBe('<p>See <a href="https://example.com/a" target="_blank" rel="noreferrer" title="https://example.com/a">https://example.com/a</a>.</p>')
    expect(inner('(at https://example.com/x)')).toContain('>https://example.com/x</a>)</p>')
    expect(inner('`https://example.com` and javascript:alert(1)')).toBe('<p><code>https://example.com</code> and javascript:alert(1)</p>')
  })

  it('does not nest links inside link text', () => {
    expect(inner('[see https://b.example](https://a.example)')).toBe(
      '<p><a href="https://a.example/" target="_blank" rel="noreferrer" title="https://a.example/">see https://b.example</a></p>'
    )
  })

  it('renders italics, strikethrough and bold italics, but leaves snake_case alone', () => {
    expect(inner('*one* _two_ ~~gone~~ ***both***')).toBe('<p><em>one</em> <em>two</em> <del>gone</del> <strong><em>both</em></strong></p>')
    expect(inner('call snake_case_name and __init__ with 2 * 3 * 4')).toBe('<p>call snake_case_name and __init__ with 2 * 3 * 4</p>')
    expect(inner('**bold with *italic* inside**')).toBe('<p><strong>bold with <em>italic</em> inside</strong></p>')
  })

  it('maps heading levels and renders quotes and rules', () => {
    expect(inner('# One\n### Three\n###### Six')).toBe('<h3>One</h3><h5>Three</h5><h6>Six</h6>')
    expect(inner('#hashtag')).toBe('<p>#hashtag</p>')
    expect(inner('> quoted\n> **more**\n\nafter')).toBe('<blockquote><p>quoted<br/><strong>more</strong></p></blockquote><p>after</p>')
    expect(inner('a\n\n---\n\nb')).toBe('<p>a</p><hr/><p>b</p>')
  })

  it('renders GFM tables with alignment', () => {
    expect(inner('| Name | Cost |\n|:-----|-----:|\n| `a` | 1 |\n| b \\| c |')).toBe(
      '<div class="md-table"><table><thead><tr><th style="text-align:left">Name</th><th style="text-align:right">Cost</th></tr></thead>' +
        '<tbody><tr><td style="text-align:left"><code>a</code></td><td style="text-align:right">1</td></tr>' +
        '<tr><td style="text-align:left">b | c</td><td style="text-align:right"></td></tr></tbody></table></div>'
    )
    expect(inner('a | b\n--- | ---')).toContain('<thead>')
    expect(inner('a | b\n---')).not.toContain('<table')
  })

  it('labels fenced code with its language and a copy button, escaping the code', () => {
    const out = inner('```ts\nconst a = "<script>"\n```')
    expect(out).toContain('<span class="ellipsis">ts</span>')
    expect(out).toContain('<button type="button" class="md-copy"')
    expect(out).toContain('<pre><code>const a = &quot;&lt;script&gt;&quot;</code></pre>')
    expect(out).not.toContain('<script')
  })

  it('shows an unfinished fence as code, as while a reply is being written', () => {
    expect(inner('Here:\n```\nline 1\n# not a heading')).toBe('<p>Here:</p><pre><code>line 1\n# not a heading</code></pre>')
  })

  it('nests lists, keeps ordered starts and shows task boxes', () => {
    expect(inner('1. one\n2. two\n   - sub\n   - sub2\n3. three')).toBe('<ol><li>one</li><li>two<ul><li>sub</li><li>sub2</li></ul></li><li>three</li></ol>')
    expect(inner('3. c\n4. d')).toBe('<ol start="3"><li>c</li><li>d</li></ol>')
    expect(inner('- [x] done\n- [ ] todo')).toBe(
      '<ul><li class="task"><input type="checkbox" disabled="" readOnly="" checked=""/>done</li><li class="task"><input type="checkbox" disabled="" readOnly=""/>todo</li></ul>'
    )
    expect(inner('- a\ncontinued\n\nnext')).toBe('<ul><li>a<br/>continued</li></ul><p>next</p>')
  })

  it('keeps an indented code block inside its list item', () => {
    expect(inner('1. Run:\n   ```sh\n   npm test\n   ```\n2. Done')).toContain('<li>Run:<div class="md-code">')
    expect(inner('1. Run:\n   ```sh\n   npm test\n   ```\n2. Done')).toContain('<li>Done</li></ol>')
  })

  it('stays bounded on deeply nested input', () => {
    expect(() => html('>'.repeat(5000) + ' deep')).not.toThrow()
    expect(() => html(Array.from({ length: 200 }, (_, i) => `${' '.repeat(i * 2)}- level ${i}`).join('\n'))).not.toThrow()
    expect(() => html('*a '.repeat(5000))).not.toThrow()
  })
})
