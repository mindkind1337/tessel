// @vitest-environment node
// Live Share's rendezvous (liveShare/shareRendezvous.js): where a share says
// its address on the relay, sealed with a key from the code's secret and
// signed with the share's key, and how a guest reads it back (newest only,
// nothing older or replayed). The relay is a fake fetch: nothing goes to
// ntfy.sh.
import { describe, it, expect, vi } from 'vitest'
import { rendezvousKeys, sealAddress, openAddress, newestAddress, withBase, createRelay, createPublisher, RELAY_BASE, MAX_MESSAGE } from '../liveShare/shareRendezvous'
import { newSecret, newSigningKey } from '../liveShare/shareCrypto'

const URL_A = 'wss://first-words.trycloudflare.com/'
const URL_B = 'wss://other-words.trycloudflare.com/'

describe('rendezvous keys', () => {
  it('one topic and one key per code, from its secret alone (a TS1 code finds it too)', () => {
    const secret = newSecret()
    const a = rendezvousKeys(secret)
    const b = rendezvousKeys(Buffer.from(secret))
    expect(a.topic).toBe(b.topic)
    expect(a.key.equals(b.key)).toBe(true)
    // Long, unguessable, a valid ntfy topic; never the secret itself.
    expect(a.topic).toMatch(/^[a-z2-7]{40}$/)
    expect(a.topic).not.toContain(secret.toString('base64url').toLowerCase().slice(0, 12))
    const other = rendezvousKeys(newSecret())
    expect(other.topic).not.toBe(a.topic)
    expect(other.key.equals(a.key)).toBe(false)
    expect(rendezvousKeys(Buffer.alloc(8))).toBe(null)
  })
})

describe('a sealed and signed address', () => {
  it('opens with the code’s secret and the share’s key; nothing readable on the relay', () => {
    const secret = newSecret()
    const hostKey = newSigningKey()
    const msg = sealAddress({ secret, url: URL_A, seq: 7, at: 1000, hostKey })
    expect(msg.topic).toBe(rendezvousKeys(secret).topic)
    expect(msg.text.startsWith('r1.')).toBe(true)
    expect(msg.text.length).toBeLessThan(MAX_MESSAGE)
    for (const clear of ['trycloudflare', 'first-words', Buffer.from(URL_A).toString('base64url'), secret.toString('base64url'), secret.toString('base64')]) expect(msg.text).not.toContain(clear)
    expect(openAddress(msg.text, { secret, hostKey: hostKey.publicRaw, now: () => 2000 })).toEqual({ url: URL_A, seq: 7, at: 1000 })
    // Without the share's key (a TS1 code's first join): the seal alone.
    expect(openAddress(msg.text, { secret, now: () => 2000 })).toEqual({ url: URL_A, seq: 7, at: 1000 })
  })

  it('refuses a wrong secret, another key’s signature, a tampered message, and junk', () => {
    const secret = newSecret()
    const hostKey = newSigningKey()
    const { text } = sealAddress({ secret, url: URL_A, seq: 1, hostKey })
    expect(openAddress(text, { secret: newSecret() })).toBe(null)
    expect(openAddress(text, { secret, hostKey: newSigningKey().publicRaw })).toBe(null)
    // Someone with the secret (another guest of that invitation) but not the
    // share's key: refused by a guest that knows the key.
    const forged = sealAddress({ secret, url: URL_B, seq: 2, hostKey: newSigningKey() }).text
    expect(openAddress(forged, { secret, hostKey: hostKey.publicRaw })).toBe(null)
    const [p, body, sig] = text.split('.')
    const flipped = Buffer.from(body, 'base64url')
    flipped[20] ^= 1
    expect(openAddress(`${p}.${flipped.toString('base64url')}.${sig}`, { secret })).toBe(null)
    expect(openAddress(`${p}.${flipped.toString('base64url')}.${sig}`, { secret, hostKey: hostKey.publicRaw })).toBe(null)
    for (const junk of ['', 'r1', 'r1.x.y', 'r2.' + body + '.' + sig, text + '.x', 'r1.' + 'A'.repeat(MAX_MESSAGE) + '.' + sig, null, 42]) expect(openAddress(junk, { secret })).toBe(null)
  })

  it('refuses an address that is no share’s (plain ws:// away from this network, http, a user and password)', () => {
    const secret = newSecret()
    const hostKey = newSigningKey()
    for (const url of ['ws://evil.example/', 'http://a.example/', 'wss://u:p@a.example/']) expect(sealAddress({ secret, url, seq: 1, hostKey })).toBe(null)
  })

  it('a message dated more than a day ahead is refused (a wrong clock)', () => {
    const secret = newSecret()
    const hostKey = newSigningKey()
    const { text } = sealAddress({ secret, url: URL_A, seq: 1, at: 10 * 24 * 3600 * 1000, hostKey })
    expect(openAddress(text, { secret, now: () => 0 })).toBe(null)
  })
})

