#!/usr/bin/env node
// Tessel's helper on an SSH server (src/main/remoteAgent/REMOTE_AGENTS.md). An agent there
// (Claude Code, Codex) runs it instead of the team tools: it pipes its stdio
// through the pane's Unix socket (TESSEL_REMOTE_SOCK), which sshd forwards to
// Tessel on the PC, where the real tessel-team server runs.
//   node tessel-shim.cjs mcp                     the tessel-team MCP server
//   node tessel-shim.cjs hook <provider> <Event> an agent hook
//   node tessel-shim.cjs install [--node <abs>]  set up Claude Code and Codex (and Tessel's account folders)
//   node tessel-shim.cjs sessions [limit]       past Claude Code / Codex conversations
//   node tessel-shim.cjs version
// One file, Node >= 18, no dependencies.
'use strict'

const fs = require('fs')
const os = require('os')
const net = require('net')
const path = require('path')

const VERSION = '1.4.1'
const PROTOCOL = 1
const SERVER_NAME = 'tessel-team'
const SHIM_NAME = 'tessel-shim.cjs'
const MAX_HELLO = 8 * 1024
const MAX_ARGS = 16
const MAX_ARG = 256
const MAX_HOOK_INPUT = 1024 * 1024
// The hook runs at most 30 s on the PC: a little more for the round trip.
const HOOK_WAIT_MS = 40 * 1000
// sshd accepts on the socket even when the link to the PC is dead: the
// answer to the hello must come within this time.
const ANSWER_WAIT_MS = 10 * 1000
// One MCP line / what waits for a link, at most: a bigger one drops the link (or is refused).
const MAX_LINE = 4 * 1024 * 1024
const MAX_QUEUE = 64
const ENV_VARS = ['TESSEL_PANE_ID', 'TESSEL_REMOTE_SOCK', 'TESSEL_REMOTE_TOKEN', 'TESSEL_AGENT_PROVIDER']

// The same events as Tessel installs on the PC (teamInstall.js).
const CLAUDE_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'Notification', 'Stop', 'StopFailure', 'SessionEnd', 'SubagentStart', 'SubagentStop']
const CODEX_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop', 'Interrupt', 'SessionEnd', 'SubagentStart', 'SubagentStop']

// ---------------------------------------------------------------------------
// Wire protocol (v1, client side)

// The first line sent on the socket, or null when it breaks the limits.
function helloLine({ pane, token, kind, args = [] }) {
  if (typeof pane !== 'string' || !pane || typeof token !== 'string' || !/^[0-9a-f]{64}$/i.test(token)) return null
  if (kind !== 'mcp' && kind !== 'hook') return null
  if (!Array.isArray(args) || args.length > MAX_ARGS || args.some((a) => typeof a !== 'string' || a.length > MAX_ARG)) return null
  const line = JSON.stringify({ v: PROTOCOL, pane, token, kind, args }) + '\n'
  return Buffer.byteLength(line) <= MAX_HELLO ? line : null
}

// The pane's connection settings from the environment, or { error }.
function remoteEnv(env = process.env) {
  const sock = env.TESSEL_REMOTE_SOCK
  const pane = env.TESSEL_PANE_ID
  const token = env.TESSEL_REMOTE_TOKEN
  if (!sock) return { error: 'TESSEL_REMOTE_SOCK is not set (not started in a Tessel SSH pane)' }
  if (!pane) return { error: 'TESSEL_PANE_ID is not set' }
  if (!token) return { error: 'TESSEL_REMOTE_TOKEN is not set' }
  return { sock, pane, token }
}

// Connect and say hello; calls done(err, socket, rest) once Tessel answered
// {"ok":true} (rest: the bytes that came after that line).
function open(conn, kind, args, done) {
  const hello = helloLine({ pane: conn.pane, token: conn.token, kind, args })
  if (!hello) return done(new Error('bad-hello'))
  let finished = false
  let timer = null
  const finish = (err, socket, rest) => {
    if (finished) return
    finished = true
    clearTimeout(timer)
    done(err, socket, rest)
  }
  const socket = net.createConnection({ path: conn.sock, allowHalfOpen: true })
  timer = setTimeout(() => {
    socket.destroy()
    finish(new Error('Tessel did not answer'))
  }, ANSWER_WAIT_MS)
  let buf = Buffer.alloc(0)
  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk])
    const nl = buf.indexOf(10)
    if (nl < 0) {
      if (buf.length > MAX_HELLO) {
        socket.destroy()
        finish(new Error('bad answer from Tessel'))
      }
      return
    }
    socket.removeListener('data', onData)
    socket.removeListener('end', onEnd)
    let answer = null
    try {
      answer = JSON.parse(buf.subarray(0, nl).toString('utf8'))
    } catch {
      // below
    }
    if (!answer || answer.ok !== true) {
      socket.destroy()
      return finish(new Error((answer && typeof answer.error === 'string' && answer.error) || 'bad answer from Tessel'))
    }
    socket.pause()
    finish(null, socket, buf.subarray(nl + 1))
  }
  const onEnd = () => finish(new Error('Tessel closed the connection'))
  socket.on('connect', () => socket.write(hello))
  socket.on('data', onData)
  socket.on('end', onEnd)
  socket.on('error', (err) => finish(err))
}

