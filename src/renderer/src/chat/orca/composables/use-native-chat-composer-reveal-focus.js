// After Orca's use-native-chat-composer-reveal-focus.ts (MIT, Copyright (c) 2026 Lovecast Inc.)
// Reactive options and DOM refs; only the visible focused group claims focus.
// Existing editable focus and explicit pointer/Tab navigation always win.
// No return value; all listeners and queued attempts are disposed on scope change.
import { watch } from 'vue'
import { composerOptions } from './composer-options.js'
export function useNativeChatComposerRevealFocus(options) {
  const { read, fn } = composerOptions(options)
  watch(
    () => [
      read('isVisible'),
      read('isFocusedGroup'),
      read('composerReady'),
      read('rootRef'),
      read('composerRef'),
    ],
    ([visible, focused, ready, root, composer], _, cleanup) => {
      if (!visible || !focused || !ready || !root || !composer) return
      let canceled = false,
        interacted = false,
        attempts = 0
      const doc = read('rootRef')?.ownerDocument
      const pointer = () => {
        interacted = true
      }
      const key = (event) => {
        // Tab moves the focus; Escape closes a menu that gives it back (Tessel).
        if (event.key === 'Tab' || event.key === 'Escape') interacted = true
      }
      const stop = () => {
        doc?.removeEventListener('pointerdown', pointer, true)
        doc?.removeEventListener('keydown', key, true)
      }
      doc?.addEventListener('pointerdown', pointer, true)
      doc?.addEventListener('keydown', key, true)
      cleanup(() => {
        canceled = true
        stop()
      })
      const schedule = fn('scheduleFrame') || requestAnimationFrame
      function claim() {
        if (canceled) return
        const active = doc?.activeElement
        if (
          interacted ||
          read('rootRef')?.contains(active) ||
          active?.matches?.('input,textarea,select,[contenteditable="true"],[role="textbox"]') ||
          // Tessel: never taken from an open menu, list or dialog (the … menu).
          active?.closest?.('[role="menu"],[role="listbox"],[role="dialog"]')
        ) {
          stop()
          return
        }
        read('composerRef')?.focus()
        if (++attempts < 6) schedule(claim)
        else stop()
      }
      schedule(claim)
    },
    { immediate: true, flush: 'post' },
  )
}
