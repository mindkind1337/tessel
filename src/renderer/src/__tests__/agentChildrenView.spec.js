import { describe, it, expect } from 'vitest'
import { formatElapsed, formatTokens, childTime, childrenSummary } from '../agentChildrenView'

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
      { state: 'stopped', endedAt: now - 1000 }
    ]
    expect(childrenSummary(list, now)).toEqual({ running: 1, recent: 2, total: 4 })
  })
})
