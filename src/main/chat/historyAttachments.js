// The images and files of a conversation's earlier history
// (transcriptHistory.js, transcriptView.js): a user message's attachments,
// shown like a sent message's (an image as a thumbnail, a data: URL; any other
// file as a chip: name, type, size, the file itself when it is still an
// existing local file), and the images a tool gave back (a screenshot, an
// image file it read), on its result.
//
// Two steps: while the lines are read, each entry notes what it held
// (candidates: inline base64, a data: URL, a local path); once the page is
// cut to its final events, resolveHistoryAttachments turns them into images
// and files, newest entry first (the page's image budget goes to the most
// recent ones). The shape every entry gets is described at "Resolution".
//
// Bounded: png, jpeg, gif, webp only, by the decoded bytes' magic (never by a
// declared type or a name); at most ATTACHMENT_LIMITS.images per entry, each
// at most imageBytes decoded, pageImages and pageBytes of images per page; at
// most `files` file chips per message. A local path: absolute, an existing regular file
// (not a link, not reached through a link or junction: its real path is the
// path itself), checked again on the opened handle, read with the size cap.
// Nothing is ever logged about an image (no data, no path).
import fs from 'fs'
import { createHash } from 'crypto'
import { basename, extname, isAbsolute, resolve } from 'path'
import { fileURLToPath } from 'url'
import { sniffImage } from './chatImages.js'

export const ATTACHMENT_LIMITS = { images: 4, imageBytes: 2 * 1024 * 1024, pageImages: 40, pageBytes: 12 * 1024 * 1024, files: 8, name: 120 }

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
// image: { kind: 'image', base64?, dataUrl?, path?, mediaType?, name?, source?,
//   secondary?, fallback? } (none of the three: an image that cannot be shown,
//   such as a remote URL). source: 'user' (attached to a message), 'pasted'
//   (pasted in a terminal: "[Image #N]"), 'tool' (a tool's result); default
//   'user'. secondary: another copy of an image the entry may already hold
//   inline (a path the agent also read back as bytes): left out when the
//   entry shows any image of its own. fallback: another candidate for the same
//   image, tried when this one cannot be shown (a pasted file gone from
//   %TEMP%: the bytes the transcript kept).
// file: { kind: 'file', name?, mediaType?, base64?, dataUrl?, text?, path? }.

const SOURCES = new Set(['user', 'pasted', 'tool'])
const withSource = (c, source) => (SOURCES.has(source) ? { ...c, source } : c)

export const imageFromBase64 = (base64, mediaType, name, source) => withSource({ kind: 'image', base64: str(base64), mediaType: cleanType(mediaType), name }, source)
export function imageFromUrl(url, name, source) {
  const u = str(url)
  if (u && /^data:/i.test(u)) return withSource({ kind: 'image', dataUrl: u, name }, source)
  const p = localPath(u)
  return withSource(p ? { kind: 'image', path: p, name: name ?? p } : { kind: 'image', name }, source)
}
export const imageFromPath = (path, name, source) => withSource({ kind: 'image', path: localPath(path), name: name ?? path }, source)

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

// Marks a history event (a user message, a tool result) with what it held.
// marked: its text already names its images ("[Image #1]"): a lost one adds
// no "[image]". Called again for the same event, the candidates add up (a
// tool's images reported apart from its result).
export function noteAttachments(event, list, { marked = false } = {}) {
  const items = (Array.isArray(list) ? list : []).filter((c) => c && (c.kind === 'image' || c.kind === 'file'))
  if (!event || !items.length) return event
  const prior = pending.get(event)
  if (prior) prior.list.push(...items)
  else pending.set(event, { list: items, marked })
  return event
}
export const hasPendingAttachments = (event) => pending.has(event)

// ---- Resolution ------------------------------------------------------------------
// Every entry gets the same shape (the contract the chat UI reads):
//   ev.images: [{ key, dataUrl?, source, mime, mediaType, name, bytes }] for an
//     image shown (dataUrl left out once a chat view already has that key);
//   [{ source, name, mime?, path, missing: true }]: a local file no longer there;
//   [{ source, name, mime?, path, remote: true }]: a file on the SSH host the
//     transcript came from (fetched by the window through remoteFs, never read
//     here);
//   ev.imagesMore: how many more images the entry held that are not listed
//     (over a cap, unreadable, not an image); a user message also says
//     "[image]" for each in its text (unless its text names them already).
// Caps: `images` per entry, `pageImages` and `pageBytes` per page (the newest
// entries first).

