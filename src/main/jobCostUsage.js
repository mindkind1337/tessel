// The token usage events of one session file, for the job cost
// (jobCost.js): read with async fs, kept per file (path + size + change time)
// and read again only from where the last read stopped (the files grow at
// their end). Nothing else of the file is kept: no prompt, no output.
//
// Kinds of file:
//   claude   a Claude Code transcript (<home>/projects/<project>/<id>.jsonl, or
//            one of its sub-agents' <id>/subagents/*.jsonl): assistant lines'
//            message.usage. Claude Code writes a reply's usage several times
//            while it streams: lines with the same message id are one reply
//            (the largest counts kept), as claudeUsageReport.js does.
//   codex    a Codex rollout: its token_count events, turned into increments by
//            codexUsageReport.js (last_token_usage, else the difference of the
//            running totals; replays and forks skipped). Codex counts cached
//            input inside input_tokens: here input is the part NOT cached and
//            cacheRead the cached part (Codex writes no cache).
//   journal  a Tessel chat pane's journal (chats/<pane>/journal.jsonl): its
//            turnEnd events' usage, and the cost the agent itself reported
//            (OpenCode), for chat agents that keep no transcript we read.
//
// An event: { key, at (ms), model, provider, input, output, cacheRead,
// cacheWrite, cacheWrite1h?, reportedUsd? }; input never includes the cache
// reads or writes; cacheWrite1h is the part of cacheWrite Claude wrote for
// one hour (priced at its own rate).
//
// The incremental design (a cursor per file, the usage-only state, the
// fork-safe Codex keys) follows Orca's usage scanners (github.com/stablyai/orca,
// src/main/claude-usage and src/main/codex-usage, MIT, Copyright (c) 2026
// Lovecast Inc.).
import fsp from 'fs/promises'
import { parseClaudeLine } from './claudeUsageReport'
import { newCodexUsageState, consumeCodexUsageLine } from './codexUsageReport'

export const USAGE_KINDS = ['claude', 'codex', 'journal']
const READ_CHUNK = 1024 * 1024
const MAX_FILES = 300
const TS = /"timestamp"\s*:\s*"([^"]{10,40})"/
const n = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

function fresh(kind) {
  return { kind, size: 0, mtimeMs: 0, offset: 0, carry: null, byKey: new Map(), events: [], first: null, last: null, codex: null, model: null, provider: null, anon: 0, agent: null }
}

function noteTime(e, at) {
  if (!Number.isFinite(at) || at <= 0) return
  if (e.first === null || at < e.first) e.first = at
  if (e.last === null || at > e.last) e.last = at
}

// One line of a Claude transcript.
function claudeLine(e, line) {
  const ts = TS.exec(line)
  if (ts) noteTime(e, Date.parse(ts[1]))
  const t = parseClaudeLine(line)
  if (!t || !t.model || t.model === '<synthetic>') return
  // The message id alone: the same reply streamed again (or copied into a
  // resumed session's file) is the same spend.
  const key = t.key ? `c:${t.key.split(':')[0]}` : `c:anon:${e.anon++}`
  const had = e.byKey.get(key)
  if (had) {
    had.input = Math.max(had.input, t.input)
    had.output = Math.max(had.output, t.output)
    had.cacheRead = Math.max(had.cacheRead, t.cacheRead)
    had.cacheWrite = Math.max(had.cacheWrite, t.cacheWrite)
    had.cacheWrite1h = Math.max(had.cacheWrite1h, t.cacheWrite1h || 0)
    return
  }
  const ev = { key, at: t.time || e.last || 0, model: t.model, provider: 'anthropic', input: t.input, output: t.output, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite, cacheWrite1h: t.cacheWrite1h || 0 }
  e.byKey.set(key, ev)
  e.events.push(ev)
}

