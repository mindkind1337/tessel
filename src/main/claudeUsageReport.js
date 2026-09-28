// Claude Code usage report, read from its own conversation files on this
// computer (~/.claude/projects/**/*.jsonl; nothing is sent anywhere, no
// sign-in used): tokens and estimated cost by day, model, project and
// conversation. Each file is parsed again only when it changed. Parsing
// follows Orca's (github.com/stablyai/orca, src/main/claude-usage, MIT):
// Claude Code writes a reply's usage several times, so rows sharing a message
// id and request id are one turn, keeping the largest counts.
import fs from 'fs'
import os from 'os'
import { join, basename } from 'path'
import { createInterface } from 'readline'
import { turnCostUsd, pricingModel } from '../shared/claudePricing'

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
  const rl = createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of rl) {
    const t = parseClaudeLine(line)
    if (!t || !t.model || t.model === '<synthetic>') continue
    const key = t.key || `${file}#${anon++}`
    const had = turns.get(key)
    if (!had) turns.set(key, t)
    else for (const f of ['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h']) had[f] = Math.max(had[f], t[f])
  }
  return turns
}

export function claudeProjectsDir(home = os.homedir(), env = process.env) {
  const base = env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.trim() ? env.CLAUDE_CONFIG_DIR.trim() : join(home, '.claude')
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

const empty = () => ({ turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cost: 0, unpriced: 0 })
function add(acc, t, cost) {
  acc.turns++
  acc.input += t.input
  acc.output += t.output
  acc.cacheRead += t.cacheRead
  acc.cacheWrite += t.cacheWrite
  acc.cacheWrite1h += t.cacheWrite1h
  if (cost === null) acc.unpriced++
  else acc.cost += cost
}
const dayOf = (ms) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// A reader that keeps parsed files between calls (parses a file again only
// when its size or time changed). -> () => Promise<report>
export function createClaudeUsageReport({ dir = claudeProjectsDir(), days = 30 } = {}) {
  const cache = new Map() // file -> { size, mtimeMs, turns }
  return async function report() {
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
    for (const { turns } of cache.values()) for (const [k, t] of turns) if (!all.has(k)) all.set(k, t)

    const since = Date.now() - days * 86400000
    const totals = empty()
    const last = empty()
    const byDay = new Map()
    const byModel = new Map()
    const byProject = new Map()
    const bySession = new Map()
    for (const t of all.values()) {
      const cost = turnCostUsd(t.model, t)
      add(totals, t, cost)
      if (t.time < since) continue
      add(last, t, cost)
      const day = dayOf(t.time)
      if (!byDay.has(day)) byDay.set(day, { day, ...empty() })
      add(byDay.get(day), t, cost)
      const model = pricingModel(t.model) || t.model
      if (!byModel.has(model)) byModel.set(model, { model, ...empty() })
      add(byModel.get(model), t, cost)
      const project = t.cwd || '(unknown folder)'
      if (!byProject.has(project)) byProject.set(project, { cwd: project, label: basename(project) || project, ...empty() })
      add(byProject.get(project), t, cost)
      if (t.sessionId) {
        if (!bySession.has(t.sessionId))
          bySession.set(t.sessionId, { id: t.sessionId, cwd: t.cwd, branch: t.branch, model, first: t.time, last: t.time, ...empty() })
        const s = bySession.get(t.sessionId)
        add(s, t, cost)
        s.first = Math.min(s.first, t.time)
        if (t.time >= s.last) Object.assign(s, { last: t.time, model, cwd: t.cwd || s.cwd, branch: t.branch || s.branch })
      }
    }
    const byCost = (a, b) => b.cost - a.cost
    return {
      ok: true,
      source: 'claude-local',
      days,
      files: files.length,
      totals,
      lastDays: last,
      byDay: [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1)),
      byModel: [...byModel.values()].sort(byCost),
      byProject: [...byProject.values()].sort(byCost),
      sessions: [...bySession.values()].sort(byCost).slice(0, 50)
    }
  }
}
