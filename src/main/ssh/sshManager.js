// One SSH connection per host, shared by everything Tessel does there: the
// terminals (shell channels with a PTY), the Files / Changes / editor session
// and the add-project browser (one exec channel running `exec /bin/sh`), the
// connection test. Like Orca's ssh-connection-manager.ts (MIT, Copyright (c)
// 2026 Lovecast Inc.).
//
// - The first channel a host needs connects (sshConnection.js: host key
//   check, sign-in ladder, questions to the user); channels asked for
//   meanwhile wait for that same attempt, so the user is asked once.
// - Transient network failures are retried a few times (a short ladder);
//   a refused host key, a failed or cancelled sign-in are not.
// - The password / passphrases the user typed are kept in memory only, per
//   host and endpoint (user@host:port), for reconnects; Disconnect, removing
//   the host or closing the terminal host forgets them. Never on disk, never
//   logged, never sent anywhere but ssh2.
// - A connection with no channel left is closed after IDLE_CLOSE_MS.
// - A server that refuses another channel on a busy connection (OpenSSH's
//   MaxSessions, 10 by default) gets a second connection to the same host,
//   signed in with the kept credentials (no new question).
import { connectSsh } from './sshConnection'

export const IDLE_CLOSE_MS = 5 * 60 * 1000
export const RETRY_DELAYS_MS = [2000, 5000]
const MAX_CONNECTIONS_PER_HOST = 4

const endpointOf = (spec) => `${spec.username || ''}@${String(spec.host).toLowerCase()}:${spec.port || 22}`

