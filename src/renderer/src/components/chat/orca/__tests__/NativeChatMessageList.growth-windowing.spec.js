// After Orca's NativeChatMessageList.growth-windowing.test.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
// Exercises the real virtualizer while a streaming row grows and messages append.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'

// Many frames over a large virtualized transcript: pure CPU work (no real time
// left in it: frames run on the harness clock), which a fully loaded machine
// can stretch past the default 5 s. The cases check positions, not durations.
vi.setConfig({ testTimeout: 30_000 })
import {
  NATIVE_CHAT_BOTTOM_THRESHOLD_PX,
  NATIVE_CHAT_FOLLOW_REARM_PX
} from '../../../../chat/orca/native-chat-autoscroll.js'
import { NATIVE_CHAT_ROW_GAP_PX } from '../../../../chat/orca/native-chat-row-height-estimate.js'
import {
  advanceFrame,
  BELOW_TRANSCRIPT_PX,
  deliverResizes,
  fireScroll,
  flush,
  getButton,
  getByText,
  installElementScrollTo,
  layout,
  listProps,
  marker,
  mountList,
  queryButton,
  ROW_PITCH_PX,
  ROW_PX,
  scrollRoot,
  scrollTranscript,
  session,
  stubLayout,
  stubResizeObserver,
  TRANSCRIPT_LENGTH,
  unmountAll,
  useFrameClock,
  VIEWPORT_PX,
  windowState
} from './native-chat-windowing-test-harness.js'

vi.mock('../NativeChatMessageRow.vue', async () => ({
  default: (await import('./native-chat-list-stubs.js')).MessageRowStub
}))
vi.mock('../NativeChatResolutionReceipt.vue', async () => ({
  default: (await import('./native-chat-list-stubs.js')).ResolutionReceiptStub
}))
vi.mock('../NativeChatTurnDiffRollup.vue', async () => ({
  default: (await import('./native-chat-list-stubs.js')).TurnDiffRollupStub
}))
vi.mock('../NativeChatTaskList.vue', async () => ({
  default: (await import('./native-chat-list-stubs.js')).TaskListStub
}))

let restoreScrollTo = () => {}
beforeAll(() => {
  restoreScrollTo = installElementScrollTo()
})
afterAll(() => restoreScrollTo())
afterEach(() => unmountAll())

/** Deliver resize and scroll events to a fixed point, as a painted frame would. */
async function paint() {
  const scroller = scrollRoot()
  let lastScrollTop = scroller.scrollTop
  for (let pass = 0; pass < 12; pass += 1) {
    let changed = deliverResizes()
    await flush()
    if (scroller.scrollTop !== lastScrollTop) {
      lastScrollTop = scroller.scrollTop
      fireScroll(scroller)
      await flush()
      changed = true
    }
    if (!changed) return
  }
  throw new Error('the transcript never settled: resize and scroll kept moving it')
}

