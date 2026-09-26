// Which model an agent pane uses, for the pane header.
//
// Best first:
// 1. The running session (Claude Code, Codex, Copilot: its conversation
//    file; Cline: its sessions database), so a change with /model shows up.
// 2. A --model / -m option in the agent's command.
// 3. What the agent remembers or its settings file (OpenCode's last picked
//    model, Cline's provider settings, the folder's settings, the user's).
// Nothing found: null (the header shows nothing rather than a guess).
// watchModelFiles tells when one of these files changes.
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { isUuid } from './agentSessions'
import { clineDataDir } from './jsonAgents'

const TAIL = 256 * 1024

function readTail(file, bytes = TAIL) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const size = fs.fstatSync(fd).size
    const len = Math.min(bytes, size)
    const buf = Buffer.alloc(len)
    const n = fs.readSync(fd, buf, 0, len, size - len)
    return buf.subarray(0, n).toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

// JSON, or JSON with comments and trailing commas (.jsonc).
function parseLoose(text) {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    /* comments? */
  }
  try {
    const plain = text
      .replace(/("(?:[^"\\]|\\.)*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m, str) => str || '')
      .replace(/,(\s*[}\]])/g, '$1')
    return JSON.parse(plain)
  } catch {
    return null
  }
}

// --- 1. Conversation files -------------------------------------------------

// The model of the latest answer in a Claude Code transcript (JSON lines).
export function claudeModelFromText(text) {
  const lines = String(text || '').split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line.includes('"model"')) continue
    try {
      const o = JSON.parse(line)
      const m = o && o.message && o.message.model
      if (o.type === 'assistant' && typeof m === 'string' && m && !m.startsWith('<')) return m
    } catch {
      /* a line cut by the tail read */
    }
  }
  return null
}

// The model (and reasoning effort) of the latest turn in a Codex rollout.
export function codexModelFromText(text) {
  const lines = String(text || '').split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line.includes('"model"')) continue
    try {
      const o = JSON.parse(line)
      const p = o && o.payload
      if (!p) continue
      if (o.type === 'turn_context' && typeof p.model === 'string' && p.model) {
        return { model: p.model, effort: typeof p.effort === 'string' ? p.effort : null }
      }
      const s = p.type === 'thread_settings_applied' && p.thread_settings
      if (s && typeof s.model === 'string' && s.model) {
        const effort = s.reasoning_effort || s.effort
        return { model: s.model, effort: typeof effort === 'string' ? effort : null }
      }
    } catch {
      /* a line cut by the tail read */
    }
  }
  return null
}

const fileCache = new Map() // session id -> transcript path

function claudeTranscript(id, home) {
  const hit = fileCache.get(id)
  if (hit && fs.existsSync(hit)) return hit
  const root = join(home, '.claude', 'projects')
  let dirs
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return null
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    const f = join(root, d.name, `${id}.jsonl`)
    if (fs.existsSync(f)) {
      fileCache.set(id, f)
      return f
    }
  }
  return null
}

function codexRollout(id, home, now = Date.now()) {
  const hit = fileCache.get(id)
  if (hit && fs.existsSync(hit)) return hit
  const root = join(home, '.codex', 'sessions')
  const d = new Date(now)
  // Newest day first, at most 30 days back.
  for (let i = 0; i < 31; i++) {
    const dir = join(
      root,
      String(d.getFullYear()),
      String(d.getMonth() + 1).padStart(2, '0'),
      String(d.getDate()).padStart(2, '0')
    )
    d.setDate(d.getDate() - 1)
    let files
    try {
      files = fs.readdirSync(dir)
    } catch {
      continue
    }
    const f = files.find((n) => n.startsWith('rollout-') && n.endsWith(`${id}.jsonl`))
    if (f) {
      fileCache.set(id, join(dir, f))
      return join(dir, f)
    }
  }
  return null
}

// The model of the latest answer (or /model change) in a Copilot session's
// events.jsonl. "auto" until the first answer says which model it picked.
export function copilotModelFromText(text) {
  const lines = String(text || '').split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line.includes('"model') || !line.includes('"type":"')) continue
    try {
      const o = JSON.parse(line)
      const d = o && o.data
      if (!d) continue
      if (o.type === 'assistant.message' && typeof d.model === 'string' && d.model) return { model: d.model, effort: null }
      if (o.type === 'session.model_change' && typeof d.newModel === 'string' && d.newModel) {
        return { model: d.newModel, effort: typeof d.reasoningEffort === 'string' ? d.reasoningEffort : null }
      }
    } catch {
      /* a line cut by the tail read */
    }
  }
  return null
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

