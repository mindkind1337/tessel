// The conversations each terminal agent pane was in while this window runs,
// and the agent panes closed since, for the Conversations tab: what you and
// an agent said in an earlier conversation of its pane (before /clear, a new
// session) or in a pane closed since stays in your thread with it. Tessel
// keeps no history of a pane's conversations (its layout saves the current
// one only): this trail is kept in the window's storage, so a pane's earlier
// conversations (before an account switch, a restart into a new session)
// are still read after Tessel restarts. Bounded: the last 3 conversations of
// a pane, the last 12 panes closed.
// A conversation the pane did not really run (an id reported first, then
// corrected) is not kept as an earlier one: an id replaced is kept only when
// its file was read (confirmSession) or it stayed SETTLE_MS at least. A pane
// that became a chat is not closed: its conversation is the chat's now
// (Tessel records it), and its earlier ones are not read meanwhile.
import { reactive } from 'vue'

export const MAX_SESSIONS = 3
export const MAX_CLOSED = 12
export const SETTLE_MS = 2 * 60 * 1000

// paneId -> { paneId, wsId, title, agentId, accountId?, hostId, chat,
//   sessions: [{ id, since, confirmed }] (oldest first), closedAt }
export const paneSessionTrail = reactive({})

// Kept across restarts (ids, times and pane names only, no conversation).
const STORE = 'tessel.conversations.paneTrail' // i18n-ignore
const storage = () => {
  try {
    return globalThis.localStorage || null
  } catch {
    return null
  }
}
const validRow = (row) =>
  !!row && typeof row === 'object' && typeof row.paneId === 'string' && typeof row.agentId === 'string' && Array.isArray(row.sessions) && row.sessions.every((x) => x && typeof x.id === 'string' && Number.isFinite(x.since))
function restore() {
  try {
    const raw = storage() && storage().getItem(STORE)
    const rows = raw ? JSON.parse(raw) : null
    if (!rows || typeof rows !== 'object') return
    for (const row of Object.values(rows)) if (validRow(row)) paneSessionTrail[row.paneId] = { ...row, sessions: row.sessions.slice(-MAX_SESSIONS) }
  } catch {
    // nothing kept
  }
}
restore()
let saveTimer = 0
let saved = ''
function save(trail) {
  if (trail !== paneSessionTrail) return
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try {
      const s = storage()
      const text = JSON.stringify(paneSessionTrail)
      if (s && text !== saved) s.setItem(STORE, text)
      saved = text
    } catch {
      // kept for this run only
    }
  }, 1000)
}

// projects: App's sidebarProjects (each project's panes). A terminal agent in
// a conversation is noted; a pane no longer there, closed.
export function notePanes(projects, now = Date.now(), trail = paneSessionTrail) {
  const present = new Set()
  for (const p of projects || []) {
    for (const pane of (p && p.panes) || []) {
      if (!pane || !pane.id) continue
      present.add(pane.id)
      const had = trail[pane.id]
      if (
        pane.kind !== 'agent' ||
        !pane.agentId ||
        typeof pane.sessionId !== 'string' ||
        !pane.sessionId
      ) {
        // A chat now (or a bare shell): kept as it was, not read.
        if (had && !had.chat) trail[pane.id] = { ...had, chat: true }
        continue
      }
      // Another program in the pane: its earlier conversations were another agent's.
      let sessions = had && had.agentId === pane.agentId ? had.sessions.map((s) => ({ ...s })) : []
      const current = sessions[sessions.length - 1]
      if (!current || current.id !== pane.sessionId) {
        // The one it leaves: kept if it really ran.
        if (current && !current.confirmed && now - current.since < SETTLE_MS) sessions.pop()
        const back = sessions.find((s) => s.id === pane.sessionId)
        sessions = sessions.filter((s) => s.id !== pane.sessionId)
        sessions.push(back || { id: pane.sessionId, since: now, confirmed: false })
      }
      const row = {
        paneId: pane.id,
        wsId: p.id || null,
        title: pane.title || '',
        agentId: pane.agentId,
        ...(pane.accountId !== undefined ? { accountId: pane.accountId } : {}),
        hostId: pane.remoteHostId || null,
        chat: false,
        sessions: sessions.slice(-MAX_SESSIONS),
        closedAt: 0
      }
      // Written only when it changed (what reads it is not rebuilt for nothing).
      if (!had || JSON.stringify(had) !== JSON.stringify(row)) trail[pane.id] = row
    }
  }
  for (const [id, row] of Object.entries(trail))
    if (!present.has(id) && !row.closedAt) row.closedAt = now
  const closed = Object.values(trail)
    .filter((row) => row.closedAt)
    .sort((a, b) => b.closedAt - a.closedAt)
  for (const row of closed.slice(MAX_CLOSED)) delete trail[row.paneId]
  save(trail)
}

// The pane's conversation was read from its file: it really ran.
export function confirmSession(paneId, id, trail = paneSessionTrail) {
  const row = trail[paneId]
  const s = row && row.sessions.find((x) => x.id === id)
  if (s && !s.confirmed) {
    s.confirmed = true
    save(trail)
  }
}

// The ids of a pane's conversations, oldest first.
export const sessionIds = (row) =>
  row && Array.isArray(row.sessions) ? row.sessions.map((s) => s.id) : []

// Everything forgotten (tests).
export function clearPaneSessionTrail(trail = paneSessionTrail) {
  for (const id of Object.keys(trail)) delete trail[id]
  if (trail !== paneSessionTrail) return
  clearTimeout(saveTimer)
  try {
    const s = storage()
    if (s) s.removeItem(STORE)
  } catch {
    // nothing kept
  }
}

// What was kept is read again (tests: a restart).
export const restorePaneSessionTrail = restore
