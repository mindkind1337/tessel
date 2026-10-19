// Live Share, host side: views of the one access model main keeps
// (src/main/liveShare/shareAccess.js + shareTrust.js), derived from the
// latest HostStatus each time it comes. The window keeps no copy of who may
// see or do what: the invitations list, the people, the trusted people, a
// project's people, the access grid, the pill and the sidebar's badges all
// read the status main pushed last, and every change goes back to main
// (liveShare.access and friends), which answers with a fresh status.
//
// Subjects (ids main gives): g<n> a guest connected or waiting, k-… a person
// let in who is offline now, t-… a trusted person, iv-… an invitation. A
// trusted person who was let in during this share and is offline shows up
// twice in the status (offline, as k-…, and in trusted, as t-…, both with
// the same grant; trustId links them): the views that list everyone at once
// keep the trusted entry only.
import { t } from './i18n'
import { formatDuration, formatWhen } from './timeFormat'
import { sameAgentRule } from '../../shared/liveShareAgents'

const list = (x) => (Array.isArray(x) ? x : [])

// "Simpa" -> "SI", "Jean Claude" -> "JC", "" -> "?".
export function initials(name) {
  const words = String(name || '')
    .trim()
    .split(/[\s._-]+/)
    .filter(Boolean)
  if (!words.length) return '?'
  const letters = words.length > 1 ? [...words[0]][0] + [...words[1]][0] : [...words[0]].slice(0, 2).join('')
  return letters.toLocaleUpperCase()
}

export const personName = (p) => (p && typeof p.name === 'string' && p.name.trim()) || t('liveShare.guest', 'A guest')

// An invitation's name: its label, else what it is.
export function inviteName(inv) {
  if (inv && typeof inv.label === 'string' && inv.label.trim()) return inv.label.trim()
  return inv && inv.root ? t('liveShare.invite.rootLabel', 'First invite code') : t('liveShare.invite.untitled', 'Invitation')
}

// The invitation a person came in with ({ id, label } or null), in words.
export function viaName(via) {
  if (!via) return ''
  if (!via.id) return via.label ? t('liveShare.invite.goneNamed', '{{label}} (no longer exists)', { label: via.label }) : t('liveShare.invite.gone', 'An invitation that no longer exists')
  return via.label || t('liveShare.invite.untitled', 'Invitation')
}

// The guests in now. A trusted identity has one connection at a time (a new
// id on each join): should two show for a moment, the newest stands.
export function joinedGuests(host) {
  const joined = list(host && host.guests).filter((g) => g && g.state === 'joined')
  const newest = new Map()
  for (const g of joined) if (g.trustId && (!newest.has(g.trustId) || (g.since || 0) >= (newest.get(g.trustId).since || 0))) newest.set(g.trustId, g)
  return joined.filter((g) => !g.trustId || newest.get(g.trustId) === g)
}
export const waitingGuests = (host) => list(host && host.guests).filter((g) => g && g.state === 'waiting')
// The people let in who are offline now (not one of a trusted person who is
// connected through another connection).
export function offlinePeople(host) {
  const online = new Set(joinedGuests(host).map((g) => g.trustId).filter(Boolean))
  return list(host && host.offline).filter((p) => !(p && p.trustId && online.has(p.trustId)))
}
export const trustedPeople = (host) => list(host && host.trusted)
export const invitesOf = (host) => list(host && host.invites)

// One row per person with access now, for the views that list everyone
// (the grid, a project's people): the guests in (trusted ones included),
// the people let in who are offline (not trusted), and the trusted people
// who are not connected. kind: 'guest' | 'offline' | 'trusted'.
export function accessPeople(host) {
  const rows = joinedGuests(host).map((g) => ({
    id: g.id,
    kind: 'guest',
    name: personName(g),
    online: true,
    trusted: !!g.trusted,
    trustable: !!g.trustable,
    projects: list(g.projects),
    rights: g.rights || {},
    via: g.invite || null,
    trustId: g.trustId || null
  }))
  for (const p of offlinePeople(host)) {
    if (p.trusted || p.trustId) continue
    rows.push({ id: p.id, kind: 'offline', name: personName(p), online: false, trusted: false, trustable: !!p.trustable, projects: list(p.projects), rights: p.rights || {}, via: p.invite || null })
  }
  const inNow = new Set(rows.map((r) => r.trustId).filter(Boolean))
  for (const e of trustedPeople(host)) {
    if (e.online || inNow.has(e.id)) continue
    rows.push({ id: e.id, kind: 'trusted', name: personName(e), online: false, trusted: true, trustable: true, projects: list(e.projects), rights: e.rights || {}, via: null, lastSeen: e.lastSeen || null })
  }
  return rows
}

