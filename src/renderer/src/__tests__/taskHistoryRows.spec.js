// The Task history tab with many records: opening a row re-renders that row
// only, creates no Intl formatter and asks main for nothing; only the rows in
// view are drawn (rowTops / visibleRange in taskHistoryView.js).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'

const renders = vi.hoisted(() => ({ ids: [] }))
vi.mock('../taskHistoryText', async (importOriginal) => {
  const orig = await importOriginal()
  // costCell runs once per row render: it says which rows rendered.
  return { ...orig, costCell: (r) => (renders.ids.push(r.id), orig.costCell(r)) }
})

import TaskHistoryPanel from '../components/TaskHistoryPanel.vue'
import { setTaskHistory } from '../taskHistory'
import { rowTops, visibleRange, VIRTUAL_MIN } from '../taskHistoryView'

const NOW = new Date(2026, 9, 6, 23, 30).getTime()
function records(n) {
  return Array.from({ length: n }, (_, i) => {
    const done = NOW - i * 37 * 60000
    return {
      id: 'r' + i,
      title: 'Task ' + i,
      agentName: 'Ada',
      agentKind: 'claude',
      project: 'Tessel',
      paneId: 'p1',
      doneAt: done,
      durationMs: 14 * 60000,
      workPeriods: [{ start: done - 14 * 60000, end: done }],
      cost: { status: 'ok', inputTokens: 900, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, usd: 0.53, known: true, final: true, models: [{ model: 'claude-opus-4-8', inputTokens: 900, outputTokens: 100, usd: 0.53, known: true }] }
    }
  })
}

// jsdom lays nothing out: the list and its rows get a size here.
let restore = []
function fakeLayout({ list = 0, row = 40, open = 160 } = {}) {
  const def = (name, get) => {
    const before = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get })
    restore.push(() => (before ? Object.defineProperty(HTMLElement.prototype, name, before) : delete HTMLElement.prototype[name]))
  }
  def('clientHeight', function () {
    return this.classList && this.classList.contains('th-list') ? list : 0
  })
  def('offsetHeight', function () {
    if (!this.classList || !this.classList.contains('th-item')) return 0
    return this.querySelector('[data-test="history-detail"]') ? open : row
  })
}

let forCards
beforeEach(() => {
  forCards = vi.fn(async () => ({}))
  window.shellApi = { jobCost: { forCards, onChanged: () => () => {} } }
  renders.ids = []
})
afterEach(() => {
  for (const r of restore.reverse()) r()
  restore = []
  delete window.shellApi
})

const mountPanel = () => mount(TaskHistoryPanel, { props: { active: true, now: NOW, projects: [{ id: 'ws', panes: [{ id: 'p1' }] }] }, attachTo: document.body })
const drawn = (w) => w.findAll('[data-test^="history-row-"]').map((x) => x.attributes('data-test').slice('history-row-'.length))

describe('rows in view', () => {
  it('rowTops: measured heights, the others at the estimate', () => {
    const tops = rowTops(['a', 'b', 'c'], (id) => ({ b: 100 })[id], 40)
    expect([...tops]).toEqual([0, 40, 140, 180])
  })

  it('visibleRange: the rows in view and a few more, the rest as space', () => {
    const tops = rowTops(Array.from({ length: 1000 }, (_, i) => i), () => 0, 40)
    expect(visibleRange(tops, 0, 400, 5)).toEqual({ start: 0, end: 16, before: 0, after: 984 * 40 })
    expect(visibleRange(tops, 4000, 400, 5)).toEqual({ start: 95, end: 116, before: 95 * 40, after: 884 * 40 })
    // Past the end: the last rows.
    expect(visibleRange(tops, 1e9, 400, 5)).toMatchObject({ end: 1000, after: 0 })
    expect(visibleRange(rowTops([], () => 0), 0, 400)).toEqual({ start: 0, end: 0, before: 0, after: 0 })
  })
})

