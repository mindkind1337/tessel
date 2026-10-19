// Live Share: where a share is now, for guests whose address went dead.
//
// A share runs behind a Cloudflare quick tunnel, whose address changes each
// time a tunnel starts (shareTunnel.js), and that address is in every invite
// code. A share is kept until the host stops it (liveShare.js): after a
// restart or a reboot it comes back with the same invitations, codes and
// people, often on a new tunnel. So the host says where it is now on a free,
// public relay (ntfy.sh, no account), and a guest whose address no longer
// answers asks the relay, then connects there the usual way. The host can
// turn it off (Live Share's setting "Find me again after a restart"): then
// neither side calls the relay.
//
// Topics (what the relay sees), each HKDF-SHA256 of a secret
// ("tessel-rendezvous-v1", 'topic'), 25 bytes in base32, unguessable without
// that secret:
// - The share's own topic, from a share-level secret (made with the share,
//   kept with it) that the host gives each guest it lets in, inside its
//   signed welcome (shareHost.js): every guest let in, trusted people too,
//   finds the share there, whatever code it came with.
// - One per invitation that still lets new guests in (not expired, revoked,
//   blocked or used up), from its code's secret: for a first join with a
//   code whose address is dead. A topic stops being said once its
//   invitation can't be used any more.
// ntfy.sh takes 250 messages a day from an address: the host says the
// address only when it changed (at most once every ADDRESS_GAP_MS), for a
// new code, and again every REPUBLISH_MS (the relay forgets after 12 hours),
// one topic a second; a topic the relay refused (a limit, a timeout) is tried
// again after RETRY_DELAYS. Nothing is logged of a topic, a secret or an
// address (counts only).
//
// Messages "r1.<sealed>.<signature>": { url (the share's base address: the
// guest keeps its invitation's path), seq, at } or { stopped: true, seq, at }
// (the host pressed Stop sharing: guests end), as JSON sealed with
// AES-256-GCM under a key HKDF'd from the same secret ('key'), a random IV,
// the topic as associated data; then signed (Ed25519) with the share's key,
// over a label, the topic and the sealed bytes. seq is never lower than the
// last one said (Date.now() or more). No secret, code, name or address is
// ever in clear there.
//
// A guest takes a message only when it is signed with the share's key (from
// a TS2 code, or pinned by the host's first welcome, which the verification
// code vouched for): never on the seal alone, since anyone holding an
// invitation's code could seal one. A TS1 code (no key in it) is never sent
// elsewhere by the relay: its own address, or a new code. Then the newest one
// (highest seq), newer than the last it took (a replayed or older one is
// refused) and not dated or counted more than FUTURE_MS ahead (a counter at
// the end of the line would blind it). Only wss:// addresses of
// trycloudflare.com are taken (urlOk). The relay's answer is read up to
// MAX_READ bytes, keeping the newest (a flood can't push the host's message
// out), line by line, skipping lines that are no r1 message.
//
// The relay is only a pointer: the connection to the new address still goes
// through TLS to the tunnel and the share's handshake (the invite's secret,
// the reconnect key, the host's signed welcome: shareCrypto.js), so a relay
// that lies, drops or replays messages can at worst keep a guest from finding
// the share, never get in or pose as the host.
import crypto from 'crypto'
import { signBinding, bindingSigned, cleanShareUrl, KX_BYTES } from './shareCrypto.js'

// Fixed: never taken from settings, a code or the network.
export const RELAY_BASE = 'https://ntfy.sh'
export const REPUBLISH_MS = 11 * 60 * 60 * 1000
export const ADDRESS_GAP_MS = 3 * 60 * 1000
export const RETRY_DELAYS = Object.freeze([60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000])
const LABEL = 'tessel-rendezvous-v1'
const SIG_LABEL = Buffer.from('tessel-rendezvous-v1\0sig\0')
const TIMEOUT_MS = 8000
const MAX_READ = 2 * 1024 * 1024
// One line of the relay's answer: a JSON event around one message.
const MAX_LINE = 4096
export const MAX_MESSAGE = 1024
const MAX_URL = 512
// Topics said in one round at most (the share's and its invitations':
// shareAccess.js MAX_INVITES), and the pause between two.
const MAX_TOPICS = 24
const PUBLISH_GAP_MS = 1000
// A message dated or counted more than this ahead is not taken (a wrong
// clock, or a counter set at the end of the line).
const FUTURE_MS = 24 * 60 * 60 * 1000
const R1 = /^r1\.[\w-]{40,1400}\.[\w-]{86}$/

