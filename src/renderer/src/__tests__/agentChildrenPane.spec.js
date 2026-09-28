// The sub-agents chip of a Claude Code pane (AgentChildren.vue): answers for
// another conversation, or arriving after the pane closed, are dropped.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import AgentChildren from '../components/AgentChildren.vue'

let requests
beforeEach(() => {
  requests = []
  window.shellApi = {
    agentChildren: (q) =>
      new Promise((resolve) => {
        requests.push({ q, resolve })
      })
  }
})
afterEach(() => {
  vi.useRealTimers()
  delete window.shellApi
})

describe('sub-agents chip', () => {
  it("an older answer (another session) never shows in the current one's list", async () => {
    const w = mount(AgentChildren, { props: { agentId: 'claude', sessionId: 'A', accountId: null } })
    await flushPromises()
    requests[0].resolve([{ id: 'child-A0', state: 'running', startedAt: Date.now() }])
    await flushPromises()
    expect(w.text()).toContain('1 running')
    // A refresh for A is still out when the pane switches to B.
    await w.find('[data-test="agent-children"]').trigger('click')
    await w.setProps({ sessionId: 'B' })
    await flushPromises()
    // The old list went at once.
    expect(w.find('[data-test="agent-children"]').exists()).toBe(false)
    const forB = requests.find((r) => r.q.sessionId === 'B')
    const forA = requests.filter((r) => r.q.sessionId === 'A').pop()
    forB.resolve([{ id: 'child-B', type: 'Explore', title: 'B work', state: 'running', startedAt: Date.now() }])
    await flushPromises()
    forA.resolve([{ id: 'child-A', type: 'Explore', title: 'A work', state: 'running', startedAt: Date.now() }])
    await flushPromises()
    // The list opened before the switch shows B's only.
    expect(w.find('[data-test="agent-children-list"]').exists()).toBe(true)
    expect(w.text()).toContain('B work')
    expect(w.text()).not.toContain('A work')
    w.unmount()
  })

  it('an account change drops the old list too', async () => {
    const w = mount(AgentChildren, { props: { agentId: 'claude', sessionId: 'A', accountId: 'one' } })
    await flushPromises()
    await w.setProps({ accountId: 'two' })
    await flushPromises()
    requests[0].resolve([{ id: 'x', title: 'from one', state: 'running', startedAt: Date.now() }])
    await flushPromises()
    expect(w.find('[data-test="agent-children"]').exists()).toBe(false)
    w.unmount()
  })

  it('a refresh answered after the pane closed sets no new polling timer', async () => {
    vi.useFakeTimers()
    const w = mount(AgentChildren, { props: { agentId: 'claude', sessionId: 'A' } })
    const before = vi.getTimerCount()
    w.unmount()
    requests[0].resolve([{ id: 'c', state: 'running', startedAt: Date.now() }])
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBeLessThanOrEqual(before)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('the "done" count forgets finished ones after 30 min, even with nothing running', async () => {
    vi.useFakeTimers()
    const t0 = Date.now()
    const done = [{ id: 'd', state: 'done', startedAt: t0 - 60000, endedAt: t0 - 1000 }]
    const w = mount(AgentChildren, { props: { agentId: 'claude', sessionId: 'A' } })
    requests[0].resolve(done)
    await vi.advanceTimersByTimeAsync(0)
    expect(w.text()).toContain('1 done')
    vi.setSystemTime(t0 + 31 * 60000)
    // The next poll (every 20 s while none runs) answers the same list.
    await vi.advanceTimersByTimeAsync(20000)
    requests[requests.length - 1].resolve(done)
    await vi.advanceTimersByTimeAsync(0)
    expect(w.find('[data-test="agent-children"]').exists()).toBe(false)
    w.unmount()
  })

  it('a quiet one shows as quiet, never as finished', async () => {
    const now = Date.now()
    const w = mount(AgentChildren, { props: { agentId: 'claude', sessionId: 'A' } })
    requests[0].resolve([{ id: 'q', title: 'long tool', state: 'quiet', startedAt: now - 40 * 60000, lastAt: now - 16 * 60000, endedAt: null }])
    await flushPromises()
    expect(w.text()).toContain('1 quiet')
    await w.find('[data-test="agent-children"]').trigger('click')
    expect(w.text()).toContain('quiet 16m')
    expect(w.text()).not.toContain('✓')
    w.unmount()
  })
})