const EXT_TYPE = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }
const typeOfPath = (p) => EXT_TYPE[extname(String(p || '')).slice(1).toLowerCase()] || ''

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
  const ext = IMAGE_EXT[mediaType] || 'png'
  if (c.name) return cleanName(c.name, `image.${ext}`) // i18n-ignore
  let name = `image.${ext}` // i18n-ignore
  for (let n = 2; used.has(name); n++) name = `image-${n}.${ext}` // i18n-ignore
  used.add(name)
  return name
}

const sha = (s) => createHash('sha1').update(s).digest('hex')
const dataUrlOf = (got) => `data:${got.mediaType};base64,${got.buf.toString('base64')}`
const pathOnly = (c) => !!c.path && !c.base64 && !c.dataUrl

// A local path: 'ok' (an existing regular file reached directly), 'missing'
// (nothing there any more), 'refused' (a folder, a link, a junction on the way).
function pathState(path) {
  const p = localPath(path)
  if (!p) return 'refused'
  try {
    const st = fs.lstatSync(p)
    if (st.isSymbolicLink() || !st.isFile()) return 'refused'
    return samePath(fs.realpathSync.native(p), p) ? 'ok' : 'refused'
  } catch (err) {
    return err && (err.code === 'ENOENT' || err.code === 'ENOTDIR') ? 'missing' : 'refused'
  }
}

// One candidate -> { shown: { key, hash, mediaType, bytes, dataUrl } } |
// { missing: path } | { remote: path } | {} (lost). local: false, a host's
// transcript (its paths are the host's).
function stateOf(c, caps, local) {
  const viaFallback = () => (c.fallback ? stateOf(c.fallback, caps, local) : {})
  if (pathOnly(c)) {
    if (!local) {
      const fb = viaFallback()
      return fb.shown ? fb : { remote: c.path }
    }
    const st = pathState(c.path)
    const got = st === 'ok' ? resolveImage(c, caps) : null
    if (got) {
      const hash = sha(got.buf)
      return { shown: { key: hash.slice(0, 24), hash, mediaType: got.mediaType, bytes: got.buf.length, dataUrl: dataUrlOf(got) } }
    }
    const fb = viaFallback()
    if (fb.shown) return fb
    return st === 'missing' ? { missing: c.path } : {}
  }
  const got = resolveImage(c, caps)
  if (!got) return viaFallback()
  const hash = sha(got.buf)
  return { shown: { key: hash.slice(0, 24), hash, mediaType: got.mediaType, bytes: got.buf.length, dataUrl: dataUrlOf(got) } }
}

// The page's shared budget: bytes and images shown, newest entries first.
const pageBudget = (caps) => ({ bytes: caps.pageBytes, images: Number.isInteger(caps.pageImages) ? caps.pageImages : Infinity })

// One entry's candidates -> its images, files and placeholders (in place).
// A generator, so the same choice runs synchronously (the history) or with
// awaited reads (the chat view): it yields { image: c, dataless } (answered
// with a stateOf-like result) and { file: c } (answered with its chip).
function* placeEntry(ev, note, caps, budget) {
  const images = []
  const files = []
  const names = new Set()
  const hashes = new Set()
  let lost = 0
  let lostFiles = 0
  // Another copy of an image comes after the entry's own (left out when one shows).
  const list = [...note.list.filter((c) => !c.secondary), ...note.list.filter((c) => c.secondary)]
  for (const c of list) {
    if (c.kind === 'file') {
      if (files.length >= caps.files) lostFiles++
      else files.push(yield { file: c })
      continue
    }
    if (c.secondary && images.some((i) => i.key)) continue
    if (images.length >= caps.images) {
      lost++
      continue
    }
    const source = SOURCES.has(c.source) ? c.source : 'user'
    // Over the page's budget: a file's absence is still told (nothing is read).
    const r = budget.bytes > 0 && budget.images > 0 ? (yield { image: c, dataless: false }) : pathOnly(c) ? (yield { image: c, dataless: true }) : {}
    if (r.shown) {
      // The same image twice in a tool's entry (its result and a copy): once.
      if (source === 'tool' && hashes.has(r.shown.hash)) continue
      if (r.shown.bytes > budget.bytes || budget.images <= 0) {
        lost++
        continue
      }
      hashes.add(r.shown.hash)
      budget.bytes -= r.shown.bytes
      budget.images--
      const { mediaType, key, bytes, dataUrl } = r.shown
      images.push({ key, name: imageName(c, mediaType, names), source, mime: mediaType, mediaType, bytes, dataUrl })
    } else if (r.missing || r.remote) {
      const path = r.missing || r.remote
      const mime = cleanType(c.mediaType) && IMAGE_TYPES.has(cleanType(c.mediaType)) ? cleanType(c.mediaType) : typeOfPath(path)
      images.push({ source, name: cleanName(c.name || path, 'image'), ...(mime ? { mime } : {}), path, ...(r.missing ? { missing: true } : { remote: true }) }) // i18n-ignore
    } else lost++
  }
  if (images.length) ev.images = images
  if (files.length) ev.files = files
  if (lost) ev.imagesMore = lost
  // A user message says what it lost in its text; a tool's result never
  // changes its output.
  if (ev.type !== 'toolResult' && ev.type !== 'tool') {
    let text = typeof ev.text === 'string' ? ev.text : ''
    if (!note.marked) text = imagePlaceholders(text, lost)
    text = placeholders(text, lostFiles, '[file]') // i18n-ignore
    ev.text = text
  }
}

