// A chat view of a terminal agent's conversation: its session file is read
// and shown in the chat UI while the agent keeps running in its terminal pane.
// Read-only for Grok and OMP; for Claude Code, OpenClaude and Codex the view
// also types into the terminal (the renderer's chat view of the pane), so
// nothing is restarted to switch between the terminal and the chat.
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
// sub-folders, its task sub-agents', are not searched);
// Claude Code: <its account's config folder>/projects/<project>/<id>.jsonl;
// Codex: <its account's CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl.
// Claude Code and Codex: the folder is the pane's account's, resolved in this
// process from the account id (the window never names a folder). Newer Claude
// Code names its file with a UUID other than the hook's session id: the path
// its hooks reported for that session (teamMcp reportSession, per pane) is
// used when it is a real file inside that same folder.
// The window names an agent and a session id (checked), never a path; the file
// is found inside that agent's folder and read only when it is a real file
// whose real path stays inside it (no link, no junction). Bounded like the
// chat's history (the last 4 MB, 2000 events, texts cut); at most 8 views are
// watched at once, each by one file watcher (a slow poll where watching fails),
// read again at most every 300 ms, and only while the view is open. A change
// reads only the bytes added since the last read (the kept lines are decoded
// again in memory); a file that shrank or was replaced is read again whole.
// Scrolled up, the view reads the 4 MB before the kept lines (whole lines,
// from the same already-checked file; 12 MB more at most, the events kept grow
// with it).
import fs from 'fs'
import os from 'os'
import { basename, isAbsolute, join } from 'path'
import { claudeTranscriptIn } from '../agentModel.js'
import { realInside } from '../agentChildren.js'
import { ompSessionsDir } from '../agentSessionSources.js'
import { HISTORY_LIMITS, claudeHistoryEvents, codexHistoryEvents, createBuilder, findTranscript } from './transcriptHistory.js'
import { claudeBackgroundFromLines, transcriptCwd } from './transcriptBackground.js'

export const TRANSCRIPT_VIEW_AGENTS = ['grok', 'openclaude', 'omp', 'claude', 'codex']
// Their folder is the pane's account's (given by the caller as `home`).
const ACCOUNT_AGENTS = ['claude', 'codex']
const MAX_VIEWS = 8
const GROUP_SCAN_MAX = 2048
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TOKEN_ID = /^[A-Za-z0-9_-]{6,128}$/

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null)
const str = (v) => (typeof v === 'string' && v ? v : null)

