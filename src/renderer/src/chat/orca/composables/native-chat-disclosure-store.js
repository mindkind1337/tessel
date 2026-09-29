// After Orca's components/native-chat/native-chat-disclosure-store.ts (MIT, Copyright (c) 2026 Lovecast Inc.)
//
// Where a transcript row's open/closed disclosures live when the row itself may
// be unmounted.
//
// A tool run the reader opened is state they created. Held in the run's own
// local state it survives exactly as long as the row is mounted, which under
// windowing is "until you scroll past it" — the run silently re-collapses behind
// the reader's back. Rows read through this store when the transcript provides
// one, and fall back to their own state when they are rendered standalone.
//
// Vue API:
//   const store = provideNativeChatDisclosures()   // in the transcript (list)
//   const { open, setOpen } = useNativeChatDisclosure(() => props.disclosureKey, false)  // in a row
//   open is a writable computed (v-model friendly); setOpen(next) is the same write.
import { computed, inject, provide, shallowRef, toValue } from 'vue'

/** The injection key (the reference's NativeChatDisclosureContext). */
export const NativeChatDisclosureContext = Symbol('NativeChatDisclosureContext')

/** Bounded like the transcript's other per-turn map: a session that ran for a day
 *  should not carry every disclosure it ever opened. */
export const MAX_NATIVE_CHAT_DISCLOSURES = 512

/**
 * The store: { read(key) → boolean | undefined, write(key, open) }. read() is
 * reactive (a computed or template reading it updates on write).
 */
export function useNativeChatDisclosures() {
  const open = shallowRef(new Map())
  function write(key, next) {
    const current = open.value
    if (current.get(key) === next) return
    const updated = new Map(current)
    updated.set(key, next)
    if (updated.size > MAX_NATIVE_CHAT_DISCLOSURES) {
      const oldest = updated.keys().next().value
      if (oldest !== undefined && oldest !== key) updated.delete(oldest)
    }
    open.value = updated
  }
  return { read: (key) => open.value.get(key), write }
}

/** Creates a store (or takes one) and provides it to the rows below. */
export function provideNativeChatDisclosures(store = useNativeChatDisclosures()) {
  provide(NativeChatDisclosureContext, store)
  return store
}

/**
 * One row's disclosure. `key` and `initialOpen` may be values, refs or
 * getters (props). Keyed and under a store: remembered past the row's
 * lifetime; otherwise local, and reset when the key or initialOpen changes.
 * Returns { open (writable computed), setOpen(next) }.
 */
export function useNativeChatDisclosure(key, initialOpen) {
  const store = inject(NativeChatDisclosureContext, null)
  const local = shallowRef({ key: toValue(key), initialOpen: toValue(initialOpen), open: toValue(initialOpen) })

  function setOpen(next) {
    const currentKey = toValue(key)
    local.value = { key: currentKey, initialOpen: toValue(initialOpen), open: next }
    if (currentKey !== undefined && store) store.write(currentKey, next)
  }

  const open = computed({
    get() {
      const currentKey = toValue(key)
      const currentInitial = toValue(initialOpen)
      const state = local.value
      const localOpen = state.key === currentKey && state.initialOpen === currentInitial ? state.open : currentInitial
      const isStored = currentKey !== undefined && store !== null
      return isStored ? (store.read(currentKey) ?? localOpen) : localOpen
    },
    set: setOpen
  })

  return { open, setOpen }
}