// Write, then exit once it is out.
function writeThen(stream, data, then) {
  if (!data || !data.length) return then()
  stream.write(data, () => then())
}

// The agent outside a Tessel pane (VS Code, a plain ssh login: no socket), or
// Tessel closed: a valid MCP server without tools, quietly, so the agent does
// not list tessel-team as failed. reason: said to the agent when it was in a
// Tessel pane but Tessel did not answer.
function emptyServer(reason) {
  const write = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')
  const answer = (msg) => {
    if (!msg || typeof msg !== 'object' || msg.id === undefined || msg.id === null) return // a notification
    const { id, method, params } = msg
    if (method === 'initialize') {
      const result = {
        protocolVersion: (params && typeof params.protocolVersion === 'string' && params.protocolVersion) || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: VERSION }
      }
      if (reason) result.instructions = `Tessel's team tools are not reachable right now (${reason}).`
      return write({ jsonrpc: '2.0', id, result })
    }
    if (method === 'tools/list') return write({ jsonrpc: '2.0', id, result: { tools: [] } })
    if (method === 'ping') return write({ jsonrpc: '2.0', id, result: {} })
    write({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } })
  }
  let buf = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buf += chunk
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      for (const m of Array.isArray(msg) ? msg : [msg]) answer(m)
    }
  })
  const done = () => process.stdout.write('', () => process.exit(0))
  process.stdin.on('end', done)
  process.stdin.on('error', done)
  process.stdout.on('error', () => process.exit(0))
  process.stdin.resume()
}

// What to tell the agent when the link to Tessel is gone or refused, in words
// that say what happened and what to do (never "Transport closed").
// A reason that is safe to show the agent: an error code or one of our own
// fixed texts, never an OS message (those carry the socket path).
function safeReason(err) {
  if (err && typeof err.code === 'string' && /^[A-Z0-9_]{2,30}$/.test(err.code)) return err.code
  const m = String((err && err.message) || '')
  return /^(bad-[a-z]+|busy|failed|unknown-pane|Tessel did not answer|Tessel closed the connection|bad answer from Tessel)$/.test(m) ? m : 'no answer'
}

function linkProblem(err) {
  const m = typeof err === 'string' ? err : safeReason(err)
  if (/bad-token|unknown-pane/.test(m)) return 'Tessel no longer knows this agent (Tessel was restarted, or this pane was closed or restarted). Restart this agent from Tessel (right-click its pane, Restart).'
  if (/busy/.test(m)) return 'Tessel has too many tool connections open for this agent. Wait a moment and retry.'
  if (/failed/.test(m)) return 'Tessel could not start its tools for this agent. Retry; if it persists, restart this agent from Tessel.'
  if (/did not answer/.test(m)) return 'Tessel did not answer in time. It may be busy or the SSH link may be stuck. Retry in a moment.'
  if (/ENOENT|ECONNREFUSED|ECONNRESET|EPIPE|closed/.test(m))
    return 'The link from Tessel to this server is down (Tessel is closed or restarting, or the SSH connection dropped). Tessel reconnects by itself when it is back: retry in a few seconds. If it persists, reopen this SSH pane in Tessel.'
  return `Tessel is not reachable (${m}). Retry in a few seconds.`
}

// The MCP stdio, kept alive across the link: the agent's client sees one
// server for its whole life, even when the tunnel is closed (idle for
// 30 minutes, the SSH connection dropped, Tessel restarted). A call that
// finds the link down opens a new one (hello, then the initialize the client
// sent first is replayed); a call that was running when the link dropped, and
// a call the new link cannot take, are answered with a precise message
// instead of "Transport closed".
function runMcp(argv, env = process.env) {
  const conn = remoteEnv(env)
  if (conn.error) return emptyServer(null)
  open(conn, 'mcp', [], (err, socket, rest) => {
    if (err) return emptyServer(safeReason(err))
    proxyMcp(conn, socket, rest)
  })
}

