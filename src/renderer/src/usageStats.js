// Local-report presentation, independently adapted from Orca's usage overview
// normalization/daily series (MIT, Copyright (c) 2026 Lovecast Inc.).
// Reports are already deduplicated and filtered in main. Never reconstruct
// totals from a page of conversations, or add cached/reasoning subsets twice.
import { t } from './i18n'

export const USAGE_REPORT_PROVIDERS = ['claude', 'codex', 'opencode', 'grok']
const PROVIDERS = USAGE_REPORT_PROVIDERS
const LABELS = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', grok: 'Grok Build' } // product names // i18n-ignore
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const count = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)
const optionalCount = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)
const text = (v) => (typeof v === 'string' ? v : '')
const rows = (v) => (Array.isArray(v) ? v.filter(object) : [])
const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone
const epoch = (v) => {
  const value = typeof v === 'number' ? v : typeof v === 'string' && v ? Date.parse(v) : NaN
  return Number.isFinite(value) && value >= 0 && value <= 8.64e15 ? value : null
}

export function validUsageDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

export function usageLocalDay(value = Date.now(), timezone = localZone()) {
  const at = epoch(value)
  if (at === null) throw new RangeError(t('usage.report.invalidDate', 'Choose a valid usage date.'))
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    })
      .formatToParts(new Date(at))
      .map((part) => [part.type, part.value])
  )
  return `${parts.year}-${parts.month}-${parts.day}`
}

// A folder the local reports accept as a root: a drive, UNC or POSIX path.
function localRoot(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4096 &&
    !/[\x00-\x1f]/.test(value) &&
    (/^[a-z]:[\\/]/i.test(value) || /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(value) || value.startsWith('/'))
  )
}
// One spelling per folder: Windows paths without case or slash differences.
function folderKey(path) {
  const windows = /^[a-z]:[\\/]/i.test(path) || /^(?:\\\\|\/\/)/.test(path)
  const key = windows ? path.replace(/\\/g, '/').toLowerCase() : path
  return key.replace(/\/+$/, '') || '/'
}
const within = (path, folder) => {
  const key = folderKey(path)
  const base = folderKey(folder)
  return key === base || key.startsWith(base === '/' ? '/' : `${base}/`)
}

// The local folders of a Tessel project: its folder, and for a folder
// imported as a group, each of its repositories too (the group's own folder
// stays: its agents start there by default; a repository, deeper, keeps its
// own turns). None for a project on an SSH host (its history is not on this
// computer).
export function usageProjectFolders(workspace) {
  if (!object(workspace) || workspace.remote) return []
  const own = localRoot(workspace.cwd) ? [workspace.cwd] : []
  if (object(workspace.group) && Array.isArray(workspace.group.repos))
    return [...workspace.group.repos.map((repo) => (object(repo) ? repo.path : null)).filter(localRoot), ...own]
  return own
}

// What the "Tessel projects" scope holds now, like Orca's worktree scope:
// each project folder (a project of its own), and counted under it, its git
// worktrees (`worktrees`: folder -> [{ path, isMain }]), the task copies
// (`tasks`: [{ worktree: { path, root } }]) and the pane copies (`panes`:
// [{ path, workspace }]). -> [{ path, project, main? }]
export function usageScopeEntries({ workspaces = [], worktrees = {}, tasks = [], panes = [] } = {}) {
  const entries = new Map() // folder key -> entry
  const projects = []
  const owner = new Map() // a git worktree's folder key -> its project
  const add = (path, project, main = false) => {
    if (!localRoot(path) || entries.has(folderKey(path))) return
    entries.set(folderKey(path), { path, project, ...(main ? { main: true } : {}) })
  }
  for (const workspace of Array.isArray(workspaces) ? workspaces : [])
    for (const folder of usageProjectFolders(workspace))
      if (!entries.has(folderKey(folder))) {
        projects.push(folder)
        add(folder, folder)
      }
  const projectKeys = new Map(projects.map((folder) => [folderKey(folder), folder]))
  for (const folder of projects) {
    const listed = object(worktrees) ? worktrees[folder] : null
    for (const copy of Array.isArray(listed) ? listed : [])
      if (object(copy) && localRoot(copy.path)) {
        if (!owner.has(folderKey(copy.path))) owner.set(folderKey(copy.path), folder)
        add(copy.path, folder, copy.isMain === true)
      }
  }
  // A copy's project: the one git lists it under, else its repository's,
  // else the project whose copies folder (<project>.worktrees) or own folder holds it.
  const projectOf = (path, root, candidates = projects, single = false) => {
    const listed = owner.get(folderKey(path))
    if (listed) return listed
    if (localRoot(root)) {
      const named = projectKeys.get(folderKey(root)) || owner.get(folderKey(root))
      if (named) return named
    }
    // The deepest one: a copy inside a project nested in another is that one's.
    const holder = candidates
      .filter((folder) => within(path, `${folder}.worktrees`) || within(path, folder)) // i18n-ignore
      .sort((a, b) => folderKey(b).length - folderKey(a).length)[0]
    if (holder) return holder
    if (single && candidates.length === 1) return candidates[0]
    return localRoot(root) ? root : path
  }
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const copy = object(task) && object(task.worktree) ? task.worktree : null
    if (copy && localRoot(copy.path)) add(copy.path, projectOf(copy.path, copy.root))
  }
  for (const pane of Array.isArray(panes) ? panes : [])
    if (object(pane) && localRoot(pane.path)) {
      const folders = usageProjectFolders(pane.workspace)
      add(pane.path, projectOf(pane.path, null, folders.length ? folders : projects, folders.length > 0))
    }
  return [...entries.values()]
}

