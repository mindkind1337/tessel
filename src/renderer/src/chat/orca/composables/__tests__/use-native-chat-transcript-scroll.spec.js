// After Orca's use-native-chat-transcript-scroll.test.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
import { nextTick, shallowReactive, shallowRef } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from './withSetup.js'
import { useNativeChatTranscriptScroll } from '../use-native-chat-transcript-scroll.js'

afterEach(() => vi.unstubAllGlobals())

function setupScroll() {
  const element = document.createElement('div')
  Object.defineProperties(element, {
    clientHeight: { value: 100, configurable: true },
    scrollHeight: { value: 1000, configurable: true },
  })
  element.scrollTop = 900
  const observers = []
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback) {
        this.callback = callback
        this.disconnect = vi.fn()
        observers.push(this)
      }
      observe() {}
    },
  )
  const options = shallowReactive({
    scrollRef: shallowRef(element),
    contentRef: shallowRef(document.createElement('div')),
    itemCount: 5,
    isWorking: true,
    showTypingIndicator: true,
    isVisible: true,
    alignToViewportTop: vi.fn(),
    scrollToEnd: vi.fn(),
    restoreScrollOffset: vi.fn(),
    consumeProgrammaticScroll: vi.fn(() => false),
    reconcileReaderScroll: vi.fn(),
  })
  const hook = renderHook(() => useNativeChatTranscriptScroll(options))
  return { ...hook, options, element, observers }
}

describe('transcript reader intent', () => {
  it('restores the last detached offset when a retained tab is revealed', async () => {
    const { result, options, element, observers, unmount } = setupScroll()
    expect(options.scrollToEnd).toHaveBeenCalledTimes(1)
    element.scrollTop = 300
    result.current.onScroll(new Event('scroll'))
    expect(result.current.showJump).toBe(true)
    expect(options.reconcileReaderScroll).toHaveBeenLastCalledWith(true)
    options.itemCount += 1
    await nextTick()
    observers[0].callback()
    expect(options.scrollToEnd).toHaveBeenCalledTimes(1)
    options.isVisible = false
    await nextTick()
    element.scrollTop = 900
    result.current.onScroll(new Event('scroll'))
    options.restoreScrollOffset.mockImplementation((offset) => {
      element.scrollTop = offset
    })
    options.isVisible = true
    await nextTick()
    expect(options.restoreScrollOffset).toHaveBeenCalledExactlyOnceWith(300)
    expect(element.scrollTop).toBe(300)
    result.current.scrollToBottom()
    expect(options.scrollToEnd).toHaveBeenCalledTimes(2)
    expect(result.current.showJump).toBe(false)
    unmount()
    expect(observers[0].disconnect).toHaveBeenCalledOnce()
  })

  it('reattaches a detached reader that content shrinking clamps onto the end', async () => {
    const { result, options, element } = setupScroll()
    element.scrollTop = 850
    result.current.onScroll(new Event('scroll'))
    options.scrollToEnd.mockClear()
    options.itemCount += 1
    await nextTick()
    expect(options.scrollToEnd).not.toHaveBeenCalled()
    Object.defineProperty(element, 'scrollHeight', { value: 700 })
    element.scrollTop = 600
    result.current.onScroll(new Event('scroll'))
    options.itemCount += 1
    await nextTick()
    expect(options.scrollToEnd).toHaveBeenCalled()
  })

  it('does not rearm following from a programmatic scroll to the bottom', async () => {
    const { result, options, element } = setupScroll()
    element.scrollTop = 100
    result.current.onScroll(new Event('scroll'))
    options.consumeProgrammaticScroll.mockReturnValue(true)
    element.scrollTop = 900
    result.current.onScroll(new Event('scroll'))
    options.itemCount += 1
    await nextTick()
    expect(options.scrollToEnd).toHaveBeenCalledTimes(1)
  })

  it('does not write to a viewport with no measurable height', () => {
    const { result, options, element } = setupScroll()
    options.scrollToEnd.mockClear()
    Object.defineProperty(element, 'clientHeight', { value: 0 })
    result.current.scrollToBottom()
    expect(options.scrollToEnd).not.toHaveBeenCalled()
  })
})