function proxyMcp(conn, first, firstRest) {
  const out = (line) => process.stdout.write(line.endsWith('\n') ? line : line + '\n') // false: stdout is full
  const note = (text) => process.stderr.write(`tessel-shim: ${text}\n`)
  let sock = null
  let connecting = false
  let inEnded = false
  let exiting = false
  let initLine = null // the client's initialize request (parsed)
  let initializedLine = null // its notifications/initialized
  let replays = 0
  let queued = 0 // bytes in the queue
  const replayPrefix = `tessel-reinit-${require('crypto').randomBytes(8).toString('hex')}-`
  let queue = [] // { line, msgs } waiting for a link
  const pending = new Map() // id -> method, for requests sent on the current link
  const swallow = new Set() // ids of the replayed initialize
  const exit = (code) => {
    if (exiting) return
    exiting = true
    process.exitCode = code
    process.stdout.write('', () => process.exit(code))
  }
  const failure = (id, method, text) =>
    method === 'tools/call'
      ? out(JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: true } }))
      : out(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: text } }))
  const isRequest = (m) => m && typeof m === 'object' && typeof m.method === 'string' && m.id !== undefined && m.id !== null
  const parse = (line) => {
    try {
      const v = JSON.parse(line)
      return Array.isArray(v) ? v : [v]
    } catch {
      return []
    }
  }

  function attach(s, rest) {
    sock = s
    let buf = Buffer.alloc(0)
    let waitingDrain = false
    const onBytes = (chunk) => {
      buf = Buffer.concat([buf, chunk])
      let nl
      while ((nl = buf.indexOf(10)) >= 0) {
        const line = buf.subarray(0, nl).toString('utf8')
        buf = buf.subarray(nl + 1)
        if (!line.trim()) continue
        let drop = false
        for (const m of parse(line)) {
          if (m && typeof m === 'object' && m.id !== undefined && m.id !== null && typeof m.method !== 'string') {
            if (swallow.delete(m.id)) drop = true
            else pending.delete(m.id)
          }
        }
        if (!drop && !out(line) && !waitingDrain) {
          // stdout is full: stop reading the link until it drains.
          waitingDrain = true
          s.pause()
          process.stdout.once('drain', () => {
            waitingDrain = false
            s.resume()
          })
        }
      }
      if (buf.length > MAX_LINE) {
        buf = Buffer.alloc(0)
        lost(new Error('too large'), 'An answer from Tessel was too large for this link: it was closed.')
      }
    }
    let dropped = false
    const lost = (why, message) => {
      if (dropped) return
      dropped = true
      if (sock === s) sock = null
      try {
        s.destroy()
      } catch {
        // gone
      }
      const text = `${message || linkProblem(why || 'closed')} The call was running when the link dropped: it may or may not have been done, check before repeating it.`
      for (const [id, method] of pending) failure(id, method, text)
      pending.clear()
      swallow.clear()
      if (inEnded) exit(0)
      else note(`link to Tessel closed${why ? ` (${safeReason(why)})` : ''}; the next call reopens it`)
    }
    s.on('data', onBytes)
    s.on('end', () => lost(null))
    s.on('close', () => lost(null))
    s.on('error', (e) => lost(e))
    if (rest && rest.length) onBytes(rest)
    s.resume()
  }

  function write(line, msgs) {
    for (const m of msgs) if (isRequest(m)) pending.set(m.id, m.method)
    sock.write(line + '\n')
  }

  function connect() {
    if (connecting) return
    connecting = true
    let tries = 0
    const attempt = () => {
      tries++
      open(conn, 'mcp', [], (err, socket, rest) => {
        // Not for a refusal that will not change; "busy" (too many hellos) waits longer each time.
        if (err && tries < 3 && !/bad-token|unknown-pane/.test(err.message)) return setTimeout(attempt, tries * 1000)
        connecting = false
        if (err) {
          const items = queue
          queue = []
          queued = 0
          for (const { msgs } of items) for (const m of msgs) if (isRequest(m)) failure(m.id, m.method, linkProblem(err))
          note(`could not reopen the link: ${safeReason(err)}`)
          if (inEnded) exit(0)
          return
        }
        attach(socket, rest)
        if (initLine) {
          let id
          do id = `${replayPrefix}${++replays}`
          while (pending.has(id))
          swallow.add(id)
          sock.write(JSON.stringify({ ...initLine, id }) + '\n')
          if (initializedLine) sock.write(initializedLine + '\n')
        }
        const items = queue
        queue = []
        queued = 0
        for (const { line, msgs } of items) write(line, msgs)
        if (inEnded) sock.end()
      })
    }
    attempt()
  }

  function fromClient(line) {
    const msgs = parse(line)
    for (const m of msgs) {
      if (!m || typeof m !== 'object') continue
      if (m.method === 'initialize' && m.id !== undefined) initLine = m
      else if (m.method === 'notifications/initialized') initializedLine = line
    }
    if (sock) return write(line, msgs)
    if (queue.length >= MAX_QUEUE || queued + line.length > MAX_LINE) {
      for (const m of msgs) if (isRequest(m)) failure(m.id, m.method, 'Too many calls are waiting for the link to Tessel. Retry in a moment.')
      return
    }
    queued += line.length
    queue.push({ line, msgs })
    connect()
  }

  attach(first, firstRest)
  let inBuf = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    inBuf += chunk
    if (inBuf.length > MAX_LINE && inBuf.indexOf('\n') < 0) {
      inBuf = ''
      out(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Message too large for the link to Tessel (over 4 MB): it was dropped.' } }))
      return
    }
    let nl
    while ((nl = inBuf.indexOf('\n')) >= 0) {
      const line = inBuf.slice(0, nl).replace(/\r$/, '')
      inBuf = inBuf.slice(nl + 1)
      if (line.trim()) fromClient(line)
    }
  })
  // The agent closed our stdin: the stream ends (Tessel then stops the server).
  const stdinGone = () => {
    if (inEnded) return
    inEnded = true
    if (sock) {
      sock.end()
      setTimeout(() => exit(0), 3000).unref()
    } else if (!connecting) exit(0)
  }
  process.stdin.on('end', stdinGone)
  process.stdin.on('error', stdinGone)
  process.stdout.on('error', () => exit(0))
  process.stdin.resume()
}

