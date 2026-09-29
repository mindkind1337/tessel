// After Orca's use-native-chat-draft.ts (MIT, Copyright (c) 2026 Lovecast Inc.)
// scopeKey accepts a value/ref/getter; draft is a ref.
// setDraft accepts a string or updater and persists synchronously by scope.
// Scope changes restore cached text before rendering.
import { ref, toValue, watch } from 'vue'
import { readNativeChatDraftCache, writeNativeChatDraftCache } from '../native-chat-draft-cache.js'
export function useNativeChatDraft(scopeKey) {
  const draft = ref('')
  watch(
    () => toValue(scopeKey),
    (key) => {
      draft.value = readNativeChatDraftCache(key)
    },
    { immediate: true, flush: 'sync' },
  )
  function setDraft(next) {
    draft.value = typeof next === 'function' ? next(draft.value) : next
    writeNativeChatDraftCache(toValue(scopeKey), draft.value)
  }
  return { draft, setDraft }
}
