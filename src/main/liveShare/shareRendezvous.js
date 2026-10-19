// Live Share: where a share is now, for guests whose address went dead.
//
// A share runs behind a Cloudflare quick tunnel, whose address changes each
// time a tunnel starts (shareTunnel.js), and that address is in every invite
// code. A share is kept until the host stops it (liveShare.js): after a
// restart or a reboot it comes back with the same invitations, codes and
// people, often on a new tunnel. So the host says where it is now on a free,
// public relay (ntfy.sh, no account), and a guest whose address no longer
// answers asks the relay, then connects there the usual way.
//
// What the relay sees and keeps (about 12 hours), per invitation code:
// - A topic: HKDF-SHA256 of the code's secret ("tessel-rendezvous-v1",
//   'topic'), 25 bytes in base32. Unguessable without the secret, and one per
//   code (an invitation's current code, and each earlier code a person let in
//   still comes back with: shareAccess.js), so a TS1 code made before this
//   finds its topic too.
// - Messages "r1.<sealed>.<signature>": the share's address (its base: the
//   guest keeps its invitation's path), when it was said (at) and a counter
//   (seq: never lower than the last one, Date.now() or more), as JSON sealed
//   with AES-256-GCM under a key HKDF'd from the same secret ('key'), a
//   random IV, the topic as associated data; then signed (Ed25519) with the
//   share's signing key, over a label, the topic and the sealed bytes. No
//   secret, code, address or name is ever in clear there.
//
// A guest takes a message only when it opens with its code's key, and, when
// it knows the share's key (from a TS2 code, or from the host's first
// welcome, which the verification code vouched for), only when that key
// signed it; then the newest one (highest seq), and only when it is newer
// than the last it took (a replayed or older address is refused). Bounded on
// both ends: the relay's answer is read up to MAX_READ bytes and MAX_LINES
// messages, a message is at most MAX_MESSAGE characters.
//
// The relay is only a pointer: the connection to the new address still goes
// through TLS to the tunnel and the share's handshake (the invite's secret,
// the reconnect key, the host's signed welcome: shareCrypto.js), so a relay
// that lies, drops or replays messages can at worst keep a guest from finding
// the share, never get in or pose as the host.
//
// The host says it when its address is known (a share started, taken back,
// on a new tunnel) and again every REPUBLISH_MS (the relay forgets after 12
// hours; ntfy.sh limits how much an address publishes a day), one code after
// another. Nothing is logged of a topic, a secret or a message.
import crypto from 'crypto'
import { signBinding, bindingSigned, cleanShareUrl, KX_BYTES } from './shareCrypto.js'

// Fixed: never taken from settings, a code or the network.
export const RELAY_BASE = 'https://ntfy.sh'
export const REPUBLISH_MS = 6 * 60 * 60 * 1000
const LABEL = 'tessel-rendezvous-v1'
const SIG_LABEL = Buffer.from('tessel-rendezvous-v1\0sig\0')
const TIMEOUT_MS = 8000
const MAX_READ = 256 * 1024
const MAX_LINES = 200
export const MAX_MESSAGE = 1024
const MAX_URL = 512
// Codes said in one round at most (a share's invitations and the earlier
// codes its people need: shareAccess.js MAX_INVITES + MAX_PEOPLE), and the
// pause between two (the relay's burst limit).
const MAX_TOPICS = 84
const PUBLISH_GAP_MS = 250
// A message said more than this in the future is not taken (a wrong clock).
const FUTURE_MS = 24 * 60 * 60 * 1000

const b64u = (buf) => Buffer.from(buf).toString('base64url')
const B32 = 'abcdefghijklmnopqrstuvwxyz234567'
function base32(buf) {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}

// A code's topic on the relay and the key its messages are sealed with.
export function rendezvousKeys(secret) {
  if (!Buffer.isBuffer(secret) || secret.length !== 32) return null
  const derive = (info, bytes) => Buffer.from(crypto.hkdfSync('sha256', secret, Buffer.from(LABEL), Buffer.from(info), bytes))
  return { topic: base32(derive('topic', 25)), key: derive('key', 32) }
}

