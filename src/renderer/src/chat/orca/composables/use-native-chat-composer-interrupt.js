// After Orca's use-native-chat-composer-interrupt.ts (MIT, Copyright (c) 2026 Lovecast Inc.)
// Reactive options; returns a stable callback. onStop interrupts the current turn.
// Idle and open menus cannot interrupt. Queued messages remain queued in Tessel.
// No PTY writes and no cancelPendingSends call on a turn interruption.
import { composerOptions } from './composer-options.js'
export function useNativeChatComposerInterrupt(options) {
  const { read, call } = composerOptions(options)
  return () => {
    if (!read('isWorking') || read('menuOpen') || read('autocomplete')?.mode === 'slash')
      return false
    return call('onStop')
  }
}
