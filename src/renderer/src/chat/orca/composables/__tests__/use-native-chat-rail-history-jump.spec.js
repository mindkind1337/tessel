// After Orca's use-native-chat-rail-history-jump.test.ts (MIT, Copyright (c) 2026 Lovecast Inc.)

import { act, renderHook, waitFor } from './withSetup.js'
import { computed } from 'vue'
import { useExternalSnapshot } from './withSetup.js'
import { describe, expect, it, vi } from 'vitest'

import { useNativeChatRailHistoryJump } from '../use-native-chat-rail-history-jump.js'

/** A lane shaped like the structured read owner: a page lands in the store, and
 *  only then does the returned promise settle. A request made while a page is in
 *  flight joins it and shares its result. */
function createLane({ total, pageSize, initiallyLoaded, ghost, pageResult = 'applied' }) {
  const ids = Array.from({ length: total }, (_, index) => `m${index}`)
  let snapshot = {
    loaded: initiallyLoaded,
    messages: ids.slice(total - initiallyLoaded),
    streamed: 0,
  }
  const listeners = new Set()
  const emit = () => listeners.forEach((listener) => listener())
  const pageGate = { release: null }
  let holdPages = false
  let inFlight = null
  const reads = { count: 0 }
  const readPage = async () => {
    reads.count += 1
    if (holdPages) {
      await new Promise((resolve) => {
        pageGate.release = resolve
      })
    }
    await Promise.resolve()
    if (pageResult !== 'applied') {
      return pageResult
    }
    const loaded = Math.min(total, snapshot.loaded + pageSize)
    snapshot = { ...snapshot, loaded, messages: ids.slice(total - loaded) }
    emit()
    return 'applied'
  }
  const loadEarlier = vi.fn(() => {
    if (inFlight) {
      return inFlight
    }
    if (snapshot.loaded >= total) {
      return Promise.resolve('exhausted')
    }
    const page = readPage().finally(() => {
      inFlight = null
    })
    inFlight = page
    return page
  })
  const lane = {
    loadEarlier,
    reads,
    holdPages: () => {
      holdPages = true
    },
    releasePage: () => pageGate.release?.(),
    /** A live turn streaming: new state, nothing older. */
    stream: () => {
      snapshot = { ...snapshot, streamed: snapshot.streamed + 1 }
      emit()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => snapshot,
  }
  const useLaneRailJump = (jumpToLoaded, sessionKey = 'session-1') => {
    const current = useExternalSnapshot(lane.subscribe, lane.getSnapshot)
    const items = computed(() => {
      const firstLoaded = total - current.value.loaded
      const unloaded = ids.slice(0, firstLoaded)
      const outline = ghost && ghost.at < firstLoaded ? [ghost.id, ...unloaded] : unloaded
      return [
        ...outline.map((id) => ({ id, slotIndex: null, text: id, hasImages: false })),
        ...current.value.messages.map((id, slotIndex) => ({
          id,
          slotIndex,
          text: id,
          hasImages: false,
        })),
      ]
    })
    return useNativeChatRailHistoryJump({
      items,
      sessionKey,
      loadEarlier: lane.loadEarlier,
      jumpToLoaded,
    })
  }
  return { lane, useLaneRailJump }
}

function outlineItem(id) {
  return { id, slotIndex: null, text: id, hasImages: false }
}

async function releasePage(lane) {
  await act(async () => {
    lane.releasePage()
    await Promise.resolve()
  })
}

describe('rail jump through unloaded history', () => {
  it('pages older history until the message has a slot, then jumps to it', async () => {
    const { lane, useLaneRailJump } = createLane({ total: 100, pageSize: 10, initiallyLoaded: 10 })
    const jumpToLoaded = vi.fn()
    const { result } = renderHook(() => useLaneRailJump(jumpToLoaded))

    act(() => result.current.start(outlineItem('m5')))
    expect(result.current.pendingId).toBe('m5')

    await waitFor(() => expect(jumpToLoaded).toHaveBeenCalledTimes(1))
    // 90 messages were unloaded and m5 sits 5 from the top: nine pages reach it.
    expect(lane.reads.count).toBe(9)
    expect(jumpToLoaded).toHaveBeenCalledWith(expect.objectContaining({ id: 'm5', slotIndex: 5 }))
    expect(result.current.pendingId).toBeNull()
  })

  it('stops quietly when history runs out without the message drawing a row', async () => {
    const { lane, useLaneRailJump } = createLane({
      total: 30,
      pageSize: 10,
      initiallyLoaded: 10,
      ghost: { id: 'ghost', at: -1 },
    })
    const jumpToLoaded = vi.fn()
    const { result } = renderHook(() => useLaneRailJump(jumpToLoaded))

    act(() => result.current.start(outlineItem('ghost')))
    await waitFor(() => expect(result.current.pendingId).toBeNull())
    expect(lane.reads.count).toBe(2)
    expect(jumpToLoaded).not.toHaveBeenCalled()
  })

  it('stops once the window covers the message without it drawing a row', async () => {
    const { lane, useLaneRailJump } = createLane({
      total: 40,
      pageSize: 10,
      initiallyLoaded: 10,
      ghost: { id: 'ghost', at: 25 },
    })
    const jumpToLoaded = vi.fn()
    const { result } = renderHook(() => useLaneRailJump(jumpToLoaded))

    act(() => result.current.start(outlineItem('ghost')))
    await waitFor(() => expect(result.current.pendingId).toBeNull())
    // The first page covers index 25; history behind it is not read for a message that has no row.
    expect(lane.reads.count).toBe(1)
    expect(jumpToLoaded).not.toHaveBeenCalled()
  })

  it.each(['failed', 'unchanged', 'superseded'])(
    'stops after one %s page even while a live turn keeps streaming',
    async (pageResult) => {
      const { lane, useLaneRailJump } = createLane({
        total: 30,
        pageSize: 10,
        initiallyLoaded: 10,
        pageResult,
      })
      lane.holdPages()
      const jumpToLoaded = vi.fn()
      const { result } = renderHook(() => useLaneRailJump(jumpToLoaded))

      act(() => result.current.start(outlineItem('m3')))
      await waitFor(() => expect(lane.reads.count).toBe(1))
      for (let batch = 0; batch < 5; batch += 1) {
        act(() => lane.stream())
      }
      await releasePage(lane)
      for (let batch = 0; batch < 5; batch += 1) {
        act(() => lane.stream())
        await act(async () => {
          await Promise.resolve()
        })
      }

      await waitFor(() => expect(result.current.pendingId).toBeNull())
      expect(lane.loadEarlier).toHaveBeenCalledTimes(1)
      expect(jumpToLoaded).not.toHaveBeenCalled()
    },
  )

  it('joins a page already in flight instead of reading it as no progress', async () => {
    const { lane, useLaneRailJump } = createLane({ total: 40, pageSize: 10, initiallyLoaded: 10 })
    lane.holdPages()
    const jumpToLoaded = vi.fn()
    const { result } = renderHook(() => useLaneRailJump(jumpToLoaded))
    // Scrolling to the top already asked for the next page.
    act(() => void lane.loadEarlier())

    act(() => result.current.start(outlineItem('m25')))
    expect(result.current.pendingId).toBe('m25')
    await releasePage(lane)

    await waitFor(() => expect(jumpToLoaded).toHaveBeenCalledTimes(1))
    expect(jumpToLoaded).toHaveBeenCalledWith(expect.objectContaining({ id: 'm25' }))
    expect(lane.reads.count).toBe(1)
  })

  it("lets a pick made during another pick's page win, sharing that page", async () => {
    const { lane, useLaneRailJump } = createLane({ total: 40, pageSize: 10, initiallyLoaded: 10 })
    lane.holdPages()
    const jumpToLoaded = vi.fn()
    const { result } = renderHook(() => useLaneRailJump(jumpToLoaded))

    act(() => result.current.start(outlineItem('m25')))
    await waitFor(() => expect(lane.reads.count).toBe(1))
    act(() => result.current.start(outlineItem('m2')))
    expect(result.current.pendingId).toBe('m2')
    for (let page = 0; page < 3; page += 1) {
      await releasePage(lane)
    }

    await waitFor(() => expect(jumpToLoaded).toHaveBeenCalledTimes(1))
    // The superseded jump's target loaded first, and it never jumped there.
    expect(jumpToLoaded).toHaveBeenCalledWith(expect.objectContaining({ id: 'm2' }))
    expect(lane.reads.count).toBe(3)
  })

  it("aims at a pick made before the previous one's commit settled", async () => {
    const { lane, useLaneRailJump } = createLane({ total: 40, pageSize: 10, initiallyLoaded: 10 })
    const jumpToLoaded = vi.fn()
    const { result } = renderHook(() => useLaneRailJump(jumpToLoaded))

    act(() => {
      result.current.start(outlineItem('m25'))
      result.current.start(outlineItem('m2'))
    })

    await waitFor(() => expect(result.current.pendingId).toBeNull())
    expect(jumpToLoaded).toHaveBeenCalledTimes(1)
    expect(jumpToLoaded).toHaveBeenCalledWith(expect.objectContaining({ id: 'm2' }))
    expect(lane.reads.count).toBe(3)
  })

  it('stops paging once aborted', async () => {
    const { lane, useLaneRailJump } = createLane({ total: 40, pageSize: 10, initiallyLoaded: 10 })
    lane.holdPages()
    const jumpToLoaded = vi.fn()
    const { result } = renderHook(() => useLaneRailJump(jumpToLoaded))

    act(() => result.current.start(outlineItem('m25')))
    await waitFor(() => expect(lane.reads.count).toBe(1))
    act(() => result.current.abort())
    expect(result.current.pendingId).toBeNull()
    await releasePage(lane)

    // The page it was waiting on still lands for the lane; the jump does not follow it.
    expect(lane.getSnapshot().loaded).toBe(20)
    expect(lane.reads.count).toBe(1)
    expect(jumpToLoaded).not.toHaveBeenCalled()
  })

  it('abandons the jump when the session changes mid-page', async () => {
    const { lane, useLaneRailJump } = createLane({ total: 40, pageSize: 10, initiallyLoaded: 10 })
    lane.holdPages()
    const jumpToLoaded = vi.fn()
    const { result, rerender } = renderHook(
      ({ sessionKey }) => useLaneRailJump(jumpToLoaded, sessionKey),
      { initialProps: { sessionKey: 'session-1' } },
    )

    act(() => result.current.start(outlineItem('m25')))
    await waitFor(() => expect(lane.reads.count).toBe(1))
    rerender({ sessionKey: 'session-2' })
    expect(result.current.pendingId).toBeNull()
    await releasePage(lane)

    expect(lane.reads.count).toBe(1)
    expect(jumpToLoaded).not.toHaveBeenCalled()
  })

  it('abandons the jump when the list unmounts mid-page', async () => {
    const { lane, useLaneRailJump } = createLane({ total: 40, pageSize: 10, initiallyLoaded: 10 })
    lane.holdPages()
    const jumpToLoaded = vi.fn()
    const { result, unmount } = renderHook(() => useLaneRailJump(jumpToLoaded))

    act(() => result.current.start(outlineItem('m2')))
    await waitFor(() => expect(lane.reads.count).toBe(1))
    unmount()
    await releasePage(lane)
    expect(lane.reads.count).toBe(1)
    expect(jumpToLoaded).not.toHaveBeenCalled()
  })
})
