// Settings > Connections: signs a local MCP server in to the user's account.
// The sign-in runs inside the server (Google answers on its local port,
// Microsoft's code is polled by it), so the server stays alive here until the
// user has finished, gave up or the time ran out. Answers are codes: the page
// words them in the interface's language. Saved tokens stay in this process:
// the page never sees one, and the only place one is sent is Google's own
// token address, to ask whether a sign-in is still alive.
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, basename } from 'path'
import os from 'os'
import { createHash, randomUUID } from 'crypto'
import { spawnOff, execFileOff } from './spawnOffThread'
import { fullConfig, windowsSafeCommand } from './agentTools'

const ANSWER_MS = 90 * 1000 // uvx or npx may download the package first
const POLL_MS = 2500
const EXPIRES_MS = 10 * 60 * 1000
const GRACE_MS = 1500 // the server still has to answer the browser's page
const FORGET_MS = 60 * 1000
const EMAIL_RE = /^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+$/
// Fixed here, never the address in the saved file.
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'

const googleCredentialsDir = (home) => join(home, '.google_workspace_mcp', 'credentials')

// The sign-ins saved on this computer: email -> { file, hash, at }. A new
// sign-in changes the hash; the server refreshing its access token does not.
function googleSignIns(home) {
  const dir = googleCredentialsDir(home)
  const found = new Map()
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return found
  }
  for (const name of names) {
    if (!name.endsWith('.json') || name === 'oauth_states.json') continue
    try {
      const email = decodeURIComponent(name.slice(0, -5))
      if (!EMAIL_RE.test(email)) continue
      const file = join(dir, name)
      const { refresh_token: token } = JSON.parse(readFileSync(file, 'utf8'))
      if (!token) continue
      found.set(email, { file, hash: createHash('sha256').update(String(token)).digest('hex'), at: statSync(file).mtimeMs })
    } catch {
      /* a bad name, or a file being written: the next look reads it */
    }
  }
  return found
}

// The newest account signed in on this computer, or null.
export function googleAccount(home = os.homedir()) {
  const accounts = [...googleSignIns(home)].sort((a, b) => b[1].at - a[1].at)
  return accounts.length ? accounts[0][0] : null
}

// Is a saved sign-in alive? Asks Google for a new access token and drops it:
// calling one of the server's tools instead would open a sign-in page in the
// browser whenever it has ended (7 days in Google's test mode).
// -> true, false, or null when it cannot be told (offline, Google unwell).
async function googleAlive(file, fetchFn) {
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: saved.refresh_token, client_id: saved.client_id })
  if (saved.client_secret) body.set('client_secret', saved.client_secret)
  const res = await fetchFn(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(10000)
  })
  if (res.ok) return true
  const answer = await res.json().catch(() => ({}))
  return ['invalid_grant', 'invalid_client', 'unauthorized_client'].includes(answer.error) ? false : null
}

function answerSaysSuccess(text) {
  try {
    return JSON.parse(text).success === true
  } catch {
    return false
  }
}

// `launcher` and `package` guard against another server that happens to have
// the same name: it would be handed the address and asked to run these tools.
const SERVERS = {
  'google-workspace': {
    launcher: 'uvx',
    package: 'workspace-mcp',
    needsEmail: true,
    tool: 'start_google_auth',
    args: ({ email }) => ({ service_name: 'gmail', user_google_email: email }),
    pageRe: /https:\/\/accounts\.google\.com\/[^\s)\]"']+/,
    before: (home) => googleSignIns(home),
    // Done when a sign-in is new or changed, under the address Google signed in:
    // the user may pick another account than the one typed.
    finished: async (_server, home, before) => {
      for (const [email, now] of googleSignIns(home)) {
        const was = before.get(email)
        if (!was || was.hash !== now.hash) return { account: email }
      }
      return null
    },
    stateWithoutServer: async (home, fetchFn) => {
      const signIns = googleSignIns(home)
      const account = googleAccount(home)
      if (!account) return { signedIn: false, account: null }
      return { signedIn: await googleAlive(signIns.get(account).file, fetchFn).catch(() => null), account }
    }
  },
  outlook: {
    launcher: 'npx',
    package: '@softeria/ms-365-mcp-server',
    needsEmail: false,
    tool: 'login',
    args: () => ({}),
    pageRe: /https:\/\/(?:www\.)?microsoft\.com\/[^\s)\]"']+/,
    codeRe: /\bcode\s+([A-Z0-9-]{6,})\b/,
    alreadyRe: /"status"\s*:\s*"Already logged in"/,
    finished: async (server) => (answerSaysSuccess(await server.call('verify-login', {})) ? { account: null } : null),
    state: async (server) => ({ signedIn: answerSaysSuccess(await server.call('verify-login', {})), account: null })
  }
}

