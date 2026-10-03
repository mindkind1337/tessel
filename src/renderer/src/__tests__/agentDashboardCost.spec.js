// Dashboard cards: the session's tokens and estimated cost next to the time
// pill (jobCost.js), and the agent's sub-agents (agentChildrenFeed.js, as in
// the sidebar): a compact line with dots, the list on hover.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils'
import AgentDashboard from '../components/AgentDashboard.vue'
import { dashboardView } from '../agentDashboard'
import { resetJobCost } from '../jobCost'
import { _resetFeedsForTest } from '../agentChildrenFeed'
import { setMessages } from '../i18n'
import fr from '../i18n/locales/fr/agentDashboard.json'

enableAutoUnmount(afterEach)

const ENTRY = {
  inputTokens: 10000,
  outputTokens: 2400,
  cacheReadTokens: 500000,
  cacheWriteTokens: 0,
  durationMs: 360000,
  usd: 0.31,
  known: true,
  model: 'claude-opus-5-5',
  provider: 'anthropic',
  estimated: true
}
const pane = (id, extra = {}) => ({
  id,
  kind: 'agent',
  agentId: 'claude',
  agentLabel: 'Claude Code',
  title: 'Claude Code ' + id,
  state: 'ready',
  sleeping: false,
  since: 0,
  ...extra
})
const projects = () => [{ id: 'w1', name: 'tessel', panes: [pane('1', { sessionId: 'sess-1' }), pane('2')] }]

function install({ costs = {}, children = [] } = {}) {
  const shellApi = {
    jobCost: {
      forCards: vi.fn(async () => ({})),
      forPanes: vi.fn(async (ids) => Object.fromEntries(ids.filter((id) => costs[id]).map((id) => [id, costs[id]]))),
      onChanged: vi.fn(() => () => {})
    },
    agentChildren: vi.fn(async () => children)
  }
  window.shellApi = shellApi
  return shellApi
}

beforeEach(() => {
  resetJobCost()
  _resetFeedsForTest()
  setMessages('en', {})
  Object.assign(dashboardView, { groupBy: 'status', filter: 'all', query: '' })
})
afterEach(() => {
  vi.useRealTimers()
  delete window.shellApi
  setMessages('en', {})
  document.body.innerHTML = ''
})

function card(wrapper, id) {
  return wrapper.get(`[data-test="adb-card"][data-pane-id="${id}"]`)
}

describe('Dashboard: tokens and cost', () => {
  it('a card shows the session tokens and cost, compact, next to its pill', async () => {
    const api = install({ costs: { 1: ENTRY } })
    const wrapper = mount(AgentDashboard, { props: { projects: projects() } })
    await vi.waitFor(() => expect(card(wrapper, '1').find('[data-test="job-cost"]').exists()).toBe(true))
    const line = card(wrapper, '1').get('[data-test="job-cost"]')
    expect(line.text()).toBe('12.4k · ~$0.31')
    expect(line.attributes('title')).toContain('Cache read: 500k tokens')
    expect(card(wrapper, '1').find('.adb-card-side').exists()).toBe(true)
    // One call for every card; the other agent has no usage.
    expect(api.jobCost.forPanes).toHaveBeenCalledTimes(1)
    expect(api.jobCost.forPanes.mock.calls[0][0].sort()).toEqual(['1', '2'])
    expect(card(wrapper, '2').find('[data-test="job-cost"]').exists()).toBe(false)
  })

  it('without the API nothing shows', async () => {
    window.shellApi = {}
    const wrapper = mount(AgentDashboard, { props: { projects: projects() } })
    await flushPromises()
    expect(wrapper.find('[data-test="job-cost"]').exists()).toBe(false)
  })
})

describe('Dashboard: sub-agents', () => {
  const kids = () => {
    const now = Date.now()
    return [
      { id: 'a', title: 'Explore the code', type: 'Explore', state: 'running', startedAt: now - 30000, lastAt: now, tokens: 12000 },
      { id: 'b', title: 'Write tests', state: 'running', startedAt: now - 60000, lastAt: now },
      { id: 'c', title: 'Old one', state: 'done', startedAt: now - 600000, endedAt: now - 500000, tokens: 2500 }
    ]
  }

  it('"3 sub-agents · 2 running" with a dot each; the list on hover', async () => {
    const api = install({ children: kids() })
    const wrapper = mount(AgentDashboard, { props: { projects: projects() }, attachTo: document.body })
    await vi.waitFor(() => expect(card(wrapper, '1').find('[data-test="adb-children"]').exists()).toBe(true))
    expect(api.agentChildren).toHaveBeenCalledWith({ agent: 'claude', sessionId: 'sess-1' })
    const line = card(wrapper, '1').get('[data-test="adb-children"]')
    expect(line.text()).toBe('3 sub-agents · 2 running')
    expect(line.findAll('.adb-children-dots > *')).toHaveLength(3)
    // A pane without a conversation has none.
    expect(card(wrapper, '2').find('[data-test="adb-children"]').exists()).toBe(false)

    await line.trigger('pointerover', { pointerType: 'mouse' })
    await vi.waitFor(() => expect(document.body.querySelectorAll('[data-test="adb-child"]').length).toBe(3), { timeout: 2000 })
    const rows = [...document.body.querySelectorAll('[data-test="adb-child"]')].map((el) => el.textContent)
    // Running first, then the finished one.
    expect(rows[2]).toContain('Old one')
    expect(rows[2]).toContain('Finished')
    expect(rows[2]).toContain('↓ 2.5k tokens')
    expect(rows.some((r) => r.includes('Explore the code · Explore') && r.includes('Running'))).toBe(true)
  })

  it('French', async () => {
    install({ children: kids() })
    setMessages('fr', fr)
    const wrapper = mount(AgentDashboard, { props: { projects: projects() } })
    await vi.waitFor(() => expect(card(wrapper, '1').find('[data-test="adb-children"]').exists()).toBe(true))
    expect(card(wrapper, '1').get('[data-test="adb-children"]').text()).toBe('3 sous-agents · 2 en cours')
  })

  it('the feed is released when the Dashboard goes (no more polling)', async () => {
    vi.useFakeTimers()
    const api = install({ children: kids() })
    const wrapper = mount(AgentDashboard, { props: { projects: projects() } })
    await vi.advanceTimersByTimeAsync(0)
    expect(api.agentChildren).toHaveBeenCalledTimes(1)
    wrapper.unmount()
    await vi.advanceTimersByTimeAsync(60000)
    expect(api.agentChildren).toHaveBeenCalledTimes(1)
  })
})
