// The file explorer (after Orca's): a project's folders, their git status,
// and the few changes you make from it (new file or folder, rename, to the
// Recycle Bin). Everything stays inside the project folder it was asked for.
import fs from 'fs'
import { join, resolve, relative, isAbsolute, dirname, basename, sep } from 'path'
import { execFile, spawn } from 'child_process'
import { StringDecoder } from 'string_decoder'
import { t } from './i18n'
import { localGitArgs } from './gitSafety'
import { parseSparseList, sparseDirsUnder } from './sparseCheckout'

const MAX_ENTRIES = 5000
// Never listed (Orca hides the same by default): git's own folder.
const HIDDEN = new Set(['.git'])
// Heavy folders, rebuilt by tools: not watched, not searched.
const HEAVY = ['.git', 'node_modules', 'dist', 'build', 'out', '.next', '.cache', 'target', '.venv', '__pycache__']
const HEAVY_SET = new Set(HEAVY)
const UNWATCHED = new RegExp(`(^|[\\\\/])(${HEAVY.map((h) => h.replace(/\./g, '\\.')).join('|')})([\\\\/]|$)`)
// Git's own files that say the status changed (a stage, a commit, a branch
// switch, a merge, a fetch), even when done in a terminal: the project's
// watch passes them on; never its objects, logs or lock files.
const GIT_STATE = /^\.git[\\/](index|HEAD|ORIG_HEAD|MERGE_HEAD|FETCH_HEAD|packed-refs|refs[\\/].+)$/
export function isGitStateChange(file) {
  const f = String(file || '')
  return GIT_STATE.test(f) && !f.endsWith('.lock')
}

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
  if (!full) return { ok: false, error: t('main.explorer.outside', 'Outside the project.') }
  let items
  try {
    items = fs.readdirSync(full, { withFileTypes: true })
  } catch (err) {
    return {
      ok: false,
      error: err.code === 'ENOENT' ? t('main.explorer.folderGone', 'The folder is gone.') : t('main.explorer.folderUnreadable', 'The folder could not be read.')
    }
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

// Git's own message (its first line), for an error shown to the user.
export function gitError(stderr, fallback) {
  const line = String(stderr || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l)
  return line ? `${fallback} ${line.slice(0, 300)}` : fallback
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
  if (typeof root !== 'string' || !isAbsolute(root)) return { ok: false, error: t('main.explorer.invalidFolder', 'Invalid folder.') }
  const top = await gitTop(root)
  if (!top) return { ok: true, files: {}, repo: false }
  // The repository's own settings that run programs stay off until trusted.
  const safety = await localGitArgs(top)
  return new Promise((done) => {
    const args = ['-C', top, ...safety, 'status', '--porcelain=v1', '-z', '--untracked-files=all']
    if (ignored) args.push('--ignored=matching')
    execFile('git', args, { windowsHide: true, timeout: 15000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      // A repository whose status failed is not a clean one: said as an error.
      if (err)
        return done({
          ok: false,
          error: gitError(
            stderr,
            err.killed ? t('main.explorer.statusSlow', 'Git status took too long.') : t('main.scm.statusFailed', 'Git status failed.')
          )
        })
      done({ ok: true, files: parsePorcelain(top, String(stdout)), repo: true })
    })
  })
}

// The folders a sparse checkout keeps below the project (sparseCheckout.js),
// for the tree to offer as its root: -> { ok, sparse, dirs: [{ rel, path }] }
// (rel "a/b" from the project folder, only folders that are there). Not a
// repository, not sparse, or a git without sparse-checkout: { sparse: false }.
export async function sparseInfo({ root } = {}) {
  if (typeof root !== 'string' || !isAbsolute(root)) return { ok: false, error: t('main.explorer.invalidFolder', 'Invalid folder.') }
  const none = { ok: true, sparse: false, dirs: [] }
  const top = await gitTop(root)
  if (!top) return none
  const safety = await localGitArgs(top)
  const out = await new Promise((done) => {
    // Exit 128 ("this worktree is not sparse") or an old git: not sparse.
    execFile('git', ['-C', top, ...safety, 'sparse-checkout', 'list'], { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 }, (err, stdout) =>
      done(err ? null : String(stdout))
    )
  })
  if (out === null) return none
  // The project below the top: as given, or by its real path (a junction, a
  // short 8.3 name) when git named the top that way.
  const ways = [resolve(root)]
  try {
    ways.push(fs.realpathSync.native(ways[0]))
  } catch {
    // gone: compared as given
  }
  const rootRel = ways.map((p) => relative(top, p)).find((rel) => !rel.startsWith('..') && !isAbsolute(rel))
  if (rootRel === undefined) return none
  const dirs = []
  for (const rel of sparseDirsUnder(parseSparseList(out), rootRel)) {
    const full = inside(root, rel)
    if (!full) continue
    try {
      if (!fs.statSync(full).isDirectory()) continue
    } catch {
      continue
    }
    dirs.push({ rel, path: full })
  }
  return { ok: true, sparse: true, dirs }
}

// --- Search -------------------------------------------------------------------
export const SEARCH_LIMIT = 500
const MAX_WALK = 100000 // entries looked at, at most, per search
const MAX_FILE = 2 * 1024 * 1024 // content search skips bigger files
const MAX_TEXT = 240 // a result's line, cut around the match
const MAX_RECORD = 8192 // chars of one git grep line kept (path + text); the rest is dropped unread
const MAX_OUTPUT = 32 * 1024 * 1024 // bytes of git grep output read, at most

// The number of results asked for, within 1..SEARCH_LIMIT.
export function searchCap(limit) {
  const n = Number(limit)
  return Number.isInteger(n) && n > 0 ? Math.min(n, SEARCH_LIMIT) : SEARCH_LIMIT
}

// Every folder and file of the project, breadth first, without the heavy
// folders: fn(entry) returns true to stop.
async function walk(root, { dotfiles = true } = {}, fn) {
  const queue = [root]
  let seen = 0
  while (queue.length) {
    const dir = queue.shift()
    let items
    try {
      items = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    items.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
    for (const d of items) {
      if (HEAVY_SET.has(d.name)) continue
      if (!dotfiles && d.name.startsWith('.')) continue
      if (++seen > MAX_WALK) return true
      const full = join(dir, d.name)
      // Links and junctions are not followed (they may loop or leave the project).
      const isDir = d.isDirectory()
      if (isDir) queue.push(full)
      if (await fn({ name: d.name, path: full, dir: isDir, file: d.isFile() })) return true
    }
  }
  return false
}

const relOf = (root, p) => relative(resolve(root), p)

// Files and folders whose name has the query (case-insensitive), in folders
// not opened yet too: -> { ok, results: [{ name, path, rel, dir }], truncated }
// `dir`: only below that folder of the project (the tree's root when it shows
// one sparse folder); rel stays relative to the project.
export async function searchNames({ root, dir, query, dotfiles = true, limit = SEARCH_LIMIT } = {}) {
  if (!inside(root, root)) return { ok: false, error: t('main.explorer.invalidFolder', 'Invalid folder.') }
  const start = dir ? inside(root, dir) : resolve(root)
  if (!start) return { ok: false, error: t('main.explorer.outside', 'Outside the project.') }
  limit = searchCap(limit)
  const q = String(query || '').trim().toLowerCase()
  if (!q) return { ok: true, results: [], truncated: false }
  const results = []
  let truncated = false
  const stopped = await walk(start, { dotfiles }, (e) => {
    if (!e.name.toLowerCase().includes(q)) return false
    if (results.length >= limit) {
      truncated = true
      return true
    }
    results.push({ name: e.name, path: e.path, rel: relOf(root, e.path), dir: e.dir })
    return false
  })
  return { ok: true, results, truncated: truncated || stopped }
}

// A result's line: trimmed, and cut around the match when it is long.
export function clipLine(text, q) {
  const s = String(text).replace(/\r$/, '').replace(/\t/g, '  ').trim()
  if (s.length <= MAX_TEXT) return s
  const at = Math.max(0, s.toLowerCase().indexOf(q))
  const start = Math.max(0, Math.min(at - 60, s.length - MAX_TEXT))
  return (start > 0 ? '…' : '') + s.slice(start, start + MAX_TEXT) + (start + MAX_TEXT < s.length ? '…' : '')
}

// Content search by walking the project (no git): plain text,
// case-insensitive; binaries (a NUL in the first 8 KB) and files over 2 MB
// are skipped. -> { ok, results: [{ path, rel, line, text }], truncated }
export async function searchContentWalk({ root, query, limit = SEARCH_LIMIT } = {}) {
  if (!inside(root, root)) return { ok: false, error: t('main.explorer.invalidFolder', 'Invalid folder.') }
  limit = searchCap(limit)
  const q = String(query || '').toLowerCase()
  if (!q.trim()) return { ok: true, results: [], truncated: false }
  const results = []
  let truncated = false
  const stopped = await walk(root, {}, async (e) => {
    if (!e.file) return false
    let buf
    try {
      const st = await fs.promises.stat(e.path)
      if (st.size > MAX_FILE) return false
      buf = await fs.promises.readFile(e.path)
    } catch {
      return false
    }
    if (buf.subarray(0, 8192).includes(0)) return false
    const lines = buf.toString('utf8').split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].toLowerCase().includes(q)) continue
      if (results.length >= limit) {
        truncated = true
        return true
      }
      results.push({ path: e.path, rel: relOf(root, e.path), line: i + 1, text: clipLine(lines[i], q) })
    }
    return false
  })
  return { ok: true, results, truncated: truncated || stopped }
}

