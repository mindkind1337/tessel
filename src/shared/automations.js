// Scheduled automations: an agent task that runs on a schedule while Tessel is
// open. The schedule engine is Orca's (MIT, Copyright (c) 2026 Lovecast Inc.:
// src/shared/automation-schedule-parsing.ts, automation-cron-field-parsing.ts,
// automation-cron-occurrence.ts, automation-schedule-occurrences.ts,
// automation-schedules.ts, automation-run-retention.ts,
// src/main/automations/dispatch-refusal.ts), ported to plain JS: the same
// presets (hourly, daily, weekdays, weekly, custom five-field cron), stored as
// Orca stores them (an RRULE for a preset, the cron text for a custom one),
// the same missed-run grace and the same bounded run history.
//
// Tessel's differences: an automation runs in one of your projects (a
// workspace) with an agent that takes its first prompt on its command line
// (like orchestration workers: nothing is typed into its terminal), in its
// own copy of the project or in the project folder, and each run is a card on
// the board. Pure functions, shared by the main process (the scheduler,
// src/main/automations.js), the window and the tests.

import { WORKER_AGENTS } from './orchestration'

// Agents an automation can run: their CLI takes a first prompt on its
// command line (see automationLaunchArgs).
export const AUTOMATION_AGENTS = WORKER_AGENTS

export const SCHEDULE_PRESETS = ['hourly', 'daily', 'weekdays', 'weekly', 'custom']
// Orca's grace choices (minutes) and its default (12 hours).
export const GRACE_MINUTES = [0, 30, 60, 180, 720, 1440, 2880]
export const DEFAULT_GRACE_MINUTES = 720
export const ISOLATIONS = ['worktree', 'project']

// Orca's run statuses (those Tessel uses).
export const RUN_STATUSES = ['pending', 'dispatching', 'dispatched', 'completed', 'skipped_missed', 'skipped_unavailable', 'dispatch_failed']
export const FINAL_STATUSES = ['completed', 'skipped_missed', 'skipped_unavailable', 'dispatch_failed']
export const ACTIVE_STATUSES = ['dispatching', 'dispatched']
export function isFinalRunStatus(status) {
  return FINAL_STATUSES.includes(status)
}

// Bounds: Orca keeps 100 runs per automation (MAX_AUTOMATION_RUNS_PER_AUTOMATION).
export const MAX_RUNS_PER_AUTOMATION = 100
export const MAX_AUTOMATIONS = 100
export const MAX_NAME = 120
export const MAX_PROMPT = 20000
// How many runs go at once, all automations together (the others wait).
export const MAX_CONCURRENT_DEFAULT = 2
export const MAX_CONCURRENT_LIMIT = 8
// Orca's scheduler tick (DEFAULT_TICK_MS).
export const TICK_MS = 60 * 1000
// A run the window was asked to start and never answered for.
export const DISPATCH_TIMEOUT_MS = 3 * 60 * 1000
// A run whose agent never showed any sign of life in its pane.
export const AGENT_START_TIMEOUT_MS = 5 * 60 * 1000
// Panes still open, and copies of the project not merged or discarded yet,
// left by previous runs of one automation: past this, a run waits (skipped)
// until you close or review them, so a schedule never piles them up.
export const MAX_OPEN_PANES_PER_AUTOMATION = 3
export const MAX_COPIES_PER_AUTOMATION = 3

export function resolveMaxConcurrent(v) {
  return Number.isSafeInteger(v) && v >= 1 ? Math.min(MAX_CONCURRENT_LIMIT, v) : MAX_CONCURRENT_DEFAULT
}

// --- Cron fields (Orca's dialect: vixie/POSIX) -------------------------------------
// - `N/step` is the open-ended sequence `N-max/step`; a bare `N` is only itself.
// - A day field is restricted iff no term of it ranges over a star; when both
//   day fields are restricted the day matches on either, otherwise on both.
// - A step wider than the field's domain is refused as new input.
export const CRON_MAX_BYTES = 2 * 1024

