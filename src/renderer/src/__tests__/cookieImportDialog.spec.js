// The cookie-import dialog (CookieImportDialog.vue): it lists the detected
// browsers, preselects the system default and its default profile, imports the
// chosen profile or a file, and shows counts — never a cookie value.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import CookieImportDialog from '../components/CookieImportDialog.vue'
import { settings, resetSettings } from '../settings'

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
    pickCookieFile: vi.fn().mockResolvedValue({ token: 'tok-1', name: 'cookies.json' }),
    importCookieFile: vi.fn().mockResolvedValue({ ok: true, summary: { total: 5, imported: 5, skipped: 0, reasons: {}, domains: ['x.com'] } }),
    clearImportedCookies: vi.fn().mockResolvedValue({ ok: true })
  }
  window.shellApi = { browser: api }
  resetSettings()
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
    expect(api.importCookieFile).toHaveBeenCalledWith({ token: 'tok-1', domainFilter: '' })
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

  it("turns on the agents' separate session at the first import, and says so", async () => {
    const wrapper = await open()
    await wrapper.find('[data-test="cookie-import"]').trigger('click')
    await flushPromises()
    expect(settings.browserAgentSeparateSession).toBe(true)
    expect(wrapper.find('[data-test="cookie-separate-note"]').text()).toMatch(/Agents now use a separate session without these logins; change it in Settings > Browser/)
    // A second import: no note again.
    await wrapper.find('[data-test="cookie-import"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="cookie-separate-note"]').exists()).toBe(false)
  })

  it('shows when a profile was imported before', async () => {
    SOURCES[1].profiles[1].lastImport = { at: Date.UTC(2026, 9, 3, 12), imported: 2180 }
    try {
      const wrapper = await open()
      const last = wrapper.findAll('[data-test="cookie-last-import"]')
      expect(last).toHaveLength(1)
      expect(last[0].text()).toMatch(/^Imported on .*2026 · 2180 cookies$/)
    } finally {
      delete SOURCES[1].profiles[1].lastImport
    }
  })

  it('says a re-import was already done, with new / updated / unchanged and the reasons', async () => {
    api.importCookies.mockResolvedValue({
      ok: true,
      summary: {
        total: 3317,
        imported: 2180,
        added: 12,
        updated: 3,
        unchanged: 2165,
        previousAt: Date.UTC(2026, 9, 3, 12),
        skipped: 1137,
        reasons: { google: 89, expired: 700, partitioned: 300, container: 40, invalidHost: 5, invalid: 3 },
        domains: []
      }
    })
    const wrapper = await open()
    await wrapper.find('[data-test="cookie-import"]').trigger('click')
    await flushPromises()
    const text = wrapper.find('[data-test="cookie-result-text"]').text()
    expect(text).toMatch(/^Already imported on .*2026\. This time: 12 new, 3 updated, 2165 unchanged\./)
    expect(text).toContain('Skipped 89 Google cookies')
    expect(text).toContain('skipped 1048 others')
    const details = wrapper.find('[data-test="cookie-details"]')
    expect(details.find('summary').text()).toBe('Details')
    const rows = Object.fromEntries(details.findAll('li').map((li) => [li.attributes('data-reason'), li.text()]))
    expect(rows).toMatchObject({ expired: expect.stringContaining('700'), partitioned: expect.stringContaining('300'), container: expect.stringContaining('40'), invalidHost: expect.stringContaining('5'), google: expect.stringContaining('89'), other: expect.stringContaining('3') })
  })

  it('a first import with a comparison says how many are new', async () => {
    api.importCookies.mockResolvedValue({ ok: true, summary: { total: 2, imported: 2, added: 2, updated: 0, unchanged: 0, previousAt: null, skipped: 0, reasons: {}, domains: [] } })
    const wrapper = await open()
    await wrapper.find('[data-test="cookie-import"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="cookie-result-text"]').text()).toBe('Imported 2 cookies: 2 new, 0 updated, 0 unchanged.')
    expect(wrapper.find('[data-test="cookie-details"]').exists()).toBe(false)
  })

  it('does not touch the setting when the import fails', async () => {
    api.importCookies.mockResolvedValue({ ok: false, code: 'locked' })
    const wrapper = await open()
    await wrapper.find('[data-test="cookie-import"]').trigger('click')
    await flushPromises()
    expect(settings.browserAgentSeparateSession).toBe(false)
  })
})
