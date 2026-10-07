// Parsing and decryption of imported cookies, with fixtures generated here
// (fake keys and databases): no real browser, no real cookie is read.
import { describe, it, expect } from 'vitest'
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import {
  decryptChromiumValue,
  chromiumExpiry,
  sealedKeyFromLocalState,
  readChromiumCookies,
  countChromiumCookies,
  withDatabaseCopy
} from '../cookieImport/chromium'
import { firefoxExpiry } from '../cookieImport/firefox'
import { toElectronCookie, planImport, parseDomainFilter, matchesDomains, isGoogleHost } from '../cookieImport/cookies'
import { parseCookieFile } from '../cookieImport/cookieFile'

const sqlite = process.getBuiltinModule('node:sqlite')

const GCM_KEY = crypto.randomBytes(32)
const CBC_KEY = crypto.pbkdf2Sync('peanuts', 'saltysalt', 1, 16, 'sha1')

function encGcm(plaintext, prefix = 'v10') {
  const nonce = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', GCM_KEY, nonce)
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()])
  return Buffer.concat([Buffer.from(prefix), nonce, ct, cipher.getAuthTag()])
}
function encCbc(plaintext) {
  const cipher = crypto.createCipheriv('aes-128-cbc', CBC_KEY, Buffer.alloc(16, ' '))
  return Buffer.concat([Buffer.from('v10'), cipher.update(Buffer.from(plaintext)), cipher.final()])
}

describe('decryptChromiumValue', () => {
  it('decrypts a Windows AES-256-GCM value', () => {
    expect(decryptChromiumValue(encGcm('secret-token'), { gcm: GCM_KEY }, '.example.com').value).toBe('secret-token')
  })

  it('decrypts a Linux AES-128-CBC v10 value', () => {
    expect(decryptChromiumValue(encCbc('linux-value'), { cbc: CBC_KEY }, '.example.com').value).toBe('linux-value')
  })

  it('skips an app-bound v20 value without decrypting', () => {
    expect(decryptChromiumValue(encGcm('x', 'v20'), { gcm: GCM_KEY }, '.example.com')).toEqual({ skip: 'appBound' })
  })

  it('strips the version-24 host-key hash prefix', () => {
    const hash = crypto.createHash('sha256').update('.example.com').digest()
    const enc = encGcm(Buffer.concat([hash, Buffer.from('value')]))
    expect(decryptChromiumValue(enc, { gcm: GCM_KEY }, '.example.com', 24).value).toBe('value')
  })

  it('reports undecryptable when the key is missing', () => {
    expect(decryptChromiumValue(encGcm('x'), null, '.example.com')).toEqual({ skip: 'undecryptable' })
  })

  it('returns an empty string for an empty encrypted value', () => {
    expect(decryptChromiumValue(Buffer.alloc(0), { gcm: GCM_KEY }, '.example.com').value).toBe('')
  })
})

describe('sealedKeyFromLocalState', () => {
  it('reads the DPAPI-prefixed os_crypt key', () => {
    const blob = Buffer.from('fake-dpapi-blob')
    const text = JSON.stringify({ os_crypt: { encrypted_key: Buffer.concat([Buffer.from('DPAPI'), blob]).toString('base64') } })
    expect(sealedKeyFromLocalState(text)).toEqual(blob)
  })
  it('returns null when the prefix is not DPAPI', () => {
    const text = JSON.stringify({ os_crypt: { encrypted_key: Buffer.from('nope').toString('base64') } })
    expect(sealedKeyFromLocalState(text)).toBeNull()
  })
})

describe('chromiumExpiry / firefoxExpiry', () => {
  it('maps Chromium microseconds-since-1601 to seconds-since-1970', () => {
    // 2021-01-01 in Chromium time: 13253932800 s after 1601 -> microseconds.
    const micros = (13253932800) * 1e6
    expect(chromiumExpiry(micros)).toBe(13253932800 - 11644473600)
  })
  it('treats a non-persistent cookie as a session cookie', () => {
    expect(chromiumExpiry(13253932800e6, false)).toBe(0)
  })
  it('maps Firefox seconds and milliseconds', () => {
    expect(firefoxExpiry(1700000000)).toBe(1700000000)
    expect(firefoxExpiry(1700000000000)).toBe(1700000000)
  })
})

