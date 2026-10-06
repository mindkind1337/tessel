// The import a profile (or a file) into Tessel's browser session: detection
// (detect.js), reading the source (chromium.js / firefox.js / cookieFile.js),
// the plan (cookies.js) and the write into Electron's session. The main
// process wires this up in index.js; nothing here reaches the renderer but
// counts and domain names.
import { detectBrowsers } from './detect'
import { withDatabaseCopy, readChromiumCookies, chromiumKey, countChromiumCookies, cleanStaleCopies } from './chromium'
import { readFirefoxCookies, countFirefoxCookies } from './firefox'
import { parseCookieFile, MAX_COOKIE_FILE } from './cookieFile'
import { planImport, writeCookies, parseDomainFilter, isGoogleHost } from './cookies'
import { unprotectDpapi } from './dpapi'
import { isAllowedCookieFilePath } from './fileTokens'
import fs from 'fs'
import os from 'os'

// The browsers and profiles, each profile with a cheap cookie count (and how
// many of its cookies are app-bound, so the window can warn before an import).
// Values are never read here.
export async function listBrowsersForImport(opts = {}) {
  const browsers = await detectBrowsers(opts)
  return browsers.map((b) => ({
    id: b.id,
    name: b.name,
    family: b.family,
    isDefault: !!b.isDefault,
    profiles: b.profiles.map((p) => {
      let count = null
      let appBound = 0
      try {
        const c = b.family === 'firefox' ? countFirefoxCookies(p.cookiesPath) : countChromiumCookies(p.cookiesPath)
        count = c.total
        appBound = c.appBound
      } catch {
        // locked (the browser is open) or no sqlite: no count, still offered
      }
      return { dir: p.dir, name: p.name, lastUsed: !!p.lastUsed, cookieCount: count, appBoundCount: appBound }
    })
  }))
}

// One profile -> rows, with the Chromium key unsealed when needed. The copy of
// the database is made and deleted inside withDatabaseCopy.
async function readProfileRows(browser, profile, { platform = process.platform, unprotect = unprotectDpapi, tmpRoot } = {}) {
  if (browser.family === 'firefox') {
    return withDatabaseCopy(profile.cookiesPath, (copy) => readFirefoxCookies(copy), { tmpRoot })
  }
  const key = await chromiumKey(browser.localStatePath, { platform, unprotect })
  return withDatabaseCopy(profile.cookiesPath, (copy) => readChromiumCookies(copy, key), { tmpRoot })
}

// Import a detected browser's profile. target: { session } (Electron). Returns
// { ok, summary } or { ok: false, code }.
export async function importFromProfile({ browser, profile, session, domainFilter = '', deps = {} }) {
  if (!browser || !profile || !session) return { ok: false, code: 'invalid' }
  const domains = parseDomainFilter(domainFilter)
  // Copies an earlier run left behind go first.
  cleanStaleCopies([deps.tmpRoot, os.tmpdir()].filter(Boolean))
  let rows
  try {
    rows = await readProfileRows(browser, profile, deps)
  } catch (err) {
    return { ok: false, code: (err && err.code) || 'read-failed' }
  }
  const { writes, summary } = planImport(rows, { domains })
  await writeCookies(session, writes, summary)
  return { ok: true, summary }
}

// Import from a cookie file (the way in for app-bound cookies).
export async function importFromFile({ filePath, session, domainFilter = '' }) {
  if (!filePath || !session) return { ok: false, code: 'invalid' }
  // A local file only (no network share, no device path).
  if (!isAllowedCookieFilePath(filePath)) return { ok: false, code: 'refused' }
  let stat
  try {
    stat = fs.statSync(filePath)
  } catch {
    return { ok: false, code: 'missing' }
  }
  if (!stat.isFile() || stat.size > MAX_COOKIE_FILE) return { ok: false, code: 'too-big' }
  let text
  try {
    text = fs.readFileSync(filePath, 'utf8')
  } catch {
    return { ok: false, code: 'read-failed' }
  }
  let rows
  try {
    rows = parseCookieFile(text)
  } catch {
    return { ok: false, code: 'format' }
  }
  const domains = parseDomainFilter(domainFilter)
  const { writes, summary } = planImport(rows, { domains })
  await writeCookies(session, writes, summary)
  return { ok: true, summary }
}

export { isGoogleHost }
