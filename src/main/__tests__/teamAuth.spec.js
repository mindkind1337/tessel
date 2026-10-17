// Signed team requests (teamAuth.js): a nonce is accepted once, and never
// forgotten while its request could still be sent again.
import { describe, it, expect, beforeEach } from 'vitest'
import { setTeamSecret, verifyRequest, requestMac, _resetTeamAuth, MAX_NONCES } from '../teamAuth'

const PANE = 'pane-17'
const SECRET = 'ab'.repeat(32)
let n = 0
function signed(at = Date.now()) {
  const nonce = `nonce-${String(++n).padStart(12, '0')}`
  const body = { op: 'list', args: {} }
  return { ...body, auth: { nonce, at, mac: requestMac(SECRET, PANE, 'accounts', { ...body, nonce, at }) } }
}

beforeEach(() => {
  _resetTeamAuth()
  setTeamSecret(PANE, SECRET)
})

describe('nonces', () => {
  it('a request is accepted once; its replay is refused', () => {
    const r = signed()
    expect(verifyRequest(r, PANE, 'accounts').ok).toBe(true)
    expect(verifyRequest(r, PANE, 'accounts').error).toMatch(/replay/)
    // Another pane, another team key, a changed body: refused too.
    expect(verifyRequest(signed(), 'pane-99', 'accounts').error).toBeTruthy()
    const t = signed()
    expect(verifyRequest(t, PANE, 'terminal').error).toMatch(/signature/)
    expect(verifyRequest({ ...t, args: { x: 1 } }, PANE, 'accounts').error).toMatch(/signature/)
  })

  it('the cache full of fresh nonces: new requests are refused, never an old nonce forgotten (its replay stays refused)', () => {
    const now = Date.now()
    const first = signed(now)
    expect(verifyRequest(first, PANE, 'accounts', now).ok).toBe(true)
    for (let i = 1; i < MAX_NONCES; i++) expect(verifyRequest(signed(now), PANE, 'accounts', now).ok).toBe(true)
    // Full: the next one waits, and the first can still not be replayed.
    expect(verifyRequest(signed(now), PANE, 'accounts', now).error).toMatch(/too many signed requests/)
    expect(verifyRequest(first, PANE, 'accounts', now).error).toMatch(/replay/)
    // Once the old ones expire (10 min + 2 min skew), there is room again.
    const later = now + 13 * 60 * 1000
    expect(verifyRequest(signed(later), PANE, 'accounts', later).ok).toBe(true)
  })

  it('a request with a malformed or missing signature is not accepted', () => {
    expect(verifyRequest({ op: 'list', args: {} }, PANE, 'accounts').unsigned).toBe(true)
    expect(verifyRequest({ op: 'list', args: {}, auth: { nonce: 'x', at: Date.now(), mac: 'y' } }, PANE, 'accounts').error).toMatch(/malformed/)
    const old = signed(Date.now() - 11 * 60 * 1000)
    expect(verifyRequest(old, PANE, 'accounts').error).toMatch(/too old/)
  })
})