const normDir = (p) =>
  String(p || '')
    .replace(/\//g, '\\')
    .replace(/\\+$/, '')
    .toLowerCase()

// Copilot keeps each session in ~/.copilot/session-state/<id>/, with an
// inuse.<pid>.lock file while a Copilot process has it open. The pane's
// session: one open by a running Copilot, in the pane's folder if any,
// the most recently written first.
function copilotLiveSession(cwd, home) {
  const root = join(home, '.copilot', 'session-state')
  let dirs
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())
  } catch {
    return null
  }
  const want = normDir(cwd)
  let best = null
  for (const d of dirs) {
    const dir = join(root, d.name)
    let files
    try {
      files = fs.readdirSync(dir)
    } catch {
      continue
    }
    const open = files.some((f) => {
      const m = /^inuse\.(\d+)\.lock$/.exec(f)
      return m && pidAlive(Number(m[1]))
    })
    if (!open || !files.includes('events.jsonl')) continue
    let mtime = 0
    try {
      mtime = fs.statSync(join(dir, 'events.jsonl')).mtimeMs
    } catch {
      continue
    }
    const ws = /^cwd:\s*(.+?)\s*$/m.exec(readText(join(dir, 'workspace.yaml')))
    const here = !!(want && ws && normDir(ws[1]) === want)
    if (!best || here > best.here || (here === best.here && mtime > best.mtime)) {
      best = { file: join(dir, 'events.jsonl'), here, mtime }
    }
  }
  return best ? best.file : null
}

// OpenCode remembers the models last picked in its model list (newest first).
function opencodeRecent(home) {
  const dir = process.env.XDG_STATE_HOME || join(home, '.local', 'state')
  const file = join(dir, 'opencode', 'model.json')
  const o = parseLoose(readText(file))
  const r = o && Array.isArray(o.recent) ? o.recent[0] : null
  if (!r || typeof r.modelID !== 'string' || !r.modelID) return null
  let mtime = 0
  try {
    mtime = fs.statSync(file).mtimeMs
  } catch {
    /* read just above */
  }
  return { model: r.providerID ? `${r.providerID}/${r.modelID}` : r.modelID, mtime }
}

// Cline 3 lists its sessions in <data>/db/sessions.db (SQLite), each with
// the process running it, its folder, provider and model. The pane's: one
// still open whose process runs, in the pane's folder first.
export function clineSessionModel(rows, cwd, alive = pidAlive) {
  const want = normDir(cwd)
  let best = null
  for (const r of rows || []) {
    if (!r || r.ended_at || r.is_subagent || !r.model || !alive(Number(r.pid))) continue
    const here = !!(want && normDir(r.cwd) === want)
    const at = Date.parse(r.updated_at || '') || 0
    if (!best || here > best.here || (here === best.here && at > best.at)) best = { here, at, model: r.model }
  }
  return best ? { model: best.model, at: best.at } : null
}

function clineLive(cwd, home) {
  const sqlite = process.getBuiltinModule ? process.getBuiltinModule('node:sqlite') : null
  const file = join(clineDataDir(home), 'db', 'sessions.db')
  if (!sqlite || !fs.existsSync(file)) return null
  let db
  try {
    db = new sqlite.DatabaseSync(file, { readOnly: true })
    const rows = db
      .prepare(
        'SELECT pid, model, cwd, ended_at, is_subagent, updated_at FROM sessions WHERE ended_at IS NULL ORDER BY updated_at DESC LIMIT 50'
      )
      .all()
    return clineSessionModel(rows, cwd)
  } catch {
    return null // busy, or another layout
  } finally {
    try {
      if (db) db.close()
    } catch {
      /* closed */
    }
  }
}

