// @vitest-environment node
// Live Share's access model (liveShare/shareAccess.js), its trusted people
// (shareTrust.js) and its rights catalog (src/shared/liveShareRights.js), on
// their own: invitations, codes, people, grants, trust, saving and taking a
// share back. The wire is liveShareInvites.spec.js's.
import { describe, it, expect } from 'vitest'
import crypto from 'crypto'
import { createAccess, pathOfUrl, cleanInviteSpec, secretId, keyHash, personId, LIFETIMES, MAX_INVITES, MAX_PEOPLE, UNFINISHED_MAX, ROOM_FULL_FREE, OFFLINE_KEEP_MS } from '../liveShare/shareAccess'
import { createTrustStore, MAX_TRUSTED, MAX_TRUSTED_PROJECTS, trustId, isTrustId } from '../liveShare/shareTrust'
import { SHARE_RIGHTS, RIGHT_IDS, cleanRights, defaultRights, NO_RIGHTS, isRightId, sameRights, setRight, neededBy } from '../../shared/liveShareRights'
import { newSigningKey, identityFingerprint } from '../liveShare/shareCrypto'

const NONE = { ...NO_RIGHTS, type: false, open: false, close: false }
const key = () => newSigningKey().publicRaw

// An access model over a clock and a set of shared projects.
function model({ shared = ['ws-a', 'ws-b'], trust = createTrustStore(), saved = null, legacy = null, online = new Set() } = {}) {
  const clock = { now: 1_000_000 }
  const sharedSet = { ids: new Set(shared) }
  const changes = []
  const logs = []
  const access = createAccess({
    now: () => clock.now,
    trust,
    isOnline: (hash) => online.has(hash),
    sharedIds: () => sharedSet.ids,
    onChange: (kind) => changes.push(kind),
    log: (line) => logs.push(line),
    saved,
    legacy
  })
  return { access, clock, sharedSet, changes, logs, trust, online }
}

describe('the rights catalog', () => {
  it('is one list of ids with their defaults, all off', () => {
    expect(RIGHT_IDS).toEqual(['type', 'open', 'close', 'usage', 'edit', 'git', 'tasks', 'pagesView'])
    expect(SHARE_RIGHTS.every((r) => r.default === false)).toBe(true)
    expect(defaultRights()).toEqual(NONE)
    expect(NO_RIGHTS).toEqual(NONE)
    expect(Object.isFrozen(NO_RIGHTS) && Object.isFrozen(SHARE_RIGHTS)).toBe(true)
  })

  it('keeps only the rights it knows, each on only when exactly true (a peer’s unknown ids are never granted)', () => {
    expect(cleanRights({ type: true, open: 'yes', close: 1, files: true, __proto__: { type: true } })).toEqual({ ...NO_RIGHTS, type: true })
    expect(cleanRights(Object.create({ open: true }))).toEqual(NONE)
    expect(cleanRights(null)).toEqual(NONE)
    expect(cleanRights('type')).toEqual(NONE)
    for (const id of ['__proto__', 'constructor', 'toString', 'files', '', null, ['type']]) expect(isRightId(id)).toBe(false)
    expect(isRightId('open')).toBe(true)
    expect(sameRights({ type: true }, { type: true, open: false, extra: true })).toBe(true)
    expect(sameRights({ type: true }, NONE)).toBe(false)
  })

  it('the old "use my browser pages" is gone: a record that has it reads without it, and no click gives it', () => {
    expect(neededBy('pagesUse')).toBe(null)
    expect(neededBy('edit')).toBe(null)
    // A record (a peer, a file) from before: only what it still means.
    expect(cleanRights({ pagesUse: true })).toEqual(NONE)
    expect(cleanRights({ pagesUse: true, pagesView: true })).toEqual({ ...NONE, pagesView: true })
    expect(setRight(NONE, 'pagesUse', true)).toEqual(NONE)
    expect(setRight(NONE, 'pagesView', true)).toEqual({ ...NONE, pagesView: true })
    expect(setRight(NONE, 'edit', true)).toEqual({ ...NONE, edit: true })
    expect(setRight({ ...NONE, git: true }, 'nope', true)).toEqual({ ...NONE, git: true })
  })

  it('an old record (three rights) still loads, with the new ones off', () => {
    expect(cleanRights({ type: true, open: false, close: true })).toEqual({ ...NONE, type: true, close: true })
    const { access } = model()
    const inv = access.createInvite({ projects: ['ws-a'], rights: { type: true } }).invite
    const back = createAccess({ now: () => 1000, sharedIds: () => new Set(['ws-a']), saved: access.toJSON() })
    expect(back.invite(inv.id).grant.rights).toEqual({ ...NONE, type: true })
  })

  it('changes one right at a time with what it needs (a person, a trusted person, an invitation)', () => {
    const { access } = model()
    const inv = access.createInvite({ projects: ['ws-a'] }).invite
    expect(access.change({ invite: inv.id }, { right: 'pagesView', on: true })).toBe(true)
    expect(access.invite(inv.id).grant.rights).toEqual({ ...NONE, pagesView: true })
    expect(access.change({ invite: inv.id }, { right: 'pagesView', on: false })).toBe(true)
    expect(access.invite(inv.id).grant.rights).toEqual(NONE)
    const store = createTrustStore({ entries: [], save: () => {}, onChange: () => {} })
    const e = store.add({ key: newSigningKey().publicRaw, name: 'Ana', projects: [], rights: null })
    expect(store.change(e.fp, { right: 'pagesView', on: true })).toBe(true)
    expect(store.get(e.fp).grant.rights).toEqual({ ...NONE, pagesView: true })
  })
})

