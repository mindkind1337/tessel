// tessel-host on each SSH host, from the app, the way VS Code puts its server
// there: at the first connection (once the Files session is signed in, so
// nothing is asked twice), the program of this build's release is checked
// on the host, put there when missing (over the signed-in connection, under
// the user's home, no root), and joined over one more exec channel of the
// same connection running `tessel-host connect --stdio`. The daemon then
// serves the file tree and git status (remote.ts). A host where that is
// impossible (another kind of machine, a home that refuses to run programs,
// no bundle in this build) keeps the shell-based path as before, and says
// which one it uses (status()).
//
// Every command run here is one of tessel_host::install's fixed templates
// (install.ts), passed to the host as it is; nothing from the window reaches
// them. The daemon's own program is never downloaded at run time.
import { randomBytes } from 'node:crypto'
import { type BundledHost } from './bundled'
import { Client } from './client'
import { type Arch, archFromUname, checkVersion, commands, parseDigest, plan } from './install'
import { type Pipe } from './link'

/** What a host's shell session answers for one command (remoteFs.js call). */
export type RunResult = { rc: number; out: Buffer; err: string } | { error: string; code?: string }

/** A child-process-like object over an exec channel running /bin/sh (ssh/sshRemote.js ChannelChild). */
export interface ShellChannel {
  stdout: { on(event: 'data', listener: (chunk: Buffer) => void): unknown }
  /** What the shell or the daemon's bridge printed (its own fixed sentences): kept for the failure's detail. */
  stderr?: { on(event: 'data', listener: (chunk: Buffer) => void): unknown }
  stdin: { write(data: Buffer | string): boolean; end(): void }
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown
  kill(): unknown
}

export interface DaemonDeps {
  /** This build's tessel-host release (null: no programs shipped). */
  bundle: BundledHost | null
  /** Runs one plan command on the host (a signed-in session), with bytes on its standard input when given. */
  run(hostId: string, command: string, opts: { upload?: Buffer; timeoutMs: number }): Promise<RunResult>
  /** A fresh exec channel on the host's live connection running `connect` (the plan's connect command; null: none to be had). */
  channel(hostId: string, connect: string): Promise<ShellChannel | null>
  /** Whether the host's connection is signed in now (nothing is asked for the daemon). */
  connected(hostId: string): boolean
  log?: (text: string) => void
  now?: () => number
  timers?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout }
}

export type DaemonStatus =
  | { ok: true; client: Client; source: 'had' | 'installed'; version: string }
  | { ok: false; reason: 'no-bundle' | 'not-connected' | 'unsupported' | 'checksum' | 'install-failed' | 'connect-failed' | 'failed'; detail?: string }

/** A failed install or connection is tried again after this, by itself while the host stays connected. */
export const RETRY_MS = 60_000
const STDERR_KEPT = 2048
const RUN_MS = 60_000
const UPLOAD_MS = 180_000
/** Reasons that hold for the app run (the same tomorrow). */
type FailReason = Extract<DaemonStatus, { ok: false }>['reason']
const LASTING = new Set<FailReason>(['no-bundle', 'unsupported'])

interface HostState {
  arch: Arch | null
  /** Bumped by close(): a work() started before gives up at its next step. */
  generation: number
  client: Client | null
  settled: DaemonStatus | null
  running: Promise<DaemonStatus> | null
  lastFailure: { at: number; status: DaemonStatus } | null
  retry: ReturnType<typeof setTimeout> | null
}

/** A link's pipe over an exec channel running the daemon's connect command. */
export function pipeFromShellChannel(child: ShellChannel): Pipe {
  let ended = false
  const ends: Array<(error?: Error) => void> = []
  let said = ''
  child.stderr?.on('data', (chunk) => {
    said = (said + chunk.toString('utf8')).slice(-STDERR_KEPT)
  })
  const end = (error?: Error): void => {
    if (ended) return
    ended = true
    for (const l of ends.splice(0)) l(error)
  }
  // The channel ended by itself: the bridge's exit and its last words say why
  // (the daemon did not start, a refused socket).
  child.on('exit', (code, signal) => {
    const words = said.replace(/\s+/g, ' ').trim().slice(0, 300)
    end(new Error(`exit ${code ?? signal ?? '?'}${words ? `: ${words}` : ''}`))
  })
  return {
    onData: (listener) => void child.stdout.on('data', listener),
    onEnd: (listener) => (ended ? listener() : void ends.push(listener)),
    write(chunk) {
      if (ended) throw new Error('channel ended')
      child.stdin.write(chunk)
    },
    close() {
      try {
        child.kill()
      } finally {
        end()
      }
    }
  }
}

