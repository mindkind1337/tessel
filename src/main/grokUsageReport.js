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
// Bounded: at most 4000 sessions, the newest first; read without blocking the
// main process (fs.promises, 1 MB at a time), a file again only from where the
// last read stopped (they only grow); a line longer than 1 MB is passed over
// (the read goes on after it, even across reads), and only turn_completed
// lines are parsed.
import fsp from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import { usageDayFormatter, usageQueryRange, usageRootMatcher } from './usageReportFilters'
import { usageReportFromEvents } from './opencodeUsageReport'
import { grokHome } from './grokAccount'

const MAX_SESSIONS = 4000
const CHUNK = 1024 * 1024
const MAX_LINE = 1024 * 1024
const TICKS_PER_USD = 1e10
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const n = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)

async function entries(dir) {
  try {
    return await fsp.readdir(dir, { withFileTypes: true })
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

async function readSummary(file) {
  try {
    const st = await fsp.stat(file)
    if (!st.isFile() || st.size > 256 * 1024) return {}
    const o = JSON.parse(await fsp.readFile(file, 'utf8'))
    const info = object(o?.info) ? o.info : {}
    return { cwd: str(info.cwd), title: str(o.generated_title)?.split(/\r?\n/)[0].slice(0, 200) || null, model: str(o.current_model_id) }
  } catch {
    return {}
  }
}

// The sessions' update files, newest first: [{ id, file, dir }].
export async function listGrokSessionFiles(root) {
  const out = []
  for (const group of await entries(root)) {
    if (!group.isDirectory() || group.isSymbolicLink()) continue
    for (const s of await entries(join(root, group.name))) {
      if (!s.isDirectory() || s.isSymbolicLink() || !/^[A-Za-z0-9_-]{6,80}$/.test(s.name)) continue
      const dir = join(root, group.name, s.name)
      const file = join(dir, 'updates.jsonl')
      let st
      try {
        st = await fsp.lstat(file)
      } catch {
        continue
      }
      if (st.isFile()) out.push({ id: s.name, file, dir, size: st.size, mtimeMs: st.mtimeMs })
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_SESSIONS)
}

// A file's complete lines from `from.offset` to `size`, read 1 MB at a time:
// onLine(text) for each line of at most 1 MB; a longer one is passed over
// (skipping: still inside one when the read ends). A last line not ended yet
// is read again next time. -> { offset, skipping, reset }.
export async function scanGrokLines(file, from, size, onLine, { chunk = CHUNK, maxLine = MAX_LINE } = {}) {
  const reset = from.offset > size
  let offset = reset ? 0 : from.offset
  let skipping = reset ? false : from.skipping === true
  if (offset >= size) return { offset, skipping, reset }
  const fh = await fsp.open(file, 'r')
  try {
    let pos = offset
    let parts = []
    let partLen = 0
    const buf = Buffer.alloc(chunk)
    while (pos < size) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(chunk, size - pos), pos)
      if (!bytesRead) break
      let start = 0
      for (;;) {
        const nl = buf.indexOf(10, start)
        const end = nl < 0 || nl >= bytesRead ? bytesRead : nl
        if (!skipping) {
          if (partLen + (end - start) > maxLine) {
            skipping = true
            parts = []
            partLen = 0
          } else if (end > start) {
            parts.push(Buffer.from(buf.subarray(start, end)))
            partLen += end - start
          }
        }
        if (end === bytesRead) break
        // A whole line: given, or the over-long one ends here.
        if (!skipping) onLine(Buffer.concat(parts, partLen).toString('utf8').replace(/\r$/, ''))
        skipping = false
        parts = []
        partLen = 0
        offset = pos + nl + 1
        start = nl + 1
      }
      pos += bytesRead
    }
    // Inside an over-long line at the end: past it so far, still passing over.
    if (skipping) offset = pos
    return { offset, skipping, reset }
  } finally {
    await fh.close().catch(() => {})
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
    const files = await listGrokSessionFiles(join(grokHome(home, env), 'sessions'))
    const live = new Set(files.map((f) => f.file))
    for (const f of [...cache.keys()]) if (!live.has(f)) cache.delete(f)
    const events = []
    for (const f of files) {
      let entry = cache.get(f.file)
      if (!entry || entry.mtimeMs !== f.mtimeMs || entry.size !== f.size) {
        try {
          const facts = await readSummary(join(f.dir, 'summary.json'))
          const added = []
          const got = await scanGrokLines(f.file, entry || { offset: 0, skipping: false }, f.size, (l) => added.push(...grokUsageEvents(l, { sessionId: f.id, ...facts })))
          const kept = entry && !got.reset ? entry.events : []
          // The folder and title as the summary says them now.
          entry = { offset: got.offset, skipping: got.skipping, size: f.size, mtimeMs: f.mtimeMs, events: [...kept, ...added].map((e) => ({ ...e, cwd: facts.cwd || e.cwd, title: facts.title || e.title })) }
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
