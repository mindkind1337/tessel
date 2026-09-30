// The session search index: a SQLite database (node:sqlite, FTS5) holding a
// copy of what was said in the agents' conversations, so it can be searched.
// A cache over the agents' own files, never a source: a database that cannot
// be trusted (another schema, missing columns, a failed integrity check, a
// torn file) is removed and built again. Local only; never sent anywhere.
// Secrets are masked BEFORE the text is indexed (maskSecrets), so no result
// can bring one back, highlighted or not; what is deleted is overwritten
// (secure_delete, and FTS5's own secure-delete).
// After Orca's src/main/ai-vault-search (session-search-schema.ts,
// session-search-retrieval.ts, session-search-store.ts), MIT, Copyright (c)
// 2026 Lovecast Inc.
import fs from 'fs'
import { dirname } from 'path'
import { maskSecrets } from '../../shared/maskSecrets.js'
import { andExpression, identifierShadowText, orExpression, phraseExpression, planQuery } from './query.js'

export const SCHEMA_VERSION = 2
// Tool output beyond this many characters per row is not indexed.
export const TOOL_TEXT_MAX = 3072
// A match's marks in a passage: private-use characters, taken out of the text
// when it is indexed, so nothing a conversation says can pass for a mark.
export const MARK_OPEN = ''
export const MARK_CLOSE = ''
const MARKS = /[]/g
// The agents a result may name, and the shape of a session id a result may
// carry (what the resume accepts): anything else in the database is not shown.
export const KNOWN_AGENTS = new Set(['claude', 'openclaude', 'codex', 'gemini', 'qwen', 'opencode', 'copilot', 'kimi', 'cline', 'cursor', 'droid', 'grok', 'pi', 'omp', 'antigravity', 'devin', 'zcode']) // i18n-ignore
export const safeSessionId = (id) => typeof id === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_-]{5,79}$/.test(id)

// unicode61 keeps `_ . - / +` inside tokens, so paths and identifiers match
// exactly; the identifiers column carries their split form.
const TOKENIZER = `tokenize="unicode61 tokenchars '_.-/+'"` // i18n-ignore

const COLUMNS = {
  meta: ['key', 'value'],
  sessions: ['id', 'agent', 'session_id', 'file_path', 'title', 'cwd', 'cwd_key', 'created_at', 'updated_at', 'message_count'],
  files: ['path', 'agent', 'byte_offset', 'mtime_ms', 'size_bytes', 'head_hash', 'skipped', 'state', 'fail_count'],
  messages: ['id', 'session_row_id', 'role', 'ts']
}
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  session_id TEXT NOT NULL,
  file_path TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL DEFAULT '',
  cwd TEXT,
  cwd_key TEXT,
  created_at INTEGER,
  updated_at INTEGER,
  message_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS sessions_updated_at ON sessions(updated_at);
