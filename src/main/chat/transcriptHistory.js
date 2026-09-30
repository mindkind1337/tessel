// A conversation's earlier history, read from the agent's own transcript, for
// a chat opened on a conversation that happened elsewhere (a terminal pane's
// "Open in chat", a chat resumed with its session id): the chat's journal
// only knows what the chat itself showed.
//
// After Orca's src/main/native-chat transcript readers (transcript-reader.ts,
// transcript-line-decoders-claude.ts, transcript-line-decoders-codex.ts,
// session-file-resolver.ts, structured-agent-session-history-adoption.ts),
// MIT, Copyright (c) 2026 Lovecast Inc. Rewritten for Tessel's chat events:
// the lines become the same events the pane's journal replays ('user',
// 'assistant', 'thinking', 'tool', 'toolResult', 'turnEnd'), each marked
// imported: true, with the transcript's own times (increasing).
//
// Where: Claude: <claude dir>/projects/<project>/<session id>.jsonl; Codex:
// <codex home>/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl. The
// folder is the one the chat's agent runs with (its account's), checked by
// the caller (sessions.js transcriptHome); the file is found here from the id
// alone (never a path from the window), and read only when it is a real file
// whose real path stays inside that folder (no link, no junction).
// Bounded: the last 4 MB of the file, the last 2000 events, each message's
// text cut at 64 KB and a tool's input and output as the journal cuts them
// (8 KB). A partial first line (cut by the window) or last line (being
// written) is skipped. Nothing else is read: no environment, no settings, no
// tokens (Codex's session_meta and turn_context lines are skipped).
// Codex: only the thread's own lines (a line naming another thread, such as a
// sub-agent's, is skipped; sub-agents are reported by their own events).
import fs from 'fs'
import { isAbsolute, join, resolve } from 'path'
import { claudeTranscriptIn, codexRolloutIn } from '../agentModel.js'
import { realInside } from '../agentChildren.js'
import { allowedCodexHome } from '../codexTurnEnd.js'
import { clipDeep, clipString } from './journal.js'
import { toolName as opencodeToolName, toolInput as opencodeToolInput } from './opencodeFrames.js'
import {
  ATTACHMENT_LIMITS,
  fileCandidate,
  imageFromBase64,
  imageFromPath,
  imageFromUrl,
  imagePlaceholders,
  localPath,
  noteAttachments,
  resolveHistoryAttachments
} from './historyAttachments.js'

// attachments (optional): the caps of the images and files a user message
// shows (historyAttachments.js); without them (the search index) its images
// are "[image]" text only and nothing is decoded or read.
export const HISTORY_LIMITS = { bytes: 4 * 1024 * 1024, events: 2000, text: 64 * 1024 }
export { ATTACHMENT_LIMITS, resolveHistoryAttachments }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function validHistoryId(id) {
  return typeof id === 'string' && UUID.test(id)
}

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null)
const str = (v) => (typeof v === 'string' && v ? v : null)
// A user message's text with one "[image]" per image it held (without
// attachment caps: the images themselves are not read).
const withImages = imagePlaceholders

function toolSummary(input) {
  const i = obj(input) || {}
  const pick = i.command ?? i.cmd ?? i.file_path ?? i.path ?? i.pattern ?? i.url ?? i.query ?? i.description ?? i.prompt
  const s = typeof pick === 'string' ? pick : Array.isArray(pick) ? pick.join(' ') : ''
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > 200 ? `${one.slice(0, 199)}…` : one
}

// A tool result's content as text (string, or text blocks).
function resultText(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map((b) => (typeof b === 'string' ? b : str(obj(b)?.text) || ''))
      .filter(Boolean)
      .join('\n')
  }
  const o = obj(value)
  if (o) return str(o.text) || str(o.content) || str(o.output) || JSON.stringify(o)
  return value == null ? '' : String(value)
}