// The message saying the share is at `url` (its base address), for the code
// of this secret, signed with the share's key ({ privateKey, publicRaw }).
export function sealAddress({ secret, url, seq, at = Date.now(), hostKey }) {
  const keys = rendezvousKeys(secret)
  const address = cleanShareUrl(url)
  if (!keys || !address || !Number.isSafeInteger(seq) || seq <= 0 || !hostKey) return null
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', keys.key, iv)
  cipher.setAAD(Buffer.from(keys.topic))
  const body = Buffer.concat([iv, cipher.update(JSON.stringify({ v: 1, url: address, seq, at }), 'utf8'), cipher.final(), cipher.getAuthTag()])
  const sig = signBinding(hostKey, Buffer.concat([SIG_LABEL, Buffer.from(keys.topic), body]))
  return { topic: keys.topic, text: `r1.${b64u(body)}.${b64u(sig)}` }
}

// What a message says ({ url, seq, at }), or null: it must open with this
// code's key and, when the share's key is known (hostKey: its raw public
// half), carry its signature.
export function openAddress(text, { secret, hostKey = null, now = Date.now } = {}) {
  const keys = rendezvousKeys(secret)
  if (!keys || typeof text !== 'string' || text.length > MAX_MESSAGE) return null
  const parts = text.split('.')
  if (parts.length !== 3 || parts[0] !== 'r1' || !/^[\w-]+$/.test(parts[1]) || !/^[\w-]+$/.test(parts[2])) return null
  const body = Buffer.from(parts[1], 'base64url')
  const sig = Buffer.from(parts[2], 'base64url')
  if (body.length < 12 + 16 + 2) return null
  if (hostKey !== null) {
    if (!Buffer.isBuffer(hostKey) || hostKey.length !== KX_BYTES || !bindingSigned(hostKey, Buffer.concat([SIG_LABEL, Buffer.from(keys.topic), body]), sig)) return null
  }
  let said
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', keys.key, body.subarray(0, 12))
    decipher.setAAD(Buffer.from(keys.topic))
    decipher.setAuthTag(body.subarray(body.length - 16))
    said = JSON.parse(Buffer.concat([decipher.update(body.subarray(12, body.length - 16)), decipher.final()]).toString('utf8'))
  } catch {
    return null
  }
  if (!said || said.v !== 1 || typeof said.url !== 'string' || said.url.length > MAX_URL) return null
  const url = cleanShareUrl(said.url)
  if (!url || !Number.isSafeInteger(said.seq) || said.seq <= 0 || !Number.isFinite(said.at) || said.at > now() + FUTURE_MS) return null
  return { url, seq: said.seq, at: said.at }
}

