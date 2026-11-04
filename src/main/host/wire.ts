// The wire of the Tessel host protocol, version 1 (tessel-host,
// crates/host-protocol/PROTOCOL.md): frames of a four-byte big-endian length
// and that many bytes of UTF-8 JSON, the shapes both sides exchange, and the
// limits a frame must respect before it is parsed. Everything the daemon
// says is data from another machine: the limits below are checked on what
// comes in, not only on what goes out.

export const PROTOCOL_VERSION = 1
/** The largest frame either side ever sends, header aside. */
export const MAX_FRAME_BYTES = 1024 * 1024
/** Nested objects and arrays a frame may hold, counted before parsing. */
export const MAX_DEPTH = 16
const HEADER = 4

export interface Budgets {
  frame_bytes: number
  terminal_ring_bytes: number
  total_ring_bytes: number
  stream_window_bytes: number
  in_flight: number
}

/** The default of the daemon and of the Rust client for a slow or shared host. */
export const SLOW_HOST: Budgets = {
  frame_bytes: MAX_FRAME_BYTES,
  terminal_ring_bytes: 2 * 1024 * 1024,
  total_ring_bytes: 16 * 1024 * 1024,
  stream_window_bytes: 2 * 1024 * 1024,
  in_flight: 32
}

export type Capability = 'pty' | 'tree' | 'editor' | 'git' | 'tunnel.reverse'

export interface Hello {
  versions: number[]
  capabilities: string[]
  budgets: Budgets
}

export interface HelloOk {
  version: number
  capabilities: string[]
  budgets: Budgets
  host_epoch: string
}

export interface HostInfo {
  version: string
  arch: string
  pid: number
  persistence: {
    method: string
    linger: boolean | null
    kill_user_processes: boolean | null
    survives_logout: 'yes' | 'no' | 'unknown'
  }
}

/** A refusal: `detail` is one of the host's fixed sentences, never what was sent. */
export interface WireError {
  code: string
  retryable: boolean
  detail?: string
}

export interface Message {
  kind: string
  body?: unknown
}

/** A frame the host sends: a reply, an event of a stream, or a connection error. */
export interface HostFrame {
  version: number
  reply_to?: number
  ok?: Message
  error?: WireError
  stream?: { id: string; seq: number }
  event?: Message
}

/** A frame the client sends: a request or an acknowledgment. */
export type ClientFrame =
  | { version: number; request_id: number; message: Message }
  | { version: number; ack: { stream: string; seq: number } }

export class FrameError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FrameError'
  }
}

const HEX32 = /^[0-9a-f]{32}$/
export const isId = (value: unknown): value is string => typeof value === 'string' && HEX32.test(value)

/** Encodes one frame; refuses one above `limit` rather than sending what the host would close on. */
export function encodeFrame(frame: ClientFrame, limit = MAX_FRAME_BYTES): Buffer {
  const json = Buffer.from(JSON.stringify(frame), 'utf8')
  if (json.length === 0 || json.length > Math.min(limit, MAX_FRAME_BYTES)) throw new FrameError('frame too large')
  const out = Buffer.allocUnsafe(HEADER + json.length)
  out.writeUInt32BE(json.length, 0)
  json.copy(out, HEADER)
  return out
}

// The nesting of a JSON text, counted on its bytes (strings skipped), without
// parsing it: a frame nested deeper than MAX_DEPTH is refused before any
// parser recurses into it.
function tooDeep(bytes: Buffer): boolean {
  let depth = 0
  let inString = false
  let escaped = false
  for (const b of bytes) {
    if (inString) {
      if (escaped) escaped = false
      else if (b === 0x5c) escaped = true
      else if (b === 0x22) inString = false
      continue
    }
    if (b === 0x22) inString = true
    else if (b === 0x7b || b === 0x5b) {
      if (++depth > MAX_DEPTH) return true
    } else if (b === 0x7d || b === 0x5d) depth--
  }
  return false
}

// Numbers are integers within ±(2^53 − 1) by contract; a fraction or an
// exponent is a broken frame (JSON.parse would silently round it).
const NUMBER_SYNTAX = /-?\d+(\.\d+|[eE][+-]?\d+)/
function badNumber(text: string): boolean {
  // Only outside strings: strip them first (escapes kept out of the way).
  const noStrings = text.replace(/"(?:[^"\\]|\\.)*"/g, '""')
  return NUMBER_SYNTAX.test(noStrings)
}

