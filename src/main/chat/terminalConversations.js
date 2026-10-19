// What you and each terminal agent said to each other in its terminal, for
// the Conversations tab (ConversationsPanel.vue, src/shared/conversations.js):
// your prompts and its answers, read from the agent's own conversation file
// with the chat view's readers (transcriptView.js: the file found by its id
// inside the agent's own folder, never a path from the window, and its lines
// decoded by the same parsers), then cut to what a conversation shows.
//
// Kept: what you typed, also while the agent worked (Claude Code queues such
// a prompt and records it apart), not a tool's result, not Claude Code's own
// notes, a hook's or the IDE's context or a background task's notice, not
// what Tessel itself typed there (src/shared/tesselDelivery.js); and the
// agent's answer to the latest prompt: the text it wrote after its last tool
// call of the turn (not the text between its tool calls, not its thinking;
// not its answer to Tessel's own message or another session's). Each with its
// time, and the model and effort it ran with when the file says so (Claude
// Code: each answer's model and effort; Codex: its turn_context, as
// agentModel.js reads them for the pane header); else none, never a guess.
//
// Bounded: the last 2 MB of a local file (512 KB of a host's), read async and
// only when its size or time changed; what is kept is the decoded lines (the
// newest 200, 300 000 characters, each text cut at 8000 characters), never
// the file's own lines. 32 conversations asked at once and kept, one local
// read at a time; one not asked for 2 minutes (the tab hidden) is let go. A
// file not found is looked for again a minute later; a read refused for a
// moment (the file busy) keeps what was read and is tried again at the next
// ask. An agent on an SSH host (Claude Code, Codex: remoteFs.js
// readAgentFile, the file found by its id in the agent's folder there) is
// read at most once a minute, apart from the local reads (an answer waits for
// a host 1.5 s at most), and a host slow to answer is left alone 2 minutes.
// The window names agents, session ids, panes, accounts and hosts, never a
// folder or a file; what is read goes back to that window only.
import fs from 'fs'
import { HISTORY_LIMITS } from './transcriptHistory.js'
import {
  findTranscriptViewFile,
  reportedTranscript,
  transcriptViewRoots,
  validViewId,
  viewEvents,
  grokModelTimeline
} from './transcriptView.js'
import { remoteWindowReader, validRemoteTranscript } from './remoteTranscripts.js'
import { isTesselDelivery } from '../../shared/tesselDelivery.js'
import { museModelTimeline } from '../museSessions.js'
import { antigravityModelTimeline } from '../agentModel.js'
import { piModelTimeline } from '../agentModelSources.js'

// Cursor is left out: its file keeps no times (a line could not be placed).
export const TERMINAL_CONVERSATION_AGENTS = [
  'claude',
  'codex',
  'openclaude',
  'antigravity',
  'grok',
  'omp',
  'muse'
]
// Their folder is the pane's account's (homes()).
const ACCOUNT_AGENTS = ['claude', 'codex']
// Their hooks may name the session's file (sessions/<pane>.json).
const REPORTING_AGENTS = ['claude', 'codex', 'openclaude']

export const TERMINAL_LIMITS = {
  localBytes: 2 * 1024 * 1024,
  remoteBytes: 512 * 1024,
  items: 200,
  chars: 300000,
  text: 8000,
  panes: 32,
  entries: 32,
  // Not asked for this long: let go.
  idleMs: 2 * 60 * 1000,
  // A file not found is looked for again after this long.
  missingMs: 60 * 1000,
  remoteEveryMs: 60 * 1000,
  remoteWaitMs: 1500,
  slowHostMs: 10 * 1000,
  hostDownMs: 2 * 60 * 1000
}

