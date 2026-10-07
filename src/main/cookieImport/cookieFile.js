// A cookie file the user exported from a browser (an extension's JSON export,
// or a Netscape cookies.txt) -> [{ cookie } | { skip }]. The way in for
// cookies Tessel cannot decrypt (Chrome's app-bound encryption). After Orca's
// browser-cookie-import-pipeline.ts (MIT, Copyright (c) 2026 Lovecast Inc.).
// The file is only read; its values stay in memory.

export const MAX_COOKIE_FILE = 32 * 1024 * 1024

const SAME_SITE_WORDS = {
  no_restriction: 'no_restriction',
  none: 'no_restriction',
  lax: 'lax',
  strict: 'strict',
  unspecified: 'unspecified'
}

function jsonExpiry(c) {
  if (c.session === true) return 0
  for (const v of [c.expirationDate, c.expires, c.expiry]) {
    if (v == null || v === '' || v === -1) continue
    if (typeof v === 'number' && Number.isFinite(v)) return v > 1e11 ? Math.floor(v / 1000) : Math.floor(v)
    const ms = Date.parse(String(v))
    if (Number.isFinite(ms)) return Math.floor(ms / 1000)
  }
  return 0
}

function fromJson(c) {
  if (!c || typeof c !== 'object' || typeof c.name !== 'string') return { skip: 'invalid' }
  const domain = String(c.domain || c.host || '').trim()
  if (!domain) return { skip: 'invalidHost' }
  if (c.partitionKey) return { skip: 'partitioned' }
  const hostOnly = typeof c.hostOnly === 'boolean' ? c.hostOnly : !domain.startsWith('.')
  return {
    cookie: {
      host: domain,
      name: c.name,
      value: c.value == null ? '' : String(c.value),
      path: typeof c.path === 'string' ? c.path : '/',
      secure: !!c.secure,
      httpOnly: !!c.httpOnly,
      sameSite: SAME_SITE_WORDS[String(c.sameSite || '').toLowerCase()] || 'unspecified',
      expires: jsonExpiry(c),
      hostOnly
    }
  }
}

// Netscape: domain, include subdomains, path, secure, expiry, name, value
// (tabs); "#HttpOnly_" before the domain marks an httpOnly cookie.
function fromNetscape(text) {
  const rows = []
  for (const raw of text.split(/\r?\n/)) {
    let line = raw
    let httpOnly = false
    if (line.startsWith('#HttpOnly_')) {
      httpOnly = true
      line = line.slice('#HttpOnly_'.length)
    } else if (!line.trim() || line.startsWith('#')) continue
    const f = line.split('\t')
    if (f.length < 7) {
      rows.push({ skip: 'invalid' })
      continue
    }
    const [domain, sub, path, secure, expiry, name, ...rest] = f
    const host = domain.trim()
    const subdomains = /^true$/i.test(sub)
    rows.push({
      cookie: {
        host: subdomains && !host.startsWith('.') ? `.${host}` : host,
        name,
        value: rest.join('\t'),
        path,
        secure: /^true$/i.test(secure),
        httpOnly,
        sameSite: 'unspecified',
        expires: Number(expiry) > 0 ? Math.floor(Number(expiry)) : 0,
        hostOnly: !subdomains
      }
    })
  }
  return rows
}

// text -> rows, or throws { code: 'format' }.
export function parseCookieFile(text) {
  const s = String(text || '').replace(/^﻿/, '')
  const trimmed = s.trim()
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    let data
    try {
      data = JSON.parse(trimmed)
    } catch {
      throw Object.assign(new Error('format'), { code: 'format' })
    }
    const list = Array.isArray(data) ? data : data && Array.isArray(data.cookies) ? data.cookies : null
    if (!list) throw Object.assign(new Error('format'), { code: 'format' })
    return list.map(fromJson)
  }
  const rows = fromNetscape(s)
  if (!rows.some((r) => r.cookie)) throw Object.assign(new Error('format'), { code: 'format' })
  return rows
}