describe('invitations', () => {
  it('each one has its own code at its own address; the rest of an address reaches nothing', () => {
    const { access } = model()
    const a = access.createInvite({ label: 'Simpa', projects: ['ws-a'] }).invite
    const b = access.createInvite({ label: 'Dev team', projects: ['ws-b'] }).invite
    const ca = access.codeOf(a.id)
    const cb = access.codeOf(b.id)
    expect(ca.path).toMatch(/^[A-Za-z0-9_-]{16}$/)
    expect(ca.path).not.toBe(cb.path)
    expect(ca.secret.equals(cb.secret)).toBe(false)
    expect(access.codesAt(pathOfUrl(`/i/${ca.path}`))).toEqual([ca])
    expect(access.codesAt(pathOfUrl(`/i/${cb.path}/`))).toEqual([cb])
    expect(access.liveInvite(ca)).toBe(a)
    expect(access.codesAt(pathOfUrl('/'))).toEqual([]) // no root code in a new share
    for (const url of ['/x', '/i/short', `/i/${ca.path}/more`, `/I/${ca.path}`, '//evil/', `//evil/i/${ca.path}`, '', `http://evil/i/${ca.path}`]) expect(pathOfUrl(url)).toBe(null)
    // A query is not part of the address.
    expect(pathOfUrl(`/i/${ca.path}?x=1`)).toBe(ca.path)
    expect(pathOfUrl('/')).toBe('')
    expect(pathOfUrl('/?x')).toBe('')
  })

  it('has a label, a lifetime (an hour by default, a day, a week or none), optional uses, and what it offers (shared projects only)', () => {
    const { access, clock } = model()
    const hour = access.createInvite({ label: '  Simpa\u0007 ', projects: ['ws-a', 'ws-gone', '../x'], rights: { type: true, files: true } }).invite
    expect(hour).toMatchObject({ label: 'Simpa', lifetime: 'hour', expiresAt: clock.now + LIFETIMES.hour, maxUses: 0, uses: 0, later: false, grant: { projects: ['ws-a'], rights: { ...NO_RIGHTS, type: true, open: false, close: false } } })
    expect(access.createInvite({ lifetime: 'day' }).invite.expiresAt).toBe(clock.now + LIFETIMES.day)
    expect(access.createInvite({ lifetime: 'week', maxUses: 1 }).invite).toMatchObject({ expiresAt: clock.now + 7 * 24 * 3600 * 1000, maxUses: 1 })
    const never = access.createInvite({ lifetime: 'never', later: true }).invite
    expect(never.expiresAt).toBe(null)
    expect(never.later).toBe(true)
  })

  it('refuses what it does not know, never guesses: lifetimes, uses, and "let them in without asking"', () => {
    const shared = new Set(['ws-a'])
    for (const lifetime of ['forever', 'month', 0, null, 3600000, '__proto__']) expect(cleanInviteSpec({ lifetime }, shared)).toEqual({ error: 'lifetime' })
    for (const maxUses of [-1, 1.5, '3', 1001, NaN]) expect(cleanInviteSpec({ maxUses }, shared)).toEqual({ error: 'uses' })
    expect(cleanInviteSpec({ autoAllow: true }, shared)).toEqual({ error: 'auto-allow' })
    expect(cleanInviteSpec({ autoAllow: true, lifetime: 'never' }, shared)).toEqual({ error: 'auto-allow' })
    const { access } = model()
    expect(access.createInvite({ lifetime: 'never', autoAllow: true })).toEqual({ ok: false, reason: 'auto-allow' })
    const inv = access.createInvite({ lifetime: 'never' }).invite
    expect(access.updateInvite(inv.id, { autoAllow: true })).toEqual({ ok: false, reason: 'auto-allow' })
    expect(access.updateInvite(inv.id, { lifetime: 'forever' })).toEqual({ ok: false, reason: 'lifetime' })
    expect(access.updateInvite('iv-0000000000', { label: 'x' })).toEqual({ ok: false, reason: 'missing' })
  })

  it('at most MAX_INVITES at once (an expired one makes room)', () => {
    const { access, clock } = model()
    for (let i = 0; i < MAX_INVITES; i++) expect(access.createInvite({ label: `n${i}`, lifetime: i === 0 ? 'hour' : 'week' }).ok).toBe(true)
    expect(access.createInvite({})).toEqual({ ok: false, reason: 'full', max: MAX_INVITES })
    clock.now += LIFETIMES.hour + 1
    expect(access.createInvite({}).ok).toBe(true)
  })

  it('lets no new guest in once expired, used up, blocked or revoked; no expiry is never, even years later', () => {
    const { access, clock } = model()
    const hour = access.createInvite({ lifetime: 'hour' }).invite
    const never = access.createInvite({ lifetime: 'never' }).invite
    const once = access.createInvite({ lifetime: 'week', maxUses: 1 }).invite
    expect([hour, never, once].map(access.usable)).toEqual([null, null, null])
    expect(access.used(once)).toBe(true)
    expect(access.usable(once)).toBe('used')
    clock.now += LIFETIMES.hour + 1
    expect(access.usable(hour)).toBe('expired')
    clock.now += 10 * 365 * 24 * 3600 * 1000
    expect(access.usable(never)).toBe(null)
    // Expired ones go; no expiry stays.
    access.prune()
    expect(access.invites().map((i) => i.id)).toEqual([never.id])
    access.revokeInvite(never.id)
    expect(access.usable(never)).toBe('revoked')
  })

  it('each invitation has its own block: connections that stop after the keys block that one only', () => {
    const { access, logs } = model()
    const a = access.createInvite({ lifetime: 'never' }).invite
    const b = access.createInvite({}).invite
    for (let i = 0; i < UNFINISHED_MAX - 1; i++) expect(access.noteUnfinished(a.id)).toBe(false)
    expect(access.noteUnfinished(a.id)).toBe(true)
    expect(access.noteUnfinished(a.id)).toBe(false) // already
    expect(access.usable(a)).toBe('blocked')
    expect(access.usable(b)).toBe(null)
    expect(access.publicInvite(a).state).toBe('blocked')
    // A blocked no-expiry code stays blocked until it gets a new code.
    expect(access.rotateInvite(a.id).ok).toBe(true)
    expect(access.usable(a)).toBe(null)
    expect(a.expiresAt).toBe(null)
    expect(logs.join('\n')).toContain(`invitation ${a.id} blocked`)
  })

  it('each invitation has its own pause after a no and its own full-room count', () => {
    const { access, clock } = model()
    const a = access.createInvite({}).invite
    const b = access.createInvite({}).invite
    access.noteDenied(a.id)
    expect(access.pausing(a.id)).toBe(true)
    expect(access.pausing(b.id)).toBe(false)
    clock.now += 15001
    expect(access.pausing(a.id)).toBe(false)
    for (let i = 0; i < ROOM_FULL_FREE; i++) expect(access.noteRoomFull(a.id)).toBe(true)
    expect(access.noteRoomFull(a.id)).toBe(false)
    expect(access.noteRoomFull(b.id)).toBe(true)
  })

  it('a new code keeps its label, grant and uses, lifts the block and starts its lifetime again; the old code stays only for its people', () => {
    const { access, clock } = model()
    const inv = access.createInvite({ label: 'Dev team', lifetime: 'day', projects: ['ws-a'], rights: { type: true } }).invite
    const old = access.codeOf(inv.id)
    access.used(inv)
    clock.now += 1000
    access.rotateInvite(inv.id)
    const fresh = access.codeOf(inv.id)
    expect(fresh.path).not.toBe(old.path)
    expect(inv).toMatchObject({ label: 'Dev team', uses: 1, expiresAt: clock.now + LIFETIMES.day, grant: { projects: ['ws-a'], rights: { ...NO_RIGHTS, type: true, open: false, close: false } } })
    // No one let in with the old code: it is gone.
    expect(access.codesAt(old.path)).toEqual([])
    // Someone let in with the new one keeps it after another new code.
    access.addPerson({ key: key(), name: 'Bea', sid: fresh.sid, via: inv.id, grant: inv.grant })
    access.rotateInvite(inv.id)
    expect(access.codesAt(fresh.path)).toHaveLength(1)
    expect(access.liveInvite(access.codesAt(fresh.path)[0])).toBe(null)
  })

  it('duplicating copies its settings with a code of its own and no uses', () => {
    const { access } = model()
    const inv = access.createInvite({ label: 'Simpa', lifetime: 'never', maxUses: 2, projects: ['ws-b'], later: true, rights: { open: true } }).invite
    access.used(inv)
    const copy = access.duplicateInvite(inv.id).invite
    expect(copy.id).not.toBe(inv.id)
    expect(copy).toMatchObject({ label: 'Simpa', lifetime: 'never', expiresAt: null, maxUses: 2, uses: 0, later: true, grant: { projects: ['ws-b'], rights: { ...NO_RIGHTS, type: false, open: true, close: false } } })
    expect(access.codeOf(copy.id).sid).not.toBe(access.codeOf(inv.id).sid)
  })
})

