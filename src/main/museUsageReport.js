// Muse Code's usage report, read from its own session logs on this computer
// (nothing is sent anywhere, no sign-in used): the tokens of each model call
// Muse recorded, by day, model, project and session, for Stats.
//
// <XDG_DATA_HOME or ~/.local/share>/muse/sessions/YYYY/MM/DD/<id>/session.jsonl
// (museSessions.js), and the logs of the sessions it starts for itself
// (sub-agents, its background observers) under subagent/<child id>/: they use
// the same subscription, so they count, under the session that started them.
// Each model call ends with a runtime.session record { event: { kind:
// 'model_completed', model, usage: { input_tokens, output_tokens,
// cached_tokens, cache_write_tokens, cache_read_tokens, reasoning_tokens } } }.
// Muse counts cached input inside input and reasoning inside output (as
// Muse Code 1.4.10 writes them: cached <= input on every call): they are taken
// out here, so the report carries OpenCode's buckets (input, output,
// reasoning, cacheRead, cacheWrite, each its own). Muse records no price (a
// subscription): the cost stays unknown, never guessed.
//
// Bounded and incremental like grokUsageReport.js: at most 4000 logs, newest
// first, read with fs.promises 1 MB at a time from where the last read
// stopped; only the lines that can be a model call, the session's metadata or
// a prompt are parsed.
import fsp from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import { usageDayFormatter, usageQueryRange, usageRootMatcher } from './usageReportFilters'
import { usageReportFromEvents } from './opencodeUsageReport'
import { scanGrokLines } from './grokUsageReport'
import { museModelId, musePromptOf, museRecords, museSessionsDir } from './museSessions'

const MAX_FILES = 4000
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const n = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
// eslint-disable-next-line no-control-regex
const folder = (v) => (typeof v === 'string' && v.length <= 4096 && !/[\x00-\x1f]/.test(v) && (/^[a-z]:[\\/]/i.test(v) || v.startsWith('/') || v.startsWith('\\\\')) ? v : null)

async function dirs(dir, re) {
  try {
    return (await fsp.readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory() && !e.isSymbolicLink() && re.test(e.name)).map((e) => e.name)
  } catch {
    return []
  }
}
async function logIn(dir) {
  const file = join(dir, 'session.jsonl')
  try {
    const st = await fsp.lstat(file)
    return st.isFile() ? { file, size: st.size, mtimeMs: st.mtimeMs } : null
  } catch {
    return null
  }
}

// The session logs, newest first: [{ id (the conversation's), file, size,
// mtimeMs, child }]; a child's log (one level of subagent/) counts as its
// parent's session.
export async function listMuseSessionLogs(root) {
  const out = []
  for (const y of await dirs(root, /^\d{4}$/))
    for (const m of await dirs(join(root, y), /^\d{2}$/))
      for (const d of await dirs(join(root, y, m), /^\d{2}$/))
        for (const id of await dirs(join(root, y, m, d), SESSION_ID)) {
          const dir = join(root, y, m, d, id)
          const main = await logIn(dir)
          if (main) out.push({ id, ...main, child: false })
          for (const c of await dirs(join(dir, 'subagent'), SESSION_ID)) {
            const log = await logIn(join(dir, 'subagent', c))
            if (log) out.push({ id, ...log, child: true })
          }
        }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_FILES)
}

// One model call's usage -> the report's buckets, or null.
export function museUsageBucket(u) {
  if (!object(u)) return null
  const input = n(u.input_tokens)
  const read = Math.min(input, n(u.cached_tokens) || n(u.cache_read_tokens))
  const output = n(u.output_tokens)
  const reasoning = Math.min(output, n(u.reasoning_tokens))
  const write = n(u.cache_write_tokens)
  if (!input && !output && !write) return null
  return { input: input - read, output: output - reasoning, reasoning, cacheRead: read, cacheWrite: write, cost: null }
}

// One log line -> { events, cwd, title } (what it adds). facts: { sessionId,
// cwd, title } so far for this log.
export function museUsageLine(line, facts) {
  const out = { events: [], cwd: null, title: null }
  if (typeof line !== 'string' || !(line.includes('model_completed') || line.includes('runtime.session.metadata') || line.includes('user_intent.accepted'))) return out
  let o
  try {
    o = JSON.parse(line)
  } catch {
    return out
  }
  for (const rec of museRecords(o)) {
    const p = rec.payload
    if (rec.type === 'runtime.session.metadata') {
      out.cwd = out.cwd || folder(object(p.record) ? p.record.workspace_root : null)
      continue
    }
    if (rec.type === 'runtime.user_intent.accepted') {
      if (!facts.title && !out.title) {
        const t = musePromptOf(rec)
        if (t) out.title = t.split(/\r?\n/)[0].slice(0, 200)
      }
      continue
    }
    const e = object(p.event) ? p.event : null
    if (rec.type !== 'runtime.session' || !e || e.kind !== 'model_completed' || !rec.at) continue
    const b = museUsageBucket(e.usage)
    if (b) out.events.push({ sessionId: facts.sessionId, time: rec.at, cwd: facts.cwd || out.cwd, title: facts.title || out.title, model: museModelId(e.model) || null, ...b })
  }
  return out
}

export function createMuseUsageReport({ home = os.homedir(), env = process.env, days = 30, now = Date.now, timezone = Intl.DateTimeFormat().resolvedOptions().timeZone } = {}) {
  const cache = new Map() // file -> { offset, skipping, size, mtimeMs, cwd, title, events }
  const dayOf = usageDayFormatter(timezone)
  return async function report(query = {}) {
    const time = now()
    const range = usageQueryRange(query, dayOf(time), days)
    const projectIn = usageRootMatcher(range)
    const files = await listMuseSessionLogs(museSessionsDir(home, env))
    const live = new Set(files.map((f) => f.file))
    for (const f of [...cache.keys()]) if (!live.has(f)) cache.delete(f)
    const events = []
    const parents = new Map() // session id -> { cwd, title } of its own log
    for (const f of files) {
      let entry = cache.get(f.file)
      if (!entry || entry.mtimeMs !== f.mtimeMs || entry.size !== f.size) {
        try {
          const facts = { sessionId: f.id, cwd: entry && entry.cwd, title: entry && entry.title }
          const added = []
          const got = await scanGrokLines(f.file, entry || { offset: 0, skipping: false }, f.size, (l) => {
            const r = museUsageLine(l, facts)
            if (r.cwd && !facts.cwd) facts.cwd = r.cwd
            if (r.title && !facts.title) facts.title = r.title
            added.push(...r.events)
          })
          const kept = entry && !got.reset ? entry.events : []
          entry = { offset: got.offset, skipping: got.skipping, size: f.size, mtimeMs: f.mtimeMs, cwd: facts.cwd, title: facts.title, child: f.child, id: f.id, events: [...kept, ...added] }
          cache.set(f.file, entry)
        } catch {
          // busy right now: left out this time
          if (!entry) continue
        }
      }
      if (!f.child) parents.set(f.id, { cwd: entry.cwd, title: entry.title })
    }
    for (const f of files) {
      const entry = cache.get(f.file)
      if (!entry) continue
      // A child's calls under its parent's folder and title.
      const parent = (f.child && parents.get(f.id)) || null
      for (const e of entry.events) events.push(parent ? { ...e, cwd: parent.cwd || e.cwd, title: parent.title || e.title } : e)
    }
    return usageReportFromEvents(events, { range, projectIn, dayOf, time, timezone, files: files.length, source: 'muse-local', provider: 'muse' })
  }
}
