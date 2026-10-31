import { it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { isProxy } from 'vue'
import BrowserPasswords from '../components/BrowserPasswords.vue'

it('sends a cloneable plain profile across Electron IPC instead of a Vue proxy', async () => {
  const passwordImportProfile = vi.fn(async (opts) => {
    expect(isProxy(opts)).toBe(false)
    expect(JSON.parse(JSON.stringify(opts))).toEqual({ browserId: 'chrome', profileDir: 'C:/fixture/Default' })
    return { ok: true, imported: 1, skipped: 0, protectedCount: 1 }
  })
  window.shellApi = { browser: {
    passwordSources: async () => ({ ok: true, sources: [{ id: 'chrome', name: 'Chrome', profiles: [{ dir: 'C:/fixture/Default', name: 'Default' }] }] }),
    passwordList: async () => ({ ok: true, entries: [] }),
    passwordImportProfile
  } }
  const wrapper = mount(BrowserPasswords, { global: { stubs: { teleport: true } } })
  try {
    await wrapper.find('[data-test=browser-passwords]').trigger('click'); await flushPromises()
    await wrapper.findAll('button').find((b) => b.text() === 'Import from browser').trigger('click'); await flushPromises()
    expect(passwordImportProfile).toHaveBeenCalledOnce()
    expect(wrapper.text()).toContain('1 imported')
    expect(wrapper.find('details').element.open).toBe(true)
    expect(wrapper.find('details').text()).toContain('Google Password Manager')
  } finally { wrapper.unmount(); delete window.shellApi }
})

it('offers import and explicit opt-in without displaying a password', async () => {
  const entry = { id: 'test', origin: 'https://example.test', username: 'fixture-user', allowAgents: false }
  window.shellApi = { browser: {
    passwordSources: vi.fn(async () => ({ ok: true, sources: [] })),
    passwordList: vi.fn(async () => ({ ok: true, entries: [entry] })),
    passwordChange: vi.fn(async () => ({ ok: true })),
    passwordFill: vi.fn(async () => ({ ok: true })),
    passwordImportCsv: vi.fn(async () => ({ ok: true, imported: 1, skipped: 0 }))
  } }
  const wrapper = mount(BrowserPasswords, { props: { guestId: 7 }, global: { stubs: { teleport: true } } })
  try {
    await wrapper.find('[data-test=browser-passwords]').trigger('click'); await flushPromises()
    expect(wrapper.text()).toContain('fixture-user')
    const checkbox = wrapper.find('input[type=checkbox]')
    expect(checkbox.element.checked).toBe(false)
    await checkbox.setValue(true); await flushPromises()
    expect(window.shellApi.browser.passwordChange).toHaveBeenCalledWith({ id: 'test', action: 'allow', allowAgents: true })
    expect(wrapper.find('input[type=password]').exists()).toBe(false)
  } finally { wrapper.unmount(); delete window.shellApi }
})
