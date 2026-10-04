import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { settings } from '../settings'
import { flushPromises, mount } from '@vue/test-utils'
import UsageMenu from '../components/UsageMenu.vue'

// Cursor: a failed usage read is not an expired sign-in, and the compact row
// shows Cursor's own model pool.
describe('Cursor usage in the menu', () => {
  const epoch = Date.parse('2026-09-28T18:00:00Z')
  let wrapper, previousApi, api
  const cursorReading = (windows) => ({
    ok: true,
    provider: 'cursor',
    accountId: null,
    observedAt: epoch,
    windows
  })
  beforeEach(() => {
    settings.hiddenUsageProviders = []
    vi.useFakeTimers()
    vi.setSystemTime(epoch)
    previousApi = window.shellApi
    api = {
      getUsage: vi.fn(async () => ({ agents: [] })),
      accounts: { list: vi.fn(async () => ({ ok: true, providers: [] })) },
      providerUsage: {
        capabilities: vi.fn(async () => ({
          ok: true,
          providers: [{ id: 'cursor', name: 'Cursor', quota: true }]
        })),
        read: vi.fn()
      }
    }
    window.shellApi = api
  })
  afterEach(() => {
    wrapper?.unmount()
    window.shellApi = previousApi
    vi.restoreAllMocks()
    vi.useRealTimers()
  })
  async function openCursor() {
    wrapper = mount(UsageMenu, { attachTo: document.body })
    await flushPromises()
    await wrapper.get('[data-test="usage-button"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-test="usage-row-cursor"]').trigger('click')
    await flushPromises()
  }
  const flyout = () => wrapper.get('[data-test="usage-provider-flyout"]')

  it('offers Retry, not a new sign-in, when the usage could not be read', async () => {
    api.providerUsage.read.mockResolvedValue({
      ok: false,
      provider: 'cursor',
      accountId: null,
      code: 'server',
      error: 'Cursor usage could not be read (HTTP 403).'
    })
    await openCursor()
    expect(flyout().text()).toContain('Cursor usage could not be read (HTTP 403).')
    expect(wrapper.find('[data-test="usage-provider-sign-in"]').exists()).toBe(false)
    expect(wrapper.get('[data-test="usage-row-cursor"]').text()).toContain('Usage could not be read')
    const calls = api.providerUsage.read.mock.calls.length
    api.providerUsage.read.mockResolvedValue(cursorReading([{ label: 'Cursor models', usedPct: 10 }]))
    await wrapper.get('[data-test="usage-provider-retry"]').trigger('click')
    await flushPromises()
    expect(api.providerUsage.read).toHaveBeenCalledTimes(calls + 1)
    expect(wrapper.find('[data-test="usage-provider-retry"]').exists()).toBe(false)
    expect(flyout().text()).not.toContain('HTTP 403')
  })

  it('asks to sign in again only when the sign-in expired', async () => {
    api.providerUsage.read.mockResolvedValue({
      ok: false,
      provider: 'cursor',
      accountId: null,
      code: 'expired',
      error: 'Cursor sign-in expired. Sign in again with Cursor or cursor-agent login.'
    })
    await openCursor()
    expect(wrapper.find('[data-test="usage-provider-retry"]').exists()).toBe(false)
    expect(wrapper.get('[data-test="usage-row-cursor"]').text()).toContain('Sign in again')
    await wrapper.get('[data-test="usage-provider-sign-in"]').trigger('click')
    expect(wrapper.emitted('accounts')).toHaveLength(1)
  })

  it('shows the Cursor models pool in the compact row, while the icon still warns of a full pool', async () => {
    api.providerUsage.read.mockResolvedValue(
      cursorReading([
        { label: 'Monthly', usedPct: 12 },
        { label: 'Cursor models', usedPct: 7 },
        { label: 'Other models', usedPct: 100 }
      ])
    )
    await openCursor()
    await wrapper.get('[data-test="usage-provider-back"]').trigger('click')
    const row = wrapper.get('[data-test="usage-row-cursor"]')
    expect(row.get('.usage-summary-pct').text()).toBe('7%')
    expect(wrapper.get('[data-test="usage-button"]').classes()).toContain('usage-bad')
  })

  it('falls back to the fullest window when Cursor reports no model pool', async () => {
    api.providerUsage.read.mockResolvedValue(
      cursorReading([{ label: 'Monthly requests', usedPct: 40 }, { label: 'On demand', usedPct: 65 }])
    )
    await openCursor()
    await wrapper.get('[data-test="usage-provider-back"]').trigger('click')
    expect(wrapper.get('[data-test="usage-row-cursor"] .usage-summary-pct').text()).toBe('65%')
  })
})
