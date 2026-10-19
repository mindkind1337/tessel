// What the chat's image viewer does with an image it shows (a tool's
// screenshot, a pasted image, a picture in an answer): those come to the
// window as data: URLs, with no file of their own.
// - Save as: the system's save dialog, then the image's bytes written there;
// - Open in an image tab: a copy in Tessel's temp folder
//   (%TEMP%\tessel-chat-images, named by the image's bytes), whose path the
//   window then opens in the editor. Copies older than a day are removed.
// The bytes are checked first: a base64 data: URL of png, jpeg, gif or webp
// (by its first bytes, never by its name or declared type), 30 MB at most.
// Only the main window may ask. Nothing is logged about an image.
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import { sniffImage } from './chatImages.js'
import { t } from '../i18n.js'

export const IMAGE_ACTION_LIMITS = { maxBytes: 30 * 1024 * 1024, name: 120 }
export const IMAGE_VIEW_DIR = join(os.tmpdir(), 'tessel-chat-images')
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }
const DATA_URL = /^data:image\/(?:png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/
const DAY = 24 * 60 * 60 * 1000

// data: URL -> { buf, mime } | null.
export function imageFromDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string' || dataUrl.length > Math.ceil((IMAGE_ACTION_LIMITS.maxBytes * 4) / 3) + 64) return null
  const m = DATA_URL.exec(dataUrl)
  if (!m) return null
  const buf = Buffer.from(m[1], 'base64')
  if (!buf.length || buf.length > IMAGE_ACTION_LIMITS.maxBytes) return null
  const mime = sniffImage(buf)
  return mime ? { buf, mime } : null
}

// A file name to offer: one line, no folder, no character Windows refuses,
// with the extension of the image's real type.
export function saveName(name, mime) {
  const ext = EXT[mime] || 'png'
  let s = typeof name === 'string' ? name.split(/[\\/]/).pop() : ''
  s = s.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').trim() // eslint-disable-line no-control-regex
  s = s.replace(/\.(?:png|jpe?g|gif|webp)$/i, '').replace(/^\.+/, '')
  if (!s) s = 'image' // i18n-ignore
  return `${s.slice(0, IMAGE_ACTION_LIMITS.name)}.${ext}`
}

// deps: dialog (Electron's), getWindow() (the main window), downloadsDir(),
// dir (the copies' folder), now().
export function createChatImageActions({ dialog, getWindow = () => null, downloadsDir = () => os.homedir(), dir = IMAGE_VIEW_DIR, now = Date.now } = {}) {
  async function saveAs({ dataUrl, name } = {}) {
    const img = imageFromDataUrl(dataUrl)
    if (!img) return { ok: false, error: t('main.chatImage.cannotSave', 'This image cannot be saved.') }
    const win = getWindow()
    const opts = {
      title: t('main.chatImage.saveTitle', 'Save image'),
      defaultPath: join(downloadsDir(), saveName(name, img.mime)),
      filters: [{ name: t('main.chatImage.filter', 'Image'), extensions: [EXT[img.mime]] }]
    }
    const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (!res || res.canceled || !res.filePath) return { ok: false, canceled: true }
    try {
      fs.writeFileSync(res.filePath, img.buf)
      return { ok: true, path: res.filePath }
    } catch {
      return { ok: false, error: t('main.chatImage.saveFailed', 'The image could not be saved there.') }
    }
  }

  function sweep() {
    let names = []
    try {
      names = fs.readdirSync(dir)
    } catch {
      return
    }
    for (const n of names) {
      const file = join(dir, n)
      try {
        const st = fs.lstatSync(file)
        if (st.isFile() && now() - st.mtimeMs > DAY) fs.unlinkSync(file)
      } catch {
        /* in use or gone */
      }
    }
  }

  // -> { ok, path }: the same image gives the same file (written once).
  function viewCopy({ dataUrl } = {}) {
    const img = imageFromDataUrl(dataUrl)
    if (!img) return { ok: false, error: t('main.chatImage.cannotOpen', 'This image cannot be opened.') }
    try {
      fs.mkdirSync(dir, { recursive: true })
      sweep()
      const file = join(dir, `${createHash('sha1').update(img.buf).digest('hex').slice(0, 24)}.${EXT[img.mime]}`)
      if (!fs.existsSync(file)) fs.writeFileSync(file, img.buf)
      return { ok: true, path: file }
    } catch {
      return { ok: false, error: t('main.chatImage.openFailed', 'The image could not be opened.') }
    }
  }

  function register(ipcMain) {
    const fromWindow = (e) => {
      const win = getWindow()
      return !!win && !win.isDestroyed?.() && e && e.sender === win.webContents
    }
    const obj = (q) => (q && typeof q === 'object' && !Array.isArray(q) ? q : {})
    ipcMain.handle('chatImages:saveAs', (e, q) => (fromWindow(e) ? saveAs(obj(q)) : { ok: false }))
    ipcMain.handle('chatImages:viewCopy', (e, q) => (fromWindow(e) ? viewCopy(obj(q)) : { ok: false }))
  }

  return { saveAs, viewCopy, sweep, register }
}
