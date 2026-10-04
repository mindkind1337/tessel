// Per-job tokens / time / cost: the shared fetcher and formatting
// (jobCost.js) and the task board's cards and total.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { setMessages } from '../i18n'
import {
  formatTokens,
  jobCostLine,
  jobCostDetails,
  costText,
  sumJobCosts,
  hasUsage,
  resetJobCost,
  THROTTLE_MS
} from '../jobCost'
import { setTasks, addTask } from '../taskBoardStore'
import TaskBoard from '../components/TaskBoard.vue'
import TaskCard from '../components/TaskCard.vue'
import fr from '../i18n/locales/fr/jobCost.json'

const ENTRY = {
  inputTokens: 10000,
  outputTokens: 2400,
  cacheReadTokens: 1_200_000,
  cacheWriteTokens: 30000,
  durationMs: 6 * 60 * 1000,
  usd: 0.31,
  known: true,
  model: 'claude-opus-5-5',
  provider: 'anthropic',
  estimated: true
}

function installApi(byCard = {}, byPane = {}) {
  const listeners = []
  const api = {
    forCards: vi.fn(async (ids) => Object.fromEntries(ids.filter((id) => byCard[id]).map((id) => [id, byCard[id]]))),
    forPanes: vi.fn(async (ids) => Object.fromEntries(ids.filter((id) => byPane[id]).map((id) => [id, byPane[id]]))),
    onChanged: vi.fn((cb) => {
      listeners.push(cb)
      return () => listeners.splice(listeners.indexOf(cb), 1)
    }),
    fire: () => listeners.slice().forEach((cb) => cb()),
    listeners
  }
  window.shellApi = { ...(window.shellApi || {}), jobCost: api }
  return api
}

enableAutoUnmount(afterEach)

beforeEach(() => {
  resetJobCost()
  setTasks([])
  setMessages('en', {})
})
afterEach(() => {
  vi.useRealTimers()
  if (window.shellApi) delete window.shellApi.jobCost
  setMessages('en', {})
})

describe('formatting', () => {
  it('tokens with k / M suffixes in the interface language', () => {
    expect(formatTokens(950, 'en-US')).toBe('950')
    expect(formatTokens(12400, 'en-US')).toBe('12.4k')
    expect(formatTokens(12400, 'fr-CA')).toBe('12,4k')
    expect(formatTokens(250000, 'en-US')).toBe('250k')
    expect(formatTokens(3_200_000, 'en-US')).toBe('3.2M')
    expect(formatTokens(999_990, 'en-US')).toBe('1M')
  })

  it('the line: tokens · time · ~cost, in English and French', () => {
    expect(jobCostLine(ENTRY, { locale: 'en-US' })).toBe('12.4k tokens · 6 min · ~$0.31')
    setMessages('fr', fr)
    expect(jobCostLine(ENTRY, { locale: 'fr-CA' }).replace(/\s/g, ' ')).toBe('12,4k tokens · 6 min · ~0,31 $')
  })

  it('compact: no word, no time', () => {
    expect(jobCostLine(ENTRY, { compact: true, locale: 'en-US' })).toBe('12.4k · ~$0.31')
  })

  it('unknown price: "cost unknown", tokens and time still shown', () => {
    const e = { ...ENTRY, usd: null, known: false }
    expect(jobCostLine(e, { locale: 'en-US' })).toBe('12.4k tokens · 6 min · cost unknown')
    expect(jobCostDetails(e, 'en-US')).toContain('No price known for this model')
  })

  it('under a cent: no "~" before "<"', () => {
    expect(costText({ ...ENTRY, usd: 0.001 }, 'en-US')).toBe('< $0.01')
  })

  it('details: each kind of token, model, and what the estimate means', () => {
    const d = jobCostDetails(ENTRY, 'en-US')
    expect(d).toContain('Input: 10k tokens')
    expect(d).toContain('Output: 2.4k tokens')
    expect(d).toContain('Cache read: 1.2M tokens')
    expect(d).toContain('Cache write: 30k tokens')
    expect(d).toContain('Model: Opus 5.5')
    expect(d).toContain('API-equivalent estimate (subscriptions are not billed per token)')
  })

  it('no usage: nothing', () => {
    expect(hasUsage(null)).toBe(false)
    expect(hasUsage({ inputTokens: 0, outputTokens: 0, usd: 0 })).toBe(false)
    expect(jobCostLine({ inputTokens: 0 })).toBe('')
  })

  it('sum: known costs added, unknown ones counted apart', () => {
    const total = sumJobCosts([ENTRY, { ...ENTRY, usd: null, known: false }, null, { ...ENTRY, usd: 0.19 }])
    expect(total.count).toBe(3)
    expect(total.unknownCount).toBe(1)
    expect(total.inputTokens).toBe(30000)
    expect(total.usd).toBeCloseTo(0.5)
    expect(total.known).toBe(true)
    expect(sumJobCosts([{ ...ENTRY, usd: null, known: false }]).known).toBe(false)
  })
})

