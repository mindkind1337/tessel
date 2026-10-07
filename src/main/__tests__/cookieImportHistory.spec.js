// Remembering imports (history.js), counting new / updated / unchanged
// against the session, the skip reasons, and real-size expiry values in
// generated databases. Fixtures only: no real browser, no real cookie.
import { describe, it, expect } from 'vitest'
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { createImportHistory, historyEntry } from '../cookieImport/history'
import { planImport, writeCookies, toElectronCookie, cookieKey } from '../cookieImport/cookies'
import { readChromiumCookies } from '../cookieImport/chromium'
import { readFirefoxCookies, originSkipReason } from '../cookieImport/firefox'
import { importFromProfile, listBrowsersForImport } from '../cookieImport/importer'

const sqlite = process.getBuiltinModule('node:sqlite')
const NOW = 1_790_000_000 // seconds, 2026

function tmpDir() {
  return fs.mkdtempSync(join(os.tmpdir(), 'cookiehist-'))
}

// A fake Electron session: a jar keyed like Chromium's (name, domain, path).
function fakeSession(initial = []) {
  const jar = new Map()
  const put = (c) => jar.set(cookieKey(c.name, c.domain, c.path), c)
  for (const c of initial) put(c)
  return {
    jar,
    cookies: {
      get: async () => [...jar.values()].map((c) => ({ ...c })),
      set: async (d) => {
        if (d.name === 'refuse-me') throw new Error('refused')
        const host = new URL(d.url).hostname
        put({ name: d.name, value: d.value, domain: d.domain || host, hostOnly: !d.domain, path: d.path, secure: d.secure, httpOnly: d.httpOnly })
      },
      flushStore: async () => {}
    }
  }
}

function cookie(name, value, host = '.example.com', extra = {}) {
  return { cookie: { host, name, value, path: '/', secure: true, httpOnly: false, expires: NOW + 3600, ...extra } }
}

