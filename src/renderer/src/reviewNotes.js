// Review notes on diff lines (after Orca's diff comments: store/slices/
// diffComments.ts, MIT, Copyright (c) 2026 Lovecast Inc.): kept per
// repository (the project or a task's copy), saved in this browser profile so
// they survive a restart, sent to an agent in one message, then cleared.
// A note: { id, repo, filePath (relative, /), startLine?, lineNumber, body,
// createdAt, updatedAt?, sentAt? }
import { reactive } from 'vue'

const KEY = 'tessel.reviewNotes.v1'
const MAX_NOTES = 2000

// repo key (lowercased Windows path) -> notes
export const notesByRepo = reactive({})

export const repoKey = (p) =>
  String(p || '')
    .replace(/[\\/]+/g, '\\')
    .replace(/\\+$/, '')
    .toLowerCase()

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}')
    if (!raw || typeof raw !== 'object') return
    for (const [k, list] of Object.entries(raw)) {
      if (!Array.isArray(list)) continue
      notesByRepo[k] = list.filter(
        (n) => n && typeof n.id === 'string' && typeof n.filePath === 'string' && Number.isInteger(n.lineNumber) && typeof n.body === 'string'
      )
    }
  } catch {
    /* nothing saved, or unreadable */
  }
}
function save() {
  try {
    const out = {}
    for (const [k, list] of Object.entries(notesByRepo)) if (list.length) out[k] = list
    localStorage.setItem(KEY, JSON.stringify(out))
  } catch {
    /* storage full or blocked: the notes stay for this session */
  }
}
load()

const EMPTY = Object.freeze([])
export function notesFor(repo) {
  return notesByRepo[repoKey(repo)] || EMPTY
}
export function notesForFile(repo, filePath) {
  return notesFor(repo).filter((n) => n.filePath === filePath)
}

let seq = 0
export function addNote({ repo, filePath, lineNumber, startLine, body }) {
  const text = String(body || '').trim()
  if (!repo || !filePath || !Number.isInteger(lineNumber) || !text) return null
  const k = repoKey(repo)
  if (!notesByRepo[k]) notesByRepo[k] = []
  if (notesByRepo[k].length >= MAX_NOTES) return null
  const note = {
    id: `n${Date.now().toString(36)}${(++seq).toString(36)}`,
    repo,
    filePath,
    lineNumber,
    ...(Number.isInteger(startLine) && startLine !== lineNumber ? { startLine: Math.min(startLine, lineNumber) } : {}),
    body: text.slice(0, 20000),
    createdAt: Date.now()
  }
  if (note.startLine !== undefined) note.lineNumber = Math.max(startLine, lineNumber)
  notesByRepo[k].push(note)
  save()
  return note
}

export function updateNote(repo, id, body) {
  const list = notesByRepo[repoKey(repo)]
  const n = list && list.find((x) => x.id === id)
  const text = String(body || '').trim()
  if (!n || !text) return false
  n.body = text.slice(0, 20000)
  n.updatedAt = Date.now()
  save()
  return true
}

export function deleteNote(repo, id) {
  const list = notesByRepo[repoKey(repo)]
  if (!list) return false
  const i = list.findIndex((x) => x.id === id)
  if (i < 0) return false
  list.splice(i, 1)
  save()
  return true
}

export function clearNotes(repo, filePath = null) {
  const k = repoKey(repo)
  const list = notesByRepo[k]
  if (!list) return 0
  const before = list.length
  notesByRepo[k] = filePath ? list.filter((n) => n.filePath !== filePath) : []
  save()
  return before - notesByRepo[k].length
}

// Delivered: the notes sent are removed, unless one was edited meanwhile
// (Orca's clearDeliveredDiffComments keeps a note that changed while sending).
export function clearDelivered(repo, sent) {
  const k = repoKey(repo)
  const list = notesByRepo[k]
  if (!list) return
  const snap = new Map((sent || []).map((n) => [n.id, n.body]))
  notesByRepo[k] = list.filter((n) => !(snap.has(n.id) && snap.get(n.id) === n.body))
  save()
}
