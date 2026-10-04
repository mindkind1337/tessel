// Deleting a task's copy safely (review.js): before git, and what git leaves
// behind after it.
//
// Before: Git for Windows (2.53 checked) goes THROUGH a junction when it
// deletes a copy: `git worktree remove` emptied the folder a node_modules
// junction pointed to. So every link to a folder inside the copy is unlinked
// first (unlinkFolderLinks), and git only deletes real files.
//
// After: git can unregister a copy and still leave its folder (a path too
// long, a file still open). That leftover is deleted here, after Orca's
// local worktree removal recovery (src/main/local-worktree-removal-
// recovery.ts, MIT, Copyright (c) 2026 Lovecast Inc.).
//
// Safety first: Tessel once lost its node_modules to a delete that went
// through a junction. So:
// - only the exact folder git knew as a copy of this repository is touched,
//   never the project folder, a folder that holds it, a drive root, the home
//   folder or a folder that holds it (leftoverRefusal);
// - links are never followed: a junction or symbolic link (lstat says
//   isSymbolicLink, junctions included on Windows) is unlinked itself, and a
//   folder whose real path is not where it stands (another kind of reparse
//   point) is removed the same way, without looking inside;
// - nothing here deletes recursively with fs.rm: every entry is looked at.
//
// A copy git unregistered but whose folder stayed is remembered (the
// leftover store), so the delete can be tried again later, even after a
// restart, and only for that path.
import fs from 'fs'
import os from 'os'
import { join, parse, relative, resolve, isAbsolute } from 'path'
import { readJsonSafe, writeJsonSafe } from './safeJson.js'

const fsp = fs.promises
const win = process.platform === 'win32'
export const MAX_LEFTOVERS = 200

export function pathKey(p) {
  const x = resolve(p)
  return win ? x.toLowerCase() : x
}

// a is b, or holds it.
function holds(a, b) {
  const rel = relative(pathKey(a), pathKey(b))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

async function realOf(p) {
  try {
    return await fsp.realpath(p)
  } catch {
    return null
  }
}

// -> null when `target` may be deleted as a leftover copy of `repo`, else why
// not: 'not-absolute' | 'unknown' | 'no-project' | 'drive-root' | 'project'
// (the project folder or one that holds it) | 'home' (same for home). `known`: the copy is one git
// listed for this repository (now, or when the leftover was recorded).
export async function leftoverRefusal(target, { repo, known, home = os.homedir() } = {}) {
  if (typeof target !== 'string' || !target || target.includes('\0') || !isAbsolute(target)) return 'not-absolute'
  if (!known) return 'unknown'
  if (typeof repo !== 'string' || !repo) return 'no-project'
  const plain = resolve(target)
  const real = (await realOf(plain)) || plain
  const repoReal = (await realOf(repo)) || resolve(repo)
  const homeReal = home ? (await realOf(home)) || resolve(home) : null
  for (const p of [plain, real]) {
    if (pathKey(p) === pathKey(parse(p).root)) return 'drive-root'
    if (holds(p, repo) || holds(p, repoReal)) return 'project'
    if (home && (holds(p, home) || (homeReal && holds(p, homeReal)))) return 'home'
  }
  return null
}

const RETRY = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY', 'EMFILE', 'ENFILE'])

// A junction or symbolic link: removed itself, never what it points to.
async function unlinkLink(p) {
  try {
    await fsp.unlink(p)
  } catch (err) {
    if (err.code === 'ENOENT') return
    // A directory link on some systems: rmdir removes the link, and never
    // anything inside (it fails on a folder that is not empty).
    await fsp.rmdir(p)
  }
}

async function unlinkFile(p) {
  try {
    await fsp.unlink(p)
  } catch (err) {
    if (err.code === 'ENOENT') return
    if (err.code !== 'EPERM' && err.code !== 'EACCES') throw err
    // A read-only file (git makes its objects read-only).
    await fsp.chmod(p, 0o666)
    await fsp.unlink(p)
  }
}

// Deletes `p` without ever following a link. `expected`: where `p` really is
// (its real path) when it is not reached through a link.
async function removeEntry(p, expected) {
  let st
  try {
    st = await fsp.lstat(p)
  } catch (err) {
    if (err.code === 'ENOENT') return
    throw err
  }
  if (st.isSymbolicLink()) return unlinkLink(p)
  if (!st.isDirectory()) return unlinkFile(p)
  // A reparse point lstat does not call a link (mount point of another kind,
  // cloud placeholder...): its real path is elsewhere. Remove the entry only.
  const real = await realOf(p)
  if (!real || pathKey(real) !== pathKey(expected)) return unlinkLink(p)
  for (const name of await fsp.readdir(p)) await removeEntry(join(p, name), join(real, name))
  await fsp.rmdir(p)
}

// Before git deletes the copy `dir`: unlinks every junction or symbolic link
// to a folder inside it (never what it points to), so git cannot go through
// one. Links to files stay (git deletes the link only). Reparse points are
// links for readdir on Windows, junctions included; links are never entered.
// -> { ok: true, unlinked } | { ok: false, error }
export async function unlinkFolderLinks(dir) {
  let unlinked = 0
  async function walk(p) {
    let entries
    try {
      entries = await fsp.readdir(p, { withFileTypes: true })
    } catch (err) {
      if (err.code === 'ENOENT') return
      throw err
    }
    for (const e of entries) {
      const child = join(p, e.name)
      if (e.isSymbolicLink()) {
        let target = null
        try {
          target = await fsp.stat(child)
        } catch (err) {
          if (err.code === 'ENOENT') continue // dangling: nothing to go through
        }
        // A folder, or one that cannot be looked at: unlinked to be safe.
        if (target && !target.isDirectory()) continue
        await unlinkLink(child)
        unlinked++
      } else if (e.isDirectory()) await walk(child)
    }
  }
  try {
    const st = await fsp.lstat(dir)
    if (st.isSymbolicLink() || !st.isDirectory()) return { ok: false, error: 'not a folder' } // i18n-ignore internal reason
    await walk(dir)
    return { ok: true, unlinked }
  } catch (err) {
    return { ok: false, error: [err.code, err.path].filter(Boolean).join(' ') || err.message }
  }
}

// Deletes the folder `dir` (checked with leftoverRefusal first), retrying
// while Windows keeps a file busy. -> { ok: true } | { ok: false, error }
export async function removeLeftover(dir, { attempts = 8, delay = 700 } = {}) {
  let last = null
  for (let i = 0; i < attempts; i++) {
    try {
      const st = await fsp.lstat(dir).catch((err) => (err.code === 'ENOENT' ? null : Promise.reject(err)))
      if (!st) return { ok: true }
      if (st.isSymbolicLink()) await unlinkLink(dir)
      else await removeEntry(dir, (await realOf(dir)) || resolve(dir))
      if (!fs.existsSync(dir)) return { ok: true }
    } catch (err) {
      last = err
      if (err && err.code && !RETRY.has(err.code)) break
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, delay))
  }
  if (!fs.existsSync(dir)) return { ok: true }
  const why = last ? [last.code, last.path].filter(Boolean).join(' ') || last.message : 'ENOTEMPTY'
  return { ok: false, error: why }
}

