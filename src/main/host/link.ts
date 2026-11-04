// One live connection to a host daemon over any byte pipe (an SSH exec channel
// running `tessel-host connect --stdio`, a test pipe). It says hello, matches
// replies to requests, routes the events of each stream to whoever claimed it
// and acknowledges them once handled, and reports its end. The same part as
// crates/host-client/src/link.rs on the Rust side.
import {
  type Budgets,
  type ClientFrame,
  type HelloOk,
  type HostFrame,
  type Message,
  FrameError,
  FrameReader,
  HostError,
  LinkError,
  PROTOCOL_VERSION,
  encodeFrame
} from './wire'

/** Both directions of one connection, and how to end it (which ends its process). */
export interface Pipe {
  onData(listener: (chunk: Buffer) => void): void
  onEnd(listener: (error?: Error) => void): void
  write(chunk: Buffer): void
  close(): void
}

/** Opens a fresh pipe to `tessel-host connect --stdio`; called again for each reconnect. */
export type Connector = (signal: AbortSignal) => Promise<Pipe>

/** One event of a stream, in order. `gap`: events were missed before this one (never applied silently). */
export interface StreamItem {
  seq: number
  kind: string
  body: unknown
  gap: boolean
}

export type StreamHandler = (item: StreamItem) => void | Promise<void>

interface Pending {
  resolve: (message: Message) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface Route {
  handler: StreamHandler
  last: number
  queue: StreamItem[]
  busy: boolean
}

/** Events of a stream nobody claimed yet (its reply is still on its way to the requester). */
const MAX_ORPHAN_EVENTS = 4096
const MAX_ORPHAN_STREAMS = 64

/** A connection being opened, so another caller can abandon it. */
export class Opening {
  readonly controller = new AbortController()
  cancel(): void {
    this.controller.abort()
  }
  get cancelled(): boolean {
    return this.controller.signal.aborted
  }
}

export class Link {
  readonly hello: HelloOk
  private readonly pipe: Pipe
  private readonly reader: FrameReader
  private readonly frameLimit: number
  private readonly pending = new Map<number, Pending>()
  private readonly waiting: Array<() => void> = []
  private readonly routes = new Map<string, Route>()
  private readonly orphans = new Map<string, HostFrame[]>()
  private readonly closed: Array<() => void> = []
  private nextId = 2
  private _alive = true

  private constructor(pipe: Pipe, hello: HelloOk, reader: FrameReader) {
    this.pipe = pipe
    this.hello = hello
    this.frameLimit = hello.budgets.frame_bytes
    this.reader = reader
    pipe.onData((chunk) => this.onData(chunk))
    pipe.onEnd(() => this.end())
  }

