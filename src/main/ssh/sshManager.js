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
import net from 'node:net'
import { connectSsh, KEEPALIVE_INTERVAL_MS, KEEPALIVE_COUNT_MAX } from './sshConnection'

export const IDLE_CLOSE_MS = 5 * 60 * 1000
export const RETRY_DELAYS_MS = [2000, 5000]
export const CREDENTIALS_MAX_AGE_MS = 8 * 60 * 60 * 1000
const MAX_CONNECTIONS_PER_HOST = 4

// What a lost connection leaves in the log (one line, no secret): which event
// ended it, the local port to match with sshd's own log, how long it lived, how
// long since a byte moved either way, and whether this process itself stalled.
const SAMPLE_MS = 1000
const LAG_KEEP = 60
const PROBE_TIMEOUT_MS = 3000
const sec = (ms) => `${Math.max(0, Math.round(ms / 1000))}s`

// How late this process's timers fire, sampled each second: a stalled process
// (the terminal host) would let the keepalives expire. -> () => peak of the last minute, in ms.
function createLagMeter(timers = { setTimeout, clearTimeout }) {
  const peaks = []
  let expected = Date.now() + SAMPLE_MS
  const tick = () => {
    const late = Math.max(0, Date.now() - expected)
    peaks.push(late)
    if (peaks.length > LAG_KEEP) peaks.shift()
    expected = Date.now() + SAMPLE_MS
    const h = timers.setTimeout(tick, SAMPLE_MS)
    if (h && h.unref) h.unref()
  }
  const h = timers.setTimeout(tick, SAMPLE_MS)
  if (h && h.unref) h.unref()
  return () => (peaks.length ? Math.max(...peaks) : 0)
}

