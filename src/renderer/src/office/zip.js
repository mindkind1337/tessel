// The zip and XML of office files (.xlsx, .docx, .pptx, .odt, .ods, .odp),
// read with nothing added to the app: the zip's central directory read here,
// each part inflated by Chromium's own DecompressionStream, the XML read with
// DOMParser (never run, never shown as HTML).

// The parts this reads, inflated: none may grow past this (a zip bomb).
const MAX_PART = 64 * 1024 * 1024

const td = new TextDecoder()

// --- Zip ------------------------------------------------------------------------------
function u16(b, o) {
  return b[o] | (b[o + 1] << 8)
}
function u32(b, o) {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0
}

// name -> { method, offset, size, csize }, from the central directory.
export function zipEntries(bytes) {
  const b = bytes
  let eocd = -1
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) {
    if (u32(b, i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('not a zip')
  const count = u16(b, eocd + 10)
  let p = u32(b, eocd + 16)
  const out = new Map()
  for (let i = 0; i < count; i++) {
    if (p + 46 > b.length || u32(b, p) !== 0x02014b50) throw new Error('bad zip directory')
    const method = u16(b, p + 10)
    const csize = u32(b, p + 20)
    const size = u32(b, p + 24)
    const nameLen = u16(b, p + 28)
    const extraLen = u16(b, p + 30)
    const commentLen = u16(b, p + 32)
    const offset = u32(b, p + 42)
    const name = td.decode(b.subarray(p + 46, p + 46 + nameLen))
    out.set(name, { method, offset, size, csize })
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}

async function inflateRaw(data, limit) {
  const source = new ReadableStream({
    start(c) {
      c.enqueue(data)
      c.close()
    }
  })
  const stream = source.pipeThrough(new DecompressionStream('deflate-raw'))
  const reader = stream.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > limit) {
      reader.cancel().catch(() => {})
      throw new Error('part too large')
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let o = 0
  for (const c of chunks) {
    out.set(c, o)
    o += c.length
  }
  return out
}

export async function readPart(bytes, entries, name) {
  const e = entries.get(name)
  if (!e) return null
  const p = e.offset
  if (u32(bytes, p) !== 0x04034b50) throw new Error('bad zip entry')
  const start = p + 30 + u16(bytes, p + 26) + u16(bytes, p + 28)
  const data = bytes.subarray(start, start + e.csize)
  if (e.method === 0) return td.decode(data)
  if (e.method !== 8) throw new Error('unsupported compression')
  return td.decode(await inflateRaw(data, MAX_PART))
}

// --- XML ------------------------------------------------------------------------------
export function xml(text) {
  return new DOMParser().parseFromString(text, 'application/xml')
}
// Elements by local name (the namespace prefixes vary between writers).
export function els(node, name) {
  return Array.from(node.getElementsByTagNameNS('*', name))
}

// The parts of a zip, by name ('a/b.xml'); for reading many with readPart.
export function openZip(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const entries = zipEntries(data)
  return { entries, read: (name) => readPart(data, entries, name), has: (name) => entries.has(name) }
}

// A target in a .rels file, from the part it belongs to: 'worksheets/a.xml'
// from 'xl/workbook.xml' is 'xl/worksheets/a.xml'; '/xl/a.xml' is absolute.
export function resolveTarget(base, target) {
  if (target.startsWith('/')) return target.slice(1)
  const parts = base.split('/').slice(0, -1)
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop()
    else if (seg && seg !== '.') parts.push(seg)
  }
  return parts.join('/')
}