// The copies Tessel has seen, kept so that a copy merged and removed since
// still counts under its project: { [folder key]: { path, project, at } },
// at most USAGE_COPIES_MAX, the most recently seen.
export const USAGE_COPIES_KEY = 'tessel:usage-copies'
export const USAGE_COPIES_MAX = 1000
const DAY = 86400000
export function usageCopiesFrom(raw) {
  const out = {}
  if (!object(raw)) return out
  for (const [key, copy] of Object.entries(raw))
    if (
      object(copy) &&
      localRoot(copy.path) &&
      localRoot(copy.project) &&
      folderKey(copy.path) === key &&
      Number.isFinite(copy.at)
    )
      out[key] = { path: copy.path, project: copy.project, at: copy.at }
  return out
}
// -> the same object when nothing changed (nothing to save), else a new one.
export function rememberUsageCopies(saved, entries, now = Date.now()) {
  let next = null
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!object(entry) || folderKey(entry.project) === folderKey(entry.path)) continue
    const key = folderKey(entry.path)
    const had = saved[key]
    if (had && had.project === entry.project && now - had.at < DAY) continue
    next ??= { ...saved }
    next[key] = { path: entry.path, project: entry.project, at: now }
  }
  if (!next) return saved
  const keys = Object.keys(next)
  if (keys.length > USAGE_COPIES_MAX)
    for (const key of keys.sort((a, b) => next[b].at - next[a].at).slice(USAGE_COPIES_MAX)) delete next[key]
  return next
}
export function loadUsageCopies(storage = globalThis.localStorage) {
  try {
    return usageCopiesFrom(JSON.parse(storage.getItem(USAGE_COPIES_KEY) || 'null'))
  } catch {
    return {}
  }
}
export function saveUsageCopies(copies, storage = globalThis.localStorage) {
  try {
    storage.setItem(USAGE_COPIES_KEY, JSON.stringify(copies))
  } catch {
    // kept for this run only
  }
}

// The roots the reports get: the entries of now, and the copies seen before
// of a project still open. A project folder is sent as its path, a copy as
// { path, project } (main: its repository's own checkout). Sorted, so the
// same folders always make the same query.
export function usageScopeRoots(entries = [], remembered = {}) {
  const roots = new Map()
  const projects = new Set()
  for (const entry of Array.isArray(entries) ? entries : [])
    if (object(entry) && localRoot(entry.path) && localRoot(entry.project)) {
      if (folderKey(entry.project) === folderKey(entry.path)) projects.add(folderKey(entry.path))
      if (!roots.has(folderKey(entry.path))) roots.set(folderKey(entry.path), entry)
    }
  for (const copy of Object.values(object(remembered) ? remembered : {}))
    if (object(copy) && projects.has(folderKey(copy.project)) && !roots.has(folderKey(copy.path)))
      roots.set(folderKey(copy.path), { path: copy.path, project: copy.project })
  return [...roots.values()]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .slice(0, 4096)
    .map((entry) =>
      folderKey(entry.project) === folderKey(entry.path)
        ? entry.path
        : { path: entry.path, project: entry.project, ...(entry.main ? { main: true } : {}) }
    )
}

