// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createUsageStatsTracker } from '../usageStatsTracker'
import {
  createAgentState,
  reduceAgentState,
  publicAgentState,
  AGENT_STATE_STALE_MS
} from '../../shared/agentStateModel'

const fixtures = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.tracker.close()
    const resolved = path.resolve(fixture.dir)
    if (
      path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
      !path.basename(resolved).startsWith('tessel-stats-test-')
    )
      throw new Error('Unexpected statistics fixture cleanup target')
    await fs.rm(fixture.dir, { recursive: true, force: true })
  }
})
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tessel-stats-test-'))
  const clock = { at: 100000 }
  const file = path.join(dir, 'stats.json')
  const tracker = createUsageStatsTracker({ file, now: () => clock.at, saveDelay: 60000 })
  const value = { dir, file, tracker, clock }
  fixtures.push(value)
  return value
}
const state = (at, overrides = {}) => ({
  launchToken: 'launch-1',
  state: 'working',
  confirmed: true,
  hookSeen: true,
  source: 'hook',
  since: at,
  observedAt: at,
  children: [],
  ...overrides
})

let nextEvent = 0
const realState = () =>
  createAgentState({
    paneId: 'pane-1',
    provider: 'claude',
    launchToken: 'launch-1',
    startedAt: 90000
  })
function event(state, name, at, source = 'hook', extra = {}) {
  return reduceAgentState(
    state,
    {
      v: 1,
      id: `event-${++nextEvent}`,
      paneId: 'pane-1',
      provider: 'claude',
      launchToken: 'launch-1',
      sessionId: source === 'hook' ? 'session-1' : null,
      source,
      event: name,
      at,
      ...extra
    },
    at
  )
}
const snapshot = (state, at) => ({ 'pane-1': publicAgentState(state, at) })