function codexLine(e, line, file) {
  const ts = TS.exec(line)
  if (ts) noteTime(e, Date.parse(ts[1]))
  if (!e.codex) e.codex = newCodexUsageState(file)
  const before = e.codex.events.length
  consumeCodexUsageLine(line, e.codex)
  for (const x of e.codex.events.slice(before)) {
    const cached = Math.min(n(x.cached), n(x.input))
    e.events.push({
      key: `x:${x.key}`,
      at: Date.parse(x.at) || 0,
      model: x.model && x.model !== 'unknown' ? x.model : null,
      provider: 'openai',
      input: n(x.input) - cached,
      output: n(x.output),
      cacheRead: cached,
      cacheWrite: 0
    })
  }
  // Only what is still needed to resume: the converted events are ours now.
  e.codex.events.length = 0
}

// A journal line: { seq, at, event }.
function journalLine(e, line) {
  if (line.indexOf('"init"') < 0 && line.indexOf('"turnEnd"') < 0) {
    const at = /"at"\s*:\s*(\d{12,14})/.exec(line)
    if (at) noteTime(e, Number(at[1]))
    return
  }
  let row
  try {
    row = JSON.parse(line)
  } catch {
    return
  }
  const ev = row && row.event
  noteTime(e, row && row.at)
  if (!ev || typeof ev !== 'object') return
  if (ev.type === 'init' && typeof ev.model === 'string' && ev.model) {
    e.model = ev.model
    return
  }
  if (ev.type !== 'turnEnd' || !ev.usage || typeof ev.usage !== 'object') return
  const u = ev.usage
  const cacheRead = n(u.cache_read_input_tokens ?? u.cached_input_tokens)
  // Codex app-server counts the cached input inside input_tokens.
  const input = e.agent === 'codex' ? Math.max(0, n(u.input_tokens) - cacheRead) : n(u.input_tokens)
  const full = e.model || null
  // OpenCode names its models provider/model.
  const slash = full && full.indexOf('/') > 0 ? full.indexOf('/') : -1
  e.events.push({
    key: `j:${row.seq ?? e.anon++}:${row.at ?? ''}`,
    at: Number(row.at) || e.last || 0,
    model: slash > 0 ? full.slice(slash + 1) : full,
    provider: slash > 0 ? full.slice(0, slash) : e.agent === 'codex' ? 'openai' : e.agent === 'claude' ? 'anthropic' : e.agent || null,
    input,
    output: n(u.output_tokens),
    cacheRead,
    cacheWrite: n(u.cache_creation_input_tokens),
    cacheWrite1h: Math.min(n(u.cache_creation_input_tokens), n(u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens)),
    ...(typeof ev.costUsd === 'number' && Number.isFinite(ev.costUsd) && ev.costUsd >= 0 ? { reportedUsd: ev.costUsd } : {})
  })
}

// Bytes just read at the end of what was read before: its complete lines
// go through the kind's reader; a line still being written waits (carry).
function consume(e, kind, data, file) {
  if (e.carry) data = Buffer.concat([e.carry, data])
  const cut = data.lastIndexOf(10)
  e.carry = cut < 0 ? data : data.subarray(cut + 1)
  if (e.carry.length > 64 * 1024 * 1024) e.carry = null // a runaway line: dropped
  if (cut < 0) return
  const text = data.subarray(0, cut).toString('utf8')
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    if (kind === 'claude') claudeLine(e, line)
    else if (kind === 'codex') codexLine(e, line, file)
    else journalLine(e, line)
  }
}

