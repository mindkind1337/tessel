// Files for Tessel's code editor (EditorPane.vue): read, write, watch, and
// the last committed version for the Changes view. The approach follows
// Orca's filesystem read/write handlers and file-diff (MIT, Copyright (c)
// 2026 Lovecast Inc.): text only (a NUL in the first 8 KB means binary), a
// size cap, a UTF-8 BOM kept as it was, and line endings written exactly as
// the editor holds them. Writes are atomic: a temporary file in the same
// folder, then a rename over the file.
import fs from 'fs'
import { isAbsolute, dirname, basename, join, resolve, relative, sep } from 'path'
import { execFile } from 'child_process'
import crypto from 'crypto'
import { t } from './i18n'

export const MAX_EDIT_BYTES = 50 * 1024 * 1024
export const MAX_HEAD_BYTES = 10 * 1024 * 1024
export const BINARY_ERROR = 'Binary file: open it with its own program'

const BOM = Buffer.from([0xef, 0xbb, 0xbf])

// A file's identity on disk for change detection: modified time and size.
export function signatureOf(st) {
  return st ? `${Math.round(st.mtimeMs)}:${st.size}` : null
}

function checkPath(file) {
  if (typeof file !== 'string' || !file || file.length > 4000 || !isAbsolute(file)) return t('main.editor.notFullPath', 'Not a full file path.')
  return ''
}

// A NUL byte in the first 8 KB: binary (Orca's test, and git's).
export function looksBinary(buf) {
  return buf.subarray(0, 8192).includes(0)
}

// -> { ok, text, bom, size, mtimeMs, sig } | { ok: false, error, code }
// code: 'missing' | 'binary' | 'too-large' | 'encoding' | 'not-file' | 'error'
export function readForEdit(file) {
  const bad = checkPath(file)
  if (bad) return { ok: false, error: bad, code: 'error' }
  let st
  try {
    st = fs.statSync(file)
  } catch (err) {
    return err && err.code === 'ENOENT'
      ? { ok: false, error: t('main.editor.notFound', 'The file was not found.'), code: 'missing' }
      : { ok: false, error: (err && err.message) || t('main.editor.readFailed', 'The file could not be read.'), code: 'error' }
  }
  if (!st.isFile()) return { ok: false, error: t('main.editor.notFile', 'This is not a file.'), code: 'not-file' }
  if (st.size > MAX_EDIT_BYTES) return { ok: false, error: t('main.editor.tooLarge', 'This file is too large to edit here (over 50 MB).'), code: 'too-large' }
  let buf
  try {
    buf = fs.readFileSync(file)
  } catch (err) {
    return { ok: false, error: (err && err.message) || t('main.editor.readFailed', 'The file could not be read.'), code: 'error' }
  }
  if (looksBinary(buf)) return { ok: false, error: t('main.editor.binary', 'Binary file: open it with its own program'), code: 'binary' }
  const bom = buf.length >= 3 && buf.subarray(0, 3).equals(BOM)
  const body = bom ? buf.subarray(3) : buf
  let text
  try {
    // Not UTF-8 (an old code page): refused rather than saved back mangled.
    text = new TextDecoder('utf-8', { fatal: true }).decode(body)
  } catch {
    return { ok: false, error: t('main.editor.notUtf8', 'This file is not UTF-8 text: open it with another editor.'), code: 'encoding' }
  }
  return { ok: true, text, bom, size: st.size, mtimeMs: st.mtimeMs, sig: signatureOf(st), hash: hashOf(buf) }
}

