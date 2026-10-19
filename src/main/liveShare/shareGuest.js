// Live Share, guest side: the connection to a host's share server.
//
// The invite code (shareCrypto.js) gives the address and the secret. The
// host's first message says it is a Tessel Live Share; the guest commits to
// a random nonce and a fresh X25519 key, gets the host's, reveals its own,
// and then everything is sealed with the keys both derive from them and the
// secret. The host sees the guest's name and verification code and says yes
// or no; once in, the guest gets what the host lets it do (onRights), the
// host's projects it sees, each with its layout and its panes (onProjects),
// each pane's screen (onSnapshot) and its output.
// The guest's reconnect key (signingKey, made on this computer): its public
// half goes with the first join, with a signature of the connection (it
// holds it); coming back (back), the guest signs the new connection with it
// instead of asking again. The host signs every welcome with its own key:
// the guest keeps the one of its first welcome (onHostKey; the code it
// compared with the host vouches for it) and, coming back, checks the
// host's signature with it (hostKey) before anything else. A new guest
// whose code names the share's key (TS2) gives it as hostKey too: the
// welcome must be signed with that one.
// A connection that hears nothing from the host (not even its pings, every
// 25 s) for 70 s is over.
// The join says what this Tessel speaks beyond the protocol version
// (shareChat.js SHARE_FEATURES), the welcome what the host does (onFeatures;
// an older host says nothing: none). With 'chat' on both sides, chat(id, on)
// starts or stops watching an agent pane's conversation (read only), which
// comes with onChat(id, message). With 'agents', the host lists the agents
// this guest may ask for (onAgents), and asking without the right to open
// asks the host. With 'presence', focus(id) tells the host which of its panes
// this guest has on screen (only for the host's eyes; at most twice a second,
// the latest).
// Phase 2 (shareChannel.js): with 'files', 'scm' or 'tasks' on both sides,
// request(op, project, args) asks the host about one of its projects and
// resolves its answer ({ ok: true, data } | { ok: false, code, detail? }):
// at most CHANNEL_LIMITS.inFlight at once (the rest wait their turn here, so
// the host's limit is never what turns one away), each given up after a
// while (the host is told: cancel); it rejects when the connection ends or
// the time is up, and answers 'bad-op' at once for a feature the host does
// not speak (an older Tessel). subscribe(topic, project, key, on) follows a
// topic; its news come with onPush(topic, project, key, data), in order
// (an older or repeated one is dropped).
// The guest's identity key (identityKey: made once on this computer, kept in
// liveshare-identity.json by liveShare.js): its public half and a proof that it holds it (shareCrypto.js
// signIdentity, bound to this connection) go with a new join, so a host that
// trusts it lets it in without asking. An older host ignores them.
//
// Tessel itself is reached only through the callbacks, so this file runs
// (and is tested) without Electron.
import WebSocket from 'ws'
import { fallbackLookup } from './shareDns.js'
import { newNonce, newKeyPair, sharedSecret, sessionKeys, createChannel, commitment, signBinding, bindingSigned, signIdentity, NONCE_BYTES, KX_BYTES } from './shareCrypto.js'
import { SHARE_FEATURES, cleanFeatures } from './shareChat.js'
import { OP_AREAS, TOPICS, CHANNEL_LIMITS, cleanSub, subKey } from './shareChannel.js'
import { cleanRights } from '../../shared/liveShareRights'

const CONNECT_TIMEOUT_MS = 20000
const SILENCE_MS = 70000
const MAX_FRAME = 64 * 1024 * 1024 // a snapshot of a screen
// shareHost.js SHARE_PROTOCOL: 4, several projects.
const PROTOCOL = 4
const FOCUS_MS = 500
// Requests: how long one is waited for (a change, a search or git's status
// can take a while on a big project), and how many wait their turn here.
const REQUEST_MS = 45000
const MAX_QUEUED = 64
// A request bigger than this is not sent (the host closes a connection whose
// message is over 1 MB).
const MAX_REQUEST_BYTES = 1000 * 1000

