// The sub-agents a Claude Code conversation started (its Task / Agent tool),
// read from Claude Code's own files, like its "agents" list shows them:
//   <claude dir>/projects/<project>/<session id>/subagents/agent-<id>.meta.json
//     { agentType, description }
//   .../agent-<id>.jsonl   its transcript (timestamps, token usage)
// Read-only; only the first line and the end of each transcript are read.
// Codex (spawn_agent threads), OpenCode and Cline (child sessions),
// Antigravity (child conversations) and the others below.
import fs from 'fs'
import os from 'os'
import { join, relative, isAbsolute } from 'path'
import { createHash } from 'crypto'
import { readRows, readHead as readHeadText } from './fileRead'
import { antigravityModelFromText } from './agentModel'
import { museModelFromText, museSessionLog, museSessionsDir, museTextRecords, parseMuseHead } from './museSessions'

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TAIL_BYTES = 96 * 1024
// A tail with no message in it (Claude writes its whole prompt as one line
// after a sub-agent ends, often over 100 KB) is read again, wider, up to this.
const WIDE_TAIL_BYTES = 2 * 1024 * 1024
const MAX_AGENTS = 50
// Sub-agent files of one conversation looked at, at most (stat only).
const MAX_LISTED = 5000
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
  return { done, last, tokens, model, decided }
}

