// Agents on an SSH host: the terminal host's end of the socket tunnel
// (src/main/remoteAgent/REMOTE_AGENTS.md, wire protocol v1).
//
// A remote agent runs tessel-shim.cjs on the server; the shim connects to
// ~/.tessel-server/run/<instance>.sock, which sshd forwards to this process
// over the host's ssh2 connection (openssh_forwardInStreamLocal). Each
// connection says hello (pane id + the pane's token); this checks it and runs
// the normal local server.cjs (MCP, or --hook) with the pane's local
// environment, so for server.cjs a remote pane is a local one.
//
// Per host: one forwarded socket, bound while the host has a remote-agent
// pane (a stale socket is removed and ~/.tessel-server/run made 0700 first,
// through an exec channel), bound again after the connection under it goes
// away, unforwarded when its last remote-agent pane exits.
//
// The token is a secret: never logged, never sent back, compared with
// crypto.timingSafeEqual.
import crypto from 'crypto'
import { spawn as nodeSpawn } from 'child_process'
import { isAbsolute } from 'path'
import { StringDecoder } from 'string_decoder'

export const HELLO_MAX = 8 * 1024
export const ARGS_MAX = 16
export const ARG_MAX = 256
export const HOOK_STDIN_MAX = 1024 * 1024
export const HOOK_TIMEOUT_MS = 30_000
export const HOOK_TIMEOUT_EXIT = 124
export const MAX_CONNECTIONS = 32
export const HELLO_TIMEOUT_MS = 10_000
export const BIND_RETRY_MS = [1000, 5000, 15000]
const HOOK_OUTPUT_MAX = 4 * 1024 * 1024
const PREP_OUTPUT_MAX = 8 * 1024

const CONTROL = /[\u0000-\u001f\u007f]/
const TOKEN_RE = /^[0-9a-f]{64}$/
const INSTANCE_RE = /^[a-z0-9-]{1,40}$/
const PANE_RE = /^[A-Za-z0-9_.:-]{1,80}$/
const PROVIDER_RE = /^[a-z0-9-]{1,32}$/
const ENV_KEY_RE = /^[^=\u0000-\u001f\u007f]{1,256}$/
const MAX_ENV_KEYS = 2000
const MAX_ENV_VALUE = 32 * 1024

const cleanPath = (v) => (typeof v === 'string' && v.length <= 4096 && !CONTROL.test(v) && isAbsolute(v) ? v : null)

// main's remoteAgent part of a create message, checked. -> agent | null
// (null: not a remote-agent pane, or a malformed one, which is refused).
export function validateRemoteAgent(raw) {
  if (!raw || typeof raw !== 'object') return null
  const token = typeof raw.token === 'string' && TOKEN_RE.test(raw.token) ? raw.token : null
  const instance = typeof raw.instance === 'string' && INSTANCE_RE.test(raw.instance) ? raw.instance : null
  const node = cleanPath(raw.node)
  const script = cleanPath(raw.script)
  if (!token || !instance || !node || !script) return null
  if (!raw.env || typeof raw.env !== 'object' || Array.isArray(raw.env)) return null
  const keys = Object.keys(raw.env)
  if (keys.length > MAX_ENV_KEYS) return null
  const env = {}
  for (const k of keys) {
    const v = raw.env[k]
    if (!ENV_KEY_RE.test(k) || typeof v !== 'string' || v.length > MAX_ENV_VALUE || v.includes('\0')) return null
    env[k] = v
  }
  let provider = raw.provider == null ? env.TESSEL_AGENT_PROVIDER : raw.provider
  if (provider != null && provider !== '' && !(typeof provider === 'string' && PROVIDER_RE.test(provider))) return null
  return { token, instance, node, script, env, provider: provider || null }
}

// POSIX single quotes (values here never hold a backslash: see remoteProject.js).
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

// A remote home from the prep command's output, checked. -> path | null
export function validateHome(raw) {
  const home = String(raw || '').replace(/\r?\n$/, '')
  if (!home.startsWith('/') || home.length > 1024 || CONTROL.test(home) || home.includes('\\')) return null
  return home.replace(/\/+$/, '') || '/'
}

export const runDirOf = (home) => `${home === '/' ? '' : home}/.tessel-server/run`
export const sockPathOf = (home, instance) => `${runDirOf(home)}/${instance}.sock`

