import { it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import BrowserPasswords from '../components/BrowserPasswords.vue'

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
