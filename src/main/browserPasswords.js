// Local-only password vault. Secrets never cross shell IPC or agent results.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { secureStorageAvailable } from './credentialProtection'
import { withDatabaseCopy, sqliteModule, chromiumKey, decryptChromiumValue } from './cookieImport/chromium'
import { unprotectDpapi } from './cookieImport/dpapi'
import { detectBrowsers } from './cookieImport/detect'

const MAX_BYTES = 10 * 1024 * 1024
const fail = (code) => Object.assign(new Error(code), { code })
export function loginOrigin(url) {
  try { const u = new URL(url); return u.protocol === 'https:' && !u.username && !u.password ? u.origin : null } catch { return null }
}

// RFC4180 fields, including quoted commas, CRLF, newlines and escaped quotes.
export function parsePasswordCsv(text) {
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw fail('too-big')
  const rows = []
  let row = [], field = '', quoted = false
  text = text.replace(/^\uFEFF/, '')
  for (let i = 0; i <= text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++ }
      else if (c === '"') quoted = false
      else if (c === undefined) throw fail('format')
      else field += c
    } else if (c === '"' && !field) quoted = true
    else if (c === ',' || c === '\n' || c === undefined) {
      row.push(field); field = ''
      if (c !== ',') { if (row.some(Boolean)) rows.push(row); row = [] }
    } else if (c !== '\r' || text[i + 1] !== '\n') field += c
    if (rows.length > 5001) throw fail('too-big')
  }
  const headers = (rows.shift() || []).map((h) => h.trim().toLowerCase())
  const url = headers.indexOf('url'), username = headers.indexOf('username'), password = headers.indexOf('password')
  if (url < 0 || username < 0 || password < 0) throw fail('format')
  return rows.map((r) => ({ origin: loginOrigin(r[url]), username: r[username] || '', password: r[password] || '' }))
}

