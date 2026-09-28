// Claude Code usage report, read from its own conversation files on this
// computer (~/.claude/projects/**/*.jsonl; nothing is sent anywhere, no
// sign-in used): tokens and estimated cost by day, model, project and
// conversation. Each file is parsed again only when it changed. Parsing
// follows Orca's (github.com/stablyai/orca, src/main/claude-usage, MIT):
// Claude Code writes a reply's usage several times, so rows sharing a message
// id and request id are one turn, keeping the largest counts.
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { createInterface } from 'readline'
import { turnCostUsd, pricingModel } from '../shared/claudePricing'
import {
  usageDayFormatter,
  usageQueryRange,
  usageProjectKey,
  matchesUsageRoots,
  usageScope
} from './usageReportFilters'

const n = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

// One transcript line -> a turn, or null.
export function parseClaudeLine(line) {
  if (!line || line.indexOf('"usage"') < 0) return null
  let r
  try {
    r = JSON.parse(line)
  } catch {
    return null
  }
  const m = r && r.message
  const u = m && m.usage
  if (!u || r.type !== 'assistant') return null
  const cc = u.cache_creation || {}
  return {
    key: m.id && r.requestId ? `${m.id}:${r.requestId}` : r.uuid || null,
    sessionId: r.sessionId || r.session_id || null,
    time: Date.parse(r.timestamp) || 0,
    model: m.model || null,
    cwd: r.cwd || null,
    branch: r.gitBranch || null,
    sidechain: !!r.isSidechain,
    input: n(u.input_tokens),
    output: n(u.output_tokens),
    cacheRead: n(u.cache_read_input_tokens),
    cacheWrite: n(u.cache_creation_input_tokens),
    cacheWrite1h: n(cc.ephemeral_1h_input_tokens)
  }
}

async function parseFile(file) {
  const turns = new Map() // key -> turn (keyless turns get their own key)
  let anon = 0
  const rl = createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity
  })
  for await (const line of rl) {
    const t = parseClaudeLine(line)
    if (!t || !t.model || t.model === '<synthetic>') continue
    const key = t.key || `${file}#${anon++}`
    const had = turns.get(key)
    if (!had) turns.set(key, t)
    else
      for (const f of ['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h'])
        had[f] = Math.max(had[f], t[f])
  }
  return turns
}

export function claudeProjectsDir(home = os.homedir(), env = process.env) {
  const base =
    env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.trim()
      ? env.CLAUDE_CONFIG_DIR.trim()
      : join(home, '.claude')
  return join(base, 'projects')
}

function listJsonl(dir) {
  const out = []
  const stack = [dir]
  while (stack.length) {
    const d = stack.pop()
    let entries = []
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const full = join(d, e.name)
      if (e.isDirectory()) stack.push(full)
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full)
    }
  }
  return out
}

