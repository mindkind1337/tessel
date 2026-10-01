// Images attached to a chat message (pasted, dropped or picked in the
// composer). Every image the agent sees is a copy Tessel made in its own temp
// folder (%TEMP%\tessel-paste\chat, next to the terminal panes' pasted
// images), known by an opaque id tied to its pane: the window never names a
// file for the agent, and chat:send takes ids only.
// - bytes (clipboard): checked (type by magic bytes, size), then saved;
// - a dropped or picked file: a real file (not a folder, not a link), within
//   the size cap, an image by its bytes; then copied.
// png, jpeg, gif and webp only; 10 MB each; 10 per message.
// A copy is removed once the turn that sent it ends, when its chip is removed
// or its pane closes, and (left by an earlier run) after a day. A terminal
// agent's chat view gets the paths of its copies (chat:imagePaths), to paste
// into the agent's input; those are removed ten minutes later.
import fs from 'fs'
import os from 'os'
import { basename, extname, isAbsolute, join } from 'path'
import { randomBytes } from 'crypto'
import { t } from '../i18n.js'

export const IMAGE_LIMITS = { maxBytes: 10 * 1024 * 1024, perMessage: 10, perPane: 40, total: 200, name: 120 }
export const CHAT_IMAGE_DIR = join(os.tmpdir(), 'tessel-paste', 'chat')
export const IMAGE_ID = /^img_[0-9a-f]{24}$/
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }
const DAY = 24 * 60 * 60 * 1000
// A copy handed to a terminal agent is removed this long after.
export const HANDOFF_KEEP_MS = 10 * 60 * 1000

// The image type from its first bytes, or null (never from a name).
export function sniffImage(buf) {
  if (!buf || buf.length < 12) return null
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'image/png'
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  const head = buf.toString('latin1', 0, 6)
  if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif'
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
  return null
}

// The pixel size from the image's header, or null when it cannot be read.
export function imageSize(buf, mime) {
  try {
    if (mime === 'image/png') {
      if (buf.length < 24 || buf.toString('latin1', 12, 16) !== 'IHDR') return null
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
    }
    if (mime === 'image/gif') return buf.length >= 10 ? { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) } : null
    if (mime === 'image/webp') {
      const chunk = buf.toString('latin1', 12, 16)
      if (chunk === 'VP8X' && buf.length >= 30) return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) }
      if (chunk === 'VP8L' && buf.length >= 25) {
        const b = buf.readUInt32LE(21)
        return { width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) }
      }
      if (chunk === 'VP8 ' && buf.length >= 30) return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
      return null
    }
    if (mime === 'image/jpeg') {
      let i = 2
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) {
          i++
          continue
        }
        const marker = buf[i + 1]
        if (marker === 0xff) {
          i++
          continue
        }
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          i += 2
          continue
        }
        const len = buf.readUInt16BE(i + 2)
        // SOF0..SOF15, but not DHT (c4), JPG (c8), DAC (cc).
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) }
        }
        if (len < 2) return null
        i += 2 + len
      }
    }
  } catch {
    /* a truncated header */
  }
  return null
}

// A shown name: one line, no folder, at most IMAGE_LIMITS.name characters.
export function cleanImageName(name, mime) {
  let s = typeof name === 'string' ? basename(name.replace(/\\/g, '/')) : ''
  s = s.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').trim()
  if (!s) s = `image.${EXT[mime] || 'png'}` // i18n-ignore
  if (s.length > IMAGE_LIMITS.name) {
    const ext = extname(s).slice(0, 10)
    s = s.slice(0, IMAGE_LIMITS.name - ext.length) + ext
  }
  return s
}

