// OpenCode usage report, read from its own SQLite databases on this computer
// (<data>/opencode/opencode*.db; nothing is sent anywhere, no sign-in used):
// tokens and the cost OpenCode recorded, by day, model, project and session.
// After Orca's src/main/opencode-usage (opencode-usage-row-queries.ts,
// opencode-usage-row-parsing.ts, opencode-database-discovery.ts), MIT,
// Copyright (c) 2026 Lovecast Inc.
// Databases are opened read-only and parsed again only when they changed.
import fs from 'fs'
import os from 'os'
import { basename, isAbsolute, join } from 'path'
import {
  usageDayFormatter,
  usageQueryRange,
  usageProjectKey,
  matchesUsageRoots,
  usageScope
} from './usageReportFilters'

const DB_NAME = /^opencode(?:-[A-Za-z0-9_.-]+)?\.db$/
const MAX_DATABASES = 16
const MAX_ROWS = 200000

export function opencodeDataDir(home = os.homedir(), env = process.env) {
  const xdg = typeof env.XDG_DATA_HOME === 'string' ? env.XDG_DATA_HOME.trim() : ''
  return join(xdg || join(home, '.local', 'share'), 'opencode')
}

// OpenCode's databases: OPENCODE_DB when set (':memory:' = none), else every
// opencode*.db in its data folder. The live opencode.db comes first: it owns
// a session that a stale sibling copy also holds.
export function listOpencodeDatabases(dataDir, env = process.env) {
  const override = typeof env.OPENCODE_DB === 'string' ? env.OPENCODE_DB.trim() : ''
  const files = []
  if (override) {
    if (override === ':memory:') return []
    files.push(isAbsolute(override) ? override : join(dataDir, override))
  } else {
    try {
      for (const e of fs.readdirSync(dataDir, { withFileTypes: true }))
        if (e.isFile() && DB_NAME.test(e.name)) files.push(join(dataDir, e.name))
    } catch {
      return []
    }
  }
  return files
    .filter((f) => {
      try {
        const st = fs.lstatSync(f)
        return st.isFile() && !st.isSymbolicLink()
      } catch {
        return false
      }
    })
    .sort((a, b) => {
      const ra = basename(a).toLowerCase() === 'opencode.db' ? 0 : 1
      const rb = basename(b).toLowerCase() === 'opencode.db' ? 0 : 1
      return ra - rb || (a < b ? -1 : a > b ? 1 : 0)
    })
    .slice(0, MAX_DATABASES)
}

// --- Queries (every schema generation OpenCode has written) -----------------

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
}
function columnExists(db, table, column) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((r) => r.name === column)
}

// OpenCode 2 copies every `session` row into `session_v2` and then writes only
// there: read both, each id once, the live generation first.
const SESSION_TABLES = ['session_v2', 'session']
const META = { project_id: 'NULL', directory: 'NULL', title: 'NULL', model: 'NULL', time_created: '0', time_updated: 'NULL' }
const TOKEN_COLUMNS = ['tokens_input', 'tokens_output', 'tokens_reasoning', 'tokens_cache_read', 'tokens_cache_write']
const USAGE_COLUMNS = ['cost', ...TOKEN_COLUMNS]
const TOKEN_TOTAL = TOKEN_COLUMNS.map((c) => `s.${c}`).join(' + ')

function sessionSource(db, tables) {
  const selects = tables.map((table, index) => {
    const parts = [{ table, alias: 't' }, ...tables.slice(index + 1).map((other, i) => ({ table: other, alias: `o${index + i + 1}` }))]
    const refs = (name) => parts.filter((p) => columnExists(db, p.table, name)).map((p) => `${p.alias}.${name}`)
    const meta = Object.entries(META).map(([name, fallback]) => {
      const r = refs(name)
      const expr = !r.length ? fallback : parts.length === 1 ? r[0] : `COALESCE(${[...r, ...(fallback === 'NULL' ? [] : [fallback])].join(', ')})`
      return `${expr} AS ${name}`
    })
    // Both rows count the same replies: each column's larger value.
    const usage = USAGE_COLUMNS.map((name) => {
      const r = refs(name)
      const expr = !r.length ? '0' : parts.length === 1 ? r[0] : r.length === 1 ? `COALESCE(${r[0]}, 0)` : `MAX(${r.map((x) => `COALESCE(${x}, 0)`).join(', ')})`
      return `${expr} AS ${name}`
    })
    const joins = parts.slice(1).map((p) => `LEFT JOIN ${p.table} ${p.alias} ON ${p.alias}.id = t.id`).join(' ')
    const exclude = tables.slice(0, index).map((other) => `NOT EXISTS (SELECT 1 FROM ${other} o WHERE o.id = t.id)`).join(' AND ')
    return `SELECT t.id, ${[...meta, ...usage].join(', ')} FROM ${table} t${joins ? ' ' + joins : ''}${exclude ? ' WHERE ' + exclude : ''}`
  })
  return `(${selects.join(' UNION ALL ')})`
}

