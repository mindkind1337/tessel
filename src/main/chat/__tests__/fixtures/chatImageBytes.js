// Small valid image headers (and a little body) for chatImages.spec.js: each
// is recognized by its magic bytes and carries its pixel size.

// A real 1×1 PNG.
export const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
)

// A PNG header claiming 688×478.
export function pngOf(width, height, extra = 0) {
  const b = Buffer.alloc(33 + extra)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'latin1')
  b.writeUInt32BE(width, 16)
  b.writeUInt32BE(height, 20)
  return b
}

// JPEG: SOI, an APP0 segment, then SOF0 with the size.
export function jpegOf(width, height) {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00])
  const sof = Buffer.alloc(19)
  sof.writeUInt16BE(0xffc0, 0)
  sof.writeUInt16BE(17, 2)
  sof[4] = 8
  sof.writeUInt16BE(height, 5)
  sof.writeUInt16BE(width, 7)
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])])
}

export function gifOf(width, height) {
  const b = Buffer.alloc(16)
  b.write('GIF89a', 0, 'latin1')
  b.writeUInt16LE(width, 6)
  b.writeUInt16LE(height, 8)
  return b
}

// WebP, extended (VP8X) form: 24-bit width-1 and height-1.
export function webpOf(width, height) {
  const b = Buffer.alloc(30)
  b.write('RIFF', 0, 'latin1')
  b.writeUInt32LE(22, 4)
  b.write('WEBP', 8, 'latin1')
  b.write('VP8X', 12, 'latin1')
  b.writeUInt32LE(10, 16)
  b.writeUIntLE(width - 1, 24, 3)
  b.writeUIntLE(height - 1, 27, 3)
  return b
}

// Not images: a BMP, an SVG, text named .png.
export const BMP = Buffer.concat([Buffer.from('BM', 'latin1'), Buffer.alloc(40)])
export const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>')
export const TEXT = Buffer.from('just some text, not an image at all')
