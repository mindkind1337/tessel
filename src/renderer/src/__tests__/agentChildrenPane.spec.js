// The sub-agents chip of a Claude Code pane (AgentChildren.vue): answers for
// another conversation, or arriving after the pane closed, are dropped.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import AgentChildren from '../components/AgentChildren.vue'

// The list is teleported to <body> (above the other panes): these tests look
// at what it shows, so it renders in place here.
const mountChip = (props) => mount(AgentChildren, { props, global: { stubs: { teleport: true } } })

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
    const w = mountChip({ agentId: 'claude', sessionId: 'A', accountId: null })
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
    const w = mountChip({ agentId: 'claude', sessionId: 'A', accountId: 'one' })
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
    const w = mountChip({ agentId: 'claude', sessionId: 'A' })
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
    const w = mountChip({ agentId: 'claude', sessionId: 'A' })
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
    const w = mountChip({ agentId: 'claude', sessionId: 'A' })
    requests[0].resolve([{ id: 'q', title: 'long tool', state: 'quiet', startedAt: now - 40 * 60000, lastAt: now - 16 * 60000, endedAt: null }])
    await flushPromises()
    expect(w.text()).toContain('1 quiet')
    await w.find('[data-test="agent-children"]').trigger('click')
    expect(w.text()).toContain('quiet 16m')
    expect(w.text()).not.toContain('✓')
    w.unmount()
  })

  it('is a compact count in the header; its list opens in the top layer, next to it and inside the window', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const w = mount(AgentChildren, { props: { agentId: 'claude', sessionId: 'A' }, attachTo: host })
    requests[0].resolve([
      { id: 'a', type: 'Explore', title: 'first', state: 'running', startedAt: Date.now() },
      { id: 'b', type: 'Plan', title: 'second', state: 'running', startedAt: Date.now() }
    ])
    await flushPromises()
    const chip = w.get('[data-test="agent-children"]')
    expect(chip.get('.agent-children-count').text()).toBe('2')
    expect(chip.attributes('title')).toContain('2 running')
    chip.element.getBoundingClientRect = () => ({ left: 900, right: 930, top: 40, bottom: 60, width: 30, height: 20 })
    await chip.trigger('click')
    await flushPromises()
    // Not inside the pane (its header), but at the end of <body>.
    expect(w.find('[data-test="agent-children-list"]').exists()).toBe(false)
    const list = document.body.querySelector(':scope > [data-test="agent-children-list"]')
    expect(list).not.toBeNull()
    expect(list.textContent).toContain('first')
    expect(parseInt(list.style.top)).toBe(66)
    expect(parseInt(list.style.left)).toBeLessThanOrEqual(window.innerWidth)
    // A click in the list keeps it open; outside, or Esc, closes it.
    list.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await flushPromises()
    expect(document.body.querySelector('[data-test="agent-children-list"]')).not.toBeNull()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(document.body.querySelector('[data-test="agent-children-list"]')).toBeNull()
    await chip.trigger('click')
    await flushPromises()
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await flushPromises()
    expect(document.body.querySelector('[data-test="agent-children-list"]')).toBeNull()
    w.unmount()
    host.remove()
  })
})
