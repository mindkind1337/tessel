// The sub-agents a Claude Code conversation started (its Task / Agent tool),
// read from Claude Code's own files, like its "agents" list shows them:
//   <claude dir>/projects/<project>/<session id>/subagents/agent-<id>.meta.json
//     { agentType, description }
//   .../agent-<id>.jsonl   its transcript (timestamps, token usage)
// Read-only; only the first line and the end of each transcript are read.
// Codex (spawn_agent threads), OpenCode and Cline (child sessions) below.
import fs from 'fs'
import os from 'os'
import { join, relative, isAbsolute } from 'path'
import { readRows } from './fileRead'

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TAIL_BYTES = 96 * 1024
const MAX_AGENTS = 50
// Not finished, and nothing written for this long: quiet (maybe a long tool,
// maybe stopped: nothing proves which, so it is never shown as finished).
const QUIET_MS = 15 * 60 * 1000

function within(base, p) {
  const rel = relative(base, p)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

// A real folder or file of the account: no link or junction, and its real
// path inside the account's Claude folder (nothing is read outside it).
export function realInside(base, p, dir) {
  try {
    const st = fs.lstatSync(p)
    if (st.isSymbolicLink() || (dir ? !st.isDirectory() : !st.isFile())) return false
    return within(base, fs.realpathSync.native(p))
  } catch {
    return false
  }
}

// -> { base, dir } (the account folder's real path, the session's folder) or null.
function sessionDir(claudeDir, sessionId) {
  let base
  try {
    base = fs.realpathSync.native(claudeDir)
  } catch {
    return null
  }
  const root = join(claudeDir, 'projects')
  if (!realInside(base, root, true)) return null
  let dirs
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return null
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    const project = join(root, d.name)
    const dir = join(project, sessionId)
    if (!fs.existsSync(join(dir, 'subagents'))) continue
    if (realInside(base, project, true) && realInside(base, dir, true) && realInside(base, join(dir, 'subagents'), true)) return { base, dir }
  }
  return null
}

function readStart(file) {
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(8192)
    const n = fs.readSync(fd, buf, 0, buf.length, 0)
    const first = buf.toString('utf8', 0, n).split('\n')[0]
    const m = /"timestamp":"([^"]+)"/.exec(first)
    return m ? Date.parse(m[1]) || null : null
  } finally {
    fs.closeSync(fd)
  }
}

function readTail(file, size, max = TAIL_BYTES) {
  const len = Math.min(size, max)
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, size - len)
    const lines = buf.toString('utf8').split('\n')
    if (size > len) lines.shift() // cut in the middle
    return lines.filter((l) => l.trim())
  } finally {
    fs.closeSync(fd)
  }
}

// From the end of a transcript: finished (its last message ended the turn and
// nothing came after), when it last wrote, and the tokens of its last turn
// (what it holds in context, as Claude Code shows it).
export function summarizeTail(lines) {
  let done = false
  let decided = false
  let last = null
  let tokens = null
  let model = null
  for (let i = lines.length - 1; i >= 0; i--) {
    let o
    try {
      o = JSON.parse(lines[i])
    } catch {
      continue
    }
    if (!last && o.timestamp) last = Date.parse(o.timestamp) || null
    if (!decided) {
      if (o.type === 'assistant') {
        done = o.message && o.message.stop_reason === 'end_turn'
        decided = true
      } else if (o.type === 'user') {
        done = false
        decided = true
      }
    }
    if (tokens === null && o.type === 'assistant' && o.message && o.message.usage) {
      const u = o.message.usage
      tokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0)
    }
    // The model it runs on ("<synthetic>" marks Claude Code's own notes).
    if (model === null && o.type === 'assistant' && o.message && typeof o.message.model === 'string' && /^[\w.[\]:/@-]{1,80}$/.test(o.message.model) && o.message.model !== '<synthetic>') {
      model = o.message.model
    }
    if (decided && last && tokens !== null && model !== null) break
  }
  return { done, last, tokens, model }
}

