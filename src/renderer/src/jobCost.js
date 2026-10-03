// Tokens, time and estimated cost per task card and per agent pane, as the
// main process counts them (window.shellApi.jobCost: forCards, forPanes,
// onChanged). Every surface that shows them (task board cards and total,
// Dashboard cards, pane header hover card, chat pane title) asks through
// useJobCost(): the ids wanted by all of them are fetched together, at most
// once per THROTTLE_MS, and again when the main process says something
// changed. Without the API (older main process, tests) nothing shows.
import { reactive, watch, getCurrentInstance, onBeforeUnmount } from 'vue'
import { formatCost } from '../../shared/modelPricing'
import { modelLabel } from '../../shared/modelLabel'
import { formatDuration } from './timeFormat'
import { t, intlLocale } from './i18n'

export const THROTTLE_MS = 1500

const KINDS = ['cards', 'panes']
// Fetched figures: { cards: { [cardId]: entry }, panes: { [paneId]: entry } }.
export const jobCostState = reactive({ cards: {}, panes: {} })
// Who wants which ids: id -> number of users.
const wanted = { cards: new Map(), panes: new Map() }

let timer = null
let lastRun = 0
let running = false
let again = false
let unsubChanged = null

function api() {
  try {
    const a = typeof window !== 'undefined' && window.shellApi ? window.shellApi.jobCost : null
    return a && typeof a === 'object' ? a : null
  } catch {
    return null
  }
}

function anyWanted() {
  return wanted.cards.size > 0 || wanted.panes.size > 0
}

// Ask again soon (throttled: never more than once per THROTTLE_MS).
export function refreshJobCost() {
  if (!anyWanted() || timer) return
  const wait = Math.max(0, lastRun + THROTTLE_MS - Date.now())
  timer = setTimeout(run, wait)
}

async function run() {
  timer = null
  if (running) {
    again = true
    return
  }
  const a = api()
  if (!a) return
  running = true
  lastRun = Date.now()
  try {
    for (const kind of KINDS) {
      const ids = [...wanted[kind].keys()]
      const fn = kind === 'cards' ? a.forCards : a.forPanes
      if (!ids.length || typeof fn !== 'function') continue
      let res = null
      try {
        res = await fn(ids)
      } catch {
        res = null
      }
      if (!res || typeof res !== 'object') continue
      const next = {}
      for (const id of ids) if (res[id]) next[id] = res[id]
      jobCostState[kind] = next
    }
  } finally {
    running = false
    if (again) {
      again = false
      refreshJobCost()
    }
  }
}

function listen() {
  if (unsubChanged) return
  const a = api()
  if (!a || typeof a.onChanged !== 'function') return
  try {
    const off = a.onChanged(() => refreshJobCost())
    unsubChanged = typeof off === 'function' ? off : () => {}
  } catch {
    unsubChanged = null
  }
}

function unlistenIfIdle() {
  if (anyWanted()) return
  if (unsubChanged) {
    try {
      unsubChanged()
    } catch {
      // Already gone.
    }
  }
  unsubChanged = null
  if (timer) clearTimeout(timer)
  timer = null
}

function retain(kind, ids) {
  let added = false
  for (const id of ids) {
    const n = wanted[kind].get(id) || 0
    if (!n) added = true
    wanted[kind].set(id, n + 1)
  }
  return added
}
function release(kind, ids) {
  for (const id of ids) {
    const n = wanted[kind].get(id) || 0
    if (n <= 1) wanted[kind].delete(id)
    else wanted[kind].set(id, n - 1)
  }
}

// In a component: keeps the ids getIds() returns fetched while it is
// mounted. Returns (id) => entry | null.
export function useJobCost(kind, getIds) {
  let held = []
  const stop = watch(
    () => (getIds() || []).filter(Boolean).map(String),
    (ids) => {
      const same = ids.length === held.length && ids.every((id, i) => id === held[i])
      if (same) return
      release(kind, held)
      held = ids
      retain(kind, ids)
      if (ids.length) {
        listen()
        refreshJobCost()
      } else unlistenIfIdle()
    },
    { immediate: true }
  )
  if (getCurrentInstance()) {
    onBeforeUnmount(() => {
      stop()
      release(kind, held)
      held = []
      unlistenIfIdle()
    })
  }
  return (id) => (id && jobCostState[kind][id]) || null
}

// For tests: forget everything.
export function resetJobCost() {
  for (const kind of KINDS) {
    wanted[kind].clear()
    jobCostState[kind] = {}
  }
  if (timer) clearTimeout(timer)
  timer = null
  lastRun = 0
  running = false
  again = false
  unsubChanged = null
}

// --- Formatting ---------------------------------------------------------------

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}

// The tokens a job used: what it read and wrote (cache reads and writes are
// in the details).
export function headlineTokens(e) {
  return e ? num(e.inputTokens) + num(e.outputTokens) : 0
}
function allTokens(e) {
  return e ? num(e.inputTokens) + num(e.outputTokens) + num(e.cacheReadTokens) + num(e.cacheWriteTokens) : 0
}

