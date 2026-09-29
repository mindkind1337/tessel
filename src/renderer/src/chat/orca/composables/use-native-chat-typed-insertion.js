// After Orca's use-native-chat-typed-insertion.ts (MIT, Copyright (c) 2026 Lovecast Inc.)
// Reactive options and textareaRef use Vue refs. Setters keep reference signatures.
// Returns insertTypedText(text):boolean and focus():boolean.
// Deferred caret restoration is canceled when scope/input changes or unmounts.
import { nextTick, onScopeDispose } from 'vue'
import { composerOptions } from './composer-options.js'
export function useNativeChatTypedInsertion(options) {
  const { read, call, scope } = composerOptions(options)
  let alive = true,
    generation = 0
  onScopeDispose(() => {
    alive = false
  })
  function focus() {
    const input = read('textareaRef')
    if (!alive || !input || input.disabled || read('disabled') || read('disabledReason'))
      return false
    input.focus()
    return true
  }
  function insertTypedText(text) {
    const input = read('textareaRef')
    if (!focus()) return false
    const from = input.selectionStart ?? read('caret', 0),
      to = input.selectionEnd ?? from
    const draft = read('draft', '')
    const next = draft.slice(0, from) + text + draft.slice(to),
      caret = from + text.length
    const owner = scope(),
      ticket = ++generation
    call('setDraft', next)
    call('setCaret', caret)
    call('setHistory', (previous) => ({ entries: previous.entries, index: null }))
    call('setActiveSuggestion', 0)
    nextTick(() => {
      if (
        alive &&
        ticket === generation &&
        scope() === owner &&
        read('textareaRef') === input &&
        read('draft') === next
      )
        input.setSelectionRange?.(caret, caret)
    })
    return true
  }
  return { insertTypedText, focus }
}
