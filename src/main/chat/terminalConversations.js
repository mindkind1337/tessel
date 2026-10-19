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
// Bounded: the last 2 MB of a local file, read async and only when its size
// or time changed (a window with fewer than minItems lines, an agent at work
// for hours, reads further back, 8 MB at most); what is kept is the decoded
// lines (the newest 200, 300 000 characters, each text cut at 8000
// characters), never a local file's own lines. 32 conversations asked at
// once and kept, one local read at a time; one not asked for 2 minutes (the
// tab hidden) is let go. A file not found is looked for again a minute
// later; a read refused for a moment (the file busy) keeps what was read and
// is tried again at the next ask. An agent on an SSH host (Claude Code,
// Codex: remoteFs.js readAgentFile, the file found by its id in the agent's
// folder there, a managed account's too) is read at most once a minute while
// the tab is shown, apart from the local reads (an answer waits for a host
// 1.5 s at most), incrementally: its last 512 KB first (further back, 3 MB
// more at most, while it holds too few lines), then only what was added
// (remoteTranscripts.js createRemoteTail, its lines kept while it is asked
// for); a host slow to answer is left alone 2 minutes.
// OpenCode keeps its conversations in its database: read there (see OpenCode).
// The window names agents, session ids, panes, accounts and hosts, never a
// folder or a file; what is read goes back to that window only.
//
// Images (historyAttachments.js, the chat view's contract): a prompt's own
// images and the images the turn's tools gave back (a screenshot, an image
// file read) on its answer, decoded only for the lines kept, each once per
// conversation (cached by its content), within TERMINAL_LIMITS.images. A line
// carries each image's key, name, type and size, never its bytes: the window
// asks for them by key when a thumbnail comes into view (image(key)). A
// host's transcript names the host's paths: listed as remote, never read.
// Live Share guests never get them (shareHistory.js copies text fields only).
import fs from 'fs'
import os from 'os'
import { HISTORY_LIMITS, opencodeHistoryEvents } from './transcriptHistory.js'
import { hasPendingAttachments, resolveHistoryAttachmentsCached } from './historyAttachments.js'
import { createRemoteDrives } from './remoteDrives.js'
import {
  findTranscriptViewFile,
  reportedTranscript,
  transcriptViewRoots,
  validViewId,
  viewEvents
} from './transcriptView.js'
import { createRemoteTail, remoteWindowReader, validRemoteTranscript } from './remoteTranscripts.js'
import { isTesselDelivery } from '../../shared/tesselDelivery.js'
import { museModelTimeline } from '../museSessions.js'
import { antigravityModelTimeline } from '../agentModel.js'
import { opencodeDbFile, opencodeMessageModel, piModelTimeline } from '../agentModelSources.js'
import { readRows } from '../fileRead.js'

// Cursor is left out: its file keeps no times (a line could not be placed).
export const TERMINAL_CONVERSATION_AGENTS = [
  'claude',
  'codex',
  'opencode',
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
  // A window with fewer lines than this (an agent at work for hours, its
  // tools' outputs filling the window) reads further back: a local file up
  // to localMaxBytes, a host's up to remoteMaxBytes more (once, then only
  // what is added).
  minItems: 4,
  localMaxBytes: 8 * 1024 * 1024,
  remoteMaxBytes: 3 * 1024 * 1024,
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
  hostDownMs: 2 * 60 * 1000,
  // A conversation's images (historyAttachments.js caps): per line, and for
  // all the lines kept (the newest first).
  images: { images: 4, imageBytes: 2 * 1024 * 1024, pageImages: 12, pageBytes: 3 * 1024 * 1024, files: 4, name: 120 }
}
const IMAGE_KEY = /^[0-9a-f]{24}$/

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

// The events whose images a line shows (its prompt's, its turn's tools'),
// until attachImages resolves them.
const itemSources = new WeakMap()

