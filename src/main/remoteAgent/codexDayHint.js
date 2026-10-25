// Where a Codex rollout is on a host: Codex writes a conversation's rollout
// in sessions/YYYY/MM/DD (the day it started) and its id is a UUIDv7, whose
// first 48 bits are that moment in milliseconds. The day folders around it
// (the host's time zone is not known here: the day before and after too) are
// looked at first (remoteShell.js __t_tfile), before a search of the whole
// folder, which on a host with many sessions held its session for seconds
// at every read of a Codex conversation.
const DAY_MS = 86_400_000
const V7 = /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const EARLIEST = Date.UTC(2023, 0, 1)

const dayOf = (ms) => {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}`
}

// id -> "YYYY/MM/DD:YYYY/MM/DD:YYYY/MM/DD" (its day first), or '' (not a
// UUIDv7, or a time that cannot be a session's).
export function codexDayHint(id, now = Date.now()) {
  const m = V7.exec(String(id || ''))
  if (!m) return ''
  const ms = parseInt(m[1] + m[2], 16)
  if (!Number.isSafeInteger(ms) || ms < EARLIEST || ms > now + 2 * DAY_MS) return ''
  return [dayOf(ms), dayOf(ms - DAY_MS), dayOf(ms + DAY_MS)].join(':')
}
