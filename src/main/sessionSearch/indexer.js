// What session search indexes, and how: the agents' own conversation files,
// found by the same readers as the conversation history, read only, inside
// each agent's folder, a slice at a time from where the last read stopped
// (never a whole file: a transcript can be hundreds of MB).
// After Orca's src/main/ai-vault-search (session-search-indexer.ts,
// session-search-file-cursor.ts, session-search-message-rows.ts), MIT,
// Copyright (c) 2026 Lovecast Inc.
import { createHash } from 'crypto'
import fs from 'fs'
import os from 'os'
import { basename, join } from 'path'
import { grokSessions, insideDir, ompSessions, ompSessionsDir, piSessions, piSessionsDir, sessionDirs } from '../agentSessionSources.js'
import { listSessions, qoderDir, qoderTextLine } from '../agentSessions.js'
import { claudeHistoryEvents, codexHistoryEvents } from '../chat/transcriptHistory.js'
import { grokViewEvents, ompViewEvents } from '../chat/transcriptView.js'

// Small on purpose: a slice is one step of the background work, between two timers.
export const SLICE_BYTES = 32 * 1024
const MAX_LINE_BYTES = 512 * 1024
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
// Whole messages are indexed (the history's own cut is for display).
const LIMITS = { text: 256 * 1024, events: Infinity, bytes: Infinity }
// Agents whose conversation text is indexed; the others by their title.
export const CONTENT_AGENTS = ['claude', 'openclaude', 'codex', 'grok', 'pi', 'omp', 'qoder']
const META = 'meta:' // a title-only session's key: meta:<agent>:<id>

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null)
const oneLine = (s, max = 160) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

function statFile(root, file) {
  try {
    const st = fs.lstatSync(file)
    if (!st.isFile() || !insideDir(root, file)) return null
    return { mtimeMs: st.mtimeMs, size: st.size }
  } catch {
    return null
  }
}
function dirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