// A file's content identity (its bytes, BOM included).
export function hashOf(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

// Has the file changed since the editor last knew it (expectHash: its bytes
// then, expectSig: its signature then)? Neither given: not checked. A file
// gone meanwhile has nothing to overwrite. -> { changed, sig }
export function changedOnDisk(file, { expectSig, expectHash } = {}) {
  if (expectSig === undefined && expectHash === undefined) return { changed: false, sig: null }
  let st
  try {
    st = fs.statSync(file)
  } catch {
    return { changed: false, sig: null }
  }
  const sig = signatureOf(st)
  if (typeof expectHash === 'string' && expectHash) {
    // The content decides: touched but the same bytes is no change, and a
    // change that kept the size and time is still one.
    try {
      return { changed: hashOf(fs.readFileSync(file)) !== expectHash, sig }
    } catch {
      return { changed: true, sig }
    }
  }
  return { changed: sig !== expectSig, sig }
}

// -> { ok, exists, size, mtimeMs, sig }
export function statForEdit(file) {
  const bad = checkPath(file)
  if (bad) return { ok: false, error: bad }
  try {
    const st = fs.statSync(file)
    if (!st.isFile()) return { ok: true, exists: false, sig: null }
    return { ok: true, exists: true, size: st.size, mtimeMs: st.mtimeMs, sig: signatureOf(st) }
  } catch {
    return { ok: true, exists: false, sig: null }
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// Replace `target` with `tmp`. Windows refuses a rename over a file another
// program holds open for a moment (antivirus, indexer): tried a few times.
async function renameOver(tmp, target) {
  let last = null
  for (let i = 0; i < 6; i++) {
    try {
      fs.renameSync(tmp, target)
      return null
    } catch (err) {
      last = err
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(err && err.code)) break
      await wait(40 * (i + 1))
    }
  }
  return last
}

// { file, text, bom, expectSig, expectHash } -> { ok, size, mtimeMs, sig, hash }
// | { ok: false, error } | { ok: false, conflict: true, error, sig }
// expectSig / expectHash: the file as the editor last knew it. Changed on disk
// since (an agent wrote it before the watcher told the window): refused, never
// overwritten; the editor treats it as a change made on disk.
export async function writeForEdit({ file, text, bom = false, expectSig, expectHash } = {}) {
  const bad = checkPath(file)
  if (bad) return { ok: false, error: bad }
  if (typeof text !== 'string') return { ok: false, error: t('main.editor.nothingToWrite', 'Nothing to write.') }
  let target = file
  let mode = null
  try {
    const st = fs.lstatSync(file)
    // A link: the file it points to is written (the link stays a link).
    if (st.isSymbolicLink()) target = fs.realpathSync(file)
    const real = fs.statSync(target)
    if (real.isDirectory()) return { ok: false, error: t('main.editor.isFolder', 'This is a folder.') }
    mode = real.mode
  } catch (err) {
    if (!err || err.code !== 'ENOENT') return { ok: false, error: (err && err.message) || t('main.editor.writeFailed', 'The file could not be written.') }
  }
  const data = bom ? Buffer.concat([BOM, Buffer.from(text, 'utf8')]) : Buffer.from(text, 'utf8')
  if (data.length > MAX_EDIT_BYTES) return { ok: false, error: t('main.editor.textTooLarge', 'The text is too large to save (over 50 MB).') }
  const expect = { expectSig, expectHash }
  const conflict = (sig) => ({ ok: false, conflict: true, sig, error: t('main.editor.changedOnDisk', 'The file was changed on disk by another program.') })
  const before = changedOnDisk(target, expect)
  if (before.changed) return conflict(before.sig)
  const dir = dirname(target)
  const tmp = join(dir, `.${basename(target)}.tessel-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`)
  try {
    fs.writeFileSync(tmp, data, { flag: 'wx' })
    if (mode !== null) {
      try {
        fs.chmodSync(tmp, mode & 0o777)
      } catch {
        // permissions kept by default on Windows
      }
    }
  } catch (err) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      // not created
    }
    return { ok: false, error: (err && err.message) || t('main.editor.writeFailed', 'The file could not be written.') }
  }
  // Checked again right before the file is replaced (the write took time).
  const late = changedOnDisk(target, expect)
  if (late.changed) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      // gone already
    }
    return conflict(late.sig)
  }
  const failed = await renameOver(tmp, target)
  if (failed) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      // gone already
    }
    return { ok: false, error: failed.message || t('main.editor.replaceFailed', 'The file could not be replaced.') }
  }
  const st = statForEdit(target)
  return { ok: true, size: st.size, mtimeMs: st.mtimeMs, sig: st.sig, hash: hashOf(data) }
}

function git(args, opts = {}) {
  return new Promise((done) =>
    execFile(
      'git',
      args,
      { windowsHide: true, timeout: 20000, maxBuffer: opts.maxBuffer || 1024 * 1024, encoding: 'buffer' },
      (err, stdout, stderr) => done({ err, stdout: stdout || Buffer.alloc(0), stderr: String(stderr || '') })
    )
  )
}

