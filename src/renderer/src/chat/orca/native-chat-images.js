// Images attached to chat messages, on the window's side. The main process
// keeps the copy the agent reads (src/main/chat/chatImages.js) and hands back
// an opaque id; the window keeps what it shows: a blob: URL made from the
// bytes it already holds (the pasted or dropped File) and a small thumbnail
// (data: URL). Never a file:// path. Shown images of sent messages live here
// for this window's life only (the journal keeps names), a bounded number.
// Limits as the main process checks them again: png, jpeg, gif, webp; 10 MB
// each; 10 per message.

export const CHAT_IMAGE_LIMITS = { maxBytes: 10 * 1024 * 1024, perMessage: 10 }
export const CHAT_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
export const CHAT_IMAGE_ACCEPT = CHAT_IMAGE_TYPES.join(',')
const IMAGE_PATH = /\.(?:png|jpe?g|gif|webp)$/i
const KEEP = 60 // registered images kept (their blob: URLs), oldest dropped first

const registry = new Map() // image id -> { fullUrl, thumbUrl, name, width, height }

export const isChatImagePath = (path) => typeof path === 'string' && IMAGE_PATH.test(path)
export const isChatImageFile = (file) => !!file && CHAT_IMAGE_TYPES.includes(file.type)

// "image.png", then "image-2.png", "image-3.png"… (names already in use skipped).
export function nextPastedImageName(names = [], ext = 'png') {
  const used = new Set(names)
  if (!used.has(`image.${ext}`)) return `image.${ext}` // i18n-ignore
  for (let n = 2; ; n++) if (!used.has(`image-${n}.${ext}`)) return `image-${n}.${ext}` // i18n-ignore
}
export const extensionFor = (mime) => ({ 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' })[mime] || 'png'

export function objectUrl(blob) {
  try {
    return blob && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function' ? URL.createObjectURL(blob) : null
  } catch {
    return null
  }
}
export function revokeUrl(url) {
  try {
    if (typeof url === 'string' && url.startsWith('blob:')) URL.revokeObjectURL(url)
  } catch {
    /* already gone */
  }
}

// A small PNG thumbnail (longest side `side` px) of an image URL, or null
// when the image cannot be decoded here.
export function makeThumbnail(url, side = 192) {
  return new Promise((resolve) => {
    if (!url || typeof Image === 'undefined' || typeof document === 'undefined') return resolve(null)
    const img = new Image()
    img.onload = () => {
      try {
        const w = img.naturalWidth
        const h = img.naturalHeight
        if (!w || !h) return resolve(null)
        const scale = Math.min(1, side / Math.max(w, h))
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(w * scale))
        canvas.height = Math.max(1, Math.round(h * scale))
        const g = canvas.getContext('2d')
        if (!g) return resolve(null)
        g.drawImage(img, 0, 0, canvas.width, canvas.height)
        resolve({ url: canvas.toDataURL('image/png'), width: w, height: h })
      } catch {
        resolve(null)
      }
    }
    img.onerror = () => resolve(null)
    img.src = url
  })
}

export function registerChatImage(id, entry) {
  if (typeof id !== 'string' || !id) return
  const prior = registry.get(id)
  if (prior && prior.fullUrl !== entry.fullUrl) revokeUrl(prior.fullUrl)
  registry.delete(id)
  registry.set(id, { ...entry })
  while (registry.size > KEEP) {
    const [oldId, old] = registry.entries().next().value
    registry.delete(oldId)
    revokeUrl(old.fullUrl)
  }
}
export const chatImageEntry = (id) => registry.get(id) || null
// The full-size URL of a shown image (thumbnail or full URL), or null.
export function fullImageUrlFor(url) {
  if (!url) return null
  for (const entry of registry.values()) if (entry.thumbUrl === url || entry.fullUrl === url) return entry.fullUrl || entry.thumbUrl
  return null
}
// A chip removed before its message was sent: nothing will show it again.
export function forgetChatImage(id) {
  const entry = registry.get(id)
  if (!entry) return
  registry.delete(id)
  revokeUrl(entry.fullUrl)
}
export function clearChatImagesForTests() {
  registry.clear()
}

// "688×478" (empty when unknown).
export const imagePixelSize = (w, h) => (w > 0 && h > 0 ? `${w}×${h}` : '')

// An image an earlier-history message carries (src/main/chat/historyAttachments.js):
// a base64 data: URL of an image type shown here, else nothing.
const HISTORY_IMAGE_URL = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/
export const historyImageUrl = (url) => (typeof url === 'string' && url.length <= 4 * 1024 * 1024 && HISTORY_IMAGE_URL.test(url) ? url : null)

// A 'user' event's images as the message's image-ref blocks: the shown
// thumbnail while this window has it (a sent image), the image itself for a
// history message (its dataUrl), else a chip with the name.
export function imageRefBlocks(images) {
  if (!Array.isArray(images)) return []
  return images.slice(0, CHAT_IMAGE_LIMITS.perMessage).map((image) => {
    const entry = image && typeof image.id === 'string' ? chatImageEntry(image.id) : null
    const name = typeof image?.name === 'string' && image.name ? image.name : 'image' // i18n-ignore
    const url = entry?.thumbUrl || entry?.fullUrl || historyImageUrl(image?.dataUrl)
    return { type: 'image-ref', alt: name, ...(url ? { url } : {}) }
  })
}

// A history 'user' event's other files as file-ref blocks: a chip with the
// name, type and size; path only for a file that existed as a plain local
// file when the history was read (opened with the system on a click).
export const CHAT_FILE_LIMITS = { perMessage: 8 }
export function fileRefBlocks(files) {
  if (!Array.isArray(files)) return []
  return files.slice(0, CHAT_FILE_LIMITS.perMessage).flatMap((file) => {
    if (!file || typeof file !== 'object') return []
    const name = typeof file.name === 'string' && file.name ? file.name.slice(0, 200) : 'file' // i18n-ignore
    const mediaType = typeof file.mediaType === 'string' ? file.mediaType.slice(0, 200) : ''
    const size = Number.isSafeInteger(file.size) && file.size >= 0 ? file.size : null
    const path = typeof file.path === 'string' && file.path && file.path.length <= 4096 && !file.path.includes('\0') ? file.path : null
    return [{ type: 'file-ref', name, ...(mediaType ? { mediaType } : {}), ...(size !== null ? { size } : {}), ...(path ? { path } : {}) }]
  })
}

// "12 KB", "3.4 MB" (empty when unknown).
export function fileSizeLabel(size) {
  if (!Number.isFinite(size) || size < 0) return ''
  if (size < 1024) return `${size} B` // i18n-ignore unit
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB` // i18n-ignore unit
  const mb = size / 1024 / 1024
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB` // i18n-ignore unit
}
