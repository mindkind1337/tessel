// After Orca's use-native-chat-send-lifecycle.ts (MIT, Copyright (c) 2026 Lovecast Inc.)
// Scope/session inputs accept refs/getters (second positional argument retained).
// Tracks cancellable handles, removing settled handles on resolve OR rejection.
// Scope changes/unmount cancel owned pending work; no terminal dependency.
import { toValue, unref, watch, onScopeDispose } from 'vue'
export function useNativeChatSendLifecycle(terminalTabId, targetSessionId, onPendingSendCanceled) {
  const handles = new Map()
  function cancelPendingSends() {
    const entries = [...handles]
    handles.clear()
    for (const [handle, entry] of entries) {
      clearTimeout(entry.timer)
      try {
        handle.cancel()
      } finally {
        if (entry.pendingId) unref(onPendingSendCanceled)?.(entry.pendingId)
      }
    }
  }
  function trackPendingSend(handle, pendingId) {
    const entry = { pendingId, timer: null }
    if (handles.has(handle)) clearTimeout(handles.get(handle).timer)
    handles.set(handle, entry)
    const settle = () => {
      if (handles.get(handle) === entry) handles.delete(handle)
    }
    if (handle.settled) Promise.resolve(handle.settled).then(settle, settle)
    else entry.timer = setTimeout(settle, handle.settleAfterMs ?? 0)
  }
  watch(() => [toValue(terminalTabId), toValue(targetSessionId)], cancelPendingSends, {
    flush: 'sync',
  })
  onScopeDispose(cancelPendingSends)
  return { cancelPendingSends, trackPendingSend }
}