export function createChatImages(deps = {}) {
  const {
    dir = CHAT_IMAGE_DIR,
    limits = IMAGE_LIMITS,
    now = Date.now,
    newId = () => `img_${randomBytes(12).toString('hex')}`,
    // Electron's nativeImage (main process): shrinks a large png/jpeg for
    // Claude, whose API refuses an image over 5 MB. None: sent as is.
    nativeImage = null,
    log = null
  } = deps
  const images = new Map() // id -> { id, paneId, file, mime, name, width, height, size, at }

  const fail = (error) => ({ ok: false, error })
  const tooLarge = () => fail(t('main.chat.image.tooLarge', 'This image is larger than {{mb}} MB.', { mb: String(Math.round(limits.maxBytes / 1024 / 1024)) }))
  const notImage = () => fail(t('main.chat.image.notImage', 'Only PNG, JPEG, GIF and WebP images can be attached.'))
  const warn = (text) => {
    try {
      log?.warn?.('chat', text)
    } catch {
      /* logging never breaks the chat */
    }
  }

  function countFor(paneId) {
    let n = 0
    for (const img of images.values()) if (img.paneId === paneId) n++
    return n
  }

  // Validated bytes -> a copy in the folder, registered for the pane.
  function store(paneId, buf, name, withThumb = false) {
    if (!buf.length || buf.length > limits.maxBytes) return buf.length ? tooLarge() : notImage()
    const mime = sniffImage(buf)
    if (!mime) return notImage()
    if (countFor(paneId) >= limits.perPane || images.size >= limits.total) {
      return fail(t('main.chat.image.tooMany', 'Too many images are waiting in this chat. Send or remove some first.'))
    }
    const id = newId()
    const file = join(dir, `${id}.${EXT[mime]}`)
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(file, buf, { flag: 'wx' })
    } catch (err) {
      warn(`image save failed: ${err?.message || err}`)
      return fail(t('main.chat.image.saveFailed', 'The image could not be saved.'))
    }
    const size = imageSize(buf, mime) || { width: 0, height: 0 }
    const img = { id, paneId, file, mime, name: cleanImageName(name, mime), width: size.width, height: size.height, size: buf.length, at: now() }
    images.set(id, img)
    const thumb = withThumb ? thumbnail(buf) : null
    return { ok: true, image: { ...publicImage(img), ...(thumb ? { thumb } : {}) } }
  }

  // A small PNG data: URL (a png/jpeg; Electron decodes those), for a window
  // that has no bytes of its own to show (a file dragged from Tessel's
  // explorer).
  function thumbnail(buf) {
    if (!nativeImage) return null
    try {
      const pic = nativeImage.createFromBuffer(buf)
      if (pic.isEmpty()) return null
      const { width, height } = pic.getSize()
      const side = 192
      const small = Math.max(width, height) > side ? pic.resize(width >= height ? { width: side } : { height: side }) : pic
      return small.toDataURL()
    } catch {
      return null
    }
  }
  const publicImage = (img) => ({ id: img.id, name: img.name, mime: img.mime, width: img.width, height: img.height, size: img.size })

  // Clipboard bytes from the window.
  function saveBytes({ paneId, bytes, name } = {}) {
    let buf
    if (Buffer.isBuffer(bytes)) buf = bytes
    else if (bytes instanceof Uint8Array) buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    else if (bytes instanceof ArrayBuffer) buf = Buffer.from(bytes)
    else return notImage()
    if (buf.length > limits.maxBytes) return tooLarge()
    return store(paneId, Buffer.from(buf), name)
  }

  // A dropped or picked file: copied only when it is a real image file.
  function importFile({ paneId, path, thumb = false } = {}) {
    if (typeof path !== 'string' || !path || path.length > 4096 || path.includes('\0') || !isAbsolute(path)) return notImage()
    const unreadable = () => fail(t('main.chat.image.unreadable', 'This file could not be read.'))
    let st
    try {
      st = fs.lstatSync(path)
    } catch {
      return unreadable()
    }
    if (st.isSymbolicLink()) return fail(t('main.chat.image.link', 'Links cannot be attached: drop the image itself.'))
    if (!st.isFile()) return notImage()
    if (st.size > limits.maxBytes) return tooLarge()
    let fd = null
    try {
      fd = fs.openSync(path, 'r')
      // The file opened is still a plain file within the cap (not swapped since).
      const fst = fs.fstatSync(fd)
      if (!fst.isFile()) return notImage()
      if (fst.size > limits.maxBytes) return tooLarge()
      const buf = Buffer.alloc(Math.min(fst.size, limits.maxBytes) + 1)
      let read = 0
      while (read < buf.length) {
        const n = fs.readSync(fd, buf, read, buf.length - read, read)
        if (!n) break
        read += n
      }
      if (read > limits.maxBytes) return tooLarge()
      return store(paneId, buf.subarray(0, read), basename(path), thumb === true)
    } catch {
      return unreadable()
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd)
        } catch {
          /* closed */
        }
      }
    }
  }

  // The pane's images for a message, in order; the whole list or an error.
  function take(paneId, ids) {
    if (!Array.isArray(ids) || !ids.length) return { ok: true, images: [] }
    if (ids.length > limits.perMessage) return fail(t('main.chat.image.perMessage', 'At most {{n}} images per message.', { n: String(limits.perMessage) }))
    const out = []
    const seen = new Set()
    for (const id of ids) {
      const img = typeof id === 'string' && IMAGE_ID.test(id) ? images.get(id) : null
      if (!img || img.paneId !== paneId || img.taken || seen.has(id) || !fs.existsSync(img.file)) {
        return fail(t('main.chat.image.gone', 'An attached image is no longer available. Attach it again.'))
      }
      seen.add(id)
      out.push(img)
    }
    // Sent once: a message's images belong to it now (released with its turn).
    for (const img of out) img.taken = true
    return { ok: true, images: out }
  }

  // A terminal agent's chat view (its composer types into the terminal): the
  // pane's images for a message as the files of Tessel's own copies, whose
  // paths are pasted into the agent's input (Claude Code and Codex attach a
  // pasted image path). Taken once like a chat message's; the agent reads a
  // pasted image at once (Claude) or when the message is submitted (Codex),
  // so each copy is removed a while later (no turn end tells it here).
  const handOffTimers = new Map()
  function handOff(paneId, ids) {
    const r = take(paneId, ids)
    if (!r.ok) return r
    for (const img of r.images) {
      const timer = setTimeout(() => {
        handOffTimers.delete(img.id)
        release([img.id])
      }, limits.handOffKeepMs ?? HANDOFF_KEEP_MS)
      if (timer && typeof timer.unref === 'function') timer.unref()
      handOffTimers.set(img.id, timer)
    }
    return { ok: true, paths: r.images.map((img) => img.file) }
  }

  // What an adapter gets for one image: its file, type, name, and its data
  // read when needed (base64; for Claude a large png/jpeg is shrunk).
  function forAgent(img) {
    return {
      id: img.id,
      path: img.file,
      mime: img.mime,
      name: img.name,
      width: img.width,
      height: img.height,
      base64: () => fs.readFileSync(img.file).toString('base64'),
      claudeImage: () => claudeImage(img)
    }
  }

  // Claude's API refuses an image over 5 MB (its base64): a larger png/jpeg
  // is scaled down and sent as JPEG; anything else goes as is.
  const CLAUDE_MAX = 5 * 1024 * 1024
  function claudeImage(img) {
    const buf = fs.readFileSync(img.file)
    if (Math.ceil(buf.length / 3) * 4 <= CLAUDE_MAX || !nativeImage || !['image/png', 'image/jpeg'].includes(img.mime)) {
      return { mime: img.mime, data: buf.toString('base64') }
    }
    try {
      let pic = nativeImage.createFromBuffer(buf)
      for (const side of [2048, 1600, 1200]) {
        const { width, height } = pic.getSize()
        if (Math.max(width, height) > side) pic = pic.resize(width >= height ? { width: side, quality: 'good' } : { height: side, quality: 'good' })
        const out = pic.toJPEG(85)
        if (out.length && Math.ceil(out.length / 3) * 4 <= CLAUDE_MAX) return { mime: 'image/jpeg', data: out.toString('base64') }
      }
    } catch (err) {
      warn(`image shrink failed: ${err?.message || err}`)
    }
    return { mime: img.mime, data: buf.toString('base64') }
  }

  function removeFile(file) {
    try {
      fs.unlinkSync(file)
    } catch {
      /* in use or gone */
    }
  }
  function release(ids) {
    for (const id of ids || []) {
      const img = images.get(id)
      if (!img) continue
      images.delete(id)
      removeFile(img.file)
    }
  }
  // A chip removed in the composer (its own pane only).
  function discard({ paneId, id } = {}) {
    const img = images.get(id)
    if (!img || img.paneId !== paneId || img.taken) return { ok: false }
    release([id])
    return { ok: true }
  }
  // The pane closed: every image it still holds (chips, queued messages).
  function releasePane(paneId, keep = new Set()) {
    release([...images.values()].filter((img) => img.paneId === paneId && !keep.has(img.id)).map((img) => img.id))
  }
  // Copies left by an earlier run (a crash, a quit mid-turn), after a day.
  function sweep() {
    let names = []
    try {
      names = fs.readdirSync(dir)
    } catch {
      return
    }
    const known = new Set([...images.values()].map((img) => basename(img.file)))
    for (const name of names) {
      if (known.has(name)) continue
      const file = join(dir, name)
      try {
        const st = fs.lstatSync(file)
        if (st.isFile() && now() - st.mtimeMs > DAY) fs.unlinkSync(file)
      } catch {
        /* in use or gone */
      }
    }
  }

  const obj = (q) => (q && typeof q === 'object' && !Array.isArray(q) ? q : {})
  function register(ipcMain, validPaneId) {
    ipcMain.handle('chat:imageSave', (_e, q) => {
      const { paneId, bytes, name } = obj(q)
      if (!validPaneId(paneId) || (name != null && typeof name !== 'string')) return notImage()
      return saveBytes({ paneId, bytes, name })
    })
    ipcMain.handle('chat:imageImport', (_e, q) => {
      const { paneId, path, thumb } = obj(q)
      if (!validPaneId(paneId)) return notImage()
      return importFile({ paneId, path, thumb: thumb === true })
    })
    ipcMain.handle('chat:imagePaths', (_e, q) => {
      const { paneId, ids } = obj(q)
      if (!validPaneId(paneId) || !Array.isArray(ids) || !ids.length || ids.some((id) => typeof id !== 'string' || !IMAGE_ID.test(id))) return notImage()
      return handOff(paneId, ids)
    })
    ipcMain.handle('chat:imageDiscard', (_e, q) => {
      const { paneId, id } = obj(q)
      if (!validPaneId(paneId) || typeof id !== 'string' || !IMAGE_ID.test(id)) return { ok: false }
      return discard({ paneId, id })
    })
  }

  return { saveBytes, importFile, take, handOff, forAgent, release, discard, releasePane, sweep, register, publicImage, has: (id) => images.has(id) }
}
