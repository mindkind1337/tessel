// What triggers a save of the task board (App.vue watches boardWatchState and
// historyVersion instead of the whole board and history, deeply).
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { watch, nextTick } from 'vue'
import { tasks, setTasks, addTask, updateTask, removeTask, boardWatchState } from '../taskBoardStore'
import { taskHistory, historyVersion, setTaskHistory, noteCost, forgetDone, renameDone, backfillHistory } from '../taskHistory'

let saves
beforeEach(async () => {
  setTasks([])
  setTaskHistory([])
  saves = vi.fn()
  watch([() => boardWatchState(tasks), historyVersion], saves, { deep: true })
  await nextTick()
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
    expect(await settle()).toBe(1)
    updateTask(c.id, { column: 'doing', paneId: 'p1' })
    await settle()
    tasks[0].workPeriods.push({ start: 1, end: null, paneId: 'x' })
    expect(await settle()).toBe(1)
  })

  it('adding, moving to Done, renaming or moving out of Done, and deleting a card save', async () => {
    const c = addTask({ title: 'A' })
    expect(await settle()).toBe(1)
    updateTask(c.id, { column: 'done' })
    expect(await settle()).toBe(1)
    updateTask(c.id, { title: 'Renamed' })
    expect(await settle()).toBe(1)
    tasks[0].report = { outcome: 'done' }
    expect(await settle()).toBe(1)
    updateTask(c.id, { column: 'review' })
    expect(await settle()).toBe(1)
    updateTask(c.id, { column: 'done' })
    await settle()
    removeTask(c.id)
    expect(await settle()).toBe(1)
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
    expect(await settle()).toBe(1)
    forgetDone(c.id)
    expect(await settle()).toBe(1)
    setTasks([{ id: 'old', title: 'Old', column: 'done', doneAt: 5 }])
    await settle()
    expect(backfillHistory(tasks)).toBe(1)
    expect(await settle()).toBe(1)
    expect(taskHistory.map((r) => r.id)).toEqual(['old'])
  })

  it('a finished card is not tracked deeply: only its listed fields', () => {
    setTasks(Array.from({ length: 50 }, (_, i) => ({ id: `d${i}`, title: 't', column: 'done', doneAt: i, workPeriods: [{ start: 1 }] })))
    const state = boardWatchState(tasks)
    expect(state.active).toEqual([])
    expect(state.finished).toHaveLength(50 * 6)
  })
})
