// What the Task history tab (TaskHistoryPanel.vue) shows of the records
// (taskHistory.js): filters, sort, totals, the CSV export, and the figures
// read in batches through window.shellApi.jobCost.forCards (at most 100 ids
// a call; each record's figures are kept in it, read again only until final).
import { needsCost, noteCost } from './taskHistory'

export const PERIODS = ['today', '7d', '30d', 'all']
export const SORTS = ['date', 'cost', 'time']
const DAY = 24 * 60 * 60 * 1000
export const BATCH = 100
// A record's figures are asked for at most once per this while.
const RETRY_MS = 60 * 1000

const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

// When the period starts (local midnight for today), or 0 for all.
export function periodStart(period, now = Date.now()) {
  if (period === 'today') {
    const d = new Date(now)
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }
  if (period === '7d') return now - 7 * DAY
  if (period === '30d') return now - 30 * DAY
  return 0
}

// The agent a record is filed under: its pane's name, else its agent kind.
export function agentOf(r) {
  return (r && (r.agentName || r.agentKind)) || ''
}

// Filter: { period, project, agent, query } ('' or 'all' for any).
export function filterHistory(records, { period = 'all', project = '', agent = '', query = '' } = {}, now = Date.now()) {
  const from = periodStart(period, now)
  const q = String(query || '').trim().toLowerCase()
  return (records || []).filter(
    (r) =>
      (!from || (r.doneAt || 0) >= from) &&
      (!project || (r.project || '') === project) &&
      (!agent || agentOf(r) === agent) &&
      (!q || String(r.title || '').toLowerCase().includes(q))
  )
}

// Priced: the figures read, with a known cost.
export function pricedUsd(r) {
  const c = r && r.cost
  if (!c || c.status !== 'ok' || c.known === false || typeof c.usd !== 'number') return null
  return c.usd
}

// Newest first by default; by cost or time the largest first (records with
// no figure last).
export function sortHistory(records, by = 'date') {
  const key = by === 'cost' ? (r) => pricedUsd(r) ?? -1 : by === 'time' ? (r) => num(r.durationMs) : (r) => r.doneAt || 0
  return [...(records || [])].sort((a, b) => key(b) - key(a) || (b.doneAt || 0) - (a.doneAt || 0))
}

// Totals of a list: tasks, time, tokens (input + output; cache apart), the
// known cost, and how many have an unknown cost (not counted) or no
// figures yet.
export function historyTotals(records) {
  const t = { tasks: 0, durationMs: 0, tokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, usd: 0, priced: 0, unknown: 0, pending: 0 }
  for (const r of records || []) {
    t.tasks++
    t.durationMs += num(r.durationMs)
    const c = r.cost
    if (!c) {
      t.pending++
      continue
    }
    t.inputTokens += num(c.inputTokens)
    t.outputTokens += num(c.outputTokens)
    t.cacheReadTokens += num(c.cacheReadTokens)
    t.cacheWriteTokens += num(c.cacheWriteTokens)
    const usd = pricedUsd(r)
    if (usd === null) t.unknown++
    else {
      t.usd += usd
      t.priced++
    }
  }
  t.tokens = t.inputTokens + t.outputTokens
  return t
}

// The choices of the project and agent filters (sorted, no blanks).
export function filterOptions(records) {
  const projects = new Set()
  const agents = new Set()
  for (const r of records || []) {
    if (r.project) projects.add(r.project)
    const a = agentOf(r)
    if (a) agents.add(a)
  }
  const sort = (s) => [...s].sort((a, b) => a.localeCompare(b))
  return { projects: sort(projects), agents: sort(agents) }
}

// --- CSV ------------------------------------------------------------------------

