// Live Share: an image a guest pastes (or drops) into a host's pane.
//
// On this computer, an image pasted into an agent pane is saved to a file and
// its path pasted (TerminalPane.vue pasteImage). A guest's path would be on
// the guest's computer, meaningless on the host: so the guest's Tessel reads
// the image, makes it a PNG, and sends it to the host in parts over the
// share's request channel (shareChannel.js, feature 'paste'):
//   paste.part  { pane, upload, index, count, data }   (base64, in order)
//   paste.image { pane, upload }                       (all parts are in)
// Both need the type right on the pane's project (the host's own check,
// shareHost.js). The host keeps one upload per guest at a time, for a minute
// at most, decodes what came (a real PNG, its size read from its header
// before anything is decoded: a few hundred KB can say 8000 x 8000, 256 MB
// once decoded; so width x height is capped too), makes it a new PNG (nothing else of the
// guest's bytes is kept), saves it under its own folder for pasted images
// with a name it chooses, and pastes that path into the pane as a local
// image paste would (liveShare.js, the host's window).
//
// This file is plain data and checks: the Electron pieces (nativeImage, the
// clipboard) are given (createPasteImages).
import fs from 'fs'
import crypto from 'crypto'
import { join } from 'path'

export const PASTE_LIMITS = Object.freeze({
  bytes: 10 * 1024 * 1024, // one image's PNG at most
  side: 8000, // its width and height at most
  pixels: 25 * 1000 * 1000, // and both together (decoded, 4 bytes each: 100 MB)
  part: 512 * 1024, // one part's bytes (base64 in a request under 1 MB)
  imagesPerMinute: 6, // images one guest pastes in a minute
  uploadMs: 60 * 1000, // an upload with no new part this long is dropped
  uploadMaxMs: 2 * 60 * 1000, // and one not finished this long after its first part
  uploadsAtOnce: 3, // uploads the host holds at once, all guests together
  keepFiles: 50, // guests' images kept on the host at most (the oldest go)
  keepBytes: 200 * 1024 * 1024 // and their bytes
})
export const MAX_PARTS = Math.ceil(PASTE_LIMITS.bytes / PASTE_LIMITS.part)

// What each op needs and costs (shareHost.js opInfo): a part is light (an
// image is a score of them), the paste itself a change.
export const PASTE_OPS = Object.freeze({
  'paste.part': Object.freeze({ right: 'type', kind: 'light', bulk: false }),
  'paste.image': Object.freeze({ right: 'type', kind: 'write', bulk: false })
})

const PANE_ID = /^[\w-]{1,80}$/
const UPLOAD_ID = /^[0-9a-f]{16}$/
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/
export const isPaneId = (v) => typeof v === 'string' && PANE_ID.test(v)
export const newUploadId = () => crypto.randomBytes(8).toString('hex')

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
// A PNG's width and height, from its header (IHDR, the first chunk), or null
// when the bytes are not a PNG.
export function pngSize(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null
  if (buf.readUInt32BE(8) !== 13 || buf.toString('latin1', 12, 16) !== 'IHDR') return null
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  return width > 0 && height > 0 ? { width, height } : null
}

const tooBig = (size, limits) => size.width > limits.side || size.height > limits.side || size.width * size.height > limits.pixels

// An image's bytes checked and made again: a PNG within the caps (its size
// read from its header first, so nothing too big is ever decoded), that
// decodes to that size, as a new PNG. -> { ok: true, png, width, height } |
// { ok: false, code: 'too-large' | 'not-image' }.
export function checkPng(buf, nativeImage, limits = PASTE_LIMITS) {
  if (!Buffer.isBuffer(buf) || !buf.length) return { ok: false, code: 'not-image' }
  if (buf.length > limits.bytes) return { ok: false, code: 'too-large' }
  const size = pngSize(buf)
  if (!size) return { ok: false, code: 'not-image' }
  if (tooBig(size, limits)) return { ok: false, code: 'too-large' }
  let png
  try {
    const img = nativeImage.createFromBuffer(buf)
    if (!img || img.isEmpty()) return { ok: false, code: 'not-image' }
    const got = img.getSize()
    if (!got || got.width !== size.width || got.height !== size.height) return { ok: false, code: 'not-image' }
    png = img.toPNG()
  } catch {
    return { ok: false, code: 'not-image' }
  }
  if (!Buffer.isBuffer(png) || !png.length) return { ok: false, code: 'not-image' }
  if (png.length > limits.bytes) return { ok: false, code: 'too-large' }
  return { ok: true, png, width: size.width, height: size.height }
}

// An image as the parts a guest sends (base64 each).
export function splitParts(png, part = PASTE_LIMITS.part) {
  const parts = []
  for (let at = 0; at < png.length; at += part) parts.push(png.subarray(at, at + part).toString('base64'))
  return parts
}