// What a sub-agent's transcript said (its start, its tail's summary), kept by
// file with its size and time: a file that did not change is not read again.
// Each pane header and sidebar row asks every 5 to 20 s, and a conversation
// can have 50 sub-agents with long transcripts: up to a quarter of a second
// of reading per answer, during which the main process answered nothing
// (2026-10-16).
const subagentReads = new Map() // file -> { size, mtimeMs, startedAt, tail }
const SUBAGENT_READS_MAX = 2000
function readSubagent(file, st) {
  const kept = subagentReads.get(file)
  if (kept && kept.size === st.size && kept.mtimeMs === st.mtimeMs) return kept
  const startedAt = readStart(file)
  let tail = summarizeTail(readTail(file, st.size))
  if (!tail.decided && st.size > TAIL_BYTES) tail = summarizeTail(readTail(file, st.size, WIDE_TAIL_BYTES))
  const read = { size: st.size, mtimeMs: st.mtimeMs, startedAt, tail }
  subagentReads.delete(file)
  subagentReads.set(file, read)
  if (subagentReads.size > SUBAGENT_READS_MAX) subagentReads.delete(subagentReads.keys().next().value)
  return read
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
  // Only the MAX_AGENTS written to last are read (each read blocks a moment:
  // a conversation can have hundreds of them); the others only stat'ed.
  const stats = new Map()
  for (const n of names.slice(0, MAX_LISTED)) {
    try {
      stats.set(n, fs.statSync(join(sub, n)))
    } catch {
      /* gone */
    }
  }
  const newest = [...stats.keys()].sort((a, b) => stats.get(b).mtimeMs - stats.get(a).mtimeMs).slice(0, MAX_AGENTS)
  const out = []
  for (const n of newest) {
    const file = join(sub, n)
    const id = n.slice(6, -6)
    if (!realInside(base, file, false)) continue
    const st = stats.get(n)
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
      ;({ startedAt, tail } = readSubagent(file, st))
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
      // Started in the background (run_in_background): it works on after its
      // parent's turn ends.
      background: meta.requestShape === 'background',
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

const effortName = (v) => (typeof v === 'string' && /^[a-z]{1,20}$/.test(v) ? v : null)
// Its reasoning effort: turn_context { effort }, or the thread settings.
function codexEffortOf(e) {
  const p = e && e.payload
  if (!p) return null
  if (e.type === 'turn_context') return effortName(p.effort) || effortName(p.reasoning_effort)
  if (p.type === 'thread_settings_applied' && p.thread_settings) return effortName(p.thread_settings.reasoning_effort)
  return null
}

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
  let effort = null
  for (const l of text.slice(nl + 1).split('\n')) {
    if (!l.includes('"model"')) continue
    try {
      const o = JSON.parse(l)
      model = codexModelOf(o) || model
      effort = codexEffortOf(o) || effort
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
    model,
    effort
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
  let effort = null
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
    if (effort === null) effort = codexEffortOf(o)
    if (decided && last && tokens !== null && model !== null && effort !== null) break
  }
  return { done, last, tokens, model, effort, decided }
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
        model: tail.model || head.model || null,
        effort: tail.effort || head.effort || null
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
// { role: 'assistant', time: { created, completed }, finish, tokens, modelID,
// variant } (a user one: { role: 'user', model: { modelID, variant } }); its
// variant is the effort it runs at (the parent's unless its agent has a model
// of its own), the session's model { id, variant } when no message says.
export function summarizeOpencodeMessage(data) {
  let m
  try {
    m = typeof data === 'string' ? JSON.parse(data) : data
  } catch {
    m = null
  }
  if (!m || typeof m !== 'object') return { done: false, endedAt: null, tokens: null, model: null, effort: null }
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
  const effort = opencodeEffort(assistant ? m.variant : m.model && m.model.variant)
  return { done, endedAt: done ? completed || null : null, tokens, model: assistant ? modelName(m.modelID) : null, effort }
}

// A variant that is an effort ("default": none picked).
const opencodeEffort = (v) => (v === 'default' ? null : effortName(v))

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

function opencodeModelEffort(v) {
  try {
    const o = typeof v === 'string' && v ? JSON.parse(v) : null
    return o && typeof o === 'object' ? opencodeEffort(o.variant) : null
  } catch {
    return null
  }
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
      model: last.model || opencodeModel(r.model),
      effort: last.effort || opencodeModelEffort(r.model)
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

// ---------------------------------------------------------------------------
// The Antigravity CLI (agy, its invoke_subagent tool): each sub-agent is a
// conversation of its own, and agy's index of its conversations
// (<gemini dir>/antigravity-cli/conversation_summaries.db, SQLite) names its
// parent: table conversation_summaries { conversation_id,
// parent_conversation_id ('' for one the user started), agent_name (its
// type), title, status (CASCADE_RUN_STATUS_RUNNING, _BUSY, _CANCELING,
// _IDLE), killed, not_fully_idle, step_count, last_modified_time
// ('2026-10-15 13:25:05.0955539+00:00') }. A child's own children name it
// as their parent (listed too, like Codex's nested ones).
// Its transcript (brain/<id>/.system_generated/logs/transcript.jsonl, one
// step per line { type, created_at, input_tokens, cache_read_tokens,
// output_tokens }) says when it started and wrote last, its tokens, and the
// model agy noted (agentModel.js). Read-only: one bounded query, the head of
// each transcript once (cached), its end.
const AGY_IDLE = 'CASCADE_RUN_STATUS_IDLE'
const AGY_MAX_DEPTH = 5
const AGY_HEAD_BYTES = 64 * 1024
// file -> { startedAt, model } (its first line and first prompt never change).
const agyHeadCache = new Map()

// agy's time ('2026-10-15 13:25:05.0955539+00:00') -> ms; its zero time
// ('0001-01-01 00:00:00+00:00': never set) -> null.
export function agyTime(v) {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.exec(String(v || '').trim())
  if (!m || m[1] < '2000') return null
  const ms = Date.parse(`${m[1]}T${m[2]}${m[3] ? m[3].slice(0, 4) : ''}${m[4] || 'Z'}`)
  return Number.isFinite(ms) ? ms : null
}

// The model agy noted -> { model: its name, effort } (both null when none).
function agyModel(text) {
  const m = antigravityModelFromText(text)
  return { model: (m && m.name) || null, effort: (m && m.effort) || null }
}

// The start of a child's transcript: when it started (its first line) and the
// model agy noted with its first prompt.
export function parseAgyHead(text) {
  const first = String(text || '').split('\n')[0]
  const m = /"created_at":\s*"([^"]+)"/.exec(first)
  return { startedAt: m ? Date.parse(m[1]) || null : null, ...agyModel(text) }
}

function agyHead(file, size) {
  const hit = agyHeadCache.get(file)
  if (hit) return hit
  const fd = fs.openSync(file, 'r')
  let text
  try {
    const buf = Buffer.alloc(Math.min(size, AGY_HEAD_BYTES))
    text = buf.toString('utf8', 0, fs.readSync(fd, buf, 0, buf.length, 0))
  } finally {
    fs.closeSync(fd)
  }
  const head = parseAgyHead(text)
  // Kept once it can no longer change: its model noted, or more written than
  // the head holds.
  if (head.startedAt && (head.model || size > AGY_HEAD_BYTES)) {
    if (agyHeadCache.size > 5000) agyHeadCache.clear()
    agyHeadCache.set(file, head)
  }
  return head
}

// From the end of a child's transcript: when it last wrote, the tokens of its
// last reply (what it holds in context) and the model agy noted last.
export function summarizeAgyTail(lines) {
  let last = null
  let tokens = null
  for (let i = lines.length - 1; i >= 0 && (last === null || tokens === null); i--) {
    let o
    try {
      o = JSON.parse(lines[i])
    } catch {
      continue
    }
    if (!o || typeof o !== 'object') continue
    if (last === null && typeof o.created_at === 'string') last = Date.parse(o.created_at) || null
    if (tokens === null && ('input_tokens' in o || 'output_tokens' in o)) {
      const n = (num(o.input_tokens) || 0) + (num(o.cache_read_tokens) || 0) + (num(o.output_tokens) || 0)
      if (n > 0) tokens = n
    }
  }
  return { last, tokens, ...agyModel(lines.join('\n')) }
}

// -> the same rows as claudeSubagents: type is its agent_name ("subagent"
// when none), title the title agy gave it; done once it is idle or killed.
export function antigravitySubagents(sessionId, geminiDir = join(os.homedir(), '.gemini'), now = Date.now()) {
  if (!ID.test(String(sessionId))) return []
  const sid = String(sessionId).toLowerCase()
  const db = dbInside(geminiDir, 'antigravity-cli', 'conversation_summaries.db')
  if (!db) return []
  let base
  try {
    base = fs.realpathSync.native(geminiDir)
  } catch {
    return []
  }
  const rows = readRows(
    db,
    `WITH RECURSIVE kids(id, depth) AS (
       SELECT conversation_id, 1 FROM conversation_summaries WHERE parent_conversation_id = ?
       UNION
       SELECT c.conversation_id, k.depth + 1 FROM conversation_summaries c JOIN kids k ON c.parent_conversation_id = k.id WHERE k.depth < ${AGY_MAX_DEPTH}
     )
     SELECT conversation_id, title, agent_name, status, killed, not_fully_idle, step_count, last_modified_time
     FROM conversation_summaries WHERE conversation_id IN (SELECT id FROM kids) AND conversation_id <> ?
     ORDER BY last_modified_time DESC LIMIT ${MAX_AGENTS}`,
    [sid, sid]
  )
  const out = []
  for (const r of rows) {
    const id = String(r.conversation_id || '').toLowerCase()
    if (!ID.test(id)) continue
    const file = join(geminiDir, 'antigravity-cli', 'brain', id, '.system_generated', 'logs', 'transcript.jsonl')
    let st = null
    let head = { startedAt: null, model: null, effort: null }
    let tail = { last: null, tokens: null, model: null, effort: null }
    try {
      if (realInside(base, file, false)) {
        st = fs.statSync(file)
        head = agyHead(file, st.size)
        tail = summarizeAgyTail(readTail(file, st.size))
      }
    } catch {
      // being written: next time
    }
    const modified = agyTime(r.last_modified_time)
    const lastAt = Math.max(modified || 0, tail.last || 0, (st && st.mtimeMs) || 0) || null
    // Idle after it worked (not only made), with nothing of its own left
    // running; or killed (its parent's manage_subagents, or the user).
    const done = !!num(r.killed) || (r.status === AGY_IDLE && !num(r.not_fully_idle) && num(r.step_count) > 0)
    const state = done ? 'done' : lastAt && now - lastAt > QUIET_MS ? 'quiet' : 'running'
    const title = firstLine(r.title, 200)
    out.push({
      id,
      type: str(r.agent_name, 60) || 'subagent',
      title: title === 'New Chat' ? '' : title,
      state,
      startedAt: head.startedAt || (st && st.birthtimeMs) || null,
      endedAt: state === 'done' ? modified || lastAt : null,
      lastAt,
      tokens: tail.tokens,
      model: tail.model || head.model,
      effort: tail.model ? tail.effort : head.effort
    })
  }
  out.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
  return out.slice(0, MAX_AGENTS)
}

// ---------------------------------------------------------------------------
// Gemini CLI (its invoke_agent tool): each sub-agent run has a chat file of
// its own, in a folder named after the conversation (nested ones too: they
// keep the main session's id):
//   <gemini dir>/tmp/<project>/chats/<session id>/<agent id>.jsonl
//   first line { sessionId: <agent id>, startTime, kind: 'subagent' }, then
//   its messages { timestamp, type: 'user' | 'gemini', content, model,
//   tokens: { input, output, total }, toolCalls: [{ name, status }] } and
//   { $set: { lastUpdated | summary } }.
// Done once it called complete_task or got its summary (it reached its
// goal); one stopped, failed or out of turns writes neither: quiet once
// silent, like a stopped Claude one, unless the conversation's own file
// (chats/session-<time>-<id8>.jsonl) has its invoke_agent call back:
//   toolCalls: [{ name: 'invoke_agent', args: { agent_name }, status:
//   'success' | 'error' | 'cancelled', agentId }]
// (only once all the tools it ran with returned; read from its end), which
// also has its name. Gemini notes no effort.
const GEMINI_HEAD_BYTES = 64 * 1024
const GEMINI_TAIL_BYTES = 256 * 1024
// file -> { startedAt, title, child } (its first line and prompt never change).
const geminiHeadCache = new Map()
// agent id -> { name, ended } of its invoke_agent call (back: never changes).
const geminiCalls = new Map()

const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('') : '')

// The start of a sub-agent's chat file: when it started, whether it is one
// (kind), its first prompt's first line.
export function parseGeminiChildHead(text) {
  let startedAt = null
  let child = false
  let title = null
  for (const l of String(text || '').split('\n')) {
    let o
    try {
      o = JSON.parse(l)
    } catch {
      continue // cut at the end
    }
    if (!o || typeof o !== 'object') continue
    if (startedAt === null && typeof o.startTime === 'string') {
      startedAt = Date.parse(o.startTime) || null
      child = o.kind === 'subagent'
    }
    if (title === null && o.type === 'user') title = firstLine(textOf(o.content), 200)
    if (startedAt !== null && title !== null) break
  }
  return { startedAt, child, title }
}

function geminiHead(file, size) {
  const hit = geminiHeadCache.get(file)
  if (hit) return hit
  const fd = fs.openSync(file, 'r')
  let text
  try {
    const buf = Buffer.alloc(Math.min(size, GEMINI_HEAD_BYTES))
    text = buf.toString('utf8', 0, fs.readSync(fd, buf, 0, buf.length, 0))
  } finally {
    fs.closeSync(fd)
  }
  const head = parseGeminiChildHead(text)
  if (head.startedAt && (head.title !== null || size > GEMINI_HEAD_BYTES)) {
    if (geminiHeadCache.size > 5000) geminiHeadCache.clear()
    geminiHeadCache.set(file, head)
  }
  return head
}

// From the end of a sub-agent's chat file: finished (it called complete_task
// or got its summary), when it last wrote, the tokens of its last request
// and its model.
export function summarizeGeminiTail(lines) {
  let done = false
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
    if (!o || typeof o !== 'object') continue
    const set = o.$set && typeof o.$set === 'object' ? o.$set : null
    if (set) {
      if (typeof set.summary === 'string') done = true
      if (!last && typeof set.lastUpdated === 'string') last = Date.parse(set.lastUpdated) || null
      continue
    }
    if (!last && typeof o.timestamp === 'string') last = Date.parse(o.timestamp) || null
    if (o.type !== 'gemini') continue
    if (Array.isArray(o.toolCalls) && o.toolCalls.some((c) => c && c.name === 'complete_task' && c.status === 'success')) done = true
    if (tokens === null && o.tokens && typeof o.tokens === 'object') {
      const n = num(o.tokens.total) || (num(o.tokens.input) || 0) + (num(o.tokens.output) || 0)
      if (n > 0) tokens = n
    }
    if (model === null) model = modelName(o.model)
    if (done && last && tokens !== null && model !== null) break
  }
  return { done, last, tokens, model }
}