const b64u = (buf) => Buffer.from(buf).toString('base64url')
const B32 = 'abcdefghijklmnopqrstuvwxyz234567'
function base32(buf) {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buf) {
    value = ((value << 8) | byte) & 0xffff
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}

// A code's (or the share's) topic on the relay and the key its messages are
// sealed with.
export function rendezvousKeys(secret) {
  if (!Buffer.isBuffer(secret) || secret.length !== 32) return null
  const derive = (info, bytes) => Buffer.from(crypto.hkdfSync('sha256', secret, Buffer.from(LABEL), Buffer.from(info), bytes))
  return { topic: base32(derive('topic', 25)), key: derive('key', 32) }
}

// An address the relay may send a guest to: a Cloudflare quick tunnel's
// (wss://<words>.trycloudflare.com/), nothing else.
export function isTunnelUrl(text) {
  const clean = cleanShareUrl(text)
  if (!clean) return false
  const u = new URL(clean)
  return u.protocol === 'wss:' && /^[a-z0-9-]{1,100}\.trycloudflare\.com$/.test(u.hostname) && u.port === '' && u.pathname === '/'
}

// The message saying the share is at `url` (its base address), or that it
// stopped (stopped: true), for the topic of this secret, signed with the
// share's key ({ privateKey, publicRaw }).
export function sealAddress({ secret, url = null, stopped = false, seq, at = Date.now(), hostKey }) {
  const keys = rendezvousKeys(secret)
  const address = stopped ? null : cleanShareUrl(url)
  if (!keys || (!stopped && !address) || !Number.isSafeInteger(seq) || seq <= 0 || !hostKey) return null
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', keys.key, iv)
  cipher.setAAD(Buffer.from(keys.topic))
  const said = stopped ? { v: 1, stopped: true, seq, at } : { v: 1, url: address, seq, at }
  const body = Buffer.concat([iv, cipher.update(JSON.stringify(said), 'utf8'), cipher.final(), cipher.getAuthTag()])
  const sig = signBinding(hostKey, Buffer.concat([SIG_LABEL, Buffer.from(keys.topic), body]))
  return { topic: keys.topic, text: `r1.${b64u(body)}.${b64u(sig)}` }
}

// What a message says ({ url, seq, at } or { stopped: true, seq, at }), or
// null: it must be signed with the share's key (hostKey: its raw public half;
// none known: nothing is taken) and open with this secret's key.
export function openAddress(text, { secret, hostKey, now = Date.now, urlOk = isTunnelUrl } = {}) {
  const keys = rendezvousKeys(secret)
  if (!keys || typeof text !== 'string' || text.length > MAX_MESSAGE || !R1.test(text)) return null
  if (!Buffer.isBuffer(hostKey) || hostKey.length !== KX_BYTES) return null
  const [, b, s] = text.split('.')
  const body = Buffer.from(b, 'base64url')
  const sig = Buffer.from(s, 'base64url')
  if (body.length < 12 + 16 + 2) return null
  if (!bindingSigned(hostKey, Buffer.concat([SIG_LABEL, Buffer.from(keys.topic), body]), sig)) return null
  let said
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', keys.key, body.subarray(0, 12))
    decipher.setAAD(Buffer.from(keys.topic))
    decipher.setAuthTag(body.subarray(body.length - 16))
    said = JSON.parse(Buffer.concat([decipher.update(body.subarray(12, body.length - 16)), decipher.final()]).toString('utf8'))
  } catch {
    return null
  }
  if (!said || said.v !== 1 || !Number.isSafeInteger(said.seq) || said.seq <= 0 || !Number.isFinite(said.at)) return null
  const limit = now() + FUTURE_MS
  if (said.at > limit || said.seq > limit) return null
  if (said.stopped === true) return { stopped: true, seq: said.seq, at: said.at }
  if (typeof said.url !== 'string' || said.url.length > MAX_URL) return null
  const url = cleanShareUrl(said.url)
  if (!url || !urlOk(url)) return null
  return { url, seq: said.seq, at: said.at }
}

// The newest message among the relay's, newer than `after` (the last seq
// taken), or null.
export function newestAddress(texts, { secret, hostKey, after = 0, now = Date.now, urlOk = isTunnelUrl } = {}) {
  let best = null
  for (const text of Array.isArray(texts) ? texts : []) {
    const said = openAddress(text, { secret, hostKey, now, urlOk })
    if (said && said.seq > after && (!best || said.seq > best.seq)) best = said
  }
  return best
}

