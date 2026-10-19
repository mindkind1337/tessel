// @vitest-environment node
// Live Share over the wire with invitations, trusted people, opening panes
// and presence (liveShare/shareHost.js on liveShare/shareAccess.js): real
// WebSockets on 127.0.0.1, each invitation at its own address.
import { describe, it, expect, afterEach } from 'vitest'
import WebSocket from 'ws'
import { createShareHost } from '../liveShare/shareHost'
import { createShareGuest } from '../liveShare/shareGuest'
import { createTrustStore, trustId } from '../liveShare/shareTrust'
import { newSecret, newSigningKey, newNonce, newKeyPair, commitment, sharedSecret, sessionKeys, createChannel, signBinding, signIdentity, identityFingerprint } from '../liveShare/shareCrypto'
import { NO_RIGHTS } from '../../shared/liveShareRights'

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
const NONE = { ...NO_RIGHTS, type: false, open: false, close: false }
const pane = (id) => ({ id, title: id, kind: 'shell', cols: 80, rows: 24 })

// The host's Tessel: projects (id -> pane ids) shared now. A guest's answer:
// answers[name] (true, false, an object, or a function of the ask); by
// default the prompt's one click (its invitation's projects and rights).
function fakeTessel(projects = { 'ws-a': ['a1'], 'ws-b': ['b1'] }) {
  const t = {
    shared: projects,
    answers: {},
    asked: [],
    writes: [],
    opened: [],
    askedOpen: [],
    blocked: [],
    presence: 0,
    agents: [{ id: 'codex', name: 'Codex' }],
    callbacks: {
      projects: () => Object.entries(t.shared).map(([id, ids]) => ({ id, layout: null, panes: ids.map(pane) })),
      snapshot: async (id) => ({ data: `screen of ${id}`, cols: 80, rows: 24 }),
      write: (id, data) => t.writes.push([id, data]),
      openPane: (spec, guest) => t.opened.push([guest.name, spec]),
      askOpen: (spec, guest) => t.askedOpen.push([guest.name, spec]),
      closePane: () => {},
      agents: () => t.agents,
      onPresence: () => t.presence++,
      onInviteBlocked: (id) => t.blocked.push(id),
      askApproval: async (g) => {
        t.asked.push(g)
        const a = t.answers[g.name]
        if (typeof a === 'function') return a(g)
        if (a !== undefined) return a
        return { yes: true, projects: g.offer.projects, rights: g.offer.rights }
      }
    }
  }
  return t
}

function recorder() {
  const r = { states: [], projects: null, lists: [], screens: {}, data: [], closed: null, rights: [], notices: [], agents: [], features: null }
  r.callbacks = {
    onState: (s, info) => {
      r.states.push(s)
      if (info && info.code) r.code = info.code
    },
    onProjects: (projects) => {
      r.projects = projects
      r.lists.push(projects)
    },
    onSnapshot: (id, data) => (r.screens[id] = data),
    onData: (id, data) => {
      r.screens[id] = (r.screens[id] || '') + data
      r.data.push([id, data])
    },
    onExit: () => {},
    onRestart: () => {},
    onRights: (rights) => r.rights.push(rights),
    onHostKey: (key) => (r.hostKey = key),
    onFeatures: (list) => (r.features = list),
    onAgents: (list) => r.agents.push(list),
    onNotice: (code) => r.notices.push(code),
    onClosed: (reason) => (r.closed = reason)
  }
  return r
}
const ids = (r) => (r.projects || []).map((p) => p.id)
const joinedOrClosed = (r) => (r.states.includes('joined') && r.projects) || r.closed

