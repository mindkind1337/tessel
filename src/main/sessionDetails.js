// One past conversation for the Agent Session History panel
// (SessionHistoryPanel.vue), from the agent's own transcript: its file, its
// first prompt, its latest turns and, when the file is small enough to be
// read whole, its message count. Then that file shown in the file manager,
// and the conversation deleted (to the Recycle Bin, never for good).
// The list itself is agentSessions.js; only the agents whose transcript
// Tessel reads line by line (CONTENT_AGENTS, the ones session search
// indexes) have details, a log and a deletion. Read-only otherwise, and
// only files inside the agent's own folder (after links).
// After Orca's src/main/ai-vault (session-scanner-first-prompt.ts,
// session-delete-target.ts, session-delete.ts), MIT, Copyright (c) 2026
// Lovecast Inc.
import fs from 'fs'
import os from 'os'
import { basename, dirname, join } from 'path'
import { claudeTranscriptIn, claudeTurnFromText, codexModelFromText, codexRolloutIn } from './agentModel'
import { opencodeDbFile, opencodeSessionModel, piModelFromWire } from './agentModelSources'
import { isUuid, qoderDir, qoderTranscriptIn } from './agentSessions'
import { insideDir, ompSessions, ompSessionsDir, piSessions, piSessionsDir, plainId, sessionDirs } from './agentSessionSources'
import { museModelFromText, museSessionLog } from './museSessions'
import { HISTORY_LIMITS, claudeHistoryEvents, codexHistoryEvents, readLastLines, resolveHistoryAttachments } from './chat/transcriptHistory'
import { hasPendingAttachments } from './chat/historyAttachments'
import { GROK_SESSION_FILES, grokModelTimeline } from './chat/transcriptView'
import { readHead, readRows } from './fileRead'
import { rowsFromLines } from './sessionSearch/indexer'

export const CONTENT_AGENTS = ['claude', 'openclaude', 'codex', 'grok', 'pi', 'omp', 'qoder', 'muse']
// Deleted whole: a Claude Code transcript with its <id>/ sidecar folder (the
// sub-agents), Grok's session folder, a Pi or OMP file. Codex is left out
// (its session_index.jsonl would keep naming the file), as are the agents
// whose history is a database row or a registry entry.
export const DELETABLE_AGENTS = ['claude', 'openclaude', 'grok', 'pi', 'omp']
export const HEAD_BYTES = 256 * 1024
const TAIL_BYTES = 256 * 1024
const PROMPT_MAX = 20000
const TURN_MAX = 2000
const LATEST_TURNS = 3

const clip = (s, max) => (String(s || '').length > max ? `${String(s).slice(0, max - 1)}…` : String(s || ''))

function entries(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}
function statOf(p) {
  try {
    return fs.lstatSync(p)
  } catch {
    return null
  }
}

// A Codex rollout older than the days codexRolloutIn looks at: the whole
// sessions tree (year / month / day), by the id at the end of the name.
function codexRolloutAnywhere(root, id) {
  const want = `${id}.jsonl`
  const walk = (dir, depth) => {
    for (const e of entries(dir)) {
      if (e.isSymbolicLink()) continue
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (depth < 3) {
          const hit = walk(full, depth + 1)
          if (hit) return hit
        }
      } else if (e.isFile() && e.name.startsWith('rollout-') && e.name.toLowerCase().endsWith(want)) return full
    }
    return null
  }
  return walk(root, 0)
}

// <grok sessions>/<encoded folder>/<id>/updates.jsonl (its timed update
// stream), else an older session's chat_history.jsonl beside it.
function grokChatFile(root, id) {
  for (const group of entries(root)) {
    if (!group.isDirectory() || group.isSymbolicLink()) continue
    for (const name of GROK_SESSION_FILES) {
      const file = join(root, group.name, id, name)
      if (statOf(file)) return file
    }
  }
  return null
}