// Who has access to one shared project (contract: per-project access):
// people (with it), invitations (offering it), and who could be given it.
export function projectAccess(host, projectId) {
  const people = accessPeople(host)
  const invites = invitesOf(host)
  return {
    people: people.filter((p) => p.projects.includes(projectId)),
    invites: invites.filter((inv) => list(inv.projects).includes(projectId)),
    candidates: {
      people: people.filter((p) => !p.projects.includes(projectId)),
      invites: invites.filter((inv) => !list(inv.projects).includes(projectId))
    }
  }
}

// The guests in now who see a project (for the sidebar's avatars).
export const guestsIn = (host, projectId) => joinedGuests(host).filter((g) => list(g.projects).includes(projectId))

// When an invitation stops letting new guests in, in words.
export function inviteExpiry(inv, now = Date.now()) {
  if (!inv || inv.expiresAt == null) return { text: t('liveShare.invite.noExpiry', 'No expiry'), expired: false, never: true }
  const left = inv.expiresAt - now
  if (left <= 0) return { text: t('liveShare.invite.expired', 'Expired'), expired: true, never: false }
  return {
    text: t('liveShare.invite.expiresIn', 'Expires in {{left}} ({{when}})', { left: formatDuration(Math.max(60000, left)), when: formatWhen(inv.expiresAt, now) }),
    expired: false,
    never: false
  }
}

// How much an invitation was used, in words.
export function inviteUses(inv) {
  const uses = (inv && Number.isInteger(inv.uses) && inv.uses) || 0
  const max = (inv && Number.isInteger(inv.maxUses) && inv.maxUses) || 0
  // count picks the French singular (1 utilisation sur 3).
  if (max > 0) return t('liveShare.invite.usesOf', '{{uses}} of {{max}} uses', { uses, max, count: uses })
  return uses === 1 ? t('liveShare.invite.uses', '{{count}} use, no limit', { count: uses }) : t('liveShare.invite.uses', '{{count}} uses, no limit', { count: uses })
}

// An invitation that lets no new guest in, and why (null: it does).
export function inviteBlockedText(inv) {
  if (!inv) return null
  if (inv.state === 'blocked') return t('liveShare.invite.blocked', 'Blocked: several connections used this code without joining. Make a new code to use it again.')
  if (inv.state === 'used') return t('liveShare.invite.usedUp', 'Used up: raise its max uses or make another invitation.')
  return null
}

// What a change to an invitation's projects or rights takes away and adds,
// for the people who joined with it.
export function grantDiff(before, after) {
  const bp = new Set(list(before && before.projects))
  const ap = new Set(list(after && after.projects))
  const br = (before && before.rights) || {}
  const ar = (after && after.rights) || {}
  const ids = new Set([...Object.keys(br), ...Object.keys(ar)])
  // A changed agents rule ('agents') goes with what is taken away: it may
  // take agents or models away (main applies it with the removals).
  const agents = !sameAgentRule(br.agents, ar.agents)
  return {
    removedProjects: [...bp].filter((id) => !ap.has(id)),
    addedProjects: [...ap].filter((id) => !bp.has(id)),
    removedRights: [...[...ids].filter((id) => id !== 'agents' && br[id] === true && ar[id] !== true), ...(agents ? ['agents'] : [])],
    addedRights: [...ids].filter((id) => id !== 'agents' && ar[id] === true && br[id] !== true)
  }
}

// What main's refusal of a change means, in words (the reasons the contract
// lists); `fallback` for anything else (no answer, a person gone).
export function accessError(r, fallback) {
  const reason = r && typeof r.reason === 'string' ? r.reason : ''
  if (reason === 'full') return t('liveShare.error.full', 'You can have up to {{max}} invitations at once. Revoke one first.', { max: (r && r.max) || 20 })
  if (reason === 'lifetime') return t('liveShare.error.lifetime', 'Pick how long it lasts: 1 hour, 1 day, 7 days or no expiry.')
  if (reason === 'uses') return t('liveShare.error.uses', 'Max uses must be a whole number from 0 (no limit) to 1000.')
  if (reason === 'auto-allow') return t('liveShare.error.autoAllow', 'Every new guest needs your yes: only trusted people get in without it.')
  if (reason === 'not-sharing') return t('liveShare.error.notSharing', 'Start sharing first.')
  if (reason === 'missing') return t('liveShare.error.missing', 'This invitation no longer exists (it expired or was revoked).')
  if (reason === 'trust-full') return t('liveShare.error.trustFull', 'Trusted list is full ({{max}}): remove someone first.', { max: (r && r.max) || 50 })
  if (reason === 'trust-projects') return t('liveShare.error.trustProjects', 'A trusted person can have up to {{max}} projects: take one away first.', { max: (r && r.max) || 64 })
  return fallback || t('liveShare.error.change', 'That change could not be made (the person may have left or been removed).')
}
