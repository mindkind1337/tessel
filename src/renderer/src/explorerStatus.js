// Git status for the file explorer: a file's letter, and a folder's (the
// most important of what is inside: deleted > modified > added/untracked >
// renamed > copied, as Orca shows it). Keys are lower-case full paths.
const PRIORITY = { D: 5, M: 4, A: 3, U: 3, R: 2, C: 1 }

export function statusOf(map, key) {
  const l = map[key]
  return l && l !== '!' ? l : ''
}

const parentOf = (p) => p.replace(/[\\/][^\\/]*$/, '')

// -> { "<folder key>": letter } for every folder between a changed file and root.
export function folderStatus(map, rootKey) {
  const out = {}
  const root = String(rootKey || '').replace(/[\\/]+$/, '')
  for (const [p, l] of Object.entries(map)) {
    if (!PRIORITY[l]) continue
    let dir = parentOf(p)
    while (dir.length > root.length && dir.startsWith(root)) {
      if (!out[dir] || PRIORITY[l] > PRIORITY[out[dir]]) out[dir] = l
      const up = parentOf(dir)
      if (up === dir) break
      dir = up
    }
  }
  return out
}

// Git-ignored paths ('!' in the status map) -> a Set of their keys.
export function ignoredSet(map) {
  const out = new Set()
  for (const [p, l] of Object.entries(map)) if (l === '!') out.add(p.replace(/[\/]+$/, ''))
  return out
}

// Ignored: the path itself, or a folder it is in (below root), is ignored.
export function isIgnored(set, key, rootKey) {
  if (!set || !set.size || !key) return false
  const root = String(rootKey || '').replace(/[\/]+$/, '')
  let p = key.replace(/[\/]+$/, '')
  while (p.length > root.length) {
    if (set.has(p)) return true
    const up = parentOf(p)
    if (up === p) break
    p = up
  }
  return false
}
