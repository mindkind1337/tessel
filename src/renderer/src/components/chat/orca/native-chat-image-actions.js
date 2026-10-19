// What the chat does with an image it shows: open it (Tessel's link router,
// src/renderer/src/links/openTarget.js: the window's image viewer, or an
// editor tab), copy it, save it. Every image click of the chat goes through
// openChatImage, so the router stays the one place that decides.
import { openTarget } from '../../../links/openTarget.js'

// target: a data:image URL, a path (local, ssh://), or { src, path };
// opts: openTarget's ({ image: 'lightbox' | 'editor', label, event }).
export function openChatImage(target, opts = {}) {
  return openTarget(target, opts)
}

// A shown image's src as a data: URL (a blob: one is read back), or null.
export async function imageDataUrl(src) {
  if (typeof src !== 'string' || !src) return null
  if (/^data:image\//i.test(src)) return src
  if (!/^blob:/i.test(src) || typeof fetch !== 'function' || typeof FileReader === 'undefined') return null
  try {
    const blob = await (await fetch(src)).blob()
    return await new Promise((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null)
      reader.onerror = () => resolve(null)
      reader.readAsDataURL(blob)
    })
  } catch {
    return null
  }
}

// A PNG of the image, decoded off the page's thread where the browser can
// (createImageBitmap), for the clipboard (which takes PNG only).
async function pngBlob(src) {
  const blob = await (await fetch(src)).blob()
  if (blob.type === 'image/png') return blob
  const bitmap = typeof createImageBitmap === 'function' ? await createImageBitmap(blob) : null
  if (!bitmap) return null
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const g = canvas.getContext('2d')
  if (!g) return null
  g.drawImage(bitmap, 0, 0)
  bitmap.close?.()
  return await new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'))
}

// -> true when the image is on the clipboard.
export async function copyChatImage(src) {
  try {
    const clip = globalThis.navigator?.clipboard
    if (!src || !clip || typeof clip.write !== 'function' || typeof ClipboardItem === 'undefined') return false
    const blob = await pngBlob(src)
    if (!blob) return false
    await clip.write([new ClipboardItem({ 'image/png': blob })])
    return true
  } catch {
    return false
  }
}

// The system's save dialog for the image -> { ok, path } | { ok: false, canceled? }.
export async function saveChatImage(src, name) {
  const api = globalThis.window?.shellApi?.chat
  const dataUrl = await imageDataUrl(src)
  if (!dataUrl || !api || typeof api.imageSaveAs !== 'function') return { ok: false }
  try {
    return (await api.imageSaveAs({ dataUrl, name: typeof name === 'string' ? name : '' })) || { ok: false }
  } catch {
    return { ok: false }
  }
}

// The image in an editor tab: its own file when it has one (a local or an
// SSH path), else a copy Tessel writes for it. -> true when opened.
export async function openChatImageInTab({ src, path, label } = {}) {
  if (path) return openChatImage({ kind: 'image', path }, { image: 'editor', label })
  const api = globalThis.window?.shellApi?.chat
  const dataUrl = await imageDataUrl(src)
  if (!dataUrl || !api || typeof api.imageViewCopy !== 'function') return false
  try {
    const res = await api.imageViewCopy({ dataUrl })
    return !!(res && res.ok && res.path) && (await openChatImage({ kind: 'image', path: res.path }, { image: 'editor', label }))
  } catch {
    return false
  }
}
