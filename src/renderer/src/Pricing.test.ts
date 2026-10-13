import { describe, expect, it } from 'vitest'
import { fromRows, num, toRow } from './Pricing'

describe('price rows', () => {
  it('round-trips prices and skips empty rows', () => {
    const long = { above: 99_999, in: 0.5, out: 2.5 }
    const rows = [toRow('a', { in: 4, out: 20, cacheRead: 0.2, long }), toRow('b'), { ...toRow('c'), in: '0,3'.replace(',', '.'), out: '1.2' }]
    expect(fromRows(rows)).toEqual({ a: { in: 4, out: 20, cacheRead: 0.2, long }, c: { in: 0.3, out: 1.2 } })
  })
  it('rejects half-filled or negative prices', () => {
    expect(() => fromRows([{ ...toRow('a'), in: '1' }])).toThrow('E_PRICE')
    expect(() => fromRows([{ ...toRow('a'), in: '-1', out: '1' }])).toThrow('E_PRICE')
  })
  it('prints prices without float noise', () => {
    expect([num(0.1 + 0.2), num(4), num(0.000125)]).toEqual(['0.3', '4', '0.000125'])
  })
})
