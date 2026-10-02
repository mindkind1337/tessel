import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false, getVersion: () => '1.0.0' } }))
vi.mock('electron-updater', () => ({ autoUpdater: { on: vi.fn() } }))

const { htmlToText, createUpdater } = await import('../updater.js')

describe('htmlToText', () => {
  it('turns GitHub release-note HTML into plain text', () => {
    const html =
      '<h2>Contenu</h2>\n<ul>\n<li>Mises à jour &amp; reprise</li>\n<li>Onglets</li>\n</ul><p>Voir <a href="x">ici</a></p>'
    expect(htmlToText(html)).toBe('Contenu\n\n• Mises à jour & reprise\n\n• Onglets\n\nVoir ici')
  })
})

describe('createUpdater', () => {
  it('stays off in a dev build', async () => {
    const u = createUpdater({ log: {}, send: vi.fn(), beforeInstall: vi.fn() })
    expect(u.status.state).toBe('disabled')
    expect((await u.check()).state).toBe('disabled')
    expect(await u.install()).toBe(false)
  })
})
