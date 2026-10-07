// Cookies read from another browser (or a file) -> Tessel's browser session.
// After Orca's cookie import (MIT, Copyright (c) 2026 Lovecast Inc.:
// src/main/browser/browser-cookie-import*.ts, browser-cookie-sqlite.ts):
// the same attribute mapping (secure, httpOnly, sameSite, expiry, host-only
// vs domain cookies) and the same Google exclusion, written for Tessel.
//
// A cookie here is { host, name, value, path, secure, httpOnly, sameSite,
// expires (seconds since 1970, 0 = a session cookie), hostOnly }. Its value is
// never logged, never written to a file, never sent to the window: only
// counts and domain names leave this module.

// sameSite as Electron's cookies.set takes it.
export const SAME_SITE = ['unspecified', 'no_restriction', 'lax', 'strict']

// Google signs a session out everywhere when its cookies show up in another
// app (session theft protection), and refuses sign-in in embedded browsers:
// never imported; the user signs in to Google in Tessel's browser instead.
const GOOGLE = /(^|\.)google\.(com|[a-z]{2,3}|com?\.[a-z]{2})$/i

export function isGoogleHost(host) {
  return GOOGLE.test(String(host || '').replace(/^\./, ''))
}

// "github.com, .example.org" -> ['github.com', 'example.org'] (lower case, no
// scheme, no path); [] = every domain.
export function parseDomainFilter(text) {
  const out = []
  for (const raw of String(text || '').split(/[\s,;]+/)) {
    let d = raw.trim().toLowerCase()
    if (!d) continue
    d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/^\*?\.+/, '')
    if (/^[a-z0-9.-]{1,253}$/.test(d) && !out.includes(d)) out.push(d)
  }
  return out.slice(0, 50)
}

// Does a cookie's host belong to one of the filter's domains (itself or a
// subdomain)? An empty filter takes everything.
export function matchesDomains(host, domains) {
  if (!domains || !domains.length) return true
  const h = String(host || '').replace(/^\./, '').toLowerCase()
  return domains.some((d) => h === d || h.endsWith(`.${d}`))
}

// A cookie -> the details of Electron's session.cookies.set, or null with
// why: 'invalidHost' (no host, or not a host name), 'invalid' (no name, a
// name too long), 'expired' (setting it would delete the cookie instead).
export function toElectronCookie(c, nowSec = Date.now() / 1000) {
  if (!c || typeof c.name !== 'string' || typeof c.value !== 'string') return { skip: 'invalid' }
  const rawHost = String(c.host || '').trim().toLowerCase()
  const host = rawHost.replace(/^\./, '')
  if (!host || !/^[a-z0-9._-]+$|^\[[0-9a-f:.]+\]$/.test(host)) return { skip: 'invalidHost' }
  if (c.name.length > 4096) return { skip: 'invalid' }
  const path = typeof c.path === 'string' && c.path.startsWith('/') ? c.path : '/'
  const expires = Number(c.expires) || 0
  if (expires > 0 && expires <= nowSec) return { skip: 'expired' }
  const secure = !!c.secure
  let sameSite = SAME_SITE.includes(c.sameSite) ? c.sameSite : 'unspecified'
  // SameSite=None needs Secure, or Chromium refuses the cookie.
  if (sameSite === 'no_restriction' && !secure) sameSite = 'unspecified'
  // A host-only cookie: no domain (a domain would widen it to subdomains).
  const hostOnly = c.hostOnly != null ? !!c.hostOnly : !rawHost.startsWith('.')
  const details = {
    url: `${secure ? 'https' : 'http'}://${host}${path}`,
    name: c.name,
    value: c.value,
    path,
    secure,
    httpOnly: !!c.httpOnly,
    sameSite
  }
  if (!hostOnly) details.domain = `.${host}`
  // Chromium caps an expiry at 400 days from now.
  if (expires > 0) details.expirationDate = Math.min(expires, nowSec + 400 * 24 * 3600)
  return { details }
}

