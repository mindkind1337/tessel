// "[Image #N]" in a Claude Code pane: which image it is, to open it.
// Claude records, with each message, the numbers of the images pasted in it
// ("imagePasteIds": [42]) and the images themselves in the same order
// (base64), in a user message or a queued_command attachment:
//   { type: 'user', imagePasteIds: [39], message: { content: [text, image] } }
//   { type: 'attachment', attachment: { imagePasteIds: [42], prompt: [text, image] } }
// The image found is saved as a file (once) so the system viewer opens it.
import fs from 'fs'
import os from 'os'
import { join, resolve, relative, isAbsolute, dirname, basename } from 'path'
import readline from 'readline'
import { createHash } from 'crypto'
import { claudeTranscript } from './agentModel'

export const PASTE_DIR = join(os.tmpdir(), 'tessel-paste')
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }

// One transcript line -> the image block for number n, or null.
export function imageInEntry(o, n) {
  if (!o || typeof o !== 'object') return null
  let ids = null
  let blocks = null
  if (Array.isArray(o.imagePasteIds) && o.message && Array.isArray(o.message.content)) {
    ids = o.imagePasteIds
    blocks = o.message.content
  } else if (o.attachment && Array.isArray(o.attachment.imagePasteIds) && Array.isArray(o.attachment.prompt)) {
    ids = o.attachment.imagePasteIds
    blocks = o.attachment.prompt
  }
  if (!ids) return null
  const i = ids.indexOf(n)
  if (i < 0) return null
  const images = blocks.filter((b) => b && b.type === 'image' && b.source)
  const img = images[i]
  if (!img || img.source.type !== 'base64' || typeof img.source.data !== 'string') return null
  return { mediaType: img.source.media_type || 'image/png', data: img.source.data }
}

// -> the image's file, or null. The transcript can be large: read line by
// line, parsing only the lines that name this image. The transcript is always
// read first (the file Claude Code pasted from %TEMP% is soon gone; its bytes
// in the transcript are the copy that lasts), and the saved copy is named by
// the whole session and the image's own bytes: another session, or this
// number reused for another image (a resumed session), never gets a copy of
// the wrong image.
export async function claudeImageFile({ sessionId, n }, home = os.homedir(), outDir = PASTE_DIR) {
  if (!Number.isInteger(n) || n < 1) return null
  const file = claudeTranscript(sessionId, home)
  if (!file) return null
  const needle = new RegExp(`"imagePasteIds":\\[[^\\]]*\\b${n}\\b`)
  let found = null
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
  try {
    for await (const line of rl) {
      if (!line.includes('"imagePasteIds"') || !needle.test(line)) continue
      try {
        const img = imageInEntry(JSON.parse(line), n)
        if (img) found = img // the latest one with this number (a resumed session can reuse it)
      } catch {
        /* a broken line */
      }
    }
  } finally {
    rl.close()
  }
  if (!found) return null
  const bytes = Buffer.from(found.data, 'base64')
  if (!bytes.length) return null
  const session = createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 16)
  const image = createHash('sha256').update(bytes).digest('hex').slice(0, 16)
  const path = join(outDir, `claude-${session}-image-${n}-${image}.${EXT[found.mediaType] || 'png'}`)
  if (fs.existsSync(path)) return path
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path, bytes)
  return path
}

// "[Image #N]" in a Codex pane: Codex records each pasted image in its user
// message as <image name=[Image #N] path="…"> followed by the image itself
// (an input_image data: URL), in the session's rollout file:
//   { type: 'response_item', payload: { role: 'user', content: [
//       { type: 'input_text', text: '<image name=[Image #1] path="…">' },
//       { type: 'input_image', image_url: 'data:image/png;base64,…' }, … ] } }
// One rollout line -> the image for number n ({ mediaType, data }), or null.
export function codexImageInEntry(o, n) {
  const p = o && o.type === 'response_item' && o.payload && typeof o.payload === 'object' ? o.payload : null
  if (!p || p.role !== 'user' || !Array.isArray(p.content)) return null
  const tag = `<image name=[Image #${n}]`
  for (let i = 0; i < p.content.length; i++) {
    const b = p.content[i]
    if (!b || b.type !== 'input_text' || typeof b.text !== 'string' || !b.text.includes(tag)) continue
    const img = p.content[i + 1]
    const m = img && img.type === 'input_image' && typeof img.image_url === 'string' ? /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/s.exec(img.image_url) : null
    if (m) return { mediaType: m[1], data: m[2] }
  }
  return null
}

// rollout: the session's file (found by the caller) -> the image's file, or
// null. Like claudeImageFile: read line by line, the latest image with this
// number, saved once under a name made of the session and the image's bytes.
export async function codexImageFile({ rollout, sessionId, n }, outDir = PASTE_DIR) {
  if (!Number.isInteger(n) || n < 1 || typeof rollout !== 'string' || !rollout) return null
  const needle = `<image name=[Image #${n}]`
  let found = null
  const rl = readline.createInterface({ input: fs.createReadStream(rollout, { encoding: 'utf8' }), crlfDelay: Infinity })
  try {
    for await (const line of rl) {
      if (!line.includes(needle)) continue
      try {
        const img = codexImageInEntry(JSON.parse(line), n)
        if (img) found = img
      } catch {
        /* a broken line */
      }
    }
  } catch {
    return null
  } finally {
    rl.close()
  }
  if (!found) return null
  const bytes = Buffer.from(found.data, 'base64')
  if (!bytes.length) return null
  const session = createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 16)
  const image = createHash('sha256').update(bytes).digest('hex').slice(0, 16)
  const path = join(outDir, `codex-${session}-image-${n}-${image}.${EXT[found.mediaType] || 'png'}`)
  if (fs.existsSync(path)) return path
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path, bytes)
  return path
}

// A file Tessel may open for a pane: one it saved itself (pasted images,
// screenshots), inside its folder once resolved (not a folder whose name
// only starts the same, like tessel-paste-other).
export function isPastedImage(file, dir = PASTE_DIR) {
  if (typeof file !== 'string' || !file || file.includes('\0') || !/\.(png|jpe?g|gif|webp)$/i.test(file)) return false
  const rel = relative(resolve(dir), resolve(file))
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel)
}
// An image pasted in a pane, as Tessel named it, right in its folder (a
// local paste's image-<time>.png, a Live Share guest's guest-image-....png).
export function isSavedPaste(file, dir = PASTE_DIR) {
  if (typeof file !== 'string' || !file || file.includes('\0')) return false
  const full = resolve(file)
  return dirname(full).toLowerCase() === resolve(dir).toLowerCase() && /^(guest-image|image)-[\w-]+\.png$/i.test(basename(full))
}
