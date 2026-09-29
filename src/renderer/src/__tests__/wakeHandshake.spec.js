// Waking on the ready handshake (wakeHandshake.js): only for the current
// launch, only while nothing shows work since; the screen can veto, never
// authorize.
import { describe, it, expect } from 'vitest'
import { handshakeAllowsWake } from '../wakeHandshake'

const T = 'a'.repeat(32)
const base = () => ({
  ready: { launchToken: T, at: 2000 },
  leaf: { agentLaunchToken: T, launchedAt: 1000 },
  state: { state: 'unknown', hookSeen: false, confirmed: false },
  status: 'unknown',
  approval: false,
  limit: false,
  lastUserKeyAt: 0,
  lastSentAt: 0
})

describe('ready handshake for waking', () => {
  it('a resumed agent that said ready and did nothing since may be woken', () => {
    expect(handshakeAllowsWake(base())).toBe(true)
    expect(handshakeAllowsWake({ ...base(), state: null })).toBe(true)
  })

  it('no handshake, another launch, or one already spent: no', () => {
    expect(handshakeAllowsWake({ ...base(), ready: null })).toBe(false)
    expect(handshakeAllowsWake({ ...base(), leaf: { agentLaunchToken: 'b'.repeat(32), launchedAt: 1000 } })).toBe(false)
    expect(handshakeAllowsWake({ ...base(), ready: { launchToken: T, at: 2000, spent: true } })).toBe(false)
  })

  it('any sign of work since: hooks take over, the screen vetoes', () => {
    expect(handshakeAllowsWake({ ...base(), state: { state: 'idle', hookSeen: true } })).toBe(false)
    expect(handshakeAllowsWake({ ...base(), state: { state: 'working', hookSeen: false } })).toBe(false) // ScreenBusy
    expect(handshakeAllowsWake({ ...base(), state: { state: 'approval', hookSeen: false } })).toBe(false)
    expect(handshakeAllowsWake({ ...base(), status: 'busy' })).toBe(false)
    expect(handshakeAllowsWake({ ...base(), approval: true })).toBe(false)
    expect(handshakeAllowsWake({ ...base(), limit: true })).toBe(false)
  })

  it('anything typed there since the launch (the user, or Tessel: a task, a note) voids it', () => {
    expect(handshakeAllowsWake({ ...base(), lastUserKeyAt: 1500 })).toBe(false) // before the handshake, after the launch
    expect(handshakeAllowsWake({ ...base(), lastUserKeyAt: 2500 })).toBe(false)
    expect(handshakeAllowsWake({ ...base(), lastSentAt: 1200 })).toBe(false)
    expect(handshakeAllowsWake({ ...base(), lastUserKeyAt: 900, lastSentAt: 500 })).toBe(true) // before this launch
  })

  it('the screen never authorizes: an idle-looking screen changes nothing without the handshake', () => {
    expect(handshakeAllowsWake({ ...base(), ready: null, status: 'idle', state: { state: 'idle', hookSeen: false } })).toBe(false)
  })
})
