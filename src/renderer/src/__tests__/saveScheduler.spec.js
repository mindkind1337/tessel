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

  it('retry: a failed save runs again later, sooner if a change comes, and closing the window runs it', () => {
    const run = vi.fn()
    const s = createSaveScheduler(run, { now: () => Date.now() })
    s.retry(5000)
    expect(s.pending()).toBe(true)
    vi.advanceTimersByTime(4999)
    expect(run).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(run).toHaveBeenCalledTimes(1)
    // A change while the retry waits: saved after the usual quiet moment.
    s.retry(5000)
    s.schedule()
    vi.advanceTimersByTime(500)
    expect(run).toHaveBeenCalledTimes(2)
    // A retry never pushes back a save already waiting.
    s.schedule()
    s.retry(60000)
    vi.advanceTimersByTime(500)
    expect(run).toHaveBeenCalledTimes(3)
    s.retry(60000)
    expect(s.flush()).toBe(true)
    expect(run).toHaveBeenCalledTimes(4)
  })
})
