// A fake `opencode serve` for the adapter tests: an HTTP + SSE server on
// 127.0.0.1 that REQUIRES Basic auth with OPENCODE_SERVER_PASSWORD from its
// environment (401 without it, like the real one), prints the listening line
// the real server prints, and replays the frames recorded from opencode
// 1.18.33 (opencode-real-frames.jsonl: a plain turn, a bash call with a
// permission ask, a task sub-agent) and the provider-error turn
// (opencode-error-turn.jsonl). The prompt's text picks the scenario.
//
// Environment:
//   FAKE_OC_LOG            file for a JSON line per request (and argv checks)
//   FAKE_OC_HOST           host printed in the listening line (127.0.0.1)
//   FAKE_OC_SILENT=1       never prints the listening line
//   FAKE_OC_EXTRA_AGENT    a user sub-agent whose own rules allow everything
//   FAKE_OC_PERMISSIVE=1   general's rules end with edit allow (a managed config)
//   FAKE_OC_DROP_SESSION_PERMISSION=1  GET /session/:id returns no rules
//   FAKE_OC_NO_PROVIDERS=1 no provider configured
//   FAKE_OC_SESSIONS       JSON [{id, directory}] that already exist
//   FAKE_OC_WRONG_PASSWORD=1  expects another password (another server)
//   FAKE_OC_NO_AUTH=1      answers without the password too (not enforced)
//   FAKE_OC_VERSION        the version /global/health reports (1.18.33)
//   FAKE_OC_STATE          a file keeping the sessions across servers (restarts)
//   FAKE_OC_LOOSE_CONFIG=1 GET /config shows general allowing some webfetch
//   FAKE_OC_HIDDEN_LOOSE=1 a hidden agent whose own rules allow everything
const http = require('http')
const fs = require('fs')
const path = require('path')

const PASSWORD = process.env.OPENCODE_SERVER_PASSWORD
const USER = process.env.OPENCODE_SERVER_USERNAME || 'opencode'
const LOG = process.env.FAKE_OC_LOG
const log = (rec) => {
  if (LOG) fs.appendFileSync(LOG, JSON.stringify(rec) + '\n')
}
if (!PASSWORD) {
  process.stderr.write('fake-opencode: no OPENCODE_SERVER_PASSWORD\n')
  process.exit(3)
}
log({ t: 'start', argv: process.argv.slice(2), passwordInArgv: process.argv.some((a) => a.includes(PASSWORD)), config: process.env.OPENCODE_CONFIG_CONTENT || null, permissionEnv: process.env.OPENCODE_PERMISSION || null, autoupdate: process.env.OPENCODE_DISABLE_AUTOUPDATE || null, tesselChat: process.env.TESSEL_CHAT || null })
const VERSION = process.env.FAKE_OC_VERSION || '1.18.33'
const EXPECTED = 'Basic ' + Buffer.from(`${USER}:${process.env.FAKE_OC_WRONG_PASSWORD ? 'x' + PASSWORD : PASSWORD}`).toString('base64')