export function createPasswordVault({ file, safeStorage }) {
  function read() {
    if (!secureStorageAvailable(safeStorage)) throw fail('encryption-unavailable')
    try {
      const stat = fs.lstatSync(file)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES * 2) throw fail('vault-unavailable')
      const rows = JSON.parse(safeStorage.decryptString(fs.readFileSync(file)))
      if (!Array.isArray(rows) || rows.length > 5000) throw fail('vault-unavailable')
      return rows
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw fail('vault-unavailable')
    }
  }
  function write(rows) {
    if (!secureStorageAvailable(safeStorage)) throw fail('encryption-unavailable')
    if (rows.length > 5000) throw fail('too-big')
    const bytes = safeStorage.encryptString(JSON.stringify(rows))
    if (bytes.length > MAX_BYTES * 2) throw fail('too-big')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${crypto.randomUUID()}.tmp`
    try { fs.writeFileSync(tmp, bytes, { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, file) }
    finally { try { fs.unlinkSync(tmp) } catch { /* only encrypted temporary bytes */ } }
  }
  const metadata = (r) => ({ id: r.id, origin: r.origin, username: r.username, allowAgents: r.allowAgents === true })
  function list(origin = null, agent = false) {
    return read().filter((r) => (!origin || r.origin === origin) && (!agent || r.allowAgents === true)).map(metadata)
  }
  function importRows(incoming) {
    const rows = read()
    let imported = 0, skipped = 0
    for (const item of incoming) {
      const origin = loginOrigin(item.origin)
      if (!origin || typeof item.password !== 'string' || !item.password || item.password.length > 16384 || typeof item.username !== 'string' || item.username.length > 2000) { skipped++; continue }
      const old = rows.find((r) => r.origin === origin && r.username === item.username)
      if (old) { old.password = item.password; old.allowAgents = false }
      else rows.push({ id: crypto.randomUUID(), origin, username: item.username, password: item.password, allowAgents: false })
      imported++
    }
    write(rows)
    return { ok: true, imported, skipped }
  }
  function change(id, action, allowAgents) {
    const rows = read()
    const entry = rows.find((r) => r.id === id)
    if (!entry) return { ok: false, code: 'not-found' }
    if (action === 'delete') write(rows.filter((r) => r.id !== id))
    else if (action === 'allow') { entry.allowAgents = allowAgents === true; write(rows) }
    else return { ok: false, code: 'invalid' }
    return { ok: true }
  }
  function credential(id, origin, agent = false) {
    const r = read().find((r) => r.id === id && r.origin === origin && (!agent || r.allowAgents === true))
    if (!r) throw fail('refused')
    return r
  }
  return { list, importRows, change, credential }
}

export async function passwordSources() {
  return (await detectBrowsers({ includePasswords: true })).filter((b) => b.family === 'chromium').map((b) => ({
    id: b.id, name: b.name,
    profiles: b.profiles.filter((p) => ['Login Data', 'Login Data For Account'].some((f) => fs.existsSync(path.join(p.dir, f)))).map((p) => ({ dir: p.dir, name: p.name }))
  })).filter((b) => b.profiles.length)
}

export async function importBrowserPasswords(vault, { browserId, profileDir }, tmpRoot) {
  const browser = (await detectBrowsers({ includePasswords: true })).find((b) => b.id === browserId && b.family === 'chromium')
  const profile = browser?.profiles.find((p) => p.dir === profileDir)
  if (!profile) throw fail('not-found')
  const key = await chromiumKey(browser.localStatePath, { unprotect: unprotectDpapi })
  const incoming = []
  let protectedCount = 0
  for (const name of ['Login Data', 'Login Data For Account']) {
    const file = path.join(profile.dir, name)
    if (!fs.existsSync(file)) continue
    await withDatabaseCopy(file, async (copy) => {
      const { DatabaseSync } = sqliteModule()
      const db = new DatabaseSync(copy, { readOnly: true })
      try {
        for (const row of db.prepare('SELECT origin_url, username_value, password_value FROM logins WHERE blacklisted_by_user = 0 LIMIT 5001').all()) {
          const encrypted = Buffer.from(row.password_value || [])
          let result = decryptChromiumValue(encrypted, key, '', 0)
          if (encrypted.length && !/^v\d\d/.test(encrypted.subarray(0, 3).toString()) && process.platform === 'win32') {
            try { result = { value: (await unprotectDpapi(encrypted)).toString('utf8') } } catch { result = { skip: 'protected' } }
          }
          if (result.skip) { protectedCount++; continue }
          incoming.push({ origin: row.origin_url, username: row.username_value || '', password: result.value })
        }
      } finally { db.close() }
    }, { tmpRoot })
  }
  return { ...vault.importRows(incoming), protectedCount }
}

// Runs only in the main frame's isolated world. Rechecks the exact origin
// inside that world to close navigation races. Never submits the login form.
export function passwordFillScript(entry) {
  return `(${function (login) {
    if (location.origin !== login.origin || location.protocol !== 'https:') return { ok: false, code: 'wrong-site' }
    const visible = (e) => !e.disabled && !e.readOnly && e.getClientRects().length && getComputedStyle(e).visibility === 'visible'
    const passwords = [...document.querySelectorAll('input[type="password"]')].filter(visible).filter((e) => e.autocomplete !== 'new-password')
    if (passwords.length !== 1) return { ok: false, code: 'no-login-form' }
    const password = passwords[0]
    const form = password.form
    if (!form || new URL(form.action || location.href, location.href).origin !== login.origin) return { ok: false, code: 'unsafe-form' }
    const candidates = [...form.querySelectorAll('input')].filter(visible).filter((e) => ['text', 'email'].includes(e.type))
    const named = candidates.filter((e) => e.autocomplete === 'username' || e.type === 'email')
    const username = named.length === 1 ? named[0] : candidates.length === 1 ? candidates[0] : null
    if (!username && candidates.length) return { ok: false, code: 'ambiguous-form' }
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    const fill = (e, value) => { setter.call(e, value); e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })) }
    if (username) fill(username, login.username)
    if (location.origin !== login.origin || !password.isConnected || password.type !== 'password' || new URL(form.action || location.href, location.href).origin !== login.origin) return { ok: false, code: 'unsafe-form' }
    fill(password, login.password)
    return { ok: true, submitted: false }
  }.toString()})(${JSON.stringify({ origin: entry.origin, username: entry.username, password: entry.password })})`
}

export async function fillSavedPassword({ vault, guest, id, agent = false, allowed }) {
  if (!guest || !allowed(guest)) return { ok: false, code: 'private-page-required' }
  const origin = loginOrigin(guest.getURL())
  if (!origin) return { ok: false, code: 'https-required' }
  try {
    const entry = vault.credential(id, origin, agent)
    if (!allowed(guest)) return { ok: false, code: 'private-page-required' }
    const result = await guest.executeJavaScriptInIsolatedWorld(1998, [{ code: passwordFillScript(entry) }], true)
    // Never relay arbitrary page output (or page exception messages).
    if (result?.ok === true) return { ok: true, submitted: false }
    const codes = ['wrong-site', 'no-login-form', 'unsafe-form', 'ambiguous-form']
    return { ok: false, code: codes.includes(result?.code) ? result.code : 'fill-failed' }
  } catch { return { ok: false, code: 'fill-failed' } }
}
