// One OpenCode chat: a long-lived `opencode serve` process spoken to over its
// local HTTP API (REST + the /event SSE bus), with the same API and
// normalized events as claudeChat.js and codexChat.js (the session manager
// does not know which one it drives). Plan and recordings: opencode 1.18.32
// and 1.18.33 (see opencodeFrames.js for the event mapping).
//
// Security (the API can run anything: /pty, /session/:id/shell, config writes):
// - the server binds 127.0.0.1 only (--hostname 127.0.0.1 --port 0, never
//   --mdns); its real address is read from its stdout and must be
//   http://127.0.0.1:<port>;
// - each chat has its own random password (OPENCODE_SERVER_PASSWORD, in the
//   child's environment only: never on the command line, never logged or
//   journaled); every request carries it (Basic auth), and an authenticated
//   health check proves the server on that port is our child (another server
//   there would not know the password);
// - OPENCODE_CONFIG_CONTENT gives every agent Manual's strict rules (sub-agent
//   sessions do not inherit the session's rules), no sharing, no self-update;
//   the session's own ruleset switches Manual / Plan / Yolo (PATCH, which
//   appends: each ruleset starts with a catch-all rule, so it decides), and a
//   posture check (GET /agent, GET /session/:id) refuses to open, or closes,
//   when an agent could edit or run a command without asking in Manual;
// - close aborts the turn, then kills the process tree by the PID we started
//   (`serve` never exits on its own).
import { EventEmitter } from 'events'
import http from 'http'
import { spawn as nodeSpawn } from 'child_process'
import { randomBytes, randomUUID } from 'crypto'
import { killClaudeTree } from './claudeChat'
import { opencodeSkillDiscovery } from './skills.js'
import { opencodeCommands } from './commands.js'
import { createQuestionRequests, normalizeQuestions, providerAnswers } from './questions.js'
import {
  createOpencodeState,
  normalizeOpencodeEvent,
  settleOpencodeTurn,
  permissionFromOpencode,
  opencodeReply,
  opencodeConfig,
  strictPermission,
  sessionRuleset,
  opencodePostureProblem,
  unknownAgents,
  endsWithRules,
  isOpencodeAuthError,
  opencodeErrorMessage,
  KNOWN_AGENTS
} from './opencodeFrames.js'

export const PERMISSION_MODES = ['default', 'bypassPermissions', 'plan']
export const DEFAULT_TIMEOUTS = {
  start: 30000,
  request: 30000,
  health: 5000,
  catalog: 1500,
  abort: 3000,
  close: 3000,
  quitKill: 1500,
  exitFlush: 1000,
  heartbeat: 45000,
  sseRetry: 1000
}
export const killOpencodeTree = killClaudeTree
export const MAX_LINE = 8 * 1024 * 1024 // an SSE line longer than this is dropped
export const MAX_BODY = 32 * 1024 * 1024 // a response body longer than this is refused
export const MAX_APPROVALS = 50
const STDERR_TAIL = 8 * 1024
const SSE_RETRIES = 5
export const SESSION_ID = /^ses_[A-Za-z0-9]{20,40}$/
// provider/model: OpenCode's model ids contain one '/'.
export const MODEL = /^[A-Za-z0-9._-]{1,80}\/[A-Za-z0-9._:-]{1,120}$/
export const validOpencodeModel = (v) => typeof v === 'string' && MODEL.test(v) && !v.startsWith('-')
const VARIANT = /^[A-Za-z0-9][\w.:-]{0,59}$/
const LISTEN = /opencode server listening on (http:\/\/([^\s/:]+):(\d{1,5}))/
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g
const USER = 'opencode'

export function buildOpencodeArgs({ exeArgs = [] } = {}) {
  return [...exeArgs, 'serve', '--hostname', '127.0.0.1', '--port', '0']
}

// The child's environment: the chat's (chatEnv.js already dropped any
// inherited OPENCODE_SERVER_* / config content), then this chat's own.
export function opencodeEnv(base, { password, config }) {
  const out = {}
  const drop = new Set(['OPENCODE_SERVER_PASSWORD', 'OPENCODE_SERVER_USERNAME', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_PERMISSION'])
  for (const [k, v] of Object.entries(base || {})) if (typeof v === 'string' && !drop.has(k.toUpperCase())) out[k] = v
  out.OPENCODE_SERVER_USERNAME = USER
  out.OPENCODE_SERVER_PASSWORD = password
  out.OPENCODE_CONFIG_CONTENT = JSON.stringify(config)
  out.OPENCODE_PERMISSION = JSON.stringify(strictPermission())
  return out
}

// The address printed on stdout -> { port } when it is 127.0.0.1, else null.
export function listenAddress(text) {
  const m = LISTEN.exec(String(text || ''))
  if (!m) return undefined
  const port = Number(m[3])
  if (m[2] !== '127.0.0.1' || !Number.isInteger(port) || port < 1 || port > 65535) return null
  return { port }
}

// Manual / Plan / Yolo: what the session ruleset follows.
const postureOf = (mode) => (mode === 'bypassPermissions' ? 'yolo' : mode === 'plan' ? 'plan' : 'manual')
const agentOf = (posture) => (posture === 'plan' ? 'plan' : 'build')
const str = (v) => (typeof v === 'string' ? v : '')
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})
const normDir = (d) => str(d).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