// ---- recorded frames ----------------------------------------------------------
const REC_ROOT = 'ses_f106568edffeX593nuABwvaO1O'
const ERR_ROOT = 'ses_f112fbbbaffelPpnXTdcB6LETB'
const lines = fs.readFileSync(path.join(__dirname, 'opencode-real-frames.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const turns = [[], [], [], []]
let n = 0
for (const l of lines) {
  if (l.kind === 'turn') n = l.n
  else if (n && l.kind === 'sse') turns[n].push(l.event)
}
const errorTurn = fs
  .readFileSync(path.join(__dirname, 'opencode-error-turn.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .filter((l) => l.event)
  .map((l) => l.event)
const RECORDED_AGENTS = lines.find((l) => l.kind === 'http' && l.path === '/agent')
// GET /session/:id/message as recorded after the 3 turns (root session).
const RECORDED_MESSAGES = lines.find((l) => l.kind === 'http' && l.path === `/session/${REC_ROOT}/message`).response

// ---- state ------------------------------------------------------------------------
const sessions = new Map()
for (const s of JSON.parse(process.env.FAKE_OC_SESSIONS || '[]')) sessions.set(s.id, { id: s.id, directory: s.directory, title: 'old', permission: s.permission || [] })
const STATE = process.env.FAKE_OC_STATE
if (STATE && fs.existsSync(STATE)) for (const s of JSON.parse(fs.readFileSync(STATE, 'utf8'))) sessions.set(s.id, s)
const saveState = () => {
  if (STATE) fs.writeFileSync(STATE, JSON.stringify([...sessions.values()]))
}
const clients = new Set()
const pausedPermissions = new Map() // id -> { ask, resume }
const pausedQuestions = new Map()
let running = null // { sid, stopped }
let idN = 0
const newId = (prefix) => `${prefix}${String(Date.now()).slice(-6)}${String(++idN).padStart(4, '0')}AbCdEfGhIjKlMnOp`.slice(0, prefix.length + 26)

function broadcast(evt) {
  const data = `data: ${JSON.stringify(evt)}\n\n`
  for (const res of clients) res.write(data)
}

function rulesFrom(map) {
  const out = []
  for (const [permission, value] of Object.entries(map || {})) {
    if (typeof value === 'string') out.push({ permission, pattern: '*', action: value })
    else for (const [pattern, action] of Object.entries(value || {})) out.push({ permission, pattern, action })
  }
  return out
}
// Built-ins, then the global config rules, then the agent's own (last wins).
function agents() {
  let config = {}
  try {
    config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}')
  } catch {
    config = {}
  }
  const builtin = [
    { permission: '*', pattern: '*', action: 'allow' },
    { permission: 'doom_loop', pattern: '*', action: 'ask' },
    { permission: 'external_directory', pattern: '*', action: 'ask' },
    { permission: 'read', pattern: '*.env', action: 'ask' }
  ]
  const list = [
    { name: 'build', mode: 'primary' },
    { name: 'plan', mode: 'primary', extra: [{ permission: 'edit', pattern: '*', action: 'deny' }] },
    { name: 'general', mode: 'subagent' },
    { name: 'explore', mode: 'subagent' },
    { name: 'title', mode: 'primary', hidden: true, extra: [{ permission: '*', pattern: '*', action: 'deny' }] },
    ...(process.env.FAKE_OC_HIDDEN_LOOSE ? [{ name: 'helper', mode: 'primary', hidden: true, loose: true }] : []),
    ...(process.env.FAKE_OC_EXTRA_AGENT ? [{ name: process.env.FAKE_OC_EXTRA_AGENT, mode: 'subagent' }] : [])
  ]
  return list.map((a) => {
    const permission = [...builtin, ...(a.extra || []), ...rulesFrom(config.permission)]
    const own = config.agent && config.agent[a.name]
    if (own) permission.push(...rulesFrom(own.permission))
    else if (a.name === process.env.FAKE_OC_EXTRA_AGENT || a.loose) permission.push({ permission: '*', pattern: '*', action: 'allow' })
    // title: OpenCode's own all-deny agent keeps its deny after the config.
    if (a.name === 'title') permission.push({ permission: '*', pattern: '*', action: 'deny' })
    // A managed config (applied after ours) loosening a sub-agent.
    if (a.name === 'general' && process.env.FAKE_OC_PERMISSIVE) permission.push({ permission: 'edit', pattern: '*', action: 'allow' })
    return { name: a.name, mode: a.mode, ...(a.hidden ? { hidden: true } : {}), permission }
  })
}
void RECORDED_AGENTS

// The merged config, as GET /config shows it (FAKE_OC_LOOSE_CONFIG_FROM=n:
// loosened from the n-th read on, as a PATCH /config by another client would).
let configReads = 0
function mergedConfig() {
  let config = {}
  try {
    config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}')
  } catch {
    config = {}
  }
  const out = JSON.parse(JSON.stringify(config))
  configReads++
  const from = Number(process.env.FAKE_OC_LOOSE_CONFIG_FROM || 0)
  if ((process.env.FAKE_OC_LOOSE_CONFIG || (from && configReads >= from)) && out.agent && out.agent.general) out.agent.general.permission.webfetch = { '*': 'ask', 'https://*': 'allow' }
  return out
}

function info(s) {
  return { id: s.id, slug: 'lucky-falcon', projectID: 'global', directory: s.directory, title: s.title, ...(s.parentID ? { parentID: s.parentID } : {}), permission: process.env.FAKE_OC_DROP_SESSION_PERMISSION ? [] : s.permission, version: VERSION, time: { created: 1, updated: 2 } }
}

// ---- scripted turns -----------------------------------------------------------------
function substitute(evt, sid, from = REC_ROOT) {
  return JSON.parse(JSON.stringify(evt).split(from).join(sid))
}

async function replay(sid, events) {
  const run = { sid, stopped: false }
  running = run
  for (const raw of events) {
    if (run.stopped) return
    const evt = typeof raw === 'function' ? raw() : raw
    if (evt.pause) {
      await evt.pause
      continue
    }
    if (evt.type === 'permission.asked') {
      const p = evt.properties
      let resume
      const wait = new Promise((r) => (resume = r))
      pausedPermissions.set(p.id, { ask: p, resume })
      broadcast(evt)
      const reply = await wait
      if (run.stopped) return
      broadcast({ type: 'permission.replied', properties: { sessionID: p.sessionID, requestID: p.id, reply } })
      continue
    }
    if (evt.type === 'permission.replied') continue // sent with the answer above
    // The recorded session updates carry the capture's own rules: this
    // server's session (and its rules) is what OpenCode would send.
    if (evt.type === 'session.updated' && evt.properties && evt.properties.info && sessions.has(evt.properties.info.id)) {
      broadcast({ ...evt, properties: { ...evt.properties, info: { ...evt.properties.info, permission: info(sessions.get(evt.properties.info.id)).permission } } })
      await new Promise((r) => setImmediate(r))
      continue
    }
    broadcast(evt)
    await new Promise((r) => setImmediate(r))
  }
  if (running === run) running = null
}

function stepEnd(sid, text) {
  const msg = newId('msg_')
  return [
    { type: 'message.updated', properties: { sessionID: sid, info: { id: msg, role: 'assistant', sessionID: sid, providerID: 'opencode', modelID: 'nemotron-3.5-lightning-free', time: { created: 1 }, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } } } },
    { type: 'message.part.updated', properties: { sessionID: sid, part: { id: newId('prt_'), type: 'text', text, messageID: msg, sessionID: sid, time: { start: 1, end: 2 } } } },
    { type: 'message.part.updated', properties: { sessionID: sid, part: { id: newId('prt_'), type: 'step-finish', reason: 'stop', messageID: msg, sessionID: sid, tokens: { total: 10, input: 8, output: 2, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 } } },
    { type: 'message.updated', properties: { sessionID: sid, info: { id: msg, role: 'assistant', sessionID: sid, finish: 'stop', time: { created: 1, completed: 3 }, tokens: { total: 10, input: 8, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } } } },
    { type: 'session.status', properties: { sessionID: sid, status: { type: 'idle' } } },
    { type: 'session.idle', properties: { sessionID: sid } }
  ]
}
function echo(sid, text) {
  const msg = newId('msg_')
  return [
    { type: 'message.updated', properties: { sessionID: sid, info: { id: msg, role: 'user', sessionID: sid, time: { created: 1 } } } },
    { type: 'message.part.updated', properties: { sessionID: sid, part: { id: newId('prt_'), type: 'text', text, messageID: msg, sessionID: sid } } },
    { type: 'session.status', properties: { sessionID: sid, status: { type: 'busy' } } }
  ]
}

function script(sid, text) {
  if (/echo tessel/.test(text)) return turns[2].map((e) => substitute(e, sid))
  if (/CHILDASK/.test(text)) {
    const out = []
    let child = null
    for (const e of turns[3]) {
      const s = substitute(e, sid)
      out.push(s)
      if (s.type === 'session.created') child = s.properties.info.id
      if (child && s.type === 'session.status' && s.properties.sessionID === child && !out.some((x) => x.type === 'permission.asked')) {
        out.push({ type: 'permission.asked', properties: { id: 'per_childask00000000000001', sessionID: child, permission: 'bash', patterns: ['ls'], metadata: { command: 'ls' }, always: ['ls *'], tool: { messageID: 'msg_child', callID: 'call-child-1' } } })
      }
    }
    return out
  }
  if (/task tool/.test(text)) return turns[3].map((e) => substitute(e, sid))
  if (/FAIL/.test(text)) return errorTurn.map((e) => substitute(e, sid, ERR_ROOT))
  if (/LOOSEN/.test(text)) {
    // Another client loosening the session's rules: told on the stream.
    return [
      ...echo(sid, text),
      () => {
        const s = sessions.get(sid)
        s.permission = [{ permission: '*', pattern: '*', action: 'allow' }]
        return { type: 'session.updated', properties: { sessionID: sid, info: info(s) } }
      },
      { pause: new Promise(() => {}) }
    ]
  }
  if (/HUGE/.test(text)) {
    const msg = newId('msg_')
    return [
      ...echo(sid, text),
      { type: 'message.part.updated', properties: { sessionID: sid, part: { id: newId('prt_'), type: 'text', text: 'x'.repeat(9 * 1024 * 1024), messageID: msg, sessionID: sid, time: { start: 1, end: 2 } } } },
      ...stepEnd(sid, 'Small.')
    ]
  }
  if (/HANG/.test(text)) return [...echo(sid, text), { pause: new Promise(() => {}) }]
  if (/QUESTION/.test(text)) {
    let resume
    const wait = new Promise((r) => (resume = r))
    const ask = { id: 'que_fake0000000000000000001', sessionID: sid, questions: [{ question: 'Which format?', header: 'Format', options: [{ label: 'Summary', description: 'Brief' }, { label: 'Full', description: 'All of it' }], multiple: false }], tool: { messageID: 'msg_q', callID: 'call-q' } }
    return [
      ...echo(sid, text),
      () => {
        pausedQuestions.set(ask.id, { ask, resume })
        return { type: 'question.asked', properties: ask }
      },
      { pause: wait },
      ...stepEnd(sid, 'Answered.')
    ]
  }
  return turns[1].map((e) => substitute(e, sid))
}

// ---- HTTP ----------------------------------------------------------------------------
function send(res, status, body) {
  const text = body === undefined ? '' : JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(text)
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    let body = null
    try {
      body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null
    } catch {
      body = null
    }
    const authed = req.headers.authorization === EXPECTED || !!process.env.FAKE_OC_NO_AUTH
    log({ t: 'req', method: req.method, path: url.pathname, directory: url.searchParams.get('directory'), body, authed, host: req.headers.host })
    if (!authed) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="opencode"' })
      return res.end('Unauthorized')
    }
    route(req.method, url.pathname, url, body, res)
  })
})

