// What a change notice from the project's watch means for the Files tab and
// the Changes count (explorer.js watchProject, remoteFs.js poll): the paths
// that changed, or null when not known (everything shown is read again).
//
// Like VS Code (explorerService.ts, the git extension's repository.ts): a
// folder is read again only when it is loaded and its entries may have
// changed, and git status runs only for a change it can see. A change in
// git-ignored files only (a server's log, its cache) runs neither; git's
// own folder (a stage, a commit, a branch switch) always runs the status.
import { isIgnored } from './explorerStatus'

const key = (p) => String(p || '').toLowerCase()
export const parentOf = (p) => String(p || '').replace(/[\\/][^\\/]*$/, '')
const IN_GIT = /(^|[\\/])\.git([\\/]|$)/i

// The git-ignored paths each project's Files tab knows (lower-case keys),
// shared with the side panel (its Changes count).
const ignoredByRoot = new Map()
export function rememberIgnored(root, set) {
  if (root) ignoredByRoot.set(key(root), set)
}
export function forgetIgnored(root) {
  ignoredByRoot.delete(key(root))
}

export const inGitDir = (p) => IN_GIT.test(String(p || ''))

// Can these changes change git status? null (not known): yes.
export function statusMatters(root, paths, ignored = ignoredByRoot.get(key(root))) {
  if (!Array.isArray(paths)) return true
  const rootKey = key(root)
  return paths.some((p) => inGitDir(p) || !isIgnored(ignored, key(p), rootKey))
}

// The loaded folders to read again. nodes: dir -> { entries }.
// - Remote (remoteFs.js poll): a folder's own change time says its entries
//   changed, so the folder that changed itself is read again, and the
//   folder of a path it does not list yet (new).
// - Local (explorer.js watchProject): the watch names the entry, not its
//   folder; renamed lists those created, deleted or renamed, whose folder is
//   read again (a file only modified needs no new listing). renamed null:
//   not known, every changed path's folder.
export function foldersToReload(nodes, paths, { remote = false, renamed = null } = {}) {
  const byKey = new Map(Object.keys(nodes).map((d) => [key(d), d]))
  const moved = Array.isArray(renamed) ? new Set(renamed.map(key)) : null
  const out = new Set()
  for (const p of paths || []) {
    if (inGitDir(p)) continue
    const self = byKey.get(key(p))
    if (self && remote) out.add(self)
    const parent = byKey.get(key(parentOf(p)))
    if (!parent) continue
    const n = nodes[parent]
    const listed = !!(n && n.entries && n.entries.some((e) => key(e.path) === key(p)))
    if (remote ? !listed : !moved || moved.has(key(p)) || !listed) out.add(parent)
  }
  return [...out]
}

// Two listings with the same entries (nothing to draw again).
export function sameEntries(a, b) {
  if (a === b) return true
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (x.name !== y.name || x.path !== y.path || !!x.dir !== !!y.dir || !!x.link !== !!y.link) return false
  }
  return true
}

// Two status maps with the same letters.
export function sameStatus(a, b) {
  if (a === b) return true
  const ka = Object.keys(a || {})
  if (ka.length !== Object.keys(b || {}).length) return false
  for (const k of ka) if (a[k] !== b[k]) return false
  return true
}