function checkOptions(opts) {
  if (!opts || typeof opts.exe !== 'string' || !opts.exe) throw new TypeError('opencodeChat: exe is required')
  if (!opts.env || typeof opts.env !== 'object') throw new TypeError('opencodeChat: env is required')
  if (typeof opts.cwd !== 'string' || !opts.cwd) throw new TypeError('opencodeChat: cwd is required')
  if (opts.exeArgs != null && (!Array.isArray(opts.exeArgs) || !opts.exeArgs.every((a) => typeof a === 'string'))) throw new TypeError('opencodeChat: exeArgs must be strings')
  if (opts.sessionId != null && (typeof opts.sessionId !== 'string' || !SESSION_ID.test(opts.sessionId))) throw new TypeError('opencodeChat: bad sessionId')
  if (opts.model != null && !validOpencodeModel(opts.model)) throw new TypeError('opencodeChat: bad model')
  if (opts.effort != null && (typeof opts.effort !== 'string' || !VARIANT.test(opts.effort))) throw new TypeError('opencodeChat: bad effort')
  if (opts.permissions != null && !['yolo', 'manual'].includes(opts.permissions)) throw new TypeError('opencodeChat: bad permissions')
  if (opts.permissionMode != null && !PERMISSION_MODES.includes(opts.permissionMode)) throw new TypeError('opencodeChat: bad permissionMode')
}