// A hook never blocks nor breaks the agent: anything wrong -> exit 0, quietly.
function runHook(args, env = process.env) {
  const quiet = () => process.exit(0)
  const timer = setTimeout(quiet, HOOK_WAIT_MS)
  timer.unref()
  const conn = remoteEnv(env)
  if (conn.error || !helloLine({ pane: conn.pane, token: conn.token, kind: 'hook', args })) return quiet()
  const chunks = []
  let size = 0
  let tooBig = false
  process.stdin.on('data', (c) => {
    size += c.length
    if (size > MAX_HOOK_INPUT) tooBig = true
    else chunks.push(c)
  })
  process.stdin.on('error', quiet)
  // The agent stopped reading: nothing more to do.
  process.stdout.on('error', quiet)
  process.stderr.on('error', quiet)
  process.stdin.on('end', () => {
    if (tooBig) return quiet()
    const input = Buffer.concat(chunks)
    open(conn, 'hook', args, (err, socket, rest) => {
      if (err) return quiet()
      const parts = [rest]
      socket.on('data', (c) => parts.push(c))
      socket.on('error', quiet)
      let done = false
      const onClose = () => {
        if (done) return
        done = true
        const text = Buffer.concat(parts).toString('utf8').trim()
        let result = null
        try {
          result = JSON.parse(text.split('\n').pop())
        } catch {
          return quiet()
        }
        if (!result || typeof result !== 'object') return quiet()
        const code = Number.isInteger(result.exit) && result.exit >= 0 && result.exit <= 255 ? result.exit : 0
        const out = typeof result.stdout === 'string' ? Buffer.from(result.stdout, 'base64') : null
        const errOut = typeof result.stderr === 'string' ? Buffer.from(result.stderr, 'base64') : null
        writeThen(process.stdout, out, () => writeThen(process.stderr, errOut, () => process.exit(code)))
      }
      socket.on('end', onClose)
      socket.on('close', onClose)
      socket.resume()
      socket.end(input)
    })
  })
}

// ---------------------------------------------------------------------------
// install: pure merges (exported for the tests), then the file work

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

