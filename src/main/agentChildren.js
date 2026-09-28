// The sub-agents a Claude Code conversation started (its Task / Agent tool),
// read from Claude Code's own files, like its "agents" list shows them:
//   <claude dir>/projects/<project>/<session id>/subagents/agent-<id>.meta.json
//     { agentType, description }
//   .../agent-<id>.jsonl   its transcript (timestamps, token usage)
// Read-only; only the first line and the end of each transcript are read.
import fs from 'fs'
import os from 'os'
import { join } from 'path'

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TAIL_BYTES = 96 * 1024
const MAX_AGENTS = 50
// Not finished, and nothing written for this long: it was stopped.
const STALE_MS = 15 * 60 * 1000

function sessionDir(claudeDir, sessionId) {
  const root = join(claudeDir, 'projects')
  let dirs
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return null
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    const dir = join(root, d.name, sessionId)
    if (fs.existsSync(join(dir, 'subagents'))) return dir
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

// -> [{ id, type, title, state: 'running'|'done'|'stopped', startedAt, endedAt, tokens }]
// newest first.
export function claudeSubagents(sessionId, claudeDir = join(os.homedir(), '.claude'), now = Date.now()) {
  if (!ID.test(String(sessionId))) return []
  const dir = sessionDir(claudeDir, sessionId)
  if (!dir) return []
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
    let st
    try {
      st = fs.statSync(file)
    } catch {
      continue
    }
    let meta = {}
    try {
      meta = JSON.parse(fs.readFileSync(join(sub, `agent-${id}.meta.json`), 'utf8')) || {}
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
    const state = tail.done ? 'done' : now - Math.max(last, st.mtimeMs) > STALE_MS ? 'stopped' : 'running'
    out.push({
      id,
      type: typeof meta.agentType === 'string' ? meta.agentType.slice(0, 60) : 'agent',
      title: typeof meta.description === 'string' ? meta.description.slice(0, 200) : '',
      state,
      startedAt: startedAt || st.birthtimeMs || null,
      endedAt: state === 'running' ? null : last,
      tokens: tail.tokens
    })
  }
  out.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
  return out.slice(0, MAX_AGENTS)
}