describe('Live Share invitations over the wire', () => {
  const hosts = []
  afterEach(() => {
    for (const h of hosts.splice(0)) h.stop()
  })

  async function share({ t = fakeTessel(), trust = createTrustStore(), now, access, secret, hostKey } = {}) {
    const host = createShareHost({ hostName: 'Ada', callbacks: t.callbacks, trust, ...(now ? { now } : {}), ...(access ? { access } : {}), ...(secret ? { secret } : {}), ...(hostKey ? { hostKey } : {}) })
    hosts.push(host)
    const port = await host.start()
    return { host, port, t, trust }
  }
  // Where an invitation is, and its secret (what its invite code holds).
  const where = (s, id) => {
    const c = s.host.inviteCode(id)
    return { url: `ws://127.0.0.1:${s.port}/${c.path ? `i/${c.path}` : ''}`, secret: c.secret }
  }
  function guest(s, id, name, opts = {}) {
    const r = recorder()
    const { url, secret } = id ? where(s, id) : opts.at
    r.key = opts.signingKey || newSigningKey()
    r.client = createShareGuest({ url, secret, name, callbacks: r.callbacks, ...opts, signingKey: r.key })
    r.client.connect()
    return r
  }
  async function joined(s, id, name, opts) {
    const r = guest(s, id, name, opts)
    await until(() => joinedOrClosed(r))
    expect(r.closed).toBe(null)
    return r
  }
  const guestOf = (s, name) => s.host.guests().find((g) => g.name === name)
  const invite = (s, spec) => {
    const res = s.host.createInvite(spec)
    expect(res.ok).toBe(true)
    return res.invite
  }

  it('two invitations with different projects: each guest gets only its own, the prompt prefilled with its invitation (one click)', async () => {
    const s = await share()
    const simpa = invite(s, { label: 'Simpa', projects: ['ws-a'], rights: { type: true } })
    const team = invite(s, { label: 'Dev team', projects: ['ws-b'] })
    const a = await joined(s, simpa.id, 'Simpa')
    const b = await joined(s, team.id, 'Bob')
    expect(s.t.asked.map((g) => [g.name, g.invite, g.offer])).toEqual([
      ['Simpa', { id: simpa.id, label: 'Simpa' }, { projects: ['ws-a'], rights: { ...NO_RIGHTS, type: true, open: false, close: false } }],
      ['Bob', { id: team.id, label: 'Dev team' }, { projects: ['ws-b'], rights: NONE }]
    ])
    expect(ids(a)).toEqual(['ws-a'])
    expect(ids(b)).toEqual(['ws-b'])
    expect(a.rights[0]).toEqual({ ...NO_RIGHTS, type: true, open: false, close: false })
    expect(guestOf(s, 'Simpa')).toMatchObject({ invite: { id: simpa.id, label: 'Simpa' }, projects: ['ws-a'] })
    s.host.sendData('a1', 'FOR-SIMPA')
    s.host.sendData('b1', 'FOR-BOB')
    await until(() => a.data.length && b.data.length)
    await wait(30)
    expect(a.data).toEqual([['a1', 'FOR-SIMPA']])
    expect(b.data).toEqual([['b1', 'FOR-BOB']])
    expect(s.host.invites().map((i) => [i.label, i.uses, i.joined])).toEqual([
      ['Simpa', 1, 1],
      ['Dev team', 1, 1]
    ])
  })

  it('a revoked invitation lets no one new in, the other still works; its people stay (and come back) unless removed', async () => {
    const s = await share()
    const a = invite(s, { label: 'A', projects: ['ws-a'] })
    const b = invite(s, { label: 'B', projects: ['ws-b'] })
    const ann = await joined(s, a.id, 'Ann')
    const late = where(s, a.id)
    expect(s.host.revokeInvite(a.id)).toEqual({ ok: true, removed: 0 })
    const x = guest(s, null, 'Late', { at: late })
    await until(() => x.closed)
    expect(x.closed).toBe('expired')
    expect(s.t.asked.map((g) => g.name)).toEqual(['Ann'])
    await joined(s, b.id, 'Bea')
    // Ann was let in with A: she stays, and comes back with her key.
    ann.client.disconnect()
    await until(() => s.host.offlineGuests().length === 1)
    const back = guest(s, null, 'Ann', { at: late, signingKey: ann.key, back: true, hostKey: ann.hostKey })
    await until(() => joinedOrClosed(back))
    expect(back.closed).toBe(null)
    expect(ids(back)).toEqual(['ws-a'])
    // Revoked with its people: they are out, for good.
    const bea = s.host.guests().find((g) => g.name === 'Bea')
    expect(s.host.revokeInvite(b.id, { removePeople: true })).toEqual({ ok: true, removed: 1 })
    expect(s.host.guests().some((g) => g.id === bea.id)).toBe(false)
    expect(s.host.invites()).toEqual([])
    expect(s.host.revokeInvite(b.id)).toEqual({ ok: false, reason: 'missing' })
  })

  it('an invitation expires; one with uses lets that many in (the others waiting with it are turned away)', async () => {
    const clock = { now: 5_000_000 }
    const s = await share({ now: () => clock.now })
    const hour = invite(s, { label: 'hour', projects: ['ws-a'] })
    const once = invite(s, { label: 'once', lifetime: 'week', maxUses: 1, projects: ['ws-a'] })
    // Two wait with the one-use code; the first one let in uses it.
    let release
    s.t.answers.First = () => new Promise((r) => (release = r))
    s.t.answers.Second = () => new Promise(() => {})
    const first = guest(s, once.id, 'First')
    const second = guest(s, once.id, 'Second')
    await until(() => first.states.includes('waiting') && second.states.includes('waiting'))
    release({ yes: true, projects: ['ws-a'] })
    await until(() => first.states.includes('joined') && second.closed)
    expect(second.closed).toBe('expired')
    expect(s.host.invites().find((i) => i.id === once.id)).toMatchObject({ uses: 1, state: 'used' })
    const third = guest(s, once.id, 'Third')
    await until(() => third.closed)
    expect(third.closed).toBe('expired')
    // An hour later, the hour's code lets no one in, and goes from the list.
    clock.now += 60 * 60 * 1000 + 1
    const late = guest(s, hour.id, 'Late')
    await until(() => late.closed)
    expect(late.closed).toBe('expired')
    expect(s.t.asked.map((g) => g.name)).toEqual(['First', 'Second'])
  })

  it('one invitation blocked never touches another; an address no invitation has is closed as expired, uncounted', async () => {
    const s = await share()
    const a = invite(s, { label: 'A', lifetime: 'never', projects: ['ws-a'] })
    const b = invite(s, { label: 'B', projects: ['ws-b'] })
    const stopAfterKeys = (url) =>
      new Promise((resolve) => {
        const ws = new WebSocket(url)
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString())
          if (msg.t === 'hello') ws.send(JSON.stringify({ t: 'commit', c: commitment(newNonce(), newKeyPair().publicRaw).toString('base64') }))
          else if (msg.t === 'keys') ws.close()
        })
        ws.on('close', (code) => setTimeout(() => resolve(code), 20))
        ws.on('error', () => resolve(null))
      })
    // An unknown address (and the share's own: no root code in this share):
    // the hello, then closed as expired, before any keys.
    for (const path of ['i/AAAAAAAAAAAAAAAA', '', 'nope']) expect(await stopAfterKeys(`ws://127.0.0.1:${s.port}/${path}`)).toBe(4001)
    for (let i = 0; i < 8; i++) await stopAfterKeys(where(s, a.id).url)
    await until(() => s.t.blocked.length === 1)
    expect(s.t.blocked).toEqual([a.id])
    expect(s.host.invites().map((i) => [i.label, i.state])).toEqual([
      ['A', 'blocked'],
      ['B', 'live']
    ])
    const x = guest(s, a.id, 'Ann')
    await until(() => x.closed)
    expect(x.closed).toBe('expired')
    await joined(s, b.id, 'Bea')
    // A new code for A: in again (no expiry kept).
    expect(s.host.rotateInvite(a.id)).toEqual({ ok: true })
    expect(s.host.invites()[0]).toMatchObject({ state: 'live', expiresAt: null })
    await joined(s, a.id, 'Ann')
  })

  it('no expiry: still works years later and after a restart, and every new guest still needs the host’s yes', async () => {
    const clock = { now: 5_000_000 }
    const hostKey = newSigningKey()
    const s = await share({ now: () => clock.now, hostKey })
    const team = invite(s, { label: 'Dev team', lifetime: 'never', projects: ['ws-a'] })
    clock.now += 3 * 365 * 24 * 3600 * 1000
    await joined(s, team.id, 'Ann')
    expect(s.t.asked.map((g) => g.name)).toEqual(['Ann'])
    const code = where(s, team.id)
    const saved = JSON.parse(JSON.stringify(s.host.accessState()))
    s.host.stop('restarting')
    clock.now += 365 * 24 * 3600 * 1000
    const next = await share({ now: () => clock.now, access: saved, hostKey })
    expect(next.host.invites()).toEqual([expect.objectContaining({ id: team.id, label: 'Dev team', lifetime: 'never', expiresAt: null, state: 'live' })])
    const bea = guest(next, null, 'Bea', { at: { url: code.url.replace(`:${s.port}/`, `:${next.port}/`), secret: code.secret } })
    await until(() => joinedOrClosed(bea))
    expect(bea.closed).toBe(null)
    expect(next.t.asked.map((g) => g.name)).toEqual(['Bea'])
    // A denial still makes its next guests wait.
    next.t.answers.Cid = false
    const cid = guest(next, team.id, 'Cid')
    await until(() => cid.closed)
    expect(cid.closed).toBe('denied')
    const dan = guest(next, team.id, 'Dan')
    await until(() => dan.closed)
    expect(dan.closed).toBe('busy')
  })

  it('an old-style single code still works, and an older guest (no identity key, no features) joins with an invitation, untrusted', async () => {
    const secret = newSecret()
    const s = await share({ secret })
    const [root] = s.host.invites()
    expect(root).toMatchObject({ root: true, projects: ['ws-a', 'ws-b'], later: true })
    const old = await joined(s, null, 'Root', { at: { url: `ws://127.0.0.1:${s.port}/`, secret } })
    expect(ids(old)).toEqual(['ws-a', 'ws-b'])
    const inv = invite(s, { label: 'New', projects: ['ws-b'] })
    const older = await joined(s, inv.id, 'Older', { features: [] })
    expect(ids(older)).toEqual(['ws-b'])
    expect(older.features).toEqual(['agents', 'presence']) // the host says what it speaks; the guest uses none
    expect(guestOf(s, 'Older')).toMatchObject({ trustable: false, trusted: false })
    expect(s.host.trust(guestOf(s, 'Older').id)).toBe(false)
    expect(s.trust.list()).toEqual([])
  })
})

