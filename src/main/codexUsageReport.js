// Local Codex usage, not a bill or a live account quota. token_count semantics
// and fork deduplication informed by stablyai/orca (MIT, Lovecast Inc., 2026),
// src/main/codex-usage, and verified against openai/codex core/src/session/mod.rs.
// Implementation is independent; no OAuth tokens, API calls or price guesses.
// References: https://github.com/stablyai/orca/tree/main/src/main/codex-usage
// https://github.com/openai/codex/blob/main/codex-rs/core/src/session/mod.rs
import os from 'os'
import fs from 'fs/promises'
import { basename, join } from 'path'
import { createHash } from 'crypto'
import { createCodexUsageScanner } from './codexUsageScan'
import {
  usageDayFormatter as dayFormatter,
  usageQueryRange as queryRange,
  matchesUsageRoots,
  usageScope
} from './usageReportFilters'
import { t } from './i18n'

const FIELDS = ['input', 'cached', 'output', 'reasoning']
const seenByState = new WeakMap()
const object = (value) => value && typeof value === 'object' && !Array.isArray(value)
const clean = (value, max = 1024) =>
  typeof value === 'string'
    ? value
        .replace(/[\x00-\x1f]/g, ' ')
        .trim()
        .slice(0, max)
    : ''
const date = (value) => {
  const n = typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null
}
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const same = (a, b) => a && b && FIELDS.every((k) => a[k] === b[k])
const nonzero = (value) => value && value.input + value.output > 0
const emptyCounts = () => ({ input: 0, cached: 0, output: 0, reasoning: 0, total: 0, turns: 0 })
function sum(target, value) {
  for (const key of Object.keys(emptyCounts())) target[key] += value[key] || 0
}
function usage(value) {
  if (!object(value) || !['input_tokens', 'output_tokens', 'total_tokens'].some((k) => k in value))
    return null
  const fields = [
    value.input_tokens ?? 0,
    value.cached_input_tokens ?? value.cache_read_input_tokens ?? 0,
    value.output_tokens ?? 0,
    value.reasoning_output_tokens ?? 0
  ]
  if (!fields.every((n) => Number.isSafeInteger(n) && n >= 0)) return null
  return Object.fromEntries(FIELDS.map((k, i) => [k, fields[i]]))
}
function modelOf(value) {
  return (
    clean(value?.model, 160) ||
    clean(value?.model_name, 160) ||
    clean(value?.info?.model, 160) ||
    clean(value?.info?.metadata?.model, 160)
  )
}
function projectKey(cwd) {
  // win32.isAbsolute also accepts /unix/paths, whose case is significant.
  return /^[a-z]:[\\/]/i.test(cwd) || cwd.startsWith('\\') || cwd.startsWith('//')
    ? cwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    : cwd.replace(/\/+$/, '')
}
function projectLabel(cwd) {
  return cwd.split(/[\\/]/).filter(Boolean).at(-1) || cwd || 'Unknown project'
}
export function newCodexUsageState(file) {
  return {
    id: basename(file, '.jsonl'),
    title: '',
    cwd: '',
    model: '',
    started: null,
    previous: null,
    seen: [],
    events: [],
    malformed: 0,
    inherited: true,
    baselines: 0
  }
}

