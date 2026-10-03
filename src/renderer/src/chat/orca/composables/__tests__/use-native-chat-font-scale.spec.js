// After Orca's use-native-chat-font-scale.ts (MIT, Copyright (c) 2026 Lovecast Inc.)
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { renderHook } from './withSetup.js'
import {
  useNativeChatFontScale,
  CHAT_FONT_SCALE_STORAGE_KEY,
} from '../use-native-chat-font-scale.js'

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})
const key = (value, extra = {}) =>
  new KeyboardEvent('keydown', { key: value, ctrlKey: true, cancelable: true, ...extra })
describe('useNativeChatFontScale', () => {
  it('uses reference shortcuts, bounds zoom, and persists', () => {
    const { result } = renderHook(() => useNativeChatFontScale(true, { isMac: false }))
    const event = key('+')
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(result.current.fontScale).toBe(1.1)
    for (let i = 0; i < 20; i++) result.current.increase()
    expect(result.current.fontScale).toBe(1.6)
    for (let i = 0; i < 20; i++) result.current.decrease()
    expect(result.current.fontScale).toBe(0.8)
    window.dispatchEvent(key('0'))
    expect(result.current.fontScale).toBe(1)
    expect(localStorage.getItem(CHAT_FONT_SCALE_STORAGE_KEY)).toBe('1')
  })
  // Typed in a dialog or the palette over the app: not the chat's zoom.
  it('a key typed in a dialog or a field outside the chat does not zoom it', () => {
    const target = document.createElement('div')
    document.body.append(target)
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    const field = document.createElement('input')
    dialog.append(field)
    const outside = document.createElement('textarea')
    document.body.append(dialog, outside)
    try {
      const { result } = renderHook(() => useNativeChatFontScale(true, { target, isMac: false }))
      for (const el of [field, outside]) {
        const ev = key('+', { bubbles: true })
        el.dispatchEvent(ev)
        expect(ev.defaultPrevented).toBe(false)
      }
      expect(result.current.fontScale).toBe(1)
      // In the chat, or with nothing focused: it zooms.
      const inChat = document.createElement('div')
      target.append(inChat)
      inChat.dispatchEvent(key('+', { bubbles: true }))
      document.body.dispatchEvent(key('+', { bubbles: true }))
      expect(result.current.fontScale).toBe(1.2)
    } finally {
      target.remove()
      dialog.remove()
      outside.remove()
    }
  })
  it('scopes wheel to the pane and removes listeners on disable and unmount', () => {
    const target = document.createElement('div'),
      enabled = ref(true)
    const { result, unmount } = renderHook(() =>
      useNativeChatFontScale(enabled, { target, isMac: false }),
    )
    target.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -1, cancelable: true }))
    expect(result.current.fontScale).toBe(1.1)
    enabled.value = false
    const disabledKey = key('+')
    window.dispatchEvent(disabledKey)
    expect(disabledKey.defaultPrevented).toBe(false)
    enabled.value = true
    unmount()
    window.dispatchEvent(key('+'))
    target.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -1 }))
    expect(result.current.fontScale).toBe(1.1)
  })
  it('ignores composing and unrelated modifiers and handles macOS', () => {
    const { result } = renderHook(() => useNativeChatFontScale(true, { isMac: true }))
    window.dispatchEvent(key('+'))
    window.dispatchEvent(key('+', { metaKey: true, ctrlKey: false, isComposing: true }))
    expect(result.current.fontScale).toBe(1)
    window.dispatchEvent(key('+', { metaKey: true, ctrlKey: false }))
    expect(result.current.fontScale).toBe(1.1)
  })
  it('survives inaccessible storage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    const { result } = renderHook(() => useNativeChatFontScale(false))
    expect(result.current.fontScale).toBe(1)
    expect(() => result.current.increase()).not.toThrow()
    expect(result.current.fontScale).toBe(1.1)
  })
})
