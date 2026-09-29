// Local calendar and project filters shared by the local usage reports.
// These compare recorded metadata only: no directory traversal or auth reads.
import { posix, win32 } from 'path'
import { t } from './i18n'

const object = (value) => value && typeof value === 'object' && !Array.isArray(value)
const windowsPath = (value) =>
  /^[a-z]:[\\/]/i.test(value) || /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(value)

export function usageProjectKey(value) {
  if (typeof value !== 'string' || !value) return ''
  const windows = windowsPath(value)
  const normalized = (windows ? win32 : posix).normalize(value)
  const key = windows ? normalized.replace(/\\/g, '/').toLowerCase() : normalized
  return key.replace(/\/+$/, '') || '/'
}

function absolutePath(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4096 &&
    !/[\x00-\x1f]/.test(value) &&
    (windowsPath(value) || value.startsWith('/'))
  )
}

export function matchesUsageRoots(cwd, roots) {
  if (roots === undefined) return true
  if (!absolutePath(cwd)) return false
  const key = usageProjectKey(cwd)
  return roots.some((root) => {
    const prefix = usageProjectKey(root)
    return key === prefix || key.startsWith(prefix === '/' ? '/' : `${prefix}/`)
  })
}

export function usageDayFormatter(timezone) {
  const format = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  })
  return (value) => {
    const parts = Object.fromEntries(
      format.formatToParts(new Date(value)).map((p) => [p.type, p.value])
    )
    return `${parts.year}-${parts.month}-${parts.day}`
  }
}

function validDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const d = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value
}

export function usageQueryRange(query, today, days = 30) {
  if (!object(query)) throw new Error(t('main.usage.filtersObject', 'Usage filters must be an object.'))
  const start = new Date(`${today}T00:00:00Z`)
  start.setUTCDate(start.getUTCDate() - days + 1)
  const from = query.from === undefined ? start.toISOString().slice(0, 10) : query.from
  const to = query.to === undefined ? today : query.to
  if (
    (from !== null && !validDay(from)) ||
    (to !== null && !validDay(to)) ||
    (from && to && from > to)
  )
    throw new Error(t('main.usage.dateRange', 'Use an inclusive local date range (YYYY-MM-DD).'))
  for (const key of ['cwd', 'model'])
    if (query[key] != null && typeof query[key] !== 'string')
      throw new Error(t('main.usage.filtersText', 'Project and model filters must be text.'))
  if (
    query.roots !== undefined &&
    (!Array.isArray(query.roots) || query.roots.length > 4096 || !query.roots.every(absolutePath))
  )
    throw new Error(t('main.usage.rootsAbsolute', 'Project roots must be an array of absolute paths.'))
  return {
    from,
    to,
    cwd: query.cwd || '',
    model: query.model || '',
    ...(query.roots !== undefined ? { roots: [...new Set(query.roots)] } : {})
  }
}

export function usageScope(range) {
  return range.roots === undefined ? 'all' : 'tessel-worktrees'
}
