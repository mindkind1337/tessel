// Reading a Chromium browser's cookies (Chrome, Edge, Brave, Vivaldi, Opera,
// Arc...). After Orca's browser-cookie-chromium-import.ts, browser-cookie-
// decryption.ts and browser-cookie-sqlite.ts (MIT, Copyright (c) 2026
// Lovecast Inc.).
//
// - The database is copied first (the browser keeps it open) to a folder of
//   its own in the temp folder, read with Node's built-in sqlite, and the copy
//   is deleted right after, whatever happens. Only the copy is opened, read
//   only. Nothing decrypted is ever written anywhere.
// - Windows: the values are AES-256-GCM ("v10"/"v11") with a key kept in the
//   profile's "Local State", itself sealed by Windows (DPAPI, this user only:
//   dpapi.js unseals it). Linux: "v10" with Chromium's fixed key ("peanuts").
// - "v20" values (Chrome 127+ on Windows, app-bound encryption): only the
//   browser itself can unseal them. Not decrypted, counted as skipped; the
//   window offers the import from a cookie file instead.
// - From database version 24 on, a value starts with SHA-256 of its host: cut.
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import crypto from 'crypto'

const WINDOWS_EPOCH_OFFSET = 11644473600 // seconds from 1601 to 1970
const CHROMIUM_SAME_SITE = { '-1': 'unspecified', 0: 'no_restriction', 1: 'lax', 2: 'strict' }
const LINUX_V10_KEY = () => crypto.pbkdf2Sync('peanuts', 'saltysalt', 1, 16, 'sha1')

export function sqliteModule() {
  const sqlite = typeof process.getBuiltinModule === 'function' ? process.getBuiltinModule('node:sqlite') : null
  if (!sqlite || typeof sqlite.DatabaseSync !== 'function') throw Object.assign(new Error('no sqlite'), { code: 'no-sqlite' })
  return sqlite
}

// A database (and its -wal / -journal next to it) copied to a fresh temp
// folder: fn(copyPath) runs, then the folder goes. code 'locked' when the
// browser holds the file shut (Chrome on Windows while it runs).
export async function withDatabaseCopy(file, fn, { tmpRoot = os.tmpdir() } = {}) {
  const dir = fs.mkdtempSync(join(tmpRoot, 'tessel-cookies-'))
  const copy = join(dir, 'db.sqlite')
  try {
    try {
      await fs.promises.copyFile(file, copy)
    } catch (err) {
      const code = err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES') ? 'locked' : err && err.code === 'ENOENT' ? 'missing' : 'unreadable'
      throw Object.assign(new Error(code), { code })
    }
    for (const ext of ['-wal', '-journal']) {
      try {
        await fs.promises.copyFile(file + ext, copy + ext)
      } catch {
        // none, or busy: the main file is enough
      }
    }
    return await fn(copy)
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // the temp folder is cleaned by the system later
    }
  }
}

// Expiry (microseconds since 1601) -> seconds since 1970, 0 = session.
export function chromiumExpiry(expiresUtc, persistent = true) {
  const n = Number(expiresUtc) || 0
  if (!persistent || n <= 0) return 0
  return Math.floor(n / 1e6 - WINDOWS_EPOCH_OFFSET)
}

// The sealed key of a profile's "Local State" (os_crypt.encrypted_key: base64
// of "DPAPI" + the DPAPI blob) -> the blob, or null.
export function sealedKeyFromLocalState(localStateText) {
  let state
  try {
    state = JSON.parse(localStateText)
  } catch {
    return null
  }
  const b64 = state && state.os_crypt && state.os_crypt.encrypted_key
  if (typeof b64 !== 'string' || !b64) return null
  const raw = Buffer.from(b64, 'base64')
  if (raw.subarray(0, 5).toString('latin1') !== 'DPAPI') return null
  return raw.subarray(5)
}

