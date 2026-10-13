import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { Menu, Modal, Sheet } from './ui'
import { CapsCard } from './Usage'

// useT subscribes to the chosen language, which server rendering cannot do; English is enough here.
vi.mock('./i18n', async (load) => {
  const i18n = await load<typeof import('./i18n')>()
  return { ...i18n, useT: () => i18n.LANGS.en }
})

describe('dialogs and menus', () => {
  it('names a modal by its title', () => {
    const html = renderToStaticMarkup(
      <Modal title="Add provider" onClose={() => undefined}>
        <input />
      </Modal>
    )
    const id = /<h3 id="([^"]+)">Add provider<\/h3>/.exec(html)?.[1]
    expect(id).toBeTruthy()
    expect(html).toContain(`role="dialog" aria-modal="true" aria-labelledby="${id}" tabindex="-1"`)
  })

  it('renders a closed menu as a button that announces its popup', () => {
    const html = renderToStaticMarkup(<Menu label="Add office" icon="plus" items={[{ label: 'New office', onSelect: () => undefined }]} />)
    expect(html).toContain('aria-haspopup="menu"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('aria-label="Add office"')
    expect(html).not.toContain('role="menu"')
  })

  it('labels a sheet when asked', () => {
    expect(renderToStaticMarkup(<Sheet head={null} label="Changes" onClose={() => undefined}>x</Sheet>)).toContain('aria-label="Changes"')
  })
})

describe('CapsCard', () => {
  const html = (day: number, month: number, dailyCapUsd: number, monthlyCapUsd: number) =>
    renderToStaticMarkup(<CapsCard caps={{ day, month, dailyCapUsd, monthlyCapUsd }} onEdit={() => undefined} />)

  it('is hidden when no cap is set', () => {
    expect(html(3, 40, 0, 0)).toBe('')
  })

  it('shows only the caps that are set, with warning levels', () => {
    const month = html(3, 85, 0, 100)
    expect(month).toContain('This month')
    expect(month).not.toContain('Today')
    expect(month).toContain('class="meter high"')
    expect(month).toContain('aria-valuenow="85"')
    expect(month).toContain('Over 80% of the cap is used.')

    const both = html(12, 20, 10, 100)
    expect(both).toContain('class="meter full"')
    expect(both).toContain('Daily cap reached.')
    expect(both).toContain('$12.00 of $10.00')
    expect(both).toContain('$20.00 of $100.00')
  })
})
