// When an agent's usage limit resets, from what the agent says. Each CLI words
// its reset time its own way:
//   Claude Code: "resets 3pm (America/Toronto)", "resets Oct 17, 11pm", and
//                its older "Claude AI usage limit reached|1760000000"
//   Codex:       "try again at 8:47 PM.", "Try again in 2 days 3 hours.",
//                and its rollout's rate_limits resets_at (epoch seconds)
//   Muse:        "Your usage window resets at 2026-10-19T15:13:21Z."
// A clock time with no day is the next one to come (today, else tomorrow); a
// day with no year is this year's, else next year's. A time zone the agent
// names counts; otherwise the computer's own. No Node or Electron here: main
// and renderer both use it.

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
// Further than this is not a usage limit's reset (a misread number).
const MAX_AHEAD = 40 * DAY

// The wall clock of `ms` in a time zone: { y, mo (0-11), d, h, mi, s }.
function wallClock(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric'
  }).formatToParts(new Date(ms))
  const get = (type) => Number(parts.find((p) => p.type === type)?.value)
  return { y: get('year'), mo: get('month') - 1, d: get('day'), h: get('hour') % 24, mi: get('minute'), s: get('second') }
}

function validZone(timeZone) {
  if (typeof timeZone !== 'string' || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){1,2}$/.test(timeZone)) return null
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return timeZone
  } catch {
    return null
  }
}

// That wall time as a moment: in the named zone, else the computer's own.
function moment(y, mo, d, h, mi, timeZone) {
  if (!timeZone) return new Date(y, mo, d, h, mi, 0, 0).getTime()
  const guess = Date.UTC(y, mo, d, h, mi)
  const offsetAt = (t) => {
    const w = wallClock(t, timeZone)
    return Date.UTC(w.y, w.mo, w.d, w.h, w.mi, w.s) - Math.floor(t / 1000) * 1000
  }
  // Twice: the offset at the guess may differ from the one at the answer
  // (a change of daylight saving time between them).
  const first = guess - offsetAt(guess)
  return guess - offsetAt(first)
}

function today(now, timeZone) {
  if (timeZone) return wallClock(now, timeZone)
  const d = new Date(now)
  return { y: d.getFullYear(), mo: d.getMonth(), d: d.getDate() }
}

// "3pm", "8:47 PM", "11 a.m.", "15:00" -> { h, mi } or null.
function clock(text) {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(?:([ap])\.?\s?m\.?)?$/i.exec(text.trim())
  if (!m) return null
  let h = Number(m[1])
  const mi = m[2] ? Number(m[2]) : 0
  if (mi > 59) return null
  if (m[3]) {
    if (h < 1 || h > 12) return null
    h = (h % 12) + (m[3].toLowerCase() === 'p' ? 12 : 0)
  } else if (!m[2] || h > 23) return null
  return { h, mi }
}

// "in 2 days 3 hours", "45 minutes", "1 hr, 5 mins" -> ms or null.
function duration(text) {
  const s = text.replace(/^in\s+/i, '').trim()
  if (!s) return null
  let total = 0
  let rest = s
  const unit = /^(\d+)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b\s*,?\s*(?:and\s+)?/i
  for (let i = 0; i < 6 && rest; i++) {
    const m = unit.exec(rest)
    if (!m) return null
    const n = Number(m[1])
    const u = m[2].toLowerCase()
    total += u.startsWith('d') ? n * DAY : u.startsWith('h') ? n * HOUR : u.startsWith('m') ? n * MINUTE : n * 1000
    rest = rest.slice(m[0].length)
  }
  return rest ? null : total
}

// The time zone written after a reset time: "resets 3pm (America/Toronto)".
export function resetZone(text) {
  const m = /\(([A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){1,2})\)/.exec(String(text || ''))
  return m ? validZone(m[1]) : null
}

// -> the reset moment (ms since 1970) or null when the text says none.
// timeZone: the zone the agent named (resetZone), else the computer's.
export function parseLimitReset(text, { now = Date.now(), timeZone = null } = {}) {
  if (Number.isFinite(text)) return text > 1e12 ? text : text > 1e9 ? text * 1000 : null
  let s = String(text || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!s || s.length > 160) return null
  const zone = validZone(timeZone) || resetZone(s)
  s = s
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/[\s.,;]+$/, '')
    .trim()
  let at = null
  if (/^\d{10}$/.test(s)) at = Number(s) * 1000
  else if (/^\d{13}$/.test(s)) at = Number(s)
  else if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(s)) at = Date.parse(s.replace(' ', 'T'))
  else if (/^in\s/i.test(s) || /^\d+\s*(?:days?|hours?|hrs?|minutes?|mins?)\b/i.test(s)) {
    const ms = duration(s)
    if (ms !== null) at = now + ms
  } else {
    const dated = /^(?:on\s+)?([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:(?:,|\s+at)?\s+(.+))?$/i.exec(s)
    if (dated) {
      const mo = MONTHS.indexOf(dated[1].slice(0, 3).toLowerCase())
      const d = Number(dated[2])
      const time = dated[3] ? clock(dated[3]) : { h: 0, mi: 0 }
      if (mo >= 0 && d >= 1 && d <= 31 && time) {
        const year = today(now, zone).y
        at = moment(year, mo, d, time.h, time.mi, zone)
        // Days ago: next year's (a reset on Jan 2 read on Dec 30).
        if (at < now - 2 * DAY) at = moment(year + 1, mo, d, time.h, time.mi, zone)
      }
    } else {
      const time = clock(s.replace(/^at\s+/i, ''))
      if (time) {
        const t = today(now, zone)
        at = moment(t.y, t.mo, t.d, time.h, time.mi, zone)
        // Gone by (beyond a minute's slack): tomorrow's.
        if (at < now - MINUTE) at = moment(t.y, t.mo, t.d + 1, time.h, time.mi, zone)
      }
    }
  }
  if (!Number.isFinite(at) || at > now + MAX_AHEAD || at < now - 2 * DAY) return null
  return at
}

// The reset moment as a short local time: "15:00" today, "Tue 15:00" this
// week, "Oct 17, 15:00" later. locale: the interface's (intlLocale()).
export function formatLimitReset(at, { now = Date.now(), locale = undefined } = {}) {
  if (!Number.isFinite(at)) return ''
  try {
    const time = new Date(at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
    const a = new Date(at)
    const b = new Date(now)
    if (a.toDateString() === b.toDateString()) return time
    if (at - now < 6 * DAY && at > now) return `${a.toLocaleDateString(locale, { weekday: 'short' })} ${time}`
    return `${a.toLocaleDateString(locale, { month: 'short', day: 'numeric' })}, ${time}`
  } catch {
    return ''
  }
}
