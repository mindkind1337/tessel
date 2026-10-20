import { describe, expect, it } from 'vitest'
import { reactive, effectScope, watchEffect, nextTick, ref } from 'vue'
import { stableComputed } from '../stableComputed'
import { agentStates, applyAgentStates } from '../agentStatus'

describe('stableComputed', () => {
  it('keeps the same array while the data is the same, and stops the readers of it', async () => {
    const tick = ref(0)
    const source = reactive({ title: 'a' })
    const list = stableComputed(() => {
      tick.value // a dependency that changes without changing the data
      return [{ id: 1, title: source.title }]
    })
    const scope = effectScope()
    let runs = 0
    scope.run(() =>
      watchEffect(() => {
        void list.value
        runs++
      })
    )
    const first = list.value
    tick.value++
    await nextTick()
    expect(list.value).toBe(first)
    expect(runs).toBe(1)
    source.title = 'b'
    await nextTick()
    expect(list.value).not.toBe(first)
    expect(list.value[0].title).toBe('b')
    expect(runs).toBe(2)
    scope.stop()
  })

  it('hands out a value it cannot compare as it is', () => {
    const cycle = {}
    cycle.self = cycle
    const list = stableComputed(() => cycle)
    expect(list.value).toBe(cycle)
  })
})

describe('applyAgentStates', () => {
  const state = (extra = {}) => ({
    paneId: 'pane-1',
    provider: 'claude',
    launchToken: 'token-1',
    state: 'idle',
    reason: 'ready',
    confirmed: true,
    stale: false,
    children: [],
    ...extra
  })

  it('keeps the object of a pane whose state did not change', () => {
    applyAgentStates({ 'pane-1': state() })
    const before = agentStates['pane-1']
    applyAgentStates({ 'pane-1': state() })
    expect(agentStates['pane-1']).toBe(before)
    applyAgentStates({ 'pane-1': state({ state: 'working' }) })
    expect(agentStates['pane-1']).not.toBe(before)
    expect(agentStates['pane-1'].state).toBe('working')
    applyAgentStates({})
  })
})
