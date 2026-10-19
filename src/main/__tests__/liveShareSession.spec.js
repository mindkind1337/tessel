import { describe, it, expect, afterEach, vi } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { createShareHost, cleanName, stripTerminalReplies, INVITE_TTL_MS, addressKey, SHARE_PROTOCOL } from '../liveShare/shareHost'
import { createShareGuest as makeGuest } from '../liveShare/shareGuest'
import { newSecret, newNonce, newKeyPair, commitment, newSigningKey, sharedSecret, createChannel, sessionKeys } from '../liveShare/shareCrypto'
import { NO_RIGHTS } from '../../shared/liveShareRights'
import { OFFLINE_KEEP_MS } from '../liveShare/shareAccess'

// A guest connection: its reconnect key made here unless given.
const createShareGuest = (opts) => makeGuest({ signingKey: newSigningKey(), ...opts })
// The host key the last guest let in got (a returning guest checks it).
let lastHostKey = null

const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = fn()
    if (v) return v
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('timed out')
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function fakeTessel({ approve = true } = {}) {
  const t = {
    panes: [{ id: 'p1', title: 'Claude Code', kind: 'agent', cols: 100, rows: 30 }],
    writes: [],
    opened: [],
    closed: [],
    guestLists: [],
    asked: [],
    callbacks: {
      // One project shared, with these panes.
      projects: () => [{ id: 'ws-1', layout: null, panes: t.panes }],
      snapshot: async (id) => ({ data: `screen of ${id}`, cols: 100, rows: 30 }),
      write: (id, data) => t.writes.push([id, data]),
      openPane: (spec) => t.opened.push(spec),
      closePane: (id) => t.closed.push(id),
      agents: () => [{ id: 'codex', name: 'Codex' }],
      askApproval: async (g) => {
        t.asked.push(g)
        return typeof approve === 'function' ? approve(g) : approve
      },
      onGuests: (list) => t.guestLists.push(list)
    }
  }
  return t
}

function guestRecorder() {
  const r = { states: [], info: [], projects: null, panes: null, screens: {}, exits: {}, closed: null, rights: [], notices: [], order: [] }
  r.callbacks = {
    onState: (s, info) => {
      r.states.push(s)
      r.info.push(info || null)
    },
    onProjects: (projects) => {
      r.projects = projects
      r.panes = projects.flatMap((p) => p.panes)
    },
    onSnapshot: (id, data) => {
      r.screens[id] = data
      r.order.push(['snapshot', id, data])
    },
    onData: (id, data) => {
      r.screens[id] = (r.screens[id] || '') + data
      r.order.push(['data', id, data])
    },
    onExit: (id, code) => {
      r.exits[id] = code
      r.order.push(['exit', id, code])
    },
    onRights: (rights) => r.rights.push(rights),
    onHostKey: (key) => {
      r.hostKey = key
      lastHostKey = key
    },
    onNotice: (code) => r.notices.push(code),
    onRestart: (id) => r.order.push(['restart', id]),
    onClosed: (reason) => (r.closed = reason)
  }
  return r
}