describe('toElectronCookie attribute mapping', () => {
  it('maps a domain cookie, keeping secure/httpOnly/sameSite/expiry', () => {
    const soon = Math.floor(Date.now() / 1000) + 3600
    const { details } = toElectronCookie({ host: '.example.com', name: 's', value: 'v', path: '/app', secure: true, httpOnly: true, sameSite: 'lax', expires: soon, hostOnly: false })
    expect(details).toMatchObject({ url: 'https://example.com/app', domain: '.example.com', name: 's', secure: true, httpOnly: true, sameSite: 'lax', expirationDate: soon })
  })
  it('drops the domain for a host-only cookie', () => {
    const { details } = toElectronCookie({ host: 'example.com', name: 's', value: 'v', hostOnly: true, secure: false })
    expect(details.domain).toBeUndefined()
    expect(details.url).toBe('http://example.com/')
  })
  it('downgrades SameSite=None without Secure to unspecified', () => {
    const { details } = toElectronCookie({ host: 'example.com', name: 's', value: 'v', sameSite: 'no_restriction', secure: false })
    expect(details.sameSite).toBe('unspecified')
  })
  it('skips an expired cookie and an invalid one', () => {
    expect(toElectronCookie({ host: 'example.com', name: 's', value: 'v', expires: 10 }, 1000).skip).toBe('expired')
    expect(toElectronCookie({ host: '', name: 's', value: 'v' }).skip).toBe('invalidHost')
  })
  it('caps the expiry at 400 days', () => {
    const now = 1_000_000_000
    const { details } = toElectronCookie({ host: 'example.com', name: 's', value: 'v', expires: now + 999 * 24 * 3600 }, now)
    expect(details.expirationDate).toBe(now + 400 * 24 * 3600)
  })
})

describe('planImport', () => {
  const rows = (list) => list.map((c) => ({ cookie: c }))
  it('imports plain cookies and counts their domains', () => {
    const { writes, summary } = planImport(rows([
      { host: '.github.com', name: 'a', value: '1', secure: true },
      { host: 'linear.app', name: 'b', value: '2', secure: true }
    ]))
    expect(writes).toHaveLength(2)
    expect(summary.domains).toEqual(['github.com', 'linear.app'])
  })
  it('never imports a Google-family cookie and counts it', () => {
    const { writes, summary } = planImport(rows([
      { host: '.google.com', name: 'SID', value: 'x', secure: true },
      { host: 'accounts.google.co.uk', name: 'y', value: 'x', secure: true },
      { host: '.example.com', name: 'ok', value: 'x', secure: true }
    ]))
    expect(writes.map((w) => w.name)).toEqual(['ok'])
    expect(summary.reasons.google).toBe(2)
  })
  it('applies a domain filter', () => {
    const { writes, summary } = planImport(rows([
      { host: 'github.com', name: 'a', value: '1', secure: true },
      { host: 'other.com', name: 'b', value: '2', secure: true }
    ]), { domains: parseDomainFilter('github.com') })
    expect(writes.map((w) => w.name)).toEqual(['a'])
    expect(summary.reasons.filtered).toBe(1)
  })
  it('carries a reader skip (app-bound) into the summary', () => {
    const { summary } = planImport([{ skip: 'appBound' }, { cookie: { host: 'a.com', name: 'n', value: 'v', secure: true } }])
    expect(summary.reasons.appBound).toBe(1)
    expect(summary.total).toBe(2)
  })
})

