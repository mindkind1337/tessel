// Reading a Firefox profile's cookies (Firefox, Zen, LibreWolf, Waterfox).
// After Orca's browser-cookie-firefox-import.ts (MIT, Copyright (c) 2026
// Lovecast Inc.). Firefox keeps the values in clear in cookies.sqlite: the
// database is copied (withDatabaseCopy, chromium.js: deleted right after)
// and read there.
import { sqliteModule } from './chromium'

const FIREFOX_SAME_SITE = { 0: 'unspecified', 1: 'lax', 2: 'strict' }

// Firefox's expiry: seconds, milliseconds since Firefox 136.
export function firefoxExpiry(expiry) {
  const n = Number(expiry) || 0
  if (n <= 0) return 0
  return n > 1e11 ? Math.floor(n / 1000) : Math.floor(n)
}

export function countFirefoxCookies(dbPath) {
  const { DatabaseSync } = sqliteModule()
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const row = db.prepare('SELECT COUNT(*) AS total FROM moz_cookies').get()
    return { total: Number(row.total) || 0, appBound: 0 }
  } finally {
    db.close()
  }
}

// -> [{ cookie } | { skip }]. A container's or a partitioned cookie
// (originAttributes) has no place in Tessel's single jar: skipped.
export function readFirefoxCookies(dbPath) {
  const { DatabaseSync } = sqliteModule()
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const rows = []
    for (const r of db.prepare('SELECT originAttributes, name, value, host, path, expiry, isSecure, isHttpOnly, sameSite FROM moz_cookies').iterate()) {
      if (r.originAttributes) {
        rows.push({ skip: 'partitioned' })
        continue
      }
      const host = String(r.host || '')
      rows.push({
        cookie: {
          host,
          name: String(r.name == null ? '' : r.name),
          value: String(r.value == null ? '' : r.value),
          path: r.path,
          secure: !!r.isSecure,
          httpOnly: !!r.isHttpOnly,
          sameSite: FIREFOX_SAME_SITE[String(r.sameSite)] || 'unspecified',
          expires: firefoxExpiry(r.expiry),
          hostOnly: !host.startsWith('.')
        }
      })
    }
    return rows
  } finally {
    db.close()
  }
}