describe('transcript follow ownership across growth and appends', () => {
  const TAIL_INDEX = TRANSCRIPT_LENGTH - 1
  const GROWTH_STEPS = 24
  const LINES_PER_STEP = 12
  /** One wrapped prose line: content and measured height grow from this one number. */
  const STREAM_LINE_PX = 22
  const BASE_TOTAL_PX = (TRANSCRIPT_LENGTH - 1) * ROW_PX + (TRANSCRIPT_LENGTH - 1) * NATIVE_CHAT_ROW_GAP_PX
  /** Fixed so a re-render never restamps the turn and moves the status row. */
  const TURN_STARTED_AT = Date.now()
  const transcript = Array.from({ length: TRANSCRIPT_LENGTH }, (_, index) => marker(index))

  const appendedTranscript = (count) => [
    ...transcript,
    ...Array.from({ length: count }, (_, index) => marker(TRANSCRIPT_LENGTH + index))
  ]
  const tailHeightAt = (step) => Math.max(ROW_PX, (1 + step * LINES_PER_STEP) * STREAM_LINE_PX)
  function transcriptAt(step) {
    const lines = Array.from({ length: step * LINES_PER_STEP }, (_, index) => `streamed line ${index}`)
    const next = [...transcript]
    next[TAIL_INDEX] = {
      ...marker(TAIL_INDEX),
      blocks: [{ type: 'text', text: [`marker-${TAIL_INDEX}`, ...lines].join('\n') }]
    }
    return next
  }
  const streamingList = (step) => ({
    session: session(transcriptAt(step)),
    isWorking: true,
    expandSignal: false,
    fontScale: 1,
    workingStartedAt: TURN_STARTED_AT
  })
  function distanceFromBottom() {
    const scroller = scrollRoot()
    return scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop
  }
  function setMeasuredTail(step) {
    const heights = Array.from({ length: TRANSCRIPT_LENGTH }, () => ROW_PX)
    heights[TAIL_INDEX] = tailHeightAt(step)
    layout.measuredRowHeights = heights
  }
  const jumpButton = () => queryButton(/jump to latest/i)

  let restoreLayout = () => {}
  let restoreResizeObserver = () => {}
  beforeEach(() => {
    restoreLayout = stubLayout({ scrollGeometry: true, offsetChain: true })
    restoreResizeObserver = stubResizeObserver()
    layout.belowTranscriptPx = BELOW_TRANSCRIPT_PX
    layout.aboveTranscriptPx = 0
    setMeasuredTail(0)
  })
  afterEach(() => {
    restoreResizeObserver()
    restoreLayout()
    layout.measuredRowHeights = []
    layout.belowTranscriptPx = BELOW_TRANSCRIPT_PX
    layout.aboveTranscriptPx = 0
    vi.restoreAllMocks()
  })

  it('holds the pin, the mount and the reserved total at every frame of the growth', async () => {
    setMeasuredTail(0)
    const wrapper = await mountList(streamingList(0))
    await paint()
    expect(distanceFromBottom()).toBeLessThanOrEqual(NATIVE_CHAT_BOTTOM_THRESHOLD_PX)
    expect(windowState().totalSize).toBe(BASE_TOTAL_PX + tailHeightAt(0))

    const frames = []
    for (let step = 1; step <= GROWTH_STEPS; step += 1) {
      setMeasuredTail(step)
      await wrapper.setProps(streamingList(step))
      await paint()
      const { totalSize, indexes } = windowState()
      const distance = distanceFromBottom()
      frames.push({ step, tail: tailHeightAt(step), total: totalSize, distance })
      // Pinned: the reader is still looking at the bottom of the row.
      expect(distance).toBeLessThanOrEqual(NATIVE_CHAT_BOTTOM_THRESHOLD_PX)
      // Mounted: never swapped for reserved space while it is the live row.
      expect(indexes).toContain(TAIL_INDEX)
      expect(getByText(/streamed line 0/)).toBeTruthy()
      // Tracking: the reservation follows the measurement, not the estimate.
      expect(totalSize).toBe(BASE_TOTAL_PX + tailHeightAt(step))
      // Still a window, not the whole transcript remounted by the growth.
      expect(indexes.length).toBeLessThan(TRANSCRIPT_LENGTH / 4)
    }
    expect(frames).toHaveLength(GROWTH_STEPS)
    expect(frames.at(-1)?.tail).toBeGreaterThan(VIEWPORT_PX * 10)
    expect(Math.max(...frames.map((frame) => frame.distance))).toBeLessThanOrEqual(
      NATIVE_CHAT_BOTTOM_THRESHOLD_PX
    )
  })

  it('leaves a reader who scrolled up where they were, however far the row grows', async () => {
    setMeasuredTail(4)
    const wrapper = await mountList(streamingList(4))
    await paint()
    const readingAt = 2000
    await scrollTranscript(document, readingAt)
    await paint()
    expect(distanceFromBottom()).toBeGreaterThan(NATIVE_CHAT_BOTTOM_THRESHOLD_PX)
    expect(jumpButton()).not.toBeNull()

    for (let step = 5; step <= GROWTH_STEPS; step += 1) {
      setMeasuredTail(step)
      await wrapper.setProps(streamingList(step))
      await paint()
      const { totalSize, indexes } = windowState()
      // Not yanked: the offset the reader chose is the offset they still have.
      expect(scrollRoot().scrollTop).toBe(readingAt)
      // Off screen but still measured, which keeps the reserved total honest.
      expect(indexes).toContain(TAIL_INDEX)
      expect(totalSize).toBe(BASE_TOTAL_PX + tailHeightAt(step))
    }
    expect(jumpButton()).not.toBeNull()
  })

  it.each([0, 100])(
    'keeps a reader parked above a growing row with a %i px initial measurement delta',
    async (measurementDelta) => {
      setMeasuredTail(4)
      layout.measuredRowHeights = layout.measuredRowHeights.map((height, index) =>
        index === TAIL_INDEX ? height + measurementDelta : height
      )
      const wrapper = await mountList(streamingList(4))
      await paint()
      const scroller = scrollRoot()
      const parkGapPx = NATIVE_CHAT_BOTTOM_THRESHOLD_PX - 8
      const parkedAt = scroller.scrollHeight - scroller.clientHeight - parkGapPx
      await scrollTranscript(document, parkedAt)
      expect(distanceFromBottom()).toBe(parkGapPx)
      // The latest message is still on screen: nothing to offer a way back to yet.
      expect(jumpButton()).toBeNull()

      setMeasuredTail(5)
      await wrapper.setProps(streamingList(5))
      await paint()
      expect(scroller.scrollTop).toBe(parkedAt)

      let previousDistance = distanceFromBottom()
      for (let step = 6; step <= GROWTH_STEPS; step += 1) {
        setMeasuredTail(step)
        await wrapper.setProps(streamingList(step))
        await paint()
        // The offset stops moving at all...
        expect(scroller.scrollTop).toBe(parkedAt)
        // ...so the end runs away from the reader instead of carrying them along.
        const distance = distanceFromBottom()
        expect(distance).toBeGreaterThan(previousDistance)
        previousDistance = distance
      }
      expect(previousDistance).toBeGreaterThan(VIEWPORT_PX)
      expect(jumpButton()).not.toBeNull()
    }
  )

  it('leaves a parked reader in place through repeated appends', async () => {
    const wrapper = await mountList(listProps(transcript))
    await paint()
    const scroller = scrollRoot()
    const parkedAt = scroller.scrollHeight - scroller.clientHeight - 40
    await scrollTranscript(document, parkedAt)
    for (let count = 1; count <= 8; count += 1) {
      await wrapper.setProps(listProps(appendedTranscript(count)))
      await paint()
      expect(scroller.scrollTop).toBe(parkedAt)
      expect(windowState().indexes.length).toBeLessThan(TRANSCRIPT_LENGTH / 4)
    }
    expect(jumpButton()).not.toBeNull()
  })

  it('follows repeated appends until the reader detaches', async () => {
    const wrapper = await mountList(listProps(transcript))
    await paint()
    const scroller = scrollRoot()
    for (let count = 1; count <= 8; count += 1) {
      await wrapper.setProps(listProps(appendedTranscript(count)))
      await paint()
      expect(distanceFromBottom()).toBeLessThanOrEqual(NATIVE_CHAT_FOLLOW_REARM_PX)
      fireScroll(scroller)
      await flush()
    }
    const parkedAt = scroller.scrollTop - 22
    await scrollTranscript(document, parkedAt)
    await wrapper.setProps(listProps(appendedTranscript(9)))
    await paint()
    expect(scroller.scrollTop).toBe(parkedAt)
  })

  it('follows an empty transcript through underflow into scrollable output', async () => {
    const wrapper = await mountList(listProps([]))
    await paint()
    expect(scrollRoot().scrollTop).toBe(0)
    await wrapper.setProps(listProps(transcript.slice(0, 1)))
    await paint()
    expect(scrollRoot().scrollTop).toBe(0)
    fireScroll(scrollRoot())
    await flush()
    await wrapper.setProps(listProps(transcript))
    await paint()
    expect(distanceFromBottom()).toBeLessThanOrEqual(NATIVE_CHAT_FOLLOW_REARM_PX)
    expect(windowState().indexes.length).toBeLessThan(TRANSCRIPT_LENGTH / 4)
  })

  it.each(['reader', 'jump'])('rearms growth and append following via %s', async (rearm) => {
    setMeasuredTail(4)
    const wrapper = await mountList(streamingList(4))
    await paint()
    const scroller = scrollRoot()
    fireScroll(scroller)
    await flush()
    const parkedAt = scroller.scrollTop - 22
    await scrollTranscript(document, parkedAt)
    setMeasuredTail(5)
    await wrapper.setProps(streamingList(5))
    await paint()
    expect(scroller.scrollTop).toBe(parkedAt)

    if (rearm === 'reader') {
      await scrollTranscript(document, scroller.scrollHeight - scroller.clientHeight - NATIVE_CHAT_FOLLOW_REARM_PX)
    } else {
      getButton(/jump to latest/i).click()
      await flush()
    }
    await paint()
    expect(jumpButton()).toBeNull()
    for (let step = 6; step <= 8; step += 1) {
      setMeasuredTail(step)
      await wrapper.setProps(streamingList(step))
      await paint()
      expect(distanceFromBottom()).toBeLessThanOrEqual(NATIVE_CHAT_FOLLOW_REARM_PX)
      expect(windowState().indexes.length).toBeLessThan(TRANSCRIPT_LENGTH / 4)
    }
    await wrapper.setProps(listProps([...transcriptAt(8), marker(TRANSCRIPT_LENGTH)]))
    await paint()
    expect(distanceFromBottom()).toBeLessThanOrEqual(NATIVE_CHAT_FOLLOW_REARM_PX)
  })

  it('preserves the visible row anchor across prepends while detached', async () => {
    const wrapper = await mountList(listProps(transcript))
    await paint()
    const readingAt = 2000
    await scrollTranscript(document, readingAt)
    await paint()
    const earlier = Array.from({ length: 10 }, (_, index) => marker(index - 10))
    await wrapper.setProps(listProps([...earlier, ...transcript]))
    await paint()
    expect(scrollRoot().scrollTop).toBe(readingAt + earlier.length * ROW_PITCH_PX)
    expect(windowState().indexes.length).toBeLessThan(TRANSCRIPT_LENGTH / 4)
    expect(jumpButton()).not.toBeNull()
  })

  it('compensates a measurement entirely above the viewport without reattaching', async () => {
    const wrapper = await mountList(listProps(transcript))
    await paint()
    const scroller = scrollRoot()
    // Establish a forward scroll direction before reading at this offset.
    await scrollTranscript(document, 0)
    await paint()
    const readingAt = 2000
    await scrollTranscript(document, readingAt)
    await paint()
    const aboveIndex = windowState().indexes[0]
    expect((aboveIndex + 1) * ROW_PITCH_PX).toBeLessThan(readingAt)
    for (const growth of [100, 200]) {
      layout.measuredRowHeights = Array.from({ length: TRANSCRIPT_LENGTH }, (_, index) =>
        index === aboveIndex ? ROW_PX + growth : ROW_PX
      )
      await paint()
      expect(scroller.scrollTop).toBe(readingAt + growth)
    }
    await wrapper.setProps(listProps(appendedTranscript(1)))
    await paint()
    expect(scroller.scrollTop).toBe(readingAt + 200)
    expect(windowState().indexes.length).toBeLessThan(TRANSCRIPT_LENGTH / 4)
  })

  it('keeps following when a pin echo arrives after the document grows', async () => {
    setMeasuredTail(0)
    await mountList(streamingList(0))
    await paint()
    const scroller = scrollRoot()
    setMeasuredTail(1)
    expect(deliverResizes()).toBe(true)
    const pinnedAt = scroller.scrollTop
    layout.belowTranscriptPx += 2_000
    fireScroll(scroller)
    expect(scroller.scrollTop).toBe(pinnedAt)
    await flush()
    expect(jumpButton()).toBeNull()
    await paint()
    expect(distanceFromBottom()).toBeLessThanOrEqual(NATIVE_CHAT_FOLLOW_REARM_PX)
  })

  it('does not counter upward scrolling when measured overscan rows settle', async () => {
    const readingAt = 2000
    const aboveIndex = Math.floor(readingAt / ROW_PITCH_PX) - 1
    await mountList(listProps(transcript))
    await paint()
    await scrollTranscript(document, readingAt + 100)
    await paint()
    layout.measuredRowHeights = Array.from({ length: TRANSCRIPT_LENGTH }, (_, index) =>
      index === aboveIndex ? ROW_PX + 10 : ROW_PX
    )
    await paint()
    await scrollTranscript(document, readingAt)
    await paint()
    const scroller = scrollRoot()
    const scrollTo = vi.spyOn(scroller, 'scrollTo')
    layout.measuredRowHeights = layout.measuredRowHeights.map((height, index) =>
      index === aboveIndex ? height + 20 : height
    )
    await paint()
    expect(scroller.scrollTop).toBe(readingAt)
    expect(scrollTo).not.toHaveBeenCalled()
  })

  it('keeps the offset when a visible row shrinks past the viewport top', async () => {
    const focusedIndex = 45
    await mountList(listProps(transcript))
    await paint()
    await scrollTranscript(document, focusedIndex * ROW_PITCH_PX)
    await paint()
    layout.measuredRowHeights = Array.from({ length: TRANSCRIPT_LENGTH }, (_, index) =>
      index === focusedIndex ? 100 : ROW_PX
    )
    await paint()
    const readingAt = focusedIndex * ROW_PITCH_PX + 60
    await scrollTranscript(document, readingAt)
    await paint()
    const scroller = scrollRoot()
    const scrollTo = vi.spyOn(scroller, 'scrollTo')
    layout.measuredRowHeights = layout.measuredRowHeights.map((height, index) =>
      index === focusedIndex ? 30 : height
    )
    await paint()
    expect(scroller.scrollTop).toBe(readingAt)
    expect(scrollTo).not.toHaveBeenCalled()
  })

  it('settles a pending end reconcile after the reader keeps scrolling away', async () => {
    // Six frames of a simulated clock, not six real ones a loaded machine stretches.
    const stopClock = useFrameClock()
    onTestFinished(stopClock)
    setMeasuredTail(0)
    await mountList(streamingList(0))
    const scroller = scrollRoot()
    // A pin whose rAF reconcile is still pending when the reader moves away.
    setMeasuredTail(1)
    expect(deliverResizes()).toBe(true)
    const scheduleSpy = vi.spyOn(window, 'requestAnimationFrame')
    const scrollToSpy = vi.spyOn(scroller, 'scrollTo')
    const readingAt = 2000
    scroller.scrollTop = readingAt
    fireScroll(scroller)
    expect(scrollToSpy).toHaveBeenLastCalledWith({ behavior: 'auto', top: readingAt })
    scroller.scrollTop = 1800
    fireScroll(scroller)
    expect(scrollToSpy).toHaveBeenLastCalledWith({ behavior: 'auto', top: 1800 })

    for (let frame = 0; frame < 6; frame += 1) await advanceFrame()
    await flush()
    const scheduledFrames = scheduleSpy.mock.calls.length
    scheduleSpy.mockRestore()
    scrollToSpy.mockRestore()
    expect(scheduledFrames).toBeLessThanOrEqual(8)
    expect(scroller.scrollTop).toBe(1800)
    expect(jumpButton()).not.toBeNull()
  })

  // With something above the spacer, the transcript measures the end from the
  // document, the virtualizer from the spacer against a container-absolute offset.
  describe('with a gutter above the transcript', () => {
    const GUTTER_PX = 92
    const READING_ABOVE_END_PX = 96
    const MEASURE_SKEW_PX = 7
    function setSkewedTail(step, skew = MEASURE_SKEW_PX) {
      const heights = Array.from({ length: TRANSCRIPT_LENGTH }, () => ROW_PX)
      heights[TAIL_INDEX] = tailHeightAt(step) + skew
      layout.measuredRowHeights = heights
    }
    beforeEach(() => {
      layout.aboveTranscriptPx = GUTTER_PX
    })

    it.each([0, MEASURE_SKEW_PX])(
      'leaves a reader just above the end while the row grows (skew %i)',
      async (skew) => {
        setSkewedTail(4, skew)
        const wrapper = await mountList(streamingList(4))
        await paint()
        const scroller = scrollRoot()
        const readingAt = scroller.scrollHeight - scroller.clientHeight - READING_ABOVE_END_PX
        await scrollTranscript(document, readingAt)
        await paint()
        expect(distanceFromBottom()).toBe(READING_ABOVE_END_PX)
        for (let step = 5; step <= 10; step += 1) {
          setSkewedTail(step, skew)
          await wrapper.setProps(streamingList(step))
          await paint()
          // Not dragged along, however much the row below grows.
          expect(scroller.scrollTop).toBe(readingAt)
        }
      }
    )

    it('still pins a reader who is at the end, with the gutter in the document', async () => {
      setSkewedTail(4)
      const wrapper = await mountList(streamingList(4))
      await paint()
      expect(distanceFromBottom()).toBeLessThanOrEqual(NATIVE_CHAT_BOTTOM_THRESHOLD_PX)
      for (let step = 5; step <= 10; step += 1) {
        setSkewedTail(step)
        await wrapper.setProps(streamingList(step))
        await paint()
        expect(distanceFromBottom()).toBeLessThanOrEqual(NATIVE_CHAT_BOTTOM_THRESHOLD_PX)
      }
    })
  })
})