const MONTH_NAMES = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 }
const DAY_NAMES = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 }

function parseCronNumber(value, names, field) {
  const normalized = value.toUpperCase()
  const named = names ? names[normalized] : undefined
  const parsed = named ?? Number(normalized)
  if (!Number.isInteger(parsed)) throw new Error(`Invalid cron ${field}.`)
  return parsed
}

function parseCronField({ value, min, max, field, names = null, normalize = null, distinctValueCount = null, rejectOversizedStep = false }) {
  const result = new Set()
  const norm = (v) => (normalize ? normalize(v) : v)
  for (const rawPart of value.split(',')) {
    const part = rawPart.trim()
    if (!part) throw new Error(`Invalid cron ${field}.`)
    const stepParts = part.split('/')
    if (stepParts.length > 2) throw new Error(`Invalid cron ${field}.`)
    const [rangePart, stepPart] = stepParts
    if (!rangePart) throw new Error(`Invalid cron ${field}.`)
    const step = stepPart === undefined ? 1 : Number(stepPart)
    if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid cron ${field}.`)
    const domainSize = distinctValueCount ?? max - min + 1
    if (rejectOversizedStep && step > domainSize) throw new Error(`Cron ${field} step must be between 1 and ${domainSize}.`)
    let start
    let end
    if (rangePart === '*') {
      start = min
      end = max
    } else if (rangePart.includes('-')) {
      const range = rangePart.split('-')
      if (range.length !== 2 || !range[0] || !range[1]) throw new Error(`Invalid cron ${field}.`)
      start = parseCronNumber(range[0], names, field)
      end = parseCronNumber(range[1], names, field)
    } else {
      start = parseCronNumber(rangePart, names, field)
      end = stepPart === undefined ? start : max
    }
    const ns = norm(start)
    const ne = norm(end)
    if (start < min || start > max || end < min || end > max || ns < min || ns > max || ne < min || ne > max || start > end)
      throw new Error(`Invalid cron ${field}.`)
    for (let v = start; v <= end; v += step) result.add(norm(v))
  }
  if (result.size === 0) throw new Error(`Invalid cron ${field}.`)
  return result
}

function isCronDayFieldRestricted(field) {
  return !field.split(',').some((term) => term.split('/')[0].trim() === '*')
}

export function cronFields(expression) {
  const s = String(expression || '')
  if (new TextEncoder().encode(s).length > CRON_MAX_BYTES) return []
  return s.trim().split(/\s+/).filter(Boolean)
}

export function parseCronExpression(expression, { rejectOversizedStep = false } = {}) {
  const parts = cronFields(expression)
  if (parts.length !== 5) throw new Error('Cron schedule must have five fields.')
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts
  return {
    kind: 'cron',
    minutes: parseCronField({ value: minute, min: 0, max: 59, field: 'minute', rejectOversizedStep }),
    hours: parseCronField({ value: hour, min: 0, max: 23, field: 'hour', rejectOversizedStep }),
    daysOfMonth: parseCronField({ value: dayOfMonth, min: 1, max: 31, field: 'day of month', rejectOversizedStep }),
    months: parseCronField({ value: month, min: 1, max: 12, field: 'month', names: MONTH_NAMES, rejectOversizedStep }),
    daysOfWeek: parseCronField({
      value: dayOfWeek,
      min: 0,
      max: 7,
      field: 'day of week',
      names: DAY_NAMES,
      normalize: (v) => (v === 7 ? 0 : v),
      distinctValueCount: 7,
      rejectOversizedStep
    }),
    dayOfMonthRestricted: isCronDayFieldRestricted(dayOfMonth),
    dayOfWeekRestricted: isCronDayFieldRestricted(dayOfWeek)
  }
}

// --- RRULE presets ------------------------------------------------------------------
const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']
const WEEKDAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR']

function parseRrule(rrule) {
  const entries = new Map()
  for (const part of rrule.split(';')) {
    const [key, value] = part.split('=')
    if (key && value) entries.set(key.toUpperCase(), value)
  }
  const freq = entries.get('FREQ')
  if (freq !== 'HOURLY' && freq !== 'DAILY' && freq !== 'WEEKLY') throw new Error('Unsupported automation recurrence.')
  const byHour = Number(entries.get('BYHOUR') ?? '9')
  const byMinute = Number(entries.get('BYMINUTE') ?? '0')
  if (!Number.isInteger(byHour) || byHour < 0 || byHour > 23) throw new Error('Invalid recurrence hour.')
  if (!Number.isInteger(byMinute) || byMinute < 0 || byMinute > 59) throw new Error('Invalid recurrence minute.')
  const byDay = (entries.get('BYDAY') ?? '').split(',').filter(Boolean)
  if (freq === 'WEEKLY' && (byDay.length === 0 || byDay.some((d) => !DAY_CODES.includes(d)))) throw new Error('Invalid recurrence day.')
  return { kind: 'rrule', freq, byDay, byHour, byMinute }
}

export function parseSchedule(schedule, options = {}) {
  const trimmed = String(schedule || '').trim()
  if (trimmed.includes('=')) return parseRrule(trimmed)
  return parseCronExpression(trimmed, options)
}

// { preset, hour, minute, dayOfWeek } of a preset RRULE (throws otherwise).
export function parseAutomationRrule(rrule) {
  const rule = parseRrule(rrule)
  if (rule.freq === 'HOURLY') return { preset: 'hourly', hour: rule.byHour, minute: rule.byMinute, dayOfWeek: 1 }
  if (rule.freq === 'DAILY') return { preset: 'daily', hour: rule.byHour, minute: rule.byMinute, dayOfWeek: 1 }
  if (rule.byDay.join(',') === WEEKDAY_CODES.join(',')) return { preset: 'weekdays', hour: rule.byHour, minute: rule.byMinute, dayOfWeek: 1 }
  if (rule.byDay.length !== 1) throw new Error('Invalid recurrence day.')
  const dayOfWeek = DAY_CODES.indexOf(rule.byDay[0])
  if (dayOfWeek === -1) throw new Error('Invalid recurrence day.')
  return { preset: 'weekly', hour: rule.byHour, minute: rule.byMinute, dayOfWeek }
}

const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.floor(Number(v) || 0)))

export function buildAutomationRrule({ preset, hour, minute, dayOfWeek = 1 }) {
  const h = clampInt(hour, 0, 23)
  const m = clampInt(minute, 0, 59)
  if (preset === 'hourly') return `FREQ=HOURLY;BYMINUTE=${m}`
  if (preset === 'weekdays') return `FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=${h};BYMINUTE=${m}`
  if (preset === 'weekly') return `FREQ=WEEKLY;BYDAY=${DAY_CODES[clampInt(dayOfWeek, 0, 6)]};BYHOUR=${h};BYMINUTE=${m}`
  return `FREQ=DAILY;BYHOUR=${h};BYMINUTE=${m}`
}

export function buildAutomationCronSchedule({ preset, hour, minute, dayOfWeek = 1 }) {
  const h = clampInt(hour, 0, 23)
  const m = clampInt(minute, 0, 59)
  if (preset === 'hourly') return `${m} * * * *`
  if (preset === 'weekdays') return `${m} ${h} * * 1-5`
  if (preset === 'weekly') return `${m} ${h} * * ${clampInt(dayOfWeek, 0, 6)}`
  return `${m} ${h} * * *`
}

// --- Occurrences --------------------------------------------------------------------
const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000
const MINUTE_MS = 60 * 1000
// A valid cron like Feb 29 can have an 8-year gap across non-leap centuries.
const CRON_SCAN_DAYS = 9 * 366

function startOfLocalDay(ts) {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
// In real time: setting local fields inside an hour repeated when clocks go
// back would jump to its first copy.
function floorToMinute(ts) {
  return Math.floor(ts / 60000) * 60000
}
function atLocalTime(dayMs, hour, minute) {
  const d = new Date(dayMs)
  d.setHours(hour, minute, 0, 0)
  return d.getTime()
}
function cronDateMatches(rule, ts) {
  const d = new Date(ts)
  if (!rule.months.has(d.getMonth() + 1)) return false
  const dom = rule.daysOfMonth.has(d.getDate())
  const dow = rule.daysOfWeek.has(d.getDay())
  if (rule.dayOfMonthRestricted && rule.dayOfWeekRestricted) return dom || dow
  return dom && dow
}
function cronHasPossibleOccurrence(rule, anchor) {
  let day = startOfLocalDay(anchor)
  for (let i = 0; i < CRON_SCAN_DAYS; i++) {
    if (cronDateMatches(rule, day)) return true
    day += DAY_MS
  }
  return false
}

// Days are walked by calendar date (DST-safe), then the times are set. A
// time that does not exist that day (the hour skipped when clocks go
// forward, e.g. 02:30) runs at the same wall-clock time an hour later
// (03:30), as the RRULE presets do; a repeated hour (clocks back) runs once.
function cronDayTimes(rule, day) {
  const out = new Set()
  const everyHour = rule.hours.size === 24
  for (const h of rule.hours)
    for (const m of rule.minutes) {
      const c = atLocalTime(day, h, m)
      out.add(c)
      // Clocks going back repeat an hour: a schedule that runs every hour
      // runs in both (a daily time runs once).
      if (everyHour) {
        const again = new Date(c + HOUR_MS)
        if (again.getHours() === h && again.getMinutes() === m) out.add(c + HOUR_MS)
      }
    }
  return [...out].sort((a, b) => a - b)
}
function nextCronMatch(rule, from) {
  let day = startOfLocalDay(from)
  for (let i = 0; i < CRON_SCAN_DAYS; i++) {
    if (cronDateMatches(rule, day)) {
      const c = cronDayTimes(rule, day).find((x) => x >= from)
      if (c !== undefined) return c
    }
    const d = new Date(day)
    d.setDate(d.getDate() + 1)
    day = d.getTime()
  }
  return null
}
function prevCronMatch(rule, at, floor) {
  let day = startOfLocalDay(at)
  for (let i = 0; i < CRON_SCAN_DAYS && day + DAY_MS > floor; i++) {
    if (cronDateMatches(rule, day)) {
      const times = cronDayTimes(rule, day).filter((x) => x <= at && x >= floor)
      if (times.length) return times[times.length - 1]
    }
    const d = new Date(day)
    d.setDate(d.getDate() - 1)
    day = d.getTime()
  }
  return null
}

// The shortest time between two runs (minutes) over the next 8 days, to
// refuse a schedule that would open a pane (and a copy) every few minutes.
export const MIN_INTERVAL_MINUTES = 15
export function minIntervalMinutes(schedule, from = Date.now()) {
  let prev = null
  let min = Infinity
  let at = from
  const end = from + 8 * DAY_MS
  for (let i = 0; i < 800 && at < end; i++) {
    let next
    try {
      next = nextOccurrenceAfter(schedule, from, at)
    } catch {
      break
    }
    if (prev !== null) min = Math.min(min, (next - prev) / MINUTE_MS)
    prev = next
    at = next
  }
  return min
}

// Hourly runs follow real time, minute by minute: when clocks go back the
// repeated hour runs too (01:00 EDT and 01:00 EST are two hours), and when
// they go forward nothing is lost (the minute still comes each hour).
function nextHourly(minute, from) {
  let c = Math.floor(from / MINUTE_MS) * MINUTE_MS + MINUTE_MS
  for (let i = 0; i <= 24 * 60; i++, c += MINUTE_MS) if (new Date(c).getMinutes() === minute) return c
  throw new Error('Unable to compute next automation run.')
}
function prevHourly(minute, at) {
  let c = Math.floor(at / MINUTE_MS) * MINUTE_MS
  for (let i = 0; i <= 24 * 60; i++, c -= MINUTE_MS) if (new Date(c).getMinutes() === minute) return c
  return null
}

function dayMatches(rule, ts) {
  if (rule.freq === 'DAILY') return true
  return rule.byDay.includes(DAY_CODES[new Date(ts).getDay()])
}
function scanDayCandidates(rule, anchor, direction) {
  let day = startOfLocalDay(anchor)
  for (let i = 0; i < 370; i++) {
    const c = atLocalTime(day, rule.byHour, rule.byMinute)
    if (dayMatches(rule, c)) {
      if (direction === 1 && c > anchor) return c
      if (direction === -1 && c <= anchor) return c
    }
    const d = new Date(day)
    d.setDate(d.getDate() + direction)
    day = d.getTime()
  }
  return null
}

// The first occurrence strictly after `after` (and not before dtstart).
export function nextOccurrenceAfter(schedule, dtstart, after) {
  const rule = parseSchedule(schedule)
  if (rule.kind === 'cron') {
    let from = floorToMinute(Math.max(dtstart, after))
    if (from <= after) from += MINUTE_MS
    if (from < dtstart) from = floorToMinute(dtstart) + (floorToMinute(dtstart) < dtstart ? MINUTE_MS : 0)
    const c = nextCronMatch(rule, from)
    if (c === null) throw new Error('Unable to compute next automation run.')
    return c
  }
  if (rule.freq === 'HOURLY') return nextHourly(rule.byMinute, Math.max(after, dtstart - 1))
  const c = scanDayCandidates(rule, Math.max(dtstart - 1, after), 1)
  if (c === null) throw new Error('Unable to compute next automation run.')
  return c
}

// The latest occurrence at or before `now` (not before dtstart), or null.
export function latestOccurrenceAtOrBefore(schedule, dtstart, now) {
  if (now < dtstart) return null
  const rule = parseSchedule(schedule)
  if (rule.kind === 'cron') return prevCronMatch(rule, floorToMinute(now), dtstart)
  if (rule.freq === 'HOURLY') {
    const c = prevHourly(rule.byMinute, now)
    return c !== null && c >= dtstart ? c : null
  }
  const c = scanDayCandidates(rule, now, -1)
  return c !== null && c >= dtstart ? c : null
}

// A schedule taken as new input (an oversized cron step is refused, #15895).
export function isValidSchedule(schedule) {
  try {
    const parsed = parseSchedule(schedule, { rejectOversizedStep: true })
    return parsed.kind !== 'cron' || cronHasPossibleOccurrence(parsed, Date.now())
  } catch {
    return false
  }
}

// --- Labels (locale-free: the window words them) ---------------------------------------
function single(set) {
  return set.size === 1 ? set.values().next().value : null
}
function containsRange(set, lo, hi) {
  if (set.size !== hi - lo + 1) return false
  for (let v = lo; v <= hi; v++) if (!set.has(v)) return false
  return true
}
function containsExactly(set, list) {
  return set.size === list.length && list.every((v) => set.has(v))
}

// -> { kind: 'hourly', minute } | { kind: 'daily'|'weekdays', hour, minute }
//    | { kind: 'weekly', hour, minute, dayOfWeek } | { kind: 'custom' } | { kind: 'invalid' }
export function describeSchedule(schedule) {
  try {
    const parsed = parseSchedule(schedule)
    if (parsed.kind === 'rrule') {
      const r = parseAutomationRrule(String(schedule).trim())
      if (r.preset === 'hourly') return { kind: 'hourly', minute: r.minute }
      if (r.preset === 'weekly') return { kind: 'weekly', hour: r.hour, minute: r.minute, dayOfWeek: r.dayOfWeek }
      return { kind: r.preset, hour: r.hour, minute: r.minute }
    }
    const rule = parsed
    if (!cronHasPossibleOccurrence(rule, Date.now())) return { kind: 'invalid' }
    const minute = single(rule.minutes)
    const hour = single(rule.hours)
    const allMonths = containsRange(rule.months, 1, 12)
    const everyDom = containsRange(rule.daysOfMonth, 1, 31)
    const everyDow = containsRange(rule.daysOfWeek, 0, 6)
    const either = rule.dayOfMonthRestricted && rule.dayOfWeekRestricted
    const everyDay = either ? everyDom || everyDow : everyDom && everyDow
    if (minute !== null && containsRange(rule.hours, 0, 23) && allMonths && everyDay) return { kind: 'hourly', minute }
    if (minute !== null && hour !== null && allMonths && everyDay) return { kind: 'daily', hour, minute }
    if (minute !== null && hour !== null && everyDom && allMonths && !either) {
      if (containsExactly(rule.daysOfWeek, [1, 2, 3, 4, 5])) return { kind: 'weekdays', hour, minute }
      const dow = single(rule.daysOfWeek)
      if (dow !== null) return { kind: 'weekly', hour, minute, dayOfWeek: dow }
    }
    return { kind: 'custom' }
  } catch {
    return { kind: 'invalid' }
  }
}

// The editor's schedule fields <-> the stored expression (Orca's draft model).
export function scheduleToDraft(schedule) {
  const s = String(schedule || '').trim()
  const pad = (n) => String(n).padStart(2, '0')
  if (s.includes('=')) {
    try {
      const r = parseAutomationRrule(s)
      return { preset: r.preset, time: `${pad(r.hour)}:${pad(r.minute)}`, dayOfWeek: r.dayOfWeek, custom: '' }
    } catch {
      return { preset: 'custom', time: '09:00', dayOfWeek: 1, custom: '' }
    }
  }
  return { preset: 'custom', time: '09:00', dayOfWeek: 1, custom: s }
}
export function draftToSchedule(draft) {
  if (!draft) return ''
  if (draft.preset === 'custom') return String(draft.custom || '').trim()
  const [h, m] = String(draft.time || '09:00').split(':').map((x) => Number(x))
  return buildAutomationRrule({ preset: draft.preset, hour: h, minute: m, dayOfWeek: draft.dayOfWeek })
}

// --- Missed runs (Orca's dispatch-refusal.ts) ------------------------------------------
// Grace is a downtime catch-up budget: an occurrence found later than grace
// plus two ticks (one for the tick that should have caught it, one for
// jitter) is skipped; within it, one missed occurrence runs.
export function missedBeyondGrace({ graceMinutes, scheduledFor, now, tickMs = TICK_MS }) {
  const graceMs = (Number(graceMinutes) || 0) * 60 * 1000
  return now - scheduledFor > graceMs + tickMs * 2
}

// --- Run history (Orca's automation-run-retention.ts) --------------------------------
// Only final runs are evicted (a running one still gets its result); the
// newest `max` final runs of each automation are kept, in their order.
export function pruneRuns(runs, max = MAX_RUNS_PER_AUTOMATION) {
  const kept = new Set()
  const byAutomation = new Map()
  for (const r of runs) {
    if (!isFinalRunStatus(r.status)) continue
    if (!byAutomation.has(r.automationId)) byAutomation.set(r.automationId, [])
    byAutomation.get(r.automationId).push(r)
  }
  for (const list of byAutomation.values()) {
    list.sort((a, b) => b.createdAt - a.createdAt || b.scheduledFor - a.scheduledFor)
    for (const r of list.slice(0, Math.max(0, max))) kept.add(r.id)
  }
  return runs.filter((r) => kept.has(r.id) || !isFinalRunStatus(r.status))
}

export function nextRunNumber(runsOfAutomation) {
  return runsOfAutomation.reduce((n, r) => Math.max(n, r.runNumber || 0), 0) + 1
}

// --- Validation of an automation from the window -------------------------------------
const ID = /^[A-Za-z0-9._-]{1,100}$/
const FLAG = /^[A-Za-z0-9._:[\]-]{1,60}$/

// -> { value } (the fields to store) or { error: code }.
export function normalizeAutomationInput(input) {
  if (!input || typeof input !== 'object') return { error: 'invalid' }
  const name = typeof input.name === 'string' ? input.name.replace(/\s+/g, ' ').trim() : ''
  if (!name) return { error: 'name-required' }
  if (name.length > MAX_NAME) return { error: 'name-too-long' }
  const prompt = typeof input.prompt === 'string' ? input.prompt.replace(/\r\n?/g, '\n').trim() : ''
  if (!prompt) return { error: 'prompt-required' }
  if (prompt.length > MAX_PROMPT) return { error: 'prompt-too-long' }
  const agentId = String(input.agentId || '')
  if (!AUTOMATION_AGENTS.includes(agentId)) return { error: 'agent-invalid' }
  const model = typeof input.model === 'string' && FLAG.test(input.model.trim()) ? input.model.trim() : null
  const effort = model && typeof input.effort === 'string' && FLAG.test(input.effort.trim()) ? input.effort.trim() : null
  const wsId = typeof input.wsId === 'string' && ID.test(input.wsId) ? input.wsId : null
  if (!wsId) return { error: 'project-required' }
  const projectName = typeof input.projectName === 'string' ? input.projectName.slice(0, 200) : ''
  const projectCwd = typeof input.projectCwd === 'string' && input.projectCwd.length <= 1000 ? input.projectCwd : null
  let remote = null
  if (input.remote && typeof input.remote === 'object') {
    const hostId = typeof input.remote.hostId === 'string' && ID.test(input.remote.hostId) ? input.remote.hostId : null
    const path = typeof input.remote.path === 'string' && input.remote.path.length <= 1024 ? input.remote.path : null
    if (!hostId || !path) return { error: 'project-required' }
    remote = { hostId, path }
  }
  if (!remote && !projectCwd) return { error: 'project-required' }
  const isolation = ISOLATIONS.includes(input.isolation) ? input.isolation : 'worktree'
  if (remote && isolation === 'worktree') return { error: 'remote-worktree' }
  const schedule = typeof input.schedule === 'string' ? input.schedule.trim() : ''
  if (!isValidSchedule(schedule)) return { error: 'schedule-invalid' }
  if (minIntervalMinutes(schedule) < MIN_INTERVAL_MINUTES) return { error: 'schedule-too-frequent' }
  const grace = Number(input.missedRunGraceMinutes)
  const missedRunGraceMinutes = GRACE_MINUTES.includes(grace) ? grace : DEFAULT_GRACE_MINUTES
  const after = input.after && typeof input.after === 'object' ? input.after : {}
  return {
    value: {
      name,
      prompt,
      agentId,
      model,
      effort,
      wsId,
      projectName,
      projectCwd: remote ? null : projectCwd,
      remote,
      isolation,
      schedule,
      missedRunGraceMinutes,
      after: { notify: after.notify !== false, closePane: after.closePane === true }
    }
  }
}

// --- The agent's command line -------------------------------------------------------
// The first prompt of a run: fixed words and the path of the file that
// holds the automation's prompt (written by the main process for each run),
// never the prompt itself. The path goes between double quotes, so only
// characters that no shell (PowerShell, cmd, Git Bash, WSL, and on a remote
// host sh, bash, zsh, fish, tcsh) and no .cmd launcher reads as special
// inside double quotes are taken: letters and digits of any language, space,
// . _ - ' ( ) and the folder separators. Anything else ($ ` " % ! & ; ...)
// is refused, never quoted by guesswork.
const WIN_PATH = /^[A-Za-z]:\\[\p{L}\p{N} ._'()\\-]{1,400}$/u
const WSL_PATH = /^\/mnt\/[a-z]\/[\p{L}\p{N} ._'()/-]{1,400}$/u
// A remote project's prompt file, relative to its folder (the terminal
// starts there): always this shape, Tessel's own ids only.
export const REMOTE_PROMPT_DIR = '.tessel/automations'
const REMOTE_FILE = /^\.tessel\/automations\/auto-[A-Za-z0-9-]{1,80}\.md$/

export function remotePromptFile(automationId) {
  return `${REMOTE_PROMPT_DIR}/${automationId}.md`
}

export function wslPath(winPath) {
  const m = /^([A-Za-z]):\\(.*)$/.exec(String(winPath || ''))
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}` : null
}

export function automationStartPrompt(file) {
  // Sent to the agent: stays English.
  return `Tessel automation run. Read the file ${file} and carry out the task it describes.` // i18n-ignore
}

// The arguments a run adds after the agent's command: ' arg arg', or '' when
// it cannot be given safely.
//   agentId; { promptFile, promptDir } (this computer) or { remoteFile }
//   (a remote project: the file in its folder, see remotePromptFile);
//   shellId: the pane's shell ('wsl' reads /mnt/<drive>/ paths).
export function automationLaunchArgs(agentId, { promptFile = null, promptDir = null, remoteFile = null, shellId = null } = {}) {
  if (!AUTOMATION_AGENTS.includes(agentId)) return ''
  if (remoteFile != null) {
    if (!REMOTE_FILE.test(String(remoteFile))) return ''
    const prompt = `"${automationStartPrompt(remoteFile)}"`
    // In the project folder: every agent reads it without more flags.
    return agentId === 'gemini' || agentId === 'qwen' ? ` -i ${prompt}` : ` ${prompt}`
  }
  let file = promptFile
  let dir = promptDir
  if (shellId === 'wsl') {
    file = wslPath(file)
    dir = wslPath(dir)
    if (!file || !dir || !WSL_PATH.test(file) || !WSL_PATH.test(dir)) return ''
  } else if (!file || !dir || !WIN_PATH.test(file) || !WIN_PATH.test(dir)) return ''
  const prompt = `"${automationStartPrompt(file)}"`
  // Claude Code reads the file without asking once its folder is added
  // (--add-dir takes several folders: it goes after the prompt); Gemini CLI
  // and Qwen Code with --include-directories; Codex reads files anywhere.
  if (agentId === 'claude') return ` ${prompt} --add-dir "${dir}"`
  if (agentId === 'gemini' || agentId === 'qwen') return ` --include-directories "${dir}" -i ${prompt}`
  return ` ${prompt}`
}

// Launch flags typed into a remote login shell (bash, zsh, fish, tcsh...):
// a token with glob characters (a model like opus[1m]) goes between double
// quotes, where none of the characters flags can hold is special; zsh would
// otherwise stop with "no matches found".
export function quoteGlobArgs(text) {
  return String(text || '').replace(/(^|\s)([^\s"']*[[\]*?{}][^\s"']*)/g, (m, sp, tok) => (/^[A-Za-z0-9._:/@[\]=+*?{}-]+$/.test(tok) ? `${sp}"${tok}"` : m))
}

// What you confirmed an automation may run with: a short fingerprint of its
// agent's launch settings (command, arguments with the Yolo flag, variable
// names and values) from launchSignature (agentPrefs.js). Only the
// fingerprint is stored, never the values. A run whose fingerprint differs
// waits for a new confirmation.
export function permissionFingerprint(signature) {
  let h = 0x811c9dc5
  const s = String(signature || '')
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `p1:${h.toString(16).padStart(8, '0')}:${s.length}`
}
