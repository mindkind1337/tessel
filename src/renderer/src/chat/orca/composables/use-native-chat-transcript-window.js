// After Orca's use-native-chat-transcript-window.ts (MIT, Copyright (c) 2026 Lovecast Inc.)
// Inputs accept plain values, refs/computed or getters; options may be reactive.
// DOM refs use .value. Callbacks keep their original call signatures.
// Returns a stable object; state fields are refs/computed, actions are functions.
import {
  computed,
  onScopeDispose,
  onUpdated,
  ref,
  shallowRef,
  toValue,
  watch,
  watchPostEffect,
} from 'vue'
import { elementScroll } from '@tanstack/vue-virtual'
import { useVirtualizer } from '../lib/use-post-render-virtualizer.js'
import { createProgrammaticScrollMarks } from '../lib/programmatic-scroll-marks.js'
import { NATIVE_CHAT_ROW_GAP_PX } from '../native-chat-row-height-estimate.js'
import {
  nativeChatPinnedRowIndexes,
  nativeChatTranscriptRange,
} from '../native-chat-pinned-rows.js'

export const NATIVE_CHAT_WINDOW_OVERSCAN = 6
export const MAX_RETIRED_NATIVE_CHAT_MEASUREMENTS = 512
const FALLBACK_ROW_PX = 48

export function nativeChatScrollOffsetWithin(element, container) {
  let top = 0
  let node = element
  while (node !== null && node !== container) {
    top += node.offsetTop
    const parent = node.offsetParent
    node = parent && typeof parent.offsetTop === 'number' ? parent : null
  }
  return node === container ? top : null
}

function rectOffsetWithin(element, container) {
  const rect = container.getBoundingClientRect()
  const zoom =
    container.offsetHeight > 0 && rect.height > 0 ? rect.height / container.offsetHeight : 1
  return container.scrollTop + (element.getBoundingClientRect().top - rect.top) / zoom
}

