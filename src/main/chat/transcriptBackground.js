// What a terminal Claude Code (or OpenClaude) still runs in the background,
// read from its session file for the chat view's background-task dock: the
// tool calls that started it (Bash with run_in_background, a background or
// async Agent / Task sub-agent, Monitor) and what ended it since (its
// <task-notification> with a final status, a TaskStop / KillShell call, the
// sub-agents killed at once). After the background roster of Orca's
// ClaudeBackgroundTaskTracker (MIT, Copyright (c) 2026 Lovecast Inc.), rebuilt
// from the transcript lines instead of stream-json frames.
// Only ids, kinds, a short description and the start time leave this module
// (the renderer masks secrets in the description before showing it).
// Also: the folder the agent works in (its lines' "cwd"), for its skills.
import { isAbsolute } from 'path'

const MAX_TASKS = 32
// A task this old with no end seen is not shown (its end may leave no line).
const MAX_AGE_MS = 6 * 60 * 60 * 1000
const MAX_TEXT = 200
const OVER = new Set(['completed', 'complete', 'done', 'success', 'succeeded', 'finished', 'failed', 'error', 'killed', 'stopped', 'cancelled', 'canceled', 'terminated', 'exited', 'aborted', 'expired', 'timed_out', 'interrupted'])
const STOP_TOOLS = new Set(['TaskStop', 'KillShell', 'KillBash'])
const AGENT_TOOLS = new Set(['Agent', 'Task'])
// A cheap filter before parsing a line.
const HINT = /run_in_background|"Monitor"|"Agent"|"Task"|task-notification|"TaskStop"|"KillShell"|"KillBash"|agents_killed|backgroundTaskId|"isAsync"|"taskId"/
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null)
const str = (v) => (typeof v === 'string' && v ? v : null)
const text = (v) => (typeof v === 'string' ? v.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT) : '')
const taskId = (v) => (typeof v === 'string' && TASK_ID.test(v) ? v : null)
const timeOf = (ts) => {
  const at = typeof ts === 'string' ? Date.parse(ts) : NaN
  return Number.isFinite(at) ? at : 0
}

function parse(line) {
  try {
    return obj(JSON.parse(line))
  } catch {
    return null
  }
}

// The texts of a user line (a string, or its text blocks).
function textsOf(content) {
  if (typeof content === 'string') return [content]
  return Array.isArray(content) ? content.map((b) => (obj(b) && b.type === 'text' && typeof b.text === 'string' ? b.text : '')).filter(Boolean) : []
}

// The id a background start's result names: its toolUseResult field, else
// its text ("Command running in background with ID: b1x2...").
function startedId(kind, result, block) {
  const r = obj(result) || {}
  if (kind === 'command') {
    const id = taskId(r.backgroundTaskId)
    if (id) return id
  } else if (kind === 'agent') {
    if (r.isAsync === true || r.status === 'async_launched') return taskId(r.agentId)
    return null
  } else if (kind === 'monitor') {
    const id = taskId(r.taskId)
    if (id) return id
  }
  const body = textsOf(obj(block) && block.content).join('\n')
  const m = /\bwith ID:\s*([A-Za-z0-9._:-]{1,100})/.exec(body)
  return m ? taskId(m[1]) : null
}

// lines (the session file's, oldest first), now -> [{ id, kind: 'command' |
// 'agent' | 'monitor', description, startedAt }] still running, oldest first.
export function claudeBackgroundFromLines(lines, now = Date.now()) {
  const starts = new Map() // tool_use id -> { kind, description, startedAt }
  const live = new Map() // task id -> task
  const list = Array.isArray(lines) ? lines : []
  for (const line of list) {
    if (typeof line !== 'string' || !HINT.test(line)) continue
    const o = parse(line)
    if (!o || o.isSidechain === true) continue
    const at = timeOf(o.timestamp)
    if (o.type === 'system' && o.subtype === 'agents_killed') {
      for (const [id, task] of live) if (task.kind === 'agent') live.delete(id)
      continue
    }
    const content = obj(o.message) ? o.message.content : undefined
    if (o.type === 'assistant') {
      for (const block of Array.isArray(content) ? content : []) {
        const b = obj(block)
        if (!b || b.type !== 'tool_use' || !str(b.id)) continue
        const input = obj(b.input) || {}
        if (STOP_TOOLS.has(b.name)) {
          const id = taskId(input.task_id) || taskId(input.shell_id) || taskId(input.bash_id)
          if (id) live.delete(id)
        } else if (b.name === 'Bash' && input.run_in_background === true) {
          starts.set(b.id, { kind: 'command', description: text(input.description) || text(input.command), startedAt: at })
        } else if (AGENT_TOOLS.has(b.name)) {
          starts.set(b.id, { kind: 'agent', description: text(input.description), startedAt: at })
        } else if (b.name === 'Monitor') {
          const timeout = Number(input.timeout_ms)
          starts.set(b.id, {
            kind: 'monitor',
            description: text(input.description) || text(input.command),
            startedAt: at,
            ...(input.persistent !== true && Number.isFinite(timeout) && timeout > 0 ? { until: at + timeout } : {})
          })
        }
      }
      continue
    }
    if (o.type !== 'user') continue
    for (const block of Array.isArray(content) ? content : []) {
      const b = obj(block)
      if (!b || b.type !== 'tool_result' || !starts.has(b.tool_use_id)) continue
      const start = starts.get(b.tool_use_id)
      starts.delete(b.tool_use_id)
      if (b.is_error === true) continue
      const id = startedId(start.kind, o.toolUseResult, b)
      if (!id) continue
      live.delete(id)
      if (live.size >= MAX_TASKS) live.delete(live.keys().next().value)
      live.set(id, { id, ...start })
    }
    for (const body of textsOf(content)) {
      if (!body.includes('<task-notification>')) continue
      const id = taskId((/<task-id>([^<]{1,100})<\/task-id>/.exec(body) || [])[1])
      const status = ((/<status>([^<]{1,40})<\/status>/.exec(body) || [])[1] || '').trim().toLowerCase()
      // A monitor's event has no status: it still runs.
      if (id && OVER.has(status)) live.delete(id)
    }
  }
  const out = []
  for (const task of live.values()) {
    if (task.until && now > task.until) continue
    if (task.startedAt && now - task.startedAt > MAX_AGE_MS) continue
    const { until, ...rest } = task
    out.push(rest)
  }
  return out
}

// The folder the agent works in, from its newest lines (Claude Code's "cwd",
// Codex's session_meta / turn_context payload): an absolute path, or null.
const SCAN_FOR_CWD = 200
export function transcriptCwd(lines) {
  const list = Array.isArray(lines) ? lines : []
  const stop = Math.max(0, list.length - SCAN_FOR_CWD)
  for (let i = list.length - 1; i >= stop; i--) {
    const line = list[i]
    if (typeof line !== 'string' || !line.includes('"cwd"')) continue
    const o = parse(line)
    const cwd = o && (str(o.cwd) || str(obj(o.payload) && o.payload.cwd))
    if (cwd && cwd.length <= 1024 && !cwd.includes('\0') && isAbsolute(cwd)) return cwd
  }
  return null
}
