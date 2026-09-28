import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

describe('saving the activity log', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
  })
  afterEach(() => vi.useRealTimers())

  it('saves at most once per SAVE_EVERY_MS while events keep coming, and sends the plain array', async () => {
    const save = vi.fn(async () => ({ ok: true }))
    window.shellApi = { activity: { load: vi.fn(async () => []), save } }
    const store = await import('../activityStore')
    await store.loadActivity()
    for (let i = 0; i < 50; i++) {
      store.recordActivity({ type: 'task', action: 'x' + i })
      vi.advanceTimersByTime(1000)
    }
    // 50 s of steady events: 3 saves, not one per event.
    expect(save.mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(save.mock.calls.length).toBeLessThanOrEqual(4)
    const sent = save.mock.calls[0][0]
    expect(Array.isArray(sent)).toBe(true)
    expect(sent.length).toBeGreaterThan(0)
  })

  it('falls back to a JSON copy when the log cannot be cloned', async () => {
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error('An object could not be cloned'))
      .mockResolvedValue({ ok: true })
    window.shellApi = { activity: { load: vi.fn(async () => []), save } }
    const store = await import('../activityStore')
    await store.loadActivity()
    store.recordActivity({ type: 'task', action: 'a' })
    await store.saveActivityNow()
    expect(save).toHaveBeenCalledTimes(2)
  })
})
