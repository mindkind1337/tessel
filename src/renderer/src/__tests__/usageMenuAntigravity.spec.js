import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { settings } from '../settings'
import { setMessages } from '../i18n'
import UsageMenu from '../components/UsageMenu.vue'
import fr from '../i18n/locales/fr/usage.json'

// An Antigravity reading as the main process returns it from `agy /usage`
// (values invented): a 5-hour and a weekly limit per model group.
describe('Antigravity usage flyout', () => {
  const epoch = Date.parse('2026-10-15T12:00:00Z')
  let wrapper, previousApi
  beforeEach(() => {
    settings.hiddenUsageProviders = []
    settings.usagePercentageDisplay = 'used'
    vi.useFakeTimers()
    vi.setSystemTime(epoch)
    vi.stubGlobal('innerWidth', 1100)
    previousApi = window.shellApi
    window.shellApi = {
      getUsage: vi.fn(async () => ({ agents: [] })),
      providerUsage: {
        capabilities: vi.fn(async () => ({
          ok: true,
          providers: [{ id: 'antigravity', name: 'Antigravity', agents: ['antigravity'], report: false, quota: true }]
        })),
        read: vi.fn(async () => ({
          ok: true,
          provider: 'antigravity',
          accountId: null,
          source: 'live',
          observedAt: epoch,
          windows: [
            { label: 'Gemini 5-hour', usedPct: 25, resetsAt: epoch + 3600000 },
            { label: 'Gemini weekly', usedPct: 10, resetsAt: epoch + 6 * 86400000 },
            { label: 'Claude and GPT 5-hour', usedPct: 0, resetsAt: epoch + 5 * 3600000 },
            { label: 'Claude and GPT weekly', usedPct: 0, resetsAt: epoch + 7 * 86400000 }
          ]
        }))
      }
    }
  })
  afterEach(() => {
    wrapper?.unmount()
    window.shellApi = previousApi
    setMessages('en', {})
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })
  async function openAntigravity() {
    wrapper = mount(UsageMenu, { attachTo: document.body })
    await flushPromises()
    await wrapper.get('[data-test="usage-button"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-test="usage-row-antigravity"]').trigger('click')
    await flushPromises()
    return wrapper.get('[data-test="usage-provider-flyout"]')
  }
  const labels = (flyout) => flyout.findAll('.usage-flyout-window .usage-line').map((n) => n.text())

  it('one row per model group window', async () => {
    expect(labels(await openAntigravity())).toEqual(['Gemini 5-hour', 'Gemini weekly', 'Claude and GPT 5-hour', 'Claude and GPT weekly'])
  })

  it('a plan that went (too old) leaves the row at the next refresh', async () => {
    const base = await window.shellApi.providerUsage.read()
    window.shellApi.providerUsage.read = vi.fn(async () => ({ ...base, plan: 'Ultra' }))
    wrapper = mount(UsageMenu, { attachTo: document.body })
    await flushPromises()
    await wrapper.get('[data-test="usage-button"]').trigger('click')
    await flushPromises()
    const row = () => document.querySelector('[data-test="usage-row-antigravity"]').textContent
    expect(row()).toContain('Ultra')
    window.shellApi.providerUsage.read = vi.fn(async () => ({ ...base, plan: null }))
    document.querySelector('[data-test="usage-refresh"]').click()
    await flushPromises()
    expect(window.shellApi.providerUsage.read).toHaveBeenCalled()
    expect(row()).not.toContain('Ultra')
  })

  it('speaks French', async () => {
    setMessages('fr', fr)
    expect(labels(await openAntigravity())).toEqual(['Gemini 5 heures', 'Gemini hebdomadaire', 'Claude and GPT 5 heures', 'Claude and GPT hebdomadaire'])
  })
})
