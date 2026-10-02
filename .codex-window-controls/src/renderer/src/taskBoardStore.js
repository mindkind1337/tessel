// Reactive data layer for the Agent Task Board. Holds the single source of
// truth for board tasks and the mutators the UI calls. No IPC and no DOM here —
// persistence (load/save) lives in App.vue / the main process and feeds this
// store through setTasks(); the board view (Builders 2/3) renders `tasks` and
// calls the mutators below.

import { reactive } from 'vue'
import { COLUMNS, createTask } from '../../shared/taskModel'

// The reactive collection to watch / render. Mutated in place so external
// references and watchers stay valid across hydration.
export const tasks = reactive([])

function find(id) {
  return tasks.find((t) => t.id === id) || null
}

export function addTask(input) {
  const task = createTask(input)
  tasks.push(task)
  // Return the reactive entry (not the raw object) so callers share identity
  // with what lives in the store and with what the other mutators return.
  return tasks[tasks.length - 1]
}

// Patch fields on an existing task. The id is immutable and never overwritten.
// Returns the task, or null if no task has that id.
export function updateTask(id, patch = {}) {
  const task = find(id)
  if (!task) return null
  const rest = { ...patch }
  delete rest.id
  Object.assign(task, rest)
  return task
}

export function moveTask(id, column) {
  if (!COLUMNS.includes(column)) {
    throw new Error(`moveTask: unknown column '${column}'`)
  }
  return updateTask(id, { column })
}

export function removeTask(id) {
  const idx = tasks.findIndex((t) => t.id === id)
  if (idx === -1) return false
  tasks.splice(idx, 1)
  return true
}

export function assignAgent(taskId, paneId) {
  return updateTask(taskId, { paneId })
}

// Hydrate the board from persisted tasks, replacing the collection in place so
// watch(tasks, ...) on the caller side keeps firing (used by App.vue on launch).
export function setTasks(nextTasks) {
  if (!Array.isArray(nextTasks)) {
    throw new Error('setTasks requires an array of tasks')
  }
  tasks.splice(0, tasks.length, ...nextTasks)
  return tasks
}