// One session's lines -> [{ role: 'user' | 'agent', t, text, model?, effort? }],
// oldest first. With limits.images, the lines that held images are noted
// (attachImages then gives them their images); a prompt that was only an
// image is a line with no text until then.
export function conversationItems(agent, lines, sessionId, limits = TERMINAL_LIMITS) {
  const claude = agent === 'claude' || agent === 'openclaude'
  const kept = claude
    ? lines.map(claudeLine).filter(Boolean)
    : agent === 'codex'
      ? lines.filter(codexAnswer)
      : lines
  // Without image caps an image is "[image]" text and nothing is decoded;
  // with them, each entry only notes what it held (nothing decoded yet).
  const caps = limits && limits.images ? limits.images : null
  const events = viewEvents(agent, kept, sessionId, caps ? { ...HISTORY_LIMITS, attachments: caps } : HISTORY_LIMITS)
  return itemsOfEvents(events, modelTimeline(agent, kept), { limits, caps, answerModels: claude })
}

// The chat's events of a conversation -> its lines (conversationItems'
// shape). timeline: its models in time ([{ t, model, effort }]);
// answerModels: the agent names its model on its answers only (Claude
// Code): a prompt's is the answer's to it.
function itemsOfEvents(events, timeline, { limits, caps, answerModels = false }) {
  const claude = answerModels
  const items = []
  const push = (role, t, text, sources = null) => {
    const s = String(text || '').trim()
    if (!Number.isFinite(t) || (!s && !(sources && sources.length))) return
    const item = { role, t, text: clip(s, limits.text) }
    if (sources && sources.length) itemSources.set(item, sources)
    items.push(item)
  }
  let reply = [] // the turn's texts since its last tool call
  let pictures = [] // the turn's tool entries that gave back images
  // The turn answers you: your prompt, your agent's own background task
  // going on (or a window that starts inside a turn); not a message from
  // Tessel or another session (its answer is theirs).
  let yours = true
  const flush = () => {
    if (reply.length && yours)
      push('agent', reply[reply.length - 1].at, reply.map((e) => e.text).join('\n\n'), pictures)
    reply = []
    pictures = []
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
      const own = caps && !p.tessel && hasPendingAttachments(ev) ? [ev] : null
      if (p.text || own) push('user', ev.at, p.text, own)
      continue
    }
    if (caps && (ev.type === 'tool' || ev.type === 'toolResult') && hasPendingAttachments(ev)) pictures.push(ev)
    if (ev.type === 'turnEnd') flush()
    // A tool call (not a call's later status): the text before it was not the answer.
    else if (ev.type === 'tool' && typeof ev.name === 'string') reply = []
    else if (ev.type === 'assistant') reply.push(ev)
  }
  flush()
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

// The images of the lines kept (conversationItems with limits.images), in
// place: item.images [{ key, name, mime, bytes, source }] for an image shown
// (its bytes stay in `cache`, asked for by key), [{ name, mime?, path,
// missing | remote, source }] for a file gone or a host's; item.imagesMore,
// how many more it held; item.files, a prompt's other files (name, type,
// size, path while it exists). An answer shows its turn's newest images. A
// line left with neither text nor image says "[image]".
// opts: { cache (Map, the conversation's), host (a host's transcript),
// isRemote(path) (a network drive: never read) }.
export async function attachImages(items, caps, { cache = new Map(), host = false, isRemote = null } = {}) {
  const events = []
  for (const it of items) for (const ev of itemSources.get(it) || []) events.push(ev)
  if (events.length) await resolveHistoryAttachmentsCached(events, caps, { cache, host, isRemote: host ? async () => true : isRemote })
  else cache.clear()
  for (const it of items) {
    const sources = itemSources.get(it)
    if (!sources) continue
    itemSources.delete(it)
    let images = []
    let more = 0
    const files = []
    for (const ev of sources) {
      for (const img of Array.isArray(ev.images) ? ev.images : []) {
        if (img.path) images.push({ source: img.source, name: img.name, ...(img.mime ? { mime: img.mime } : {}), path: img.path, ...(img.missing ? { missing: true } : { remote: true }) })
        else if (img.key) images.push({ key: img.key, name: img.name, mime: img.mime, bytes: img.bytes, source: img.source })
      }
      more += Number.isInteger(ev.imagesMore) ? ev.imagesMore : 0
      if (ev.type === 'user' && Array.isArray(ev.files)) files.push(...ev.files)
    }
    if (images.length > caps.images) {
      more += images.length - caps.images
      images = images.slice(-caps.images)
    }
    if (images.length) it.images = images
    if (more) it.imagesMore = more
    if (files.length) it.files = files.map((f) => ({ name: f.name, ...(f.mediaType ? { mediaType: f.mediaType } : {}), ...(Number.isFinite(f.size) ? { size: f.size } : {}), ...(f.path ? { path: f.path } : {}) }))
    if (!it.text && !images.length && !files.length) it.text = '[image]' // i18n-ignore
  }
  return items
}