describe('a group invitation and the people who joined with it', () => {
  function group() {
    const m = model({ shared: ['ws-a', 'ws-b', 'ws-c'] })
    const inv = m.access.createInvite({ label: 'Dev team', projects: ['ws-a', 'ws-b'], rights: { type: true } }).invite
    const sid = m.access.codeOf(inv.id).sid
    const people = ['Ann', 'Bob', 'Cid'].map((name) => m.access.addPerson({ key: key(), name, sid, via: inv.id, grant: inv.grant }))
    for (let i = 0; i < 3; i++) m.access.used(inv)
    return { ...m, inv, people }
  }

  it('each person has a grant of its own: one changed, the others not', () => {
    const { access, people, inv } = group()
    expect(people[0].grant).not.toBe(people[1].grant)
    expect(people[0].grant.projects).not.toBe(inv.grant.projects)
    access.change({ person: people[0].hash }, { project: 'ws-a', on: false })
    expect(people.map((p) => p.grant.projects)).toEqual([['ws-b'], ['ws-a', 'ws-b'], ['ws-a', 'ws-b']])
    expect(inv.grant.projects).toEqual(['ws-a', 'ws-b'])
    expect(access.publicInvite(inv)).toMatchObject({ uses: 3, joined: 3 })
  })

  it('an edit takes away what it no longer gives (by default), and gives what it now gives only when asked', () => {
    const { access, people, inv, changes } = group()
    changes.length = 0
    const r = access.updateInvite(inv.id, { projects: ['ws-b', 'ws-c'], rights: { open: true } })
    expect(r).toEqual({ ok: true, applied: 3 })
    expect(changes).toContain('grants')
    expect(people.map((p) => p.grant)).toEqual(people.map(() => ({ projects: ['ws-b'], rights: NONE })))
    // Now asked to give the additions too.
    access.updateInvite(inv.id, { projects: ['ws-b', 'ws-c', 'ws-a'], rights: { open: true, close: true } }, { applyRemovals: true, applyAdditions: true })
    expect(people.map((p) => p.grant)).toEqual(people.map(() => ({ projects: ['ws-b', 'ws-a'], rights: { ...NO_RIGHTS, type: false, open: false, close: true } })))
    // Neither: the invitation changes, its people do not.
    expect(access.updateInvite(inv.id, { projects: [] }, { applyRemovals: false })).toEqual({ ok: true, applied: 0 })
    expect(people[0].grant.projects).toEqual(['ws-b', 'ws-a'])
  })

  it('revoking keeps its people (their code too) unless they are removed', () => {
    const { access, people, inv } = group()
    const sid = access.codeOf(inv.id).sid
    const r = access.revokeInvite(inv.id)
    expect(r.ok).toBe(true)
    expect(r.people.sort()).toEqual(people.map((p) => p.hash).sort())
    expect(access.invites()).toEqual([])
    expect(access.hasCode(sid)).toBe(true)
    for (const p of people) access.removePerson(p.hash)
    expect(access.hasCode(sid)).toBe(false)
    expect(access.viaOf(people[0])).toEqual({ id: null, label: 'Dev team' })
  })
})