// -> [{ id, type, title, state: 'running'|'done'|'quiet', startedAt, endedAt,
// lastAt, tokens }] newest first. endedAt only for a finished one; a quiet one
// (nothing written for 15 min, not finished) keeps when it last wrote.
export function claudeSubagents(sessionId, claudeDir = join(os.homedir(), '.claude'), now = Date.now()) {
  if (!ID.test(String(sessionId))) return []
  const found = sessionDir(claudeDir, sessionId)
  if (!found) return []
  const { base, dir } = found
  const sub = join(dir, 'subagents')
  let names
  try {
    names = fs.readdirSync(sub).filter((n) => /^agent-[A-Za-z0-9_-]{1,80}\.jsonl$/.test(n))
  } catch {
    return []
  }
  const out = []
  for (const n of names) {
    const file = join(sub, n)
    const id = n.slice(6, -6)
    if (!realInside(base, file, false)) continue
    let st
    try {
      st = fs.statSync(file)
    } catch {
      continue
    }
    let meta = {}
    const metaFile = join(sub, `agent-${id}.meta.json`)
    try {
      if (realInside(base, metaFile, false)) meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) || {}
    } catch {
      meta = {}
    }
    let startedAt = null
    let tail = { done: false, last: null, tokens: null, model: null }
    try {
      startedAt = readStart(file)
      tail = summarizeTail(readTail(file, st.size))
    } catch {
      // being written: next time
    }
    const last = tail.last || st.mtimeMs
    const lastAt = Math.max(last, st.mtimeMs)
    const state = tail.done ? 'done' : now - lastAt > QUIET_MS ? 'quiet' : 'running'
    out.push({
      id,
      type: typeof meta.agentType === 'string' ? meta.agentType.slice(0, 60) : 'agent',
      title: typeof meta.description === 'string' ? meta.description.slice(0, 200) : '',
      state,
      startedAt: startedAt || st.birthtimeMs || null,
      endedAt: state === 'done' ? last : null,
      lastAt,
      tokens: tail.tokens,
      model: tail.model
    })
  }
  out.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
  return out.slice(0, MAX_AGENTS)
}

// ---------------------------------------------------------------------------
// Codex: the threads a conversation spawned (its spawn_agent tool, "multi
// agent") are rollouts of their own in <CODEX_HOME>/sessions/YYYY/MM/DD/
// (the day they started, not the parent's day). Their first line
// (session_meta) names the conversation:
//   { id, session_id: <root conversation>, parent_thread_id,
//     thread_source: "subagent", agent_nickname, agent_path: "/root/<task>",
//     source: { subagent: { thread_spawn: { agent_role, depth, ... } } },
//     timestamp }
// Then, per turn, event_msg task_started ... task_complete (or turn_aborted),
// turn_context { model }, event_msg token_count { info.last_token_usage }.
// Read-only: the head of each rollout once (cached), the end of a child's.
const CODEX_TAIL_BYTES = 256 * 1024
const CODEX_HEAD_BYTES = 256 * 1024
const CODEX_MAX_DAYS = 60
const CODEX_MAX_FILES = 3000
const DAY = 24 * 60 * 60 * 1000
const ROLLOUT = /^rollout-[0-9T-]{10,40}-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i
// file -> its head facts (a rollout's first line never changes).
const headCache = new Map()

// A UUID v7 starts with its creation time (ms): the first day to look at.
export function uuidTime(id) {
  const s = String(id)
  if (!ID.test(s) || s[14] !== '7') return null
  const ms = parseInt(s.slice(0, 8) + s.slice(9, 13), 16)
  return Number.isFinite(ms) && ms > 0 ? ms : null
}

const str = (v, max) => (typeof v === 'string' && v ? v.slice(0, max) : null)
const modelName = (v) => (typeof v === 'string' && /^[\w.[\]:/@-]{1,80}$/.test(v) ? v : null)

function codexModelOf(e) {
  const p = e && e.payload
  if (!p) return null
  if (e.type === 'turn_context') return modelName(p.model)
  if (p.type === 'thread_settings_applied' && p.thread_settings) return modelName(p.thread_settings.model)
  return null
}

