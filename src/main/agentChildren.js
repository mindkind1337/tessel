// The sub-agents a Claude Code conversation started (its Task / Agent tool),
// read from Claude Code's own files, like its "agents" list shows them:
//   <claude dir>/projects/<project>/<session id>/subagents/agent-<id>.meta.json
//     { agentType, description }
//   .../agent-<id>.jsonl   its transcript (timestamps, token usage)
// Read-only; only the first line and the end of each transcript are read.
import fs from 'fs'
import os from 'os'
import { join, relative, isAbsolute } from 'path'

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

function readTail(file, size) {
  const len = Math.min(size, TAIL_BYTES)
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
    if (decided && last && tokens !== null) break
  }
  return { done, last, tokens }
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
    let tail = { done: false, last: null, tokens: null }
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
      tokens: tail.tokens
    })
  }
  out.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
  return out.slice(0, MAX_AGENTS)
}