function cell(v) {
  if (v === null || v === undefined) return ''
  const s = String(v)
  // A leading = + - @ would be read as a formula by a spreadsheet.
  const safe = /^[=+\-@]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

export function historyCsv(records) {
  const head = ['done_at', 'title', 'agent', 'agent_kind', 'project', 'time_seconds', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'usd_estimate', 'model', 'subagents'] // i18n-ignore
  const lines = [head.join(',')]
  for (const r of records || []) {
    const c = r.cost || {}
    const usd = pricedUsd(r)
    lines.push(
      [
        r.doneAt ? new Date(r.doneAt).toISOString() : '',
        r.title,
        r.agentName,
        r.agentKind,
        r.project,
        Math.round(num(r.durationMs) / 1000),
        r.cost ? num(c.inputTokens) : '',
        r.cost ? num(c.outputTokens) : '',
        r.cost ? num(c.cacheReadTokens) : '',
        r.cost ? num(c.cacheWriteTokens) : '',
        usd === null ? '' : usd.toFixed(4),
        c.model,
        r.cost ? c.subagents || 0 : ''
      ]
        .map(cell)
        .join(',')
    )
  }
  return lines.join('\r\n') + '\r\n'
}

// --- Figures, read in batches ------------------------------------------------------

const asked = new Map() // record id -> when its figures were last asked for

export function resetHistoryCostCache() {
  asked.clear()
}

// Reads the figures of the records that need them (newest first), BATCH ids
// a call, while isActive() (the tab is shown). -> the number of records read.
export async function loadHistoryCosts(records, { api, isActive = () => true, now = Date.now } = {}) {
  if (!api || typeof api.forCards !== 'function') return 0
  const t = now()
  const todo = (records || [])
    .filter((r) => needsCost(r) && !(asked.has(r.id) && t - asked.get(r.id) < RETRY_MS))
    .sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0))
    .map((r) => r.id)
  let read = 0
  for (let i = 0; i < todo.length; i += BATCH) {
    if (!isActive()) break
    const ids = todo.slice(i, i + BATCH)
    for (const id of ids) asked.set(id, now())
    let res = null
    try {
      res = await api.forCards(ids)
    } catch {
      res = null
    }
    if (!res || typeof res !== 'object') continue
    for (const id of ids) {
      if (res[id] && noteCost(id, res[id], now())) read++
    }
  }
  if (asked.size > 5000) for (const k of [...asked.keys()].slice(0, asked.size - 5000)) asked.delete(k)
  return read
}

// Records re-asked after a change notice: forget when they were asked.
export function forgetAsked(ids) {
  for (const id of ids || []) asked.delete(id)
}

// --- Rows drawn: only those in view ----------------------------------------------
// As the explorer does (explorerRows.js), but a row's height is not fixed: a
// row's line can wrap and an open row shows its details. Each drawn row is
// measured; the others count as the height measured for a closed row.
export const ROW_ESTIMATE = 44
export const VIRTUAL_MIN = 100
export const OVERSCAN = 8

// The top of each row (and the end of the last): length n + 1.
export function rowTops(ids, heightOf, estimate = ROW_ESTIMATE) {
  const n = (ids || []).length
  const tops = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) {
    const h = heightOf(ids[i])
    tops[i + 1] = tops[i] + (h > 0 ? h : estimate)
  }
  return tops
}

// The first row whose bottom is below y.
function rowAt(tops, y) {
  let lo = 0
  let hi = tops.length - 2
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (tops[mid + 1] > y) hi = mid
    else lo = mid + 1
  }
  return lo
}

// The rows in view (with OVERSCAN more each side): { start, end, before, after }
// (before and after: the heights of the rows not drawn).
export function visibleRange(tops, scrollTop, viewport, overscan = OVERSCAN) {
  const n = tops.length - 1
  if (n <= 0) return { start: 0, end: 0, before: 0, after: 0 }
  const top = Math.max(0, scrollTop || 0)
  const start = Math.max(0, rowAt(tops, top) - overscan)
  const end = Math.min(n, rowAt(tops, top + Math.max(0, viewport || 0)) + 1 + overscan)
  return { start, end, before: tops[start], after: tops[n] - tops[end] }
}