// One `git grep -z -n` record ("path\0line\0text") -> a result, or null
// (not one, or in a heavy folder).
export function parseGrepRecord(root, rec, q) {
  const a = rec.indexOf('\0')
  const b = a < 0 ? -1 : rec.indexOf('\0', a + 1)
  if (b < 0) return null
  const rel = rec.slice(0, a).replace(/\//g, '\\')
  if (UNWATCHED.test(rel)) return null
  const line = Number(rec.slice(a + 1, b))
  if (!Number.isInteger(line) || line < 1) return null
  const path = join(resolve(root), rel)
  if (!inside(root, path)) return null
  return { path, rel: relOf(root, path), line, text: clipLine(rec.slice(b + 1), q) }
}

const contained = (base, p) => {
  const rel = relative(base, p)
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)
}

// Is a file git grep found one the walk would search? Under no link or
// junction below the project folder, its real path inside the project's real
// one, a regular file of 2 MB at most. -> fn(full path) -> boolean, with the
// answers kept for the search (a file has many lines, a folder many files).
export function grepFileCheck(root) {
  const r = resolve(root)
  let realRoot = null
  try {
    realRoot = fs.realpathSync.native(r)
  } catch {
    // gone: nothing passes
  }
  const dirs = new Map([[r, true]])
  const files = new Map()
  const dirOk = (d) => {
    if (dirs.has(d)) return dirs.get(d)
    let ok = false
    const parent = dirname(d)
    if (parent !== d && contained(r, d) && dirOk(parent)) {
      try {
        const st = fs.lstatSync(d)
        ok = st.isDirectory() && !st.isSymbolicLink()
      } catch {
        ok = false
      }
    }
    dirs.set(d, ok)
    return ok
  }
  return (full) => {
    if (files.has(full)) return files.get(full)
    let ok = false
    if (realRoot && contained(r, full) && dirOk(dirname(full))) {
      try {
        const st = fs.lstatSync(full)
        ok = st.isFile() && !st.isSymbolicLink() && st.size <= MAX_FILE && contained(realRoot, fs.realpathSync.native(full))
      } catch {
        ok = false
      }
    }
    files.set(full, ok)
    return ok
  }
}

