// After Orca's use-native-chat-structured-composer-send.ts (MIT, Copyright (c) 2026 Lovecast Inc.)
// Reactive options; send(text, { images }) or structuredTransport.send returns {ok:true}.
// Returns an async function (with isSending ref). Images go as the ids the
// main process gave them (never paths or bytes); a confirmed send clears them.
// Only confirmed sends clear an unchanged draft in the same live scope.
import { ref, onScopeDispose, toValue } from 'vue'
import { t } from '../../../i18n/index.js'
import { pushHistory } from '../native-chat-composer-state.js'
import { composerOptions } from './composer-options.js'
import { useNativeChatSessionOptionCommand } from './use-native-chat-session-option-command.js'
export function useNativeChatStructuredComposerSend(options) {
  const { read, call, fn, scope, blocked } = composerOptions(options)
  const isSending = ref(false)
  let alive = true
  onScopeDispose(() => {
    alive = false
  })
  const error = (value) =>
    (fn('onError') || read('structuredTransport')?.onError || fn('setNotice'))?.(value)
  const optionCommands = useNativeChatSessionOptionCommand(() => ({
    ...toValue(options),
    setOption: fn('setOption') || read('structuredTransport')?.setOption,
    onError: error,
  }))
  async function send(text, attachments = read('imageAttachments', [])) {
    if (!alive || blocked() || isSending.value || (!text.trim() && !attachments.length)) return { ok: false }
    if (attachments.some((item) => item.pending || !item.imageId)) {
      error(t('chat.orca.composer.imageStillSaving', 'An image is still being attached. Send again in a moment.'))
      return { ok: false }
    }
    const imageIds = attachments.map((item) => item.imageId)
    const transport = read('structuredTransport')
    const submit = fn('send') || transport?.send
    const option = imageIds.length ? null : /^\/(model|effort|permissionMode)(?:\s+(.*))?$/i.exec(text.trim())
    if (!submit && !option) return { ok: false }
    const owner = scope(),
      draft = read('draft')
    isSending.value = true
    try {
      let result
      if (option) {
        const optionId =
          option[1].toLowerCase() === 'permissionmode' ? 'permissionMode' : option[1].toLowerCase()
        result = option[2]
          ? await optionCommands.dispatch({ optionId, value: option[2].trim() })
          : await call('onOptionCommand', optionId)
      } else result = imageIds.length ? await submit(text, { images: imageIds }) : await submit(text)
      if (!alive || scope() !== owner) return result || { ok: false }
      if (result?.ok !== true) {
        error(
          result?.error ||
            t('chat.orca.composer.sendRejected', 'The message was not sent. Your draft was kept.'),
        )
        return result || { ok: false }
      }
      error(null)
      if (text.trim()) call('setHistory', (previous) => pushHistory(previous, text))
      call('onAccepted', text)
      // The sent images belong to the message now, whatever was typed since.
      if (imageIds.length) call('clearImageAttachments')
      if (read('draft') === draft) {
        call('setDraft', '')
        call('setCaret', 0)
        call('clearSkillOrigin')
        call('clearImageAttachments')
      }
      return result
    } catch (reason) {
      if (alive && scope() === owner) error(String(reason?.message || reason))
      return { ok: false, error: String(reason?.message || reason) }
    } finally {
      isSending.value = false
    }
  }
  send.isSending = isSending
  return send
}
