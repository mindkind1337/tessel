// The images and files attached to a user message of a conversation's
// earlier history (transcriptHistory.js), shown like a sent message's: an
// image as a thumbnail (a data: URL), any other file as a chip (name, type,
// size; the file itself when it is still an existing local file).
//
// Two steps: while the lines are read, each user message notes what it held
// (candidates: inline base64, a data: URL, a local path); once the page is
// cut to its final events, resolveHistoryAttachments turns them into images
// and files, newest message first (the page's image budget goes to the most
// recent ones). What cannot be shown becomes the "[image]" / "[file]" text.
//
// Bounded: png, jpeg, gif, webp only, by the decoded bytes' magic (never by a
// declared type or a name); at most ATTACHMENT_LIMITS.images per message, each
// at most imageBytes decoded, pageBytes of images per page; at most `files`
// file chips per message. A local path: absolute, an existing regular file
// (not a link, not reached through a link or junction: its real path is the
// path itself), checked again on the opened handle, read with the size cap.
// Nothing is ever logged about an image (no data, no path).
import fs from 'fs'
import { createHash } from 'crypto'
import { basename, extname, isAbsolute, resolve } from 'path'
import { fileURLToPath } from 'url'
import { sniffImage } from './chatImages.js'

export const ATTACHMENT_LIMITS = { images: 4, imageBytes: 2 * 1024 * 1024, pageBytes: 12 * 1024 * 1024, files: 8, name: 120 }

const IMAGE_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }
const IMAGE_TYPES = new Set(Object.keys(IMAGE_EXT))
const MEDIA_TYPE = /^[a-z0-9][\w.+-]{0,63}\/[a-z0-9][\w.+-]{0,127}$/i
const DATA_URL = /^data:([^;,]{0,200})((?:;[^;,]{0,100}){0,8}),/i
const BASE64 = /^[A-Za-z0-9+/_-]*={0,2}$/

// event -> { list: candidates, marked } (the event is the key: nothing added to it).
const pending = new WeakMap()

export const imagePlaceholders = (text, n) => placeholders(text, n, '[image]') // i18n-ignore
const placeholders = (text, n, mark) => (n > 0 ? [text, Array(n).fill(mark).join(' ')].filter(Boolean).join('\n') : text)

const str = (v) => (typeof v === 'string' && v ? v : null)

// A shown name: one line, no folder, bounded.
export function cleanName(name, fallback) {
  let s = typeof name === 'string' ? basename(name.replace(/\\/g, '/')) : ''
  s = s.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').trim() // eslint-disable-line no-control-regex
  if (!s) s = fallback
  if (s.length > ATTACHMENT_LIMITS.name) {
    const ext = extname(s).slice(0, 10)
    s = s.slice(0, ATTACHMENT_LIMITS.name - ext.length) + ext
  }
  return s
}
const cleanType = (t) => (typeof t === 'string' && MEDIA_TYPE.test(t.trim()) ? t.trim().toLowerCase() : '')

// "data:<type>;base64,<data>" -> { mediaType, base64 } (base64 only), or null.
export function parseDataUrl(url) {
  if (typeof url !== 'string') return null
  const m = DATA_URL.exec(url.slice(0, 400))
  if (!m || !/;base64$/i.test(m[2])) return null
  return { mediaType: cleanType(m[1]), base64: url.slice(m[0].length) }
}

// A local path given as a path or a file: URL, or null.
export function localPath(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0')) return null
  let p = value
  if (/^file:/i.test(p)) {
    try {
      p = fileURLToPath(p)
    } catch {
      return null
    }
  }
  // Never a network or device path (\\server\share, //server, \\?\, \\.\):
  // touching one from a conversation's text could send Windows credentials
  // to that server.
  if (/^[\\/]{2}/.test(p)) return null
  return isAbsolute(p) ? p : null
}

// Decoded size of a base64 string, without decoding it.
const base64Size = (s) => Math.max(0, Math.floor((s.replace(/=+$/, '').length * 3) / 4))