// The start of a rollout -> a sub-agent's facts, or { child: false }; null
// when its first line is not complete yet (being written).
export function parseCodexHead(text) {
  const nl = text.indexOf('\n')
  if (nl < 0) return null
  let o
  try {
    o = JSON.parse(text.slice(0, nl))
  } catch {
    return { child: false }
  }
  const p = (o && o.type === 'session_meta' && o.payload) || null
  if (!p) return { child: false }
  const spawn = (p.source && typeof p.source === 'object' && p.source.subagent && p.source.subagent.thread_spawn) || {}
  const parent = str(p.parent_thread_id, 40) || str(spawn.parent_thread_id, 40)
  if (p.thread_source !== 'subagent' && !parent) return { child: false }
  // The last model it was set to in the lines read (a forked one starts with
  // its parent's history, then its own settings).
  let model = null
  for (const l of text.slice(nl + 1).split('\n')) {
    if (!l.includes('"model"')) continue
    try {
      model = codexModelOf(JSON.parse(l)) || model
    } catch {
      // cut at the end
    }
  }
  const at = typeof p.timestamp === 'string' ? p.timestamp : o.timestamp
  return {
    child: true,
    id: str(p.id, 40),
    root: str(p.session_id, 40),
    parent,
    nickname: str(p.agent_nickname, 60) || str(spawn.agent_nickname, 60),
    path: str(p.agent_path, 200) || str(spawn.agent_path, 200),
    role: str(spawn.agent_role, 60) || str(p.agent_role, 60),
    startedAt: (typeof at === 'string' && Date.parse(at)) || null,
    model
  }
}

function readHead(file) {
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(CODEX_HEAD_BYTES)
    const n = fs.readSync(fd, buf, 0, buf.length, 0)
    return buf.toString('utf8', 0, n)
  } finally {
    fs.closeSync(fd)
  }
}

function codexHead(file) {
  const hit = headCache.get(file)
  if (hit) return hit
  let head
  try {
    head = parseCodexHead(readHead(file))
  } catch {
    return null
  }
  if (!head) return null
  if (headCache.size > 5000) headCache.clear()
  headCache.set(file, head)
  return head
}

// From the end of a child's rollout: finished (its last turn completed or was
// stopped, nothing started since), when it last wrote, the tokens of its last
// request (what it holds in context) and its model.
export function summarizeCodexTail(lines) {
  let done = false
  let decided = false
  let last = null
  let tokens = null
  let model = null
  for (let i = lines.length - 1; i >= 0; i--) {
    let o
    try {
      o = JSON.parse(lines[i])
    } catch {
      continue
    }
    const p = (o && o.payload) || {}
    if (!last && o.timestamp) last = Date.parse(o.timestamp) || null
    if (!decided && o.type === 'event_msg') {
      if (p.type === 'task_complete' || p.type === 'turn_aborted') {
        done = true
        decided = true
      } else if (p.type === 'task_started') {
        decided = true
      }
    }
    if (tokens === null && o.type === 'event_msg' && p.type === 'token_count' && p.info && p.info.last_token_usage) {
      const u = p.info.last_token_usage
      const n = Number(u.total_tokens) || (Number(u.input_tokens) || 0) + (Number(u.output_tokens) || 0)
      if (n > 0) tokens = n
    }
    if (model === null) model = codexModelOf(o)
    if (decided && last && tokens !== null && model !== null) break
  }
  return { done, last, tokens, model }
}

function dayDir(sessions, ms) {
  const d = new Date(ms)
  const two = (n) => String(n).padStart(2, '0')
  return join(sessions, String(d.getFullYear()), two(d.getMonth() + 1), two(d.getDate()))
}