export function validViewId(agent, id) {
  if (typeof id !== 'string') return false
  return agent === 'openclaude' || ACCOUNT_AGENTS.includes(agent) ? UUID.test(id) : TOKEN_ID.test(id)
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

// The path an agent's hooks reported for its session, when it is a real
// .jsonl file (no link, no junction) inside <folder>/<sub> -> that path, or null.
export function reportedTranscriptIn(folder, sub, file) {
  if (typeof folder !== 'string' || !isAbsolute(folder) || typeof file !== 'string' || !isAbsolute(file)) return null
  if (file.length > 1024 || file.includes('\0') || !file.toLowerCase().endsWith('.jsonl')) return null
  const base = realBase(join(folder, sub))
  return base && realInside(base, file, false) ? file : null
}

// -> the session file (a real file inside the agent's folder) or null.
// home: Claude Code's or Codex's folder (the pane's account's); reported: the
// path its hooks gave for this session (checked here).
export function findTranscriptViewFile(agent, id, roots = transcriptViewRoots(), { home = null, reported = null } = {}) {
  if (!TRANSCRIPT_VIEW_AGENTS.includes(agent) || !validViewId(agent, id)) return null
  if (ACCOUNT_AGENTS.includes(agent)) {
    return reportedTranscriptIn(home, agent === 'codex' ? 'sessions' : 'projects', reported) || findTranscript(agent, id, home)
  }
  if (agent === 'openclaude') {
    const hit = reportedTranscriptIn(roots.openclaude, 'projects', reported)
    if (hit) return hit
  }
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

/// ---- Reading -----------------------------------------------------------------

// A session file's complete lines, the last `maxBytes` of them, kept between
// reads: each read takes only the bytes added since the previous one (up to
// its last line end: a line being written waits for the next read). A file
// that shrank or was replaced (another file at that path) is read again from
// its last `maxBytes`. Lines are cut at '\n' bytes only, which never fall
// inside a UTF-8 character.
// readEarlier(bytes): the lines just before the kept ones (at most `bytes`
// more, whole lines only), kept from then on (the chat's "load earlier", after
// Orca's windowed transcript read in use-native-chat-live-session.ts, MIT,
// Copyright (c) 2026 Lovecast Inc.); at most `maxEarlier` bytes in all.
export function createTail(file, maxBytes, { maxEarlier = 0 } = {}) {
  let offset = 0
  let identity = null
  let lines = []
  let sizes = []
  let kept = 0
  let cut = false
  // The file offset of the first kept line, and how much may be kept now
  // (more once earlier lines were read).
  let head = 0
  let limit = maxBytes
  let earlier = 0
  // Blank lines' bytes after the last kept line (they go with the next one).
  let blank = 0
  // A line before the kept ones too long to read whole: nothing earlier is read.
  let stuck = false
  function reset() {
    offset = 0
    lines = []
    sizes = []
    kept = 0
    cut = false
    head = 0
    limit = maxBytes
    earlier = 0
    blank = 0
    stuck = false
  }
  // The complete lines of buf[from, end) (end: just past a '\n'), each with
  // its size in the file (a blank line's bytes go with the next line's).
  function linesOf(buf, from, end, carry = 0) {
    const out = []
    const outSizes = []
    let skipped = carry
    let pos = from
    while (pos < end) {
      let nl = buf.indexOf(10, pos)
      if (nl < 0 || nl >= end) nl = end - 1
      let stop = nl
      if (stop > pos && buf[stop - 1] === 13) stop--
      const size = nl + 1 - pos
      if (stop > pos) {
        out.push(buf.toString('utf8', pos, stop))
        outSizes.push(size + skipped)
        skipped = 0
      } else skipped += size
      pos = nl + 1
    }
    return { out, outSizes, skipped }
  }
  // -> true when lines were added (or the file was read again), false when
  // nothing changed, null when the file cannot be read.
  function read() {
    let fd
    try {
      fd = fs.openSync(file, 'r')
    } catch {
      return null
    }
    try {
      const st = fs.fstatSync(fd)
      const id = `${st.dev}:${st.ino}:${st.birthtimeMs}`
      let changed = false
      if (identity !== id || st.size < offset) {
        if (identity !== null) changed = true
        identity = id
        reset()
      }
      if (st.size === offset) return changed
      let start = offset
      // More was added than is kept: only its end is read.
      if (st.size - start > maxBytes) {
        start = st.size - maxBytes
        reset()
        cut = true
      }
      const buf = Buffer.alloc(st.size - start)
      let got = 0
      while (got < buf.length) {
        const n = fs.readSync(fd, buf, got, buf.length - got, start + got)
        if (!n) break
        got += n
      }
      let from = 0
      // Started inside a line (the file's tail only): from the next line.
      if (start > 0 && start !== offset) {
        const nl = buf.indexOf(10)
        if (nl < 0 || nl >= got) return true
        from = nl + 1
      }
      const end = got > 0 ? buf.lastIndexOf(10, got - 1) : -1
      if (end < from) {
        if (start !== offset) offset = head = start + from
        return changed || start !== offset
      }
      if (!lines.length && start !== offset) {
        head = start + from
        blank = 0
      }
      offset = start + end + 1
      const { out, outSizes, skipped } = linesOf(buf, from, end + 1, blank)
      blank = skipped
      for (let i = 0; i < out.length; i++) {
        lines.push(out[i])
        sizes.push(outSizes[i])
        kept += outSizes[i]
      }
      let drop = 0
      while (kept > limit && drop < lines.length) {
        kept -= sizes[drop]
        head += sizes[drop++]
      }
      if (drop) {
        lines = lines.slice(drop)
        sizes = sizes.slice(drop)
        cut = true
      }
      return true
    } catch {
      return null
    } finally {
      fs.closeSync(fd)
    }
  }
  // -> { added: lines added before the kept ones, more: earlier lines remain
  // (and may still be read) } | null (the file changed under it, or cannot be
  // read: read() starts it over).
  function readEarlier(bytes) {
    const room = Math.min(bytes, maxEarlier - earlier)
    if (head <= 0 || room <= 0 || stuck) return { added: 0, more: false }
    let fd
    try {
      fd = fs.openSync(file, 'r')
    } catch {
      return null
    }
    try {
      const st = fs.fstatSync(fd)
      if (identity !== `${st.dev}:${st.ino}:${st.birthtimeMs}` || st.size < offset) return null
      // The window ends where the kept lines begin (just past a '\n'); a line
      // longer than the room left is never cut: nothing more is read.
      // One byte more before it: a window that starts a line keeps it.
      const start = Math.max(0, head - room - 1)
      const buf = Buffer.alloc(head - start)
      let got = 0
      while (got < buf.length) {
        const n = fs.readSync(fd, buf, got, buf.length - got, start + got)
        if (!n) break
        got += n
      }
      if (got !== buf.length) return null
      let from = 0
      if (start > 0) {
        // Its last byte ends the line before the kept ones: a newline before
        // it starts a whole line, none means that line is longer than the room.
        const nl = buf.indexOf(10)
        if (nl < 0 || nl >= buf.length - 1) {
          stuck = true
          return { added: 0, more: false }
        }
        from = nl + 1
      }
      const { out, outSizes, skipped } = linesOf(buf, from, buf.length)
      let added = outSizes.reduce((sum, n) => sum + n, 0)
      // Blank lines just before the kept ones go with the first of them.
      if (skipped && sizes.length) {
        sizes[0] += skipped
        added += skipped
      } else if (skipped) blank += skipped
      const read = buf.length - from
      lines = [...out, ...lines]
      sizes = [...outSizes, ...sizes]
      kept += added
      head = start + from
      earlier += read
      // Kept while the agent writes on (up to the whole bound, then the
      // oldest go first).
      limit = Math.max(limit, kept, maxBytes + maxEarlier)
      cut = head > 0
      return { added: out.length, more: more() }
    } catch {
      return null
    } finally {
      fs.closeSync(fd)
    }
  }
  // Earlier lines remain and may still be read.
  function more() {
    return head > 0 && earlier < maxEarlier && !stuck
  }
  return { read, readEarlier, lines: () => lines, cut: () => cut, more }
}

// The lines of one agent's session file -> the chat's events.
export function viewEvents(agent, lines, sessionId, limits = HISTORY_LIMITS) {
  if (agent === 'grok') return grokViewEvents(lines, limits)
  if (agent === 'omp') return ompViewEvents(lines, limits)
  if (agent === 'codex') return codexHistoryEvents(lines, sessionId, limits)
  return claudeHistoryEvents(lines, limits)
}

// The context the agent's latest answer read, for the chat view's ring
// (after Orca's transcript context usage, MIT, Copyright (c) 2026 Lovecast
// Inc.): Claude Code / OpenClaude: the newest main-thread answer's usage
// (its input, cache writes and reads; the file never says the window);
// Codex: its newest token_count (the last request's total, in the model's
// window). -> { type: 'contextUsage', usedTokens, windowTokens } | null
const SCAN_FOR_USAGE = 400
export function contextUsageEvent(agent, lines) {
  const list = Array.isArray(lines) ? lines : []
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0)
  const stop = Math.max(0, list.length - SCAN_FOR_USAGE)
  for (let i = list.length - 1; i >= stop; i--) {
    const line = list[i]
    if (typeof line !== 'string') continue
    if (agent === 'codex') {
      if (!line.includes('"token_count"')) continue
      const o = parse(line)
      const p = obj(o && o.payload)
      const info = obj(p && p.info)
      if (!o || o.type !== 'event_msg' || p.type !== 'token_count' || !info) continue
      const last = obj(info.last_token_usage)
      const used = last ? n(last.total_tokens) || n(last.input_tokens) + n(last.output_tokens) : 0
      if (!used) continue
      return { type: 'contextUsage', usedTokens: used, windowTokens: n(info.model_context_window) || null }
    }
    if (agent !== 'claude' && agent !== 'openclaude') return null
    if (!line.includes('"usage"')) continue
    const o = parse(line)
    if (!o || o.type !== 'assistant' || o.isSidechain === true) continue
    const u = obj(obj(o.message)?.usage)
    if (!u) continue
    const used = n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens)
    if (!used) continue
    return { type: 'contextUsage', usedTokens: used, windowTokens: null }
  }
  return null
}