// The file as it is in the last commit, for the Changes view.
// -> { ok, repo, isNew, text, note } | { ok: false, error }
export async function headContent(file) {
  const bad = checkPath(file)
  if (bad) return { ok: false, error: bad }
  let real = file
  try {
    real = fs.realpathSync(file)
  } catch {
    real = resolve(file)
  }
  const topRes = await git(['-C', dirname(real), 'rev-parse', '--show-toplevel'])
  const top = topRes.err ? '' : String(topRes.stdout).trim()
  if (!top) return { ok: true, repo: false, isNew: true, text: '', note: t('main.editor.noteNotRepo', 'Not in a git repository: there is no committed version to compare with.') }
  const rel = relative(resolve(top), real)
  if (!rel || rel.startsWith('..') || isAbsolute(rel))
    return { ok: true, repo: false, isNew: true, text: '', note: t('main.editor.noteOutside', 'Outside the repository: there is no committed version to compare with.') }
  const spec = `HEAD:${rel.split(sep).join('/')}`
  const res = await git(['-C', resolve(top), '-c', 'core.quotepath=off', 'show', spec], { maxBuffer: MAX_HEAD_BYTES + 1 })
  if (res.err) {
    if (/maxBuffer/i.test(String(res.err.message || '')) || res.err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
      return { ok: false, error: t('main.editor.headTooLarge', 'The committed version is too large to compare (over 10 MB).') }
    const noHead = /bad revision|unknown revision|invalid object name 'HEAD'|ambiguous argument 'HEAD'/i.test(res.stderr)
    return {
      ok: true,
      repo: true,
      isNew: true,
      text: '',
      note: noHead
        ? t('main.editor.noteNoCommit', 'No commit yet: the left side is empty.')
        : t('main.editor.noteNewFile', 'Not in the last commit (a new file): the left side is empty.')
    }
  }
  const buf = res.stdout
  if (buf.length > MAX_HEAD_BYTES) return { ok: false, error: t('main.editor.headTooLarge', 'The committed version is too large to compare (over 10 MB).') }
  if (looksBinary(buf)) return { ok: false, error: t('main.editor.headBinary', 'The committed version is binary: it cannot be compared here.') }
  const body = buf.length >= 3 && buf.subarray(0, 3).equals(BOM) ? buf.subarray(3) : buf
  return { ok: true, repo: true, isNew: false, text: body.toString('utf8'), note: '' }
}

// Watching the files open in the editor: each file's folder is watched (a
// rename over the file, as editors and agents save, is seen too), and every
// file is checked every 2 s as a backstop (a folder deleted, a network
// drive). onChange({ path, exists, size, mtimeMs, sig }) when a file's
// signature changes; noteWritten() records Tessel's own save so it is not
// reported back.
export function createFileWatcher(onChange, { pollMs = 2000, debounceMs = 100 } = {}) {
  const files = new Map() // key -> { path, sig, timer }
  const dirs = new Map() // dir key -> { watcher, keys: Set }
  const keyOf = (p) => resolve(p).toLowerCase()

  function check(entry) {
    entry.timer = null
    const st = statForEdit(entry.path)
    const sig = st.ok && st.exists ? st.sig : null
    if (sig === entry.sig) return
    entry.sig = sig
    onChange({ path: entry.path, exists: sig !== null, size: st.size || 0, mtimeMs: st.mtimeMs || 0, sig })
  }
  function soon(entry) {
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => check(entry), debounceMs)
  }
  function watchDir(dir) {
    const dk = keyOf(dir)
    if (dirs.has(dk)) return dirs.get(dk)
    const d = { watcher: null, keys: new Set() }
    try {
      d.watcher = fs.watch(dir, (_type, name) => {
        for (const k of d.keys) {
          const e = files.get(k)
          if (!e) continue
          if (!name || basename(e.path).toLowerCase() === String(name).toLowerCase()) soon(e)
        }
      })
      d.watcher.on('error', () => {
        // The folder is gone: the poll reports its files as deleted.
        try {
          d.watcher.close()
        } catch {
          // closed
        }
        d.watcher = null
      })
    } catch {
      d.watcher = null
    }
    dirs.set(dk, d)
    return d
  }
  function add(p) {
    const k = keyOf(p)
    if (files.has(k)) return
    const st = statForEdit(p)
    files.set(k, { path: p, sig: st.ok && st.exists ? st.sig : null, timer: null })
    watchDir(dirname(resolve(p))).keys.add(k)
  }
  function remove(k) {
    const e = files.get(k)
    if (!e) return
    if (e.timer) clearTimeout(e.timer)
    files.delete(k)
    const dk = keyOf(dirname(resolve(e.path)))
    const d = dirs.get(dk)
    if (d) {
      d.keys.delete(k)
      if (!d.keys.size) {
        try {
          if (d.watcher) d.watcher.close()
        } catch {
          // closed
        }
        dirs.delete(dk)
      }
    }
  }
  // The files to watch now (others stop being watched).
  function set(paths) {
    const want = new Map()
    for (const p of Array.isArray(paths) ? paths.slice(0, 500) : []) {
      if (typeof p === 'string' && isAbsolute(p)) want.set(keyOf(p), p)
    }
    for (const k of [...files.keys()]) if (!want.has(k)) remove(k)
    for (const p of want.values()) add(p)
    return files.size
  }
  function noteWritten(p, sig) {
    const e = files.get(keyOf(p))
    if (e) e.sig = sig
  }
  const poll = setInterval(() => {
    for (const e of files.values()) {
      if (!e.timer) check(e)
      // A folder whose watcher failed (it was gone): watched again once back.
      const d = dirs.get(keyOf(dirname(resolve(e.path))))
      if (d && !d.watcher && fs.existsSync(dirname(resolve(e.path)))) {
        dirs.delete(keyOf(dirname(resolve(e.path))))
        const again = watchDir(dirname(resolve(e.path)))
        for (const k of d.keys) again.keys.add(k)
      }
    }
  }, pollMs)
  if (poll.unref) poll.unref()
  function close() {
    clearInterval(poll)
    for (const k of [...files.keys()]) remove(k)
  }
  return { set, noteWritten, close, size: () => files.size }
}