describe('the newest address', () => {
  it('takes the highest counter, and nothing at or below the last one taken (replayed or older)', () => {
    const secret = newSecret()
    const hostKey = newSigningKey()
    const seal = (url, seq) => sealAddress({ secret, url, seq, hostKey }).text
    const texts = [seal(URL_A, 10), seal(URL_B, 30), seal(URL_A, 20), 'junk']
    expect(newestAddress(texts, { secret, hostKey: hostKey.publicRaw })).toMatchObject({ url: URL_B, seq: 30 })
    // Already took 30: the same message again, or an older one, is nothing new.
    expect(newestAddress(texts, { secret, hostKey: hostKey.publicRaw, after: 30 })).toBe(null)
    expect(newestAddress([seal(URL_A, 20)], { secret, after: 25 })).toBe(null)
    // A newer one signed by someone else does not hide the host's.
    const forged = sealAddress({ secret, url: 'wss://evil-words.trycloudflare.com/', seq: 99, hostKey: newSigningKey() }).text
    expect(newestAddress([...texts, forged], { secret, hostKey: hostKey.publicRaw })).toMatchObject({ url: URL_B, seq: 30 })
  })

  it('the guest keeps its invitation’s path on the new address', () => {
    expect(withBase(URL_B, 'wss://first-words.trycloudflare.com/i/abcdefghijklmnop')).toBe('wss://other-words.trycloudflare.com/i/abcdefghijklmnop')
    expect(withBase(URL_B, 'wss://first-words.trycloudflare.com/')).toBe(URL_B)
    expect(withBase('ws://127.0.0.1:9/', 'ws://127.0.0.1:8/i/abcdefghijklmnop')).toBe('ws://127.0.0.1:9/i/abcdefghijklmnop')
    expect(withBase('ws://evil.example/', URL_A)).toBe(null)
    expect(withBase(URL_B, 'wss://a.example/../etc')).toBe(null)
    expect(withBase(URL_B, 'wss://a.example/other/path')).toBe(null)
  })
})

// A fetch that answers like ntfy.sh: POST keeps a message, GET .../json?poll=1
// gives them back as lines of JSON.
function fakeNtfy() {
  const topics = new Map()
  const calls = []
  const fetchImpl = vi.fn(async (url, init = {}) => {
    calls.push([url, init])
    const u = new URL(url)
    if (u.origin !== RELAY_BASE) throw new Error('not the relay')
    const parts = u.pathname.split('/').filter(Boolean)
    if (init.method === 'POST') {
      if (!topics.has(parts[0])) topics.set(parts[0], [])
      topics.get(parts[0]).push(String(init.body))
      return { ok: true, headers: new Map(), text: async () => '{}' }
    }
    const lines = [JSON.stringify({ event: 'open', topic: parts[0] }), ...(topics.get(parts[0]) || []).map((m, i) => JSON.stringify({ id: String(i), time: i, event: 'message', topic: parts[0], message: m }))]
    return { ok: true, headers: new Map(), text: async () => lines.join('\n') + '\n' }
  })
  return { topics, calls, fetchImpl }
}

