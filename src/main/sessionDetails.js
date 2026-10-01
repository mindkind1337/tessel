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
import { claudeTranscriptIn, codexRolloutIn } from './agentModel'
import { isUuid } from './agentSessions'
import { insideDir, ompSessions, ompSessionsDir, piSessions, piSessionsDir, plainId, sessionDirs } from './agentSessionSources'
import { readLastLines } from './chat/transcriptHistory'
import { readHead } from './fileRead'
import { rowsFromLines } from './sessionSearch/indexer'

export const CONTENT_AGENTS = ['claude', 'openclaude', 'codex', 'grok', 'pi', 'omp']
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

// <grok sessions>/<encoded folder>/<id>/chat_history.jsonl
function grokChatFile(root, id) {
  for (const group of entries(root)) {
    if (!group.isDirectory() || group.isSymbolicLink()) continue
    const file = join(root, group.name, id, 'chat_history.jsonl')
    if (statOf(file)) return file
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
  } else if (agent === 'codex') {
    const dir = roots.codex || join(home, '.codex')
    root = join(dir, 'sessions')
    file = isUuid(id) ? codexRolloutIn(dir, id.toLowerCase()) || codexRolloutAnywhere(root, id.toLowerCase()) : null
  } else if (agent === 'grok') {
    root = sessionDirs(home).grok
    file = grokChatFile(root, id)
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
//      messageCount (null when the file was not read whole) } | { ok: false }
export function sessionDetails(q = {}, home = os.homedir(), roots = {}) {
  const found = findSessionFile(q, home, roots)
  if (!found) return { ok: false }
  const { file, size } = found
  const whole = size <= HEAD_BYTES
  const head = lines(readHead(file, HEAD_BYTES))
  // The last line of a window is cut (or still being written).
  if (!whole) head.pop()
  const headRows = safeRows(q.agent, head, q.id)
  const first = headRows.find((r) => r.role === 'user')
  let tailRows = headRows
  if (!whole) {
    const tail = readLastLines(file, TAIL_BYTES)
    tailRows = tail ? safeRows(q.agent, tail.lines, q.id) : []
  }
  const turns = tailRows
    .filter(spoken)
    .slice(-LATEST_TURNS)
    .map((r) => ({ role: r.role, text: clip(r.text, TURN_MAX), at: Number.isFinite(r.ts) ? r.ts : null }))
  return {
    ok: true,
    file,
    size,
    firstPrompt: first ? clip(first.text, PROMPT_MAX) : '',
    turns,
    messageCount: whole ? headRows.filter(spoken).length : null
  }
}
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
