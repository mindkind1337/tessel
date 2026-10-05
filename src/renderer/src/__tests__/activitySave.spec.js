import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { parseActivityText, activityText, isActivityText, MAX_EVENTS } from '../../../shared/activity'

describe('saving the activity log', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
  })
  afterEach(() => vi.useRealTimers())

  it('saves at most once per SAVE_EVERY_MS while events keep coming, as JSON text', async () => {
    const save = vi.fn(async () => ({ ok: true }))
    window.shellApi = { activity: { load: vi.fn(async () => ({ text: '' })), save } }
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
    expect(typeof sent).toBe('string')
    expect(isActivityText(sent)).toBe(true)
    expect(JSON.parse(sent).length).toBeGreaterThan(0)
  })

  it('loads the saved log from its text, keeping events recorded before it', async () => {
    const now = Date.now()
    const saved = [{ t: now - 5000, type: 'task', action: 'old' }, { nope: true }, { t: now - 4000, type: 'message' }]
    let release
    const load = vi.fn(() => new Promise((r) => (release = r)))
    window.shellApi = { activity: { load, save: vi.fn(async () => ({ ok: true })) } }
    const store = await import('../activityStore')
    const done = store.loadActivity()
    store.recordActivity({ type: 'task', action: 'early' })
    release({ text: JSON.stringify(saved) })
    await done
    expect(load).toHaveBeenCalledWith({ text: true })
    expect(store.activity.map((e) => e.action || e.type)).toEqual(['old', 'message', 'early'])
  })

  it('still takes a list (an older main process)', async () => {
    window.shellApi = { activity: { load: vi.fn(async () => [{ t: Date.now(), type: 'task' }]), save: vi.fn() } }
    const store = await import('../activityStore')
    await store.loadActivity()
    expect(store.activity.length).toBe(1)
  })

  it('counts each trim of old events', async () => {
    window.shellApi = { activity: { load: vi.fn(async () => ({ text: '' })), save: vi.fn(async () => ({ ok: true })) } }
    const store = await import('../activityStore')
    await store.loadActivity()
    expect(store.trimCount()).toBe(0)
    for (let i = 0; i <= MAX_EVENTS + 500; i++) store.recordActivity({ type: 'task' })
    expect(store.trimCount()).toBe(1)
    expect(store.activity.length).toBe(MAX_EVENTS)
  })
})

describe('the log as text', () => {
  it('parses, checks and bounds it', () => {
    const now = 1e12
    const text = JSON.stringify([{ t: now - 1, type: 'a' }, { t: 'x', type: 'b' }, null, { t: now - 40 * 24 * 3600e3, type: 'old' }])
    expect(parseActivityText(text, now)).toEqual([{ t: now - 1, type: 'a' }])
    expect(parseActivityText('', now)).toEqual([])
    expect(parseActivityText('{"a":1}', now)).toEqual([])
    expect(parseActivityText('[1,', now)).toEqual([])
    expect(parseActivityText(undefined, now)).toEqual([])
  })
  it('writes only events, bounded', () => {
    const now = 1e12
    expect(JSON.parse(activityText([{ t: now, type: 'a' }, { bad: 1 }], now))).toEqual([{ t: now, type: 'a' }])
  })
  it('accepts only a JSON list as text to store', () => {
    expect(isActivityText('[]')).toBe(true)
    expect(isActivityText(' [{"t":1}]\n')).toBe(true)
    expect(isActivityText('{}')).toBe(false)
    expect(isActivityText(42)).toBe(false)
  })
})
