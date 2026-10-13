import { describe, expect, it } from 'vitest'
import { createLayers, trapStep, type Layer } from './layers'

// Fake elements: their number is their position in the document.
const el = (n: number) => ({ n }) as unknown as Element
const pos = (e: Element) => (e as unknown as { n: number }).n
const layer = (name: string, level: number, at: number | null, closed: string[]): Layer => ({
  level,
  el: () => (at === null ? null : el(at)),
  close: () => closed.push(name)
})

describe('layers', () => {
  it('closes only the top-most layer: a modal over a sheet, a menu over a modal', () => {
    const closed: string[] = []
    const layers = createLayers((a, b) => pos(a) < pos(b))
    const removeSheet = layers.add(layer('sheet', 1, 5, closed))
    const removeModal = layers.add(layer('modal', 2, 1, closed))
    layers.top()?.close()
    expect(closed).toEqual(['modal'])
    const removeMenu = layers.add(layer('menu', 3, 0, closed))
    expect(layers.top()?.level).toBe(3)
    removeMenu()
    removeModal()
    layers.top()?.close()
    expect(closed).toEqual(['modal', 'sheet'])
    removeSheet()
    expect(layers.top()).toBeUndefined()
    expect(layers.size).toBe(0)
  })

  it('puts the later one in the document on top among equal levels, else the newer one', () => {
    const closed: string[] = []
    const layers = createLayers((a, b) => pos(a) < pos(b))
    // A modal nested inside another modal's body comes later in the document, even if it registered first.
    layers.add(layer('inner', 2, 9, closed))
    layers.add(layer('outer', 2, 3, closed))
    layers.top()?.close()
    expect(closed).toEqual(['inner'])

    const unmounted = createLayers((a, b) => pos(a) < pos(b))
    unmounted.add(layer('first', 2, null, closed))
    unmounted.add(layer('second', 2, null, closed))
    unmounted.top()?.close()
    expect(closed).toEqual(['inner', 'second'])
  })

  it('removing twice does not remove another layer', () => {
    const layers = createLayers(() => false)
    const remove = layers.add(layer('a', 1, null, []))
    layers.add(layer('b', 1, null, []))
    remove()
    remove()
    expect(layers.size).toBe(1)
  })
})

describe('trapStep', () => {
  it('wraps Tab from the last element to the first and Shift+Tab from the first to the last', () => {
    expect(trapStep(2, 3, false)).toBe(0)
    expect(trapStep(0, 3, true)).toBe(2)
  })

  it('lets the browser move focus in between', () => {
    expect(trapStep(0, 3, false)).toBeNull()
    expect(trapStep(1, 3, true)).toBeNull()
  })

  it('brings focus back in from outside, and keeps it on the container when nothing can be focused', () => {
    expect(trapStep(-1, 3, false)).toBe(0)
    expect(trapStep(-1, 3, true)).toBe(2)
    expect(trapStep(-1, 0, false)).toBe(-1)
    expect(trapStep(0, 1, false)).toBe(0)
  })
})
