// Copy the locally rendered usage card through Electron's native clipboard.
// The IPC accepts a bounded PNG, never a path or an arbitrary URL.
export function copyUsageImage(bytes, { nativeImage, clipboard }) {
  try {
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.byteLength < 33 ||
      bytes.byteLength > 10 * 1024 * 1024
    )
      return { ok: false, error: 'The usage image is invalid or too large.' }
    const buffer = Buffer.from(bytes)
    if (
      !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      buffer.toString('ascii', 12, 16) !== 'IHDR'
    )
      return { ok: false, error: 'The usage image must be a PNG.' }
    const width = buffer.readUInt32BE(16),
      height = buffer.readUInt32BE(20)
    if (!width || !height || width > 4096 || height > 4096)
      return { ok: false, error: 'The usage image dimensions are invalid.' }
    const image = nativeImage.createFromBuffer(buffer)
    if (image.isEmpty()) return { ok: false, error: 'The usage image could not be decoded.' }
    clipboard.writeImage(image)
    return { ok: true }
  } catch {
    return { ok: false, error: 'The usage image could not be copied.' }
  }
}
