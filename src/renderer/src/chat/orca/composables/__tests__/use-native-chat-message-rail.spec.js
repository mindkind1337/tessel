// After Orca's use-native-chat-message-rail.test.ts (MIT, Copyright (c) 2026 Lovecast Inc.)

import { shallowRef } from 'vue'
import { act, renderHook } from './withSetup.js'
import * as rowContent from '../../shared/native-chat-row-content.js'
import { describe, expect, it, vi } from 'vitest'

import { buildNativeChatTranscriptSlots } from '../../native-chat-transcript-slots.js'
import { useNativeChatMessageRail } from '../use-native-chat-message-rail.js'

function message(id, role) {
  return {
    id,
    role,
    blocks: [{ type: 'text', text: `body of ${id}` }],
    timestamp: 1,
    source: 'transcript',
  }
}

/** A fresh slot array each call, the way the list rebuilds it every render. */
function slotsOf(messages) {
  let turn
  const turnKeys = messages.map((entry) => {
    if (entry.role === 'user') {
      turn = entry.id
    }
    return turn
  })
  return buildNativeChatTranscriptSlots({
    messages,
    turnKeys,
    latestUserIndex: messages.findLastIndex((entry) => entry.role === 'user'),
    currentTurnKey: undefined,
    receipts: new Map(),
    turnStatuses: { active: null, completedByTurn: {} },
    turnDiffs: new Map(),
    showTurnStatus: false,
    expandedTurnKeys: new Set(),
    isWorking: false,
    lifecycleWorking: false,
  })
}

const CONVERSATION = [
  message('u1', 'user'),
  message('a1', 'assistant'),
  message('u2', 'user'),
  message('a2', 'assistant'),
  message('u3', 'user'),
]

describe('message rail hook', () => {
  it('reuses previews and rail state during long-history streamed renders', () => {
    const conversation = Array.from({ length: 2000 }, (_, index) =>
      message(`history-${index}`, index % 2 === 0 ? 'user' : 'assistant'),
    )
    const scrollRef = shallowRef(document.createElement('div'))
    const { result, rerender, unmount } = renderHook(
      ({ slots }) => useNativeChatMessageRail({ scrollRef, slots, virtualItems: [] }),
      { initialProps: { slots: slotsOf(conversation) } },
    )
    const initial = result.current
    const derive = vi.spyOn(rowContent, 'deriveNativeChatRowContent')
    for (let revision = 0; revision < 20; revision += 1) {
      const slots = slotsOf([
        ...conversation.slice(0, -1),
        message(`tail-${revision}`, 'assistant'),
      ])
      derive.mockClear()
      rerender({ slots })
      expect(derive.mock.calls.length).toBe(0)
      expect(result.current).toBe(initial)
    }
    unmount()
    derive.mockRestore()
  })

  it('removes its scroll listener and pending idle read on unmount', () => {
    vi.useFakeTimers()
    const element = document.createElement('div')
    const remove = vi.spyOn(element, 'removeEventListener')
    const { unmount } = renderHook(() =>
      useNativeChatMessageRail({
        scrollRef: shallowRef(element),
        slots: slotsOf(CONVERSATION),
        virtualItems: [],
      }),
    )
    act(() => element.dispatchEvent(new Event('scroll')))
    expect(vi.getTimerCount()).toBe(1)
    unmount()
    expect(remove).toHaveBeenCalledWith('scroll', expect.any(Function))
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })

  // `slots` is rebuilt on every render, so a listener effect that depended on it
  // would unsubscribe and cancel its pending idle timer on every frame of a
  // streaming turn — and the highlight would never settle.
  it('subscribes to scroll once across renders that rebuild the slots', () => {
    const element = document.createElement('div')
    const scrollRef = shallowRef(element)
    const addListener = vi.spyOn(element, 'addEventListener')

    const { rerender } = renderHook(
      ({ slots }) => useNativeChatMessageRail({ scrollRef, slots, virtualItems: [] }),
      { initialProps: { slots: slotsOf(CONVERSATION) } },
    )
    // Same prompts, new array identity — exactly what a re-render produces.
    rerender({ slots: slotsOf(CONVERSATION) })
    rerender({ slots: slotsOf(CONVERSATION) })

    const scrollSubscriptions = addListener.mock.calls.filter(([type]) => type === 'scroll')
    expect(scrollSubscriptions).toHaveLength(1)
  })

  it('ticks every user message and hides below the minimum', () => {
    const element = document.createElement('div')
    const scrollRef = shallowRef(element)

    const { result } = renderHook(() =>
      useNativeChatMessageRail({ scrollRef, slots: slotsOf(CONVERSATION), virtualItems: [] }),
    )
    expect(result.current.items.map((item) => item.id)).toEqual(['u1', 'u2', 'u3'])
    expect(result.current.visible).toBe(true)

    const { result: short } = renderHook(() =>
      useNativeChatMessageRail({
        scrollRef,
        slots: slotsOf([message('u1', 'user'), message('a1', 'assistant')]),
        virtualItems: [],
      }),
    )
    expect(short.current.visible).toBe(false)
  })

  it('maps user messages above the loaded window from the outline, before the loaded ones', () => {
    const scrollRef = shallowRef(document.createElement('div'))
    const outline = Array.from({ length: 30 }, (_, index) => ({
      id: `older-${index}`,
      text: `older prompt ${index}`,
      hasImages: false,
    }))
    const loaded = [message('u1', 'user'), message('a1', 'assistant')]
    const { result } = renderHook(() =>
      useNativeChatMessageRail({ scrollRef, slots: slotsOf(loaded), virtualItems: [], outline }),
    )
    // One loaded prompt alone would hide the rail; the outline is what makes it a map.
    expect(result.current.visible).toBe(true)
    expect(result.current.items.map((item) => item.id)).toEqual([
      ...outline.map((entry) => entry.id),
      'u1',
    ])
    expect(result.current.items.at(0)).toMatchObject({ slotIndex: null, text: 'older prompt 0' })
    expect(result.current.items.at(-1)).toMatchObject({ id: 'u1', slotIndex: 0 })
    // The sampled ticks keep both ends of the whole thread, not of the loaded page.
    expect(result.current.ticks.at(0)?.id).toBe('older-0')
    expect(result.current.ticks.at(-1)?.id).toBe('u1')
  })
})