// cache.read(file, kind, budget, { agent }) -> { events, first, last, done }
//   budget: { bytes } shared by every file of one call; a file not read to
//   its end (done: false) goes on from there next time.
// cache.readRemote(key, kind, readWindow, budget, { minGapMs }) -> the same | null
//   a conversation file on an SSH host (Claude Code, Codex), read through
//   readWindow({ offset, cap }) -> { ok, size, mtimeMs, data } | { ok: false, missing? }
//   (remoteFs.js readAgentFile): only the bytes after what was read before,
//   at most READ_CHUNK a request; the host is asked at most once per
//   minGapMs per file (the figures kept meanwhile).
// fs: injectable for tests ({ stat, open }).
export function createUsageFileCache({ fs = fsp, maxFiles = MAX_FILES, now = Date.now } = {}) {
  const entries = new Map() // path -> entry (oldest used first)

  function remember(file, e) {
    entries.delete(file)
    entries.set(file, e)
    while (entries.size > maxFiles) entries.delete(entries.keys().next().value)
  }

  async function read(file, kind, budget = { bytes: Infinity }, { agent = null } = {}) {
    if (!USAGE_KINDS.includes(kind)) throw new Error('unknown usage file kind') // i18n-ignore programming error
    let st
    try {
      st = await fs.stat(file)
    } catch {
      entries.delete(file)
      return null
    }
    let e = entries.get(file)
    // A file that shrank, or another kind: read again from the start.
    if (!e || e.kind !== kind || st.size < e.offset) e = fresh(kind)
    if (agent) e.agent = agent
    remember(file, e)
    if (st.size === e.offset && st.mtimeMs === e.mtimeMs) return view(e, true)
    let fh = null
    try {
      fh = await fs.open(file, 'r')
      while (e.offset < st.size && budget.bytes > 0) {
        const len = Math.min(READ_CHUNK, st.size - e.offset, budget.bytes)
        const buf = Buffer.alloc(len)
        const { bytesRead } = await fh.read(buf, 0, len, e.offset)
        if (!bytesRead) break
        budget.bytes -= bytesRead
        e.offset += bytesRead
        // A line still being written stays for the next read.
        consume(e, kind, buf.subarray(0, bytesRead), file)
      }
    } catch {
      // Unreadable now: what was read so far stands; tried again next time.
    } finally {
      if (fh) await fh.close().catch(() => {})
    }
    const done = e.offset >= st.size
    if (done) {
      e.size = st.size
      e.mtimeMs = st.mtimeMs
    }
    return view(e, done)
  }

  function view(e, done) {
    return { events: e.events, first: e.first, last: e.last, done }
  }

  async function readRemote(key, kind, readWindow, budget = { bytes: Infinity }, { minGapMs = 5000 } = {}) {
    if (kind !== 'claude' && kind !== 'codex') throw new Error('unknown remote usage file kind') // i18n-ignore programming error
    let e = entries.get(key)
    if (e && e.kind !== kind) e = null
    // Asked a moment ago: the figures kept, no request to the host.
    if (e && e.checkedAt != null && now() - e.checkedAt < minGapMs) {
      remember(key, e)
      return view(e, e.offset >= e.size)
    }
    // One request at a time per file.
    if (e && e.pending) return e.pending
    if (!e) e = fresh(kind)
    remember(key, e)
    const entry = e
    entry.pending = (async () => {
      let restarted = false
      let readAny = entry.checkedAt != null
      try {
        while (budget.bytes > 0) {
          let r
          try {
            r = await readWindow({ offset: entry.offset, cap: Math.max(1, Math.min(READ_CHUNK, budget.bytes)) })
          } catch {
            r = null
          }
          if (!r || !r.ok || !Buffer.isBuffer(r.data) || !Number.isSafeInteger(r.size)) {
            if (r && r.missing) {
              if (entries.get(key) === entry) entries.delete(key)
              return null
            }
            // Not reachable now: what was read stands, asked again later.
            return readAny ? view(entry, false) : null
          }
          readAny = true
          // Shrank (replaced): read again from its start, once.
          if (r.size < entry.offset) {
            if (restarted) break
            restarted = true
            const again = fresh(kind)
            Object.assign(entry, again)
            continue
          }
          entry.size = r.size
          if (r.mtimeMs !== undefined) entry.mtimeMs = r.mtimeMs
          if (!r.data.length) break
          budget.bytes -= r.data.length
          entry.offset += r.data.length
          consume(entry, kind, r.data, key)
          if (entry.offset >= r.size) break
        }
        return view(entry, entry.offset >= entry.size)
      } finally {
        entry.checkedAt = now()
        entry.pending = null
      }
    })()
    return entry.pending
  }

  return { read, readRemote, size: () => entries.size, forget: (file) => entries.delete(file), clear: () => entries.clear() }
}