// Cline's provider settings: the provider in use and its model (none set:
// the provider's own default, which is not written anywhere).
function clineSettings(home) {
  const file = join(clineDataDir(home), 'settings', 'providers.json')
  const o = parseLoose(readText(file))
  const p = o && o.lastUsedProvider && o.providers && o.providers[o.lastUsedProvider]
  const m = p && p.settings && p.settings.model
  if (typeof m !== 'string' || !m) return null
  let mtime = 0
  try {
    mtime = fs.statSync(file).mtimeMs
  } catch {
    /* read just above */
  }
  return { model: m, mtime }
}

// --- 2. The command's own option ----------------------------------------------

export function modelFromCommand(command) {
  const m = /(?:^|\s)(?:--model|-m)(?:=|\s+)("([^"]+)"|'([^']+)'|([^\s"']+))/.exec(String(command || ''))
  return m ? m[2] || m[3] || m[4] : null
}

// --- 3. Settings files ------------------------------------------------------------

// Codex's config.toml: the top-level `model` and `model_reasoning_effort`
// (before the first [section]).
export function codexModelFromToml(text) {
  const top = String(text || '').split(/^\s*\[/m)[0]
  const val = (key) => {
    const m = new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, 'm').exec(top)
    return m ? m[1] : null
  }
  const model = val('model')
  return model ? { model, effort: val('model_reasoning_effort') } : null
}

function jsonModel(file, pick) {
  const o = parseLoose(readText(file))
  if (!o || typeof o !== 'object') return null
  const m = pick(o)
  return typeof m === 'string' && m.trim() ? m.trim() : null
}

const plainModel = (o) => o.model
const nestedModel = (o) => (o.model && typeof o.model === 'object' ? o.model.name : o.model)

function settingsModel(agentId, cwd, home) {
  const files = []
  if (agentId === 'claude') {
    if (cwd) files.push(join(cwd, '.claude', 'settings.local.json'), join(cwd, '.claude', 'settings.json'))
    files.push(join(home, '.claude', 'settings.json'))
    for (const f of files) {
      const m = jsonModel(f, plainModel)
      if (m) return { model: m }
    }
    return null
  }
  if (agentId === 'codex') return codexModelFromToml(readText(join(home, '.codex', 'config.toml')))
  if (agentId === 'gemini' || agentId === 'qwen') {
    const dir = agentId === 'gemini' ? '.gemini' : '.qwen'
    if (cwd) files.push(join(cwd, dir, 'settings.json'))
    files.push(join(home, dir, 'settings.json'))
    for (const f of files) {
      const m = jsonModel(f, nestedModel)
      if (m) return { model: m }
    }
    return null
  }
  if (agentId === 'opencode') {
    if (cwd) files.push(join(cwd, 'opencode.json'), join(cwd, 'opencode.jsonc'))
    const cfg = process.env.XDG_CONFIG_HOME || join(home, '.config')
    files.push(join(cfg, 'opencode', 'opencode.json'), join(cfg, 'opencode', 'opencode.jsonc'))
    for (const f of files) {
      const m = jsonModel(f, plainModel)
      if (m) return { model: m }
    }
    return null
  }
  if (agentId === 'copilot') {
    for (const f of [join(home, '.copilot', 'settings.json'), join(home, '.copilot', 'config.json')]) {
      const m = jsonModel(f, plainModel)
      if (m) return { model: m }
    }
    return null
  }
  return null
}

