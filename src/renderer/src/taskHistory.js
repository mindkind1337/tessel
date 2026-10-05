// The history of finished tasks (the side panel's Task history tab,
// TaskHistoryPanel.vue): one compact record per card that reached Done, kept
// with the board (task-board.json "history", taskBoardPersistence.js) so a
// card deleted from the board stays in its history. The main process also
// reads the records' work periods (src/main/jobCost.js), so the tokens and
// cost of a deleted card can still be counted; the figures last read are kept
// in the record (cost) for when the agent's session files are gone.
//
// A record: { id, title, wsId, paneId, agentName, agentKind, project,
//   createdAt, startedAt, doneAt, durationMs, workPeriods: [{ start, end,
//   paneId }], cost: { status, reason, inputTokens, outputTokens,
//   cacheReadTokens, cacheWriteTokens, usd, known, model, models: [...],
//   subagents, partial, at } | null }
// No IPC and no DOM here: App.vue loads and saves it with the board.
import { reactive, toRaw } from 'vue'

export const MAX_HISTORY = 2000
const MAX_PERIODS = 50
const MAX_MODELS = 6
// The figures of a task are final once read this long after it was done
// (its agent may still write the last turn's usage a moment later).
export const SETTLE_MS = 10 * 60 * 1000
const GIVE_UP_MS = 24 * 60 * 60 * 1000

// Oldest done first (the order they were finished).
export const taskHistory = reactive([])

// App.vue: card -> { agentName, agentKind, project } (who did it, where).
let describer = null
export function setHistoryDescriber(fn) {
  describer = typeof fn === 'function' ? fn : null
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v) => (typeof v === 'string' && v ? v : null)

// The card's periods in Doing, closed at doneAt (or now) when still open.
export function periodsOf(card, now = Date.now()) {
  if (!card) return []
  const close = num(card.doneAt) || num(card.columnSince) || now
  if (Array.isArray(card.workPeriods) && card.workPeriods.length) {
    return card.workPeriods
      .filter((p) => p && num(p.start))
      .slice(-MAX_PERIODS)
      .map((p) => ({ start: p.start, end: Math.max(p.start, num(p.end) ?? close), paneId: str(p.paneId) || str(card.paneId) }))
  }
  // A card from before the periods were kept: from its first entry in Doing.
  const start = num(card.startedAt)
  return start ? [{ start, end: Math.max(start, close), paneId: str(card.paneId) }] : []
}

export function workTime(periods) {
  return (periods || []).reduce((a, p) => a + Math.max(0, (num(p.end) ?? p.start) - p.start), 0)
}

function find(id) {
  return taskHistory.find((r) => r.id === id) || null
}

function describe(card) {
  let info = null
  try {
    info = describer ? describer(card) : null
  } catch {
    info = null
  }
  return info && typeof info === 'object' ? info : {}
}

// A card entered Done: its record, made or brought up to date (a card done
// again keeps the figures read before; they are read again).
export function recordDone(card, now = Date.now()) {
  if (!card || !str(card.id)) return null
  const before = find(card.id)
  const info = describe(card)
  const periods = periodsOf(card, now)
  const lastPane = periods.length ? periods[periods.length - 1].paneId : null
  const rec = {
    id: card.id,
    title: String(card.title || ''),
    wsId: str(card.wsId),
    paneId: str(card.paneId) || lastPane,
    agentName: str(info.agentName) || (before && before.agentName) || null,
    agentKind: str(info.agentKind) || (before && before.agentKind) || null,
    project: str(info.project) || (before && before.project) || null,
    createdAt: num(card.createdAt),
    startedAt: num(card.startedAt) || (periods.length ? periods[0].start : null),
    doneAt: num(card.doneAt) || now,
    durationMs: workTime(periods),
    workPeriods: periods,
    cost: before && before.cost ? { ...before.cost, final: false } : null
  }
  if (before) taskHistory.splice(taskHistory.indexOf(before), 1)
  taskHistory.push(rec)
  trim()
  return taskHistory[taskHistory.length - 1]
}

// A card taken back out of Done: it is not finished any more.
export function forgetDone(id) {
  const i = taskHistory.findIndex((r) => r.id === id)
  if (i === -1) return false
  taskHistory.splice(i, 1)
  return true
}

// A card renamed while done: the history shows its new title.
export function renameDone(id, title) {
  const r = find(id)
  if (r && typeof title === 'string' && title) r.title = title
}

function trim() {
  if (taskHistory.length > MAX_HISTORY) taskHistory.splice(0, taskHistory.length - MAX_HISTORY)
}