// The newest address among the relay's messages, newer than `after` (the
// last seq taken), or null.
export function newestAddress(texts, { secret, hostKey = null, after = 0, now = Date.now } = {}) {
  let best = null
  for (const text of Array.isArray(texts) ? texts.slice(-MAX_LINES) : []) {
    const said = openAddress(text, { secret, hostKey, now })
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

// The relay (ntfy.sh): publish(topic, text) -> true when it took it;
// latest(topic) -> the messages it still has (texts, oldest first). Small
// timeouts; https only; nothing but the topic and the sealed text sent.
export function createRelay({ fetchImpl = (...a) => fetch(...a), base = RELAY_BASE, timeoutMs = TIMEOUT_MS } = {}) {
  const topicOk = (topic) => typeof topic === 'string' && /^[a-z2-7]{40}$/.test(topic)
  async function call(url, init) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      return await fetchImpl(url, { ...init, signal: ctrl.signal, redirect: 'error', cache: 'no-store' })
    } finally {
      clearTimeout(timer)
    }
  }
  async function readCapped(res) {
    const declared = Number(res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : NaN)
    if (Number.isFinite(declared) && declared > MAX_READ) return null
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader()
      const chunks = []
      let size = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.length
        if (size > MAX_READ) {
          reader.cancel().catch(() => {})
          return null
        }
        chunks.push(Buffer.from(value))
      }
      return Buffer.concat(chunks).toString('utf8')
    }
    const text = await res.text()
    return text.length > MAX_READ ? null : text
  }
  return {
    async publish(topic, text) {
      if (!topicOk(topic) || typeof text !== 'string' || text.length > MAX_MESSAGE) return false
      try {
        // Not forwarded to phones (Firebase), kept in the relay's cache.
        const res = await call(`${base}/${topic}`, { method: 'POST', body: text, headers: { 'Content-Type': 'text/plain', 'X-Firebase': 'no', 'X-Cache': 'yes' } })
        return !!(res && res.ok)
      } catch {
        return false
      }
    },
    async latest(topic) {
      if (!topicOk(topic)) return []
      try {
        const res = await call(`${base}/${topic}/json?poll=1&since=all`, { method: 'GET' })
        if (!res || !res.ok) return []
        const text = await readCapped(res)
        if (text === null) return []
        const out = []
        for (const line of text.split('\n').slice(-MAX_LINES)) {
          if (!line.trim()) continue
          try {
            const ev = JSON.parse(line)
            if (ev && ev.event === 'message' && ev.topic === topic && typeof ev.message === 'string' && ev.message.length <= MAX_MESSAGE) out.push(ev.message)
          } catch {
            /* not a message */
          }
        }
        return out
      } catch {
        return []
      }
    }
  }
}

// The host's side: says the share's address for each of its codes.
// publish({ url, hostKey, secrets, nextSeq, force }): one round, one code
// after another (a round asked for while one runs follows it, with the
// latest asked); without force, only the codes not yet said at this address
// (a new invitation, a new code). forget(): everything said is forgotten
// (the share stopped). log(line): without a topic, secret or address.
export function createPublisher({ relay, log = () => {}, gapMs = PUBLISH_GAP_MS, now = Date.now }) {
  let said = new Map() // topic -> the address said there
  let running = null
  let next = null
  let generation = 0
  async function round(opts, gen) {
    const { url, hostKey, secrets, nextSeq, force } = opts
    const list = []
    const seen = new Set()
    for (const secret of Array.isArray(secrets) ? secrets : []) {
      const keys = rendezvousKeys(secret)
      if (!keys || seen.has(keys.topic)) continue
      seen.add(keys.topic)
      if (force || said.get(keys.topic) !== url) list.push(secret)
      if (list.length >= MAX_TOPICS) break
    }
    let ok = 0
    let failed = 0
    for (const secret of list) {
      if (gen !== generation) return
      const msg = sealAddress({ secret, url, seq: nextSeq(), at: now(), hostKey })
      if (!msg) continue
      if (await relay.publish(msg.topic, msg.text)) {
        if (gen !== generation) return
        said.set(msg.topic, url)
        ok++
      } else failed++
      if (gapMs > 0) await new Promise((r) => setTimeout(r, gapMs))
    }
    if (list.length) log(`rendezvous: address said for ${ok} code(s)${failed ? `, ${failed} not taken by the relay` : ''}`)
  }
  async function pump() {
    while (next) {
      const opts = next
      next = null
      try {
        await round(opts, generation)
      } catch {
        /* said again later */
      }
    }
    running = null
  }
  return {
    publish(opts) {
      if (!opts || !cleanShareUrl(opts.url) || !opts.hostKey || typeof opts.nextSeq !== 'function') return Promise.resolve()
      next = next && next.force ? { ...opts, force: true } : opts
      if (!running) running = pump()
      return running
    },
    forget() {
      generation++
      next = null
      said = new Map()
    },
    // Whether this topic was said at that address (tests).
    saidAt: (topic) => said.get(topic) || null
  }
}
