import { writeJsonSafe, readJsonSafe } from './safeJson'
import { join } from 'path'
import fs from 'fs'

// ---------------------------------------------------------------------------
// Task-board persistence
// ---------------------------------------------------------------------------
// The kanban task board is saved to userData as its own JSON file, kept fully
// separate from workspace-layout.json so the two features never clobber each
// other. We persist only the serializable task list (id, title, column,
// paneId) — the pane referenced by paneId is re-minted on restore, so dangling
// paneIds are reconciled at the App/integration layer, not here. This module is
// deliberately schema-agnostic: it round-trips whatever task array it is given,
// so it does not couple to the task model's exact field set.

export const TASK_BOARD_FILENAME = 'task-board.json'

/** Absolute path to the task-board file inside the given userData directory. */
export function taskBoardFilePath(userDataDir) {
  if (!userDataDir) throw new Error('taskBoardFilePath requires a userData directory')
  return join(userDataDir, TASK_BOARD_FILENAME)
}

/**
 * Load persisted tasks from the given userData directory.
 *
 * Returns [] when the file is absent or empty so the board always opens to a
 * valid state. Corrupt JSON throws on purpose: the caller (IPC handler) logs it
 * and falls back to [], keeping the failure visible rather than silent.
 *
 * @param {string} userDataDir
 * @returns {Array<object>}
 */
export function loadTasks(userDataDir) {
  const board = loadBoard(userDataDir)
  // Even the older list API must preserve this signal: its fallback cannot
  // be edited/saved while the latest board remains unread.
  return board.locked ? board : board.tasks
}

// The board with its ledger: appliedRequests, the agents' board requests
// (team tools) already applied, kept in the same file so they are saved
// atomically with the cards (see syncTeamBoard in App.vue).
// -> { tasks, appliedRequests }
export function loadBoard(userDataDir) {
  const file = taskBoardFilePath(userDataDir)

  // A damaged file (stopped mid-write by an older version, cut, unknown
  // shape) is kept aside as .corrupt-<time> and the previous good copy used.
  const res = readJsonSafe(file, isTaskList, { onLocked: 'backup' })
  if (res.locked) return {
    locked: true,
    tasks: Array.isArray(res.data) ? res.data : res.data?.tasks || [],
    appliedRequests: Array.isArray(res.data?.appliedRequests)
      ? res.data.appliedRequests.filter((k) => typeof k === 'string') : []
  }
  if (res.data) {
    if (Array.isArray(res.data)) return { tasks: res.data, appliedRequests: [] }
    const applied = Array.isArray(res.data.appliedRequests)
      ? res.data.appliedRequests.filter((k) => typeof k === 'string')
      : []
    return { tasks: res.data.tasks, appliedRequests: applied }
  }

  // No good copy at all: empty or an unknown shape opens an empty board;
  // damaged JSON throws so the caller logs it.
  const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  if (raw.trim()) JSON.parse(raw)
  return { tasks: [], appliedRequests: [] }
}

// A task array, or the forward-compatible { version, tasks: [...] } envelope.
function isTaskList(data) {
  return Array.isArray(data) || (!!data && Array.isArray(data.tasks))
}

/**
 * Persist the task list as pretty-printed JSON. Throws on non-array input so a
 * malformed save surfaces instead of silently dropping the board.
 *
 * @param {string} userDataDir
 * @param {Array<object>} tasks
 * @returns {string} the path written
 */
export function saveTasks(userDataDir, tasks, appliedRequests = null) {
  if (!Array.isArray(tasks)) throw new Error('saveTasks requires an array of tasks')
  const file = taskBoardFilePath(userDataDir)
  // Temp file + rename, previous copy kept as .bak: a kill mid-write never
  // leaves an empty or cut board. With a ledger: one file, one write.
  const data = Array.isArray(appliedRequests)
    ? { version: 2, tasks, appliedRequests: appliedRequests.filter((k) => typeof k === 'string').slice(-5000) }
    : tasks
  writeJsonSafe(file, data, isTaskList)
  return file
}