// Calendar arithmetic on date-only keys avoids 23/25-hour DST boundaries.
function shiftDay(day, amount) {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + amount)
  return date.toISOString().slice(0, 10)
}

export function usageDateRange(
  preset = '30d',
  { now = Date.now(), timezone = localZone(), from, to } = {}
) {
  if (preset === 'all') return { from: null, to: null }
  if (preset === 'custom') {
    if (!validUsageDay(from) || !validUsageDay(to) || from > to)
      throw new RangeError(
        t('usage.report.invalidRange', 'Use an inclusive date range (YYYY-MM-DD).')
      )
    return { from, to }
  }
  if (!['7d', '30d', '90d'].includes(preset))
    throw new RangeError(t('usage.report.invalidPreset', 'Choose 7d, 30d, 90d, all or custom.'))
  const end = usageLocalDay(now, timezone)
  return { from: shiftDay(end, 1 - Number.parseInt(preset, 10)), to: end }
}

// OpenCode records reasoning and cache tokens next to input and output; they
// are shown as Codex shows its own (cached input inside input, reasoning
// inside output), with the cost OpenCode itself recorded.
function openCodeMetrics(value) {
  const read = count(value.cacheRead)
  const write = count(value.cacheWrite)
  const reasoning = count(value.reasoning)
  const input = count(value.input) + read + write
  const output = count(value.output) + reasoning
  const activity = count(value.turns)
  const unpriced = Math.min(activity, count(value.unpriced))
  const cost = !(activity > 0 && unpriced >= activity) ? optionalCount(value.cost) : null
  return {
    inputTokens: input,
    newInputTokens: input - read,
    outputTokens: output,
    cacheReadTokens: read,
    cacheWriteTokens: write,
    cacheWrite1hTokens: 0,
    cachedInputTokens: read,
    cacheTokens: read + write,
    reasoningTokens: reasoning,
    reasoningOutputTokens: reasoning,
    totalTokens: input + output,
    activityCount: activity,
    activityLabel: t('usage.report.events', 'events'),
    turns: null,
    events: activity,
    sessions: optionalCount(value.sessions),
    estimatedCostUsd: cost,
    unpricedCount: unpriced,
    hasUnpricedModels: unpriced > 0,
    hasPartialCost: cost !== null && unpriced > 0,
    cacheReuseRate: input > 0 ? read / input : null,
    zeroCacheReadTurns: null
  }
}

function normalizeMetrics(provider, value = {}) {
  // Grok Build's report carries OpenCode's buckets (grokUsageReport.js).
  if (provider === 'opencode' || provider === 'grok') return openCodeMetrics(value)
  const input = count(value.input)
  const output = count(value.output)
  const activity = count(value.turns)
  const cached =
    provider === 'codex' ? Math.min(input, count(value.cached)) : count(value.cacheRead)
  const write = provider === 'claude' ? count(value.cacheWrite) : 0
  const reasoning = provider === 'codex' ? Math.min(output, count(value.reasoning)) : 0
  const unpriced = provider === 'claude' ? count(value.unpriced) : activity
  const cost =
    provider === 'claude' && !(activity > 0 && unpriced >= activity)
      ? optionalCount(value.cost)
      : null
  const zeroRead = optionalCount(value.zeroCacheReadTurns)
  return {
    inputTokens: input,
    newInputTokens: provider === 'codex' ? input - cached : input,
    outputTokens: output,
    cacheReadTokens: cached,
    cacheWriteTokens: write,
    // The one-hour bucket is already inside cacheWriteTokens.
    cacheWrite1hTokens: provider === 'claude' ? Math.min(write, count(value.cacheWrite1h)) : 0,
    cachedInputTokens: cached,
    cacheTokens: cached + write,
    reasoningTokens: reasoning,
    reasoningOutputTokens: reasoning,
    totalTokens: provider === 'codex' ? input + output : input + output + cached + write,
    activityCount: activity,
    activityLabel:
      provider === 'codex' ? t('usage.report.events', 'events') : t('usage.report.turns', 'turns'),
    turns: provider === 'claude' ? activity : null,
    events: provider === 'codex' ? activity : null,
    sessions: optionalCount(value.sessions),
    estimatedCostUsd: cost,
    unpricedCount: unpriced,
    hasUnpricedModels: unpriced > 0,
    hasPartialCost: cost !== null && unpriced > 0,
    // Claude's cache-reuse denominator intentionally excludes new cache writes.
    cacheReuseRate:
      (provider === 'codex' ? input : input + cached) > 0
        ? cached / (provider === 'codex' ? input : input + cached)
        : null,
    zeroCacheReadTurns:
      provider === 'claude' && zeroRead !== null && zeroRead <= activity ? zeroRead : null
  }
}

