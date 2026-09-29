// Codex does not run its Stop hook when a turn ends in an error (for example
// a refused request: the rollout gets `task_complete` with `error`, no hook
// runs). The pane would then show "working" until the next prompt. Codex's own
// session rollout says when the turn ended:
//   <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<time>-<session id>.jsonl
//   ... event_msg task_started { turn_id } ... task_complete { turn_id, error }
//   (or turn_aborted when it was stopped).
// For a managed Codex pane shown working with no hook for a while, the end of
// its current session's rollout is read (bounded, read-only, real paths inside
// the pane's CODEX_HOME, cached by size and mtime); a turn end newer than the
// state's last event becomes a 'RolloutTurnEnd' observation (agentStateModel).
import fs from 'fs'
import { join, relative, isAbsolute, resolve } from 'path'
import { realInside, uuidTime } from './agentChildren'

export const TURN_END_QUIET_MS = 60 * 1000
export const TURN_END_CHECK_MS = 5 * 1000
const TAIL_BYTES = 256 * 1024
const MAX_DAYS = 31
const DAY = 24 * 60 * 60 * 1000
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ROLLOUT = /^rollout-[0-9T-]{10,40}-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i
const TURN = /^[A-Za-z0-9_.:-]{1,160}$/

const eqPath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)
function within(base, p) {
  const rel = relative(base, p)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

// A pane's CODEX_HOME is read only when it is the system Codex home or a
// managed account home (inside Tessel's codex-accounts folder).
export function allowedCodexHome(home, { systemHome, accountsBase } = {}) {
  if (typeof home !== 'string' || !isAbsolute(home)) return false
  const target = resolve(home)
  if (systemHome && eqPath(resolve(systemHome), target)) return true
  if (!accountsBase) return false
  const base = resolve(accountsBase)
  return !eqPath(base, target) && (process.platform === 'win32' ? within(base.toLowerCase(), target.toLowerCase()) : within(base, target))
}

// The last turn event at the end of a rollout: { kind: 'started' | 'complete'
// | 'error' | 'aborted', at, turnId } or null when none is in these lines.
export function lastTurnEvent(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line.includes('"event_msg"')) continue
    let o
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    const p = o && o.type === 'event_msg' && o.payload && typeof o.payload === 'object' ? o.payload : null
    if (!p || !['task_started', 'task_complete', 'turn_aborted'].includes(p.type)) continue
    const at = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN
    const turnId = typeof p.turn_id === 'string' && TURN.test(p.turn_id) ? p.turn_id : null
    const kind =
      p.type === 'task_started' ? 'started' : p.type === 'turn_aborted' ? 'aborted' : p.error ? 'error' : 'complete'
    return { kind, at: Number.isFinite(at) ? at : null, turnId }
  }
  return null
}

function readTail(file, size) {
  const len = Math.min(size, TAIL_BYTES)
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(len)
    const n = fs.readSync(fd, buf, 0, len, size - len)
    const lines = buf.toString('utf8', 0, n).split('\n')
    if (size > len) lines.shift() // cut in the middle
    return lines.filter((l) => l.trim())
  } finally {
    fs.closeSync(fd)
  }
}

function dayDir(sessions, ms) {
  const d = new Date(ms)
  const two = (n) => String(n).padStart(2, '0')
  return join(sessions, String(d.getFullYear()), two(d.getMonth() + 1), two(d.getDate()))
}

export function createRolloutReader({ now = Date.now } = {}) {
  const clock = () => (typeof now === 'function' ? now() : now)
  const paths = new Map() // home|session -> rollout file
  const tails = new Map() // file -> { size, mtimeMs, result }

  function find(base, home, sid) {
    const key = `${base}|${sid}`
    const hit = paths.get(key)
    if (hit && realInside(base, hit, false)) return hit
    paths.delete(key)
    const sessions = join(home, 'sessions')
    if (!realInside(base, sessions, true)) return null
    // A rollout stays in the folder of the day its session began: that day
    // (UUID v7 time) and its neighbours, else the last 31 days, newest first.
    const born = uuidTime(sid)
    const days = born
      ? [born, born - DAY, born + DAY]
      : Array.from({ length: MAX_DAYS }, (_, i) => clock() - i * DAY)
    const seen = new Set()
    for (const t of days) {
      const dir = dayDir(sessions, t)
      if (seen.has(dir)) continue
      seen.add(dir)
      if (!fs.existsSync(dir) || !realInside(base, dir, true)) continue
      let names
      try {
        names = fs.readdirSync(dir)
      } catch {
        continue
      }
      for (const n of names) {
        const m = ROLLOUT.exec(n)
        if (!m || m[1].toLowerCase() !== sid) continue
        const file = join(dir, n)
        if (!realInside(base, file, false)) continue
        if (paths.size > 256) paths.clear()
        paths.set(key, file)
        return file
      }
    }
    return null
  }

  // -> the last turn event of that session's rollout in that home, or null.
  function read(home, sessionId) {
    if (typeof home !== 'string' || !isAbsolute(home) || !ID.test(String(sessionId))) return null
    const sid = String(sessionId).toLowerCase()
    let base
    try {
      base = fs.realpathSync.native(home)
    } catch {
      return null
    }
    const file = find(base, home, sid)
    if (!file) return null
    let st
    try {
      st = fs.statSync(file)
    } catch {
      return null
    }
    const cached = tails.get(file)
    if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) return cached.result
    let result = null
    try {
      result = lastTurnEvent(readTail(file, st.size))
    } catch {
      return null // being written: next time
    }
    if (tails.size > 256) tails.clear()
    tails.set(file, { size: st.size, mtimeMs: st.mtimeMs, result })
    return result
  }
  return { read }
}

// One check for every candidate pane the store gives: a finished last turn in
// its rollout, newer than its state's last event, is sent to the store.
// homeFor(paneId, launchToken) -> the pane's CODEX_HOME (checked) or null.
export function createCodexTurnEnd({ store, homeFor, reader = createRolloutReader(), quietMs = TURN_END_QUIET_MS }) {
  let running = false
  return async function check() {
    if (running) return 0
    running = true
    let sent = 0
    try {
      for (const c of store.turnEndCandidates(quietMs)) {
        const home = homeFor(c.paneId, c.launchToken)
        if (!home) continue
        const end = reader.read(home, c.sessionId)
        if (!end || end.kind === 'started' || end.at === null || end.at <= c.lastEventAt) continue
        if (c.turnId && end.turnId && c.turnId !== end.turnId) continue
        try {
          await store.rolloutTurnEnd(c.paneId, c.launchToken, {
            sessionId: c.sessionId,
            at: end.at,
            turnId: end.turnId,
            ended: end.kind
          })
          sent++
        } catch {
          /* the next check retries */
        }
      }
    } finally {
      running = false
    }
    return sent
  }
}