// Done cards with no record (finished before the history was kept, or
// in a board saved by an older version): recorded now. The ids already
// recorded are read once (looking each card up in the history through Vue's
// proxies, hundreds of cards by hundreds of records, slowed startup).
export function backfillHistory(cards, now = Date.now()) {
  let added = 0
  const known = new Set(toRaw(taskHistory).map((r) => r && r.id))
  for (const c of cards || []) {
    if (!c || c.column !== 'done' || known.has(c.id)) continue
    recordDone(c, now)
    known.add(c.id)
    added++
  }
  if (added) taskHistory.sort((a, b) => (a.doneAt || 0) - (b.doneAt || 0))
  return added
}

// --- Saved and loaded --------------------------------------------------------

function cleanCost(c) {
  if (!c || typeof c !== 'object') return null
  const n = (v) => Math.max(0, Math.round(num(v) || 0))
  const models = Array.isArray(c.models)
    ? c.models.slice(0, MAX_MODELS).map((m) => ({
        model: str(m && m.model),
        provider: str(m && m.provider),
        inputTokens: n(m && m.inputTokens),
        outputTokens: n(m && m.outputTokens),
        cacheReadTokens: n(m && m.cacheReadTokens),
        cacheWriteTokens: n(m && m.cacheWriteTokens),
        usd: num(m && m.usd),
        known: !!(m && m.known)
      }))
    : []
  const subagents = Array.isArray(c.subagents) ? c.subagents.length : num(c.subagents)
  return {
    status: c.status === 'ok' ? 'ok' : 'unavailable',
    reason: str(c.reason),
    inputTokens: n(c.inputTokens),
    outputTokens: n(c.outputTokens),
    cacheReadTokens: n(c.cacheReadTokens),
    cacheWriteTokens: n(c.cacheWriteTokens),
    usd: num(c.usd),
    known: c.known !== false,
    model: str(c.model),
    models,
    subagents: subagents || 0,
    ...(c.partial ? { partial: true } : {}),
    ...(c.incomplete ? { incomplete: true } : {}),
    final: !!c.final,
    at: num(c.at) || 0
  }
}

function cleanRecord(r) {
  if (!r || typeof r !== 'object' || !str(r.id)) return null
  const periods = Array.isArray(r.workPeriods)
    ? r.workPeriods
        .filter((p) => p && num(p.start))
        .slice(-MAX_PERIODS)
        .map((p) => ({ start: p.start, end: Math.max(p.start, num(p.end) ?? p.start), paneId: str(p.paneId) }))
    : []
  return {
    id: r.id,
    title: String(r.title || ''),
    wsId: str(r.wsId),
    paneId: str(r.paneId),
    agentName: str(r.agentName),
    agentKind: str(r.agentKind),
    project: str(r.project),
    createdAt: num(r.createdAt),
    startedAt: num(r.startedAt),
    doneAt: num(r.doneAt) || 0,
    durationMs: num(r.durationMs) ?? workTime(periods),
    workPeriods: periods,
    cost: cleanCost(r.cost)
  }
}

// The saved history (task-board.json "history"), in place.
export function setTaskHistory(list) {
  const seen = new Set()
  const out = []
  for (const r of Array.isArray(list) ? list : []) {
    const c = cleanRecord(r)
    if (!c || seen.has(c.id)) continue
    seen.add(c.id)
    out.push(c)
  }
  out.sort((a, b) => a.doneAt - b.doneAt)
  taskHistory.splice(0, taskHistory.length, ...out.slice(-MAX_HISTORY))
  return taskHistory
}

// --- Figures -------------------------------------------------------------------

// The figures read for a record (jobCost.forCards' entry), kept. An entry
// that could not be read does not replace figures read before (the session
// files may be gone since).
export function noteCost(id, entry, now = Date.now()) {
  const r = find(id)
  if (!r || !entry || typeof entry !== 'object') return false
  if (entry.status !== 'ok' && r.cost && r.cost.status === 'ok') {
    r.cost = { ...r.cost, at: now, final: r.cost.final || now - r.doneAt >= SETTLE_MS }
    return false
  }
  const c = cleanCost({ ...entry, at: now })
  // Not readable a day after it was done: it will not be any more.
  c.final = c.status === 'ok' ? !c.partial && now - r.doneAt >= SETTLE_MS : now - r.doneAt >= GIVE_UP_MS
  r.cost = c
  return true
}

// Should the figures be read (again)? Not yet read, or read before they
// were final.
export function needsCost(r) {
  if (!r) return false
  if (!r.cost) return true
  return !r.cost.final
}
