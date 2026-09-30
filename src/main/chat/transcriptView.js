// A read-only chat view of a terminal agent's conversation, for the agents
// with no chat protocol of their own (Grok, OpenClaude, OMP): their session
// file is read and shown in the chat UI while the agent keeps running in its
// terminal pane.
//
// After Orca's src/main/native-chat (transcript-line-decoders-grok.ts,
// transcript-line-decoders-omp.ts, session-file-resolver.ts,
// transcript-watch*.ts) and shared/native-chat-agent-support.ts, MIT,
// Copyright (c) 2026 Lovecast Inc. Rewritten for Tessel's chat events: the
// lines become the events the chat journal replays (transcriptHistory.js's
// builder), so the chat UI renders them as it renders any chat.
//
// Where: Grok: <GROK_HOME or ~/.grok>/sessions/<encoded folder>/<id>/chat_history.jsonl;
// OpenClaude (Claude Code's format): ~/.openclaude/projects/<project>/<id>.jsonl;
// OMP: <OMP_CODING_AGENT_DIR or ~/.omp/agent/sessions>/<folder slug>/<time>_<id>.jsonl (a session's own
// sub-folders, its task sub-agents', are not searched).
// The window names an agent and a session id (checked), never a path; the file
// is found inside that agent's folder and read only when it is a real file
// whose real path stays inside it (no link, no junction). Bounded like the
// chat's history (the last 4 MB, 2000 events, texts cut); at most 8 views are
// watched at once, each by one file watcher (a slow poll where watching fails),
// re-read at most every 300 ms, and only while the view is open.
import fs from 'fs'
import os from 'os'
import { basename, isAbsolute, join } from 'path'
import { claudeTranscriptIn } from '../agentModel.js'
import { realInside } from '../agentChildren.js'
import { ompSessionsDir } from '../agentSessionSources.js'
import { HISTORY_LIMITS, claudeHistoryEvents, createBuilder, readLastLines } from './transcriptHistory.js'

export const TRANSCRIPT_VIEW_AGENTS = ['grok', 'openclaude', 'omp']
const MAX_VIEWS = 8
const GROUP_SCAN_MAX = 2048
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TOKEN_ID = /^[A-Za-z0-9_-]{6,128}$/

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null)
const str = (v) => (typeof v === 'string' && v ? v : null)

export function validViewId(agent, id) {
  if (typeof id !== 'string') return false
  return agent === 'openclaude' ? UUID.test(id) : TOKEN_ID.test(id)
}

function envDir(v) {
  const t = typeof v === 'string' ? v.trim() : ''
  return t && isAbsolute(t) ? t : ''
}

// The folder each agent keeps its sessions in.
export function transcriptViewRoots(home = os.homedir(), env = process.env) {
  return {
    grok: join(envDir(env.GROK_HOME) || join(home, '.grok'), 'sessions'),
    openclaude: join(home, '.openclaude'),
    omp: ompSessionsDir(home, env)
  }
}

function realBase(dir) {
  try {
    return fs.realpathSync.native(dir)
  } catch {
    return null
  }
}

function dirNames(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .slice(0, GROUP_SCAN_MAX)
      .map((d) => d.name)
  } catch {
    return []
  }
}

// -> the session file (a real file inside the agent's folder) or null.
export function findTranscriptViewFile(agent, id, roots = transcriptViewRoots()) {
  if (!TRANSCRIPT_VIEW_AGENTS.includes(agent) || !validViewId(agent, id)) return null
  const root = roots[agent]
  if (typeof root !== 'string' || !isAbsolute(root)) return null
  const base = realBase(root)
  if (!base) return null
  let file = null
  if (agent === 'openclaude') {
    if (!realInside(base, join(root, 'projects'), true)) return null
    file = claudeTranscriptIn(root, id)
  } else if (agent === 'grok') {
    for (const group of dirNames(root)) {
      const candidate = join(root, group, id, 'chat_history.jsonl')
      if (fs.existsSync(candidate)) {
        file = candidate
        break
      }
    }
  } else {
    for (const group of dirNames(root)) {
      let names = []
      try {
        names = fs.readdirSync(join(root, group)).slice(0, GROUP_SCAN_MAX)
      } catch {
        continue
      }
      const hit = names.find((n) => n.endsWith('.jsonl') && (basename(n, '.jsonl') === id || basename(n, '.jsonl').endsWith(`_${id}`)))
      if (hit) {
        file = join(root, group, hit)
        break
      }
    }
  }
  return file && realInside(base, file, false) ? file : null
}

function parse(line) {
  try {
    return obj(JSON.parse(line))
  } catch {
    return null
  }
}

// Text blocks of a Claude-like content (a string or an array of blocks).
function textsOf(content) {
  if (typeof content === 'string') return content.trim() ? [content] : []
  if (!Array.isArray(content)) return []
  return content.map((b) => (typeof b === 'string' ? b : obj(b)?.type === 'text' ? str(obj(b).text) : null)).filter(Boolean)
}