// An absolute path Tessel can write in every config: no quotes, no control
// characters. -> the error, or ''
function badPath(p, what) {
  if (typeof p !== 'string' || !path.posix.isAbsolute(p)) return `${what} must be an absolute path`
  // eslint-disable-next-line no-control-regex
  if (/['"\u0000-\u001f\u007f]/.test(p)) return `${what} cannot hold a quote or a control character: ${p}`
  return ''
}

// Shell single quotes (badPath keeps quotes out).
const shellQuote = (p) => `'${p}'`

// node = the absolute node Tessel found on the server (install --node), or
// undefined for a plain "node" from PATH.
function hookCommand(shimPath, provider, event, node) {
  return `${node ? shellQuote(node) : 'node'} ${shellQuote(shimPath)} hook ${provider} ${event}`
}

function claudeServer(shimPath, node) {
  return { type: 'stdio', command: node || 'node', args: [shimPath, 'mcp'] }
}

// ~/.claude.json with Tessel's MCP server. -> { value, changed }
function mergeClaudeJson(cfg, shimPath, node) {
  const value = isPlainObject(cfg) ? { ...cfg } : {}
  const servers = isPlainObject(value.mcpServers) ? { ...value.mcpServers } : {}
  const want = claudeServer(shimPath, node)
  // Only what Tessel sets is compared (Claude Code may add its own fields).
  const have = servers[SERVER_NAME]
  if (isPlainObject(have) && have.type === want.type && have.command === want.command && JSON.stringify(have.args) === JSON.stringify(want.args))
    return { value: cfg, changed: false }
  servers[SERVER_NAME] = want
  value.mcpServers = servers
  return { value, changed: true }
}

const isOurHook = (h) => isPlainObject(h) && typeof h.command === 'string' && h.command.includes(SHIM_NAME)

// A hooks file ({ hooks: { Event: [{ matcher, hooks: [{ type, command }] }] } })
// with Tessel's command in each event, an older Tessel command replaced and
// every other entry kept (as teamInstall.js does on the PC). -> { value, changed }
function mergeHooks(settings, events, provider, shimPath, node) {
  const value = isPlainObject(settings) ? { ...settings } : {}
  const hooks = isPlainObject(value.hooks) ? { ...value.hooks } : {}
  let changed = false
  for (const event of events) {
    const command = hookCommand(shimPath, provider, event, node)
    const list = Array.isArray(hooks[event]) ? hooks[event] : []
    const matches = (h) => isPlainObject(h) && h.type === 'command' && h.command === command
    const already = list.some((g) => isPlainObject(g) && [undefined, '', '*'].includes(g.matcher) && Array.isArray(g.hooks) && g.hooks.some(matches))
    const stale = list.some((g) => isPlainObject(g) && Array.isArray(g.hooks) && g.hooks.some((h) => isOurHook(h) && !matches(h)))
    if (already && !stale) continue
    const kept = []
    for (const g of list) {
      if (!isPlainObject(g) || !Array.isArray(g.hooks)) {
        kept.push(g)
        continue
      }
      const others = g.hooks.filter((h) => !isOurHook(h))
      if (others.length === g.hooks.length) kept.push(g)
      else if (others.length) kept.push({ ...g, hooks: others })
    }
    kept.push({ matcher: '', hooks: [{ type: 'command', command }] })
    hooks[event] = kept
    changed = true
  }
  if (!changed) return { value: settings, changed: false }
  value.hooks = hooks
  return { value, changed: true }
}

// The lines of Tessel's table in a Codex config.toml (any spelling of the
// key, with its sub-tables) apart from the rest.
const OUR_HEADER = /^\s*\[\s*mcp_servers\s*\.\s*(?:tessel-team|"tessel-team"|'tessel-team')\s*(?:\.[^\]]*)?\]\s*(?:#.*)?$/
const ANY_HEADER = /^\s*\[/
function splitCodexConfig(text) {
  const kept = []
  const ours = []
  let inOurs = false
  for (const line of String(text || '').split(/\r?\n/)) {
    if (ANY_HEADER.test(line)) inOurs = OUR_HEADER.test(line)
    ;(inOurs ? ours : kept).push(line)
  }
  return { kept: kept.join('\n'), ours: ours.join('\n') }
}

// Tessel's server written another way (an inline table under [mcp_servers]
// or dotted keys): Tessel cannot replace it, and a second definition would
// stop Codex from starting.
const OTHER_FORM = /^\s*mcp_servers\s*\.\s*(?:tessel-team|"tessel-team"|'tessel-team')\s*[.=]/
const IN_SERVERS = /^\s*(?:tessel-team|"tessel-team"|'tessel-team')\s*[.=]/
const SERVERS_HEADER = /^\s*\[\s*mcp_servers\s*\]\s*(?:#.*)?$/
function otherForm(kept) {
  let header = ''
  for (const line of kept.split('\n')) {
    if (ANY_HEADER.test(line)) {
      header = line
      continue
    }
    if (OTHER_FORM.test(line) && !header) return true
    if (IN_SERVERS.test(line) && SERVERS_HEADER.test(header)) return true
  }
  return false
}

// JSON strings are valid TOML basic strings.
const tomlString = (s) => JSON.stringify(String(s))

function codexTable(shimPath, node) {
  return (
    `[mcp_servers.${SERVER_NAME}]\n` +
    `command = ${tomlString(node || 'node')}\n` +
    `args = [${tomlString(shimPath)}, "mcp"]\n` +
    `env_vars = [${ENV_VARS.map(tomlString).join(', ')}]\n` +
    // Only the team tools run without asking, as on the PC.
    `default_tools_approval_mode = "approve"\n`
  )
}

// ~/.codex/config.toml with Tessel's table. -> { text, changed } or { error }
function mergeCodexToml(text, shimPath, node) {
  const old = String(text || '')
  const { kept, ours } = splitCodexConfig(old)
  if (otherForm(kept)) return { error: 'tessel-team is already set another way (inline table or dotted keys), left as it is' }
  const want = codexTable(shimPath, node)
  if (ours.trim() === want.trim()) return { text: old, changed: false }
  const base = kept.replace(/\s*$/, '')
  return { text: (base ? base + '\n\n' : '') + want, changed: true }
}

// Write through a temporary file and a rename, with the old file's mode. A
// symlinked config (dotfiles) stays a link: its target is written.
function writeAtomic(link, text) {
  let file = link
  try {
    file = fs.realpathSync(link)
  } catch {
    // a new file
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  let mode = 0o600
  try {
    mode = fs.statSync(file).mode & 0o7777
  } catch {
    // a new file: private
  }
  const tmp = `${file}.tessel-tmp-${process.pid}`
  try {
    fs.writeFileSync(tmp, text, { encoding: 'utf8', mode })
    fs.chmodSync(tmp, mode)
    fs.renameSync(tmp, file)
  } catch (err) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      // nothing left
    }
    throw err
  }
}

// The user's file as it was before Tessel's first change, kept once.
function backupOnce(file) {
  const bak = `${file}.tessel-bak`
  if (fs.existsSync(file) && !fs.existsSync(bak)) fs.copyFileSync(file, bak)
}

// A command on PATH (an installed agent).
function onPath(name, env = process.env) {
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    try {
      fs.accessSync(path.join(dir, name), fs.constants.X_OK)
      return true
    } catch {
      // next
    }
  }
  return false
}

// The JSON object in a file: {} when missing, null when it is not an object.
function readJsonObject(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return {}
    return null
  }
  if (!text.trim()) return {}
  try {
    const v = JSON.parse(text)
    return isPlainObject(v) ? v : null
  } catch {
    return null
  }
}

// Set up Claude Code and Codex on this server for the shim at shimPath.
// -> { ok, version, shim, changed: [files], unchanged: [files], skipped: [agents], errors: [text] }
function install({ home = os.homedir(), shimPath = path.resolve(__filename), env = process.env, node } = {}) {
  const report = { ok: true, version: VERSION, shim: shimPath, node: node || 'node', changed: [], unchanged: [], skipped: [], errors: [] }
  const bad = badPath(shimPath, 'the shim') || (node !== undefined ? badPath(node, '--node') : '')
  if (bad) return { ...report, ok: false, errors: [bad] }
  const step = (file, apply) => {
    try {
      const r = apply()
      if (r && r.error) report.errors.push(`${file}: ${r.error}`)
      else (r && r.changed ? report.changed : report.unchanged).push(file)
    } catch (err) {
      report.errors.push(`${file}: ${err.message}`)
    }
  }
  const jsonStep = (file, merge) =>
    step(file, () => {
      const cur = readJsonObject(file)
      if (!cur) return { error: 'not a JSON object, left as it is' }
      const { value, changed } = merge(cur)
      if (!changed) return { changed: false }
      backupOnce(file)
      writeAtomic(file, JSON.stringify(value, null, 2) + '\n')
      return { changed: true }
    })

  const claudeJson = path.join(home, '.claude.json')
  const claudeDir = path.join(home, '.claude')
  // Its official installer's place (~/.local/bin), which a non-login PATH lacks.
  const claudeLocal = path.join(home, '.local', 'bin', 'claude')
  if (fs.existsSync(claudeJson) || fs.existsSync(claudeDir) || onPath('claude', env) || fs.existsSync(claudeLocal)) {
    jsonStep(claudeJson, (cfg) => mergeClaudeJson(cfg, shimPath, node))
    jsonStep(path.join(claudeDir, 'settings.json'), (s) => mergeHooks(s, CLAUDE_HOOK_EVENTS, 'claude', shimPath, node))
  } else report.skipped.push('claude')

  const codexDir = path.join(home, '.codex')
  const tomlStep = (toml) =>
    step(toml, () => {
      let text = ''
      try {
        text = fs.readFileSync(toml, 'utf8')
      } catch (err) {
        if (err.code !== 'ENOENT') throw err
      }
      const r = mergeCodexToml(text, shimPath, node)
      if (r.error) return r
      if (!r.changed) return { changed: false }
      backupOnce(toml)
      writeAtomic(toml, r.text)
      return { changed: true }
    })
  if (fs.existsSync(codexDir) || onPath('codex', env)) {
    tomlStep(path.join(codexDir, 'config.toml'))
    jsonStep(path.join(codexDir, 'hooks.json'), (s) => mergeHooks(s, CODEX_HOOK_EVENTS, 'codex', shimPath, node))
  } else report.skipped.push('codex')

  // The folders Tessel made here for one account each (an agent started
  // with CLAUDE_CONFIG_DIR / CODEX_HOME there reads its settings from that
  // folder): the same team tools and hooks. Their settings are the default
  // folder's (a link) when that one exists; a Claude account's .claude.json
  // is its own (its sign-in's profile), with your MCP servers of this host's
  // ~/.claude.json kept in step (mergeAccountClaudeJson).
  for (const dir of accountFolders(home, 'claude')) {
    const system = readJsonObject(claudeJson) || {}
    const recordFile = path.join(dir, MCP_RECORD)
    const record = readJsonObject(recordFile) || {}
    let nextRecord = null
    jsonStep(path.join(dir, '.claude.json'), (cfg) => {
      const r = mergeAccountClaudeJson(cfg, system, shimPath, node, record)
      nextRecord = r.record
      return r
    })
    if (nextRecord && JSON.stringify(nextRecord) !== JSON.stringify(record)) step(recordFile, () => (writeAtomic(recordFile, JSON.stringify(nextRecord, null, 2) + '\n'), { changed: true }))
    linkMissing(path.join(dir, 'settings.json'), path.join(claudeDir, 'settings.json'))
    jsonStep(path.join(dir, 'settings.json'), (s) => mergeHooks(s, CLAUDE_HOOK_EVENTS, 'claude', shimPath, node))
  }
  for (const dir of accountFolders(home, 'codex')) {
    linkMissing(path.join(dir, 'config.toml'), path.join(codexDir, 'config.toml'))
    tomlStep(path.join(dir, 'config.toml'))
    linkMissing(path.join(dir, 'hooks.json'), path.join(codexDir, 'hooks.json'))
    jsonStep(path.join(dir, 'hooks.json'), (s) => mergeHooks(s, CODEX_HOOK_EVENTS, 'codex', shimPath, node))
  }

  report.ok = report.errors.length === 0
  return report
}

// Folders Tessel made on this server for one account each
// (remoteAccounts.sh __t_acctmk): ~/.tessel-server/accounts/<agent>/<id>,
// whose marker names that agent and id. Never a folder without it, never
// a link.
const ACCOUNT_ID = /^[0-9a-z]{1,40}$/
function accountFolders(home, agent) {
  const root = path.join(home, '.tessel-server', 'accounts', agent)
  const out = []
  for (const d of dirEntries(root)) {
    if (out.length >= 50) break
    if (!d.isDirectory() || !ACCOUNT_ID.test(d.name)) continue
    const dir = path.join(root, d.name)
    try {
      const mark = path.join(dir, '.tessel-account')
      if (fs.lstatSync(mark).isFile() && fs.readFileSync(mark, 'utf8').trim() === `tessel-account ${agent} ${d.name}`) out.push(dir)
    } catch {
      // not one of Tessel's
    }
  }
  return out
}

// A settings file an account folder lacks: a link to the default folder's
// (so a change there counts for every account), when that one exists.
function linkMissing(file, target) {
  try {
    fs.lstatSync(file)
    return
  } catch (err) {
    if (err.code !== 'ENOENT') return
  }
  try {
    if (fs.statSync(target).isFile()) fs.symlinkSync(target, file)
  } catch {
    // its own file then (written by the step after)
  }
}

// Which of an account's MCP servers Tessel copied from the default
// ~/.claude.json, and the digest of what it copied ({ servers: { name:
// digest } }), next to its .claude.json (mode 600).
const MCP_RECORD = '.tessel-mcp.json'
const stableJson = (v) =>
  Array.isArray(v) ? `[${v.map(stableJson).join(',')}]` : isPlainObject(v) ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}` : JSON.stringify(v)
const digestOf = (v) => require('crypto').createHash('sha256').update(stableJson(v)).digest('hex').slice(0, 32)

// An account's .claude.json: Tessel's server, and your own servers of this
// host's default ~/.claude.json (the user's own config on this same host:
// their env or header values, keys included, never leave it). A server is
// copied once; while the account's copy is as Tessel left it, it follows
// the default one (a rotated key, a changed command) and goes when the
// default one goes; one you changed or removed in the account is left as
// you made it (never copied again, never doubled).
// record: what Tessel copied before ({ servers }). -> { value, changed, record }
function mergeAccountClaudeJson(cfg, system, shimPath, node, record = {}) {
  const value = isPlainObject(cfg) ? cfg : {}
  const own = isPlainObject(value.mcpServers) ? value.mcpServers : {}
  const theirs = isPlainObject(system.mcpServers) ? system.mcpServers : {}
  const copied = isPlainObject(record.servers) ? record.servers : {}
  const next = { ...own }
  const nextCopied = {}
  let touched = false
  for (const name of Object.keys(theirs)) {
    if (name === SERVER_NAME || !isPlainObject(theirs[name])) continue
    const want = digestOf(theirs[name])
    if (!Object.hasOwn(own, name)) {
      // Removed from the account after Tessel copied it: left out (and
      // remembered, so it is never copied again).
      if (Object.hasOwn(copied, name)) {
        nextCopied[name] = copied[name]
        continue
      }
      next[name] = theirs[name]
      nextCopied[name] = want
      touched = true
    } else if (Object.hasOwn(copied, name) && digestOf(own[name]) === copied[name]) {
      if (want !== copied[name]) {
        next[name] = theirs[name]
        touched = true
      }
      nextCopied[name] = want
    }
  }
  // Gone from the default config: Tessel's untouched copy goes too.
  for (const name of Object.keys(copied)) {
    if (Object.hasOwn(theirs, name) || !Object.hasOwn(own, name)) continue
    if (digestOf(own[name]) === copied[name]) {
      delete next[name]
      touched = true
    }
  }
  const base = touched ? { ...value, mcpServers: next } : value
  const r = mergeClaudeJson(base, shimPath, node)
  const nextRecord = { servers: nextCopied }
  return r.changed || touched ? { value: r.value, changed: true, record: nextRecord } : { value: cfg, changed: false, record: nextRecord }
}

// ---------------------------------------------------------------------------
// sessions: the past conversations on this server for Tessel's session
// history, read as src/main/agentSessions.js reads them on the PC (only the
// start of each file). One JSON line:
//   {"v":1,"sessions":[{agent,id,cwd,started,updated,title}]}, newest first,
//   at most <limit> per agent. Unreadable files are skipped.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HEAD_BYTES = 256 * 1024

function readHead(file, bytes = HEAD_BYTES) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(bytes)
    const n = fs.readSync(fd, buf, 0, bytes, 0)
    return buf.subarray(0, n).toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        // closed
      }
    }
  }
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const t = content.find((c) => c && (c.type === 'text' || c.type === 'input_text') && c.text)
    return t ? t.text : ''
  }
  return ''
}

// Injected context (tags like <environment_context>, <command-name>) is no prompt.
function isRealPrompt(text) {
  const t = String(text || '').trim()
  return t.length > 0 && !t.startsWith('<')
}

// A user message's prompt: its first text block that is not injected context.
// VS Code's Claude puts <ide_opened_file>…</ide_opened_file> as the first block
// and the typed prompt in the next one.
function promptOf(content) {
  if (typeof content === 'string') return isRealPrompt(content) ? content : ''
  if (!Array.isArray(content)) return ''
  const block = content.find((c) => c && (c.type === 'text' || c.type === 'input_text') && isRealPrompt(c.text))
  return block ? block.text : ''
}

function oneLine(text, max = 120) {
  const t = String(text || '').replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}

// The head of a Claude transcript: { cwd, started (ms), title, sessionId }.
function parseClaudeHead(text) {
  let cwd = ''
  let started = 0
  let title = ''
  let sessionId = ''
  for (const line of String(text).split('\n')) {
    if (!line.startsWith('{')) continue
    let o
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    if (!o || typeof o !== 'object') continue
    if (!cwd && typeof o.cwd === 'string') cwd = o.cwd
    if (!sessionId && typeof o.sessionId === 'string') sessionId = o.sessionId
    if (!started && typeof o.timestamp === 'string') started = Date.parse(o.timestamp) || 0
    if (!title && o.type === 'user' && !o.isMeta && o.message) {
      const t = promptOf(o.message.content)
      if (t) title = oneLine(t)
    }
    if (!title && o.type === 'summary' && o.summary) title = oneLine(o.summary)
    if (cwd && title) break
  }
  return { cwd, started, title, sessionId }
}

// A Codex rollout's first line: { id, cwd, time (ms) } or null.
function parseCodexMeta(line) {
  try {
    const o = JSON.parse(line)
    if (!o || o.type !== 'session_meta' || !o.payload) return null
    const p = o.payload
    if (typeof p.id !== 'string' || !UUID.test(p.id)) return null
    return { id: p.id, cwd: p.cwd || '', time: Date.parse(p.timestamp || o.timestamp || '') || 0 }
  } catch {
    return null
  }
}

// The head of a Codex rollout: { id, cwd, started (ms), title } or null.
function parseCodexHead(text) {
  const lines = String(text).split('\n')
  const meta = parseCodexMeta(lines[0] || '')
  if (!meta) return null
  let title = ''
  for (const line of lines.slice(1)) {
    if (!line.includes('"user"') && !line.includes('user_message')) continue
    let o
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    if (!o || typeof o !== 'object') continue
    const p = o.payload || {}
    let t = ''
    if (o.type === 'response_item' && p.type === 'message' && p.role === 'user') t = textOf(p.content)
    else if (o.type === 'event_msg' && p.type === 'user_message') t = p.message
    if (isRealPrompt(t)) {
      title = oneLine(t)
      break
    }
  }
  return { id: meta.id, cwd: meta.cwd, started: meta.time, title }
}

function dirEntries(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function mtimeOf(file) {
  try {
    return fs.statSync(file).mtimeMs
  } catch {
    return null
  }
}

const isoOf = (ms) => (ms ? new Date(ms).toISOString() : null)

function sessionLimit(raw) {
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) ? Math.max(1, Math.min(200, n)) : 60
}

// Claude Code: <config>/projects/<folder slug>/<uuid>.jsonl.
function claudeSessions(configDir, limit) {
  const root = path.join(configDir, 'projects')
  const files = []
  for (const d of dirEntries(root)) {
    if (!d.isDirectory()) continue
    for (const f of dirEntries(path.join(root, d.name))) {
      const m = /^(.{36})\.jsonl$/.exec(f.name)
      if (!m || !UUID.test(m[1]) || !f.isFile()) continue
      const full = path.join(root, d.name, f.name)
      const updated = mtimeOf(full)
      if (updated !== null) files.push({ id: m[1], full, updated })
    }
  }
  files.sort((a, b) => b.updated - a.updated)
  const out = []
  for (const f of files) {
    if (out.length >= limit) break
    const head = parseClaudeHead(readHead(f.full))
    if (!head.title) continue // never messaged: nothing to resume
    out.push({ agent: 'claude', id: f.id, cwd: head.cwd, started: isoOf(head.started), updated: Math.round(f.updated), title: head.title })
  }
  return out
}

// Codex: <home>/sessions/YYYY/MM/DD/rollout-*.jsonl.
function codexSessions(codexHome, limit) {
  const files = []
  const walk = (dir, depth) => {
    for (const e of dirEntries(dir)) {
      const full = path.join(dir, e.name)
      if (e.isDirectory() && depth < 3) walk(full, depth + 1)
      else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
        const updated = mtimeOf(full)
        if (updated !== null) files.push({ full, updated })
      }
    }
  }
  walk(path.join(codexHome, 'sessions'), 0)
  files.sort((a, b) => b.updated - a.updated)
  const out = []
  for (const f of files) {
    if (out.length >= limit) break
    const head = parseCodexHead(readHead(f.full))
    if (!head || !head.title) continue
    out.push({ agent: 'codex', id: head.id, cwd: head.cwd, started: isoOf(head.started), updated: Math.round(f.updated), title: head.title })
  }
  return out
}

// -> { v: 1, sessions: [...] } (never throws)
function listSessions({ limit, home = os.homedir(), env = process.env } = {}) {
  const max = sessionLimit(limit)
  const out = []
  const safely = (fn) => {
    try {
      out.push(...fn())
    } catch {
      // that agent's history is left out
    }
  }
  safely(() => claudeSessions(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), max))
  safely(() => codexSessions(env.CODEX_HOME || path.join(home, '.codex'), max))
  // A Codex account's conversations are in its own folder (Claude Code's
  // are the default folder's, linked).
  for (const dir of accountFolders(home, 'codex')) safely(() => codexSessions(dir, max))
  out.sort((a, b) => b.updated - a.updated)
  return { v: 1, sessions: out }
}

// ---------------------------------------------------------------------------

function main(argv = process.argv.slice(2)) {
  const [mode, ...rest] = argv
  if (mode === 'mcp') return runMcp(rest)
  if (mode === 'hook') return runHook(rest)
  if (mode === 'install') {
    // install [--node <abs path>]
    let report
    try {
      let node
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '--node') node = rest[++i] || ''
        else if (rest[i].startsWith('--node=')) node = rest[i].slice(7)
      }
      report = install({ node })
    } catch (err) {
      report = { ok: false, version: VERSION, errors: [err.message] }
    }
    process.stdout.write(JSON.stringify(report) + '\n')
    process.exitCode = report.ok ? 0 : 1
    return
  }
  if (mode === 'sessions') {
    let result
    try {
      result = listSessions({ limit: rest[0] })
    } catch {
      result = { v: 1, sessions: [] }
    }
    process.stdout.write(JSON.stringify(result) + '\n')
    return
  }
  if (mode === 'version') {
    process.stdout.write(VERSION + '\n')
    return
  }
  process.stderr.write('usage: node tessel-shim.cjs mcp | hook <provider> <Event> | install | sessions [limit] | version\n')
  process.exitCode = 2
}

if (require.main === module) main()
else
  module.exports = {
    VERSION,
    PROTOCOL,
    CLAUDE_HOOK_EVENTS,
    CODEX_HOOK_EVENTS,
    ENV_VARS,
    helloLine,
    remoteEnv,
    badPath,
    hookCommand,
    claudeServer,
    mergeClaudeJson,
    mergeHooks,
    splitCodexConfig,
    codexTable,
    mergeCodexToml,
    install,
    parseClaudeHead,
    parseCodexHead,
    listSessions
  }
