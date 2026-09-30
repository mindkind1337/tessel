// The session search index: a SQLite database (node:sqlite, FTS5) holding a
// copy of what was said in the agents' conversations, so it can be searched.
// A cache over the agents' own files, never a source: a database that cannot
// be trusted (another schema version, a torn file) is removed and built again.
// Local only (Tessel's data folder); nothing here is ever sent anywhere.
// After Orca's src/main/ai-vault-search (session-search-schema.ts,
// session-search-retrieval.ts, session-search-store.ts), MIT, Copyright (c)
// 2026 Lovecast Inc.
import fs from 'fs'
import { dirname } from 'path'
import { andExpression, identifierShadowText, orExpression, phraseExpression, planQuery } from './query.js'

export const SCHEMA_VERSION = 1
// Tool output beyond this many characters per row is not indexed.
export const TOOL_TEXT_MAX = 3072

// unicode61 keeps `_ . - / +` inside tokens, so paths and identifiers match
// exactly; the identifiers column carries their split form.
const TOKENIZER = `tokenize="unicode61 tokenchars '_.-/+'"` // i18n-ignore

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

export function removeDatabase(path) {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try {
      fs.rmSync(path + suffix, { force: true })
    } catch {
      // held by another process: the next open decides
    }
  }
}

function openRaw(path) {
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;') // i18n-ignore
  } catch (err) {
    // Not a database: the handle must go before the file can be removed.
    db.close()
    throw err
  }
  return db
}

// Folder keys compare folders whatever their case or slashes.
export function cwdKey(cwd) {
  const s = typeof cwd === 'string' ? cwd.trim() : ''
  return s ? s.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() : null
}

export function openStore(path) {
  if (path !== ':memory:') fs.mkdirSync(dirname(path), { recursive: true })
  let db
  const fresh = () => {
    db = openRaw(path)
    db.exec(SCHEMA_SQL)
    db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION))
  }
  try {
    db = openRaw(path)
    let version = null
    try {
      version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value ?? null
    } catch {
      version = null // no meta table yet
    }
    if (version !== null && version !== String(SCHEMA_VERSION)) {
      db.close()
      removeDatabase(path)
      fresh()
    } else {
      db.exec(SCHEMA_SQL)
      db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION))
    }
  } catch {
    // A file SQLite cannot use: a cache, so it is built again.
    try {
      db?.close()
    } catch {
      // already closed
    }
    removeDatabase(path)
    fresh()
  }

  const q = {
    fileGet: db.prepare('SELECT * FROM files WHERE path = ?'),
    fileUpsert: db.prepare(
      `INSERT INTO files(path, agent, mtime_ms, size_bytes, state) VALUES (?, ?, ?, ?, 'due')
       ON CONFLICT(path) DO UPDATE SET mtime_ms = excluded.mtime_ms, size_bytes = excluded.size_bytes, state = 'due', fail_count = 0`
    ),
    fileReset: db.prepare("UPDATE files SET byte_offset = 0, state = 'due', fail_count = 0 WHERE path = ?"),
    fileProgress: db.prepare('UPDATE files SET byte_offset = ?, state = ? WHERE path = ?'),
    fileFail: db.prepare("UPDATE files SET fail_count = fail_count + 1, state = CASE WHEN fail_count >= 2 THEN 'failed' ELSE 'due' END WHERE path = ?"),
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

  function dropSession(filePath) {
    const s = q.sessionByFile.get(filePath)
    if (!s) return
    q.ftsDelete.run(s.id)
    q.messagesDelete.run(s.id)
    q.sessionDelete.run(s.id)
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
    // A file seen by a scan: new or changed -> due. Smaller than what was
    // read (rewritten): its rows go and it is read again from the start.
    noteFile({ path: file, agent, mtimeMs, size }) {
      const prior = q.fileGet.get(file)
      if (prior && prior.mtime_ms === mtimeMs && prior.size_bytes === size) return false
      if (prior && size < prior.byte_offset) {
        dropSession(file)
        q.fileReset.run(file)
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
    nextDue: () => q.nextDue.get() || null,
    fileFailed: (file) => q.fileFail.run(file),
    // One slice of a file: its rows, the session's facts, the new offset.
    addSlice({ file, agent, rows, offset, done, session }) {
      let s = q.sessionByFile.get(file)
      if (!s) {
        q.sessionInsert.run(agent, session.id || '', file, session.title || '', session.cwd || null, cwdKey(session.cwd), session.createdAt ?? null, session.updatedAt ?? null)
        s = q.sessionByFile.get(file)
      }
      let count = s.message_count
      for (const row of rows) {
        const text = String(row.text || '')
        if (!text.trim()) continue
        const tool = row.role === 'tool'
        const body = tool ? text.slice(0, TOOL_TEXT_MAX) : text
        const id = Number(q.messageInsert.run(s.id, row.role, Number.isFinite(row.ts) ? row.ts : null).lastInsertRowid)
        q.ftsInsert.run(id, row.role === 'user' ? body : '', row.role === 'assistant' ? body : '', tool ? body : '', identifierShadowText(body))
        if (!tool) count++
      }
      q.sessionUpdate.run(
        session.id || s.session_id,
        session.title || s.title,
        session.cwd || s.cwd,
        cwdKey(session.cwd || s.cwd),
        s.created_at ?? session.createdAt ?? null,
        session.updatedAt ?? s.updated_at,
        count,
        s.id
      )
      q.fileProgress.run(offset, done ? 'current' : 'due', file)
    },
    counts() {
      const c = q.counts.get() || {}
      return { filesIndexed: c.indexed || 0, filesDue: c.due || 0, filesFailed: c.failed || 0, sessions: q.sessionCount.get().n }
    },

    // -> { hits, route, truncated }. scope: { kind: 'all' | 'folder' |
    // 'project', path }, agents: [ids] or null. An empty query lists the
    // newest sessions of the scope.
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
        return { hits: rows.slice(0, limit).map((s) => hitOf(s, null)), route: 'recent', truncated: rows.length > limit }
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
        } catch {
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
      const snippets = [0, 1, 2].map((c) => db.prepare(`SELECT snippet(messages_fts, ${c}, '[[', ']]', '…', 28) AS s FROM messages_fts WHERE messages_fts MATCH ? AND rowid = ?`))
      const session = db.prepare('SELECT * FROM sessions WHERE id = ?')
      const hits = []
      for (const row of rows.slice(0, limit)) {
        const s = session.get(row.session_row_id)
        if (!s) continue
        let text = ''
        try {
          text = snippets[column[row.role] ?? 1].get(expression, row.rowid)?.s || ''
        } catch {
          text = ''
        }
        hits.push(hitOf(s, { snippet: text, role: row.role, ts: row.ts }))
      }
      return { hits, route, truncated: rows.length > limit || plan.truncated }
    }
  }
  return store
}

function hitOf(s, evidence) {
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