// Copies git unregistered while their folder stayed:
// file (userData): { version: 1, leftovers: { [path key]: { repo, path, branch, at } } }
// Without a file (tests), kept in memory only.
const validFile = (d) => !!d && typeof d === 'object' && d.version === 1 && !!d.leftovers && typeof d.leftovers === 'object'

export function createLeftoverStore({ file = null, now = Date.now, max = MAX_LEFTOVERS } = {}) {
  let items = null
  function load() {
    if (items) return items
    items = {}
    if (file) {
      try {
        const { data } = readJsonSafe(file, validFile)
        if (data) items = { ...data.leftovers }
      } catch {
        // Unreadable: nothing remembered (a retry is then refused, never widened).
      }
    }
    return items
  }
  function save() {
    if (!file) return
    try {
      writeJsonSafe(file, { version: 1, leftovers: items }, validFile)
    } catch {
      // Kept in memory for this session.
    }
  }
  return {
    get(repo, path) {
      if (typeof repo !== 'string' || typeof path !== 'string' || !repo || !path) return null
      const rec = load()[pathKey(path)]
      return rec && pathKey(rec.repo) === pathKey(repo) ? rec : null
    },
    add(repo, path, branch = null) {
      const list = load()
      list[pathKey(path)] = { repo: resolve(repo), path: resolve(path), branch: branch || null, at: now() }
      const keys = Object.keys(list)
      if (keys.length > max) {
        keys.sort((a, b) => (list[a].at || 0) - (list[b].at || 0))
        for (const k of keys.slice(0, keys.length - max)) delete list[k]
      }
      save()
    },
    // The leftovers of the project `repo`, oldest first.
    list(repo) {
      if (typeof repo !== 'string' || !repo) return []
      const k = pathKey(repo)
      return Object.values(load())
        .filter((r) => r && typeof r.path === 'string' && typeof r.repo === 'string' && pathKey(r.repo) === k)
        .sort((a, b) => (a.at || 0) - (b.at || 0))
        .map((r) => ({ ...r }))
    },
    forget(path) {
      const list = load()
      const k = pathKey(path)
      if (!list[k]) return
      delete list[k]
      save()
    }
  }
}
