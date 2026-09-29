// After Orca's use-native-chat-skills.react.test.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { renderHook, waitFor } from './withSetup.js'
import { useNativeChatSkills } from '../use-native-chat-skills.js'
afterEach(() => vi.useRealTimers())
const catalog = {
  skills: [{ name: 'skill', rootPath: '/skills', providers: ['agent-skills'] }],
  sources: [{ path: '/skills', owner: null }],
}
describe('injected local skill discovery', () => {
  it('starts lazily, shows loading and reuses successful discoveries', async () => {
    let resolve
    const enabled = ref(false),
      discover = vi.fn(
        () =>
          new Promise((r) => {
            resolve = r
          }),
      )
    const h = renderHook(() => useNativeChatSkills('codex', 'a', enabled, { discover }))
    expect(h.result.current.status).toBe('idle')
    expect(discover).not.toHaveBeenCalled()
    enabled.value = true
    await Promise.resolve()
    expect(h.result.current.status).toBe('loading')
    resolve(catalog)
    await waitFor(() => expect(h.result.current.status).toBe('ready'))
    expect(h.result.current.skills).toHaveLength(1)
    enabled.value = false
    enabled.value = true
    expect(discover).toHaveBeenCalledOnce()
  })
  it('surfaces errors and sends refresh on retry', async () => {
    const discover = vi.fn().mockRejectedValueOnce(new Error('failed')).mockResolvedValue(catalog)
    const h = renderHook(() => useNativeChatSkills('codex', 'a', true, { discover }))
    await waitFor(() => expect(h.result.current.status).toBe('error'))
    h.result.current.retry()
    await waitFor(() => expect(h.result.current.status).toBe('ready'))
    expect(discover.mock.calls[1][0].refresh).toBe(true)
  })
  it('does not apply old-pane results to a new pane', async () => {
    const resolves = [],
      pane = ref('a'),
      discover = vi.fn(() => new Promise((r) => resolves.push(r)))
    const h = renderHook(() => useNativeChatSkills('codex', pane, true, { discover }))
    await Promise.resolve()
    pane.value = 'b'
    await Promise.resolve()
    resolves[0](catalog)
    await Promise.resolve()
    await Promise.resolve()
    expect(h.result.current.status).toBe('loading')
    resolves[1]({ skills: [], sources: [] })
    await waitFor(() => expect(h.result.current.status).toBe('ready'))
    expect(h.result.current.skills).toEqual([])
  })
  it('marks absent discovery or remote owners unavailable without scanning', () => {
    const discover = vi.fn()
    const h = renderHook(() => useNativeChatSkills('codex', 'a', true, { discover, remote: true }))
    expect(h.result.current.errorKind).toBe('unavailable')
    expect(discover).not.toHaveBeenCalled()
  })
  it('times out a stuck discovery and allows retry', async () => {
    vi.useFakeTimers()
    const h = renderHook(() =>
      useNativeChatSkills('codex', 'a', true, {
        discover: () => new Promise(() => {}),
        timeoutMs: 10,
      }),
    )
    await vi.advanceTimersByTimeAsync(11)
    expect(h.result.current.status).toBe('error')
    expect(h.result.current.errorKind).toBe('timeout')
  })
})