export function createHostDaemons(deps: DaemonDeps) {
  const log = deps.log ?? (() => {})
  const now = deps.now ?? (() => Date.now())
  const timers = deps.timers ?? { setTimeout, clearTimeout }
  const hosts = new Map<string, HostState>()
  const state = (hostId: string): HostState => {
    let s = hosts.get(hostId)
    if (!s) {
      s = { arch: null, generation: 0, client: null, settled: null, running: null, lastFailure: null, retry: null }
      hosts.set(hostId, s)
    }
    return s
  }
  const text = (res: RunResult): string => ('error' in res ? res.error : res.out.toString('utf8'))
  const failed = (reason: FailReason, detail?: string): DaemonStatus => (detail ? { ok: false, reason, detail } : { ok: false, reason })

  async function work(hostId: string, s: HostState): Promise<DaemonStatus> {
    const bundle = deps.bundle
    if (!bundle) return failed('no-bundle')
    if (!deps.connected(hostId)) return failed('not-connected')
    const generation = s.generation
    // The host was closed meanwhile (a disconnect during the install): this
    // work is of no use and must not reach the host again.
    const gone = (): boolean => s.generation !== generation || !deps.connected(hostId)
    const run = async (command: string, opts: { upload?: Buffer; timeoutMs?: number } = {}): Promise<RunResult> => {
      if (gone()) return { error: 'not connected', code: 'not-connected' }
      const res = await deps.run(hostId, command, { timeoutMs: opts.timeoutMs ?? RUN_MS, ...(opts.upload ? { upload: opts.upload } : {}) })
      if (gone()) return { error: 'not connected', code: 'not-connected' }
      return res
    }
    const lost = (res: RunResult): boolean => 'error' in res && res.code === 'not-connected'
    if (!s.arch) {
      const probe = await run('uname -m')
      if (lost(probe)) return failed('not-connected')
      if ('error' in probe) return failed('failed', probe.error)
      const arch = archFromUname(probe.out.toString('utf8'))
      if (!arch) return failed('unsupported', probe.out.toString('utf8').trim().slice(0, 40))
      s.arch = arch
    }
    const arch = s.arch
    const fixed = commands(bundle.version, arch)
    if (!fixed) return failed('failed', 'bad version')
    let source: 'had' | 'installed' = 'had'
    const had = await run(fixed.version)
    if (lost(had)) return failed('not-connected')
    if (!('error' in had) && had.rc === 0 && checkVersion(had.out.toString('utf8'), bundle.version, arch)) {
      // This release is there already.
    } else {
      const artifact = bundle.artifact(arch)
      const bytes = bundle.read(arch)
      if (!artifact || !bytes) return failed('unsupported', `no program for ${arch}`)
      const p = plan(bundle.version, arch, randomBytes(8).toString('hex'))
      if (!p) return failed('failed', 'bad plan')
      const up = await run(p.upload, { upload: bytes, timeoutMs: UPLOAD_MS })
      if (lost(up)) return failed('not-connected')
      if ('error' in up || up.rc !== 0) {
        void run(p.abort).catch(() => {})
        return failed('install-failed', `upload: ${'error' in up ? up.error : `exit ${up.rc}`}`)
      }
      const digest = await run(p.digest)
      if (lost(digest)) return failed('not-connected')
      if ('error' in digest || parseDigest(digest.out.toString('utf8')) !== artifact.sha256) {
        void run(p.abort).catch(() => {})
        return failed('checksum')
      }
      const activated = await run(p.activate)
      if (lost(activated)) return failed('not-connected')
      if ('error' in activated || activated.rc !== 0 || !checkVersion(activated.out.toString('utf8'), bundle.version, arch)) {
        void run(p.abort).catch(() => {})
        return failed('install-failed', `activate: ${'error' in activated ? activated.error : `exit ${activated.rc}`}`)
      }
      source = 'installed'
      log(`tessel-host ${bundle.version} (${arch}) put on ${hostId}`)
    }
    const connect = fixed.connect
    const connector = async (): Promise<Pipe> => {
      const child = await deps.channel(hostId, connect)
      if (!child) throw new Error('no channel')
      return pipeFromShellChannel(child)
    }
    if (gone()) return failed('not-connected')
    let client: Client
    try {
      client = await Client.connect(connector, { capabilities: ['tree', 'git'] })
    } catch (e) {
      return failed('connect-failed', e instanceof Error ? e.message : String(e))
    }
    if (gone()) {
      // Closed while connecting: never the host's client.
      client.close()
      return failed('not-connected')
    }
    s.client = client
    client.onState((st) => {
      if (st.kind === 'closed' && s.client === client) s.client = null
      if (st.kind === 'restarted') log(`tessel-host on ${hostId} restarted (${st.previous.slice(0, 8)} -> ${st.current.slice(0, 8)})`)
    })
    return { ok: true, client, source, version: bundle.version }
  }

  /** The daemon of a host: connected, put there first when needed. Once per host at a time. */
  function ensure(hostId: string): Promise<DaemonStatus> {
    const s = state(hostId)
    if (s.client && !s.client.closed) return Promise.resolve({ ok: true, client: s.client, source: 'had', version: deps.bundle?.version ?? '' })
    if (s.settled) return Promise.resolve(s.settled)
    if (s.running) return s.running
    if (s.lastFailure && now() - s.lastFailure.at < RETRY_MS) return Promise.resolve(s.lastFailure.status)
    s.running = work(hostId, s)
      .catch((e): DaemonStatus => failed('failed', e instanceof Error ? e.message : String(e)))
      .then((status) => {
        s.running = null
        if (!status.ok) {
          if (LASTING.has(status.reason)) s.settled = status
          else if (status.reason !== 'not-connected') {
            s.lastFailure = { at: now(), status }
            // Tried again by itself (a daemon slow to start, a link cut during the
            // install): nothing else would ask while the host stays connected.
            if (s.retry) timers.clearTimeout(s.retry)
            s.retry = timers.setTimeout(() => {
              s.retry = null
              if (deps.connected(hostId)) void ensure(hostId)
            }, RETRY_MS)
          }
          if (status.reason !== 'not-connected') log(`tessel-host on ${hostId}: ${status.reason}${status.detail ? ` (${status.detail})` : ''}`)
        }
        return status
      })
    return s.running
  }

  /** The live client of a host, or null (nothing is started here). */
  function client(hostId: string): Client | null {
    const s = hosts.get(hostId)
    return s && s.client && !s.client.closed ? s.client : null
  }

  /** What a host uses now: 'daemon', or the reason it does not. */
  function status(hostId: string): { daemon: boolean; reason?: string } {
    const s = hosts.get(hostId)
    if (!s) return { daemon: false }
    if (s.client && !s.client.closed) return { daemon: true }
    const last = s.settled ?? s.lastFailure?.status ?? null
    return last && !last.ok ? { daemon: false, reason: last.reason } : { daemon: false }
  }

  /** The host's connection ended (disconnect, removed, Tessel closing): its client goes. */
  function close(hostId: string): void {
    const s = hosts.get(hostId)
    if (!s) return
    s.generation++
    if (s.retry) {
      timers.clearTimeout(s.retry)
      s.retry = null
    }
    const c = s.client
    s.client = null
    c?.close()
  }

  function closeAll(): void {
    for (const id of [...hosts.keys()]) close(id)
  }

  return { ensure, client, status, close, closeAll }
}

export type HostDaemons = ReturnType<typeof createHostDaemons>