// A connection that goes as far as the host's keys, then stops (what someone
// in the middle trying codes would do).
function stopAfterKeys(port) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`)
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString())
      if (msg.t === 'hello') ws.send(JSON.stringify({ t: 'commit', c: commitment(newNonce(), newKeyPair().publicRaw).toString('base64') }))
      else if (msg.t === 'keys') ws.close()
    })
    ws.on('close', () => setTimeout(resolve, 20))
    ws.on('error', () => resolve())
  })
}

const ALL = { ...NO_RIGHTS, type: true, open: true, close: true }
// The share's one invitation (a share made with one secret: a root one).
const firstInvite = (h) => h.invites()[0]
const isBlocked = (h) => firstInvite(h).state === 'blocked'
const rotate = (h, secret) => h.rotateInvite(firstInvite(h).id, { secret })

describe('Live Share session', () => {
  let host
  afterEach(() => host?.stop())

  async function joinOne({ t = fakeTessel(), secret = newSecret(), name = 'Alex', now, hostKey } = {}) {
    host = createShareHost({ secret, hostName: 'Cedric', callbacks: t.callbacks, ...(now ? { now } : {}), ...(hostKey ? { hostKey } : {}) })
    const port = await host.start()
    const r = guestRecorder()
    const key = newSigningKey()
    const guest = createShareGuest({ url: `ws://127.0.0.1:${port}/`, secret, name, signingKey: key, callbacks: r.callbacks })
    guest.connect()
    return { t, r, guest, port, secret, key }
  }
  const comeBack = (port, secret, key, extra = {}) => {
    const back = guestRecorder()
    createShareGuest({ url: `ws://127.0.0.1:${port}/`, secret, name: 'Alex', signingKey: key, back: true, hostKey: lastHostKey, callbacks: back.callbacks, ...extra }).connect()
    return back
  }

  it('lets a guest with the invite in to watch, and takes its typing once the host allows it', async () => {
    const { t, r, guest } = await joinOne({ name: 'Alex\u0007' })
    await until(() => r.screens.p1 === 'screen of p1')
    expect(t.asked.map((g) => g.name)).toEqual(['Alex'])
    expect(r.states).toEqual(['connecting', 'waiting', 'joined'])
    expect(r.panes.map((p) => p.id)).toEqual(['p1'])
    // It starts view only, and knows it.
    expect(r.rights).toEqual([{ ...NO_RIGHTS, type: false, open: false, close: false }])

    host.sendData('p1', '\r\nhello')
    await until(() => r.screens.p1.endsWith('hello'))

    // Not allowed yet: nothing typed, opened or closed.
    guest.write('p1', 'whoami\r')
    guest.open({ kind: 'terminal', project: 'ws-1' })
    guest.close('p1')
    await wait(60)
    expect(t.writes).toEqual([])
    expect(t.opened).toEqual([])
    expect(t.closed).toEqual([])

    const [g] = host.guests()
    expect(host.setGrant(g.id, { rights: { type: true, open: true, extra: 'x' } })).toBe(true)
    await until(() => r.rights.length === 2)
    expect(r.rights[1]).toEqual({ ...NO_RIGHTS, type: true, open: true, close: false })
    expect(host.guests()[0].rights).toEqual({ ...NO_RIGHTS, type: true, open: true, close: false })

    guest.write('p1', 'ls\r')
    guest.write('nope', 'rm -rf /\r') // not a shared pane
    guest.open({ kind: 'agent', agent: 'codex', project: 'ws-1' })
    guest.open({ kind: 'terminal', project: 'ws-other' }) // not a project it sees
    guest.open({ kind: 'terminal' }) // in no project
    guest.close('p1') // still not allowed
    await until(() => t.opened.length === 1)
    await wait(30)
    expect(t.writes).toEqual([['p1', 'ls\r']])
    expect(t.opened).toEqual([{ kind: 'agent', agent: 'codex', project: 'ws-1' }])
    expect(t.closed).toEqual([])

    t.panes = [...t.panes, { id: 'p2', title: 'PowerShell', kind: 'terminal', cols: 80, rows: 24 }]
    host.panesChanged()
    await until(() => r.screens.p2 === 'screen of p2')
    expect(host.guests().map((x) => [x.name, x.state])).toEqual([['Alex', 'joined']])

    host.sendExit('p2', 0)
    await until(() => r.exits.p2 === 0)
    guest.leave()
    await until(() => host.guests().length === 0)
  })

  it('both sides show the same verification code', async () => {
    const { t, r } = await joinOne()
    await until(() => r.states.includes('joined'))
    const waiting = r.info[r.states.indexOf('waiting')]
    expect(waiting.code).toMatch(/^\d{3} \d{3}$/)
    expect(t.asked[0].code).toBe(waiting.code)
  })

  it('a guest that does not reveal what it committed to is dropped', async () => {
    const t = fakeTessel()
    host = createShareHost({ secret: newSecret(), hostName: 'Cedric', callbacks: t.callbacks })
    const port = await host.start()
    const closed = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/`)
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.t === 'hello') ws.send(JSON.stringify({ t: 'commit', c: commitment(newNonce(), newKeyPair().publicRaw).toString('base64') }))
        else if (msg.t === 'keys') ws.send(JSON.stringify({ t: 'reveal', n: newNonce().toString('base64'), kx: newKeyPair().publicRaw.toString('base64') }))
      })
      ws.on('close', () => resolve(true))
    })
    expect(closed).toBe(true)
    expect(t.asked).toEqual([])
  })

  it('connections that stop after the handshake block the code until a new one', async () => {
    const t = fakeTessel()
    let blocked = 0
    t.callbacks.onInviteBlocked = () => blocked++
    const secret = newSecret()
    host = createShareHost({ secret, hostName: 'Cedric', callbacks: t.callbacks })
    const port = await host.start()
    for (let i = 0; i < 8; i++) await stopAfterKeys(port)
    await until(() => blocked === 1)
    expect(isBlocked(host)).toBe(true)
    const r = guestRecorder()
    createShareGuest({ url: `ws://127.0.0.1:${port}/`, secret, name: 'Alex', callbacks: r.callbacks }).connect()
    await until(() => r.closed)
    expect(r.closed).toBe('expired')
    // A new code lets guests in again.
    const fresh = newSecret()
    rotate(host, fresh)
    expect(isBlocked(host)).toBe(false)
    const r2 = guestRecorder()
    createShareGuest({ url: `ws://127.0.0.1:${port}/`, secret: fresh, name: 'Alex', callbacks: r2.callbacks }).connect()
    await until(() => r2.states.includes('joined'))
  })

  it('drops what a guest terminal answers by itself, keeps what is typed', async () => {
    expect(stripTerminalReplies('\x1b[12;40R')).toBe('')
    expect(stripTerminalReplies('\x1b[?1;2c\x1b[>0;276;0c\x1b[0n')).toBe('')
    expect(stripTerminalReplies('\x1b]11;rgb:1e1e/1e1e/1e1e\x07\x1b]10;rgb:ffff/ffff/ffff\x1b\\')).toBe('')
    expect(stripTerminalReplies('\x1bP>|xterm.js(5.5.0)\x1b\\\x1b[?2004;1$y\x1b[I\x1b[O')).toBe('')
    expect(stripTerminalReplies('ls\r\x1b[A\x1b[1;5C\x1b[200~pasted\x1b[201~')).toBe('ls\r\x1b[A\x1b[1;5C\x1b[200~pasted\x1b[201~')
    expect(stripTerminalReplies('git st\x1b[3;7Ratus\r')).toBe('git status\r')

    const { t, r, guest } = await joinOne()
    await until(() => r.states.includes('joined'))
    host.setGrant(host.guests()[0].id, { rights: ALL })
    await until(() => r.rights.length === 2)
    guest.write('p1', '\x1b[5;1R')
    guest.write('p1', 'echo hi\r\x1b[?1;2c')
    await until(() => t.writes.length)
    await wait(30)
    expect(t.writes).toEqual([['p1', 'echo hi\r']])
  })

  it('limits how often a guest opens terminals', async () => {
    const { t, r, guest } = await joinOne()
    await until(() => r.states.includes('joined'))
    host.setGrant(host.guests()[0].id, { rights: ALL })
    await until(() => r.rights.length === 2)
    for (let i = 0; i < 5; i++) guest.open({ kind: 'terminal', project: 'ws-1' })
    await until(() => r.notices.length >= 2)
    expect(t.opened).toHaveLength(3)
    expect(r.notices[0]).toBe('limit')
  })

  it('drops a guest without the right secret before it reaches the host', async () => {
    const t = fakeTessel()
    host = createShareHost({ secret: newSecret(), hostName: 'Cedric', callbacks: t.callbacks })
    const port = await host.start()
    const r = guestRecorder()
    createShareGuest({ url: `ws://127.0.0.1:${port}/`, secret: newSecret(), name: 'Mallory', callbacks: r.callbacks }).connect()
    await until(() => r.closed)
    expect(t.asked).toEqual([])
    expect(r.panes).toBe(null)
  })

  it('tells a guest the host said no, and makes the next one wait', async () => {
    const secret = newSecret()
    const t = fakeTessel({ approve: false })
    host = createShareHost({ secret, hostName: 'Cedric', callbacks: t.callbacks })
    const port = await host.start()
    const r = guestRecorder()
    createShareGuest({ url: `ws://127.0.0.1:${port}/`, secret, name: 'Bob', callbacks: r.callbacks }).connect()
    await until(() => r.closed)
    expect(r.closed).toBe('denied')
    expect(r.panes).toBe(null)
    // Right after a no, a new guest is turned away without asking the host.
    const again = guestRecorder()
    createShareGuest({ url: `ws://127.0.0.1:${port}/`, secret, name: 'Bob', callbacks: again.callbacks }).connect()
    await until(() => again.closed)
    expect(again.closed).toBe('busy')
    expect(t.asked).toHaveLength(1)
  })

  it('a new invite code: the old one stops working, guests already in stay', async () => {
    const { t, r, port, secret } = await joinOne()
    await until(() => r.states.includes('joined'))
    rotate(host, newSecret())
    const late = guestRecorder()
    createShareGuest({ url: `ws://127.0.0.1:${port}/`, secret, name: 'Late', callbacks: late.callbacks }).connect()
    await until(() => late.closed)
    expect(late.closed).toBe('expired')
    expect(host.guests().map((g) => g.name)).toEqual(['Alex'])
    host.sendData('p1', 'still here')
    await until(() => r.screens.p1.endsWith('still here'))
    expect(t.asked).toHaveLength(1)
  })

  it('an invite code expires after an hour', async () => {
    let clock = 1000
    const secret = newSecret()
    const t = fakeTessel()
    host = createShareHost({ secret, hostName: 'Cedric', callbacks: t.callbacks, now: () => clock })
    const port = await host.start()
    expect(firstInvite(host).expiresAt).toBe(1000 + INVITE_TTL_MS)
    clock += INVITE_TTL_MS + 1
    const r = guestRecorder()
    createShareGuest({ url: `ws://127.0.0.1:${port}/`, secret, name: 'Late', callbacks: r.callbacks }).connect()
    await until(() => r.closed)
    expect(r.closed).toBe('expired')
    expect(t.asked).toEqual([])
  })

  it('refuses a web page (an Origin header)', async () => {
    const t = fakeTessel()
    host = createShareHost({ secret: newSecret(), hostName: 'Cedric', callbacks: t.callbacks })
    const port = await host.start()
    const result = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { origin: 'https://evil.example' })
      ws.on('open', () => resolve('open'))
      ws.on('error', () => resolve('refused'))
    })
    expect(result).toBe('refused')
  })

  it('tells a Tessel with the first protocol it is out of date, both ways', async () => {
    const t = fakeTessel()
    host = createShareHost({ secret: newSecret(), hostName: 'Cedric', callbacks: t.callbacks })
    const port = await host.start()
    // An older guest sends its nonce right away.
    const code = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/`)
      ws.on('message', () => ws.send(JSON.stringify({ t: 'nonce', n: newNonce().toString('base64') })))
      ws.on('close', (c) => resolve(c))
    })
    expect(code).toBe(4003)
    expect(t.asked).toEqual([])
    // An older host puts its nonce in its hello.
    const old = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise((r) => old.once('listening', r))
    old.on('connection', (ws) => ws.send(JSON.stringify({ t: 'hello', app: 'tessel-liveshare', v: 1, n: newNonce().toString('base64') })))
    const r = guestRecorder()
    createShareGuest({ url: `ws://127.0.0.1:${old.address().port}/`, secret: newSecret(), name: 'Alex', callbacks: r.callbacks }).connect()
    await until(() => r.closed)
    expect(r.closed).toBe('outdated-host')
    old.close()
  })

  it('a guest let in comes back with its key: in at once, with its rights, no question', async () => {
    const { t, r, port, secret, key } = await joinOne()
    await until(() => r.states.includes('joined'))
    host.setGrant(host.guests()[0].id, { rights: { ...NO_RIGHTS, type: true, open: false, close: false } })
    await until(() => r.rights.length === 2)
    // Its connection drops; it comes back, signing the new connection.
    const back = comeBack(port, secret, key)
    await until(() => back.states.includes('joined'))
    expect(t.asked).toHaveLength(1)
    expect(back.rights[0]).toEqual({ ...NO_RIGHTS, type: true, open: false, close: false })
    // Its old connection is replaced.
    await until(() => r.closed)
    expect(r.closed).toBe('replaced')
    expect(host.guests().map((g) => g.state)).toEqual(['joined'])
  })

  it('someone with the guest public key but not its private key can not come back as it', async () => {
    const { t, r, port, secret, key } = await joinOne()
    await until(() => r.states.includes('joined'))
    // The public half is public; a signature must come from the private one.
    const forged = { publicRaw: key.publicRaw, privateKey: newSigningKey().privateKey }
    const intruder = comeBack(port, secret, forged)
    await until(() => intruder.closed)
    expect(intruder.closed).toBe('rejoin-refused')
    expect(r.closed).toBe(null)
    expect(t.asked).toHaveLength(1)
  })

  it('an unknown key is turned away without a question, and a guest who left can not come back', async () => {
    const { t, r, guest, port, secret, key } = await joinOne()
    await until(() => r.states.includes('joined'))
    const stranger = comeBack(port, secret, newSigningKey())
    await until(() => stranger.closed)
    expect(stranger.closed).toBe('rejoin-refused')
    guest.leave()
    await until(() => host.guests().length === 0)
    const again = comeBack(port, secret, key)
    await until(() => again.closed)
    expect(again.closed).toBe('rejoin-refused')
    expect(t.asked).toHaveLength(1)
  })

  it('the guests let in carry over to the next Tessel (a restart), and an expired code still lets them back', async () => {
    let clock = 1000
    const hostKey = newSigningKey()
    const { r, secret, key } = await joinOne({ now: () => clock, hostKey })
    await until(() => r.states.includes('joined'))
    host.setGrant(host.guests()[0].id, { rights: { ...NO_RIGHTS, type: true, open: true, close: true } })
    const saved = host.accessState()
    expect(saved.people).toEqual([expect.objectContaining({ key: key.publicRaw.toString('base64'), name: 'Alex', grant: { projects: ['ws-1'], rights: { ...NO_RIGHTS, type: true, open: true, close: true } }, opened: 0 })])
    host.stop('restarting')
    await until(() => r.closed)
    expect(r.closed).toBe('restarting')
    // The next Tessel, an hour and more later.
    clock += 2 * 60 * 60 * 1000
    const t2 = fakeTessel()
    host = createShareHost({ hostName: 'Cedric', callbacks: t2.callbacks, access: saved, now: () => clock, hostKey })
    const port = await host.start()
    const back = comeBack(port, secret, key)
    await until(() => back.states.includes('joined'))
    expect(back.rights[0]).toEqual({ ...NO_RIGHTS, type: true, open: true, close: true })
    expect(t2.asked).toEqual([])
    // A new guest with the expired code: turned away.
    const late = guestRecorder()
    createShareGuest({ url: `ws://127.0.0.1:${port}/`, secret, name: 'Late', callbacks: late.callbacks }).connect()
    await until(() => late.closed)
    expect(late.closed).toBe('expired')
  })

  it('a guest let in before a new code comes back with the secret it had', async () => {
    const { r, port, secret, key } = await joinOne()
    await until(() => r.states.includes('joined'))
    rotate(host, newSecret())
    // Its old code is kept for it (and the new one).
    expect(host.accessState().codes).toHaveLength(2)
    const back = comeBack(port, secret, key)
    await until(() => back.states.includes('joined'))
    // A new guest with that old secret: no.
    const late = guestRecorder()
    createShareGuest({ url: `ws://127.0.0.1:${port}/`, secret, name: 'Late', callbacks: late.callbacks }).connect()
    await until(() => late.closed)
    expect(late.closed).toBe('expired')
  })

  it('a guest let in comes back even while the code is blocked or new guests must wait', async () => {
    const { r, port, secret, key } = await joinOne()
    await until(() => r.states.includes('joined'))
    for (let i = 0; i < 8; i++) await stopAfterKeys(port)
    await until(() => isBlocked(host))
    const back = comeBack(port, secret, key)
    await until(() => back.states.includes('joined'))
  })

  it('every connection that got the host keys and never got in counts, whatever its way out', async () => {
    const t = fakeTessel()
    const secret = newSecret()
    host = createShareHost({ secret, hostName: 'Cedric', callbacks: t.callbacks })
    const port = await host.start()
    // Coming back with a key the host never let in, eight times.
    for (let i = 0; i < 8; i++) {
      const g = comeBack(port, secret, newSigningKey())
      await until(() => g.closed)
      expect(g.closed).toBe('rejoin-refused')
    }
    expect(isBlocked(host)).toBe(true)
    expect(t.asked).toEqual([])
  })

  it('what a guest may open or close a minute stays counted across its reconnects', async () => {
    const { t, r, port, secret, key, guest } = await joinOne()
    await until(() => r.states.includes('joined'))
    host.setGrant(host.guests()[0].id, { rights: { ...NO_RIGHTS, type: false, open: true, close: false } })
    await until(() => r.rights.length === 2)
    for (let i = 0; i < 3; i++) guest.open({ kind: 'terminal', project: 'ws-1' })
    await until(() => t.opened.length === 3)
    const back = comeBack(port, secret, key)
    await until(() => back.states.includes('joined'))
    // The same guest, a new connection: still at its limit.
    const conn = guestRecorder()
    const g2 = createShareGuest({ url: `ws://127.0.0.1:${port}/`, secret, name: 'Alex', signingKey: key, back: true, hostKey: lastHostKey, callbacks: conn.callbacks })
    g2.connect()
    await until(() => conn.states.includes('joined'))
    g2.open({ kind: 'terminal', project: 'ws-1' })
    await until(() => conn.notices.length)
    expect(conn.notices[0]).toBe('limit')
    expect(t.opened).toHaveLength(3)
  })

  it('a returning guest checks it is the same host (someone posing as it is not trusted)', async () => {
    const { r, secret, key } = await joinOne()
    await until(() => r.states.includes('joined'))
    // Another share server with the same secret and the guests it let in,
    // but not the host's key (someone in the middle posing as the host).
    const t2 = fakeTessel()
    const fake = createShareHost({ hostName: 'Cedric', callbacks: t2.callbacks, access: host.accessState() })
    const fakePort = await fake.start()
    const back = comeBack(fakePort, secret, key)
    await until(() => back.closed)
    expect(back.closed).toBe('host-unverified')
    expect(back.states).not.toContain('joined')
    fake.stop()
  })

  it('a new guest must hold its key, and a key already known is refused', async () => {
    const { t, r, port, secret, key } = await joinOne()
    await until(() => r.states.includes('joined'))
    // The same public key again, as a new guest.
    const twin = guestRecorder()
    createShareGuest({ url: `ws://127.0.0.1:${port}/`, secret, name: 'Mallory', signingKey: key, callbacks: twin.callbacks }).connect()
    await until(() => twin.closed)
    expect(twin.closed).toBe('protocol')
    // Someone else's public key, without its private half.
    const thief = guestRecorder()
    createShareGuest({ url: `ws://127.0.0.1:${port}/`, secret, name: 'Mallory', signingKey: { publicRaw: newSigningKey().publicRaw, privateKey: newSigningKey().privateKey }, callbacks: thief.callbacks }).connect()
    await until(() => thief.closed)
    expect(thief.closed).toBe('protocol')
    expect(t.asked).toHaveLength(1)
  })

  it('a guest let in comes back even after many new codes (the secret it needs is kept)', async () => {
    const { r, port, secret, key } = await joinOne()
    await until(() => r.states.includes('joined'))
    for (let i = 0; i < 12; i++) rotate(host, newSecret())
    const back = comeBack(port, secret, key)
    await until(() => back.states.includes('joined'))
  })

  it('a restart keeps what a guest opened in all, and the block', async () => {
    const hostKey = newSigningKey()
    const { r, secret, key } = await joinOne({ hostKey })
    await until(() => r.states.includes('joined'))
    host.setGrant(host.guests()[0].id, { rights: { ...NO_RIGHTS, type: false, open: true, close: false } })
    const saved = host.accessState()
    saved.people[0].opened = 12
    saved.invites[0].guard = { blocked: true, unfinished: [] }
    host.stop('restarting')
    const t2 = fakeTessel()
    host = createShareHost({ hostName: 'Cedric', callbacks: t2.callbacks, access: saved, hostKey })
    const port = await host.start()
    expect(isBlocked(host)).toBe(true)
    const back = comeBack(port, secret, key)
    await until(() => back.states.includes('joined'))
    // Its twelve opens are spent.
    const conn = guestRecorder()
    const g = createShareGuest({ url: `ws://127.0.0.1:${port}/`, secret, name: 'Alex', signingKey: key, back: true, hostKey: lastHostKey, callbacks: conn.callbacks })
    g.connect()
    await until(() => conn.states.includes('joined'))
    g.open({ kind: 'terminal', project: 'ws-1' })
    await until(() => conn.notices.length)
    expect(t2.opened).toEqual([])
    // New guests: the block holds.
    const late = guestRecorder()
    createShareGuest({ url: `ws://127.0.0.1:${port}/`, secret, name: 'Late', callbacks: late.callbacks }).connect()
    await until(() => late.closed)
    expect(late.closed).toBe('expired')
  })

  it('limits handshakes from one address', async () => {
    const t = fakeTessel()
    host = createShareHost({ secret: newSecret(), hostName: 'Cedric', callbacks: t.callbacks })
    const port = await host.start()
    for (let i = 0; i < 20; i++) await stopAfterKeys(port)
    const code = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/`)
      ws.on('close', (c) => resolve(c))
    })
    expect(code).toBe(4002)
  })

  it('forgets a guest offline for more than 30 days (a share is kept; its people come back whenever they can)', async () => {
    let clock = 1000
    const { r, guest } = await joinOne({ now: () => clock })
    await until(() => r.states.includes('joined'))
    guest.disconnect()
    await until(() => host.guests().length === 0)
    expect(host.offlineGuests().map((g) => g.name)).toEqual(['Alex'])
    // A night, a week away: still let in.
    clock += 7 * 24 * 60 * 60 * 1000
    expect(host.offlineGuests().map((g) => g.name)).toEqual(['Alex'])
    clock += OFFLINE_KEEP_MS
    expect(host.offlineGuests()).toEqual([])
    expect(host.accessState().people).toEqual([])
  })

  it('a port that is taken leaves no timer running', async () => {
    const busy = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise((res) => busy.once('listening', res))
    const made = new Set()
    const realSet = global.setInterval
    const realClear = global.clearInterval
    const setSpy = vi.spyOn(global, 'setInterval').mockImplementation((fn, ms, ...args) => {
      const id = realSet(fn, ms, ...args)
      made.add(id)
      return id
    })
    const clearSpy = vi.spyOn(global, 'clearInterval').mockImplementation((id) => {
      made.delete(id)
      return realClear(id)
    })
    try {
      const t = fakeTessel()
      host = createShareHost({ secret: newSecret(), hostName: 'Cedric', callbacks: t.callbacks })
      await expect(host.start(busy.address().port)).rejects.toThrow()
      await expect(host.start(busy.address().port)).rejects.toThrow()
      await host.start()
      host.stop()
      expect(made.size).toBe(0)
    } finally {
      setSpy.mockRestore()
      clearSpy.mockRestore()
      busy.close()
    }
  })

  it('a host with a newer protocol than this Tessel: this one is out of date', async () => {
    const newer = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise((res) => newer.once('listening', res))
    newer.on('connection', (ws) => ws.send(JSON.stringify({ t: 'hello', app: 'tessel-liveshare', v: SHARE_PROTOCOL + 1 })))
    const r = guestRecorder()
    createShareGuest({ url: `ws://127.0.0.1:${newer.address().port}/`, secret: newSecret(), name: 'Alex', callbacks: r.callbacks }).connect()
    await until(() => r.closed)
    expect(r.closed).toBe('outdated')
    newer.close()
  })

  it('a new code turns away guests still waiting under the old one', async () => {
    const t = fakeTessel({ approve: () => new Promise(() => {}) })
    const secret = newSecret()
    host = createShareHost({ secret, hostName: 'Cedric', callbacks: t.callbacks })
    const port = await host.start()
    const r = guestRecorder()
    createShareGuest({ url: `ws://127.0.0.1:${port}/`, secret, name: 'Leaked', callbacks: r.callbacks }).connect()
    await until(() => r.states.includes('waiting'))
    rotate(host, newSecret())
    await until(() => r.closed)
    expect(r.closed).toBe('expired')
    expect(host.guests()).toEqual([])
  })

  it('a guest leaving while waiting makes the next one wait, as after a no', async () => {
    const t = fakeTessel({ approve: () => new Promise(() => {}) })
    const secret = newSecret()
    host = createShareHost({ secret, hostName: 'Cedric', callbacks: t.callbacks })
    const port = await host.start()
    const r = guestRecorder()
    const g = createShareGuest({ url: `ws://127.0.0.1:${port}/`, secret, name: 'Pest', callbacks: r.callbacks })
    g.connect()
    await until(() => r.states.includes('waiting'))
    g.leave()
    await until(() => host.guests().length === 0)
    const next = guestRecorder()
    createShareGuest({ url: `ws://127.0.0.1:${port}/`, secret, name: 'Pest', callbacks: next.callbacks }).connect()
    await until(() => next.closed)
    expect(next.closed).toBe('busy')
  })

  it('a pane restarted on the host: guests are told, then get its new screen', async () => {
    const { r } = await joinOne()
    await until(() => r.screens.p1 === 'screen of p1')
    host.paneRestarted('p1')
    await until(() => r.order.filter((o) => o[0] === 'snapshot').length === 2)
    expect(r.order.slice(-2)).toEqual([
      ['restart', 'p1'],
      ['snapshot', 'p1', 'screen of p1']
    ])
  })

  it('a guest whose window reloaded gets the pane screen again', async () => {
    const { r, guest } = await joinOne()
    await until(() => r.screens.p1 === 'screen of p1')
    guest.resync('p1')
    await until(() => r.order.filter((o) => o[0] === 'snapshot').length === 2)
  })

  it('sends a screen that takes a moment first, then the output that came meanwhile', async () => {
    const t = fakeTessel()
    let finish
    t.callbacks.snapshot = (id, ready) => {
      ready({ data: new Promise((resolve) => (finish = resolve)), cols: 100, rows: 30 })
      return new Promise(() => {})
    }
    const { r } = await joinOne({ t })
    await until(() => finish)
    host.sendData('p1', 'after')
    host.sendExit('p1', 2)
    await wait(40)
    expect(r.order).toEqual([])
    finish('screen')
    await until(() => r.order.length === 3)
    expect(r.order).toEqual([
      ['snapshot', 'p1', 'screen'],
      ['data', 'p1', 'after'],
      ['exit', 'p1', 2]
    ])
  })

  it('a pane taken out of the shared project sends nothing more, at once', async () => {
    const { t, r } = await joinOne()
    await until(() => r.screens.p1 === 'screen of p1')
    // Output waiting to go out when the pane leaves: dropped.
    host.sendData('p1', 'QUEUED')
    t.panes = []
    // Output after it left, before the guests are told (panesChanged).
    host.sendData('p1', 'PRIVATE-AFTER-MOVE')
    host.sendExit('p1', 0)
    await wait(60)
    expect(r.screens.p1).toBe('screen of p1')
    expect(r.exits).toEqual({})
    // Back in the project: its screen again, then its output.
    t.panes = [{ id: 'p1', title: 'Claude Code', kind: 'agent', cols: 100, rows: 30 }]
    host.panesChanged()
    await wait(30)
    host.sendData('p1', 'back')
    await until(() => r.screens.p1 === 'screen of p1back')
  })

  it('a screen still being prepared when its pane leaves the project is not sent', async () => {
    const t = fakeTessel()
    let finish
    t.callbacks.snapshot = (id, ready) => {
      ready({ data: new Promise((resolve) => (finish = resolve)), cols: 100, rows: 30 })
      return new Promise(() => {})
    }
    const { r } = await joinOne({ t })
    await until(() => finish)
    host.sendData('p1', 'during')
    t.panes = []
    finish('PRIVATE-SCREEN')
    await wait(60)
    expect(r.order).toEqual([])
  })

  it('a pane that leaves and comes back while its first screen is prepared gets its new screen, in order', async () => {
    const t = fakeTessel()
    const finish = []
    t.callbacks.snapshot = (id, ready) => {
      ready({ data: new Promise((resolve) => finish.push(resolve)), cols: 100, rows: 30 })
      return new Promise(() => {})
    }
    const { r } = await joinOne({ t })
    await until(() => finish.length === 1)
    const shown = t.panes
    t.panes = []
    host.panesChanged()
    t.panes = shown
    host.panesChanged()
    await until(() => finish.length === 2)
    host.sendData('p1', 'LIVE')
    // The old screen comes back first: ignored, the new one still holds the output.
    finish[0]('OLD-SCREEN')
    await wait(40)
    expect(r.order).toEqual([])
    finish[1]('NEW-SCREEN')
    await until(() => r.order.length === 2)
    expect(r.order).toEqual([
      ['snapshot', 'p1', 'NEW-SCREEN'],
      ['data', 'p1', 'LIVE']
    ])
  })

  it('an old screen coming back after the new one changes nothing', async () => {
    const t = fakeTessel()
    const finish = []
    t.callbacks.snapshot = (id, ready) => {
      ready({ data: new Promise((resolve) => finish.push(resolve)), cols: 100, rows: 30 })
      return new Promise(() => {})
    }
    const { r } = await joinOne({ t })
    await until(() => finish.length === 1)
    const shown = t.panes
    t.panes = []
    host.panesChanged()
    t.panes = shown
    host.panesChanged()
    await until(() => finish.length === 2)
    finish[1]('NEW-SCREEN')
    await until(() => r.order.length === 1)
    finish[0]('OLD-SCREEN')
    host.sendData('p1', 'LIVE')
    await until(() => r.order.length === 2)
    await wait(30)
    expect(r.order).toEqual([
      ['snapshot', 'p1', 'NEW-SCREEN'],
      ['data', 'p1', 'LIVE']
    ])
  })

  it('a guest coming back over and over: 3 times a minute, then busy (the connection it had kept, the code not blocked), in again after its minute', async () => {
    let clock = 1000000
    const { t, r, port, secret, key } = await joinOne({ now: () => clock })
    await until(() => r.states.includes('joined'))
    let last = r
    for (let i = 0; i < 3; i++) {
      const back = comeBack(port, secret, key)
      await until(() => back.states.includes('joined'))
      await until(() => last.closed)
      expect(last.closed).toBe('replaced')
      last = back
    }
    for (let i = 0; i < 8; i++) {
      const again = comeBack(port, secret, key)
      await until(() => again.closed)
      expect(again.closed).toBe('busy')
      expect(again.states).not.toContain('joined')
    }
    expect(last.closed).toBe(null)
    expect(host.guests().map((g) => g.state)).toEqual(['joined'])
    expect(isBlocked(host)).toBe(false)
    expect(t.asked).toHaveLength(1)
    clock += 61000
    const later = comeBack(port, secret, key)
    await until(() => later.states.includes('joined'))
  })

  it('what a guest asks to see again (a pane screen) a minute stays counted across its reconnects', async () => {
    let clock = 1000000
    const { r, guest, port, secret, key } = await joinOne({ now: () => clock })
    await until(() => r.screens.p1 === 'screen of p1')
    const screens = (x) => x.order.filter((o) => o[0] === 'snapshot').length
    for (let i = 0; i < 30; i++) {
      guest.resync('p1')
      await until(() => screens(r) === i + 2)
    }
    guest.resync('p1')
    await wait(60)
    expect(screens(r)).toBe(31)
    // A new connection of the same guest: its screen with the welcome, and
    // no more asked again until its minute is over.
    const back = guestRecorder()
    const client = createShareGuest({ url: `ws://127.0.0.1:${port}/`, secret, name: 'Alex', signingKey: key, back: true, hostKey: lastHostKey, callbacks: back.callbacks })
    client.connect()
    await until(() => screens(back) === 1)
    client.resync('p1')
    await wait(60)
    expect(screens(back)).toBe(1)
    clock += 61000
    client.resync('p1')
    await until(() => screens(back) === 2)
  })

  it('one screen at a time per pane: guests coming back or joining while it is taken get that one, then the same output', async () => {
    const t = fakeTessel()
    const calls = []
    const answers = []
    t.callbacks.snapshot = (id) => {
      calls.push(id)
      return new Promise((resolve) => answers.push(resolve))
    }
    const { r, port, secret, key } = await joinOne({ t })
    await until(() => calls.length === 1)
    // In (the host's key known) before it comes back.
    await until(() => r.states.includes('joined'))
    // Back twice and a second guest in, while it is taken: nothing more asked
    // of the terminal host.
    const first = comeBack(port, secret, key)
    await until(() => first.states.includes('joined'))
    const second = comeBack(port, secret, key)
    await until(() => second.states.includes('joined'))
    const bea = guestRecorder()
    const beaClient = createShareGuest({ url: `ws://127.0.0.1:${port}/`, secret, name: 'Bea', callbacks: bea.callbacks })
    beaClient.connect()
    await until(() => bea.states.includes('joined'))
    await wait(40)
    expect(calls).toEqual(['p1'])
    answers[0]({ data: 'SCREEN', cols: 100, rows: 30 })
    await until(() => second.screens.p1 === 'SCREEN' && bea.screens.p1 === 'SCREEN')
    host.sendData('p1', '+live')
    await until(() => second.screens.p1 === 'SCREEN+live' && bea.screens.p1 === 'SCREEN+live')
    // The connections replaced got nothing.
    expect(r.screens.p1).toBeUndefined()
    expect(first.screens.p1).toBeUndefined()
    // Once it came, the next one needed is taken anew.
    beaClient.resync('p1')
    await until(() => calls.length === 2)
    answers[1]({ data: 'AGAIN', cols: 100, rows: 30 })
    await until(() => bea.screens.p1 === 'AGAIN')
    expect(second.screens.p1).toBe('SCREEN+live')
  })

  it('a pane restarted while its screen is taken: its new screen is taken anew, the old one goes to no one', async () => {
    const t = fakeTessel()
    const answers = []
    t.callbacks.snapshot = () => new Promise((resolve) => answers.push(resolve))
    const { r } = await joinOne({ t })
    await until(() => answers.length === 1)
    host.paneRestarted('p1')
    await until(() => answers.length === 2)
    answers[0]({ data: 'OLD-TERMINAL', cols: 100, rows: 30 })
    await wait(40)
    expect(r.screens.p1).toBeUndefined()
    answers[1]({ data: 'NEW-TERMINAL', cols: 100, rows: 30 })
    await until(() => r.screens.p1 === 'NEW-TERMINAL')
  })

  it('a goodbye with a word the host never says is read as a closed connection', async () => {
    for (const word of ['__proto__', 'constructor', 'toString', 'made-up']) {
      const { r } = await joinOne()
      await until(() => r.states.includes('joined'))
      host.stop(word)
      await until(() => r.closed)
      expect(r.closed).toBe('closed')
    }
    const { r } = await joinOne()
    await until(() => r.states.includes('joined'))
    host.stop('tunnel')
    await until(() => r.closed)
    expect(r.closed).toBe('tunnel')
  })

  it('removes a guest and ends everything when sharing stops', async () => {
    const secret = newSecret()
    const t = fakeTessel()
    host = createShareHost({ secret, hostName: 'Cedric', callbacks: t.callbacks })
    const port = await host.start()
    const a = guestRecorder()
    const b = guestRecorder()
    createShareGuest({ url: `ws://127.0.0.1:${port}/`, secret, name: 'A', callbacks: a.callbacks }).connect()
    createShareGuest({ url: `ws://127.0.0.1:${port}/`, secret, name: 'B', callbacks: b.callbacks }).connect()
    await until(() => a.panes && b.panes)
    const ga = host.guests().find((g) => g.name === 'A')
    host.removeGuest(ga.id)
    await until(() => a.closed)
    expect(a.closed).toBe('removed')
    host.stop()
    await until(() => b.closed)
    expect(b.closed).toBe('stopped')
  })

  it('cleans guest names', () => {
    expect(cleanName('  Al\u0000ex  ')).toBe('Alex')
    expect(cleanName('')).toBe('')
    expect(cleanName('x'.repeat(100)).length).toBe(40)
  })
})