const PANE_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/
const ASK_ID = /^[A-Za-z0-9_-][A-Za-z0-9._~:-]{0,199}$/
const ACCOUNT_ID = /^[\w.-]{1,80}$/
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null)
const str = (v) => (typeof v === 'string' && v ? v : null)
function parse(line) {
  try {
    return obj(JSON.parse(line))
  } catch {
    return null
  }
}
function timeOf(v) {
  const ms = typeof v === 'string' ? Date.parse(v) : typeof v === 'number' ? v : NaN
  return Number.isFinite(ms) ? ms : null
}

// ---- What a line says -------------------------------------------------------------

// The context an agent, its IDE or its host puts before a prompt (Claude
// Code's, Codex's): only these known tags, closed (a prompt that starts with
// a snippet of yours, <router-view …>, is yours).
const CONTEXT_TAGS = [
  'ide_opened_file',
  'ide_selection',
  'ide_diagnostics',
  'task-notification',
  'bash-input',
  'bash-stdout',
  'bash-stderr',
  'user-prompt-submit-hook',
  'command-message',
  'local-command-caveat',
  'local-command-stdout',
  'local-command-stderr',
  'in-app-browser-context',
  'browser_instruction',
  'send_user_message_question_reply',
  'environment_context',
  'user_instructions'
]
const CONTEXT_BLOCK = new RegExp(
  `^<(${CONTEXT_TAGS.join('|')})(?:\\s[^>]*)?>[\\s\\S]*?<\\/\\1>\\s*`
)
const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g
// Claude Code's mark around a paste (no closing tag): the paste is kept.
const PASTE_MARK = /<\/?pasted_content\b[^>]*>/g

// A prompt as typed, without what was added around it: { text, tessel }.
// text: '' when nothing is yours (a bare slash command such as /clear, only
// context); tessel: Tessel typed it (its answer is not to you).
export function promptOf(raw) {
  let s = String(raw || '')
    .replace(REMINDER, '')
    .trim()
  for (let i = 0; i < 8; i++) {
    const m = CONTEXT_BLOCK.exec(s)
    if (!m) break
    s = s.slice(m[0].length).trimStart()
  }
  s = s.replace(PASTE_MARK, '').trim()
  if (s && isTesselDelivery(s)) return { text: '', tessel: true }
  if (!s || /^\/[\w:.-]+$/.test(s)) return { text: '', tessel: false }
  return { text: s, tessel: false }
}
export const cleanPrompt = (raw) => promptOf(raw).text

const clip = (s, max) => (s.length > max ? `${s.slice(0, max - 1)}…` : s)
const textBlocks = (content) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .filter((b) => obj(b) && b.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text)
          .join('\n')
      : ''

// Claude Code: a user line that is not you (a background task's notice, a
// message from another session such as Tessel's reminder in its inbox: its
// origin says so) is not shown, but it starts a turn of its own: the line
// becomes a bare prompt marked TURN (PEER for another session's), so the
// answer before it stays that turn's.
const TURN = '\u0000turn'
const PEER = '\u0000peer'
const bare = (r, content) =>
  JSON.stringify({
    type: 'user',
    uuid: r.uuid,
    timestamp: r.timestamp,
    message: { role: 'user', content }
  })