// The host closed before the handshake: why (shareHost.js CLOSE_*).
const CLOSE_REASONS = { 4001: 'expired', 4002: 'busy', 1013: 'busy', 4003: 'outdated' }
// Why a host says goodbye (shareHost.js drop and stop, liveShare.js
// stopSharing); any other word from it is read as a closed connection.
const BYE_REASONS = new Set(['stopped', 'restarting', 'denied', 'removed', 'replaced', 'slow', 'busy', 'expired', 'protocol', 'rejoin-refused', 'timeout', 'refused', 'outdated', 'closed', 'tunnel', 'error'])

// callbacks: onState(state, info) with 'connecting' | 'waiting' (info:
// { code }) | 'joined' (info: { host }), onProjects(projects) (the host's
// projects this guest sees: [{ id, layout, panes }]),
// onSnapshot(id, data, cols, rows), onData(id, data), onExit(id, exitCode),
// onRestart(id) (the pane restarted on the host: a new screen follows),
// onRights(rights), onNotice(code), onClosed(reason) (once, at the end),
// onAgents(list) (the agents the host lists: [{ id, name }], unchecked).
// onHostKey(raw) (the host's key, from the first welcome). onRendezvous(secret)
// (the share's rendezvous secret, from each welcome). onFeatures(list)
// (what the host speaks beyond the protocol, from each welcome), onChat(id,
// message) (an agent pane's conversation: { ok, events, truncated, code }),
// onPush(topic, project, key, data) (a subscription's news, unchecked),
// onPageFrame(msg) and onPageEvent(msg) (a watched page's, unchecked).
// signingKey: { privateKey, publicRaw } (shareCrypto.js newSigningKey);
// back: coming back with it (shareHost.js rejoin), no question; hostKey:
// the host's key kept from the first welcome (a Buffer). features: what this
// Tessel speaks beyond the protocol (SHARE_FEATURES; an older Tessel: none).
export function createShareGuest({ url, secret, name, signingKey, identityKey = null, back = false, hostKey = null, callbacks, features: speaks = SHARE_FEATURES }) {
  let socket = null
  let channel = null
  let code = null
  let closed = false
  let timer = null
  let silence = null
  let mine = null // { nonce, keys } until the host's keys came
  let binding = null // this connection's, as both sides see it
  let welcomed = false // the host's welcome came, its signature checked
  let hostSpeaks = new Set() // what the host speaks beyond the protocol (its welcome)
  // The pane this guest has on screen, as last said to the host, and the
  // next one to say (presence).
  let focusSent = null
  let focusWanted = null
  let focusTimer = null
  let focusAt = 0
  // Requests sent (id -> { resolve, reject, timer }), those waiting their
  // turn, and the last news of each subscription (its seq).
  let nextReq = 1
  const inFlight = new Map()
  const waitingReqs = []
  const lastSeq = new Map()

  function finish(reason) {
    if (closed) return
    closed = true
    clearTimeout(timer)
    clearTimeout(silence)
    clearTimeout(focusTimer)
    // Every request still waiting fails (the views keep what they show).
    for (const r of [...inFlight.values(), ...waitingReqs.splice(0)]) {
      clearTimeout(r.timer)
      r.reject(new Error('closed'))
    }
    inFlight.clear()
    try {
      socket?.close(1000)
    } catch {
      /* already closed */
    }
    callbacks.onClosed?.(reason)
  }

  // Anything from the host (a message, a ping) shows the connection lives.
  function heard() {
    clearTimeout(silence)
    silence = setTimeout(() => finish('timeout'), SILENCE_MS)
  }

  function send(message) {
    if (!channel || !socket || socket.readyState !== 1) return
    socket.send(channel.seal(message))
  }

  // The pane on screen, to a host that listens (once welcomed): at most every
  // FOCUS_MS, the latest.
  function sayFocus() {
    if (!welcomed || !hostSpeaks.has('presence') || focusTimer || closed) return
    const go = () => {
      focusTimer = null
      if (closed || focusWanted === focusSent) return
      focusSent = focusWanted
      focusAt = Date.now()
      send({ t: 'focus', id: focusSent })
    }
    const later = focusAt + FOCUS_MS - Date.now()
    if (later > 0) focusTimer = setTimeout(go, later)
    else go()
  }

  // Requests waiting their turn, sent while fewer than the host's limit are
  // in flight.
  function pump() {
    while (waitingReqs.length && inFlight.size < CHANNEL_LIMITS.inFlight && !closed) {
      const r = waitingReqs.shift()
      const id = nextReq
      nextReq = nextReq >= 2 ** 31 ? 1 : nextReq + 1
      const message = { t: 'req', id, op: r.op, project: r.project, args: r.args }
      let size
      try {
        size = Buffer.byteLength(JSON.stringify(message), 'utf8')
      } catch {
        size = Infinity
      }
      if (size > MAX_REQUEST_BYTES) {
        r.resolve({ ok: false, code: 'too-large' })
        continue
      }
      r.timer = setTimeout(() => {
        if (inFlight.get(id) !== r) return
        inFlight.delete(id)
        send({ t: 'cancel', id })
        r.reject(new Error('timeout'))
        pump()
      }, r.timeoutMs)
      inFlight.set(id, r)
      send(message)
    }
  }
  function onAnswer(msg) {
    const r = Number.isSafeInteger(msg.id) ? inFlight.get(msg.id) : null
    if (!r) return
    inFlight.delete(msg.id)
    clearTimeout(r.timer)
    if (msg.ok === true) r.resolve({ ok: true, data: msg.data === undefined ? null : msg.data })
    else r.resolve({ ok: false, code: typeof msg.code === 'string' ? msg.code.slice(0, 40) : 'failed', ...(typeof msg.detail === 'string' ? { detail: msg.detail.slice(0, 300) } : {}) })
    pump()
  }
  // A subscription's news: a topic this Tessel knows, of a feature the host
  // speaks, newer than the last one.
  function onPushed(msg) {
    const s = cleanSub({ topic: msg.topic, project: msg.project, key: msg.key, on: true })
    if (!s || !hostSpeaks.has(s.spec.feature) || !Number.isSafeInteger(msg.seq)) return
    const k = subKey(s.topic, s.project, s.key)
    if (msg.seq <= (lastSeq.get(k) || 0)) return
    lastSeq.set(k, msg.seq)
    callbacks.onPush?.(s.topic, s.project, s.key, msg.data === undefined ? null : msg.data)
  }

  // Rights as this Tessel knows them (an id it does not know is never kept).
  const rightsOf = (r) => (r && typeof r === 'object' ? cleanRights(r) : null)

  // Before the host's checked welcome, only its welcome, its "wait for my
  // answer" (a new guest only) and its goodbye count: anything else is
  // someone posing as it.
  const BEFORE_WELCOME = new Set(['welcome', 'bye'])
  function onMessage(msg) {
    if (!welcomed && !(BEFORE_WELCOME.has(msg.t) || (msg.t === 'waiting' && !back))) return finish('protocol')
    switch (msg.t) {
      case 'waiting':
        callbacks.onState?.('waiting', { code })
        return
      case 'welcome': {
        clearTimeout(timer)
        // The host signed this connection: with the key kept from the first
        // welcome when coming back (someone else posing as the host is not
        // trusted with anything typed here).
        const key = Buffer.from(String(msg.hostKey || ''), 'base64')
        const sig = Buffer.from(String(msg.hostSig || ''), 'base64')
        // A new guest whose code names the share's key (a TS2 code) expects
        // that one too.
        if (!bindingSigned(key, binding, sig) || (hostKey ? !key.equals(hostKey) : back)) return finish('host-unverified')
        if (!back) callbacks.onHostKey?.(key)
        welcomed = true
        // The share's rendezvous secret (shareRendezvous.js), from the host
        // just checked.
        if (typeof msg.rdv === 'string') {
          const rdv = Buffer.from(msg.rdv, 'base64')
          if (rdv.length === 32) callbacks.onRendezvous?.(rdv)
        }
        // What it may do first: the window takes it as the starting point.
        if (msg.rights) callbacks.onRights?.(rightsOf(msg.rights))
        hostSpeaks = new Set(cleanFeatures(msg.features))
        callbacks.onFeatures?.([...hostSpeaks])
        if (hostSpeaks.has('agents') && Array.isArray(msg.agents)) callbacks.onAgents?.(msg.agents)
        callbacks.onState?.('joined', { host: String(msg.host || '') })
        callbacks.onProjects?.(Array.isArray(msg.projects) ? msg.projects : [])
        // A pane on screen before the welcome (or before a reconnect).
        if (focusWanted !== null) sayFocus()
        return
      }
      case 'projects':
        callbacks.onProjects?.(Array.isArray(msg.projects) ? msg.projects : [])
        return
      case 'rights':
        callbacks.onRights?.(rightsOf(msg.rights))
        return
      case 'notice':
        callbacks.onNotice?.(String(msg.code || ''))
        return
      case 'agents':
        if (hostSpeaks.has('agents') && Array.isArray(msg.agents)) callbacks.onAgents?.(msg.agents)
        return
      case 'snapshot':
        callbacks.onSnapshot?.(msg.id, String(msg.data || ''), msg.cols | 0, msg.rows | 0)
        return
      case 'data':
        callbacks.onData?.(msg.id, String(msg.data || ''))
        return
      case 'exit':
        callbacks.onExit?.(msg.id, msg.exitCode)
        return
      case 'restart':
        callbacks.onRestart?.(msg.id)
        return
      case 'chat':
        if (typeof msg.id === 'string') callbacks.onChat?.(msg.id, msg)
        return
      case 'res':
        onAnswer(msg)
        return
      case 'push':
        onPushed(msg)
        return
      case 'bye':
        finish(BYE_REASONS.has(msg.reason) ? msg.reason : 'closed')
        return
      default:
        return
    }
  }

  const parse = (data, isBinary) => {
    try {
      return isBinary ? null : JSON.parse(data.toString())
    } catch {
      return null
    }
  }

  // The handshake, before the channel: the host's hello (commit), then its
  // keys (reveal and join).
  function onHandshake(msg) {
    if (!mine) {
      if (!msg || msg.t !== 'hello' || msg.app !== 'tessel-liveshare') return finish('not-tessel')
      // A host with a newer protocol than this Tessel, or an older one (the
      // first had its nonce in the hello).
      if (Number(msg.v) > PROTOCOL) return finish('outdated')
      if (msg.v !== PROTOCOL || msg.n != null) return finish('outdated-host')
      mine = { nonce: newNonce(), keys: newKeyPair() }
      socket.send(JSON.stringify({ t: 'commit', c: commitment(mine.nonce, mine.keys.publicRaw).toString('base64') }))
      return
    }
    const hostNonce = msg && msg.t === 'keys' ? Buffer.from(String(msg.n || ''), 'base64') : null
    const hostKey = msg && msg.t === 'keys' ? Buffer.from(String(msg.kx || ''), 'base64') : null
    if (!hostNonce || hostNonce.length !== NONCE_BYTES || !hostKey || hostKey.length !== KX_BYTES) return finish('not-tessel')
    const dh = sharedSecret(mine.keys.privateKey, hostKey)
    if (!dh) return finish('not-tessel')
    socket.send(JSON.stringify({ t: 'reveal', n: mine.nonce.toString('base64'), kx: mine.keys.publicRaw.toString('base64') }))
    const session = sessionKeys(secret, hostNonce, mine.nonce, 'guest', { dh, hostKey, guestKey: mine.keys.publicRaw })
    mine = null
    channel = createChannel(session)
    code = session.code
    binding = session.binding
    const key = signingKey.publicRaw.toString('base64')
    const sig = signBinding(signingKey, binding).toString('base64')
    const features = cleanFeatures(speaks)
    if (back) send({ t: 'join', name, features, rejoin: { key, sig } })
    else {
      const identity = identityKey ? { key: identityKey.publicRaw.toString('base64'), sig: signIdentity(identityKey, binding).toString('base64') } : undefined
      send({ t: 'join', name, features, key, sig, ...(identity ? { identity } : {}) })
    }
  }

  return {
    connect() {
      callbacks.onState?.('connecting')
      try {
        // The host's address found through public DNS when this PC's cannot.
        socket = new WebSocket(url, { maxPayload: MAX_FRAME, perMessageDeflate: false, handshakeTimeout: CONNECT_TIMEOUT_MS, lookup: fallbackLookup() })
      } catch {
        finish('error')
        return
      }
      // Until the host says yes, a connection that goes nowhere ends here;
      // waiting for the host's answer has no limit (cleared on 'waiting').
      timer = setTimeout(() => finish('timeout'), CONNECT_TIMEOUT_MS)
      heard()
      socket.on('ping', heard)
      socket.on('message', (data, isBinary) => {
        if (closed) return
        heard()
        if (!channel) return onHandshake(parse(data, isBinary))
        const msg = isBinary ? channel.open(data) : null
        if (!msg) return finish('refused')
        if (msg.t === 'waiting' && !back) clearTimeout(timer)
        onMessage(msg)
      })
      socket.on('close', (closeCode) => finish(CLOSE_REASONS[closeCode] || 'closed'))
      socket.on('error', (err) => finish(err?.code === 'ECONNREFUSED' || err?.code === 'ENOTFOUND' ? 'unreachable' : 'error'))
    },
    write(id, data) {
      send({ t: 'write', id, data })
    },
    open(spec) {
      send({ t: 'open', spec })
    },
    close(id) {
      send({ t: 'close', id })
    },
    // The pane's screen again (this window reloaded).
    resync(id) {
      send({ t: 'resync', id })
    },
    // The host's pane this guest has on screen (null: none of the host's):
    // said to a host that listens, at most every FOCUS_MS, the latest.
    focus(id) {
      focusWanted = typeof id === 'string' ? id : null
      sayFocus()
    },
    // An agent pane's conversation watched (on) or no longer: read only.
    chat(id, on) {
      send({ t: 'chat', id, on: !!on })
    },
    // All of a watched conversation again (this guest's copy no longer lines
    // up with the host's updates).
    resyncChat(id) {
      send({ t: 'chat', id, on: true, resync: true })
    },
    // Whether the host speaks a feature (its welcome; false before it).
    speaks: (feature) => welcomed && hostSpeaks.has(feature),
    // A request about one of the host's projects (shareChannel.js): resolves
    // the host's answer; rejects when the connection ends or the time is up.
    request(op, project, args = {}, { timeoutMs = REQUEST_MS } = {}) {
      return new Promise((resolve, reject) => {
        if (closed || !welcomed) return reject(new Error('closed'))
        const area = typeof op === 'string' && op.includes('.') ? op.slice(0, op.indexOf('.')) : ''
        const feature = Object.hasOwn(OP_AREAS, area) ? OP_AREAS[area] : null
        // A host whose Tessel does not do this (an older one): said at once.
        if (!feature || !hostSpeaks.has(feature)) return resolve({ ok: false, code: 'bad-op' })
        if (waitingReqs.length >= MAX_QUEUED) return resolve({ ok: false, code: 'busy' })
        waitingReqs.push({ op, project, args: args && typeof args === 'object' ? args : {}, resolve, reject, timer: null, timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : REQUEST_MS })
        pump()
      })
    },
    // A topic followed (on) or no longer. false when the host does not speak
    // its feature (or before its welcome): nothing was asked.
    subscribe(topic, project = null, key = null, on = true) {
      const spec = Object.hasOwn(TOPICS, topic) ? TOPICS[topic] : null
      if (closed || !welcomed || !spec || !hostSpeaks.has(spec.feature)) return false
      if (!on) lastSeq.delete(subKey(topic, project, key))
      send({ t: 'sub', topic, ...(project ? { project } : {}), ...(key ? { key } : {}), on: !!on })
      return true
    },
    leave() {
      send({ t: 'leave' })
      finish('left')
    },
    // Gone without leaving (this Tessel restarting): the host keeps the
    // reconnect key, and the next Tessel comes back with it.
    disconnect() {
      finish('suspended')
    }
  }
}
