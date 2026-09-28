import { describe, it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import UsageMenu from '../components/UsageMenu.vue'

describe('the usage gauge', () => {
  it('shows each window with its % and reset; Claude says it is not available; colour by the highest', async () => {
    const soon = new Date(Date.now() + 90 * 60000).toISOString()
    window.shellApi = {
      getUsage: vi.fn(async () => ({
        agents: [
          { id: 'codex', windows: [{ label: 'week', usedPct: 86, resetsAt: soon, stale: false }], observedAt: new Date().toISOString(), stale: false },
          { id: 'claude', windows: [], error: null }
        ]
      }))
    }
    const w = mount(UsageMenu, { attachTo: document.body })
    await flushPromises()
    expect(w.find('[data-test="usage-button"]').classes()).toContain('usage-warn')
    await w.find('[data-test="usage-button"]').trigger('click')
    await flushPromises()
    const [codex, claude] = w.findAll('[data-test="usage-agent"]')
    expect(codex.text()).toMatch(/Weekly\s*86%/)
    expect(codex.text()).toMatch(/resets in 1 h 30 min|resets in 1 h 29 min/)
    expect(claude.text()).toMatch(/Not available/)
    w.unmount()
  })
})