// The conversation's invoke_agent calls that came back, from the end of its
// own file(s) in its project's chats folder.
function geminiParentCalls(base, chats, sid) {
  let names
  try {
    names = fs.readdirSync(chats)
  } catch {
    return
  }
  for (const n of names) {
    if (!n.startsWith('session-') || !n.endsWith(`-${sid.slice(0, 8)}.jsonl`)) continue
    const file = join(chats, n)
    if (!realInside(base, file, false)) continue
    let lines
    try {
      lines = readTail(file, fs.statSync(file).size, GEMINI_TAIL_BYTES)
    } catch {
      continue
    }
    for (const l of lines) {
      if (!l.includes('"invoke_agent"')) continue
      let o
      try {
        o = JSON.parse(l)
      } catch {
        continue
      }
      for (const c of o && Array.isArray(o.toolCalls) ? o.toolCalls : []) {
        if (!c || c.name !== 'invoke_agent' || !ID.test(String(c.agentId))) continue
        if (geminiCalls.size > 5000) geminiCalls.clear()
        geminiCalls.set(String(c.agentId).toLowerCase(), {
          name: str(c.args && c.args.agent_name, 60),
          ended: c.status === 'success' || c.status === 'error' || c.status === 'cancelled'
        })
      }
    }
  }
}

