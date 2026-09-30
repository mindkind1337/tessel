// After Orca's use-native-chat-composer-paste.ts (MIT, Copyright (c) 2026 Lovecast Inc.)
// Reactive options; insertTypedText receives plain text, never HTML. A pasted
// image goes to attachImages([{ file }]) when allowImages.
// readClipboardText() callback defaults to Tessel shellApi.readClipboard.
// Disabled/scope changes invalidate asynchronous menu pastes.
import { onScopeDispose } from 'vue'
import { t } from '../../../i18n/index.js'
import { composerOptions } from './composer-options.js'
export function useNativeChatComposerPaste(options) {
  const { read, call, fn, scope } = composerOptions(options)
  let alive = true
  onScopeDispose(() => {
    alive = false
  })
  const disabled = () => !alive || read('disabled') || read('disabledReason')
  function insert(text) {
    if (disabled() || !text) return false
    return call('insertTypedText', String(text))
  }
  function handlePaste(event) {
    if (event.defaultPrevented) return
    event.preventDefault()
    if (disabled()) return
    // An image on the clipboard wins over its text (as the reference): with
    // images allowed it becomes a chip, "image.png", "image-2.png"…
    const imageItems = Array.from(event.clipboardData?.items || []).filter(
      (item) => item.kind !== 'string' && item.type?.startsWith('image/'),
    )
    const images = imageItems.map((item) => item.getAsFile?.()).filter(Boolean)
    if (images.length && read('allowImages', false) && fn('attachImages')) {
      call('attachImages', images.map((file) => ({ file })))
      return
    }
    const text = event.clipboardData?.getData('text/plain') || ''
    if (text) insert(text)
    else if (imageItems.length) {
      call('setNotice', t('chat.orca.composer.textOnly', 'This chat accepts text only.'))
    }
  }
  async function pasteFromClipboard() {
    if (disabled()) return false
    const owner = scope()
    try {
      const get = fn('readClipboardText') || globalThis.window?.shellApi?.readClipboard
      const text = await get?.()
      if (scope() !== owner || disabled()) return false
      return insert(typeof text === 'string' ? text : text?.text || '')
    } catch (error) {
      if (scope() === owner && !disabled()) call('setNotice', String(error?.message || error))
      return false
    }
  }
  return { handlePaste, pasteFromClipboard }
}
