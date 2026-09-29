// After Orca's use-native-chat-font-scale.ts (MIT, Copyright (c) 2026 Lovecast Inc.)
// enabled and options accept values, refs or getters. Enable only the active pane.
// Optional target scopes Ctrl+wheel; absent target uses window. Storage is best effort.
// Returns fontScale ref and increase/decrease/reset functions; disposed with the scope.
import { ref, toValue, watch, onScopeDispose } from 'vue'
import {
  chatFontScaleActionForEvent,
  clampChatFontScale,
  DEFAULT_CHAT_FONT_SCALE,
  increaseChatFontScale,
  decreaseChatFontScale,
} from '../native-chat-font-scale.js'
import { isMacPlatform } from '../native-chat-shortcut.js'

export const CHAT_FONT_SCALE_STORAGE_KEY = 'tessel.chat.fontScale'
export function useNativeChatFontScale(enabled, options = {}) {
  const get = (key) => toValue(toValue(options)[key])
  const storageKey = get('storageKey') || CHAT_FONT_SCALE_STORAGE_KEY
  const fontScale = ref(DEFAULT_CHAT_FONT_SCALE)
  try {
    const stored = globalThis.localStorage?.getItem(storageKey)
    const value = stored === null ? NaN : Number(stored)
    if (Number.isFinite(value)) fontScale.value = clampChatFontScale(value)
  } catch {
    /* Storage may be unavailable in embedded/private contexts. */
  }
  function set(value) {
    fontScale.value = value
    try {
      globalThis.localStorage?.setItem(storageKey, String(value))
    } catch {
      /* Best effort. */
    }
  }
  const increase = () => set(increaseChatFontScale(fontScale.value))
  const decrease = () => set(decreaseChatFontScale(fontScale.value))
  const reset = () => set(DEFAULT_CHAT_FONT_SCALE)
  function keydown(event) {
    const action = chatFontScaleActionForEvent(event, get('isMac') ?? isMacPlatform())
    if (!action || event.altKey || event.isComposing) return
    event.preventDefault()
    event.stopPropagation()
    if (action === 'increase') increase()
    else if (action === 'decrease') decrease()
    else reset()
  }
  function wheel(event) {
    if (!event.ctrlKey || event.altKey || event.metaKey || !event.deltaY) return
    event.preventDefault()
    event.stopPropagation()
    if (event.deltaY < 0) increase()
    else decrease()
  }
  const stop = watch(
    () => [toValue(enabled), get('target')],
    ([active, target], _, onCleanup) => {
      if (!active || typeof window === 'undefined') return
      const surface = target || window
      window.addEventListener('keydown', keydown, true)
      surface.addEventListener('wheel', wheel, { capture: true, passive: false })
      onCleanup(() => {
        window.removeEventListener('keydown', keydown, true)
        surface.removeEventListener('wheel', wheel, true)
      })
    },
    { immediate: true, flush: 'sync' },
  )
  onScopeDispose(stop)
  return { scale: fontScale, fontScale, increase, decrease, reset }
}
