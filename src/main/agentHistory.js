// Read-only history adapters. Formats are checked against the agents' own
// storage/recording code; no CLI, migration or model call runs while listing.
// Gemini: google-gemini/gemini-cli packages/core/src/services/chatRecordingService.ts
// and config/projectRegistry.ts. Qwen: QwenLM/qwen-code, the same paths.
// OpenCode: session table, also verified on installed OpenCode 1.18.32.
import fs from 'fs'
import os from 'os'
import { join, isAbsolute, win32 } from 'path'
import { createHash } from 'crypto'
import { normDir, readHead, readTail, readRows } from './fileRead'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HEAD_BYTES = 256 * 1024
const object = (v) => v && typeof v === 'object' && !Array.isArray(v)
const timestamp = (v) =>
  typeof v === 'number' ? (Number.isFinite(v) ? v : 0) : Date.parse(v || '') || 0
const folder = (v) =>
  typeof v === 'string' && (isAbsolute(v) || win32.isAbsolute(v)) && !/[\x00-\x1f]/.test(v) ? v : ''
const title = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 120) : '')
const contentText = (v) =>
  typeof v === 'string'
    ? v
    : Array.isArray(v)
      ? v
          .filter((p) => p && !p.thought && typeof p.text === 'string')
          .map((p) => p.text)
          .join('')
      : ''
const realPrompt = (v) => title(v) && !v.trim().startsWith('<') && !v.trim().startsWith('[Tessel]')
const entries = (dir) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}
const json = (text) => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// A large legacy Gemini JSON document can end beyond our bounded read. Keep
// only complete values before that cut, then close their containing objects.
// Used only when stat confirms truncation by readHead, never to repair a file.
function jsonHead(text, truncated) {
  const complete = json(text)
  if (complete || !truncated) return complete
  const stack = []
  let quoted = false,
    escaped = false,
    cut = 0,
    endings = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') quoted = false
      continue
    }
    if (c === '"') quoted = true
    else if (c === '{') stack.push('}')
    else if (c === '[') stack.push(']')
    else if (c === '}' || c === ']') {
      if (stack.pop() !== c) return null
      cut = i + 1
      endings = [...stack].reverse().join('')
    } else if (c === ',') {
      cut = i
      endings = [...stack].reverse().join('')
    }
  }
  return cut ? json(text.slice(0, cut) + endings) : null
}

export function parseGeminiHead(text, { legacy = false, truncated = false, tail = '' } = {}) {
  const records = legacy ? [jsonHead(text, truncated)] : text.split('\n').map(json)
  // Renames/workspace metadata may occur long after the first prompt.
  if (!legacy && tail)
    records.push(
      ...tail
        .split('\n')
        .map(json)
        .filter((r) => object(r?.$set))
    )
  let id = '',
    started = 0,
    summary = '',
    first = '',
    cwd = '',
    subagent = false
  for (const r of records) {
    if (!object(r)) continue
    if (UUID.test(r.sessionId || '')) id = r.sessionId
    if (!started) started = timestamp(r.startTime)
    if (r.kind === 'subagent') subagent = true
    const meta = object(r.$set) ? r.$set : r
    if (typeof meta.summary === 'string') summary = title(meta.summary)
    // A root path/registry is preferable: directories can include extra workspaces.
    if (!cwd && Array.isArray(meta.directories)) cwd = folder(meta.directories[0])
    const messages = Array.isArray(meta.messages) ? meta.messages : [r]
    for (const m of messages) {
      if (m?.type !== 'user' || first) continue
      const text = contentText(m.content)
      if (realPrompt(text)) first = title(text)
    }
  }
  return id && !subagent ? { id, cwd, started, title: summary || first } : null
}

export function geminiFiles(home = os.homedir()) {
  const root = join(process.env.GEMINI_CLI_HOME || home, '.gemini')
  const registry = json(readHead(join(root, 'projects.json')))?.projects
  const folders = new Map()
  if (object(registry))
    for (const [dir, slug] of Object.entries(registry)) {
      if (typeof slug === 'string' && folder(dir)) {
        folders.set(slug, dir)
        folders.set(createHash('sha256').update(dir).digest('hex'), dir)
      }
    }
  const out = []
  for (const p of entries(join(root, 'tmp')).filter((p) => p.isDirectory())) {
    const project = join(root, 'tmp', p.name)
    const cwd =
      folder(readHead(join(project, '.project_root'), 8192).trim()) || folders.get(p.name) || ''
    for (const f of entries(join(project, 'chats'))) {
      if (!f.isFile() || !/^session-.+\.(jsonl|json)$/.test(f.name)) continue
      const full = join(project, 'chats', f.name)
      try {
        const stat = fs.statSync(full)
        out.push({
          full,
          cwd,
          project: p.name,
          updated: stat.mtimeMs,
          size: stat.size,
          legacy: f.name.endsWith('.json')
        })
      } catch {
        /* disappeared during scan */
      }
    }
  }
  return out.sort((a, b) => b.updated - a.updated)
}