// The transcript of a conversation: { file, root, size } (root: the agent
// folder it must stay inside), or null. roots: { claude, codex }, an
// account's folders (the others are under home).
export function findSessionFile({ agent, id } = {}, home = os.homedir(), roots = {}) {
  if (!plainId(id) || !CONTENT_AGENTS.includes(agent)) return null
  let root = null
  let file = null
  if (agent === 'claude' || agent === 'openclaude') {
    const dir = agent === 'claude' ? roots.claude || join(home, '.claude') : join(home, '.openclaude')
    root = join(dir, 'projects')
    file = isUuid(id) ? claudeTranscriptIn(dir, id) : null
  } else if (agent === 'qoder') {
    root = join(qoderDir(home), 'projects')
    file = qoderTranscriptIn(qoderDir(home), id)
  } else if (agent === 'codex') {
    const dir = roots.codex || join(home, '.codex')
    root = join(dir, 'sessions')
    file = isUuid(id) ? codexRolloutIn(dir, id.toLowerCase()) || codexRolloutAnywhere(root, id.toLowerCase()) : null
  } else if (agent === 'grok') {
    root = sessionDirs(home).grok
    file = grokChatFile(root, id)
  } else if (agent === 'muse') {
    // Muse Code: by its id's day (museSessions.js).
    root = sessionDirs(home).muse
    file = museSessionLog(id, root)
  } else {
    root = agent === 'pi' ? piSessionsDir(home) : ompSessionsDir(home)
    let rows = []
    try {
      rows = agent === 'pi' ? piSessions(home) : ompSessions(home)
    } catch {
      rows = []
    }
    const hit = rows.find((s) => s.id === id)
    file = hit ? hit.file : null
  }
  if (!file || !insideDir(root, file)) return null
  const st = statOf(file)
  if (!st || !st.isFile()) return null
  return { file, root, size: st.size }
}

const lines = (text) =>
  String(text)
    .split('\n')
    .map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
    .filter(Boolean)
const spoken = (r) => r.role === 'user' || r.role === 'assistant'

// -> { ok: true, file, size, firstPrompt, turns: [{ role, text, at }],
//      messageCount (null when the file was not read whole), model?, effort? }
//    | { ok: false }
export function sessionDetails(q = {}, home = os.homedir(), roots = {}) {
  if (q.agent === 'opencode') return opencodeDetails(q.id, opencodeDbFile(home))
  const found = findSessionFile(q, home, roots)
  if (!found) return { ok: false }
  const { file, size } = found
  const whole = size <= HEAD_BYTES
  const head = lines(readHead(file, HEAD_BYTES))
  let tailLines = null
  if (!whole) {
    const tail = readLastLines(file, TAIL_BYTES)
    tailLines = tail ? tail.lines : []
  }
  const images = latestImages(q.agent, q.id, whole ? head : tailLines)
  return { ok: true, file, size, ...detailsFromLines(q.agent, q.id, head, tailLines, whole), ...(images.length ? { images } : {}) }
}