// -> the same rows as claudeSubagents: type is its role ("default" when the
// parent gave none), title the task name the parent gave it and its nickname.
// Nested ones (a child's children) share the conversation's session_id.
export function codexSubagents(sessionId, codexDir = join(os.homedir(), '.codex'), now = Date.now()) {
  if (!ID.test(String(sessionId))) return []
  const sid = String(sessionId).toLowerCase()
  let base
  try {
    base = fs.realpathSync.native(codexDir)
  } catch {
    return []
  }
  const sessions = join(codexDir, 'sessions')
  if (!realInside(base, sessions, true)) return []
  const born = uuidTime(sid)
  // Children start after their parent: from the day before it (time zones)
  // to tomorrow, at most the last 60 days.
  const from = Math.max((born || now) - DAY, now - CODEX_MAX_DAYS * DAY)
  const seenDirs = new Set()
  const out = []
  let scanned = 0
  for (let t = from; t <= now + DAY && scanned < CODEX_MAX_FILES; t += DAY) {
    const dir = dayDir(sessions, t)
    if (seenDirs.has(dir)) continue
    seenDirs.add(dir)
    if (!fs.existsSync(dir) || !realInside(base, dir, true)) continue
    let names
    try {
      names = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const n of names) {
      const m = ROLLOUT.exec(n)
      if (!m || m[1].toLowerCase() === sid) continue
      if (++scanned > CODEX_MAX_FILES) break
      const file = join(dir, n)
      let st
      try {
        st = fs.statSync(file)
      } catch {
        continue
      }
      // Last written before the conversation began: not one of its children.
      if (born && st.mtimeMs < born - 60000) continue
      if (!realInside(base, file, false)) continue
      const head = codexHead(file)
      if (!head || !head.child) continue
      const root = head.root && head.root.toLowerCase()
      const parent = head.parent && head.parent.toLowerCase()
      if (root !== sid && parent !== sid) continue
      let tail = { done: false, last: null, tokens: null, model: null }
      try {
        tail = summarizeCodexTail(readTail(file, st.size, CODEX_TAIL_BYTES))
      } catch {
        // being written: next time
      }
      const last = tail.last || st.mtimeMs
      const lastAt = Math.max(last, st.mtimeMs)
      const state = tail.done ? 'done' : now - lastAt > QUIET_MS ? 'quiet' : 'running'
      const task = head.path ? head.path.split('/').filter(Boolean).pop() || '' : ''
      const title = task && head.nickname ? `${task} (${head.nickname})` : task || head.nickname || ''
      out.push({
        id: m[1].toLowerCase(),
        type: head.role || 'default',
        title: title.slice(0, 200),
        state,
        startedAt: head.startedAt || st.birthtimeMs || null,
        endedAt: state === 'done' ? last : null,
        lastAt,
        tokens: tail.tokens,
        model: tail.model || head.model || null
      })
    }
  }
  out.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
  return out.slice(0, MAX_AGENTS)
}

export function _clearCodexCacheForTest() {
  headCache.clear()
}

// ---------------------------------------------------------------------------
// Agents that keep their sessions in a SQLite database, a sub-agent being a
// session whose parent is the conversation. Read-only (readRows opens the
// database read-only), one bounded query per call; the database must be a
// real file inside the agent's data folder.
function dbInside(root, sub, name) {
  let base
  try {
    base = fs.realpathSync.native(root)
  } catch {
    return null
  }
  const dir = join(root, sub)
  const file = join(dir, name)
  return realInside(base, dir, true) && realInside(base, file, false) ? file : null
}

const SQL_ID = /^[A-Za-z0-9_-]{6,80}$/
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null)
const firstLine = (s, max) => (typeof s === 'string' ? s.trim().split(/\r?\n/)[0].slice(0, max) : '')