// git grep's arguments: its answer shaped whatever the repository's or the
// user's git config says (paths relative to the project folder, line numbers,
// fixed text), without the heavy folders.
export function grepArgs(root, query) {
  return [
    '-C', root,
    '-c', 'core.fsmonitor=false',
    '-c', 'grep.fullName=false',
    '-c', 'grep.lineNumber=true',
    '-c', 'grep.column=false',
    '-c', 'grep.patternType=fixed',
    '-c', 'grep.extendedRegexp=false',
    '-c', 'color.grep=never',
    'grep', '-n', '-I', '-z', '-i', '-F', '--untracked', '--no-color',
    '-e', String(query),
    '--', '.',
    ...HEAVY.filter((h) => h !== '.git').map((h) => `:(exclude,glob)**/${h}/**`)
  ]
}

// Reads git grep's output one record at a time, keeping at most MAX_RECORD
// chars of each (a huge line is not held in memory). onRecord(rec) returns
// true to stop. -> { write(text) -> stop?, end() -> stop? }
export function grepReader(onRecord) {
  let pending = ''
  let skipping = false
  const write = (text) => {
    let start = 0
    for (;;) {
      const nl = text.indexOf('\n', start)
      if (!skipping) {
        pending += nl < 0 ? text.slice(start, start + MAX_RECORD + 1) : text.slice(start, Math.min(nl, start + MAX_RECORD + 1))
        if (pending.length > MAX_RECORD) {
          pending = pending.slice(0, MAX_RECORD)
          skipping = true
        }
      }
      if (nl < 0) return false
      const rec = pending
      pending = ''
      skipping = false
      start = nl + 1
      if (onRecord(rec)) return true
    }
  }
  const end = () => {
    const rec = pending
    pending = ''
    skipping = false
    return rec ? onRecord(rec) : false
  }
  return { write, end }
}