// An OpenCode conversation (its database, read-only: no file, no log): its
// first prompt (its first message of yours), its latest turns (the text of
// its newest messages, a prompt's own text, an answer's), its message count
// and the model it ran with last. -> as sessionDetails | { ok: false }
const OPENCODE_SESSION = /^ses_[A-Za-z0-9]{8,60}$/
export function opencodeDetails(id, db, rows = readRows) {
  if (typeof id !== 'string' || !OPENCODE_SESSION.test(id) || typeof db !== 'string') return { ok: false }
  const head = rows(db, 'SELECT s.id, (SELECT count(*) FROM message m WHERE m.session_id = s.id) AS n FROM session s WHERE s.id = ?', [id])[0]
  if (!head) return { ok: false }
  const textOf = (mid) =>
    rows(db, "SELECT json_extract(data, '$.text') AS text FROM part WHERE message_id = ? AND json_extract(data, '$.type') = 'text' AND COALESCE(json_extract(data, '$.synthetic'), 0) = 0 ORDER BY id", [mid])
      .map((r) => (typeof r.text === 'string' ? r.text : ''))
      .filter(Boolean)
      .join('\n')
  const first = rows(db, "SELECT id FROM message WHERE session_id = ? AND json_extract(data, '$.role') = 'user' ORDER BY time_created ASC, id ASC LIMIT 8", [id]).map((r) => textOf(r.id)).find(Boolean) || ''
  const latest = rows(db, "SELECT id, time_created, data FROM message WHERE session_id = ? AND json_extract(data, '$.role') IN ('user', 'assistant') ORDER BY time_created DESC, id DESC LIMIT 12", [id])
  const turns = []
  for (const m of latest) {
    if (turns.length >= LATEST_TURNS) break
    const text = textOf(m.id)
    if (!text) continue
    let role = 'assistant'
    try {
      role = JSON.parse(m.data).role === 'user' ? 'user' : 'assistant'
    } catch {
      role = 'assistant'
    }
    turns.unshift({ role, text: clip(text, TURN_MAX), at: Number.isFinite(m.time_created) ? m.time_created : null })
  }
  const used = opencodeSessionModel(null, latest)
  return {
    ok: true,
    file: null,
    firstPrompt: clip(first, PROMPT_MAX),
    turns,
    messageCount: Number.isSafeInteger(head.n) ? head.n : null,
    ...(used ? { model: used.model, ...(used.effort ? { effort: used.effort } : {}) } : {})
  }
}

// Its latest images (a prompt's, a tool's: a screenshot, an image file read),
// from the lines read for its latest turns, as the chat view decodes them
// (historyAttachments.js: png, jpeg, gif, webp by their bytes, a local file
// only while it is still there): [{ key, name, mime, bytes, source,
// dataUrl, at }], oldest first, DETAILS_IMAGES.pageImages at most. Only for
// Claude Code (and its forks) and Codex, whose transcripts keep images
// (transcriptHistory.js reads them as the chat view does); this computer's files
// only (a host's details never come here). Never a Live Share guest's
// (shareHistory.js copies the text fields only).
export const DETAILS_IMAGES = { images: 4, imageBytes: 2 * 1024 * 1024, pageImages: 6, pageBytes: 3 * 1024 * 1024, files: 0, name: 120 }
const IMAGE_AGENTS = ['claude', 'openclaude', 'codex']
export function latestImages(agent, id, lines, caps = DETAILS_IMAGES) {
  if (!IMAGE_AGENTS.includes(agent) || !Array.isArray(lines) || !lines.length) return []
  try {
    const limits = { ...HISTORY_LIMITS, attachments: caps }
    const events = agent === 'codex' ? codexHistoryEvents(lines, id, limits) : claudeHistoryEvents(lines, limits)
    // Only the newest entries that held images are decoded.
    const noted = events.filter(hasPendingAttachments).slice(-caps.pageImages)
    resolveHistoryAttachments(noted, caps)
    const out = []
    for (const ev of noted)
      for (const img of Array.isArray(ev.images) ? ev.images : [])
        if (img.key && typeof img.dataUrl === 'string')
          out.push({ key: img.key, name: img.name, mime: img.mime, bytes: img.bytes, source: img.source, dataUrl: img.dataUrl, ...(Number.isFinite(ev.at) ? { at: ev.at } : {}) })
    return out.slice(-caps.pageImages)
  } catch {
    return []
  }
}

// The details of a conversation from its first lines (head: complete lines
// read from its start; its last one is dropped when the file goes on) and,
// when it was not read whole, its last lines. Also for a file read on an SSH
// host (chat/remoteTranscripts.js remoteSessionDetails).
// -> { firstPrompt, turns, messageCount, model?, effort? }
export function detailsFromLines(agent, id, headLines, tailLines, whole) {
  const head = [...(Array.isArray(headLines) ? headLines : [])]
  // The last line of a window is cut (or still being written).
  if (!whole) head.pop()
  const headRows = safeRows(agent, head, id)
  const first = headRows.find((r) => r.role === 'user')
  const tailRows = whole ? headRows : safeRows(agent, Array.isArray(tailLines) ? tailLines : [], id)
  const turns = tailRows
    .filter(spoken)
    .slice(-LATEST_TURNS)
    .map((r) => ({ role: r.role, text: clip(r.text, TURN_MAX), at: Number.isFinite(r.ts) ? r.ts : null }))
  // The model it ran with last (its end, else its start), and its effort.
  const used = latestModel(agent, whole ? head : Array.isArray(tailLines) ? tailLines : [], whole ? [] : head)
  return {
    firstPrompt: first ? clip(first.text, PROMPT_MAX) : '',
    turns,
    messageCount: whole ? headRows.filter(spoken).length : null,
    ...(used ? { model: used.model, ...(used.effort ? { effort: used.effort } : {}) } : {})
  }
}

