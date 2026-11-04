// A connection to one host daemon that reconnects by itself (the same part as
// crates/host-client/src/lib.rs on the Rust side). Sessions (a file tree, a
// repository's status) register to be resumed on a new link: on the same
// daemon they subscribe again; on a restarted one (another host_epoch) they
// open their root again by its path first.
import { type Connector, Link, Opening } from './link'
import { type Budgets, type HelloOk, type HostInfo, type Message, SLOW_HOST, LinkError, isConnectionLost } from './wire'

export interface ClientOptions {
  capabilities: string[]
  budgets: Budgets
  /** How long one request may wait for its answer, ms. */
  requestTimeout: number
  /** One connection attempt, from opening the pipe to the daemon's hello, ms. */
  connectTimeout: number
  /** Longest pause between two reconnection attempts, ms. */
  maxBackoff: number
}

export const DEFAULT_OPTIONS: ClientOptions = {
  capabilities: ['tree', 'git'],
  budgets: SLOW_HOST,
  requestTimeout: 30_000,
  connectTimeout: 20_000,
  maxBackoff: 5_000
}

export type ConnectionState =
  | { kind: 'connected'; epoch: string }
  | { kind: 'reconnecting'; attempt: number }
  | { kind: 'restarted'; previous: string; current: string }
  | { kind: 'closed' }

/** A session that knows how to continue on a new link. */
export interface Resumable {
  /** `sameEpoch`: the same daemon (subscribe again); otherwise a restarted one (open again by path). */
  resume(client: Client, sameEpoch: boolean): Promise<void>
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const t = setTimeout(done, ms)
    function done(): void {
      clearTimeout(t)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })

export class Client {
  readonly options: ClientOptions
  /** What the daemon said about itself on the first connection (`host.info`). */
  readonly info: HostInfo | null
  private readonly connector: Connector
  private link: Link | null
  private opening: Opening | null = null
  private _state: ConnectionState
  private readonly sessions = new Set<WeakRef<Resumable>>()
  private readonly stateListeners = new Set<(state: ConnectionState) => void>()
  private readonly connectedWaiters: Array<() => void> = []
  private readonly closing = new AbortController()

  private constructor(connector: Connector, options: ClientOptions, link: Link, info: HostInfo | null) {
    this.connector = connector
    this.options = options
    this.link = link
    this.info = info
    this._state = { kind: 'connected', epoch: link.hello.host_epoch }
    link.onClose(() => void this.supervise(link))
  }

  /**
   * Connects once within `connectTimeout` (a failure here is thrown, not
   * retried), asks `host.info`, then keeps the link up. `opening.cancel()`
   * abandons the first connection (a Cancel button).
   */
  static async connect(connector: Connector, options: Partial<ClientOptions> = {}, opening = new Opening()): Promise<Client> {
    const all: ClientOptions = { ...DEFAULT_OPTIONS, ...options }
    const link = await Link.open(connector, all.capabilities, all.budgets, all.connectTimeout, opening)
    let info: HostInfo | null = null
    try {
      const reply = await link.request('host.info', undefined, all.requestTimeout)
      info = reply.kind === 'host_info' ? (reply.body as HostInfo) : null
    } catch (e) {
      if (isConnectionLost(e)) {
        link.shutdown()
        throw e
      }
      // An older daemon without host.info still serves trees and git.
    }
    return new Client(connector, all, link, info)
  }

  get state(): ConnectionState {
    return this._state
  }

  /** What the daemon agreed to on the current link. */
  get hello(): HelloOk | null {
    return this.link?.hello ?? null
  }

  get epoch(): string | null {
    return this.link?.hello.host_epoch ?? null
  }

  get closed(): boolean {
    return this.closing.signal.aborted
  }

  onState(listener: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  /** The live link, or throws connection_lost while reconnecting. */
  live(): Link {
    if (this.link && this.link.alive) return this.link
    throw new LinkError('connection_lost')
  }

  /** One request on the live link: the reply's body. */
  async ask<T = unknown>(kind: string, body?: unknown): Promise<T> {
    const reply: Message = await this.live().request(kind, body, this.options.requestTimeout)
    return reply.body as T
  }

  /** Waits until a live link exists (on whatever epoch), or `timeout` ms. */
  waitConnected(timeout: number): Promise<boolean> {
    if (this.closed) return Promise.resolve(false)
    if (this.link && this.link.alive) return Promise.resolve(true)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const i = this.connectedWaiters.indexOf(wake)
        if (i >= 0) this.connectedWaiters.splice(i, 1)
        resolve(false)
      }, timeout)
      function wake(this: void): void {
        clearTimeout(timer)
        resolve(true)
      }
      this.connectedWaiters.push(wake)
    })
  }

  /**
   * Runs `call` until it answers, waiting through reconnections within
   * `requestTimeout` (a call must be safe to repeat: the host deduplicates
   * those with an effect).
   */
  async retrying<T>(call: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + this.options.requestTimeout
    for (;;) {
      try {
        return await call()
      } catch (e) {
        if (!isConnectionLost(e) || Date.now() >= deadline) throw e
        if (!(await this.waitConnected(deadline - Date.now()))) throw new LinkError('connection_lost')
      }
    }
  }

  register(session: Resumable): void {
    for (const ref of this.sessions) if (!ref.deref()) this.sessions.delete(ref)
    this.sessions.add(new WeakRef(session))
  }

  /**
   * Ends the link for good: its pipe is closed, a reconnection in progress is
   * abandoned, and the client does not reconnect. Sessions on the host go on.
   */
  close(): void {
    if (this.closed) return
    this.closing.abort()
    this.opening?.cancel()
    this.opening = null
    const link = this.link
    this.link = null
    link?.shutdown()
    this.setState({ kind: 'closed' })
    for (const w of this.connectedWaiters.splice(0)) w()
  }

  private setState(state: ConnectionState): void {
    if (this.closed && state.kind !== 'closed') return
    this._state = state
    for (const listener of this.stateListeners) {
      try {
        listener(state)
      } catch {
        /* a listener's failure is its own */
      }
    }
  }

  private async supervise(lost: Link): Promise<void> {
    if (this.closed || this.link !== lost) return
    const previous = lost.hello.host_epoch
    let attempt = 0
    let pause = 100
    let fresh: Link | null = null
    while (!fresh) {
      if (this.closed) return
      attempt++
      this.setState({ kind: 'reconnecting', attempt })
      const opening = new Opening()
      this.opening = opening
      try {
        fresh = await Link.open(this.connector, this.options.capabilities, this.options.budgets, this.options.connectTimeout, opening)
      } catch {
        if (this.closed) return
        await sleep(pause, this.closing.signal)
        pause = Math.min(pause * 2, this.options.maxBackoff)
      } finally {
        if (this.opening === opening) this.opening = null
      }
    }
    if (this.closed) {
      // Closed while this link opened: it never becomes the client's.
      fresh.shutdown()
      return
    }
    const current = fresh.hello.host_epoch
    const same = current === previous
    this.link = fresh
    fresh.onClose(() => void this.supervise(fresh!))
    this.setState(same ? { kind: 'connected', epoch: current } : { kind: 'restarted', previous, current })
    for (const w of this.connectedWaiters.splice(0)) w()
    const sessions: Resumable[] = []
    for (const ref of this.sessions) {
      const s = ref.deref()
      if (s) sessions.push(s)
      else this.sessions.delete(ref)
    }
    for (const session of sessions) {
      try {
        await session.resume(this, same)
      } catch {
        /* the session reports its own state */
      }
    }
  }
}
