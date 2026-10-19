// @vitest-environment node
// Live Share's rendezvous (liveShare/shareRendezvous.js): where a share says
// its address on the relay, sealed with a key from a secret and signed with
// the share's key, and how a guest reads it back (signed only, newest only,
// nothing older, replayed or far ahead, quick tunnels only). The relay is a
// fake fetch: nothing goes to ntfy.sh.
import { describe, it, expect, vi } from 'vitest'
import { rendezvousKeys, sealAddress, openAddress, newestAddress, withBase, isTunnelUrl, createRelay, createPublisher, RELAY_BASE, MAX_MESSAGE } from '../liveShare/shareRendezvous'
import { newSecret, newSigningKey } from '../liveShare/shareCrypto'

const URL_A = 'wss://first-words.trycloudflare.com/'
const URL_B = 'wss://other-words.trycloudflare.com/'

describe('rendezvous keys', () => {
  it('one topic and one key per secret (a TS1 code finds its topic too)', () => {
    const secret = newSecret()
    const a = rendezvousKeys(secret)
    const b = rendezvousKeys(Buffer.from(secret))
    expect(a.topic).toBe(b.topic)
    expect(a.key.equals(b.key)).toBe(true)
    expect(a.topic).toMatch(/^[a-z2-7]{40}$/)
    const other = rendezvousKeys(newSecret())
    expect(other.topic).not.toBe(a.topic)
    expect(other.key.equals(a.key)).toBe(false)
    expect(rendezvousKeys(Buffer.alloc(8))).toBe(null)
  })
})

describe('a sealed and signed address', () => {
  it('opens with the secret and the share’s key; nothing readable on the relay', () => {
    const secret = newSecret()
    const hostKey = newSigningKey()
    const msg = sealAddress({ secret, url: URL_A, seq: 7, at: 1000, hostKey })
    expect(msg.topic).toBe(rendezvousKeys(secret).topic)
    expect(msg.text.length).toBeLessThan(MAX_MESSAGE)
    for (const clear of ['trycloudflare', 'first-words', Buffer.from(URL_A).toString('base64url'), secret.toString('base64url'), secret.toString('base64')]) expect(msg.text).not.toContain(clear)
    expect(openAddress(msg.text, { secret, hostKey: hostKey.publicRaw, now: () => 2000 })).toEqual({ url: URL_A, seq: 7, at: 1000 })
  })

  it('never taken on the seal alone: no key known, nothing (anyone with a code could seal one)', () => {
    const secret = newSecret()
    const { text } = sealAddress({ secret, url: URL_A, seq: 7, hostKey: newSigningKey() })
    expect(openAddress(text, { secret })).toBe(null)
    expect(openAddress(text, { secret, hostKey: null })).toBe(null)
    expect(newestAddress([text], { secret })).toBe(null)
  })

  it('refuses a wrong secret, another key’s signature, a tampered message, and junk', () => {
    const secret = newSecret()
    const hostKey = newSigningKey()
    const { text } = sealAddress({ secret, url: URL_A, seq: 1, hostKey })
    const key = hostKey.publicRaw
    expect(openAddress(text, { secret: newSecret(), hostKey: key })).toBe(null)
    expect(openAddress(text, { secret, hostKey: newSigningKey().publicRaw })).toBe(null)
    const forged = sealAddress({ secret, url: URL_B, seq: 2, hostKey: newSigningKey() }).text
    expect(openAddress(forged, { secret, hostKey: key })).toBe(null)
    const [p, body, sig] = text.split('.')
    const flipped = Buffer.from(body, 'base64url')
    flipped[20] ^= 1
    expect(openAddress(`${p}.${flipped.toString('base64url')}.${sig}`, { secret, hostKey: key })).toBe(null)
    for (const junk of ['', 'r1', 'r1.x.y', 'r2.' + body + '.' + sig, text + '.x', 'r1.' + 'A'.repeat(MAX_MESSAGE) + '.' + sig, null, 42]) expect(openAddress(junk, { secret, hostKey: key })).toBe(null)
  })

  it('takes only a quick tunnel’s address (wss://<words>.trycloudflare.com/)', () => {
    expect(isTunnelUrl(URL_A)).toBe(true)
    expect(isTunnelUrl('wss://first-words.trycloudflare.com')).toBe(true)
    for (const url of ['ws://first-words.trycloudflare.com/', 'wss://192.168.1.4/', 'ws://127.0.0.1:4000/', 'wss://evil.example/', 'wss://trycloudflare.com.evil.example/', 'wss://a.trycloudflare.com:8443/', 'wss://a.trycloudflare.com/i/abcdefghijklmnop']) expect(isTunnelUrl(url)).toBe(false)
    const secret = newSecret()
    const hostKey = newSigningKey()
    // Signed by the host, but a LAN address: refused (tests can allow theirs).
    const lan = sealAddress({ secret, url: 'ws://192.168.1.4:4000/', seq: 1, hostKey }).text
    expect(openAddress(lan, { secret, hostKey: hostKey.publicRaw })).toBe(null)
    expect(openAddress(lan, { secret, hostKey: hostKey.publicRaw, urlOk: () => true })).toMatchObject({ url: 'ws://192.168.1.4:4000/' })
  })

  it('a message dated or counted more than a day ahead is refused (a counter at the end of the line would blind the guest)', () => {
    const secret = newSecret()
    const hostKey = newSigningKey()
    const now = () => 1_000_000_000_000
    const ahead = sealAddress({ secret, url: URL_A, seq: 1, at: now() + 2 * 24 * 3600 * 1000, hostKey }).text
    expect(openAddress(ahead, { secret, hostKey: hostKey.publicRaw, now })).toBe(null)
    const blinding = sealAddress({ secret, url: URL_A, seq: Number.MAX_SAFE_INTEGER, at: now(), hostKey }).text
    expect(openAddress(blinding, { secret, hostKey: hostKey.publicRaw, now })).toBe(null)
    const fine = sealAddress({ secret, url: URL_A, seq: now() + 1000, at: now(), hostKey }).text
    expect(openAddress(fine, { secret, hostKey: hostKey.publicRaw, now })).toMatchObject({ seq: now() + 1000 })
  })

  it('a signed "stopped" says the host stopped sharing', () => {
    const secret = newSecret()
    const hostKey = newSigningKey()
    const { text } = sealAddress({ secret, stopped: true, seq: 9, at: 5, hostKey })
    expect(openAddress(text, { secret, hostKey: hostKey.publicRaw })).toEqual({ stopped: true, seq: 9, at: 5 })
    const older = sealAddress({ secret, url: URL_A, seq: 8, hostKey }).text
    expect(newestAddress([text, older], { secret, hostKey: hostKey.publicRaw })).toMatchObject({ stopped: true })
  })
})