describe('people and trust', () => {
  it('trusting a person links its grant to the trusted entry: changed from either side, one place', () => {
    const trust = createTrustStore()
    const { access, changes } = model({ trust })
    const identity = key()
    const p = access.addPerson({ key: key(), name: 'Simpa', sid: 's', identity, grant: { projects: ['ws-a'], rights: { type: true } } })
    const e = access.trustPerson(p.hash)
    expect(e.fp).toBe(identityFingerprint(identity))
    expect(access.grantOf(p)).toBe(trust.get(e.fp).grant)
    changes.length = 0
    expect(access.change({ person: p.hash }, { project: 'ws-b', on: true })).toBe(true)
    expect(trust.get(e.fp).grant.projects).toEqual(['ws-a', 'ws-b'])
    expect(access.change({ trust: e.fp }, { right: 'open', on: true })).toBe(true)
    expect(access.effective(p).rights).toEqual({ ...NO_RIGHTS, type: true, open: true, close: false })
    expect(changes).toContain('grants')
    // A person without an identity key (an older Tessel) can't be trusted.
    const old = access.addPerson({ key: key(), name: 'Old', sid: 's', grant: { projects: [] } })
    expect(access.trustPerson(old.hash)).toBe(null)
  })

  it('no longer trusted: its people go (to come back, the host’s yes again), with its counts', () => {
    const trust = createTrustStore()
    const { access } = model({ trust })
    const other = access.addPerson({ key: key(), name: 'Bea', sid: 's', grant: {} })
    const p = access.addPerson({ key: key(), name: 'Simpa', sid: 's', identity: key(), grant: { projects: ['ws-a'], rights: { close: true } } })
    const e = access.trustPerson(p.hash)
    access.trustCounters(e.fp).opened = 5
    expect(access.untrust(e.fp)).toEqual({ people: [p.hash] })
    expect(trust.list()).toEqual([])
    expect(access.people()).toEqual([other])
    expect(access.toJSON().counters).toEqual([])
    expect(access.untrust(e.fp)).toBe(null)
  })

  it('a trusted identity has one person entry: each join takes it over (new reconnect key), its counts and uses are its identity’s', () => {
    const trust = createTrustStore()
    const { access } = model({ trust })
    const identity = key()
    const e = trust.add({ key: identity, name: 'Simpa', projects: ['ws-a'] })
    const inv = access.createInvite({ maxUses: 2 }).invite
    const sid = access.codeOf(inv.id).sid
    const first = access.claimTrusted(e.fp, { key: key(), name: 'Simpa', sid, via: inv.id, identity })
    expect(first.replaced).toEqual([])
    access.countersOf(first.person).opened = 7
    expect(access.usedBy(inv, e.fp)).toBe(false)
    const again = access.claimTrusted(e.fp, { key: key(), name: 'Simpa 2', sid, via: inv.id, identity })
    expect(again.person).toBe(first.person)
    expect(again.replaced).toHaveLength(1)
    expect(access.people()).toHaveLength(1)
    expect(access.countersOf(again.person).opened).toBe(7)
    // The same invitation again: no new use (two uses would have used it up).
    access.usedBy(inv, e.fp)
    access.usedBy(inv, e.fp)
    expect(inv.uses).toBe(1)
    // Its counts are kept with the share.
    const next = model({ trust, saved: access.toJSON() })
    expect(next.access.trustCounters(e.fp)).toMatchObject({ opened: 7, invites: [inv.id] })
  })

  it('a trusted identity never pushes out someone the host let in; only the host’s own noes, across two invitations, pause every invitation', () => {
    const trust = createTrustStore()
    const online = new Set()
    const { access, clock } = model({ trust, online })
    const inv = access.createInvite({}).invite
    const sid = access.codeOf(inv.id).sid
    for (let i = 0; i < MAX_PEOPLE; i++) access.addPerson({ key: key(), name: `p${i}`, sid, grant: {} })
    const identity = key()
    const e = trust.add({ key: identity, name: 'Simpa' })
    expect(access.claimTrusted(e.fp, { key: key(), name: 'Simpa', sid, via: inv.id, identity })).toBe(null)
    expect(access.people()).toHaveLength(MAX_PEOPLE)
    const b = access.createInvite({}).invite
    // Guests leaving or turned away pause their own invitation only.
    for (let i = 0; i < 5; i++) access.noteDenied(inv.id)
    expect(access.pausing(inv.id)).toBe(true)
    expect(access.pausingAll()).toBe(false)
    // The host's own noes, all for one invitation: still not every one.
    for (let i = 0; i < 3; i++) access.noteDenied(inv.id, { byHost: true })
    expect(access.pausingAll()).toBe(false)
    // One for another invitation too: every invitation pauses a while.
    access.noteDenied(b.id, { byHost: true })
    expect(access.pausingAll()).toBe(true)
    clock.now += 30001
    expect(access.pausingAll()).toBe(false)
  })

  it('a trusted person’s projects stay when they are not shared (seen again when shared); a person’s and an invitation’s go', () => {
    const trust = createTrustStore()
    const { access, sharedSet } = model({ trust })
    const inv = access.createInvite({ projects: ['ws-a', 'ws-b'], later: true }).invite
    const fixed = access.createInvite({ projects: ['ws-a'] }).invite
    const plain = access.addPerson({ key: key(), name: 'Bea', sid: 's', grant: { projects: ['ws-a', 'ws-b'] } })
    const t = access.addPerson({ key: key(), name: 'Simpa', sid: 's', identity: key(), grant: { projects: ['ws-a', 'ws-b'] } })
    access.trustPerson(t.hash)
    sharedSet.ids = new Set(['ws-a'])
    access.sharedChanged(['ws-a'])
    expect(plain.grant.projects).toEqual(['ws-a'])
    expect(inv.grant.projects).toEqual(['ws-a'])
    expect(access.grantOf(t).projects).toEqual(['ws-a', 'ws-b'])
    expect([...access.effective(t).projects]).toEqual(['ws-a'])
    // Shared again: the trusted one sees it at once; the person does not;
    // the invitation that takes projects shared later offers it.
    sharedSet.ids = new Set(['ws-a', 'ws-b', 'ws-c'])
    access.sharedChanged(['ws-a', 'ws-b', 'ws-c'])
    expect([...access.effective(t).projects]).toEqual(['ws-a', 'ws-b'])
    expect(plain.grant.projects).toEqual(['ws-a'])
    expect(inv.grant.projects).toEqual(['ws-a', 'ws-b', 'ws-c'])
    expect(fixed.grant.projects).toEqual(['ws-a'])
    // Setting a trusted person's projects from the share keeps those not shared.
    sharedSet.ids = new Set(['ws-a'])
    access.sharedChanged(['ws-a'])
    access.setGrant({ person: t.hash }, { projects: [] })
    expect(access.grantOf(t).projects).toEqual(['ws-b'])
  })

  it('a project is given only while shared; ids and rights are checked', () => {
    const { access } = model()
    const p = access.addPerson({ key: key(), name: 'Bea', sid: 's', grant: { projects: [] } })
    expect(access.change({ person: p.hash }, { project: 'ws-z', on: true })).toBe(false)
    expect(access.change({ person: p.hash }, { project: '../x', on: true })).toBe(false)
    expect(access.change({ person: p.hash }, { right: 'files', on: true })).toBe(false)
    expect(access.change({ person: p.hash }, { right: '__proto__', on: true })).toBe(false)
    expect(access.change({ person: 'nobody' }, { project: 'ws-a', on: true })).toBe(false)
    expect(access.change({ person: p.hash }, { project: 'ws-a', on: true })).toBe(true)
    expect(access.change({ person: p.hash }, { project: 'ws-a', on: true })).toBe(true) // twice: the same
    expect(p.grant.projects).toEqual(['ws-a'])
  })

  it('people offline for 30 days are forgotten (with the codes only they needed); at most MAX_PEOPLE', () => {
    const online = new Set()
    const { access, clock } = model({ online })
    const inv = access.createInvite({}).invite
    const sid = access.codeOf(inv.id).sid
    const a = access.addPerson({ key: key(), name: 'A', sid, grant: {} })
    const b = access.addPerson({ key: key(), name: 'B', sid, grant: {} })
    online.add(b.hash)
    clock.now += OFFLINE_KEEP_MS + 1
    access.forgetOld()
    expect(access.people().map((p) => p.name)).toEqual(['B'])
    expect(access.personById(personId(b.hash))).toBe(b)
    expect(access.personById(personId(a.hash))).toBe(null)
    // Full: the one offline the longest makes room (the ones online stay).
    for (let i = 0; i < MAX_PEOPLE - 1; i++) {
      clock.now += 1
      access.addPerson({ key: key(), name: `p${i}`, sid, grant: {} })
    }
    expect(access.people()).toHaveLength(MAX_PEOPLE)
    access.addPerson({ key: key(), name: 'late', sid, grant: {} })
    expect(access.people()).toHaveLength(MAX_PEOPLE)
    expect(access.people().map((p) => p.name)).toEqual(expect.arrayContaining(['B', 'late']))
    expect(access.people().some((p) => p.name === 'p0')).toBe(false)
  })
})