function folder(cwd) {
  return (
    text(cwd)
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .at(-1) || t('usage.report.unknownProject', 'Unknown project')
  )
}

function reportRange(raw, options) {
  const candidate = object(raw?.range) ? raw.range : options.range
  if (
    candidate &&
    (candidate.from === null || validUsageDay(candidate.from)) &&
    (candidate.to === null || validUsageDay(candidate.to)) &&
    !(candidate.from && candidate.to && candidate.from > candidate.to)
  )
    return { from: candidate.from, to: candidate.to }
  return null
}

// This adapts the selected report; date/model/project/worktree filtering belongs
// to the backend, where individual usage observations still exist.
export function normalizeUsageReport(provider, raw, options = {}) {
  if (!PROVIDERS.includes(provider)) throw new RangeError(t('usage.report.unsupportedProvider', 'Unsupported local usage provider.'))
  const ready = raw?.ok === true && raw.enabled !== false
  const legacyClaude = provider === 'claude' && !object(raw?.range) && object(raw?.lastDays)
  const value = ready ? (legacyClaude ? raw.lastDays : raw.totals) || {} : {}
  const summary = normalizeMetrics(provider, value)
  const mapRows = (field, decorate) =>
    ready
      ? rows(raw[field]).map((row) => ({
          ...decorate(row),
          ...normalizeMetrics(provider, row.tokens || row)
        }))
      : []
  const byDay = mapRows('byDay', (row) => ({
    key: text(row.day),
    label: text(row.day),
    day: text(row.day)
  }))
    .filter((row) => validUsageDay(row.day))
    .sort((a, b) => a.day.localeCompare(b.day))
  // Orca's Claude breakdowns rank/display input + output, excluding the
  // additional cache buckets. The overview and daily totals retain them.
  const breakdown = (values) =>
    values
      .map((row) => ({ ...row, breakdownTokens: row.inputTokens + row.outputTokens }))
      .sort((a, b) => b.breakdownTokens - a.breakdownTokens)
  const byModel = breakdown(
    mapRows('byModel', (row) => ({
      key: text(row.model) || 'unknown',
      label: text(row.model) || t('usage.report.unknownModel', 'Unknown model'),
      model: text(row.model) || 'unknown'
    }))
  )
  const byProject = breakdown(
    mapRows('byProject', (row) => ({
      key: text(row.cwd),
      label: text(row.label) || folder(row.cwd),
      cwd: text(row.cwd)
    }))
  )
  const sessions = mapRows('sessions', (row) => ({
    key: `${provider}:${text(row.id)}`,
    id: text(row.id),
    provider,
    label: text(row.title) || folder(row.cwd),
    title: text(row.title),
    cwd: text(row.cwd),
    projectLabel: folder(row.cwd),
    branch: text(row.branch),
    model: text(row.model) || 'unknown',
    models: Array.isArray(row.models)
      ? row.models.filter((v) => typeof v === 'string')
      : row.model
        ? [row.model]
        : [],
    projects: Array.isArray(row.projects)
      ? row.projects.filter((v) => typeof v === 'string')
      : row.cwd
        ? [row.cwd]
        : [],
    first: epoch(row.first),
    last: epoch(row.last)
  })).filter((row) => row.id)
  // Legacy Claude returns only its 50 costliest sessions: never call that the
  // exact conversation count. Updated backends supply totals.sessions.
  if (summary.sessions === null && ready && provider !== 'claude') summary.sessions = sessions.length
  const warnings =
    ready && Array.isArray(raw.warnings) ? raw.warnings.filter((v) => typeof v === 'string') : []
  if (legacyClaude)
    warnings.push(
      t('usage.report.legacyClaude', 'This older Claude report covers its recent window; its conversation list may be incomplete.'
      )
    )
  const scope = ready && raw.scope === 'tessel-worktrees' ? 'tessel-worktrees' : 'all'
  const updatedAt = ready ? epoch(raw.generatedAt ?? raw.observedAt) : null
  const hasData = ready && (summary.totalTokens > 0 || summary.activityCount > 0)
  return {
    provider,
    id: provider,
    label: LABELS[provider],
    status: ready ? 'ready' : raw && raw.ok === false ? 'error' : 'unavailable',
    enabled: ready,
    hasData,
    error: ready ? null : text(raw?.error) || null,
    generatedAt: updatedAt,
    updatedAt,
    lastScanCompletedAt: updatedAt,
    range: reportRange(raw, options),
    timezone: text(raw?.timezone) || options.timezone || localZone(),
    scope,
    scopeLabel:
      scope === 'tessel-worktrees'
        ? t('usage.report.scopeTessel', 'Tessel projects only')
        : provider === 'claude'
          ? t('usage.report.scopeClaude', 'Shared Claude history on this computer')
          : provider === 'opencode'
            ? t('usage.report.scopeOpenCode', 'OpenCode history on this computer')
            : provider === 'grok'
              ? t('usage.report.scopeGrok', 'Grok Build history on this computer')
            : t('usage.report.scopeCodex', 'Selected Codex account’s local history'),
    accountId:
      provider === 'codex' && (raw?.accountId === null || typeof raw?.accountId === 'string')
        ? raw.accountId
        : null,
    accountScoped: provider === 'codex',
    warnings,
    summary,
    metrics: summary,
    byDay,
    byModel,
    byProject,
    sessions,
    // Names matching the Orca-style presentation are aliases, never re-sums.
    daily: byDay,
    modelBreakdown: byModel,
    projectBreakdown: byProject,
    recentSessions: sessions,
    topModel: byModel[0]?.label || null,
    topProject: byProject[0]?.label || null,
    turnsMeaning:
      text(raw?.turnsMeaning) ||
      (provider === 'opencode'
        ? t('usage.report.opencodeTurns', 'Recorded usage rows: one per session where OpenCode keeps session totals, else one per reply.')
        : provider === 'grok'
          ? t('usage.report.grokTurns', 'Completed turns, one row per model a turn used.')
        : provider === 'codex'
          ? t('usage.report.codexTurns', 'Observed model usage events; not user prompts.')
          : t('usage.report.claudeTurns', 'Deduplicated assistant replies.')),
    tokenSemantics:
      provider === 'codex' || provider === 'opencode' || provider === 'grok'
        ? t('usage.report.codexTokens', 'Cached input and reasoning output are subsets, not additional tokens.'
          )
        : t('usage.report.claudeTokens', 'Cache reads and cache writes are additional to input; one-hour cache writes are a subset of all cache writes.'
          )
  }
}

