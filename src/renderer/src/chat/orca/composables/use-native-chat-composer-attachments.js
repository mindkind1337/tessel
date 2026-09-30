// After Orca's use-native-chat-composer-attachments.ts (MIT, Copyright (c) 2026 Lovecast Inc.)
// Reactive options. With allowImages, pasted, dropped and picked images become
// chips: each is saved by the main process (clipboard bytes: imageSave; a
// dropped or picked file: imageImport, checked and copied there) and known by
// the opaque id it returns; send names those ids only. Without allowImages,
// and for any other dropped file, paths insert as text. Composition defers
// insertion and rechecks scope ownership.
// Options: attachmentScopeKey (the pane id), allowImages, imageApi (default
// window.shellApi.chat), setNotice, isComposing, insertTypedText | setDraft
// + setCaret + caret, disabled, disabledReason.
// A chip: { id, imageId, name, width, height, previewUrl, fullUrl, pending }.
import { ref, watch, onScopeDispose } from 'vue'
import { setBoundedScopeCacheEntry } from '../native-chat-composer-scope-cache.js'
import { validateNativeFileDropPaths } from '../shared/native-file-drop.js'
import { composerOptions } from './composer-options.js'
import { t } from '../../../i18n/index.js'
import {
  CHAT_IMAGE_LIMITS,
  chatImageEntry,
  extensionFor,
  forgetChatImage,
  isChatImageFile,
  isChatImagePath,
  makeThumbnail,
  nextPastedImageName,
  objectUrl,
  registerChatImage,
  revokeUrl
} from '../native-chat-images.js'
const attachmentCache = new Map()
export const readNativeChatAttachmentCache = (key) => [...(attachmentCache.get(key) || [])]
export const clearNativeChatAttachmentCacheForTests = () => attachmentCache.clear()
export function useNativeChatComposerAttachments(options) {
  const { read, call, fn, scope } = composerOptions(options)
  const imageAttachments = ref([])
  let queue = [],
    counter = 0,
    alive = true
  const disabled = () => !alive || read('disabled') || read('disabledReason') || read('remote')
  const api = () => fn('imageApi') || globalThis.window?.shellApi?.chat || null
  const notice = (text) => call('setNotice', text)
  // Chips of a scope restored from the cache get their shown image back.
  const withImage = (item) => {
    const entry = item.imageId ? chatImageEntry(item.imageId) : null
    return entry ? { ...item, previewUrl: entry.thumbUrl || entry.fullUrl, fullUrl: entry.fullUrl } : item
  }
  function persist() {
    const items = imageAttachments.value
      .filter((item) => !item.pending)
      .map(({ previewUrl, fullUrl, ...item }) => item)
    const key = read('attachmentScopeKey')
    if (items.length) setBoundedScopeCacheEntry(attachmentCache, key, items)
    else attachmentCache.delete(key)
  }
  watch(
    () => [read('attachmentScopeKey'), read('allowImages', false)],
    () => {
      queue = []
      imageAttachments.value = read('allowImages', false)
        ? readNativeChatAttachmentCache(read('attachmentScopeKey')).map(withImage)
        : []
    },
    { immediate: true, flush: 'sync' },
  )
  onScopeDispose(() => {
    alive = false
    queue = []
  })
  watch(
    () => [read('disabled'), read('disabledReason'), read('remote')],
    () => {
      queue = []
    },
    { flush: 'sync' },
  )
  // After a confirmed send: the main process owns these images now.
  function clearImageAttachments() {
    imageAttachments.value = []
    persist()
  }
  function removeImageAttachment(id) {
    const gone = imageAttachments.value.filter((item) => item.id === id)
    imageAttachments.value = imageAttachments.value.filter((item) => item.id !== id)
    persist()
    const paneId = read('attachmentScopeKey')
    for (const item of gone) {
      if (!item.imageId) continue
      forgetChatImage(item.imageId)
      Promise.resolve(api()?.imageDiscard?.({ paneId, id: item.imageId })).catch(() => {})
    }
  }
  const tooMany = () =>
    notice(
      t('chat.orca.composer.imageLimit', 'At most {{n}} images per message.', {
        n: String(CHAT_IMAGE_LIMITS.perMessage),
      }),
    )
  const badType = () =>
    notice(t('chat.orca.composer.imageType', 'Only PNG, JPEG, GIF and WebP images can be attached.'))
  const tooLarge = () =>
    notice(
      t('chat.orca.composer.imageTooLarge', 'This image is larger than {{mb}} MB.', {
        mb: String(Math.round(CHAT_IMAGE_LIMITS.maxBytes / 1024 / 1024)),
      }),
    )
  // Images for this message: [{ file (a Blob/File), path? (a dropped or
  // picked file: the main process copies it), name? }]. Chips show at once
  // (pending) and settle when the main process answers. -> accepted count.
  function attachImages(list) {
    if (disabled() || !read('allowImages', false) || !list?.length) return 0
    const target = api()
    if (!target?.imageSave || !target?.imageImport) return 0
    const room = CHAT_IMAGE_LIMITS.perMessage - imageAttachments.value.length
    if (list.length > room) {
      tooMany()
      if (room <= 0) return 0
    }
    const paneId = read('attachmentScopeKey')
    const owner = scope()
    let accepted = 0
    for (const entry of list.slice(0, Math.max(0, room))) {
      const file = entry.file
      if (file && !isChatImageFile(file)) {
        badType()
        continue
      }
      if (!file && !(entry.path && isChatImagePath(entry.path))) {
        badType()
        continue
      }
      if (file && file.size > CHAT_IMAGE_LIMITS.maxBytes) {
        tooLarge()
        continue
      }
      const names = imageAttachments.value.map((item) => item.name)
      const name = entry.path
        ? entry.path.split(/[\\/]/).filter(Boolean).pop()
        : entry.name || nextPastedImageName(names, extensionFor(file?.type))
      const id = `${Date.now()}-${++counter}`
      const fullUrl = file ? objectUrl(file) : null
      imageAttachments.value = [...imageAttachments.value, { id, name, fullUrl, previewUrl: fullUrl, pending: true }]
      accepted++
      void settle(id, paneId, owner, entry, file, name, fullUrl)
    }
    return accepted
  }
  async function settle(id, paneId, owner, entry, file, name, fullUrl) {
    const target = api()
    let result
    try {
      if (entry.path) result = await target.imageImport({ paneId, path: entry.path, ...(file ? {} : { thumb: true }) })
      else result = await target.imageSave({ paneId, bytes: new Uint8Array(await file.arrayBuffer()), name })
    } catch (error) {
      result = { ok: false, error: String(error?.message || error) }
    }
    const still = alive && scope() === owner && imageAttachments.value.some((item) => item.id === id)
    if (!result?.ok || !result.image) {
      revokeUrl(fullUrl)
      if (still) {
        imageAttachments.value = imageAttachments.value.filter((item) => item.id !== id)
        notice(result?.error || t('chat.orca.composer.imageFailed', 'The image could not be attached.'))
      }
      return
    }
    const image = result.image
    if (!still) {
      // Removed (or the pane changed) while it was saved: not needed.
      revokeUrl(fullUrl)
      Promise.resolve(target.imageDiscard?.({ paneId, id: image.id })).catch(() => {})
      return
    }
    const made = fullUrl ? await makeThumbnail(fullUrl) : null
    const thumb = made || (typeof image.thumb === 'string' && image.thumb.startsWith('data:image/') ? { url: image.thumb } : null)
    registerChatImage(image.id, {
      fullUrl,
      thumbUrl: thumb?.url || null,
      name: image.name,
      width: image.width || thumb?.width || 0,
      height: image.height || thumb?.height || 0,
    })
    if (!alive || scope() !== owner) return
    imageAttachments.value = imageAttachments.value.map((item) =>
      item.id === id
        ? {
            id,
            imageId: image.id,
            name: image.name || name,
            width: image.width || thumb?.width || 0,
            height: image.height || thumb?.height || 0,
            previewUrl: thumb?.url || fullUrl || undefined,
            fullUrl: fullUrl || undefined,
          }
        : item,
    )
    persist()
  }
  // Dropped paths (ownership.files: the dropped Files, same order). Images
  // become chips; any other path inserts as text.
  function attachResolvedPaths(paths, connectionId, ownership = {}) {
    if (
      disabled() ||
      connectionId ||
      !paths?.length ||
      paths.some((path) => typeof path !== 'string' || /[\0\r\n]/.test(path)) ||
      validateNativeFileDropPaths(paths).status !== 'accepted'
    )
      return false
    const owner = scope()
    const current = () =>
      !disabled() && scope() === owner && (ownership.targetOwnerIsCurrent?.() ?? true)
    const files = Array.isArray(ownership.files) ? ownership.files : []
    const apply = () => {
      if (!current()) return false
      const images = read('allowImages', false)
        ? paths.map((path, i) => ({ path, file: files[i] })).filter((entry) => isChatImagePath(entry.path))
        : []
      if (images.length) attachImages(images)
      const textPaths = paths.filter((path) => !images.some((entry) => entry.path === path))
      if (!textPaths.length) return true
      const text =
        textPaths.map((path) => (/\s/.test(path) ? JSON.stringify(path) : path)).join(' ') + ' '
      if (fn('insertTypedText')) return call('insertTypedText', text)
      const caret = read('caret', 0)
      call('setDraft', (previous) => previous.slice(0, caret) + text + previous.slice(caret))
      call('setCaret', caret + text.length)
      return true
    }
    if (call('isComposing')) {
      if (
        queue.reduce((sum, entry) => sum + entry.paths.length, 0) + paths.length > 256 ||
        validateNativeFileDropPaths([...queue.flatMap((entry) => entry.paths), ...paths]).status ===
          'rejected'
      ) {
        call(
          'setNotice',
          t(
            'chat.orca.composer.fileDropFailed',
            `Could not insert these file paths. Drop up to 256 local files.`,
          ),
        )
        return false
      }
      queue.push({ apply, paths })
      return true
    }
    return apply()
  }
  function flushPendingAttachments() {
    if (call('isComposing')) return
    const pending = queue
    queue = []
    pending.forEach((entry) => entry.apply())
  }
  // The ids chat:send names, in order (none while one is still saving).
  const imageIdsForSend = () => imageAttachments.value.map((item) => item.imageId).filter(Boolean)
  return {
    imageAttachments,
    attachImages,
    attachResolvedPaths,
    clearImageAttachments,
    flushPendingAttachments,
    removeImageAttachment,
    imageIdsForSend,
  }
}
