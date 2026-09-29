// Shared Vue accessors for the native chat composer adapters.
import { toValue, unref, watch } from 'vue'
export function composerOptions(options) {
  const read = (key, fallback) => toValue(toValue(options)?.[key]) ?? fallback
  const fn = (key) => unref(toValue(options)?.[key])
  const call = (key, ...args) => fn(key)?.(...args)
  const blocked = () => !!(read('disabled') || read('disabledReason') || read('sendBlockedReason'))
  const rawScope = () =>
    JSON.stringify([
      read('scopeKey'),
      read('draftScopeKey'),
      read('attachmentScopeKey'),
      read('terminalTabId'),
      read('sessionId'),
      toValue(read('structuredTransport')?.sessionId),
    ])
  let epoch = 0
  watch(
    rawScope,
    () => {
      epoch++
    },
    { flush: 'sync' },
  )
  const scope = () => rawScope() + ':' + epoch
  return { read, fn, call, blocked, scope }
}