describe('Live Share session: round 5', () => {
  const servers = []
  afterEach(() => {
    for (const s of servers.splice(0)) s.stop?.() ?? s.close?.()
  })
  const hostFor = (opts) => {
    const h = createShareHost(opts)
    servers.push(h)
    return h
  }

  it('groups IPv6 addresses by network (/64)', () => {
    expect(addressKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64')
    expect(addressKey('2001:db8:1:2::9')).toBe('2001:db8:1:2::/64')
    expect(addressKey('::ffff:10.0.0.5')).toBe('10.0.0.5')
    expect(addressKey('203.0.113.7')).toBe('203.0.113.7')
  })

  it('connections that say nothing hold no guest place, and are limited per address', async () => {
    const t = fakeTessel()
    const secret = newSecret()
    const host = hostFor({ secret, hostName: 'Cedric', callbacks: t.callbacks })
    const port = await host.start()
    const open = (ip) =>
      new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers: { 'cf-connecting-ip': ip } })
        servers.push(ws)
        ws.on('message', () => resolve({ ws, code: null }))
        ws.on('close', (code) => resolve({ ws, code }))
      })
    // Three silent connections from one address: a fourth is turned away.
    for (let i = 0; i < 3; i++) expect((await open('198.51.100.1')).code).toBe(null)
    expect((await open('198.51.100.1')).code).toBe(4002)
    // Another address: still welcome, and a real guest gets in while they
    // are all held.
    expect((await open('198.51.100.2')).code).toBe(null)
    const r = guestRecorder()
    createShareGuest({ url: `ws://127.0.0.1:${port}/`, secret, name: 'Alex', signingKey: newSigningKey(), callbacks: r.callbacks }).connect()
    await until(() => r.states.includes('joined'))
  })

  it('a returning guest acts on nothing the host sends before its signed welcome', async () => {
    const secret = newSecret()
    // Someone posing as the host: it has the invite secret, not the host key,
    // and sends a screen before any welcome.
    const fake = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    servers.push(fake)
    await new Promise((res) => fake.once('listening', res))
    fake.on('connection', (ws) => {
      const hostNonce = newNonce()
      const pair = newKeyPair()
      let commit = null
      let channel = null
      ws.send(JSON.stringify({ t: 'hello', app: 'tessel-liveshare', v: SHARE_PROTOCOL }))
      ws.on('message', (data, isBinary) => {
        if (!commit) {
          commit = JSON.parse(data.toString())
          ws.send(JSON.stringify({ t: 'keys', n: hostNonce.toString('base64'), kx: pair.publicRaw.toString('base64') }))
          return
        }
        if (!channel) {
          const reveal = JSON.parse(data.toString())
          const guestKey = Buffer.from(reveal.kx, 'base64')
          const dh = sharedSecret(pair.privateKey, guestKey)
          channel = createChannel(sessionKeys(secret, hostNonce, Buffer.from(reveal.n, 'base64'), 'host', { dh, hostKey: pair.publicRaw, guestKey }))
          return
        }
        if (isBinary) ws.send(channel.seal({ t: 'snapshot', id: 'p1', data: 'FAKE: enter your password', cols: 80, rows: 24 }))
      })
    })
    const r = guestRecorder()
    createShareGuest({ url: `ws://127.0.0.1:${fake.address().port}/`, secret, name: 'Alex', back: true, hostKey: newSigningKey().publicRaw, callbacks: r.callbacks }).connect()
    await until(() => r.closed)
    expect(r.closed).toBe('protocol')
    expect(r.screens).toEqual({})
  })

  it('a guest connected when this Tessel stops suddenly is not forgotten by the next one', async () => {
    let clock = 1000
    const t = fakeTessel()
    const secret = newSecret()
    const hostKey = newSigningKey()
    const host = hostFor({ secret, hostName: 'Cedric', callbacks: t.callbacks, hostKey, now: () => clock })
    const port = await host.start()
    const r = guestRecorder()
    const key = newSigningKey()
    createShareGuest({ url: `ws://127.0.0.1:${port}/`, secret, name: 'Alex', signingKey: key, callbacks: r.callbacks }).connect()
    await until(() => r.states.includes('joined'))
    // Connected for an hour: its saved entry says seen now.
    clock += 60 * 60 * 1000
    const saved = host.accessState()
    expect(saved.people[0].lastSeen).toBe(clock)
    expect(saved.knownAt).toBe(clock)
    // Another guest, offline for all but a minute of its time when the list
    // was saved.
    saved.people.push({ ...saved.people[0], key: newSigningKey().publicRaw.toString('base64'), name: 'Sam', lastSeen: clock - OFFLINE_KEEP_MS + 60 * 1000 })
    // The next Tessel, 5 minutes later (a crash or an update; nothing ran
    // meanwhile): the time away is not counted as theirs offline.
    clock += 5 * 60 * 1000
    const next = hostFor({ hostName: 'Cedric', callbacks: fakeTessel().callbacks, access: saved, hostKey, now: () => clock })
    expect(next.offlineGuests().map((g) => g.name).sort()).toEqual(['Alex', 'Sam'])
    // Two minutes on: Sam's time is over (restarts don't extend it); Alex
    // has most of its time left.
    clock += 2 * 60 * 1000
    expect(next.offlineGuests().map((g) => g.name)).toEqual(['Alex'])
  })

  it('a full room turns guests away without counting them against the code', async () => {
    const t = fakeTessel()
    let blocked = 0
    const secret = newSecret()
    const host = hostFor({ secret, hostName: 'Cedric', callbacks: { ...t.callbacks, onInviteBlocked: () => blocked++ } })
    const port = await host.start()
    const join = async (name) => {
      const r = guestRecorder()
      createShareGuest({ url: `ws://127.0.0.1:${port}/`, secret, name, signingKey: newSigningKey(), callbacks: r.callbacks }).connect()
      await until(() => r.states.includes('joined') || r.closed)
      return r
    }
    for (let i = 0; i < 10; i++) expect((await join(`G${i}`)).states).toContain('joined')
    // Ten guests in: the next ones are turned away, as many as they like.
    for (let i = 0; i < 9; i++) expect((await join(`X${i}`)).closed).toBe('busy')
    expect(blocked).toBe(0)
  }, 30000)

  it('a room full with its waiting line full too: still a full room, not counted against the code', async () => {
    // Eight let in, then two left waiting for the host's answer.
    let answered = 0
    const t = fakeTessel({ approve: () => (++answered <= 8 ? true : new Promise(() => {})) })
    let blocked = 0
    const secret = newSecret()
    const host = hostFor({ secret, hostName: 'Cedric', callbacks: { ...t.callbacks, onInviteBlocked: () => blocked++ } })
    const port = await host.start()
    const join = async (name) => {
      const r = guestRecorder()
      createShareGuest({ url: `ws://127.0.0.1:${port}/`, secret, name, signingKey: newSigningKey(), callbacks: r.callbacks }).connect()
      await until(() => r.states.includes('joined') || r.states.includes('waiting') || r.closed)
      return r
    }
    for (let i = 0; i < 8; i++) expect((await join(`G${i}`)).states).toContain('joined')
    for (let i = 0; i < 2; i++) expect((await join(`W${i}`)).states).toContain('waiting')
    for (let i = 0; i < 9; i++) expect((await join(`X${i}`)).closed).toBe('busy')
    expect(blocked).toBe(0)
  }, 30000)

  it('the waiting line full with room left: those turned away still count (anyone can fill the line)', async () => {
    const t = fakeTessel({ approve: () => new Promise(() => {}) })
    let blocked = 0
    const secret = newSecret()
    const host = hostFor({ secret, hostName: 'Cedric', callbacks: { ...t.callbacks, onInviteBlocked: () => blocked++ } })
    const port = await host.start()
    const join = async (name) => {
      const r = guestRecorder()
      createShareGuest({ url: `ws://127.0.0.1:${port}/`, secret, name, signingKey: newSigningKey(), callbacks: r.callbacks }).connect()
      await until(() => r.states.includes('waiting') || r.closed)
      return r
    }
    for (let i = 0; i < 2; i++) expect((await join(`W${i}`)).states).toContain('waiting')
    for (let i = 0; i < 8; i++) expect((await join(`X${i}`)).closed).toBe('busy')
    // Eight counted: the code lets no new guest in.
    expect(blocked).toBe(1)
    expect((await join('Y')).closed).toBe('expired')
  }, 30000)

  // Guests arriving one after the other from this PC, the clock a minute on
  // every 15 (past the connections a minute from one address).
  const arrivals = (port, secret, clock) => {
    let n = 0
    return async (name) => {
      if (++n % 15 === 0) clock.now += 61000
      const r = guestRecorder()
      createShareGuest({ url: `ws://127.0.0.1:${port}/`, secret, name, signingKey: newSigningKey(), callbacks: r.callbacks }).connect()
      await until(() => r.states.includes('joined') || r.states.includes('waiting') || r.closed)
      return r
    }
  }

  it('a crowded share (8 in, 2 waiting) turns away 30 more in 10 minutes without blocking the code, and 30 more after that', async () => {
    const clock = { now: 1000 }
    let answered = 0
    const t = fakeTessel({ approve: () => (++answered <= 8 ? true : new Promise(() => {})) })
    let blocked = 0
    const secret = newSecret()
    const host = hostFor({ secret, hostName: 'Cedric', callbacks: { ...t.callbacks, onInviteBlocked: () => blocked++ }, now: () => clock.now })
    const join = arrivals(await host.start(), secret, clock)
    for (let i = 0; i < 8; i++) expect((await join(`G${i}`)).states).toContain('joined')
    const waiting = []
    for (let i = 0; i < 2; i++) waiting.push(await join(`W${i}`))
    expect(waiting.every((r) => r.states.includes('waiting'))).toBe(true)
    for (let i = 0; i < 30; i++) expect((await join(`X${i}`)).closed).toBe('busy')
    expect(blocked).toBe(0)
    clock.now += 10 * 60 * 1000
    // Those two waited too long: turned away at the next arrival, and two
    // more wait in their place.
    for (let i = 2; i < 4; i++) expect((await join(`W${i}`)).states).toContain('waiting')
    await until(() => waiting.every((r) => r.closed))
    expect(waiting.map((r) => r.closed)).toEqual(['timeout', 'timeout'])
    for (let i = 0; i < 30; i++) expect((await join(`Z${i}`)).closed).toBe('busy')
    expect(blocked).toBe(0)
    expect(isBlocked(host)).toBe(false)
  }, 60000)

  it('past 30 turned away by a full room in 10 minutes, the next ones count against the code (someone keeping the room full)', async () => {
    const clock = { now: 1000 }
    const t = fakeTessel()
    let blocked = 0
    const secret = newSecret()
    const host = hostFor({ secret, hostName: 'Cedric', callbacks: { ...t.callbacks, onInviteBlocked: () => blocked++ }, now: () => clock.now })
    const join = arrivals(await host.start(), secret, clock)
    for (let i = 0; i < 10; i++) expect((await join(`G${i}`)).states).toContain('joined')
    for (let i = 0; i < 30; i++) expect((await join(`X${i}`)).closed).toBe('busy')
    for (let i = 0; i < 7; i++) expect((await join(`Y${i}`)).closed).toBe('busy')
    expect(blocked).toBe(0)
    // The eighth counted: the code lets no new guest in.
    expect((await join('Y7')).closed).toBe('busy')
    expect(blocked).toBe(1)
    expect(isBlocked(host)).toBe(true)
    expect(host.accessState().invites[0].guard.roomFull).toHaveLength(38)
  }, 60000)

  it('what a guest closes is saved at once (a crash before the next save does not reset its count)', async () => {
    const t = fakeTessel()
    let saves = 0
    const secret = newSecret()
    const host = hostFor({ secret, hostName: 'Cedric', callbacks: { ...t.callbacks, onKnownChanged: () => saves++ }, hostKey: newSigningKey() })
    const port = await host.start()
    const r = guestRecorder()
    const g = createShareGuest({ url: `ws://127.0.0.1:${port}/`, secret, name: 'Alex', signingKey: newSigningKey(), callbacks: r.callbacks })
    g.connect()
    await until(() => r.states.includes('joined'))
    host.setGrant(host.guests()[0].id, { rights: { ...NO_RIGHTS, type: false, open: false, close: true } })
    await until(() => r.rights.length === 2)
    const before = saves
    for (let i = 0; i < 3; i++) g.close('p1')
    await until(() => t.closed.length === 3)
    expect(saves - before).toBeGreaterThanOrEqual(3)
    expect(host.accessState().people[0].closes).toHaveLength(3)
  })

  it('what a guest opened this minute survives a restart', async () => {
    const t = fakeTessel()
    const secret = newSecret()
    const hostKey = newSigningKey()
    const host = hostFor({ secret, hostName: 'Cedric', callbacks: t.callbacks, hostKey })
    const port = await host.start()
    const r = guestRecorder()
    const key = newSigningKey()
    const g = createShareGuest({ url: `ws://127.0.0.1:${port}/`, secret, name: 'Alex', signingKey: key, callbacks: r.callbacks })
    g.connect()
    await until(() => r.states.includes('joined'))
    host.setGrant(host.guests()[0].id, { rights: { ...NO_RIGHTS, type: false, open: true, close: false } })
    await until(() => r.rights.length === 2)
    for (let i = 0; i < 3; i++) g.open({ kind: 'terminal', project: 'ws-1' })
    await until(() => t.opened.length === 3)
    const saved = host.accessState()
    expect(saved.people[0].opens).toHaveLength(3)
    host.stop('restarting')
    const t2 = fakeTessel()
    const next = hostFor({ hostName: 'Cedric', callbacks: t2.callbacks, access: saved, hostKey })
    const port2 = await next.start()
    const conn = guestRecorder()
    const back = createShareGuest({ url: `ws://127.0.0.1:${port2}/`, secret, name: 'Alex', signingKey: key, back: true, hostKey: r.hostKey, callbacks: conn.callbacks })
    back.connect()
    await until(() => conn.states.includes('joined'))
    back.open({ kind: 'terminal', project: 'ws-1' })
    await until(() => conn.notices.length)
    expect(t2.opened).toEqual([])
  })
})
