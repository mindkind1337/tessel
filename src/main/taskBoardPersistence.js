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
  if (res.locked) {
    const deleted = deletedOf(res.data)
    return {
      locked: true,
      tasks: withoutDeleted(Array.isArray(res.data) ? res.data : res.data?.tasks || [], deleted),
      appliedRequests: Array.isArray(res.data?.appliedRequests)
        ? res.data.appliedRequests.filter((k) => typeof k === 'string') : [],
      deleted,
      history: historyOf(res.data)
    }
  }
  if (res.data) {
    if (Array.isArray(res.data)) return { tasks: res.data, appliedRequests: [], deleted: [], history: [] }
    const applied = Array.isArray(res.data.appliedRequests)
      ? res.data.appliedRequests.filter((k) => typeof k === 'string')
      : []
    const deleted = deletedOf(res.data)
    return { tasks: withoutDeleted(res.data.tasks, deleted), appliedRequests: applied, deleted, history: historyOf(res.data) }
  }

  // No good copy at all: empty or an unknown shape opens an empty board;
  // damaged JSON throws so the caller logs it.
  const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  if (raw.trim()) JSON.parse(raw)
  return { tasks: [], appliedRequests: [], deleted: [], history: [] }
}

// The finished tasks' history (renderer taskHistory.js): records kept even
// after their card is deleted, oldest first, at most MAX_HISTORY.
const MAX_HISTORY = 2000
function historyOf(data) {
  return data && !Array.isArray(data) && Array.isArray(data.history)
    ? data.history.filter((r) => r && typeof r === 'object' && typeof r.id === 'string' && r.id).slice(-MAX_HISTORY)
    : []
}
function savedHistory(file) {
  try {
    return historyOf(JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch {
    return []
  }
}

// The ids of the cards deleted from the board (the version 2 envelope's
// "deleted"): such a card is never read back nor written again, whatever
// copy of the board a window saves (one from before the deletion included).
const MAX_DELETED = 5000
function deletedOf(data) {
  return data && !Array.isArray(data) && Array.isArray(data.deleted) ? data.deleted.filter((k) => typeof k === 'string' && k) : []
}
function withoutDeleted(tasks, deleted) {
  if (!deleted.length) return tasks
  const gone = new Set(deleted)
  return tasks.filter((t) => !(t && gone.has(t.id)))
}

// The deletions already saved (best effort: a file that cannot be read now
// adds none; the window's own list still goes in).
function savedDeleted(file) {
  try {
    return deletedOf(JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch {
    return []
  }
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
export function saveTasks(userDataDir, tasks, appliedRequests = null, deleted = null, history = null) {
  if (!Array.isArray(tasks)) throw new Error('saveTasks requires an array of tasks')
  const file = taskBoardFilePath(userDataDir)
  // Temp file + rename, previous copy kept as .bak: a kill mid-write never
  // leaves an empty or cut board. With a ledger: one file, one write.
  let data = tasks
  if (Array.isArray(appliedRequests)) {
    // Deletions add up: those already saved (by this window or another one)
    // and this save's. A card in that list is left out, so a copy of the
    // board from before its deletion cannot write it back.
    const all = new Set(savedDeleted(file))
    for (const id of Array.isArray(deleted) ? deleted : []) {
      if (typeof id !== 'string' || !id) continue
      all.delete(id)
      all.add(id)
    }
    const kept = [...all].slice(-MAX_DELETED)
    // A window that does not send the history (an older one) keeps it.
    const hist = Array.isArray(history) ? historyOf({ history }) : savedHistory(file)
    data = {
      version: 2,
      tasks: withoutDeleted(tasks, kept),
      appliedRequests: appliedRequests.filter((k) => typeof k === 'string').slice(-5000),
      ...(kept.length ? { deleted: kept } : {}),
      ...(hist.length ? { history: hist } : {})
    }
  }
  writeJsonSafe(file, data, isTaskList)
  return file
}