// -> the same rows as claudeSubagents: type is its agent's name (once its
// call came back, else "subagent"), title the first line of its prompt.
export function geminiSubagents(sessionId, geminiDir = join(process.env.GEMINI_CLI_HOME || os.homedir(), '.gemini'), now = Date.now()) {
  if (!ID.test(String(sessionId))) return []
  const sid = String(sessionId).toLowerCase()
  let base
  try {
    base = fs.realpathSync.native(geminiDir)
  } catch {
    return []
  }
  const tmp = join(geminiDir, 'tmp')
  if (!realInside(base, tmp, true)) return []
  let found = null
  let projects
  try {
    projects = fs.readdirSync(tmp, { withFileTypes: true })
  } catch {
    return []
  }
  for (const p of projects) {
    if (!p.isDirectory()) continue
    const chats = join(tmp, p.name, 'chats')
    const dir = join(chats, sid)
    if (!fs.existsSync(dir)) continue
    if (realInside(base, join(tmp, p.name), true) && realInside(base, chats, true) && realInside(base, dir, true)) {
      found = { chats, dir }
      break
    }
  }
  if (!found) return []
  let names
  try {
    names = fs.readdirSync(found.dir).filter((n) => ID.test(n.slice(0, -6)) && n.endsWith('.jsonl'))
  } catch {
    return []
  }
  // Its calls are read only while one has not come back.
  if (names.some((n) => !(geminiCalls.get(n.slice(0, -6).toLowerCase()) || {}).ended)) geminiParentCalls(base, found.chats, sid)
  const out = []
  for (const n of names) {
    const id = n.slice(0, -6).toLowerCase()
    const file = join(found.dir, n)
    if (!realInside(base, file, false)) continue
    let st
    try {
      st = fs.statSync(file)
    } catch {
      continue
    }
    let head = { startedAt: null, child: false, title: null }
    let tail = { done: false, last: null, tokens: null, model: null }
    try {
      head = geminiHead(file, st.size)
      tail = summarizeGeminiTail(readTail(file, st.size))
    } catch {
      // being written: next time
    }
    if (!head.child && head.startedAt) continue
    const call = geminiCalls.get(id) || null
    const last = tail.last || st.mtimeMs
    const lastAt = Math.max(last, st.mtimeMs)
    const state = tail.done || (call && call.ended) ? 'done' : now - lastAt > QUIET_MS ? 'quiet' : 'running'
    out.push({
      id,
      type: (call && call.name) || 'subagent',
      title: head.title || '',
      state,
      startedAt: head.startedAt || st.birthtimeMs || null,
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
// Logs an agent only appends to (Copilot's events.jsonl, Kimi's wire.jsonl),
// where a sub-agent's start may be far from their end: read once, then only
// what was added since (by file), each whole line that may matter (keep: a
// quick test of its text) folded into that file's state. Before their last
// 32 MB, only the lines that start or end a sub-agent (mark), so one started
// long ago that still runs is never lost; nothing before their last 256 MB.
// Read without blocking: 1 MB at a time, the event loop free between two,
// one read of a file at a time (a poll meanwhile waits for it). Each read
// first checks the file is still the one folded (the same first 4 KB and the
// same 64 bytes before where it was read to), then that it was not cut and
// written again meanwhile; if it was, its state is dropped and it is read
// again from its start.
const LOG_TAIL_BYTES = 32 * 1024 * 1024
const LOG_SCAN_BYTES = 256 * 1024 * 1024
const LOG_CHUNK = 1024 * 1024
const PRINT_HEAD = 4096
const PRINT_TAIL = 64
let logTail = LOG_TAIL_BYTES
let logChunk = LOG_CHUNK
// file -> { ino, born, mtime, offset, rest (a line not ended yet), cut,
// marked (read up to there with mark only), state, print, stale, reading
// (the read under way) }
const logCache = new Map()
const nextTurn = () => new Promise((resolve) => setImmediate(resolve))

async function readAt(fh, pos, len) {
  const buf = Buffer.alloc(len)
  const { bytesRead } = await fh.read(buf, 0, len, pos)
  return buf.subarray(0, bytesRead)
}

// The file as read up to `at`: a hash of its first bytes, the bytes before `at`.
async function printOf(fh, headLen, at) {
  const head = createHash('sha1').update(await readAt(fh, 0, headLen)).digest('hex')
  const from = Math.max(0, at - PRINT_TAIL)
  return { headLen, head, at, tail: (await readAt(fh, from, at - from)).toString('hex') }
}

async function samePrint(fh, p) {
  const now = await printOf(fh, p.headLen, p.at)
  return now.head === p.head && now.tail === p.tail
}

function freshLog(file, st) {
  const offset = Math.max(0, st.size - LOG_SCAN_BYTES)
  const c = {
    ino: st.ino,
    born: st.birthtimeMs,
    mtime: null,
    offset,
    rest: Buffer.alloc(0),
    cut: offset > 0,
    marked: st.size - logTail,
    state: {},
    print: null,
    stale: false,
    reading: null
  }
  if (!logCache.has(file) && logCache.size > 500) logCache.clear()
  logCache.set(file, c)
  return c
}

// Reads the file from c.offset up to its size in `st`, a chunk per turn of
// the loop; c.stale when it is no longer the file read so far.
async function readLog(file, c, st, keep, fold, mark) {
  const size = st.size
  const fh = await fs.promises.open(file, 'r')
  try {
    if (c.print && !(await samePrint(fh, c.print))) {
      c.stale = true
      return
    }
    const start = c.print || (await printOf(fh, Math.min(PRINT_HEAD, size), 0))
    let first = true
    while (c.offset < size) {
      if (!first) await nextTurn()
      first = false
      // Up to the start of its last 32 MB, then the rest.
      const upTo = c.offset < c.marked ? Math.min(c.marked, size) : size
      const buf = Buffer.alloc(Math.min(upTo - c.offset, logChunk))
      const { bytesRead: n } = await fh.read(buf, 0, buf.length, c.offset)
      if (n <= 0) break
      c.offset += n
      const data = c.rest.length ? Buffer.concat([c.rest, buf.subarray(0, n)]) : buf.subarray(0, n)
      const end = data.lastIndexOf(10)
      c.rest = Buffer.from(end < 0 ? data : data.subarray(end + 1))
      if (end < 0) continue
      const lines = data.toString('utf8', 0, end).split('\n')
      if (c.cut) lines.shift() // read from the middle of a line
      c.cut = false
      // Before its last 32 MB: its starts and ends only.
      const test = c.offset <= c.marked ? mark : keep
      for (const l of lines) {
        if (!test(l)) continue
        try {
          fold(c.state, JSON.parse(l))
        } catch {
          // not a record
        }
      }
    }
    // Replaced, or cut and written again, while it was read.
    const now = await fs.promises.stat(file)
    if (now.ino !== c.ino || now.birthtimeMs !== c.born || now.size < c.offset || !(await samePrint(fh, start))) {
      c.stale = true
      return
    }
    c.print = await printOf(fh, start.headLen, c.offset)
    c.mtime = st.mtimeMs
  } finally {
    await fh.close()
  }
}

async function foldLog(file, st, keep, fold, mark = keep) {
  for (let tries = 0; tries < 3; tries++) {
    let c = logCache.get(file)
    // Another file now, shorter, or found rewritten: from its start.
    if (!c || c.stale || c.ino !== st.ino || c.born !== st.birthtimeMs || st.size < c.offset) c = freshLog(file, st)
    // Grown, or written to, since it was read.
    while (!c.stale && (c.offset < st.size || c.mtime !== st.mtimeMs)) {
      const before = c.offset
      if (!c.reading) {
        const reading = readLog(file, c, st, keep, fold, mark).finally(() => {
          if (c.reading === reading) c.reading = null
        })
        c.reading = reading
      }
      await c.reading
      if (!c.stale && c.offset === before && c.mtime === st.mtimeMs) break // shorter than it said: next time
    }
    if (!c.stale) return c.state
    st = await fs.promises.stat(file)
  }
  return {} // rewritten each time it is read: next time
}

// GitHub Copilot CLI (its task tool, custom agents): sub-agents have no
// folder of their own; the conversation's <COPILOT_HOME or ~/.copilot>/
// session-state/<id>/events.jsonl notes them, one event per line { type,
// timestamp, agentId (the sub-agent's, on everything it does), data }:
//   tool.execution_start { toolName: 'task', toolCallId, arguments: { name,
//     description, agent_type, model, mode } }
//   subagent.started { toolCallId, agentName, agentType, agentDisplayName
//     (its task), executionMode ('sync' | 'background'), model,
//     workflowRunId }
//   subagent.configured { model, reasoningEffort }
//   subagent.completed { toolCallId, model, firstDispatchedModel }
//   | subagent.failed { toolCallId }
// Like Copilot's own list: one per tool call (a follow-up starts again under
// the same agentId), those a workflow run started apart.
function foldCopilot(s, e) {
  if (!s.kids) {
    s.kids = new Map() // its key (first tool call) -> its facts
    s.calls = new Map() // tool call id -> key
    s.byAgent = new Map() // agent id -> key
    s.agents = new Map() // agent id -> { last, model, effort }
  }
  if (!e || typeof e !== 'object') return
  const d = e.data && typeof e.data === 'object' ? e.data : {}
  const at = Date.parse(e.timestamp) || null
  const agent = str(e.agentId, 120) || str(d.agentId, 120)
  if (agent) {
    const a = s.agents.get(agent) || { last: null, model: null, effort: null }
    if (at && at > (a.last || 0)) a.last = at
    if (e.type === 'subagent.configured') {
      a.model = modelName(d.model) || a.model
      a.effort = effortName(d.reasoningEffort) || a.effort
    }
    s.agents.set(agent, a)
  }
  const call = str(d.toolCallId, 120)
  if (!call) return
  if (e.type === 'tool.execution_start') {
    if (d.toolName !== 'task' || s.calls.has(call)) return
    const args = d.arguments && typeof d.arguments === 'object' ? d.arguments : {}
    s.calls.set(call, call)
    s.kids.set(call, {
      agent: null,
      type: str(args.agent_type, 60),
      title: firstLine(args.name || args.description, 200),
      background: args.mode === 'background',
      model: modelName(args.model),
      startedAt: at,
      done: false,
      endedAt: null
    })
  } else if (e.type === 'subagent.started') {
    if (d.workflowRunId) return
    const key = s.calls.get(call) || (agent && s.byAgent.get(agent)) || call
    s.calls.set(call, key)
    if (agent) s.byAgent.set(agent, key)
    const k = s.kids.get(key)
    const type = str(d.agentType, 60) || str(d.agentName, 60)
    const title = firstLine(d.agentDisplayName || d.agentDescription, 200)
    if (k) {
      // Its task call first, or working again.
      Object.assign(k, { agent: agent || k.agent, type: k.type || type, title: k.title || title, model: modelName(d.model) || k.model, done: false, endedAt: null })
      if (d.executionMode) k.background = d.executionMode === 'background'
      return
    }
    s.kids.set(key, { agent, type, title, background: d.executionMode === 'background', model: modelName(d.model), startedAt: at, done: false, endedAt: null })
  } else if (e.type === 'subagent.completed' || e.type === 'subagent.failed') {
    const k = s.kids.get(s.calls.get(call))
    if (!k) return
    k.done = true
    k.endedAt = at
    k.model = modelName(d.firstDispatchedModel) || modelName(d.model) || k.model
  }
}

const copilotLine = (l) => l.includes('"agentId"') || l.includes('"subagent.') || l.includes('"tool.execution_start"')
// One that starts or ends a sub-agent (or sets its model and effort).
const copilotMark = (l) => l.includes('"subagent.') || (l.includes('"tool.execution_start"') && /"toolName":\s*"task"/.test(l))

export async function copilotSubagents(sessionId, copilotDir = process.env.COPILOT_HOME || join(os.homedir(), '.copilot'), now = Date.now()) {
  if (!SQL_ID.test(String(sessionId))) return []
  let base
  try {
    base = fs.realpathSync.native(copilotDir)
  } catch {
    return []
  }
  const dir = join(copilotDir, 'session-state', String(sessionId))
  const file = join(dir, 'events.jsonl')
  if (!realInside(base, join(copilotDir, 'session-state'), true) || !realInside(base, dir, true) || !realInside(base, file, false)) return []
  let s
  try {
    s = await foldLog(file, fs.statSync(file), copilotLine, foldCopilot, copilotMark)
  } catch {
    return []
  }
  if (!s.kids) return []
  const out = []
  for (const [key, k] of s.kids) {
    const a = (k.agent && s.agents.get(k.agent)) || s.agents.get(key) || {}
    const lastAt = Math.max(k.endedAt || 0, a.last || 0, k.startedAt || 0) || null
    const state = k.done ? 'done' : lastAt && now - lastAt > QUIET_MS ? 'quiet' : 'running'
    out.push({
      id: key.slice(0, 80),
      type: k.type || 'subagent',
      title: k.title || '',
      background: k.background,
      state,
      startedAt: k.startedAt,
      endedAt: state === 'done' ? k.endedAt || lastAt : null,
      lastAt,
      tokens: null,
      model: k.model || a.model || null,
      effort: a.effort || null
    })
  }
  out.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
  return out.slice(0, MAX_AGENTS)
}

// ---------------------------------------------------------------------------
// Kimi Code (its Agent tool): each agent of a session has a folder,
//   <KIMI_CODE_HOME or ~/.kimi-code>/sessions/<workspace>/<session id>/
//   agents/<agent id>/wire.jsonl (main: the conversation's own),
// one record per line { type, time (ms), ... }. The agent that started one
// notes it in its own wire (a sub-agent's children in that sub-agent's):
//   subagent.spawned { subagentId, subagentName, description,
//     runInBackground, model, thinkingEffort }, subagent.started,
//   then subagent.completed { contextTokens } | .failed | .cancelled
// (Kimi folds them the same way: foldWireRecordFacts). The child's own wire
// says when it last wrote.
function foldKimi(s, r) {
  if (!s.kids) s.kids = new Map()
  if (!r || typeof r !== 'object') return
  const id = str(r.subagentId, 80)
  if (!id || !SQL_ID.test(id)) return
  const at = num(r.time) || Date.parse(r.time) || null
  const k = s.kids.get(id)
  if (r.type === 'subagent.spawned') {
    s.kids.set(id, {
      type: str(r.subagentName, 60),
      title: firstLine(r.description, 200),
      background: r.runInBackground === true,
      model: modelName(r.model),
      effort: effortName(r.thinkingEffort),
      startedAt: at,
      done: false,
      endedAt: null,
      tokens: null,
      last: at
    })
  } else if (k && r.type === 'subagent.started') {
    // Working again (a resumed one).
    Object.assign(k, { done: false, endedAt: null, last: at || k.last })
  } else if (k && (r.type === 'subagent.completed' || r.type === 'subagent.failed' || r.type === 'subagent.cancelled')) {
    Object.assign(k, { done: true, endedAt: at, last: at || k.last })
    if (r.type === 'subagent.completed' && num(r.contextTokens) > 0) k.tokens = num(r.contextTokens)
  }
}

const kimiLine = (l) => l.includes('"subagent.')

export async function kimiSubagents(sessionId, kimiDir = process.env.KIMI_CODE_HOME || join(os.homedir(), '.kimi-code'), now = Date.now()) {
  if (!SQL_ID.test(String(sessionId))) return []
  let base
  try {
    base = fs.realpathSync.native(kimiDir)
  } catch {
    return []
  }
  const sessions = join(kimiDir, 'sessions')
  if (!realInside(base, sessions, true)) return []
  let session = null
  let workspaces
  try {
    workspaces = fs.readdirSync(sessions, { withFileTypes: true })
  } catch {
    return []
  }
  for (const w of workspaces) {
    if (!w.isDirectory() || w.name.startsWith('.')) continue
    const dir = join(sessions, w.name, String(sessionId))
    if (fs.existsSync(dir) && realInside(base, join(sessions, w.name), true) && realInside(base, dir, true)) {
      session = dir
      break
    }
  }
  const agents = session && join(session, 'agents')
  if (!agents || !realInside(base, agents, true)) return []
  let names
  try {
    names = fs.readdirSync(agents).filter((n) => SQL_ID.test(n) || n === 'main')
  } catch {
    return []
  }
  const kids = new Map()
  const wrote = new Map() // agent id -> its wire's last write
  for (const n of names) {
    const file = join(agents, n, 'wire.jsonl')
    if (!realInside(base, join(agents, n), true) || !realInside(base, file, false)) continue
    try {
      const st = fs.statSync(file)
      wrote.set(n, st.mtimeMs)
      const s = await foldLog(file, st, kimiLine, foldKimi)
      if (s.kids) for (const [id, k] of s.kids) kids.set(id, k)
    } catch {
      // being written: next time
    }
  }
  const out = []
  for (const [id, k] of kids) {
    const lastAt = Math.max(k.last || 0, wrote.get(id) || 0) || null
    const state = k.done ? 'done' : lastAt && now - lastAt > QUIET_MS ? 'quiet' : 'running'
    out.push({
      id,
      type: k.type || 'subagent',
      title: k.title || '',
      background: k.background,
      state,
      startedAt: k.startedAt,
      endedAt: state === 'done' ? k.endedAt || lastAt : null,
      lastAt,
      tokens: k.tokens,
      model: k.model,
      effort: k.effort
    })
  }
  out.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
  return out.slice(0, MAX_AGENTS)
}

// ---------------------------------------------------------------------------
// Cursor Agent (its Task tool): each sub-agent is a chat of its own beside
// the conversation's, ~/.cursor/chats/<folder hash>/<chat id>/store.db
// (SQLite), whose meta row "0" (the hex of a JSON) names its parent:
//   { agentId, name, createdAt (ms), lastUsedModel, subagentInfo: {
//     parentAgentId, rootParentAgentId, typeName } }
// (nested ones name the conversation as their root). Its transcript,
// ~/.cursor/projects/<folder slug>/agent-transcripts/<id>/<id>.jsonl, ends
// each of its runs with { type: 'turn_ended', status: 'success' | 'error' |
// 'aborted' }. Cursor notes no effort.
// store.db -> { mtime, info } (info null: not a sub-agent; kept for good once
// it is old enough to have said so).
const cursorMetaCache = new Map()

export function parseCursorMeta(value) {
  try {
    const o = JSON.parse(Buffer.from(String(value || ''), 'hex').toString('utf8'))
    return o && typeof o === 'object' ? o : null
  } catch {
    return null
  }
}

function cursorMeta(file, st, now) {
  const hit = cursorMetaCache.get(file)
  if (hit && (hit.info === null || hit.mtime === st.mtimeMs)) return hit.info
  const row = readRows(file, "SELECT value FROM meta WHERE key = '0'")[0]
  const m = row ? parseCursorMeta(row.value) : null
  if (!m) return null // busy or being made: next time
  const sub = m.subagentInfo && typeof m.subagentInfo === 'object' ? m.subagentInfo : null
  const info = sub
    ? {
        parent: str(sub.parentAgentId, 80),
        root: str(sub.rootParentAgentId, 80),
        type: str(sub.typeName, 60),
        title: firstLine(m.name, 200),
        createdAt: num(m.createdAt),
        model: modelName(m.lastUsedModel)
      }
    : null
  // Not one: Cursor notes it right after making the chat.
  if (info || now - (num(m.createdAt) || now) > 60000) {
    if (cursorMetaCache.size > 5000) cursorMetaCache.clear()
    cursorMetaCache.set(file, { mtime: st.mtimeMs, info })
  }
  return info
}

// The end of a transcript: its last run's end, if it ended.
export function cursorTurnEnded(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    let o
    try {
      o = JSON.parse(lines[i])
    } catch {
      continue
    }
    return !!(o && o.type === 'turn_ended')
  }
  return false
}

export function cursorSubagents(sessionId, cursorDir = join(os.homedir(), '.cursor'), now = Date.now()) {
  if (!SQL_ID.test(String(sessionId))) return []
  const sid = String(sessionId)
  let base
  try {
    base = fs.realpathSync.native(cursorDir)
  } catch {
    return []
  }
  const chats = join(cursorDir, 'chats')
  if (!realInside(base, chats, true)) return []
  let bucket = null
  let buckets
  try {
    buckets = fs.readdirSync(chats, { withFileTypes: true })
  } catch {
    return []
  }
  for (const b of buckets.slice(0, 400)) {
    if (b.isDirectory() && fs.existsSync(join(chats, b.name, sid)) && realInside(base, join(chats, b.name), true)) {
      bucket = join(chats, b.name)
      break
    }
  }
  if (!bucket) return []
  let ids
  try {
    ids = fs.readdirSync(bucket).filter((n) => SQL_ID.test(n) && n !== sid)
  } catch {
    return []
  }
  const kids = []
  for (const id of ids) {
    const file = join(bucket, id, 'store.db')
    if (!realInside(base, join(bucket, id), true) || !realInside(base, file, false)) continue
    try {
      const st = fs.statSync(file)
      const info = cursorMeta(file, st, now)
      if (info && (info.parent === sid || info.root === sid)) kids.push({ id, info, st })
    } catch {
      // being written: next time
    }
  }
  if (!kids.length) return []
  // Its transcripts are in the conversation's project folder (the one with
  // the conversation's, or one of theirs).
  const projects = join(cursorDir, 'projects')
  let project = null
  try {
    if (realInside(base, projects, true)) {
      const want = [sid, ...kids.map((k) => k.id)]
      for (const p of fs.readdirSync(projects).slice(0, 400)) {
        const dir = join(projects, p, 'agent-transcripts')
        if (want.some((id) => fs.existsSync(join(dir, id)))) {
          project = dir
          break
        }
      }
    }
  } catch {
    project = null
  }
  const out = []
  for (const { id, info, st } of kids) {
    let wrote = st.mtimeMs
    let done = false
    const file = project && join(project, id, `${id}.jsonl`)
    try {
      if (file && realInside(base, file, false)) {
        const t = fs.statSync(file)
        wrote = Math.max(wrote, t.mtimeMs)
        done = cursorTurnEnded(readTail(file, t.size))
      }
    } catch {
      // being written: next time
    }
    try {
      // What it writes goes to the database's log first.
      wrote = Math.max(wrote, fs.statSync(join(bucket, id, 'store.db-wal')).mtimeMs)
    } catch {
      // none
    }
    const state = done ? 'done' : now - wrote > QUIET_MS ? 'quiet' : 'running'
    out.push({
      id,
      type: info.type || 'subagent',
      title: info.title || '',
      state,
      startedAt: info.createdAt || st.birthtimeMs || null,
      endedAt: state === 'done' ? wrote : null,
      lastAt: wrote,
      tokens: null,
      model: info.model
    })
  }
  out.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
  return out.slice(0, MAX_AGENTS)
}

// How much of a log is read whole (its last 32 MB) and how much per turn
// of the event loop (1 MB), smaller in tests.
// ---------------------------------------------------------------------------
// Muse Code (its subagents): each child session writes its own log inside its
// parent session's folder, subagent/<child session id>/session.jsonl (its own
// sub-agents nested the same way). Muse's background observers (memory
// recall, goal, verification) write logs there too, so only the children its
// hooks announced are listed (SubagentStart, by child session id: teamMcp
// server.cjs reportMuseChild, <sessions>/muse-children/<session>/<child>.json).
// Done once its SubagentStop came; its title is the task it was given (its
// first prompt); its model and effort, and the tokens of its last request,
// from its log (museSessions.js).
const MUSE_HEAD_BYTES = 64 * 1024
const MUSE_DEPTH = 4

// From the end of a child's log: when it last wrote, the tokens of its last
// model request (what it held in context), its model and effort.
export function summarizeMuseTail(text) {
  let last = null
  let tokens = null
  for (const rec of museTextRecords(text)) {
    if (rec.at) last = rec.at
    const e = rec.type === 'runtime.session' && rec.payload.event && typeof rec.payload.event === 'object' ? rec.payload.event : null
    if (e && e.kind === 'model_completed' && e.usage && typeof e.usage === 'object') {
      const n = (num(e.usage.input_tokens) || 0) + (num(e.usage.output_tokens) || 0)
      if (n > 0) tokens = n
    }
  }
  const m = museModelFromText(text)
  return { last, tokens, model: m ? m.model : null, effort: m ? m.effort : null }
}

// sessionsDir: where the hooks note the children (Tessel's sessions folder).
export function museSubagents(sessionId, { sessionsDir = null, home = os.homedir(), now = Date.now() } = {}) {
  if (!ID.test(String(sessionId)) || typeof sessionsDir !== 'string' || !isAbsolute(sessionsDir)) return []
  const sid = String(sessionId).toLowerCase()
  const registry = join(sessionsDir, 'muse-children', sid)
  const noted = new Map()
  let names
  try {
    names = fs.readdirSync(registry).filter((n) => /^[0-9a-f-]{36}\.json$/i.test(n))
  } catch {
    return []
  }
  for (const n of names.slice(0, 200)) {
    const id = n.slice(0, -5).toLowerCase()
    if (!ID.test(id)) continue
    let entry
    try {
      entry = JSON.parse(fs.readFileSync(join(registry, n), 'utf8')) || {}
    } catch {
      entry = {}
    }
    noted.set(id, entry)
  }
  if (!noted.size) return []
  const root = museSessionsDir(home)
  const log = museSessionLog(sid, root)
  let base
  try {
    base = fs.realpathSync.native(root)
  } catch {
    return []
  }
  if (!log) return []
  // Each noted child's folder: under its parent's, or under another noted
  // child's (a sub-agent's own), a few levels down at most.
  const folders = new Map()
  let parents = [join(log, '..')]
  for (let depth = 0; depth < MUSE_DEPTH && parents.length && folders.size < noted.size; depth++) {
    const next = []
    for (const parent of parents) {
      for (const id of noted.keys()) {
        if (folders.has(id)) continue
        const dir = join(parent, 'subagent', id)
        if (realInside(base, dir, true)) {
          folders.set(id, dir)
          next.push(dir)
        }
      }
    }
    parents = next
  }
  const out = []
  for (const [id, dir] of folders) {
    const file = join(dir, 'session.jsonl')
    if (!realInside(base, file, false)) continue
    const entry = noted.get(id)
    let st = null
    let head = { started: 0, prompt: '', model: '' }
    let tail = { last: null, tokens: null, model: null, effort: null }
    try {
      st = fs.statSync(file)
      head = parseMuseHead(readHeadText(file, MUSE_HEAD_BYTES))
      tail = summarizeMuseTail(readTail(file, st.size).join('\n'))
    } catch {
      // being written: next time
    }
    const lastAt = Math.max(tail.last || 0, (st && st.mtimeMs) || 0) || null
    const stopped = num(entry.stoppedAt)
    const state = stopped ? 'done' : lastAt && now - lastAt > QUIET_MS ? 'quiet' : 'running'
    out.push({
      id,
      type: typeof entry.name === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(entry.name) ? entry.name.slice(0, 60) : 'subagent',
      title: firstLine(head.prompt, 200),
      state,
      startedAt: head.started || num(entry.startedAt) || (st && st.birthtimeMs) || null,
      endedAt: state === 'done' ? Math.max(stopped, tail.last || 0) : null,
      lastAt,
      tokens: tail.tokens,
      model: tail.model || head.model || null,
      effort: tail.effort || null
    })
  }
  out.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
  return out.slice(0, MAX_AGENTS)
}

export function _setLogSizesForTest(tail = LOG_TAIL_BYTES, chunk = LOG_CHUNK) {
  logTail = tail
  logChunk = chunk
}

export function _clearChildCachesForTest() {
  agyHeadCache.clear()
  geminiHeadCache.clear()
  geminiCalls.clear()
  logCache.clear()
  cursorMetaCache.clear()
}
