// A provider its maker no longer supports (Gemini CLI for personal accounts)
// is taken out of the usage menu instead of listed as "No longer supported".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { settings } from '../settings'
import { flushPromises, mount } from '@vue/test-utils'
import UsageMenu from '../components/UsageMenu.vue'

describe('usage menu: a provider no longer supported', () => {
  let wrapper, previousApi, api
  beforeEach(() => {
    settings.hiddenUsageProviders = []
    previousApi = window.shellApi
    api = {
      getUsage: vi.fn(async () => ({ agents: [] })),
      accounts: { list: vi.fn(async () => ({ ok: true, providers: [] })) },
      providerUsage: {
        capabilities: vi.fn(async () => ({ ok: true, providers: [{ id: 'gemini', name: 'Gemini', quota: true }, { id: 'cursor', name: 'Cursor', quota: true }] })),
        read: vi.fn(async ({ provider }) =>
          provider === 'gemini'
            ? { ok: false, provider, accountId: null, code: 'unsupported', error: 'Google no longer supports Gemini CLI for personal accounts.' }
            : { ok: true, provider, accountId: null, observedAt: Date.now(), windows: [{ label: 'monthly', usedPct: 12, resetsAt: Date.now() + 3600000 }] }
        )
      }
    }
    window.shellApi = api
  })
  afterEach(() => {
    wrapper?.unmount()
    window.shellApi = previousApi
    vi.restoreAllMocks()
  })

  it('Gemini is gone from the list once its read says it is no longer supported; the others stay', async () => {
    wrapper = mount(UsageMenu, { attachTo: document.body })
    await flushPromises()
    await wrapper.get('[data-test="usage-button"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="usage-row-gemini"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('No longer supported')
    expect(wrapper.get('[data-test="usage-row-cursor"]').text()).toContain('12%')
  })

  it("a Live Share host's reading of it is not listed either", async () => {
    wrapper = mount(UsageMenu, {
      props: { hostUsage: { providers: [{ id: 'gemini', windows: [], status: 'unsupported' }, { id: 'cursor', windows: [{ label: 'monthly', usedPct: 5 }], status: 'ok' }] }, hostName: 'Ana' },
      attachTo: document.body
    })
    await flushPromises()
    await wrapper.get('[data-test="usage-button"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="usage-host-row-gemini"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="usage-host-row-cursor"]').exists()).toBe(true)
  })
})