// Only metadata, a short optional title and normalized usage survive in state.
// Prompts, tool output, credentials and full raw rows never enter the cache.
export function consumeCodexUsageLine(line, state) {
  if (!line.trim()) return
  let row
  try {
    row = JSON.parse(line)
  } catch {
    state.malformed++
    return
  }
  if (!object(row) || !object(row.payload)) return
  const p = row.payload
  if (row.type === 'session_meta') {
    state.id = clean(p.id, 160) || state.id
    state.cwd = clean(p.cwd, 4096) || state.cwd
    state.started = date(p.timestamp || row.timestamp) || state.started
    state.title = clean(p.title, 120) || state.title
    state.inherited = !!(p.forked_from_id || p.parent_thread_id || p.history_base)
    return
  }
  if (row.type === 'turn_context') {
    state.cwd = clean(p.cwd, 4096) || state.cwd
    state.model = modelOf(p) || state.model
    return
  }
  if (row.type === 'event_msg' && p.type === 'thread_settings_applied') {
    state.model = modelOf(p.thread_settings) || state.model
    return
  }
  // token_usage_record is a separate newer representation of the same usage;
  // do not add it to token_count and charge the same request twice.
  if (row.type !== 'event_msg' || p.type !== 'token_count' || !object(p.info)) return
  const at = date(row.timestamp)
  const total = usage(p.info.total_token_usage)
  const last = usage(p.info.last_token_usage)
  if (!at || (!total && !last)) {
    state.malformed++
    return
  }
  const key = digest([at, total, last])
  let seen = seenByState.get(state)
  if (!seen) {
    seen = new Set(state.seen)
    seenByState.set(state, seen)
  }
  // An old exact row replayed inside a file must not rewind its cumulative
  // baseline. Across different files each parser still advances independently.
  if (seen.has(key)) return
  seen.add(key)
  state.seen.push(key)
  const previous = state.previous
  if (same(total, previous)) return // Rate-limit updates re-emit the last usage.
  let increment = null
  if (last) {
    // Compaction can synthesize last={I:0,O:0,total_tokens:context estimate}.
    // total_tokens alone is never evidence of new model usage.
    if (nonzero(last)) increment = last
    state.previous =
      total || (previous ? Object.fromEntries(FIELDS.map((k) => [k, previous[k] + last[k]])) : null)
  } else if (total) {
    const inheritedBaseline =
      !previous && state.inherited && (!state.started || at >= state.started)
    if (inheritedBaseline) state.baselines++
    else if (!previous || FIELDS.every((k) => total[k] >= previous[k])) {
      increment = Object.fromEntries(FIELDS.map((k) => [k, total[k] - (previous?.[k] || 0)]))
    }
    // A falling total-only snapshot establishes a baseline, not a new request.
    state.previous = total
  }
  if (!nonzero(increment)) return
  state.events.push({
    // Exclude session id: a fork rewrites session_meta but copies usage rows.
    key,
    at,
    model: modelOf(p) || state.model || 'unknown',
    cwd: state.cwd,
    input: increment.input,
    cached: Math.min(increment.cached, increment.input),
    output: increment.output,
    reasoning: Math.min(increment.reasoning, increment.output),
    total: increment.input + increment.output,
    turns: 1
  })
}

export function validCodexUsageState(state) {
  return (
    object(state) &&
    typeof state.id === 'string' &&
    typeof state.title === 'string' &&
    typeof state.cwd === 'string' &&
    typeof state.model === 'string' &&
    Array.isArray(state.seen) &&
    state.seen.every((key) => typeof key === 'string' && /^[a-f0-9]{64}$/.test(key)) &&
    typeof state.inherited === 'boolean' &&
    Number.isSafeInteger(state.baselines) &&
    state.baselines >= 0 &&
    (state.started === null || !!date(state.started)) &&
    Number.isSafeInteger(state.malformed) &&
    state.malformed >= 0 &&
    (state.previous === null ||
      (object(state.previous) &&
        FIELDS.every((k) => Number.isSafeInteger(state.previous[k]) && state.previous[k] >= 0))) &&
    Array.isArray(state.events) &&
    state.events.every(
      (e) =>
        object(e) &&
        /^[a-f0-9]{64}$/.test(e.key) &&
        !!date(e.at) &&
        typeof e.cwd === 'string' &&
        typeof e.model === 'string' &&
        Object.keys(emptyCounts()).every((k) => Number.isSafeInteger(e[k]) && e[k] >= 0) &&
        e.total === e.input + e.output &&
        e.cached <= e.input &&
        e.reasoning <= e.output &&
        e.turns === 1
    )
  )
}

