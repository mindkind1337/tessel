// After Orca's lib/ime-composition-keyboard-event.ts (MIT, Copyright (c) 2026 Lovecast Inc.)
// The composer's IME helpers, without React: useImeEnterGestureOwnership() is a
// plain factory (one per composer field) and reads native DOM events (the
// reference's nativeEvent falls back to the event itself).

/** True when the IME, rather than Tessel, owns a keyboard event. */
export function isImeOwnedKeyboardEvent(event) {
  return (
    event.isComposing === true ||
    event.keyCode === 229 ||
    event.nativeEvent?.isComposing === true ||
    event.nativeEvent?.keyCode === 229
  )
}

export function resolveImeModifierGesture(active, event) {
  const hasModifier = Boolean(event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
  const marked = isImeOwnedKeyboardEvent(event)
  const owned = active || (hasModifier && marked)
  return { active: owned && hasModifier, carried: active && !marked, owned }
}

/**
 * Why: the confirming Enter of a CJK composition arrives as two keydowns, and the
 * two orderings differ by platform. Windows/Linux redispatch the unmarked
 * `Enter`/13 *before* keyup; macOS delivers keyup first and redispatches after.
 * A token that expires synchronously on keyup therefore regresses macOS, so the
 * carry survives until the next animation frame. Identity-scoped so an older
 * gesture's expiry cannot clear a newer one.
 */
export function useImeEnterGestureOwnership() {
  let state = { composing: false, pendingEnter: null }
  const native = (event) => event.nativeEvent ?? event
  const reset = () => {
    state = { composing: false, pendingEnter: null }
  }
  // Shift+Enter is a newline, never a submit — it must never be owned or swallowed.
  const isPlainEnter = (event) => event.key === 'Enter' && event.keyCode === 13 && !event.shiftKey
  // The redispatched Enter of a confirm carries no modifiers, so a chorded one is the
  // user's own submit aimed past the IME. It must still ARM, and must never be swallowed.
  const hasChordModifier = (event) => Boolean(event.altKey || event.ctrlKey || event.metaKey)
  return {
    isComposing: () => state.composing,
    ownsKeyDown: (event) => {
      const markedEnter =
        (native(event).isComposing || state.composing) &&
        (isPlainEnter(event) ||
          (event.key === 'Enter' && event.keyCode === 229) ||
          (event.key === 'Process' && event.keyCode === 229))
      if (markedEnter) {
        state.pendingEnter = {}
        return true
      }
      if (state.pendingEnter && isPlainEnter(event) && !native(event).isComposing) {
        // The gesture resolves either way, so the carry is spent either way; only a bare
        // Enter is also swallowed, because a chorded one is the user's own submit.
        state.pendingEnter = null
        if (hasChordModifier(event)) return false
        event.preventDefault()
        return true
      }
      return false
    },
    onKeyUp: (event) => {
      // A Process/229 keyup means the IME finished without redispatching, so the
      // gesture is over immediately.
      if (event.key === 'Process' && event.keyCode === 229) {
        state.pendingEnter = null
        return
      }
      // Every other keyup expires on the NEXT FRAME, never synchronously (macOS delivers
      // Enter's keyup before the unmarked redispatch; Pinyin reports Process/229 on
      // every key, so a Process-only clear would eat the user's next real Enter).
      const pendingEnter = state.pendingEnter
      if (pendingEnter) {
        requestAnimationFrame(() => {
          if (state.pendingEnter === pendingEnter) state.pendingEnter = null
        })
      }
    },
    reset,
    setComposing: (active) => {
      state.composing = active
    }
  }
}

/** A keydown that only confirms a conversion candidate (CJK IMEs). */
export function isImeCompositionKeyDown(event) {
  return isImeOwnedKeyboardEvent(event)
}
