// The SSH host each pane worked on, as the window itself saw the pane
// (senderIdentity.js paneRemote: its remoteHostId and folder, or a chat's
// ssh:// folder), kept after the pane closes and across restarts. A message's
// record says which host its sender ran on, but that record is read back from
// files in the project (the team channel's state.json) that another program
// could write: its paths open on a host only when the host it names is the
// one recorded here for that pane (useMessageLinks.js), in the folder recorded
// here, never the one the record names.
import { paneRemote } from './senderIdentity'

export const MAX_PANE_HOSTS = 400
const STORE = 'tessel.paneHosts' // i18n-ignore
const HOST_ID = /^ssh-[\w-]{1,60}$/
// eslint-disable-next-line no-control-regex -- control characters are what it refuses
const CONTROL = /[\u0000-\u001f\u007f]/

const storage = () => {
  try {
    return globalThis.localStorage || null
  } catch {
    return null
  }
}
const validEntry = (e) =>
  !!e && typeof e === 'object' && typeof e.hostId === 'string' && HOST_ID.test(e.hostId) && typeof e.path === 'string' && e.path.length <= 4096 && !CONTROL.test(e.path) && Number.isFinite(e.at)

// paneId -> { hostId, path, at }
const hosts = new Map()
function restore() {
  try {
    const raw = storage() && storage().getItem(STORE)
    const rows = raw ? JSON.parse(raw) : null
    if (!rows || typeof rows !== 'object') return
    for (const [id, e] of Object.entries(rows)) if (typeof id === 'string' && id.length <= 100 && validEntry(e)) hosts.set(id, { hostId: e.hostId, path: e.path, at: e.at })
  } catch {
    // nothing kept
  }
}
restore()
function save() {
  try {
    const s = storage()
    if (s) s.setItem(STORE, JSON.stringify(Object.fromEntries(hosts)))
  } catch {
    // kept for this run only
  }
}

// leaves: the window's panes now. Each one on a host is noted (its latest
// host and folder); the oldest notes go past MAX_PANE_HOSTS.
export function notePaneHosts(leaves, now = Date.now()) {
  let changed = false
  for (const leaf of leaves || []) {
    const r = leaf && typeof leaf.id === 'string' && leaf.id.length <= 100 ? paneRemote(leaf) : null
    if (!r) continue
    const entry = { hostId: r.hostId, path: r.path || '~', at: now }
    if (!validEntry(entry)) continue
    const had = hosts.get(leaf.id)
    if (had && had.hostId === entry.hostId && had.path === entry.path) continue
    hosts.set(leaf.id, entry)
    changed = true
  }
  if (hosts.size > MAX_PANE_HOSTS) {
    const old = [...hosts.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, hosts.size - MAX_PANE_HOSTS)
    for (const [id] of old) hosts.delete(id)
    changed = true
  }
  if (changed) save()
}

// -> { hostId, path } the window saw this pane on, or null.
export function paneHost(paneId) {
  const e = typeof paneId === 'string' ? hosts.get(paneId) : null
  return e ? { hostId: e.hostId, path: e.path } : null
}

export function forgetPaneHosts() {
  hosts.clear()
}