/**
 * Splits a byte stream into host frames. `push` returns the frames completed
 * by this chunk and throws FrameError on a frame the contract forbids (the
 * connection is then to be closed; the reader keeps nothing usable).
 */
export class FrameReader {
  private chunks: Buffer[] = []
  private buffered = 0
  private readonly limit: number

  constructor(limit = MAX_FRAME_BYTES) {
    this.limit = Math.min(Math.max(1024, limit), MAX_FRAME_BYTES)
  }

  push(chunk: Buffer): HostFrame[] {
    if (chunk.length) {
      this.chunks.push(chunk)
      this.buffered += chunk.length
    }
    const frames: HostFrame[] = []
    for (;;) {
      if (this.buffered < HEADER) return frames
      const all = this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks)
      this.chunks = [all]
      const length = all.readUInt32BE(0)
      if (length === 0 || length > this.limit) throw new FrameError('frame length')
      if (all.length < HEADER + length) return frames
      const body = all.subarray(HEADER, HEADER + length)
      const rest = all.subarray(HEADER + length)
      this.chunks = rest.length ? [Buffer.from(rest)] : []
      this.buffered = rest.length
      frames.push(decodeFrame(body))
    }
  }
}

export function decodeFrame(body: Buffer): HostFrame {
  if (tooDeep(body)) throw new FrameError('frame too deep')
  const text = body.toString('utf8')
  if (badNumber(text)) throw new FrameError('frame number')
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new FrameError('frame not json')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new FrameError('frame not an object')
  const frame = value as Record<string, unknown>
  if (frame.version !== PROTOCOL_VERSION) throw new FrameError('frame version')
  const out: HostFrame = { version: PROTOCOL_VERSION }
  if (frame.reply_to !== undefined) {
    if (!isRequestId(frame.reply_to)) throw new FrameError('reply identifier')
    out.reply_to = frame.reply_to
    if (frame.ok !== undefined) out.ok = asMessage(frame.ok)
    else if (frame.error !== undefined) out.error = asError(frame.error)
    else throw new FrameError('empty reply')
    return out
  }
  if (frame.stream !== undefined) {
    const stream = frame.stream as Record<string, unknown> | null
    if (!stream || typeof stream !== 'object' || !isId(stream.id) || !isSeq(stream.seq)) throw new FrameError('stream header')
    out.stream = { id: stream.id, seq: stream.seq }
    out.event = asMessage(frame.event)
    return out
  }
  if (frame.error !== undefined) {
    out.error = asError(frame.error)
    return out
  }
  throw new FrameError('frame shape')
}

const isRequestId = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1
const isSeq = isRequestId
const KIND = /^[a-z][a-z0-9._]{0,63}$/

function asMessage(value: unknown): Message {
  const m = value as Record<string, unknown> | null
  if (!m || typeof m !== 'object' || typeof m.kind !== 'string' || !KIND.test(m.kind)) throw new FrameError('message kind')
  return m.body === undefined ? { kind: m.kind } : { kind: m.kind, body: m.body }
}

function asError(value: unknown): WireError {
  const e = value as Record<string, unknown> | null
  if (!e || typeof e !== 'object' || typeof e.code !== 'string' || typeof e.retryable !== 'boolean') throw new FrameError('error shape')
  const out: WireError = { code: e.code, retryable: e.retryable }
  if (typeof e.detail === 'string') out.detail = e.detail
  return out
}

/** A refusal from the host, as a thrown error. */
export class HostError extends Error {
  readonly code: string
  readonly retryable: boolean
  readonly detail: string | undefined
  constructor(error: WireError) {
    super(`host refused: ${error.code}${error.detail ? ` (${error.detail})` : ''}`)
    this.name = 'HostError'
    this.code = error.code
    this.retryable = error.retryable
    this.detail = error.detail
  }
}

export type LinkFailure = 'connection_lost' | 'timeout' | 'protocol'

/** The link failed the request: lost, too slow, or the host broke the contract. */
export class LinkError extends Error {
  readonly reason: LinkFailure
  constructor(reason: LinkFailure, detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason)
    this.name = 'LinkError'
    this.reason = reason
  }
}

export const isConnectionLost = (e: unknown): boolean => e instanceof LinkError && e.reason === 'connection_lost'
