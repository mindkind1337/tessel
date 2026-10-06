// The cookie-import dialog (CookieImportDialog.vue): it lists the detected
// browsers, preselects the system default and its default profile, imports the
// chosen profile or a file, and shows counts — never a cookie value.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import CookieImportDialog from '../components/CookieImportDialog.vue'

const SOURCES = [
  {
    id: 'chrome',
    name: 'Google Chrome',
    family: 'chromium',
    isDefault: false,
    profiles: [{ dir: 'C/chrome/Default', name: 'Personal', lastUsed: true, cookieCount: 120, appBoundCount: 3 }]
  },
  {
    id: 'edge',
    name: 'Microsoft Edge',
    family: 'chromium',
    isDefault: true,
    profiles: [
      { dir: 'C/edge/Default', name: 'Personal', lastUsed: false, cookieCount: 10, appBoundCount: 0 },
      { dir: 'C/edge/Profile 1', name: 'Work', lastUsed: true, cookieCount: 40, appBoundCount: 0 }
    ]
  }
]

let api
beforeEach(() => {
  api = {
    cookieSources: vi.fn().mockResolvedValue(SOURCES),
    importCookies: vi.fn().mockResolvedValue({ ok: true, summary: { total: 50, imported: 47, skipped: 3, reasons: { appBound: 0, google: 2, expired: 1 }, domains: ['github.com'] } }),
    pickCookieFile: vi.fn().mockResolvedValue('C:/exports/cookies.json'),
    importCookieFile: vi.fn().mockResolvedValue({ ok: true, summary: { total: 5, imported: 5, skipped: 0, reasons: {}, domains: ['x.com'] } }),
    clearImportedCookies: vi.fn().mockResolvedValue({ ok: true })
  }
  window.shellApi = { browser: api }
})
afterEach(() => {
  delete window.shellApi
  vi.clearAllMocks()
})

async function open() {
  const wrapper = mount(CookieImportDialog)
  await flushPromises()
  return wrapper
}

describe('CookieImportDialog', () => {
  it('preselects the default browser and its default profile', async () => {
    const wrapper = await open()
    // Edge is the system default and its Work profile is the last used.
    expect(wrapper.vm.selected).toEqual({ browserId: 'edge', profileDir: 'C/edge/Profile 1' })
    expect(wrapper.text()).toContain('Default browser')
  })

  it('imports the chosen profile and shows counts, never a value', async () => {
    const wrapper = await open()
    await wrapper.find('[data-test="cookie-import"]').trigger('click')
    await flushPromises()
    expect(api.importCookies).toHaveBeenCalledWith({ browserId: 'edge', profileDir: 'C/edge/Profile 1', domainFilter: '' })
    const result = wrapper.find('[data-test="cookie-result"]').text()
    expect(result).toContain('Imported 47 cookies')
    expect(result).toContain('Google')
    expect(result).not.toMatch(/token|value|secret/i)
  })

  it('passes a domain filter through', async () => {
    const wrapper = await open()
    await wrapper.find('.cookie-filter-input').setValue('github.com, linear.app')
    await wrapper.find('[data-test="cookie-import"]').trigger('click')
    await flushPromises()
    expect(api.importCookies).toHaveBeenCalledWith(expect.objectContaining({ domainFilter: 'github.com, linear.app' }))
  })

  it('imports from a file when asked', async () => {
    const wrapper = await open()
    await wrapper.find('[data-test="cookie-import-file"]').trigger('click')
    await flushPromises()
    expect(api.pickCookieFile).toHaveBeenCalled()
    expect(api.importCookieFile).toHaveBeenCalledWith({ filePath: 'C:/exports/cookies.json', domainFilter: '' })
  })

  it('warns that agents act with these logins', async () => {
    const wrapper = await open()
    expect(wrapper.text()).toMatch(/agents.*browser tools.*act with them/i)
  })

  it('shows a friendly message when a browser is locked', async () => {
    api.importCookies.mockResolvedValue({ ok: false, code: 'locked' })
    const wrapper = await open()
    await wrapper.find('[data-test="cookie-import"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toMatch(/Close that browser first/i)
  })
})
