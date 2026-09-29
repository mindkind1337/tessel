// After Orca's use-native-chat-transcript-scroll.ts (MIT, Copyright (c) 2026 Lovecast Inc.)
// Inputs accept plain values, refs/computed or getters; options may be reactive.
// DOM refs use .value. Callbacks keep their original call signatures.
// Returns a stable object; state fields are refs/computed, actions are functions.
import { ref, toValue, unref, watch } from 'vue'
import {
  distanceFromBottom,
  nextFollowingEnd,
  shouldShowJumpToLatest,
} from '../native-chat-autoscroll.js'

const hasMeasurableViewport = (element) => element != null && element.clientHeight > 0
const geometryOf = (element) => ({
  scrollTop: element.scrollTop,
  scrollHeight: element.scrollHeight,
  clientHeight: element.clientHeight,
})

export function useNativeChatTranscriptScroll(options) {
  const read = (key) => toValue(toValue(options)[key])
  const call = (key, ...args) => unref(toValue(options)[key])(...args)
  const showJump = ref(false)
  let following = true
  let detachedScrollTop = null
  let previousIsVisible = read('isVisible')
  let previousDistanceFromEnd = Number.POSITIVE_INFINITY
  function syncScrollState(event) {
    const element = read('scrollRef')
    if (!read('isVisible') || !hasMeasurableViewport(element)) return null
    const geometry = geometryOf(element)
    if (event) {
      const wasFollowing = following
      const programmatic = call('consumeProgrammaticScroll', event)
      following = nextFollowingEnd({ following, programmatic, geometry, previousDistanceFromEnd })
      if (!programmatic) call('reconcileReaderScroll', wasFollowing && !following)
    }
    detachedScrollTop = following ? null : geometry.scrollTop
    showJump.value = shouldShowJumpToLatest(following, geometry)
    return geometry
  }
  function onScroll(event) {
    const geometry = syncScrollState(event)
    if (geometry) previousDistanceFromEnd = distanceFromBottom(geometry)
  }
  function scrollToEndWhenMeasurable() {
    if (hasMeasurableViewport(read('scrollRef'))) call('scrollToEnd')
  }
  function scrollToBottom() {
    following = true
    scrollToEndWhenMeasurable()
    showJump.value = false
  }
  function scrollMessageToTop(element) {
    following = false
    call('alignToViewportTop', element)
  }
  watch(
    [
      () => read('isVisible'),
      () => read('itemCount'),
      () => read('isWorking'),
      () => read('showTypingIndicator'),
      () => read('scrollRef'),
    ],
    () => {
      const visible = read('isVisible')
      const revealed = visible && !previousIsVisible
      previousIsVisible = visible
      if (!visible) return
      if (!following) {
        if (revealed && detachedScrollTop !== null) call('restoreScrollOffset', detachedScrollTop)
        return
      }
      scrollToEndWhenMeasurable()
    },
    { immediate: true, flush: 'post' },
  )
  watch(
    [() => read('scrollRef'), () => read('contentRef')],
    ([element, content], _old, onCleanup) => {
      if (!element || typeof ResizeObserver === 'undefined') return
      const observer = new ResizeObserver(() => {
        if (following) scrollToEndWhenMeasurable()
        else syncScrollState()
      })
      observer.observe(element)
      if (content) observer.observe(content)
      onCleanup(() => observer.disconnect())
    },
    { immediate: true, flush: 'post' },
  )
  return { showJump, onScroll, scrollToBottom, scrollMessageToTop }
}
