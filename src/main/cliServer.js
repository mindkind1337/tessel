// The tessel command's side in the app (src/cli/tessel.js is the command).
//
// Transport: a named pipe served by Tessel's helper ("tessel-askpass.exe
// --serve tessel-cli-<32 hex>", askpassPipeHost.js), so the pipe has an
// explicit DACL: full control for the current Windows user only, network
// logons denied. Its name is random for each run of Tessel and written, with
// Tessel's process id, to <userData>\cli-runtime.json; the command's token is
// made once per install and kept in <userData>\cli.token. Both files are in
// the user's own profile and, on Windows, get an ACL for the user only
// (restrictFile). A request carries the token; without the right one nothing
// runs.
//
// One request per connection, one line:
//   TESSEL-CLI 1 <base64 of UTF-8 JSON { token, method, params }>\n
// and one answer, the connection's only output:
//   <JSON { ok: true, result } | { ok: false, error: { code, message } }>\n
// Sizes are bounded both ways. Every request is validated here (method,
// each parameter), and only what the command offers exists: open a folder or
// a file, open a terminal or agent pane, focus the window, list the panes,
// add a card to the task board, read the usage, and (method "browser") an
// agent's browser tool (agentBrowser.js: signed by the agent's own pane,
// checked there), and (method "terminal") an agent's terminal tool
// (agentTerminal.js: signed the same way; what it types, the user approves).
// Nothing else types into a terminal, answers a confirmation, or controls
// orchestration workers.
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { t } from './i18n'

export const CLI_PROTOCOL = 'TESSEL-CLI 1'
// A request line (base64): room for a browser request whose arguments are at
// their own limit (MAX_BROWSER_ARGS_BYTES), encoded.
export const MAX_REQUEST_BYTES = 192 * 1024
export const MAX_REPLY_BYTES = 1024 * 1024
export const RUNTIME_FILE = 'cli-runtime.json'
export const TOKEN_FILE = 'cli.token'
export const MAX_IN_FLIGHT = 8
export const METHODS = ['ping', 'focus', 'open', 'new', 'status', 'task.add', 'usage', 'browser', 'terminal']

const TOKEN_RE = /^[0-9a-f]{64}$/
const MAX_PATH = 1024
const MAX_TITLE = 200
const MAX_NOTE = 4000
// An agent's id, a shell's id (built-in or custom agents: short, plain).
const ID_RE = /^[A-Za-z0-9][\w.-]{0,63}$/
// A model or effort value: what an agent's command line accepts as one
// argument (the pane's session options re-check it).
const VALUE_RE = /^[A-Za-z0-9][\w.:[\]/@+-]{0,99}$/

export class CliError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

const invalid = (message) => new CliError('invalid_argument', message)

// --- Token and runtime file ------------------------------------------------------

// The per-install token (64 hex), made the first time.
export function readOrCreateToken(dir, { fsImpl = fs, restrict = null } = {}) {
  const file = path.join(dir, TOKEN_FILE)
  try {
    const text = fsImpl.readFileSync(file, 'utf8').trim()
    if (TOKEN_RE.test(text)) return text
  } catch {
    /* made below */
  }
  const token = crypto.randomBytes(32).toString('hex')
  fsImpl.mkdirSync(dir, { recursive: true })
  fsImpl.writeFileSync(file, token, { mode: 0o600 })
  if (restrict) restrict(file)
  return token
}

export function newPipeName() {
  return `tessel-cli-${crypto.randomBytes(16).toString('hex')}`
}

export function tokensMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !TOKEN_RE.test(a) || !TOKEN_RE.test(b)) return false
  return crypto.timingSafeEqual(Buffer.from(a, 'ascii'), Buffer.from(b, 'ascii'))
}

// --- Requests ---------------------------------------------------------------------