describe('the relay (ntfy.sh)', () => {
  it('publishes to its fixed https address and reads back the messages of a topic only', async () => {
    const ntfy = fakeNtfy()
    const relay = createRelay({ fetchImpl: ntfy.fetchImpl })
    const topic = rendezvousKeys(newSecret()).topic
    expect(await relay.publish(topic, 'r1.a.b')).toBe(true)
    const [url, init] = ntfy.calls[0]
    expect(url).toBe(`https://ntfy.sh/${topic}`)
    expect(init).toMatchObject({ method: 'POST', body: 'r1.a.b', redirect: 'error' })
    expect(init.headers['X-Firebase']).toBe('no')
    expect(await relay.latest(topic)).toEqual(['r1.a.b'])
    expect(ntfy.calls[1][0]).toBe(`https://ntfy.sh/${topic}/json?poll=1&since=all`)
    // Not a topic of ours, a message too long: nothing sent.
    expect(await relay.publish('../x', 'r1.a.b')).toBe(false)
    expect(await relay.publish(topic, 'x'.repeat(MAX_MESSAGE + 1))).toBe(false)
    expect(await relay.latest('Not-Ours')).toEqual([])
    expect(ntfy.calls).toHaveLength(2)
  })

  it('a relay that fails, answers too much or hangs gives nothing (and never throws)', async () => {
    const topic = rendezvousKeys(newSecret()).topic
    const failing = createRelay({ fetchImpl: async () => ({ ok: false, headers: new Map() }) })
    expect(await failing.publish(topic, 'r1.a.b')).toBe(false)
    expect(await failing.latest(topic)).toEqual([])
    const throwing = createRelay({ fetchImpl: async () => Promise.reject(new Error('offline')) })
    expect(await throwing.latest(topic)).toEqual([])
    const huge = createRelay({ fetchImpl: async () => ({ ok: true, headers: new Map([['content-length', String(10 * 1024 * 1024)]]), text: async () => 'x' }) })
    expect(await huge.latest(topic)).toEqual([])
    const big = createRelay({ fetchImpl: async () => ({ ok: true, headers: new Map(), text: async () => 'x'.repeat(300 * 1024) }) })
    expect(await big.latest(topic)).toEqual([])
    const hanging = createRelay({ timeoutMs: 50, fetchImpl: (url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))) })
    expect(await hanging.latest(topic)).toEqual([])
    // Lines of another topic, or that are no message, are skipped.
    const mixed = createRelay({
      fetchImpl: async () => ({ ok: true, headers: new Map(), text: async () => [JSON.stringify({ event: 'message', topic: 'zz', message: 'other' }), 'not json', JSON.stringify({ event: 'keepalive', topic }), JSON.stringify({ event: 'message', topic, message: 'mine' })].join('\n') })
    })
    expect(await mixed.latest(topic)).toEqual(['mine'])
  })
})

describe('the host’s publisher', () => {
  it('says the address for each code once, a new code as it comes, every code again when forced or moved; nothing in its log', async () => {
    const ntfy = fakeNtfy()
    const relay = createRelay({ fetchImpl: ntfy.fetchImpl })
    const logs = []
    const pub = createPublisher({ relay, log: (l) => logs.push(l), gapMs: 0 })
    const hostKey = newSigningKey()
    const s1 = newSecret()
    const s2 = newSecret()
    let seq = 0
    const nextSeq = () => ++seq
    await pub.publish({ url: URL_A, hostKey, secrets: [s1, s2, s1], nextSeq })
    expect(ntfy.calls).toHaveLength(2)
    await pub.publish({ url: URL_A, hostKey, secrets: [s1, s2], nextSeq })
    expect(ntfy.calls).toHaveLength(2)
    const s3 = newSecret()
    await pub.publish({ url: URL_A, hostKey, secrets: [s1, s2, s3], nextSeq })
    expect(ntfy.calls).toHaveLength(3)
    await pub.publish({ url: URL_A, hostKey, secrets: [s1, s2, s3], nextSeq, force: true })
    expect(ntfy.calls).toHaveLength(6)
    await pub.publish({ url: URL_B, hostKey, secrets: [s1], nextSeq })
    expect(ntfy.calls).toHaveLength(7)
    // Each code's topic has its own messages; the newest is the new address.
    const t1 = rendezvousKeys(s1).topic
    expect(newestAddress(ntfy.topics.get(t1), { secret: s1, hostKey: hostKey.publicRaw })).toMatchObject({ url: URL_B, seq: 7 })
    expect(newestAddress(ntfy.topics.get(rendezvousKeys(s3).topic), { secret: s3, hostKey: hostKey.publicRaw })).toMatchObject({ url: URL_A })
    for (const line of logs) {
      expect(line).not.toContain('trycloudflare')
      expect(line).not.toContain(t1)
    }
    // Forgotten (the share stopped): said again from scratch.
    pub.forget()
    await pub.publish({ url: URL_B, hostKey, secrets: [s1], nextSeq })
    expect(ntfy.calls).toHaveLength(8)
  })
})