describe('task board', () => {
  it('a card with usage shows the muted line with its details; one without shows nothing', async () => {
    const used = addTask({ title: 'Used' })
    addTask({ title: 'Fresh' })
    const api = installApi({ [used.id]: ENTRY })
    const wrapper = mount(TaskBoard)
    await vi.waitFor(() => expect(api.forCards).toHaveBeenCalled())
    await flushPromises()
    const cards = wrapper.findAll('[data-test="task-card"]')
    const usedCard = cards.find((c) => c.text().includes('Used'))
    const freshCard = cards.find((c) => c.text().includes('Fresh'))
    const line = usedCard.get('[data-test="job-cost"]')
    expect(line.text()).toBe('12.4k tokens · 6 min · ~$0.31')
    expect(line.attributes('title')).toContain('Cache read: 1.2M tokens')
    expect(line.attributes('title')).toContain('subscriptions are not billed per token')
    expect(freshCard.find('[data-test="job-cost"]').exists()).toBe(false)
    // One batched call for every card of the board.
    expect(api.forCards).toHaveBeenCalledTimes(1)
    expect(api.forCards.mock.calls[0][0]).toHaveLength(2)
    expect(api.forCards.mock.calls[0][0]).toContain(used.id)
    wrapper.unmount()
  })

  it('the total sums the visible cards, at the top of the board', async () => {
    const a = addTask({ title: 'A' })
    const b = addTask({ title: 'B' })
    installApi({ [a.id]: ENTRY, [b.id]: { ...ENTRY, usd: 0.19, durationMs: 4 * 60 * 1000 } })
    const wrapper = mount(TaskBoard)
    await vi.waitFor(() => expect(wrapper.find('[data-test="task-board-cost"]').exists()).toBe(true))
    const total = wrapper.get('[data-test="task-board-cost"]')
    expect(total.text()).toContain('Total:')
    expect(total.get('[data-test="job-cost"]').text()).toBe('24.8k tokens · 10 min · ~$0.50')
    wrapper.unmount()
  })

  it('no API (older main process): nothing shows, nothing breaks', async () => {
    addTask({ title: 'A' })
    const wrapper = mount(TaskBoard)
    await flushPromises()
    expect(wrapper.find('[data-test="job-cost"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="task-board-cost"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('refreshes on onChanged, throttled, and stops listening once unmounted', async () => {
    vi.useFakeTimers()
    const a = addTask({ title: 'A' })
    const api = installApi({})
    const wrapper = mount(TaskBoard)
    await vi.advanceTimersByTimeAsync(0)
    expect(api.forCards).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[data-test="job-cost"]').exists()).toBe(false)
    // Now it has usage; three changes in a row make one call.
    api.forCards.mockImplementation(async () => ({ [a.id]: ENTRY }))
    api.fire()
    api.fire()
    api.fire()
    await vi.advanceTimersByTimeAsync(THROTTLE_MS / 2)
    expect(api.forCards).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(THROTTLE_MS)
    expect(api.forCards).toHaveBeenCalledTimes(2)
    await nextTick()
    expect(wrapper.get('[data-test="job-cost"]').text()).toContain('12.4k tokens')
    wrapper.unmount()
    expect(api.listeners).toHaveLength(0)
  })

  it('moving a card asks again', async () => {
    vi.useFakeTimers()
    const a = addTask({ title: 'A' })
    const api = installApi({ [a.id]: ENTRY })
    const wrapper = mount(TaskBoard)
    await vi.advanceTimersByTimeAsync(0)
    expect(api.forCards).toHaveBeenCalledTimes(1)
    a.column = 'doing'
    await nextTick()
    await vi.advanceTimersByTimeAsync(THROTTLE_MS)
    expect(api.forCards).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })

  it('a card in Doing: its time goes on between two reads of the figures (card and total)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-03T10:00:00Z'))
    const a = addTask({ title: 'A' })
    a.column = 'doing'
    a.workPeriods = [{ start: Date.now() - 6 * 60 * 1000, end: null, paneId: 'pane-1' }]
    const api = installApi({ [a.id]: ENTRY })
    const wrapper = mount(TaskBoard)
    await vi.advanceTimersByTimeAsync(0)
    await nextTick()
    expect(wrapper.get('[data-task-id="' + a.id + '"] [data-test="job-cost"]').text()).toBe('12.4k tokens · 6 min · ~$0.31')
    // Ten minutes later, nothing written by the agent (no change notice).
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
    await nextTick()
    expect(api.forCards).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-task-id="' + a.id + '"] [data-test="job-cost"]').text()).toBe('12.4k tokens · 16 min · ~$0.31')
    expect(wrapper.get('[data-test="task-board-cost"] [data-test="job-cost"]').text()).toBe('12.4k tokens · 16 min · ~$0.31')
    wrapper.unmount()
  })

  it('TaskCard alone: the cost prop drives the line', () => {
    const task = addTask({ title: 'Alone' })
    const wrapper = mount(TaskCard, { props: { task, cost: { ...ENTRY, usd: null, known: false } } })
    expect(wrapper.get('[data-test="job-cost"]').text()).toBe('12.4k tokens · 6 min · cost unknown')
    const none = mount(TaskCard, { props: { task } })
    expect(none.find('[data-test="task-cost"]').exists()).toBe(false)
  })
})
