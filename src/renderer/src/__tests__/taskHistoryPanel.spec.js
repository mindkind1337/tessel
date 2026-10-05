// The Task history tab: filters, sort, totals and CSV (taskHistoryView.js),
// and the panel (TaskHistoryPanel.vue) with a fake jobCost API.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import TaskHistoryPanel from '../components/TaskHistoryPanel.vue'
import { taskHistory, setTaskHistory, SETTLE_MS } from '../taskHistory'
import { filterHistory, sortHistory, historyTotals, historyCsv, filterOptions, loadHistoryCosts, resetHistoryCostCache, periodStart, BATCH } from '../taskHistoryView'
import { setSelectValue } from './selectTestUtils'

const NOW = new Date(2026, 9, 3, 15, 0, 0).getTime()
const H = 3600 * 1000
const D = 24 * H
const ok = (input, output, usd, extra = {}) => ({ status: 'ok', inputTokens: input, outputTokens: output, cacheReadTokens: 7, cacheWriteTokens: 3, usd, known: usd !== null, final: true, models: [], ...extra })

function sample() {
  return [
    { id: 'a', title: 'Fix the login', agentName: 'Ada', agentKind: 'claude', project: 'Tessel', doneAt: NOW - 1 * H, durationMs: 10 * 60000, paneId: 'p1', workPeriods: [{ start: NOW - 2 * H, end: NOW - 1 * H, paneId: 'p1' }], cost: ok(1000, 500, 0.5, { models: [{ model: 'claude-opus-4-8', inputTokens: 1000, outputTokens: 500, usd: 0.5, known: true }], subagents: 3 }) },
    { id: 'b', title: 'Write docs', agentName: 'Bo', agentKind: 'codex', project: 'Site', doneAt: NOW - 3 * D, durationMs: 60 * 60000, cost: ok(200, 100, null, { known: false }) },
    { id: 'c', title: 'Old login bug', agentName: 'Ada', agentKind: 'claude', project: 'Tessel', doneAt: NOW - 40 * D, durationMs: 5 * 60000, cost: ok(10, 10, 2) },
    { id: 'd', title: 'Gone pane', agentName: null, agentKind: null, project: 'Site', doneAt: NOW - 2 * H, durationMs: 0, cost: { status: 'unavailable', reason: 'missing-file', final: true } }
  ]
}

beforeEach(() => {
  setTaskHistory(sample())
  resetHistoryCostCache()
})
afterEach(() => {
  delete window.shellApi
  vi.useRealTimers()
})

describe('filters, sort and totals', () => {
  it('period, project, agent and title search', () => {
    const ids = (f) => filterHistory(taskHistory, f, NOW).map((r) => r.id).sort()
    expect(ids({ period: 'today' })).toEqual(['a', 'd'])
    expect(ids({ period: '7d' })).toEqual(['a', 'b', 'd'])
    expect(ids({ period: '30d' })).toEqual(['a', 'b', 'd'])
    expect(ids({ period: 'all' })).toEqual(['a', 'b', 'c', 'd'])
    expect(ids({ project: 'Tessel' })).toEqual(['a', 'c'])
    expect(ids({ agent: 'Bo' })).toEqual(['b'])
    expect(ids({ query: 'LOGIN' })).toEqual(['a', 'c'])
    expect(periodStart('today', NOW)).toBe(new Date(2026, 9, 3).getTime())
  })

  it('sorts newest first, by cost (unknown last), by time', () => {
    expect(sortHistory(taskHistory).map((r) => r.id)).toEqual(['a', 'd', 'b', 'c'])
    expect(sortHistory(taskHistory, 'cost').map((r) => r.id)).toEqual(['c', 'a', 'd', 'b'])
    expect(sortHistory(taskHistory, 'time').map((r) => r.id)).toEqual(['b', 'a', 'c', 'd'])
  })

  it('totals: unknown costs left out and counted, records not read yet counted apart', () => {
    const t = historyTotals([...taskHistory, { id: 'e', title: 'E', doneAt: NOW, durationMs: 1000, cost: null }])
    expect(t).toMatchObject({ tasks: 5, durationMs: 75 * 60000 + 1000, tokens: 1820, cacheReadTokens: 21, usd: 2.5, priced: 2, unknown: 2, pending: 1 })
  })

  it('the filter choices', () => {
    expect(filterOptions(taskHistory)).toEqual({ projects: ['Site', 'Tessel'], agents: ['Ada', 'Bo'] })
  })

  it('CSV: one line per task, quoted where needed, formulas neutralised', () => {
    const rec = (id) => taskHistory.find((r) => r.id === id)
    const csv = historyCsv([{ ...rec('a'), title: 'Say "hi", =SUM(1)' }, rec('d')])
    const lines = csv.trim().split('\r\n')
    expect(lines[0]).toBe('done_at,title,agent,agent_kind,project,time_seconds,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,usd_estimate,model,subagents')
    expect(lines[1]).toContain('"Say ""hi"", =SUM(1)",Ada,claude,Tessel,600,1000,500,7,3,0.5000,,3')
    expect(historyCsv([{ id: 'x', title: '=cmd', doneAt: 0 }])).toContain("'=cmd")
    expect(lines[2]).toContain(',Gone pane,,,Site,0,')
  })
})