function route(method, p, url, body, res) {
  const dir = url.searchParams.get('directory') || process.cwd()
  let m
  if (method === 'GET' && p === '/global/health') return send(res, 200, { healthy: true, version: VERSION })
  if (method === 'GET' && p === '/config') return send(res, 200, mergedConfig())
  if (method === 'GET' && p === '/event') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.write(`data: ${JSON.stringify({ id: 'evt_1', type: 'server.connected', properties: {} })}\n\n`)
    clients.add(res)
    res.on('close', () => clients.delete(res))
    return
  }
  if (method === 'GET' && p === '/agent') return send(res, 200, agents())
  if (method === 'GET' && p === '/command')
    return send(res, 200, [
      { name: 'review', source: 'command', description: 'review changes', hints: ['$ARGUMENTS'], template: 'x' },
      { name: 'xlsx', source: 'skill', description: 'Spreadsheets', hints: [], template: 'y' }
    ])
  if (method === 'GET' && p === '/config/providers') {
    if (process.env.FAKE_OC_NO_PROVIDERS) return send(res, 200, { providers: [], default: {} })
    return send(res, 200, { providers: [{ id: 'opencode', name: 'OpenCode Zen', source: 'api', env: [], options: {}, models: { 'nemotron-3.5-lightning-free': { id: 'nemotron-3.5-lightning-free', providerID: 'opencode', name: 'Nemotron', limit: { context: 131072, output: 8192 } } } }], default: { opencode: 'nemotron-3.5-lightning-free' } })
  }
  if (method === 'GET' && p === '/skill') return send(res, 200, [{ name: 'review', description: 'Review changes', location: path.join(dir, '.opencode', 'skill', 'review', 'SKILL.md'), content: 'SECRET BODY' }])
  if (method === 'GET' && p === '/permission') return send(res, 200, [...pausedPermissions.values()].map((x) => x.ask))
  if (method === 'GET' && p === '/question') return send(res, 200, [...pausedQuestions.values()].map((x) => x.ask))
  if (method === 'GET' && p === '/session/status') {
    const out = {}
    for (const id of sessions.keys()) out[id] = { type: running && running.sid === id ? 'busy' : 'idle' }
    return send(res, 200, out)
  }
  if (method === 'POST' && p === '/session') {
    const s = { id: newId('ses_'), directory: dir, title: (body && body.title) || 'New session', permission: (body && body.permission) || [] }
    sessions.set(s.id, s)
    saveState()
    send(res, 200, info(s))
    setTimeout(() => {
      broadcast({ type: 'session.created', properties: { sessionID: s.id, info: info(s) } })
      broadcast({ type: 'session.updated', properties: { sessionID: s.id, info: info(s) } })
    }, 1)
    return
  }
  if ((m = /^\/session\/([^/]+)$/.exec(p))) {
    const s = sessions.get(m[1])
    if (!s) return send(res, 404, { name: 'NotFoundError', data: { message: 'Session not found' } })
    if (method === 'GET') return send(res, 200, info(s))
    if (method === 'PATCH') {
      // Like opencode 1.18.33: the rules are APPENDED to the session's.
      if (body && Array.isArray(body.permission)) s.permission = [...s.permission, ...body.permission]
      saveState()
      send(res, 200, info(s))
      setTimeout(() => broadcast({ type: 'session.updated', properties: { sessionID: s.id, info: info(s) } }), 1)
      return
    }
  }
  if ((m = /^\/session\/([^/]+)\/message$/.exec(p)) && method === 'GET') {
    const s = sessions.get(m[1])
    if (!s) return send(res, 404, {})
    // FAKE_OC_HISTORY=1: the recorded conversation; =big: each message padded
    // (the reader asks again for fewer).
    let list = process.env.FAKE_OC_HISTORY ? substitute(RECORDED_MESSAGES, s.id) : []
    if (process.env.FAKE_OC_HISTORY === 'big') list = list.map((x) => ({ ...x, info: { ...x.info, pad: 'p'.repeat(700 * 1024) } }))
    const limit = Number(url.searchParams.get('limit') || 0)
    return send(res, 200, limit ? list.slice(-limit) : list)
  }
  if ((m = /^\/session\/([^/]+)\/prompt_async$/.exec(p)) && method === 'POST') {
    const s = sessions.get(m[1])
    if (!s) return send(res, 404, { name: 'NotFoundError', data: { message: 'Session not found' } })
    const text = ((body && body.parts) || []).map((x) => x.text || '').join('')
    res.writeHead(204)
    res.end()
    setTimeout(() => replay(s.id, script(s.id, text)), 5)
    return
  }
  if ((m = /^\/session\/([^/]+)\/summarize$/.exec(p)) && method === 'POST') {
    // Answers once the summary is written; says so on the stream.
    const s = sessions.get(m[1])
    if (!s) return send(res, 404, {})
    if (!body || !body.providerID || !body.modelID) return send(res, 400, { name: 'BadRequest', data: { message: 'providerID and modelID required' } })
    setTimeout(() => {
      broadcast({ type: 'session.compacted', properties: { sessionID: s.id } })
      send(res, 200, true)
    }, 5)
    return
  }
  if ((m = /^\/session\/([^/]+)\/command$/.exec(p)) && method === 'POST') {
    const s = sessions.get(m[1])
    if (!s) return send(res, 404, {})
    replay(s.id, [...echo(s.id, `/${body.command} ${body.arguments}`), ...stepEnd(s.id, 'Reviewed.')]).then(() => send(res, 200, { info: { id: 'msg_cmd', role: 'assistant' }, parts: [] }))
    return
  }
  if ((m = /^\/session\/([^/]+)\/abort$/.exec(p)) && method === 'POST') {
    const sid = m[1]
    if (running && running.sid === sid) running.stopped = true
    running = null
    send(res, 200, true)
    setTimeout(() => {
      broadcast({ type: 'session.error', properties: { sessionID: sid, error: { name: 'MessageAbortedError', data: { message: 'The operation was aborted.' } } } })
      broadcast({ type: 'session.status', properties: { sessionID: sid, status: { type: 'idle' } } })
      broadcast({ type: 'session.idle', properties: { sessionID: sid } })
    }, 2)
    return
  }
  if ((m = /^\/permission\/([^/]+)\/reply$/.exec(p)) && method === 'POST') {
    const paused = pausedPermissions.get(decodeURIComponent(m[1]))
    send(res, 200, true)
    if (paused) {
      pausedPermissions.delete(decodeURIComponent(m[1]))
      paused.resume((body && body.reply) || 'once')
    }
    return
  }
  if ((m = /^\/question\/([^/]+)\/(reply|reject)$/.exec(p)) && method === 'POST') {
    const id = decodeURIComponent(m[1])
    const paused = pausedQuestions.get(id)
    send(res, 200, true)
    if (paused) {
      pausedQuestions.delete(id)
      broadcast({ type: m[2] === 'reply' ? 'question.replied' : 'question.rejected', properties: { sessionID: paused.ask.sessionID, requestID: id, ...(m[2] === 'reply' ? { answers: body.answers } : {}) } })
      paused.resume()
    }
    return
  }
  send(res, 404, { name: 'NotFound' })
}

// The real server tries 4096 first; the fake always takes a free port.
const host = process.env.FAKE_OC_HOST || '127.0.0.1'
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port
  log({ t: 'listen', port })
  if (!process.env.FAKE_OC_SILENT) process.stdout.write(`opencode server listening on http://${host}:${port}\n`)
})
// `serve` never exits on its own (stdin closing included).
setInterval(() => {}, 1 << 30)