// { model, effort, source: 'session' | 'command' | 'picked' | 'settings' } or null.
// launchedAt (ms): when the pane started, so a model picked in OpenCode
// since then beats its settings file.
export function agentModel({ agentId, sessionId, command, cwd, launchedAt = 0 } = {}, home = os.homedir()) {
  if (!agentId) return null
  if (agentId === 'copilot') {
    const f = copilotLiveSession(cwd, home)
    const m = f && copilotModelFromText(readTail(f))
    if (m) return { ...m, source: 'session' }
  }
  if (agentId === 'cline') {
    const live = clineLive(cwd, home)
    const set = clineSettings(home)
    // A model picked in Cline after its session was written: that one.
    if (live && !(set && set.mtime > live.at)) return { model: live.model, effort: null, source: 'session' }
    const flag = modelFromCommand(command)
    if (flag) return { model: flag, effort: null, source: 'command' }
    return set ? { model: set.model, effort: null, source: 'settings' } : null
  }
  if (isUuid(sessionId)) {
    if (agentId === 'claude') {
      const f = claudeTranscript(sessionId, home)
      const m = f && claudeModelFromText(readTail(f))
      if (m) {
        // The transcript never says 1M context; the settings do (opus[1m]).
        const set = settingsModel('claude', cwd, home)
        const big = set && /^(\w+)\[1m\]$/i.exec(set.model)
        const same = big && m.toLowerCase().includes(big[1].toLowerCase())
        return { model: same ? m + '[1m]' : m, effort: null, source: 'session' }
      }
    } else if (agentId === 'codex') {
      const f = codexRollout(sessionId, home)
      const m = f && codexModelFromText(readTail(f))
      if (m) return { ...m, source: 'session' }
    }
  }
  const flag = modelFromCommand(command)
  if (flag) return { model: flag, effort: null, source: 'command' }
  const picked = agentId === 'opencode' ? opencodeRecent(home) : null
  if (picked && launchedAt && picked.mtime >= launchedAt) return { model: picked.model, effort: null, source: 'picked' }
  const s = settingsModel(agentId, cwd, home)
  if (s) return { model: s.model, effort: s.effort || null, source: 'settings' }
  return picked ? { model: picked.model, effort: null, source: 'picked' } : null
}

// --- Watching: a model change shows right away ---------------------------------
// The files where agents keep their model are watched; a change calls
// onChange(agentId) (at most about once a second per agent), so the panes of
// that agent read it again. A folder that does not exist yet is tried again
// every minute (an agent installed later).
export function watchModelFiles(onChange, home = os.homedir()) {
  const state = process.env.XDG_STATE_HOME || join(home, '.local', 'state')
  const cfg = process.env.XDG_CONFIG_HOME || join(home, '.config')
  const cline = clineDataDir(home)
  const targets = [
    { agent: 'claude', dir: join(home, '.claude'), match: /^settings\.json$/ },
    { agent: 'codex', dir: join(home, '.codex'), match: /^config\.toml$/ },
    { agent: 'gemini', dir: join(home, '.gemini'), match: /^settings\.json$/ },
    { agent: 'qwen', dir: join(home, '.qwen'), match: /^settings\.json$/ },
    { agent: 'copilot', dir: join(home, '.copilot'), match: /^(settings|config)\.json$/ },
    { agent: 'copilot', dir: join(home, '.copilot', 'session-state'), match: /events\.jsonl$/, recursive: true },
    { agent: 'opencode', dir: join(state, 'opencode'), match: /^model\.json$/ },
    { agent: 'opencode', dir: join(cfg, 'opencode'), match: /^opencode\.jsonc?$/ },
    { agent: 'cline', dir: join(cline, 'settings'), match: /^providers\.json$/ },
    { agent: 'cline', dir: join(cline, 'db'), match: /^sessions\.db/ }
  ]
  const watchers = new Map() // target -> fs.FSWatcher
  const timers = new Map() // agent -> timeout
  const last = new Map() // agent -> last call (ms)
  let closed = false
  const fire = (agent) => {
    if (closed || timers.has(agent)) return
    const wait = Math.max(300, 1000 - (Date.now() - (last.get(agent) || 0)))
    timers.set(
      agent,
      setTimeout(() => {
        timers.delete(agent)
        last.set(agent, Date.now())
        if (!closed) onChange(agent)
      }, wait)
    )
  }
  const attach = () => {
    for (const t of targets) {
      if (watchers.has(t) || !fs.existsSync(t.dir)) continue
      try {
        const w = fs.watch(t.dir, { recursive: !!t.recursive, persistent: false }, (_ev, name) => {
          if (!name || t.match.test(String(name).replace(/\\/g, '/').split('/').pop())) fire(t.agent)
        })
        w.on('error', () => {
          // The folder went away: watch it again when it is back.
          try {
            w.close()
          } catch {
            /* closed */
          }
          watchers.delete(t)
        })
        watchers.set(t, w)
      } catch {
        /* not watchable now: next minute */
      }
    }
  }
  attach()
  const retry = setInterval(attach, 60000)
  if (retry.unref) retry.unref()
  return () => {
    closed = true
    clearInterval(retry)
    for (const w of watchers.values()) {
      try {
        w.close()
      } catch {
        /* closed */
      }
    }
    watchers.clear()
    for (const t of timers.values()) clearTimeout(t)
    timers.clear()
  }
}