const SUM_FIELDS = [
  'inputTokens',
  'newInputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'cacheWrite1hTokens',
  'cachedInputTokens',
  'cacheTokens',
  'reasoningTokens',
  'reasoningOutputTokens',
  'totalTokens',
  'activityCount'
]
function combineMetrics(values) {
  const out = Object.fromEntries(
    SUM_FIELDS.map((key) => [key, values.reduce((sum, row) => sum + row[key], 0)])
  )
  const active = values.filter((row) => row.totalTokens > 0 || row.activityCount > 0)
  const priced = active.filter((row) => row.estimatedCostUsd !== null)
  out.estimatedCostUsd = priced.length
    ? priced.reduce((sum, row) => sum + row.estimatedCostUsd, 0)
    : null
  out.hasPartialCost =
    priced.length > 0 && active.some((row) => row.estimatedCostUsd === null || row.hasPartialCost)
  out.hasUnpricedModels = active.some((row) => row.hasUnpricedModels)
  out.sessions = values.every((row) => row.sessions !== null)
    ? values.reduce((sum, row) => sum + row.sessions, 0)
    : null
  out.cacheShare =
    out.newInputTokens + out.cacheTokens > 0
      ? out.cacheTokens / (out.newInputTokens + out.cacheTokens)
      : null
  return out
}

