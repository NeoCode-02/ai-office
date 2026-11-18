import { describe, expect, it } from 'vitest'
import { plain } from './speech'

describe('plain', () => {
  it('keeps the words of a Markdown reply and drops markup, links and code', () => {
    const md = [
      '## Done',
      '',
      'Daniel wrote **hello.txt** and checked `node --version`.',
      '- See [the report](https://example.com/r)',
      '1. _Next_: ~~old~~ tests',
      '```js',
      'console.log(1)',
      '```',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |'
    ].join('\n')
    expect(plain(md)).toBe('Done\nDaniel wrote hello.txt and checked node --version.\nSee the report\nNext: old tests\na b\n1 2')
  })

  it('leaves a snake_case name and a lone asterisk alone', () => {
    expect(plain('Run read_file on a*b')).toBe('Run read_file on a*b')
  })
})
