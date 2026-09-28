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
    add('Monthly', ratio(plan?.used, plan?.limit) ?? number(plan?.totalPercentUsed))
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
export function mapMiniMax(data, now = Date.now()) {
  const rows = (Array.isArray(data?.model_remains) ? data.model_remains : []).filter(
    (d) =>
      typeof d?.model_name === 'string' &&
      number(d.current_interval_remaining_percent) !== null &&
      number(d.start_time) !== null &&
      number(d.end_time) !== null
  )
  const d = rows.find((r) => r.model_name === 'general') || (rows.length === 1 ? rows[0] : null)
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
