// Local-report presentation, independently adapted from Orca's usage overview
// normalization/daily series (MIT, Copyright (c) 2026 Lovecast Inc.).
// Reports are already deduplicated and filtered in main. Never reconstruct
// totals from a page of conversations, or add cached/reasoning subsets twice.
const PROVIDERS = ['claude', 'codex']
const LABELS = { claude: 'Claude Code', codex: 'Codex' }
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
  if (at === null) throw new RangeError('Choose a valid usage date.')
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
      throw new RangeError('Use an inclusive date range (YYYY-MM-DD).')
    return { from, to }
  }
  if (!['7d', '30d', '90d'].includes(preset))
    throw new RangeError('Choose 7d, 30d, 90d, all or custom.')
  const end = usageLocalDay(now, timezone)
  return { from: shiftDay(end, 1 - Number.parseInt(preset, 10)), to: end }
}

function normalizeMetrics(provider, value = {}) {
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
    activityLabel: provider === 'codex' ? 'events' : 'turns',
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
      .at(-1) || 'Unknown project'
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
  if (!PROVIDERS.includes(provider)) throw new RangeError('Unsupported local usage provider.')
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
      label: text(row.model) || 'Unknown model',
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
  if (summary.sessions === null && ready && provider === 'codex') summary.sessions = sessions.length
  const warnings =
    ready && Array.isArray(raw.warnings) ? raw.warnings.filter((v) => typeof v === 'string') : []
  if (legacyClaude)
    warnings.push(
      'This older Claude report covers its recent window; its conversation list may be incomplete.'
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
        ? 'Tessel worktrees only'
        : provider === 'claude'
          ? 'Shared Claude history on this computer'
          : 'Selected Codex account’s local history',
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
      (provider === 'codex'
        ? 'Observed model usage events; not user prompts.'
        : 'Deduplicated assistant replies.'),
    tokenSemantics:
      provider === 'codex'
        ? 'Cached input and reasoning output are subsets, not additional tokens.'
        : 'Cache reads and cache writes are additional to input; one-hour cache writes are a subset of all cache writes.'
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
        rows: []
      }
      current[`${provider.provider}Tokens`] += row.totalTokens
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