describe('the newest address', () => {
  it('takes the highest counter, and nothing at or below the last one taken (replayed or older)', () => {
    const secret = newSecret()
    const hostKey = newSigningKey()
    const key = hostKey.publicRaw
    const seal = (url, seq) => sealAddress({ secret, url, seq, hostKey }).text
    const texts = [seal(URL_A, 10), seal(URL_B, 30), seal(URL_A, 20), 'junk']
    expect(newestAddress(texts, { secret, hostKey: key })).toMatchObject({ url: URL_B, seq: 30 })
    expect(newestAddress(texts, { secret, hostKey: key, after: 30 })).toBe(null)
    expect(newestAddress([seal(URL_A, 20)], { secret, hostKey: key, after: 25 })).toBe(null)
    const forged = sealAddress({ secret, url: 'wss://evil-words.trycloudflare.com/', seq: 99, hostKey: newSigningKey() }).text
    expect(newestAddress([...texts, forged], { secret, hostKey: key })).toMatchObject({ url: URL_B, seq: 30 })
  })

  it('the guest keeps its invitation’s path on the new address', () => {
    expect(withBase(URL_B, 'wss://first-words.trycloudflare.com/i/abcdefghijklmnop')).toBe('wss://other-words.trycloudflare.com/i/abcdefghijklmnop')
    expect(withBase(URL_B, 'wss://first-words.trycloudflare.com/')).toBe(URL_B)
    expect(withBase('ws://127.0.0.1:9/', 'ws://127.0.0.1:8/i/abcdefghijklmnop')).toBe('ws://127.0.0.1:9/i/abcdefghijklmnop')
    expect(withBase('ws://evil.example/', URL_A)).toBe(null)
    expect(withBase(URL_B, 'wss://a.example/other/path')).toBe(null)
  })
})

// A fetch that answers like ntfy.sh: POST keeps a message, GET .../json?poll=1
// gives them back as lines of JSON. status(topic): what a POST answers.
function fakeNtfy({ status = () => 200 } = {}) {
  const topics = new Map()
  const calls = []
  const fetchImpl = vi.fn(async (url, init = {}) => {
    calls.push([url, init])
    const u = new URL(url)
    if (u.origin !== RELAY_BASE) throw new Error('not the relay')
    const topic = u.pathname.split('/').filter(Boolean)[0]
    if (init.method === 'POST') {
      const code = status(topic)
      if (code === 200) {
        if (!topics.has(topic)) topics.set(topic, [])
        topics.get(topic).push(String(init.body))
      }
      return { ok: code === 200, status: code, headers: new Map(), text: async () => '{}' }
    }
    const lines = [JSON.stringify({ event: 'open', topic }), ...(topics.get(topic) || []).map((m, i) => JSON.stringify({ id: String(i), time: i, event: 'message', topic, message: m }))]
    return { ok: true, status: 200, headers: new Map(), text: async () => lines.join('\n') + '\n' }
  })
  return { topics, calls, fetchImpl }
}
const answer = (text) => async () => ({ ok: true, status: 200, headers: new Map(), text: async () => text })
const line = (topic, message) => JSON.stringify({ event: 'message', topic, message })