// -> { token, method, params } or throws CliError.
export function parseRequestLine(line) {
  const text = String(line || '').replace(/\r?\n$/, '')
  if (text.length > MAX_REQUEST_BYTES) throw new CliError('too_large', t('main.cli.tooLarge', 'The request is too large.'))
  if (!text.startsWith(`${CLI_PROTOCOL} `)) throw new CliError('bad_request', t('main.cli.badRequest', 'This is not a request from the tessel command.'))
  const b64 = text.slice(CLI_PROTOCOL.length + 1)
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) throw new CliError('bad_request', t('main.cli.badRequest', 'This is not a request from the tessel command.'))
  let body
  try {
    body = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'))
  } catch {
    throw new CliError('bad_request', t('main.cli.badRequest', 'This is not a request from the tessel command.'))
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new CliError('bad_request', t('main.cli.badRequest', 'This is not a request from the tessel command.'))
  const params = body.params == null ? {} : body.params
  if (typeof params !== 'object' || Array.isArray(params)) throw invalid(t('main.cli.badParams', 'The request’s parameters are not valid.'))
  return { token: body.token, method: body.method, params }
}

function cleanText(value, max) {
  // One line of text, no control characters.
  return String(value)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

function multilineText(value, max) {
  return String(value)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]+/g, ' ')
    .trim()
    .slice(0, max)
}

// A local absolute path: a drive path (C:\…), or a network share
// (\\server\share\…, WebDAV) only when the command asked with --allow-unc
// (opening one makes Windows sign in to that server with your account);
// never a device path (\\.\…, \\?\…).
export function isUncPath(value) {
  return typeof value === 'string' && /^[\\/]{2}/.test(value)
}
export function validAbsolutePath(value, { allowUnc = false } = {}) {
  if (typeof value !== 'string' || !value || value.length > MAX_PATH || value.includes('\0')) return null
  if (/^[\\/]{2}[.?][\\/]/.test(value)) return null
  const isDrive = /^[A-Za-z]:[\\/]/.test(value)
  const isShare = /^[\\/]{2}[^\\/.?][^\\/]*[\\/][^\\/]+/.test(value)
  if (!isDrive && !(isShare && allowUnc)) return null
  return path.win32.normalize(value)
}

function optionalInt(value, name) {
  if (value == null) return null
  if (!Number.isInteger(value) || value < 1 || value > 10_000_000) throw invalid(t('main.cli.badNumber', '{{name}} must be a positive whole number.', { name }))
  return value
}

function optionalCwd(params) {
  if (params.cwd == null) return null
  // A network folder you are in is left out, not an error (and never read).
  if (isUncPath(params.cwd) && params.allowUnc !== true) return null
  const cwd = validAbsolutePath(params.cwd, { allowUnc: params.allowUnc === true })
  if (!cwd) throw invalid(t('main.cli.badPath', 'Not a full local path: {{path}}', { path: String(params.cwd).slice(0, 200) }))
  return cwd
}