const defaultKillTree =
  process.platform === 'win32'
    ? (pid, then) => execFileOff('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }, () => then())
    : null

const openServers = new Set()

// One running server: its tools can be called until close().
function openServer(cfg, baseEnv, spawnFn, killTree = defaultKillTree) {
  const words = windowsSafeCommand([cfg.command, ...(cfg.args || [])].filter((w) => w !== undefined && w !== ''))
  const child = spawnFn(words[0], words.slice(1), {
    env: { ...baseEnv, ...(cfg.env || {}) },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const waiting = new Map()
  let nextId = 1
  let out = ''
  let gone = false
  const failAll = (err) => {
    gone = true
    for (const w of waiting.values()) {
      clearTimeout(w.timer)
      w.reject(err)
    }
    waiting.clear()
  }
  const write = (msg) => {
    try {
      child.stdin.write(JSON.stringify(msg) + '\n')
    } catch {
      /* closed: the exit fails what waits */
    }
  }
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      if (gone) return reject(new Error('gone'))
      const id = nextId++
      const timer = setTimeout(() => {
        waiting.delete(id)
        reject(new Error('no answer'))
      }, ANSWER_MS)
      waiting.set(id, { resolve, reject, timer })
      write({ jsonrpc: '2.0', id, method, params })
    })
  child.on('error', failAll)
  child.on('exit', () => failAll(new Error('gone')))
  if (child.stdin.on) child.stdin.on('error', () => {}) // a closed pipe: the exit reports it
  if (child.stderr) child.stderr.on('data', () => {})
  child.stdout.on('data', (d) => {
    out += d
    let nl
    while ((nl = out.indexOf('\n')) >= 0) {
      const line = out.slice(0, nl).trim()
      out = out.slice(nl + 1)
      if (!line.startsWith('{')) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (msg.method) continue // the server asking us something, not an answer
      const w = waiting.get(msg.id)
      if (!w) continue
      waiting.delete(msg.id)
      clearTimeout(w.timer)
      if (msg.error) w.reject(new Error(String(msg.error.message || 'refused')))
      else w.resolve(msg.result)
    }
  })
  const ready = request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'tessel', version: '1.0.0' }
  }).then(() => write({ jsonrpc: '2.0', method: 'notifications/initialized' }))
  ready.catch(() => {}) // each call reports it
  const server = {
    call: async (name, args) => {
      await ready
      const res = await request('tools/call', { name, arguments: args })
      const text = ((res && res.content) || []).map((c) => c.text || '').join('\n')
      if (res && res.isError) throw new Error(text || 'refused')
      return text
    },
    onExit: (fn) => child.on('exit', fn),
    // On Windows the tree goes first: the server runs under cmd and npx, taskkill
    // cannot find the children once their parent is gone, and a server waiting
    // on a sign-in does not stop by itself when its input closes.
    close: () => {
      gone = true
      openServers.delete(server)
      const kill = () => {
        try {
          child.kill()
        } catch {
          /* already gone */
        }
      }
      if (killTree && child.pid) killTree(child.pid, kill)
      else kill()
    }
  }
  openServers.add(server)
  return server
}

// Whether these settings start the server we know: its launcher, directly or
// through cmd /c, and its package as the first word that is not a flag.
function isTheServer(cfg, spec) {
  if (cfg.transport === 'http') return false
  let words = [cfg.command, ...(cfg.args || [])].map(String)
  const program = (w) => basename(w.replace(/\\/g, '/')).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase()
  if (program(words[0]) === 'cmd' && String(words[1]).toLowerCase() === '/c') words = words.slice(2)
  return program(words[0] || '') === spec.launcher && words.slice(1).find((w) => !w.startsWith('-')) === spec.package
}

// The server's settings for this agent, when it is the server we know. A
// repository's .mcp.json is never started from here: this runs on a click in
// Settings or when the page opens, without the agent's own trust question.
async function configFor(ref, spec, configOf) {
  if (ref.scope === 'project') return { reason: 'projectScope' }
  const cfg = await configOf(ref)
  if (!cfg) return { reason: 'notAdded' }
  return isTheServer(cfg, spec) ? { cfg } : { reason: 'otherServer' }
}

const sessions = new Map() // id -> { name, state, account, page, code, end }
const starts = new Map() // service -> the latest start, so an older one gives way

