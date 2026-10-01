import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { settings } from '../settings'
import { flushPromises, mount } from '@vue/test-utils'
import UsageMenu from '../components/UsageMenu.vue'

describe('compact usage roster', () => {
  let wrapper, api, previousApi
  const epoch = Date.parse('2026-09-28T12:00:00Z')
  const reset = (minutes) => new Date(epoch + minutes * 60000).toISOString()
  const readings = (windows) => ({ agents: [{ id: 'codex', windows }] })
  const weekly = { label: 'week', usedPct: 66, resetsAt: reset(5 * 1440 + 22 * 60) }
  const hourly = { label: '5h', usedPct: 20, resetsAt: reset(90) }

  beforeEach(() => {
    settings.hiddenUsageProviders = []
    vi.useFakeTimers()
    vi.setSystemTime(epoch)
    previousApi = window.shellApi
    api = {
      listAgents: vi.fn(async () => [{ id: 'codex', available: true }]),
      getUsage: vi.fn(async () => readings([hourly, weekly]))
    }
    window.shellApi = api
  })
  afterEach(() => {
    wrapper?.unmount()
    window.shellApi = previousApi
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })
  async function open() {
    wrapper = mount(UsageMenu, { attachTo: document.body })
    await flushPromises()
    await wrapper.get('[data-test="usage-button"]').trigger('click')
    await flushPromises()
  }

  it('starts compact, pairs the tightest quota with its own reset, and uses amber at 66 percent', async () => {
    await open()
    expect(wrapper.get('[data-test="usage-mode-compact"]').attributes('aria-pressed')).toBe('true')
    const row = wrapper.get('[data-test="usage-row-codex"]')
    expect(row.attributes('aria-expanded')).toBe('false')
    expect(row.get('.usage-summary-pct').text()).toBe('66%')
    expect(row.get('.usage-countdown').text()).toBe('5d 22h')
    expect(row.get('.usage-summary-pct').classes()).toContain('usage-level-warn')
    expect(wrapper.get('[data-test="usage-button"]').classes()).toContain('usage-warn')
    expect(wrapper.find('.usage-window').exists()).toBe(false)
    await row.trigger('click')
    expect(row.attributes('aria-expanded')).toBe('true')
    expect(wrapper.findAll('.usage-window')).toHaveLength(2)
    expect(wrapper.text()).toContain('Resets in 1h 30m')
    await wrapper.get('[data-test="usage-mode-detailed"]').trigger('click')
    expect(wrapper.find('.usage-summary').exists()).toBe(false)
    expect(wrapper.findAll('.usage-window')).toHaveLength(2)
    await wrapper.get('[data-test="usage-mode-compact"]').trigger('click')
    expect(wrapper.find('.usage-window').exists()).toBe(false)
  })

  it('lists the providers with usage first, the ones without at the bottom', async () => {
    api.listAgents.mockResolvedValue([{ id: 'claude', available: true }, { id: 'codex', available: true }])
    api.getUsage.mockResolvedValue({ agents: [{ id: 'claude', windows: [] }, { id: 'codex', windows: [hourly, weekly] }] })
    await open()
    const ids = wrapper.findAll('[data-test="usage-agent"]').map((s) => s.text())
    expect(ids[0]).toContain('Codex')
    expect(ids.at(-1)).toContain('Claude')
  })

  it('uses a fresh window ahead of stale readings and never resets old usage to zero', async () => {
    api.getUsage.mockResolvedValue(
      readings([
        { label: 'week', usedPct: 99, resetsAt: reset(-1), stale: false },
        { label: '5h', usedPct: 20, resetsAt: reset(1), stale: false }
      ])
    )
    await open()
    expect(wrapper.get('.usage-summary-pct').text()).toBe('20%')
    expect(wrapper.get('[data-test="usage-button"]').classes()).toContain('usage-ok')
    await vi.advanceTimersByTimeAsync(61000)
    await flushPromises()
    expect(wrapper.get('.usage-summary-pct').text()).toBe('99%')
    expect(wrapper.get('.usage-summary').classes()).toContain('stale')
    expect(wrapper.get('.usage-old').text()).toBe('last seen')
    expect(wrapper.get('[data-test="usage-button"]').classes()).not.toContain('usage-bad')
    await wrapper.get('[data-test="usage-row-codex"]').trigger('click')
    expect(wrapper.findAll('.usage-pct').map((node) => node.text())).toEqual([
      '99% used',
      '20% used'
    ])
    expect(wrapper.text()).toContain('Last known reading')
  })

  it('does not invent quota support for installed agents without a collector', async () => {
    api.listAgents = vi.fn(async () => [
      { id: 'codex', available: true },
      { id: 'kimi', available: true },
      { id: 'qwen', available: true }
    ])
    await open()
    expect(wrapper.find('[data-test="usage-row-codex"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="usage-row-kimi"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="usage-row-qwen"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Open for usage')
  })

  it('displays only real plan metadata and keeps account switching behind an explicit selection', async () => {
    api.accounts = {
      list: vi.fn(async () => ({
        ok: true,
        providers: [
          {
            provider: 'codex',
            selectedId: null,
            system: { label: 'System default', status: 'ready', plan: 'free' },
            accounts: []
          }
        ]
      })),
      select: vi.fn()
    }
    await open()
    expect(wrapper.get('.usage-plan').text()).toContain('Free')
    expect(wrapper.find('select').exists()).toBe(false)
    await wrapper.get('[data-test="usage-row-codex"]').trigger('click')
    await wrapper.get('[data-test="usage-account-toggle"]').trigger('click')
    expect(wrapper.find('[data-test="usage-account-codex"]').exists()).toBe(true)
    expect(api.accounts.select).not.toHaveBeenCalled()
  })

  it('rejects invalid quota values rather than displaying fabricated zero or overflowing bars', async () => {
    api.getUsage.mockResolvedValue(
      readings([
        { label: 'week', usedPct: null },
        { label: '5h', usedPct: -1 },
        { label: 'day', usedPct: 101 },
        { label: 'month', usedPct: Number.NaN }
      ])
    )
    await open()
    expect(wrapper.get('[data-test="usage-row-codex"]').text()).toContain('Open for usage')
    expect(wrapper.find('.usage-summary-pct').exists()).toBe(false)
    await wrapper.get('[data-test="usage-row-codex"]').trigger('click')
    expect(wrapper.find('.usage-fill').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('0%')
  })

  it('refreshes local readers explicitly, shows loading, and keeps the latest result', async () => {
    let finishInitial, finishRefresh
    api.getUsage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishInitial = resolve
        })
    )
    await open()
    api.getUsage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRefresh = resolve
        })
    )
    // No refresh button: opening the menu again reads the local files again.
    await wrapper.get('[data-test="usage-button"]').trigger('click')
    await wrapper.get('[data-test="usage-button"]').trigger('click')
    expect(wrapper.get('[role="dialog"]').attributes('aria-busy')).toBe('true')
    finishRefresh(readings([{ ...weekly, usedPct: 73 }]))
    await flushPromises()
    finishInitial(readings([{ ...weekly, usedPct: 99 }]))
    await flushPromises()
    expect(wrapper.get('.usage-summary-pct').text()).toBe('73%')
    expect(api.getUsage).toHaveBeenCalledTimes(3)
  })

  it('clamps the popover to a narrow viewport and returns focus on Escape', async () => {
    vi.stubGlobal('innerWidth', 640)
    vi.stubGlobal('innerHeight', 480)
    wrapper = mount(UsageMenu, { attachTo: document.body })
    await flushPromises()
    const trigger = wrapper.get('[data-test="usage-button"]')
    vi.spyOn(trigger.element, 'getBoundingClientRect').mockReturnValue({ right: 260, bottom: 32 })
    await trigger.trigger('click')
    await flushPromises()
    const menu = wrapper.get('[role="dialog"]').element
    expect(menu.style.position).toBe('fixed')
    expect(menu.style.left).toBe('8px')
    expect(menu.style.width).toBe('360px')
    expect(Number.parseFloat(menu.style.top) + Number.parseFloat(menu.style.maxHeight)).toBe(472)
    vi.stubGlobal('innerWidth', 360)
    window.dispatchEvent(new Event('resize'))
    await flushPromises()
    expect(menu.style.left).toBe('8px')
    expect(menu.style.width).toBe('344px')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    expect(document.activeElement).toBe(trigger.element)
  })

  it('opens the existing usage history through its footer event', async () => {
    await open()
    await wrapper.get('[data-test="usage-details"]').trigger('click')
    expect(wrapper.emitted('details')).toHaveLength(1)
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
  })

  it('surfaces local read failures and recovers on refresh without treating errors as zero usage', async () => {
    api.getUsage.mockRejectedValue(new Error('Local reading unavailable'))
    await open()
    expect(wrapper.get('[role="alert"]').text()).toContain('Local reading unavailable')
    expect(wrapper.find('.usage-summary-pct').exists()).toBe(false)
    api.getUsage.mockResolvedValue(readings([weekly]))
    // No refresh button: opening the menu again reads the local files again.
    await wrapper.get('[data-test="usage-button"]').trigger('click')
    await wrapper.get('[data-test="usage-button"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.get('.usage-summary-pct').text()).toBe('66%')
  })
})
