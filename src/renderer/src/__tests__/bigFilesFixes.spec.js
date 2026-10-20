// The reviewed risks of the big-file changes, window side: the history is sent
// again after a save that did not store it, closing sends the recent activity
// first, and the board watch sees every field a finished card can still get.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { watch, nextTick } from 'vue'
import { tasks, setTasks, addTask, updateTask, boardWatchState } from '../taskBoardStore'
import { setTaskHistory, historyVersion, createHistorySync, renameDone, recordDone } from '../taskHistory'

describe('F1: the history travels again after a save that did not store it', () => {
  beforeEach(() => setTaskHistory([]))

  it('sent when changed; a good answer marks it stored; unchanged: not sent', () => {
    const sync = createHistorySync()
    sync.markStored()
    expect(sync.pending()).toBeNull()
    recordDone({ id: 'c1', title: 'A', doneAt: 5 })
    const first = sync.pending()
    expect(first.history.map((r) => r.id)).toEqual(['c1'])
    sync.settle(first.version, { ok: true })
    expect(sync.pending()).toBeNull()
  })

  it('a refused or failed save, or no answer, sends the whole history with the next one', () => {
    const sync = createHistorySync()
    sync.markStored()
    recordDone({ id: 'c1', title: 'A', doneAt: 5 })
    const first = sync.pending()
    sync.settle(first.version, { ok: false, error: 'busy' })
    expect(sync.pending().history).toHaveLength(1)
    // A save that did not carry the history and failed (the main process could not read it): resend.
    const again = sync.pending()
    sync.settle(again.version, { ok: true })
    expect(sync.pending()).toBeNull()
    sync.settle(null, { ok: false, error: 'The saved task history could not be read.' })
    expect(sync.pending().history).toHaveLength(1)
    sync.settle(sync.pending().version, null)
    expect(sync.pending()).not.toBeNull()
  })

  it('a good save that carried no history leaves what is stored as it was', () => {
    const sync = createHistorySync()
    sync.markStored()
    sync.settle(null, { ok: true })
    expect(sync.pending()).toBeNull()
    renameDone('nothing', 'x')
    recordDone({ id: 'c2', title: 'B', doneAt: 6 })
    expect(sync.pending()).not.toBeNull()
    expect(historyVersion.value).toBeGreaterThan(0)
  })
})

describe('F2: closing sends the recent activity first', () => {
  beforeEach(() => {
    vi.resetModules()
  })
  afterEach(() => vi.useRealTimers())
  const HOUR = 3600 * 1000

  it('a save waiting for the archive does not hold back the closing one, which sends everything not archived and archives nothing', async () => {
    const now = Date.now()
    const saved = [{ t: now - 5 * HOUR, type: 'task', n: 1 }, { t: now - 60000, type: 'task', n: 2 }]
    let release
    const archive = vi.fn(() => new Promise((r) => (release = r)))
    const save = vi.fn(async () => ({ ok: true }))
    window.shellApi = { activity: { load: vi.fn(async () => ({ text: JSON.stringify(saved), archive: '' })), save, archive } }
    const store = await import('../activityStore')
    await store.loadActivity()
    const normal = store.saveActivityNow() // archiving, its answer never comes
    await Promise.resolve()
    expect(archive).toHaveBeenCalledTimes(1)
    expect(save).not.toHaveBeenCalled()
    store.recordActivity({ type: 'task', n: 3 })
    const closing = store.saveActivityNow({ closing: true })
    await closing
    expect(save).toHaveBeenCalledTimes(1)
    expect(JSON.parse(save.mock.calls[0][0]).map((e) => e.n)).toEqual([1, 2, 3])
    expect(archive).toHaveBeenCalledTimes(1)
    release({ ok: true })
    await normal
  })
})

describe('F4: every field a finished card can still get is watched', () => {
  let saves
  beforeEach(async () => {
    setTasks([])
    setTaskHistory([])
    saves = vi.fn()
    watch([() => boardWatchState(tasks), historyVersion], saves, { deep: true })
    const c = addTask({ title: 'A' })
    updateTask(c.id, { column: 'done' })
    await nextTick()
    saves.mockClear()
  })

  for (const [field, value] of [
    ['worktree', { path: 'C:/w' }],
    ['mergedAt', 5],
    ['mergeSha', 'abc'],
    ['brief', 'do it'],
    ['leadReview', { ok: true }],
    ['leadNote', 'fine'],
    ['gate', { status: 'answered' }],
    ['guestBy', 'Zoe'],
    ['aFieldNobodyListed', 1]
  ]) {
    it(`${field} set on a finished card saves the board`, async () => {
      updateTask(tasks[0].id, { [field]: value })
      await nextTick()
      expect(saves).toHaveBeenCalledTimes(1)
    })
  }

  it('a nested change in a finished card\'s gate or review saves too', async () => {
    updateTask(tasks[0].id, { gate: { status: 'open' }, leadReview: { ok: false } })
    await nextTick()
    saves.mockClear()
    tasks[0].gate.status = 'answered'
    await nextTick()
    expect(saves).toHaveBeenCalledTimes(1)
    tasks[0].leadReview.ok = true
    await nextTick()
    expect(saves).toHaveBeenCalledTimes(2)
  })
})