describe('saving and taking a share back', () => {
  it('keeps invitations (no expiry as null), codes, people and their counts, each invitation’s block', () => {
    const trust = createTrustStore()
    const { access, clock } = model({ trust })
    const never = access.createInvite({ label: 'Dev team', lifetime: 'never', projects: ['ws-a'], rights: { type: true } }).invite
    const hour = access.createInvite({ label: 'Simpa', maxUses: 1 }).invite
    for (let i = 0; i < UNFINISHED_MAX; i++) access.noteUnfinished(hour.id)
    const p = access.addPerson({ key: key(), name: 'Ann', sid: access.codeOf(never.id).sid, via: never.id, identity: key(), grant: never.grant })
    p.opened = 5
    p.opens = [clock.now - 1000]
    const saved = JSON.parse(JSON.stringify(access.toJSON()))
    expect(saved.invites.find((i) => i.id === never.id).expiresAt).toBe(null)
    expect(JSON.stringify(saved)).not.toContain('undefined')
    clock.now += 5000
    const next = model({ trust, saved })
    const back = next.access.invite(never.id)
    expect(back).toMatchObject({ label: 'Dev team', lifetime: 'never', expiresAt: null, grant: { projects: ['ws-a'], rights: { ...NO_RIGHTS, type: true, open: false, close: false } } })
    expect(next.access.codeOf(never.id).path).toBe(access.codeOf(never.id).path)
    expect(next.access.usable(next.access.invite(hour.id))).toBe('blocked')
    const ann = next.access.person(p.hash)
    expect(ann).toMatchObject({ name: 'Ann', opened: 5, via: never.id, idfp: identityFingerprint(p.identity) })
    // No expiry, a long time later and after a restart: still good.
    next.clock.now += 400 * 24 * 3600 * 1000
    next.access.prune()
    expect(next.access.usable(next.access.invite(never.id))).toBe(null)
  })

  it('what a saved share had that is not shared any more is no one’s (shared again, not given back)', () => {
    const { access } = model({ shared: ['ws-a', 'ws-b'] })
    const inv = access.createInvite({ projects: ['ws-a', 'ws-b'] }).invite
    access.addPerson({ key: key(), name: 'Ann', sid: access.codeOf(inv.id).sid, grant: { projects: ['ws-a', 'ws-b'] } })
    const next = model({ shared: ['ws-a'], saved: access.toJSON() })
    expect(next.access.invite(inv.id).grant.projects).toEqual(['ws-a'])
    expect(next.access.people()[0].grant.projects).toEqual(['ws-a'])
  })

  it('a share taken back: a person whose trust is gone meanwhile is gone too', () => {
    const trust = createTrustStore()
    const { access } = model({ trust })
    const sid = access.codeOf(access.createInvite({}).invite.id).sid
    const p = access.addPerson({ key: key(), name: 'Simpa', sid, identity: key(), grant: {} })
    access.addPerson({ key: key(), name: 'Bea', sid, grant: {} })
    access.trustPerson(p.hash)
    const saved = access.toJSON()
    const next = model({ trust: createTrustStore(), saved })
    expect(next.access.people().map((x) => x.name)).toEqual(['Bea'])
  })

  it('a saved share is checked: bad codes, invitations and people are dropped', () => {
    const { access } = model()
    const inv = access.createInvite({}).invite
    access.addPerson({ key: key(), name: 'Ann', sid: access.codeOf(inv.id).sid, grant: {} })
    const saved = access.toJSON()
    saved.codes.push({ secret: 'short', path: 'x', invite: inv.id }, { secret: crypto.randomBytes(32).toString('base64'), path: '../../x', invite: null })
    saved.invites.push({ id: 'iv-bad', sid: 'nope', lifetime: 'hour' }, { ...saved.invites[0], id: 'iv-1111111111', lifetime: 'forever' })
    saved.people.push({ key: 'AAAA', sid: saved.people[0].sid, name: 'x' }, { ...saved.people[0], key: key().toString('base64'), sid: 'unknown' })
    const next = model({ saved })
    expect(next.access.invites().map((i) => i.id)).toEqual([inv.id])
    expect(next.access.toJSON().codes).toHaveLength(1)
    expect(next.access.people().map((p) => p.name)).toEqual(['Ann'])
  })

  it('a share saved before invitations: its one code is a root invitation offering every shared project, its earlier secrets kept for its guests', () => {
    const secret = crypto.randomBytes(32)
    const earlier = crypto.randomBytes(32)
    const unused = crypto.randomBytes(32)
    const alex = key()
    const sam = key()
    const legacy = {
      secret,
      expiresAt: 2_000_000,
      secrets: [earlier, unused],
      guard: { blocked: true, unfinished: [999_000] },
      known: [
        { key: alex.toString('base64'), name: 'Alex', rights: { type: true }, projects: ['ws-a'], sid: secretId(secret), opened: 3, lastSeen: 1_000_000 },
        { key: sam.toString('base64'), name: 'Sam', rights: {}, projects: ['ws-b', 'ws-gone'], sid: secretId(earlier), lastSeen: 1_000_000 }
      ]
    }
    const { access } = model({ legacy })
    const [root] = access.invites()
    expect(root).toMatchObject({ root: true, label: '', later: true, expiresAt: 2_000_000, grant: { projects: ['ws-a', 'ws-b'], rights: NONE } })
    expect(access.usable(root)).toBe('blocked')
    expect(access.codesAt('').map((c) => c.sid).sort()).toEqual([secretId(secret), secretId(earlier)].sort())
    const people = access.people()
    expect(people.map((p) => [p.name, p.via, p.grant.projects])).toEqual([
      ['Alex', root.id, ['ws-a']],
      ['Sam', null, ['ws-b']]
    ])
    expect(access.person(keyHash(alex)).opened).toBe(3)
  })
})