// The exec command run before a bind: the run folder (0700), the stale
// socket gone, then $HOME on stdout. (sshd does not unlink a socket left by
// a lost connection: StreamLocalBindUnlink is off by default.)
export function prepCommand(instance) {
  if (!INSTANCE_RE.test(instance)) throw new Error('invalid instance') // i18n-ignore internal
  return (
    'umask 077 && mkdir -p "$HOME/.tessel-server/run" && ' +
    'chmod 700 "$HOME/.tessel-server" "$HOME/.tessel-server/run" && ' +
    `rm -f "$HOME/.tessel-server/run/${instance}.sock" && printf '%s\\n' "$HOME"`
  )
}

// The prefix that puts the pane's remote-agent variables in its shell:
//   export TESSEL_PANE_ID='..' TESSEL_REMOTE_SOCK='..' TESSEL_REMOTE_TOKEN='..' [TESSEL_AGENT_PROVIDER='..'];
// sockPath null (the home is not known: the bind failed): built from $HOME
// by the remote shell.
export function exportPrefix({ paneId, token, instance, provider, sockPath }) {
  if (!PANE_RE.test(paneId) || !TOKEN_RE.test(token) || !INSTANCE_RE.test(instance)) throw new Error('invalid remote agent') // i18n-ignore internal
  const sock = sockPath ? q(sockPath) : `"$HOME"/${q(`.tessel-server/run/${instance}.sock`)}`
  const parts = [`TESSEL_PANE_ID=${q(paneId)}`, `TESSEL_REMOTE_SOCK=${sock}`, `TESSEL_REMOTE_TOKEN=${q(token)}`]
  if (provider) {
    if (!PROVIDER_RE.test(provider)) throw new Error('invalid remote agent') // i18n-ignore internal
    parts.push(`TESSEL_AGENT_PROVIDER=${q(provider)}`)
  }
  return `export ${parts.join(' ')}; `
}

function safely(fn) {
  try {
    fn()
  } catch {
    /* gone */
  }
}

// The exit status a channel reported (sshManager.js keeps it on the stream).
function exitCodeOf(stream) {
  const a = stream && stream.tesselExit
  if (!a) return null
  return typeof a[0] === 'number' ? a[0] : 128
}

// Runs one command on an exec channel. -> Promise<{ code, stdout, client }>
function runExec(openExec, hostId, spec, command, timers, timeoutMs) {
  return openExec(hostId, spec, command).then(
    ({ stream, release, client }) =>
      new Promise((resolve, reject) => {
        let out = ''
        const dec = new StringDecoder('utf8')
        let done = false
        const timer = timers.setTimeout(() => {
          if (done) return
          done = true
          safely(() => stream.close())
          release()
          reject(Object.assign(new Error('remote agent prep timed out'), { code: 'timeout' })) // i18n-ignore internal
        }, timeoutMs)
        stream.on('data', (d) => {
          if (out.length < PREP_OUTPUT_MAX) out += dec.write(d)
        })
        if (stream.stderr) stream.stderr.on('data', () => {})
        stream.on('error', () => {})
        const onClose = () =>
          timers.setTimeout(() => {
            if (done) return
            done = true
            timers.clearTimeout(timer)
            release()
            resolve({ code: exitCodeOf(stream), stdout: out + dec.end(), client })
          }, 0)
        if (stream.tesselClosed) onClose()
        else stream.once('close', onClose)
        safely(() => stream.end())
      })
  )
}

