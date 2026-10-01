import { setSelectValue, selectOptions } from './selectTestUtils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { settings } from '../settings'
import { flushPromises, mount } from '@vue/test-utils'
import UsageMenu from '../components/UsageMenu.vue'

describe('usage provider flyout', () => {
  const epoch = Date.parse('2026-09-28T18:00:00Z')
  let wrapper, previousApi, api, selectedId, serial
  function reading(provider, accountId = null, extra = {}) {
    return {
      ok: true,
      provider,
      accountId,
      observedAt: epoch,
      windows: [{ label: 'week', usedPct: 74, resetsAt: epoch + (5 * 24 + 21) * 3600000 }],
      ...(provider === 'codex'
        ? {
            resetCredits: {
              availableCount: 2,
              nextExpiresAt: epoch + 7 * 86400000,
              eligible: true
            },
            resetToken: `opaque-${accountId}-${++serial}`
          }
        : {}),
      ...extra
    }
  }
  beforeEach(() => {
    settings.hiddenUsageProviders = []
    vi.useFakeTimers()
    vi.setSystemTime(epoch)
    previousApi = window.shellApi
    selectedId = null
    serial = 0
    api = {
      listAgents: vi.fn(async () => [
        { id: 'codex', available: true },
        { id: 'claude', available: true }
      ]),
      getUsage: vi.fn(async () => ({
        agents: [
          { id: 'codex', windows: [{ label: 'week', usedPct: 25 }] },
          { id: 'claude', windows: [] }
        ]
      })),
      accounts: {
        list: vi.fn(async () => ({
          ok: true,
          providers: [
            {
              provider: 'codex',
              selectedId,
              system: { label: 'System default', status: 'ready' },
              accounts: [{ id: 'work', label: 'Work', status: 'ready' }]
            }
          ]
        })),
        select: vi.fn(async (provider, id) => {
          selectedId = id
          return { ok: true }
        })
      },
      providerUsage: {
        read: vi.fn(async ({ provider, accountId }) => reading(provider, accountId)),
        redeemReset: vi.fn(async () => ({ ok: true, outcome: 'reset' }))
      }
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
  async function openProvider() {
    wrapper = mount(UsageMenu, { attachTo: document.body })
    await flushPromises()
    await wrapper.get('[data-test="usage-button"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-test="usage-row-codex"]').trigger('click')
    await flushPromises()
  }
  const flyout = () => wrapper.get('[data-test="usage-provider-flyout"]')

  it('a provider you open whose usage is unavailable stays listed, with its reason', async () => {
    wrapper = mount(UsageMenu, { attachTo: document.body })
    await flushPromises()
    await wrapper.get('[data-test="usage-button"]').trigger('click')
    await flushPromises()
    // Its next read (the click's) finds no usage it can show.
    api.providerUsage.read.mockResolvedValue({ ok: false, provider: 'codex', accountId: null, code: 'unavailable', error: 'Needs a Gemini CLI sign-in.' })
    await wrapper.get('[data-test="usage-row-codex"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="usage-row-codex"]').exists()).toBe(true)
    expect(flyout().text()).toContain('Needs a Gemini CLI sign-in.')
  })

  it('reads authenticated usage only from explicit menu actions, never mount or timer polling', async () => {
    wrapper = mount(UsageMenu)
    await flushPromises()
    expect(api.providerUsage.read).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60000)
    expect(api.getUsage).toHaveBeenCalledTimes(2)
    expect(api.providerUsage.read).not.toHaveBeenCalled()
    await wrapper.get('[data-test="usage-button"]').trigger('click')
    await flushPromises()
    expect(api.providerUsage.read).toHaveBeenCalledWith({ provider: 'codex', accountId: null })
    expect(api.providerUsage.read).toHaveBeenCalledWith({ provider: 'claude', accountId: null })
    const calls = api.providerUsage.read.mock.calls.length
    await vi.advanceTimersByTimeAsync(120000)
    expect(api.providerUsage.read).toHaveBeenCalledTimes(calls)
    expect(api.providerUsage.redeemReset).not.toHaveBeenCalled()
  })

  it('shows actual updated time, weekly usage, countdown, credits and expiry with a right flyout', async () => {
    vi.stubGlobal('innerWidth', 1100)
    await openProvider()
    expect(flyout().text()).toContain('Updated just now')
    expect(flyout().text()).toContain('Weekly')
    expect(flyout().get('.usage-pct').text()).toBe('74% used')
    expect(flyout().get('.usage-fill').classes()).toContain('warn')
    expect(flyout().get('[role="meter"]').attributes('aria-valuenow')).toBe('74')
    expect(flyout().text()).toContain('Resets in 5d 21h')
    expect(flyout().text()).toContain('2 rate-limit resets available')
    expect(flyout().text()).toContain('Expires in 7d 0h')
    const roster = wrapper.get('[aria-label="Usage"][role="dialog"]').element
    expect(Number.parseFloat(flyout().element.style.left)).toBeGreaterThanOrEqual(
      Number.parseFloat(roster.style.left) + Number.parseFloat(roster.style.width)
    )
    expect(api.accounts.select).not.toHaveBeenCalled()
  })

  it('replaces the roster on a small viewport and restores it with Back', async () => {
    vi.stubGlobal('innerWidth', 360)
    vi.stubGlobal('innerHeight', 480)
    await openProvider()
    const roster = wrapper.get('[aria-label="Usage"][role="dialog"]')
    expect(roster.isVisible()).toBe(false)
    expect(flyout().element.style.width).toBe('344px')
    expect(flyout().element.style.left).toBe('8px')
    expect(
      Number.parseFloat(flyout().element.style.top) +
        Number.parseFloat(flyout().element.style.maxHeight)
    ).toBe(472)
    await flyout().get('[data-test="usage-provider-back"]').trigger('click')
    expect(wrapper.find('[data-test="usage-provider-flyout"]').exists()).toBe(false)
    expect(roster.isVisible()).toBe(true)
  })

  it('requires an account-named in-app confirmation and prevents duplicate redemption', async () => {
    let finishReset
    api.providerUsage.redeemReset.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishReset = resolve
        })
    )
    await openProvider()
    await flyout().get('[data-test="usage-reset-now"]').trigger('click')
    expect(flyout().get('[role="alertdialog"]').text()).toContain('System default')
    expect(api.providerUsage.redeemReset).not.toHaveBeenCalled()
    await flyout().get('[data-test="usage-reset-cancel"]').trigger('click')
    expect(flyout().find('[role="alertdialog"]').exists()).toBe(false)
    expect(api.providerUsage.redeemReset).not.toHaveBeenCalled()
    await flyout().get('[data-test="usage-reset-now"]').trigger('click')
    const confirm = flyout().get('[data-test="usage-reset-confirm"]')
    await confirm.trigger('click')
    await confirm.trigger('click')
    expect(api.providerUsage.redeemReset).toHaveBeenCalledTimes(1)
    expect(api.providerUsage.redeemReset).toHaveBeenCalledWith({
      provider: 'codex',
      accountId: null,
      resetToken: expect.any(String),
      confirmed: true
    })
    expect(flyout().get('[data-test="usage-account-toggle"]').element.disabled).toBe(true)
    const reads = api.providerUsage.read.mock.calls.length
    finishReset({ ok: true, outcome: 'reset' })
    await flushPromises()
    expect(flyout().get('[data-test="usage-reset-notice"]').text()).toBe('Usage limits reset.')
    expect(api.providerUsage.read.mock.calls.length).toBe(reads + 1)
  })

  it.each([
    ['missing credits', { resetCredits: undefined }],
    ['no available credits', { resetCredits: { availableCount: 0, eligible: true } }],
    ['not eligible', { resetCredits: { availableCount: 2, eligible: false } }],
    ['missing token', { resetToken: null }],
    ['stale snapshot', { observedAt: epoch - 6 * 60000 }]
  ])('does not offer reset for %s', async (reason, extra) => {
    api.providerUsage.read.mockImplementation(async ({ provider, accountId }) =>
      reading(provider, accountId, extra)
    )
    await openProvider()
    expect(flyout().find('[data-test="usage-reset-now"]').exists()).toBe(false)
    expect(api.providerUsage.redeemReset).not.toHaveBeenCalled()
  })

  it('marks last known readings stale after a failed authenticated refresh and disables reset', async () => {
    await openProvider()
    api.providerUsage.read.mockResolvedValue({ ok: false, error: 'Sign-in expired' })
    await wrapper.get('[data-test="usage-refresh"]').trigger('click')
    await flushPromises()
    expect(flyout().get('[role="alert"]').text()).toContain('Sign-in expired')
    expect(flyout().get('.usage-window').classes()).toContain('stale')
    expect(flyout().get('.usage-pct').text()).toBe('74% used')
    expect(flyout().text()).toContain('Last known reading')
    expect(flyout().find('[data-test="usage-reset-now"]').exists()).toBe(false)
  })

  it('cancels reset confirmation on account change and ignores an old account response', async () => {
    await openProvider()
    await flyout().get('[data-test="usage-reset-now"]').trigger('click')
    await flyout().get('[data-test="usage-account-toggle"]').trigger('click')
    let finishOld
    api.providerUsage.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve
        })
    )
    await wrapper.get('[data-test="usage-refresh"]').trigger('click')
    await setSelectValue(flyout().get('[data-test="usage-account-codex"]'), 'work')
    await flushPromises()
    expect(flyout().find('[role="alertdialog"]').exists()).toBe(false)
    expect(api.providerUsage.read).toHaveBeenLastCalledWith({
      provider: 'codex',
      accountId: 'work'
    })
    expect(flyout().get('[data-test="usage-account-toggle"]').text()).toContain('Work')
    finishOld(reading('codex', null, { windows: [{ label: 'week', usedPct: 99 }] }))
    await flushPromises()
    expect(flyout().get('.usage-pct').text()).toBe('74% used')
    expect(api.providerUsage.redeemReset).not.toHaveBeenCalled()
    await flyout().get('[data-test="usage-reset-now"]').trigger('click')
    expect(flyout().get('[role="alertdialog"]').text()).toContain('Work')
  })

  it('keeps ambiguous reset results visible without retrying or reusing the token', async () => {
    api.providerUsage.redeemReset.mockResolvedValue({
      ok: false,
      uncertain: true,
      error: 'Network response lost'
    })
    await openProvider()
    await flyout().get('[data-test="usage-reset-now"]').trigger('click')
    const reads = api.providerUsage.read.mock.calls.length
    await flyout().get('[data-test="usage-reset-confirm"]').trigger('click')
    await flushPromises()
    expect(flyout().get('[data-test="usage-reset-notice"]').text()).toContain('result is uncertain')
    expect(flyout().find('[data-test="usage-reset-now"]').exists()).toBe(false)
    expect(api.providerUsage.read).toHaveBeenCalledTimes(reads)
    await vi.advanceTimersByTimeAsync(120000)
    expect(api.providerUsage.redeemReset).toHaveBeenCalledTimes(1)
  })

  it('replaces stale local metadata when a fresh provider read succeeds', async () => {
    api.getUsage.mockResolvedValue({
      agents: [
        {
          id: 'codex',
          accountId: null,
          stale: true,
          error: 'Old local reading unavailable',
          windows: [{ label: 'week', usedPct: 99, stale: true }]
        }
      ]
    })
    await openProvider()
    expect(flyout().get('.usage-pct').text()).toBe('74% used')
    expect(flyout().get('.usage-window').classes()).not.toContain('stale')
    expect(flyout().text()).not.toContain('Old local reading unavailable')
    expect(flyout().find('[data-test="usage-reset-now"]').exists()).toBe(true)
  })

  it('never relabels the prior account quota when external selection changes and refresh fails', async () => {
    api.getUsage.mockResolvedValue({
      agents: [{ id: 'codex', accountId: null, windows: [{ label: 'week', usedPct: 99 }] }]
    })
    await openProvider()
    expect(flyout().get('.usage-pct').text()).toBe('74% used')
    selectedId = 'work'
    api.providerUsage.read.mockResolvedValue({ ok: false, error: 'Work sign-in expired' })
    // The external selection is discovered by list(), without an accounts-changed event.
    await wrapper.get('[data-test="usage-refresh"]').trigger('click')
    await flushPromises()
    expect(flyout().get('[data-test="usage-account-toggle"]').text()).toContain('Work')
    expect(flyout().find('.usage-pct').exists()).toBe(false)
    expect(flyout().text()).not.toContain('74%')
    expect(flyout().text()).not.toContain('99%')
    expect(flyout().find('[data-test="usage-reset-now"]').exists()).toBe(false)
    expect(flyout().text()).toContain('Work sign-in expired')
  })

  it('shows optional credit errors without discarding verified quota windows or inventing reset availability', async () => {
    api.providerUsage.read.mockImplementation(async ({ provider, accountId }) =>
      reading(provider, accountId, {
        resetCredits: undefined,
        resetToken: null,
        resetCreditsError: 'Credit service unavailable'
      })
    )
    await openProvider()
    expect(flyout().get('.usage-pct').text()).toBe('74% used')
    expect(flyout().get('.usage-window').classes()).not.toContain('stale')
    expect(flyout().get('[data-test="usage-reset-credits-error"]').text()).toContain(
      'Credit service unavailable'
    )
    expect(flyout().find('[data-test="usage-reset-credits"]').exists()).toBe(false)
    expect(flyout().find('[data-test="usage-reset-now"]').exists()).toBe(false)
  })
})
