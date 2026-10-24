// Live Share: a host's browser page as its guests get it, a link. The host's
// Tessel never streams its pages (no picture, no input): with "See my
// browser pages", a guest gets each page's address and title and opens the
// address in its own browser tab, with its own session and cookies, never
// the host's.
//
// What an address may carry to a guest (linkForGuest), on the host and again
// on the guest (a host is not trusted with what it sends):
// - http and https only; never a user or a password (URL.host has neither);
// - its path, and of its query only plain navigation parameters (a video
//   and its time, a page, a language: KEPT_PARAMS), a fragment only as a
//   plain anchor; everything else is dropped (a search too);
// - only the origin when something reads as a secret: a parameter named like
//   one (token, key, code, password, state, nonce...), a value or a path
//   segment that reads as one (a share link's id, a reset code, a short id
//   after /s/ or /invite/, a digit run, a session in the path). The origin
//   alone, never a guess at a "safe" part of the path: a capability link
//   opened at its root gives nothing;
// - local: an address that only works on the host's computer or network
//   (localhost, a private range, a .local name: livePageUrl.js
//   localOnlyHost). It is still sent (the guest's tab says where it runs),
//   but the guest never opens it.
//
// Pure: no DOM, no Electron.
import { localOnlyHost } from './livePageUrl.js'

export const LINK_LIMITS = Object.freeze({ url: 2000, title: 200 })

/* eslint-disable no-control-regex */
export const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g
/* eslint-enable no-control-regex */

// A parameter (of the query or a fragment) whose name says it is a secret:
// the whole address is then its origin only.
const SECRET_NAMES = new Set(['code', 'key', 'sig', 'sid', 'pwd', 'pass', 'otp', 'jwt', 'ticket', 'session', 'auth', 'authkey', 'rlkey', 'hmac', 'pin', 'passcode', 'pass_code', 'nonce', 'license', 'invite', 'state', 'expires', 'policy', 'resourcekey'])
const SECRET_PARTS = ['token', 'secret', 'passw', 'apikey', 'api_key', 'api-key', 'credential', 'signature', 'access_key', 'accesskey', 'private_key', 'session_id', 'sessionid', 'auth_', '_auth', 'authorization', 'x-amz-', 'x-goog-', 'key-pair', 'accessid']
const secretName = (name) => {
  const n = String(name || '').toLowerCase()
  return SECRET_NAMES.has(n) || SECRET_PARTS.some((p) => n.includes(p))
}
// The only parameters kept (plain navigation: a video and its time, a list,
// a page, a language, a tab, a sort); every other one is dropped, a search
// included (what someone searched for is theirs).
const KEPT_PARAMS = new Set(['v', 't', 'list', 'index', 'page', 'p', 'lang', 'hl', 'start', 'tab', 'sort'])
// A kept parameter's value: short and plain.
const plainValue = (name, v) => {
  if (typeof v !== 'string' || v.length > 64 || !/^[\w.,:+-]*$/.test(v) || /^eyJ/.test(v)) return false
  // A time is a time (42, 42s, 1h2m3s), never a code passed as "t".
  if (name === 't') return /^(\d+(\.\d+)?s?|(\d+h)?(\d+m)?(\d+s)?)$/.test(v)
  return true
}

// A segment (or a value) that reads as a token: a UUID, a long hex run, an
// email, a digit run of 6 or more (an order, an account, a phone number), or
// a part (between - _ . ~ +) that reads as random: 8 characters or more
// mixing letters and digits, a base64 or base32 run; or three short parts
// that each mix letters and digits or both cases. A slug
// ("2024-05-01-my-post") or a word in CamelCase is not one.
const TOKEN_SEGMENT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|@|\d{6,}/i
function randomPart(p) {
  if (p.length < 8) return false
  const letters = p.replace(/[^A-Za-z]/g, '').length
  const digits = p.replace(/[^0-9]/g, '').length
  if (letters && digits) return true
  if (p.length < 12) return false
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
  const parts = s.split(/[-_.~+!]+/)
  return parts.some(randomPart) || parts.filter(mixedPart).length >= 3
}
// The segment after one of these is a code or an id (/reset/<code>,
// /invite/<id>, /auth/email/<code>, /join/<room>...): secret, whatever it
// looks like.
const SECRET_BEFORE = /^(reset|verify|verification|verify-email|invite|invitation|accept-invite|join|session|sessions|token|magic|magic-link|share|shared|auth|oauth|login|signin|sign-in|callback|confirm|activate|unsubscribe|link|email|password|downloads|pay|raw)$/i

