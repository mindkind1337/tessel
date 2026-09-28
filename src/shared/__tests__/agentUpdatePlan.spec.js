import { describe, it, expect } from 'vitest'
import { updateBlocker, planUpdate, autoUpdateMoment, describeWaiting, UPDATE_QUIET_MS } from '../agentUpdatePlan'

const NOW = 10_000_000
// A pane that may be restarted: idle for a while, nothing typed.
const safe = (over = {}) => ({
  pane: { kind: 'agent', agentId: 'opencode', agentCommand: 'opencode' },
  resumable: true,
  managed: false,
  confirmed: false,
  state: 'idle',
  trackedState: 'idle',
  since: NOW - UPDATE_QUIET_MS - 1000,
  approval: false,
  limited: false,
  draft: false,
  lastKey: 0,
  focused: false,
  delivering: false,
  recentReminder: false,
  restarting: false,
  now: NOW,
  ...over
})

describe('when a pane may be restarted for an update', () => {
  it('an idle, quiet pane with a conversation to resume', () => {
    expect(updateBlocker(safe())).toBe('')
  })
  it('never a working agent, nor one waiting for an approval or at its limit', () => {
    expect(updateBlocker(safe({ state: 'working' }))).toBe('working')
    expect(updateBlocker(safe({ state: 'unknown' }))).toBe('state unknown')
    expect(updateBlocker(safe({ approval: true }))).toBe('waiting for an approval')
    expect(updateBlocker(safe({ state: 'approval' }))).toBe('waiting for an approval')
    expect(updateBlocker(safe({ limited: true }))).toBe('at its usage limit')
  })
  it("Claude Code and Codex: only when their own hooks confirm they're idle", () => {
    expect(updateBlocker(safe({ managed: true, confirmed: false }))).toBe('its idle state is not confirmed yet')
    expect(updateBlocker(safe({ managed: true, confirmed: true }))).toBe('')
  })
  it('not right after it finished working, nor when idle time is unknown', () => {
    expect(updateBlocker(safe({ since: NOW - 5000 }))).toBe('just finished working')
    expect(updateBlocker(safe({ trackedState: 'working' }))).toBe('idle time unknown')
    expect(updateBlocker(safe({ since: NaN }))).toBe('idle time unknown')
  })
  it("never over the user's typing", () => {
    expect(updateBlocker(safe({ draft: true }))).toBe('something is typed in it')
    expect(updateBlocker(safe({ lastKey: NOW - 3000 }))).toBe('you typed there lately')
    expect(updateBlocker(safe({ focused: true }))).toBe('you are in this pane')
  })
  it('not while a team message or a reminder reaches it, nor while it restarts', () => {
    expect(updateBlocker(safe({ delivering: true }))).toBe('a team message is being delivered')
    expect(updateBlocker(safe({ recentReminder: true }))).toBe('a reminder was just typed there')
    expect(updateBlocker(safe({ restarting: true }))).toBe('being restarted')
  })
  it('never without a conversation to resume (it would be lost)', () => {
    expect(updateBlocker(safe({ resumable: false }))).toBe('its conversation cannot be resumed')
  })
  it('only agent panes', () => {
    expect(updateBlocker(safe({ pane: { kind: 'shell' } }))).toBe('not an agent pane')
    expect(updateBlocker(safe({ pane: null }))).toBe('not an agent pane')
  })
})

describe('update plan', () => {
  it('no pane runs the agent: update at once, nothing to restart', () => {
    expect(planUpdate([])).toEqual({ running: [], ready: [], waiting: [], manual: [], allReady: true })
  })
  it('sleeping panes run nothing (they wake on the new version)', () => {
    const p = planUpdate([{ id: 'a', label: '#1', sleeping: true, blocker: 'working' }])
    expect(p.running).toEqual([])
    expect(p.allReady).toBe(true)
  })
  it('splits the running panes into ready, waiting and yours to restart', () => {
    const p = planUpdate([
      { id: 'a', label: '#1 OpenCode', blocker: '' },
      { id: 'b', label: '#2 OpenCode', blocker: 'working' },
      { id: 'c', label: '#3 OpenCode', blocker: 'its conversation cannot be resumed' }
    ])
    expect(p.running).toEqual(['a', 'b', 'c'])
    expect(p.ready).toEqual(['a'])
    expect(p.waiting).toEqual([{ id: 'b', label: '#2 OpenCode', why: 'working' }])
    expect(p.manual).toEqual([{ id: 'c', label: '#3 OpenCode', why: 'its conversation cannot be resumed' }])
    expect(p.allReady).toBe(false)
    expect(describeWaiting(p.waiting)).toBe('#2 OpenCode (working)')
  })
  it('all ready: its panes may all be stopped for a locked update', () => {
    const p = planUpdate([
      { id: 'a', label: '#1', blocker: '' },
      { id: 'b', label: '#2', blocker: '' }
    ])
    expect(p.allReady).toBe(true)
    expect(p.ready).toEqual(['a', 'b'])
  })
})

describe('automatic updates', () => {
  const plan = (panes) => planUpdate(panes)
  it('only when you have not typed for a while', () => {
    expect(autoUpdateMoment({ plan: plan([]), lastAnyKey: NOW - 5000, now: NOW })).toBe('you are typing')
    expect(autoUpdateMoment({ plan: plan([]), lastAnyKey: NOW - 120000, now: NOW })).toBe('')
  })
  it('only when every pane running it may be restarted', () => {
    expect(autoUpdateMoment({ plan: plan([{ id: 'a', blocker: 'working' }]), now: NOW })).toBe('a pane running it is busy')
    expect(autoUpdateMoment({ plan: plan([{ id: 'a', blocker: 'its conversation cannot be resumed' }]), now: NOW })).toMatch(/without a conversation/)
    expect(autoUpdateMoment({ plan: plan([{ id: 'a', blocker: '' }]), now: NOW })).toBe('')
  })
})