// ref: { agent, name, scope, cwd }, input: { email }
// -> { ok: true, id, page, code } | { ok: true, alreadySignedIn: true } | { ok: false, reason }
export async function startSignIn(ref, input = {}, deps = {}) {
  const { baseEnv = process.env, spawnFn = spawnOff, killTree, configOf = fullConfig, home = os.homedir(), pollMs = POLL_MS, expiresMs = EXPIRES_MS, graceMs = GRACE_MS, forgetMs = FORGET_MS } = deps
  const spec = Object.hasOwn(SERVERS, String(ref && ref.name)) ? SERVERS[ref.name] : null
  if (!spec) return { ok: false, reason: 'unknownServer' }
  const email = String(input.email || '').trim()
  if (spec.needsEmail && !EMAIL_RE.test(email)) return { ok: false, reason: 'email' }
  const { cfg, reason } = await configFor(ref, spec, configOf)
  if (!cfg) return { ok: false, reason }

  // One at a time per service: a second Connect replaces the first.
  const start = {}
  starts.set(ref.name, start)
  for (const s of sessions.values()) if (s.name === ref.name) s.end('cancelled')

  const before = spec.before ? spec.before(home) : null
  const server = openServer(cfg, baseEnv, spawnFn, killTree)
  let text
  try {
    text = await server.call(spec.tool, spec.args({ email }))
  } catch {
    server.close()
    return { ok: false, reason: 'noAnswer' }
  }
  if (starts.get(ref.name) !== start) {
    server.close()
    return { ok: false, reason: 'replaced' }
  }
  if (spec.alreadyRe && spec.alreadyRe.test(text)) {
    server.close()
    return { ok: true, alreadySignedIn: true }
  }
  const page = (spec.pageRe.exec(text) || [])[0] || null
  const code = spec.codeRe ? (spec.codeRe.exec(text) || [])[1] || null : null
  if (!page) {
    server.close()
    return { ok: false, reason: 'noPage' }
  }

  const id = randomUUID()
  let pollTimer = null
  let expiry = null
  const session = {
    name: ref.name,
    state: 'waiting',
    account: null,
    page,
    code,
    end: (state) => {
      if (session.state !== 'waiting') return
      session.state = state
      clearTimeout(pollTimer)
      clearTimeout(expiry)
      server.close()
      // Kept a moment for the page to read how it ended.
      const forget = setTimeout(() => sessions.delete(id), forgetMs)
      if (forget.unref) forget.unref()
    }
  }
  sessions.set(id, session)
  server.onExit(() => session.end('failed'))
  expiry = setTimeout(() => session.end('expired'), expiresMs)
  const poll = async () => {
    if (session.state !== 'waiting') return
    let done = null
    try {
      done = await spec.finished(server, home, before)
    } catch {
      /* not yet: the expiry ends it */
    }
    if (session.state !== 'waiting') return
    if (done) {
      session.account = done.account
      pollTimer = setTimeout(() => session.end('done'), graceMs)
    } else {
      pollTimer = setTimeout(poll, pollMs)
    }
  }
  pollTimer = setTimeout(poll, pollMs)
  return { ok: true, id, page, code }
}

// -> { state: 'waiting' | 'done' | 'failed' | 'expired' | 'cancelled' | 'unknown', account }
export function signInStatus(id) {
  const s = sessions.get(id)
  if (!s) return { state: 'unknown', account: null }
  if (s.state !== 'waiting') sessions.delete(id)
  return { state: s.state, account: s.account }
}

// The sign-ins still waiting: the page finds them again when it comes back.
export function activeSignIns() {
  return [...sessions].filter(([, s]) => s.state === 'waiting').map(([id, s]) => ({ id, name: s.name, page: s.page, code: s.code }))
}

export function cancelSignIn(id) {
  const s = sessions.get(id)
  if (s) s.end('cancelled')
  sessions.delete(id)
  return { ok: true }
}

export function cancelAllSignIns() {
  starts.clear()
  for (const s of sessions.values()) s.end('cancelled')
  sessions.clear()
  for (const server of [...openServers]) server.close()
}

// Is this service signed in?
// -> { signedIn: true | false | null, account, reason? } (null: cannot be told)
export async function signInState(ref, deps = {}) {
  const { baseEnv = process.env, spawnFn = spawnOff, killTree, configOf = fullConfig, home = os.homedir(), fetchFn = fetch } = deps
  const spec = Object.hasOwn(SERVERS, String(ref && ref.name)) ? SERVERS[ref.name] : null
  if (!spec) return { signedIn: null, account: null, reason: 'unknownServer' }
  if (spec.stateWithoutServer) return spec.stateWithoutServer(home, fetchFn)
  const { cfg, reason } = await configFor(ref, spec, configOf)
  if (!cfg) return { signedIn: null, account: null, reason }
  const server = openServer(cfg, baseEnv, spawnFn, killTree)
  try {
    return await spec.state(server, home)
  } catch {
    return { signedIn: null, account: null, reason: 'noAnswer' }
  } finally {
    server.close()
  }
}
