import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { settings } from '../settings'
import { setMessages } from '../i18n'
import UsageMenu from '../components/UsageMenu.vue'
import fr from '../i18n/locales/fr/usage.json'

// A Claude reading as the main process returns it (values invented).
describe('Claude usage flyout details', () => {
  const epoch = Date.parse('2026-09-28T18:00:00Z')
  let wrapper, previousApi, reading
  const claudeReading = () => ({
    ok: true,
    provider: 'claude',
    accountId: null,
    observedAt: epoch,
    windows: [
      { label: '5-hour', usedPct: 41, resetsAt: epoch + 3600000 },
      {
        label: 'Weekly',
        usedPct: 63,
        resetsAt: epoch + 86400000,
        lockedReason: 'Weekly limit reached. <b>Upgrade</b>'
      },
      { label: 'Opus weekly', usedPct: 71, resetsAt: epoch + 86400000 },
      { label: 'Haiku 4.5 weekly', usedPct: 12, resetsAt: epoch + 86400000 }
    ],
    breakdown: {
      asOf: epoch - 1800000,
      rows: [
        { label: 'Claude Code', pct: 48.5 },
        { label: 'Chat', pct: 20 },
        { label: 'Bad', pct: 'x' }
      ]
    },
    extraUsage: {
      currency: 'USD',
      decimals: 2,
      used: 1234,
      limit: 5000,
      pct: 24.68,
      limitReached: true
    }
  })
  beforeEach(() => {
    settings.hiddenUsageProviders = []
    settings.usagePercentageDisplay = 'used'
    vi.useFakeTimers()
    vi.setSystemTime(epoch)
    vi.stubGlobal('innerWidth', 1100)
    previousApi = window.shellApi
    reading = claudeReading()
    window.shellApi = {
      listAgents: vi.fn(async () => [{ id: 'claude', available: true }]),
      getUsage: vi.fn(async () => ({ agents: [{ id: 'claude', windows: [] }] })),
      providerUsage: { read: vi.fn(async () => reading) }
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
  async function openClaude() {
    wrapper = mount(UsageMenu, { attachTo: document.body })
    await flushPromises()
    await wrapper.get('[data-test="usage-button"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-test="usage-row-claude"]').trigger('click')
    await flushPromises()
    return wrapper.get('[data-test="usage-provider-flyout"]')
  }

  it('names every per-model weekly window, and shows a lock reason as text', async () => {
    const flyout = await openClaude()
    const labels = flyout.findAll('.usage-flyout-window .usage-line').map((n) => n.text())
    expect(labels).toEqual(['5-hour', 'Weekly', 'Opus weekly', 'Haiku 4.5 weekly'])
    const locked = flyout.findAll('[data-test="usage-locked"]')
    expect(locked).toHaveLength(1)
    expect(locked[0].text()).toBe('Locked: Weekly limit reached. <b>Upgrade</b>')
    expect(locked[0].find('b').exists()).toBe(false)
  })

  it('shows the week by category with bars and the as-of time', async () => {
    const flyout = await openClaude()
    const section = flyout.get('[data-test="usage-breakdown"]')
    expect(section.text()).toContain('This week by category')
    expect(section.text()).toContain('as of')
    const rows = section.findAll('[data-test="usage-breakdown-row"]')
    expect(rows.map((r) => r.text())).toEqual(['Claude Code49%', 'Chat20%'])
    expect(rows[0].get('.usage-fill').attributes('style')).toContain('width: 48.5%')
  })

  it('shows paid extra usage in money with its bar and the limit warning', async () => {
    const flyout = await openClaude()
    const section = flyout.get('[data-test="usage-extra"]')
    expect(section.text()).toContain('Extra usage')
    expect(section.get('[data-test="usage-extra-amount"]').text()).toBe('$12.34 of $50.00 this month')
    expect(section.get('[role="meter"]').attributes('aria-valuenow')).toBe('25')
    expect(section.get('[data-test="usage-extra-limit"]').text()).toBe('Monthly spend limit reached.')
  })

  it('shows nothing extra when the reading has no breakdown, extra usage or lock', async () => {
    reading = { ...claudeReading(), windows: [{ label: '5-hour', usedPct: 10 }] }
    delete reading.breakdown
    delete reading.extraUsage
    const flyout = await openClaude()
    expect(flyout.find('[data-test="usage-breakdown"]').exists()).toBe(false)
    expect(flyout.find('[data-test="usage-extra"]').exists()).toBe(false)
    expect(flyout.find('[data-test="usage-locked"]').exists()).toBe(false)
  })

  it('speaks French', async () => {
    setMessages('fr', fr)
    reading.extraUsage = { ...reading.extraUsage, limitReached: false }
    const flyout = await openClaude()
    const labels = flyout.findAll('.usage-flyout-window .usage-line').map((n) => n.text())
    expect(labels).toEqual(['5 heures', 'Hebdomadaire', 'Opus hebdomadaire', 'Haiku 4.5 hebdomadaire'])
    expect(flyout.text()).toContain('Cette semaine par catégorie')
    expect(flyout.text()).toContain('Bloqué : Weekly limit reached.')
    const amount = flyout.get('[data-test="usage-extra-amount"]').text().replace(/\s/g, ' ')
    expect(amount).toBe('12,34 $ US sur 50,00 $ US ce mois-ci')
    expect(flyout.find('[data-test="usage-extra-limit"]').exists()).toBe(false)
  })
})