// An empty summary; reasons are counted, never listed cookie by cookie.
export function newSummary() {
  return {
    total: 0,
    imported: 0,
    skipped: 0,
    // Of the imported ones, against what the session had before (null when
    // the session could not be read).
    added: null,
    updated: null,
    unchanged: null,
    reasons: { appBound: 0, google: 0, expired: 0, filtered: 0, partitioned: 0, container: 0, undecryptable: 0, invalidHost: 0, invalid: 0, rejected: 0 },
    domains: []
  }
}

export function skip(summary, reason, n = 1) {
  summary.skipped += n
  summary.reasons[reason] = (summary.reasons[reason] || 0) + n
}

// Plan which cookies go in: the filter, Google, expired and invalid ones out.
// cookies: [{ cookie } | { skip: reason }] (rows a reader could not use come
// with their reason). -> { writes: [details], summary }
export function planImport(rows, { domains = [], nowSec = Date.now() / 1000 } = {}) {
  const summary = newSummary()
  const writes = []
  const seenDomains = new Set()
  for (const row of rows) {
    summary.total++
    if (row.skip) {
      skip(summary, row.skip)
      continue
    }
    const c = row.cookie
    if (!matchesDomains(c.host, domains)) {
      skip(summary, 'filtered')
      continue
    }
    if (isGoogleHost(c.host)) {
      skip(summary, 'google')
      continue
    }
    const mapped = toElectronCookie(c, nowSec)
    if (!mapped.details) {
      skip(summary, mapped.skip)
      continue
    }
    writes.push(mapped.details)
    seenDomains.add(String(c.host).replace(/^\./, '').toLowerCase())
  }
  summary.domains = [...seenDomains].sort().slice(0, 500)
  return { writes, summary }
}

// A cookie's identity in a jar: name + domain + path. domain: '.host' for a
// domain cookie, 'host' for a host-only one (Chromium's own way).
export function cookieKey(name, domain, path) {
  return [name, String(domain || '').toLowerCase(), path || '/'].join('\u0000')
}

function detailsKey(d) {
  let domain = d.domain
  if (!domain) {
    try {
      domain = new URL(d.url).hostname
    } catch {
      domain = ''
    }
  }
  return cookieKey(d.name, domain, d.path)
}

// What decides "unchanged": the value and the flags. Kept in the main
// process's memory only, for the length of one import.
function fingerprint(c) {
  return `${c.secure ? 1 : 0}${c.httpOnly ? 1 : 0}${c.value}`
}

// The session's cookies before the import: key -> fingerprint, or null when
// they could not be read.
export async function snapshotSession(ses) {
  try {
    const list = await ses.cookies.get({})
    const map = new Map()
    for (const c of list || []) {
      const bare = String(c.domain || '').replace(/^\./, '')
      const domain = c.hostOnly === false || (c.hostOnly == null && String(c.domain || '').startsWith('.')) ? `.${bare}` : bare
      map.set(cookieKey(c.name, domain, c.path), fingerprint(c))
    }
    return map
  } catch {
    return null
  }
}

// The cookies into the session (the browser's own, never Tessel's), a few at a
// time. A cookie Chromium refuses is counted, its value never shown. Each one
// written is counted new, updated or unchanged against the session's cookies
// before (compared here, in the main process; only the counts leave).
export async function writeCookies(ses, writes, summary, { batch = 50 } = {}) {
  const before = await snapshotSession(ses)
  if (before) {
    summary.added = 0
    summary.updated = 0
    summary.unchanged = 0
  }
  for (let i = 0; i < writes.length; i += batch) {
    const part = writes.slice(i, i + batch)
    const results = await Promise.allSettled(part.map((d) => ses.cookies.set(d)))
    results.forEach((r, j) => {
      if (r.status !== 'fulfilled') {
        skip(summary, 'rejected')
        return
      }
      summary.imported++
      if (!before) return
      const d = part[j]
      const key = detailsKey(d)
      const had = before.get(key)
      const now = fingerprint(d)
      if (had == null) summary.added++
      else if (had === now) summary.unchanged++
      else summary.updated++
      // The same cookie twice in one source: the second is not new.
      before.set(key, now)
    })
  }
  if (typeof ses.cookies.flushStore === 'function') await ses.cookies.flushStore().catch(() => {})
  return summary
}
