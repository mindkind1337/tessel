// After Orca's use-native-chat-rail-history-jump.ts (MIT, Copyright (c) 2026 Lovecast Inc.)
// Inputs accept plain values, refs/computed or getters; options may be reactive.
// DOM refs use .value. Callbacks keep their original call signatures.
// Returns a stable object; state fields are refs/computed, actions are functions.
import { nextTick, onScopeDispose, ref, toValue, unref, watch } from 'vue'

export const NATIVE_CHAT_RAIL_JUMP_MAX_PAGES = 1000

export function useNativeChatRailHistoryJump(options) {
  const read = (key) => toValue(toValue(options)[key])
  const call = (key, ...args) => unref(toValue(options)[key])(...args)
  const pendingId = ref(null)
  let controller = null
  let disposed = false
  async function run(id, signal) {
    for (let pages = 0; ; pages += 1) {
      if (signal.aborted) return
      const target = read('items').find((item) => item.id === id)
      if (!target) return
      if (target.slotIndex !== null) {
        call('jumpToLoaded', target)
        return
      }
      if (pages >= NATIVE_CHAT_RAIL_JUMP_MAX_PAGES) return
      const result = await call('loadEarlier')
      if (signal.aborted || result !== 'applied') return
      // Vue flushes the page's computed rail and DOM before this continuation.
      await nextTick()
      if (signal.aborted) return
    }
  }
  function abort() {
    if (!controller) return
    const previous = controller
    controller = null
    previous.abort()
    pendingId.value = null
  }
  function start(item) {
    if (disposed) return
    controller?.abort()
    const next = new AbortController()
    controller = next
    pendingId.value = item.id
    void run(item.id, next.signal)
      .catch(() => undefined)
      .finally(() => {
        if (controller === next) {
          controller = null
          pendingId.value = null
        }
      })
  }
  watch(() => read('sessionKey'), abort, { flush: 'sync' })
  onScopeDispose(() => {
    disposed = true
    abort()
  })
  return { pendingId, start, abort }
}