describe('the panel with 1500 records', () => {
  it('draws only the rows in view, and others as the list scrolls', async () => {
    fakeLayout({ list: 600 })
    setTaskHistory(records(1500))
    const w = mountPanel()
    await flushPromises()
    const first = drawn(w)
    expect(first[0]).toBe('r0')
    expect(first.length).toBeLessThan(40)
    // The space of the rows not drawn keeps the list's height.
    const after = w.findAll('.th-spacer')
    expect(after).toHaveLength(1)
    expect(parseFloat(after[0].attributes('style').match(/height:\s*([\d.]+)px/)[1])).toBe((1500 - first.length) * 40)
    const list = w.find('[data-test="history-list"]').element
    list.scrollTop = 20000
    list.dispatchEvent(new Event('scroll'))
    await new Promise((r) => setTimeout(r, 40))
    await nextTick()
    const later = drawn(w)
    expect(later).toContain('r500')
    expect(later).not.toContain('r0')
    expect(later.length).toBeLessThan(40)
    w.unmount()
  })

  it('opening a row re-renders that row only: no Intl formatter, no figures asked, no other row', async () => {
    fakeLayout({ list: 600 })
    setTaskHistory(records(1500))
    const w = mountPanel()
    await flushPromises()
    forCards.mockClear()
    const made = { n: 0 }
    const saved = { NumberFormat: Intl.NumberFormat, DateTimeFormat: Intl.DateTimeFormat, PluralRules: Intl.PluralRules }
    for (const k of Object.keys(saved)) Intl[k] = new Proxy(saved[k], { construct: (T, a) => (made.n++, new T(...a)) })
    try {
      // Formatters of the details made once.
      await w.find('[data-test="history-row-r3"] button').trigger('click')
      await w.find('[data-test="history-row-r3"] button').trigger('click')
      await flushPromises()
      made.n = 0
      renders.ids = []
      await w.find('[data-test="history-row-r2"] button').trigger('click')
      await flushPromises()
      expect(w.find('[data-test="history-row-r2"] [data-test="history-detail"]').text()).toContain('Opus')
      expect(renders.ids).toEqual(['r2'])
      renders.ids = []
      // Another row: the one open closes, the new one opens; nothing else.
      await w.find('[data-test="history-row-r5"] button').trigger('click')
      await flushPromises()
      expect([...renders.ids].sort()).toEqual(['r2', 'r5'])
      expect(w.findAll('[data-test="history-detail"]')).toHaveLength(1)
      expect(made.n).toBe(0)
      expect(forCards).not.toHaveBeenCalled()
    } finally {
      Object.assign(Intl, saved)
    }
    w.unmount()
  })

  it("an open row's measured height moves the rows below it", async () => {
    fakeLayout({ list: 600, row: 40, open: 400 })
    setTaskHistory(records(1500))
    const w = mountPanel()
    await flushPromises()
    const spaceAfter = () => parseFloat(w.findAll('.th-spacer').at(-1).attributes('style').match(/height:\s*([\d.]+)px/)[1])
    const n = drawn(w).length
    expect(spaceAfter()).toBe((1500 - n) * 40)
    await w.find('[data-test="history-row-r0"] button').trigger('click')
    await flushPromises()
    await nextTick()
    // r0 is 360 px taller: fewer rows below it fit in the view.
    expect(drawn(w).length).toBeLessThan(n)
    const total = drawn(w).length
    expect(spaceAfter()).toBe((1500 - total) * 40)
    w.unmount()
  })

  it('a list never laid out (no size) draws every row; a small one is never windowed', async () => {
    setTaskHistory(records(VIRTUAL_MIN - 1))
    fakeLayout({ list: 600 })
    let w = mountPanel()
    await flushPromises()
    expect(drawn(w)).toHaveLength(VIRTUAL_MIN - 1)
    w.unmount()
    for (const r of restore.reverse()) r()
    restore = []
    setTaskHistory(records(300))
    w = mountPanel()
    await flushPromises()
    expect(drawn(w)).toHaveLength(300)
    w.unmount()
  })
})