export function geminiHistory({ cwd, limit }, home) {
  const out = [],
    seen = new Set()
  const hash = cwd ? createHash('sha256').update(cwd).digest('hex') : null
  for (const f of geminiFiles(home)) {
    const head = parseGeminiHead(readHead(f.full, HEAD_BYTES), {
      legacy: f.legacy,
      truncated: f.size > HEAD_BYTES,
      tail: !f.legacy && f.size > HEAD_BYTES ? readTail(f.full, 64 * 1024) : ''
    })
    if (!head?.title || seen.has(head.id)) continue
    const dir = f.cwd || folder(head.cwd) || (f.project === hash ? folder(cwd) : '')
    // A hashed project folder cannot safely be decoded. Keep it visible in
    // All folders; the dialog disables Resume until its folder is known.
    if (cwd && normDir(dir) !== normDir(cwd)) continue
    out.push({ agent: 'gemini', ...head, cwd: dir, updated: f.updated })
    seen.add(head.id)
    if (out.length >= limit) break
  }
  return out
}

export function qwenProjectsRoot(home = os.homedir()) {
  return join(
    process.env.QWEN_RUNTIME_DIR || process.env.QWEN_HOME || join(home, '.qwen'),
    'projects'
  )
}

export function parseQwenHead(text, expectedId, tail = '') {
  let cwd = '',
    started = 0,
    first = '',
    custom = '',
    matched = false,
    subagent = false
  for (const r of (text + '\n' + tail).split('\n').map(json)) {
    if (!object(r) || r.sessionId !== expectedId) continue
    matched = true
    if (!cwd) cwd = folder(r.cwd)
    if (!started) started = timestamp(r.timestamp)
    if (r.subtype === 'parent_session') subagent = true
    if (r.type === 'system' && r.subtype === 'custom_title')
      custom = title(r.systemPayload?.customTitle) || custom
    if (
      r.type !== 'user' ||
      r.isSidechain ||
      r.agentId ||
      (r.provenance && r.provenance !== 'real_user') ||
      ['notification', 'cron', 'goal_runtime'].includes(r.subtype)
    )
      continue
    const prompt =
      typeof r.systemPayload?.displayText === 'string'
        ? r.systemPayload.displayText
        : contentText(r.message?.parts || r.message?.content)
    if (!first && realPrompt(prompt)) first = title(prompt)
  }
  return matched && UUID.test(expectedId) && !subagent
    ? { id: expectedId, cwd, started, title: custom || first }
    : null
}

export function qwenHistory({ cwd, limit }, home) {
  const files = [],
    root = qwenProjectsRoot(home)
  for (const p of entries(root).filter((p) => p.isDirectory())) {
    for (const child of ['', 'archive']) {
      const dir = join(root, p.name, 'chats', child)
      for (const f of entries(dir)) {
        if (!f.isFile() || !f.name.endsWith('.jsonl') || !UUID.test(f.name.slice(0, -6))) continue
        const full = join(dir, f.name)
        try {
          files.push({ full, id: f.name.slice(0, -6), updated: fs.statSync(full).mtimeMs })
        } catch {
          /* disappeared */
        }
      }
    }
  }
  const out = [],
    seen = new Set()
  for (const f of files.sort((a, b) => b.updated - a.updated)) {
    if (seen.has(f.id)) continue
    const head = parseQwenHead(readHead(f.full), f.id, readTail(f.full, 64 * 1024))
    if (!head?.title || !head.cwd || (cwd && normDir(head.cwd) !== normDir(cwd))) continue
    out.push({ agent: 'qwen', ...head, updated: f.updated })
    seen.add(f.id)
    if (out.length >= limit) break
  }
  return out
}

export function opencodeHistory({ cwd, limit }, home = os.homedir()) {
  const db = join(
    process.env.XDG_DATA_HOME || join(home, '.local', 'share'),
    'opencode',
    'opencode.db'
  )
  const columns = new Set(readRows(db, 'PRAGMA table_info(session)').map((c) => c.name))
  if (
    !['id', 'directory', 'title', 'time_created', 'time_updated', 'parent_id'].every((c) =>
      columns.has(c)
    )
  )
    return []
  const where = ['parent_id IS NULL']
  if (columns.has('time_archived')) where.push('time_archived IS NULL')
  if (cwd) where.push("lower(rtrim(replace(directory, '/', char(92)), char(92))) = ?")
  const rows = readRows(
    db,
    `SELECT id, directory, title, time_created, time_updated FROM session WHERE ${where.join(' AND ')} ORDER BY time_updated DESC LIMIT ?`,
    [...(cwd ? [normDir(cwd)] : []), limit]
  )
  return rows
    .filter((r) => /^ses_[A-Za-z0-9_-]{2,76}$/.test(r.id) && folder(r.directory))
    .map((r) => ({
      agent: 'opencode',
      id: r.id,
      cwd: r.directory,
      title: title(r.title) || 'Untitled conversation',
      started: timestamp(r.time_created),
      updated: timestamp(r.time_updated) || timestamp(r.time_created)
    }))
}
