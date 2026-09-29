// After Orca's use-native-chat-composer-attachments.ts (MIT, Copyright (c) 2026 Lovecast Inc.)
// Reactive options; images are opt-in local chip state, never transport payloads.
// Paths insert as text; composition defers insertion and rechecks scope ownership.
// Returns the reference chip/queue API and imageAttachments ref.
import { ref, watch, onScopeDispose } from 'vue'
import { setBoundedScopeCacheEntry } from '../native-chat-composer-scope-cache.js'
import { validateNativeFileDropPaths } from '../shared/native-file-drop.js'
import { composerOptions } from './composer-options.js'
import { t } from '../../../i18n/index.js'
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
  const release = (item) => {
    if (item.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(item.previewUrl)
  }
  function persist() {
    const items = imageAttachments.value
      .filter((item) => !item.pending)
      .map(({ previewUrl, ...item }) => item)
    const key = read('attachmentScopeKey')
    if (items.length) setBoundedScopeCacheEntry(attachmentCache, key, items)
    else attachmentCache.delete(key)
  }
  watch(
    () => [read('attachmentScopeKey'), read('allowImages', false)],
    () => {
      imageAttachments.value.forEach(release)
      queue = []
      imageAttachments.value = read('allowImages', false)
        ? readNativeChatAttachmentCache(read('attachmentScopeKey'))
        : []
    },
    { immediate: true, flush: 'sync' },
  )
  onScopeDispose(() => {
    alive = false
    queue = []
    imageAttachments.value.forEach(release)
  })
  watch(
    () => [read('disabled'), read('disabledReason'), read('remote')],
    () => {
      queue = []
    },
    { flush: 'sync' },
  )
  function clearImageAttachments() {
    imageAttachments.value.forEach(release)
    imageAttachments.value = []
    persist()
  }
  function removeImageAttachment(id) {
    imageAttachments.value.filter((item) => item.id === id).forEach(release)
    imageAttachments.value = imageAttachments.value.filter((item) => item.id !== id)
    persist()
  }
  function beginPendingImageAttachment(previewUrl) {
    if (disabled() || !read('allowImages', false)) return null
    const id = `${Date.now()}-${++counter}`
    imageAttachments.value.push({ id, path: '', previewUrl, pending: true })
    return id
  }
  function resolvePendingImageAttachment(id, path, connectionId) {
    if (disabled() || connectionId || !read('allowImages', false)) {
      removeImageAttachment(id)
      return
    }
    imageAttachments.value = imageAttachments.value.map((item) =>
      item.id === id ? { ...item, path, pending: undefined } : item,
    )
    persist()
  }
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
    const apply = () => {
      if (!current()) return false
      const imagePaths = read('allowImages', false)
        ? paths.filter((path) => /\.(?:png|jpe?g|webp|gif|bmp)$/i.test(path))
        : []
      for (const path of imagePaths)
        imageAttachments.value.push({ id: `${Date.now()}-${++counter}`, path })
      if (imagePaths.length) persist()
      const textPaths = paths.filter((path) => !imagePaths.includes(path))
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
  return {
    imageAttachments,
    attachResolvedPaths,
    clearImageAttachments,
    flushPendingAttachments,
    removeImageAttachment,
    beginPendingImageAttachment,
    resolvePendingImageAttachment,
    dropPendingImageAttachment: removeImageAttachment,
  }
}
