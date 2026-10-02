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
