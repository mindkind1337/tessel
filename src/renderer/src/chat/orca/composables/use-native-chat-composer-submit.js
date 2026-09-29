// After Orca's use-native-chat-composer-submit.ts (MIT, Copyright (c) 2026 Lovecast Inc.)
// Reactive options, callback setters. Returns send and goalMode with active computed.
// Goal mode exists only with an explicit threadGoal controller; no PTY fallback.
// sendStructured owns confirmed clearing; goal clearing also requires ok:true.
import { computed, ref, onScopeDispose, watch } from 'vue'
import { applyPickerSuggestion, pushHistory } from '../native-chat-composer-state.js'
import { composerOptions } from './composer-options.js'
import { t } from '../../../i18n/index.js'
export function useNativeChatComposerSubmit(options) {
  const { read, call, blocked, scope } = composerOptions(options)
  const entered = ref(false),
    pending = ref(false)
  watch(
    scope,
    () => {
      entered.value = false
    },
    { flush: 'sync' },
  )
  let alive = true
  onScopeDispose(() => {
    alive = false
  })
  const goal = () => read('structuredTransport')?.threadGoal
  const active = computed(() => entered.value && !!goal())
  function interceptPick(pick) {
    return (item) => {
      if (!goal() || item.kind !== 'command' || item.name !== 'goal') return pick(item)
      const inserted = applyPickerSuggestion(read('draft', ''), read('caret', 0), item)
      const start = inserted.caret - item.token.length - 1
      call('setDraft', inserted.draft.slice(0, start) + inserted.draft.slice(inserted.caret))
      call('setCaret', start)
      entered.value = true
    }
  }
  async function send() {
    if (!alive || blocked() || pending.value || call('isComposing')) return { ok: false }
    const draft = read('draft', ''),
      attachments = read('imageAttachments', [])
    if (attachments.length) {
      read('structuredTransport')?.onError?.(
        t('chat.orca.composer.textOnly', 'This chat accepts text only.'),
      )
      return { ok: false }
    }
    if (goal() && /^\/goal\s*$/i.test(draft)) {
      call('setDraft', '')
      call('setCaret', 0)
      entered.value = true
      return { ok: false }
    }
    if (!active.value) return draft.trim() ? call('sendStructured', draft, []) : { ok: false }
    const objective = draft.replace(/^\/goal\s+/i, '').trim(),
      owner = scope()
    if (!objective) return { ok: false }
    pending.value = true
    try {
      const result = await goal().setObjective(objective)
      if (!alive || scope() !== owner) return result
      if (result?.ok !== true) {
        read('structuredTransport')?.onError?.(
          result?.error ||
            t('chat.orca.composer.sendRejected', 'The message was not sent. Your draft was kept.'),
        )
        return result || { ok: false }
      }
      call('setHistory', (previous) => pushHistory(previous, draft))
      if (read('draft') === draft) {
        call('setDraft', '')
        call('setCaret', 0)
        entered.value = false
      }
      return result
    } catch (error) {
      if (alive && scope() === owner)
        read('structuredTransport')?.onError?.(String(error?.message || error))
      return { ok: false }
    } finally {
      pending.value = false
    }
  }
  return {
    send,
    goalMode: {
      active,
      exit: () => {
        entered.value = false
      },
      interceptPick,
    },
  }
}
