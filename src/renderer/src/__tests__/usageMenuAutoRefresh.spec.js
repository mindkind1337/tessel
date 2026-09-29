import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { settings } from '../settings'
import { flushPromises, mount } from '@vue/test-utils'
import UsageMenu from '../components/UsageMenu.vue'

// The automatic refresh's readings (main/usagePoller.js) colour the icon without a click.
describe('usage menu automatic refresh', () => {
  let wrapper, api, previousApi, push
  const epoch = Date.parse('2026-09-29T12:00:00Z')
  const reading = (usedPct, extra = {}) => ({
    ok: true,
    provider: 'kimi',
    accountId: null,
    observedAt: epoch,
    windows: [{ label: 'Weekly', usedPct, resetsAt: new Date(epoch + 3600000).toISOString() }],
    ...extra
  })

  beforeEach(() => {
    settings.hiddenUsageProviders = []
    settings.usageRefreshMinutes = 15
    vi.useFakeTimers()
    vi.setSystemTime(epoch)
    previousApi = window.shellApi
    api = {
      getUsage: vi.fn(async () => ({ agents: [] })),
      providerUsage: {
        capabilities: vi.fn(async () => ({
          ok: true,
          providers: [{ id: 'kimi', name: 'Kimi', quota: true }]
        })),
        read: vi.fn(async () => reading(10)),
        autoRefresh: vi.fn(async () => ({ ok: true })),
        onUpdate: vi.fn((cb) => {
          push = cb
          return vi.fn()
        })
      }
    }
    window.shellApi = api
  })
  afterEach(() => {
    wrapper?.unmount()
    window.shellApi = previousApi
    settings.usageRefreshMinutes = 15
    vi.restoreAllMocks()
    vi.useRealTimers()
  })
  const button = () => wrapper.get('[data-test="usage-button"]')

  it('configures the refresh and turns the icon amber then red from pushed readings', async () => {
    wrapper = mount(UsageMenu, { attachTo: document.body })
    await flushPromises()
    expect(api.providerUsage.autoRefresh).toHaveBeenCalledWith({ hidden: [], intervalMs: 900000 })
    expect(api.providerUsage.read).not.toHaveBeenCalled()
    await push(reading(70))
    await nextTick()
    expect(button().classes()).toContain('usage-warn')
    await push(reading(96))
    await nextTick()
    expect(button().classes()).toContain('usage-bad')
    // A reading kept through a failed refresh still colours the icon.
    await push(reading(97, { kept: true, stale: true, error: 'down' }))
    await nextTick()
    expect(button().classes()).toContain('usage-bad')
    // A plain failure leaves only a last-known reading: no colour.
    await push({ ok: false, provider: 'kimi', accountId: null, code: 'network', error: 'down' })
    await nextTick()
    expect(button().classes()).not.toContain('usage-bad')
  })

  it('ignores readings of hidden providers and follows the Settings interval', async () => {
    wrapper = mount(UsageMenu, { attachTo: document.body })
    await flushPromises()
    settings.usageRefreshMinutes = 0
    settings.hiddenUsageProviders = ['kimi']
    await nextTick()
    expect(api.providerUsage.autoRefresh).toHaveBeenLastCalledWith({ hidden: ['kimi'], intervalMs: 0 })
    await push(reading(99))
    await nextTick()
    expect(button().classes()).not.toContain('usage-bad')
    settings.hiddenUsageProviders = []
  })
})