// Checks one request's parameters and keeps only the known ones.
export function validateParams(method, params = {}) {
  switch (method) {
    case 'ping':
    case 'focus':
    case 'status':
    case 'usage':
      return {}
    case 'open': {
      if (isUncPath(params.path) && !/^[\\/]{2}[.?][\\/]/.test(params.path) && params.allowUnc !== true)
        throw invalid(t('main.cli.uncRefused', '{{path}} is a network path: add --allow-unc to open it (Windows signs in to that server with your account).', { path: String(params.path).slice(0, 200) }))
      const p = validAbsolutePath(params.path, { allowUnc: params.allowUnc === true })
      if (!p) throw invalid(t('main.cli.badPath', 'Not a full local path: {{path}}', { path: String(params.path ?? '').slice(0, 200) }))
      return { path: p, line: optionalInt(params.line, 'line'), col: optionalInt(params.col, 'column') }
    }
    case 'new': {
      const out = { cwd: optionalCwd(params), agent: null, model: null, effort: null, shell: null }
      for (const key of ['agent', 'shell']) {
        if (params[key] == null) continue
        if (typeof params[key] !== 'string' || !ID_RE.test(params[key])) throw invalid(t('main.cli.badId', 'Not a valid {{name}} id: {{value}}', { name: key, value: String(params[key]).slice(0, 80) }))
        out[key] = params[key]
      }
      for (const key of ['model', 'effort']) {
        if (params[key] == null) continue
        if (typeof params[key] !== 'string' || !VALUE_RE.test(params[key])) throw invalid(t('main.cli.badValue', 'Not a valid {{name}}: {{value}}', { name: key, value: String(params[key]).slice(0, 80) }))
        out[key] = params[key]
      }
      if ((out.model || out.effort) && !out.agent) throw invalid(t('main.cli.modelNeedsAgent', '--model and --effort go with --agent.'))
      if (out.effort && !out.model) throw invalid(t('main.cli.effortNeedsModel', '--effort goes with --model.'))
      if (out.agent && out.shell) throw invalid(t('main.cli.agentOrShell', 'Choose --agent or --shell, not both.'))
      return out
    }
    case 'task.add': {
      const title = typeof params.title === 'string' ? cleanText(params.title, MAX_TITLE) : ''
      if (!title) throw invalid(t('main.cli.noTitle', 'The card needs a title.'))
      const note = params.note == null ? '' : typeof params.note === 'string' ? multilineText(params.note, MAX_NOTE) : null
      if (note === null) throw invalid(t('main.cli.badParams', 'The request’s parameters are not valid.'))
      return { title, note, cwd: optionalCwd(params) }
    }
    case 'browser':
      return browserParams(params)
    case 'terminal':
      return terminalParams(params)
    default:
      throw new CliError('unknown_method', t('main.cli.unknownMethod', 'Unknown request: {{method}}', { method: String(method).slice(0, 40) }))
  }
}

// An agent's browser tool (teamMcp/server.cjs): its pane, the operation,
// flat arguments (strings, numbers, booleans) and the pane's signature.
// Who may do what is decided by agentBrowser.js.
const BROWSER_ARG_KEYS = new Set(['page', 'url', 'action', 'ref', 'text', 'key', 'direction', 'amount', 'double', 'limit', 'level', 'selector', 'timeout_ms'])
// fill and type take 20,000 characters, of any kind: a control character is
// 6 bytes in JSON, so 120,000 bytes, and some room.
export const MAX_BROWSER_ARGS_BYTES = 128 * 1024
function browserParams(params) {
  const bad = () => invalid(t('main.cli.badParams', 'The request’s parameters are not valid.'))
  const { pane, op, args, auth } = params
  if (typeof pane !== 'string' || !/^[A-Za-z0-9][\w.:-]{0,99}$/.test(pane)) throw bad()
  if (typeof op !== 'string' || !/^[a-z]{1,20}$/.test(op)) throw bad()
  const a = args == null ? {} : args
  if (typeof a !== 'object' || Array.isArray(a)) throw bad()
  const clean = {}
  for (const [k, v] of Object.entries(a)) {
    if (!BROWSER_ARG_KEYS.has(k)) throw bad()
    if (v === null || v === undefined) continue
    if (!['string', 'number', 'boolean'].includes(typeof v) || (typeof v === 'number' && !Number.isFinite(v))) throw bad()
    clean[k] = v
  }
  if (Buffer.byteLength(JSON.stringify(clean), 'utf8') > MAX_BROWSER_ARGS_BYTES) throw new CliError('too_large', t('main.cli.tooLarge', 'The request is too large.'))
  if (!auth || typeof auth !== 'object' || Array.isArray(auth) || typeof auth.nonce !== 'string' || typeof auth.mac !== 'string' || !Number.isFinite(auth.at)) throw bad()
  return { pane, op, args: clean, auth: { nonce: auth.nonce.slice(0, 80), at: auth.at, mac: auth.mac.slice(0, 128) } }
}