describe('Live Share trusted people over the wire', () => {
  const hosts = []
  afterEach(() => {
    for (const h of hosts.splice(0)) h.stop()
  })
  async function share({ t = fakeTessel(), trust = createTrustStore(), access, hostKey, now } = {}) {
    const host = createShareHost({ hostName: 'Ada', callbacks: t.callbacks, trust, ...(access ? { access } : {}), ...(hostKey ? { hostKey } : {}), ...(now ? { now } : {}) })
    hosts.push(host)
    const port = await host.start()
    return { host, port, t, trust }
  }
  const where = (s, id) => {
    const c = s.host.inviteCode(id)
    return { url: `ws://127.0.0.1:${s.port}/i/${c.path}`, secret: c.secret }
  }
  function guest(s, id, name, opts = {}) {
    const r = recorder()
    const { url, secret } = opts.at || where(s, id)
    r.key = opts.signingKey || newSigningKey()
    r.client = createShareGuest({ url, secret, name, callbacks: r.callbacks, ...opts, signingKey: r.key })
    r.client.connect()
    return r
  }
  async function settled(r) {
    await until(() => joinedOrClosed(r))
    return r
  }
  const inviteOf = (s, spec) => s.host.createInvite(spec).invite

  it('trusted from the prompt: from then on in without the question, with its trusted grant, after leaving and after a restart', async () => {
    let file = []
    const trust = createTrustStore({ save: (entries) => (file = entries) })
    const s = await share({ trust })
    const simpa = inviteOf(s, { label: 'Simpa', projects: ['ws-a'] })
    const other = inviteOf(s, { label: 'Dev team', projects: ['ws-b'], rights: { type: true } })
    const identityKey = newSigningKey()
    s.t.answers.Simpa = (g) => {
      expect(g.trustable).toBe(true)
      return { yes: true, projects: ['ws-a'], rights: { close: true }, trust: true }
    }
    const first = await settled(guest(s, simpa.id, 'Simpa', { identityKey }))
    expect(first.closed).toBe(null)
    expect(file).toEqual([expect.objectContaining({ name: 'Simpa', grant: { projects: ['ws-a'], rights: { ...NO_RIGHTS, type: false, open: false, close: true } } })])
    expect(s.host.guests()[0]).toMatchObject({ trusted: true, trustable: true })
    // Leaves on purpose, comes back with another invitation (and a new
    // reconnect key): no question, its trusted grant plus the projects that
    // invitation offers (added to its trusted entry); its rights stay the
    // trusted ones.
    first.client.leave()
    await until(() => s.host.guests().length === 0)
    const again = await settled(guest(s, other.id, 'Simpa', { identityKey }))
    expect(again.closed).toBe(null)
    expect(ids(again)).toEqual(['ws-a', 'ws-b'])
    expect(again.rights[0]).toEqual({ ...NO_RIGHTS, type: false, open: false, close: true })
    expect(s.t.asked).toHaveLength(1)
    expect(file[0].grant.projects).toEqual(['ws-a', 'ws-b'])
    // Taken away by the host, it does not come back with the same invitation.
    const tid = trustId(trust.list()[0].fp)
    expect(s.host.change(tid, { project: 'ws-b', on: false })).toBe(true)
    await until(() => ids(again).length === 1)
    again.client.leave()
    await until(() => s.host.guests().length === 0)
    const fourthJoin = await settled(guest(s, other.id, 'Simpa', { identityKey }))
    expect(ids(fourthJoin)).toEqual(['ws-a'])
    fourthJoin.client.leave()
    await until(() => s.host.guests().length === 0)
    // This Tessel restarts and shares anew (a new access model, a new code):
    // the trust file brings it back.
    s.host.stop()
    const t2 = fakeTessel()
    const next = await share({ t: t2, trust: createTrustStore({ entries: file }) })
    const fresh = inviteOf(next, { label: 'Anyone', projects: ['ws-b'] })
    const third = await settled(guest(next, fresh.id, 'Simpa', { identityKey }))
    expect(third.closed).toBe(null)
    expect(ids(third)).toEqual(['ws-a', 'ws-b'])
    expect(t2.asked).toEqual([])
    // Rate limits and blocks still apply: a blocked invitation lets no one in, trusted or not.
    for (let i = 0; i < 8; i++) {
      await new Promise((resolve) => {
        const ws = new WebSocket(where(next, fresh.id).url)
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString())
          if (msg.t === 'hello') ws.send(JSON.stringify({ t: 'commit', c: commitment(newNonce(), newKeyPair().publicRaw).toString('base64') }))
          else if (msg.t === 'keys') ws.close()
        })
        ws.on('close', () => setTimeout(resolve, 20))
      })
    }
    third.client.leave()
    const fourth = await settled(guest(next, fresh.id, 'Simpa', { identityKey }))
    expect(fourth.closed).toBe('expired')
  })

  // 2026-10-19: a trusted person whose entry listed only a project of an
  // earlier share joined a new share (a new invitation offering the project
  // shared now) and saw nothing until the host shared its old project too.
  it('a trusted person joining a new share with a new invitation sees the projects that invitation offers at once', async () => {
    let file = []
    const identityKey = newSigningKey()
    const trust = createTrustStore({ save: (entries) => (file = entries) })
    // Trusted in an earlier share, with a project not shared now.
    trust.add({ key: identityKey.publicRaw, name: 'Maxim', projects: ['ws-old'], rights: { type: true } })
    const s = await share({ trust, t: fakeTessel({ 'ws-a': ['a1', 'a2'] }) })
    const inv = inviteOf(s, { projects: ['ws-a'] })
    const r = await settled(guest(s, inv.id, 'Maxim', { identityKey }))
    expect(r.closed).toBe(null)
    expect(s.t.asked).toEqual([])
    // In the welcome itself: its project and its panes, nothing re-ticked.
    expect(r.lists[0].map((p) => p.id)).toEqual(['ws-a'])
    expect(r.lists[0][0].panes.map((p) => p.id)).toEqual(['a1', 'a2'])
    await until(() => r.screens.a1 && r.screens.a2)
    expect(r.rights[0]).toEqual({ ...NO_RIGHTS, type: true, open: false, close: false })
    // Kept: its old project too (seen again when it is shared again).
    expect(file[0].grant.projects).toEqual(['ws-old', 'ws-a'])
    expect(s.host.guests()[0]).toMatchObject({ trusted: true, projects: ['ws-a'] })
  })

  it('a guest trusted from the prompt gets what the host ticked, not the rest of its invitation', async () => {
    const s = await share()
    const inv = inviteOf(s, { projects: ['ws-a', 'ws-b'] })
    s.t.answers.Simpa = { yes: true, projects: ['ws-a'], trust: true }
    const r = await settled(guest(s, inv.id, 'Simpa', { identityKey: newSigningKey() }))
    expect(ids(r)).toEqual(['ws-a'])
    expect(s.trust.list()[0].grant.projects).toEqual(['ws-a'])
  })

  it('trust can be given later from People, and taken back: then asked again', async () => {
    const clock = { now: 9_000_000 }
    const s = await share({ now: () => clock.now })
    const inv = inviteOf(s, { label: 'Simpa', projects: ['ws-a'] })
    const identityKey = newSigningKey()
    const a = await settled(guest(s, inv.id, 'Simpa', { identityKey }))
    const g = s.host.guests()[0]
    expect(g).toMatchObject({ trusted: false, trustable: true })
    expect(s.host.trust(g.id)).toBe(true)
    expect(s.host.guests()[0].trusted).toBe(true)
    const [entry] = s.trust.list()
    expect(entry.fp).toBe(identityFingerprint(identityKey.publicRaw))
    a.client.leave()
    await until(() => s.host.guests().length === 0)
    await settled(guest(s, inv.id, 'Simpa', { identityKey }))
    expect(s.t.asked).toHaveLength(1)
    // No longer trusted: removed at once (connected), and its reconnect key
    // lets it in no more.
    const second = s.host.guests()[0]
    expect(s.host.untrust(trustId(entry.fp))).toBe(true)
    await until(() => s.host.guests().length === 0)
    expect(s.host.offlineGuests()).toEqual([])
    expect(s.host.guests().some((x) => x.id === second.id)).toBe(false)
    // Not trusted any more: the prompt again.
    s.t.answers.Simpa = () => new Promise(() => {})
    clock.now += 16000
    const back = guest(s, inv.id, 'Simpa', { identityKey })
    await until(() => back.states.includes('waiting') || back.closed)
    expect(back.states).toContain('waiting')
    expect(s.t.asked).toHaveLength(2)
  })

  it('a spoofed identity is refused: another key, or a proof made for another connection', async () => {
    const trust = createTrustStore()
    const s = await share({ trust })
    const inv = inviteOf(s, { label: 'Simpa', projects: ['ws-a'] })
    const real = newSigningKey()
    trust.add({ key: real.publicRaw, name: 'Simpa', projects: ['ws-a'] })
    // Its public key with another private key.
    const forged = await settled(guest(s, inv.id, 'Mallory', { identityKey: { publicRaw: real.publicRaw, privateKey: newSigningKey().privateKey } }))
    expect(forged.closed).toBe('protocol')
    // A proof seen on one connection, replayed on another.
    const { url, secret } = where(s, inv.id)
    const seen = await rawJoin(url, secret, (binding) => {
      const k = newSigningKey()
      return { t: 'join', name: 'Simpa', key: k.publicRaw.toString('base64'), sig: signBinding(k, binding).toString('base64'), identity: { key: real.publicRaw.toString('base64'), sig: signIdentity(real, binding).toString('base64') } }
    })
    expect(seen.got.map((m) => m.t)).toContain('welcome') // the real one: in, no question
    const proof = seen.join.identity
    seen.ws.close()
    const replay = await rawJoin(url, secret, (binding) => {
      const k = newSigningKey()
      return { t: 'join', name: 'Mallory', key: k.publicRaw.toString('base64'), sig: signBinding(k, binding).toString('base64'), identity: proof }
    })
    expect(replay.got.map((m) => m.t)).not.toContain('welcome')
    expect(replay.got.find((m) => m.t === 'bye')).toMatchObject({ reason: 'protocol' })
    // Garbage instead of an identity: refused too.
    const junk = await rawJoin(url, secret, (binding) => {
      const k = newSigningKey()
      return { t: 'join', name: 'x', key: k.publicRaw.toString('base64'), sig: signBinding(k, binding).toString('base64'), identity: 'me' }
    })
    expect(junk.got.find((m) => m.t === 'bye')).toMatchObject({ reason: 'protocol' })
    expect(s.t.asked).toEqual([])
  })

  it('an offline trusted person: projects added or taken away apply when it comes back', async () => {
    const trust = createTrustStore()
    const s = await share({ trust })
    const inv = inviteOf(s, { label: 'Simpa', projects: ['ws-a'] })
    const identityKey = newSigningKey()
    s.t.answers.Simpa = { yes: true, projects: ['ws-a'], trust: true }
    const a = await settled(guest(s, inv.id, 'Simpa', { identityKey }))
    a.client.disconnect()
    await until(() => s.host.offlineGuests().length === 1)
    const tid = trustId(trust.list()[0].fp)
    expect(s.host.change(tid, { project: 'ws-b', on: true })).toBe(true)
    expect(s.host.change(tid, { project: 'ws-a', on: false })).toBe(true)
    expect(s.host.change(tid, { right: 'type', on: true })).toBe(true)
    expect(s.host.offlineGuests()[0]).toMatchObject({ trusted: true, projects: ['ws-b'], rights: { ...NO_RIGHTS, type: true, open: false, close: false } })
    const back = await settled(guest(s, inv.id, 'Simpa', { signingKey: a.key, back: true, hostKey: a.hostKey }))
    expect(ids(back)).toEqual(['ws-b'])
    expect(back.rights[0]).toEqual({ ...NO_RIGHTS, type: true, open: false, close: false })
  })
})