describe('figures read in batches', () => {
  it('asks only for records not final, newest first, at most BATCH ids a call, and keeps what it read', async () => {
    const many = Array.from({ length: BATCH + 5 }, (_, i) => ({ id: 'r' + i, title: 'T', doneAt: NOW - i * 1000 }))
    setTaskHistory([...sample(), ...many])
    const calls = []
    const api = { forCards: vi.fn(async (ids) => (calls.push(ids), Object.fromEntries(ids.map((id) => [id, { status: 'ok', inputTokens: 1, outputTokens: 1, usd: 0.01, known: true, models: [] }])))) }
    const read = await loadHistoryCosts(taskHistory, { api, now: () => NOW })
    expect(calls.map((c) => c.length)).toEqual([BATCH, 5])
    expect(calls[0][0]).toBe('r0')
    expect(calls.flat()).not.toContain('a') // final already
    expect(read).toBe(BATCH + 5)
    expect(taskHistory.find((r) => r.id === 'r3').cost).toMatchObject({ status: 'ok', usd: 0.01 })
    // Asked a moment ago: not again yet.
    await loadHistoryCosts(taskHistory, { api, now: () => NOW + 1000 })
    expect(api.forCards).toHaveBeenCalledTimes(2)
  })

  it('stops when the tab is hidden', async () => {
    setTaskHistory(Array.from({ length: BATCH * 3 }, (_, i) => ({ id: 'r' + i, title: 'T', doneAt: NOW - SETTLE_MS * 2 })))
    let shown = true
    const api = { forCards: vi.fn(async (ids) => ((shown = false), Object.fromEntries(ids.map((id) => [id, { status: 'ok', models: [] }])))) }
    await loadHistoryCosts(taskHistory, { api, isActive: () => shown, now: () => NOW })
    expect(api.forCards).toHaveBeenCalledTimes(1)
  })
})