function decode(base64, max) {
  if (typeof base64 !== 'string' || !base64) return null
  const s = base64.replace(/\s+/g, '')
  if (base64Size(s) > max || !BASE64.test(s)) return null
  const buf = Buffer.from(s, s.includes('-') || s.includes('_') ? 'base64url' : 'base64')
  return buf.length && buf.length <= max ? buf : null
}

const samePath = (a, b) => (process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b))

// { size } of an existing regular local file reached directly (no link on
// the way), or null.
export function plainFile(path) {
  const p = localPath(path)
  if (!p) return null
  try {
    const st = fs.lstatSync(p)
    if (st.isSymbolicLink() || !st.isFile()) return null
    if (!samePath(fs.realpathSync.native(p), p)) return null
    return { path: p, size: st.size }
  } catch {
    return null
  }
}

// A local image file's bytes (at most `max`), or null.
function readLocal(path, max) {
  const f = plainFile(path)
  if (!f || f.size > max) return null
  let fd = null
  try {
    fd = fs.openSync(f.path, 'r')
    const st = fs.fstatSync(fd)
    if (!st.isFile() || st.size > max) return null
    const buf = Buffer.alloc(Math.min(st.size, max) + 1)
    let got = 0
    while (got < buf.length) {
      const n = fs.readSync(fd, buf, got, buf.length - got, got)
      if (!n) break
      got += n
    }
    return got && got <= max ? buf.subarray(0, got) : null
  } catch {
    return null
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

// ---- Candidates (what a transcript line held) ---------------------------------
// image: { kind: 'image', base64?, dataUrl?, path?, mediaType?, name? } (none of
//   the three: an image that cannot be shown, such as a remote URL);
// file: { kind: 'file', name?, mediaType?, base64?, dataUrl?, text?, path? }.

export const imageFromBase64 = (base64, mediaType, name) => ({ kind: 'image', base64: str(base64), mediaType: cleanType(mediaType), name })
export function imageFromUrl(url, name) {
  const u = str(url)
  if (u && /^data:/i.test(u)) return { kind: 'image', dataUrl: u, name }
  const p = localPath(u)
  return p ? { kind: 'image', path: p, name: name ?? p } : { kind: 'image', name }
}
export const imageFromPath = (path, name) => ({ kind: 'image', path: localPath(path), name: name ?? path })

export function fileCandidate({ name, mediaType, base64, dataUrl, text, path } = {}) {
  const p = localPath(path)
  const d = str(dataUrl)
  return {
    kind: 'file',
    name: str(name) || (p ? basename(p) : null),
    mediaType: cleanType(mediaType) || (d ? parseDataUrl(d)?.mediaType || '' : ''),
    ...(str(base64) ? { base64 } : {}),
    ...(d ? { dataUrl: d } : {}),
    ...(typeof text === 'string' ? { text } : {}),
    ...(p ? { path: p } : {})
  }
}

// Marks a history user event with what it held. marked: its text already
// names its images ("[Image #1]"): a missing one adds no "[image]".
export function noteAttachments(event, list, { marked = false } = {}) {
  const items = (Array.isArray(list) ? list : []).filter((c) => c && (c.kind === 'image' || c.kind === 'file'))
  if (event && items.length) pending.set(event, { list: items, marked })
  return event
}
export const hasPendingAttachments = (event) => pending.has(event)

// ---- Resolution ------------------------------------------------------------------

function resolveImage(c, caps) {
  let buf = null
  let declared = c.mediaType || ''
  if (c.base64) buf = decode(c.base64, caps.imageBytes)
  else if (c.dataUrl) {
    const d = parseDataUrl(c.dataUrl)
    if (d) {
      declared = d.mediaType
      buf = decode(d.base64, caps.imageBytes)
    }
  } else if (c.path) buf = readLocal(c.path, caps.imageBytes)
  if (!buf) return null
  // A declared type that is not an image Tessel shows: refused, whatever the bytes.
  if (declared && !IMAGE_TYPES.has(declared)) return null
  const mediaType = sniffImage(buf)
  if (!mediaType) return null
  return { buf, mediaType }
}

function resolveFile(c) {
  let size = null
  if (c.base64) size = base64Size(c.base64.replace(/\s+/g, ''))
  else if (c.dataUrl) {
    const d = parseDataUrl(c.dataUrl)
    if (d) size = base64Size(d.base64.replace(/\s+/g, ''))
  } else if (typeof c.text === 'string') size = Buffer.byteLength(c.text, 'utf8')
  const local = c.path ? plainFile(c.path) : null
  if (local) size = local.size
  return {
    name: cleanName(c.name, 'file'), // i18n-ignore
    mediaType: c.mediaType || '',
    ...(Number.isFinite(size) ? { size } : {}),
    ...(local ? { path: local.path } : {})
  }
}

// Unique shown names for a message's unnamed images: image.png, image-2.png…
function imageName(c, mediaType, used) {
  const ext = IMAGE_EXT[mediaType]
  if (c.name) return cleanName(c.name, `image.${ext}`) // i18n-ignore
  let name = `image.${ext}` // i18n-ignore
  for (let n = 2; used.has(name); n++) name = `image-${n}.${ext}` // i18n-ignore
  used.add(name)
  return name
}

// Turns the noted candidates of `events` into their images and files (in
// place), newest event first; what cannot be shown becomes placeholder text.
export function resolveHistoryAttachments(events, caps = ATTACHMENT_LIMITS) {
  let budget = caps.pageBytes
  for (let i = (Array.isArray(events) ? events.length : 0) - 1; i >= 0; i--) {
    const ev = events[i]
    const note = pending.get(ev)
    if (!note) continue
    pending.delete(ev)
    const images = []
    const files = []
    const used = new Set()
    let lostImages = 0
    let lostFiles = 0
    for (const c of note.list) {
      if (c.kind === 'file') {
        if (files.length >= caps.files) lostFiles++
        else files.push(resolveFile(c))
        continue
      }
      const got = images.length < caps.images && budget > 0 ? resolveImage(c, caps) : null
      if (!got || got.buf.length > budget) {
        lostImages++
        continue
      }
      budget -= got.buf.length
      images.push({ name: imageName(c, got.mediaType, used), mediaType: got.mediaType, dataUrl: `data:${got.mediaType};base64,${got.buf.toString('base64')}` })
    }
    if (images.length) ev.images = images
    if (files.length) ev.files = files
    let text = typeof ev.text === 'string' ? ev.text : ''
    if (!note.marked) text = imagePlaceholders(text, lostImages)
    text = placeholders(text, lostFiles, '[file]') // i18n-ignore
    ev.text = text
  }
  return events
}

// ---- The chat view's resolution: cached per view, never blocking -------------------
// The same choice as resolveHistoryAttachments (newest first, the same caps),
// for a view read again after every change of its file: each image is
// decoded once per view and kept in `cache` (by its content, or a file's
// path, size and change time), and a local file is read with fs.promises,
// never on a network drive (isRemote) and given up after timeoutMs (a
// stalled disk shows "[image]", the view goes on). Each image gets a `key`
// (the same for the same image) so the view can send its bytes only once.
// cache: Map (the view's), pruned to the images of this page.

const IMAGE_READ_TIMEOUT_MS = 2000

function withDeadline(promise, ms) {
  let timer
  return Promise.race([promise, new Promise((r) => (timer = setTimeout(() => r(null), ms)))]).finally(() => clearTimeout(timer))
}

// { path, size, mtimeMs } of an existing regular local file reached directly
// (no link on the way, not on a network drive), or null.
async function plainFileAsync(path, isRemote) {
  const p = localPath(path)
  if (!p) return null
  try {
    if (isRemote && (await isRemote(p))) return null
    const st = await fs.promises.lstat(p)
    if (st.isSymbolicLink() || !st.isFile()) return null
    if (!samePath(await fs.promises.realpath(p), p)) return null
    return { path: p, size: st.size, mtimeMs: st.mtimeMs }
  } catch {
    return null
  }
}

async function readLocalAsync(f, max) {
  if (!f || f.size > max) return null
  let handle = null
  try {
    handle = await fs.promises.open(f.path, 'r')
    const st = await handle.stat()
    if (!st.isFile() || st.size > max) return null
    const buf = Buffer.alloc(Math.min(st.size, max) + 1)
    let got = 0
    while (got < buf.length) {
      const { bytesRead } = await handle.read(buf, got, buf.length - got, got)
      if (!bytesRead) break
      got += bytesRead
    }
    return got && got <= max ? buf.subarray(0, got) : null
  } catch {
    return null
  } finally {
    if (handle) await handle.close().catch(() => {})
  }
}

const sha = (s) => createHash('sha1').update(s).digest('hex')

// The candidate's identity (what it holds), before any decoding, or null.
async function imageIdentity(c, isRemote, timeoutMs) {
  if (c.base64) return { id: `b|${c.mediaType || ''}|${sha(c.base64)}` }
  if (c.dataUrl) return { id: `d|${sha(c.dataUrl)}` }
  if (c.path) {
    const f = await withDeadline(plainFileAsync(c.path, isRemote), timeoutMs)
    return f ? { id: `p|${f.path}|${f.size}|${f.mtimeMs}`, file: f } : null
  }
  return null
}

async function resolveImageCached(c, caps, cache, used, isRemote, timeoutMs) {
  const who = await imageIdentity(c, isRemote, timeoutMs)
  if (!who) return null
  if (cache.has(who.id)) {
    used.add(who.id)
    return cache.get(who.id)
  }
  let got = null
  if (who.file) {
    const buf = await withDeadline(readLocalAsync(who.file, caps.imageBytes), timeoutMs)
    const mediaType = buf ? sniffImage(buf) : null
    got = mediaType ? { buf, mediaType } : null
  } else got = resolveImage(c, caps)
  const entry = got
    ? { key: sha(who.id).slice(0, 24), mediaType: got.mediaType, bytes: got.buf.length, dataUrl: `data:${got.mediaType};base64,${got.buf.toString('base64')}` }
    : null
  cache.set(who.id, entry)
  used.add(who.id)
  return entry
}

async function resolveFileAsync(c, isRemote, timeoutMs) {
  const out = resolveFile({ ...c, path: null })
  const local = c.path ? await withDeadline(plainFileAsync(c.path, isRemote), timeoutMs) : null
  return local ? { ...out, size: local.size, path: local.path } : out
}

export async function resolveHistoryAttachmentsCached(events, caps = ATTACHMENT_LIMITS, { cache = new Map(), isRemote = null, timeoutMs = IMAGE_READ_TIMEOUT_MS } = {}) {
  let budget = caps.pageBytes
  const used = new Set()
  for (let i = (Array.isArray(events) ? events.length : 0) - 1; i >= 0; i--) {
    const ev = events[i]
    const note = pending.get(ev)
    if (!note) continue
    pending.delete(ev)
    const images = []
    const files = []
    const names = new Set()
    let lostImages = 0
    let lostFiles = 0
    for (const c of note.list) {
      if (c.kind === 'file') {
        if (files.length >= caps.files) lostFiles++
        else files.push(await resolveFileAsync(c, isRemote, timeoutMs))
        continue
      }
      const got = images.length < caps.images && budget > 0 ? await resolveImageCached(c, caps, cache, used, isRemote, timeoutMs) : null
      if (!got || got.bytes > budget) {
        lostImages++
        continue
      }
      budget -= got.bytes
      images.push({ key: got.key, name: imageName(c, got.mediaType, names), mediaType: got.mediaType, dataUrl: got.dataUrl })
    }
    if (images.length) ev.images = images
    if (files.length) ev.files = files
    let text = typeof ev.text === 'string' ? ev.text : ''
    if (!note.marked) text = imagePlaceholders(text, lostImages)
    text = placeholders(text, lostFiles, '[file]') // i18n-ignore
    ev.text = text
  }
  // Only this page's images stay (a view's memory follows what it shows).
  for (const id of [...cache.keys()]) if (!used.has(id)) cache.delete(id)
  return events
}