function projectJoin(db) {
  return tableExists(db, 'project') && columnExists(db, 'project', 'worktree')
    ? 'LEFT JOIN project p ON p.id = s.project_id'
    : 'LEFT JOIN (SELECT NULL AS id, NULL AS worktree) p ON 1 = 0'
}

export function selectOpencodeUsageRows(db) {
  const tables = SESSION_TABLES.filter((t) => tableExists(db, t) && columnExists(db, t, 'id'))
  if (!tables.length) return []
  const source = sessionSource(db, tables)
  const join = projectJoin(db)
  // Newer databases keep token totals per session: one row per session.
  const totals = tables.some((t) => ['cost', 'tokens_input', 'tokens_output', 'tokens_reasoning', 'tokens_cache_read'].every((c) => columnExists(db, t, c)))
  if (totals && db.prepare(`SELECT COUNT(*) AS n FROM ${source} s WHERE ${TOKEN_TOTAL} > 0`).get().n > 0) {
    return db
      .prepare(
        `SELECT s.id, s.id AS session_id, s.time_created, s.time_updated, s.directory, s.title,
                p.worktree, s.model AS session_model, s.cost, s.tokens_input, s.tokens_output,
                s.tokens_reasoning, s.tokens_cache_read, s.tokens_cache_write
         FROM ${source} s ${join} WHERE ${TOKEN_TOTAL} > 0 ORDER BY s.time_created, s.id LIMIT ${MAX_ROWS}`
      )
      .all()
      .map((r) => ({
        ...r,
        data: JSON.stringify({
          cost: r.cost,
          tokens: {
            input: r.tokens_input,
            output: r.tokens_output,
            reasoning: r.tokens_reasoning,
            cache: { read: r.tokens_cache_read, write: r.tokens_cache_write }
          }
        })
      }))
  }
  if (tableExists(db, 'session_message')) {
    const typed = columnExists(db, 'session_message', 'type')
    const assistant = typed ? "sm.type = 'assistant'" : "json_extract(sm.data, '$.tokens.input') IS NOT NULL"
    const rows = db
      .prepare(
        `SELECT sm.id, sm.session_id, sm.time_created, sm.time_updated, sm.data, s.directory, s.title,
                p.worktree, s.model AS session_model
         FROM session_message sm JOIN ${source} s ON s.id = sm.session_id ${join}
         WHERE ${assistant} ORDER BY sm.time_created, sm.id LIMIT ${MAX_ROWS}`
      )
      .all()
    if (rows.length) return rows
  }
  if (!tableExists(db, 'message')) return []
  return db
    .prepare(
      `SELECT m.id, m.session_id, m.time_created, m.time_updated, m.data, s.directory, s.title,
              p.worktree, s.model AS session_model
       FROM message m JOIN ${source} s ON s.id = m.session_id ${join}
       WHERE json_extract(m.data, '$.role') = 'assistant' ORDER BY m.time_created, m.id LIMIT ${MAX_ROWS}`
    )
    .all()
}

// --- Rows -> usage ------------------------------------------------------------

const n = (v) => {
  const x = typeof v === 'string' ? Number(v) : v
  return typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0
}
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)
function obj(v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v
  if (typeof v !== 'string') return null
  try {
    const o = JSON.parse(v)
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null
  } catch {
    return null
  }
}
const millis = (v) => {
  const x = n(v)
  return x ? (x < 10_000_000_000 ? x * 1000 : x) : null
}

function modelLabel(data, sessionModel) {
  const direct = str(data.modelID) || str(data.modelId)
  const provider = str(data.providerID) || str(data.providerId)
  if (direct) return provider ? `${provider}/${direct}` : direct
  const m = obj(data.model) || obj(sessionModel)
  const id = m && (str(m.modelID) || str(m.id))
  if (!id) return null
  return str(m.providerID) ? `${str(m.providerID)}/${id}` : id
}

// One usage row -> { sessionId, time, model, cwd, title, input, output,
// reasoning, cacheRead, cacheWrite, cost } or null. Reasoning and cache
// tokens are OpenCode's own buckets, next to input and output.
export function parseOpencodeUsageRow(row) {
  const data = obj(row && row.data)
  const tokens = data && obj(data.tokens)
  if (!tokens || typeof row.session_id !== 'string') return null
  const cache = obj(tokens.cache) || {}
  const usage = {
    input: n(tokens.input),
    output: n(tokens.output),
    reasoning: n(tokens.reasoning),
    cacheRead: n(cache.read),
    cacheWrite: n(cache.write)
  }
  if (!Object.values(usage).some(Boolean)) return null
  const time = obj(data.time) || {}
  const at = millis(time.completed) || millis(time.created) || millis(row.time_updated) || millis(row.time_created)
  if (!at) return null
  return {
    sessionId: row.session_id.slice(0, 120),
    time: at,
    model: modelLabel(data, row.session_model),
    cwd: str(obj(data.path)?.cwd) || str(row.directory) || str(row.worktree),
    title: str(row.title) ? str(row.title).split(/\r?\n/)[0].slice(0, 200) : null,
    ...usage,
    cost: n(data.cost) || null
  }
}