function claudeLine(line) {
  if (line.includes('"queued_command"')) return queuedLine(line)
  if (!line.includes('"origin"') || !line.includes('"type":"user"')) return line
  const r = parse(line)
  if (!r || r.type !== 'user') return line
  const kind = obj(r.origin)?.kind
  if (typeof kind !== 'string' || kind === 'human') return line
  return bare(r, kind === 'peer' ? PEER : TURN)
}
// A prompt you sent while it worked: Claude Code queues it and gives it
// between its tool calls, recorded as an attachment (queued_command), never
// as a user line: yours becomes a prompt where it was given (the turn's
// answer is then to it). Another session's, a task's notice and Tessel's own
// are left out, and the turn stays whose it was.
function queuedLine(line) {
  const r = parse(line)
  const a = r && r.type === 'attachment' ? obj(r.attachment) : null
  if (!a || a.type !== 'queued_command') return line
  const kind = obj(a.origin)?.kind
  if (
    a.commandMode !== 'prompt' ||
    a.isMeta === true ||
    r.isSidechain === true ||
    (typeof kind === 'string' && kind !== 'human')
  )
    return null
  const content = typeof a.prompt === 'string' || Array.isArray(a.prompt) ? a.prompt : null
  if (!content) return null
  // Tessel's own, or nothing typed (a slash command such as /compact, only
  // context; an image is something): the turn stays whose it was.
  const p = promptOf(textBlocks(content))
  const image = Array.isArray(content) && content.some((b) => obj(b) && b.type === 'image')
  if (p.tessel || (!p.text && !image)) return null
  return JSON.stringify({
    type: 'user',
    uuid: str(r.uuid) || str(a.source_uuid),
    timestamp: r.timestamp || a.timestamp,
    message: { role: 'user', content }
  })
}
// Codex: an agent message marked as commentary (what it says between tool
// calls) is not its answer.
function codexAnswer(line) {
  if (!line.includes('"commentary"')) return true
  const r = parse(line)
  const p = r && obj(r.payload)
  if (!p) return true
  const item = p.type === 'item_completed' ? obj(p.item) : p.type === 'message' ? p : null
  return !(item && item.phase === 'commentary')
}

// The models a file names, in its order: [{ t, model, effort }]. Claude Code:
// each answer's model and the effort it ran with (perTurnEffort, else
// effort); Codex: each turn_context (and thread settings applied), its effort
// on the turn or in its collaboration mode; Muse Code: each turn's model, each
// /models and /effort (museSessions.js); Antigravity: each model agy notes
// with a prompt; OMP: each model change, thinking level and answer's model
// (Pi's format, agentModelSources.js). As agentModel.js reads them.
export function modelTimeline(agent, lines) {
  if (agent === 'muse') return museModelTimeline(lines.join('\n'))
  if (agent === 'antigravity') return antigravityModelTimeline(lines)
  if (agent === 'omp') return piModelTimeline(lines)
  // Grok Build: the model each prompt was sent to (its update stream).
  if (agent === 'grok') return grokModelTimeline(lines)
  const out = []
  const claude = agent === 'claude' || agent === 'openclaude'
  if (!claude && agent !== 'codex') return out
  for (const line of lines) {
    if (!line.includes('"model"')) continue
    const o = parse(line)
    if (!o) continue
    const t = timeOf(o.timestamp)
    if (t == null) continue
    if (claude) {
      const m = obj(o.message)?.model
      if (
        o.type !== 'assistant' ||
        o.isSidechain === true ||
        typeof m !== 'string' ||
        !m ||
        m.startsWith('<')
      )
        continue
      const e = [o.perTurnEffort, o.effort].find((x) => CLAUDE_EFFORTS.includes(x))
      out.push({ t, model: m, effort: e || null })
      continue
    }
    const p = obj(o.payload)
    if (!p) continue
    if (o.type === 'turn_context' && str(p.model)) {
      const mode = obj(obj(p.collaboration_mode)?.settings)
      const effort = p.effort || p.reasoning_effort || (mode && mode.reasoning_effort)
      out.push({ t, model: p.model, effort: str(effort) })
      continue
    }
    const s = p.type === 'thread_settings_applied' ? obj(p.thread_settings) : null
    if (s && str(s.model))
      out.push({ t, model: s.model, effort: str(s.reasoning_effort || s.effort) })
  }
  return out
}

// The latest model named at or before t.
function modelAt(timeline, t) {
  let hit = null
  for (const m of timeline) {
    if (m.t > t) break
    hit = m
  }
  return hit
}

