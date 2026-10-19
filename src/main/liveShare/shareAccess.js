// Live Share, host side: who may get in, and what each one gets.
//
// One model for the whole share: shareHost.js asks it at every join and
// request, liveShare.js saves it (a restart takes it back), and the host's
// window shows views of it (invitations, people, trusted people, each
// project's people, the accept prompt). Each grant ({ projects, rights },
// shareGrant.js) is kept in one place only:
//
// - Invitations. Each one is a code of its own (its own secret, and its own
//   address on the share: /i/<path>, so a connection says which invitation
//   it uses before the handshake, and is counted against that one only),
//   with a label, a lifetime (an hour, a day, a week, or none: expiresAt
//   null, never by accident), an optional number of uses, and the grant it
//   offers: the projects and rights the accept prompt comes with (projects
//   shared later added to it when `later` is on). Every new guest still needs
//   the host's yes; only trusted people get in without it. Each invitation
//   has its own block (connections that got the host's keys and never got
//   in, see shareHost.js), its own pause after a no, and its own count of
//   guests turned away by a full room: one invitation blocked, expired,
//   used up or revoked never changes another. At most MAX_INVITES at once.
//   A code made before invitations existed (a share taken back after an
//   update, or a share made with one secret) is a root invitation, reached
//   at the address itself.
// - Codes. An invitation's current code, and the earlier ones (revoked,
//   expired, replaced by a new code) kept only while a person let in with it
//   needs it to come back (at most one per person: bounded).
// - People: the guests let in (each by the reconnect key it proved), with
//   their own grant, copied from the invitation and the host's answer when
//   they came in, changed one by one afterwards (two people of one
//   invitation never share one); or, for a trusted person, the trusted
//   grant itself (shareTrust.js), linked, not copied. A trusted person has
//   one person entry at most (each new join of its identity takes that entry
//   over, with the new reconnect key), and its counters (what it opened,
//   closed, asked, how often it joined, the invitations it used) belong to
//   its identity, not to a reconnect key: leaving and joining again resets
//   nothing, and a join with an invitation it used already is no new use.
//   The others' counters stay with them across their reconnects and a
//   restart. One offline for OFFLINE_KEEP_MS (30 days: a share is kept until
//   the host stops it, and its people come back whenever they can; Remove
//   is what keeps one out) is forgotten; at most
//   MAX_PEOPLE (a trusted person's join never pushes out someone the host
//   let in). No longer trusted: its people go (the host's yes again).
//
// A project taken out of the share is taken out of every invitation's and
// person's grant (shared again later, it is no one's until the host gives
// it); a trusted person's projects stay (seen again whenever shared).
// Besides each invitation's pause and waiting line, a few of the host's own
// noes in a row, for guests of two invitations or more, pause every
// invitation for a short while (pausingAll); a guest leaving or turned away
// pauses its own invitation only, so no code can pause the others.
// Nothing here touches the network: shareHost.js does.
import crypto from 'crypto'
import { cleanRights, isRightId, sameRights, setRight, withAgents, RIGHT_IDS } from '../../shared/liveShareRights'
import { sameAgentRule } from '../../shared/liveShareAgents'
import { cleanGrant, cleanName, cleanProjectIds, copyGrant, isProjectId } from './shareGrant.js'
import { KX_BYTES, identityFingerprint } from './shareCrypto.js'

export const LIFETIMES = Object.freeze({ hour: 60 * 60 * 1000, day: 24 * 60 * 60 * 1000, week: 7 * 24 * 60 * 60 * 1000, never: null })
export const DEFAULT_LIFETIME = 'hour'
export const INVITE_TTL_MS = LIFETIMES.hour
export const MAX_INVITES = 20
export const MAX_USES = 1000
export const MAX_PEOPLE = 64
export const OFFLINE_KEEP_MS = 30 * 24 * 60 * 60 * 1000
// Connections that got the host's keys and never got in, in 10 min, before
// an invitation is blocked.
export const UNFINISHED_MAX = 8
const UNFINISHED_MEMORY_MS = 10 * 60 * 1000
// Guests turned away by a full room in that time and not counted (a crowd);
// past that, counted like the others (someone keeping the room full can't
// try codes past the count).
export const ROOM_FULL_FREE = 30
// After a no: new guests of that invitation wait 15 s, doubled by each no of
// the last 10 min, up to 5 min.
const DENY_WAIT_MS = 15000
const DENY_WAIT_MAX_MS = 5 * 60 * 1000
const DENY_MEMORY_MS = 10 * 60 * 1000
// The host's noes in 10 min, for guests of GLOBAL_INVITES invitations at
// least, before every invitation pauses (15 s, doubled by each more, up to
// 5 min).
const GLOBAL_DENIALS = 3
const GLOBAL_INVITES = 2

