// @vitest-environment node
// The frame codec: the contract's limits are checked on what comes in, before
// any parsing, and the shapes the host sends are the only ones accepted.
import { describe, it, expect } from 'vitest'
import { FrameError, FrameReader, MAX_FRAME_BYTES, PROTOCOL_VERSION, decodeFrame, encodeFrame } from '../wire'

const raw = (json: string): Buffer => {
  const body = Buffer.from(json)
  const out = Buffer.alloc(4 + body.length)
  out.writeUInt32BE(body.length, 0)
  body.copy(out, 4)
  return out
}

describe('frames', () => {
  it('encodes a request and an acknowledgment with a four-byte big-endian length', () => {
    const frame = encodeFrame({ version: 1, request_id: 1, message: { kind: 'ping' } })
    expect(frame.readUInt32BE(0)).toBe(frame.length - 4)
    expect(JSON.parse(frame.subarray(4).toString())).toEqual({ version: 1, request_id: 1, message: { kind: 'ping' } })
    const ack = encodeFrame({ version: 1, ack: { stream: 'a'.repeat(32), seq: 3 } })
    expect(JSON.parse(ack.subarray(4).toString())).toEqual({ version: 1, ack: { stream: 'a'.repeat(32), seq: 3 } })
  })

  it('refuses to build a frame above the negotiated limit', () => {
    expect(() => encodeFrame({ version: 1, request_id: 1, message: { kind: 'x', body: 'y'.repeat(2000) } }, 1024)).toThrow(FrameError)
    expect(() => encodeFrame({ version: 1, request_id: 1, message: { kind: 'x', body: 'y'.repeat(MAX_FRAME_BYTES) } })).toThrow(FrameError)
  })

  it('reads frames split across chunks, and several in one chunk', () => {
    const reader = new FrameReader()
    const a = raw('{"version":1,"reply_to":1,"ok":{"kind":"pong"}}')
    const b = raw('{"version":1,"stream":{"id":"' + 'b'.repeat(32) + '","seq":1},"event":{"kind":"git.changed","body":{"reset":true}}}')
    const all = Buffer.concat([a, b])
    const first = reader.push(all.subarray(0, 10))
    expect(first).toEqual([])
    const rest = reader.push(all.subarray(10))
    expect(rest).toHaveLength(2)
    expect(rest[0]).toEqual({ version: 1, reply_to: 1, ok: { kind: 'pong' } })
    expect(rest[1]!.stream).toEqual({ id: 'b'.repeat(32), seq: 1 })
    expect(rest[1]!.event).toEqual({ kind: 'git.changed', body: { reset: true } })
  })

  it('refuses a zero or oversized length from the header alone', () => {
    const zero = Buffer.alloc(4)
    expect(() => new FrameReader().push(zero)).toThrow(/length/)
    const big = Buffer.alloc(4)
    big.writeUInt32BE(MAX_FRAME_BYTES + 1, 0)
    expect(() => new FrameReader().push(big)).toThrow(/length/)
    const limited = Buffer.alloc(4)
    limited.writeUInt32BE(70_000, 0)
    expect(() => new FrameReader(65_536).push(limited)).toThrow(/length/)
  })

  it('refuses a frame nested deeper than 16, a fraction, an exponent, another version, a wrong shape', () => {
    const deep = '{"version":1,"reply_to":1,"ok":{"kind":"x","body":' + '['.repeat(15) + ']'.repeat(15) + '}}'
    expect(() => decodeFrame(Buffer.from(deep))).toThrow(/deep/)
    const fine = '{"version":1,"reply_to":1,"ok":{"kind":"x","body":' + '['.repeat(13) + ']'.repeat(13) + '}}'
    expect(decodeFrame(Buffer.from(fine)).reply_to).toBe(1)
    // Brackets inside strings do not count.
    expect(decodeFrame(Buffer.from('{"version":1,"reply_to":1,"ok":{"kind":"x","body":"' + '['.repeat(40) + '"}}')).ok!.body).toBe('['.repeat(40))
    expect(() => decodeFrame(Buffer.from('{"version":1,"reply_to":1,"ok":{"kind":"x","body":1.5}}'))).toThrow(/number/)
    expect(() => decodeFrame(Buffer.from('{"version":1,"reply_to":1,"ok":{"kind":"x","body":1e3}}'))).toThrow(/number/)
    expect(decodeFrame(Buffer.from('{"version":1,"reply_to":1,"ok":{"kind":"x","body":"1.5e3"}}')).ok!.body).toBe('1.5e3')
    expect(() => decodeFrame(Buffer.from('{"version":2,"reply_to":1,"ok":{"kind":"x"}}'))).toThrow(/version/)
    expect(() => decodeFrame(Buffer.from('[1]'))).toThrow(FrameError)
    expect(() => decodeFrame(Buffer.from('{"version":1}'))).toThrow(/shape/)
    expect(() => decodeFrame(Buffer.from('{"version":1,"reply_to":1}'))).toThrow(/empty/)
    expect(() => decodeFrame(Buffer.from('{"version":1,"reply_to":1,"ok":{"kind":"Bad Kind"}}'))).toThrow(/kind/)
    expect(() => decodeFrame(Buffer.from('{"version":1,"stream":{"id":"short","seq":1},"event":{"kind":"x"}}'))).toThrow(/stream/)
    expect(() => decodeFrame(Buffer.from('{"version":1,"stream":{"id":"' + 'c'.repeat(32) + '","seq":0},"event":{"kind":"x"}}'))).toThrow(/stream/)
  })

  it('reads a reply, an error reply and a connection error', () => {
    expect(decodeFrame(Buffer.from('{"version":1,"reply_to":7,"error":{"code":"busy","retryable":true}}'))).toEqual({
      version: PROTOCOL_VERSION,
      reply_to: 7,
      error: { code: 'busy', retryable: true }
    })
    expect(decodeFrame(Buffer.from('{"version":1,"error":{"code":"bad_frame","retryable":false,"detail":"request identifier must increase"}}'))).toEqual({
      version: PROTOCOL_VERSION,
      error: { code: 'bad_frame', retryable: false, detail: 'request identifier must increase' }
    })
  })
})