// One session's lines -> [{ role: 'user' | 'agent', t, text, model?, effort? }],
// oldest first.
export function conversationItems(agent, lines, sessionId, limits = TERMINAL_LIMITS) {
  const claude = agent === 'claude' || agent === 'openclaude'
  const kept = claude
    ? lines.map(claudeLine).filter(Boolean)
    : agent === 'codex'
      ? lines.filter(codexAnswer)
      : lines
  // No attachment caps: an image is "[image]" text, nothing is decoded.
  const events = viewEvents(agent, kept, sessionId, HISTORY_LIMITS)
  const items = []
  const push = (role, t, text) => {
    const s = String(text || '').trim()
    if (!Number.isFinite(t) || !s) return
    items.push({ role, t, text: clip(s, limits.text) })
  }
  let reply = [] // the turn's texts since its last tool call
  // The turn answers you: your prompt, your agent's own background task
  // going on (or a window that starts inside a turn); not a message from
  // Tessel or another session (its answer is theirs).
  let yours = true
  const flush = () => {
    if (reply.length && yours)
      push('agent', reply[reply.length - 1].at, reply.map((e) => e.text).join('\n\n'))
    reply = []
  }
  for (const ev of events) {
    if (ev.type === 'user') {
      flush()
      if (ev.text === TURN || ev.text === PEER) {
        yours = ev.text === TURN
        continue
      }
      const p = promptOf(ev.text)
      yours = !p.tessel
      if (p.text) push('user', ev.at, p.text)
    } else if (ev.type === 'turnEnd') flush()
    // A tool call (not a call's later status): the text before it was not the answer.
    else if (ev.type === 'tool' && typeof ev.name === 'string') reply = []
    else if (ev.type === 'assistant') reply.push(ev)
  }
  flush()
  const timeline = modelTimeline(agent, kept)
  if (timeline.length) {
    items.forEach((it, i) => {
      // Claude Code names the model on its answers: a prompt's is the answer's
      // to it (none yet: unknown). Codex names it when the turn starts.
      const next = items[i + 1]
      const m =
        claude && it.role === 'user'
          ? next && next.role === 'agent'
            ? modelAt(timeline, next.t)
            : null
          : modelAt(timeline, it.t)
      if (m) {
        it.model = m.model
        if (m.effort) it.effort = m.effort
      }
    })
  }
  return items
}

// ---- Reading ------------------------------------------------------------------------

// A local file's window, async: { ok, size, mtimeMs, data } | { ok: false,
// missing?, code? } (the window ends at its end, or starts at offset).
export function localWindowReader(file, fsp = fs.promises) {
  return async ({ offset = null, cap }) => {
    let fh = null
    try {
      fh = await fsp.open(file, 'r')
      const st = await fh.stat()
      if (!st.isFile()) return { ok: false, missing: true }
      const start = offset === null ? Math.max(0, st.size - cap) : Math.min(offset, st.size)
      const len = Math.max(0, Math.min(cap, st.size - start))
      const data = Buffer.alloc(len)
      let got = 0
      while (got < len) {
        const { bytesRead } = await fh.read(data, got, len - got, start + got)
        if (!bytesRead) break
        got += bytesRead
      }
      return { ok: true, size: st.size, mtimeMs: st.mtimeMs, data: data.subarray(0, got) }
    } catch (err) {
      const code = err && err.code
      return { ok: false, missing: code === 'ENOENT', ...(code ? { code } : {}) }
    } finally {
      if (fh) await fh.close().catch(() => {})
    }
  }
}

// A window's complete lines: the first one when the window starts inside the
// file (cut), and a last one still being written (not whole JSON), go.
export function windowLines(data, cut) {
  let text = data.toString('utf8')
  if (cut) {
    const nl = text.indexOf('\n')
    text = nl < 0 ? '' : text.slice(nl + 1)
  }
  const lines = text.split('\n')
  const last = lines.pop()
  if (last && last.trim() && parse(last.replace(/\r$/, ''))) lines.push(last)
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l)).filter(Boolean)
}

