// Small file readers shared by the main process (agents' session files,
// settings, databases). None of them throws: a missing or unreadable file
// reads as empty ('' / null / []).
import fs from 'fs'

// The first `bytes` of a file as text.
export function readHead(file, bytes = 256 * 1024) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(bytes)
    const n = fs.readSync(fd, buf, 0, bytes, 0)
    return buf.subarray(0, n).toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

// The first line of a file (read from its first `bytes`).
export function readFirstLine(file, bytes = 64 * 1024) {
  const text = readHead(file, bytes)
  const nl = text.indexOf('\n')
  return nl >= 0 ? text.slice(0, nl) : text
}

// The last `bytes` of a file as text (its first line may be cut).
export function readTail(file, bytes = 256 * 1024) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const size = fs.fstatSync(fd).size
    const len = Math.min(bytes, size)
    const buf = Buffer.alloc(len)
    const n = fs.readSync(fd, buf, 0, len, size - len)
    return buf.subarray(0, n).toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

export function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

// Parsed JSON, or null.
export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

// A folder path in one form, to compare two ways of writing it
// (C:/Proj, c:\proj\ -> c:\proj).
export function normDir(p) {
  return String(p || '')
    .replace(/\//g, '\\')
    .replace(/\\+$/, '')
    .toLowerCase()
}

// Rows from a SQLite database opened read-only (Node's built-in sqlite), or []
// when it cannot be read (missing, busy, another layout).
export function readRows(file, sql, params = []) {
  const sqlite = process.getBuiltinModule ? process.getBuiltinModule('node:sqlite') : null
  if (!sqlite || !fs.existsSync(file)) return []
  let db
  try {
    db = new sqlite.DatabaseSync(file, { readOnly: true })
    return db.prepare(sql).all(...params)
  } catch {
    return []
  } finally {
    try {
      if (db) db.close()
    } catch {
      /* closed */
    }
  }
}
