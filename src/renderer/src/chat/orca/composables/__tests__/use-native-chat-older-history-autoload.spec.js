import { nextTick, shallowReactive, shallowRef } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from './withSetup.js'
import { useNativeChatOlderHistoryAutoload } from '../use-native-chat-older-history-autoload.js'

afterEach(() => vi.unstubAllGlobals())

describe('older history autoload', () => {
  it('stops on no progress, retries manually and does not carry a stale failure into another history', async () => {
    const observers = []
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback, options) {
          this.callback = callback
          this.options = options
          this.disconnect = vi.fn()
          this.observe = vi.fn()
          observers.push(this)
        }
      },
    )
    const options = shallowReactive({
      scrollRef: shallowRef(document.createElement('div')),
      historyKey: 'a',
      isVisible: true,
      hasMore: true,
      loadingEarlier: false,
      loadEarlier: vi.fn(async () => 'unchanged'),
    })
    const { result, unmount } = renderHook(() => useNativeChatOlderHistoryAutoload(options))
    result.current.sentinelRef(document.createElement('div'))
    await nextTick()
    expect(observers[0].options.rootMargin).toBe('600px 0px 0px 0px')
    await act(async () => observers[0].callback([{ isIntersecting: true }]))
    expect(result.current.isAutoLoadEnabled).toBe(false)
    expect(observers[0].disconnect).toHaveBeenCalledOnce()
    options.loadEarlier = vi.fn(async () => 'applied')
    await act(async () => result.current.loadEarlierManually())
    expect(result.current.isAutoLoadEnabled).toBe(true)
    let reject
    options.loadEarlier = () =>
      new Promise((_resolve, failure) => {
        reject = failure
      })
    result.current.loadEarlierManually()
    options.historyKey = 'b'
    await act(async () => reject(new Error('offline')))
    expect(result.current.isAutoLoadEnabled).toBe(true)
    unmount()
    expect(observers.at(-1).disconnect).toHaveBeenCalledOnce()
  })

  it('offers manual loading without IntersectionObserver', () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const loadEarlier = vi.fn(async () => 'applied')
    const { result } = renderHook(() =>
      useNativeChatOlderHistoryAutoload({
        scrollRef: shallowRef(null),
        historyKey: 'a',
        isVisible: true,
        hasMore: true,
        loadingEarlier: false,
        loadEarlier,
      }),
    )
    expect(result.current.isAutoLoadEnabled).toBe(false)
    result.current.loadEarlierManually()
    expect(loadEarlier).toHaveBeenCalledOnce()
  })
})