describe('Live Share: what a guest opens, and what the host sees of it', () => {
  const hosts = []
  afterEach(() => {
    for (const h of hosts.splice(0)) h.stop()
  })
  async function setup({ rights = NONE, features, now, projects = ['ws-a'] } = {}) {
    const t = fakeTessel()
    const host = createShareHost({ hostName: 'Ada', callbacks: t.callbacks, trust: createTrustStore(), ...(now ? { now } : {}) })
    hosts.push(host)
    const port = await host.start()
    const inv = host.createInvite({ label: 'Team', projects: ['ws-a', 'ws-b'] }).invite
    const c = host.inviteCode(inv.id)
    t.answers.Alex = { yes: true, projects, rights }
    const r = recorder()
    r.client = createShareGuest({ url: `ws://127.0.0.1:${port}/i/${c.path}`, secret: c.secret, name: 'Alex', signingKey: newSigningKey(), callbacks: r.callbacks, ...(features ? { features } : {}) })
    r.client.connect()
    await until(() => r.states.includes('joined') && r.projects)
    return { t, host, r, gid: host.guests()[0].id }
  }

  it('with the right: a terminal or an agent the host lists, in one of its projects; nothing else of the request is kept', async () => {
    const { t, r } = await setup({ rights: { open: true } })
    expect(r.agents).toEqual([[{ id: 'codex', name: 'Codex' }]])
    r.client.open({ kind: 'terminal', project: 'ws-a', cwd: 'C:\\Windows', env: { X: 1 } })
    r.client.open({ kind: 'agent', agent: 'codex', project: 'ws-a', args: ['--dangerously-skip-permissions'], command: 'calc.exe' })
    await until(() => t.opened.length === 2)
    expect(t.opened).toEqual([
      ['Alex', { kind: 'terminal', project: 'ws-a' }],
      ['Alex', { kind: 'agent', agent: 'codex', project: 'ws-a' }]
    ])
    expect(Object.keys(t.opened[1][1]).sort()).toEqual(['agent', 'kind', 'project'])
  })

  it('refused: a project not its own, an agent the host does not list, an id with arguments in it, an unknown kind', async () => {
    const { t, r } = await setup({ rights: { open: true } })
    r.client.open({ kind: 'terminal', project: 'ws-b' }) // shared, not its
    r.client.open({ kind: 'terminal', project: 'ws-zz' })
    r.client.open({ kind: 'agent', agent: 'calc', project: 'ws-a' })
    r.client.open({ kind: 'agent', agent: 'codex --yolo', project: 'ws-a' })
    r.client.open({ kind: 'agent', agent: '../codex', project: 'ws-a' })
    r.client.open({ kind: 'agent', agent: { id: 'codex' }, project: 'ws-a' })
    r.client.open({ kind: 'shell', id: 'cmd', project: 'ws-a' })
    r.client.open('terminal')
    await until(() => r.notices.includes('agent'))
    await wait(60)
    expect(t.opened).toEqual([])
    expect(t.askedOpen).toEqual([])
    expect(r.notices).toEqual(['agent'])
  })

  it('without the right, the host is asked (a couple of times a minute); an older guest without it asks nothing', async () => {
    const clock = { now: 9_000_000 }
    const { t, r } = await setup({ now: () => clock.now })
    r.client.open({ kind: 'agent', agent: 'codex', project: 'ws-a' })
    r.client.open({ kind: 'terminal', project: 'ws-a' })
    r.client.open({ kind: 'terminal', project: 'ws-a' })
    await until(() => r.notices.includes('limit'))
    expect(t.opened).toEqual([])
    expect(t.askedOpen).toEqual([
      ['Alex', { kind: 'agent', agent: 'codex', project: 'ws-a' }],
      ['Alex', { kind: 'terminal', project: 'ws-a' }]
    ])
    clock.now += 61000
    r.client.open({ kind: 'terminal', project: 'ws-a' })
    await until(() => t.askedOpen.length === 3)
    const older = await setup({ features: [] })
    older.r.client.open({ kind: 'terminal', project: 'ws-a' })
    await wait(80)
    expect(older.t.askedOpen).toEqual([])
    expect(older.t.opened).toEqual([])
  })

  it('caps: three a minute, a dozen in all (counted across its reconnects)', async () => {
    const clock = { now: 9_000_000 }
    const { t, r } = await setup({ rights: { open: true }, now: () => clock.now })
    for (let minute = 0; minute < 5; minute++) {
      for (let i = 0; i < 4; i++) r.client.open({ kind: 'terminal', project: 'ws-a' })
      await until(() => r.notices.length > minute)
      clock.now += 61000
    }
    await wait(50)
    expect(t.opened).toHaveLength(12)
  })

  it('the agents the host lists can change: guests who list them are told', async () => {
    const { t, host, r } = await setup({ rights: { open: true } })
    t.agents = [{ id: 'codex', name: 'Codex' }, { id: 'opencode', name: 'OpenCode' }, { id: 'bad id', name: 'x' }]
    host.agentsChanged()
    await until(() => r.agents.length === 2)
    expect(r.agents[1]).toEqual([
      { id: 'codex', name: 'Codex' },
      { id: 'opencode', name: 'OpenCode' }
    ])
    r.client.open({ kind: 'agent', agent: 'opencode', project: 'ws-a' })
    await until(() => t.opened.length === 1)
  })

  it('presence: the pane a guest has on screen, then typing in it, then idle again after a few seconds; only its own panes', async () => {
    const clock = { now: 9_000_000 }
    const { t, host, r, gid } = await setup({ rights: { type: true }, now: () => clock.now })
    expect(host.presence()).toEqual([])
    const before = t.presence
    r.client.focus('a1')
    await until(() => host.presence().length)
    expect(host.presence()).toEqual([{ id: 'a1', guests: [{ id: gid, watching: true, typing: false, reading: false }] }])
    expect(t.presence).toBeGreaterThan(before)
    r.client.write('a1', 'ls\r')
    await until(() => host.presence()[0]?.guests[0].typing)
    expect(host.presence()).toEqual([{ id: 'a1', guests: [{ id: gid, watching: true, typing: true, reading: false }] }])
    // Typing that goes on is said again every few seconds.
    const said = t.presence
    for (let i = 0; i < 5; i++) {
      clock.now += 1000
      r.client.write('a1', 'x')
      await until(() => t.writes.length === i + 2)
    }
    expect(t.presence).toBe(said + 1)
    clock.now += 3001
    expect(host.presence()).toEqual([{ id: 'a1', guests: [{ id: gid, watching: true, typing: false, reading: false }] }])
    // A pane of a project it does not see: nothing (and its focus is gone).
    await wait(520)
    r.client.focus('b1')
    await until(() => host.presence().length === 0)
    r.client.write('b1', 'x')
    await wait(40)
    expect(host.presence()).toEqual([])
    expect(t.writes.filter(([id]) => id === 'b1')).toEqual([])
  })

  it('presence comes from a guest a couple of times a second at most, the latest', async () => {
    const { host, r, gid } = await setup()
    for (const id of ['a1', null, 'a1', null, 'a1']) r.client.focus(id)
    await until(() => host.presence().length)
    await wait(600)
    expect(host.presence()).toEqual([{ id: 'a1', guests: [{ id: gid, watching: true, typing: false, reading: false }] }])
  })
})

