import { describe, it, expect } from 'vitest'
import { formatElapsed, formatTokens, childTime, childrenSummary, childActive, CHILD_STALE_MS } from '../agentChildrenView'

describe('sub-agents in a pane', () => {
  it('shows times and tokens like Claude Code', () => {
    expect(formatElapsed(477000)).toBe('7m 57s')
    expect(formatElapsed(45000)).toBe('45s')
    expect(formatElapsed(3 * 3600000 + 5 * 60000)).toBe('3h 5m')
    expect(formatTokens(105800)).toBe('105.8k')
    expect(formatTokens(950)).toBe('950')
    expect(formatTokens(2500000)).toBe('2.5M')
    expect(formatTokens(null)).toBe('')
  })
  it('a running one counts until now; a finished one until it ended', () => {
    expect(childTime({ state: 'running', startedAt: 1000 }, 61000)).toBe('1m 0s')
    expect(childTime({ state: 'done', startedAt: 1000, endedAt: 11000 }, 999999)).toBe('10s')
  })
  it('counts the running and the recently finished', () => {
    const now = 10_000_000
    const list = [
      { state: 'running' },
      { state: 'done', endedAt: now - 60000 },
      { state: 'done', endedAt: now - 3600000 },
      { state: 'quiet', lastAt: now - 1000 }
    ]
    expect(childrenSummary(list, now)).toEqual({ running: 1, quiet: 1, recent: 1, recentQuiet: 1, total: 4 })
  })
  it('a quiet one (unfinished, silent for a while) says for how long, never that it finished', () => {
    const now = 100_000_000
    const quiet = { state: 'quiet', startedAt: now - 40 * 60000, lastAt: now - 16 * 60000, endedAt: null }
    expect(childTime(quiet, now)).toBe('quiet 16m')
    expect(childTime({ ...quiet, lastAt: now - 125 * 60000 }, now)).toBe('quiet 2h 5m')
    // Even with an end date, only a done one counts as recently finished.
    expect(childrenSummary([{ ...quiet, endedAt: now - 1000 }], now)).toEqual({ running: 0, quiet: 1, recent: 0, recentQuiet: 1, total: 1 })
  })
  it('an unfinished one is running only while it writes, and after its parent ended its turn only if it wrote since', () => {
    const now = 100_000_000
    const run = { state: 'running', startedAt: now - 30 * 60000, lastAt: now - 60000 }
    expect(childActive(run, { now })).toBe(true)
    expect(childActive({ ...run, lastAt: now - CHILD_STALE_MS - 1 }, { now })).toBe(false)
    expect(childActive({ state: 'quiet', lastAt: now - 16 * 60000 }, { now })).toBe(false)
    expect(childActive({ state: 'done', lastAt: now }, { now })).toBe(false)
    // Parent idle since 2 min ago; the child last wrote 1 min ago: a background one.
    expect(childActive(run, { now, parentIdleSince: now - 120000 })).toBe(true)
    // Parent idle since 30 s ago; the child last wrote before that: stopped with it.
    expect(childActive(run, { now, parentIdleSince: now - 30000 })).toBe(false)
    expect(childrenSummary([run, { ...run, lastAt: now - 10000 }], now, now - 30000)).toMatchObject({ running: 1, quiet: 1 })
  })
  it("one started in the background works after its parent's turn ended, even while it writes nothing (one long answer)", () => {
    const now = 100_000_000
    const bg = { state: 'running', background: true, startedAt: now - 20000, lastAt: now - 19000 }
    expect(childActive(bg, { now, parentIdleSince: now - 15000 })).toBe(true)
    expect(childrenSummary([bg, { ...bg, background: false }], now, now - 15000)).toMatchObject({ running: 1, quiet: 1 })
    // Finished, or silent past the stale limit: not at work.
    expect(childActive({ ...bg, state: 'done' }, { now, parentIdleSince: now - 15000 })).toBe(false)
    expect(childActive({ ...bg, lastAt: now - CHILD_STALE_MS - 1 }, { now, parentIdleSince: now - 15000 })).toBe(false)
  })
})
