// "[Image #N]" in a Claude Code pane: which image it is, to open it.
// Claude records, with each message, the numbers of the images pasted in it
// ("imagePasteIds": [42]) and the images themselves in the same order
// (base64), in a user message or a queued_command attachment:
//   { type: 'user', imagePasteIds: [39], message: { content: [text, image] } }
//   { type: 'attachment', attachment: { imagePasteIds: [42], prompt: [text, image] } }
// The image found is saved as a file (once) so the system viewer opens it.
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import readline from 'readline'
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
// line, parsing only the lines that name this image.
export async function claudeImageFile({ sessionId, n }, home = os.homedir(), outDir = PASTE_DIR) {
  if (!Number.isInteger(n) || n < 1) return null
  const file = claudeTranscript(sessionId, home)
  if (!file) return null
  const out = join(outDir, `claude-${String(sessionId).slice(0, 8)}-image-${n}`)
  for (const ext of Object.values(EXT)) if (fs.existsSync(`${out}.${ext}`)) return `${out}.${ext}`
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
  const path = `${out}.${EXT[found.mediaType] || 'png'}`
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path, Buffer.from(found.data, 'base64'))
  return path
}

// A file Tessel may open for a pane: one it saved itself (pasted images).
export function isPastedImage(file, dir = PASTE_DIR) {
  return (
    typeof file === 'string' &&
    file.toLowerCase().startsWith(dir.toLowerCase()) &&
    !file.includes('..') &&
    /\.(png|jpe?g|gif|webp)$/i.test(file)
  )
}
