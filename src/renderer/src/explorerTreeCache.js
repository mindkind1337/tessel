// The Files panel's tree as it was last shown, per project (stale while it
// is read again): its folders' entries, the folders open, the selection, the
// scroll position and the git letters. A project comes back at once after
// another project, a remount of the panel (a host connected again) or a
// restart of Tessel, never as an empty "Loading…"; the panel then reads its
// open folders again in the background and applies only what changed (its
// rows dimmed and the header saying so until then).
//
// In memory for the projects shown in this run (the entries' own arrays, no
// copy). On disk (localStorage) a compact copy of a project on an SSH host
// (where a listing costs a round trip): its open folders' names only (what
// the tree showed), bounded per project, in all and in number of projects;
// the oldest go first when the storage is full, and nothing here ever breaks
// another user of the storage. Never a Live Share host's project (its names
// are the host's, not this computer's); a host removed takes its trees along.
// An SSH project's path is matched exactly (POSIX names have case), a local
// one without case (Windows).
import { isRemotePath, parseRemotePath } from '../../shared/remotePath'

const MEM_MAX = 24 // projects kept in memory
export const DISK_MAX_ENTRIES = 4000 // entries kept on disk per project
export const DISK_MAX_BYTES = 256 * 1024 // one project's copy at most
export const DISK_TOTAL_BYTES = 2 * 1024 * 1024 // all of them at most
const DISK_PROJECTS = 16
const DISK_PREFIX = 'tessel.explorerTree.v2:'
const DISK_INDEX = 'tessel.explorerTree.v2.index' // [{ k, bytes }], the oldest first

const mem = new Map() // key -> { root, snap, owner }
const keyOf = (root) => (isRemotePath(root) ? String(root) : String(root || '').toLowerCase())
const sameRoot = (a, b) => (isRemotePath(a) || isRemotePath(b) ? a === b : String(a).toLowerCase() === String(b).toLowerCase())
const storage = () => {
  try {
    return globalThis.localStorage || null
  } catch {
    return null
  }
}
const childPath = (dir, name) => `${String(dir).replace(/[\\/]+$/, '')}\\${name}`

// snap: { nodes: { dir: entries }, open: [dir], selected, scrollTop, status,
// repo }; its time (at) is added. Kept in memory; a remote project's also on
// disk (see above). owner: what read it (the window's explorer API): a
// snapshot is given back only to the same one (another window's or a
// test's reads are not its own).
export function saveTree(root, snap, owner = null, now = Date.now()) {
  if (!root || !snap) return
  const k = keyOf(root)
  const kept = { ...snap, at: now }
  mem.delete(k)
  mem.set(k, { root, snap: kept, owner })
  while (mem.size > MEM_MAX) mem.delete(mem.keys().next().value)
  if (isRemotePath(root)) saveDisk(root, kept)
}

// -> the snapshot ({ ..., at }), or null. From memory, else (a remote
// project shown for the first time in this run) from disk: its open
// folders' entries, no letters.
export function loadTree(root, owner = null) {
  if (!root) return null
  const hit = mem.get(keyOf(root))
  if (hit) return hit.owner === owner && sameRoot(hit.root, root) ? hit.snap : null
  const snap = isRemotePath(root) ? loadDisk(root) : null
  if (snap) mem.set(keyOf(root), { root, snap, owner })
  return snap
}

// Forgotten (a Live Share project whose access ended, a project removed).
export function forgetTree(root) {
  if (!root) return
  const k = keyOf(root)
  mem.delete(k)
  dropDisk([k])
}

// A host removed: every tree of its projects goes (memory and disk).
export function forgetHostTrees(hostId) {
  if (!hostId) return
  const mine = (root) => {
    const p = parseRemotePath(root)
    return !!p && p.hostId === hostId
  }
  for (const [k, v] of [...mem]) if (mine(v.root)) mem.delete(k)
  const gone = readIndex().filter((x) => mine(x.k)).map((x) => x.k)
  dropDisk(gone)
}