// The newest decoded lines only, within the bounds (what is kept).
function newest(items, limits) {
  const out = []
  let chars = 0
  for (let i = items.length - 1; i >= 0 && out.length < limits.items; i--) {
    chars += items[i].text.length
    if (chars > limits.chars) break
    out.push(items[i])
  }
  return out.reverse()
}

// The window's ask, checked: [{ ask, paneId, agent, sessionId, accountId?, hostId? }].
// ask: what the answer is filed under (a pane's earlier conversation has its
// own); the pane's id by default.
function asksOf(list, max) {
  const out = []
  const seen = new Set()
  for (const raw of Array.isArray(list) ? list : []) {
    if (out.length >= max) break
    const p = obj(raw)
    if (
      !p ||
      typeof p.paneId !== 'string' ||
      !PANE_ID.test(p.paneId) ||
      !TERMINAL_CONVERSATION_AGENTS.includes(p.agent)
    )
      continue
    const ask =
      p.ask === undefined
        ? p.paneId
        : typeof p.ask === 'string' && ASK_ID.test(p.ask)
          ? p.ask
          : null
    if (!ask || seen.has(ask)) continue
    if (p.hostId != null) {
      if (!validRemoteTranscript(p.agent, p.hostId, p.sessionId)) continue
      seen.add(ask)
      out.push({ ask, paneId: p.paneId, agent: p.agent, sessionId: p.sessionId, hostId: p.hostId })
      continue
    }
    if (!validViewId(p.agent, p.sessionId)) continue
    const accountId =
      p.accountId === null || (typeof p.accountId === 'string' && ACCOUNT_ID.test(p.accountId))
        ? p.accountId
        : undefined
    seen.add(ask)
    out.push({ ask, paneId: p.paneId, agent: p.agent, sessionId: p.sessionId, accountId })
  }
  return out
}