// -> [{ agent, path, root, mtimeMs, size, id?, cwd?, title? }], newest first
// (root: the agent folder the file must stay inside).
// since (ms): older files are left out (the retention).
export function listSources({ home = os.homedir(), since = 0, titles = true } = {}) {
  const out = []
  const add = (agent, root, file, extra = {}) => {
    const st = statFile(root, file)
    if (st && st.mtimeMs >= since) out.push({ agent, path: file, root, ...st, ...extra })
  }
  // Claude Code and OpenClaude: <dir>/projects/<slug>/<uuid>.jsonl
  for (const [agent, dir] of [['claude', join(home, '.claude')], ['openclaude', join(home, '.openclaude')]]) {
    const root = join(dir, 'projects')
    for (const d of dirs(root)) {
      if (!d.isDirectory()) continue
      for (const f of dirs(join(root, d.name))) {
        const m = /^([0-9a-f-]{36})\.jsonl$/i.exec(f.name)
        if (m && f.isFile()) add(agent, root, join(root, d.name, f.name), { id: m[1] })
      }
    }
  }
  // Qoder CLI: the same format, <session>.jsonl under ~/.qoder/projects/<slug>/
  // (its id is the sessionId inside; sub-agents' folders are left out).
  const qoderRoot = join(qoderDir(home), 'projects')
  for (const d of dirs(qoderRoot)) {
    if (!d.isDirectory()) continue
    for (const f of dirs(join(qoderRoot, d.name))) {
      if (f.isFile() && f.name.endsWith('.jsonl')) add('qoder', qoderRoot, join(qoderRoot, d.name, f.name), { id: (UUID.exec(f.name) || [''])[0] })
    }
  }
  // Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl
  const codexRoot = join(home, '.codex', 'sessions')
  const walk = (dir, depth) => {
    for (const e of dirs(dir)) {
      const full = join(dir, e.name)
      if (e.isDirectory() && depth < 3) walk(full, depth + 1)
      else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) add('codex', codexRoot, full, { id: (UUID.exec(e.name) || [''])[0] })
    }
  }
  walk(codexRoot, 0)
  // Grok, Pi, OMP: from their own readers.
  const safe = (fn) => {
    try {
      return fn()
    } catch {
      return []
    }
  }
  const grokRoot = sessionDirs(home).grok
  for (const s of safe(() => grokSessions(home, { since }))) {
    for (const group of dirs(grokRoot)) {
      const file = join(grokRoot, group.name, s.id, 'chat_history.jsonl')
      if (group.isDirectory() && fs.existsSync(file)) {
        add('grok', grokRoot, file, { id: s.id, cwd: s.cwd, title: s.title })
        break
      }
    }
  }
  for (const s of safe(() => piSessions(home, { since }))) add('pi', piSessionsDir(home), s.file, { id: s.id, cwd: s.cwd, title: s.title })
  for (const s of safe(() => ompSessions(home, { since }))) add('omp', ompSessionsDir(home), s.file, { id: s.id, cwd: s.cwd, title: s.title })
  // The other agents: their title only (what the history list shows).
  if (titles) {
    for (const s of safe(() => listSessions({ limit: 200 }, home, { claude: null, codex: null }))) {
      if (CONTENT_AGENTS.includes(s.agent) || !s.id || !s.title || !(s.updated >= since)) continue
      out.push({ agent: s.agent, path: `${META}${s.agent}:${s.id}`, mtimeMs: s.updated, size: String(s.title).length, id: s.id, cwd: s.cwd || '', title: s.title })
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

export const isTitleOnly = (path) => String(path).startsWith(META)

// The fingerprint of a file's first bytes (null for a file shorter than
// them): a rewritten file of the same size or bigger is told by it.
export const HEAD_BYTES = 4096
export function headHash(file, fd = null) {
  const own = fd === null
  if (own) fd = fs.openSync(file, 'r')
  try {
    if (fs.fstatSync(fd).size < HEAD_BYTES) return null
    const buf = Buffer.alloc(HEAD_BYTES)
    let got = 0
    while (got < HEAD_BYTES) {
      const n = fs.readSync(fd, buf, got, HEAD_BYTES - got, got)
      if (!n) break
      got += n
    }
    return createHash('sha1').update(buf.subarray(0, got)).digest('hex')
  } finally {
    if (own) fs.closeSync(fd)
  }
}

// An endless line is passed over this much per slice, and the file given up
// after this much of it without a line end.
export const SKIP_BYTES = 4 * 1024 * 1024
export const GIVE_UP_BYTES = 64 * 1024 * 1024

// The complete lines in at most `max` bytes from `offset`:
// { lines, next (the offset after them), done (nothing more to read now),
//   skipped (bytes of an endless line passed over by this call), head }.
// The file must be a plain file inside `root` (checked on the open handle,
// not just the path). A line longer than MAX_LINE_BYTES is passed over,
// SKIP_BYTES at a time.
export function readSlice(file, offset, max = SLICE_BYTES, { root = null } = {}) {
  const fd = fs.openSync(file, 'r')
  try {
    const st = fs.fstatSync(fd)
    if (!st.isFile() || (root && !insideDir(root, file))) throw new Error('not a session file') // i18n-ignore
    const size = st.size
    const head = offset === 0 ? headHash(file, fd) : null
    if (offset >= size) return { lines: [], next: size, done: true, size, skipped: 0, head }
    let span = max
    for (;;) {
      const length = Math.min(span, size - offset)
      const buf = Buffer.alloc(length)
      let got = 0
      while (got < length) {
        const n = fs.readSync(fd, buf, got, length - got, offset + got)
        if (!n) break
        got += n
      }
      const data = buf.subarray(0, got)
      const end = data.lastIndexOf(10)
      if (end < 0) {
        // No whole line in the window: a last line still being written, or one too long.
        if (offset + got >= size) return { lines: [], next: offset, done: true, size, skipped: 0, head }
        if (span >= MAX_LINE_BYTES) {
          // Passed over, a bounded run per call: forward to its end if it is
          // within reach, else as far as the budget goes (the next call goes on).
          let pos = offset + got
          const stop = Math.min(size, offset + SKIP_BYTES)
          const chunk = Buffer.alloc(1024 * 1024)
          while (pos < stop) {
            const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, stop - pos), pos)
            if (!n) break
            const nl = chunk.subarray(0, n).indexOf(10)
            if (nl >= 0) return { lines: [], next: pos + nl + 1, done: pos + nl + 1 >= size, size, skipped: 0, head }
            pos += n
          }
          return { lines: [], next: pos, done: false, size, skipped: pos - offset, head }
        }
        span = Math.min(MAX_LINE_BYTES, span * 4)
        continue
      }
      const lines = data
        .subarray(0, end)
        .toString('utf8')
        .split('\n')
        .map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
        .filter(Boolean)
      const next = offset + end + 1
      return { lines, next, done: next >= size, size, skipped: 0, head }
    }
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

// What a slice says about its session: { id?, cwd?, createdAt? }.
function sessionFacts(agent, lines) {
  const facts = {}
  for (const line of lines.slice(0, 40)) {
    const r = parse(line)
    if (!r) continue
    // Qoder's own records carry their time in ms, its messages an ISO date.
    const ts = typeof r.timestamp === 'number' ? r.timestamp : Date.parse(r.timestamp || '')
    if (facts.createdAt == null && Number.isFinite(ts)) facts.createdAt = ts
    if (agent === 'codex') {
      const p = obj(r.payload)
      if (r.type === 'session_meta' && p) {
        if (typeof p.id === 'string') facts.id = p.id
        if (typeof p.cwd === 'string') facts.cwd = p.cwd
      }
    } else if (agent === 'pi' || agent === 'omp') {
      if (r.type === 'session') {
        if (typeof r.id === 'string') facts.id = r.id
        if (typeof r.cwd === 'string') facts.cwd = r.cwd
      }
    } else if (agent === 'qoder') {
      if (typeof r.sessionId === 'string' && !facts.id) facts.id = r.sessionId
      if (typeof r.cwd === 'string' && !facts.cwd) facts.cwd = r.cwd
      // Its first record names the workspace before any message does.
      if (r.type === 'workspace-directories' && !facts.cwd && Array.isArray(r.directories) && typeof r.directories[0] === 'string') facts.cwd = r.directories[0]
    } else if (typeof r.cwd === 'string' && !facts.cwd) facts.cwd = r.cwd
    if (facts.cwd && facts.createdAt != null && (facts.id || agent === 'claude' || agent === 'openclaude')) break
  }
  return facts
}

// The lines of a slice as index rows: [{ role: 'user' | 'assistant' | 'tool', text, ts }].
export function rowsFromLines(agent, lines, sessionId) {
  let events = []
  try {
    if (agent === 'codex') events = codexHistoryEvents(lines, sessionId, LIMITS)
    else if (agent === 'grok') events = grokViewEvents(lines, LIMITS)
    else if (agent === 'pi' || agent === 'omp') events = ompViewEvents(lines, LIMITS)
    else if (agent === 'qoder') events = claudeHistoryEvents(lines.map(qoderTextLine), LIMITS)
    else events = claudeHistoryEvents(lines, LIMITS)
  } catch {
    events = []
  }
  const rows = []
  for (const e of events) {
    const ts = Number.isFinite(e.at) ? e.at : null
    if (e.type === 'user' && e.text) rows.push({ role: 'user', text: e.text, ts })
    else if (e.type === 'assistant' && e.text) rows.push({ role: 'assistant', text: e.text, ts })
    else if (e.type === 'tool' && e.name) rows.push({ role: 'tool', text: `${e.name} ${e.summary || ''}`.trim(), ts })
    else if (e.type === 'toolResult' && e.text) rows.push({ role: 'tool', text: e.text, ts })
  }
  return rows
}

// One slice of the next due file into the store. -> true when something was
// done (more may remain), false when nothing is due.
export function indexNext(store, { sliceBytes = SLICE_BYTES, sources = new Map() } = {}) {
  const file = store.nextDue()
  if (!file) return false
  const known = sources.get(file.path) || {}
  try {
    if (isTitleOnly(file.path)) {
      // Its title is all there is: one row, replaced when the title changes.
      store.transaction(() => {
        store.forgetFile(file.path)
        store.noteFile({ path: file.path, agent: file.agent, mtimeMs: file.mtime_ms, size: file.size_bytes })
        store.addSlice({
          file: file.path,
          agent: file.agent,
          rows: known.title ? [{ role: 'user', text: known.title, ts: file.mtime_ms }] : [],
          offset: file.size_bytes,
          done: true,
          session: { id: known.id || file.path.split(':').slice(2).join(':'), title: oneLine(known.title), cwd: known.cwd || '', createdAt: file.mtime_ms, updatedAt: file.mtime_ms }
        })
      })
      return true
    }
    // Only a file the scan listed inside an agent folder is read.
    if (!known.root) throw new Error('not listed') // i18n-ignore
    const slice = readSlice(file.path, file.byte_offset, sliceBytes, { root: known.root })
    if (slice.skipped) {
      // An endless line: passed over so far; given up past GIVE_UP_BYTES of it.
      const skipped = (file.skipped || 0) + slice.skipped
      if (skipped >= GIVE_UP_BYTES) store.fileGivenUp(file.path)
      else store.addSlice({ file: file.path, agent: file.agent, rows: [], offset: slice.next, done: false, skipped, head: slice.head, session: {} })
      return true
    }
    const facts = file.byte_offset === 0 ? sessionFacts(file.agent, slice.lines) : {}
    const id = facts.id || known.id || (UUID.exec(basename(file.path)) || [''])[0]
    const rows = rowsFromLines(file.agent, slice.lines, id)
    const firstPrompt = rows.find((r) => r.role === 'user')
    let last = null
    for (const r of rows) if (Number.isFinite(r.ts)) last = r.ts
    store.transaction(() => {
      const prior = store.sessionOf(file.path)
      store.addSlice({
        file: file.path,
        agent: file.agent,
        rows,
        offset: slice.next,
        done: slice.done,
        skipped: 0,
        head: slice.head,
        session: {
          id,
          title: (prior && prior.title) || oneLine(known.title) || (firstPrompt ? oneLine(firstPrompt.text) : ''),
          cwd: facts.cwd || known.cwd || '',
          createdAt: facts.createdAt ?? null,
          updatedAt: last ?? (slice.done ? file.mtime_ms : null) ?? (prior && prior.updated_at) ?? file.mtime_ms
        }
      })
    })
    return true
  } catch {
    store.fileFailed(file.path)
    return true
  }
}