export function aggregateCodexUsage(
  files,
  query = {},
  { now = Date.now(), timezone = Intl.DateTimeFormat().resolvedOptions().timeZone } = {}
) {
  const dayOf = dayFormatter(timezone)
  const range = queryRange(query, dayOf(now))
  const totals = emptyCounts(),
    days = new Map(),
    models = new Map(),
    projects = new Map(),
    sessions = new Map()
  const seen = new Set()
  let duplicated = 0,
    malformed = 0,
    baselines = 0
  // Original sessions normally predate forks. File path provides deterministic
  // ownership on equal dates, independent of directory enumeration/cache order.
  const ordered = [...files].sort(
    (a, b) =>
      (a.state.started || '\uffff').localeCompare(b.state.started || '\uffff') ||
      a.path.localeCompare(b.path)
  )
  for (const { state } of ordered) {
    malformed += state.malformed
    baselines += state.baselines
    for (const event of state.events) {
      if (seen.has(event.key)) {
        duplicated++
        continue
      }
      seen.add(event.key)
      const day = dayOf(event.at)
      if (
        (range.from && day < range.from) ||
        (range.to && day > range.to) ||
        (range.cwd && projectKey(event.cwd) !== projectKey(range.cwd)) ||
        (range.model && event.model !== range.model) ||
        !matchesUsageRoots(event.cwd, range.roots)
      )
        continue
      sum(totals, event)
      if (!days.has(day)) days.set(day, { day, ...emptyCounts() })
      sum(days.get(day), event)
      if (!models.has(event.model))
        models.set(event.model, { model: event.model, ...emptyCounts(), sessions: new Set() })
      sum(models.get(event.model), event)
      models.get(event.model).sessions.add(state.id)
      const key = projectKey(event.cwd)
      if (!projects.has(key))
        projects.set(key, {
          cwd: event.cwd,
          label: projectLabel(event.cwd),
          ...emptyCounts(),
          sessions: new Set()
        })
      sum(projects.get(key), event)
      projects.get(key).sessions.add(state.id)
      if (!sessions.has(state.id))
        sessions.set(state.id, {
          id: state.id,
          title: state.title || null,
          cwd: event.cwd,
          model: event.model,
          models: new Set(),
          projects: new Set(),
          first: event.at,
          last: event.at,
          tokens: emptyCounts()
        })
      const session = sessions.get(state.id)
      session.models.add(event.model)
      session.projects.add(event.cwd)
      if (event.at < session.first) session.first = event.at
      if (event.at > session.last) session.last = event.at
      sum(session.tokens, event)
    }
  }
  const rows = [...sessions.values()]
    .map((s) => ({
      ...s,
      models: [...s.models].sort(),
      projects: [...s.projects].sort(),
      model: s.models.size === 1 ? [...s.models][0] : 'mixed'
    }))
    .sort((a, b) => b.last.localeCompare(a.last) || a.id.localeCompare(b.id))
  const withSessionCount = ({ sessions, ...entry }) => ({ ...entry, sessions: sessions.size })
  return {
    ok: true,
    provider: 'codex',
    generatedAt: new Date(now).toISOString(),
    timezone,
    range: { from: range.from, to: range.to },
    scope: usageScope(range),
    totals: { ...totals, sessions: rows.length },
    byDay: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
    byModel: [...models.values()]
      .map(withSessionCount)
      .sort((a, b) => b.total - a.total || a.model.localeCompare(b.model)),
    byProject: [...projects.values()]
      .map(withSessionCount)
      .sort((a, b) => b.total - a.total || a.cwd.localeCompare(b.cwd)),
    sessions: rows,
    warnings: [
      ...(malformed ? [t('main.usage.malformedSkipped', 'Some malformed log records were skipped.')] : []),
      ...(baselines
        ? [t('main.usage.baselinesOnly', 'Inherited or incomplete cumulative snapshots were used only as baselines.')]
        : [])
    ],
    scan: { duplicated, malformed, baselines },
    // Cumulative-only legacy records can span several requests. The count is
    // therefore observations of model usage, not a count of user prompts.
    turnsMeaning: t('main.usage.codexTurns', 'Observed model usage events; not user prompts.'),
    tokenSemantics: t('main.usage.codexTokens', 'Cached tokens are included in input; reasoning tokens are included in output.')
  }
}

// Codex's append-only index contains conversation names without needing to
// extract user prompts. Read a bounded tail; older missing titles remain null.
function sessionTitles(root) {
  let signature = null,
    titles = new Map()
  return async () => {
    let file
    try {
      const path = join(root, 'session_index.jsonl')
      const stat = await fs.lstat(path)
      if (!stat.isFile()) return new Map()
      const current = `${stat.size}:${stat.mtimeMs}`
      if (current === signature) return titles
      file = await fs.open(path, 'r')
      const length = Math.min(stat.size, 4 * 1024 * 1024)
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await file.read(buffer, 0, length, stat.size - length)
      const found = new Map()
      for (const line of buffer.subarray(0, bytesRead).toString('utf8').split('\n')) {
        try {
          const row = JSON.parse(line)
          const name = clean(row?.thread_name, 120)
          if (typeof row?.id === 'string' && name) found.set(row.id, name)
        } catch {
          /* partial append or bounded first line */
        }
      }
      signature = current
      titles = found
      return titles
    } catch {
      return new Map()
    } finally {
      await file?.close().catch(() => {})
    }
  }
}

export function createCodexUsageReport({
  userData,
  home = os.homedir(),
  env = process.env,
  now = Date.now,
  timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
} = {}) {
  const root = env.CODEX_HOME || join(home, '.codex')
  const readTitles = sessionTitles(root)
  const scan = createCodexUsageScanner({
    root,
    cacheFile: userData ? join(userData, 'codex-usage-report-v1.json') : undefined,
    makeState: newCodexUsageState,
    consumeLine: consumeCodexUsageLine,
    validateState: validCodexUsageState,
    cacheVersion: 1
  })
  return async (query = {}) => {
    const time = now()
    // Validate before any I/O for malformed renderer requests.
    queryRange(query, dayFormatter(timezone)(time))
    const scanned = await scan()
    const result = aggregateCodexUsage(scanned.files, query, { now: time, timezone })
    const titles = await readTitles()
    for (const session of result.sessions) session.title = titles.get(session.id) || session.title
    result.scan = { ...scanned.stats, ...result.scan }
    result.warnings = [...scanned.warnings, ...result.warnings]
    return result
  }
}
