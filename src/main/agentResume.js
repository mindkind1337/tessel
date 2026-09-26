// Resuming the conversations of the other agents (Claude Code and Codex are
// in agentSessions.js), so a reopened pane goes on where it was:
//   Gemini CLI  we choose the id (gemini --session-id <uuid>), resumed with
//               gemini --resume <uuid>; its file only exists once you wrote
//               to it: ~/.gemini/tmp/<project>/chats/session-<time>-<id8>.jsonl
//   OpenCode    picks its own id: found in its database (session table, by
//               folder and start time), resumed with opencode --session <id>
//   Cline       picks its own id: found in <data>/db/sessions.db, resumed
//               with cline --id <id>
//   Copilot CLI picks its own id: found in ~/.copilot/session-state/<id>/
//               (events.jsonl starts with session.start), copilot --resume <id>
//   Qwen Code   like Gemini (qwen --session-id / --resume <uuid>)
//   Kimi Code   picks its own id: ~/.kimi-code/sessions/<workspace>/<id>/state.json,
//               resumed with kimi --session <id>
// Each "find" takes the session started in the pane's folder at or after the
// pane started, not already used by another pane (like findCodexSession).
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { findCodexSession, isUuid } from './agentSessions'
import { clineDataDir } from './jsonAgents'

const SLACK = 5000

function normDir(p) {
  return String(p || '')
    .replace(/\//g, '\\')
    .replace(/\\+$/, '')
    .toLowerCase()
}

// Session ids an agent hands out: letters, digits, _ and -, nothing a shell
// could read as anything else.
export function isSessionId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{6,80}$/.test(id)
}

function sqliteOf() {
  return process.getBuiltinModule ? process.getBuiltinModule('node:sqlite') : null
}

function readRows(file, sql, params = []) {
  const sqlite = sqliteOf()
  if (!sqlite || !fs.existsSync(file)) return []
  let db
  try {
    db = new sqlite.DatabaseSync(file, { readOnly: true })
    return db.prepare(sql).all(...params)
  } catch {
    return [] // busy, or another layout
  } finally {
    try {
      if (db) db.close()
    } catch {
      /* closed */
    }
  }
}

// The choice, from { id, cwd, time (ms start), updated (ms) } candidates.
export function pickSession(list, { cwd, since, exclude = [], latest = false, activeSince = 0 } = {}) {
  if (!cwd || !Number.isFinite(since)) return null
  const want = normDir(cwd)
  const skip = new Set(exclude)
  let best = null
  for (const s of list || []) {
    if (!s || !isSessionId(s.id) || skip.has(s.id)) continue
    if (normDir(s.cwd) !== want) continue
    if (!s.time || s.time < since - SLACK) continue
    if (activeSince && (s.updated || s.time) < activeSince) continue
    if (!best || (latest ? s.time > best.time : s.time < best.time)) best = s
  }
  return best ? best.id : null
}

// --- Gemini CLI ------------------------------------------------------------------

export function geminiSessionExists(id, home = os.homedir()) {
  if (!isUuid(id)) return false
  const tmp = join(home, '.gemini', 'tmp')
  let projects
  try {
    projects = fs.readdirSync(tmp, { withFileTypes: true }).filter((d) => d.isDirectory())
  } catch {
    return false
  }
  const tail = `-${id.slice(0, 8)}.jsonl`
  for (const p of projects) {
    let files
    try {
      files = fs.readdirSync(join(tmp, p.name, 'chats'))
    } catch {
      continue
    }
    for (const f of files) {
      if (!f.startsWith('session-') || !f.endsWith(tail)) continue
      // The first 8 characters could match another id: check the whole one.
      try {
        const fd = fs.openSync(join(tmp, p.name, 'chats', f), 'r')
        const buf = Buffer.alloc(4096)
        const n = fs.readSync(fd, buf, 0, buf.length, 0)
        fs.closeSync(fd)
        if (buf.subarray(0, n).toString('utf8').includes(id)) return true
      } catch {
        /* unreadable: not this one */
      }
    }
  }
  return false
}

// --- OpenCode ----------------------------------------------------------------------

export function opencodeSessions(home = os.homedir()) {
  const dataDir = process.env.XDG_DATA_HOME || join(home, '.local', 'share')
  return readRows(
    join(dataDir, 'opencode', 'opencode.db'),
    'SELECT id, directory, time_created, time_updated FROM session WHERE parent_id IS NULL ORDER BY time_created DESC LIMIT 200'
  ).map((r) => ({ id: r.id, cwd: r.directory, time: Number(r.time_created) || 0, updated: Number(r.time_updated) || 0 }))
}

// --- Cline ----------------------------------------------------------------------------