// -> { path, root } or null: the transcript of this conversation in `home`,
// a real file inside it.
export function findTranscript(agent, id, home, now = Date.now()) {
  if (!validHistoryId(id) || typeof home !== 'string' || !isAbsolute(home) || home.includes('\0')) return null
  let base
  try {
    base = fs.realpathSync.native(home)
  } catch {
    return null
  }
  const root = join(home, agent === 'codex' ? 'sessions' : 'projects')
  if (!realInside(base, root, true)) return null
  const file = agent === 'codex' ? codexRolloutIn(home, id.toLowerCase(), now) : claudeTranscriptIn(home, id)
  if (!file || !realInside(base, file, false)) return null
  return file
}

// The last `maxBytes` of a file as complete lines: a first line cut by the
// window and a last line without its end (being written) are dropped, unless
// that last one is whole JSON already.
export function readLastLines(file, maxBytes) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
  } catch {
    return null
  }
  try {
    const size = fs.fstatSync(fd).size
    const start = Math.max(0, size - maxBytes)
    const buf = Buffer.alloc(size - start)
    let got = 0
    while (got < buf.length) {
      const n = fs.readSync(fd, buf, got, buf.length - got, start + got)
      if (!n) break
      got += n
    }
    let text = buf.subarray(0, got).toString('utf8')
    let cut = false
    if (start > 0) {
      const nl = text.indexOf('\n')
      text = nl < 0 ? '' : text.slice(nl + 1)
      cut = true
    }
    const lines = text.split('\n')
    const tail = lines.pop()
    if (tail && tail.trim()) {
      try {
        JSON.parse(tail)
        lines.push(tail)
      } catch {
        // being written: next time
      }
    }
    return { lines: lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l)).filter(Boolean), cut }
  } catch {
    return null
  } finally {
    fs.closeSync(fd)
  }
}

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

// Collects the events, each with a time never before the previous one's,
// merges a message's text (one line per content block) into its first
// event, and closes turns.
export function createBuilder(limits) {
  const events = []
  const messages = new Map() // key -> the event holding its text
  const openTools = new Set()
  const seenTools = new Set() // a result whose call is before the window is dropped
  let lastAt = null
  let turn = null // { at } of the open turn
  let n = 0
  const at = (ts) => {
    const t = timeOf(ts)
    lastAt = t == null ? lastAt : lastAt == null ? t : Math.max(lastAt, t)
    return lastAt
  }
  const push = (ev, ts) => {
    const when = at(ts)
    const e = { ...ev, imported: true, ...(when != null ? { at: when } : {}) }
    events.push(e)
    return e
  }
  const text = (s) => clipString(String(s), limits.text)
  const b = {
    // idTag: an older page's own mark, so its made-up ids never meet another page's.
    nextId: (prefix) => `hist-${limits.idTag || ''}${prefix}-${++n}`, // i18n-ignore id
    endTurn(status = 'completed', ts) {
      if (!turn) return
      for (const id of openTools) push({ type: 'tool', id, status: status === 'interrupted' ? 'stopped' : 'done' }, ts)
      openTools.clear()
      const when = at(ts)
      push({ type: 'turnEnd', status, ...(when != null && turn.at != null ? { durationMs: Math.max(0, when - turn.at) } : {}) }, ts)
      turn = null
      messages.clear()
    },
    // attachments: what the message held (historyAttachments.js candidates),
    // resolved once the page is final; without attachment caps, one "[image]"
    // per image (unless marked: its text already names them) and no files.
    user(id, body, ts, attachments = [], { marked = false } = {}) {
      const list = Array.isArray(attachments) ? attachments : []
      let shown = String(body ?? '')
      if (!limits.attachments) {
        if (!marked) shown = withImages(shown, list.filter((c) => c.kind === 'image').length)
        if (!shown.trim()) return
      } else if (!shown.trim() && !list.length) return
      // The turn before ended with its last line, not when this one came.
      b.endTurn('completed')
      const e = push({ type: 'user', id: `hist-${id}`, text: text(shown), origin: 'user', status: 'accepted' }, ts) // i18n-ignore id
      if (limits.attachments) noteAttachments(e, list, { marked })
      turn = { at: e.at ?? null }
    },
    // Content with no prompt before it (the window started mid-turn).
    work(ts) {
      if (!turn) turn = { at: timeOf(ts) ?? lastAt }
    },
    message(kind, key, body, ts, join) {
      if (!body) return
      b.work(ts)
      const k = `${kind}|${key}`
      const prior = messages.get(k)
      if (prior) {
        prior.text = text(`${prior.text}${join}${body}`)
        at(ts)
        return
      }
      messages.set(k, push({ type: kind, messageId: `hist-${key}`, text: text(body) }, ts)) // i18n-ignore id
    },
    tool(id, name, input, ts) {
      b.work(ts)
      let value = input
      if (typeof value === 'string') {
        try {
          value = JSON.parse(value)
        } catch {
          // kept as text
        }
      }
      openTools.add(id)
      seenTools.add(id)
      push({ type: 'tool', id, name: String(name || ''), summary: toolSummary(value), input: clipDeep(value ?? {}), status: 'running' }, ts)
    },
    toolResult(id, output, isError, ts) {
      if (!seenTools.has(id)) return
      b.work(ts)
      openTools.delete(id)
      push({ type: 'toolResult', id, isError: isError === true, text: clipString(resultText(output)) }, ts)
    },
    finish() {
      b.endTurn('completed')
      return events
    }
  }
  return b
}

