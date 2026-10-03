// Specs for the in-app Agent Task Board data layer: the shared task model
// (src/shared/taskModel.js) and the reactive renderer store
// (src/renderer/src/taskBoardStore.js). No UI / no IPC is exercised here —
// this is the foundation Builders 2/3 build their board view on top of.

import { describe, it, expect, beforeEach } from 'vitest'
import { watch, nextTick, isReactive } from 'vue'
import { COLUMNS, createTask } from '../../../shared/taskModel'
import {
  tasks,
  addTask,
  updateTask,
  moveTask,
  removeTask,
  assignAgent,
  setTasks
} from '../taskBoardStore'

describe('taskModel', () => {
  it('exposes the kanban columns in order', () => {
    expect(COLUMNS).toEqual(['todo', 'doing', 'review', 'done'])
  })

  it('createTask builds a task in the first column with no agent', () => {
    const task = createTask({ title: 'Wire up the board' })
    expect(task).toMatchObject({
      title: 'Wire up the board',
      column: 'todo',
      paneId: null
    })
    expect(typeof task.id).toBe('string')
    expect(task.id.length).toBeGreaterThan(0)
  })

  it('trims the title', () => {
    expect(createTask({ title: '  spaced  ' }).title).toBe('spaced')
  })

  it('mints a unique id per task', () => {
    const ids = new Set()
    for (let i = 0; i < 100; i += 1) ids.add(createTask({ title: 't' }).id)
    expect(ids.size).toBe(100)
  })

  it('rejects an empty or missing title — no silent failure', () => {
    expect(() => createTask({ title: '   ' })).toThrow()
    expect(() => createTask({})).toThrow()
    expect(() => createTask()).toThrow()
  })
})

describe('taskBoardStore', () => {
  beforeEach(() => {
    // Reset shared reactive state between tests without replacing the array
    // reference (callers and watchers hold onto it).
    tasks.splice(0, tasks.length)
  })

  it('exposes a reactive tasks array', () => {
    expect(Array.isArray(tasks)).toBe(true)
    expect(isReactive(tasks)).toBe(true)
  })

  it('addTask appends a task and returns it', () => {
    const task = addTask({ title: 'First' })
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toBe(task)
    expect(task.column).toBe('todo')
  })

  it('reacts when a task is added', async () => {
    let seen = -1
    const stop = watch(
      () => tasks.length,
      (len) => {
        seen = len
      }
    )
    addTask({ title: 'reactive?' })
    await nextTick()
    expect(seen).toBe(1)
    stop()
  })

  it('updateTask patches fields and ignores id changes', () => {
    const task = addTask({ title: 'Old' })
    const original = task.id
    const updated = updateTask(task.id, { title: 'New', id: 'hacked' })
    expect(updated).toBe(task)
    expect(task.title).toBe('New')
    expect(task.id).toBe(original)
  })

  it('updateTask returns null for an unknown id', () => {
    expect(updateTask('nope', { title: 'x' })).toBeNull()
  })

  it('moveTask moves a task to a valid column', () => {
    const task = addTask({ title: 'Move me' })
    moveTask(task.id, 'doing')
    expect(task.column).toBe('doing')
    moveTask(task.id, 'done')
    expect(task.column).toBe('done')
  })

  it('moveTask throws on an unknown column — no silent failure', () => {
    const task = addTask({ title: 'Move me' })
    expect(() => moveTask(task.id, 'archived')).toThrow()
    expect(task.column).toBe('todo')
  })

  it('removeTask removes a task and reports success', () => {
    const a = addTask({ title: 'a' })
    const b = addTask({ title: 'b' })
    expect(removeTask(a.id)).toBe(true)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toBe(b)
    expect(removeTask('missing')).toBe(false)
  })

  it('assignAgent links a task to a pane', () => {
    const task = addTask({ title: 'Assign me' })
    assignAgent(task.id, 'pane-1-42')
    expect(task.paneId).toBe('pane-1-42')
    // unassign
    assignAgent(task.id, null)
    expect(task.paneId).toBeNull()
  })

  it('assignAgent returns null for an unknown task', () => {
    expect(assignAgent('nope', 'pane-1')).toBeNull()
  })

  it('setTasks hydrates in place and keeps the same array reference', async () => {
    addTask({ title: 'stale' })
    const ref = tasks
    let seen = -1
    const stop = watch(
      () => tasks.length,
      (len) => {
        seen = len
      }
    )
    const loaded = [createTask({ title: 'loaded a' }), createTask({ title: 'loaded b' })]
    setTasks(loaded)
    await nextTick()
    expect(tasks).toBe(ref) // same reactive reference — watchers survive
    expect(tasks).toHaveLength(2)
    expect(tasks.map((t) => t.title)).toEqual(['loaded a', 'loaded b'])
    expect(seen).toBe(2)
    stop()
  })

  it('setTasks rejects a non-array — no silent failure', () => {
    expect(() => setTasks(null)).toThrow()
    expect(() => setTasks({})).toThrow()
  })
})