// The guest's address with a new base: the share's address the relay gave,
// with the path of the guest's invitation ('/i/<path>' or '/').
export function withBase(base, current) {
  const b = cleanShareUrl(base)
  let path = '/'
  try {
    path = new URL(String(current)).pathname
  } catch {
    /* the address itself */
  }
  if (!b || !/^\/(i\/[A-Za-z0-9_-]{16}\/?)?$/.test(path)) return null
  const url = new URL(b)
  url.pathname = path
  return cleanShareUrl(url.toString())
}

// The r1 messages of a topic in the relay's answer (lines of JSON), oldest
// first; lines too long, of another topic or that are no r1 message skipped.
function messagesIn(text, topic) {
  const out = []
  for (const line of text.split('\n')) {
    if (!line || line.length > MAX_LINE) continue
    let ev
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    if (ev && ev.event === 'message' && ev.topic === topic && typeof ev.message === 'string' && ev.message.length <= MAX_MESSAGE && R1.test(ev.message)) out.push(ev.message)
  }
  return out
}

// The relay (ntfy.sh): publish(topic, text) -> { ok, limited } (limited: it
// refused for its rate limit); latest(topic) -> the messages it still has
// (texts, oldest first). Small timeouts that cover reading the answer too;
// https only; nothing but the topic and the sealed text sent.
export function createRelay({ fetchImpl = (...a) => fetch(...a), base = RELAY_BASE, timeoutMs = TIMEOUT_MS } = {}) {
  const topicOk = (topic) => typeof topic === 'string' && /^[a-z2-7]{40}$/.test(topic)
  // fetch, then read(res), both within the timeout.
  async function call(url, init, read) {
    const ctrl = new AbortController()
    let timer = null
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        ctrl.abort()
        reject(new Error('timeout'))
      }, timeoutMs)
    })
    try {
      return await Promise.race([
        (async () => {
          const res = await fetchImpl(url, { ...init, signal: ctrl.signal, redirect: 'error', cache: 'no-store' })
          return await read(res)
        })(),
        timeout
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  // The answer's text, its newest MAX_READ bytes at most (ntfy lists the
  // oldest first: what a flood pushes out is the oldest).
  async function readTail(res) {
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader()
      let chunks = []
      let size = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(Buffer.from(value))
        size += value.length
        if (size > MAX_READ * 2) {
          const all = Buffer.concat(chunks)
          chunks = [all.subarray(all.length - MAX_READ)]
          size = MAX_READ
        }
      }
      const all = Buffer.concat(chunks)
      return tail(all.length > MAX_READ ? all.subarray(all.length - MAX_READ).toString('utf8') : all.toString('utf8'), all.length > MAX_READ)
    }
    const text = await res.text()
    return tail(text.length > MAX_READ ? text.slice(text.length - MAX_READ) : text, text.length > MAX_READ)
  }
  // A text cut at its start begins mid-line: that line goes.
  const tail = (text, cut) => (cut ? text.slice(text.indexOf('\n') + 1) : text)
  return {
    async publish(topic, text) {
      if (!topicOk(topic) || typeof text !== 'string' || text.length > MAX_MESSAGE) return { ok: false, limited: false }
      try {
        // Not forwarded to phones (Firebase), kept in the relay's cache.
        return await call(`${base}/${topic}`, { method: 'POST', body: text, headers: { 'Content-Type': 'text/plain', 'X-Firebase': 'no' } }, async (res) => ({ ok: !!(res && res.ok), limited: !!res && res.status === 429 }))
      } catch {
        return { ok: false, limited: false }
      }
    },
    async latest(topic) {
      if (!topicOk(topic)) return []
      try {
        return await call(`${base}/${topic}/json?poll=1&since=all`, { method: 'GET' }, async (res) => (res && res.ok ? messagesIn(await readTail(res), topic) : []))
      } catch {
        return []
      }
    }
  }
}