describe('the trusted people (shareTrust.js)', () => {
  it('kept by identity key, saved at every change, read back; weak keys refused; bounded', () => {
    let file = null
    const store = createTrustStore({ save: (entries) => (file = entries) })
    const k = key()
    const e = store.add({ key: k, name: ' Simpa ', projects: ['ws-a', 'x y'], rights: { type: true, files: true } })
    expect(e).toMatchObject({ fp: identityFingerprint(k), name: 'Simpa', grant: { projects: ['ws-a'], rights: { ...NO_RIGHTS, type: true, open: false, close: false } } })
    expect(store.add({ key: k, name: 'Again' })).toBe(e) // already trusted
    expect(store.add({ key: Buffer.alloc(32) })).toBe(null) // a weak key
    expect(store.add({ key: Buffer.alloc(5) })).toBe(null)
    expect(isTrustId(trustId(e.fp))).toBe(true)
    expect(store.byId(trustId(e.fp))).toBe(e)
    expect(store.byId('t-nope')).toBe(null)
    expect(file).toHaveLength(1)
    expect(JSON.stringify(file)).not.toMatch(/private/i)
    store.change(e.fp, { project: 'ws-b', on: true })
    store.change(e.fp, { right: 'close', on: true })
    expect(store.change(e.fp, { right: 'files', on: true })).toBe(false)
    store.rename(e.fp, 'Simpa (laptop)')
    const again = createTrustStore({ entries: file })
    expect(again.get(e.fp)).toMatchObject({ name: 'Simpa (laptop)', grant: { projects: ['ws-a', 'ws-b'], rights: { ...NO_RIGHTS, type: true, open: false, close: true } } })
    expect(again.remove(e.fp)).toBe(true)
    const many = createTrustStore()
    for (let i = 0; i < MAX_TRUSTED; i++) expect(many.add({ key: key(), name: `p${i}` })).not.toBe(null)
    expect(many.isFull()).toBe(true)
    expect(many.add({ key: key(), name: 'one more' })).toBe(null)
    // Projects: 64 at most, the 65th refused (never cut).
    const one = many.list()[0]
    for (let i = 0; i < MAX_TRUSTED_PROJECTS; i++) expect(many.change(one.fp, { project: `ws-${i}`, on: true })).toBe(true)
    expect(many.change(one.fp, { project: 'ws-x', on: true })).toBe(false)
    expect(many.setGrant(one.fp, { projects: Array.from({ length: 65 }, (_, i) => `p-${i}`) })).toBe(false)
    expect(one.grant.projects).toHaveLength(MAX_TRUSTED_PROJECTS)
    // A file with bad entries: they are left out.
    expect(createTrustStore({ entries: [{ key: 'AAAA' }, null, { key: Buffer.alloc(32).toString('base64') }] }).list()).toEqual([])
  })
})