// An agent's terminal tool (teamMcp/server.cjs): its pane, the operation,
// flat arguments (strings, numbers, booleans; "keys" a list of key names)
// and the pane's signature. Who may do what is decided by agentTerminal.js.
const TERMINAL_ARG_KEYS = new Set(['id', 'command', 'explanation', 'goal', 'mode', 'isBackground', 'timeout', 'host', 'waitForOutput', 'keys', 'all', 'lines'])
// A command of 8 KB (control characters 6 bytes each in JSON) and its texts.
export const MAX_TERMINAL_ARGS_BYTES = 64 * 1024
function terminalParams(params) {
  const bad = () => invalid(t('main.cli.badParams', 'The request’s parameters are not valid.'))
  const { pane, op, args, auth } = params
  if (typeof pane !== 'string' || !/^[A-Za-z0-9][\w.:-]{0,99}$/.test(pane)) throw bad()
  if (typeof op !== 'string' || !/^[a-zA-Z]{1,20}$/.test(op)) throw bad()
  const a = args == null ? {} : args
  if (typeof a !== 'object' || Array.isArray(a)) throw bad()
  const clean = {}
  for (const [k, v] of Object.entries(a)) {
    if (!TERMINAL_ARG_KEYS.has(k)) throw bad()
    if (v === null || v === undefined) continue
    if (k === 'keys' && Array.isArray(v)) {
      if (v.length > 64 || v.some((x) => typeof x !== 'string' || x.length > 40)) throw bad()
      clean[k] = v.slice()
      continue
    }
    if (!['string', 'number', 'boolean'].includes(typeof v) || (typeof v === 'number' && !Number.isFinite(v))) throw bad()
    clean[k] = v
  }
  if (Buffer.byteLength(JSON.stringify(clean), 'utf8') > MAX_TERMINAL_ARGS_BYTES) throw new CliError('too_large', t('main.cli.tooLarge', 'The request is too large.'))
  if (!auth || typeof auth !== 'object' || Array.isArray(auth) || typeof auth.nonce !== 'string' || typeof auth.mac !== 'string' || !Number.isFinite(auth.at)) throw bad()
  return { pane, op, args: clean, auth: { nonce: auth.nonce.slice(0, 80), at: auth.at, mac: auth.mac.slice(0, 128) } }
}

// One request line -> the answer's JSON text (with its line break).
export async function handleRequestLine(line, { token, handlers }) {
  let req
  try {
    req = parseRequestLine(line)
    if (!tokensMatch(req.token, token)) throw new CliError('unauthorized', t('main.cli.unauthorized', 'The tessel command’s token was refused. Register the command again in Settings > General.'))
    if (!METHODS.includes(req.method) || typeof handlers[req.method] !== 'function')
      throw new CliError('unknown_method', t('main.cli.unknownMethod', 'Unknown request: {{method}}', { method: String(req.method).slice(0, 40) }))
    const params = validateParams(req.method, req.params)
    const result = await handlers[req.method](params)
    return encodeReply({ ok: true, result: result === undefined ? null : result })
  } catch (err) {
    const code = err instanceof CliError ? err.code : 'failed'
    const message = err instanceof CliError ? err.message : (err && err.message) || t('main.cli.failed', 'Tessel could not do it.')
    return encodeReply({ ok: false, error: { code, message: String(message).slice(0, 2000) } })
  }
}

export function encodeReply(obj) {
  let text = JSON.stringify(obj)
  if (Buffer.byteLength(text, 'utf8') > MAX_REPLY_BYTES)
    text = JSON.stringify({ ok: false, error: { code: 'too_large', message: t('main.cli.replyTooLarge', 'The answer is too large.') } })
  return `${text}\n`
}

// --- The server ----------------------------------------------------------------------

