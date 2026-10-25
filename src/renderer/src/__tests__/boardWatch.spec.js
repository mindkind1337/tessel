// What triggers a save of the task board: App.vue watches every card with
// watchBoard (a watcher per card) and the history by its version counter,
// instead of the whole board and history deeply.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { watch, nextTick } from 'vue'
import { tasks, setTasks, addTask, updateTask, removeTask, watchBoard } from '../taskBoardStore'
import { taskHistory, historyVersion, setTaskHistory, noteCost, forgetDone, renameDone, backfillHistory } from '../taskHistory'

let saves
let stops = []
beforeEach(async () => {
  setTasks([])
  setTaskHistory([])
  saves = vi.fn()
  stops = [watchBoard(saves, tasks), watch(historyVersion, saves)]
  await nextTick()
  saves.mockClear()
})
afterEach(() => {
  for (const stop of stops) stop()
})

const settle = async () => {
  await nextTick()
  const n = saves.mock.calls.length
  saves.mockClear()
  return n
}

describe('saving the task board', () => {
  it('a change inside a card in play saves (even a nested one)', async () => {
    const c = addTask({ title: 'A' })
    await settle()
    c.title = 'B'
    expect(await settle()).toBeGreaterThan(0)
    updateTask(c.id, { column: 'doing', paneId: 'p1' })
    await settle()
    tasks[0].workPeriods.push({ start: 1, end: null, paneId: 'x' })
    expect(await settle()).toBeGreaterThan(0)
    tasks[0].workPeriods[0].end = 5
    expect(await settle()).toBeGreaterThan(0)
  })

  it('adding, moving to Done, renaming or moving out of Done, and deleting a card save', async () => {
    const c = addTask({ title: 'A' })
    expect(await settle()).toBeGreaterThan(0)
    updateTask(c.id, { column: 'done' })
    expect(await settle()).toBeGreaterThan(0)
    updateTask(c.id, { title: 'Renamed' })
    expect(await settle()).toBeGreaterThan(0)
    tasks[0].report = { outcome: 'done' }
    expect(await settle()).toBeGreaterThan(0)
    tasks[0].report.outcome = 'merged'
    expect(await settle()).toBeGreaterThan(0)
    updateTask(c.id, { column: 'review' })
    expect(await settle()).toBeGreaterThan(0)
    updateTask(c.id, { column: 'done' })
    await settle()
    removeTask(c.id)
    expect(await settle()).toBeGreaterThan(0)
  })

  it('any field of a finished card saves, however deep, including fields nobody listed', async () => {
    setTasks([{ id: 'd1', title: 't', column: 'done', doneAt: 1, createdBy: 'p1', workPeriods: [{ start: 1, end: 2, paneId: 'p1' }] }])
    await settle()
    tasks[0].createdBy = 'p2'
    expect(await settle()).toBeGreaterThan(0)
    tasks[0].workPeriods[0].end = 3
    expect(await settle()).toBeGreaterThan(0)
    tasks[0].someFutureField = { deep: { value: 1 } }
    expect(await settle()).toBeGreaterThan(0)
    tasks[0].someFutureField.deep.value = 2
    expect(await settle()).toBeGreaterThan(0)
    delete tasks[0].createdBy
    expect(await settle()).toBeGreaterThan(0)
  })

  it('a board replaced whole (setTasks) is watched card by card; a removed card no longer saves', async () => {
    setTasks([{ id: 'a', title: 'a', column: 'todo' }, { id: 'b', title: 'b', column: 'done' }])
    expect(await settle()).toBeGreaterThan(0)
    const gone = tasks[0]
    removeTask('a')
    expect(await settle()).toBeGreaterThan(0)
    gone.title = 'changed after removal'
    expect(await settle()).toBe(0)
    tasks[0].title = 'b2'
    expect(await settle()).toBeGreaterThan(0)
  })

  it('nothing changed: nothing saved; stop() ends every watcher', async () => {
    setTasks([{ id: 'n1', title: 'a', column: 'todo' }])
    await settle()
    expect(await settle()).toBe(0)
    stops[0]()
    tasks[0].title = 'x'
    addTask({ title: 'B' })
    expect(await settle()).toBe(0)
  })

  it('a change re-reads that card only, not the whole board', async () => {
    setTasks(Array.from({ length: 2000 }, (_, i) => ({ id: `c${i}`, title: 't', column: i % 10 ? 'done' : 'doing', workPeriods: [{ start: 1, end: 2, paneId: 'p' }] })))
    await settle()
    // 40 changes, each in its own tick (each one runs the watchers): one deep
    // watcher of a 2000-card board re-read all of it each time (tens of ms).
    const before = performance.now()
    for (let i = 0; i < 40; i++) {
      tasks[i * 37].title = `x${i}`
      await nextTick()
    }
    const ms = performance.now() - before
    expect(saves).toHaveBeenCalledTimes(40)
    expect(ms).toBeLessThan(150)
  })

  it('every kind of history change saves: a record, a rename, the figures, a removal, a backfill', async () => {
    const c = addTask({ title: 'A' })
    await settle()
    updateTask(c.id, { column: 'done' }) // its record
    expect(historyVersion.value).toBeGreaterThan(0)
    await settle()
    const before = historyVersion.value
    renameDone(c.id, 'New')
    noteCost(c.id, { status: 'ok', inputTokens: 5 })
    expect(historyVersion.value).toBeGreaterThanOrEqual(before + 2)
    expect(await settle()).toBeGreaterThan(0)
    forgetDone(c.id)
    expect(await settle()).toBeGreaterThan(0)
    setTasks([{ id: 'old', title: 'Old', column: 'done', doneAt: 5 }])
    await settle()
    expect(backfillHistory(tasks)).toBe(1)
    expect(await settle()).toBeGreaterThan(0)
    expect(taskHistory.map((r) => r.id)).toEqual(['old'])
  })
})
