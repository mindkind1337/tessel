// JSON files that must survive a crash or a kill mid-write (the dev build is
// restarted on every source change): written to a temp file, then renamed
// over the real one, keeping the previous good copy as <file>.bak. Reading
// falls back to that copy when the file is damaged, and keeps the damaged
// file aside (<file>.corrupt-<time>) instead of letting it be overwritten.
//
// `valid(data)` (optional) says whether parsed content has the expected
// shape; content that parses but fails it counts as damaged.
import fs from 'fs'
import { resolve } from 'path'

const anyShape = () => true
const transientRead = ['EPERM', 'EBUSY', 'EACCES']
// A failed load must never turn a fallback/empty UI into a saved replacement
// of unread data. Only another successful load lifts this write protection.
const unloaded = new Set()

// The parsed content of `file` when it is good, else undefined.
function readGood(file, valid) {
  let text
  for (let i = 0; ; i++) {
    try {
      text = fs.readFileSync(file, 'utf8')
      break
    } catch (err) {
      if (err.code === 'ENOENT') return undefined
      // A failed read says nothing about the contents. Retry brief Windows
      // sharing locks, then propagate the error without declaring corruption.
      if (i >= 20 || !transientRead.includes(err.code)) throw err
      sleepSync(25)
    }
  }
  try {
    const data = JSON.parse(text)
    return valid(data) ? data : undefined
  } catch {
    return undefined
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// The file a write really replaces, and its mode. A symbolic link (a
// dotfiles setup linking ~/.claude/settings.json elsewhere) is written through
// to its target, never replaced by a plain file; a link whose target is gone
// is refused (the error propagates, nothing is written).
function writeTarget(file) {
  let stat
  try {
    stat = fs.lstatSync(file)
  } catch (err) {
    if (err.code === 'ENOENT') return { file, mode: null }
    throw err
  }
  if (!stat.isSymbolicLink()) return { file, mode: stat.mode }
  const real = fs.realpathSync(file)
  return { file: real, mode: fs.statSync(real).mode }
}

// Write `text` to `file` through a temp file + rename. On Windows the rename
// fails for a moment while another process (a team tool reading the file, an
// antivirus scan) has the file open: tried again for about half a second.
// The temp file never stays behind. The file keeps its mode (permissions,
// where the system has them), and a symbolic link its target (see above).
export function writeFileAtomic(path, text) {
  const { file, mode } = writeTarget(path)
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, text, mode === null ? 'utf8' : { encoding: 'utf8', mode: mode & 0o7777 })
  if (mode !== null) {
    try {
      // The mode given at creation is reduced by the umask: set it again.
      fs.chmodSync(tmp, mode & 0o7777)
    } catch {
      // not supported here: the default mode
    }
  }
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file)
      return
    } catch (err) {
      if (i >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) {
        try {
          fs.unlinkSync(tmp)
        } catch {
          // nothing left to clean
        }
        throw err
      }
      sleepSync(25)
    }
  }
}
const writeAtomic = writeFileAtomic

// What was last written to a file by this process (its text, size and
// modification time): a save of the same text, with the file still as it was
// left, writes nothing (opts.skipIfSame).
const lastWritten = new Map()

// Options for big files saved often (the task board, 3 MB):
//   indent         spaces in the file (default 2; 0: compact, a third smaller)
//   backupEveryMs  the .bak is replaced at most this often (default: at every
//                  write); the check that the file is good (a read and a
//                  parse of all of it) and the copy are then not paid by each
//                  save
//   skipIfSame     nothing is written when the text is the one this process
//                  last wrote and the file has not changed since
// -> { written: boolean }
export function writeJsonSafe(file, data, valid = anyShape, opts = {}) {
  if (unloaded.has(resolve(file))) {
    // i18n-ignore shared with the team tools (inlined in their process, no i18n there)
    throw Object.assign(new Error('Saved data has not been loaded; reload it before saving.'), {
      code: 'EJSONUNREAD'
    })
  }
  const text = JSON.stringify(data, null, opts.indent === undefined ? 2 : opts.indent)
  const key = resolve(file)
  if (opts.skipIfSame) {
    const last = lastWritten.get(key)
    if (last && last.text === text) {
      try {
        const st = fs.statSync(file)
        if (st.size === last.size && st.mtimeMs === last.mtimeMs && st.ino === last.ino) return { written: false }
      } catch {
        // gone or unreadable: written again
      }
    }
  }
  // Only a good file becomes the backup (a damaged one would replace the
  // last good copy), and the backup itself is replaced atomically.
  try {
    const bak = `${file}.bak`
    let fresh = false
    if (opts.backupEveryMs > 0) {
      try {
        // A copy "from the future" (the clock was set back since) is not
        // fresh: it would not be renewed until the clock caught up.
        const age = Date.now() - fs.statSync(bak).mtimeMs
        fresh = age >= 0 && age < opts.backupEveryMs
      } catch {
        fresh = false
      }
    }
    if (!fresh && fs.existsSync(file) && readGood(file, valid) !== undefined) {
      writeAtomic(bak, fs.readFileSync(file, 'utf8'))
    }
  } catch {
    // no new backup this time; the previous one is still intact
  }
  writeAtomic(file, text)
  if (opts.skipIfSame) {
    try {
      const st = fs.statSync(file)
      lastWritten.set(key, { text, size: st.size, mtimeMs: st.mtimeMs, ino: st.ino })
    } catch {
      lastWritten.delete(key)
    }
  }
  return { written: true }
}

function readAvailable(file, valid) {
  let corrupt = null
  // existsSync can hide access errors; an actual read distinguishes those
  // from a genuinely absent first save.
  const data = readGood(file, valid)
  if (data !== undefined) return { data, from: 'file', corrupt }
  if (fs.existsSync(file)) {
    corrupt = `${file}.corrupt-${Date.now()}`
    try {
      fs.copyFileSync(file, corrupt)
    } catch {
      corrupt = null
    }
  }
  const bak = readGood(`${file}.bak`, valid)
  if (bak !== undefined) return { data: bak, from: 'backup', corrupt }
  return { data: null, from: null, corrupt }
}

// -> { data, from: 'file' | 'backup' | null, corrupt: path | null, locked? }
// Strict by default for queues: an older snapshot cannot be safely replayed.
// UI loaders may request a read-only backup while they retry the primary.
export function readJsonSafe(file, valid = anyShape, { onLocked = 'throw' } = {}) {
  const key = resolve(file)
  try {
    const result = readAvailable(file, valid)
    unloaded.delete(key)
    return result
  } catch (err) {
    unloaded.add(key)
    if (onLocked !== 'backup') throw err
    let backup
    try {
      backup = readGood(`${file}.bak`, valid)
    } catch {
      // No readable snapshot; still locked, never a new empty document.
    }
    return {
      data: backup === undefined ? null : backup,
      from: backup === undefined ? null : 'backup',
      corrupt: null,
      locked: true
    }
  }
}
