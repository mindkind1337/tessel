// The file explorer (after Orca's): a project's folders, their git status,
// and the few changes you make from it (new file or folder, rename, to the
// Recycle Bin). Everything stays inside the project folder it was asked for.
import fs from 'fs'
import { join, resolve, relative, isAbsolute, dirname, basename } from 'path'
import { execFile } from 'child_process'

const MAX_ENTRIES = 5000
// Never listed (Orca hides the same by default): git's own folder.
const HIDDEN = new Set(['.git'])
// Not watched (too busy, and rebuilt by tools).
const UNWATCHED = /(^|[\\/])(\.git|node_modules|dist|build|out|\.next|\.cache|target|\.venv|__pycache__)([\\/]|$)/

// The path inside root, or null when it would leave it (.., another drive).
export function inside(root, p) {
  if (typeof root !== 'string' || !isAbsolute(root) || typeof p !== 'string') return null
  const r = resolve(root)
  const full = resolve(isAbsolute(p) ? p : join(r, p))
  const rel = relative(r, full)
  if (rel === '') return full
  if (rel.startsWith('..') || isAbsolute(rel)) return null
  return full
}

// -> { ok, entries: [{ name, path, dir }] } folders first, by name.
export function listDir({ root, dir, dotfiles = true } = {}) {
  const full = inside(root, dir || root)
  if (!full) return { ok: false, error: 'Outside the project.' }
  let items
  try {
    items = fs.readdirSync(full, { withFileTypes: true })
  } catch (err) {
    return { ok: false, error: err.code === 'ENOENT' ? 'The folder is gone.' : 'The folder could not be read.' }
  }
  const entries = []
  for (const d of items) {
    if (HIDDEN.has(d.name)) continue
    if (!dotfiles && d.name.startsWith('.')) continue
    let isDir = d.isDirectory()
    // A link or junction: followed for its kind only.
    if (d.isSymbolicLink()) {
      try {
        isDir = fs.statSync(join(full, d.name)).isDirectory()
      } catch {
        isDir = false
      }
    }
    entries.push({ name: d.name, path: join(full, d.name), dir: isDir })
    if (entries.length >= MAX_ENTRIES) break
  }
  entries.sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })))
  return { ok: true, entries, truncated: items.length > MAX_ENTRIES }
}

// `git status --porcelain=v1 -z` run at the repository's top -> { full path:
// letter }: M modified, A added, D deleted, R renamed, C copied, U untracked,
// ! ignored.
export function parsePorcelain(top, out) {
  const files = {}
  const parts = out.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i]
    if (rec.length < 4) continue
    const x = rec[0]
    const y = rec[1]
    const p = rec.slice(3)
    let letter
    if (x === '?' && y === '?') letter = 'U'
    else if (x === '!' && y === '!') letter = '!'
    else if (x === 'R' || y === 'R') letter = 'R'
    else if (x === 'C' || y === 'C') letter = 'C'
    else if (x === 'D' || y === 'D') letter = 'D'
    else if (x === 'A') letter = 'A'
    else letter = 'M'
    // A rename or copy is followed by its old path.
    if (x === 'R' || x === 'C') i++
    files[resolve(top, p.replace(/[\\/]$/, ''))] = letter
  }
  return files
}

// The repository's top folder (status paths are relative to it).
export function gitTop(root) {
  return new Promise((done) => {
    execFile('git', ['-C', root, 'rev-parse', '--show-toplevel'], { windowsHide: true, timeout: 10000 }, (err, stdout) =>
      done(err ? null : resolve(String(stdout).trim()))
    )
  })
}

// The git status of the project root is in (its repository may start above
// it): -> { ok, files: { "<full path>": letter }, repo }. Not a repository: {}.
export async function projectStatus({ root, ignored = false } = {}) {
  if (typeof root !== 'string' || !isAbsolute(root)) return { ok: false, error: 'Invalid folder.' }
  const top = await gitTop(root)
  if (!top) return { ok: true, files: {}, repo: false }
  return new Promise((done) => {
    const args = ['-C', top, 'status', '--porcelain=v1', '-z', '--untracked-files=all']
    if (ignored) args.push('--ignored=matching')
    execFile('git', args, { windowsHide: true, timeout: 15000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      if (err) return done({ ok: true, files: {}, repo: false })
      done({ ok: true, files: parsePorcelain(top, String(stdout)), repo: true })
    })
  })
}

const BAD_NAME = /[<>:"/\\|?*\x00-\x1f]|^\.\.?$|[. ]$/
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i
export function checkName(name) {
  const n = String(name || '').trim()
  if (!n) return 'Give it a name.'
  if (n.length > 200) return 'The name is too long.'
  if (BAD_NAME.test(n) || RESERVED.test(n)) return `"${n}" is not a valid name on Windows.`
  return ''
}

// New file or folder in dir: -> { ok, path } | { ok: false, error }
export function create({ root, dir, name, folder = false } = {}) {
  const bad = checkName(name)
  if (bad) return { ok: false, error: bad }
  const parent = inside(root, dir || root)
  const target = parent && inside(root, join(parent, name.trim()))
  if (!target) return { ok: false, error: 'Outside the project.' }
  if (fs.existsSync(target)) return { ok: false, error: `"${name.trim()}" already exists here.` }
  try {
    if (folder) fs.mkdirSync(target)
    else fs.writeFileSync(target, '', { flag: 'wx' })
    return { ok: true, path: target }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

export function rename({ root, path: p, name } = {}) {
  const bad = checkName(name)
  if (bad) return { ok: false, error: bad }
  const from = inside(root, p)
  if (!from || from === resolve(root)) return { ok: false, error: 'Outside the project.' }
  const to = inside(root, join(dirname(from), name.trim()))
  if (!to) return { ok: false, error: 'Outside the project.' }
  if (to === from) return { ok: true, path: to }
  // Only a change of case on Windows is the same file: allowed.
  if (fs.existsSync(to) && to.toLowerCase() !== from.toLowerCase()) return { ok: false, error: `"${name.trim()}" already exists here.` }
  try {
    fs.renameSync(from, to)
    return { ok: true, path: to }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

// To the Recycle Bin (shell.trashItem, given by the caller): never deleted for good.
export async function trash({ root, path: p } = {}, trashItem) {
  const target = inside(root, p)
  if (!target || target === resolve(root)) return { ok: false, error: 'Outside the project.' }
  if (!fs.existsSync(target)) return { ok: false, error: 'It is already gone.' }
  try {
    await trashItem(target)
    return { ok: true, name: basename(target) }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

// Watching a project: changes come as one call per burst (fn(root)), not for
// busy tool folders. -> a function that stops watching.
export function watchProject(root, fn) {
  let timer = null
  let first = 0
  let watcher
  try {
    watcher = fs.watch(root, { recursive: true }, (_type, file) => {
      if (file && UNWATCHED.test(String(file))) return
      const now = Date.now()
      if (!timer) first = now
      clearTimeout(timer)
      // 150 ms after the last change, at most 500 ms after the first (Orca's).
      timer = setTimeout(() => {
        timer = null
        fn(root)
      }, now - first > 350 ? 0 : 150)
    })
    watcher.on('error', () => {})
  } catch {
    return () => {}
  }
  return () => {
    clearTimeout(timer)
    try {
      watcher.close()
    } catch {
      // closed already
    }
  }
}