// ---- OpenCode --------------------------------------------------------------------
// OpenCode keeps its conversations in its database (session, message and part
// tables, each row's data JSON), never a file: a conversation is read there,
// read-only (fileRead.js readRows), its newest OPENCODE_MESSAGES messages, a
// part's text and file data only (a tool's output never: only its name, and
// the images it gave back). Its lines are the chat's own reading
// (transcriptHistory.js opencodeHistoryEvents), its models each message's
// (agentModelSources.js opencodeMessageModel).
export const OPENCODE_MESSAGES = 400
const OPENCODE_ID = /^ses_[A-Za-z0-9]{8,60}$/
export const validOpencodeId = (id) => typeof id === 'string' && OPENCODE_ID.test(id)
const jsonOf = (v) => {
  try {
    return obj(JSON.parse(v))
  } catch {
    return null
  }
}

// -> { stamp } | null (no such session): what changes when it is written to.
export function opencodeStamp(db, sessionId, rows = readRows) {
  const r = rows(db, 'SELECT s.time_updated AS u, (SELECT count(*) FROM message m WHERE m.session_id = s.id) AS n FROM session s WHERE s.id = ?', [sessionId])[0]
  return r ? { stamp: `${r.u}:${r.n}` } : null
}

// One OpenCode session -> its lines (conversationItems' shape), oldest first.
export function opencodeItems(db, sessionId, limits = TERMINAL_LIMITS, rows = readRows) {
  if (!validOpencodeId(sessionId)) return []
  const messages = rows(db, 'SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created DESC, id DESC LIMIT ?', [sessionId, OPENCODE_MESSAGES]).reverse()
  if (!messages.length) return []
  const parts = rows(
    db,
    `SELECT p.message_id AS mid, CASE WHEN json_extract(p.data, '$.type') = 'tool'
       THEN json_object('type', 'tool', 'callID', json_extract(p.data, '$.callID'), 'tool', json_extract(p.data, '$.tool'),
         'synthetic', json_extract(p.data, '$.synthetic'),
         'state', json_object('status', json_extract(p.data, '$.state.status'), 'time', json_extract(p.data, '$.state.time'), 'attachments', json_extract(p.data, '$.state.attachments')))
       ELSE p.data END AS data
     FROM part p WHERE p.message_id IN (SELECT id FROM message WHERE session_id = ? ORDER BY time_created DESC, id DESC LIMIT ?)
     ORDER BY p.id`,
    [sessionId, OPENCODE_MESSAGES]
  )
  const byMessage = new Map()
  for (const part of parts) {
    const d = typeof part.data === 'string' ? jsonOf(part.data) : null
    if (!d) continue
    if (d.type === 'tool' && d.state) {
      // json_object embeds them as JSON; an older SQLite as text.
      const back = (v) => {
        if (typeof v !== 'string') return v
        try {
          return JSON.parse(v)
        } catch {
          return null
        }
      }
      const att = back(d.state.attachments)
      d.state.attachments = Array.isArray(att) ? att : []
      d.state.time = obj(back(d.state.time)) || undefined
    }
    if (!byMessage.has(part.mid)) byMessage.set(part.mid, [])
    byMessage.get(part.mid).push(d)
  }
  const timeline = []
  const list = messages.map((m) => {
    const info = { ...(jsonOf(m.data) || {}), id: String(m.id) }
    if (!obj(info.time)) info.time = { created: m.time_created }
    const model = opencodeMessageModel(info)
    const t = timeOf(info.time.created) ?? timeOf(m.time_created)
    if (model && t != null) timeline.push({ t, model: model.model, effort: model.effort || null })
    return { info, parts: byMessage.get(m.id) || [] }
  })
  // One answer holds text, tool calls, then more text: each stretch of text
  // between two tool calls is a message of its own (the chat merges a
  // message's texts), so its answer is the text after its last call.
  const split = []
  for (const m of list) {
    if (m.info.role !== 'assistant' || !m.parts.some((x) => x.type === 'tool')) {
      split.push(m)
      continue
    }
    let n = 0
    let cur = []
    const flush = (last) => {
      if (!cur.length) return
      const end = !last && m.info.time ? { ...m.info.time, completed: undefined } : m.info.time
      split.push({ info: { ...m.info, id: `${m.info.id}~${n++}`, time: end, ...(last ? {} : { error: undefined }) }, parts: cur })
      cur = []
    }
    for (const x of m.parts) {
      if (x.type === 'tool') {
        flush(false)
        split.push({ info: { ...m.info, id: `${m.info.id}~${n++}`, time: { ...m.info.time, completed: undefined }, error: undefined }, parts: [x] })
      } else cur.push(x)
    }
    flush(true)
  }
  const caps = limits && limits.images ? limits.images : null
  const events = opencodeHistoryEvents(split, caps ? { ...HISTORY_LIMITS, attachments: caps } : HISTORY_LIMITS)
  return itemsOfEvents(events, timeline, { limits, caps })
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
    if (p.agent === 'opencode' ? !validOpencodeId(p.sessionId) : !validViewId(p.agent, p.sessionId)) continue
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
  timers = globalThis,
  // A path on a network drive (never read for an image), as the chat view's.
  isRemote = null,
  // OpenCode's database (this computer's).
  opencodeDb = () => opencodeDbFile(os.homedir()),
  rows = readRows
} = {}) {
  let drives = null
  const onNetwork = isRemote || ((p) => (drives || (drives = createRemoteDrives())).isRemote(p))
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
      // Its images, decoded once (by content), only those of the lines kept.
      images: new Map(),
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
  // Lines decoded -> what is kept, its images resolved.
  async function settle(e, items, stamp) {
    const kept = newest(items, limits)
    if (limits.images) await attachImages(kept, limits.images, { cache: e.images, host: !!e.hostId, isRemote: onNetwork })
    e.items = kept
    e.stamp = stamp
  }
  const decodeLines = (e, lines) => conversationItems(e.agent, lines, e.sessionId, limits)

  // ---- OpenCode (its database) ----
  function opencodeEntry(p) {
    const db = opencodeDb()
    if (typeof db !== 'string' || !db) return null
    const key = `opencode|${db}|${p.sessionId}` // i18n-ignore
    if (entries.has(key)) return entries.get(key)
    if (lostLately(key)) return null
    if (!opencodeStamp(db, p.sessionId, rows)) {
      lost(key)
      return null
    }
    return newEntry(key, 'opencode', p.sessionId, null, { file: db, opencode: true })
  }
  async function refreshOpencode(e) {
    const st = opencodeStamp(e.file, e.sessionId, rows)
    if (!st) {
      entries.delete(e.key)
      lost(e.key)
      return
    }
    if (e.items && e.stamp === st.stamp) return
    await settle(e, opencodeItems(e.file, e.sessionId, limits, rows), st.stamp)
    e.readAt = now()
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
    // The window it needed last time (a wider one when it had too few lines).
    let cap = e.cap || limits.localBytes
    for (;;) {
      const r = await e.reader({ offset: null, cap })
      if (!r || !r.ok) {
        if (r && r.missing) {
          entries.delete(e.key)
          lost(e.key)
        }
        return
      }
      const items = decodeLines(e, windowLines(r.data, r.size > r.data.length))
      const wider = Math.min(cap * 2, limits.localMaxBytes || cap)
      if (items.length < (limits.minItems || 0) && r.size > r.data.length && wider > cap) {
        cap = wider
        continue
      }
      e.cap = cap
      await settle(e, items, `${r.size}:${r.mtimeMs ?? ''}`)
      break
    }
    e.readAt = now()
  }

  // ---- A host's files ----
  function remoteEntry(p) {
    if (typeof readAgentFile !== 'function') return null
    const key = `${p.agent}|ssh:${p.hostId}|${p.sessionId}` // i18n-ignore
    if (entries.has(key)) return entries.get(key)
    if (lostLately(key)) return null
    const read = remoteWindowReader(readAgentFile, { hostId: p.hostId, agent: p.agent, id: p.sessionId })
    const e = newEntry(key, p.agent, p.sessionId, p.hostId, {})
    // Its last answer, to tell a file gone from a host not answering.
    e.reader = async (q) => {
      const r = await read(q)
      e.gone = !!(r && !r.ok && r.missing)
      // Not connected (no sign-in is ever asked here): said to the window.
      e.offline = !!(r && !r.ok && r.notConnected)
      return r
    }
    // Only what was added since the last read crosses the connection (the
    // chat view's remote tail): its last remoteBytes first, further back
    // (remoteMaxBytes more at most) while it holds too few lines.
    e.tail = createRemoteTail(e.reader, limits.remoteBytes, { maxEarlier: limits.remoteMaxBytes || 0 })
    return e
  }
  async function refreshRemote(e) {
    const changed = await e.tail.read()
    e.readAt = now()
    if (changed === null) {
      if (e.gone) {
        entries.delete(e.key)
        lost(e.key)
      }
      return
    }
    if (e.items && !changed) return
    let items = decodeLines(e, e.tail.lines())
    for (let i = 0; i < 8 && items.length < (limits.minItems || 0) && e.tail.more(); i++) {
      const more = await e.tail.readEarlier(limits.remoteBytes)
      if (!more || !more.added) break
      items = decodeLines(e, e.tail.lines())
    }
    await settle(e, items, `${e.tail.size()}`)
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
  // -> { ok: true, panes: { [ask]: { key, items } | { key, same: true } },
  //      waiting?: { [ask]: 'offline' | 'reading' } }
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
    // A host's conversation not read yet: 'offline' (the host is not
    // connected) or 'reading' (its first read is on its way).
    const waiting = {}
    const remote = []
    for (const p of asksOf(o.panes, limits.panes)) {
      let e = null
      try {
        e = p.hostId ? remoteEntry(p) : p.agent === 'opencode' ? opencodeEntry(p) : await localEntry(p, homeOf)
        if (!e) continue
        e.askedAt = now()
        keep(e)
        if (p.hostId) {
          remote.push({ p, e, wait: scheduleRemote(e) })
          continue
        }
        if (e.opencode) await refreshOpencode(e)
        else await refreshLocal(e)
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
      for (const { p, e } of remote) {
        if (e.items) out[p.ask] = answer(e, known[p.ask], from)
        else waiting[p.ask] = e.offline ? 'offline' : 'reading'
      }
    }
    armIdle()
    return { ok: true, panes: out, ...(Object.keys(waiting).length ? { waiting } : {}) }
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
  // An image of a line read for the window, by its key: { ok, dataUrl } (only
  // the images of the conversations it holds, never a path).
  function image(key) {
    if (typeof key !== 'string' || !IMAGE_KEY.test(key)) return { ok: false }
    for (const e of entries.values())
      for (const hit of e.images.values()) if (hit && hit.key === key && typeof hit.dataUrl === 'string') return { ok: true, dataUrl: hit.dataUrl }
    return { ok: false }
  }
  function register(ipcMain) {
    ipcMain.handle('conversations:terminal', (_e, q) => read(q).catch(() => ({ ok: false })))
    ipcMain.handle('conversations:image', (_e, key) => image(key))
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
  return { read, image, register, dispose, held, size: () => entries.size, clear: () => entries.clear() }
}
