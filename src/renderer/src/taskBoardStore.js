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
  // Entering Doing (from any column, by any path) starts a new period for
  // agent tracking.
  if (rest.column === 'doing' && task.column !== 'doing' && !('doingSince' in rest)) rest.doingSince = Date.now()
  // When the work started (first time in Doing) and when it was finished
  // (entering Done; taken back out of Done, it is not finished any more).
  // When it arrived in its column: the board lists each column in that order.
  if (rest.column && rest.column !== task.column && !('columnSince' in rest)) rest.columnSince = Date.now()
  if (rest.column === 'doing' && !task.startedAt && !('startedAt' in rest)) rest.startedAt = Date.now()
  if (rest.column === 'done' && task.column !== 'done' && !('doneAt' in rest)) rest.doneAt = Date.now()
  if (rest.column && rest.column !== 'done' && task.column === 'done') rest.doneAt = null
  const periods = workPeriodsAfter(task, rest, Date.now())
  if (periods) rest.workPeriods = periods
  Object.assign(task, rest)
  return task
}

// The periods the card spent in Doing, with the pane that worked on it:
// [{ start, end (null while it is in Doing), paneId }], oldest first. The job
// cost (src/main/jobCost.js) counts the tokens that pane spent in them. A new
// pane while in Doing closes the period and opens another one for the new
// pane. -> the new list, or null when it does not change.
const MAX_PERIODS = 50
export function workPeriodsAfter(task, patch, now) {
  if ('workPeriods' in patch) return null
  const was = task.column === 'doing'
  const is = (patch.column || task.column) === 'doing'
  const pane = 'paneId' in patch ? patch.paneId || null : task.paneId || null
  const list = Array.isArray(task.workPeriods) ? task.workPeriods.map((p) => ({ ...p })) : []
  const open = list.length && list[list.length - 1].end == null ? list[list.length - 1] : null
  let changed = false
  if (open && (!is || open.paneId !== pane)) {
    open.end = now
    changed = true
  }
  if (is && (!was || !open || open.paneId !== pane)) {
    // A card already in Doing before periods were kept: since it got there.
    const legacy = was && !open && !list.length && pane === (task.paneId || null)
    const start = legacy ? Number(task.doingSince) || Number(task.startedAt) || now : now
    list.push({ start, end: null, paneId: pane })
    changed = true
  }
  return changed ? list.slice(-MAX_PERIODS) : null
}

export function moveTask(id, column) {
  if (!COLUMNS.includes(column)) {
    throw new Error(`moveTask: unknown column '${column}'`)
  }
  return updateTask(id, { column })
}

// Cards deleted from the board, by id (oldest first). A deleted card never
// comes back: a copy of the board from before its deletion (loaded again when
// the interface restarts while the previous one still shows the board, or
// written by a window that still had it) is filtered here, and the ids are
// saved with the board (the main process keeps every window's deletions, see
// taskBoardPersistence.js). Card ids are never reused.
const MAX_DELETED = 5000
const deleted = new Set()
// Deleted since the published copies for the agents were last cleaned
// (App.vue removes them from every team and workspace board).
const toPurge = new Set()

function forget(id) {
  deleted.delete(id)
  deleted.add(id)
  while (deleted.size > MAX_DELETED) deleted.delete(deleted.values().next().value)
}

export function removeTask(id) {
  const idx = tasks.findIndex((t) => t.id === id)
  if (idx === -1) return false
  tasks.splice(idx, 1)
  forget(id)
  toPurge.add(id)
  return true
}

export function deletedTaskIds() {
  return [...deleted]
}

// Deletions read from the saved board (kept with this window's own).
export function addDeletedTasks(ids) {
  if (!Array.isArray(ids)) return
  for (const id of ids) if (typeof id === 'string' && id && !deleted.has(id)) forget(id)
  for (let i = tasks.length - 1; i >= 0; i--) if (deleted.has(tasks[i].id)) tasks.splice(i, 1)
}

// The ids deleted since the last call (each handed out once).
export function takeDeletedToPurge() {
  const ids = [...toPurge]
  toPurge.clear()
  return ids
}

// Is this card on the board of these agents? Its workspace's board (a card
// with no agent belongs to its workspace and every agent there sees it), or
// a card given to or added by one of them, wherever it is. The same rule for
// what the agents read (team_tasks) and what they may change, so an agent
// can always move and finish a card it sees or added.
// scope: { wsIds: [workspace ids], memberIds: [pane ids] }
export function cardOnBoard(task, { wsIds = [], memberIds = [] } = {}) {
  if (!task) return false
  if (task.wsId && wsIds.includes(task.wsId)) return true
  return (!!task.paneId && memberIds.includes(task.paneId)) || (!!task.createdBy && memberIds.includes(task.createdBy))
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
  // A card deleted meanwhile stays deleted (see removeTask).
  tasks.splice(0, tasks.length, ...nextTasks.filter((t) => !(t && deleted.has(t.id))))
  return tasks
}