  /**
   * Connects and says hello within `timeout` ms. Rejects if the host refused
   * (HostError), the pipe failed, nothing came in time (LinkError timeout: an
   * SSH channel can stay up with a daemon that never answers) or `opening` was
   * cancelled meanwhile (LinkError connection_lost). Giving up closes the pipe,
   * which must end what it owns (the SSH channel, a process).
   */
  static async open(
    connector: Connector,
    capabilities: string[],
    budgets: Budgets,
    timeout: number,
    opening = new Opening()
  ): Promise<Link> {
    const signal = opening.controller.signal
    let pipe: Pipe | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    const abandon = (): void => {
      if (pipe) pipe.close()
      pipe = null
    }
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new LinkError('timeout', 'no hello in time')), timeout)
    })
    const cancelled = new Promise<never>((_, reject) => {
      if (signal.aborted) reject(new LinkError('connection_lost', 'cancelled'))
      else signal.addEventListener('abort', () => reject(new LinkError('connection_lost', 'cancelled')), { once: true })
    })
    const handshake = (async (): Promise<Link> => {
      const opened = await connector(signal)
      if (signal.aborted) {
        opened.close()
        throw new LinkError('connection_lost', 'cancelled')
      }
      pipe = opened
      const reader = new FrameReader(budgets.frame_bytes)
      const rest: HostFrame[] = []
      const reply = await new Promise<HostFrame>((resolve, reject) => {
        let done = false
        opened.onData((chunk) => {
          if (done) return
          let frames: HostFrame[]
          try {
            frames = reader.push(chunk)
          } catch (e) {
            done = true
            reject(e instanceof Error ? e : new LinkError('protocol'))
            return
          }
          if (frames.length) {
            done = true
            rest.push(...frames.slice(1))
            resolve(frames[0]!)
          }
        })
        opened.onEnd((error) => {
          if (done) return
          done = true
          reject(new LinkError('connection_lost', error ? error.message : 'closed before hello'))
        })
        const hello: ClientFrame = {
          version: PROTOCOL_VERSION,
          request_id: 1,
          message: { kind: 'hello', body: { versions: [PROTOCOL_VERSION], capabilities, budgets } }
        }
        opened.write(encodeFrame(hello))
      })
      if (reply.error) throw new HostError(reply.error)
      if (reply.reply_to !== 1 || !reply.ok || reply.ok.kind !== 'hello_ok') throw new LinkError('protocol', 'no hello_ok')
      const agreed = asHelloOk(reply.ok.body)
      const link = new Link(opened, agreed, reader)
      // Frames that came in the same chunk as the hello (none by contract: the
      // host waits for the next request), dispatched all the same.
      for (const frame of rest) link.dispatch(frame)
      return link
    })()
    try {
      return await Promise.race([handshake, timedOut, cancelled])
    } catch (e) {
      abandon()
      // The handshake may still settle later: nothing listens, and its pipe is closed.
      handshake.catch(() => {})
      throw e
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  get alive(): boolean {
    return this._alive
  }

  /** Ends this connection for good: its pipe (and the process behind it) goes. */
  shutdown(): void {
    this.pipe.close()
    this.end()
  }

  onClose(listener: () => void): void {
    if (this._alive) this.closed.push(listener)
    else listener()
  }

  /**
   * One request and its reply (the ok message). At most `in_flight` wait for
   * the host at once; the next ones wait here, so the host never answers busy
   * for that. Rejects with HostError (refused) or LinkError (lost, timeout).
   */
  async request(kind: string, body: unknown, timeout: number): Promise<Message> {
    if (!this._alive) throw new LinkError('connection_lost')
    while (this.pending.size >= this.hello.budgets.in_flight) {
      await new Promise<void>((resolve) => this.waiting.push(resolve))
      if (!this._alive) throw new LinkError('connection_lost')
    }
    const id = this.nextId++
    const message: Message = body === undefined ? { kind } : { kind, body }
    return new Promise<Message>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.wake()
        reject(new LinkError('timeout', kind))
      }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.pipe.write(encodeFrame({ version: PROTOCOL_VERSION, request_id: id, message }, this.frameLimit))
      } catch (e) {
        clearTimeout(timer)
        this.pending.delete(id)
        this.wake()
        if (e instanceof FrameError) reject(e)
        else {
          // The other end is gone: no request goes through this link any more.
          this.end()
          reject(new LinkError('connection_lost'))
        }
      }
    })
  }

  /** The request number the next request will carry (for a cancel of one in flight). */
  get nextRequestId(): number {
    return this.nextId
  }

  /**
   * Claims a stream: events that came before the claim are delivered first, in
   * order. Each event is handed to `handler` once, in sequence; an older one
   * (a replay overlapping what was seen) is dropped; a jump is delivered with
   * `gap: true` and never applied silently by the handler. The acknowledgment
   * goes out once the handler is done with the event.
   */
  register(stream: string, handler: StreamHandler): void {
    const route: Route = { handler, last: 0, queue: [], busy: false }
    this.routes.set(stream, route)
    const early = this.orphans.get(stream) ?? []
    this.orphans.delete(stream)
    for (const frame of early) this.deliver(stream, route, frame)
  }

  unregister(stream: string): void {
    this.routes.delete(stream)
    this.orphans.delete(stream)
  }

  ack(stream: string, seq: number): void {
    if (!this._alive) return
    try {
      this.pipe.write(encodeFrame({ version: PROTOCOL_VERSION, ack: { stream, seq } }, this.frameLimit))
    } catch {
      this.end()
    }
  }

  private onData(chunk: Buffer): void {
    if (!this._alive) return
    let frames: HostFrame[]
    try {
      frames = this.reader.push(chunk)
    } catch {
      // The host broke the contract: nothing after this can be trusted.
      this.shutdown()
      return
    }
    for (const frame of frames) {
      if (!this._alive) return
      this.dispatch(frame)
    }
  }

  private dispatch(frame: HostFrame): void {
    {
      if (frame.reply_to !== undefined) {
        const waiter = this.pending.get(frame.reply_to)
        if (!waiter) return
        this.pending.delete(frame.reply_to)
        clearTimeout(waiter.timer)
        this.wake()
        if (frame.ok) waiter.resolve(frame.ok)
        else waiter.reject(new HostError(frame.error!))
        return
      }
      if (frame.stream && frame.event) {
        const route = this.routes.get(frame.stream.id)
        if (route) this.deliver(frame.stream.id, route, frame)
        else this.orphan(frame.stream.id, frame)
        return
      }
      // A connection error: the host closes after it.
      this.shutdown()
      return
    }
  }

  private orphan(stream: string, frame: HostFrame): void {
    const queue = this.orphans.get(stream)
    if (!queue) {
      if (this.orphans.size >= MAX_ORPHAN_STREAMS) return
      this.orphans.set(stream, [frame])
      return
    }
    if (queue.length < MAX_ORPHAN_EVENTS) queue.push(frame)
  }

  private deliver(stream: string, route: Route, frame: HostFrame): void {
    const seq = frame.stream!.seq
    if (seq <= route.last) return
    const item: StreamItem = { seq, kind: frame.event!.kind, body: frame.event!.body, gap: seq !== route.last + 1 }
    route.last = seq
    route.queue.push(item)
    if (!route.busy) void this.drain(stream, route)
  }

  private async drain(stream: string, route: Route): Promise<void> {
    route.busy = true
    try {
      while (route.queue.length) {
        const item = route.queue.shift()!
        if (this.routes.get(stream) !== route) return
        try {
          await route.handler(item)
        } catch {
          /* a handler's failure never stops the stream */
        }
        if (this.routes.get(stream) === route) this.ack(stream, item.seq)
      }
    } finally {
      route.busy = false
    }
  }

  private wake(): void {
    const next = this.waiting.shift()
    if (next) next()
  }

  private end(): void {
    if (!this._alive) return
    this._alive = false
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer)
      waiter.reject(new LinkError('connection_lost'))
    }
    this.pending.clear()
    for (const w of this.waiting.splice(0)) w()
    this.routes.clear()
    this.orphans.clear()
    for (const listener of this.closed.splice(0)) {
      try {
        listener()
      } catch {
        /* a listener's failure is its own */
      }
    }
  }
}

function asHelloOk(body: unknown): HelloOk {
  const b = body as Record<string, unknown> | null
  const budgets = b && (b.budgets as Record<string, unknown> | null)
  if (
    !b ||
    typeof b !== 'object' ||
    b.version !== PROTOCOL_VERSION ||
    !Array.isArray(b.capabilities) ||
    !b.capabilities.every((c) => typeof c === 'string') ||
    typeof b.host_epoch !== 'string' ||
    !budgets ||
    typeof budgets !== 'object'
  )
    throw new LinkError('protocol', 'hello_ok shape')
  const n = (k: keyof Budgets): number => {
    const v = budgets[k]
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1) throw new LinkError('protocol', 'hello_ok budgets')
    return v
  }
  return {
    version: PROTOCOL_VERSION,
    capabilities: b.capabilities as string[],
    host_epoch: b.host_epoch,
    budgets: {
      frame_bytes: n('frame_bytes'),
      terminal_ring_bytes: n('terminal_ring_bytes'),
      total_ring_bytes: n('total_ring_bytes'),
      stream_window_bytes: n('stream_window_bytes'),
      in_flight: n('in_flight')
    }
  }
}
