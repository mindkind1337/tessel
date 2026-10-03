// Read-only session readers for the agents that pick their own conversation
// id: Droid, Grok, Pi, Antigravity, Devin, Cursor, Copilot, Kimi, Cline and ZCode.
// Each one lists { agent, id, cwd, started, updated, title } from the agent's
// own session folder, for the Sessions dialog (history) and to find the
// conversation a pane started (resume).
//
// Layouts after Orca's src/main/ai-vault/session-scanner-agent-sources.ts and
// session-scanner-{droid,grok,antigravity,devin,cursor,copilot,kimi,cline}-parser.ts,
// session-scanner-graph-parsers.ts (Pi), session-scanner-antigravity-{paths,history}.ts,
// session-scanner-kimi-paths.ts, session-scanner-devin-db.ts and
// shared/grok-session-paths.ts, MIT, Copyright (c) 2026 Lovecast Inc.
//
// Safety: nothing here writes, runs an agent or follows a link out of the
// agent's folder. Every file is checked to resolve (realpath) inside its
// agent's session folder, reads are bounded (a head of the file, whole JSON
// documents only up to a size), walks are bounded in depth and count, and only
// plain session ids are kept.
import fs from 'fs'
import os from 'os'
import { basename, dirname, join, isAbsolute, relative, resolve, sep, win32 } from 'path'
import { normDir, readHead, readTail, readRows } from './fileRead'
import { clineDataDir } from './jsonAgents'

const HEAD_BYTES = 256 * 1024
const JSON_MAX = 1024 * 1024
const WALK_MAX = 4000 // entries looked at per agent folder
const SLACK = 5000
const UUID_TAIL = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Session ids an agent hands out: letters, digits, _ and -, nothing a shell
// could read as anything else (the same rule as agentResume.isSessionId).
export const plainId = (id) => typeof id === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_-]{5,79}$/.test(id)

const object = (v) => v && typeof v === 'object' && !Array.isArray(v)
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '')
const oneLine = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '')
const title = (v) => oneLine(v).slice(0, 120)
const realPrompt = (v) => !!title(v) && !v.trim().startsWith('<') && !v.trim().startsWith('[Tessel]')
const folder = (v) =>
  typeof v === 'string' && (isAbsolute(v) || win32.isAbsolute(v)) && !/[\x00-\x1f]/.test(v) ? v : ''
const time = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) return v > 0 && v < 1e11 ? v * 1000 : v // seconds or ms
  if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim())) return time(Number(v))
  const t = Date.parse(v || '')
  return Number.isFinite(t) ? t : 0
}
const json = (text) => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
const jsonLines = (text) =>
  String(text)
    .split('\n')
    .map((l) => (l.trim().startsWith('{') ? json(l) : null))
    .filter(object)
// Plain text of message content: a string, or text parts ({ type: 'text', text }).
export function contentText(v) {
  if (typeof v === 'string') return v
  if (!Array.isArray(v)) return ''
  return v
    .map((p) => (typeof p === 'string' ? p : object(p) && (!p.type || p.type === 'text') && typeof p.text === 'string' ? p.text : ''))
    .filter(Boolean)
    .join('\n')
}

// --- Confinement -------------------------------------------------------------