describe('history', () => {
  it('keeps counts and dates only, per browser and profile', () => {
    const dir = tmpDir()
    try {
      const file = join(dir, 'cookie-imports.json')
      const h = createImportHistory(file)
      expect(h.get('firefox', 'P1')).toBeNull()
      const summary = { total: 5, imported: 3, added: 3, updated: 0, unchanged: 0, skipped: 2, reasons: { expired: 2, google: 0 }, domains: ['secret-site.example'] }
      h.record('firefox', 'P1', summary, 1000)
      const again = createImportHistory(file)
      expect(again.get('firefox', 'P1')).toEqual({ at: 1000, total: 5, imported: 3, added: 3, updated: 0, unchanged: 0, skipped: 2, reasons: { expired: 2 } })
      expect(again.get('firefox', 'P2')).toBeNull()
      // No domain, no name, no value in the file.
      expect(fs.readFileSync(file, 'utf8')).not.toMatch(/secret-site/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('survives a broken file', () => {
    const dir = tmpDir()
    try {
      const file = join(dir, 'cookie-imports.json')
      fs.writeFileSync(file, '{not json')
      const h = createImportHistory(file)
      expect(h.get('x', 'y')).toBeNull()
      h.record('x', 'y', { imported: 1 }, 5)
      expect(createImportHistory(file).get('x', 'y').imported).toBe(1)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('drops odd reason keys and non-numbers', () => {
    expect(historyEntry({ imported: 'a', reasons: { 'a b': 1, ok: 2, bad: 'x' } }, 7)).toMatchObject({ at: 7, imported: null, reasons: { ok: 2 } })
  })
})

describe('new / updated / unchanged', () => {
  it('compares with the session by name, domain and path', async () => {
    const ses = fakeSession([
      { name: 'same', value: 'v1', domain: '.example.com', hostOnly: false, path: '/', secure: true, httpOnly: false },
      { name: 'changed', value: 'old', domain: '.example.com', hostOnly: false, path: '/', secure: true, httpOnly: false },
      // Same name, other path: a different cookie.
      { name: 'new-path', value: 'v', domain: '.example.com', hostOnly: false, path: '/a', secure: true, httpOnly: false },
      // Host-only vs domain cookie: different cookies too.
      { name: 'host-only', value: 'v', domain: 'example.com', hostOnly: true, path: '/', secure: true, httpOnly: false }
    ])
    const { writes, summary } = planImport(
      [cookie('same', 'v1'), cookie('changed', 'new'), cookie('new-path', 'v'), cookie('host-only', 'v'), cookie('fresh', 'v', 'example.com'), cookie('refuse-me', 'v')],
      { nowSec: NOW }
    )
    await writeCookies(ses, writes, summary)
    expect(summary).toMatchObject({ imported: 5, added: 3, updated: 1, unchanged: 1 })
    expect(summary.reasons.rejected).toBe(1)
  })

  it('a second identical import is all unchanged', async () => {
    const ses = fakeSession()
    const rows = [cookie('a', '1'), cookie('b', '2', 'b.example.org')]
    const first = planImport(rows, { nowSec: NOW })
    await writeCookies(ses, first.writes, first.summary)
    expect(first.summary).toMatchObject({ added: 2, updated: 0, unchanged: 0 })
    const second = planImport(rows, { nowSec: NOW })
    await writeCookies(ses, second.writes, second.summary)
    expect(second.summary).toMatchObject({ imported: 2, added: 0, updated: 0, unchanged: 2 })
  })

  it('a duplicate in one source is not counted new twice', async () => {
    const ses = fakeSession()
    const { writes, summary } = planImport([cookie('a', '1'), cookie('a', '2')], { nowSec: NOW })
    await writeCookies(ses, writes, summary)
    expect(summary).toMatchObject({ added: 1, updated: 1 })
  })

  it('leaves the counts null when the session cannot be read', async () => {
    const ses = fakeSession()
    ses.cookies.get = async () => {
      throw new Error('nope')
    }
    const { writes, summary } = planImport([cookie('a', '1')], { nowSec: NOW })
    await writeCookies(ses, writes, summary)
    expect(summary).toMatchObject({ imported: 1, added: null, updated: null, unchanged: null })
  })
})

describe('skip reasons', () => {
  it('tells an invalid host from other malformed cookies', () => {
    expect(toElectronCookie({ host: 'bad host!', name: 'n', value: 'v' }).skip).toBe('invalidHost')
    expect(toElectronCookie({ host: 'a.com', name: 'x'.repeat(5000), value: 'v' }).skip).toBe('invalid')
    expect(toElectronCookie({ host: 'a.com', name: 3, value: 'v' }).skip).toBe('invalid')
  })
  it('keeps session cookies (no expiry) and valid hosts', () => {
    const r = toElectronCookie({ host: 'localhost', name: 'n', value: 'v', expires: 0 }, NOW)
    expect(r.details).toBeTruthy()
    expect(r.details.expirationDate).toBeUndefined()
    expect(toElectronCookie({ host: '[::1]', name: 'n', value: 'v' }, NOW).details).toBeTruthy()
    expect(toElectronCookie({ host: '.sub_domain.example.co.uk', name: 'n', value: 'v' }, NOW).details).toBeTruthy()
  })
  it('splits Firefox containers from partitioned cookies', () => {
    expect(originSkipReason('')).toBeNull()
    expect(originSkipReason('^userContextId=2')).toBe('container')
    expect(originSkipReason('^partitionKey=%28https%2Cexample.com%29')).toBe('partitioned')
    expect(originSkipReason('^firstPartyDomain=example.com')).toBe('partitioned')
    expect(originSkipReason('^privateBrowsingId=1')).toBe('partitioned')
  })
})

describe('real-size expiry values', () => {
  it('reads a Chromium database whose expires_utc is past a safe JS integer', () => {
    const dir = tmpDir()
    try {
      const file = join(dir, 'Cookies')
      const db = new sqlite.DatabaseSync(file)
      db.exec('CREATE TABLE meta(key TEXT, value TEXT)')
      db.exec("INSERT INTO meta VALUES('version', '24')")
      db.exec('CREATE TABLE cookies(host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER, is_persistent INTEGER)')
      // 2027 in microseconds since 1601: about 1.34e16 (> 2^53).
      const expiresUtc = BigInt(NOW + 3600 * 24 * 30 + 11644473600) * 1000000n
      db.prepare('INSERT INTO cookies VALUES(?,?,?,?,?,?,?,?,?,?)').run('.example.com', 'plain', 'v', Buffer.alloc(0), '/', expiresUtc, 1, 0, -1, 1)
      db.close()
      const rows = readChromiumCookies(file, null)
      expect(rows).toHaveLength(1)
      expect(rows[0].cookie.expires).toBe(NOW + 3600 * 24 * 30)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads a Firefox database with containers, partitioned and huge expiries', () => {
    const dir = tmpDir()
    try {
      const file = join(dir, 'cookies.sqlite')
      const db = new sqlite.DatabaseSync(file)
      db.exec('CREATE TABLE moz_cookies(originAttributes TEXT, name TEXT, value TEXT, host TEXT, path TEXT, expiry INTEGER, isSecure INTEGER, isHttpOnly INTEGER, sameSite INTEGER)')
      const ins = db.prepare('INSERT INTO moz_cookies VALUES(?,?,?,?,?,?,?,?,?)')
      ins.run('', 'ok', 'v', '.example.com', '/', (NOW + 60) * 1000, 1, 0, 1)
      ins.run('', 'forever', 'v', 'example.com', '/', 9223372036854775807n, 1, 0, 0)
      ins.run('^userContextId=1', 'c', 'v', '.example.com', '/', (NOW + 60) * 1000, 1, 0, 0)
      ins.run('^partitionKey=%28https%2Cother.com%29', 'p', 'v', '.example.com', '/', (NOW + 60) * 1000, 1, 0, 0)
      db.close()
      const rows = readFirefoxCookies(file)
      expect(rows.filter((r) => r.cookie).map((r) => r.cookie.name)).toEqual(['ok', 'forever'])
      expect(rows.filter((r) => r.skip).map((r) => r.skip)).toEqual(['container', 'partitioned'])
      // The far-future one is kept (capped at 400 days when written).
      const forever = toElectronCookie(rows[1].cookie, NOW)
      expect(forever.details.expirationDate).toBe(NOW + 400 * 24 * 3600)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('importFromProfile with a history', () => {
  function firefoxProfile(dir) {
    const file = join(dir, 'cookies.sqlite')
    const db = new sqlite.DatabaseSync(file)
    db.exec('CREATE TABLE moz_cookies(originAttributes TEXT, name TEXT, value TEXT, host TEXT, path TEXT, expiry INTEGER, isSecure INTEGER, isHttpOnly INTEGER, sameSite INTEGER)')
    const ins = db.prepare('INSERT INTO moz_cookies VALUES(?,?,?,?,?,?,?,?,?)')
    const later = (Math.floor(Date.now() / 1000) + 3600) * 1000
    ins.run('', 'a', '1', '.example.com', '/', later, 1, 0, 1)
    ins.run('', 'b', '2', 'example.org', '/', later, 1, 0, 1)
    ins.run('', 'old', '3', 'example.org', '/', 1000, 1, 0, 1)
    db.close()
    return file
  }

  it('says when the profile was imported before and records each import', async () => {
    const dir = tmpDir()
    try {
      const browser = { id: 'firefox', name: 'Firefox', family: 'firefox', profiles: [] }
      const profile = { dir: join(dir, 'P'), name: 'dev-edition-default', cookiesPath: firefoxProfile(dir) }
      const history = createImportHistory(join(dir, 'cookie-imports.json'))
      const ses = fakeSession()
      const deps = { tmpRoot: join(dir, 'tmp') }
      const first = await importFromProfile({ browser, profile, session: ses, history, deps })
      expect(first.summary).toMatchObject({ imported: 2, added: 2, previousAt: null })
      expect(first.summary.reasons.expired).toBe(1)
      const recorded = history.get('firefox', profile.dir)
      expect(recorded).toMatchObject({ imported: 2, added: 2, skipped: 1, reasons: { expired: 1 } })
      const second = await importFromProfile({ browser, profile, session: ses, history, deps })
      expect(second.summary).toMatchObject({ imported: 2, added: 0, updated: 0, unchanged: 2, previousAt: recorded.at })

      // The list shows the last import: date and count, nothing else.
      browser.profiles = [profile]
      const list = await listBrowsersForImport({ history, detect: async () => [browser] })
      expect(list[0].profiles[0]).toMatchObject({ cookieCount: 3, lastImport: { at: history.get('firefox', profile.dir).at, imported: 2 } })
      expect(Object.keys(list[0].profiles[0].lastImport)).toEqual(['at', 'imported'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
