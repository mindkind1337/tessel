// After Orca's use-native-chat-older-history-autoload.ts (MIT, Copyright (c) 2026 Lovecast Inc.)
// Inputs accept plain values, refs/computed or getters; options may be reactive.
// DOM refs use .value. Callbacks keep their original call signatures.
// Returns a stable object; state fields are refs/computed, actions are functions.
import { computed, onScopeDispose, ref, shallowRef, toValue, unref, watch } from 'vue'

export const NATIVE_CHAT_OLDER_HISTORY_PREFETCH_PX = 600

export function useNativeChatOlderHistoryAutoload(options) {
  const read = (key) => toValue(toValue(options)[key])
  const sentinel = shallowRef(null)
  const failedHistoryKey = ref(null)
  let disposed = false
  onScopeDispose(() => {
    disposed = true
  })
  const canObserve = typeof IntersectionObserver !== 'undefined'
  const isAutoLoadEnabled = computed(
    () => canObserve && failedHistoryKey.value !== read('historyKey'),
  )
  const shouldObserve = computed(
    () =>
      isAutoLoadEnabled.value && read('isVisible') && read('hasMore') && !read('loadingEarlier'),
  )
  function loadPage() {
    const historyKey = read('historyKey')
    const fail = () => {
      if (!disposed) failedHistoryKey.value = historyKey
    }
    try {
      void Promise.resolve(unref(toValue(options).loadEarlier)()).then((result) => {
        if (result === 'failed' || result === 'unchanged') fail()
      }, fail)
    } catch {
      fail()
    }
  }
  function loadEarlierManually() {
    failedHistoryKey.value = null
    loadPage()
  }
  watch(
    [() => read('scrollRef'), sentinel, shouldObserve, () => read('historyKey')],
    ([root, node, enabled], _old, onCleanup) => {
      if (!enabled || !node || !root) return
      const observer = new IntersectionObserver(
        (entries) => {
          if (entries.at(-1)?.isIntersecting) loadPage()
        },
        { root, rootMargin: `${NATIVE_CHAT_OLDER_HISTORY_PREFETCH_PX}px 0px 0px 0px` },
      ) // i18n-ignore
      observer.observe(node)
      onCleanup(() => observer.disconnect())
    },
    { immediate: true, flush: 'post' },
  )
  return {
    sentinelRef: (node) => {
      sentinel.value = node
    },
    isAutoLoadEnabled,
    loadEarlierManually,
  }
}