// Is the server's SSH port reachable right now (a plain TCP connect, nothing sent)?
function probeTcp(host, port, run = net.connect) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    let done = false
    const sock = run({ host, port })
    const end = (result) => {
      if (done) return
      done = true
      try {
        sock.destroy()
      } catch {
        /* gone */
      }
      resolve(result)
    }
    sock.setTimeout(PROBE_TIMEOUT_MS, () => end(`no answer in ${PROBE_TIMEOUT_MS / 1000}s`))
    sock.once('connect', () => end(`reachable in ${Date.now() - t0}ms`))
    sock.once('error', (err) => end(`failed (${(err && (err.code || err.message)) || 'error'})`))
  })
}

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
  retryDelays = RETRY_DELAYS_MS,
  hasShells = () => false, // (hostId) -> a terminal on it may still reconnect
  now = () => Date.now(),
  credentialsMaxAgeMs = CREDENTIALS_MAX_AGE_MS
} = {}) {
  const entries = new Map() // hostId\nendpoint -> entry
  const creds = new Map() // hostId\nendpoint -> { password, passphrases }
  const states = new Map() // hostId -> { status, code?, params? }
  const lagPeak = createLagMeter(timers)

  function setState(hostId, state) {
    states.set(hostId, state)
    try {
      onState(hostId, state)
    } catch {
      /* the listener is gone */
    }
  }

  // Kept credentials (and the host key pinned for an unchecked host): at
  // most credentialsMaxAgeMs, then asked again.
  function credsFor(key) {
    let c = creds.get(key)
    if (c && now() - c.since > credentialsMaxAgeMs) c = null
    if (!c) {
      c = { password: null, passphrases: new Map(), pinnedKey: null, since: now() }
      creds.set(key, c)
    }
    return c
  }

  // The last connection of an entry closed: its credentials go too, unless
  // a terminal on the host will reconnect with them.
  function forgetIfUnused(e) {
    if (liveConns(e).length || e.connecting || hasShells(e.hostId)) return
    creds.delete(e.key)
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
    const conn = { client, channels: 0, closed: false, closing: false, openedAt: now(), events: [], why: '' }
    e.conns.push(conn)
    // The socket under ssh2 (internal, so read defensively): its local port
    // lets the line be matched with the server's log, its byte counters tell when
    // something last moved.
    const sock = client && client._sock
    const traffic = { rx: sock ? sock.bytesRead : 0, tx: sock ? sock.bytesWritten : 0, rxAt: conn.openedAt, txAt: conn.openedAt }
    const localPort = sock && sock.localPort ? sock.localPort : '?'
    const sampler = sock
      ? setInterval(() => {
          if (sock.bytesRead !== traffic.rx) {
            traffic.rx = sock.bytesRead
            traffic.rxAt = now()
          }
          if (sock.bytesWritten !== traffic.tx) {
            traffic.tx = sock.bytesWritten
            traffic.txAt = now()
          }
        }, SAMPLE_MS)
      : null
    if (sampler && sampler.unref) sampler.unref()
    const keepalive = `${(connectOptions.keepaliveMs || KEEPALIVE_INTERVAL_MS) / 1000}s x${KEEPALIVE_COUNT_MAX}`
    log('info', `ssh connection opened: ${e.spec.host}:${e.spec.port || 22} account=${e.hostId} localPort=${localPort} keepalive=${keepalive}`)
    const note = (event, detail = '') => {
      if (conn.events.length < 8) conn.events.push(`${event}${detail ? `(${detail})` : ''}@${sec(now() - conn.openedAt)}`)
    }
    const gone = () => {
      if (conn.closed) return
      conn.closed = true
      if (sampler) clearInterval(sampler)
      const t = now()
      if (sock) {
        if (sock.bytesRead !== traffic.rx) traffic.rxAt = t
        if (sock.bytesWritten !== traffic.tx) traffic.txAt = t
      }
      log(
        conn.closing ? 'info' : 'warn',
        `ssh connection ended: ${e.spec.host}:${e.spec.port || 22} account=${e.hostId} localPort=${localPort} ` +
          `by=${conn.closing ? `tessel(${conn.why || 'close'})` : 'link'} events=[${conn.events.join(' ') || 'none'}] ` +
          `age=${sec(t - conn.openedAt)} sinceLastRx=${sec(t - traffic.rxAt)} sinceLastTx=${sec(t - traffic.txAt)} ` +
          `channels=${conn.channels} bytesRx=${sock ? traffic.rx : '?'} bytesTx=${sock ? traffic.tx : '?'} ` +
          `keepalive=${keepalive} loopLagMax60s=${Math.round(lagPeak())}ms`
      )
      // Not Tessel's doing: is the server reachable right now, and again shortly
      // after (a blip that is already over, or a link that is still down)?
      if (!conn.closing) {
        const host = e.spec.host
        const port = e.spec.port || 22
        const probe = (label) => probeTcp(host, port).then((r) => log('info', `ssh probe ${label}: ${host}:${port} ${r} (after ${e.hostId} lost localPort=${localPort})`))
        probe('now')
        const h = timers.setTimeout(() => probe('+10s'), 10_000)
        if (h && h.unref) h.unref()
      }
      e.conns = e.conns.filter((c) => c !== conn)
      const wasUsed = conn.channels > 0
      conn.channels = 0
      // After the terminals' own close handlers (which may reconnect).
      timers.setTimeout(() => forgetIfUnused(e), 1000)
      if (hostStatus(e.hostId) === 'connected') return
      if (conn.closing || !wasUsed) setState(e.hostId, { status: 'disconnected' })
      else {
        log('warn', `ssh connection to ${e.spec.host}:${e.spec.port || 22} lost`)
        setState(e.hostId, { status: 'disconnected', code: 'lost', params: { host: e.spec.host, port: e.spec.port || 22 } })
      }
    }
    client.on('close', (hadError) => {
      note('close', hadError ? 'hadError' : '')
      gone()
    })
    client.on('end', () => {
      note('end')
      gone()
    })
    // ssh2's own words: its keepalive giving up is level "client-timeout".
    client.on('error', (err) => {
      note('error', `${(err && (err.code || err.level)) || 'error'}${err && err.level ? `/${err.level}` : ''}: ${String((err && err.message) || '').replace(/[\u0000-\u001f]+/g, ' ').slice(0, 80)}`)
    })
    setState(e.hostId, { status: 'connected' })
    if (!spare) armIdle(e)
    return conn
  }

  function closeConn(conn, why = 'idle') {
    conn.closing = true
    conn.why = why
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
    for (const c of live.slice(1)) if (c.channels === 0) closeConn(c, 'spare unused')
    if (channelCount(e) > 0 || !liveConns(e).length) return
    e.idleTimer = timers.setTimeout(() => {
      e.idleTimer = null
      if (channelCount(e) === 0) for (const c of liveConns(e)) closeConn(c, 'idle')
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

  // lane: a channel opened with onlyLive (remoteFs.js lanes): kept on its
  // connection's list, to give its slot up to a terminal (open below), with
  // how many of its requests are on their way (watchLane).
  function track(e, conn, stream, lane = false) {
    conn.channels++
    if (lane) {
      watchLane(stream)
      ;(conn.lanes || (conn.lanes = new Set())).add(stream)
    }
    if (e.idleTimer) {
      timers.clearTimeout(e.idleTimer)
      e.idleTimer = null
    }
    let released = false
    const release = () => {
      if (released) return
      released = true
      if (conn.lanes) conn.lanes.delete(stream)
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

  // A lane's requests on their way (remoteShell.js protocol: one
  // "__t_q <id> ..." line each, answered by a "@@T <nonce> <id> z" line), so
  // the idle ones give their slot first. Counted only: nothing is read or
  // changed.
  const REQUEST_LINE = /(^|\n)__t_q \d+ /g
  const ANSWER_END = /\n@@T [0-9a-f]{32} \d+ z\r?\n/g
  function watchLane(stream) {
    if (stream.tesselPending !== undefined) return
    stream.tesselPending = 0
    const write = stream.write.bind(stream)
    stream.write = (chunk, ...rest) => {
      const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('latin1') : ''
      const sent = text.match(REQUEST_LINE)
      if (sent) stream.tesselPending += sent.length
      return write(chunk, ...rest)
    }
    let tail = ''
    stream.on('data', (d) => {
      const text = tail + (Buffer.isBuffer(d) ? d.toString('latin1') : String(d))
      let ended = 0
      // A marker split between two pieces is counted once, in the later one.
      for (const m of text.matchAll(ANSWER_END)) if (m.index + m[0].length > tail.length) ended++
      if (ended) stream.tesselPending = Math.max(0, stream.tesselPending - ended)
      tail = text.slice(-80)
    })
  }

  const channelError = (err) => Object.assign(new Error('ssh channel'), { code: 'channel', params: { detail: String((err && err.message) || err || '').slice(0, 200) } }) // i18n-ignore internal: translated by code
  // One lane's channel closed, waited for (its slot is the server's again
  // once the close is done; LANE_YIELD_MS at most).
  const LANE_YIELD_MS = 2000
  function closeLane(s) {
    // Never asked twice (a server that does not answer the close).
    s.tesselYielded = true
    return new Promise((resolve) => {
      if (s.tesselClosed) return resolve()
      const timer = timers.setTimeout(resolve, LANE_YIELD_MS)
      s.once('close', () => {
        timers.clearTimeout(timer)
        resolve()
      })
      try {
        s.close()
      } catch {
        resolve()
      }
    })
  }
  // The next lane to give its slot: an idle one first (no request on its
  // way), a busy one only with busy (its request then fails as "closed" and
  // runs again in the Files session: remoteFs.js). -> { conn, stream } | null
  function laneToYield(e, busy) {
    let best = null
    for (const conn of liveConns(e)) {
      for (const s of conn.lanes || []) {
        if (s.tesselClosed || s.tesselYielded) continue
        const pending = s.tesselPending || 0
        if (pending && !busy) continue
        if (!best || pending < best.pending) best = { conn, stream: s, pending }
      }
    }
    return best
  }

  // kind: 'exec' ({ command, pty? }) | 'shell' ({ pty }) | 'sftp'
  // opts.onlyLive: a lane's channel (remoteFs.js): on a connection that is up
  // only (never a new connection, so never a question), refused otherwise,
  // and given up to a terminal that needs its slot.
  // The live connections are tried the least loaded first (a spare one with
  // room before any new connection). Refused everywhere: the lanes give
  // their slots up one at a time, the idle ones first (terminals and the
  // Files session always win), then a spare connection with the kept
  // credentials.
  // -> Promise<{ stream, release, client }>; rejects with an sshError.
  async function open(hostId, spec, kind, opts = {}) {
    const e = entryFor(hostId, spec)
    const lane = opts.onlyLive === true
    if (lane && !liveConns(e).length) throw channelError('not connected')
    await ensure(e)
    const tried = new Set()
    let lastErr = null
    for (;;) {
      const conn = liveConns(e)
        .filter((c) => !tried.has(c))
        .sort((a, b) => a.channels - b.channels)[0]
      if (!conn) break
      tried.add(conn)
      try {
        return track(e, conn, await openOn(conn, kind, opts), lane)
      } catch (err) {
        lastErr = err
      }
    }
    if (lane) throw channelError(lastErr)
    for (const busy of [false, true]) {
      for (let guard = 0; guard < 16; guard++) {
        const victim = laneToYield(e, busy)
        if (!victim) break
        await closeLane(victim.stream)
        if (victim.conn.closed) continue
        try {
          return track(e, victim.conn, await openOn(victim.conn, kind, opts))
        } catch (err) {
          lastErr = err
        }
      }
    }
    // A second connection (kept credentials), when a busy one refused it.
    if (liveConns(e).some((c) => c.channels > 0) && liveConns(e).length < MAX_CONNECTIONS_PER_HOST) {
      const client = await connectWithRetry(e)
      const extra = adopt(e, client, { spare: true })
      try {
        return track(e, extra, await openOn(extra, kind, opts))
      } catch (err2) {
        closeConn(extra, 'extra unused')
        throw channelError(err2)
      }
    }
    throw channelError(lastErr)
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
      for (const c of liveConns(e)) closeConn(c, 'disconnect')
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
    forgetIfUnused: (hostId) => {
      for (const e of [...entries.values()]) if (e.hostId === hostId) forgetIfUnused(e)
    },
    disconnect,
    closeAll,
    snapshot,
    // For tests and diagnostics: never the secrets themselves.
    connectionCount: (hostId) => [...entries.values()].filter((e) => e.hostId === hostId).reduce((n, e) => n + liveConns(e).length, 0),
    hasKeptPassword: (hostId) => [...creds].some(([k, c]) => k.startsWith(`${hostId}\n`) && c.password != null && now() - c.since <= credentialsMaxAgeMs)
  }
}
