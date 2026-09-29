// Who really sent a team request, and answers only its sender can read.
//
// Each pane Tessel starts gets its own secret (TESSEL_TEAM_SECRET in the
// pane's environment, created in pty:create, kept only in this process's
// memory and in the terminal host's memory for re-attaching; never written
// to disk, never logged). The team tools (teamMcp/server.cjs) never put the
// secret in a file: they MAC each request with it, over the pane id, the
// team, the action and its canonical content, a random nonce and the time.
// Here the MAC is checked against the sending pane's secret (constant time),
// a nonce is accepted once (replays refused) and an old request is refused.
// Answers to a waiting tool are encrypted and authenticated with a key
// derived from the requester's secret (AES-256-GCM, bound to its request id
// and pane), so another agent can neither read nor forge them.
//
// The secret is revoked when the pane's terminal is closed and replaced on
// every launch or relaunch. It cannot change while an agent runs (its
// environment is fixed at launch), so a team change is covered by binding
// the team id into the MAC, and by Tessel checking the sender's current team
// and role before acting (the signature proves who sent it, not what it may
// do).
//
// Trust model, honestly: every agent runs as the same Windows user as
// Tessel. This stops one agent from cheaply impersonating another (a JSON
// file dropped in the shared folder, a copied request, a fabricated
// answer); it does not stop a determined local attacker running as that
// user, who can read other processes' environment or memory.
import crypto from 'crypto'

const SECRET_RE = /^[a-f0-9]{64}$/
const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/
const MAX_AGE_MS = 10 * 60 * 1000 // a request older than this is refused
const MAX_SKEW_MS = 2 * 60 * 1000 // ... and one from the future
const MAX_NONCES = 20000

const secrets = new Map() // pane id -> secret (hex)
const seen = new Map() // nonce -> time it expires

export function newTeamSecret() {
  return crypto.randomBytes(32).toString('hex')
}
export function setTeamSecret(paneId, secret) {
  if (paneId == null || typeof secret !== 'string' || !SECRET_RE.test(secret)) return
  secrets.set(String(paneId), secret)
}
export function revokeTeamSecret(paneId) {
  secrets.delete(String(paneId))
}
export function teamSecretOf(paneId) {
  return secrets.get(String(paneId)) || null
}
// Tests only.
export function _resetTeamAuth() {
  secrets.clear()
  seen.clear()
}

// The text a request's MAC covers: its pane, team and content, keys sorted
// (the same function in teamMcp/server.cjs).
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`
  return JSON.stringify(value === undefined ? null : value)
}
export function requestMac(secret, paneId, teamKey, body) {
  return crypto.createHmac('sha256', Buffer.from(secret, 'hex')).update(canonical({ pane: String(paneId), team: String(teamKey), body })).digest('hex')
}

function sameHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || !/^[a-f0-9]+$/.test(a)) return false
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
}

// data: a request file's JSON. -> { ok, body } (the request without its
// signature), { unsigned: true } (no signature), or { error }.
//   teamKey: the team id (or "board:<workspace>" for a workspace board).
export function verifyRequest(data, paneId, teamKey, now = Date.now()) {
  if (!data || typeof data !== 'object' || data.auth == null) return { unsigned: true }
  const { auth, ...body } = data
  const secret = teamSecretOf(paneId)
  if (!secret) return { error: 'this pane has no team secret in this Tessel (restart the agent)' }
  if (!auth || typeof auth !== 'object' || !NONCE_RE.test(String(auth.nonce)) || !Number.isFinite(auth.at) || typeof auth.mac !== 'string')
    return { error: 'the request signature is malformed' }
  if (now - auth.at > MAX_AGE_MS || auth.at - now > MAX_SKEW_MS) return { error: 'the request is too old (or from the future)' }
  const want = requestMac(secret, paneId, teamKey, { ...body, nonce: auth.nonce, at: auth.at })
  if (!sameHex(auth.mac, want)) return { error: 'the request signature does not match its pane' }
  for (const [n, until] of seen) {
    if (until > now && seen.size <= MAX_NONCES) break
    seen.delete(n)
  }
  if (seen.has(auth.nonce)) return { error: 'this request was already used (a replay)' }
  seen.set(auth.nonce, now + MAX_AGE_MS + MAX_SKEW_MS)
  return { ok: true, body }
}

function answerKey(secret) {
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret, 'hex'), Buffer.alloc(0), Buffer.from('tessel-team-answer'), 32))
}
// An answer only its requester can read and trust: { v, iv, tag, data }
// (AES-256-GCM, additional data: the pane id and the request id), or null
// when that pane has no secret here.
export function sealAnswer(paneId, rid, payload) {
  const secret = teamSecretOf(paneId)
  if (!secret) return null
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', answerKey(secret), iv)
  cipher.setAAD(Buffer.from(`${paneId}\n${rid}`))
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()])
  return { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }
}
// The same in the other direction (used by the tests; server.cjs has its own).
export function openAnswer(secret, paneId, rid, sealed) {
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', answerKey(secret), Buffer.from(sealed.iv, 'base64'))
    d.setAAD(Buffer.from(`${paneId}\n${rid}`))
    d.setAuthTag(Buffer.from(sealed.tag, 'base64'))
    return JSON.parse(Buffer.concat([d.update(Buffer.from(sealed.data, 'base64')), d.final()]).toString('utf8'))
  } catch {
    return null
  }
}
