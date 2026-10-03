import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

// The feed of a pane's sub-agents, faked: what acquireChildren returns.
const feeds = new Map()
vi.mock('../agentChildrenFeed', () => ({
  childrenKey: (c) => JSON.stringify(c || {}),
  acquireChildren: (spec) => {
    const f = { state: { list: feeds.get(spec.paneId) || [], at: 1 }, release: vi.fn() }
    return f
  }
}))
vi.mock('../agentStatus', () => ({ turnEndedSince: () => null }))

import AgentDashboardRunning from '../components/AgentDashboardRunning.vue'

afterEach(() => feeds.clear())
const now = Date.now()
const child = (state, extra = {}) => ({ id: Math.random().toString(36), state, startedAt: now - 1000, updatedAt: now, ...extra })

describe('a Dashboard card: the sub-agents working now', () => {
  it('counts only the ones at work (not the finished ones)', async () => {
    feeds.set('p1', [child('running'), child('running'), child('done'), child('done'), child('done')])
    const w = mount(AgentDashboardRunning, { props: { row: { id: 'p1', kind: 'agent', children: { paneId: 'p1' } } } })
    await flushPromises()
    expect(w.get('[data-test="adb-running"]').text()).toBe('2 sub-agents working')
    w.unmount()
  })
  it('nothing when none works', async () => {
    feeds.set('p2', [child('done'), child('done')])
    const w = mount(AgentDashboardRunning, { props: { row: { id: 'p2', kind: 'agent', children: { paneId: 'p2' } } } })
    await flushPromises()
    expect(w.find('[data-test="adb-running"]').exists()).toBe(false)
    w.unmount()
  })
})
