// After Orca's use-native-chat-transcript-lifecycle.ts (MIT, Copyright (c) 2026 Lovecast Inc.)
// Inputs accept plain values, refs/computed or getters; options may be reactive.
// DOM refs use .value. Callbacks keep their original call signatures.
// Returns [lifecycle shallowRef, control]; control methods keep their names.
import { shallowRef } from 'vue'

export function useNativeChatTranscriptLifecycle() {
  const lifecycle = shallowRef()
  let revisionCount = 0
  const replace = (next) => {
    revisionCount += 1
    lifecycle.value = next
  }
  const reset = () => replace(undefined)
  const append = (next) => {
    if (next) replace(next)
  }
  const revision = () => revisionCount
  const replaceFromPagination = (next, expectedRevision) => {
    if (next && revisionCount === expectedRevision) replace(next)
  }
  return [lifecycle, { reset, replace, append, revision, replaceFromPagination }]
}