describe('the panel', () => {
  function mountPanel(props = {}) {
    return mount(TaskHistoryPanel, { props: { active: true, now: NOW, projects: [{ id: 'ws', name: 'Tessel', panes: [{ id: 'p1' }] }], ...props }, attachTo: document.body })
  }

  it("shows this workspace's tasks by default, every workspace's with All", async () => {
    window.shellApi = { jobCost: { forCards: vi.fn(async () => ({})), onChanged: () => () => {} } }
    setTaskHistory([
      { id: 'w1', title: 'Here', wsId: 'ws', doneAt: NOW - 1000 },
      { id: 'w2', title: 'Elsewhere', wsId: 'other', doneAt: NOW - 2000 }
    ])
    const w = mountPanel({ workspaceId: 'ws' })
    await flushPromises()
    const rows = () => w.findAll('[data-test^="history-row-"]').map((x) => x.attributes('data-test'))
    expect(rows()).toEqual(['history-row-w1'])
    expect(w.find('[data-test="total-tasks"]').text()).toBe('1')
    await w.find('[data-test="history-scope-all"]').trigger('click')
    expect(rows()).toEqual(['history-row-w1', 'history-row-w2'])
    w.unmount()
  })

  it('lists the tasks with their figures and the totals', async () => {
    window.shellApi = { jobCost: { forCards: vi.fn(async () => ({})), onChanged: () => () => {} } }
    const w = mountPanel()
    await flushPromises()
    const row = w.find('[data-test="history-row-a"]')
    expect(row.text()).toContain('Fix the login')
    expect(row.find('[data-test="row-agent"]').text()).toBe('Ada')
    expect(row.find('[data-test="row-project"]').text()).toBe('Tessel')
    expect(row.find('[data-test="row-cost"]').text()).toBe('~$0.50')
    expect(row.find('[data-test="row-cost"]').attributes('title')).toMatch(/API-equivalent estimate/)
    expect(row.find('[data-test="row-tokens"]').text()).toBe('1.5k')
    expect(row.find('[data-test="row-tokens"]').attributes('title')).toContain('Cache read: 7')
    expect(w.find('[data-test="history-row-b"] [data-test="row-cost"]').text()).toBe('unknown')
    expect(w.find('[data-test="total-tasks"]').text()).toBe('4')
    expect(w.find('[data-test="total-cost"]').text()).toBe('~$2.50')
    expect(w.find('[data-test="total-note"]').text()).toContain('2 with an unknown cost (not counted)')
    // Newest first.
    expect(w.findAll('[data-test^="history-row-"]').map((x) => x.attributes('data-test'))).toEqual(['history-row-a', 'history-row-d', 'history-row-b', 'history-row-c'])
    w.unmount()
  })

  it('filters by period and search, sorts by cost', async () => {
    window.shellApi = { jobCost: { forCards: vi.fn(async () => ({})) } }
    const w = mountPanel()
    await setSelectValue(w.find('[data-test="history-period"]'), 'today')
    expect(w.findAll('[data-test^="history-row-"]')).toHaveLength(2)
    expect(w.find('[data-test="total-tasks"]').text()).toBe('2')
    await setSelectValue(w.find('[data-test="history-period"]'), 'all')
    await w.find('[data-test="history-search"]').setValue('login')
    expect(w.findAll('[data-test^="history-row-"]')).toHaveLength(2)
    await setSelectValue(w.find('[data-test="history-sort"]'), 'cost')
    expect(w.findAll('[data-test^="history-row-"]')[0].attributes('data-test')).toBe('history-row-c')
    await w.find('[data-test="history-search"]').setValue('nothing like it')
    expect(w.find('[data-test="history-none"]').exists()).toBe(true)
    w.unmount()
  })

  it('a row opens its details: periods, cost per model, sub-agents, and its pane if it is still there', async () => {
    window.shellApi = { jobCost: { forCards: vi.fn(async () => ({})) } }
    const w = mountPanel()
    await w.find('[data-test="history-row-a"] button').trigger('click')
    const d = w.find('[data-test="history-detail"]')
    expect(d.find('.th-periods li').exists()).toBe(true)
    expect(d.find('[data-test="history-models"]').text()).toContain('$0.50')
    expect(d.find('[data-test="history-subagents"]').text()).toBe('3 sub-agents')
    await d.find('[data-test="history-open-pane"]').trigger('click')
    expect(w.emitted('focus-pane')).toEqual([['p1']])
    // A task whose figures could not be read: why; its pane is gone.
    await w.find('[data-test="history-row-d"] button').trigger('click')
    expect(w.find('[data-test="history-reason"]').text()).toMatch(/session file could not be found/)
    expect(w.find('[data-test="history-open-pane"]').exists()).toBe(false)
    w.unmount()
  })

  it('reads the missing figures only while shown, and shows them', async () => {
    setTaskHistory([{ id: 'n', title: 'New one', doneAt: NOW - H, durationMs: 1000 }])
    const forCards = vi.fn(async (ids) => Object.fromEntries(ids.map((id) => [id, { status: 'ok', inputTokens: 2000, outputTokens: 0, usd: 1.25, known: true, models: [] }])))
    window.shellApi = { jobCost: { forCards } }
    const w = mountPanel({ active: false })
    await flushPromises()
    expect(forCards).not.toHaveBeenCalled()
    expect(w.find('[data-test="history-row-n"] [data-test="row-cost"]').text()).toBe('…')
    await w.setProps({ active: true })
    await flushPromises()
    await nextTick()
    expect(forCards).toHaveBeenCalledWith(['n'])
    expect(w.find('[data-test="history-row-n"] [data-test="row-cost"]').text()).toBe('~$1.25')
    w.unmount()
  })

  it('an empty history says how tasks get there', () => {
    setTaskHistory([])
    const w = mountPanel({ active: false })
    expect(w.find('[data-test="history-empty"]').exists()).toBe(true)
    expect(w.find('[data-test="history-export"]').attributes('disabled')).toBeDefined()
    w.unmount()
  })
})
