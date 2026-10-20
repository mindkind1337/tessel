import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createSaveScheduler } from '../saveScheduler'

describe('createSaveScheduler', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('runs once, 500 ms after the last of a burst of changes', () => {
    const run = vi.fn()
    const s = createSaveScheduler(run, { now: () => Date.now() })
    s.schedule()
    vi.advanceTimersByTime(300)
    s.schedule()
    vi.advanceTimersByTime(499)
    expect(run).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('changes every 200 ms for a minute still save every 5 s', () => {
    const run = vi.fn()
    const s = createSaveScheduler(run, { now: () => Date.now() })
    for (let i = 0; i < 300; i++) {
      s.schedule()
      vi.advanceTimersByTime(200)
    }
    expect(run.mock.calls.length).toBeGreaterThanOrEqual(11)
    expect(run.mock.calls.length).toBeLessThanOrEqual(13)
  })

  it('flush runs what waits now (closing the window), cancel only forgets it', () => {
    const run = vi.fn()
    const s = createSaveScheduler(run, { now: () => Date.now() })
    expect(s.flush()).toBe(false)
    s.schedule()
    expect(s.flush()).toBe(true)
    expect(run).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(10000)
    expect(run).toHaveBeenCalledTimes(1)
    s.schedule()
    expect(s.cancel()).toBe(true)
    vi.advanceTimersByTime(10000)
    expect(run).toHaveBeenCalledTimes(1)
  })
})