// The host's uploads in progress: one per person (a new one replaces the one
// it had; its other connections share it), in order, within the caps,
// dropped after a minute without a part or two minutes after its first one
// (a guest trickling parts can't hold a place). owner: the guest's person
// (a reconnect counts its images within the same minute).
export function createPasteUploads({ now = Date.now, limits = PASTE_LIMITS } = {}) {
  const uploads = new Map() // owner -> { id, pane, project, count, parts: [Buffer], bytes, at, started }
  const times = new Map() // owner -> times of its last pastes (a minute)
  const maxParts = Math.ceil(limits.bytes / limits.part)
  function sweep() {
    const t = now()
    for (const [owner, u] of [...uploads]) if (t - u.at >= limits.uploadMs || t - u.started >= limits.uploadMaxMs) uploads.delete(owner)
    for (const [owner, list] of [...times]) if (!list.some((x) => t - x < 60000)) times.delete(owner)
  }
  // One part: { ok: true } | { ok: false, code }.
  function part(owner, project, args) {
    sweep()
    const a = args && typeof args === 'object' ? args : {}
    const { pane, upload, index, count, data } = a
    if (!isPaneId(pane) || typeof upload !== 'string' || !UPLOAD_ID.test(upload) || !Number.isSafeInteger(index) || !Number.isSafeInteger(count)) return { ok: false, code: 'bad-args' }
    if (count < 1 || count > maxParts || index < 0 || index >= count) return { ok: false, code: 'too-large' }
    if (typeof data !== 'string' || !data || data.length > Math.ceil(limits.part / 3) * 4 || data.length % 4 !== 0 || !BASE64.test(data)) return { ok: false, code: 'bad-args' }
    let u = uploads.get(owner)
    if (index === 0) {
      // A new upload: the guest's earlier one goes; one more needs room.
      if (u) uploads.delete(owner)
      if (uploads.size >= limits.uploadsAtOnce) return { ok: false, code: 'busy' }
      u = { id: upload, pane, project, count, parts: [], bytes: 0, at: now(), started: now() }
      uploads.set(owner, u)
    } else if (!u || u.id !== upload || u.pane !== pane || u.project !== project || u.count !== count || u.parts.length !== index) {
      return { ok: false, code: 'bad-args' }
    }
    const bytes = Buffer.from(data, 'base64')
    if (bytes.length > limits.part || u.bytes + bytes.length > limits.bytes) {
      uploads.delete(owner)
      return { ok: false, code: 'too-large' }
    }
    u.parts.push(bytes)
    u.bytes += bytes.length
    u.at = now()
    return { ok: true }
  }
  // All of an upload, taken (it is gone from here): { ok: true, bytes } |
  // { ok: false, code }. Each paste counts within the guest's minute.
  function take(owner, project, args) {
    sweep()
    const a = args && typeof args === 'object' ? args : {}
    const u = uploads.get(owner)
    if (!u || u.id !== a.upload || u.pane !== a.pane || u.project !== project || u.parts.length !== u.count) return { ok: false, code: 'bad-args' }
    uploads.delete(owner)
    const t = now()
    const recent = (times.get(owner) || []).filter((x) => t - x < 60000)
    if (recent.length >= limits.imagesPerMinute) {
      times.set(owner, recent)
      return { ok: false, code: 'busy' }
    }
    recent.push(t)
    times.set(owner, recent)
    return { ok: true, bytes: Buffer.concat(u.parts) }
  }
  return {
    part,
    take,
    clear() {
      uploads.clear()
      times.clear()
    },
    size: () => uploads.size
  }
}

// The Electron side of it (index.js gives nativeImage, the clipboard and the
// folder for pasted images): reading an image here (a guest's clipboard, a
// file it dropped) as a checked PNG, and saving one a guest sent (the host).
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|bmp)$/i
export const isImageFile = (p) => typeof p === 'string' && IMAGE_FILE.test(p)
export function createPasteImages({ nativeImage, clipboard, dir, limits = PASTE_LIMITS, files = fs }) {
  // Any image as a checked PNG: made a PNG first (a JPEG, say), its size
  // checked before it is made one.
  function asPng(img) {
    if (!img || img.isEmpty()) return { ok: false, code: 'no-image' }
    const size = img.getSize()
    if (tooBig(size, limits)) return { ok: false, code: 'too-large' }
    return checkPng(img.toPNG(), nativeImage, limits)
  }
  return {
    check: (buf) => checkPng(buf, nativeImage, limits),
    fromClipboard: () => asPng(clipboard.readImage()),
    fromFile(path) {
      if (!isImageFile(path)) return { ok: false, code: 'not-image' }
      try {
        const st = files.statSync(path)
        // A file this big makes a PNG over the cap anyway (or is no image).
        if (!st.isFile() || st.size > limits.bytes * 4) return { ok: false, code: 'too-large' }
      } catch {
        return { ok: false, code: 'not-image' }
      }
      const res = asPng(nativeImage.createFromPath(path))
      return res.ok || res.code !== 'no-image' ? res : { ok: false, code: 'not-image' }
    },
    // A checked PNG saved with a name of the host's (images a day old go,
    // and guests' oldest past keepFiles or keepBytes: they can't fill the disk).
    save(png) {
      files.mkdirSync(dir, { recursive: true })
      const dayAgo = Date.now() - 24 * 60 * 60 * 1000
      const guests = []
      for (const f of files.readdirSync(dir)) {
        try {
          const st = files.statSync(join(dir, f))
          if (st.mtimeMs < dayAgo) files.unlinkSync(join(dir, f))
          else if (/^guest-image-.*\.png$/.test(f) && st.isFile()) guests.push({ f, at: st.mtimeMs, size: st.size })
        } catch {
          /* in use or gone */
        }
      }
      guests.sort((a, b) => a.at - b.at || (a.f < b.f ? -1 : 1))
      let bytes = guests.reduce((sum, x) => sum + x.size, 0) + png.length
      let count = guests.length + 1
      for (const x of guests) {
        if (count <= limits.keepFiles && bytes <= limits.keepBytes) break
        try {
          files.unlinkSync(join(dir, x.f))
        } catch {
          /* in use: counted anyway */
        }
        count--
        bytes -= x.size
      }
      const file = join(dir, `guest-image-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.png`)
      files.writeFileSync(file, png)
      return file
    }
  }
}