// Turns the noted candidates of `events` into their images and files (in
// place), newest event first; what cannot be shown becomes placeholder text.
// local: false (a transcript read from an SSH host): a path it names is the
// host's, never read on this PC (only inline images are shown; a path is
// listed as remote).
export function resolveHistoryAttachments(events, caps = ATTACHMENT_LIMITS, { local = true } = {}) {
  const budget = pageBudget(caps)
  const resolve = (c, { dataless = false } = {}) => (dataless ? (local ? (pathState(c.path) === 'missing' ? { missing: c.path } : {}) : { remote: c.path }) : stateOf(c, caps, local))
  const fileOf = (c) => resolveFile(local ? c : { ...c, path: null })
  for (let i = (Array.isArray(events) ? events.length : 0) - 1; i >= 0; i--) {
    const ev = events[i]
    const note = pending.get(ev)
    if (!note) continue
    pending.delete(ev)
    const run = placeEntry(ev, note, caps, budget)
    for (let step = run.next(); !step.done; ) step = run.next(step.value.file ? fileOf(step.value.file) : resolve(step.value.image, step.value))
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
// cache: Map (the view's), pruned to the images of this page. host: the
// transcript is an SSH host's (its paths are listed as remote, never read).

const IMAGE_READ_TIMEOUT_MS = 2000

function withDeadline(promise, ms) {
  let timer
  return Promise.race([promise, new Promise((r) => (timer = setTimeout(() => r(null), ms)))]).finally(() => clearTimeout(timer))
}

// { state: 'ok', file: { path, size, mtimeMs } } for an existing regular local
// file reached directly (no link on the way, not on a network drive);
// { state: 'missing' } when nothing is there; null otherwise.
async function pathStateAsync(path, isRemote) {
  const p = localPath(path)
  if (!p) return null
  try {
    if (isRemote && (await isRemote(p))) return null
    const st = await fs.promises.lstat(p)
    if (st.isSymbolicLink() || !st.isFile()) return null
    if (!samePath(await fs.promises.realpath(p), p)) return null
    return { state: 'ok', file: { path: p, size: st.size, mtimeMs: st.mtimeMs } }
  } catch (err) {
    return err && (err.code === 'ENOENT' || err.code === 'ENOTDIR') ? { state: 'missing' } : null
  }
}
async function plainFileAsync(path, isRemote) {
  const r = await pathStateAsync(path, isRemote)
  return r && r.state === 'ok' ? r.file : null
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

// The candidate's identity (what it holds), before any decoding:
// { id, file? } | { missing: true } | null.
async function imageIdentity(c, isRemote, timeoutMs) {
  if (c.base64) return { id: `b|${c.mediaType || ''}|${sha(c.base64)}` }
  if (c.dataUrl) return { id: `d|${sha(c.dataUrl)}` }
  if (c.path) {
    const r = await withDeadline(pathStateAsync(c.path, isRemote), timeoutMs)
    if (r && r.state === 'missing') return { missing: true }
    return r && r.state === 'ok' ? { id: `p|${r.file.path}|${r.file.size}|${r.file.mtimeMs}`, file: r.file } : null
  }
  return null
}

async function resolveImageCached(c, caps, cache, used, isRemote, timeoutMs) {
  const who = await imageIdentity(c, isRemote, timeoutMs)
  if (!who || who.missing) return who
  if (cache.has(who.id)) {
    used.add(who.id)
    return { entry: cache.get(who.id) }
  }
  let got = null
  if (who.file) {
    const buf = await withDeadline(readLocalAsync(who.file, caps.imageBytes), timeoutMs)
    const mediaType = buf ? sniffImage(buf) : null
    got = mediaType ? { buf, mediaType } : null
  } else got = resolveImage(c, caps)
  const entry = got ? { key: sha(who.id).slice(0, 24), hash: sha(got.buf), mediaType: got.mediaType, bytes: got.buf.length, dataUrl: dataUrlOf(got) } : null
  cache.set(who.id, entry)
  used.add(who.id)
  return { entry }
}

// One candidate as stateOf says it, from the view's cache.
async function stateCached(c, ctx, { dataless = false } = {}) {
  const { caps, cache, used, isRemote, timeoutMs, host } = ctx
  const viaFallback = () => (c.fallback ? stateCached(c.fallback, ctx, { dataless }) : {})
  if (pathOnly(c) && host) {
    const fb = dataless ? {} : await viaFallback()
    return fb.shown ? fb : { remote: c.path }
  }
  if (dataless) {
    if (!pathOnly(c)) return {}
    const who = await imageIdentity(c, isRemote, timeoutMs)
    return who && who.missing ? { missing: c.path } : {}
  }
  const r = await resolveImageCached(c, caps, cache, used, isRemote, timeoutMs)
  if (r && r.entry) return { shown: r.entry }
  const fb = await viaFallback()
  if (fb.shown) return fb
  return r && r.missing ? { missing: c.path } : {}
}

async function resolveFileAsync(c, isRemote, timeoutMs, host) {
  const out = resolveFile({ ...c, path: null })
  const local = c.path && !host ? await withDeadline(plainFileAsync(c.path, isRemote), timeoutMs) : null
  return local ? { ...out, size: local.size, path: local.path } : out
}

export async function resolveHistoryAttachmentsCached(events, caps = ATTACHMENT_LIMITS, { cache = new Map(), isRemote = null, timeoutMs = IMAGE_READ_TIMEOUT_MS, host = false } = {}) {
  const budget = pageBudget(caps)
  const used = new Set()
  const ctx = { caps, cache, used, isRemote, timeoutMs, host }
  const resolve = (c, opts) => stateCached(c, ctx, opts)
  const fileOf = (c) => resolveFileAsync(c, isRemote, timeoutMs, host)
  for (let i = (Array.isArray(events) ? events.length : 0) - 1; i >= 0; i--) {
    const ev = events[i]
    const note = pending.get(ev)
    if (!note) continue
    pending.delete(ev)
    const run = placeEntry(ev, note, caps, budget)
    for (let step = run.next(); !step.done; ) step = run.next(step.value.file ? await fileOf(step.value.file) : await resolve(step.value.image, step.value))
  }
  // Only this page's images stay (a view's memory follows what it shows).
  for (const id of [...cache.keys()]) if (!used.has(id)) cache.delete(id)
  return events
}

// ---- Live chat frames ------------------------------------------------------------
// A live tool result's images (claudeFrames.js, codexChat.js), in the same
// shape: inline bytes checked like the history's (magic bytes, the size cap),
// at most `images` per entry; a path is listed for the window to fetch (never
// read here: the frame normalizers do no I/O). Each item:
// { base64, mediaType } | { dataUrl } | { path, remote? } | { bad: true }.
// -> { images, imagesMore } (images absent when none).
export function liveImages(items, caps = ATTACHMENT_LIMITS) {
  const images = []
  const hashes = new Set()
  const names = new Set()
  let more = 0
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || typeof it !== 'object') continue
    if (images.length >= caps.images) {
      more++
      continue
    }
    const p = typeof it.path === 'string' ? (it.remote ? (it.path.startsWith('/') && !it.path.includes('\0') ? it.path : null) : localPath(it.path)) : null
    if (p) {
      const mime = typeOfPath(p)
      images.push({ source: 'tool', name: cleanName(p, 'image'), ...(mime ? { mime } : {}), path: p, ...(it.remote ? { remote: true } : {}) }) // i18n-ignore
      continue
    }
    const got = it.bad ? null : resolveImage({ base64: str(it.base64), dataUrl: str(it.dataUrl), mediaType: cleanType(it.mediaType) }, caps)
    if (!got) {
      more++
      continue
    }
    const hash = sha(got.buf)
    if (hashes.has(hash)) continue
    hashes.add(hash)
    images.push({ key: hash.slice(0, 24), name: imageName({ name: it.name }, got.mediaType, names), source: 'tool', mime: got.mediaType, mediaType: got.mediaType, bytes: got.buf.length, dataUrl: dataUrlOf(got) })
  }
  return { ...(images.length ? { images } : {}), ...(more ? { imagesMore: more } : {}) }
}
