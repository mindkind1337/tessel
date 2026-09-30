// What session search indexes, and how: the agents' own conversation files,
// found by the same readers as the conversation history, read only, inside
// each agent's folder, a slice at a time from where the last read stopped
// (never a whole file: a transcript can be hundreds of MB).
// After Orca's src/main/ai-vault-search (session-search-indexer.ts,
// session-search-file-cursor.ts, session-search-message-rows.ts), MIT,
// Copyright (c) 2026 Lovecast Inc.
import fs from 'fs'
import os from 'os'
import { basename, join } from 'path'
import { grokSessions, insideDir, ompSessions, ompSessionsDir, piSessions, piSessionsDir, sessionDirs } from '../agentSessionSources.js'
import { listSessions } from '../agentSessions.js'
import { claudeHistoryEvents, codexHistoryEvents } from '../chat/transcriptHistory.js'
import { grokViewEvents, ompViewEvents } from '../chat/transcriptView.js'

// Small on purpose: a slice runs on the main thread, between two timers.
export const SLICE_BYTES = 32 * 1024
const MAX_LINE_BYTES = 512 * 1024
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
// Whole messages are indexed (the history's own cut is for display).
const LIMITS = { text: 256 * 1024, events: Infinity, bytes: Infinity }
// Agents whose conversation text is indexed; the others by their title.
export const CONTENT_AGENTS = ['claude', 'openclaude', 'codex', 'grok', 'pi', 'omp']
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

// -> [{ agent, path, mtimeMs, size, id?, cwd?, title? }], newest first.
// since (ms): older files are left out (the retention).
export function listSources({ home = os.homedir(), since = 0, titles = true } = {}) {
  const out = []
  const add = (agent, root, file, extra = {}) => {
    const st = statFile(root, file)
    if (st && st.mtimeMs >= since) out.push({ agent, path: file, ...st, ...extra })
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

// The complete lines in at most `max` bytes from `offset`:
// { lines, next (the offset after them), done (nothing more to read now) }.
// A line longer than MAX_LINE_BYTES is passed over.
export function readSlice(file, offset, max = SLICE_BYTES) {
  const fd = fs.openSync(file, 'r')
  try {
    const size = fs.fstatSync(fd).size
    if (offset >= size) return { lines: [], next: size, done: true, size }
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
        if (offset + got >= size) return { lines: [], next: offset, done: true, size }
        if (span >= MAX_LINE_BYTES) {
          // Passed over: forward to the next line start, without keeping it.
          let pos = offset + got
          const chunk = Buffer.alloc(1024 * 1024)
          while (pos < size) {
            const n = fs.readSync(fd, chunk, 0, chunk.length, pos)
            if (!n) break
            const nl = chunk.subarray(0, n).indexOf(10)
            if (nl >= 0) return { lines: [], next: pos + nl + 1, done: pos + nl + 1 >= size, size }
            pos += n
          }
          return { lines: [], next: offset, done: true, size }
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
      return { lines, next, done: next >= size, size }
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
    const ts = Date.parse(r.timestamp || '')
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
    const slice = readSlice(file.path, file.byte_offset, sliceBytes)
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