// One encrypted value -> { value } (a string) or { skip: reason }.
// key: { gcm: Buffer(32) } on Windows, { cbc: Buffer(16) } on Linux.
// hostKey: the row's host_key (its SHA-256 prefixes values from version 24).
export function decryptChromiumValue(encrypted, key, hostKey, dbVersion = 0) {
  const buf = Buffer.isBuffer(encrypted) ? encrypted : Buffer.from(encrypted || [])
  if (!buf.length) return { value: '' }
  const prefix = buf.subarray(0, 3).toString('latin1')
  if (prefix === 'v20') return { skip: 'appBound' }
  if (prefix !== 'v10' && prefix !== 'v11') return { skip: 'undecryptable' }
  let plain
  try {
    if (key && key.gcm) {
      if (buf.length < 3 + 12 + 16) return { skip: 'undecryptable' }
      const nonce = buf.subarray(3, 15)
      const tag = buf.subarray(buf.length - 16)
      const decipher = crypto.createDecipheriv('aes-256-gcm', key.gcm, nonce)
      decipher.setAuthTag(tag)
      plain = Buffer.concat([decipher.update(buf.subarray(15, buf.length - 16)), decipher.final()])
    } else if (key && key.cbc) {
      const decipher = crypto.createDecipheriv('aes-128-cbc', key.cbc, Buffer.alloc(16, ' '))
      plain = Buffer.concat([decipher.update(buf.subarray(3)), decipher.final()])
    } else return { skip: 'undecryptable' }
  } catch {
    return { skip: 'undecryptable' }
  }
  // Version 24+: SHA-256(host_key) first. Older databases: cut it only when
  // it is there (a value never starts with these 32 bytes by chance).
  const hash = crypto.createHash('sha256').update(String(hostKey || '')).digest()
  if (plain.length >= 32 && (dbVersion >= 24 || plain.subarray(0, 32).equals(hash))) plain = plain.subarray(32)
  return { value: plain.toString('utf8') }
}

function hasColumn(db, table, name) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === name)
}

function dbVersionOf(db) {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'version'").get()
    return Number(row && row.value) || 0
  } catch {
    return 0
  }
}

// Counts only, no value read: { total, appBound } (for the list of browsers).
export function countChromiumCookies(dbPath) {
  const { DatabaseSync } = sqliteModule()
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const row = db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN substr(encrypted_value, 1, 3) = CAST('v20' AS BLOB) THEN 1 ELSE 0 END) AS appBound FROM cookies").get()
    return { total: Number(row.total) || 0, appBound: Number(row.appBound) || 0 }
  } finally {
    db.close()
  }
}

// Every row of a (copied) Cookies database -> [{ cookie } | { skip }].
// key: null when the browser's key could not be had (every encrypted value
// then counts as undecryptable, plain ones still come).
export function readChromiumCookies(dbPath, key) {
  const { DatabaseSync } = sqliteModule()
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const version = dbVersionOf(db)
    const partitioned = hasColumn(db, 'cookies', 'top_frame_site_key')
    const persistentCol = hasColumn(db, 'cookies', 'is_persistent') ? 'is_persistent' : hasColumn(db, 'cookies', 'has_expires') ? 'has_expires' : '1'
    const sql = `SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite, ${persistentCol} AS persistent${partitioned ? ', top_frame_site_key' : ''} FROM cookies`
    const rows = []
    for (const r of db.prepare(sql).iterate()) {
      if (partitioned && r.top_frame_site_key) {
        rows.push({ skip: 'partitioned' })
        continue
      }
      let value = typeof r.value === 'string' ? r.value : ''
      const enc = r.encrypted_value
      if (enc && enc.length) {
        const d = decryptChromiumValue(Buffer.from(enc), key, r.host_key, version)
        if (d.skip) {
          rows.push({ skip: d.skip, host: r.host_key })
          continue
        }
        value = d.value
      }
      rows.push({
        cookie: {
          host: r.host_key,
          name: r.name,
          value,
          path: r.path,
          secure: !!r.is_secure,
          httpOnly: !!r.is_httponly,
          sameSite: CHROMIUM_SAME_SITE[String(r.samesite)] || 'unspecified',
          expires: chromiumExpiry(r.expires_utc, !!r.persistent),
          hostOnly: !String(r.host_key || '').startsWith('.')
        }
      })
    }
    return rows
  } finally {
    db.close()
  }
}

// The browser's key: Windows -> unsealed through DPAPI (unprotect(blob) ->
// Buffer), Linux -> the fixed v10 key, elsewhere null.
export async function chromiumKey(localStatePath, { platform = process.platform, unprotect } = {}) {
  if (platform === 'linux') return { cbc: LINUX_V10_KEY() }
  if (platform !== 'win32') return null
  let text
  try {
    text = fs.readFileSync(localStatePath, 'utf8')
  } catch {
    return null
  }
  const sealed = sealedKeyFromLocalState(text)
  if (!sealed || !unprotect) return null
  try {
    const key = await unprotect(sealed)
    return key && key.length === 32 ? { gcm: key } : null
  } catch {
    return null
  }
}