export function clineSessions(home = os.homedir()) {
  return readRows(
    join(clineDataDir(home), 'db', 'sessions.db'),
    'SELECT session_id, cwd, started_at, updated_at FROM sessions WHERE is_subagent = 0 AND parent_session_id IS NULL ORDER BY started_at DESC LIMIT 200'
  ).map((r) => ({
    id: r.session_id,
    cwd: r.cwd,
    time: Date.parse(r.started_at || '') || 0,
    updated: Date.parse(r.updated_at || '') || 0
  }))
}

// --- Copilot CLI --------------------------------------------------------------------

function firstLine(file) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(16 * 1024)
    const n = fs.readSync(fd, buf, 0, buf.length, 0)
    const text = buf.subarray(0, n).toString('utf8')
    const nl = text.indexOf('\n')
    return nl >= 0 ? text.slice(0, nl) : text
  } catch {
    return ''
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

export function copilotSessions(home = os.homedir(), since = 0) {
  const root = join(home, '.copilot', 'session-state')
  let dirs
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())
  } catch {
    return []
  }
  const out = []
  for (const d of dirs) {
    const events = join(root, d.name, 'events.jsonl')
    let updated = 0
    try {
      updated = fs.statSync(events).mtimeMs
    } catch {
      continue
    }
    if (updated < since - SLACK) continue // older than the pane: skip reading it
    try {
      const o = JSON.parse(firstLine(events))
      const data = o && o.type === 'session.start' ? o.data || {} : null
      if (!data) continue
      out.push({
        id: String(data.sessionId || d.name),
        cwd: (data.context && data.context.cwd) || '',
        time: Date.parse(data.startTime || o.timestamp || '') || 0,
        updated
      })
    } catch {
      /* not a session */
    }
  }
  return out
}

// --- Qwen Code ------------------------------------------------------------------------
// Like Gemini: we choose the id (qwen --session-id), resumed with qwen --resume
// once its file exists: <QWEN_HOME or ~/.qwen>/projects/<project>/chats/<id>.jsonl

export function qwenSessionExists(id, home = os.homedir()) {
  if (!isUuid(id)) return false
  const root = join(process.env.QWEN_HOME || join(home, '.qwen'), 'projects')
  let projects
  try {
    projects = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())
  } catch {
    return false
  }
  return projects.some(
    (p) =>
      fs.existsSync(join(root, p.name, 'chats', `${id}.jsonl`)) ||
      fs.existsSync(join(root, p.name, 'chats', 'archive', `${id}.jsonl`))
  )
}

// --- Kimi Code ------------------------------------------------------------------------
// Picks its own id: <KIMI_CODE_HOME or ~/.kimi-code>/sessions/<workspace>/<id>/
// state.json (or session-meta/state.json) holds its folder and dates; resumed
// with kimi --session <id>.

function timeOf(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  const t = Date.parse(v || '')
  return Number.isFinite(t) ? t : 0
}

export function kimiSessions(home = os.homedir(), since = 0) {
  const root = join(process.env.KIMI_CODE_HOME || join(home, '.kimi-code'), 'sessions')
  const out = []
  let workspaces
  try {
    workspaces = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.'))
  } catch {
    return out
  }
  for (const ws of workspaces) {
    let sessions
    try {
      sessions = fs.readdirSync(join(root, ws.name), { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    } catch {
      continue
    }
    for (const s of sessions) {
      for (const f of [join(root, ws.name, s.name, 'state.json'), join(root, ws.name, s.name, 'session-meta', 'state.json')]) {
        let stat
        try {
          stat = fs.statSync(f)
        } catch {
          continue
        }
        if (stat.mtimeMs < since - SLACK) break // older than the pane
        try {
          let meta = JSON.parse(fs.readFileSync(f, 'utf8'))
          if (meta && typeof meta.data === 'object' && meta.data && !meta.cwd && !meta.workDir) meta = meta.data
          const custom = meta && typeof meta.custom === 'object' && meta.custom ? meta.custom : {}
          const cwd = meta.cwd || meta.workDir || custom.cwd || ''
          out.push({
            id: s.name,
            cwd,
            time: timeOf(meta.createdAt) || timeOf(meta.createdAtMs) || stat.birthtimeMs || stat.mtimeMs,
            updated: timeOf(meta.updatedAt) || timeOf(meta.updatedAtMs) || stat.mtimeMs
          })
        } catch {
          /* not readable */
        }
        break
      }
    }
  }
  return out
}

// --- All -------------------------------------------------------------------------------

// q: { agent, cwd, since, exclude, latest, activeSince } -> the session id or null
export function findAgentSession(q = {}, home = os.homedir()) {
  const { agent } = q
  if (agent === 'codex') return findCodexSession(q, home)
  if (!q.cwd || !Number.isFinite(q.since)) return null
  if (agent === 'opencode') return pickSession(opencodeSessions(home), q)
  if (agent === 'cline') return pickSession(clineSessions(home), q)
  if (agent === 'copilot') return pickSession(copilotSessions(home, q.since), q)
  if (agent === 'kimi') return pickSession(kimiSessions(home, q.since), q)
  return null
}