const empty = () => ({
  turns: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cacheWrite1h: 0,
  cost: 0,
  unpriced: 0,
  zeroCacheReadTurns: 0
})
function add(acc, t, cost) {
  acc.turns++
  acc.input += t.input
  acc.output += t.output
  acc.cacheRead += t.cacheRead
  acc.cacheWrite += t.cacheWrite
  acc.cacheWrite1h += t.cacheWrite1h
  if (t.cacheRead === 0) acc.zeroCacheReadTurns++
  if (cost === null) acc.unpriced++
  else acc.cost += cost
}
// A reader that keeps parsed files between calls (parses a file again only
// when its size or time changed). Filtering never changes deduplication ownership.
export function createClaudeUsageReport({
  dir = claudeProjectsDir(),
  days = 30,
  now = Date.now,
  timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
} = {}) {
  const cache = new Map() // file -> { size, mtimeMs, turns }
  const dayOf = usageDayFormatter(timezone)
  return async function report(query = {}) {
    const time = now()
    // Reject malformed renderer filters before touching any log file.
    const range = usageQueryRange(query, dayOf(time), days)
    const files = listJsonl(dir)
    const seen = new Set(files)
    for (const f of [...cache.keys()]) if (!seen.has(f)) cache.delete(f)
    for (const f of files) {
      let st
      try {
        st = fs.statSync(f)
      } catch {
        continue
      }
      const c = cache.get(f)
      if (c && c.size === st.size && c.mtimeMs === st.mtimeMs) continue
      try {
        cache.set(f, { size: st.size, mtimeMs: st.mtimeMs, turns: await parseFile(f) })
      } catch {
        // unreadable right now: left out this time
      }
    }
    // One turn once across files (a resumed or forked conversation copies
    // earlier turns into its new file).
    const all = new Map()
    for (const { turns } of cache.values())
      for (const [k, t] of turns) if (!all.has(k)) all.set(k, t)

    const totals = empty()
    const allTotals = empty()
    const allSessions = new Set()
    const byDay = new Map()
    const byModel = new Map()
    const byProject = new Map()
    const bySession = new Map()
    for (const t of all.values()) {
      const cost = turnCostUsd(t.model, t)
      add(allTotals, t, cost)
      if (t.sessionId) allSessions.add(t.sessionId)
      const day = dayOf(t.time)
      const model = pricingModel(t.model) || t.model
      if (
        (range.from && day < range.from) ||
        (range.to && day > range.to) ||
        (range.cwd && usageProjectKey(t.cwd) !== usageProjectKey(range.cwd)) ||
        (range.model && t.model !== range.model && model !== range.model) ||
        !matchesUsageRoots(t.cwd, range.roots)
      )
        continue
      add(totals, t, cost)
      if (!byDay.has(day)) byDay.set(day, { day, ...empty() })
      add(byDay.get(day), t, cost)
      if (!byModel.has(model)) byModel.set(model, { model, ...empty(), sessions: new Set() })
      add(byModel.get(model), t, cost)
      if (t.sessionId) byModel.get(model).sessions.add(t.sessionId)
      const project = t.cwd || '(unknown folder)'
      const projectKey = usageProjectKey(project)
      if (!byProject.has(projectKey))
        byProject.set(projectKey, {
          cwd: project,
          label: project.split(/[\\/]/).filter(Boolean).at(-1) || project,
          ...empty(),
          sessions: new Set()
        })
      add(byProject.get(projectKey), t, cost)
      if (t.sessionId) byProject.get(projectKey).sessions.add(t.sessionId)
      if (t.sessionId) {
        if (!bySession.has(t.sessionId))
          bySession.set(t.sessionId, {
            id: t.sessionId,
            cwd: t.cwd,
            branch: t.branch,
            model,
            first: t.time,
            last: t.time,
            ...empty()
          })
        const s = bySession.get(t.sessionId)
        add(s, t, cost)
        s.first = Math.min(s.first, t.time)
        if (t.time >= s.last)
          Object.assign(s, {
            last: t.time,
            model,
            cwd: t.cwd || s.cwd,
            branch: t.branch || s.branch
          })
      }
    }
    const byCost = (a, b) => b.cost - a.cost
    const withSessionCount = ({ sessions, ...entry }) => ({ ...entry, sessions: sessions.size })
    return {
      ok: true,
      source: 'claude-local',
      provider: 'claude',
      generatedAt: new Date(time).toISOString(),
      timezone,
      range: { from: range.from, to: range.to },
      scope: usageScope(range),
      days:
        range.from && range.to
          ? Math.round((Date.parse(range.to) - Date.parse(range.from)) / 86400000) + 1
          : null,
      files: files.length,
      totals: { ...totals, sessions: bySession.size },
      lastDays: { ...totals, sessions: bySession.size },
      allTotals: { ...allTotals, sessions: allSessions.size },
      byDay: [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1)),
      byModel: [...byModel.values()].map(withSessionCount).sort(byCost),
      byProject: [...byProject.values()].map(withSessionCount).sort(byCost),
      sessions: [...bySession.values()].sort((a, b) => b.last - a.last || a.id.localeCompare(b.id))
    }
  }
}