export function useNativeChatTranscriptWindow(options) {
  const read = (key) => toValue(toValue(options)[key])
  const sizer = shallowRef(null)
  const scrollMargin = ref(0)
  const marks = createProgrammaticScrollMarks()
  let readerTakeoverFrame = null
  let previousMeasurementKeys = null
  let retiredMeasurementCount = 0
  const pinned = computed(() =>
    nativeChatPinnedRowIndexes({ count: read('slots').length, revealIndex: read('revealIndex') }),
  )
  const encodedKeys = computed(() => JSON.stringify(read('slots').map((slot) => slot.message.id)))
  const itemKeys = computed(() => JSON.parse(encodedKeys.value))
  // The key function changes only with structure, not streamed row content.
  const getItemKey = computed(() => {
    const keys = itemKeys.value
    return (index) => keys[index] ?? index
  })
  const rangeExtractor = computed(() => {
    const indexes = pinned.value
    return (range) => nativeChatTranscriptRange(range, indexes)
  })
  const virtualizer = useVirtualizer(
    computed(() => ({
      count: read('slots').length,
      getScrollElement: () => read('scrollRef'),
      estimateSize: (index) => read('slots')[index]?.estimatedHeight ?? FALLBACK_ROW_PX,
      getItemKey: getItemKey.value,
      rangeExtractor: rangeExtractor.value,
      overscan: NATIVE_CHAT_WINDOW_OVERSCAN,
      gap: NATIVE_CHAT_ROW_GAP_PX,
      scrollMargin: scrollMargin.value,
      anchorTo: 'end',
      followOnAppend: false,
      scrollEndThreshold: -1,
      // Tessel: a hidden pane lays nothing out (every row measures 0); rows keep
      // their last size meanwhile, so the reader's place is not shifted by
      // phantom shrinks that the reveal's re-measure then over-corrects.
      useCachedMeasurements: !read('isVisible'),
      scrollToFn: (offset, settings, instance) => {
        const target = offset + (settings.adjustments ?? 0)
        const element = instance.scrollElement
        if (settings.behavior === 'smooth') {
          if (element) {
            const max = Math.max(0, element.scrollHeight - element.clientHeight)
            const landing = Math.max(0, Math.min(target, max))
            if (element.scrollTop !== landing) marks.mark(landing)
          }
          elementScroll(offset, settings, instance)
          return
        }
        const previous = element?.scrollTop
        elementScroll(offset, settings, instance)
        const landing = element?.scrollTop
        if (previous !== undefined && landing !== undefined && landing !== previous)
          marks.mark(landing)
      },
    })),
  )
  virtualizer.value.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) =>
    item.end <= (instance.scrollOffset ?? 0) &&
    (instance.scrollDirection !== 'backward' || !instance.itemSizeCache.has(item.key))

  function finishReaderTakeover() {
    if (readerTakeoverFrame !== null) {
      window.cancelAnimationFrame(readerTakeoverFrame)
      readerTakeoverFrame = null
    }
  }
  onScopeDispose(finishReaderTakeover)

  function readScrollMargin() {
    const container = read('scrollRef')
    if (!container || !sizer.value) return
    const offset = nativeChatScrollOffsetWithin(sizer.value, container)
    if (offset !== null) scrollMargin.value = offset
  }
  watchPostEffect(readScrollMargin)
  onUpdated(readScrollMargin)
  watch(
    () => read('scrollRef'),
    (container, _old, onCleanup) => {
      if (!container) return
      readScrollMargin()
      if (typeof ResizeObserver === 'undefined') return
      const observer = new ResizeObserver(readScrollMargin)
      observer.observe(container)
      onCleanup(() => observer.disconnect())
    },
    { immediate: true, flush: 'post' },
  )

  watch(
    itemKeys,
    (keys) => {
      const currentKeys = new Set(keys)
      if (previousMeasurementKeys !== null) {
        for (const key of previousMeasurementKeys) {
          if (!currentKeys.has(key)) retiredMeasurementCount += 1
        }
      }
      previousMeasurementKeys = currentKeys
      if (retiredMeasurementCount < MAX_RETIRED_NATIVE_CHAT_MEASUREMENTS) return
      const instance = virtualizer.value
      const retained = instance
        .takeSnapshot()
        .filter((item) => typeof item.key === 'string' && currentKeys.has(item.key))
      const scrollTop = read('scrollRef')?.scrollTop
      instance.measure()
      instance.getTotalSize()
      for (const item of retained) instance.resizeItem(item.index, item.size)
      if (scrollTop !== undefined) instance.scrollToOffset(scrollTop)
      retiredMeasurementCount = 0
    },
    { immediate: true, flush: 'post' },
  )

  function sizerRef(node) {
    sizer.value = node
    if (node) readScrollMargin()
  }
  function alignToViewportTop(element) {
    const container = read('scrollRef')
    if (!container) return
    const top =
      nativeChatScrollOffsetWithin(element, container) ?? rectOffsetWithin(element, container)
    finishReaderTakeover()
    if (virtualizer.value.scrollElement) {
      virtualizer.value.scrollToOffset(top, { align: 'start', behavior: 'smooth' })
    } else {
      const max = Math.max(0, container.scrollHeight - container.clientHeight)
      const landing = Math.max(0, Math.min(top, max))
      if (container.scrollTop !== landing) marks.mark(landing)
      container.scrollTo({ top, behavior: 'smooth' })
    }
  }
  function scrollToEnd() {
    const container = read('scrollRef')
    if (!read('isVisible') || !container) return
    finishReaderTakeover()
    if (virtualizer.value.scrollElement) {
      virtualizer.value.scrollToEnd({ behavior: 'auto' })
      return
    }
    const previous = container.scrollTop
    container.scrollTop = container.scrollHeight
    if (container.scrollTop !== previous) marks.mark(container.scrollTop)
  }
  function restoreScrollOffset(offset) {
    const container = read('scrollRef')
    if (!read('isVisible') || !container) return
    finishReaderTakeover()
    if (virtualizer.value.scrollElement) {
      virtualizer.value.scrollToOffset(offset, { behavior: 'auto' })
      return
    }
    const previous = container.scrollTop
    container.scrollTop = offset
    if (container.scrollTop !== previous) marks.mark(container.scrollTop)
  }
  function consumeProgrammaticScroll(event) {
    const container = read('scrollRef')
    if (!container) return false
    return marks.consume(
      event,
      container.scrollTop,
      Math.max(0, container.scrollHeight - container.clientHeight),
    )
  }
  function reconcileReaderScroll(isTakingOver) {
    const container = read('scrollRef')
    if (
      !container ||
      !virtualizer.value.scrollElement ||
      (!isTakingOver && readerTakeoverFrame === null)
    )
      return
    virtualizer.value.scrollToOffset(container.scrollTop, { behavior: 'auto' })
    if (readerTakeoverFrame !== null) return
    readerTakeoverFrame = window.requestAnimationFrame(() => {
      readerTakeoverFrame = null
    })
  }
  return {
    virtualItems: computed(() => virtualizer.value.getVirtualItems()),
    totalSize: computed(() => virtualizer.value.getTotalSize()),
    scrollMargin,
    sizerRef,
    measureRow: (node) => virtualizer.value.measureElement(node),
    alignToViewportTop,
    scrollToEnd,
    restoreScrollOffset,
    consumeProgrammaticScroll,
    reconcileReaderScroll,
  }
}