// homes(agent, accountId) -> the folder Claude Code or Codex keeps that
// account's conversations in (or null); sessionsDir() -> where the panes'
// hooks report their sessions; readAgentFile(hostId, q) -> a host's file
// window (remoteFs.js), or null when hosts are not read.
export function createTerminalConversations({
  homes = async () => null,
  sessionsDir = () => null,
  readAgentFile = null,
  roots = transcriptViewRoots,
  limits = TERMINAL_LIMITS,
  now = () => Date.now(),
  fsp = fs.promises,
  log = null,
  timers = globalThis
} = {}) {
  // key -> { id, key, agent, sessionId, hostId, file, reader, stamp, items, askedAt, readAt, pending }
  const entries = new Map()
  const missing = new Map() // key -> when its file was last looked for in vain
  const hostDown = new Map() // hostId -> until when it is left alone
  const hostQueues = new Map() // hostId -> its reads, one after the other
  let queue = Promise.resolve()
  let serial = 0
  let idleTimer = null

  function keep(entry) {
    entries.delete(entry.key)
    entries.set(entry.key, entry)
    while (entries.size > limits.entries) entries.delete(entries.keys().next().value)
  }
  function newEntry(key, agent, sessionId, hostId, more) {
    // What the window knows it by: a number (never a folder).
    return {
      id: ++serial,
      key,
      agent,
      sessionId,
      hostId,
      file: null,
      reader: null,
      stamp: '',
      items: null,
      askedAt: 0,
      readAt: 0,
      pending: null,
      ...more
    }
  }
  // A file not found: not looked for again before missingMs.
  function lost(key) {
    missing.set(key, now())
    if (missing.size > limits.entries * 4) missing.delete(missing.keys().next().value)
  }
  const lostLately = (key) => missing.has(key) && now() - missing.get(key) < limits.missingMs
  // What nobody asked for lately goes (the tab hidden, a pane closed); all
  // of it once nothing is asked at all for idleMs.
  function sweep() {
    for (const [key, e] of entries) if (now() - e.askedAt > limits.idleMs) entries.delete(key)
  }
  function armIdle() {
    if (idleTimer) timers.clearTimeout(idleTimer)
    idleTimer = timers.setTimeout(() => {
      idleTimer = null
      entries.clear()
      missing.clear()
      hostDown.clear()
    }, limits.idleMs)
    if (idleTimer && typeof idleTimer.unref === 'function') idleTimer.unref()
  }
  const decode = (e, r) => {
    e.items = newest(
      conversationItems(e.agent, windowLines(r.data, r.size > r.data.length), e.sessionId, limits),
      limits
    )
    e.stamp = `${r.size}:${r.mtimeMs ?? ''}`
  }

  // ---- Local files ----
  async function localEntry(p, homeOf) {
    let home = null
    if (ACCOUNT_AGENTS.includes(p.agent)) {
      home = await homeOf(p.agent, p.accountId)
      if (!home) return null
    }
    const key = `${p.agent}|${home || ''}|${p.sessionId}` // i18n-ignore
    if (entries.has(key)) return entries.get(key)
    if (lostLately(key)) return null
    let reported = null
    if (REPORTING_AGENTS.includes(p.agent)) {
      try {
        reported = reportedTranscript(sessionsDir(), p.paneId, p.agent, p.sessionId)
      } catch {
        reported = null
      }
    }
    let file = null
    try {
      file = findTranscriptViewFile(p.agent, p.sessionId, roots(), { home, reported })
    } catch {
      file = null
    }
    if (!file) {
      lost(key)
      return null
    }
    missing.delete(key)
    return newEntry(key, p.agent, p.sessionId, null, { file, reader: localWindowReader(file, fsp) })
  }
  // Read again when its size or time changed. Gone: let go (looked for again
  // a minute later); busy for a moment: what was read stays, tried again at
  // the next ask.
  async function refreshLocal(e) {
    let st
    try {
      st = await fsp.stat(e.file)
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        entries.delete(e.key)
        lost(e.key)
      }
      return
    }
    if (e.items && e.stamp === `${st.size}:${st.mtimeMs}`) return
    const r = await e.reader({ offset: null, cap: limits.localBytes })
    if (!r || !r.ok) {
      if (r && r.missing) {
        entries.delete(e.key)
        lost(e.key)
      }
      return
    }
    decode(e, r)
    e.readAt = now()
  }

  // ---- A host's files ----
  function remoteEntry(p) {
    if (typeof readAgentFile !== 'function') return null
    const key = `${p.agent}|ssh:${p.hostId}|${p.sessionId}` // i18n-ignore
    if (entries.has(key)) return entries.get(key)
    if (lostLately(key)) return null
    return newEntry(key, p.agent, p.sessionId, p.hostId, {
      reader: remoteWindowReader(readAgentFile, {
        hostId: p.hostId,
        agent: p.agent,
        id: p.sessionId
      })
    })
  }
  // Its size and time first (one byte); the window only when they changed.
  async function refreshRemote(e) {
    const probe = await e.reader({ offset: null, cap: 1 })
    e.readAt = now()
    if (!probe || !probe.ok) {
      if (probe && probe.missing) {
        entries.delete(e.key)
        lost(e.key)
      }
      return
    }
    if (e.items && e.stamp === `${probe.size}:${probe.mtimeMs ?? ''}`) return
    const r = await e.reader({ offset: null, cap: limits.remoteBytes })
    if (r && r.ok && Buffer.isBuffer(r.data)) decode(e, r)
  }
  // One read at a time per host, apart from the local reads; a host that
  // took long is left alone hostDownMs.
  function scheduleRemote(e) {
    if (e.pending) return e.pending
    if (e.readAt && now() - e.readAt < limits.remoteEveryMs) return Promise.resolve()
    const down = () => (hostDown.get(e.hostId) || 0) > now()
    if (down()) return Promise.resolve()
    const run = (hostQueues.get(e.hostId) || Promise.resolve()).then(async () => {
      if (down() || !entries.has(e.key)) return
      const started = Date.now()
      try {
        await refreshRemote(e)
      } catch {
        // what was read stays
      }
      if (Date.now() - started > limits.slowHostMs)
        hostDown.set(e.hostId, now() + limits.hostDownMs)
    })
    e.pending = run.finally(() => {
      e.pending = null
    })
    hostQueues.set(
      e.hostId,
      e.pending.catch(() => {})
    )
    return e.pending
  }

  // What the window gets for one ask: its lines from `from` on, or "same"
  // when its copy (known by the key it was given) still holds them: same
  // conversation, same file, and a period no longer than it was sent for.
  function answer(e, prevKey, from) {
    const prev = typeof prevKey === 'string' ? prevKey.split('|') : null
    if (
      prev &&
      prev.length === 3 &&
      prev[0] === String(e.id) &&
      prev[1] === e.stamp &&
      Number(prev[2]) <= from
    )
      return { key: prevKey, same: true }
    const items = []
    for (const it of e.items) if (it.t >= from) items.push(it)
    return { key: `${e.id}|${e.stamp}|${from}`, items } // i18n-ignore
  }

  // q: { panes: [{ ask?, paneId, agent, sessionId, accountId?, hostId? }],
  //      from, known: { [ask]: key } }
  // -> { ok: true, panes: { [ask]: { key, items } | { key, same: true } } }
  async function readAll(q) {
    const o = obj(q) || {}
    const from = Number.isFinite(o.from) ? o.from : 0
    const known = obj(o.known) || {}
    sweep()
    const homesSeen = new Map()
    const homeOf = (agent, accountId) => {
      const k = `${agent}|${accountId === undefined ? '' : String(accountId)}` // i18n-ignore
      if (!homesSeen.has(k))
        homesSeen.set(
          k,
          Promise.resolve()
            .then(() => homes(agent, accountId))
            .catch(() => null)
        )
      return homesSeen.get(k)
    }
    const out = {}
    const remote = []
    for (const p of asksOf(o.panes, limits.panes)) {
      let e = null
      try {
        e = p.hostId ? remoteEntry(p) : await localEntry(p, homeOf)
        if (!e) continue
        e.askedAt = now()
        keep(e)
        if (p.hostId) {
          remote.push({ p, e, wait: scheduleRemote(e) })
          continue
        }
        await refreshLocal(e)
      } catch (err) {
        if (log) log.warn('conversations', `terminal read failed: ${err && err.message}`) // i18n-ignore
      }
      if (e && e.items) out[p.ask] = answer(e, known[p.ask], from)
      // The window had its turn before the next file.
      await new Promise((resolve) => setImmediate(resolve))
    }
    if (remote.length) {
      let timer = null
      await Promise.race([
        Promise.all(remote.map((x) => x.wait.catch(() => {}))),
        new Promise((resolve) => (timer = timers.setTimeout(resolve, limits.remoteWaitMs)))
      ])
      timers.clearTimeout(timer)
      for (const { p, e } of remote) if (e.items) out[p.ask] = answer(e, known[p.ask], from)
    }
    armIdle()
    return { ok: true, panes: out }
  }
  // One ask at a time: a second waits for the first (a host's reads do not
  // hold it longer than remoteWaitMs).
  function read(q) {
    const run = queue.then(
      () => readAll(q),
      () => readAll(q)
    )
    queue = run.catch(() => {})
    return run
  }
  function register(ipcMain) {
    ipcMain.handle('conversations:terminal', (_e, q) => read(q).catch(() => ({ ok: false })))
  }
  function dispose() {
    if (idleTimer) timers.clearTimeout(idleTimer)
    idleTimer = null
    entries.clear()
    missing.clear()
  }
  // What is held for each conversation (its fields, its decoded lines' count).
  const held = () =>
    [...entries.values()].map((e) => ({
      keys: Object.keys(e),
      items: e.items ? e.items.length : 0
    }))
  return { read, register, dispose, held, size: () => entries.size, clear: () => entries.clear() }
}