describe('the relay (ntfy.sh)', () => {
  it('publishes to its fixed https address and reads back the r1 messages of a topic only', async () => {
    const ntfy = fakeNtfy()
    const relay = createRelay({ fetchImpl: ntfy.fetchImpl })
    const secret = newSecret()
    const { topic, text } = sealAddress({ secret, url: URL_A, seq: 1, hostKey: newSigningKey() })
    expect(await relay.publish(topic, text)).toEqual({ ok: true, limited: false })
    const [url, init] = ntfy.calls[0]
    expect(url).toBe(`https://ntfy.sh/${topic}`)
    expect(init).toMatchObject({ method: 'POST', body: text, redirect: 'error' })
    expect(init.headers['X-Firebase']).toBe('no')
    expect(await relay.latest(topic)).toEqual([text])
    expect(ntfy.calls[1][0]).toBe(`https://ntfy.sh/${topic}/json?poll=1&since=all`)
    expect(await relay.publish('../x', text)).toEqual({ ok: false, limited: false })
    expect(await relay.publish(topic, 'x'.repeat(MAX_MESSAGE + 1))).toEqual({ ok: false, limited: false })
    expect(await relay.latest('Not-Ours')).toEqual([])
    expect(ntfy.calls).toHaveLength(2)
  })

  it('says when the relay refused for its rate limit', async () => {
    const relay = createRelay({ fetchImpl: fakeNtfy({ status: () => 429 }).fetchImpl })
    const { topic, text } = sealAddress({ secret: newSecret(), url: URL_A, seq: 1, hostKey: newSigningKey() })
    expect(await relay.publish(topic, text)).toEqual({ ok: false, limited: true })
  })

  it('a flood can’t hide the host’s message: oversized and odd lines skipped, the newest 2 MB kept', async () => {
    const secret = newSecret()
    const hostKey = newSigningKey()
    const { topic, text } = sealAddress({ secret, url: URL_B, seq: 50, hostKey })
    const big = 'r1.' + 'A'.repeat(4000) + '.' + 'B'.repeat(86)
    const small = sealAddress({ secret, url: URL_A, seq: 10, hostKey: newSigningKey() }).text
    // 60 large messages before it, 300 small ones after it.
    const lines = [...Array.from({ length: 60 }, () => line(topic, big)), line(topic, text), ...Array.from({ length: 300 }, () => line(topic, small)), 'not json', line('zz', text)]
    const relay = createRelay({ fetchImpl: answer(lines.join('\n')) })
    const texts = await relay.latest(topic)
    expect(texts).toContain(text)
    expect(texts).not.toContain(big)
    expect(newestAddress(texts, { secret, hostKey: hostKey.publicRaw })).toMatchObject({ url: URL_B, seq: 50 })
    // More than 2 MB: the oldest goes, the newest stays.
    const filler = Array.from({ length: 12000 }, () => line(topic, small))
    const huge = createRelay({ fetchImpl: answer([...filler, line(topic, text)].join('\n')) })
    expect(await huge.latest(topic)).toContain(text)
  })

  it('a relay that fails, hangs, or hangs while sending its answer gives nothing (and never throws)', async () => {
    const topic = rendezvousKeys(newSecret()).topic
    const failing = createRelay({ fetchImpl: async () => ({ ok: false, status: 500, headers: new Map() }) })
    expect(await failing.latest(topic)).toEqual([])
    const throwing = createRelay({ fetchImpl: async () => Promise.reject(new Error('offline')) })
    expect(await throwing.latest(topic)).toEqual([])
    const hanging = createRelay({ timeoutMs: 50, fetchImpl: (url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))) })
    expect(await hanging.latest(topic)).toEqual([])
    // Headers at once, the body never: the timeout covers it too.
    let aborted = false
    const slowBody = createRelay({
      timeoutMs: 50,
      fetchImpl: async (url, init) => {
        init.signal.addEventListener('abort', () => (aborted = true))
        return { ok: true, status: 200, headers: new Map(), text: () => new Promise(() => {}) }
      }
    })
    const t0 = Date.now()
    expect(await slowBody.latest(topic)).toEqual([])
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(aborted).toBe(true)
  })
})

