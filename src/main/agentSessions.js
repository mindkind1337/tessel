// Agent conversation sessions, so a reopened pane can resume where it left off.
//
// Claude Code: we choose the session id up front (`claude --session-id <uuid>`)
//   and resume it with `claude --resume <uuid>`. The transcript file only exists
//   once you've sent a message, so we check for it before resuming.
// Codex: it picks its own id, and writes ~/.codex/sessions/YYYY/MM/DD/
//   rollout-*.jsonl whose first line is session_meta { id, cwd, timestamp }.
//   We find the session a pane started by its folder and start time.
// Qoder CLI: Claude Code's transcript format under ~/.qoder/projects (history
//   and search only; it reports its own id through its hooks).
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { normDir, readFirstLine, readHead } from './fileRead'
import { geminiHistory, qwenHistory, opencodeHistory } from './agentHistory'
import { moreAgentsHistory } from './agentSessionSources'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(id) {
  return typeof id === 'string' && UUID.test(id)
}

// Does Claude Code have a saved transcript for this session id?
export function claudeSessionExists(id, home = os.homedir(), configDir = join(home, '.claude')) {
  if (!isUuid(id)) return false
  const root = join(configDir, 'projects')
  let dirs
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return false
  }
  return dirs.some((d) => d.isDirectory() && fs.existsSync(join(root, d.name, `${id}.jsonl`)))
}

// Parse a Codex rollout file's first line into { id, cwd, time } (or null).
export function parseCodexMeta(line) {
  try {
    const o = JSON.parse(line)
    if (!o || o.type !== 'session_meta' || !o.payload) return null
    const p = o.payload
    if (!isUuid(p.id)) return null
    return { id: p.id, cwd: p.cwd || '', time: Date.parse(p.timestamp || o.timestamp || '') || 0 }
  } catch {
    return null
  }
}

function dayDirs(root, since, now) {
  const out = []
  const d = new Date(since - 24 * 3600 * 1000)
  d.setHours(0, 0, 0, 0)
  while (d.getTime() <= now) {
    const y = String(d.getFullYear())
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    out.push(join(root, y, m, day))
    d.setDate(d.getDate() + 1)
  }
  return out
}

// The earliest Codex session started in `cwd` at or after `since` (ms) that
// isn't already claimed by another pane (or the most recent one, with
// `latest`, for panes whose start time wasn't recorded).
export function findCodexSession(
  { cwd, since, exclude = [], latest = false, activeSince = 0 },
  home = os.homedir(),
  now = Date.now(),
  codexHome = join(home, '.codex')
) {
  if (!cwd || !Number.isFinite(since)) return null
  // Never back to 1970 (since 0): at most the last 30 days of session folders.
  since = Math.max(since, now - 30 * 24 * 3600 * 1000)
  const root = join(codexHome, 'sessions')
  const want = normDir(cwd)
  const skip = new Set(exclude)
  const slack = 5000
  let best = null
  for (const dir of dayDirs(root, since, now)) {
    let files
    try {
      files = fs.readdirSync(dir).filter((f) => f.startsWith('rollout-') && f.endsWith('.jsonl'))
    } catch {
      continue
    }
    for (const f of files) {
      const full = join(dir, f)
      let stat
      try {
        stat = fs.statSync(full)
      } catch {
        continue
      }
      if (stat.mtimeMs < since - slack) continue
      // Only sessions still being written (used after the pane re-attached).
      if (activeSince && stat.mtimeMs < activeSince) continue
      const meta = parseCodexMeta(readFirstLine(full))
      if (!meta || skip.has(meta.id)) continue
      if (normDir(meta.cwd) !== want) continue
      if (meta.time && meta.time < since - slack) continue
      if (!best || (latest ? meta.time > best.time : meta.time < best.time)) best = meta
    }
  }
  return best ? best.id : null
}

// ---------------------------------------------------------------------------
// Session list: past conversations, newest first, with a per-agent limit.
// Only the start of each file is read, so this stays fast with many sessions.
// ---------------------------------------------------------------------------

