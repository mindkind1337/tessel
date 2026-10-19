// Live Share, host side: the people this host trusts.
//
// A trusted person gets into this host's Live Share without the accept
// prompt, with the projects and rights kept here, whenever it joins (with
// any live invitation of the share; after its connection drops; after this
// Tessel restarts; in a later share); the first time it joins with an
// invitation, the shared projects that invitation offers are added to its
// projects (shareAccess.js trustedInviteProjects). Trust is tied to the guest's identity
// key (shareCrypto.js signIdentity: an Ed25519 key made once on the guest's
// computer, which it proves it holds on every join), never to a name or a
// code; a guest whose Tessel has no identity key can't be trusted. The host
// trusts someone only from a guest it let in itself (after the verification
// code check), and can change what each one gets, or stop trusting it, at
// any time.
//
// Kept in a file of this Tessel's data folder (liveShare.js), with only
// public keys: nothing in it lets anyone in by itself. Bounded (MAX_TRUSTED).
// Each one's projects are the host window's project ids: a project not
// shared at the moment is simply not seen (trust is standing access: shared
// again later, it is seen again).
import { cleanRights, isRightId, setRight, withAgents } from '../../shared/liveShareRights'
import { identityFingerprint, isWeakSigningKey, KX_BYTES } from './shareCrypto.js'
import { cleanProjectIds, cleanName } from './shareGrant.js'

export const MAX_TRUSTED = 50
// Projects a trusted person may be given (over time, across shares).
export const MAX_TRUSTED_PROJECTS = 64
export const isTrustId = (id) => typeof id === 'string' && /^t-[0-9a-f]{32}$/.test(id)
export const trustId = (fp) => `t-${fp}`

// entries: what toJSON() gave (the file); save(entries): called after every
// change; onChange(): the same, for the host's window.
export function createTrustStore({ entries = [], save = () => {}, onChange = () => {}, now = Date.now, log = () => {} } = {}) {
  const map = new Map() // fp -> { fp, key (Buffer), name, grant: { projects, rights }, since, lastSeen }

  const make = (key, name, projects, rights, since, lastSeen) => ({
    fp: identityFingerprint(key),
    key,
    name: cleanName(name),
    grant: { projects: cleanProjectIds(projects, MAX_TRUSTED_PROJECTS), rights: cleanRights(rights) },
    since: Number.isFinite(since) ? since : now(),
    lastSeen: Number.isFinite(lastSeen) ? lastSeen : null
  })
  const usableKey = (key) => Buffer.isBuffer(key) && key.length === KX_BYTES && !isWeakSigningKey(key)

  for (const e of Array.isArray(entries) ? entries : []) {
    if (map.size >= MAX_TRUSTED) break
    const key = e && typeof e.key === 'string' ? Buffer.from(e.key, 'base64') : null
    if (!usableKey(key)) continue
    const entry = make(key, e.name, e.grant && e.grant.projects, e.grant && e.grant.rights, e.since, e.lastSeen)
    if (!map.has(entry.fp)) map.set(entry.fp, entry)
  }

  function changed() {
    try {
      save(toJSON())
    } catch {
      /* only the file is lost */
    }
    onChange()
  }

  function toJSON() {
    return [...map.values()].map((e) => ({ key: e.key.toString('base64'), name: e.name, grant: { projects: [...e.grant.projects], rights: { ...e.grant.rights } }, since: e.since, lastSeen: e.lastSeen }))
  }

  // A project list it may have: valid ids, at most MAX_TRUSTED_PROJECTS
  // (more is refused, never cut).
  const fits = (list) => Array.isArray(list) && new Set(list).size <= MAX_TRUSTED_PROJECTS

  return {
    get: (fp) => map.get(fp) || null,
    isFull: () => map.size >= MAX_TRUSTED,
    byId: (id) => (isTrustId(id) ? map.get(id.slice(2)) || null : null),
    list: () => [...map.values()],
    // Trusts the holder of this identity key, with these projects and rights
    // (already trusted: its entry as it is). null: a weak key, or the list
    // full.
    add({ key, name, projects, rights }) {
      if (!usableKey(key)) return null
      const fp = identityFingerprint(key)
      if (map.has(fp)) return map.get(fp)
      if (map.size >= MAX_TRUSTED) return null
      const entry = make(key, name, projects, rights, now(), now())
      map.set(fp, entry)
      log(`trusted ${entry.name || 'a guest'} (${fp.slice(0, 8)})`)
      changed()
      return entry
    },
    // What a trusted person gets: its projects, its rights, its name.
    setGrant(fp, { projects, rights } = {}) {
      const e = map.get(fp)
      if (!e || (projects !== undefined && !fits(projects))) return false
      if (projects !== undefined) e.grant.projects = cleanProjectIds(projects, MAX_TRUSTED_PROJECTS)
      if (rights !== undefined) e.grant.rights = cleanRights(rights)
      changed()
      return true
    },
    // One project or one right, against what it has now; or its agents
    // rule ({ agents }: null, the share's setting counts).
    change(fp, { project, right, on, ...rest }) {
      const e = map.get(fp)
      if (!e) return false
      if (Object.hasOwn(rest, 'agents')) return this.setGrant(fp, { rights: withAgents(e.grant.rights, rest.agents) })
      if (project !== undefined) {
        const has = e.grant.projects.includes(project)
        if (!!on === has) return true
        if (on && e.grant.projects.length >= MAX_TRUSTED_PROJECTS) return false
        return this.setGrant(fp, { projects: on ? [...e.grant.projects, project] : e.grant.projects.filter((p) => p !== project) })
      }
      if (!isRightId(right)) return false
      return this.setGrant(fp, { rights: setRight(e.grant.rights, right, on) })
    },
    rename(fp, name) {
      const e = map.get(fp)
      if (!e) return false
      e.name = cleanName(name)
      changed()
      return true
    },
    // Last seen in a share (shown to the host); saved with the next change.
    seen(fp) {
      const e = map.get(fp)
      if (e) e.lastSeen = now()
    },
    remove(fp) {
      const e = map.get(fp)
      if (!e) return false
      map.delete(fp)
      log(`stopped trusting ${e.name || 'a guest'} (${fp.slice(0, 8)})`)
      changed()
      return true
    },
    toJSON
  }
}
