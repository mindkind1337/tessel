// Live Share: a host's browser page as its guests get it, a link. The host's
// Tessel never streams its pages (no picture, no input): with "See my
// browser pages", a guest gets each page's address and title and opens the
// address in its own browser tab, with its own session and cookies, never
// the host's.
//
// What an address may carry to a guest (linkForGuest), on the host and again
// on the guest (a host is not trusted with what it sends):
// - http and https only; never a user or a password (URL.host has neither);
// - the whole address (path, query, fragment) when nothing in it reads as a
//   secret, so a video or a search opens at the same place;
// - only the origin when something does: a query or fragment parameter
//   named like a secret (token, key, code, password, secret, auth...), a
//   value or a path segment that reads as one (a share link's id, a reset
//   code, a long random run). The origin alone, never a guess at a "safe"
//   part of the path: a capability link opened at its root gives nothing;
// - local: an address that only works on the host's computer or network
//   (localhost, a private range, a .local name: livePageUrl.js
//   localOnlyHost). It is still sent (the guest's tab says where it runs),
//   but the guest never opens it.
//
// Pure: no DOM, no Electron.
import { localOnlyHost } from './livePageUrl.js'

export const LINK_LIMITS = Object.freeze({ url: 2000, title: 200 })

/* eslint-disable no-control-regex */
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g
/* eslint-enable no-control-regex */

// A query or fragment parameter whose name says it is a secret.
const SECRET_NAMES = new Set(['code', 'key', 'sig', 'sid', 'pwd', 'pass', 'otp', 'jwt', 'ticket', 'session', 'auth'])
const SECRET_PARTS = ['token', 'secret', 'passw', 'apikey', 'api_key', 'api-key', 'credential', 'signature', 'access_key', 'accesskey', 'private_key', 'session_id', 'sessionid', 'auth_', '_auth', 'authorization', 'x-amz-']
const secretName = (name) => {
  const n = String(name || '').toLowerCase()
  return SECRET_NAMES.has(n) || SECRET_PARTS.some((p) => n.includes(p))
}
// A segment (or a value) that reads as a token: a UUID, a long hex run, an
// email, or a part (between - _ . ~ +) that reads as random, or three short
// parts that each mix letters and digits or both cases. A slug
// ("2024-05-01-my-post") or a word in CamelCase is not one.
const TOKEN_SEGMENT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|@/i
function randomPart(p) {
  if (p.length < 12) return false
  const letters = p.replace(/[^A-Za-z]/g, '').length
  const digits = p.replace(/[^0-9]/g, '').length
  if (letters && digits && letters / p.length >= 0.15 && digits / p.length >= 0.15) return true
  if (/^[A-Za-z0-9+/=]+$/.test(p) && letters >= 12) {
    const upper = p.replace(/[^A-Z]/g, '').length / letters
    if (upper >= 0.25 && upper <= 0.75) return true
  }
  return /^[a-z]{16,}$/.test(p) && (p.match(/[aeiouy]/g) || []).length / p.length < 0.2
}
const mixedPart = (p) => p.length >= 3 && ((/\d/.test(p) && /[A-Za-z]/.test(p)) || (/[A-Z].*[A-Z]/.test(p) && /[a-z].*[a-z]/.test(p)))
export function tokenLike(text) {
  const s = String(text || '')
  if (TOKEN_SEGMENT.test(s)) return true
  const parts = s.split(/[-_.~+]+/)
  return parts.some(randomPart) || parts.filter(mixedPart).length >= 3
}
// The segment after one of these words is a code or an id (/reset/<code>,
// /invite/<id>, /auth/callback...).
const SECRET_BEFORE = /^(reset|verify|verification|invite|invitation|token|magic|share|shared|auth|oauth|login|signin|sign-in|callback|confirm|activate|unsubscribe)s?([-_].*)?$/i

const decoded = (s) => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}
// "a=1&b=2" (a query without "?" or a fragment without "#") -> whether a
// parameter is named like a secret or holds one.
function secretParams(text) {
  if (!text) return false
  for (const pair of text.split('&')) {
    if (!pair) continue
    const at = pair.indexOf('=')
    const name = decoded(at < 0 ? pair : pair.slice(0, at))
    const value = at < 0 ? '' : decoded(pair.slice(at + 1))
    if (secretName(name)) return true
    // A value that reads as a token (a share id passed as ?id=...). A plain
    // video id (11 characters) or a search is not one.
    if (value && tokenLike(value) && value.length >= 20) return true
  }
  return false
}
// A fragment that is a route (#/settings) or an anchor (#intro) is kept; one
// holding parameters (an OAuth answer: #access_token=...) is checked.
function secretFragment(hash) {
  const h = hash.replace(/^#/, '')
  if (!h) return false
  const params = h.includes('?') ? h.slice(h.indexOf('?') + 1) : h.includes('=') ? h : ''
  if (params && secretParams(params)) return true
  return h.split('/').some((seg, i, all) => tokenLike(decoded(seg)) || (i > 0 && SECRET_BEFORE.test(decoded(all[i - 1])) && !!seg && decoded(seg).length >= 8))
}
function secretPath(pathname) {
  const segs = pathname.split('/')
  return segs.some((seg, i) => {
    if (!seg) return false
    const text = decoded(seg)
    if (tokenLike(text)) return true
    return i > 0 && SECRET_BEFORE.test(decoded(segs[i - 1])) && text.length >= 8
  })
}

// A page's address as a guest gets it -> { url, local, trimmed } | null
// (nothing to send: not http(s), not an address). trimmed: only the origin
// went (something in the rest read as a secret).
export function linkForGuest(raw) {
  const s = typeof raw === 'string' ? raw.trim() : ''
  if (!s || s.length > 8000) return null
  let url
  try {
    url = new URL(s)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const local = localOnlyHost(url.hostname)
  const origin = `${url.protocol}//${url.host}`
  const trimmed = secretPath(url.pathname) || secretParams(url.search.replace(/^\?/, '')) || secretFragment(url.hash)
  const whole = `${origin}${url.pathname}${url.search}${url.hash}`
  // Too long to be sure of: the origin.
  const cut = trimmed || whole.length > LINK_LIMITS.url
  return { url: cut ? `${origin}/` : whole, local, trimmed: cut && whole !== `${origin}/` }
}

// A page's title as a guest gets it: one line, no invisible characters,
// secrets masked (mask: the caller's maskSecrets), at most LINK_LIMITS.title.
export function linkTitle(raw, mask = (x) => x) {
  const text = mask(typeof raw === 'string' ? raw.replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim() : '')
  return text.length > LINK_LIMITS.title ? `${text.slice(0, LINK_LIMITS.title - 1)}…` : text
}

// Two addresses are the same page for following (a page that adds a
// parameter to its own address while it plays is not a new page): the same
// origin and path.
export function samePage(a, b) {
  try {
    const x = new URL(a)
    const y = new URL(b)
    return x.origin === y.origin && x.pathname.replace(/\/+$/, '') === y.pathname.replace(/\/+$/, '')
  } catch {
    return a === b
  }
}
