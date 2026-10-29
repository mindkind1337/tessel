// A zip built for tests: each part deflated (method 8), or stored (method 0)
// when asked, as office programs write them.
import { deflateRawSync } from 'node:zlib'

export function zip(parts, stored = []) {
  const enc = new TextEncoder()
  const locals = []
  const central = []
  let offset = 0
  for (const [name, text] of Object.entries(parts)) {
    const raw = enc.encode(text)
    const store = stored.includes(name)
    const data = store ? raw : new Uint8Array(deflateRawSync(raw))
    const nameBytes = enc.encode(name)
    const local = new Uint8Array(30 + nameBytes.length + data.length)
    const dv = new DataView(local.buffer)
    dv.setUint32(0, 0x04034b50, true)
    dv.setUint16(8, store ? 0 : 8, true)
    dv.setUint32(18, data.length, true)
    dv.setUint32(22, raw.length, true)
    dv.setUint16(26, nameBytes.length, true)
    local.set(nameBytes, 30)
    local.set(data, 30 + nameBytes.length)
    const cen = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(cen.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(10, store ? 0 : 8, true)
    cv.setUint32(20, data.length, true)
    cv.setUint32(24, raw.length, true)
    cv.setUint16(28, nameBytes.length, true)
    cv.setUint32(42, offset, true)
    cen.set(nameBytes, 46)
    locals.push(local)
    central.push(cen)
    offset += local.length
  }
  const cenSize = central.reduce((n, c) => n + c.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, central.length, true)
  ev.setUint16(10, central.length, true)
  ev.setUint32(12, cenSize, true)
  ev.setUint32(16, offset, true)
  const all = [...locals, ...central, end]
  const out = new Uint8Array(all.reduce((n, a) => n + a.length, 0))
  let o = 0
  for (const a of all) {
    out.set(a, o)
    o += a.length
  }
  return out
}