export function createSshManager({
  ask, // (hostId, prompt) -> Promise<string|null>
  hostKeys = null,
  connect = connectSsh,
  connectOptions = {},
  onState = () => {}, // (hostId, { status, code?, params? })
  log = () => {},
  timers = { setTimeout, clearTimeout },
  idleCloseMs = IDLE_CLOSE_MS,
  retryDelays = RETRY_DELAYS_MS
} = {}) {
  const entries = new Map() // hostId\nendpoint -> entry
  const creds = new Map() // hostId\nendpoint -> { password, passphrases }
  const states = new Map() // hostId -> { status, code?, params? }

  function setState(hostId, state) {
    states.set(hostId, state)
    try {
      onState(hostId, state)
    } catch {
      /* the listener is gone */
    }
  }

  function credsFor(key) {
    let c = creds.get(key)
    if (!c) {
      c = { password: null, passphrases: new Map() }
      creds.set(key, c)
    }
    return c
  }

  function entryFor(hostId, spec) {
    const key = `${hostId}\n${endpointOf(spec)}`
    let e = entries.get(key)
    if (!e) {
      e = { key, hostId, spec, conns: [], connecting: null, idleTimer: null, generation: 0 }
      entries.set(key, e)
    }
    // A host edited meanwhile (same endpoint): the next connection uses it.
    e.spec = spec
    return e
  }

  const liveConns = (e) => e.conns.filter((c) => !c.closed)
  const channelCount = (e) => liveConns(e).reduce((n, c) => n + c.channels, 0)

  function hostStatus(hostId) {
    const mine = [...entries.values()].filter((e) => e.hostId === hostId)
    if (mine.some((e) => liveConns(e).length)) return 'connected'
    if (mine.some((e) => e.connecting)) return 'connecting'
    return null
  }

  function attempt(e) {
    const c = credsFor(e.key)
    return connect({
      spec: e.spec,
      creds: c,
      ask: (prompt) => ask(e.hostId, prompt),
      hostKeys,
      log,
      ...connectOptions
    })
  }

  async function connectWithRetry(e) {
    let lastErr = null
    for (let i = 0; i <= retryDelays.length; i++) {
      try {
        return await attempt(e)
      } catch (err) {
        lastErr = err
        if (!err || !err.transient || i === retryDelays.length) break
        await new Promise((r) => timers.setTimeout(r, retryDelays[i]))
      }
    }
    throw lastErr
  }

  // spare: a second connection opened for one channel (not closed as idle
  // before that channel is on it).
  function adopt(e, client, { spare = false } = {}) {
    const conn = { client, channels: 0, closed: false, closing: false }
    e.conns.push(conn)
    const gone = () => {
      if (conn.closed) return
      conn.closed = true
      e.conns = e.conns.filter((c) => c !== conn)
      const wasUsed = conn.channels > 0
      conn.channels = 0
      if (hostStatus(e.hostId) === 'connected') return
      if (conn.closing || !wasUsed) setState(e.hostId, { status: 'disconnected' })
      else {
        log('warn', `ssh connection to ${e.spec.host}:${e.spec.port || 22} lost`)
        setState(e.hostId, { status: 'disconnected', code: 'lost', params: { host: e.spec.host, port: e.spec.port || 22 } })
      }
    }
    client.on('close', gone)
    client.on('end', gone)
    client.on('error', () => {
      /* followed by close */
    })
    setState(e.hostId, { status: 'connected' })
    if (!spare) armIdle(e)
    return conn
  }

  function closeConn(conn) {
    conn.closing = true
    try {
      conn.client.end()
    } catch {
      /* gone */
    }
  }

  function armIdle(e) {
    if (e.idleTimer) {
      timers.clearTimeout(e.idleTimer)
      e.idleTimer = null
    }
    // A spare connection with nothing on it goes at once.
    const live = liveConns(e)
    for (const c of live.slice(1)) if (c.channels === 0) closeConn(c)
    if (channelCount(e) > 0 || !liveConns(e).length) return
    e.idleTimer = timers.setTimeout(() => {
      e.idleTimer = null
      if (channelCount(e) === 0) for (const c of liveConns(e)) closeConn(c)
    }, idleCloseMs)
    if (e.idleTimer && e.idleTimer.unref) e.idleTimer.unref()
  }

  // A connected connection for this host (connecting if needed).
  function ensure(e) {
    const live = liveConns(e)
    if (live.length) return Promise.resolve(live[0])
    if (!e.connecting) {
      const generation = e.generation
      setState(e.hostId, { status: 'connecting' })
      e.connecting = connectWithRetry(e)
        .then((client) => {
          // Disconnected while signing in: this connection is not wanted.
          if (generation !== e.generation) {
            try {
              client.end()
            } catch {
              /* gone */
            }
            throw Object.assign(new Error('ssh cancelled'), { code: 'auth-cancelled', params: {} }) // i18n-ignore internal: translated by code
          }
          return adopt(e, client)
        })
        .catch((err) => {
          const code = (err && err.code) || 'failed'
          // (This attempt is still "connecting" here: only another live
          // connection to the host keeps it from showing the failure.)
          if (hostStatus(e.hostId) !== 'connected') {
            if (code === 'auth-cancelled') setState(e.hostId, { status: 'disconnected' })
            else setState(e.hostId, { status: 'error', code, params: (err && err.params) || {} })
          }
          throw err
        })
        .finally(() => {
          e.connecting = null
        })
    }
    return e.connecting
  }

  function openOn(conn, kind, opts) {
    return new Promise((resolve, reject) => {
      const done = (err, stream) => {
        if (err) return reject(err)
        // A command that ends at once can report its exit status (and close)
        // before the caller's listeners are attached: kept on the stream.
        stream.on('exit', (...args) => {
          stream.tesselExit = args
        })
        stream.once('close', () => {
          stream.tesselClosed = true
        })
        resolve(stream)
      }
      try {
        if (kind === 'sftp') conn.client.sftp(done)
        else if (kind === 'shell') conn.client.shell(opts.pty || {}, done)
        else conn.client.exec(opts.command, opts.pty ? { pty: opts.pty } : {}, done)
      } catch (err) {
        reject(err)
      }
    })
  }

  function track(e, conn, stream) {
    conn.channels++
    if (e.idleTimer) {
      timers.clearTimeout(e.idleTimer)
      e.idleTimer = null
    }
    let released = false
    const release = () => {
      if (released) return
      released = true
      if (!conn.closed) conn.channels = Math.max(0, conn.channels - 1)
      armIdle(e)
    }
    if (stream.tesselClosed) release()
    else stream.once('close', release)
    // Whether the connection under this channel is still up (a channel that
    // closed without an exit status: the remote end closed it, or the
    // connection went away).
    return { stream, release, client: conn.client, connectionAlive: () => !conn.closed }
  }

  // kind: 'exec' ({ command, pty? }) | 'shell' ({ pty }) | 'sftp'
  // -> Promise<{ stream, release, client }>; rejects with an sshError.
  async function open(hostId, spec, kind, opts = {}) {
    const e = entryFor(hostId, spec)
    const conn = await ensure(e)
    try {
      return track(e, conn, await openOn(conn, kind, opts))
    } catch (err) {
      // Refused on a busy connection: a second one (kept credentials).
      if (conn.channels > 0 && liveConns(e).length < MAX_CONNECTIONS_PER_HOST && !conn.closed) {
        const client = await connectWithRetry(e)
        const extra = adopt(e, client, { spare: true })
        try {
          return track(e, extra, await openOn(extra, kind, opts))
        } catch (err2) {
          closeConn(extra)
          throw Object.assign(new Error('ssh channel'), { code: 'channel', params: { detail: String((err2 && err2.message) || '').slice(0, 200) } }) // i18n-ignore internal: translated by code
        }
      }
      throw Object.assign(new Error('ssh channel'), { code: 'channel', params: { detail: String((err && err.message) || '').slice(0, 200) } }) // i18n-ignore internal: translated by code
    }
  }

  // Signed in (a connection test). -> Promise<void>
  async function connectHost(hostId, spec) {
    const e = entryFor(hostId, spec)
    await ensure(e)
    armIdle(e)
  }

  // Disconnect: every connection to the host ends, its kept credentials are
  // forgotten, a sign-in in progress is dropped when it ends.
  function disconnect(hostId) {
    for (const e of [...entries.values()]) {
      if (e.hostId !== hostId) continue
      e.generation++
      if (e.idleTimer) timers.clearTimeout(e.idleTimer)
      e.idleTimer = null
      for (const c of liveConns(e)) closeConn(c)
      if (!e.connecting) entries.delete(e.key)
    }
    for (const k of [...creds.keys()]) if (k.startsWith(`${hostId}\n`)) creds.delete(k)
    setState(hostId, { status: 'disconnected' })
  }

  function closeAll() {
    for (const hostId of new Set([...entries.values()].map((e) => e.hostId))) disconnect(hostId)
    creds.clear()
  }

  function snapshot() {
    return Object.fromEntries(states)
  }

  return {
    open,
    connectHost,
    disconnect,
    closeAll,
    snapshot,
    // For tests and diagnostics: never the secrets themselves.
    connectionCount: (hostId) => [...entries.values()].filter((e) => e.hostId === hostId).reduce((n, e) => n + liveConns(e).length, 0),
    hasKeptPassword: (hostId) => [...creds].some(([k, c]) => k.startsWith(`${hostId}\n`) && c.password != null)
  }
}