CREATE INDEX IF NOT EXISTS sessions_cwd_key ON sessions(cwd_key);
CREATE TABLE IF NOT EXISTS files(
  path TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  byte_offset INTEGER NOT NULL DEFAULT 0,
  mtime_ms REAL NOT NULL DEFAULT 0,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  head_hash TEXT,
  skipped INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'due',
  fail_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS files_state ON files(state, mtime_ms);
CREATE TABLE IF NOT EXISTS messages(
  id INTEGER PRIMARY KEY,
  session_row_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  ts INTEGER
);
CREATE INDEX IF NOT EXISTS messages_session ON messages(session_row_id);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  user_text, assistant_text, tool_text, identifiers, ${TOKENIZER}, detail=full
);
` // i18n-ignore

export function sqliteAvailable() {
  try {
    const sqlite = typeof process.getBuiltinModule === 'function' ? process.getBuiltinModule('node:sqlite') : null
    return !!(sqlite && typeof sqlite.DatabaseSync === 'function')
  } catch {
    return false
  }
}

export const DATABASE_FILES = ['', '-wal', '-shm', '-journal']
// -> true when none of the database's files is left.
export function removeDatabase(path) {
  for (const suffix of DATABASE_FILES) {
    try {
      fs.rmSync(path + suffix, { force: true })
    } catch {
      // held by another process: said by the result
    }
  }
  return DATABASE_FILES.every((suffix) => !fs.existsSync(path + suffix))
}
export function databaseSize(path) {
  let n = 0
  for (const suffix of DATABASE_FILES) {
    try {
      n += fs.statSync(path + suffix).size
    } catch {
      // not there
    }
  }
  return n
}

// SQLITE_CORRUPT and SQLITE_NOTADB: the file, not the request.
export const isCorruption = (err) => !!err && (err.errcode === 11 || err.errcode === 26 || /malformed|not a database/i.test(String(err.message || '')))

// Folder keys compare folders whatever their case or slashes.
export function cwdKey(cwd) {
  const s = typeof cwd === 'string' ? cwd.trim() : ''
  return s ? s.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() : null
}

// The text as it is indexed: secrets masked, the passage marks taken out.
export const indexText = (text) => maskSecrets(String(text || '').replace(MARKS, ''))

const rebuild = (why) => Object.assign(new Error(why), { rebuild: true })

// Opens, checks and prepares the database; throws when it cannot be trusted
// (the caller then removes it and builds a new one, once). The handle never
// outlives a failure.
function openChecked(path) {
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
  const db = new DatabaseSync(path)
  try {
    // Nothing in the file is trusted to run code of its own (a schema is ours
    // to trust only because we wrote it, and it holds no functions anyway).
    db.exec('PRAGMA trusted_schema = OFF; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA secure_delete = ON;') // i18n-ignore
    const hasTables = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get().n > 0
    if (hasTables) {
      let version = null
      try {
        version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value ?? null
      } catch {
        version = null
      }
      if (version !== String(SCHEMA_VERSION)) throw rebuild('another schema') // i18n-ignore
      const check = db.prepare('PRAGMA quick_check').get()
      if (!check || Object.values(check)[0] !== 'ok') throw rebuild('integrity check failed') // i18n-ignore
    }
    db.exec(SCHEMA_SQL)
    db.exec("INSERT INTO messages_fts(messages_fts, rank) VALUES('secure-delete', 1)") // i18n-ignore
    for (const [table, columns] of Object.entries(COLUMNS)) {
      const have = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name) // i18n-ignore
      if (columns.some((c) => !have.includes(c))) throw rebuild(`${table}: missing columns`) // i18n-ignore
    }
    db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION))
    return { db, q: prepare(db) }
  } catch (err) {
    try {
      db.close()
    } catch {
      // already closed
    }
    throw err
  }
}

function prepare(db) {
  return {
    fileGet: db.prepare('SELECT * FROM files WHERE path = ?'),
    fileUpsert: db.prepare(
      `INSERT INTO files(path, agent, mtime_ms, size_bytes, state) VALUES (?, ?, ?, ?, 'due')
       ON CONFLICT(path) DO UPDATE SET mtime_ms = excluded.mtime_ms, size_bytes = excluded.size_bytes, state = 'due', fail_count = 0`
    ),
    fileReset: db.prepare("UPDATE files SET byte_offset = 0, head_hash = NULL, skipped = 0, state = 'due', fail_count = 0 WHERE path = ?"),
    fileProgress: db.prepare('UPDATE files SET byte_offset = ?, state = ?, skipped = ?, head_hash = coalesce(?, head_hash) WHERE path = ?'),
    fileFail: db.prepare("UPDATE files SET fail_count = fail_count + 1, state = CASE WHEN fail_count >= 2 THEN 'failed' ELSE 'due' END WHERE path = ?"),
    fileFailNow: db.prepare("UPDATE files SET state = 'failed' WHERE path = ?"),
    fileDelete: db.prepare('DELETE FROM files WHERE path = ?'),
    filePaths: db.prepare('SELECT path FROM files'),
    nextDue: db.prepare("SELECT * FROM files WHERE state = 'due' ORDER BY mtime_ms DESC LIMIT 1"),
    counts: db.prepare("SELECT sum(state = 'current') AS indexed, sum(state = 'due') AS due, sum(state = 'failed') AS failed FROM files"),
    sessionByFile: db.prepare('SELECT * FROM sessions WHERE file_path = ?'),
    sessionInsert: db.prepare('INSERT INTO sessions(agent, session_id, file_path, title, cwd, cwd_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    sessionUpdate: db.prepare('UPDATE sessions SET session_id = ?, title = ?, cwd = ?, cwd_key = ?, created_at = ?, updated_at = ?, message_count = ? WHERE id = ?'),
    sessionDelete: db.prepare('DELETE FROM sessions WHERE id = ?'),
    ftsDelete: db.prepare('DELETE FROM messages_fts WHERE rowid IN (SELECT id FROM messages WHERE session_row_id = ?)'),
    messagesDelete: db.prepare('DELETE FROM messages WHERE session_row_id = ?'),
    messageInsert: db.prepare('INSERT INTO messages(session_row_id, role, ts) VALUES (?, ?, ?)'),
    ftsInsert: db.prepare('INSERT INTO messages_fts(rowid, user_text, assistant_text, tool_text, identifiers) VALUES (?, ?, ?, ?, ?)'),
    sessionCount: db.prepare('SELECT count(*) AS n FROM sessions')
  }
}

// Private to its owner (outside Windows, where the profile's own rights hold):
// a folder only they can open, files only they can read.
function makePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (process.platform === 'win32') return
  try {
    fs.chmodSync(dir, 0o700)
  } catch {
    // not ours to change
  }
}
export function makePrivateFiles(path) {
  if (process.platform === 'win32') return
  for (const suffix of DATABASE_FILES) {
    try {
      if (fs.existsSync(path + suffix)) fs.chmodSync(path + suffix, 0o600)
    } catch {
      // gone meanwhile
    }
  }
}

export function openStore(path) {
  if (path !== ':memory:') makePrivateDir(dirname(path))
  let opened
  try {
    opened = openChecked(path)
  } catch (err) {
    if (path === ':memory:') throw err
    // A cache: removed and built again, once.
    removeDatabase(path)
    opened = openChecked(path)
  }
  if (path !== ':memory:') makePrivateFiles(path)
  const { db, q } = opened
  let purged = 0

  function dropSession(filePath) {
    const s = q.sessionByFile.get(filePath)
    if (!s) return
    q.ftsDelete.run(s.id)
    q.messagesDelete.run(s.id)
    q.sessionDelete.run(s.id)
    purged++
  }

  const store = {
    path,
    close() {
      try {
        db.close()
      } catch {
        // already closed
      }
    },
    transaction(fn) {
      db.exec('BEGIN')
      try {
        const out = fn()
        db.exec('COMMIT')
        return out
      } catch (err) {
        try {
          db.exec('ROLLBACK')
        } catch {
          // nothing open
        }
        throw err
      }
    },
    // After sessions left the index: the file gives their space back (and
    // what they held is not left in it). -> true when it ran.
    compact() {
      if (!purged) return false
      purged = 0
      db.exec('VACUUM')
      return true
    },
    // A file seen by a scan: new or changed -> due. Rewritten (smaller than
    // what was read, or its first bytes not the ones read before: readHead()
    // gives their fingerprint, asked only then): its rows go and it is read
    // again from the start.
    noteFile({ path: file, agent, mtimeMs, size, readHead = null }) {
      const prior = q.fileGet.get(file)
      if (prior && prior.mtime_ms === mtimeMs && prior.size_bytes === size) return false
      if (prior && prior.byte_offset > 0) {
        let rewritten = size < prior.byte_offset
        if (!rewritten && prior.head_hash && typeof readHead === 'function') {
          const head = readHead()
          rewritten = !!head && head !== prior.head_hash
        }
        if (rewritten) {
          dropSession(file)
          q.fileReset.run(file)
        }
      }
      q.fileUpsert.run(file, agent, mtimeMs, size)
      return true
    },
    forgetFile(file) {
      dropSession(file)
      q.fileDelete.run(file)
    },
    knownPaths: () => q.filePaths.all().map((r) => r.path),
    sessionOf: (file) => q.sessionByFile.get(file) || null,
    fileOf: (file) => q.fileGet.get(file) || null,
    nextDue: () => q.nextDue.get() || null,
    fileFailed: (file) => q.fileFail.run(file),
    // Not to be read again (a line without end for too long).
    fileGivenUp: (file) => q.fileFailNow.run(file),
    // One slice of a file: its rows, the session's facts, the new offset.
    // skipped: bytes of one endless line passed over so far (0: none).
    // head: the fingerprint of the file's first bytes (with its first slice).
    addSlice({ file, agent, rows, offset, done, session, skipped = 0, head = null }) {
      let s = q.sessionByFile.get(file)
      const title = indexText(session.title || '')
      if (!s) {
        q.sessionInsert.run(agent, session.id || '', file, title, session.cwd || null, cwdKey(session.cwd), session.createdAt ?? null, session.updatedAt ?? null)
        s = q.sessionByFile.get(file)
      }
      let count = s.message_count
      for (const row of rows) {
        const tool = row.role === 'tool'
        const body = indexText(tool ? String(row.text || '').slice(0, TOOL_TEXT_MAX) : row.text)
        if (!body.trim()) continue
        const id = Number(q.messageInsert.run(s.id, row.role, Number.isFinite(row.ts) ? row.ts : null).lastInsertRowid)
        q.ftsInsert.run(id, row.role === 'user' ? body : '', row.role === 'assistant' ? body : '', tool ? body : '', identifierShadowText(body))
        if (!tool) count++
      }
      q.sessionUpdate.run(
        session.id || s.session_id,
        title || s.title,
        session.cwd || s.cwd,
        cwdKey(session.cwd || s.cwd),
        s.created_at ?? session.createdAt ?? null,
        session.updatedAt ?? s.updated_at,
        count,
        s.id
      )
      q.fileProgress.run(offset, done ? 'current' : 'due', skipped, head, file)
    },
    counts() {
      const c = q.counts.get() || {}
      return { filesIndexed: c.indexed || 0, filesDue: c.due || 0, filesFailed: c.failed || 0, sessions: q.sessionCount.get().n }
    },

    // -> { hits, route, truncated }. scope: { kind: 'all' | 'folder' |
    // 'project', path }, agents: [ids] or null. An empty query lists the
    // newest sessions of the scope. A passage marks its matches with
    // MARK_OPEN and MARK_CLOSE.
    search({ query = '', scope = { kind: 'all' }, agents = null, limit = 20 } = {}) {
      limit = Number.isInteger(limit) ? Math.max(1, Math.min(100, limit)) : 20
      const conditions = []
      const values = []
      const key = cwdKey(scope && scope.path)
      if (scope && scope.kind === 'folder' && key) {
        conditions.push('cwd_key = ?')
        values.push(key)
      } else if (scope && scope.kind === 'project' && key) {
        // The folder and everything under it (LIKE wildcards in the path escaped).
        conditions.push("(cwd_key = ? OR cwd_key LIKE ? ESCAPE '\\')") // i18n-ignore
        values.push(key, key.replace(/[\\%_]/g, '\\$&') + '/%')
      }
      if (Array.isArray(agents) && agents.length) {
        conditions.push(`agent IN (${agents.map(() => '?').join(',')})`)
        values.push(...agents.map(String))
      }
      const plan = planQuery(String(query).slice(0, 2000))
      if (!plan.phrase.length) {
        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
        const rows = db.prepare(`SELECT * FROM sessions ${where} ORDER BY updated_at DESC, id DESC LIMIT ?`).all(...values, limit + 1)
        return { hits: rows.slice(0, limit).map((s) => hitOf(s, null)).filter(Boolean), route: 'recent', truncated: rows.length > limit }
      }
      const eligible = conditions.length ? ` AND m.session_row_id IN (SELECT id FROM sessions WHERE ${conditions.join(' AND ')})` : ''
      // One row per session (its best), before the limit: a long session
      // cannot fill the page. Weights: user 3, assistant 2, tool 1, identifiers 1.
      const sql = `WITH matched AS MATERIALIZED (
          SELECT messages_fts.rowid AS rowid, -bm25(messages_fts, 3.0, 2.0, 1.0, 1.0) AS score, m.session_row_id, m.role, m.ts
          FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid
          WHERE messages_fts MATCH ?${eligible})
        SELECT rowid, max(score) AS score, session_row_id, role, ts FROM matched
        GROUP BY session_row_id ORDER BY score DESC LIMIT ?` // i18n-ignore
      const match = (expression) => {
        try {
          return db.prepare(sql).all(expression, ...values, limit + 1)
        } catch (err) {
          if (isCorruption(err)) throw err
          return [] // an expression FTS5 refuses: no match, never an error
        }
      }
      // The ladder: the words in order, then all of them, then any of them.
      let route = 'phrase'
      let expression = phraseExpression(plan.phrase)
      let rows = plan.phrase.length >= 2 || plan.literal ? match(expression) : []
      if (!rows.length && plan.phrase.length >= 2) {
        route = 'and'
        expression = andExpression(plan.phrase)
        rows = match(expression)
      }
      if (!rows.length) {
        route = 'or'
        expression = orExpression(plan.terms)
        rows = match(expression)
      }
      // From the row's own text column (never the split identifiers).
      const column = { user: 0, assistant: 1, tool: 2 }
      const snippets = [0, 1, 2].map((c) => db.prepare(`SELECT snippet(messages_fts, ${c}, ?, ?, '…', 28) AS s FROM messages_fts WHERE messages_fts MATCH ? AND rowid = ?`))
      const session = db.prepare('SELECT * FROM sessions WHERE id = ?')
      const hits = []
      for (const row of rows.slice(0, limit)) {
        const s = session.get(row.session_row_id)
        if (!s) continue
        let text = ''
        try {
          text = snippets[column[row.role] ?? 1].get(MARK_OPEN, MARK_CLOSE, expression, row.rowid)?.s || ''
        } catch {
          text = ''
        }
        const hit = hitOf(s, { snippet: text, role: row.role, ts: row.ts })
        if (hit) hits.push(hit)
      }
      return { hits, route, truncated: rows.length > limit || plan.truncated }
    }
  }
  return store
}

// A result, or null for a row no resume could take (an agent Tessel does not
// know, a session id of another shape): the database is never trusted to
// name what the window will run.
function hitOf(s, evidence) {
  if (!KNOWN_AGENTS.has(s.agent) || !safeSessionId(s.session_id)) return null
  return {
    agent: s.agent,
    sessionId: s.session_id,
    title: s.title,
    cwd: s.cwd || '',
    updatedAt: s.updated_at || null,
    messageCount: s.message_count,
    evidence
  }
}
