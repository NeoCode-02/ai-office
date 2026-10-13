import os from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { htmlToText, isOwnAddress, webFetch } from './fetch'

describe('htmlToText', () => {
  it('keeps visible text, line breaks and entities', () => {
    expect(htmlToText('<p>Hi &amp; bye</p><SCRIPT>x()</script ><div>next<br/>line</div>')).toBe('Hi & bye\nnext\nline')
    expect(htmlToText('a<svg><text>no</text></svg>b<style>p{}</STYLE>c')).toBe('abc')
  })

  it('takes linear time on hostile markup', () => {
    const inputs = ['<script'.repeat(100_000), '<'.repeat(400_000), `<a ${'<b '.repeat(100_000)}`, `${'\n \t'.repeat(200_000)}x`, `<script>${'</scrip'.repeat(50_000)}`]
    for (const html of inputs) {
      const t = performance.now()
      htmlToText(html)
      expect(performance.now() - t).toBeLessThan(300)
    }
  })

  it('stops at an unclosed tag instead of showing markup', () => {
    expect(htmlToText('ok <script>secret')).toBe('ok')
    expect(htmlToText('ok <a href')).toBe('ok')
  })

  it('keeps positions right when lowercasing changes the length', () => {
    expect(htmlToText('İİ<script>x</script>after')).toBe('İİafter')
  })
})

describe('isOwnAddress', () => {
  const ifaces = {
    eth0: [
      { address: '203.0.113.7', family: 'IPv4' as const, netmask: '', mac: '', internal: false, cidr: null },
      { address: '2001:db8::1:2', family: 'IPv6' as const, netmask: '', mac: '', internal: false, cidr: null, scopeid: 0 }
    ]
  }

  it('matches the machine’s own addresses in any IPv6 spelling', () => {
    expect(isOwnAddress('203.0.113.7', ifaces)).toBe(true)
    expect(isOwnAddress('2001:0db8:0:0:0:0:1:2', ifaces)).toBe(true)
    expect(isOwnAddress('[2001:db8::1:2]', ifaces)).toBe(true)
    expect(isOwnAddress('203.0.113.8', ifaces)).toBe(false)
    expect(isOwnAddress('example.com', ifaces)).toBe(false)
  })

  it('asks before fetching the computer’s own public address', async () => {
    const spy = vi.spyOn(os, 'networkInterfaces').mockReturnValue(ifaces)
    try {
      await expect(webFetch('http://203.0.113.7:1/admin')).rejects.toThrow(/^Refused: 203\.0\.113\.7/)
      await expect(webFetch('http://[2001:db8::1:2]:1/admin')).rejects.toThrow(/^Refused/)
    } finally {
      spy.mockRestore()
    }
  })
})
