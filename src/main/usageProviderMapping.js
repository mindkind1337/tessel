// Adapted from stablyai/orca src/main/rate-limits (MIT, Lovecast Inc. 2026).
// See THIRD_PARTY_NOTICES.md. Pure response mappings: no I/O or credentials.
export const number = (value) =>
  (typeof value === 'number' || (typeof value === 'string' && value.trim())) &&
  Number.isFinite(Number(value))
    ? Number(value)
    : null
export function timestamp(value) {
  if (value == null || value === '') return null
  const n = number(value)
  const at = n === null ? Date.parse(value) : n < 1e11 ? n * 1000 : n
  return Number.isFinite(at) && at > 0 && at <= 8.64e15 ? at : null
}
export const quota = (label, pct, reset) =>
  number(pct) === null
    ? null
    : {
        label: String(label).slice(0, 70),
        usedPct: Math.min(100, Math.max(0, number(pct))),
        resetsAt: timestamp(reset)
      }
const ratio = (used, limit) =>
  number(used) !== null && number(limit) > 0 ? (100 * number(used)) / number(limit) : null
export function mapGemini(data) {
  const buckets = Array.isArray(data) ? data : Array.isArray(data?.buckets) ? data.buckets : []
  const windows = buckets
    .slice(0, 100)
    .filter(
      (b) =>
        typeof b?.modelId === 'string' &&
        typeof b.remainingFraction === 'number' &&
        Number.isFinite(b.remainingFraction)
    )
    .map((b) =>
      quota(
        b.modelId.replace(/^gemini-/, ''),
        Math.round((1 - b.remainingFraction) * 100),
        b.resetTime
      )
    )
  // Orca merges identical pools rather than drawing duplicate model meters.
  return windows.filter(
    (w, i) => windows.findIndex((v) => v.usedPct === w.usedPct && v.resetsAt === w.resetsAt) === i
  )
}
export function mapKimi(data) {
  const window = (d, label) =>
    quota(
      label,
      ratio(
        number(d?.used) ??
          (number(d?.limit) !== null && number(d?.remaining) !== null
            ? number(d.limit) - number(d.remaining)
            : null),
        d?.limit
      ),
      d?.resetTime ?? d?.resetAt
    )
  const windows = [window(data?.usage, 'Weekly')]
  const limits = Array.isArray(data?.limits) ? data.limits : []
  let best = null
  for (const l of limits.slice(0, 100)) {
    const unit = String(l?.window?.timeUnit || '').toUpperCase()
    const duration = number(l?.window?.duration)
    const minutes =
      duration === null
        ? 300
        : duration *
          (unit.includes('HOUR')
            ? 60
            : unit.includes('DAY')
              ? 1440
              : unit.includes('SECOND')
                ? 1 / 60
                : 1)
    const value = window(l?.detail, minutes === 300 ? '5-hour' : `${Math.round(minutes)} min`)
    if (value && (!best || Math.abs(minutes - 300) < best.distance))
      best = { value, distance: Math.abs(minutes - 300) }
  }
  if (best) windows.unshift(best.value)
  return windows.filter(Boolean)
}
export function mapCursor(data) {
  if (data?.isUnlimited === true) return { windows: [], unlimited: true }
  const windows = [],
    plan = data?.individualUsage?.plan,
    onDemand = data?.individualUsage?.onDemand
  const add = (label, pct) => {
    const w = quota(label, pct, data?.billingCycleEnd)
    if (w) windows.push(w)
  }
  if (plan?.enabled !== false) {
    // Cursor's reported plan percentage wins: the raw base allowance can read
    // 100% while the plan still has capacity (after Orca's
    // cursor-usage-mapping.ts, MIT, Copyright (c) 2026 Lovecast Inc.).
    add('Monthly', number(plan?.totalPercentUsed) ?? ratio(plan?.used, plan?.limit))
    add('Cursor models', plan?.autoPercentUsed)
    add('Other models', plan?.apiPercentUsed)
  }
  if (onDemand?.enabled === true)
    add('On demand', ratio(onDemand.used, onDemand.limit) ?? number(onDemand.totalPercentUsed))
  return { windows }
}
export function mapCursorLegacy(data) {
  const rows = Object.entries(data || {})
    .map(([key, d]) => ({ key, used: number(d?.numRequests), limit: number(d?.maxRequestUsage) }))
    .filter((d) => d.used !== null && d.limit > 0)
  const row = rows.find((d) => d.key === 'gpt-4') || rows.sort((a, b) => b.limit - a.limit)[0]
  let end = null
  const start = timestamp(data?.startOfMonth)
  if (start) {
    const d = new Date(start),
      year = d.getUTCFullYear(),
      month = d.getUTCMonth()
    end = Date.UTC(
      year,
      month + 1,
      Math.min(d.getUTCDate(), new Date(Date.UTC(year, month + 2, 0)).getUTCDate()),
      d.getUTCHours(),
      d.getUTCMinutes(),
      d.getUTCSeconds()
    )
  }
  return row ? [quota('Monthly requests', ratio(row.used, row.limit), end)] : []
}
export function mapGrok(data) {
  const d = data?.config || data || {},
    reset = d.currentPeriod?.end ?? d.billingPeriodEnd
  if (typeof d.creditUsagePercent === 'number' && Number.isFinite(d.creditUsagePercent))
    return [quota('Weekly', d.creditUsagePercent, reset)]
  const monthly = ratio(d.used?.val, d.monthlyLimit?.val)
  if (monthly !== null) return [quota('Monthly', monthly, reset)]
  // Orca accepts omitted percent as zero only with matching weekly bounds and
  // no contrary monetary fields. Missing usage otherwise remains unknown.
  const scalars = [d.onDemandCap, d.onDemandUsed, d.prepaidBalance, d.monthlyLimit, d.used].map(
    (v) => number(v?.val)
  )
  const period = d.currentPeriod
  if (
    d.creditUsagePercent === undefined &&
    scalars.every((v) => v === null) &&
    period?.type === 'USAGE_PERIOD_TYPE_WEEKLY' &&
    timestamp(period.start) !== null &&
    timestamp(period.end) !== null &&
    timestamp(period.start) === timestamp(d.billingPeriodStart) &&
    timestamp(period.end) === timestamp(d.billingPeriodEnd)
  )
    return [quota('Weekly', 0, reset)]
  return []
}
export function mapOpenCodeGo(data) {
  const usage = data?.usage
  const windows = [
    ['rolling', '5-hour'],
    ['weekly', 'Weekly'],
    ['monthly', 'Monthly']
  ].map(([key, label]) =>
    typeof usage?.[key]?.percent === 'number'
      ? quota(label, usage[key].percent, usage[key].resetsAt)
      : null
  )
  return windows[0] && windows[1] ? windows.filter(Boolean) : []
}
// The model names to read, in order ("general" unless set in Settings), after
// Orca's minimax-fetcher-data.ts parseMiniMaxModels/selectMiniMaxSnapshot.
export function miniMaxModels(value) {
  const list = (Array.isArray(value) ? value : String(value ?? '').split(','))
    .map((m) => String(m).trim())
    .filter(Boolean)
    .slice(0, 20)
  return list.length ? list : ['general']
}
export function mapMiniMax(data, now = Date.now(), models = ['general']) {
  const rows = (Array.isArray(data?.model_remains) ? data.model_remains : []).filter(
    (d) =>
      typeof d?.model_name === 'string' &&
      number(d.current_interval_remaining_percent) !== null &&
      number(d.start_time) !== null &&
      number(d.end_time) !== null
  )
  let d = null
  for (const name of miniMaxModels(models)) d ??= rows.find((r) => r.model_name === name) || null
  if (!d && rows.length === 1) d = rows[0]
  if (!d) return []
  const windows = [quota('5-hour', 100 - number(d.current_interval_remaining_percent), d.end_time)]
  if (number(d.current_weekly_remaining_percent) !== null)
    windows.push(
      quota(
        'Weekly',
        100 - number(d.current_weekly_remaining_percent),
        number(d.weekly_remains_time) !== null ? now + number(d.weekly_remains_time) : null
      )
    )
  return windows
}
// OpenCode's legacy console (OpenCode Black accounts): /console/api/go/status
// meters in micro-cents, after Orca's opencode-go-status-parsing.ts.
export function mapOpenCodeConsole(data) {
  const meters = data?.access?.meters
  const window = (meter, label) => {
    const used = number(meter?.usedMicroCents)
    const limit = number(meter?.limitMicroCents)
    return used !== null && limit > 0 ? quota(label, (100 * used) / limit, meter.resetsAt) : null
  }
  const windows = [window(meters?.fiveHour, '5-hour'), window(meters?.week, 'Weekly'), window(meters?.month, 'Monthly')]
  return windows[0] && windows[1] ? windows.filter(Boolean) : []
}
// Workspace ids in the console's server-function answer (JS-serialized).
export function openCodeWorkspaceIds(text) {
  const ids = []
  for (const match of String(text).slice(0, 1000000).matchAll(/\bid\s*:\s*["']((?:wrk|wk)_[a-zA-Z0-9]+)["']/g))
    if (!ids.includes(match[1]) && ids.length < 20) ids.push(match[1])
  return ids
}
// ZCode's Coding Plan (Z.ai / BigModel): /api/monitor/usage/quota/limit, after
// Orca's zcode-usage-fetcher.ts. Token or credit limits give the 5-hour and
// weekly windows; TIME_LIMIT is the monthly tool quota. null: not a valid answer.
const ZCODE_UNITS = { 1: 1440, 3: 60, 5: 1, 6: 10080 }
function zcodeMinutes(l) {
  // Z.ai encodes its monthly marker as "one minute".
  if (l.type === 'TIME_LIMIT' && l.unit === 5 && l.number === 1) return 30 * 24 * 60
  const unit = number(l.unit)
  const count = number(l.number)
  if (unit === null || count === null || !Number.isInteger(count) || count <= 0) return null
  return ZCODE_UNITS[unit] ? count * ZCODE_UNITS[unit] : null
}
function zcodeUsed(l) {
  const total = number(l.usage)
  if (total !== null && total > 0) {
    const current = number(l.currentValue)
    const remaining = number(l.remaining)
    if (current !== null || remaining !== null) return (100 * (current ?? total - (remaining ?? 0))) / total
  }
  return number(l.percentage)
}
export function mapZcode(data, now = Date.now()) {
  const code = data?.code
  const limits = data?.data?.limits
  if (data?.success !== true || (code !== undefined && code !== 0 && code !== 200) || !Array.isArray(limits)) return null
  const window = (l, label) => {
    if (!l || typeof l !== 'object') return null
    const minutes = zcodeMinutes(l)
    const used = zcodeUsed(l)
    if (minutes === null || used === null) return null
    const reset = timestamp(l.nextResetTime)
    // A 5-hour window resetting later than 5 hours from now: not its reset.
    return { minutes, value: quota(label, used, minutes === 300 && reset !== null && reset > now + 301 * 60000 ? null : reset) }
  }
  const plan = limits
    .slice(0, 100)
    .filter((l) => l?.type === 'TOKENS_LIMIT' || l?.type === 'CREDIT_LIMIT')
    .map((l) => window(l, ''))
    .filter(Boolean)
  const session = plan.find((w) => w.minutes === 300)
  const weekly = plan.find((w) => w.minutes === 10080)
  const monthly = window(limits.find((l) => l?.type === 'TIME_LIMIT'), 'Monthly')
  return [
    session && { ...session.value, label: '5-hour' },
    weekly && { ...weekly.value, label: 'Weekly' },
    monthly?.value
  ].filter(Boolean)
}
