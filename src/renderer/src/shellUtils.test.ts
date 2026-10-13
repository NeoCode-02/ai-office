import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../../shared/types'
import { errCode, httpsUrl, meter, parseUsd, rovingStep, updateState, withDefaults } from './shellUtils'

describe('errCode', () => {
  it('finds the code of errors from the main process', () => {
    expect(errCode(new Error("Error invoking remote method 'deleteProvider': Error: E_PROVIDER_IN_USE|Ann (Studio), Bo (Lab)"))).toBe('E_PROVIDER_IN_USE')
    expect(errCode(new Error('E_RUN_ACTIVE'))).toBe('E_RUN_ACTIVE')
    expect(errCode('E_CAP_REACHED|day')).toBe('E_CAP_REACHED')
  })

  it('is null for anything else', () => {
    expect(errCode(new Error('socket hang up'))).toBeNull()
    expect(errCode(new Error('E_PROVIDER_IN_USEx'))).toBeNull()
    expect(errCode(undefined)).toBeNull()
  })
})

describe('parseUsd', () => {
  it('reads amounts, treating empty as no cap', () => {
    expect(['', ' 3 ', '2.5', '2,5', '.5', '10.'].map(parseUsd)).toEqual([0, 3, 2.5, 2.5, 0.5, 10])
  })

  it('rejects negative, non-numeric and exotic input', () => {
    for (const s of ['-1', 'abc', '.', '1e3', 'Infinity', 'NaN', '1.2.3', '0x10']) expect(parseUsd(s), s).toBeNull()
  })
})

describe('meter', () => {
  it('marks 80% as high and the full limit as full', () => {
    expect(meter(7.9, 10)).toEqual({ pct: 79, level: '' })
    expect(meter(8, 10).level).toBe('high')
    expect(meter(10, 10)).toEqual({ pct: 100, level: 'full' })
    expect(meter(25, 10)).toEqual({ pct: 100, level: 'full' })
  })

  it('shows nothing without a limit, and never a negative bar', () => {
    expect(meter(5, 0)).toEqual({ pct: 0, level: '' })
    expect(meter(5, NaN)).toEqual({ pct: 0, level: '' })
    expect(meter(-1, 10)).toEqual({ pct: 0, level: '' })
  })
})

describe('httpsUrl', () => {
  it('lets only https links through', () => {
    expect(httpsUrl('https://github.com/NeoCode-02/ai-office/releases/tag/v0.3.0')).toBe('https://github.com/NeoCode-02/ai-office/releases/tag/v0.3.0')
    for (const u of ['http://example.com', 'javascript:alert(1)', 'file:///etc/passwd', 'https://a b', '', null, undefined]) expect(httpsUrl(u), String(u)).toBeNull()
  })
})

describe('withDefaults', () => {
  it('fills settings saved by an older version and drops wrong values', () => {
    expect(withDefaults(undefined)).toEqual(DEFAULT_SETTINGS)
    expect(withDefaults({ theme: 'dark' })).toEqual({ ...DEFAULT_SETTINGS, theme: 'dark' })
    const bad = { theme: 'neon', dailyCapUsd: -5, monthlyCapUsd: Infinity, notifications: 'yes', checkUpdates: 0 } as unknown as Partial<typeof DEFAULT_SETTINGS>
    expect(withDefaults(bad)).toEqual(DEFAULT_SETTINGS)
    expect(withDefaults({ dailyCapUsd: 2.5, monthlyCapUsd: 40, notifications: false, checkUpdates: false, theme: 'light' })).toEqual({
      theme: 'light',
      dailyCapUsd: 2.5,
      monthlyCapUsd: 40,
      notifications: false,
      checkUpdates: false
    })
  })
})

describe('updateState', () => {
  it('tells a newer release from being up to date or having no release', () => {
    expect(updateState({ current: '0.3.0', latest: '0.4.0', url: 'https://x', newer: true })).toBe('newer')
    expect(updateState({ current: '0.3.0', latest: '0.3.0', url: 'https://x', newer: false })).toBe('latest')
    expect(updateState({ current: '0.3.0', latest: null, url: null, newer: false })).toBe('none')
    expect(updateState({ current: '0.3.0', latest: null, url: null, newer: true })).toBe('none')
  })
})

describe('rovingStep', () => {
  const tabs = ['work', 'team', 'settings'] as const
  it('moves along its axis and wraps around', () => {
    expect(rovingStep(tabs, 'work', 'ArrowRight', 'x')).toBe('team')
    expect(rovingStep(tabs, 'work', 'ArrowLeft', 'x')).toBe('settings')
    expect(rovingStep(tabs, 'settings', 'ArrowRight', 'x')).toBe('work')
    expect(rovingStep(tabs, 'team', 'ArrowDown', 'y')).toBe('settings')
    expect(rovingStep(tabs, 'work', 'ArrowUp', 'y')).toBe('settings')
  })

  it('handles Home/End, keys of the other axis and a start outside the list', () => {
    expect(rovingStep(tabs, 'team', 'Home', 'x')).toBe('work')
    expect(rovingStep(tabs, 'team', 'End', 'y')).toBe('settings')
    expect(rovingStep(tabs, 'team', 'ArrowDown', 'x')).toBeNull()
    expect(rovingStep(tabs, 'team', 'Enter', 'y')).toBeNull()
    expect(rovingStep<string>(tabs, null, 'ArrowDown', 'y')).toBe('work')
    expect(rovingStep<string>(tabs, 'gone', 'ArrowUp', 'y')).toBe('settings')
    expect(rovingStep([], null, 'ArrowDown', 'y')).toBeNull()
  })
})
