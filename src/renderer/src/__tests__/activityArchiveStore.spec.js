// The activity log stored in pieces (activityStore.js, shared/activity.js): the
// settled events go to the archive once, activity.json holds the recent ones,
// both are read back whole.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mergeSavedActivity, parseActivityLines, MAX_EVENTS, MAX_AGE_MS } from '../../../shared/activity'

const HOUR = 3600 * 1000
const ev = (t, extra = {}) => ({ t, type: 'task', action: 'x', ...extra })

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

  it('inArchive: the events that came from the archive, whatever their time order with the live ones', () => {
    // A team message logged late carries the time it was sent: it sorts
    // among archived events but is not archived itself.
    const a = [ev(now - 50 * HOUR, { n: 1 }), ev(now - 40 * HOUR, { n: 2 })]
    const live = [ev(now - 10 * 60000, { n: 3 }), ev(now - 45 * HOUR, { n: 4 })]
    const out = mergeSavedActivity(JSON.stringify(live), a.map((e) => JSON.stringify(e)).join('\n'), now)
    expect(out.events.map((e) => e.n)).toEqual([1, 4, 2, 3])
    expect(out.events.filter((e) => out.inArchive.has(e)).map((e) => e.n)).toEqual([1, 2])
    expect(out.archived).toBe(2)
  })

  it('a team message stored twice (logged again, or unread then read) is one event, read if a copy is', () => {
    const msg = (status, title) => ev(now - 30 * HOUR, { type: 'message', msgId: 'm-1', status, agent: { title } })
    const archive = [msg('unread', 'Ada'), msg('unread', 'Ada (renamed)')].map((e) => JSON.stringify(e)).join('\n')
    const out = mergeSavedActivity(JSON.stringify([msg('read', 'Ada')]), archive, now)
    expect(out.events).toHaveLength(1)
    expect(out.events[0].status).toBe('read')
    // The read copy is the live file's: not in the archive yet, so archived (read) later.
    expect(out.inArchive.has(out.events[0])).toBe(false)
    const both = mergeSavedActivity('[]', [msg('unread', 'Ada'), msg('read', 'Ada')].map((e) => JSON.stringify(e)).join('\n'), now)
    expect(both.events.map((e) => e.status)).toEqual(['read'])
    expect(both.inArchive.has(both.events[0])).toBe(true)
  })

  it('past MAX_EVENTS the archived events go first: an event only in the live file is kept', () => {
    const archive = Array.from({ length: MAX_EVENTS }, (_, i) => JSON.stringify(ev(now - 10 * HOUR + i, { n: i }))).join('\n')
    const out = mergeSavedActivity(JSON.stringify([ev(now - 20 * HOUR, { n: 'live' })]), archive, now)
    expect(out.events).toHaveLength(MAX_EVENTS)
    expect(out.events[0].n).toBe('live')
    expect(out.events[1].n).toBe(1)
    expect(out.archived).toBe(MAX_EVENTS - 1)
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

  it('events logged with an old time after the archived ones: a start archives those only, never the archive again', async () => {
    const now = Date.now()
    const arch = Array.from({ length: 50 }, (_, i) => ev(now - 50 * HOUR + i * 60000, { n: i }))
    // Recent events, then team messages logged late with the time they were sent.
    const live = [ev(now - 5 * 60000, { n: 100 }), ev(now - 50 * HOUR + 10.5 * 60000, { n: 101, type: 'message', msgId: 'a', status: 'read' }), ev(now - 2 * 60000, { n: 102 })]
    const shell = api({ load: vi.fn(async () => ({ text: JSON.stringify(live), archive: arch.map((e) => JSON.stringify(e)).join('\n') })) })
    window.shellApi = { activity: shell }
    const store = await import('../activityStore')
    await store.loadActivity()
    await store.saveActivityNow()
    const sent = shell.archive.mock.calls.flatMap(([text]) => JSON.parse(text).map((e) => e.n))
    expect(sent).toEqual([101])
    expect(JSON.parse(shell.save.mock.calls[0][0]).map((e) => e.n).sort()).toEqual([100, 102])
    expect(store.activity).toHaveLength(53)
  })

  it('an event recorded now with an old time stays in activity.json for an hour, then is archived', async () => {
    const now = Date.now()
    window.shellApi = { activity: api() }
    const shell = window.shellApi.activity
    const store = await import('../activityStore')
    await store.loadActivity()
    store.recordActivity({ t: now - 30 * HOUR, type: 'message', msgId: 'late', status: 'unread' })
    await store.saveActivityNow()
    expect(shell.archive).not.toHaveBeenCalled()
    expect(JSON.parse(shell.save.mock.calls[0][0]).map((e) => e.msgId)).toEqual(['late'])
    vi.setSystemTime(now + HOUR + 1000)
    await store.saveActivityNow()
    expect(JSON.parse(shell.archive.mock.calls[0][0]).map((e) => e.msgId)).toEqual(['late'])
    expect(JSON.parse(shell.save.mock.calls[1][0])).toEqual([])
  })

  it('a team message read after it was archived is stored again, read; another archived event changed is not', async () => {
    const now = Date.now()
    const arch = [ev(now - 9 * HOUR, { type: 'message', msgId: 'm', status: 'unread' }), ev(now - 8 * HOUR, { type: 'agent.state', paneId: 'p', since: 1 })]
    const shell = api({ load: vi.fn(async () => ({ text: '[]', archive: arch.map((e) => JSON.stringify(e)).join('\n') })) })
    window.shellApi = { activity: shell }
    const store = await import('../activityStore')
    await store.loadActivity()
    const [msg, state] = store.activity
    msg.status = 'read'
    state.since = 2
    store.activityChanged(msg, state)
    await store.saveActivityNow()
    // In activity.json meanwhile (changed a moment ago), then archived again, read.
    expect(JSON.parse(shell.save.mock.calls[0][0]).map((e) => e.status)).toEqual(['read'])
    vi.setSystemTime(now + HOUR + 1000)
    await store.saveActivityNow()
    expect(shell.archive).toHaveBeenCalledTimes(1)
    expect(JSON.parse(shell.archive.mock.calls[0][0])).toEqual([expect.objectContaining({ msgId: 'm', status: 'read' })])
  })

  it('a log past its limit drops archived events first, never one only activity.json holds', async () => {
    const now = Date.now()
    const arch = Array.from({ length: MAX_EVENTS - 1 }, (_, i) => JSON.stringify(ev(now - 10 * HOUR + i, { n: i }))).join('\n')
    const shell = api({ load: vi.fn(async () => ({ text: JSON.stringify([ev(now - 20 * HOUR, { n: 'only-live' })]), archive: arch })) })
    window.shellApi = { activity: shell }
    const store = await import('../activityStore')
    await store.loadActivity()
    expect(store.activity[0].n).toBe('only-live')
    for (let i = 0; i < 501; i++) store.recordActivity({ type: 'task', action: 'new', n: `new-${i}` })
    expect(store.activity).toHaveLength(MAX_EVENTS)
    expect(store.activity[0].n).toBe('only-live')
    expect(store.activity.at(-1).n).toBe('new-500')
    expect(store.trimCount()).toBe(1)
  })

  it('an archive that answers ok marks only what it was sent; the rest is sent at the next save', async () => {
    const now = Date.now()
    const saved = Array.from({ length: 3001 }, (_, i) => ev(now - 5 * HOUR + i, { n: i }))
    let calls = 0
    const shell = api({ load: vi.fn(async () => ({ text: JSON.stringify(saved), archive: '' })), archive: vi.fn(async () => (++calls === 1 ? { ok: true } : { ok: false })) })
    window.shellApi = { activity: shell }
    const store = await import('../activityStore')
    await store.loadActivity()
    await store.saveActivityNow()
    expect(JSON.parse(shell.save.mock.calls[0][0]).map((e) => e.n)).toEqual([3000])
    shell.archive.mockImplementation(async () => ({ ok: true }))
    await store.saveActivityNow()
    expect(JSON.parse(shell.archive.mock.calls[2][0]).map((e) => e.n)).toEqual([3000])
    expect(JSON.parse(shell.save.mock.calls[1][0])).toEqual([])
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