function readDatabase(file) {
  const sqlite = process.getBuiltinModule ? process.getBuiltinModule('node:sqlite') : null
  if (!sqlite) return []
  let db
  try {
    db = new sqlite.DatabaseSync(file, { readOnly: true })
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=250;')
    return selectOpencodeUsageRows(db).map(parseOpencodeUsageRow).filter(Boolean)
  } finally {
    try {
      db?.close()
    } catch {
      /* closed */
    }
  }
}

function signature(file) {
  const st = fs.statSync(file)
  let wal = ''
  try {
    const w = fs.statSync(file + '-wal')
    wal = `${w.size}:${w.mtimeMs}`
  } catch {
    /* no write-ahead log */
  }
  return `${st.size}:${st.mtimeMs}:${wal}`
}

const empty = () => ({ turns: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0, unpriced: 0 })
function add(acc, e) {
  acc.turns++
  for (const k of ['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite']) acc[k] += e[k]
  if (e.cost === null) acc.unpriced++
  else acc.cost += e.cost
}

export function createOpencodeUsageReport({
  dataDir = opencodeDataDir(),
  env = process.env,
  days = 30,
  now = Date.now,
  timezone = Intl.DateTimeFormat().resolvedOptions().timeZone,
  read = readDatabase
} = {}) {
  const cache = new Map() // file -> { sig, events }
  const dayOf = usageDayFormatter(timezone)
  return async function report(query = {}) {
    const time = now()
    const range = usageQueryRange(query, dayOf(time), days)
    const files = listOpencodeDatabases(dataDir, env)
    for (const f of [...cache.keys()]) if (!files.includes(f)) cache.delete(f)
    for (const f of files) {
      let sig
      try {
        sig = signature(f)
      } catch {
        continue
      }
      if (cache.get(f)?.sig === sig) continue
      try {
        cache.set(f, { sig, events: read(f) })
      } catch {
        // busy or another layout right now: left out this time
      }
    }
    // Each session counted from one database: the first (live) one holding it.
    const owner = new Map()
    const events = []
    for (const f of files) {
      const entry = cache.get(f)
      if (!entry) continue
      for (const e of entry.events) {
        if (!owner.has(e.sessionId)) owner.set(e.sessionId, f)
        if (owner.get(e.sessionId) === f) events.push(e)
      }
    }
    const totals = empty()
    const allTotals = empty()
    const allSessions = new Set()
    const byDay = new Map()
    const byModel = new Map()
    const byProject = new Map()
    const bySession = new Map()
    for (const e of events) {
      add(allTotals, e)
      allSessions.add(e.sessionId)
      const day = dayOf(e.time)
      const model = e.model || 'unknown'
      if (
        (range.from && day < range.from) ||
        (range.to && day > range.to) ||
        (range.cwd && usageProjectKey(e.cwd) !== usageProjectKey(range.cwd)) ||
        (range.model && model !== range.model) ||
        !matchesUsageRoots(e.cwd, range.roots)
      )
        continue
      add(totals, e)
      if (!byDay.has(day)) byDay.set(day, { day, ...empty() })
      add(byDay.get(day), e)
      if (!byModel.has(model)) byModel.set(model, { model, ...empty(), sessions: new Set() })
      add(byModel.get(model), e)
      byModel.get(model).sessions.add(e.sessionId)
      const project = e.cwd || '(unknown folder)'
      const key = usageProjectKey(project)
      if (!byProject.has(key))
        byProject.set(key, {
          cwd: project,
          label: project.split(/[\\/]/).filter(Boolean).at(-1) || project,
          ...empty(),
          sessions: new Set()
        })
      add(byProject.get(key), e)
      byProject.get(key).sessions.add(e.sessionId)
      if (!bySession.has(e.sessionId))
        bySession.set(e.sessionId, {
          id: e.sessionId,
          title: e.title,
          cwd: e.cwd,
          branch: null,
          model,
          first: e.time,
          last: e.time,
          ...empty()
        })
      const s = bySession.get(e.sessionId)
      add(s, e)
      s.first = Math.min(s.first, e.time)
      if (e.time >= s.last) Object.assign(s, { last: e.time, model, cwd: e.cwd || s.cwd, title: e.title || s.title })
    }
    const byTokens = (a, b) => b.input + b.output - (a.input + a.output)
    const withSessionCount = ({ sessions, ...entry }) => ({ ...entry, sessions: sessions.size })
    return {
      ok: true,
      source: 'opencode-local',
      provider: 'opencode',
      generatedAt: new Date(time).toISOString(),
      timezone,
      range: { from: range.from, to: range.to },
      scope: usageScope(range),
      files: files.length,
      totals: { ...totals, sessions: bySession.size },
      allTotals: { ...allTotals, sessions: allSessions.size },
      byDay: [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1)),
      byModel: [...byModel.values()].map(withSessionCount).sort(byTokens),
      byProject: [...byProject.values()].map(withSessionCount).sort(byTokens),
      sessions: [...bySession.values()].sort((a, b) => b.last - a.last || a.id.localeCompare(b.id))
    }
  }
}
