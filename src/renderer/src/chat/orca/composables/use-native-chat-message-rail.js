// After Orca's use-native-chat-message-rail.ts (MIT, Copyright (c) 2026 Lovecast Inc.)
// Inputs accept plain values, refs/computed or getters; options may be reactive.
// DOM refs use .value. Callbacks keep their original call signatures.
// Returns a stable object; state fields are refs/computed, actions are functions.
import { computed, ref, toValue, watch } from 'vue'
import { findActiveNativeChatRailItem } from '../native-chat-active-rail-item.js'
import {
  buildNativeChatRailItems,
  mergeNativeChatRailOutline,
  selectNativeChatRailTicks,
  NATIVE_CHAT_RAIL_MIN_ITEMS,
} from '../native-chat-message-rail-items.js'

export const NATIVE_CHAT_RAIL_IDLE_MS = 120
export const NATIVE_CHAT_RAIL_MIN_WIDTH_PX = 512

export function useNativeChatMessageRail(options) {
  const read = (key) => toValue(toValue(options)[key])
  const activeId = ref(null)
  const wideEnough = ref(true)
  let previousItems = []
  const loadedItems = computed(() => {
    previousItems = buildNativeChatRailItems(read('slots'), previousItems)
    return previousItems
  })
  const items = computed(() =>
    mergeNativeChatRailOutline(read('outline') ?? null, loadedItems.value),
  )
  function readActiveId() {
    const element = read('scrollRef')
    if (!element) return
    activeId.value = findActiveNativeChatRailItem({
      slots: read('slots'),
      virtualItems: read('virtualItems'),
      scrollTop: element.scrollTop,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      previousActiveId: activeId.value,
    })
  }
  // Subscribe by element only; streaming arrays must not restart the idle timer.
  watch(
    () => read('scrollRef'),
    (element, _old, onCleanup) => {
      if (!element) return
      let timer = null
      const schedule = () => {
        if (timer !== null) window.clearTimeout(timer)
        timer = window.setTimeout(() => {
          timer = null
          readActiveId()
        }, NATIVE_CHAT_RAIL_IDLE_MS)
      }
      schedule()
      element.addEventListener('scroll', schedule, { passive: true })
      onCleanup(() => {
        element.removeEventListener('scroll', schedule)
        if (timer !== null) window.clearTimeout(timer)
      })
    },
    { immediate: true, flush: 'post' },
  )
  watch(items, readActiveId, { immediate: true, flush: 'post' })
  watch(
    () => read('scrollRef'),
    (element, _old, onCleanup) => {
      if (!element || typeof ResizeObserver === 'undefined') return
      const observer = new ResizeObserver(() => {
        wideEnough.value = element.clientWidth >= NATIVE_CHAT_RAIL_MIN_WIDTH_PX
      })
      observer.observe(element)
      onCleanup(() => observer.disconnect())
    },
    { immediate: true, flush: 'post' },
  )
  return {
    ticks: computed(() =>
      selectNativeChatRailTicks({ items: items.value, activeId: activeId.value }),
    ),
    items,
    activeId,
    visible: computed(() => wideEnough.value && items.value.length >= NATIVE_CHAT_RAIL_MIN_ITEMS),
  }
}
