import { nextTick, shallowReactive, shallowRef } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from './withSetup.js'
import { useNativeChatTurnStatus } from '../use-native-chat-turn-status.js'
import { useNativeChatElapsedSeconds } from '../use-native-chat-elapsed-seconds.js'

afterEach(() => vi.useRealTimers())

describe('Vue turn timing', () => {
  it('keeps a running anchor and gives host durations precedence after settlement', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10000)
    const options = shallowReactive({
      messages: [{ id: 'u1', role: 'user' }],
      latestUserIndex: 0,
      isWorking: true,
      workingStartedAt: 8000,
      thinking: true,
      settledTurns: null,
    })
    const { result } = renderHook(() => useNativeChatTurnStatus(options))
    expect(result.current.active).toMatchObject({
      startedAt: 8000,
      workedSeconds: null,
      thinking: true,
    })
    options.workingStartedAt = 9000
    await nextTick()
    expect(result.current.active.startedAt).toBe(8000)
    vi.setSystemTime(14000)
    options.isWorking = false
    await nextTick()
    expect(result.current.completedByTurn.u1.workedSeconds).toBe(6)
    options.settledTurns = new Map([['u1', { startedAt: 7000, workedSeconds: 9 }]])
    expect(result.current.completedByTurn.u1.workedSeconds).toBe(9)
  })

  it('shares a visibility-aware elapsed clock and stops when counting is disabled', () => {
    vi.useFakeTimers()
    vi.setSystemTime(10000)
    const counting = shallowRef(true)
    const { result, unmount } = renderHook(() => useNativeChatElapsedSeconds(() => 8000, counting))
    expect(result.current).toBe(2)
    vi.advanceTimersByTime(2000)
    expect(result.current).toBe(4)
    counting.value = false
    expect(result.current).toBe(0)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
