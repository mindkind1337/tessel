// A scripted daemon at the other end of an in-memory pipe: answers hello,
// host.info and whatever the test scripts, sends events, and can drop the
// connection. Frames are read and written with the real codec.
import { type Pipe } from '../link'
import { pipePair } from '../pipe'
import { type HostFrame, FrameReader, PROTOCOL_VERSION, SLOW_HOST } from '../wire'

export interface Seen {
  request_id?: number
  kind?: string
  body?: unknown
  ack?: { stream: string; seq: number }
  consumed?: boolean
}

export type Script = (kind: string, body: unknown, id: number, host: FakeHost) => { ok: string; body?: unknown } | { error: string; retryable?: boolean } | null | undefined

export class FakeHost {
  readonly epoch: string
  readonly seen: Seen[] = []
  readonly waiters: Array<(seen: Seen) => void> = []
  readonly pipe: Pipe
  private readonly reader = new FrameReader()
  private closed = false

  constructor(pipe: Pipe, epoch: string, script: Script) {
    this.pipe = pipe
    this.epoch = epoch
    pipe.onData((chunk) => {
      const frames = parseClientFrames(this.reader, chunk)
      for (const f of frames) this.handle(f, script)
    })
  }

  private handle(frame: Record<string, unknown>, script: Script): void {
    const seen: Seen = {}
    if (typeof frame.request_id === 'number') {
      const message = frame.message as { kind: string; body?: unknown }
      seen.request_id = frame.request_id
      seen.kind = message.kind
      seen.body = message.body
      this.seen.push(seen)
      this.notify(seen)
      const id = frame.request_id
      if (message.kind === 'hello') {
        const hello = message.body as { capabilities: string[]; budgets: typeof SLOW_HOST }
        this.reply(id, 'hello_ok', { version: PROTOCOL_VERSION, capabilities: hello.capabilities, budgets: hello.budgets, host_epoch: this.epoch })
        return
      }
      if (message.kind === 'host.info') {
        this.reply(id, 'host_info', {
          version: '0.1.1',
          arch: 'x86_64',
          pid: 4242,
          persistence: { method: 'session', linger: false, kill_user_processes: false, survives_logout: 'yes' }
        })
        return
      }
      const answer = script(message.kind, message.body, id, this)
      if (!answer) return
      if ('error' in answer) this.send({ version: PROTOCOL_VERSION, reply_to: id, error: { code: answer.error, retryable: answer.retryable ?? false } })
      else this.reply(id, answer.ok, answer.body)
      return
    }
    if (frame.ack) {
      seen.ack = frame.ack as { stream: string; seq: number }
      this.seen.push(seen)
      this.notify(seen)
    }
  }

  reply(id: number, kind: string, body?: unknown): void {
    this.send({ version: PROTOCOL_VERSION, reply_to: id, ok: body === undefined ? { kind } : { kind, body } })
  }

  event(stream: string, seq: number, kind: string, body: unknown): void {
    this.send({ version: PROTOCOL_VERSION, stream: { id: stream, seq }, event: { kind, body } })
  }

  send(frame: HostFrame | Record<string, unknown>): void {
    if (this.closed) return
    const json = Buffer.from(JSON.stringify(frame))
    const out = Buffer.alloc(4 + json.length)
    out.writeUInt32BE(json.length, 0)
    json.copy(out, 4)
    this.pipe.write(out)
  }

  /** Raw bytes, for frames the codec would refuse to build. */
  raw(bytes: Buffer): void {
    this.pipe.write(bytes)
  }

  drop(): void {
    this.closed = true
    this.pipe.close()
  }

  /** The next frame matching `test` (already seen, or to come). */
  next(test: (seen: Seen) => boolean, timeout = 2000): Promise<Seen> {
    const found = this.seen.find((s) => s.consumed !== true && test(s))
    if (found) {
      found.consumed = true
      return Promise.resolve(found)
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no such frame in time')), timeout)
      const waiter = (seen: Seen): void => {
        if (seen.consumed === true || !test(seen)) return
        seen.consumed = true
        clearTimeout(timer)
        this.waiters.splice(this.waiters.indexOf(waiter), 1)
        resolve(seen)
      }
      this.waiters.push(waiter)
    })
  }

  private notify(seen: Seen): void {
    for (const w of [...this.waiters]) w(seen)
  }
}

export function parseClientFrames(reader: FrameReader, chunk: Buffer): Record<string, unknown>[] {
  // The client's frames have another shape than the host's: split them with
  // the same length rule and parse them as plain JSON here.
  const out: Record<string, unknown>[] = []
  for (const frame of splitFrames(reader, chunk)) out.push(JSON.parse(frame.toString('utf8')) as Record<string, unknown>)
  return out
}

const buffers = new WeakMap<FrameReader, Buffer>()
function splitFrames(reader: FrameReader, chunk: Buffer): Buffer[] {
  let all = Buffer.concat([buffers.get(reader) ?? Buffer.alloc(0), chunk])
  const frames: Buffer[] = []
  while (all.length >= 4) {
    const len = all.readUInt32BE(0)
    if (all.length < 4 + len) break
    frames.push(all.subarray(4, 4 + len))
    all = all.subarray(4 + len)
  }
  buffers.set(reader, Buffer.from(all))
  return frames
}

/** A connector to a fresh fake host each time (each connection is a new daemon link; the epoch is the test's). */
export function fakeConnector(epochs: () => string, script: Script, onHost?: (host: FakeHost) => void): { connect: (signal: AbortSignal) => Promise<Pipe>; hosts: FakeHost[] } {
  const hosts: FakeHost[] = []
  return {
    hosts,
    connect: async () => {
      const [clientEnd, hostEnd] = pipePair()
      const host = new FakeHost(hostEnd, epochs(), script)
      hosts.push(host)
      onHost?.(host)
      return clientEnd
    }
  }
}
