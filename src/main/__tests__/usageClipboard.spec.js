// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { copyUsageImage } from '../usageClipboard'
// A valid one-pixel PNG. Real rendering is checked separately in the compiled UI.
const png = () =>
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
    'base64'
  )
function services() {
  return {
    nativeImage: { createFromBuffer: vi.fn(() => ({ isEmpty: () => false })) },
    clipboard: { writeImage: vi.fn() }
  }
}
describe('usage PNG clipboard boundary', () => {
  it('decodes bytes and writes the decoded native image', () => {
    const api = services()
    expect(copyUsageImage(new Uint8Array(png()), api)).toEqual({ ok: true })
    expect(api.clipboard.writeImage).toHaveBeenCalledWith(
      api.nativeImage.createFromBuffer.mock.results[0].value
    )
  })
  it('rejects URLs, truncated/non-PNG data and oversized payloads before decoding', () => {
    const api = services()
    for (const bad of [
      'file:///private.png',
      new Uint8Array(4),
      new Uint8Array(40),
      new Uint8Array(10 * 1024 * 1024 + 1)
    ])
      expect(copyUsageImage(bad, api).ok).toBe(false)
    expect(api.nativeImage.createFromBuffer).not.toHaveBeenCalled()
    expect(api.clipboard.writeImage).not.toHaveBeenCalled()
  })
  it('rejects oversized decoded dimensions before calling the image decoder', () => {
    const api = services(),
      bytes = png()
    bytes.writeUInt32BE(100000, 16)
    expect(copyUsageImage(bytes, api).ok).toBe(false)
    expect(api.nativeImage.createFromBuffer).not.toHaveBeenCalled()
  })
  it('returns a visible failure for invalid PNG contents or a native clipboard failure', () => {
    const api = services()
    api.nativeImage.createFromBuffer.mockReturnValueOnce({ isEmpty: () => true })
    expect(copyUsageImage(png(), api).ok).toBe(false)
    expect(api.clipboard.writeImage).not.toHaveBeenCalled()
    api.clipboard.writeImage.mockImplementation(() => {
      throw Error('Private native details')
    })
    expect(copyUsageImage(png(), api)).toEqual({
      ok: false,
      error: 'The usage image could not be copied.'
    })
  })
})
