// Grok Build's usage report, read from its own session files on this computer
// (nothing is sent anywhere, no sign-in used): each turn's tokens and the
// cost Grok Build recorded, by day, model, project and session, for Stats.
//
// <GROK_HOME or ~/.grok>/sessions/<encoded folder>/<id>/updates.jsonl: each
// turn ends with { params: { update: { sessionUpdate: 'turn_completed',
// usage: { inputTokens, outputTokens, cachedReadTokens, cacheCreationTokens,
// reasoningTokens, costUsdTicks, modelUsage: { <model>: { same } } } },
// _meta: { agentTimestampMs } } }; summary.json beside it names the folder
// and the title. Grok counts cached input inside input and reasoning inside
// output (an OpenAI-style answer): they are taken out here, so the report
// carries OpenCode's buckets (input, output, reasoning, cacheRead, cacheWrite,
// each its own). costUsdTicks: 10^10 ticks per dollar (`grok usage`).
//
// Bounded: at most 4000 sessions, the newest first; a file is read again only
// from where the last read stopped (they only grow), each line at most 1 MB,
// and only its turn_completed lines are parsed.
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { usageDayFormatter, usageQueryRange, usageRootMatcher } from './usageReportFilters'
import { usageReportFromEvents } from './opencodeUsageReport'
import { grokHome } from './grokAccount'

const MAX_SESSIONS = 4000
const MAX_READ = 64 * 1024 * 1024
const TICKS_PER_USD = 1e10
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const n = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)

function entries(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

// One usage bucket (the turn's, or one model's in it) -> the report's own.
export function grokUsageBucket(u) {
  if (!object(u)) return null
  const input = n(u.inputTokens)
  const read = Math.min(input, n(u.cachedReadTokens))
  const output = n(u.outputTokens)
  const reasoning = Math.min(output, n(u.reasoningTokens))
  const write = n(u.cacheCreationTokens)
  if (!input && !output && !write) return null
  return {
    input: input - read,
    output: output - reasoning,
    reasoning,
    cacheRead: read,
    cacheWrite: write,
    cost: typeof u.costUsdTicks === 'number' && Number.isFinite(u.costUsdTicks) && u.costUsdTicks >= 0 ? u.costUsdTicks / TICKS_PER_USD : null
  }
}

// One updates.jsonl line -> [usage events] (one per model of the turn), or [].
export function grokUsageEvents(line, { sessionId, cwd = null, title = null, model = null } = {}) {
  if (typeof line !== 'string' || !line.includes('"turn_completed"')) return []
  let r
  try {
    r = JSON.parse(line)
  } catch {
    return []
  }
  const p = object(r?.params) ? r.params : null
  const u = p && object(p.update) ? p.update : null
  if (!u || u.sessionUpdate !== 'turn_completed' || !object(u.usage)) return []
  const meta = object(p._meta) ? p._meta : {}
  const time = n(meta.agentTimestampMs) || (n(r.timestamp) ? (r.timestamp < 1e11 ? r.timestamp * 1000 : r.timestamp) : 0)
  if (!time) return []
  const base = { sessionId, time, cwd, title }
  const per = object(u.usage.modelUsage) ? Object.entries(u.usage.modelUsage).filter(([id, v]) => str(id) && object(v)) : []
  const rows = per.map(([id, v]) => ({ model: id.slice(0, 120), b: grokUsageBucket(v) })).filter((x) => x.b)
  if (rows.length) return rows.map(({ model: m, b }) => ({ ...base, model: m, ...b }))
  const b = grokUsageBucket(u.usage)
  return b ? [{ ...base, model, ...b }] : []
}

function readSummary(file) {
  try {
    const st = fs.statSync(file)
    if (!st.isFile() || st.size > 256 * 1024) return {}
    const o = JSON.parse(fs.readFileSync(file, 'utf8'))
    const info = object(o?.info) ? o.info : {}
    return { cwd: str(info.cwd), title: str(o.generated_title)?.split(/\r?\n/)[0].slice(0, 200) || null, model: str(o.current_model_id) }
  } catch {
    return {}
  }
}

// The sessions' update files, newest first: [{ id, file, dir }].
export function listGrokSessionFiles(root) {
  const out = []
  for (const group of entries(root)) {
    if (!group.isDirectory() || group.isSymbolicLink()) continue
    for (const s of entries(join(root, group.name))) {
      if (!s.isDirectory() || s.isSymbolicLink() || !/^[A-Za-z0-9_-]{6,80}$/.test(s.name)) continue
      const dir = join(root, group.name, s.name)
      const file = join(dir, 'updates.jsonl')
      let st
      try {
        st = fs.lstatSync(file)
      } catch {
        continue
      }
      if (st.isFile()) out.push({ id: s.name, file, dir, size: st.size, mtimeMs: st.mtimeMs })
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_SESSIONS)
}

// A file's new complete lines since `offset` -> { lines, offset }.
function readFrom(file, offset, size) {
  const start = offset > size ? 0 : offset
  const len = Math.min(size - start, MAX_READ)
  if (len <= 0) return { lines: [], offset: start, reset: start !== offset }
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(len)
    const got = fs.readSync(fd, buf, 0, len, start)
    const text = buf.subarray(0, got).toString('utf8')
    const end = text.lastIndexOf('\n')
    if (end < 0) return { lines: [], offset: start, reset: start !== offset }
    return {
      lines: text.slice(0, end).split('\n').filter((l) => l.length <= 1024 * 1024),
      offset: start + Buffer.byteLength(text.slice(0, end + 1), 'utf8'),
      reset: start !== offset
    }
  } finally {
    fs.closeSync(fd)
  }
}

export function createGrokUsageReport({
  home = os.homedir(),
  env = process.env,
  days = 30,
  now = Date.now,
  timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
} = {}) {
  const cache = new Map() // file -> { offset, mtimeMs, events }
  const dayOf = usageDayFormatter(timezone)
  return async function report(query = {}) {
    const time = now()
    const range = usageQueryRange(query, dayOf(time), days)
    const projectIn = usageRootMatcher(range)
    const files = listGrokSessionFiles(join(grokHome(home, env), 'sessions'))
    const live = new Set(files.map((f) => f.file))
    for (const f of [...cache.keys()]) if (!live.has(f)) cache.delete(f)
    const events = []
    for (const f of files) {
      let entry = cache.get(f.file)
      if (!entry || entry.mtimeMs !== f.mtimeMs || entry.offset !== f.size) {
        try {
          const facts = readSummary(join(f.dir, 'summary.json'))
          const got = readFrom(f.file, entry ? entry.offset : 0, f.size)
          const kept = entry && !got.reset ? entry.events : []
          const added = got.lines.flatMap((l) => grokUsageEvents(l, { sessionId: f.id, ...facts }))
          // The folder and title as the summary says them now.
          entry = { offset: got.offset, mtimeMs: f.mtimeMs, events: [...kept, ...added].map((e) => ({ ...e, cwd: facts.cwd || e.cwd, title: facts.title || e.title })) }
          cache.set(f.file, entry)
        } catch {
          // busy right now: left out this time
          if (!entry) continue
        }
      }
      events.push(...entry.events)
    }
    return usageReportFromEvents(events, { range, projectIn, dayOf, time, timezone, files: files.length, source: 'grok-local', provider: 'grok' })
  }
}
