import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import UsageMenu from '../components/UsageMenu.vue'
import StatsUsage from '../components/StatsUsage.vue'
import { settings } from '../settings'
import { validHiddenUsageProviders } from '../../../shared/usageProviders'
let api, previous, wrapper
const catalog = [
  { id: 'codex', name: 'Codex', quota: true, report: true },
  { id: 'kimi', name: 'Kimi', quota: true, report: false },
  { id: 'cursor', name: 'Cursor', quota: true, report: false }
]
beforeEach(() => {
  previous = window.shellApi
  settings.hiddenUsageProviders = []
  api = {
    getUsage: vi.fn(async () => ({ agents: [] })),
    providerUsage: {
      capabilities: vi.fn(async () => ({ ok: true, providers: catalog })),
      read: vi.fn(async ({ provider }) => ({
        ok: true,
        provider,
        accountId: null,
        windows: [{ label: 'Weekly', usedPct: 42, resetsAt: Date.now() + 86400000 }]
      }))
    },
    codexUsageReport: vi.fn(async () => ({
      ok: true,
      totals: {},
      byDay: [],
      byModel: [],
      byProject: [],
      sessions: []
    }))
  }
  window.shellApi = api
})
afterEach(() => {
  wrapper?.unmount()
  window.shellApi = previous
  settings.hiddenUsageProviders = []
  vi.useRealTimers()
})
async function open() {
  wrapper = mount(UsageMenu, { attachTo: document.body })
  await flushPromises()
  await wrapper.get('[data-test="usage-button"]').trigger('click')
  await flushPromises()
}
describe('provider capability visibility', () => {
  it('reads metadata on mount, authenticates only on open/click, never on timers', async () => {
    vi.useFakeTimers()
    wrapper = mount(UsageMenu)
    await flushPromises()
    expect(api.providerUsage.capabilities).toHaveBeenCalled()
    expect(api.providerUsage.read).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(61000)
    expect(api.providerUsage.read).not.toHaveBeenCalled()
    await wrapper.get('[data-test="usage-button"]').trigger('click')
    await flushPromises()
    expect(api.providerUsage.read.mock.calls.map(([q]) => q.provider)).toEqual([
      'codex',
      'kimi',
      'cursor'
    ])
    await vi.advanceTimersByTimeAsync(61000)
    expect(api.providerUsage.read).toHaveBeenCalledTimes(3)
  })
  it('persists visibility, stops requesting hidden rows, and restores them on explicit selection', async () => {
    settings.hiddenUsageProviders = ['kimi']
    await open()
    expect(wrapper.find('[data-test="usage-row-kimi"]').exists()).toBe(false)
    expect(api.providerUsage.read.mock.calls.some(([q]) => q.provider === 'kimi')).toBe(false)
    // The choice lives in Settings > Usage (not in this menu): shown again,
    // the next opening reads it.
    expect(wrapper.find('[data-test="usage-visibility"]').exists()).toBe(false)
    settings.hiddenUsageProviders = []
    await wrapper.get('[data-test="usage-button"]').trigger('click')
    await wrapper.get('[data-test="usage-button"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-test="usage-row-kimi"]').text()).toContain('42%')
  })
  it('hides unsupported accounts but retains actionable expiration and service errors', async () => {
    api.providerUsage.read.mockImplementation(async ({ provider }) => ({
      ok: false,
      code: provider === 'cursor' ? 'unavailable' : 'expired',
      error: 'Run Kimi to refresh its login.'
    }))
    await open()
    expect(wrapper.find('[data-test="usage-row-cursor"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="usage-row-kimi"]').exists()).toBe(true)
    await wrapper.get('[data-test="usage-row-kimi"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Run Kimi to refresh its login.')
    expect(wrapper.text()).not.toContain('No local usage data')
  })
  it('never shows quota-only providers as token history or scans them', async () => {
    wrapper = mount(StatsUsage)
    await flushPromises()
    await wrapper.get('[data-test="stats-provider-select"]').trigger('click')
    expect(wrapper.find('[data-test="stats-provider-codex"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="stats-provider-kimi"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="stats-provider-cursor"]').exists()).toBe(false)
    expect(api.providerUsage.read).not.toHaveBeenCalled()
    expect(api.codexUsageReport).toHaveBeenCalledTimes(1)
    await wrapper.get('[data-test="usage-visible-codex"]').setValue(false)
    await flushPromises()
    expect(wrapper.find('[data-test="stats-provider-codex"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('No installed agents with a local usage history collector')
  })
  it('normalizes saved visibility to known unique IDs', () => {
    expect(validHiddenUsageProviders(['kimi', 'kimi', 'qwen', null, {}, 'minimax'])).toEqual([
      'kimi',
      'minimax'
    ])
    expect(validHiddenUsageProviders('all')).toEqual([])
  })
})