// Content search: `git grep` in a repository (tracked and untracked files,
// not ignored ones), else the walk above. Its results follow the walk's rules
// (no link or junction, 2 MB at most, no heavy folder); a git that fails is
// said as an error, never as "no results".
export async function searchContent({ root, query, limit = SEARCH_LIMIT } = {}) {
  if (!inside(root, root)) return { ok: false, error: t('main.explorer.invalidFolder', 'Invalid folder.') }
  limit = searchCap(limit)
  const q = String(query || '').toLowerCase()
  if (!q.trim()) return { ok: true, results: [], truncated: false }
  const top = await gitTop(root)
  if (!top) return searchContentWalk({ root, query, limit })
  const allowed = grepFileCheck(root)
  return new Promise((done) => {
    const results = []
    const decoder = new StringDecoder('utf8')
    let finished = false
    let child = null
    let timer = 0
    let bytes = 0
    let stderr = ''
    // Stopped early (enough results, too much output, or too slow): git is
    // ended first, so it no longer holds the folder when the answer arrives.
    const finish = (res) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      if (!child || child.exitCode !== null || child.signalCode !== null) return done(res)
      const give = setTimeout(() => done(res), 2000)
      child.once('close', () => {
        clearTimeout(give)
        done(res)
      })
      try {
        child.kill()
      } catch {
        // gone already
      }
    }
    const reader = grepReader((rec) => {
      const r = parseGrepRecord(root, rec, q)
      if (!r || !allowed(r.path)) return false
      if (results.length >= limit) return true
      results.push(r)
      return false
    })
    try {
      child = spawn('git', grepArgs(root, query), { windowsHide: true })
    } catch {
      finished = true
      return done(searchContentWalk({ root, query, limit }))
    }
    timer = setTimeout(() => finish({ ok: true, results, truncated: true }), 20000)
    child.stdout.on('data', (chunk) => {
      if (finished) return
      bytes += chunk.length
      if (reader.write(decoder.write(chunk)) || bytes > MAX_OUTPUT) finish({ ok: true, results, truncated: true })
    })
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 4096) stderr += String(chunk)
    })
    child.on('error', () => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      done(searchContentWalk({ root, query, limit }))
    })
    child.on('close', (code) => {
      if (finished) return
      // 0: matches, 1: none; anything else is git failing.
      if (code !== 0 && code !== 1) return finish({ ok: false, error: gitError(stderr, t('main.explorer.grepFailed', 'The search failed (git grep).')) })
      const full = reader.write(decoder.end()) || reader.end()
      finish({ ok: true, results, truncated: full })
    })
  })
}

const BAD_NAME = /[<>:"/\\|?*\x00-\x1f]|^\.\.?$|[. ]$/
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i
export function checkName(name) {
  const n = String(name || '').trim()
  if (!n) return t('main.explorer.noName', 'Give it a name.')
  if (n.length > 200) return t('main.explorer.nameTooLong', 'The name is too long.')
  if (BAD_NAME.test(n) || RESERVED.test(n)) return t('main.explorer.badName', '"{{name}}" is not a valid name on Windows.', { name: n })
  return ''
}

// New file or folder in dir: -> { ok, path } | { ok: false, error }
export function create({ root, dir, name, folder = false } = {}) {
  const bad = checkName(name)
  if (bad) return { ok: false, error: bad }
  const parent = inside(root, dir || root)
  const target = parent && inside(root, join(parent, name.trim()))
  if (!target) return { ok: false, error: t('main.explorer.outside', 'Outside the project.') }
  if (fs.existsSync(target)) return { ok: false, error: t('main.explorer.exists', '"{{name}}" already exists here.', { name: name.trim() }) }
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
  if (!from || from === resolve(root)) return { ok: false, error: t('main.explorer.outside', 'Outside the project.') }
  const to = inside(root, join(dirname(from), name.trim()))
  if (!to) return { ok: false, error: t('main.explorer.outside', 'Outside the project.') }
  if (to === from) return { ok: true, path: to }
  // Only a change of case on Windows is the same file: allowed.
  if (fs.existsSync(to) && to.toLowerCase() !== from.toLowerCase()) return { ok: false, error: t('main.explorer.exists', '"{{name}}" already exists here.', { name: name.trim() }) }
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
  if (!target || target === resolve(root)) return { ok: false, error: t('main.explorer.outside', 'Outside the project.') }
  if (!fs.existsSync(target)) return { ok: false, error: t('main.explorer.gone', 'It is already gone.') }
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
      if (file && UNWATCHED.test(String(file)) && !isGitStateChange(file)) return
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