const decoded = (s) => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}
// "a=1&b=2" (a query without "?" or parameters in a fragment, ";" splits
// too) -> { secret: a parameter named like a secret or holding a token,
// kept: the parameters kept ("v=abc&t=42s"), dropped: whether any went }.
function readParams(text) {
  const out = { secret: false, kept: [], dropped: false }
  if (!text) return out
  for (const pair of text.split(/[&;]/)) {
    if (!pair) continue
    const at = pair.indexOf('=')
    const name = decoded(at < 0 ? pair : pair.slice(0, at))
    const value = at < 0 ? '' : decoded(pair.slice(at + 1))
    if (secretName(name)) out.secret = true
    else if (value && value.length >= 20 && tokenLike(value)) out.secret = true
    else if (KEPT_PARAMS.has(name.toLowerCase()) && plainValue(name.toLowerCase(), value)) out.kept.push(pair)
    else out.dropped = true
  }
  return out
}
// A path that reads as a capability: a secret segment, a short id after a
// one-letter segment (/s/<id>, /j/<room>, /r/<code>), one with a digit or a
// capital after a two-letter one, matrix parameters (;jsessionid=...), an
// ASP.NET session in the path ((S(...))).
function secretPath(pathname) {
  if (pathname.includes(';') || pathname.includes('(')) return true
  const segs = pathname.split('/')
  return segs.some((seg, i) => {
    if (!seg) return false
    const text = decoded(seg)
    if (tokenLike(text)) return true
    // A meeting or room code (abc-defg-hij).
    if (/^[a-z]{3,4}(-[a-z]{3,4}){2,}$/i.test(text)) return true
    const before = i > 0 ? decoded(segs[i - 1]) : ''
    if (SECRET_BEFORE.test(before)) return true
    if (before.length === 1) return true
    return before.length === 2 && /[0-9A-Z]/.test(text)
  })
}

// A page's address as a guest gets it -> { url, local, trimmed } | null
// (nothing to send: not http(s), not an address). trimmed: part of it stayed
// private (only the origin went, or parameters were dropped).
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
  const query = readParams(url.search.replace(/^\?/, ''))
  const hash = url.hash.replace(/^#/, '')
  // A fragment is kept only as a plain anchor (#examples); one holding
  // parameters is read like a query (a secret: the origin only), any other
  // (a route, a search: #search/...) goes.
  const hashParams = hash.includes('=') ? readParams(hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : hash) : null
  const keepHash = /^[A-Za-z][\w.-]{0,63}$/.test(hash) && !tokenLike(hash)
  const secret = secretPath(url.pathname) || query.secret || !!(hashParams && hashParams.secret) || (!!hash && !hashParams && tokenLike(hash))
  if (secret) return { url: `${origin}/`, local, trimmed: `${url.pathname}${url.search}${url.hash}` !== '/' }
  const search = query.kept.length ? `?${query.kept.join('&')}` : ''
  const whole = `${origin}${url.pathname}${search}${keepHash ? `#${hash}` : ''}`
  if (whole.length > LINK_LIMITS.url) return { url: `${origin}/`, local, trimmed: true }
  return { url: whole, local, trimmed: query.dropped || (!!hash && !keepHash) }
}

// A page's title as a guest gets it: one line, no invisible characters,
// secrets masked (mask: the caller's maskSecrets), no email address and no
// run of 6 digits or more (an order, an account), at most LINK_LIMITS.title.
export function linkTitle(raw, mask = (x) => x) {
  let text = mask(typeof raw === 'string' ? raw.replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim() : '')
  text = text.replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '••••').replace(/(?<![\w])(?=\w*\d)(?=\w*[A-Za-z])\w{16,}(?![\w])/g, '••••').replace(/\d[\d -]{4,}\d/g, (m) => (m.replace(/\D/g, '').length >= 6 ? '••••' : m))
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
// The origin of an address ('' when none): a guest opens a new site of the
// host's only after one click.
export function originOf(url) {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : ''
  } catch {
    return ''
  }
}
