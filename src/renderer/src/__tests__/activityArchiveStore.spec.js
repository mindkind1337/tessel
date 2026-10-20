// The activity log stored in pieces (activityStore.js, shared/activity.js): the
// settled events go to the archive once, activity.json holds the recent ones,
// both are read back whole.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mergeSavedActivity, settledBatch, parseActivityLines, SETTLE_MS, MAX_EVENTS, MAX_AGE_MS } from '../../../shared/activity'

const HOUR = 3600 * 1000
const ev = (t, extra = {}) => ({ t, type: 'task', action: 'x', ...extra })

describe('settledBatch', () => {
  it('takes the events recorded more than SETTLE_MS ago, from the first not archived', () => {
    const now = 100 * HOUR
    const list = [ev(1 * HOUR), ev(2 * HOUR), ev(now - SETTLE_MS - 1), ev(now - SETTLE_MS + 5), ev(now)]
    expect(settledBatch(list, 0, now)).toEqual(list.slice(0, 3))
    expect(settledBatch(list, 2, now)).toEqual(list.slice(2, 3))
    expect(settledBatch(list, 3, now)).toEqual([])
  })

  it('a batch of at most max never ends between two events with the same time', () => {
    const now = 100 * HOUR
    const list = [ev(1), ev(2), ev(2, { n: 1 }), ev(2, { n: 2 }), ev(3)]
    expect(settledBatch(list, 0, now, 2).map((e) => e.t)).toEqual([1, 2, 2, 2])
  })
})

describe('mergeSavedActivity', () => {
  const now = Date.now()
  it('the archive then the live file, without copies; how many came from the archive', () => {
    const a = [ev(now - 5 * HOUR, { n: 1 }), ev(now - 4 * HOUR, { n: 2 })]
    const live = [ev(now - 4 * HOUR, { n: 2 }), ev(now - HOUR, { n: 3 })]
    const archive = '\n' + a.map((e) => JSON.stringify(e)).join('\n') + '\n'
    const out = mergeSavedActivity(JSON.stringify(live), archive, now)
    expect(out.events.map((e) => e.n)).toEqual([1, 2, 3])
    expect(out.archived).toBe(2)
  })

  it('lines cut by a kill and unreadable live files are skipped', () => {
    const good = ev(now - HOUR, { n: 1 })
    const archive = `${JSON.stringify(good)}\n{"t":123,"ty\n\n${JSON.stringify(ev(now - 1000, { n: 2 }))}\n`
    expect(mergeSavedActivity('{ broken', archive, now).events.map((e) => e.n)).toEqual([1, 2])
    expect(parseActivityLines('not json\n{"nope":1}\n')).toEqual([])
  })

  it('the old single file (no archive) is the live file whole; events past the age or count limit are dropped', () => {
    const old = ev(now - MAX_AGE_MS - HOUR, { n: 0 })
    const list = [old, ...Array.from({ length: MAX_EVENTS + 5 }, (_, i) => ev(now - 10000 + i, { n: i + 1 }))]
    const out = mergeSavedActivity(JSON.stringify(list), '', now)
    expect(out.events).toHaveLength(MAX_EVENTS)
    expect(out.events[0].n).toBe(6)
    expect(out.archived).toBe(0)
  })
})

