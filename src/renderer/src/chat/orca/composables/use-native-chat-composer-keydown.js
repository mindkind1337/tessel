// After Orca's use-native-chat-composer-keydown.ts (MIT, Copyright (c) 2026 Lovecast Inc.)
// Options/data accept values, refs or getters; callback setters accept updaters.
// Returns a native DOM key handler. isWorking gates Escape interruption.
// menuOpen/closeMenu precede autocomplete and interrupt; IME never submits.
import { recallNext, recallPrevious } from '../native-chat-composer-state.js'
import { composerOptions } from './composer-options.js'
export function useNativeChatComposerKeyDown(options) {
  const { read, call, blocked } = composerOptions(options)
  return (event) => {
    if (
      call('isComposing') ||
      event.isComposing ||
      event.nativeEvent?.isComposing ||
      event.keyCode === 229
    )
      return
    if (event.defaultPrevented) return
    if (event.key === 'Escape' && read('menuOpen')) {
      event.preventDefault()
      event.stopPropagation()
      call('closeMenu')
      return
    }
    if (read('disabled') || read('disabledReason')) return
    const autocomplete = read('autocomplete', { mode: 'none' })
    const modified = event.shiftKey || event.ctrlKey || event.altKey || event.metaKey
    if (autocomplete.mode === 'slash') {
      const items = autocomplete.items || []
      if (['ArrowDown', 'ArrowUp'].includes(event.key) && items.length && !modified) {
        event.preventDefault()
        call(
          'setActiveSuggestion',
          (index) => (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length,
        )
        return
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && !modified && items.length) {
        event.preventDefault()
        const item = items[read('activeSuggestion', 0)] || items[0]
        if (event.key === 'Enter' && item.kind === 'command' && autocomplete.dispatchable) {
          if (!blocked()) call('dispatchPickerCommand', item)
        } else call('completePickerItem', item)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        call('dismissPicker', autocomplete.triggerKey)
        return
      }
    }
    if (event.key === 'Escape' && read('isWorking', read('busy', false))) {
      event.preventDefault()
      event.stopPropagation()
      call('interrupt')
      return
    }
    if (event.key === 'Enter' && !modified) {
      event.preventDefault()
      if (!blocked()) call('send')
      return
    }
    const history = read('history', { entries: [], index: null })
    let recall
    if (event.key === 'ArrowUp' && (read('draft', '') === '' || history.index !== null))
      recall = recallPrevious(history)
    if (event.key === 'ArrowDown' && history.index !== null) recall = recallNext(history)
    if (recall?.draft != null) {
      event.preventDefault()
      call('setHistory', recall.history)
      call('setDraft', recall.draft)
      call('setCaret', recall.draft.length)
    }
  }
}