// A card still in Doing: its time goes on between two reads of the figures
// (they are read again only when its agent writes something). -> the entry
// with the card's time up to now, or the entry itself.
export function withLiveTime(entry, task, now = Date.now()) {
  if (!entry || !task || task.column !== 'doing' || !Array.isArray(task.workPeriods)) return entry
  let ms = 0
  for (const p of task.workPeriods) {
    if (!p || !Number.isFinite(p.start)) continue
    const end = Number.isFinite(p.end) ? p.end : now
    ms += Math.max(0, Math.min(end, now) - p.start)
  }
  return ms > num(entry.durationMs) ? { ...entry, durationMs: ms } : entry
}

export function hasUsage(e) {
  return !!e && (allTokens(e) > 0 || num(e.usd) > 0)
}

// 950 -> "950", 12 400 -> "12.4k" ("12,4k" in French), 3 200 000 -> "3.2M".
export function formatTokens(n, locale = intlLocale()) {
  const v = num(n)
  const fmt = (x, digits) => new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(x)
  if (v < 1000) return fmt(Math.round(v), 0)
  if (v < 1_000_000) {
    const k = v / 1000
    return k >= 999.95 ? `${fmt(v / 1_000_000, 1)}M` : `${fmt(k, k < 100 ? 1 : 0)}k` // i18n-ignore
  }
  const m = v / 1_000_000
  return `${fmt(m, m < 100 ? 1 : 0)}M` // i18n-ignore
}

// "~$0.31", "< $0.01", "cost unknown", or '' when there is no figure.
export function costText(e, locale = intlLocale()) {
  if (!e) return ''
  if (e.known === false) return t('jobCost.unknown', 'cost unknown')
  if (e.usd === null || e.usd === undefined) return ''
  const s = formatCost(e.usd, locale)
  if (!s || s === '—') return ''
  return s.startsWith('<') ? s : `~${s}` // i18n-ignore
}

function tokensWord(n, locale) {
  return t('jobCost.tokens', '{{n}} tokens', { n: formatTokens(n, locale) })
}

// "12.4k tokens · 6 min · ~$0.31" (compact: "12.4k · ~$0.31").
export function jobCostLine(e, { compact = false, locale = intlLocale() } = {}) {
  if (!hasUsage(e)) return ''
  const parts = []
  const tokens = headlineTokens(e)
  parts.push(compact ? formatTokens(tokens, locale) : tokensWord(tokens, locale))
  if (!compact && num(e.durationMs) > 0) parts.push(formatDuration(e.durationMs))
  const cost = costText(e, locale)
  if (cost) parts.push(cost)
  return parts.join(' · ')
}

// The tooltip: each kind of token, the model, and what the cost means.
// withSummary false: without the time and cost (shown beside it already).
export function jobCostDetails(e, locale = intlLocale(), { withSummary = true } = {}) {
  if (!hasUsage(e)) return ''
  const lines = [
    t('jobCost.detail.input', 'Input: {{n}}', { n: tokensWord(e.inputTokens, locale) }),
    t('jobCost.detail.output', 'Output: {{n}}', { n: tokensWord(e.outputTokens, locale) }),
    t('jobCost.detail.cacheRead', 'Cache read: {{n}}', { n: tokensWord(e.cacheReadTokens, locale) }),
    t('jobCost.detail.cacheWrite', 'Cache write: {{n}}', { n: tokensWord(e.cacheWriteTokens, locale) })
  ]
  if (withSummary && num(e.durationMs) > 0) lines.push(t('jobCost.detail.time', 'Time: {{time}}', { time: formatDuration(e.durationMs) }))
  if (e.model) lines.push(t('jobCost.detail.model', 'Model: {{model}}', { model: modelLabel(e.model) || e.model }))
  if (e.known === false) lines.push(t('jobCost.detail.unknown', 'No price known for this model: cost unknown'))
  else if (withSummary && e.usd !== null && e.usd !== undefined)
    lines.push(t('jobCost.detail.cost', 'Cost: {{cost}}', { cost: costText(e, locale) }))
  lines.push(t('jobCost.detail.estimate', 'API-equivalent estimate (subscriptions are not billed per token)'))
  return lines.join('\n')
}

// Sum of several entries (the board's total). known is false when any
// entry with usage had no price; usd sums the known ones.
export function sumJobCosts(entries) {
  const total = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, durationMs: 0, usd: null, known: true, count: 0, unknownCount: 0 }
  for (const e of entries || []) {
    if (!hasUsage(e)) continue
    total.count++
    total.inputTokens += num(e.inputTokens)
    total.outputTokens += num(e.outputTokens)
    total.cacheReadTokens += num(e.cacheReadTokens)
    total.cacheWriteTokens += num(e.cacheWriteTokens)
    total.durationMs += num(e.durationMs)
    if (e.known === false || e.usd === null || e.usd === undefined) {
      if (e.known === false) total.unknownCount++
    } else total.usd = (total.usd || 0) + Number(e.usd)
  }
  // Only unknown prices: the total cost is unknown too.
  if (total.usd === null && total.unknownCount) total.known = false
  return total
}