describe('domain helpers', () => {
  it('matches a domain and its subdomains', () => {
    expect(matchesDomains('sub.example.com', ['example.com'])).toBe(true)
    expect(matchesDomains('notexample.com', ['example.com'])).toBe(false)
    expect(matchesDomains('x.com', [])).toBe(true)
  })
  it('knows the Google family', () => {
    expect(isGoogleHost('.google.com')).toBe(true)
    expect(isGoogleHost('mail.google.co.uk')).toBe(true)
    expect(isGoogleHost('notgoogle.com')).toBe(false)
  })
})

describe('parseCookieFile', () => {
  it('reads an extension JSON export', () => {
    const rows = parseCookieFile(JSON.stringify([{ domain: '.example.com', name: 'a', value: '1', secure: true, expirationDate: 2000000000, sameSite: 'lax' }]))
    expect(rows[0].cookie).toMatchObject({ host: '.example.com', name: 'a', sameSite: 'lax', expires: 2000000000 })
  })
  it('reads a Netscape cookies.txt, including #HttpOnly_', () => {
    const txt = '# Netscape HTTP Cookie File\n#HttpOnly_.example.com\tTRUE\t/\tTRUE\t2000000000\tsession\tabc\n'
    const rows = parseCookieFile(txt)
    expect(rows[0].cookie).toMatchObject({ host: '.example.com', name: 'session', value: 'abc', httpOnly: true, secure: true, hostOnly: false })
  })
  it('throws on an unknown format', () => {
    expect(() => parseCookieFile('not a cookie file at all')).toThrow()
  })
})

describe('reading a generated Chromium database', () => {
  function makeDb(dir, rows, version = 24) {
    const file = join(dir, 'Cookies')
    const db = new sqlite.DatabaseSync(file)
    db.exec('CREATE TABLE meta(key TEXT, value TEXT)')
    db.prepare('INSERT INTO meta VALUES(?, ?)').run('version', String(version))
    db.exec('CREATE TABLE cookies(host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER, is_persistent INTEGER)')
    const ins = db.prepare('INSERT INTO cookies VALUES(?,?,?,?,?,?,?,?,?,?)')
    for (const r of rows) ins.run(r.host, r.name, '', r.enc, r.path || '/', r.expires || 0, r.secure ? 1 : 0, r.httpOnly ? 1 : 0, r.samesite == null ? -1 : r.samesite, r.persistent ? 1 : 0)
    db.close()
    return file
  }

  it('reads, decrypts and maps cookies, skipping app-bound ones', async () => {
    const dir = fs.mkdtempSync(join(os.tmpdir(), 'cookietest-'))
    try {
      const hash = crypto.createHash('sha256').update('.example.com').digest()
      const file = makeDb(dir, [
        { host: '.example.com', name: 'good', enc: encGcm(Buffer.concat([hash, Buffer.from('tok')])), secure: true, samesite: 1, persistent: 0 },
        { host: '.example.com', name: 'bound', enc: encGcm('x', 'v20'), secure: true }
      ])
      const rows = readChromiumCookies(file, { gcm: GCM_KEY })
      const good = rows.find((r) => r.cookie && r.cookie.name === 'good')
      expect(good.cookie.value).toBe('tok')
      expect(good.cookie.sameSite).toBe('lax')
      expect(rows.some((r) => r.skip === 'appBound')).toBe(true)
      expect(countChromiumCookies(file).total).toBe(2)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('copies a database to a temp folder and deletes the copy after', async () => {
    const dir = fs.mkdtempSync(join(os.tmpdir(), 'cookietest-'))
    try {
      const file = makeDb(dir, [{ host: 'a.com', name: 'n', enc: encGcm('v'), secure: true }])
      let copyPath
      const rows = await withDatabaseCopy(file, (copy) => {
        copyPath = copy
        expect(fs.existsSync(copy)).toBe(true)
        return readChromiumCookies(copy, { gcm: GCM_KEY })
      })
      expect(rows[0].cookie.value).toBe('v')
      expect(fs.existsSync(copyPath)).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