// ---- Claude -------------------------------------------------------------------

const INTERRUPTED = /^\[Request interrupted by user/
const LOCAL_COMMAND = /^\s*<local-command-(stdout|stderr|caveat)>/
const COMMAND_NAME = /<command-name>([^<]{1,200})<\/command-name>/
const COMMAND_ARGS = /<command-args>([\s\S]{0,4000}?)<\/command-args>/

function claudePrompt(textIn) {
  const s = String(textIn)
  if (LOCAL_COMMAND.test(s)) return null
  const name = COMMAND_NAME.exec(s)
  if (name) {
    const args = COMMAND_ARGS.exec(s)
    const cmd = name[1].trim()
    return `${cmd.startsWith('/') ? cmd : `/${cmd}`}${args && args[1].trim() ? ` ${args[1].trim()}` : ''}`
  }
  return s
}

// An image block: { source: { type: 'base64', media_type, data } } (a URL or
// a file id: not shown).
function claudeImage(o) {
  const src = obj(o.source) || {}
  if (src.type === 'base64') return imageFromBase64(src.data, src.media_type)
  return imageFromUrl(null)
}

// A document block (a PDF, a text file): { source: { type: 'base64' | 'text',
// media_type, data }, title }.
function claudeDocument(o) {
  const src = obj(o.source) || {}
  const mediaType = str(src.media_type) || (src.type === 'text' ? 'text/plain' : '')
  const name = str(o.title) || (mediaType === 'application/pdf' ? 'document.pdf' : mediaType === 'text/plain' ? 'document.txt' : 'document') // i18n-ignore
  if (src.type === 'base64') return fileCandidate({ name, mediaType, base64: str(src.data) })
  if (src.type === 'text') return fileCandidate({ name, mediaType, text: typeof src.data === 'string' ? src.data : '' })
  return fileCandidate({ name, mediaType })
}

export function claudeHistoryEvents(lines, limits = HISTORY_LIMITS) {
  const b = createBuilder(limits)
  for (const line of lines) {
    const r = parse(line)
    if (!r || (r.type !== 'user' && r.type !== 'assistant')) continue
    // A sub-agent's own conversation (older files kept it in the main one).
    if (r.isSidechain === true) continue
    const ts = r.timestamp
    const msg = obj(r.message) || {}
    const content = msg.content
    const meta = r.isMeta === true || r.isSynthetic === true || r.isCompactSummary === true
    if (r.type === 'user') {
      const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []
      const texts = []
      const attachments = []
      for (const blk of blocks) {
        const o = obj(blk)
        if (!o) continue
        if (o.type === 'tool_result' && str(o.tool_use_id)) b.toolResult(o.tool_use_id, o.content, o.is_error, ts)
        else if (o.type === 'text' && str(o.text) && !meta) texts.push(o.text)
        else if (o.type === 'image' && !meta) attachments.push(claudeImage(o))
        else if (o.type === 'document' && !meta && limits.attachments) attachments.push(claudeDocument(o))
      }
      if (!texts.length && !attachments.length) continue
      const joined = texts.join('\n')
      if (INTERRUPTED.test(joined.trim()) || str(r.interruptedMessageId)) {
        b.endTurn('interrupted', ts)
        continue
      }
      const prompt = claudePrompt(joined)
      if (prompt == null) continue
      // A terminal's pasted image already says "[Image #1]" in its text.
      b.user(str(r.uuid) || b.nextId('u'), prompt, ts, attachments, { marked: /\[Image #\d+\]/.test(joined) })
      continue
    }
    // assistant: one line per content block, all with the message's id.
    const key = str(msg.id) || str(r.uuid) || b.nextId('a')
    for (const blk of Array.isArray(content) ? content : typeof content === 'string' ? [{ type: 'text', text: content }] : []) {
      const o = obj(blk)
      if (!o) continue
      if (o.type === 'text' && str(o.text)) b.message('assistant', key, o.text, ts, '\n\n')
      else if (o.type === 'thinking' && str(o.thinking)) b.message('thinking', key, o.thinking, ts, '\n')
      else if (o.type === 'tool_use' && str(o.id)) b.tool(o.id, o.name, o.input, ts)
    }
  }
  return b.finish()
}

// ---- Codex --------------------------------------------------------------------

// The image items of a Codex user message (the app-server's, the rollout's).
const CODEX_IMAGE_ITEMS = new Set(['image', 'localImage', 'local_image', 'input_image', 'Image', 'LocalImage'])
const CODEX_FILE_ITEMS = new Set(['input_file'])

// Context Codex adds to a user message for the model, not what was typed.
const CODEX_CONTEXT = /^\s*<\/?(image|skill|environment_context|user_instructions|permissions instructions|user_shell_command|turn_aborted|subagent_notification)\b/i

// One image item: a data: URL or a URL (image, input_image), or a local
// path (localImage).
function codexImage(o) {
  const url = typeof o.image_url === 'string' ? o.image_url : str(obj(o.image_url)?.url) || str(o.url)
  if (url) return imageFromUrl(url)
  const path = str(o.path)
  return path ? imageFromPath(path) : imageFromUrl(null)
}

// A file item (input_file): { filename, file_data (a data: URL), file_url }.
function codexFile(o) {
  const data = str(o.file_data)
  const path = localPath(str(o.file_url)) || localPath(str(o.path))
  return fileCandidate({
    name: str(o.filename) || str(o.name),
    mediaType: str(o.mime_type) || '',
    ...(data && /^data:/i.test(data) ? { dataUrl: data } : data ? { base64: data } : {}),
    ...(path ? { path } : {})
  })
}

// -> { text, attachments }
function codexContent(content) {
  if (typeof content === 'string') return { text: content, attachments: [] }
  if (!Array.isArray(content)) return { text: '', attachments: [] }
  const parts = []
  const attachments = []
  for (const c of content) {
    const o = obj(c)
    if (o && ['text', 'Text', 'input_text', 'output_text'].includes(o.type) && str(o.text) && !CODEX_CONTEXT.test(o.text)) parts.push(o.text)
    else if (o && CODEX_IMAGE_ITEMS.has(o.type)) attachments.push(codexImage(o))
    else if (o && CODEX_FILE_ITEMS.has(o.type)) attachments.push(codexFile(o))
  }
  return { text: parts.join('\n'), attachments }
}

function codexSummary(summary) {
  if (!Array.isArray(summary)) return ''
  return summary
    .map((s) => (typeof s === 'string' ? s : str(obj(s)?.text) || ''))
    .filter(Boolean)
    .join('\n\n')
}

// A tool output: text, or { output | content, success }, or that as JSON text.
function codexOutput(output) {
  let v = output
  if (typeof v === 'string' && v.startsWith('{')) {
    try {
      v = JSON.parse(v)
    } catch {
      return { text: output, isError: false }
    }
  }
  const o = obj(v)
  if (!o) return { text: resultText(v), isError: false }
  const exit = obj(o.metadata)?.exit_code
  const isError = o.success === false || o.is_error === true || (Number.isInteger(exit) && exit !== 0)
  return { text: resultText(o.output ?? o.content ?? o), isError }
}

export function codexHistoryEvents(lines, threadId, limits = HISTORY_LIMITS) {
  const me = String(threadId || '').toLowerCase()
  const records = []
  for (const line of lines) {
    const r = parse(line)
    if (!r) continue
    const p = obj(r.payload)
    // Another thread's line (a sub-agent's): not this conversation.
    const other = p && [p.thread_id, p.threadId, p.sender_thread_id].find((v) => typeof v === 'string' && v)
    if (other && other.toLowerCase() !== me) continue
    records.push(r)
  }
  // Which lines carry the visible messages: the completed items (newest
  // rollouts), else the user_message / agent_message events, else (the
  // oldest) the response items themselves.
  const completed = (r) => r.type === 'event_msg' && obj(r.payload)?.type === 'item_completed'
  const mode = records.some((r) => completed(r) && /^(UserMessage|AgentMessage|user_message|agent_message)$/.test(String(obj(r.payload.item)?.type)))
    ? 'completed'
    : records.some((r) => r.type === 'event_msg' && ['user_message', 'agent_message'].includes(obj(r.payload)?.type))
      ? 'events'
      : 'response'
  const b = createBuilder(limits)
  const responseItem = (p, ts) => {
    const type = p.type
    if (type === 'message') {
      if (mode !== 'response') return
      const { text: body, attachments } = codexContent(p.content)
      if (p.role === 'user') b.user(str(p.id) || b.nextId('u'), body, ts, attachments)
      else if (p.role === 'assistant' && body.trim()) b.message('assistant', str(p.id) || b.nextId('a'), body, ts, '\n\n')
      return
    }
    if (type === 'reasoning') {
      const body = str(p.text) || codexSummary(p.summary)
      if (body) b.message('thinking', str(p.id) || b.nextId('r'), body, ts, '\n\n')
      return
    }
    if (type === 'function_call' || type === 'custom_tool_call' || type === 'local_shell_call') {
      const id = str(p.call_id) || str(p.id) || b.nextId('t')
      b.tool(id, str(p.name) || (type === 'local_shell_call' ? 'shell' : 'tool'), p.arguments ?? p.input ?? p.action ?? null, ts) // i18n-ignore tool name
      return
    }
    if (type === 'function_call_output' || type === 'custom_tool_call_output') {
      const id = str(p.call_id) || str(p.id)
      if (!id) return
      const out = codexOutput(p.output)
      b.toolResult(id, out.text, out.isError, ts)
    }
  }
  for (const r of records) {
    const ts = r.timestamp
    const p = obj(r.payload)
    if (!p) {
      // The oldest rollouts: response items without an envelope.
      if (typeof r.type === 'string') responseItem(r, ts)
      continue
    }
    if (r.type === 'response_item') {
      responseItem(p, ts)
      continue
    }
    if (r.type !== 'event_msg') continue
    switch (p.type) {
      case 'task_complete':
        b.endTurn('completed', ts)
        break
      case 'turn_aborted':
        b.endTurn('interrupted', ts)
        break
      case 'user_message':
        if (mode === 'events' && !CODEX_CONTEXT.test(str(p.message) || '')) {
          const attachments = [
            ...(Array.isArray(p.images) ? p.images : []).map((u) => imageFromUrl(typeof u === 'string' ? u : str(obj(u)?.url))),
            ...(Array.isArray(p.local_images) ? p.local_images : []).map((f) => imageFromPath(typeof f === 'string' ? f : str(obj(f)?.path)))
          ]
          b.user(b.nextId('u'), str(p.message) || '', ts, attachments)
        }
        break
      case 'agent_message':
        if (mode === 'events' && str(p.message)) b.message('assistant', b.nextId('a'), p.message, ts, '\n\n')
        break
      case 'item_completed': {
        if (mode !== 'completed') break
        const item = obj(p.item)
        if (!item) break
        const { text: body, attachments } = codexContent(item.content)
        if (item.type === 'UserMessage' || item.type === 'user_message') b.user(str(item.id) || b.nextId('u'), body, ts, attachments)
        else if ((item.type === 'AgentMessage' || item.type === 'agent_message') && body.trim()) b.message('assistant', str(item.id) || b.nextId('a'), body, ts, '\n\n')
        break
      }
      default:
        break
    }
  }
  return b.finish()
}

// The folder a chat's agent keeps its conversations in, from the variables
// it runs with: Codex: its CODEX_HOME when it is the system one or a managed
// account's (inside Tessel's codex-accounts folder); Claude: the system Claude
// folder only (Tessel's Claude accounts swap the sign-in inside it). Anything
// else (a folder named by some other setting): null, nothing is read.
// ---- OpenCode -----------------------------------------------------------------

// OpenCode keeps its conversations in its own database: a chat reads them
// from its running server (GET /session/:id/message, opencodeChat.history),
// never from a file. messages: [{ info, parts }] of the ROOT session only (a
// sub-agent's messages live in its child session, never listed here).
// Synthetic parts (OpenCode's own notes to the model) are not what anyone
// typed or read: skipped. A message that failed with an abort ends its turn
// as interrupted; another error as failed.
// A file part: { mime, filename, url (a data: or file: URL), source: { path } }.
function opencodeFile(p) {
  const url = str(p.url)
  const path = localPath(url) || localPath(str(obj(p.source)?.path))
  const name = str(p.filename) || undefined
  if (typeof p.mime === 'string' && p.mime.startsWith('image/')) {
    if (url && /^data:/i.test(url)) return imageFromUrl(url, name)
    return path ? imageFromPath(path, name) : imageFromUrl(null, name)
  }
  return fileCandidate({ name, mediaType: p.mime, ...(url && /^data:/i.test(url) ? { dataUrl: url } : {}), ...(path ? { path } : {}) })
}

// limits.attachments: the caller resolves the events it keeps
// (resolveHistoryAttachments) once it has cut them to a page.
export function opencodeHistoryEvents(messages, limits = HISTORY_LIMITS) {
  const b = createBuilder(limits)
  for (const m of Array.isArray(messages) ? messages : []) {
    const info = obj(obj(m)?.info)
    if (!info || !str(info.id)) continue
    const parts = Array.isArray(m.parts) ? m.parts.map(obj).filter(Boolean) : []
    const ts = obj(info.time)?.created
    if (info.role === 'user') {
      const typed = parts.filter((p) => p.type === 'text' && str(p.text) && p.synthetic !== true).map((p) => p.text)
      const attachments = parts.filter((p) => p.type === 'file').map(opencodeFile)
      b.user(info.id, typed.join('\n'), ts, attachments)
      continue
    }
    if (info.role !== 'assistant') continue
    for (const p of parts) {
      if (p.synthetic === true) continue
      const pts = obj(p.time)?.start ?? ts
      if (p.type === 'text' && str(p.text)) b.message('assistant', info.id, p.text, pts, '\n\n')
      else if (p.type === 'reasoning' && str(p.text)) b.message('thinking', info.id, p.text, pts, '\n')
      else if (p.type === 'tool' && str(p.callID)) {
        const st = obj(p.state) || {}
        if (st.status === 'pending') continue
        b.tool(p.callID, opencodeToolName(p.tool), opencodeToolInput(p.tool, obj(st.input) || {}), obj(st.time)?.start ?? pts)
        if (st.status === 'completed' || st.status === 'error') {
          const exit = obj(st.metadata)?.exit
          b.toolResult(p.callID, st.status === 'error' ? str(st.error) || '' : st.output ?? '', st.status === 'error' || (Number.isInteger(exit) && exit !== 0), obj(st.time)?.end ?? pts)
        }
      }
    }
    const error = obj(info.error)
    if (error && obj(info.time)?.completed) b.endTurn(error.name === 'MessageAbortedError' ? 'interrupted' : 'failed', info.time.completed)
  }
  return b.finish()
}

export function transcriptHomeFor(agent, env, { systemClaude, systemCodex, codexAccountsBase } = {}) {
  const get = (name) => {
    const hit = Object.entries(env || {}).find(([k]) => k.toUpperCase() === name)
    return hit && typeof hit[1] === 'string' && hit[1] ? hit[1] : null
  }
  if (agent === 'codex') {
    if (!systemCodex) return null
    const home = get('CODEX_HOME') || systemCodex
    return allowedCodexHome(home, { systemHome: systemCodex, accountsBase: codexAccountsBase }) ? home : null
  }
  if (agent !== 'claude' || !systemClaude || !isAbsolute(systemClaude)) return null
  const dir = get('CLAUDE_CONFIG_DIR') || systemClaude
  if (!isAbsolute(dir)) return null
  const same = process.platform === 'win32' ? resolve(dir).toLowerCase() === resolve(systemClaude).toLowerCase() : resolve(dir) === resolve(systemClaude)
  return same ? systemClaude : null
}

// -> { ok: true, events, truncated, file } | { ok: false, code: 'invalid' | 'missing' | 'empty' }
export function readTranscriptHistory({ agent, sessionId, home, limits = HISTORY_LIMITS, now = Date.now() } = {}) {
  if ((agent !== 'claude' && agent !== 'codex') || !validHistoryId(sessionId)) return { ok: false, code: 'invalid' }
  const file = findTranscript(agent, sessionId, home, now)
  if (!file) return { ok: false, code: 'missing' }
  const read = readLastLines(file, limits.bytes)
  if (!read) return { ok: false, code: 'missing' }
  const caps = { ...limits, attachments: limits.attachments ?? ATTACHMENT_LIMITS }
  let events = agent === 'codex' ? codexHistoryEvents(read.lines, sessionId, caps) : claudeHistoryEvents(read.lines, caps)
  let truncated = read.cut
  if (events.length > limits.events) {
    events = events.slice(-limits.events)
    truncated = true
  }
  if (!events.length) return { ok: false, code: 'empty' }
  if (caps.attachments) resolveHistoryAttachments(events, caps.attachments)
  return { ok: true, events, truncated, file }
}

// ---- Older pages ----------------------------------------------------------------
// Going back in a long conversation: the chat's journal holds the most recent
// part; older parts are read again from the agent's transcript, a page at a
// time, never written to the journal. A page is the complete lines in at most
// OLDER_LIMITS.bytes before a byte offset (the cursor). The first page ends
// where the lines reach the time of the journal's first event: found by
// halving the file (a dozen small reads), never by reading it whole (a
// transcript can be hundreds of MB).

export const OLDER_LIMITS = { bytes: 1024 * 1024, probe: 256 * 1024, maxLine: 32 * 1024 * 1024, text: HISTORY_LIMITS.text, attachments: ATTACHMENT_LIMITS }

function readBytes(fd, start, length) {
  const buf = Buffer.alloc(Math.max(0, length))
  let got = 0
  while (got < buf.length) {
    const n = fs.readSync(fd, buf, got, buf.length - got, start + got)
    if (!n) break
    got += n
  }
  return buf.subarray(0, got)
}

// The first complete line at or after `from` that has a time: { start, end,
// time } (byte offsets), or null when there is none before `limit`.
// atLineStart: `from` is where a line starts (else the line it falls in is skipped).
function timedLineAfter(fd, from, limit, limits, atLineStart = from === 0) {
  const stop = Math.min(limit, from + limits.maxLine)
  let buf = Buffer.alloc(0)
  let pos = from
  let lineStart = atLineStart ? 0 : -1 // in buf
  let scan = 0
  while (pos < stop) {
    const chunk = readBytes(fd, pos, Math.min(limits.probe, stop - pos))
    if (!chunk.length) break
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk
    pos += chunk.length
    for (;;) {
      const nl = buf.indexOf(10, scan)
      if (nl < 0) {
        scan = buf.length
        break
      }
      if (lineStart >= 0) {
        const r = parse(buf.subarray(lineStart, nl).toString('utf8'))
        const time = r ? timeOf(r.timestamp) : null
        if (time != null) return { start: from + lineStart, end: from + nl + 1, time }
      }
      lineStart = nl + 1
      scan = nl + 1
    }
  }
  return null
}

// The byte offset of the first line whose time is at or after `target`
// (the file's size when every line is older).
export function offsetAtTime(file, target, limits = OLDER_LIMITS) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
  } catch {
    return null
  }
  try {
    const size = fs.fstatSync(fd).size
    let lo = 0 // a line start whose line is older than the target (or 0)
    let hi = size
    for (let guard = 0; hi - lo > limits.probe && guard < 64; guard++) {
      const mid = lo + Math.floor((hi - lo) / 2)
      const line = timedLineAfter(fd, mid, hi, limits)
      if (!line || line.time >= target) hi = mid
      else lo = line.end
    }
    // The last stretch, line by line.
    let from = lo
    for (let guard = 0; guard < 100000; guard++) {
      const line = timedLineAfter(fd, from, size, limits, true)
      if (!line) return size
      if (line.time >= target) return line.start
      from = line.end
      if (from === line.start) return size
    }
    return size
  } catch {
    return null
  } finally {
    fs.closeSync(fd)
  }
}

// -> { ok: true, events, cursor, done } | { ok: false, code }
// cursor: null (the start of the file was reached) or the offset the next
// page ends at. before: a cursor from an earlier page, or null with beforeAt
// (ms): the time of the oldest event the chat already shows.
export function readOlderHistory({ agent, sessionId, home, before = null, beforeAt = null, limits = OLDER_LIMITS, now = Date.now() } = {}) {
  if ((agent !== 'claude' && agent !== 'codex') || !validHistoryId(sessionId)) return { ok: false, code: 'invalid' }
  const file = findTranscript(agent, sessionId, home, now)
  if (!file) return { ok: false, code: 'missing' }
  let end = null
  if (before != null) {
    if (!Number.isSafeInteger(before) || before < 0) return { ok: false, code: 'invalid' }
    end = before
  } else {
    if (!Number.isFinite(beforeAt)) return { ok: true, events: [], cursor: null, done: true }
    end = offsetAtTime(file, beforeAt, limits)
    if (end == null) return { ok: false, code: 'missing' }
  }
  let fd
  try {
    fd = fs.openSync(file, 'r')
  } catch {
    return { ok: false, code: 'missing' }
  }
  try {
    const size = fs.fstatSync(fd).size
    end = Math.min(end, size)
    if (end <= 0) return { ok: true, events: [], cursor: null, done: true }
    // The window grows (up to maxLine) until it holds one whole line.
    let span = limits.bytes
    let start = 0
    let text = ''
    for (;;) {
      start = Math.max(0, end - span)
      const buf = readBytes(fd, start, end - start)
      let from = 0
      if (start > 0) {
        const nl = buf.indexOf(10)
        if (nl < 0 || nl + 1 >= buf.length) {
          if (span >= limits.maxLine) return { ok: true, events: [], cursor: start, done: false } // one giant line: passed over
          span = Math.min(limits.maxLine, span * 4)
          continue
        }
        from = nl + 1
      }
      start += from
      text = buf.subarray(from).toString('utf8')
      break
    }
    const lines = text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l)).filter(Boolean)
    const tagged = { ...HISTORY_LIMITS, text: limits.text, attachments: limits.attachments ?? ATTACHMENT_LIMITS, idTag: `p${start}-` } // i18n-ignore id
    const events = agent === 'codex' ? codexHistoryEvents(lines, sessionId, tagged) : claudeHistoryEvents(lines, tagged)
    if (tagged.attachments) resolveHistoryAttachments(events, tagged.attachments)
    return { ok: true, events, cursor: start > 0 ? start : null, done: start <= 0 }
  } catch {
    return { ok: false, code: 'missing' }
  } finally {
    fs.closeSync(fd)
  }
}
