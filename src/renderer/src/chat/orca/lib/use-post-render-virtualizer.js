// useVirtualizer for the transcript window, in React's order. Tessel's own
// (the transcript window after Orca's use-native-chat-transcript-window.ts,
// MIT, Copyright (c) 2026 Lovecast Inc., relies on that order).
import { computed, onScopeDispose, shallowRef, triggerRef, unref, watch } from 'vue'
import { elementScroll, observeElementOffset, observeElementRect, Virtualizer } from '@tanstack/vue-virtual'

// vue-virtual's useVirtualizer applies setOptions and _willUpdate in one
// watcher before the render, so an older page's anchoring write lands before
// the list grows and the browser clamps it. React sets the options during the
// render and runs _willUpdate in a layout effect, after the commit: the same
// order here (options before the render, _willUpdate after it).
export function useVirtualizer(options) {
  const resolved = computed(() => ({ observeElementRect, observeElementOffset, scrollToFn: elementScroll, ...unref(options) }))
  const virtualizer = new Virtualizer(resolved.value)
  const state = shallowRef(virtualizer)
  const cleanup = virtualizer._didMount()
  watch(
    () => resolved.value.getScrollElement(),
    (el) => {
      if (el) virtualizer._willUpdate()
    },
    { immediate: true, flush: 'post' },
  )
  watch(
    resolved,
    (next) => {
      virtualizer.setOptions({
        ...next,
        onChange: (instance, sync) => {
          triggerRef(state)
          next.onChange?.(instance, sync)
        },
      })
      triggerRef(state)
    },
    { immediate: true },
  )
  watch(resolved, () => virtualizer._willUpdate(), { immediate: true, flush: 'post' })
  onScopeDispose(cleanup)
  return state
}