describe('Live Share: access edited from either side', () => {
  const hosts = []
  afterEach(() => {
    for (const h of hosts.splice(0)) h.stop()
  })

  it('a group invitation used by three guests, then its projects edited: removals go to its people at once, additions when asked', async () => {
    const t = fakeTessel({ 'ws-a': ['a1'], 'ws-b': ['b1'], 'ws-c': ['c1'] })
    const host = createShareHost({ hostName: 'Ada', callbacks: t.callbacks, trust: createTrustStore() })
    hosts.push(host)
    const port = await host.start()
    const team = host.createInvite({ label: 'Dev team', projects: ['ws-a', 'ws-b'] }).invite
    const c = host.inviteCode(team.id)
    const people = []
    for (const name of ['Ann', 'Bob', 'Cid']) {
      const r = recorder()
      r.client = createShareGuest({ url: `ws://127.0.0.1:${port}/i/${c.path}`, secret: c.secret, name, signingKey: newSigningKey(), callbacks: r.callbacks })
      r.client.connect()
      await until(() => r.states.includes('joined') && r.projects)
      people.push(r)
    }
    expect(people.map(ids)).toEqual([['ws-a', 'ws-b'], ['ws-a', 'ws-b'], ['ws-a', 'ws-b']])
    expect(host.invites()[0]).toMatchObject({ uses: 3, joined: 3 })
    // One of them changed on its own: the others not.
    host.change(host.guests().find((g) => g.name === 'Bob').id, { project: 'ws-c', on: true })
    await until(() => ids(people[1]).length === 3)
    // The invitation loses ws-a and gains ws-c: ws-a goes for all three at once.
    expect(host.updateInvite(team.id, { projects: ['ws-b', 'ws-c'] })).toEqual({ ok: true, applied: 3 })
    await until(() => people.every((r) => !ids(r).includes('ws-a')))
    expect(people.map(ids)).toEqual([['ws-b'], ['ws-b', 'ws-c'], ['ws-b']])
    host.sendData('a1', 'GONE')
    await wait(40)
    expect(people.some((r) => r.data.some(([, d]) => d === 'GONE'))).toBe(false)
    // Asked to give the additions too: what this edit adds (ws-a), not what an
    // earlier one added without giving it (ws-c).
    expect(host.updateInvite(team.id, { projects: ['ws-a', 'ws-b', 'ws-c'] }, { applyRemovals: true, applyAdditions: true })).toEqual({ ok: true, applied: 3 })
    await until(() => people.every((r) => ids(r).includes('ws-a')))
    expect(people.map((r) => ids(r).sort())).toEqual([['ws-a', 'ws-b'], ['ws-a', 'ws-b', 'ws-c'], ['ws-a', 'ws-b']])
  })

  it('a person taken out of a project (the project’s people): its panes there stop at once', async () => {
    const t = fakeTessel()
    const host = createShareHost({ hostName: 'Ada', callbacks: t.callbacks, trust: createTrustStore() })
    hosts.push(host)
    const port = await host.start()
    const inv = host.createInvite({ projects: ['ws-a', 'ws-b'] }).invite
    const c = host.inviteCode(inv.id)
    const r = recorder()
    r.client = createShareGuest({ url: `ws://127.0.0.1:${port}/i/${c.path}`, secret: c.secret, name: 'Ann', signingKey: newSigningKey(), callbacks: r.callbacks })
    r.client.connect()
    await until(() => r.screens.a1 && r.screens.b1)
    host.sendData('a1', 'QUEUED')
    expect(host.change(host.guests()[0].id, { project: 'ws-a', on: false })).toBe(true)
    host.sendData('a1', 'AFTER')
    await until(() => ids(r).join() === 'ws-b')
    await wait(40)
    expect(r.screens.a1).toBe('screen of a1')
    // The invitation's own projects (the project's people: an invitation) change too.
    expect(host.change(inv.id, { project: 'ws-a', on: false })).toBe(true)
    expect(host.invites()[0].projects).toEqual(['ws-b'])
    expect(host.change(inv.id, { project: 'ws-zz', on: true })).toBe(false)
  })
})