const realCache = new Map()
function real(p) {
  try {
    return fs.realpathSync.native(p)
  } catch {
    return null
  }
}
// Is `file` (after links) inside `root` (after links)?
export function insideDir(root, file) {
  const r = realCache.get(root) || real(root)
  if (!r) return false
  realCache.set(root, r)
  if (realCache.size > 64) realCache.clear()
  const f = real(file)
  if (!f) return false
  const rel = relative(r, f)
  return !!rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function entries(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}
function stat(file) {
  try {
    return fs.statSync(file)
  } catch {
    return null
  }
}
// The whole of a small JSON document inside `root`, or null.
function readJsonIn(root, file, max = JSON_MAX) {
  if (!insideDir(root, file)) return null
  const s = stat(file)
  if (!s || !s.isFile() || s.size > max) return null
  const o = json(readHead(file, max))
  return object(o) ? o : null
}
function headIn(root, file, bytes = HEAD_BYTES) {
  return insideDir(root, file) ? readHead(file, bytes) : ''
}

// Files under `root` (no links followed), at most `depth` folders down.
function walk(root, { depth = 2, file = () => true, dir = () => true, since = 0 } = {}) {
  const out = []
  let seen = 0
  const go = (d, level) => {
    for (const e of entries(d)) {
      if (++seen > WALK_MAX) return
      if (e.isSymbolicLink()) continue
      const full = join(d, e.name)
      if (e.isDirectory()) {
        if (level < depth && dir(e.name, level)) go(full, level + 1)
      } else if (e.isFile() && file(e.name, full)) {
        const s = stat(full)
        if (s && s.mtimeMs >= since - SLACK) out.push({ full, updated: s.mtimeMs, born: s.birthtimeMs || s.mtimeMs, size: s.size })
      }
    }
  }
  go(root, 0)
  return out.sort((a, b) => b.updated - a.updated)
}

// --- Where each agent keeps its sessions ------------------------------------

function envDir(v) {
  const t = typeof v === 'string' ? v.trim() : ''
  return t && isAbsolute(t) ? t : ''
}
// <override (its sessions, agent or .pi / .omp folder) or ~/<dot>/agent/sessions>.
function agentSessionsDir(override, home, dot) {
  const raw = envDir(override).replace(/[\\/]+$/, '')
  if (!raw) return join(home, dot, 'agent', 'sessions')
  const leaf = basename(raw)
  if (leaf === 'sessions') return raw
  if (leaf === 'agent') return join(raw, 'sessions')
  if (leaf === dot) return join(raw, 'agent', 'sessions')
  return raw
}
export function piSessionsDir(home = os.homedir(), env = process.env) {
  return agentSessionsDir(env.PI_CODING_AGENT_DIR, home, '.pi')
}
// OMP, a Pi fork: the same layout under ~/.omp (or OMP_CODING_AGENT_DIR).
export function ompSessionsDir(home = os.homedir(), env = process.env) {
  return agentSessionsDir(env.OMP_CODING_AGENT_DIR, home, '.omp')
}
export function sessionDirs(home = os.homedir(), env = process.env) {
  const devin =
    envDir(env.DEVIN_HOME) ||
    (process.platform === 'win32'
      ? // %APPDATA% belongs to the real home only (not a test's or another account's).
        join((home === os.homedir() && envDir(env.APPDATA)) || join(home, 'AppData', 'Roaming'), 'devin', 'cli')
      : join(envDir(env.XDG_DATA_HOME) || join(home, '.local', 'share'), 'devin', 'cli'))
  return {
    droid: [join(home, '.factory', 'sessions'), join(home, '.factory', 'projects')],
    grok: join(envDir(env.GROK_HOME) || join(home, '.grok'), 'sessions'),
    pi: piSessionsDir(home, env),
    omp: ompSessionsDir(home, env),
    antigravity: join(home, '.gemini', 'antigravity-cli'),
    devin,
    cursor: join(home, '.cursor'),
    copilot: join(envDir(env.COPILOT_HOME) || join(home, '.copilot'), 'session-state'),
    kimi: envDir(env.KIMI_CODE_HOME) || join(home, '.kimi-code'),
    cline: join(clineDataDir(home), 'sessions'),
    zcode: join(home, '.zcode', 'cli', 'db')
  }
}

// --- Droid (Factory) -----------------------------------------------------------
// ~/.factory/sessions/<folder slug>/<uuid>.jsonl (older: ~/.factory/projects):
// session_start { id, title, cwd }, system { cwd }, message { role, text | message }.

export function parseDroidHead(text, fileId) {
  let id = fileId,
    cwd = '',
    started = 0,
    name = '',
    first = ''
  for (const r of jsonLines(text)) {
    if (!started) started = time(r.timestamp)
    if (r.type === 'session_start') {
      id = str(r.id) || id
      name = title(r.title) || name
      cwd = folder(r.cwd) || cwd
      continue
    }
    if (r.type === 'system') cwd = folder(r.cwd) || cwd
    const role = str(r.role) || str(object(r.message) && r.message.role)
    if (r.type === 'message' && role === 'user' && !first) {
      const t = typeof r.text === 'string' ? r.text : contentText(object(r.message) ? r.message.content : '')
      if (realPrompt(t)) first = title(t)
    }
  }
  return plainId(id) ? { id, cwd, started, title: name || first } : null
}

export function droidSessions(home = os.homedir(), { since = 0 } = {}) {
  const out = []
  for (const root of sessionDirs(home).droid) {
    for (const f of walk(root, { depth: 2, since, file: (n) => n.endsWith('.jsonl') })) {
      const m = UUID_TAIL.exec(basename(f.full, '.jsonl'))
      const head = parseDroidHead(headIn(root, f.full), m ? m[0] : basename(f.full, '.jsonl'))
      if (head) out.push({ agent: 'droid', ...head, started: head.started || f.born, updated: f.updated })
    }
  }
  return out
}

// --- Grok ------------------------------------------------------------------------
// <GROK_HOME or ~/.grok>/sessions/<encoded folder>/<id>/summary.json
// { info: { id, cwd }, generated_title, created_at, last_active_at } and
// chat_history.jsonl beside it ({ type: 'user', content } with the typed ask
// inside <user_query>, after a <user_info> bootstrap row).

export function grokUserText(content) {
  const raw = contentText(content)
  if (!raw) return ''
  const lower = raw.toLowerCase()
  const open = lower.indexOf('<user_query>')
  if (open >= 0) {
    const start = open + '<user_query>'.length
    const end = lower.indexOf('</user_query>', start)
    return (end >= 0 ? raw.slice(start, end) : raw.slice(start)).trim()
  }
  return lower.trim().startsWith('<user_info>') ? '' : raw.trim()
}

export function grokSessions(home = os.homedir(), { since = 0 } = {}) {
  const root = sessionDirs(home).grok
  const out = []
  for (const f of walk(root, { depth: 2, since, file: (n) => n === 'summary.json' })) {
    const s = readJsonIn(root, f.full)
    if (!s) continue
    const info = object(s.info) ? s.info : {}
    const id = str(info.id) || basename(dirname(f.full))
    if (!plainId(id)) continue
    let name = title(s.generated_title) || title(s.session_summary)
    if (!name) {
      for (const r of jsonLines(headIn(root, join(dirname(f.full), 'chat_history.jsonl'), 64 * 1024))) {
        const t = r.type === 'user' ? grokUserText(r.content) : ''
        if (realPrompt(t)) {
          name = title(t)
          break
        }
      }
    }
    out.push({
      agent: 'grok',
      id,
      cwd: folder(info.cwd),
      started: time(s.created_at) || f.born,
      updated: Math.max(time(s.last_active_at), time(s.updated_at), f.updated),
      title: name
    })
  }
  return out
}

// --- Pi ----------------------------------------------------------------------------
// <PI_CODING_AGENT_DIR or ~/.pi/agent/sessions>/<folder slug>/<time>_<uuid>.jsonl:
// session { id, cwd, timestamp }, then message { message: { role, content } }.
// Pi resumes by the session file (pi --session <file>).

export function parsePiHead(text) {
  let id = '',
    cwd = '',
    started = 0,
    first = ''
  for (const r of jsonLines(text)) {
    if (!started) started = time(r.timestamp)
    if (r.type === 'session') {
      id = str(r.id) || id
      cwd = folder(r.cwd) || cwd
      continue
    }
    const m = object(r.message) ? r.message : null
    if (r.type === 'message' && m && m.role === 'user' && !first) {
      const t = contentText(m.content)
      if (realPrompt(t)) first = title(t)
    }
    if (id && first) break
  }
  return plainId(id) ? { id, cwd, started, title: first } : null
}

export function piSessions(home = os.homedir(), { since = 0 } = {}) {
  const root = piSessionsDir(home)
  const out = []
  for (const f of walk(root, { depth: 1, since, file: (n) => n.endsWith('.jsonl') })) {
    const head = parsePiHead(headIn(root, f.full))
    if (head) out.push({ agent: 'pi', ...head, started: head.started || f.born, updated: f.updated, file: f.full })
  }
  return out
}

// --- OMP ---------------------------------------------------------------------------
// Pi's format in its own folder: <slug>/<time>_<uuid>.jsonl, starting with
// session { id, cwd, timestamp }. A session's own sub-folder (its task
// sub-agents' files) is one level deeper: not listed. Resumed by the file
// (omp --resume <file>).

export function ompSessions(home = os.homedir(), { since = 0 } = {}) {
  const root = ompSessionsDir(home)
  const out = []
  for (const f of walk(root, { depth: 1, since, file: (n) => n.endsWith('.jsonl') })) {
    const head = parsePiHead(headIn(root, f.full))
    if (head) out.push({ agent: 'omp', ...head, started: head.started || f.born, updated: f.updated, file: f.full })
  }
  return out
}

// --- Antigravity -----------------------------------------------------------------
// ~/.gemini/antigravity-cli/brain/<conversation id>/.system_generated/logs/transcript.jsonl
// ({ source: USER_EXPLICIT, type: USER_INPUT, content: <USER_REQUEST>..</USER_REQUEST>,
// created_at }). The transcript has no folder: history.jsonl beside brain/ has
// { display, workspace, timestamp }, joined on the first prompt within 2 s,
// only when that match is unique.

function antigravityRequest(content) {
  const c = typeof content === 'string' ? content : ''
  const open = c.indexOf('<USER_REQUEST>')
  if (open < 0) return c.trim()
  const start = open + '<USER_REQUEST>'.length
  const end = c.indexOf('</USER_REQUEST>', start)
  return (end >= 0 ? c.slice(start, end) : c.slice(start)).trim()
}
export function parseAntigravityHead(text) {
  let started = 0,
    first = '',
    at = 0
  for (const r of jsonLines(text)) {
    if (!started) started = time(r.created_at)
    const user = (r.source === 'USER_EXPLICIT' || r.source === 'USER') && (r.type === 'USER_INPUT' || r.type === 'REQUEST')
    if (!user || first) continue
    const t = antigravityRequest(r.content)
    if (realPrompt(t)) {
      first = oneLine(t)
      at = time(r.created_at)
      break
    }
  }
  return { started, prompt: first, promptAt: at || started }
}
export function antigravityWorkspace(historyText, prompt, at) {
  if (!prompt || !at) return ''
  const hits = new Set()
  for (const r of jsonLines(historyText)) {
    if (oneLine(r.display) !== prompt || !folder(r.workspace)) continue
    if (Math.abs(time(r.timestamp) - at) <= 2000) hits.add(r.workspace)
  }
  return hits.size === 1 ? [...hits][0] : ''
}

export function antigravitySessions(home = os.homedir(), { since = 0 } = {}) {
  const root = sessionDirs(home).antigravity
  const brain = join(root, 'brain')
  let history = null // read once, only when needed
  const out = []
  for (const d of entries(brain)) {
    if (!d.isDirectory() || d.isSymbolicLink() || !plainId(d.name)) continue
    const file = join(brain, d.name, '.system_generated', 'logs', 'transcript.jsonl')
    const s = stat(file)
    if (!s || !s.isFile() || s.mtimeMs < since - SLACK) continue
    const head = parseAntigravityHead(headIn(root, file))
    if (history === null) {
      // Newest prompts are at its end: its last 2 MB.
      const h = join(root, 'history.jsonl')
      history = insideDir(root, h) ? readTail(h, 2 * 1024 * 1024) : ''
    }
    out.push({
      agent: 'antigravity',
      id: d.name,
      cwd: antigravityWorkspace(history, head.prompt, head.promptAt),
      started: head.started || s.birthtimeMs || s.mtimeMs,
      updated: s.mtimeMs,
      title: title(head.prompt)
    })
    if (out.length > 400) break
  }
  return out
}

// --- Antigravity IDE (2.0) ---------------------------------------------------------
// The IDE keeps its conversations in the same brain/ layout under
// ~/.gemini/antigravity-ide (older builds: ~/.gemini/antigravity), with
// transcript_full.jsonl beside transcript.jsonl. The CLI (agy) cannot resume
// them by id: they are listed with origin 'ide' and continued in a new CLI
// conversation from their history (antigravityIdeHistory.js). Their folder:
// history.jsonl by conversationId (or the unique first-prompt match), then
// cache/{last_conversations,projects,conversation_metadata}.json.
// After Orca's shared/antigravity-session-origin.ts,
// session-scanner-antigravity-{sources,paths,history,metadata}.ts and
// antigravity-transcript-candidates.ts (MIT, Copyright (c) 2026 Lovecast Inc.).

export const ANTIGRAVITY_IDE_ORIGINS = ['antigravity-ide', 'antigravity']
export function antigravityIdeRoots(home = os.homedir()) {
  return ANTIGRAVITY_IDE_ORIGINS.map((o) => join(home, '.gemini', o))
}
const INDEX_MAX = 4 * 1024 * 1024
const INDEX_ROWS = 10000
const absPath = (v) => typeof v === 'string' && v.length <= 4096 && /^(?:[/\\]|[A-Za-z]:[/\\])/.test(v) && !/[\x00-\x1f]/.test(v)

// The transcript of an IDE conversation folder: the full one when it is
// there, else the compact one; both only inside `root`.
export function antigravityIdeTranscript(root, id) {
  if (!plainId(id)) return null
  const logs = join(root, 'brain', id, '.system_generated', 'logs')
  for (const name of ['transcript_full.jsonl', 'transcript.jsonl']) {
    const file = join(logs, name)
    const s = stat(file)
    if (s && s.isFile() && insideDir(root, file)) return { file, updated: s.mtimeMs, born: s.birthtimeMs || s.mtimeMs }
  }
  return null
}

// conversation id -> folder (null when two sources disagree).
export function antigravityIdeFolders(historyText, cache = {}) {
  const map = new Map()
  const note = (id, path) => {
    if (!plainId(id) || !absPath(path)) return
    if (!map.has(id)) map.set(id, path)
    else if (map.get(id) !== path) map.set(id, null)
  }
  for (const r of jsonLines(historyText).slice(-INDEX_ROWS)) {
    if (typeof r.conversationId === 'string') note(r.conversationId, typeof r.workspace === 'string' ? r.workspace.trim() : '')
  }
  const fromCache = new Map()
  const noteCache = (id, path) => {
    if (!plainId(id) || !absPath(path)) return
    if (!fromCache.has(id)) fromCache.set(id, path)
    else if (fromCache.get(id) !== path) fromCache.set(id, null)
  }
  const pairs = (o) => (object(o) ? Object.entries(o).slice(0, INDEX_ROWS) : [])
  const projects = new Map()
  for (const [k, v] of pairs(cache.projects)) {
    if (typeof v !== 'string') continue
    if (absPath(k)) projects.set(v, projects.has(v) && projects.get(v) !== k ? null : k)
    else if (absPath(v)) projects.set(k, projects.has(k) && projects.get(k) !== v ? null : v)
  }
  for (const [path, id] of pairs(cache.lastConversations)) if (typeof id === 'string') noteCache(id, path)
  for (const [id, v] of pairs(object(cache.metadata) ? cache.metadata.conversations : null)) {
    const summary = object(v) && object(v.summary) ? v.summary : null
    const p = summary && typeof summary.ProjectID === 'string' ? projects.get(summary.ProjectID) : undefined
    if (p) noteCache(id, p)
  }
  for (const [id, path] of fromCache) if (!map.has(id)) map.set(id, path)
  return map
}

export function antigravityIdeSessions(home = os.homedir(), { since = 0 } = {}) {
  const out = []
  const seen = new Set()
  for (const root of antigravityIdeRoots(home)) {
    const brain = join(root, 'brain')
    let folders = null // read once per root, only when needed
    let history = null
    for (const d of entries(brain)) {
      if (!d.isDirectory() || d.isSymbolicLink() || !plainId(d.name) || seen.has(d.name)) continue
      const t = antigravityIdeTranscript(root, d.name)
      if (!t || t.updated < since - SLACK) continue
      const head = parseAntigravityHead(headIn(root, t.file))
      if (folders === null) {
        const h = join(root, 'history.jsonl')
        history = insideDir(root, h) ? readTail(h, 2 * 1024 * 1024) : ''
        folders = antigravityIdeFolders(history, {
          projects: readJsonIn(root, join(root, 'cache', 'projects.json'), INDEX_MAX),
          lastConversations: readJsonIn(root, join(root, 'cache', 'last_conversations.json'), INDEX_MAX),
          metadata: readJsonIn(root, join(root, 'cache', 'conversation_metadata.json'), INDEX_MAX)
        })
      }
      const byId = folders.has(d.name) ? folders.get(d.name) || '' : antigravityWorkspace(history, head.prompt, head.promptAt)
      seen.add(d.name)
      out.push({
        agent: 'antigravity',
        origin: 'ide',
        id: d.name,
        cwd: folder(byId),
        started: head.started || t.born,
        updated: t.updated,
        title: title(head.prompt),
        file: t.file
      })
      if (out.length > 400) return out
    }
  }
  return out
}

// --- Devin -------------------------------------------------------------------------
// <DEVIN_HOME or %APPDATA%\devin\cli>/sessions.db, table sessions (id,
// working_directory, title, created_at, last_activity_at in seconds, hidden),
// transcripts/<id>.json (ATIF: working_directory, steps[{ source, message }]).

function devinFirstPrompt(doc) {
  for (const step of Array.isArray(doc && doc.steps) ? doc.steps : []) {
    if (!object(step) || step.source === 'system') continue
    const user = step.source === 'user' || (object(step.metadata) && step.metadata.is_user_input === true)
    if (!user) continue
    const m = step.message
    const t = typeof m === 'string' ? m : object(m) ? contentText(m.content) : contentText(m) || str(step.text)
    if (realPrompt(t)) return title(t)
  }
  return ''
}
export function devinSessions(home = os.homedir(), { since = 0 } = {}) {
  const root = sessionDirs(home).devin
  const db = join(root, 'sessions.db')
  if (!insideDir(root, db)) return []
  const cols = new Set(readRows(db, 'PRAGMA table_info(sessions)').map((c) => c.name))
  if (!cols.has('id')) return []
  const pick = ['working_directory', 'title', 'created_at', 'last_activity_at', 'hidden'].map((c) => (cols.has(c) ? c : `NULL AS ${c}`))
  const rows = readRows(db, `SELECT id, ${pick.join(', ')} FROM sessions LIMIT 1000`)
  const out = []
  for (const r of rows) {
    const id = String(r.id || '')
    if (!plainId(id) || Number(r.hidden) === 1) continue
    const started = time(r.created_at)
    const updated = time(r.last_activity_at) || started
    if (updated && updated < since - SLACK) continue
    let name = title(r.title)
    let cwd = folder(r.working_directory)
    if (!name || !cwd) {
      const doc = readJsonIn(root, join(root, 'transcripts', `${id}.json`), 2 * JSON_MAX)
      if (doc) {
        name = name || devinFirstPrompt(doc)
        cwd = cwd || folder(doc.working_directory)
      }
    }
    out.push({ agent: 'devin', id, cwd, started, updated, title: name })
  }
  return out
}

// --- ZCode ----------------------------------------------------------------------------
// ~/.zcode/cli/db/db.sqlite: OpenCode's tables (session: id, directory, title,
// time_created, time_updated in ms, parent_id, time_archived; message and
// part, data as JSON). A message ZCode marks hidden
// (semantics.transcriptVisibility) is never read for a title. After Orca's
// src/main/ai-vault/session-scanner-zcode-sources.ts and
// session-scanner-zcode-visibility.ts, MIT, Copyright (c) 2026 Lovecast Inc.

const ZCODE_VISIBLE = "COALESCE(json_extract(m.data, '$.semantics.transcriptVisibility'), 'visible') != 'hidden'"
function zcodeFirstPrompt(db, id) {
  const rows = readRows(
    db,
    `SELECT json_extract(p.data, '$.text') AS text FROM message m JOIN part p ON p.message_id = m.id
     WHERE m.session_id = ? AND ${ZCODE_VISIBLE} AND json_extract(m.data, '$.role') = 'user'
       AND json_extract(p.data, '$.type') = 'text' AND length(p.data) <= 65536
     ORDER BY m.time_created ASC, m.id ASC, p.id ASC LIMIT 8`,
    [id]
  )
  for (const r of rows) if (typeof r.text === 'string' && realPrompt(r.text)) return title(r.text)
  return ''
}
export function zcodeSessions(home = os.homedir(), { since = 0 } = {}) {
  const root = sessionDirs(home).zcode
  const db = join(root, 'db.sqlite')
  if (!fs.existsSync(db) || !insideDir(root, db)) return []
  const cols = new Set(readRows(db, 'PRAGMA table_info(session)').map((c) => c.name))
  if (!['id', 'directory', 'title', 'time_created', 'time_updated'].every((c) => cols.has(c))) return []
  const where = []
  if (cols.has('parent_id')) where.push('parent_id IS NULL')
  if (cols.has('time_archived')) where.push('time_archived IS NULL')
  if (since) where.push('time_updated >= ?')
  const rows = readRows(
    db,
    `SELECT id, directory, title, time_created, time_updated FROM session${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY time_updated DESC LIMIT 1000`,
    since ? [since - SLACK] : []
  )
  const hasParts = readRows(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('message', 'part')").length === 2
  const out = []
  for (const r of rows) {
    const id = String(r.id || '')
    if (!plainId(id)) continue
    const started = time(r.time_created)
    // Its own title, or (none yet) the first prompt typed, for the newest few.
    let name = title(r.title)
    if (!name && hasParts && out.length < 200) name = zcodeFirstPrompt(db, id)
    out.push({ agent: 'zcode', id, cwd: folder(r.directory), started, updated: time(r.time_updated) || started, title: name })
  }
  return out
}

// --- Cursor Agent ------------------------------------------------------------------
// ~/.cursor/chats/<md5 of folder>/<chat id>/meta.json { title, cwd, createdAtMs,
// updatedAtMs }; the messages are in ~/.cursor/projects/<slug>/agent-transcripts/
// <chat id>/<chat id>.jsonl ({ role, message: { content } }).

function cursorTranscriptTitle(root, id) {
  const projects = join(root, 'projects')
  for (const p of entries(projects).slice(0, 400)) {
    if (!p.isDirectory() || p.isSymbolicLink()) continue
    for (const file of [join(projects, p.name, 'agent-transcripts', id, `${id}.jsonl`), join(projects, p.name, 'agent-transcripts', `${id}.jsonl`)]) {
      if (!stat(file)) continue
      for (const r of jsonLines(headIn(root, file, 64 * 1024))) {
        if (r.role !== 'user') continue
        const t = contentText(object(r.message) ? r.message.content : r.content)
        const clean = t.replace(/<\/?user_query>/g, '')
        if (realPrompt(clean)) return title(clean)
      }
      return ''
    }
  }
  return ''
}
export function cursorSessions(home = os.homedir(), { since = 0 } = {}) {
  const root = sessionDirs(home).cursor
  const chats = join(root, 'chats')
  const buckets = entries(chats).filter((d) => d.isDirectory() && !d.isSymbolicLink()).map((d) => d.name)
  const out = []
  for (const b of buckets.slice(0, 400)) {
    for (const c of entries(join(chats, b))) {
      if (!c.isDirectory() || c.isSymbolicLink() || !plainId(c.name)) continue
      const file = join(chats, b, c.name, 'meta.json')
      const s = stat(file)
      if (!s || s.mtimeMs < since - SLACK) continue
      const m = readJsonIn(root, file, 64 * 1024)
      if (!m) continue
      out.push({
        agent: 'cursor',
        id: c.name,
        cwd: folder(m.cwd),
        started: time(m.createdAtMs) || s.birthtimeMs || s.mtimeMs,
        updated: time(m.updatedAtMs) || s.mtimeMs,
        title: title(m.title)
      })
    }
  }
  return out
}
function withCursorTitles(rows, home) {
  const root = sessionDirs(home).cursor
  return rows.map((r) => (r.title ? r : { ...r, title: cursorTranscriptTitle(root, r.id) }))
}

// --- Copilot CLI -----------------------------------------------------------------
// ~/.copilot/session-state/<id>/events.jsonl: session.start { sessionId,
// context.cwd, startTime }, user.message { content }.

export function parseCopilotHead(text, dirId) {
  let id = '',
    cwd = '',
    started = 0,
    first = ''
  for (const r of jsonLines(text)) {
    const d = object(r.data) ? r.data : {}
    if (r.type === 'session.start') {
      id = str(d.sessionId) || dirId
      cwd = folder(object(d.context) ? d.context.cwd : '') || cwd
      started = time(d.startTime) || time(r.timestamp)
      continue
    }
    if (r.type === 'user.message' && !first) {
      const t = str(d.content) || str(d.transformedContent)
      if (realPrompt(t)) first = title(t)
    }
    if (id && first) break
  }
  return plainId(id) ? { id, cwd, started, title: first } : null
}
export function copilotHistorySessions(home = os.homedir(), { since = 0 } = {}) {
  const root = sessionDirs(home).copilot
  const out = []
  for (const f of walk(root, { depth: 1, since, file: (n) => n === 'events.jsonl' })) {
    const head = parseCopilotHead(headIn(root, f.full), basename(dirname(f.full)))
    if (head) out.push({ agent: 'copilot', ...head, updated: f.updated })
  }
  return out
}

// --- Kimi Code ---------------------------------------------------------------------
// <KIMI_CODE_HOME or ~/.kimi-code>/sessions/<workspace>/<session id>/state.json
// { title, lastPrompt, createdAt, updatedAt } (or session-meta/state.json);
// the folder is in state.json or in session_index.jsonl { sessionId, workDir }.

function kimiWorkDirs(root) {
  const map = new Map()
  for (const r of jsonLines(headIn(root, join(root, 'session_index.jsonl'), 2 * 1024 * 1024))) {
    if (plainId(r.sessionId) && folder(r.workDir)) map.set(r.sessionId, r.workDir)
  }
  return map
}
export function kimiHistorySessions(home = os.homedir(), { since = 0 } = {}) {
  const root = sessionDirs(home).kimi
  const sessions = join(root, 'sessions')
  let workDirs = null
  const out = []
  for (const ws of entries(sessions)) {
    if (!ws.isDirectory() || ws.isSymbolicLink() || ws.name.startsWith('.')) continue
    for (const s of entries(join(sessions, ws.name))) {
      if (!s.isDirectory() || s.isSymbolicLink() || !plainId(s.name)) continue
      for (const file of [join(sessions, ws.name, s.name, 'state.json'), join(sessions, ws.name, s.name, 'session-meta', 'state.json')]) {
        const st = stat(file)
        if (!st) continue
        if (st.mtimeMs < since - SLACK) break
        let meta = readJsonIn(root, file)
        if (!meta) break
        if (object(meta.data) && !meta.cwd && !meta.workDir) meta = meta.data
        const custom = object(meta.custom) ? meta.custom : {}
        let cwd = folder(meta.cwd) || folder(meta.workDir) || folder(custom.cwd)
        if (!cwd) {
          if (!workDirs) workDirs = kimiWorkDirs(root)
          cwd = workDirs.get(s.name) || ''
        }
        out.push({
          agent: 'kimi',
          id: s.name,
          cwd,
          started: time(meta.createdAt) || time(meta.createdAtMs) || st.birthtimeMs || st.mtimeMs,
          updated: time(meta.updatedAt) || time(meta.updatedAtMs) || st.mtimeMs,
          title: title(meta.title) || (realPrompt(meta.lastPrompt || '') ? title(meta.lastPrompt) : '')
        })
        break
      }
    }
  }
  return out
}

// --- Cline -------------------------------------------------------------------------
// <cline data>/db/sessions.db (id, folder, dates) and <cline data>/sessions/<id>/
// <id>.json { session_id, cwd | workspace_root, started_at, prompt }.

export function clineHistorySessions(home = os.homedir(), { since = 0 } = {}) {
  const root = sessionDirs(home).cline
  const out = []
  for (const d of entries(root)) {
    if (!d.isDirectory() || d.isSymbolicLink() || !plainId(d.name)) continue
    const file = join(root, d.name, `${d.name}.json`)
    const s = stat(file)
    if (!s || s.mtimeMs < since - SLACK) continue
    const m = readJsonIn(root, file)
    if (!m || m.is_subagent === true || m.parent_session_id) continue
    const id = str(m.session_id) || d.name
    if (!plainId(id)) continue
    let name = realPrompt(m.prompt || '') ? title(m.prompt) : ''
    if (!name) {
      const msgs = readJsonIn(root, join(root, d.name, `${d.name}.messages.json`), 2 * JSON_MAX)
      for (const msg of Array.isArray(msgs && msgs.messages) ? msgs.messages : []) {
        if (!object(msg) || msg.role !== 'user') continue
        const t = contentText(msg.content)
        if (realPrompt(t)) {
          name = title(t)
          break
        }
      }
    }
    out.push({
      agent: 'cline',
      id,
      cwd: folder(m.cwd) || folder(m.workspace_root),
      started: time(m.started_at) || s.birthtimeMs || s.mtimeMs,
      updated: s.mtimeMs,
      title: name
    })
  }
  return out
}

// --- History for all of them ---------------------------------------------------------

const READERS = {
  copilot: copilotHistorySessions,
  kimi: kimiHistorySessions,
  cline: clineHistorySessions,
  cursor: (home, q) => withCursorTitles(cursorSessions(home, q), home),
  droid: droidSessions,
  grok: grokSessions,
  pi: piSessions,
  omp: ompSessions,
  antigravity: antigravitySessions,
  devin: devinSessions,
  zcode: zcodeSessions
}
export const HISTORY_AGENTS = Object.keys(READERS)

// Newest conversations with a title (never messaged: nothing to resume), at
// most `limit` per agent, only from `cwd` when given.
export function moreAgentsHistory({ cwd = null, limit = 60 } = {}, home = os.homedir()) {
  const want = cwd ? normDir(cwd) : null
  const out = []
  // Antigravity IDE conversations: listed apart from the CLI's own (their
  // own per-agent limit), to be continued in a new CLI conversation.
  for (const read of [...HISTORY_AGENTS.map((a) => READERS[a]), antigravityIdeSessions]) {
    let rows = []
    try {
      rows = read(home, {})
    } catch {
      continue
    }
    const seen = new Set()
    const picked = rows
      .filter((r) => r.title && (!want || normDir(r.cwd) === want))
      .sort((a, b) => b.updated - a.updated)
      .filter((r) => !seen.has(r.id) && seen.add(r.id))
      .slice(0, limit)
      .map(({ file, ...r }) => r) // eslint-disable-line no-unused-vars
    out.push(...picked)
  }
  return out
}

// The sessions an agent has, for finding the one a pane started (by folder and
// start time) and checking one exists before resuming it.
export function agentSessionList(agent, home = os.homedir(), q = {}) {
  const read = READERS[agent]
  if (!read || agent === 'copilot' || agent === 'kimi' || agent === 'cline') return null // agentResume.js has its own
  return agent === 'cursor' ? cursorSessions(home, q) : read(home, q)
}

// Pi and OMP resume by their session file: only one inside their sessions
// folder, written with forward slashes, and plain enough to put on a command line.
function resumeFileIn(root, rows, id) {
  const hit = rows.find((s) => s.id === id)
  if (!hit || !insideDir(root, hit.file)) return null
  const path = resolve(hit.file).replace(/\\/g, '/')
  return /^[A-Za-z0-9_.:\/-]+$/.test(path) ? path : null
}
export function piResumeFile(id, home = os.homedir()) {
  return plainId(id) ? resumeFileIn(piSessionsDir(home), piSessions(home), id) : null
}
export function ompResumeFile(id, home = os.homedir()) {
  return plainId(id) ? resumeFileIn(ompSessionsDir(home), ompSessions(home), id) : null
}