export function createOpencodeChat(opts) {
  checkOptions(opts)
  const { exe, exeArgs = [], cwd, env, sessionId: resumeId = null, spawn = nodeSpawn, now = Date.now, log = null, killTree = killOpencodeTree } = opts
  const timeouts = { ...DEFAULT_TIMEOUTS, ...(opts.timeouts || {}) }
  let model = opts.model || null
  let effort = opts.effort || null
  let permissions = opts.permissions === 'yolo' ? 'yolo' : 'manual'
  let posture = permissions === 'yolo' ? 'yolo' : opts.permissionMode === 'plan' ? 'plan' : 'manual'
  const chat = new EventEmitter()
  const state = createOpencodeState({ sessionId: null, model, permissionMode: posture === 'yolo' ? 'bypassPermissions' : posture === 'plan' ? 'plan' : 'default', now })

  let child = null
  let port = null
  let auth = null // the Authorization header value (never logged)
  let startPromise = null
  let ready = false
  let exited = null
  let finished = false
  let closing = false
  let postureFailed = false
  let stderrTail = ''
  let permN = 0
  let stream = null // { req, res, timer }
  let sseFailures = 0
  let sseTimer = null
  const requests = new Set() // live http requests (destroyed at exit)
  const approvals = new Map() // our id -> { rawId, always, sessionID }
  const byRaw = new Map() // OpenCode's per_… id -> our id
  const acceptWaiters = new Map() // uuid -> resolve
  let commandNames = new Set()
  const questions = createQuestionRequests(emit)

  function logAt(level, msg) {
    if (!log) return
    try {
      if (typeof log === 'function') log(level, `[opencodeChat] ${msg}`)
      else if (typeof log[level] === 'function') log[level]('chat', `opencode: ${msg}`)
    } catch {
      /* logging never breaks the chat */
    }
  }

  function emit(type, payload) {
    try {
      chat.emit(type, payload)
    } catch (err) {
      logAt('error', `listener for ${type} threw: ${err && err.message}`)
    }
  }

  const alive = () => !!child && !exited && !finished

  // ---- HTTP ----------------------------------------------------------------------

  function withDir(path) {
    return `${path}${path.includes('?') ? '&' : '?'}directory=${encodeURIComponent(cwd)}`
  }

  // -> { ok, status, json, text, code? } (ok: a 2xx answer). ms 0: no timeout.
  function call(method, path, body, ms = timeouts.request, { usePort = port, useAuth = auth } = {}) {
    return new Promise((resolve) => {
      if (!usePort || !useAuth) return resolve({ ok: false, status: 0, code: 'exit', error: 'not started' }) // i18n-ignore internal
      const data = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8')
      let settled = false
      let timer = null
      const done = (r) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        requests.delete(req)
        resolve(r)
      }
      const req = http.request({
        host: '127.0.0.1',
        port: usePort,
        method,
        path: withDir(path),
        agent: false,
        headers: {
          authorization: useAuth,
          host: `127.0.0.1:${usePort}`,
          accept: 'application/json',
          ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {})
        }
      })
      requests.add(req)
      if (ms > 0)
        timer = setTimeout(() => {
          req.destroy()
          done({ ok: false, status: 0, code: 'timeout', error: `${method} ${path.split('?')[0]} timed out` }) // i18n-ignore internal
        }, ms)
      req.on('response', (res) => {
        const chunks = []
        let size = 0
        res.on('data', (c) => {
          size += c.length
          if (size > MAX_BODY) {
            req.destroy()
            done({ ok: false, status: res.statusCode, code: 'error', error: 'response too large' }) // i18n-ignore internal
            return
          }
          chunks.push(c)
        })
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json = null
          try {
            json = text ? JSON.parse(text) : null
          } catch {
            json = null
          }
          const ok = res.statusCode >= 200 && res.statusCode < 300
          done({ ok, status: res.statusCode, json, text: ok ? '' : text.slice(0, 2000), code: ok ? null : 'error', error: ok ? null : `HTTP ${res.statusCode}` })
        })
        res.on('error', (err) => done({ ok: false, status: res.statusCode, code: 'error', error: String((err && err.message) || err) }))
      })
      req.on('error', (err) => done({ ok: false, status: 0, code: finished ? 'exit' : 'error', error: String((err && err.message) || err) }))
      if (data) req.write(data)
      req.end()
    })
  }

  // ---- the event stream ----------------------------------------------------------

  function stopStream() {
    if (sseTimer) clearTimeout(sseTimer)
    sseTimer = null
    const s = stream
    stream = null
    if (!s) return
    if (s.watchdog) clearInterval(s.watchdog)
    try {
      s.req.destroy()
    } catch {
      /* gone */
    }
  }

  // -> resolves { ok } once server.connected came (or the stream failed).
  function openStream() {
    return new Promise((resolve) => {
      let first = true
      const answer = (r) => {
        if (!first) return
        first = false
        resolve(r)
      }
      const req = http.request({
        host: '127.0.0.1',
        port,
        method: 'GET',
        path: withDir('/event'),
        agent: false,
        headers: { authorization: auth, host: `127.0.0.1:${port}`, accept: 'text/event-stream' }
      })
      const s = { req, res: null, last: now(), watchdog: null }
      stream = s
      const startTimer = setTimeout(() => {
        answer({ ok: false, error: 'event stream did not open' }) // i18n-ignore internal
        if (stream === s) stopStream()
      }, timeouts.start)
      req.on('response', (res) => {
        s.res = res
        if (res.statusCode !== 200) {
          clearTimeout(startTimer)
          res.resume()
          answer({ ok: false, error: `event stream HTTP ${res.statusCode}` }) // i18n-ignore internal
          return
        }
        res.setEncoding('utf8')
        let buf = ''
        let dataLines = []
        let discarding = false
        res.on('data', (d) => {
          s.last = now()
          if (discarding) {
            const j = d.indexOf('\n')
            if (j < 0) return
            d = d.slice(j + 1)
            discarding = false
          }
          buf += d
          let i
          while ((i = buf.indexOf('\n')) >= 0) {
            let line = buf.slice(0, i)
            buf = buf.slice(i + 1)
            if (line.endsWith('\r')) line = line.slice(0, -1)
            if (line === '') {
              if (dataLines.length) {
                const text = dataLines.join('\n')
                dataLines = []
                let evt = null
                try {
                  evt = JSON.parse(text)
                } catch {
                  logAt('warn', 'malformed event ignored')
                }
                if (evt && typeof evt === 'object') {
                  if (evt.type === 'server.connected') {
                    clearTimeout(startTimer)
                    answer({ ok: true })
                  }
                  try {
                    onEvent(evt)
                  } catch (err) {
                    logAt('error', `event handling failed: ${err && err.message}`)
                  }
                }
              }
            } else if (line.startsWith('data:')) dataLines.push(line.slice(line.startsWith('data: ') ? 6 : 5))
          }
          if (buf.length > MAX_LINE) {
            logAt('warn', `event line over ${MAX_LINE} characters dropped`)
            buf = ''
            dataLines = []
            discarding = true
          }
        })
        const ended = () => {
          clearTimeout(startTimer)
          answer({ ok: false, error: 'event stream closed' }) // i18n-ignore internal
          if (stream === s) streamLost()
        }
        res.on('end', ended)
        res.on('error', ended)
        res.on('close', ended)
      })
      req.on('error', (err) => {
        clearTimeout(startTimer)
        answer({ ok: false, error: String((err && err.message) || err) })
        if (stream === s) streamLost()
      })
      req.end()
      // Heartbeats come every ~10 s: a silent stream is reopened (a slow
      // model is not a dead stream: this never ends a turn).
      s.watchdog = setInterval(() => {
        if (stream !== s) return clearInterval(s.watchdog)
        if (now() - s.last > timeouts.heartbeat) {
          logAt('warn', 'event stream silent: reopening')
          stopStream()
          streamLost()
        }
      }, Math.max(1000, Math.floor(timeouts.heartbeat / 3)))
      s.watchdog.unref?.()
    })
  }

  // The stream dropped while the chat runs: opened again, then what was
  // missed is read back (pending asks, the session's status).
  function streamLost() {
    if (stream) stopStream()
    if (!ready || finished || closing || sseTimer) return
    if (++sseFailures > SSE_RETRIES) {
      logAt('error', 'event stream lost for good: closing')
      close({ kill: true }).catch(() => {})
      return
    }
    sseTimer = setTimeout(async () => {
      sseTimer = null
      if (!ready || finished || closing) return
      const r = await openStream()
      if (!r.ok) return streamLost()
      sseFailures = 0
      await resync()
    }, timeouts.sseRetry)
    sseTimer.unref?.()
  }

  async function resync() {
    const p = await call('GET', '/permission')
    if (p.ok && Array.isArray(p.json)) for (const ask of p.json) onAsk(ask)
    const q = await call('GET', '/question')
    if (q.ok && Array.isArray(q.json)) for (const ask of q.json) onQuestion(ask)
    const st = await call('GET', '/session/status')
    if (st.ok && state.turn && !state.turn.settled && state.turn.accepted) {
      const mine = obj(st.json)[state.sessionId]
      if (!mine || obj(mine).type === 'idle') {
        logAt('info', 'turn ended while the event stream was down')
        dispatchEvents(settleOpencodeTurn(state, state.interruptRequested ? 'interrupted' : state.turn.error ? 'failed' : 'completed'))
      }
    }
  }

  // ---- events ------------------------------------------------------------------

  const inTree = (sid) => !!sid && (sid === state.sessionId || !!state.subagents.get(sid))

  function reject(rawId, what) {
    call('POST', `/${what}/${encodeURIComponent(rawId)}/${what === 'permission' ? 'reply' : 'reject'}`, what === 'permission' ? { reply: 'reject' } : undefined).catch(() => {})
  }

  function onAsk(ask) {
    const a = obj(ask)
    const rawId = str(a.id)
    const sid = str(a.sessionID)
    if (!rawId || byRaw.has(rawId)) return
    // Answered ids are remembered (a resync or a repeated event is ignored), bounded.
    if (byRaw.size >= 4096) byRaw.delete(byRaw.keys().next().value)
    if (!inTree(sid)) {
      // Another client's session on this server: not this chat's to allow.
      logAt('warn', `permission ask from another session refused (${str(a.permission)})`)
      return reject(rawId, 'permission')
    }
    // Yolo: sub-agent sessions still ask (their agent's rules): answered
    // once for them. A repeated-call guard stays a card.
    if (posture === 'yolo' && a.permission !== 'doom_loop') {
      logAt('info', `auto-approved in Yolo: ${str(a.permission)}`)
      byRaw.set(rawId, null)
      call('POST', `/permission/${encodeURIComponent(rawId)}/reply`, { reply: 'once' }).catch(() => {})
      return
    }
    if (approvals.size >= MAX_APPROVALS) {
      logAt('warn', 'too many pending approvals: refused')
      return reject(rawId, 'permission')
    }
    const scope = sid === state.sessionId ? (v) => v : (v) => `${sid}:${v}`
    const perm = permissionFromOpencode(`oc_perm_${++permN}`, a, { scope })
    const entry = state.subagents.get(sid)
    if (entry) perm.description = entry.description ? `${entry.description}` : ''
    approvals.set(perm.requestId, { rawId, always: perm.always, sessionID: sid })
    byRaw.set(rawId, perm.requestId)
    const { always, permission, ...shown } = perm
    emit('permission', shown)
  }

  function cancelPermissions(filter = () => true) {
    for (const [permId, p] of approvals) {
      if (!filter(p)) continue
      approvals.delete(permId)
      emit('permissionCancelled', { requestId: permId })
    }
  }

  function onQuestion(ask) {
    const a = obj(ask)
    const rawId = str(a.id)
    if (!rawId) return
    const turn = state.turn && !state.turn.settled ? state.turn : null
    const current = !closing && !finished && !state.interruptRequested && a.sessionID === state.sessionId && !!turn
    if (!current && !inTree(str(a.sessionID))) logAt('warn', 'question from another session refused')
    const normalized = current ? normalizeQuestions(a.questions, 'opencode') : null
    questions.add({
      rawId,
      questions: normalized,
      turnId: turn ? turn.id : '',
      reply: async (answers) => {
        const r = answers
          ? await call('POST', `/question/${encodeURIComponent(rawId)}/reply`, { answers: providerAnswers(normalized, answers, 'opencode') })
          : await call('POST', `/question/${encodeURIComponent(rawId)}/reject`)
        return r.ok
      }
    })
  }

  function onEvent(evt) {
    const type = str(evt.type)
    const p = obj(evt.properties)
    switch (type) {
      case 'server.connected':
      case 'server.heartbeat':
        return
      case 'permission.asked':
        return onAsk(p)
      case 'permission.replied': {
        const permId = byRaw.get(str(p.requestID))
        if (permId && approvals.has(permId)) cancelPermissions((x) => x.rawId === p.requestID)
        return
      }
      case 'question.asked':
        return onQuestion(p)
      case 'question.replied':
      case 'question.rejected':
        return questions.cancelRaw(str(p.requestID))
      default:
        return dispatchEvents(normalizeOpencodeEvent(evt, state))
    }
  }

  state.subagents.deliverTo((events) => {
    if (!finished) dispatchEvents(events)
  })

  function dispatchEvents(events) {
    for (const ev of events) {
      const { type, ...payload } = ev
      if (type === 'postureMismatch') {
        postureMismatch(payload.reason)
        continue
      }
      if (type === 'accepted') {
        const w = acceptWaiters.get(payload.uuid)
        if (w) w(true)
      }
      if (type === 'turnEnd') {
        // The ended turn's asks are gone with it (OpenCode stopped its tools).
        cancelPermissions()
        questions.cancel(() => true, true)
      }
      if (type === 'opencodeError') {
        logAt('warn', `error outside a turn: ${payload.message}`)
        continue
      }
      emit(type, payload)
    }
  }

  // Manual no longer holds (the session's rules changed, an agent allows
  // edits or commands): the turn stops, the chat closes.
  function postureMismatch(reason) {
    if (postureFailed) return
    postureFailed = true
    logAt('error', `Manual posture not applied by OpenCode (${reason}): closing`)
    emit('postureError', { reason })
    interrupt().catch(() => {})
    close({ kill: true }).catch(() => {})
  }

  // ---- process ------------------------------------------------------------------

  function finish(code, signal, error) {
    if (finished) return
    finished = true
    ready = false
    stopStream()
    for (const req of requests) {
      try {
        req.destroy()
      } catch {
        /* gone */
      }
    }
    requests.clear()
    for (const [, w] of acceptWaiters) w(false)
    acceptWaiters.clear()
    questions.cancel()
    cancelPermissions()
    const subagentEvents = []
    state.subagents.deliverTo(null)
    state.subagents.settle(null, closing ? 'interrupted' : 'failed', subagentEvents)
    dispatchEvents(subagentEvents)
    const normal = closing
    logAt(normal ? 'info' : 'warn', `exited code=${code} signal=${signal}${error ? ' error=' + error : ''}`)
    emit('exit', { code, signal, stderrTail, crashed: !normal, error: error || null })
  }

  async function killNow(proc = child) {
    if (!proc) return
    try {
      await killTree(proc)
    } catch (err) {
      logAt('error', `tree kill failed: ${err && err.message}`)
      try {
        proc.kill()
      } catch {
        /* gone */
      }
    }
  }

  // Spawns one server and reads its address. -> { ok, proc, port } | { ok:false, code, error }
  function spawnServer(extraAgents) {
    const password = randomBytes(32).toString('hex')
    const config = opencodeConfig({ extraAgents })
    let proc
    try {
      proc = spawn(exe, buildOpencodeArgs({ exeArgs }), { cwd, env: opencodeEnv(env, { password, config }), stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true })
    } catch (err) {
      return Promise.resolve({ ok: false, code: 'spawn', error: String((err && err.message) || err) })
    }
    child = proc
    exited = null
    logAt('info', `spawned pid=${proc.pid} posture=${posture} ${resumeId ? 'resume' : 'new'}`)
    return new Promise((resolve) => {
      let out = ''
      let answered = false
      const answer = (r) => {
        if (answered) return
        answered = true
        clearTimeout(timer)
        resolve(r)
      }
      const timer = setTimeout(() => answer({ ok: false, code: 'timeout', error: 'opencode serve printed no address in time' }), timeouts.start) // i18n-ignore internal
      proc.on('error', (err) => {
        logAt('warn', `child error: ${err && err.message}`)
        answer({ ok: false, code: proc.pid ? 'exit' : 'spawn', error: String((err && err.message) || err) })
        if (!proc.pid && child === proc) finish(null, null, String((err && err.message) || err))
      })
      proc.once('exit', (code, signal) => {
        if (child !== proc) return
        exited = { code, signal }
        answer({ ok: false, code: 'exit', error: stderrTail.trim().slice(-2000) || `exited with code ${code}` }) // i18n-ignore internal
        setTimeout(() => {
          if (child === proc) finish(code, signal)
        }, timeouts.exitFlush)
      })
      proc.once('close', (code, signal) => {
        if (child === proc) finish(exited ? exited.code : code, exited ? exited.signal : signal)
      })
      if (proc.stdout) {
        proc.stdout.setEncoding('utf8')
        proc.stdout.on('data', (d) => {
          if (answered) return
          out = (out + d).slice(-8192)
          const addr = listenAddress(out)
          if (addr === undefined) return
          if (addr === null) return answer({ ok: false, code: 'failed', error: 'opencode serve is not listening on 127.0.0.1 only' }) // i18n-ignore internal
          answer({ ok: true, proc, port: addr.port, auth: 'Basic ' + Buffer.from(`${USER}:${password}`).toString('base64') })
        })
        proc.stdout.on('error', () => {})
      }
      if (proc.stderr) {
        proc.stderr.setEncoding('utf8')
        proc.stderr.on('data', (d) => {
          if (child !== proc) return
          const text = String(d).replace(ANSI, '')
          stderrTail = (stderrTail + text).slice(-STDERR_TAIL)
          emit('stderr', { text: text.slice(-4096) })
        })
        proc.stderr.on('error', () => {})
      }
    })
  }

  // A first server that must be replaced (unknown agents): stopped quietly.
  async function discard(proc) {
    stopStream()
    child = null // its exit is not the chat's
    port = null
    auth = null
    await killNow(proc)
  }

  // One boot: spawn, address, health, stream, agents, session, posture.
  async function boot(extraAgents, t0) {
    const s = await spawnServer(extraAgents)
    if (!s.ok) return s
    port = s.port
    auth = s.auth
    // Our child, not another server on that port: it knows our password.
    const health = await call('GET', '/global/health', undefined, timeouts.health)
    const h = obj(health.json)
    if (!health.ok || h.healthy !== true) {
      return { ok: false, code: health.code === 'timeout' ? 'timeout' : 'failed', error: health.status === 401 ? 'the server on that port refused our password' : `health check failed (${health.error || health.status})` } // i18n-ignore internal
    }
    state.version = str(h.version) || null
    logAt('info', `opencode ${state.version || '?'} on 127.0.0.1:${port}`)
    const sse = await openStream()
    if (!sse.ok) return { ok: false, code: 'failed', error: sse.error }
    const ag = await call('GET', '/agent')
    if (!ag.ok || !Array.isArray(ag.json)) return { ok: false, code: 'failed', error: `GET /agent: ${ag.error || 'no list'}` } // i18n-ignore internal
    const agents = ag.json
    // User or project agents a task call can reach: named in the config too
    // (one restart), so their rules end strict as well.
    const unknown = unknownAgents(agents, [...KNOWN_AGENTS, ...extraAgents])
    if (unknown.length && !extraAgents.length) return { ok: false, restart: unknown }
    const cmd = await call('GET', '/command', undefined, timeouts.catalog)
    const commands = cmd.ok ? opencodeCommands(cmd.json) : []
    commandNames = new Set(commands.map((c) => c.name))
    emit('commands', { commands })
    const prov = await call('GET', '/config/providers', undefined, timeouts.catalog)
    if (prov.ok) {
      const providers = Array.isArray(obj(prov.json).providers) ? prov.json.providers : null
      if (providers && !providers.length) return { ok: false, code: 'signin', error: 'OpenCode has no provider: run opencode auth login' } // i18n-ignore code 'signin' is what the caller shows
      if (providers && model) {
        const [pid, ...rest] = model.split('/')
        const m = obj(obj(obj(providers.find((x) => x && x.id === pid)).models)[rest.join('/')])
        const ctx = obj(m.limit).context
        if (typeof ctx === 'number') state.contextWindow = ctx
      }
    }
    const rules = sessionRuleset(posture)
    let sessionId
    if (resumeId) {
      const got = await call('GET', `/session/${encodeURIComponent(resumeId)}`)
      if (!got.ok) return { ok: false, code: 'failed', error: got.status === 404 ? `no session ${resumeId}` : `GET /session: ${got.error}` } // i18n-ignore internal
      const info = obj(got.json)
      if (info.id !== resumeId) return { ok: false, code: 'failed', error: 'OpenCode answered another session' } // i18n-ignore internal
      if (normDir(info.directory) !== normDir(cwd)) return { ok: false, code: 'failed', error: 'that session belongs to another folder' } // i18n-ignore internal
      state.sessionId = resumeId
      const patched = await call('PATCH', `/session/${encodeURIComponent(resumeId)}`, { permission: rules })
      if (!patched.ok) return { ok: false, code: 'failed', error: `PATCH /session: ${patched.error}` } // i18n-ignore internal
      sessionId = resumeId
    } else {
      const created = await call('POST', '/session', { title: 'Tessel chat', permission: rules }) // i18n-ignore a title OpenCode keeps
      const info = obj(created.json)
      if (!created.ok || !SESSION_ID.test(str(info.id))) return { ok: false, code: 'failed', error: `POST /session: ${created.error || 'no id'}` } // i18n-ignore internal
      sessionId = info.id
      state.sessionId = sessionId
    }
    state.expectedRules = rules
    if (posture !== 'yolo') {
      const problem = await checkPosture(agents, rules)
      if (problem) {
        logAt('error', `Manual posture not applied by OpenCode at start (${problem})`)
        return { ok: false, code: 'posture', error: `OpenCode did not apply the Manual permissions: ${problem}` } // i18n-ignore code 'posture' is what the caller shows
      }
      state.postureCheck = true
    }
    return { ok: true, sessionId, commands, startMs: now() - t0 }
  }

  // What OpenCode applies, not what was asked: every agent, and the session.
  async function checkPosture(agents, rules) {
    let list = agents
    if (!list) {
      const ag = await call('GET', '/agent')
      if (!ag.ok || !Array.isArray(ag.json)) return 'agents unreadable'
      list = ag.json
    }
    const problem = opencodePostureProblem(list, { sessionRules: rules, primary: ['build', 'plan'] })
    if (problem) return problem
    const got = await call('GET', `/session/${encodeURIComponent(state.sessionId)}`)
    if (!got.ok) return 'session unreadable'
    if (!endsWithRules(obj(got.json).permission, rules)) return 'session permission not applied'
    return null
  }

  // -> { ok:true, pid, info } | { ok:false, code:'spawn'|'exit'|'timeout'|'signin'|'posture'|'failed', error }
  function start() {
    if (startPromise) return startPromise
    startPromise = (async () => {
      const t0 = now()
      let r = await boot([], t0)
      if (r.restart && !closing && !finished) {
        logAt('info', `restarting with ${r.restart.length} more agent(s) in the strict config`)
        const first = child
        await discard(first)
        r = await boot(r.restart, t0)
      }
      if (r.restart) r = { ok: false, code: 'posture', error: 'OpenCode agents not covered by the strict config' } // i18n-ignore internal
      if (!r.ok) {
        const text = `${r.error || ''}\n${stderrTail}`
        if (r.code === 'signin' || /opencode auth login|no provider/i.test(text)) {
          emit('authError', { message: String(r.error || '').slice(-500) })
          r = { ...r, code: 'signin' }
        }
        if (r.code !== 'spawn') await close({ kill: true })
        else finished = true
        return { ok: false, code: r.code || 'failed', error: r.error || r.code }
      }
      if (closing || finished) return { ok: false, code: 'exit', error: 'closed while starting' } // i18n-ignore internal
      ready = true
      return {
        ok: true,
        pid: child.pid,
        info: {
          startMs: r.startMs,
          sessionId: r.sessionId,
          resumed: !!resumeId,
          model: model || state.model,
          version: state.version,
          commands: r.commands
        }
      }
    })()
    return startPromise
  }

  async function skills() {
    if (!ready || !alive() || closing) return { ok: false }
    const r = await call('GET', '/skill', undefined, timeouts.catalog)
    if (!r.ok || !Array.isArray(r.json) || finished || closing) return { ok: false }
    return { ok: true, result: opencodeSkillDiscovery(r.json, cwd, now) }
  }

  function waitAccepted(uuid, ms) {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        acceptWaiters.delete(uuid)
        resolve(false)
      }, ms)
      acceptWaiters.set(uuid, (v) => {
        clearTimeout(t)
        acceptWaiters.delete(uuid)
        resolve(v)
      })
    })
  }

  function unsend(id) {
    const i = state.pending.indexOf(id)
    if (i >= 0) state.pending.splice(i, 1)
    state.sent.delete(id)
  }

  const modelParts = () => {
    if (!model) return null
    const i = model.indexOf('/')
    return { providerID: model.slice(0, i), modelID: model.slice(i + 1) }
  }

  // A user message. Resolves once OpenCode took it (204); delivery shows as
  // 'accepted' when its user message comes back on the stream. "/name args"
  // with a name from OpenCode's own catalog runs that command.
  async function send({ uuid, text } = {}) {
    if (!ready || !alive() || postureFailed || closing) return { ok: false, error: 'not running' } // i18n-ignore internal
    if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'empty' }
    const id = typeof uuid === 'string' && uuid ? uuid : randomUUID()
    state.sent.add(id)
    state.pending.push(id) // before the POST: the echo can beat its answer
    const agent = agentOf(posture)
    const cmd = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text.trim())
    if (cmd && commandNames.has(cmd[1])) {
      // POST /session/:id/command answers at the end of the whole reply: the
      // turn's events come on the stream meanwhile.
      const body = { command: cmd[1], arguments: cmd[2] || '', agent, ...(model ? { model } : {}), ...(effort ? { variant: effort } : {}) }
      const resp = call('POST', `/session/${encodeURIComponent(state.sessionId)}/command`, body, 0)
      const first = await Promise.race([resp.then((r) => ({ kind: 'resp', r })), waitAccepted(id, timeouts.request).then((ok) => ({ kind: 'accepted', ok }))])
      if (first.kind === 'resp' && !first.r.ok) {
        unsend(id)
        return { ok: false, error: first.r.error }
      }
      if (first.kind === 'accepted' && !first.ok) {
        unsend(id)
        return { ok: false, error: 'the command was not taken' } // i18n-ignore internal
      }
      return { ok: true, uuid: id, command: cmd[1] }
    }
    const mp = modelParts()
    const body = { parts: [{ type: 'text', text }], agent, ...(mp ? { model: mp } : {}), ...(effort ? { variant: effort } : {}) }
    const r = await call('POST', `/session/${encodeURIComponent(state.sessionId)}/prompt_async`, body)
    if (!r.ok) {
      unsend(id)
      const e = obj(r.json)
      if (isOpencodeAuthError(e) || isOpencodeAuthError(obj(e.error))) emit('authError', { message: opencodeErrorMessage(e.error || e) })
      return { ok: false, error: r.error }
    }
    return { ok: true, uuid: id }
  }

  async function interrupt() {
    if (!alive() || !state.sessionId) return { ok: false, error: 'not running' } // i18n-ignore internal
    const turn = state.turn && !state.turn.settled ? state.turn : null
    if (turn || state.pending.length) state.interruptRequested = true
    questions.cancel(() => true, true)
    if (!turn && !state.pending.length) return { ok: true, stillQueued: [] }
    const r = await call('POST', `/session/${encodeURIComponent(state.sessionId)}/abort`, undefined, timeouts.abort)
    if (!r.ok) return { ok: false, error: r.error }
    return { ok: true, stillQueued: [] }
  }

  // decision: { behavior:'allow'|'deny', session:boolean, message? }.
  async function answerPermission(requestId, decision = {}) {
    const p = approvals.get(requestId)
    if (!p) return { ok: false, error: 'unknown or answered request' } // i18n-ignore internal
    const body = opencodeReply(decision, p.always)
    if (!body) return { ok: false, error: 'bad decision' } // i18n-ignore internal
    // Forget first: a second answer finds nothing rather than replying twice.
    approvals.delete(requestId)
    const r = await call('POST', `/permission/${encodeURIComponent(p.rawId)}/reply`, body)
    return r.ok ? { ok: true, decision: body.reply } : { ok: false, error: r.error }
  }

  // Applied with the next prompt (OpenCode keeps the session's own).
  function setModel(name) {
    if (!validOpencodeModel(name)) return Promise.resolve({ ok: false, error: 'bad model' })
    model = name
    state.model = name
    return Promise.resolve({ ok: true })
  }

  function setEffort(level) {
    if (typeof level !== 'string' || !VARIANT.test(level)) return Promise.resolve({ ok: false, error: 'bad effort' })
    effort = level
    return Promise.resolve({ ok: true })
  }

  // default = Manual, plan = Plan (the plan agent, edits refused),
  // bypassPermissions = Yolo (only for a chat started in Yolo). Applied at once
  // to the session's own rules (PATCH), then checked like at the start. A
  // turn running without prompts is stopped when Manual or Plan is chosen.
  async function setPermissionMode(mode) {
    if (!PERMISSION_MODES.includes(mode)) return { ok: false, error: 'bad mode' }
    if (mode === 'bypassPermissions' && permissions !== 'yolo') return { ok: false, error: 'not started in yolo' } // i18n-ignore internal
    if (!ready || !alive()) return { ok: false, error: 'not running' } // i18n-ignore internal
    const next = postureOf(mode)
    const before = posture
    const rules = sessionRuleset(next)
    state.postureCheck = false
    state.expectedRules = rules
    const r = await call('PATCH', `/session/${encodeURIComponent(state.sessionId)}`, { permission: rules })
    if (!r.ok) {
      state.expectedRules = sessionRuleset(before)
      state.postureCheck = before !== 'yolo'
      return { ok: false, error: r.error }
    }
    posture = next
    state.permissionMode = mode
    if (next !== 'yolo') {
      const problem = await checkPosture(null, rules)
      if (problem) {
        postureMismatch(problem)
        return { ok: false, error: problem }
      }
      state.postureCheck = true
      const open = state.turn && !state.turn.settled
      if (before === 'yolo' && open) {
        const i = await interrupt()
        return { ok: true, response: { mode }, interrupted: !!i.ok }
      }
    }
    return { ok: true, response: { mode } }
  }

  // Aborts the running turn, then kills the tree by the PID we started (the
  // server never exits on its own). kill (Tessel quits): a short abort.
  async function close({ kill = false } = {}) {
    const wasClosing = closing
    closing = true
    questions.cancel(() => true, true)
    if (!child || finished) {
      finished = finished || !child
      return { ok: true }
    }
    const done = new Promise((resolve) => (finished ? resolve() : chat.once('exit', resolve)))
    const open = state.turn && !state.turn.settled
    if (!wasClosing && port && auth && state.sessionId && (open || state.pending.length)) {
      await call('POST', `/session/${encodeURIComponent(state.sessionId)}/abort`, undefined, kill ? Math.min(500, timeouts.abort) : timeouts.abort)
    }
    stopStream()
    logAt('info', 'killing the tree')
    await killNow()
    let t
    await Promise.race([done, new Promise((r) => (t = setTimeout(r, kill ? timeouts.quitKill : timeouts.close)))])
    clearTimeout(t)
    if (!finished) finish(exited ? exited.code : null, exited ? exited.signal : null)
    return { ok: true, killed: true }
  }

  Object.assign(chat, {
    start,
    send,
    interrupt,
    answerPermission,
    answerQuestion: questions.answer,
    setModel,
    setEffort,
    setPermissionMode,
    close,
    skills,
    pendingPermissions: () => [...approvals.keys()]
  })
  Object.defineProperties(chat, {
    pid: { get: () => (child ? child.pid : null) },
    sessionId: { get: () => state.sessionId },
    version: { get: () => state.version },
    permissions: { get: () => permissions },
    running: { get: () => alive() }
  })
  return chat
}