// The host's side: says the share's address on each of its topics.
// publish({ url, hostKey, secrets, nextSeq, refresh }): the topics not yet
// said at this address (a new address: at most once every minGapMs, the
// latest one then; a new code: at once), or every one (refresh: the relay
// about to forget); one topic every gapMs; the ones the relay refused tried
// again after retryDelays. stop({ hostKey, secrets, nextSeq }): "stopped" on
// each topic, everything else dropped. forget(): the share stopped or paused.
// seed(url, topics) / said(): what was said, kept across a restart (an
// address said already is not said again). log(line): counts only.
export function createPublisher({ relay, log = () => {}, gapMs = PUBLISH_GAP_MS, retryDelays = RETRY_DELAYS, minGapMs = ADDRESS_GAP_MS, now = Date.now, urlOk = isTunnelUrl }) {
  let said = new Map() // topic -> the address said there
  const failed = new Map() // topic -> tries refused
  let generation = 0
  let wanted = null
  let lastOpts = null
  let running = null
  let lastUrl = null
  let movedAt = -Infinity
  let delayTimer = null
  const timers = new Set()
  const later = (fn, ms) => {
    const t = setTimeout(() => {
      timers.delete(t)
      fn()
    }, ms)
    t.unref?.()
    timers.add(t)
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  function topicsOf(secrets) {
    const list = []
    const seen = new Set()
    for (const secret of Array.isArray(secrets) ? secrets : []) {
      const keys = rendezvousKeys(secret)
      if (!keys || seen.has(keys.topic)) continue
      seen.add(keys.topic)
      list.push({ secret, topic: keys.topic })
      if (list.length >= MAX_TOPICS) break
    }
    return list
  }
  async function round(opts, gen) {
    const { url, hostKey, nextSeq, refresh } = opts
    if (url !== lastUrl) {
      lastUrl = url
      movedAt = now()
    }
    const list = topicsOf(opts.secrets).filter((x) => refresh || said.get(x.topic) !== url)
    let ok = 0
    let refused = 0
    let limited = 0
    for (let i = 0; i < list.length; i++) {
      if (gen !== generation) return
      if (i && gapMs > 0) await sleep(gapMs)
      if (gen !== generation) return
      const { secret, topic } = list[i]
      const msg = sealAddress({ secret, url, seq: nextSeq(), at: now(), hostKey })
      if (!msg) continue
      const r = await relay.publish(msg.topic, msg.text)
      if (gen !== generation) return
      if (r && r.ok) {
        said.set(topic, url)
        failed.delete(topic)
        ok++
      } else {
        refused++
        if (r && r.limited) limited++
        failed.set(topic, (failed.get(topic) || 0) + 1)
      }
    }
    if (list.length) log(`rendezvous: address said on ${ok} topic(s)${refused ? `, ${refused} refused by the relay${limited ? ` (${limited} for its rate limit)` : ''}` : ''}`)
    // Refused ones: again later (a round of what is not said yet).
    if (refused) {
      const tries = Math.min(...[...failed.values()])
      if (tries <= retryDelays.length)
        later(() => {
          if (gen !== generation || !lastOpts) return
          if (!wanted) wanted = { ...lastOpts, refresh: false }
          kick()
        }, retryDelays[tries - 1])
    }
  }
  function kick() {
    if (running || !wanted) return running || Promise.resolve()
    const opts = wanted
    // A new address: at most once every minGapMs (then the latest).
    if (lastUrl !== null && opts.url !== lastUrl && now() - movedAt < minGapMs) {
      if (!delayTimer) {
        delayTimer = setTimeout(
          () => {
            delayTimer = null
            kick()
          },
          minGapMs - (now() - movedAt)
        )
        delayTimer.unref?.()
      }
      return Promise.resolve()
    }
    wanted = null
    const gen = generation
    running = round(opts, gen)
      .catch(() => {})
      .finally(() => {
        running = null
        if (wanted && gen === generation) kick()
      })
    return running
  }
  function drop() {
    generation++
    wanted = null
    clearTimeout(delayTimer)
    delayTimer = null
    for (const t of timers) clearTimeout(t)
    timers.clear()
  }
  return {
    publish(opts) {
      if (!opts || !urlOk(opts.url) || !opts.hostKey || typeof opts.nextSeq !== 'function') return Promise.resolve()
      lastOpts = opts
      wanted = wanted && wanted.refresh ? { ...opts, refresh: true } : opts
      return kick()
    },
    async stop({ hostKey, secrets, nextSeq }) {
      drop()
      const gen = generation
      const list = topicsOf(secrets)
      let ok = 0
      for (let i = 0; i < list.length; i++) {
        if (gen !== generation) return
        if (i && gapMs > 0) await sleep(gapMs)
        const msg = sealAddress({ secret: list[i].secret, stopped: true, seq: nextSeq(), at: now(), hostKey })
        if (msg && (await relay.publish(msg.topic, msg.text))?.ok) ok++
      }
      if (list.length) log(`rendezvous: "stopped" said on ${ok} of ${list.length} topic(s)`)
    },
    forget() {
      drop()
      said = new Map()
      failed.clear()
      lastOpts = null
      lastUrl = null
      movedAt = -Infinity
    },
    seed(url, topics) {
      for (const t of Array.isArray(topics) ? topics : []) if (typeof t === 'string' && /^[a-z2-7]{40}$/.test(t)) said.set(t, url)
      lastUrl = url
    },
    said: (url) => [...said].filter(([, u]) => u === url).map(([t]) => t),
    // Whether this topic was said at that address (tests).
    saidAt: (topic) => said.get(topic) || null
  }
}
