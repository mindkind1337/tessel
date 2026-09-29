import { nextTick, shallowRef } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { renderHook } from './withSetup.js'
import {
  nativeChatScrollOffsetWithin,
  useNativeChatTranscriptWindow,
} from '../use-native-chat-transcript-window.js'

const slot = (id, estimatedHeight = 48) => ({ message: { id }, estimatedHeight })

describe('Vue transcript virtualizer', () => {
  it('reads offset chains in scroll pixels and rejects disconnected layout', () => {
    const container = document.createElement('div')
    const parent = document.createElement('div')
    const child = document.createElement('div')
    Object.defineProperties(parent, {
      offsetParent: { value: container },
      offsetTop: { value: 20 },
    })
    Object.defineProperties(child, { offsetParent: { value: parent }, offsetTop: { value: 30 } })
    expect(nativeChatScrollOffsetWithin(child, container)).toBe(50)
    expect(nativeChatScrollOffsetWithin(document.createElement('div'), container)).toBeNull()
  })

  it('tracks structure and the sizer margin with the installed Vue virtualizer', async () => {
    const element = document.createElement('div')
    element.scrollTo = vi.fn(({ top }) => {
      element.scrollTop = top
    })
    const scrollRef = shallowRef(element)
    const slots = shallowRef([slot('a'), slot('b')])
    const { result, unmount } = renderHook(() =>
      useNativeChatTranscriptWindow({ scrollRef, slots, isVisible: true, revealIndex: -1 }),
    )
    const initial = result.current.totalSize
    expect(initial).toBeGreaterThanOrEqual(96)
    const sizer = document.createElement('div')
    Object.defineProperties(sizer, { offsetParent: { value: element }, offsetTop: { value: 25 } })
    result.current.sizerRef(sizer)
    await nextTick()
    expect(result.current.scrollMargin).toBe(25)
    slots.value = [...slots.value, slot('c', 80)]
    await nextTick()
    expect(result.current.totalSize).toBeGreaterThan(initial)
    expect(Array.isArray(result.current.virtualItems)).toBe(true)
    unmount()
  })

  it('converts zoomed rects for a reveal when the offset chain is missing', () => {
    const element = document.createElement('div')
    Object.defineProperties(element, {
      offsetHeight: { value: 100 },
      clientHeight: { value: 100 },
      scrollHeight: { value: 1000 },
    })
    element.getBoundingClientRect = () => ({ top: 40, height: 200 })
    element.scrollTop = 100
    element.scrollTo = vi.fn(({ top }) => {
      element.scrollTop = top
    })
    const child = document.createElement('div')
    child.getBoundingClientRect = () => ({ top: 240 })
    const { result } = renderHook(() =>
      useNativeChatTranscriptWindow({
        scrollRef: shallowRef(element),
        slots: [slot('a')],
        isVisible: true,
        revealIndex: -1,
      }),
    )
    element.scrollTop = 100
    result.current.alignToViewportTop(child)
    expect(element.scrollTo).toHaveBeenLastCalledWith(
      expect.objectContaining({ top: 200, behavior: 'smooth' }),
    )
  })
})