// --- On disk ----------------------------------------------------------------------
// { v: 2, root, at, open: [dir], dirs: { dir: [[name, flags]] }, selected, scrollTop }
// flags: 1 folder, 2 link. The root and its open folders, the root first,
// until DISK_MAX_ENTRIES (and DISK_MAX_BYTES).
function readIndex() {
  const s = storage()
  if (!s) return []
  try {
    const list = JSON.parse(s.getItem(DISK_INDEX) || '[]')
    return Array.isArray(list) ? list.filter((x) => x && typeof x.k === 'string' && Number.isFinite(x.bytes)) : []
  } catch {
    return []
  }
}
function writeIndex(list) {
  const s = storage()
  if (!s) return
  try {
    s.setItem(DISK_INDEX, JSON.stringify(list))
  } catch {
    /* refused: the entries stay findable by their key */
  }
}
function dropDisk(keys) {
  const s = storage()
  if (!s || !keys.length) return
  const set = new Set(keys)
  for (const k of set) {
    try {
      s.removeItem(DISK_PREFIX + k)
    } catch {
      /* refused */
    }
  }
  writeIndex(readIndex().filter((x) => !set.has(x.k)))
}
function compact(root, snap) {
  const open = Array.isArray(snap.open) ? snap.open : []
  const dirs = {}
  let left = DISK_MAX_ENTRIES
  for (const dir of [root, ...open.filter((d) => d !== root)]) {
    const entries = snap.nodes && snap.nodes[dir]
    if (!Array.isArray(entries) || entries.length > left) continue
    dirs[dir] = entries.map((e) => [e.name, (e.dir ? 1 : 0) | (e.link ? 2 : 0)])
    left -= entries.length
  }
  return { v: 2, root, at: snap.at, open: open.filter((d) => dirs[d]), dirs, selected: typeof snap.selected === 'string' ? snap.selected : null, scrollTop: Number(snap.scrollTop) || 0 }
}
// The copies an earlier build kept (v1): gone, once per run.
let oldGone = false
function dropOldCopies(s) {
  if (oldGone) return
  oldGone = true
  try {
    for (let i = s.length - 1; i >= 0; i--) {
      const k = s.key(i)
      if (k && k.startsWith('tessel.explorerTree.v1')) s.removeItem(k)
    }
  } catch {
    /* refused */
  }
}
function saveDisk(root, snap) {
  const s = storage()
  if (!s) return
  dropOldCopies(s)
  const k = keyOf(root)
  let text
  try {
    text = JSON.stringify(compact(root, snap))
  } catch {
    return
  }
  // Too big for one project: not kept on disk (memory only), and an older
  // copy goes (it would come back stale after a restart).
  if (text.length > DISK_MAX_BYTES) return dropDisk([k])
  // The latest last; the oldest go past DISK_PROJECTS or DISK_TOTAL_BYTES.
  let index = readIndex().filter((x) => x.k !== k)
  const over = () => index.length >= DISK_PROJECTS || index.reduce((n, x) => n + x.bytes, 0) + text.length > DISK_TOTAL_BYTES
  while (index.length && over()) dropDisk([index.shift().k])
  // Full (another user of the storage): the oldest of ours go, then it is
  // tried again; never more than ours.
  for (;;) {
    try {
      s.setItem(DISK_PREFIX + k, text)
      break
    } catch {
      if (!index.length) return
      dropDisk([index.shift().k])
    }
  }
  index.push({ k, bytes: text.length })
  writeIndex(index)
}

function loadDisk(root) {
  const s = storage()
  if (!s) return null
  try {
    const raw = JSON.parse(s.getItem(DISK_PREFIX + keyOf(root)) || 'null')
    if (!raw || raw.v !== 2 || raw.root !== root || !raw.dirs || typeof raw.dirs !== 'object') return null
    const nodes = {}
    for (const [dir, list] of Object.entries(raw.dirs)) {
      if (!Array.isArray(list)) continue
      nodes[dir] = list
        .filter((x) => Array.isArray(x) && typeof x[0] === 'string' && x[0] && !/[\\/]/.test(x[0]))
        .map(([name, flags]) => ({ name, path: childPath(dir, name), dir: !!(flags & 1), ...(flags & 2 ? { link: true } : {}) }))
    }
    if (!nodes[root]) return null
    return {
      nodes,
      open: (Array.isArray(raw.open) ? raw.open : []).filter((d) => typeof d === 'string' && nodes[d]),
      selected: typeof raw.selected === 'string' ? raw.selected : null,
      scrollTop: Number(raw.scrollTop) || 0,
      status: {},
      repo: false,
      at: Number(raw.at) || 0
    }
  } catch {
    return null
  }
}

// Tests.
export function clearTreeCache() {
  mem.clear()
}
