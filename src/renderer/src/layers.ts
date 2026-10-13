/** Something Escape closes: a menu (3) above a modal (2) above a sheet (1). */
export interface Layer {
  level: number
  el(): Element | null
  close(): void
}

// Node.DOCUMENT_POSITION_FOLLOWING; spelled out so this file also loads outside a browser.
const FOLLOWING = 4
const domBefore = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & FOLLOWING)

/**
 * Open layers, so Escape closes only the top-most one. Among equal levels the one later in the
 * document is on top (a modal inside a sheet, or opened after another), else the one opened last.
 */
export function createLayers(before: (a: Element, b: Element) => boolean = domBefore) {
  const list: Layer[] = []
  const above = (a: Layer, b: Layer) => {
    if (a.level !== b.level) return a.level > b.level
    const ea = a.el()
    const eb = b.el()
    if (ea && eb && ea !== eb) return before(eb, ea)
    return list.indexOf(a) > list.indexOf(b)
  }
  return {
    add(layer: Layer) {
      list.push(layer)
      return () => {
        const i = list.indexOf(layer)
        if (i >= 0) list.splice(i, 1)
      }
    },
    top(): Layer | undefined {
      return list.reduce<Layer | undefined>((best, l) => (!best || above(l, best) ? l : best), undefined)
    },
    get size() {
      return list.length
    }
  }
}

/**
 * Where Tab should move inside a focus trap of `count` elements when focus is at `index`
 * (-1 = not on any of them). null = let the browser move it; -1 = focus the container itself.
 */
export function trapStep(index: number, count: number, back: boolean): number | null {
  if (count === 0) return -1
  if (index < 0) return back ? count - 1 : 0
  if (back && index === 0) return count - 1
  if (!back && index === count - 1) return 0
  return null
}