// Tool calls without an id of their own are paired with results in order.
function toolQueue(b) {
  const pending = []
  return {
    call(id, name, input, ts) {
      const key = str(id) || b.nextId('t')
      pending.push(key)
      b.tool(key, name, input, ts)
    },
    result(id, output, isError, ts) {
      let key = str(id)
      if (key) {
        const i = pending.indexOf(key)
        if (i >= 0) pending.splice(i, 1)
      } else key = pending.shift()
      if (key) b.toolResult(key, output, isError, ts)
    }
  }
}

// ---- Grok ---------------------------------------------------------------------

function grokUserQuery(text) {
  const lower = text.toLowerCase()
  const open = lower.indexOf('<user_query>')
  if (open < 0) return text
  const start = open + '<user_query>'.length
  const end = lower.indexOf('</user_query>', start)
  return (end < 0 ? text.slice(start) : text.slice(start, end)).trim()
}

// The context Grok records as a user row (its <user_info> envelope, with or
// without the git snapshot it appends), not a prompt.
function grokBootstrap(content) {
  const texts = textsOf(content)
  if (texts.length !== 1) return false
  const t = texts[0].trim().toLowerCase()
  if (!t.startsWith('<user_info>')) return false
  const end = t.indexOf('</user_info>')
  if (end < 0) return false
  const rest = t.slice(end + '</user_info>'.length).trim()
  return !rest || (rest.startsWith('<git_status>') && rest.endsWith('</git_status>'))
}

function parseArgs(v) {
  if (typeof v !== 'string') return v
  try {
    return JSON.parse(v)
  } catch {
    return v
  }
}

export function grokViewEvents(lines, limits = HISTORY_LIMITS) {
  const b = createBuilder(limits)
  const tools = toolQueue(b)
  lines.forEach((line, index) => {
    const r = parse(line)
    const type = r && str(r.type)
    if (!type) return
    const ts = r.timestamp
    const key = str(r.id) || `grok-${index}` // i18n-ignore id
    if (type === 'user') {
      if ((typeof r.synthetic_reason === 'string' && r.synthetic_reason.trim()) || grokBootstrap(r.content)) return
      const body = textsOf(r.content).map(grokUserQuery).filter((t) => t.trim()).join('\n')
      if (body) b.user(key, body, ts)
      return
    }
    if (type === 'assistant') {
      for (const t of textsOf(r.content)) b.message('assistant', key, t, ts, '\n\n')
      for (const call of Array.isArray(r.tool_calls) ? r.tool_calls : []) {
        const c = obj(call)
        if (!c) continue
        const fn = obj(c.function)
        tools.call(c.id, str(c.name) || str(fn?.name) || str(c.tool) || 'tool', parseArgs(c.arguments ?? fn?.arguments ?? c.input ?? c.args), ts) // i18n-ignore tool name
      }
      return
    }
    if (type === 'reasoning') {
      const summary = Array.isArray(r.summary) ? r.summary.map((s) => (typeof s === 'string' ? s : str(obj(s)?.text) || str(obj(s)?.summary_text) || '')).filter(Boolean).join('\n') : str(r.summary)
      const body = str(r.text) || summary || str(obj(r.content)?.text)
      if (body && body.trim()) b.message('thinking', key, body, ts, '\n')
      return
    }
    if (type === 'backend_tool_call' || type === 'tool_call') {
      tools.call(r.tool_call_id || r.id, str(obj(r.kind)?.tool_type) || str(r.name) || str(r.tool) || 'tool', r.kind ?? r.arguments ?? r.input, ts) // i18n-ignore tool name
      return
    }
    if (type === 'tool_result') {
      tools.result(r.tool_call_id, r.content ?? r.output ?? r.result, r.is_error === true || r.isError === true, ts)
    }
  })
  return b.finish()
}

// ---- OMP ----------------------------------------------------------------------

export function ompViewEvents(lines, limits = HISTORY_LIMITS) {
  const b = createBuilder(limits)
  const tools = toolQueue(b)
  lines.forEach((line, index) => {
    const r = parse(line)
    // Session bookkeeping (session_init, mode changes, compaction, extension
    // state) is not the conversation; extension turns are shown only when OMP
    // itself shows them, and then as the agent's.
    if (!r || r.type !== 'message') return
    const m = obj(r.message)
    if (!m) return
    const ts = r.timestamp
    const key = str(r.id) || `omp-${index}` // i18n-ignore id
    const role = str(m.role)
    if (role === 'toolResult') {
      tools.result(m.toolCallId ?? m.tool_call_id, m.content, m.isError === true, ts)
      return
    }
    if (role === 'bashExecution' || role === 'pythonExecution') {
      const bash = role === 'bashExecution'
      const source = bash ? m.command : m.code
      const id = b.nextId('x')
      b.tool(id, bash ? 'bash' : 'python', typeof source === 'string' ? source : '', ts)
      const failed = m.cancelled === true || (typeof m.exitCode === 'number' && m.exitCode !== 0)
      b.toolResult(id, typeof m.output === 'string' ? m.output : '', failed, ts)
      return
    }
    if (role === 'user') {
      const body = textsOf(m.content).join('\n')
      if (body.trim()) b.user(key, body, ts)
      return
    }
    if (role !== 'assistant') return
    const blocks = Array.isArray(m.content) ? m.content : typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : []
    let any = false
    for (const blk of blocks) {
      const o = obj(blk)
      if (!o) continue
      if (o.type === 'text' && str(o.text)) {
        b.message('assistant', key, o.text, ts, '\n\n')
        any = true
      } else if (o.type === 'thinking' && (str(o.thinking) || str(o.text))) {
        b.message('thinking', key, o.thinking || o.text, ts, '\n')
        any = true
      } else if (o.type === 'toolCall') {
        tools.call(o.id, str(o.name) || 'tool', o.arguments, ts) // i18n-ignore tool name
        any = true
      }
    }
    // An aborted turn with nothing streamed still ends as interrupted.
    if (m.stopReason === 'aborted') b.endTurn('interrupted', ts)
    else if (!any) b.work(ts)
  })
  return b.finish()
}

