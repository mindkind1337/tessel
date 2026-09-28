import { describe, it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import UsageDialog from '../components/UsageDialog.vue'

const today = new Date()
const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
const zero = { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cost: 0, unpriced: 0 }

describe('Usage details', () => {
  it('shows the estimated cost, a bar per day, and tables by model, project and conversation', async () => {
    window.shellApi = {
      claudeUsageReport: vi.fn(async () => ({
        ok: true,
        days: 30,
        files: 3,
        totals: { ...zero, turns: 12, cost: 7.5 },
        lastDays: { ...zero, turns: 12, output: 2500000, cacheRead: 3200000000, cost: 7.5 },
        byDay: [{ day: key, ...zero, turns: 12, cost: 7.5 }],
        byModel: [{ model: 'claude-opus-5-5', ...zero, turns: 12, cost: 7.5 }],
        byProject: [{ cwd: 'C:\\Tessel', label: 'Tessel', ...zero, turns: 12, cost: 7.5 }],
        sessions: [{ id: 's1', cwd: 'C:\\Tessel', branch: 'main', model: 'claude-opus-5-5', first: 1, last: Date.now(), ...zero, turns: 12, cost: 7.5 }]
      }))
    }
    const w = mount(UsageDialog, { attachTo: document.body })
    await flushPromises()
    const tiles = w.find('[data-test="usage-tiles"]').text()
    expect(tiles).toMatch(/\$7\.50/)
    expect(tiles).toMatch(/2\.5M/)
    expect(tiles).toMatch(/3\.2B/)
    expect(w.findAll('.usage-col')).toHaveLength(30)
    // Only today has a bar, full height.
    expect(w.findAll('.usage-colbar').at(-1).attributes('style')).toMatch(/height: 100%/)
    expect(w.text()).toMatch(/claude-opus-5-5/)
    expect(w.text()).toMatch(/not billed per token/)
    await w.findAll('.usage-col').at(-1).trigger('mouseenter')
    expect(w.find('.usage-tip').text()).toMatch(/\$7\.50 · 12 replies/)
    w.unmount()
  })
})