describe('the host’s publisher', () => {
  const opts = (url, secrets, hostKey, extra = {}) => {
    let seq = 0
    return { url, hostKey, secrets, nextSeq: () => ++seq, ...extra }
  }

  it('says the address on each topic once, a new topic as it comes, all again on refresh; one topic a gap apart; nothing in its log', async () => {
    const ntfy = fakeNtfy()
    const logs = []
    const pub = createPublisher({ relay: createRelay({ fetchImpl: ntfy.fetchImpl }), log: (l) => logs.push(l), gapMs: 30, minGapMs: 0 })
    const hostKey = newSigningKey()
    const [s1, s2, s3] = [newSecret(), newSecret(), newSecret()]
    const t0 = Date.now()
    await pub.publish(opts(URL_A, [s1, s2, s1], hostKey))
    expect(ntfy.calls).toHaveLength(2)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25)
    await pub.publish(opts(URL_A, [s1, s2], hostKey))
    expect(ntfy.calls).toHaveLength(2)
    await pub.publish(opts(URL_A, [s1, s2, s3], hostKey))
    expect(ntfy.calls).toHaveLength(3)
    await pub.publish(opts(URL_A, [s1, s2, s3], hostKey, { refresh: true }))
    expect(ntfy.calls).toHaveLength(6)
    const t1 = rendezvousKeys(s1).topic
    for (const l of logs) {
      expect(l).not.toContain('trycloudflare')
      expect(l).not.toContain(t1)
    }
    expect(pub.said(URL_A).sort()).toEqual([s1, s2, s3].map((s) => rendezvousKeys(s).topic).sort())
  })

  it('a new address at most once every few minutes (the latest then)', async () => {
    const ntfy = fakeNtfy()
    const pub = createPublisher({ relay: createRelay({ fetchImpl: ntfy.fetchImpl }), gapMs: 0, minGapMs: 200 })
    const hostKey = newSigningKey()
    const s1 = newSecret()
    await pub.publish(opts(URL_A, [s1], hostKey))
    expect(ntfy.calls).toHaveLength(1)
    // Two moves in a row: nothing now, the latest one later.
    await pub.publish(opts(URL_B, [s1], hostKey))
    await pub.publish(opts('wss://third-words.trycloudflare.com/', [s1], hostKey))
    expect(ntfy.calls).toHaveLength(1)
    await vi.waitFor(() => expect(ntfy.calls).toHaveLength(2), { timeout: 2000 })
    expect(pub.saidAt(rendezvousKeys(s1).topic)).toBe('wss://third-words.trycloudflare.com/')
  })

  it('topics the relay refused are tried again later, with counts logged', async () => {
    let refuse = true
    const ntfy = fakeNtfy({ status: () => (refuse ? 429 : 200) })
    const logs = []
    const pub = createPublisher({ relay: createRelay({ fetchImpl: ntfy.fetchImpl }), log: (l) => logs.push(l), gapMs: 0, minGapMs: 0, retryDelays: [100, 100, 100] })
    const s1 = newSecret()
    await pub.publish(opts(URL_A, [s1], newSigningKey()))
    expect(logs.at(-1)).toMatch(/1 refused by the relay \(1 for its rate limit\)/)
    refuse = false
    await vi.waitFor(() => expect(pub.saidAt(rendezvousKeys(s1).topic)).toBe(URL_A), { timeout: 2000 })
  })

  it('stop: "stopped" on every topic, nothing else said after it; forget: everything said is forgotten', async () => {
    const ntfy = fakeNtfy()
    const pub = createPublisher({ relay: createRelay({ fetchImpl: ntfy.fetchImpl }), gapMs: 0, minGapMs: 0 })
    const hostKey = newSigningKey()
    const s1 = newSecret()
    await pub.publish(opts(URL_A, [s1], hostKey))
    await pub.stop(opts(null, [s1], hostKey, { nextSeq: () => 100 }))
    const t1 = rendezvousKeys(s1).topic
    expect(newestAddress(ntfy.topics.get(t1), { secret: s1, hostKey: hostKey.publicRaw })).toMatchObject({ stopped: true })
    pub.forget()
    expect(pub.saidAt(t1)).toBe(null)
    // seed: said already (a restart at the same address).
    pub.seed(URL_A, [t1])
    const before = ntfy.calls.length
    await pub.publish(opts(URL_A, [s1], hostKey))
    expect(ntfy.calls).toHaveLength(before)
  })

  it('never says an address that is not a quick tunnel’s (unless told to)', async () => {
    const ntfy = fakeNtfy()
    const pub = createPublisher({ relay: createRelay({ fetchImpl: ntfy.fetchImpl }), gapMs: 0 })
    await pub.publish(opts('ws://127.0.0.1:4000/', [newSecret()], newSigningKey()))
    expect(ntfy.calls).toHaveLength(0)
  })
})