function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const t = content.find((c) => c && (c.type === 'text' || c.type === 'input_text') && c.text)
    return t ? t.text : ''
  }
  return ''
}

// Skip injected context (tags like <environment_context>, <command-name>).
function isRealPrompt(text) {
  const t = String(text || '').trim()
  return t.length > 0 && !t.startsWith('<')
}

function oneLine(text, max = 120) {
  const t = String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}

// Parse the head of a Claude transcript: { cwd, started, title, sessionId }.
export function parseClaudeHead(text) {
  let cwd = ''
  let started = 0
  let title = ''
  let sessionId = ''
  for (const line of String(text).split('\n')) {
    if (!line.startsWith('{')) continue
    let o
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    if (!cwd && typeof o.cwd === 'string') cwd = o.cwd
    if (!sessionId && typeof o.sessionId === 'string') sessionId = o.sessionId
    if (!started && typeof o.timestamp === 'string') started = Date.parse(o.timestamp) || 0
    if (!title && o.type === 'user' && !o.isMeta && o.message) {
      const t = textOf(o.message.content)
      if (isRealPrompt(t)) title = oneLine(t)
    }
    if (!title && o.type === 'summary' && o.summary) title = oneLine(o.summary)
    if (cwd && title) break
  }
  return { cwd, started, title, sessionId }
}

// --- Qoder CLI ------------------------------------------------------------------
// Qoder writes Claude Code's transcript lines (~/.qoder/projects/<folder
// slug>/<session>.jsonl, sub-agents in a <session>/subagents/ folder) with
// records of its own (workspace-directories, runtime-config, active-leaf).
// After Orca's session-scanner-qoder-parser.ts and
// session-scanner-agent-sources.ts (MIT, Copyright (c) 2026 Lovecast Inc.).
export const qoderDir = (home = os.homedir()) => join(home, '.qoder')

// A Qoder line as the Claude readers take it: of a message, only its text
// blocks (its thinking, tool calls and tool output stay out of the history's
// previews and of search). Any other line as it is.
export function qoderTextLine(line) {
  if (typeof line !== 'string' || !line.includes('"content"')) return line
  let o
  try {
    o = JSON.parse(line)
  } catch {
    return line
  }
  const message = o && typeof o === 'object' ? o.message : null
  if (!message || typeof message !== 'object' || !Array.isArray(message.content)) return line
  const content = message.content.filter((b) => b && typeof b === 'object' && b.type === 'text')
  return JSON.stringify({ ...o, message: { ...message, content } })
}

// A Qoder transcript's file (<session>.jsonl, or another name holding that
// sessionId), or null.
export function qoderTranscriptIn(dir, id) {
  if (!isUuid(id)) return null
  const root = join(dir, 'projects')
  const named = []
  for (const d of readDirs(root)) {
    const file = join(root, d.name, `${id}.jsonl`)
    if (fs.existsSync(file)) return file
    for (const f of readNames(join(root, d.name))) if (f.endsWith('.jsonl')) named.push(join(root, d.name, f))
  }
  for (const file of named) if (parseClaudeHead(readHead(file, 16 * 1024)).sessionId === id) return file
  return null
}

function readDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory())
  } catch {
    return []
  }
}
function readNames(dir) {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

// Parse the head of a Codex rollout: { id, cwd, started, title }.
export function parseCodexHead(text) {
  const lines = String(text).split('\n')
  const meta = parseCodexMeta(lines[0] || '')
  if (!meta) return null
  let title = ''
  for (const line of lines.slice(1)) {
    if (!line.includes('"user"') && !line.includes('user_message')) continue
    let o
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    const p = o.payload || {}
    let t = ''
    if (o.type === 'response_item' && p.type === 'message' && p.role === 'user')
      t = textOf(p.content)
    else if (o.type === 'event_msg' && p.type === 'user_message') t = p.message
    if (isRealPrompt(t)) {
      title = oneLine(t)
      break
    }
  }
  return { id: meta.id, cwd: meta.cwd, started: meta.time, title }
}

function sameDir(a, b) {
  return normDir(a) === normDir(b)
}

// Conversations in a Claude Code style config folder (<dir>/projects/<slug>/<uuid>.jsonl).
// anyName (Qoder): any <name>.jsonl, its id the sessionId inside.
function claudeLikeHistory(agent, configDir, { cwd, limit, anyName = false }) {
  const root = join(configDir, 'projects')
  let projects = []
  try {
    projects = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())
  } catch {
    return [] // not used yet
  }
  const files = []
  for (const d of projects) {
    let names = []
    try {
      names = fs.readdirSync(join(root, d.name))
    } catch {
      continue
    }
    for (const f of names) {
      const m = /^([0-9a-f-]{36})\.jsonl$/i.exec(f)
      if (!m && !(anyName && f.endsWith('.jsonl'))) continue
      const full = join(root, d.name, f)
      try {
        files.push({ id: m ? m[1] : '', full, updated: fs.statSync(full).mtimeMs })
      } catch {
        /* vanished */
      }
    }
  }
  files.sort((a, b) => b.updated - a.updated)
  const out = []
  for (const f of files) {
    if (out.length >= limit) break
    const head = parseClaudeHead(readHead(f.full))
    if (!head.title) continue // never messaged: nothing to resume
    if (cwd && !sameDir(head.cwd, cwd)) continue
    const id = anyName && isUuid(head.sessionId) ? head.sessionId : f.id
    if (!id) continue
    out.push({ agent, id, cwd: head.cwd, started: head.started, updated: f.updated, title: head.title })
  }
  return out
}

export function listSessions({ cwd = null, limit = 60 } = {}, home = os.homedir(), roots = {}) {
  limit = Number.isFinite(limit) ? Math.max(0, Math.min(200, Math.floor(limit))) : 60
  cwd = typeof cwd === 'string' && cwd ? cwd : null
  if (!limit) return []
  const out = []

  // Claude Code: ~/.claude/projects/<folder slug>/<uuid>.jsonl
  if (roots.claude !== null) out.push(...claudeLikeHistory('claude', roots.claude || join(home, '.claude'), { cwd, limit }))
  // OpenClaude, a Claude Code fork: the same layout under ~/.openclaude.
  if (roots.others !== false) out.push(...claudeLikeHistory('openclaude', join(home, '.openclaude'), { cwd, limit }))
  // Qoder CLI: the same format under ~/.qoder.
  if (roots.others !== false) out.push(...claudeLikeHistory('qoder', qoderDir(home), { cwd, limit, anyName: true }))

  // Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
  const codexRoot = roots.codex === null ? null : join(roots.codex || join(home, '.codex'), 'sessions')
  const codexFiles = []
  const walk = (dir, depth) => {
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory() && depth < 3) walk(full, depth + 1)
      else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
        try {
          codexFiles.push({ full, updated: fs.statSync(full).mtimeMs })
        } catch {
          /* vanished */
        }
      }
    }
  }
  if (codexRoot) walk(codexRoot, 0)
  codexFiles.sort((a, b) => b.updated - a.updated)
  let codexCount = 0
  for (const f of codexFiles) {
    if (codexCount >= limit) break
    const head = parseCodexHead(readHead(f.full))
    if (!head || !head.title) continue
    if (cwd && !sameDir(head.cwd, cwd)) continue
    out.push({
      agent: 'codex',
      id: head.id,
      cwd: head.cwd,
      started: head.started,
      updated: f.updated,
      title: head.title
    })
    codexCount++
  }

  if (roots.others !== false)
    out.push(
      ...geminiHistory({ cwd, limit }, home),
      ...qwenHistory({ cwd, limit }, home),
      ...opencodeHistory({ cwd, limit }, home),
      ...moreAgentsHistory({ cwd, limit }, home)
    )
  return out.sort((a, b) => b.updated - a.updated)
}
