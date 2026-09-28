import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { toBlob } from 'html-to-image'
import StatsUsage from '../components/StatsUsage.vue'

vi.mock('html-to-image', () => ({ toBlob: vi.fn() }))

describe('Orca Stats & usage port', () => {
  let wrapper, api, previousApi
  const epoch = Date.parse('2026-09-28T18:00:00Z')
  const common = { input: 100, output: 40, turns: 16, sessions: 16 }
  function report(provider, query = {}, extra = {}) {
    const counts =
      provider === 'claude'
        ? {
            ...common,
            cacheRead: 90,
            cacheWrite: 20,
            cost: 0.0042,
            unpriced: 0,
            zeroCacheReadTurns: 4
          }
        : { ...common, cached: 80, reasoning: 10, total: 140 }
    return {
      ok: true,
      generatedAt: epoch,
      range: { from: query.from ?? null, to: query.to ?? null },
      scope: Array.isArray(query.roots) ? 'tessel-worktrees' : 'all',
      totals: counts,
      byDay: [{ day: '2026-09-28', ...counts }],
      byModel: [{ model: provider === 'claude' ? 'claude-sonnet-4' : 'gpt-5', ...counts }],
      byProject: [{ cwd: 'C:/project', label: 'project', ...counts }],
      sessions: Array.from({ length: 16 }, (_, i) => ({
        id: `${provider}-${i}`,
        cwd: 'C:/project',
        last: epoch - i * 60000,
        model: provider === 'claude' ? 'claude-sonnet-4' : 'gpt-5',
        ...(provider === 'claude' ? counts : { tokens: counts })
      })),
      ...extra
    }
  }
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(epoch)
    localStorage.clear()
    previousApi = window.shellApi
    api = {
      claudeUsageReport: vi.fn(async (query) => report('claude', query)),
      codexUsageReport: vi.fn(async (query) => report('codex', query)),
      statsUsage: {
        summary: vi.fn(async () => ({
          ok: true,
          totalAgentsSpawned: 7,
          totalAgentTimeMs: 7200000,
          totalPRsCreated: 2,
          firstEventAt: epoch
        }))
      },
      providerUsage: { read: vi.fn(), redeemReset: vi.fn() },
      writeClipboardImage: vi.fn(async () => ({ ok: true })),
      openExternal: vi.fn(async () => ({ ok: true }))
    }
    window.shellApi = api
    vi.mocked(toBlob)
      .mockReset()
      .mockResolvedValue({ arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer })
  })
  afterEach(() => {
    wrapper?.unmount()
    window.shellApi = previousApi
    localStorage.clear()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })
  async function open(props = {}) {
    wrapper = mount(StatsUsage, {
      props: { worktreePaths: ['C:/worktrees/task-1'], ...props },
      attachTo: document.body
    })
    await flushPromises()
  }
  async function provider(id) {
    await wrapper.get('[data-test="stats-provider-select"]').trigger('click')
    await wrapper.get(`[data-test="stats-provider-${id}"]`).trigger('click')
    await flushPromises()
  }
  async function filter(kind, value) {
    await wrapper.get('[data-test="stats-filters"]').trigger('click')
    await wrapper.get(`[data-test="stats-${kind}-${value}"]`).setValue()
    await flushPromises()
  }

  it('opens Overview with real lifetime statistics, 42-day activity and exact provider navigation', async () => {
    await open()
    expect(wrapper.get('[data-test="stats-provider-select"]').text()).toBe('Overview')
    expect(wrapper.findAll('.su-activity .su-card-label').map((node) => node.text())).toEqual([
      'Agents spawned',
      'Time agents worked',
      'PRs created'
    ])
    expect(wrapper.findAll('.su-activity .su-card-value').map((node) => node.text())).toEqual([
      '7',
      '2h 0m',
      '2'
    ])
    const overview = wrapper.get('[data-test="stats-overview"]')
    expect(overview.findAll('.su-card-label').map((node) => node.text())).toEqual([
      'Total tokens',
      'Est. cost',
      'Active days',
      'Cache share'
    ])
    expect(overview.findAll('.su-heatmap > span')).toHaveLength(42)
    expect(overview.find('[data-test="stats-overview-grok"]').exists()).toBe(false)
    expect(api.claudeUsageReport).toHaveBeenCalledWith(
      expect.objectContaining({
        from: '2026-08-30',
        to: '2026-09-28',
        roots: ['C:/worktrees/task-1']
      })
    )
    expect(api.providerUsage.read).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(120000)
    expect(api.claudeUsageReport).toHaveBeenCalledTimes(1)
    expect(api.providerUsage.read).not.toHaveBeenCalled()
  })

  it('ports Claude cards, exact small costs, ten recent sessions and data scopes', async () => {
    await open()
    await provider('claude')
    const pane = wrapper.get('[data-test="stats-pane-claude"]')
    expect(
      pane.findAll('[data-test="stats-provider-cards"] .su-card-label').map((node) => node.text())
    ).toEqual([
      'Input tokens',
      'Output tokens',
      'Cache read',
      'Cache write',
      'Cache reuse rate',
      'Zero-cache-read turns',
      'Sessions / Turns',
      'Est. API-equivalent cost'
    ])
    expect(pane.text()).toContain('$0.0042')
    expect(pane.text()).toContain('Tessel worktrees only')
    expect(pane.text()).toContain('Last 30 days')
    expect(pane.findAll('tbody tr')).toHaveLength(10)
    expect(pane.findAll('th').map((node) => node.text())).toEqual([
      'Last active',
      'Project',
      'Model',
      'Turns',
      'Input',
      'Output',
      'Cache'
    ])
    expect(wrapper.find('[data-test="stats-overview"]').exists()).toBe(false)
  })

  it('does not invent Codex cost or add cached/reasoning subsets twice in the daily chart', async () => {
    await open({ initialProvider: 'codex' })
    const pane = wrapper.get('[data-test="stats-pane-codex"]')
    expect(pane.findAll('[data-test="stats-provider-cards"] .su-card-label')).toHaveLength(6)
    expect(pane.findAll('.su-card-value').at(-1).text()).toBe('n/a')
    const heights = pane
      .findAll('[data-segment]')
      .map((node) => Number.parseFloat(node.element.style.height))
    expect(heights.reduce((sum, height) => sum + height, 0)).toBeCloseTo(100)
    expect(pane.text()).toContain('no verified Codex pricing')
  })

  it('sends actual scope/range queries, closes filter menus and updates Overview from the same selection', async () => {
    await open()
    await provider('claude')
    await filter('scope', 'all')
    expect(api.claudeUsageReport.mock.calls.at(-1)[0]).not.toHaveProperty('roots')
    expect(wrapper.find('.su-filters-menu').exists()).toBe(false)
    await filter('range', '7d')
    expect(api.claudeUsageReport.mock.calls.at(-1)[0]).toEqual(
      expect.objectContaining({ from: '2026-09-22', to: '2026-09-28' })
    )
    const calls = api.claudeUsageReport.mock.calls.length
    await provider('overview')
    expect(api.claudeUsageReport).toHaveBeenCalledTimes(calls)
    await provider('claude')
    expect(wrapper.text()).toContain('All local Claude usage')
    expect(wrapper.text()).toContain('Last 7 days')
  })

  it('keeps the latest range when an older request finishes afterward', async () => {
    await open({ initialProvider: 'codex' })
    let finishSeven, finishNinety
    api.codexUsageReport.mockImplementationOnce(
      (query) =>
        new Promise((resolve) => {
          finishSeven = () => resolve(report('codex', query, { totals: { ...common, input: 700 } }))
        })
    )
    await filter('range', '7d')
    expect(wrapper.find('[data-test="stats-provider-cards"]').exists()).toBe(false)
    api.codexUsageReport.mockImplementationOnce(
      (query) =>
        new Promise((resolve) => {
          finishNinety = () =>
            resolve(report('codex', query, { totals: { ...common, input: 900 } }))
        })
    )
    await filter('range', '90d')
    finishNinety()
    await flushPromises()
    finishSeven()
    await flushPromises()
    expect(wrapper.get('[data-test="stats-provider-cards"] .su-card-value').text()).toBe('900')
    expect(wrapper.text()).toContain('Last 90 days')
  })

  it('persists tracking off, excludes disabled data, and only scans again after Enable', async () => {
    await open({ initialProvider: 'claude' })
    await wrapper.get('[data-test="stats-tracking-toggle"]').trigger('click')
    expect(JSON.parse(localStorage.getItem('tessel:usage-analytics')).claude).toBe(false)
    expect(wrapper.find('[data-test="stats-provider-cards"]').exists()).toBe(false)
    const calls = api.claudeUsageReport.mock.calls.length
    await provider('overview')
    expect(api.claudeUsageReport).toHaveBeenCalledTimes(calls)
    await provider('claude')
    await wrapper.get('[data-test="stats-tracking-toggle"]').trigger('click')
    await flushPromises()
    expect(api.claudeUsageReport).toHaveBeenCalledTimes(calls + 1)
    expect(wrapper.find('[data-test="stats-provider-cards"]').exists()).toBe(true)
  })

  it('reports unavailable providers honestly without false zeros, controls or API calls', async () => {
    await open()
    await provider('muse')
    const pane = wrapper.get('[data-test="stats-pane-muse"]')
    expect(pane.text()).toContain('No local Muse usage reader is available')
    expect(pane.find('[data-test="stats-tracking-toggle"]').exists()).toBe(false)
    expect(pane.find('.su-card').exists()).toBe(false)
    expect(api.providerUsage.read).not.toHaveBeenCalled()
  })

  it('preserves same-scope readings on error, but never labels old scope data as a failed new scope', async () => {
    await open({ initialProvider: 'claude' })
    api.claudeUsageReport.mockResolvedValue({ ok: false, error: 'Report unavailable' })
    await wrapper.get('[data-test="stats-provider-refresh"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('last successful scan for this scope')
    expect(wrapper.find('[data-test="stats-provider-cards"]').exists()).toBe(true)
    await filter('scope', 'all')
    expect(wrapper.find('[data-test="stats-provider-cards"]').exists()).toBe(false)
    expect(wrapper.get('[role="alert"]').text()).toContain('Report unavailable')
    expect(wrapper.text()).not.toContain('No local Claude usage found')
  })

  it('copies the 2x share PNG only after click and opens a share draft only explicitly', async () => {
    await open({ initialProvider: 'claude' })
    await wrapper.get('[data-test="stats-share"]').trigger('click')
    expect(wrapper.get('[role="dialog"][aria-label="Share usage"]').text()).toContain('Share on X')
    expect(toBlob).not.toHaveBeenCalled()
    expect(api.openExternal).not.toHaveBeenCalled()
    await wrapper.get('[data-test="stats-copy-image"]').trigger('click')
    await flushPromises()
    expect(toBlob).toHaveBeenCalledWith(expect.any(HTMLElement), { pixelRatio: 2, skipFonts: true })
    expect(api.writeClipboardImage).toHaveBeenCalledWith(new Uint8Array([137, 80, 78, 71]))
    expect(wrapper.get('[data-test="stats-copy-image"]').text()).toBe('Copied')
    await wrapper.get('[data-test="stats-share-x"]').trigger('click')
    expect(api.openExternal).toHaveBeenCalledWith(
      expect.stringContaining('https://x.com/intent/post?text=')
    )
    expect(decodeURIComponent(api.openExternal.mock.calls[0][0])).not.toContain('C:/project')
  })

  it('shows clipboard errors instead of claiming an image was copied', async () => {
    api.writeClipboardImage.mockResolvedValue({ ok: false, error: 'Clipboard unavailable' })
    await open({ initialProvider: 'codex' })
    await wrapper.get('[data-test="stats-share"]').trigger('click')
    await wrapper.get('[data-test="stats-copy-image"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[aria-label="Share usage"] [role="alert"]').text()).toContain(
      'Clipboard unavailable'
    )
    expect(wrapper.get('[data-test="stats-copy-image"]').text()).toBe('Copy image')
  })

  it('supports dropdown Escape without closing Settings and dismisses filters on outside click', async () => {
    await open()
    await wrapper.get('[data-test="stats-provider-select"]').trigger('click')
    await wrapper.get('[data-test="stats-provider-claude"]').trigger('keydown', { key: 'Escape' })
    expect(wrapper.find('.su-provider-menu').exists()).toBe(false)
    await provider('claude')
    await wrapper.get('[data-test="stats-filters"]').trigger('click')
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await flushPromises()
    expect(wrapper.find('.su-filters-menu').exists()).toBe(false)
  })
})