// The model a conversation ran with last, as the pane header reads it
// (agentModel.js): Claude Code's (and its forks') latest answer, Codex's latest
// turn, Muse's log, Pi's and OMP's model changes and answers, the model of
// Grok Build's latest prompt. -> { model, effort } | null
const MODEL_TEXT = { claude: claudeTurnFromText, openclaude: claudeTurnFromText, qoder: claudeTurnFromText, codex: codexModelFromText, muse: museModelFromText }
export function latestModel(agent, lines, headLines = []) {
  try {
    if (agent === 'pi' || agent === 'omp') {
      const m = piModelFromWire(lines.join('\n'), headLines.join('\n'))
      return m ? { model: m.model, effort: m.effort || null } : null
    }
    if (agent === 'grok') {
      const m = grokModelTimeline(lines).at(-1) || grokModelTimeline(headLines).at(-1)
      return m ? { model: m.model.slice(0, 120), effort: m.effort || null } : null
    }
    const read = MODEL_TEXT[agent]
    if (!read) return null
    const m = read(lines.join('\n')) || (headLines.length ? read(headLines.join('\n')) : null)
    return m && typeof m.model === 'string' && m.model ? { model: m.model.slice(0, 120), effort: m.effort || null } : null
  } catch {
    return null
  }
}
export const DETAILS_TAIL_BYTES = TAIL_BYTES
export const splitLines = lines
function safeRows(agent, list, id) {
  try {
    return rowsFromLines(agent, list, id)
  } catch {
    return []
  }
}

// The file shown in the system's file manager. -> { ok } | { ok: false, error }
export function revealSessionFile(q = {}, home = os.homedir(), roots = {}, showItemInFolder) {
  const found = findSessionFile(q, home, roots)
  if (!found) return { ok: false, error: 'missing' }
  showItemInFolder(found.file)
  return { ok: true }
}

// What deleting a conversation removes, companions first, the transcript
// last (a failed companion leaves the row to retry from).
export function deleteTargets(agent, { file, root } = {}) {
  if (agent === 'grok') {
    // The session's own folder (summary.json beside the chat), never the
    // folder that holds every session.
    const dir = dirname(file)
    return dir !== root && dirname(dir) !== root && insideDir(root, dir) ? [dir] : []
  }
  if (agent === 'claude' || agent === 'openclaude') {
    const sidecar = join(dirname(file), basename(file, '.jsonl'))
    const st = statOf(sidecar)
    return st && st.isDirectory() && !st.isSymbolicLink() && insideDir(root, sidecar) ? [sidecar, file] : [file]
  }
  return [file]
}

// To the Recycle Bin (trashItem, given by the caller).
// -> { ok } | { ok: false, error: 'unsupported' | 'missing' | 'failed' }
export async function deleteSession(q = {}, home = os.homedir(), roots = {}, trashItem) {
  if (!DELETABLE_AGENTS.includes(q.agent)) return { ok: false, error: 'unsupported' }
  const found = findSessionFile(q, home, roots)
  if (!found) return { ok: false, error: 'missing' }
  const targets = deleteTargets(q.agent, found)
  if (!targets.length) return { ok: false, error: 'missing' }
  try {
    for (const p of targets) await trashItem(p)
  } catch {
    return { ok: false, error: 'failed' }
  }
  return { ok: true }
}
