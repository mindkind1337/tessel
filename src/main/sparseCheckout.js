// The folders a git sparse checkout keeps, for the Files tree to offer them
// as its root. After Orca's file-explorer-display-root.ts (MIT, Copyright (c)
// 2026 Lovecast Inc.), which scopes the tree to a worktree's sparse folders.

export const SPARSE_MAX_DIRS = 200

// `git sparse-checkout list` -> the folders it names, relative to the
// repository's top ("a/b"). Cone mode lists folders; a non-cone pattern is kept
// only when it is a plain folder ("/src/"), never a glob, a negation or a path
// that would leave the repository.
export function parseSparseList(out) {
  const dirs = []
  const seen = new Set()
  for (const line of String(out || '').split(/\r?\n/)) {
    const raw = line.trim()
    if (!raw || raw.startsWith('#') || raw.startsWith('!') || raw.startsWith('"')) continue
    if (/[*?[\]\\\u0000-\u001f]/.test(raw) || /^[A-Za-z]:/.test(raw)) continue
    const segs = raw.split('/').filter(Boolean)
    if (!segs.length || segs.some((s) => s === '.' || s === '..')) continue
    const dir = segs.join('/')
    if (seen.has(dir)) continue
    seen.add(dir)
    dirs.push(dir)
    if (dirs.length >= SPARSE_MAX_DIRS) break
  }
  return dirs
}

// The sparse folders inside the project folder, relative to it, when the
// project is `rootRel` below the repository's top ("" for the top itself).
// A folder above or beside the project is not one to show from it. Windows
// paths compare without case; a remote host's (POSIX) with it.
export function sparseDirsUnder(dirs, rootRel, { caseless = true } = {}) {
  const base = String(rootRel || '')
    .split(/[\\/]+/)
    .filter(Boolean)
    .join('/')
  if (!base) return [...dirs]
  const fold = (p) => (caseless ? p.toLowerCase() : p)
  const prefix = fold(base) + '/'
  return dirs.filter((d) => fold(d).startsWith(prefix)).map((d) => d.slice(prefix.length))
}