// A guest done by hand (to send a join of its own making): the handshake,
// then makeJoin(binding) sealed. Resolves once the host answered (waiting,
// welcome or bye) or closed.
function rawJoin(url, secret, makeJoin) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url)
    let mine = null
    let channel = null
    let join = null
    const got = []
    const done = () => resolve({ ws, got, join })
    ws.on('message', (data, isBinary) => {
      if (!channel) {
        const msg = JSON.parse(data.toString())
        if (msg.t === 'hello') {
          mine = { nonce: newNonce(), keys: newKeyPair() }
          ws.send(JSON.stringify({ t: 'commit', c: commitment(mine.nonce, mine.keys.publicRaw).toString('base64') }))
        } else if (msg.t === 'keys') {
          const hostNonce = Buffer.from(msg.n, 'base64')
          const hostKx = Buffer.from(msg.kx, 'base64')
          const dh = sharedSecret(mine.keys.privateKey, hostKx)
          ws.send(JSON.stringify({ t: 'reveal', n: mine.nonce.toString('base64'), kx: mine.keys.publicRaw.toString('base64') }))
          const session = sessionKeys(secret, hostNonce, mine.nonce, 'guest', { dh, hostKey: hostKx, guestKey: mine.keys.publicRaw })
          channel = createChannel(session)
          join = makeJoin(session.binding)
          ws.send(channel.seal(join))
        }
        return
      }
      if (!isBinary) return
      const msg = channel.open(data)
      if (!msg) return
      got.push(msg)
      if (['waiting', 'welcome', 'bye'].includes(msg.t)) done()
    })
    ws.on('close', done)
    ws.on('error', done)
  })
}