// Each "load earlier" reads up to one more tail's worth (4 MB), three at most;
// the events kept grow with it.
const EARLIER_STEPS = 3
// more: earlier lines can still be read (readEarlier); background: Claude
// Code's background tasks still running (transcriptBackground.js).
function eventsOf(agent, sessionId, tail, limits, eventCap = limits.events) {
  let events = viewEvents(agent, tail.lines(), sessionId, limits)
  let truncated = tail.cut()
  if (events.length > eventCap) {
    events = events.slice(-eventCap)
    truncated = true
  }
  const usage = contextUsageEvent(agent, tail.lines())
  if (usage) events = [...events, usage]
  const background = agent === 'claude' || agent === 'openclaude' ? claudeBackgroundFromLines(tail.lines()) : []
  return { events, truncated, more: !!(tail.more && tail.more()), background }
}

// -> { ok: true, events, truncated, file, tail } | { ok: false, code: 'invalid' | 'missing' }
// home, reported: see findTranscriptViewFile (Claude Code, Codex, OpenClaude).
export function readTranscriptView({ agent, sessionId, roots = transcriptViewRoots(), home = null, reported = null, limits = HISTORY_LIMITS } = {}) {
  if (!TRANSCRIPT_VIEW_AGENTS.includes(agent) || !validViewId(agent, sessionId)) return { ok: false, code: 'invalid' }
  const file = findTranscriptViewFile(agent, sessionId, roots, { home, reported })
  if (!file) return { ok: false, code: 'missing' }
  const tail = createTail(file, limits.bytes, { maxEarlier: limits.bytes * EARLIER_STEPS })
  if (tail.read() === null) return { ok: false, code: 'missing' }
  return { ok: true, ...eventsOf(agent, sessionId, tail, limits), file, tail }
}

