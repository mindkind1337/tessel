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
const BACKUP_EVERY_MS = 60 * 1000

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
// The deletions and the history of the board file as it is now. Each save
// needs them (a window may not send the history, deletions add up), and
// parsing the whole 3 MB file for them at each save was most of the save's
// cost: they are kept from the last load or save and used while the file is
// as it was left (same size and time); any other change reads the file again.
const parts = new Map() // file -> { size, mtimeMs, deleted, history }
function fileStamp(file) {
  try {
    const st = fs.statSync(file)
    return { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino }
  } catch {
    return null
  }
}
// The last parts read or written for a file, whatever the file's size and
// time: used when a read fails (never cached under the file's stamp).
const lastKnown = new Map()
function partsOf(data) {
  return { deleted: deletedOf(data), history: historyOf(data) }
}
// -> { deleted, history, ok }. ok: false when the file exists but neither it,
// its .bak nor an earlier read gave them (a file another program holds, a
// damaged one): the caller must not take "none" for the answer, and nothing
// failed is cached.
function savedParts(file) {
  const stamp = fileStamp(file)
  const known = parts.get(file)
  if (stamp && known && known.size === stamp.size && known.mtimeMs === stamp.mtimeMs && known.ino === stamp.ino) return { ...known, ok: true }
  if (!stamp) return { deleted: [], history: [], ok: true } // no file yet
  let out = null
  try {
    out = partsOf(JSON.parse(fs.readFileSync(file, 'utf8')))
    parts.set(file, { ...stamp, ...out })
    lastKnown.set(file, out)
    return { ...out, ok: true }
  } catch (err) {
    if (err.code === 'ENOENT') return { deleted: [], history: [], ok: true }
  }
  for (const source of [() => partsOf(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8'))), () => lastKnown.get(file)]) {
    try {
      const data = source()
      if (data) return { ...data, ok: true }
    } catch {
      /* next source */
    }
  }
  return { deleted: [], history: [], ok: false }
}
function rememberParts(file, deleted, history) {
  const stamp = fileStamp(file)
  if (stamp) parts.set(file, { ...stamp, deleted, history })
  lastKnown.set(file, { deleted, history })
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
    const saved = savedParts(file)
    // The saved history is needed (the window did not send it) and could not
    // be read: nothing is written, so it is not replaced by none. The window
    // sends it with its next save.
    if (!Array.isArray(history) && !saved.ok) {
      const err = new Error('The saved task history could not be read.') // i18n-ignore internal: the window sends it again
      err.code = 'EHISTORYUNREAD'
      throw err
    }
    const all = new Set(saved.deleted)
    for (const id of Array.isArray(deleted) ? deleted : []) {
      if (typeof id !== 'string' || !id) continue
      all.delete(id)
      all.add(id)
    }
    const kept = [...all].slice(-MAX_DELETED)
    // A window that does not send the history (an older one) keeps it.
    const hist = Array.isArray(history) ? historyOf({ history }) : saved.history
    data = {
      version: 2,
      tasks: withoutDeleted(tasks, kept),
      appliedRequests: appliedRequests.filter((k) => typeof k === 'string').slice(-5000),
      ...(kept.length ? { deleted: kept } : {}),
      ...(hist.length ? { history: hist } : {})
    }
  }
  // The board as an older version left it (indented, rewritten at every
  // save), kept once as it was before this one first changes it.
  const oldCopy = `${file}.before-compact`
  try {
    if (!fs.existsSync(oldCopy) && fs.existsSync(file)) fs.copyFileSync(file, oldCopy)
  } catch {
    /* the .bak below still holds the previous copy */
  }
  // Compact (a third smaller than indented), the .bak renewed at most once a
  // minute (it was a read, a parse and a write of the whole board at each
  // save), and nothing written when nothing changed.
  writeJsonSafe(file, data, isTaskList, { indent: 0, backupEveryMs: BACKUP_EVERY_MS, skipIfSame: true })
  if (!Array.isArray(data)) rememberParts(file, data.deleted || [], data.history || [])
  return file
}