export const secretId = (secret) => crypto.createHash('sha256').update('tessel-liveshare-secret').update(secret).digest('hex').slice(0, 16)
export const keyHash = (key) => crypto.createHash('sha256').update(key).digest('hex')
export const personId = (hash) => `k-${hash.slice(0, 24)}`
export const isInviteId = (id) => typeof id === 'string' && /^iv-[0-9a-f]{10}$/.test(id)
const newInviteId = () => `iv-${crypto.randomBytes(5).toString('hex')}`
const newPath = () => crypto.randomBytes(12).toString('base64url')
const isPath = (p) => typeof p === 'string' && /^[A-Za-z0-9_-]{16}$/.test(p)
const newSecret = () => crypto.randomBytes(32)
const times = (list, now, keepMs) => (Array.isArray(list) ? list.filter((x) => Number.isFinite(x) && now - x < keepMs) : [])
const recent = (list, now) => times(list, now, 60000).slice(-20)

// Where a connection asks to go (its request's target, a query aside): ''
// for the address itself (root invitations), the path of '/i/<path>', null
// for anything else.
export function pathOfUrl(url) {
  const pathname = String(url === undefined || url === null ? '/' : url).split(/[?#]/)[0]
  if (pathname === '/') return ''
  const m = /^\/i\/([A-Za-z0-9_-]{16})\/?$/.exec(pathname)
  return m ? m[1] : null
}

// An invitation as the host asks for it: { label, lifetime, maxUses,
// projects, later, rights }. Anything else is refused, never guessed: no
// lifetime the list does not have, and no "let them in without asking" (only
// trusted people get in without the host's yes).
export function cleanInviteSpec(spec, shared) {
  const s = spec && typeof spec === 'object' ? spec : {}
  if (s.autoAllow) return { error: 'auto-allow' }
  const lifetime = s.lifetime === undefined ? DEFAULT_LIFETIME : s.lifetime
  if (!Object.hasOwn(LIFETIMES, lifetime)) return { error: 'lifetime' }
  const maxUses = s.maxUses === undefined || s.maxUses === null ? 0 : s.maxUses
  if (!Number.isInteger(maxUses) || maxUses < 0 || maxUses > MAX_USES) return { error: 'uses' }
  return {
    label: cleanName(s.label),
    lifetime,
    maxUses,
    later: s.later === true,
    grant: { projects: cleanProjectIds(s.projects).filter((id) => shared.has(id)), rights: cleanRights(s.rights) }
  }
}

// now, trust (shareTrust.js), isOnline(hash): a person connected now,
// sharedIds(): the projects shared now (a Set), onChange(kind): 'invites',
// 'people' or 'grants' changed (shareHost.js refreshes the guests and saves),
// log. saved: what toJSON() gave (a restart). legacy: a share of one code
// (made with one secret, or saved before invitations): { secret, expiresAt,
// secrets (its earlier ones), known (its guests let in), knownAt, guard }.
export function createAccess({ now = Date.now, trust = null, isOnline = () => false, sharedIds = () => new Set(), onChange = () => {}, log = () => {}, saved = null, legacy = null } = {}) {
  const invites = new Map() // id -> invitation
  const codes = new Map() // sid -> { sid, secret, path ('' for a root one), invite (its id), label }
  const people = new Map() // key hash -> person
  // A trusted identity's counters (fingerprint -> counters), whoever its
  // reconnect key is; kept with the share.
  const fpCounters = new Map()
  let globalGuard = { denials: [], waitUntil: 0 } // denials: [time, invitation id]
  let shared = new Set(sharedIds())

  const changed = (kind) => {
    try {
      onChange(kind)
    } catch {
      /* a view going wrong never stops the change */
    }
  }
  const freshGuard = () => ({ blocked: false, unfinished: [], roomFull: [], denials: [], waitUntil: 0 })
  // The host's recent noes: [time, invitation id], the last 10 min.
  const hostDenials = (list) => (Array.isArray(list) ? list.filter((d) => Array.isArray(d) && Number.isFinite(d[0]) && now() - d[0] < DENY_MEMORY_MS && isInviteId(d[1])).slice(-50) : [])
  const guardOf = (g) => ({
    blocked: !!(g && g.blocked),
    unfinished: times(g && g.unfinished, now(), UNFINISHED_MEMORY_MS),
    roomFull: times(g && g.roomFull, now(), UNFINISHED_MEMORY_MS),
    denials: times(g && g.denials, now(), DENY_MEMORY_MS),
    waitUntil: Number.isFinite(g && g.waitUntil) ? g.waitUntil : 0
  })
  const expiryFor = (lifetime, from = now()) => (LIFETIMES[lifetime] === null ? null : from + (LIFETIMES[lifetime] || INVITE_TTL_MS))

  function addCode(secret, path, invite, label) {
    const sid = secretId(secret)
    codes.set(sid, { sid, secret, path, invite, label })
    return sid
  }
  function makeInvite(spec, { root = false, secret = newSecret(), expiresAt, createdAt = now(), uses = 0, guard = null, id = newInviteId() } = {}) {
    const inv = {
      id,
      label: spec.label,
      root,
      lifetime: spec.lifetime,
      createdAt,
      expiresAt: expiresAt === undefined ? expiryFor(spec.lifetime, createdAt) : expiresAt,
      maxUses: spec.maxUses,
      uses,
      grant: spec.grant,
      later: spec.later,
      sid: null,
      guard: guard ? guardOf(guard) : freshGuard()
    }
    inv.sid = addCode(secret, root ? '' : newPath(), inv.id, inv.label)
    invites.set(inv.id, inv)
    return inv
  }
  const counters = (c = {}) => ({
    opened: Math.max(0, c.opened | 0),
    opens: recent(c.opens, now()),
    closes: recent(c.closes, now()),
    joins: recent(c.joins, now()),
    invites: (Array.isArray(c.invites) ? c.invites : []).filter(isInviteId).slice(0, MAX_INVITES),
    rejoins: [],
    resyncs: [],
    openAsks: []
  })
  const entry = (p) => ({
    hash: p.hash,
    key: p.key,
    name: cleanName(p.name),
    sid: p.sid,
    via: isInviteId(p.via) ? p.via : null,
    viaLabel: cleanName(p.viaLabel),
    identity: p.identity || null,
    idfp: p.identity ? identityFingerprint(p.identity) : null,
    grant: cleanGrant(p.grant),
    trust: typeof p.trust === 'string' && /^[0-9a-f]{32}$/.test(p.trust) ? p.trust : null,
    opened: Math.max(0, p.opened | 0),
    lastSeen: Number.isFinite(p.lastSeen) ? p.lastSeen : now(),
    opens: recent(p.opens, now()),
    closes: recent(p.closes, now()),
    rejoins: [],
    resyncs: [],
    openAsks: []
  })
  // The time this Tessel was away (since the list was saved) does not count
  // as a person's time offline: one online then gets its full time to come
  // back, one already offline only what it had left.
  function restorePeople(list, knownAt, fill = (x) => x) {
    const away = Number.isFinite(knownAt) ? Math.max(0, now() - knownAt) : 0
    for (const k of Array.isArray(list) ? list : []) {
      if (people.size >= MAX_PEOPLE) break
      const key = k && typeof k.key === 'string' ? Buffer.from(k.key, 'base64') : null
      if (!key || key.length !== KX_BYTES || !codes.has(k.sid)) continue
      const identity = typeof k.identity === 'string' ? Buffer.from(k.identity, 'base64') : null
      const seen = Number.isFinite(k.lastSeen) ? Math.min(now(), k.lastSeen + away) : now()
      const hash = keyHash(key)
      people.set(hash, entry(fill({ ...k, hash, key, identity: identity && identity.length === KX_BYTES ? identity : null, lastSeen: seen })))
    }
  }

  if (saved && typeof saved === 'object') {
    for (const c of Array.isArray(saved.codes) ? saved.codes.slice(0, MAX_INVITES + MAX_PEOPLE) : []) {
      const secret = c && typeof c.secret === 'string' ? Buffer.from(c.secret, 'base64') : null
      if (!secret || secret.length !== 32 || !(c.path === '' || isPath(c.path))) continue
      addCode(secret, c.path, isInviteId(c.invite) ? c.invite : null, cleanName(c.label))
    }
    for (const i of Array.isArray(saved.invites) ? saved.invites.slice(0, MAX_INVITES) : []) {
      if (!i || !isInviteId(i.id) || invites.has(i.id) || !codes.has(i.sid) || !Object.hasOwn(LIFETIMES, i.lifetime)) continue
      const code = codes.get(i.sid)
      invites.set(i.id, {
        id: i.id,
        label: cleanName(i.label),
        root: code.path === '',
        lifetime: i.lifetime,
        createdAt: Number.isFinite(i.createdAt) ? i.createdAt : now(),
        // No expiry is said as null, and only null means it.
        expiresAt: i.expiresAt === null ? null : Number.isFinite(i.expiresAt) ? i.expiresAt : now(),
        maxUses: Number.isInteger(i.maxUses) && i.maxUses >= 0 && i.maxUses <= MAX_USES ? i.maxUses : 0,
        uses: Math.max(0, i.uses | 0),
        grant: cleanGrant(i.grant),
        later: i.later === true,
        sid: i.sid,
        guard: guardOf(i.guard)
      })
    }
    restorePeople(saved.people, saved.knownAt)
    for (const c of Array.isArray(saved.counters) ? saved.counters : []) {
      if (c && typeof c.fp === 'string' && /^[0-9a-f]{32}$/.test(c.fp) && trust && trust.get(c.fp)) fpCounters.set(c.fp, counters(c))
    }
    if (saved.guard && typeof saved.guard === 'object') globalGuard = { denials: hostDenials(saved.guard.denials), waitUntil: Number.isFinite(saved.guard.waitUntil) ? saved.guard.waitUntil : 0 }
  } else if (legacy && Buffer.isBuffer(legacy.secret) && legacy.secret.length === 32) {
    // One code: a root invitation offering every shared project (as the
    // prompt did), and its earlier secrets for the guests who need them.
    const expiresAt = Number.isFinite(legacy.expiresAt) ? legacy.expiresAt : undefined
    const root = makeInvite({ label: '', lifetime: DEFAULT_LIFETIME, maxUses: 0, later: true, grant: { projects: [...shared], rights: cleanRights(null) } }, { root: true, secret: legacy.secret, expiresAt, guard: legacy.guard })
    for (const s of Array.isArray(legacy.secrets) ? legacy.secrets : []) if (Buffer.isBuffer(s) && s.length === 32 && !codes.has(secretId(s))) addCode(s, '', null, '')
    restorePeople(legacy.known, legacy.knownAt, (k) => ({ ...k, grant: { projects: k.projects, rights: k.rights }, via: k.sid === root.sid ? root.id : null }))
  }
  // A share taken back: someone no longer trusted is gone (the host's yes
  // again); a project no longer shared is no invitation's or person's any
  // more (shared again later, no one gets it back by itself).
  for (const [hash, p] of [...people]) if (p.trust && !(trust && trust.get(p.trust))) people.delete(hash)
  for (const inv of invites.values()) inv.grant.projects = inv.grant.projects.filter((x) => shared.has(x))
  for (const p of people.values()) if (!p.trust) p.grant.projects = p.grant.projects.filter((x) => shared.has(x))
  pruneCodes()

  // --- Codes ----------------------------------------------------------------
  // Kept: every invitation's current code, and the earlier ones a person
  // needs to come back.
  function pruneCodes() {
    const keep = new Set([...invites.values()].map((i) => i.sid))
    for (const p of people.values()) keep.add(p.sid)
    for (const sid of [...codes.keys()]) if (!keep.has(sid)) codes.delete(sid)
  }
  // The codes a connection to this path may use (path: pathOfUrl's).
  function codesAt(path) {
    if (path === null) return []
    return [...codes.values()].filter((c) => c.path === path)
  }
  // The invitation a code is the current code of (null: an earlier code,
  // only good for coming back).
  const liveInvite = (code) => {
    const inv = code && code.invite ? invites.get(code.invite) : null
    return inv && inv.sid === code.sid ? inv : null
  }

  // --- Invitations ------------------------------------------------------------
  const expired = (inv) => inv.expiresAt !== null && now() > inv.expiresAt
  // Why an invitation lets no new guest in, or null.
  function usable(inv) {
    if (!inv || !invites.has(inv.id)) return 'revoked'
    if (inv.guard.blocked) return 'blocked'
    if (expired(inv)) return 'expired'
    if (inv.maxUses > 0 && inv.uses >= inv.maxUses) return 'used'
    return null
  }
  // Expired invitations go (their code kept while someone needs it).
  function prune() {
    const gone = [...invites.values()].filter(expired)
    for (const inv of gone) {
      invites.delete(inv.id)
      log(`invitation ${inv.id} expired`)
    }
    if (gone.length) {
      pruneCodes()
      changed('invites')
    }
    return gone.map((i) => i.id)
  }

  function createInvite(spec, { secret } = {}) {
    prune()
    const s = cleanInviteSpec(spec, shared)
    if (s.error) return { ok: false, reason: s.error }
    if (invites.size >= MAX_INVITES) return { ok: false, reason: 'full', max: MAX_INVITES }
    const inv = makeInvite(s, secret ? { secret } : {})
    log(`invitation ${inv.id} created (${inv.lifetime}${inv.maxUses ? `, ${inv.maxUses} use(s)` : ''})`)
    changed('invites')
    return { ok: true, invite: inv }
  }

  // An invitation changed. Its people (those who joined with it, not
  // trusted) get the projects and rights it no longer gives taken away when
  // applyRemovals, and the new ones when applyAdditions. lifetime: a new
  // lifetime from now; maxUses below its uses: used up.
  function updateInvite(id, patch = {}, { applyRemovals = true, applyAdditions = false } = {}) {
    const inv = invites.get(id)
    if (!inv) return { ok: false, reason: 'missing' }
    const p = patch && typeof patch === 'object' ? patch : {}
    if (p.autoAllow) return { ok: false, reason: 'auto-allow' }
    if (p.lifetime !== undefined && !Object.hasOwn(LIFETIMES, p.lifetime)) return { ok: false, reason: 'lifetime' }
    if (p.maxUses !== undefined && !(Number.isInteger(p.maxUses) && p.maxUses >= 0 && p.maxUses <= MAX_USES)) return { ok: false, reason: 'uses' }
    const before = copyGrant(inv.grant)
    if (p.label !== undefined) inv.label = cleanName(p.label)
    if (p.later !== undefined) inv.later = p.later === true
    if (p.maxUses !== undefined) inv.maxUses = p.maxUses
    if (p.lifetime !== undefined) {
      inv.lifetime = p.lifetime
      inv.expiresAt = expiryFor(p.lifetime)
    }
    if (p.projects !== undefined) inv.grant.projects = cleanProjectIds(p.projects).filter((x) => shared.has(x))
    if (p.rights !== undefined) inv.grant.rights = cleanRights(p.rights)
    const applied = applyToPeople(id, before, inv.grant, { applyRemovals, applyAdditions })
    codes.get(inv.sid).label = inv.label
    log(`invitation ${id} changed${applied ? ` (and ${applied} of its people)` : ''}`)
    changed(applied ? 'grants' : 'invites')
    return { ok: true, applied }
  }
  // The difference between two grants of an invitation, made to its people.
  function applyToPeople(id, before, after, { applyRemovals, applyAdditions }) {
    const removed = before.projects.filter((x) => !after.projects.includes(x))
    const added = after.projects.filter((x) => !before.projects.includes(x))
    const off = RIGHT_IDS.filter((r) => before.rights[r] && !after.rights[r])
    const on = RIGHT_IDS.filter((r) => !before.rights[r] && after.rights[r])
    // A changed agents rule may take agents or models away: its people take
    // it with what is taken away.
    const agentsChanged = !sameAgentRule(before.rights.agents, after.rights.agents)
    let applied = 0
    for (const person of people.values()) {
      if (person.via !== id || person.trust) continue
      const g = person.grant
      let projects = [...g.projects]
      const rights = { ...g.rights }
      if (applyRemovals) {
        projects = projects.filter((x) => !removed.includes(x))
        for (const r of off) rights[r] = false
        if (agentsChanged) {
          delete rights.agents
          if (after.rights.agents) rights.agents = after.rights.agents
        }
      }
      if (applyAdditions) {
        for (const x of added) if (!projects.includes(x) && shared.has(x)) projects.push(x)
        for (const r of on) rights[r] = true
      }
      if (projects.length === g.projects.length && projects.every((x) => g.projects.includes(x)) && sameRights(rights, g.rights)) continue
      person.grant = cleanGrant({ projects, rights })
      applied++
    }
    return applied
  }

  // No one new gets in with it; its people stay (their code kept for them),
  // unless the caller removes them (the hashes of its people are returned).
  function revokeInvite(id) {
    const inv = invites.get(id)
    if (!inv) return { ok: false, reason: 'missing' }
    invites.delete(id)
    pruneCodes()
    log(`invitation ${id} revoked`)
    changed('invites')
    return { ok: true, people: [...people.values()].filter((p) => p.via === id).map((p) => p.hash) }
  }

  // A new code for an invitation (its label, grant and uses kept): the old
  // one lets no new guest in (its people come back with it), the block is
  // lifted, and its lifetime starts again (none stays none).
  function rotateInvite(id, { secret = newSecret() } = {}) {
    const inv = invites.get(id)
    if (!inv) return { ok: false, reason: 'missing' }
    inv.sid = addCode(secret, inv.root ? '' : newPath(), inv.id, inv.label)
    inv.guard = freshGuard()
    inv.expiresAt = expiryFor(inv.lifetime)
    pruneCodes()
    log(`invitation ${id}: new code`)
    changed('invites')
    return { ok: true }
  }

  function duplicateInvite(id) {
    const inv = invites.get(id)
    if (!inv) return { ok: false, reason: 'missing' }
    return createInvite({ label: inv.label, lifetime: inv.lifetime, maxUses: inv.maxUses, later: inv.later, projects: inv.grant.projects, rights: inv.grant.rights })
  }

  // A guest let in with it.
  function used(inv) {
    inv.uses++
    changed('invites')
    return usable(inv) === 'used'
  }

  // --- Each invitation's block, pause and full room ---------------------------
  // A connection that got the host's keys and never got in: true when that
  // blocks the invitation.
  function noteUnfinished(id) {
    const inv = invites.get(id)
    if (!inv) return false
    const t = now()
    inv.guard.unfinished = [...times(inv.guard.unfinished, t, UNFINISHED_MEMORY_MS), t]
    if (inv.guard.blocked || inv.guard.unfinished.length < UNFINISHED_MAX) return false
    inv.guard.blocked = true
    log(`invitation ${id} blocked: connections stopped after the handshake`)
    changed('invites')
    return true
  }
  // A guest turned away by a full room: true while it is not counted.
  function noteRoomFull(id) {
    const inv = invites.get(id)
    if (!inv) return true
    const t = now()
    inv.guard.roomFull = [...times(inv.guard.roomFull, t, UNFINISHED_MEMORY_MS), t]
    return inv.guard.roomFull.length <= ROOM_FULL_FREE
  }
  // A no (or a guest who left while waiting, or one removed): that
  // invitation's new guests wait a while.
  // byHost: the host's own no (it may pause every invitation); a guest that
  // left, was removed or waited too long pauses its own invitation only.
  function noteDenied(id, { byHost = false } = {}) {
    const t = now()
    const inv = invites.get(id)
    if (byHost && inv) {
      globalGuard.denials = [...hostDenials(globalGuard.denials), [t, id]]
      const n = globalGuard.denials.length
      const spread = new Set(globalGuard.denials.map((d) => d[1])).size
      if (n >= GLOBAL_DENIALS && spread >= GLOBAL_INVITES) globalGuard.waitUntil = t + Math.min(DENY_WAIT_MAX_MS, DENY_WAIT_MS * 2 ** (n - GLOBAL_DENIALS))
    }
    if (!inv) return
    inv.guard.denials = [...times(inv.guard.denials, t, DENY_MEMORY_MS), t]
    inv.guard.waitUntil = t + Math.min(DENY_WAIT_MAX_MS, DENY_WAIT_MS * 2 ** (inv.guard.denials.length - 1))
  }
  const pausing = (id) => {
    const inv = invites.get(id)
    return !!inv && now() < inv.guard.waitUntil
  }
  // A few noes in a row (any invitations): every invitation pauses.
  const pausingAll = () => now() < globalGuard.waitUntil

  // --- People -----------------------------------------------------------------
  const trusted = (p) => (p && p.trust && trust ? trust.get(p.trust) : null)
  // What a person gets: a trusted one, the trusted grant (linked); the
  // others, their own.
  const grantOf = (p) => (trusted(p) ? trusted(p).grant : p.grant)
  // What it sees now: its projects that are shared now, and its rights.
  function effective(p) {
    const g = grantOf(p)
    return { projects: new Set(g.projects.filter((x) => shared.has(x))), rights: cleanRights(g.rights) }
  }

  // A guest let in: its reconnect key, name, the code it came with, its
  // invitation, its identity key (null: an older Tessel) and its grant, or
  // the fingerprint of the trusted person it is.
  function addPerson({ key, name, sid, via = null, identity = null, grant, trust: fp = null }) {
    const hash = keyHash(key)
    if (people.size >= MAX_PEOPLE && !people.has(hash) && !forgetOldest()) return null
    const inv = via ? invites.get(via) : null
    const person = entry({ hash, key, name, sid, via, viaLabel: inv ? inv.label : '', identity, grant, trust: fp, opened: 0, lastSeen: now() })
    people.set(hash, person)
    changed('people')
    return person
  }
  // The one offline the longest makes room (onlyTrusted: only a trusted
  // one's entry, which costs it nothing: it comes back with a join). False
  // when there is none.
  function forgetOldest({ onlyTrusted = false } = {}) {
    const offline = [...people.values()].filter((p) => !isOnline(p.hash) && (!onlyTrusted || p.trust)).sort((a, b) => a.lastSeen - b.lastSeen)
    if (!offline[0]) return false
    people.delete(offline[0].hash)
    return true
  }
  // A trusted identity joining: its person entry (taken over with this
  // reconnect key, its invitation and name), or a new one. Any other entry of
  // that identity goes. { person, replaced: hashes of the entries that went
  // (their connections end) }, or null when there is no room (a trusted
  // join never pushes out someone the host let in).
  function claimTrusted(fp, { key, name, sid, via, identity }) {
    const mine = [...people.values()].filter((p) => p.trust === fp || p.idfp === fp).sort((a, b) => b.lastSeen - a.lastSeen)
    const replaced = mine.map((p) => p.hash)
    const hash = keyHash(key)
    const inv = via ? invites.get(via) : null
    let person = mine[0] || null
    for (const p of mine) people.delete(p.hash)
    if (person) {
      Object.assign(person, { hash, key, name: cleanName(name), sid, via, viaLabel: inv ? inv.label : '', identity, idfp: identityFingerprint(identity), trust: fp, lastSeen: now() })
    } else {
      if (people.size >= MAX_PEOPLE && !forgetOldest({ onlyTrusted: true })) return null
      person = entry({ hash, key, name, sid, via, viaLabel: inv ? inv.label : '', identity, grant: null, trust: fp, lastSeen: now() })
    }
    people.set(hash, person)
    pruneCodes()
    changed('people')
    return { person, replaced }
  }
  // Where a person's counters are: a trusted one's are its identity's.
  function trustCounters(fp) {
    if (!fpCounters.has(fp)) fpCounters.set(fp, counters())
    return fpCounters.get(fp)
  }
  const countersOf = (p) => (trusted(p) ? trustCounters(p.trust) : p)
  // A trusted identity let in with an invitation: one use, the first time.
  function usedBy(inv, fp) {
    const c = trustCounters(fp)
    if (c.invites.includes(inv.id)) return usable(inv) === 'used'
    c.invites = [...c.invites, inv.id].slice(-MAX_INVITES)
    return used(inv)
  }
  // A trusted identity joining with an invitation it never used: the shared
  // projects that invitation offers become its trusted entry's too (kept:
  // trust is standing access). Without this, a trusted person whose entry
  // still listed only a project of an earlier share saw nothing of a new
  // share, whatever the code it was sent offered (2026-10-19). Its rights
  // stay the trusted entry's (the host set them for that person), and a
  // project the host takes away later does not come back with the same
  // invitation (only its first use adds). Called before usedBy notes it.
  function trustedInviteProjects(inv, fp) {
    const e = trust && trust.get(fp)
    if (!e || !inv || trustCounters(fp).invites.includes(inv.id)) return false
    const add = inv.grant.projects.filter((x) => shared.has(x) && !e.grant.projects.includes(x))
    if (!add.length) return false
    return trust.setGrant(fp, { projects: [...e.grant.projects, ...add] })
  }
  const personByHash = (hash) => people.get(hash) || null
  const personById = (id) => [...people.values()].find((p) => personId(p.hash) === id) || null
  function removePerson(hash) {
    if (!people.delete(hash)) return false
    pruneCodes()
    changed('people')
    return true
  }
  // People offline for more than OFFLINE_KEEP_MS are forgotten (a trusted
  // one comes back with a new join).
  function forgetOld() {
    let gone = false
    for (const [hash, p] of [...people]) {
      // Linked to a trusted entry that is gone: not let in by itself any more.
      const staleTrust = !!p.trust && !(trust && trust.get(p.trust)) && !isOnline(hash)
      if (!staleTrust && (isOnline(hash) || now() - p.lastSeen <= OFFLINE_KEEP_MS)) continue
      people.delete(hash)
      gone = true
    }
    if (gone) {
      pruneCodes()
      changed('people')
    }
  }

  // --- Changing what someone gets (one place for each grant) ---------------------
  // subject: { person } (its hash), { trust } (a fingerprint) or { invite }
  // (an id). change: { project, on }, { right, on } or { agents } (its agents
  // rule; null: the share's setting counts). A trusted person's change is the
  // trusted entry's, whoever it is made through.
  function change(subject, { project, right, on, ...rest } = {}) {
    if (Object.hasOwn(rest, 'agents')) return changeAgents(subject, rest.agents)
    const byProject = project !== undefined
    if (byProject ? !isProjectId(project) : !isRightId(right)) return false
    if (subject.invite) {
      const inv = invites.get(subject.invite)
      if (!inv || (byProject && on && !shared.has(project))) return false
      if (byProject) inv.grant.projects = on ? cleanProjectIds([...inv.grant.projects, project]) : inv.grant.projects.filter((x) => x !== project)
      else inv.grant.rights = setRight(inv.grant.rights, right, on)
      changed('invites')
      return true
    }
    const fp = subject.trust || (subject.person && trusted(people.get(subject.person)) ? people.get(subject.person).trust : null)
    if (fp) {
      if (!trust || !trust.get(fp)) return false
      // A trusted person may be given a project shared now only.
      if (byProject && on && !shared.has(project)) return false
      const ok = trust.change(fp, byProject ? { project, on } : { right, on })
      if (ok) changed('grants')
      return ok
    }
    const p = subject.person ? people.get(subject.person) : null
    if (!p || (byProject && on && !shared.has(project))) return false
    if (byProject) p.grant.projects = on ? cleanProjectIds([...p.grant.projects, project]) : p.grant.projects.filter((x) => x !== project)
    else p.grant.rights = setRight(p.grant.rights, right, on)
    changed('grants')
    return true
  }
  function changeAgents(subject, rule) {
    if (subject.invite) {
      const inv = invites.get(subject.invite)
      if (!inv) return false
      inv.grant.rights = withAgents(inv.grant.rights, rule)
      changed('invites')
      return true
    }
    const fp = subject.trust || (subject.person && trusted(people.get(subject.person)) ? people.get(subject.person).trust : null)
    if (fp) {
      const ok = !!trust && trust.change(fp, { agents: rule })
      if (ok) changed('grants')
      return ok
    }
    const p = subject.person ? people.get(subject.person) : null
    if (!p) return false
    p.grant.rights = withAgents(p.grant.rights, rule)
    changed('grants')
    return true
  }
  // A person's whole grant (projects: shared ones only).
  function setGrant(subject, { projects, rights } = {}) {
    const fp = subject.trust || (subject.person && trusted(people.get(subject.person)) ? people.get(subject.person).trust : null)
    const clean = projects === undefined ? undefined : cleanProjectIds(projects).filter((x) => shared.has(x))
    if (fp) {
      // Its projects not shared now stay (trust is standing access).
      const e = trust && trust.get(fp)
      const kept = clean === undefined || !e ? clean : [...clean, ...e.grant.projects.filter((x) => !shared.has(x))]
      if (!trust || !trust.setGrant(fp, { projects: kept, rights })) return false
      changed('grants')
      return true
    }
    const p = subject.person ? people.get(subject.person) : null
    if (!p) return false
    if (clean !== undefined) p.grant.projects = clean
    if (rights !== undefined) p.grant.rights = cleanRights(rights)
    changed('grants')
    return true
  }

  // --- Trust --------------------------------------------------------------------
  // Trusts a person let in (it has an identity key): from now on its grant is
  // the trusted entry's (made from its own).
  function trustPerson(hash) {
    const p = people.get(hash)
    if (!p || !p.identity || !trust) return null
    if (trusted(p)) return trusted(p)
    const e = trust.add({ key: p.identity, name: p.name, projects: p.grant.projects, rights: p.grant.rights })
    if (!e) return null
    // Its counters go on with its identity (nothing starts from zero).
    if (!fpCounters.has(e.fp)) fpCounters.set(e.fp, counters({ ...p, invites: p.via ? [p.via] : [] }))
    for (const q of people.values()) if (q.idfp === e.fp) q.trust = e.fp
    changed('grants')
    return e
  }
  // No longer trusted: the people it is go (their connections end, the
  // caller's): to come back, the host's yes again. -> { people: their
  // hashes } or null.
  function untrust(fp) {
    const e = trust && trust.get(fp)
    if (!e) return null
    const gone = [...people.values()].filter((p) => p.trust === fp).map((p) => p.hash)
    for (const hash of gone) people.delete(hash)
    fpCounters.delete(fp)
    trust.remove(fp)
    pruneCodes()
    changed('people')
    return { people: gone }
  }

  // --- The projects shared ----------------------------------------------------
  // The share's projects changed: one taken out is no invitation's or
  // person's any more (a trusted person keeps it); one added goes to the
  // invitations that take projects shared later. True when a grant changed.
  function sharedChanged(ids) {
    const next = new Set(ids)
    const removed = [...shared].filter((x) => !next.has(x))
    const added = [...next].filter((x) => !shared.has(x))
    shared = next
    if (!removed.length && !added.length) return false
    let invitesChanged = false
    let grantsChanged = false
    for (const inv of invites.values()) {
      const before = inv.grant.projects.length
      inv.grant.projects = inv.grant.projects.filter((x) => next.has(x))
      if (inv.later) inv.grant.projects = cleanProjectIds([...inv.grant.projects, ...added])
      if (inv.grant.projects.length !== before || (inv.later && added.length)) invitesChanged = true
    }
    for (const p of people.values()) {
      if (p.trust) continue
      const kept = p.grant.projects.filter((x) => next.has(x))
      if (kept.length === p.grant.projects.length) continue
      p.grant.projects = kept
      grantsChanged = true
    }
    if (grantsChanged) changed('grants')
    else if (invitesChanged) changed('invites')
    return grantsChanged
  }

  // --- Views --------------------------------------------------------------------
  const stateOf = (inv) => (inv.guard.blocked ? 'blocked' : inv.maxUses > 0 && inv.uses >= inv.maxUses ? 'used' : 'live')
  function publicInvite(inv) {
    return {
      id: inv.id,
      label: inv.label,
      root: inv.root,
      lifetime: inv.lifetime,
      createdAt: inv.createdAt,
      expiresAt: inv.expiresAt,
      maxUses: inv.maxUses,
      uses: inv.uses,
      projects: [...inv.grant.projects],
      later: inv.later,
      rights: { ...inv.grant.rights },
      state: stateOf(inv),
      joined: [...people.values()].filter((p) => p.via === inv.id).length
    }
  }
  const viaOf = (p) => (p.via ? { id: invites.has(p.via) ? p.via : null, label: invites.has(p.via) ? invites.get(p.via).label : p.viaLabel } : null)

  // --- Saving -----------------------------------------------------------------
  function toJSON() {
    return {
      invites: [...invites.values()].map((i) => ({ ...publicFields(i), guard: guardOf(i.guard) })),
      codes: [...codes.values()].map((c) => ({ secret: c.secret.toString('base64'), path: c.path, invite: c.invite, label: c.label })),
      people: [...people.values()].map((p) => ({
        key: p.key.toString('base64'),
        name: p.name,
        sid: p.sid,
        via: p.via,
        viaLabel: p.viaLabel,
        identity: p.identity ? p.identity.toString('base64') : null,
        // Its own grant (a trusted person has none: what it gets is its
        // trusted entry's, and nothing is left to it once that is gone).
        grant: p.trust ? { projects: [], rights: cleanRights(null) } : copyGrant(p.grant),
        trust: p.trust,
        opened: p.opened,
        lastSeen: isOnline(p.hash) ? now() : p.lastSeen,
        opens: [...p.opens],
        closes: [...p.closes]
      })),
      counters: [...fpCounters].filter(([fp]) => trust && trust.get(fp)).map(([fp, c]) => ({ fp, opened: c.opened, opens: [...c.opens], closes: [...c.closes], joins: [...c.joins], invites: [...c.invites] })),
      guard: { denials: hostDenials(globalGuard.denials), waitUntil: globalGuard.waitUntil },
      knownAt: now()
    }
  }
  const publicFields = (i) => ({ id: i.id, label: i.label, lifetime: i.lifetime, createdAt: i.createdAt, expiresAt: i.expiresAt, maxUses: i.maxUses, uses: i.uses, grant: copyGrant(i.grant), later: i.later, sid: i.sid })

  return {
    // codes and invitations
    codesAt,
    liveInvite,
    invite: (id) => invites.get(id) || null,
    invites: () => [...invites.values()],
    codeOf: (id) => (invites.get(id) ? codes.get(invites.get(id).sid) : null),
    hasCode: (sid) => codes.has(sid),
    // The secrets of the invitations that still let new guests in (not
    // expired, revoked, blocked or used up): their topics are where the share
    // says its address for a first join (shareRendezvous.js).
    liveSecrets: () => [...invites.values()].filter((inv) => !usable(inv) && codes.has(inv.sid)).map((inv) => codes.get(inv.sid).secret),
    usable,
    prune,
    createInvite,
    updateInvite,
    revokeInvite,
    rotateInvite,
    duplicateInvite,
    used,
    noteUnfinished,
    noteRoomFull,
    noteDenied,
    pausing,
    pausingAll,
    publicInvite,
    // people
    addPerson,
    claimTrusted,
    trustCounters,
    countersOf,
    usedBy,
    trustedInviteProjects,
    person: personByHash,
    personById,
    people: () => [...people.values()],
    removePerson,
    forgetOld,
    grantOf,
    effective,
    trustedOf: trusted,
    viaOf,
    // grants
    change,
    setGrant,
    trustPerson,
    untrust,
    sharedChanged,
    shared: () => new Set(shared),
    toJSON
  }
}