const PANE_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/
const ACCOUNT_ID = /^[\w.-]{1,80}$/

// What a pane's hooks last reported (teamMcp reportSession): the session file
// they named, for that session of that agent only (checked again where it is
// used: findTranscriptViewFile).
export function reportedTranscript(sessionsDir, paneId, agent, sessionId) {
  if (typeof sessionsDir !== 'string' || !isAbsolute(sessionsDir) || typeof paneId !== 'string' || !PANE_ID.test(paneId)) return null
  try {
    const r = obj(JSON.parse(fs.readFileSync(join(sessionsDir, `${paneId}.json`), 'utf8')))
    return r && r.agent === agent && r.sessionId === sessionId && typeof r.transcriptPath === 'string' ? r.transcriptPath : null
  } catch {
    return null
  }
}

// The open views and their watchers. send(channel, payload) reaches the window.
// homes(agent, accountId) -> the folder Claude Code or Codex keeps that
// account's conversations in (or null); sessionsDir() -> where the panes'
// hooks report their sessions.
export function createTranscriptViews({ send, roots = transcriptViewRoots, homes = async () => null, sessionsDir = () => null, watch = fs.watch, debounceMs = 300, pollMs = 2000, log = null, limits = HISTORY_LIMITS } = {}) {
  const views = new Map() // viewId -> { agent, sessionId, file, tail, watcher, timer, poll, stamp, eventCap }
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
    const read = v.tail.read()
    if (!views.has(viewId) || read === false) return
    if (read === null) {
      send('transcriptView:event', { viewId, ok: false, code: 'missing' })
      return
    }
    send('transcriptView:event', { viewId, ok: true, ...eventsOf(v.agent, v.sessionId, v.tail, limits, v.eventCap) })
  }
  // The window's "load earlier": the lines before the kept ones, read from the
  // same file (bounded: createTail's readEarlier), then the whole view again.
  // -> { ok, events, truncated, more, background, added } | { ok: false, code }
  function earlier(viewId) {
    const v = views.get(viewId)
    if (!v) return { ok: false, code: 'missing' }
    const res = v.tail.readEarlier(limits.bytes)
    if (!res) return { ok: false, code: 'changed' }
    if (res.added) v.eventCap = Math.min(v.eventCap + limits.events, limits.events * (EARLIER_STEPS + 1))
    return { ok: true, added: res.added, ...eventsOf(v.agent, v.sessionId, v.tail, limits, v.eventCap) }
  }
  // The folder the agent works in, from its file's newest lines (for its
  // skills), or null.
  function cwdOf(viewId) {
    const v = views.get(viewId)
    return v ? transcriptCwd(v.tail.lines()) : null
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
  // home, reported: resolved by the IPC handler (never from the window).
  function open({ agent, sessionId, home = null, reported = null } = {}) {
    const res = readTranscriptView({ agent, sessionId, roots: roots(), home, reported, limits })
    if (!res.ok) return res
    // The oldest view gives way: a view nobody closed (a crashed window) cannot pile up.
    while (views.size >= MAX_VIEWS) close(views.keys().next().value)
    const viewId = `tv-${++nextId}` // i18n-ignore id
    const v = { agent, sessionId, file: res.file, tail: res.tail, watcher: null, timer: null, poll: null, stamp: stampOf(res.file), eventCap: limits.events }
    views.set(viewId, v)
    // The watcher hurries a read; the slow poll is what is relied on (a
    // watcher can miss changes, or stop, without saying so).
    v.poll = setInterval(() => schedule(viewId), pollMs)
    v.poll.unref?.()
    try {
      v.watcher = watch(res.file, { persistent: false }, () => schedule(viewId))
      v.watcher.on?.('error', () => {
        try {
          v.watcher.close()
        } catch {
          // gone
        }
        v.watcher = null
      })
    } catch (err) {
      if (log) log.warn('transcriptView', `watch failed, polling: ${err && err.message}`)
    }
    return { ok: true, viewId, events: res.events, truncated: res.truncated, more: res.more, background: res.background }
  }
  // The window names the agent, the session, its pane and its account, never
  // a folder or a file.
  async function openFromWindow(q) {
    const o = obj(q) || {}
    const { agent, sessionId } = o
    if (!TRANSCRIPT_VIEW_AGENTS.includes(agent) || !validViewId(agent, sessionId)) return { ok: false, code: 'invalid' }
    const accountId = o.accountId === null || (typeof o.accountId === 'string' && ACCOUNT_ID.test(o.accountId)) ? o.accountId : undefined
    let home = null
    if (ACCOUNT_AGENTS.includes(agent)) {
      try {
        home = (await homes(agent, accountId)) || null
      } catch {
        home = null
      }
      if (!home) return { ok: false, code: 'missing' }
    }
    let reported = null
    if (ACCOUNT_AGENTS.includes(agent) || agent === 'openclaude') {
      try {
        reported = reportedTranscript(sessionsDir(), o.paneId, agent, sessionId)
      } catch {
        reported = null
      }
    }
    return open({ agent, sessionId, home, reported })
  }
  function register(ipcMain) {
    ipcMain.handle('transcriptView:open', (_e, q) => openFromWindow(q))
    ipcMain.handle('transcriptView:close', (_e, q) => ({ ok: close(obj(q)?.viewId) }))
    ipcMain.handle('transcriptView:earlier', (_e, q) => earlier(obj(q)?.viewId))
  }
  return { open, openFromWindow, close, earlier, cwdOf, agentOf: (viewId) => views.get(viewId)?.agent || null, closeAll: () => [...views.keys()].forEach(close), register, count: () => views.size }
}