describe('local lifetime activity statistics', () => {
  it('counts live execution edges once and sums only observed working intervals', async () => {
    const { tracker, clock } = await fixture()
    await tracker.observe({ a: state(clock.at) })
    clock.at += 12000
    await tracker.observe({ a: state(clock.at) })
    expect(await tracker.summary()).toMatchObject({
      totalAgentsSpawned: 1,
      totalAgentTimeMs: 12000,
      firstEventAt: 100000
    })
    await tracker.observe({ a: state(clock.at, { state: 'idle' }) })
    clock.at += 50000
    await tracker.observe({ a: state(clock.at) })
    clock.at += 1000
    await tracker.observe({})
    clock.at += 10000
    expect(await tracker.summary()).toMatchObject({
      totalAgentsSpawned: 2,
      totalAgentTimeMs: 13000
    })
  })
  it('does not turn old hooks, screen estimates, or replay into spawned agents', async () => {
    const { tracker, clock } = await fixture()
    await tracker.observe({
      a: state(clock.at - 1),
      b: state(clock.at, { source: 'screen', confirmed: false })
    })
    clock.at += 3000
    await tracker.observe({ a: state(clock.at), b: state(clock.at) })
    expect(await tracker.summary()).toMatchObject({
      totalAgentsSpawned: 0,
      totalAgentTimeMs: 0,
      firstEventAt: null
    })
    await tracker.observe({ a: state(clock.at, { state: 'idle' }) })
    await tracker.observe({ a: state(clock.at) })
    expect((await tracker.summary()).totalAgentsSpawned).toBe(1)
  })
  it('counts overlapping panes independently and preserves parent work while a child is running', async () => {
    const { tracker, clock } = await fixture()
    await tracker.observe({ a: state(clock.at), b: state(clock.at) })
    clock.at += 2000
    await tracker.observe({
      a: state(clock.at, { state: 'idle', children: [state(clock.at)] }),
      b: state(clock.at, { state: 'idle' })
    })
    clock.at += 3000
    await tracker.observe({ a: state(clock.at, { state: 'idle' }) })
    expect(await tracker.summary()).toMatchObject({ totalAgentsSpawned: 2, totalAgentTimeMs: 7000 })
  })
  it('excludes system sleep and persists totals across restarts without restoring an active clock', async () => {
    const f = await fixture()
    await f.tracker.observe({ a: state(f.clock.at) })
    f.clock.at += 2000
    await f.tracker.suspend()
    f.clock.at += 3600000
    await f.tracker.resume()
    f.clock.at += 1000
    await f.tracker.close()
    f.tracker = createUsageStatsTracker({ file: f.file, now: () => f.clock.at, saveDelay: 60000 })
    f.clock.at += 60000
    expect(await f.tracker.summary()).toMatchObject({
      totalAgentsSpawned: 1,
      totalAgentTimeMs: 3000
    })
  })
  it('deduplicates successful PR URLs and stores only hashes, including after restart', async () => {
    const f = await fixture()
    await f.tracker.prCreated('https://github.com/org/repo/pull/14')
    await f.tracker.prCreated('https://github.com/org/repo/pull/14/?foo=bar')
    await f.tracker.prCreated('https://github.com/org/repo/issues/14')
    await f.tracker.close()
    const saved = await fs.readFile(f.file, 'utf8')
    expect(saved).not.toContain('org/repo')
    f.tracker = createUsageStatsTracker({ file: f.file, now: () => f.clock.at, saveDelay: 60000 })
    await f.tracker.prCreated('https://github.com/org/repo/pull/14')
    expect(await f.tracker.summary()).toMatchObject({ totalPRsCreated: 1, firstEventAt: 100000 })
  })

  it('retains an active clock if a queued working snapshot arrives during suspension', async () => {
    const { tracker, clock } = await fixture()
    let s = event(realState(), 'UserPromptSubmit', clock.at)
    await tracker.observe(snapshot(s, clock.at))
    clock.at += 1000
    await tracker.suspend()
    clock.at += 100
    s = event(s, 'PreToolUse', clock.at, 'hook', { toolId: 'tool-1' })
    await tracker.observe(snapshot(s, clock.at))
    clock.at += 100000
    await tracker.resume()
    clock.at += 1000
    expect(await tracker.summary()).toMatchObject({ totalAgentsSpawned: 1, totalAgentTimeMs: 2000 })
  })
  it('preserves malformed saved data and returns an explicit failure', async () => {
    const f = await fixture()
    await f.tracker.close()
    await fs.writeFile(f.file, 'broken saved statistics')
    f.tracker = createUsageStatsTracker({ file: f.file, now: () => f.clock.at, saveDelay: 60000 })
    await f.tracker.observe({ a: state(f.clock.at) })
    expect(await f.tracker.summary()).toMatchObject({ ok: false })
    await f.tracker.close()
    expect(await fs.readFile(f.file, 'utf8')).toBe('broken saved statistics')
  })

  it('lets the first live hook upgrade a screen estimate without losing the real start', async () => {
    const { tracker, clock } = await fixture()
    let s = event(realState(), 'ScreenBusy', clock.at, 'screen')
    await tracker.observe(snapshot(s, clock.at))
    expect((await tracker.summary()).totalAgentsSpawned).toBe(0)
    clock.at += 100
    s = event(s, 'UserPromptSubmit', clock.at)
    await tracker.observe(snapshot(s, clock.at))
    clock.at += 1000
    expect(await tracker.summary()).toMatchObject({ totalAgentsSpawned: 1, totalAgentTimeMs: 1000 })
  })

  it('does not mint a start or timing when a restored working episode gets a fresh tool hook', async () => {
    const { tracker, clock } = await fixture()
    let s = event(realState(), 'UserPromptSubmit', 99000)
    s = { ...s, confirmed: false }
    expect(publicAgentState(s, clock.at).state).toBe('unknown')
    await tracker.observe(snapshot(s, clock.at))
    clock.at += 100
    s = event(s, 'PreToolUse', clock.at, 'hook', { toolId: 'tool-1' })
    await tracker.observe(snapshot(s, clock.at))
    clock.at += 1000
    expect(await tracker.summary()).toMatchObject({ totalAgentsSpawned: 0, totalAgentTimeMs: 0 })
    s = event(s, 'Stop', clock.at)
    s = event(s, 'ScreenReady', clock.at, 'screen')
    await tracker.observe(snapshot(s, clock.at))
    clock.at += 100
    s = event(s, 'UserPromptSubmit', clock.at)
    await tracker.observe(snapshot(s, clock.at))
    expect((await tracker.summary()).totalAgentsSpawned).toBe(1)
  })

  it('preserves a counted execution through stale/unknown without adding another start', async () => {
    const { tracker, clock } = await fixture()
    let s = event(realState(), 'UserPromptSubmit', clock.at)
    await tracker.observe(snapshot(s, clock.at))
    clock.at += AGENT_STATE_STALE_MS + 1
    expect(publicAgentState(s, clock.at).state).toBe('unknown')
    await tracker.observe(snapshot(s, clock.at))
    const before = (await tracker.summary()).totalAgentTimeMs
    clock.at += 1000
    expect((await tracker.summary()).totalAgentTimeMs).toBe(before)
    s = event(s, 'PreToolUse', clock.at, 'hook', { toolId: 'tool-1' })
    await tracker.observe(snapshot(s, clock.at))
    clock.at += 1000
    expect(await tracker.summary()).toMatchObject({
      totalAgentsSpawned: 1,
      totalAgentTimeMs: before + 1000
    })
  })

  it('can start new work after a restored idle state without confusing it with old work', async () => {
    const { tracker, clock } = await fixture()
    let s = event(realState(), 'SessionStart', 98000)
    s = event(s, 'ScreenReady', 99000, 'screen')
    s = { ...s, confirmed: false }
    await tracker.observe(snapshot(s, clock.at))
    clock.at += 100
    s = event(s, 'UserPromptSubmit', clock.at)
    await tracker.observe(snapshot(s, clock.at))
    expect((await tracker.summary()).totalAgentsSpawned).toBe(1)
  })

  it('uses a delayed completion edge and corrects only the current credited interval', async () => {
    const { tracker, clock } = await fixture()
    let s = event(realState(), 'UserPromptSubmit', clock.at)
    await tracker.observe(snapshot(s, clock.at))
    clock.at += 500
    expect((await tracker.summary()).totalAgentTimeMs).toBe(500)
    s = event(s, 'Stop', 100300)
    s = event(s, 'ScreenReady', 100300, 'screen')
    clock.at += 200
    await tracker.observe(snapshot(s, clock.at))
    expect(await tracker.summary()).toMatchObject({ totalAgentTimeMs: 300, totalAgentsSpawned: 1 })
  })
})
