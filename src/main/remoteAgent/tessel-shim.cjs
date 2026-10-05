#!/usr/bin/env node
// Tessel's helper on an SSH server (src/main/remoteAgent/REMOTE_AGENTS.md). An agent there
// (Claude Code, Codex) runs it instead of the team tools: it pipes its stdio
// through the pane's Unix socket (TESSEL_REMOTE_SOCK), which sshd forwards to
// Tessel on the PC, where the real tessel-team server runs.
//   node tessel-shim.cjs mcp                     the tessel-team MCP server
//   node tessel-shim.cjs hook <provider> <Event> an agent hook
//   node tessel-shim.cjs install [--node <abs>]  set up Claude Code and Codex
//   node tessel-shim.cjs version
// One file, Node >= 18, no dependencies.
'use strict'

const fs = require('fs')
const os = require('os')
const net = require('net')
const path = require('path')

const VERSION = '1.1.0'
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

function runMcp(argv, env = process.env) {
  const conn = remoteEnv(env)
  if (conn.error) return emptyServer(null)
  open(conn, 'mcp', [], (err, socket, rest) => {
    if (err) return emptyServer(String(err.message || 'no answer').slice(0, 120))
    let exiting = false
    const exit = (code) => {
      if (exiting) return
      exiting = true
      process.exitCode = code
      process.stdout.write('', () => process.exit(code))
    }
    if (rest.length) process.stdout.write(rest)
    socket.on('data', (chunk) => {
      if (!process.stdout.write(chunk)) {
        socket.pause()
        process.stdout.once('drain', () => socket.resume())
      }
    })
    socket.on('end', () => exit(0))
    socket.on('close', () => exit(0))
    socket.on('error', (e) => {
      process.stderr.write(`tessel-shim: ${e.message}\n`)
      exit(1)
    })
    socket.resume()
    process.stdin.pipe(socket)
    // The agent closed our stdin: the stream ends (Tessel then stops the server).
    process.stdin.on('end', () => socket.end())
    process.stdin.on('error', () => socket.end())
    process.stdout.on('error', () => exit(0))
  })
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
  if (fs.existsSync(claudeJson) || fs.existsSync(claudeDir) || onPath('claude', env)) {
    jsonStep(claudeJson, (cfg) => mergeClaudeJson(cfg, shimPath, node))
    jsonStep(path.join(claudeDir, 'settings.json'), (s) => mergeHooks(s, CLAUDE_HOOK_EVENTS, 'claude', shimPath, node))
  } else report.skipped.push('claude')

  const codexDir = path.join(home, '.codex')
  if (fs.existsSync(codexDir) || onPath('codex', env)) {
    const toml = path.join(codexDir, 'config.toml')
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
    jsonStep(path.join(codexDir, 'hooks.json'), (s) => mergeHooks(s, CODEX_HOOK_EVENTS, 'codex', shimPath, node))
  } else report.skipped.push('codex')

  report.ok = report.errors.length === 0
  return report
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
  if (mode === 'version') {
    process.stdout.write(VERSION + '\n')
    return
  }
  process.stderr.write('usage: node tessel-shim.cjs mcp | hook <provider> <Event> | install | version\n')
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
    install
  }
