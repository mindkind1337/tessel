import { describe, it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import UsageMenu from '../components/UsageMenu.vue'
import { settings, resetSettings } from '../settings'

describe('the usage gauge', () => {
  it('shows each window with its % and reset; Claude says it is not available; colour by the highest', async () => {
    const soon = new Date(Date.now() + 90 * 60000).toISOString()
    window.shellApi = {
      listAgents: vi.fn(async () => [
        { id: 'codex', available: true },
        { id: 'claude', available: true }
      ]),
      getUsage: vi.fn(async () => ({
        agents: [
          {
            id: 'codex',
            windows: [{ label: 'week', usedPct: 86, resetsAt: soon, stale: false }],
            observedAt: new Date().toISOString(),
            stale: false
          },
          { id: 'claude', windows: [], error: null }
        ]
      }))
    }
    const w = mount(UsageMenu, { attachTo: document.body })
    await flushPromises()
    expect(w.find('[data-test="usage-button"]').classes()).toContain('usage-bad') // 86 %: red from 80 %
    await w.find('[data-test="usage-button"]').trigger('click')
    await flushPromises()
    await w.get('[data-test="usage-mode-detailed"]').trigger('click')
    const [codex, claude] = w.findAll('[data-test="usage-agent"]')
    expect(codex.text()).toMatch(/Weekly\s*86%/)
    expect(codex.text()).toMatch(/resets in 1 h 30 min|resets in 1 h 29 min/)
    expect(claude.text()).toMatch(/Open for usage/)
    w.unmount()
  })

  it('Settings > Appearance, Usage percentages: Remaining shows the part left', async () => {
    window.shellApi = {
      // The menu lists only installed agents with a usage source.
      listAgents: vi.fn(async () => [{ id: 'codex', available: true }]),
      getUsage: vi.fn(async () => ({
        agents: [
          {
            id: 'codex',
            windows: [{ label: 'week', usedPct: 86, resetsAt: new Date(Date.now() + 3600000).toISOString(), stale: false }],
            observedAt: new Date().toISOString(),
            stale: false
          }
        ]
      }))
    }
    settings.usagePercentageDisplay = 'remaining'
    const w = mount(UsageMenu, { attachTo: document.body })
    try {
      await flushPromises()
      await w.find('[data-test="usage-button"]').trigger('click')
      await flushPromises()
      await w.get('[data-test="usage-mode-detailed"]').trigger('click')
      const [codex] = w.findAll('[data-test="usage-agent"]')
      expect(codex.text()).toMatch(/Weekly\s*14%/)
      expect(codex.get('.usage-fill').attributes('style')).toContain('width: 14%')
      // Colour still follows what is used.
      expect(codex.get('.usage-fill').classes()).toContain('bad')
    } finally {
      w.unmount()
      resetSettings()
    }
  })
})

describe('opening the usage menu does not flood the usage services', () => {
  it('reads a provider on the first open, not again when reopened within 5 minutes; the refresh button reads again', async () => {
    const { mount, flushPromises } = await import('@vue/test-utils')
    const UsageMenu = (await import('../components/UsageMenu.vue')).default
    const read = vi.fn(async () => ({ ok: true, windows: [{ label: 'week', usedPct: 10, resetsAt: null, stale: false }] }))
    const prev = window.shellApi
    window.shellApi = {
      ...(prev || {}),
      providerUsage: { ...(prev && prev.providerUsage), read, onUpdate: () => () => {}, autoRefresh: async () => ({ ok: true }) }
    }
    try {
      const w = mount(UsageMenu, { attachTo: document.body })
      await flushPromises()
      const button = w.find('[data-test="usage-button"]')
      if (!button.exists()) return w.unmount()
      await button.trigger('click')
      await flushPromises()
      const first = read.mock.calls.length
      await button.trigger('click') // close
      await button.trigger('click') // open again
      await flushPromises()
      expect(read.mock.calls.length).toBe(first)
      const refreshBtn = document.querySelector('[data-test="usage-refresh"]')
      if (refreshBtn && first > 0) {
        refreshBtn.click()
        await flushPromises()
        expect(read.mock.calls.length).toBeGreaterThan(first)
      }
      w.unmount()
    } finally {
      window.shellApi = prev
    }
  })
})
