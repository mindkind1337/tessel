import { describe, it, expect } from 'vitest'
import { sleepEligible } from '../../../shared/agentSleep'

const now = 10_000_000
const base = {
  leaf: { kind: 'agent', agentId: 'claude', agentCommand: 'claude', sessionId: 'abc123' },
  resumable: true,
  state: 'idle',
  trackedState: 'idle',
  since: now - 31 * 60 * 1000,
  lastKey: 0,
  draft: false,
  active: false,
  restarting: false,
  minutes: 30,
  now
}
const ok = (patch = {}) => sleepEligible({ ...base, ...patch })

describe('which idle agents may sleep', () => {
  it('an agent idle long enough, resumable, alone, not in use', () => {
    expect(ok()).toBe(true)
  })
  it('never while working, waiting for approval, limited, unknown or just idle', () => {
    for (const state of ['working', 'approval', 'limited', 'unknown', null]) expect(ok({ state })).toBe(false)
    expect(ok({ since: now - 29 * 60 * 1000 })).toBe(false)
    expect(ok({ since: NaN })).toBe(false)
  })
  it('never a teammate, the pane you are in, one with something typed, or one you typed in lately', () => {
    expect(ok({ leaf: { ...base.leaf, inTeam: true } })).toBe(false)
    expect(ok({ active: true })).toBe(false)
    expect(ok({ draft: true })).toBe(false)
    expect(ok({ lastKey: now - 5 * 60 * 1000 })).toBe(false)
    expect(ok({ restarting: true })).toBe(false)
  })
  it('never a pane Tessel could not resume, a shell, a failed or sleeping one', () => {
    expect(ok({ resumable: false })).toBe(false)
    expect(ok({ leaf: { ...base.leaf, kind: 'shell' } })).toBe(false)
    expect(ok({ leaf: { ...base.leaf, failed: 'x' } })).toBe(false)
    expect(ok({ leaf: { ...base.leaf, sleeping: { at: 1 } } })).toBe(false)
    expect(ok({ leaf: { ...base.leaf, agentCommand: null } })).toBe(false)
  })
})

import { sleepBlocker } from '../../../shared/agentSleep'
describe('why an agent stays awake (for the log)', () => {
  it('names the first reason', () => {
    expect(sleepBlocker({ ...base, state: 'unknown' })).toBe('state unknown')
    expect(sleepBlocker({ ...base, since: now - 60 * 1000 })).toBe('not idle long enough')
    expect(sleepBlocker({ ...base, leaf: { ...base.leaf, inTeam: true } })).toBe('in a team')
    expect(sleepBlocker(base)).toBe('')
  })
})
