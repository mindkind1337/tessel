// Agent conversation sessions, so a reopened pane can resume where it left off.
//
// Claude Code: we choose the session id up front (`claude --session-id <uuid>`)
//   and resume it with `claude --resume <uuid>`. The transcript file only exists
//   once you've sent a message, so we check for it before resuming.
// Codex: it picks its own id, and writes ~/.codex/sessions/YYYY/MM/DD/
//   rollout-*.jsonl whose first line is session_meta { id, cwd, timestamp }.
//   We find the session a pane started by its folder and start time.
import fs from 'fs'
import os from 'os'
import { join } from 'path'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(id) {
  return typeof id === 'string' && UUID.test(id)
}

// Does Claude Code have a saved transcript for this session id?
export function claudeSessionExists(id, home = os.homedir()) {
  if (!isUuid(id)) return false
  const root = join(home, '.claude', 'projects')
  let dirs
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return false
  }
  return dirs.some((d) => d.isDirectory() && fs.existsSync(join(root, d.name, `${id}.jsonl`)))
}

function normDir(p) {
  return String(p || '')
    .replace(/\//g, '\\')
    .replace(/\\+$/, '')
    .toLowerCase()
}

function readFirstLine(file) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(64 * 1024)
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
  now = Date.now()
) {
  if (!cwd || !Number.isFinite(since)) return null
  const root = join(home, '.codex', 'sessions')
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
// Session list: past Claude Code and Codex conversations, newest first.
// Only the start of each file is read, so this stays fast with many sessions.
// ---------------------------------------------------------------------------

function readHead(file, bytes = 256 * 1024) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(bytes)
    const n = fs.readSync(fd, buf, 0, bytes, 0)
    return buf.subarray(0, n).toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

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

// Parse the head of a Claude transcript: { cwd, started, title }.
export function parseClaudeHead(text) {
  let cwd = ''
  let started = 0
  let title = ''
  for (const line of String(text).split('\n')) {
    if (!line.startsWith('{')) continue
    let o
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    if (!cwd && o.cwd) cwd = o.cwd
    if (!started && o.timestamp) started = Date.parse(o.timestamp) || 0
    if (!title && o.type === 'user' && !o.isMeta && o.message) {
      const t = textOf(o.message.content)
      if (isRealPrompt(t)) title = oneLine(t)
    }
    if (!title && o.type === 'summary' && o.summary) title = oneLine(o.summary)
    if (cwd && title) break
  }
  return { cwd, started, title }
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

export function listSessions({ cwd = null, limit = 60 } = {}, home = os.homedir()) {
  const out = []

  // Claude Code: ~/.claude/projects/<folder slug>/<uuid>.jsonl
  const claudeRoot = join(home, '.claude', 'projects')
  let projects = []
  try {
    projects = fs.readdirSync(claudeRoot, { withFileTypes: true }).filter((d) => d.isDirectory())
  } catch {
    /* Claude not used yet */
  }
  const claudeFiles = []
  for (const d of projects) {
    let files = []
    try {
      files = fs.readdirSync(join(claudeRoot, d.name))
    } catch {
      continue
    }
    for (const f of files) {
      const m = /^([0-9a-f-]{36})\.jsonl$/i.exec(f)
      if (!m) continue
      const full = join(claudeRoot, d.name, f)
      try {
        claudeFiles.push({ id: m[1], full, updated: fs.statSync(full).mtimeMs })
      } catch {
        /* vanished */
      }
    }
  }
  claudeFiles.sort((a, b) => b.updated - a.updated)
  for (const f of claudeFiles) {
    if (out.filter((s) => s.agent === 'claude').length >= limit) break
    const head = parseClaudeHead(readHead(f.full))
    if (!head.title) continue // never messaged: nothing to resume
    if (cwd && !sameDir(head.cwd, cwd)) continue
    out.push({
      agent: 'claude',
      id: f.id,
      cwd: head.cwd,
      started: head.started,
      updated: f.updated,
      title: head.title
    })
  }

  // Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
  const codexRoot = join(home, '.codex', 'sessions')
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
  walk(codexRoot, 0)
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

  return out.sort((a, b) => b.updated - a.updated)
}