// netApi: createAskpassPipeHost(...) (or net in tests). restrict(file): an
// ACL for the user only. Returns { start(), stop(), running(), pipePath() }.
export function createCliServer({
  userData,
  netApi,
  handlers,
  log = null,
  restrict = null,
  fsImpl = fs,
  pid = process.pid,
  info = () => ({}),
  pipeName = newPipeName,
  // The pipe went away after it was up (its helper ended): Tessel starts it again.
  onDown = null
}) {
  let server = null
  let name = null
  let token = null
  let inFlight = 0
  let listening = false
  const runtimeFile = path.join(userData, RUNTIME_FILE)

  function writeRuntime() {
    const data = { version: 1, pipe: `\\\\.\\pipe\\${name}`, pid, startedAt: Date.now(), ...info() }
    fsImpl.mkdirSync(userData, { recursive: true })
    const tmp = `${runtimeFile}.${pid}.tmp`
    fsImpl.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 })
    fsImpl.renameSync(tmp, runtimeFile)
    if (restrict) restrict(runtimeFile)
  }

  function removeRuntime() {
    try {
      const data = JSON.parse(fsImpl.readFileSync(runtimeFile, 'utf8'))
      if (data && data.pid === pid) fsImpl.unlinkSync(runtimeFile)
    } catch {
      /* not ours, or already gone */
    }
  }

  function onConnection(sock) {
    let buf = ''
    let done = false
    const finish = (text) => {
      if (done) return
      done = true
      try {
        sock.end(text)
      } catch {
        /* the command went away */
      }
    }
    sock.on('close', () => {
      done = true
    })
    sock.on('data', (chunk) => {
      if (done) return
      buf += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
      if (buf.length > MAX_REQUEST_BYTES + 64) {
        finish(encodeReply({ ok: false, error: { code: 'too_large', message: t('main.cli.tooLarge', 'The request is too large.') } }))
        return
      }
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      const line = buf.slice(0, nl)
      if (inFlight >= MAX_IN_FLIGHT) {
        finish(encodeReply({ ok: false, error: { code: 'busy', message: t('main.cli.busy', 'Tessel is busy with other commands. Try again.') } }))
        return
      }
      inFlight++
      handleRequestLine(line, { token, handlers })
        .then(finish, () => finish(encodeReply({ ok: false, error: { code: 'failed', message: t('main.cli.failed', 'Tessel could not do it.') } })))
        .finally(() => {
          inFlight--
        })
    })
  }

  return {
    // Resolves true when listening (runtime file written), false otherwise.
    start() {
      if (server) return Promise.resolve(true)
      try {
        token = readOrCreateToken(userData, { fsImpl, restrict })
      } catch (err) {
        if (log) log.warn('cli', `token not readable: ${err && err.message}`)
        return Promise.resolve(false)
      }
      name = pipeName()
      return new Promise((resolve) => {
        let settled = false
        const settle = (v) => {
          if (settled) return
          settled = true
          resolve(v)
        }
        const srv = netApi.createServer(onConnection)
        server = srv
        let up = false
        srv.on('error', (err) => {
          if (log) log.warn('cli', `command-line pipe: ${(err && (err.code || err.message)) || 'error'}`)
          if (server !== srv) return
          server = null
          listening = false
          removeRuntime()
          settle(false)
          if (up && onDown) onDown()
        })
        srv.listen({ path: `\\\\.\\pipe\\${name}` }, () => {
          try {
            writeRuntime()
            up = true
            listening = true
            if (log) log.info('cli', 'command-line pipe ready')
            settle(true)
          } catch (err) {
            if (log) log.warn('cli', `runtime file not written: ${err && err.message}`)
            settle(false)
          }
        })
      })
    },
    stop() {
      const srv = server
      server = null
      listening = false
      removeRuntime()
      if (srv) {
        try {
          srv.close()
        } catch {
          /* already closed */
        }
      }
    },
    // The runtime file again (the interface's language changed).
    refreshInfo() {
      if (!listening) return
      try {
        writeRuntime()
      } catch {
        /* the command falls back to the system's language */
      }
    },
    running: () => !!server,
    pipePath: () => (name ? `\\\\.\\pipe\\${name}` : null)
  }
}