export function createRemoteAgentTunnel({
  openExec, // (hostId, spec, command) -> Promise<{ stream, release, client }> (sshManager.open 'exec')
  spawn = nodeSpawn,
  log = () => {},
  timers = { setTimeout, clearTimeout },
  limits = {}
} = {}) {
  const L = {
    helloTimeoutMs: HELLO_TIMEOUT_MS,
    hookTimeoutMs: HOOK_TIMEOUT_MS,
    hookStdinMax: HOOK_STDIN_MAX,
    maxConnections: MAX_CONNECTIONS,
    bindRetryMs: BIND_RETRY_MS,
    prepTimeoutMs: 20_000,
    ...limits
  }
  const panes = new Map() // paneId -> { hostId, token: Buffer, agent, conns: Set }
  const hosts = new Map() // hostId -> host state (below)
  const listening = new WeakSet() // ssh2 clients with our 'unix connection' listener

  function hostFor(hostId) {
    let h = hosts.get(hostId)
    if (!h) {
      h = { hostId, instance: null, spec: null, home: null, sockPath: null, client: null, binding: null, conns: new Set(), retry: 0, retryTimer: null, generation: 0 }
      hosts.set(hostId, h)
    }
    return h
  }

  // --- Panes -----------------------------------------------------------------------
  function registerPane(hostId, paneId, agent, spec) {
    if (!PANE_RE.test(String(paneId)) || !agent) return false
    const h = hostFor(hostId)
    // One socket per host: the first pane's instance names it (main sends
    // the same one for every pane on a host).
    if (!h.instance) h.instance = agent.instance
    if (spec) h.spec = spec
    panes.set(paneId, { hostId, token: Buffer.from(agent.token, 'hex'), agent, conns: new Set() })
    return true
  }

  function forgetPane(paneId) {
    const p = panes.get(paneId)
    if (!p) return
    panes.delete(paneId)
    for (const c of [...p.conns]) c.end()
    const h = hosts.get(p.hostId)
    if (h && !hasPanes(h.hostId)) unbind(h)
  }

  const hasPanes = (hostId) => [...panes.values()].some((p) => p.hostId === hostId)

  // --- Binding -----------------------------------------------------------------------
  // The socket forwarded on a live connection of the host (bound again after
  // that connection went away). Never rejects. -> Promise<sockPath | null>
  function ensure(hostId, spec) {
    const h = hostFor(hostId)
    if (spec) h.spec = spec
    if (!h.instance || !h.spec || !hasPanes(hostId)) return Promise.resolve(null)
    if (h.client && h.sockPath) return Promise.resolve(h.sockPath)
    if (!h.binding) {
      const generation = h.generation
      h.binding = bind(h, generation)
        .then((sockPath) => {
          h.retry = 0
          return sockPath
        })
        .catch((err) => {
          log('warn', `remote agent socket on ${h.spec.host}: ${(err && err.code) || ''} ${String((err && err.message) || '').slice(0, 200)}`)
          return null
        })
        .finally(() => {
          h.binding = null
        })
    }
    return h.binding
  }

  async function bind(h, generation) {
    const { code, stdout, client } = await runExec(openExec, h.hostId, h.spec, prepCommand(h.instance), timers, L.prepTimeoutMs)
    if (code !== 0) throw Object.assign(new Error(`prep exited ${code}`), { code: 'prep' }) // i18n-ignore internal
    const home = validateHome(stdout)
    if (!home) throw Object.assign(new Error('no usable remote home'), { code: 'home' }) // i18n-ignore internal
    const sockPath = sockPathOf(home, h.instance)
    if (generation !== h.generation || !hasPanes(h.hostId)) return null
    listen(client)
    await new Promise((resolve, reject) => {
      try {
        client.openssh_forwardInStreamLocal(sockPath, (err) => (err ? reject(Object.assign(err, { code: 'bind' })) : resolve()))
      } catch (err) {
        reject(Object.assign(err, { code: 'bind' }))
      }
    })
    h.home = home
    h.sockPath = sockPath
    // Unforwarded meanwhile (the last pane went): undone.
    if (generation !== h.generation || !hasPanes(h.hostId)) {
      safely(() => client.openssh_unforwardInStreamLocal(sockPath, () => {}))
      return null
    }
    h.client = client
    const gone = () => {
      if (h.client !== client) return
      h.client = null
      scheduleRebind(h)
    }
    client.once('close', gone)
    client.once('end', gone)
    log('info', `remote agent socket bound on ${h.spec.host} (${h.instance})`)
    return sockPath
  }

  // The connection under the socket went away while panes still use it: a
  // few tries (a pane that reconnects calls ensure() itself too).
  function scheduleRebind(h) {
    if (h.retryTimer || !hasPanes(h.hostId) || h.retry >= L.bindRetryMs.length) return
    h.retryTimer = timers.setTimeout(() => {
      h.retryTimer = null
      h.retry++
      if (!hasPanes(h.hostId) || h.client) return
      ensure(h.hostId).then((p) => {
        if (!p) scheduleRebind(h)
      })
    }, L.bindRetryMs[h.retry])
  }

  function unbind(h) {
    h.generation++
    if (h.retryTimer) timers.clearTimeout(h.retryTimer)
    h.retryTimer = null
    h.retry = 0
    for (const c of [...h.conns]) c.end()
    const client = h.client
    h.client = null
    if (client && h.sockPath) safely(() => client.openssh_unforwardInStreamLocal(h.sockPath, () => {}))
    h.instance = null
  }

  function listen(client) {
    if (listening.has(client)) return
    listening.add(client)
    client.on('unix connection', (info, accept, reject) => {
      const path = info && info.socketPath
      const h = [...hosts.values()].find((x) => x.sockPath === path && x.client === client)
      if (!h) return safely(() => reject())
      let stream
      try {
        stream = accept()
      } catch {
        return
      }
      handleConnection(h.hostId, stream)
    })
  }

  // --- Connections -----------------------------------------------------------------------
  // One forwarded connection (an ssh2 channel stream): hello, then MCP or a hook.
  function handleConnection(hostId, stream) {
    const h = hostFor(hostId)
    let child = null
    let ended = false
    let pane = null
    let helloTimer = null
    const conn = {
      end() {
        if (ended) return
        ended = true
        cleanup()
        safely(() => stream.close ? stream.close() : stream.destroy())
      }
    }
    function cleanup() {
      h.conns.delete(conn)
      if (pane) pane.conns.delete(conn)
      if (child && child.exitCode === null && child.signalCode === null) safely(() => child.kill())
      timers.clearTimeout(helloTimer)
    }
    // A last line, then the channel closes (after the line is out).
    function finishWith(obj) {
      if (ended) return
      ended = true
      cleanup()
      safely(() => {
        stream.once('finish', () => safely(() => (stream.close ? stream.close() : stream.destroy())))
        stream.end(JSON.stringify(obj) + '\n')
      })
    }
    stream.on('error', () => {})
    stream.once('close', () => {
      if (!ended) {
        ended = true
        cleanup()
      }
    })

    if (h.conns.size >= L.maxConnections) return finishWith({ ok: false, error: 'busy' })
    h.conns.add(conn)

    let buf = Buffer.alloc(0)
    helloTimer = timers.setTimeout(() => finishWith({ ok: false, error: 'bad-hello' }), L.helloTimeoutMs)
    const onData = (d) => {
      buf = Buffer.concat([buf, d])
      const nl = buf.indexOf(10)
      if (nl < 0) {
        if (buf.length > HELLO_MAX) finishWith({ ok: false, error: 'bad-hello' })
        return
      }
      stream.removeListener('data', onData)
      stream.pause()
      timers.clearTimeout(helloTimer)
      if (nl > HELLO_MAX) return finishWith({ ok: false, error: 'bad-hello' })
      const rest = buf.subarray(nl + 1)
      hello(buf.subarray(0, nl).toString('utf8'), rest)
    }
    stream.on('data', onData)
    stream.once('end', () => {
      if (!pane) finishWith({ ok: false, error: 'bad-hello' })
    })

    function hello(line, rest) {
      let m
      try {
        m = JSON.parse(line)
      } catch {
        return finishWith({ ok: false, error: 'bad-hello' })
      }
      const args = m && m.args === undefined ? [] : m && m.args
      if (
        !m ||
        typeof m !== 'object' ||
        m.v !== 1 ||
        typeof m.pane !== 'string' ||
        !PANE_RE.test(m.pane) ||
        typeof m.token !== 'string' ||
        !TOKEN_RE.test(m.token) ||
        (m.kind !== 'mcp' && m.kind !== 'hook') ||
        !Array.isArray(args) ||
        args.length > ARGS_MAX ||
        !args.every((a) => typeof a === 'string' && a.length <= ARG_MAX)
      ) {
        return finishWith({ ok: false, error: 'bad-hello' })
      }
      if (m.kind === 'hook' && args[0] !== 'claude' && args[0] !== 'codex') return finishWith({ ok: false, error: 'bad-hello' })
      const p = panes.get(m.pane)
      if (!p || p.hostId !== hostId) return finishWith({ ok: false, error: 'unknown-pane' })
      if (!crypto.timingSafeEqual(Buffer.from(m.token, 'hex'), p.token)) return finishWith({ ok: false, error: 'bad-token' })
      pane = p
      p.conns.add(conn)
      if (m.kind === 'mcp') runMcp(p, rest)
      else runHook(p, args[0], rest)
    }

    function start(p, argv) {
      return spawn(p.agent.node, [p.agent.script, ...argv], {
        env: p.agent.env,
        windowsHide: true,
        shell: false,
        stdio: ['pipe', 'pipe', argv.length ? 'pipe' : 'ignore']
      })
    }

    function runMcp(p, rest) {
      try {
        child = start(p, [])
      } catch {
        return finishWith({ ok: false, error: 'failed' })
      }
      let spawned = false
      child.once('error', () => {
        if (!spawned) finishWith({ ok: false, error: 'failed' })
        else conn.end()
      })
      child.once('spawn', () => {
        spawned = true
        if (ended) return safely(() => child.kill())
        stream.write(JSON.stringify({ ok: true }) + '\n')
        child.stdin.on('error', () => {})
        child.stdout.on('error', () => {})
        if (rest.length) child.stdin.write(rest)
        stream.pipe(child.stdin)
        child.stdout.pipe(stream, { end: false })
        stream.resume()
      })
      // server.cjs gone: the client's stdout ends, then the channel closes.
      child.once('close', () => {
        if (ended) return
        ended = true
        cleanup()
        safely(() => {
          stream.once('finish', () => safely(() => stream.close && stream.close()))
          stream.end()
        })
      })
    }

    function runHook(p, provider, rest) {
      stream.write(JSON.stringify({ ok: true }) + '\n')
      const chunks = [rest]
      let size = rest.length
      let tooBig = size > L.hookStdinMax
      const stdinTimer = timers.setTimeout(() => conn.end(), L.hookTimeoutMs)
      stream.on('data', (d) => {
        if (tooBig) return
        size += d.length
        if (size > L.hookStdinMax) tooBig = true
        else chunks.push(d)
      })
      stream.once('end', () => {
        timers.clearTimeout(stdinTimer)
        if (ended) return
        if (tooBig) return finishWith(result(1, '', 'tessel: hook input too large\n'))
        exec(Buffer.concat(chunks))
      })
      stream.resume()

      function exec(input) {
        const argv = provider === 'codex' ? ['--hook', '--codex'] : ['--hook']
        try {
          child = start(p, argv)
        } catch {
          return finishWith(result(1, '', 'tessel: could not run the hook\n'))
        }
        const out = []
        const err = []
        let outLen = 0
        let errLen = 0
        let timedOut = false
        const runTimer = timers.setTimeout(() => {
          timedOut = true
          safely(() => child.kill())
        }, L.hookTimeoutMs)
        child.stdout.on('data', (d) => {
          if (outLen < HOOK_OUTPUT_MAX) out.push(d)
          outLen += d.length
        })
        child.stderr.on('data', (d) => {
          if (errLen < HOOK_OUTPUT_MAX) err.push(d)
          errLen += d.length
        })
        child.stdin.on('error', () => {})
        let settled = false
        const settle = (code) => {
          if (settled) return
          settled = true
          timers.clearTimeout(runTimer)
          finishWith({ exit: code, stdout: Buffer.concat(out).toString('base64'), stderr: Buffer.concat(err).toString('base64') })
        }
        child.once('error', () => {
          if (!settled) {
            err.push(Buffer.from('tessel: could not run the hook\n'))
            settle(1)
          }
        })
        child.once('close', (code, signal) => settle(timedOut ? HOOK_TIMEOUT_EXIT : typeof code === 'number' ? code : signal ? 128 : 1))
        child.stdin.end(input)
      }
    }
    return conn
  }

  function result(exit, stdout, stderr) {
    return { exit, stdout: Buffer.from(stdout).toString('base64'), stderr: Buffer.from(stderr).toString('base64') }
  }

  function closeAll() {
    for (const id of [...panes.keys()]) forgetPane(id)
    for (const h of hosts.values()) unbind(h)
  }

  // Disconnect: the socket goes and is not bound again (its panes end).
  function dropHost(hostId) {
    const h = hosts.get(hostId)
    if (h) unbind(h)
  }

  return {
    registerPane,
    forgetPane,
    dropHost,
    ensure,
    handleConnection,
    closeAll,
    sockPathFor: (hostId) => (hosts.get(hostId) || {}).sockPath || null,
    // For tests and diagnostics: never a token.
    isBound: (hostId) => !!(hosts.get(hostId) && hosts.get(hostId).client),
    connectionCount: (hostId) => (hosts.get(hostId) ? hosts.get(hostId).conns.size : 0),
    paneCount: () => panes.size
  }
}
