// After Orca's use-native-chat-can-send.ts (MIT, Copyright (c) 2026 Lovecast Inc.)
// Tessel accepts an options value/ref/getter, replacing the reference PTY id.
// disabledReason disables input; sendBlockedReason blocks only submission.
// Returns computed eligibility; no mobile lock or PTY dependency.
import { computed } from 'vue'
import { composerOptions } from './composer-options.js'
export function useNativeChatCanSend(options = {}) {
  const { read, blocked } = composerOptions(options)
  // Tessel: attached images alone can be sent.
  return computed(
    () =>
      !blocked() &&
      !read('isSending') &&
      (String(read('draft', '')).trim().length > 0 || read('hasImages', false) === true),
  )
}