describe('saving through activityStore', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
  })
  afterEach(() => vi.useRealTimers())

  function api(overrides = {}) {
    return {
      load: vi.fn(async () => ({ text: '', archive: '' })),
      save: vi.fn(async () => ({ ok: true })),
      archive: vi.fn(async () => ({ ok: true })),
      ...overrides
    }
  }

  it('settled events go to the archive once, then leave the live file; recent ones stay in it', async () => {
    const now = Date.now()
    const saved = [ev(now - 5 * HOUR, { n: 1 }), ev(now - 3 * HOUR, { n: 2 }), ev(now - 60000, { n: 3 })]
    const shell = api({ load: vi.fn(async () => ({ text: JSON.stringify(saved), archive: '' })) })
    window.shellApi = { activity: shell }
    const store = await import('../activityStore')
    await store.loadActivity()
    await store.saveActivityNow()
    expect(shell.archive).toHaveBeenCalledTimes(1)
    expect(JSON.parse(shell.archive.mock.calls[0][0]).map((e) => e.n)).toEqual([1, 2])
    expect(JSON.parse(shell.save.mock.calls[0][0]).map((e) => e.n)).toEqual([3])
    // The whole log is still in the window.
    expect(store.activity.map((e) => e.n)).toEqual([1, 2, 3])
    // Nothing new: nothing archived again, nothing sent again.
    await store.saveActivityNow()
    expect(shell.archive).toHaveBeenCalledTimes(1)
    expect(shell.save).toHaveBeenCalledTimes(1)
    store.recordActivity({ type: 'task', action: 'new' })
    await store.saveActivityNow()
    expect(shell.archive).toHaveBeenCalledTimes(1)
    expect(JSON.parse(shell.save.mock.calls[1][0])).toHaveLength(2)
  })

  it('events loaded from the archive are not archived again', async () => {
    const now = Date.now()
    const arch = [ev(now - 9 * HOUR, { n: 1 }), ev(now - 8 * HOUR, { n: 2 })]
    const shell = api({ load: vi.fn(async () => ({ text: JSON.stringify([ev(now - 100, { n: 3 })]), archive: arch.map((e) => JSON.stringify(e)).join('\n') })) })
    window.shellApi = { activity: shell }
    const store = await import('../activityStore')
    await store.loadActivity()
    expect(store.activity.map((e) => e.n)).toEqual([1, 2, 3])
    await store.saveActivityNow()
    expect(shell.archive).not.toHaveBeenCalled()
    expect(JSON.parse(shell.save.mock.calls[0][0]).map((e) => e.n)).toEqual([3])
  })

  it('an archive that fails keeps every event in activity.json', async () => {
    const now = Date.now()
    const saved = [ev(now - 5 * HOUR, { n: 1 }), ev(now - 60000, { n: 2 })]
    const shell = api({ load: vi.fn(async () => ({ text: JSON.stringify(saved), archive: '' })), archive: vi.fn(async () => ({ ok: false, error: 'disk' })) })
    window.shellApi = { activity: shell }
    const store = await import('../activityStore')
    await store.loadActivity()
    await store.saveActivityNow()
    expect(JSON.parse(shell.save.mock.calls[0][0]).map((e) => e.n)).toEqual([1, 2])
  })

  it('a big old log (the previous version) is archived in batches, then the live file is small', async () => {
    const now = Date.now()
    const saved = Array.from({ length: 8000 }, (_, i) => ev(now - 48 * HOUR + i * 1000, { n: i }))
    const shell = api({ load: vi.fn(async () => ({ text: JSON.stringify(saved), archive: '' })) })
    window.shellApi = { activity: shell }
    const store = await import('../activityStore')
    await store.loadActivity()
    await store.saveActivityNow()
    expect(shell.archive).toHaveBeenCalledTimes(3)
    const archived = shell.archive.mock.calls.flatMap(([text]) => JSON.parse(text).map((e) => e.n))
    expect(archived).toEqual(saved.map((e) => e.n))
    expect(JSON.parse(shell.save.mock.calls[0][0])).toEqual([])
    expect(store.activity).toHaveLength(8000)
  })

  it('an older window API without archive writes the whole log as before', async () => {
    const now = Date.now()
    const shell = api({ load: vi.fn(async () => ({ text: JSON.stringify([ev(now - 9 * HOUR, { n: 1 })]) })) })
    delete shell.archive
    window.shellApi = { activity: shell }
    const store = await import('../activityStore')
    await store.loadActivity()
    await store.saveActivityNow()
    expect(JSON.parse(shell.save.mock.calls[0][0])).toHaveLength(1)
  })

  it('closing the window: two saves at once never archive the same events twice', async () => {
    const now = Date.now()
    const shell = api({ load: vi.fn(async () => ({ text: JSON.stringify([ev(now - 5 * HOUR, { n: 1 })]), archive: '' })) })
    window.shellApi = { activity: shell }
    const store = await import('../activityStore')
    await store.loadActivity()
    await Promise.all([store.saveActivityNow(), store.saveActivityNow()])
    expect(shell.archive).toHaveBeenCalledTimes(1)
  })
})
