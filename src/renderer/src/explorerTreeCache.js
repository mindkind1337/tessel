// The Files panel's tree as it was last shown, per project (stale while it
// is read again): its folders' entries, the folders open, the selection, the
// scroll position and the git letters. A project comes back at once after
// another project, a remount of the panel (a host connected again) or a
// restart of Tessel, never as an empty "Loading…"; the panel then reads its
// open folders again in the background and applies only what changed.
//
// In memory for the projects shown in this run (the entries' own arrays, no
// copy). On disk (localStorage) a compact copy of a project on an SSH host
// (where a listing costs a round trip): its open folders' names only (what
// the tree showed), bounded per project and in number of projects. Never a
// Live Share host's project (its names are the host's, not this computer's).
import { isRemotePath } from '../../shared/remotePath'

const MEM_MAX = 24 // projects kept in memory
export const DISK_MAX_ENTRIES = 4000 // entries kept on disk per project
const DISK_PROJECTS = 16
const DISK_PREFIX = 'tessel.explorerTree.v1:'
const DISK_INDEX = 'tessel.explorerTree.v1.index'

const mem = new Map() // root (lower case) -> snapshot
const keyOf = (root) => String(root || '').toLowerCase()
const storage = () => {
  try {
    return globalThis.localStorage || null
  } catch {
    return null
  }
}
const childPath = (dir, name) => `${String(dir).replace(/[\\/]+$/, '')}\\${name}`

// snap: { nodes: { dir: entries }, open: [dir], selected, scrollTop, status,
// repo }. Kept in memory; a remote project's also on disk (see above).
// owner: what read it (the window's explorer API): a snapshot is given back
// only to the same one (another window's or a test's reads are not its own).
export function saveTree(root, snap, owner = null) {
  if (!root || !snap) return
  const k = keyOf(root)
  mem.delete(k)
  mem.set(k, { snap, owner })
  while (mem.size > MEM_MAX) mem.delete(mem.keys().next().value)
  if (isRemotePath(root)) saveDisk(root, snap)
}

// -> the snapshot, or null. From memory, else (a remote project shown for
// the first time in this run) from disk: its open folders' entries, no letters.
export function loadTree(root, owner = null) {
  if (!root) return null
  const hit = mem.get(keyOf(root))
  if (hit) return hit.owner === owner ? hit.snap : null
  const snap = isRemotePath(root) ? loadDisk(root) : null
  if (snap) mem.set(keyOf(root), { snap, owner })
  return snap
}

// Forgotten (a Live Share project whose access ended, a project removed).
export function forgetTree(root) {
  const k = keyOf(root)
  mem.delete(k)
  const s = storage()
  if (!s) return
  try {
    s.removeItem(DISK_PREFIX + k)
  } catch {
    /* storage refused */
  }
}

// --- On disk ----------------------------------------------------------------------
// { v: 1, root, open: [dir], dirs: { dir: [[name, flags]] }, selected, scrollTop }
// flags: 1 folder, 2 link. The root and its open folders, the root first,
// until DISK_MAX_ENTRIES.
function saveDisk(root, snap) {
  const s = storage()
  if (!s) return
  try {
    const open = Array.isArray(snap.open) ? snap.open : []
    const dirs = {}
    let left = DISK_MAX_ENTRIES
    for (const dir of [root, ...open.filter((d) => d !== root)]) {
      const entries = snap.nodes && snap.nodes[dir]
      if (!Array.isArray(entries) || entries.length > left) continue
      dirs[dir] = entries.map((e) => [e.name, (e.dir ? 1 : 0) | (e.link ? 2 : 0)])
      left -= entries.length
    }
    const k = keyOf(root)
    s.setItem(DISK_PREFIX + k, JSON.stringify({ v: 1, root, open: open.filter((d) => dirs[d]), dirs, selected: typeof snap.selected === 'string' ? snap.selected : null, scrollTop: Number(snap.scrollTop) || 0 }))
    // The projects on disk, the latest last; the oldest go.
    let index = []
    try {
      index = JSON.parse(s.getItem(DISK_INDEX) || '[]')
    } catch {
      index = []
    }
    index = [...(Array.isArray(index) ? index : []).filter((x) => x !== k), k]
    while (index.length > DISK_PROJECTS) s.removeItem(DISK_PREFIX + index.shift())
    s.setItem(DISK_INDEX, JSON.stringify(index))
  } catch {
    /* full or refused: memory only */
  }
}

function loadDisk(root) {
  const s = storage()
  if (!s) return null
  try {
    const raw = JSON.parse(s.getItem(DISK_PREFIX + keyOf(root)) || 'null')
    if (!raw || raw.v !== 1 || raw.root !== root || !raw.dirs || typeof raw.dirs !== 'object') return null
    const nodes = {}
    for (const [dir, list] of Object.entries(raw.dirs)) {
      if (!Array.isArray(list)) continue
      nodes[dir] = list
        .filter((x) => Array.isArray(x) && typeof x[0] === 'string' && x[0] && !/[\\/]/.test(x[0]))
        .map(([name, flags]) => ({ name, path: childPath(dir, name), dir: !!(flags & 1), ...(flags & 2 ? { link: true } : {}) }))
    }
    if (!nodes[root]) return null
    const snap = {
      nodes,
      open: (Array.isArray(raw.open) ? raw.open : []).filter((d) => typeof d === 'string' && nodes[d]),
      selected: typeof raw.selected === 'string' ? raw.selected : null,
      scrollTop: Number(raw.scrollTop) || 0,
      status: {},
      repo: false
    }
    return snap
  } catch {
    return null
  }
}

// Tests.
export function clearTreeCache() {
  mem.clear()
}