// -> { ok: true, events, truncated } | { ok: false, code: 'invalid' | 'missing' | 'empty' }
export function readTranscriptView({ agent, sessionId, roots = transcriptViewRoots(), limits = HISTORY_LIMITS } = {}) {
  if (!TRANSCRIPT_VIEW_AGENTS.includes(agent) || !validViewId(agent, sessionId)) return { ok: false, code: 'invalid' }
  const file = findTranscriptViewFile(agent, sessionId, roots)
  if (!file) return { ok: false, code: 'missing' }
  const read = readLastLines(file, limits.bytes)
  if (!read) return { ok: false, code: 'missing' }
  let events = agent === 'grok' ? grokViewEvents(read.lines, limits) : agent === 'omp' ? ompViewEvents(read.lines, limits) : claudeHistoryEvents(read.lines, limits)
  let truncated = read.cut
  if (events.length > limits.events) {
    events = events.slice(-limits.events)
    truncated = true
  }
  return { ok: true, events, truncated, file }
}

// The open views and their watchers. send(channel, payload) reaches the window.
export function createTranscriptViews({ send, roots = transcriptViewRoots, watch = fs.watch, debounceMs = 300, pollMs = 2000, log = null } = {}) {
  const views = new Map() // viewId -> { agent, sessionId, file, watcher, timer, poll, stamp }
  let nextId = 0

  const stampOf = (file) => {
    try {
      const st = fs.statSync(file)
      return `${st.size}:${st.mtimeMs}`
    } catch {
      return ''
    }
  }
  function refresh(viewId) {
    const v = views.get(viewId)
    if (!v) return
    const stamp = stampOf(v.file)
    if (stamp === v.stamp) return
    v.stamp = stamp
    const res = readTranscriptView({ agent: v.agent, sessionId: v.sessionId, roots: roots() })
    if (!views.has(viewId)) return
    send('transcriptView:event', { viewId, ...(res.ok ? { ok: true, events: res.events, truncated: res.truncated } : { ok: false, code: res.code }) })
  }
  function schedule(viewId) {
    const v = views.get(viewId)
    if (!v || v.timer) return
    v.timer = setTimeout(() => {
      v.timer = null
      refresh(viewId)
    }, debounceMs)
  }
  function close(viewId) {
    const v = views.get(viewId)
    if (!v) return false
    views.delete(viewId)
    if (v.timer) clearTimeout(v.timer)
    if (v.poll) clearInterval(v.poll)
    try {
      v.watcher?.close()
    } catch {
      // already gone
    }
    return true
  }
  function open({ agent, sessionId } = {}) {
    const res = readTranscriptView({ agent, sessionId, roots: roots() })
    if (!res.ok) return res
    // The oldest view gives way: a view nobody closed (a crashed window) cannot pile up.
    while (views.size >= MAX_VIEWS) close(views.keys().next().value)
    const viewId = `tv-${++nextId}` // i18n-ignore id
    const v = { agent, sessionId, file: res.file, watcher: null, timer: null, poll: null, stamp: stampOf(res.file) }
    views.set(viewId, v)
    try {
      v.watcher = watch(res.file, { persistent: false }, () => schedule(viewId))
      v.watcher.on?.('error', () => {
        try {
          v.watcher.close()
        } catch {
          // gone
        }
        v.watcher = null
        if (!v.poll && views.has(viewId)) v.poll = setInterval(() => schedule(viewId), pollMs)
      })
    } catch (err) {
      if (log) log.warn('transcriptView', `watch failed, polling: ${err && err.message}`)
      v.poll = setInterval(() => schedule(viewId), pollMs)
    }
    return { ok: true, viewId, events: res.events, truncated: res.truncated }
  }
  function register(ipcMain) {
    ipcMain.handle('transcriptView:open', (_e, q) => {
      const o = obj(q) || {}
      return open({ agent: o.agent, sessionId: o.sessionId })
    })
    ipcMain.handle('transcriptView:close', (_e, q) => ({ ok: close(obj(q)?.viewId) }))
  }
  return { open, close, closeAll: () => [...views.keys()].forEach(close), register, count: () => views.size }
}