describe('names, labels and the files that keep them', () => {
  it('names and labels lose what could make them read as something else (bidi overrides, zero-width, format characters)', async () => {
    const { cleanName } = await import('../liveShare/shareGrant')
    expect(cleanName('Simpa\u202Egnp.exe')).toBe('Simpagnp.exe')
    expect(cleanName('\u2066Dev\u2069 \u200Bteam\u200D\uFEFF')).toBe('Dev team')
    expect(cleanName('A\u00ADB\u2028C\u2029D\u0085E')).toBe('ABCDE')
    expect(cleanName('Équipe café ☕')).toBe('Équipe café ☕')
    const store = createTrustStore()
    expect(store.add({ key: key(), name: '\u202Eevil' }).name).toBe('evil')
  })

  it('a kept file says whether it is missing or unreadable (so it is never written over by mistake)', async () => {
    const fs = await import('fs')
    const os = await import('os')
    const { join } = await import('path')
    const { createKeptFile } = await import('../liveShare/sharePersist')
    const dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-kept-'))
    try {
      const file = createKeptFile(join(dir, 'sub', 'kept.json'))
      expect(file.read()).toEqual({ status: 'missing' })
      expect(file.write({ key: 'x' })).toBe(true)
      expect(file.read()).toEqual({ status: 'ok', data: { key: 'x', v: 1 } })
      fs.writeFileSync(join(dir, 'sub', 'kept.json'), '{ broken')
      expect(file.read()).toEqual({ status: 'unreadable' })
      fs.writeFileSync(join(dir, 'sub', 'kept.json'), JSON.stringify({ v: 2 }))
      expect(file.read()).toEqual({ status: 'unreadable' })
      // A temporary file left by a crash does not stop the next write.
      fs.writeFileSync(join(dir, 'sub', 'kept.json.tmp'), 'left over')
      expect(file.write({ key: 'y' })).toBe(true)
      expect(file.read().data.key).toBe('y')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
