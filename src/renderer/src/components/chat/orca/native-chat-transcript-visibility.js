// After Orca's NativeChatTranscriptChrome.tsx (MIT, Copyright (c) 2026 Lovecast Inc.):
// the transcript images' visibility, one IntersectionObserver for all of them
// (a preview loads its image only while near the viewport).
import { t } from '../../../i18n'

const visibilityListeners = new Map()
let visibilityObserver = null

export function observeTranscriptVisibility(element, listener) {
  if (typeof IntersectionObserver === 'undefined') {
    listener(true)
    return () => {}
  }

  visibilityObserver ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        visibilityListeners.get(entry.target)?.(entry.isIntersecting)
      }
    },
    { rootMargin: '128px' }
  )
  visibilityListeners.set(element, listener)
  visibilityObserver.observe(element)

  return () => {
    visibilityListeners.delete(element)
    visibilityObserver?.unobserve(element)
    if (visibilityListeners.size === 0) {
      visibilityObserver?.disconnect()
      visibilityObserver = null
    }
  }
}

// Tessel: only images already in the page (data:, blob:) are shown directly;
// a remote http(s) image is never fetched by the chat (the page's policy
// refuses it anyway), it goes through the local loader like a path.
export function renderableImageSource(source) {
  return Boolean(source && /^(?:data|blob):/i.test(source))
}

// The reference's isNativeChatPastedImagePath (native-chat-image-paste.ts). Not
// imported from chat/orca/native-chat-image-paste.js: that module still imports
// a terminal-pane file Tessel does not have.
// Tessel: its own copies of a pasted image: %TEMP%\tessel-paste\image-*.png
// (a terminal's paste), %TEMP%\tessel-paste\chat\img_<id>.<ext> (a chat's
// paste, drop or pick); the reference's orca-paste-*.png is kept.
export function isNativeChatPastedImagePath(path) {
  const text = String(path ?? '')
  const base = text.split(/[\\/]/).findLast(Boolean) ?? text
  if (/^orca-paste-.+\.png$/i.test(base)) return true
  if (!/[\\/]tessel-paste[\\/]/i.test(text)) return false
  return /^(?:img_[0-9a-f]{24}\.(?:png|jpe?g|gif|webp)|image-\d+\.png)$/i.test(base)
}

// The name an image shows under: "Pasted image" for one pasted in a terminal
// (the transcript's 'pasted' source) or one of Tessel's paste copies, else
// its own name, its file's name, or "Image".
export function imageLabel(block) {
  if (!block) return t('chat.orca.markdown.image', 'Image')
  if (block.source === 'pasted' || (block.path && isNativeChatPastedImagePath(block.path))) return t('chat.orca.composer.pastedImageLabel', 'Pasted image')
  return block.alt?.trim() || (block.path ? basename(block.path) : t('chat.orca.markdown.image', 'Image'))
}

export function basename(path) {
  const parts = String(path).split(/[\\/]/).filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : String(path)
}

// Remounts a preview when its image or its owner (worktree) changes, so an
// error for one owner does not stick to another.
export function transcriptImageIdentity(block, runtimeContext) {
  const source = block.url?.trim() || block.path
  const filePath = block.path ?? source ?? ''
  if (renderableImageSource(source)) {
    return `external\0${source ?? ''}` // i18n-ignore
  }
  return `${source ?? ''}\0${filePath}\0${
    runtimeContext === null
      ? 'unresolved'
      : runtimeContext === undefined
        ? 'pending'
        : [
            runtimeContext.connectionId ?? 'local',
            runtimeContext.worktreeId ?? 'unknown-worktree',
            runtimeContext.worktreePath ?? '',
            source ?? ''
          ].join('\0')
  }`
}