// The review's probe (trusted person vs the caps and the room), turned
// around: what it showed must not happen.
describe('Live Share: a trusted identity keeps its caps and its one place', () => {
  const hosts = []
  afterEach(() => {
    for (const h of hosts.splice(0)) h.stop()
  })
  async function share(clock) {
    const t = fakeTessel({ 'ws-a': ['a1'] })
    t.answers = new Proxy({}, { get: () => false, has: () => true })
    const trust = createTrustStore()
    const host = createShareHost({ hostName: 'Ada', callbacks: t.callbacks, trust, now: () => clock.t })
    hosts.push(host)
    const port = await host.start()
    return { host, port, t, trust }
  }
  function guestOf(s, invId, name, opts = {}) {
    const c = s.host.inviteCode(invId)
    const r = recorder()
    r.client = createShareGuest({ url: `ws://127.0.0.1:${s.port}/i/${c.path}`, secret: c.secret, name, signingKey: newSigningKey(), callbacks: r.callbacks, ...opts })
    r.client.connect()
    return r
  }

  it('leaving and joining again (a new reconnect key each time) resets none of its caps: 12 opens in all, never 36', async () => {
    const clock = { t: 1_000_000 }
    const s = await share(clock)
    const identityKey = newSigningKey()
    s.trust.add({ key: identityKey.publicRaw, name: 'T', projects: ['ws-a'], rights: { open: true } })
    const inv = s.host.createInvite({ label: 'friends', lifetime: 'never', projects: ['ws-a'] }).invite
    for (let round = 0; round < 3; round++) {
      const r = guestOf(s, inv.id, 'T', { identityKey })
      await until(() => r.projects || r.closed)
      expect(r.closed).toBe(null)
      for (let minute = 0; minute < 5; minute++) {
        for (let i = 0; i < 4; i++) r.client.open({ kind: 'terminal', project: 'ws-a' })
        await wait(80)
        clock.t += 61_000
      }
      r.client.leave()
      await until(() => s.host.guests().length === 0)
    }
    expect(s.t.opened).toHaveLength(12)
    expect(s.t.asked).toHaveLength(0)
    // One use of the invitation, however many times it came.
    expect(s.host.invites()[0].uses).toBe(1)
  })

  it('one connection at a time: each join replaces the one it had, a few a minute; the room stays open to others', async () => {
    const clock = { t: 1_000_000 }
    const s = await share(clock)
    const identityKey = newSigningKey()
    s.trust.add({ key: identityKey.publicRaw, name: 'T', projects: ['ws-a'] })
    const inv = s.host.createInvite({ label: 'friends', lifetime: 'never', projects: ['ws-a'] }).invite
    const clones = []
    for (let i = 0; i < 10; i++) {
      const r = guestOf(s, inv.id, `T${i}`, { identityKey })
      await until(() => r.projects || r.closed)
      clones.push(r)
    }
    // Three joins in its minute (each replacing the one before), then busy.
    expect(clones.slice(0, 3).every((r) => r.states.includes('joined'))).toBe(true)
    await until(() => clones[0].closed && clones[1].closed)
    expect([clones[0].closed, clones[1].closed]).toEqual(['replaced', 'replaced'])
    expect(clones[2].closed).toBe(null)
    expect(clones.slice(3).map((r) => r.closed)).toEqual(Array(7).fill('busy'))
    expect(s.host.guests().filter((g) => g.state === 'joined')).toHaveLength(1)
    // Its one person entry, not ten.
    expect(s.host.accessState().people).toHaveLength(1)
    // Someone else is still asked (here: the host says no).
    const outsider = guestOf(s, inv.id, 'Bob')
    await until(() => outsider.closed)
    expect(outsider.closed).toBe('denied')
    expect(s.t.asked.map((g) => g.name)).toEqual(['Bob'])
    // A minute later it may join again (replacing its connection).
    clock.t += 61_000
    const later = guestOf(s, inv.id, 'T', { identityKey })
    await until(() => later.projects || later.closed)
    expect(later.closed).toBe(null)
    await until(() => clones[2].closed)
    expect(clones[2].closed).toBe('replaced')
  })

  // Mallory's asks are never answered (the host away); everyone else hears no.
  const parkMallory = (s) => (s.t.answers = new Proxy({}, { get: (_, name) => (String(name).startsWith('Mallory') ? () => new Promise(() => {}) : false), has: () => true }))
  const waitingOrClosed = (r) => r.states.includes('waiting') || r.closed

  it('one code fills only its own short line (two wait per invitation, six in all): the others are still asked', async () => {
    const clock = { t: 1_000_000 }
    const s = await share(clock)
    parkMallory(s)
    const leaked = s.host.createInvite({ label: 'public group', lifetime: 'never', projects: ['ws-a'] }).invite
    const priv = s.host.createInvite({ label: 'Simpa only', projects: ['ws-a'] }).invite
    const parked = []
    for (let i = 0; i < 3; i++) {
      const r = guestOf(s, leaked.id, `Mallory${i}`)
      await until(() => waitingOrClosed(r))
      parked.push(r)
    }
    expect(parked.map((r) => r.closed)).toEqual([null, null, 'busy'])
    const simpa = guestOf(s, priv.id, 'Simpa')
    await until(() => simpa.closed)
    expect(simpa.closed).toBe('denied') // asked: the host said no
    expect(s.t.asked.map((g) => g.name)).toContain('Simpa')
    // Six wait in all, whatever their invitations; the next is turned away,
    // not counted against its own invitation.
    const more = ['B', 'C'].map((label) => s.host.createInvite({ label, projects: ['ws-a'] }).invite)
    for (const inv of more) {
      for (let i = 0; i < 2; i++) {
        const r = guestOf(s, inv.id, `Mallory-${inv.label}${i}`)
        await until(() => waitingOrClosed(r))
        expect(r.closed).toBe(null)
      }
    }
    clock.t += 16_000 // (Simpa's no paused only its own invitation)
    const last = s.host.createInvite({ label: 'D', projects: ['ws-a'] }).invite
    const d = guestOf(s, last.id, 'Mallory-D')
    await until(() => d.closed)
    expect(d.closed).toBe('busy')
    expect(s.host.accessState().invites.find((i) => i.id === last.id).guard.unfinished).toEqual([])
  })

  it('leaving while waiting pauses only that invitation; the host’s own noes pause every invitation only when they span two invitations', async () => {
    const clock = { t: 1_000_000 }
    const s = await share(clock)
    parkMallory(s)
    const [leaked, x, y, z] = ['public group', 'X', 'Y', 'Z'].map((label) => s.host.createInvite({ label, lifetime: 'never', projects: ['ws-a'] }).invite)
    const parked = []
    for (let i = 0; i < 2; i++) {
      const r = guestOf(s, leaked.id, `Mallory${i}`)
      await until(() => waitingOrClosed(r))
      parked.push(r)
    }
    for (const r of parked) r.client.leave()
    await until(() => s.host.guests().length === 0)
    // Its own invitation pauses; no other does.
    const again = guestOf(s, leaked.id, 'Mallory9')
    await until(() => again.closed)
    expect(again.closed).toBe('busy')
    const simpa = guestOf(s, x.id, 'Simpa')
    await until(() => simpa.closed)
    expect(simpa.closed).toBe('denied')
    // Three noes, all for X: X pauses, the others do not.
    for (const [i, wait] of [
      [1, 16_000],
      [2, 31_000]
    ]) {
      clock.t += wait
      const r = guestOf(s, x.id, `Bob${i}`)
      await until(() => r.closed)
      expect(r.closed).toBe('denied')
    }
    const onZ = guestOf(s, z.id, 'Cid')
    await until(() => onZ.closed)
    expect(onZ.closed).toBe('denied') // asked
    // That no was for Z: the host's noes now span two invitations, so every
    // invitation pauses a while (Y too, which had none).
    const paused = guestOf(s, y.id, 'Eve')
    await until(() => paused.closed)
    expect(paused.closed).toBe('busy')
    // Not counted against Y (others' noes did it), and over after a while.
    expect(s.host.accessState().invites.find((i) => i.id === y.id).guard.unfinished).toEqual([])
    clock.t += 31_000
    const later = guestOf(s, y.id, 'Fay')
    await until(() => later.closed)
    expect(later.closed).toBe('denied')
  })

  it('a guest waits four minutes at most for the host’s answer, then it counts against its own invitation only', async () => {
    const clock = { t: 1_000_000 }
    const s = await share(clock)
    parkMallory(s)
    const [x, y] = ['X', 'Y'].map((label) => s.host.createInvite({ label, lifetime: 'never', projects: ['ws-a'] }).invite)
    const m = guestOf(s, x.id, 'Mallory')
    await until(() => waitingOrClosed(m))
    expect(m.closed).toBe(null)
    clock.t += 4 * 60 * 1000 + 1
    const simpa = guestOf(s, y.id, 'Simpa')
    await until(() => simpa.closed && m.closed)
    expect(m.closed).toBe('timeout')
    expect(simpa.closed).toBe('denied') // asked
    const guards = Object.fromEntries(s.host.accessState().invites.map((i) => [i.label, i.guard.unfinished.length]))
    expect(guards).toEqual({ X: 1, Y: 0 })
  })

  it('a person whose trusted entry is gone (trust taken back while the share was taken back) is refused on coming back, and not listed', async () => {
    const clock = { t: 1_000_000 }
    const s = await share(clock)
    const identityKey = newSigningKey()
    const e = s.trust.add({ key: identityKey.publicRaw, name: 'T', projects: ['ws-a'], rights: { type: true } })
    const inv = s.host.createInvite({ label: 'friends', projects: ['ws-a'] }).invite
    const key = newSigningKey()
    const r = guestOf(s, inv.id, 'T', { identityKey, signingKey: key })
    await until(() => r.projects || r.closed)
    expect(r.closed).toBe(null)
    // What is saved for it: no grant of its own (its trusted entry's).
    expect(s.host.accessState().people[0].grant).toEqual({ projects: [], rights: { ...NO_RIGHTS, type: false, open: false, close: false } })
    r.client.disconnect()
    await until(() => s.host.offlineGuests().length === 1)
    // The trusted entry goes by itself (not through the share).
    s.trust.remove(e.fp)
    const back = guestOf(s, inv.id, 'T', { signingKey: key, back: true, hostKey: r.hostKey })
    await until(() => back.closed)
    expect(back.closed).toBe('rejoin-refused')
    expect(s.host.offlineGuests()).toEqual([])
    expect(s.t.asked).toEqual([])
  })
})
