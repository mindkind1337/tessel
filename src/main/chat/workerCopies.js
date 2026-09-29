// The git worktrees Tessel made itself from a project's own code (its HEAD or
// one of its local branches), so that a chat worker opened in such a copy
// counts as its project for folder trust (chatTrust.js).
//
// Why a record: any worktree of a trusted project is not safe to trust. The
// "start a pull request" flow makes a copy from the PR's head commit (a
// pinned SHA fetched from GitHub, possibly from a fork), and a chat opened
// there would run that PR's .claude/settings.json hooks, .mcp.json servers
// and allowed permissions. Copies from a commit or a remote branch are never
// recorded: a chat there asks for trust like any other folder.
//
// File (userData): { version: 1, copies: { [real path key]: { project, at } } }
import fs from 'fs'
import { resolve } from 'path'
import { readJsonSafe, writeJsonSafe } from '../safeJson.js'
import { trustKey } from './chatTrust.js'
import { worktreeProjectRoot } from './worktreeTrust.js'

export const MAX_COPIES = 2000
// resolveWorktreeBase's kinds whose code is the project's own.
export const RECORDED_BASES = ['head', 'local']

const validFile = (data) =>
  !!data && typeof data === 'object' && data.version === 1 && !!data.copies && typeof data.copies === 'object'

export function createWorkerCopies({
  file,
  now = Date.now,
  max = MAX_COPIES,
  realpath = (p) => fs.realpathSync.native(p),
  projectOf = worktreeProjectRoot
} = {}) {
  let copies = null

  // The real path's key (junctions and links followed); the plain one when
  // the folder is gone.
  function keysOf(path) {
    const keys = new Set()
    const plain = trustKey(path)
    if (!plain) return []
    try {
      const real = trustKey(realpath(path))
      if (real) keys.add(real)
    } catch {
      /* missing: the plain key only */
    }
    keys.add(plain)
    return [...keys]
  }
  const realKey = (path) => {
    if (!trustKey(path)) return null
    try {
      return trustKey(realpath(path))
    } catch {
      return null
    }
  }

  function load() {
    if (copies) return copies
    copies = {}
    try {
      const { data } = readJsonSafe(file, validFile)
      if (data) {
        for (const [k, v] of Object.entries(data.copies)) {
          if (trustKey(k) === k && v && typeof v.project === 'string' && trustKey(v.project) && Number.isFinite(v.at))
            copies[k] = { project: v.project, at: v.at }
        }
      }
    } catch {
      // Unreadable (locked): no copy inherits trust this time.
    }
    return copies
  }
  function save() {
    const kept = Object.entries(copies)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, max)
    copies = Object.fromEntries(kept)
    try {
      writeJsonSafe(file, { version: 1, copies })
    } catch {
      // Kept for this run only.
    }
  }

  // A copy createWorktree just made. baseKind: resolveWorktreeBase's kind.
  // Any other kind (a pinned commit, a remote branch) removes a stale record
  // of the same folder instead.
  function created({ path, project, baseKind } = {}) {
    const all = load()
    const key = realKey(path)
    if (!key) return false
    if (!RECORDED_BASES.includes(baseKind)) {
      forget(path)
      return false
    }
    const proj = realKey(project)
    if (!proj) return false
    all[key] = { project: resolve(project), at: now() }
    save()
    return true
  }

  // The copy was deleted.
  function forget(path) {
    const all = load()
    let changed = false
    for (const k of keysOf(path)) {
      if (all[k]) {
        delete all[k]
        changed = true
      }
    }
    if (changed) save()
    return changed
  }

  // The folders a chat opened in `cwd` may borrow trust from: its project,
  // only for a worker, only for a recorded copy that git still lists as a
  // worktree of that project.
  function trustRoots(cwd, { worker = false } = {}) {
    if (worker !== true) return []
    const key = realKey(cwd)
    const rec = key ? load()[key] : null
    if (!rec) return []
    const main = projectOf(cwd)[0]
    if (!main) return []
    const mainKey = realKey(main)
    const projKey = realKey(rec.project)
    if (!mainKey || !projKey) return []
    // Made from the main checkout, or from another worktree of it.
    if (projKey === mainKey) return [rec.project]
    const projMain = projectOf(rec.project)[0]
    if (projMain && realKey(projMain) === mainKey) return [rec.project]
    return []
  }

  return { created, forget, trustRoots, list: () => ({ ...load() }) }
}