// Input is NORMALIZED reports, keyed by provider (not raw main-process data).
// The overview is filter-free; callers fetch all-time reports separately from
// each provider pane's currently filtered report.
export function buildUsageOverview(
  reports = {},
  { now = Date.now(), timezone = localZone(), dayCount = 42 } = {}
) {
  const providers = PROVIDERS.map((id) => reports[id] || normalizeUsageReport(id, null))
  const enabled = providers.filter((provider) => provider.enabled && provider.status === 'ready')
  const summary = combineMetrics(enabled.map((provider) => provider.summary))
  const byDay = new Map()
  for (const provider of enabled)
    for (const row of provider.byDay) {
      const current = byDay.get(row.day) || {
        day: row.day,
        claudeTokens: 0,
        codexTokens: 0,
        opencodeTokens: 0,
        grokTokens: 0,
        rows: []
      }
      current[`${provider.provider}Tokens`] += row.totalTokens // i18n-ignore
      current.rows.push(row)
      byDay.set(row.day, current)
    }
  const history = [...byDay.values()]
    .sort((a, b) => a.day.localeCompare(b.day))
    .map((row) => {
      const { rows: values, ...identity } = row
      return { ...identity, ...combineMetrics(values) }
    })
  const max = history.reduce((value, row) => Math.max(value, row.totalTokens), 0)
  for (const row of history)
    row.intensity =
      row.totalTokens <= 0 || !max ? 0 : Math.min(4, Math.ceil((row.totalTokens / max) * 4))
  const bestDay = history.reduce(
    (best, row) =>
      row.totalTokens > 0 && (!best || row.totalTokens > best.totalTokens) ? row : best,
    null
  )
  const end = usageLocalDay(now, timezone)
  const size = Math.max(1, Math.min(366, Math.floor(Number.isFinite(dayCount) ? dayCount : 42)))
  const allDays = new Map(history.map((row) => [row.day, row]))
  const daily = Array.from({ length: size }, (_, i) => {
    const day = shiftDay(end, i + 1 - size)
    return (
      allDays.get(day) || {
        day,
        claudeTokens: 0,
        codexTokens: 0,
        opencodeTokens: 0,
        grokTokens: 0,
        ...combineMetrics([]),
        intensity: 0
      }
    )
  })
  const activeDays = history.filter((row) => row.totalTokens > 0).length
  const lastUpdatedAt = enabled.reduce(
    (latest, row) =>
      row.updatedAt !== null && (latest === null || row.updatedAt > latest)
        ? row.updatedAt
        : latest,
    null
  )
  return {
    ...summary,
    summary,
    metrics: summary,
    providers: providers.map((provider) => ({ ...provider, ...provider.summary })),
    enabledProviderCount: enabled.length,
    dataProviderCount: enabled.filter((provider) => provider.hasData).length,
    hasAnyEnabledProvider: enabled.length > 0,
    hasData: enabled.some((provider) => provider.hasData),
    hasAnyData: enabled.some((provider) => provider.hasData),
    activeDays,
    daily,
    history,
    bestDay,
    lastUpdatedAt
  }
}
export const buildOverview = buildUsageOverview

// Search/sort/page only the conversation table. Report totals do not change.
export function filterUsageSessions(
  sessions,
  { search = '', sortBy = 'last', sortDir = 'desc', limit = 20, offset = 0 } = {}
) {
  const query = text(search).trim().toLocaleLowerCase()
  const allowed = new Set([
    'last',
    'first',
    'totalTokens',
    'activityCount',
    'estimatedCostUsd',
    'inputTokens',
    'outputTokens',
    'cacheTokens',
    'title',
    'cwd',
    'model'
  ])
  const key = allowed.has(sortBy) ? sortBy : 'last'
  const direction = sortDir === 'asc' ? 1 : -1
  const matches = rows(sessions).filter(
    (row) =>
      !query ||
      [row.id, row.title, row.cwd, row.branch, row.model, ...(row.models || [])].some((value) =>
        text(value).toLocaleLowerCase().includes(query)
      )
  )
  matches.sort((a, b) => {
    if (a[key] == null && b[key] != null) return 1
    if (b[key] == null && a[key] != null) return -1
    const order =
      typeof a[key] === 'number' && typeof b[key] === 'number'
        ? a[key] - b[key]
        : text(a[key]).localeCompare(text(b[key]))
    return order * direction || text(a.key || a.id).localeCompare(text(b.key || b.id))
  })
  const start = Math.max(0, Math.floor(Number.isFinite(offset) ? offset : 0))
  const size = Math.max(1, Math.min(500, Math.floor(Number.isFinite(limit) ? limit : 20)))
  return { rows: matches.slice(start, start + size), total: matches.length }
}
