// Live Share: the people of a share as rows, once each (the dialog's list
// and a person's page read the same rows). kind: 'waiting' (asks to come
// in) | 'guest' (in now) | 'offline' (let in during this share) | 'trusted'
// (not connected through this share). A trusted person connected now is
// their guest row (trustId links it); one offline is their trusted entry.
import { joinedGuests, waitingGuests, offlinePeople, trustedPeople } from './liveShareAccess'

export function peopleRows(host) {
  const trusted = trustedPeople(host)
  const trustedIds = new Set(trusted.map((e) => e.id))
  const joined = joinedGuests(host)
  const out = waitingGuests(host).map((g) => ({ ...g, kind: 'waiting', online: false }))
  for (const g of joined) out.push({ ...g, kind: 'guest', online: true })
  for (const p of offlinePeople(host)) if (!(p.trustId && trustedIds.has(p.trustId))) out.push({ ...p, kind: 'offline', online: false })
  const inNow = new Set(joined.map((g) => g.trustId).filter(Boolean))
  for (const e of trusted) if (!inNow.has(e.id)) out.push({ ...e, kind: 'trusted', online: !!e.online, trusted: true, trustable: true })
  return out
}

// Their trusted entry (t-…): a trusted row's own id, or the one a trusted
// guest's connection carries (rename and stop trusting go to it).
export const trustIdOf = (r) => (r.kind === 'trusted' ? r.id : r.trusted ? r.trustId || null : null)

// Whether they can type (run commands on the host's computer).
export const canType = (r) => !!(r && r.rights && r.rights.type === true)
