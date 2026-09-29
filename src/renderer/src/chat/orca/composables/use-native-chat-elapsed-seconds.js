// After Orca's use-native-chat-elapsed-seconds.ts (MIT, Copyright (c) 2026 Lovecast Inc.)
// Inputs accept plain values, refs/computed or getters; options may be reactive.
// DOM refs use .value. Callbacks keep their original call signatures.
// Returns a ref/computed value; read it with .value outside templates.
import { computed, toValue } from 'vue'
import { useNow } from './use-now.js'
import { nativeChatElapsedSeconds } from '../shared/native-chat-turn-status.js'

export function useNativeChatElapsedSeconds(startedAt, counting) {
  const now = useNow(1000, counting)
  const mountedAt = Date.now()
  return computed(() =>
    toValue(counting) ? nativeChatElapsedSeconds(toValue(startedAt), mountedAt, now.value) : 0,
  )
}