// OpenCode (its task tool): <data>/opencode/opencode.db, table session
// { id, parent_id, title, agent, model, time_created, time_updated (ms) };
// its last message (table message, data JSON) says whether it is done:
// { role: 'assistant', time: { created, completed }, finish, tokens, modelID }.
export function summarizeOpencodeMessage(data) {
  let m
  try {
    m = typeof data === 'string' ? JSON.parse(data) : data
  } catch {
    m = null
  }
  if (!m || typeof m !== 'object') return { done: false, endedAt: null, tokens: null, model: null }
  const assistant = m.role === 'assistant'
  const completed = assistant && m.time ? num(m.time.completed) : null
  // A finished reply that asked for tools is followed by another one.
  const done = !!(assistant && ((completed && m.finish && m.finish !== 'tool-calls') || m.error))
  let tokens = null
  if (assistant && m.tokens) {
    const tk = m.tokens
    const n = (num(tk.input) || 0) + (num(tk.output) || 0) + ((tk.cache && (num(tk.cache.read) || 0) + (num(tk.cache.write) || 0)) || 0)
    if (n > 0) tokens = n
  }
  return { done, endedAt: done ? completed || null : null, tokens, model: assistant ? modelName(m.modelID) : null }
}

function opencodeModel(v) {
  if (typeof v !== 'string' || !v) return null
  try {
    const o = JSON.parse(v)
    if (o && typeof o === 'object') return modelName(o.modelID || o.id)
  } catch {
    // plain text
  }
  return modelName(v.replace(/^.*\//, ''))
}

export function opencodeSubagents(sessionId, dataDir = process.env.XDG_DATA_HOME || join(os.homedir(), '.local', 'share'), now = Date.now()) {
  if (!SQL_ID.test(String(sessionId))) return []
  const db = dbInside(dataDir, 'opencode', 'opencode.db')
  if (!db) return []
  const rows = readRows(
    db,
    `SELECT s.id, s.title, s.agent, s.model, s.time_created, s.time_updated,
       (SELECT m.data FROM message m WHERE m.session_id = s.id ORDER BY m.time_created DESC LIMIT 1) AS last
     FROM session s WHERE s.parent_id = ? ORDER BY s.time_created DESC LIMIT ${MAX_AGENTS}`,
    [String(sessionId)]
  )
  return rows.map((r) => {
    const last = summarizeOpencodeMessage(r.last)
    const lastAt = num(r.time_updated) || num(r.time_created) || null
    const state = last.done ? 'done' : lastAt && now - lastAt > QUIET_MS ? 'quiet' : 'running'
    return {
      id: String(r.id).slice(0, 80),
      type: str(r.agent, 60) || 'subagent',
      title: firstLine(r.title, 200),
      state,
      startedAt: num(r.time_created),
      endedAt: state === 'done' ? last.endedAt || lastAt : null,
      lastAt,
      tokens: last.tokens,
      model: last.model || opencodeModel(r.model)
    }
  })
}

// Cline (its spawn / team tools): <data>/db/sessions.db, table sessions
// { session_id, parent_session_id, is_subagent, status ('running',
// 'completed', ...), started_at, ended_at, updated_at (ISO), model, prompt }.
export function clineSubagents(sessionId, dataDir, now = Date.now()) {
  if (!SQL_ID.test(String(sessionId)) || !dataDir) return []
  const db = dbInside(dataDir, 'db', 'sessions.db')
  if (!db) return []
  const rows = readRows(
    db,
    `SELECT session_id, status, started_at, ended_at, updated_at, model, prompt FROM sessions
     WHERE parent_session_id = ? AND session_id <> parent_session_id ORDER BY started_at DESC LIMIT ${MAX_AGENTS}`,
    [String(sessionId)]
  )
  return rows.map((r) => {
    const ended = Date.parse(r.ended_at || '') || null
    const lastAt = Date.parse(r.updated_at || '') || ended || Date.parse(r.started_at || '') || null
    const done = !!ended || (typeof r.status === 'string' && r.status !== 'running' && r.status !== 'pending')
    const state = done ? 'done' : lastAt && now - lastAt > QUIET_MS ? 'quiet' : 'running'
    return {
      id: String(r.session_id).slice(0, 80),
      type: 'subagent',
      title: firstLine(r.prompt, 200),
      state,
      startedAt: Date.parse(r.started_at || '') || null,
      endedAt: state === 'done' ? ended || lastAt : null,
      lastAt,
      tokens: null,
      model: modelName(r.model)
    }
  })
}
