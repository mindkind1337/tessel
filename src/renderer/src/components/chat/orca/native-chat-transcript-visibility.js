// After Orca's NativeChatTranscriptChrome.tsx (MIT, Copyright (c) 2026 Lovecast Inc.):
// the transcript images' visibility, one IntersectionObserver for all of them
// (a preview loads its image only while near the viewport).

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
export function isNativeChatPastedImagePath(path) {
  const base = path.split(/[\\/]/).findLast(Boolean) ?? path
  return /^orca-paste-.+\.png$/i.test(base)
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