describe('doingSince', () => {
  it('starts a new period whenever a task enters Doing', async () => {
    const { addTask, moveTask, updateTask } = await import('../taskBoardStore')
    const t = addTask({ title: 'Period' })
    expect(t.doingSince).toBeUndefined()
    moveTask(t.id, 'doing')
    const first = t.doingSince
    expect(first).toBeGreaterThan(0)
    updateTask(t.id, { title: 'Renamed' })
    expect(t.doingSince).toBe(first)
    moveTask(t.id, 'review')
    await new Promise((r) => setTimeout(r, 5))
    moveTask(t.id, 'doing')
    expect(t.doingSince).toBeGreaterThan(first)
  })
})

// A card deleted on the board stays deleted: an older copy of the board
// loaded again (the window's interface restarted while the previous one was
// still showing the board, or a saved copy from before the deletion) never
// brings it back with the same id.
describe('a deleted card', () => {
  it('does not come back when an older copy of the board is loaded again', async () => {
    const { tasks, addTask, removeTask, setTasks, deletedTaskIds } = await import('../taskBoardStore')
    const a = addTask({ title: 'keep' })
    const b = addTask({ title: 'delete me' })
    const before = JSON.parse(JSON.stringify(tasks))
    removeTask(b.id)
    setTasks(before)
    expect(tasks.some((t) => t.id === b.id)).toBe(false)
    expect(tasks.some((t) => t.id === a.id)).toBe(true)
    expect(deletedTaskIds()).toContain(b.id)
  })

  it('deletions read from the saved board count too (and are kept with the new ones)', async () => {
    const { tasks, setTasks, addDeletedTasks, deletedTaskIds, removeTask, addTask } = await import('../taskBoardStore')
    addDeletedTasks(['task-9-1'])
    setTasks([{ id: 'task-9-1', title: 'gone', column: 'todo' }, { id: 'task-9-2', title: 'here', column: 'todo' }])
    expect(tasks.map((t) => t.id)).toEqual(['task-9-2'])
    const c = addTask({ title: 'c' })
    removeTask(c.id)
    expect(deletedTaskIds()).toEqual(expect.arrayContaining(['task-9-1', c.id]))
  })

  it('is handed once to the purge of the published copies', async () => {
    const { addTask, removeTask, takeDeletedToPurge } = await import('../taskBoardStore')
    takeDeletedToPurge()
    const d = addTask({ title: 'd' })
    removeTask(d.id)
    expect(takeDeletedToPurge()).toEqual([d.id])
    expect(takeDeletedToPurge()).toEqual([])
  })
})

// Which cards an agent's board shows and lets it change: the cards of its
// workspace(s), and the cards it (or a teammate) was given or added anywhere.
describe('cardOnBoard', () => {
  it('a card added by an agent of the board is on it, whatever its workspace', async () => {
    const { cardOnBoard } = await import('../taskBoardStore')
    const scope = { wsIds: ['ws-1'], memberIds: ['pane-1'] }
    expect(cardOnBoard({ id: 't', wsId: 'ws-1', paneId: null }, scope)).toBe(true)
    expect(cardOnBoard({ id: 't', wsId: 'ws-2', paneId: null, createdBy: 'pane-1' }, scope)).toBe(true)
    expect(cardOnBoard({ id: 't', wsId: 'ws-2', paneId: 'pane-1' }, scope)).toBe(true)
    expect(cardOnBoard({ id: 't', wsId: 'ws-2', paneId: 'pane-9', createdBy: 'pane-8' }, scope)).toBe(false)
    expect(cardOnBoard(null, scope)).toBe(false)
  })
})

describe('work periods (job cost)', () => {
  it('opens a period entering Doing, closes it leaving, and splits on a new pane', async () => {
    const { workPeriodsAfter } = await import('../taskBoardStore')
    let card = { column: 'todo', paneId: 'p1' }
    const step = (patch, now) => {
      const p = workPeriodsAfter(card, patch, now)
      card = { ...card, ...patch, ...(p ? { workPeriods: p } : {}) }
    }
    step({ column: 'doing' }, 100)
    expect(card.workPeriods).toEqual([{ start: 100, end: null, paneId: 'p1' }])
    step({ title: 'renamed' }, 150)
    expect(card.workPeriods).toHaveLength(1)
    step({ paneId: 'p2' }, 200)
    expect(card.workPeriods).toEqual([
      { start: 100, end: 200, paneId: 'p1' },
      { start: 200, end: null, paneId: 'p2' }
    ])
    step({ column: 'review' }, 300)
    expect(card.workPeriods[1]).toEqual({ start: 200, end: 300, paneId: 'p2' })
    step({ column: 'doing' }, 400)
    expect(card.workPeriods).toHaveLength(3)
    expect(card.workPeriods[2]).toEqual({ start: 400, end: null, paneId: 'p2' })
  })

  it('a card already in Doing without periods starts from doingSince', async () => {
    const { workPeriodsAfter } = await import('../taskBoardStore')
    const p = workPeriodsAfter({ column: 'doing', paneId: 'p1', doingSince: 50 }, { title: 'x' }, 500)
    expect(p).toEqual([{ start: 50, end: null, paneId: 'p1' }])
  })

  it('updateTask records the periods on the card', () => {
    const t = addTask({ title: 'job' })
    assignAgent(t.id, 'pane-a')
    moveTask(t.id, 'doing')
    expect(t.workPeriods).toHaveLength(1)
    expect(t.workPeriods[0].paneId).toBe('pane-a')
    moveTask(t.id, 'done')
    expect(t.workPeriods[0].end).toEqual(expect.any(Number))
  })
})
