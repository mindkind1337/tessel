// @vitest-environment node
// Synthetic OpenCode databases only (built here in a temp folder).
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import {
  createOpencodeUsageReport,
  listOpencodeDatabases,
  parseOpencodeUsageRow,
  opencodeDataDir
} from '../opencodeUsageReport'

const sqlite = process.getBuiltinModule?.('node:sqlite')
const DAY = Date.parse('2026-09-20T12:00:00Z')
const NOW = Date.parse('2026-09-28T12:00:00Z')
const dirs = []
function tempDir() {
  const d = fs.mkdtempSync(join(os.tmpdir(), 'tessel-oc-usage-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})
function makeDb(file, sql) {
  const db = new sqlite.DatabaseSync(file)
  db.exec(sql)
  db.close()
}
const report = (dataDir, env = {}) =>
  createOpencodeUsageReport({ dataDir, env, now: () => NOW, timezone: 'UTC' })

const messageSchema = `
  CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
  CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, directory TEXT, title TEXT,
    time_created INTEGER, time_updated INTEGER);
  CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER,
    time_updated INTEGER, data TEXT);`
const reply = (tokens, extra = {}) =>
  JSON.stringify({
    role: 'assistant',
    modelID: 'fixture-model',
    providerID: 'fixture',
    time: { created: DAY, completed: DAY + 1000 },
    tokens,
    ...extra
  })

describe('OpenCode usage report (local databases)', () => {
  it.skipIf(!sqlite)('adds up assistant replies by day, model, project and session', async () => {
    const dir = tempDir()
    makeDb(
      join(dir, 'opencode.db'),
      `${messageSchema}
       INSERT INTO project VALUES ('p1', '/work/alpha');
       INSERT INTO session VALUES ('ses_a1', 'p1', '/work/alpha', 'Fix the parser', ${DAY}, ${DAY});
       INSERT INTO message VALUES ('m1', 'ses_a1', ${DAY}, ${DAY},
         '${reply({ input: 100, output: 20, reasoning: 5, cache: { read: 300, write: 10 } }, { cost: 0.5 })}');
       INSERT INTO message VALUES ('m2', 'ses_a1', ${DAY + 1}, ${DAY + 1},
         '${reply({ input: 50, output: 10, reasoning: 0, cache: { read: 0, write: 0 } })}');
       INSERT INTO message VALUES ('m3', 'ses_a1', ${DAY + 2}, ${DAY + 2},
         '{"role":"user","tokens":{"input":999}}');`
    )
    const r = await report(dir)({ from: null, to: null })
    expect(r).toMatchObject({ ok: true, provider: 'opencode', files: 1 })
    expect(r.totals).toMatchObject({
      turns: 2,
      input: 150,
      output: 30,
      reasoning: 5,
      cacheRead: 300,
      cacheWrite: 10,
      cost: 0.5,
      unpriced: 1,
      sessions: 1
    })
    expect(r.byDay.map((d) => d.day)).toEqual(['2026-09-20'])
    expect(r.byModel[0].model).toBe('fixture/fixture-model')
    expect(r.byProject[0]).toMatchObject({ cwd: '/work/alpha', label: 'alpha', sessions: 1 })
    expect(r.sessions[0]).toMatchObject({ id: 'ses_a1', title: 'Fix the parser' })
  })

  it.skipIf(!sqlite)('reads session totals once across session and session_v2', async () => {
    const dir = tempDir()
    const cols = `id TEXT PRIMARY KEY, project_id TEXT, directory TEXT, title TEXT, model TEXT,
      time_created INTEGER, time_updated INTEGER, cost REAL, tokens_input INTEGER, tokens_output INTEGER,
      tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER`
    makeDb(
      join(dir, 'opencode.db'),
      `CREATE TABLE session (${cols}); CREATE TABLE session_v2 (${cols});
       INSERT INTO session VALUES ('ses_old', NULL, '/work/old', 'Old title', NULL, ${DAY}, ${DAY}, 1.0, 100, 10, 0, 0, 0);
       INSERT INTO session_v2 VALUES ('ses_old', NULL, '/work/old', 'New title', '{"providerID":"p","modelID":"m"}', ${DAY}, ${DAY}, 0.5, 200, 10, 0, 0, 0);
       INSERT INTO session_v2 VALUES ('ses_new', NULL, '/work/new', 'Other', NULL, ${DAY}, ${DAY}, 0, 7, 3, 0, 0, 0);`
    )
    const r = await report(dir)({ from: null, to: null })
    expect(r.totals).toMatchObject({ turns: 2, input: 207, output: 13, sessions: 2 })
    // Each column's larger value: the legacy row's cost, the live row's tokens.
    expect(r.totals.cost).toBe(1)
    expect(r.sessions.find((s) => s.id === 'ses_old')).toMatchObject({ title: 'New title', model: 'p/m' })
  })

  it.skipIf(!sqlite)('counts a session copied into a sibling database only once', async () => {
    const dir = tempDir()
    const one = `${messageSchema}
      INSERT INTO session VALUES ('ses_dup', NULL, '/work/a', 't', ${DAY}, ${DAY});
      INSERT INTO message VALUES ('m1', 'ses_dup', ${DAY}, ${DAY}, '${reply({ input: 10, output: 1 })}');`
    makeDb(join(dir, 'opencode.db'), one)
    makeDb(join(dir, 'opencode-backup.db'), one)
    fs.writeFileSync(join(dir, 'notes.db'), 'not opencode')
    const r = await report(dir)({ from: null, to: null })
    expect(r.files).toBe(2)
    expect(r.totals).toMatchObject({ turns: 1, input: 10 })
  })

  it.skipIf(!sqlite)('filters by date range and Tessel worktrees', async () => {
    const dir = tempDir()
    makeDb(
      join(dir, 'opencode.db'),
      `${messageSchema}
       INSERT INTO session VALUES ('ses_in', NULL, '/work/tessel/a', 't', ${DAY}, ${DAY});
       INSERT INTO session VALUES ('ses_out', NULL, '/elsewhere', 't', ${DAY}, ${DAY});
       INSERT INTO message VALUES ('m1', 'ses_in', ${DAY}, ${DAY}, '${reply({ input: 10, output: 1 })}');
       INSERT INTO message VALUES ('m2', 'ses_out', ${DAY}, ${DAY}, '${reply({ input: 20, output: 2 })}');`
    )
    const read = report(dir)
    expect((await read({ roots: ['/work/tessel'] })).totals.input).toBe(10)
    expect((await read({ from: '2026-09-25', to: '2026-09-28' })).totals.turns).toBe(0)
    expect((await read({ from: null, to: null })).allTotals.input).toBe(30)
    await expect(read({ from: 'yesterday' })).rejects.toThrow()
  })

  it('finds no database without an OpenCode data folder, or with an in-memory one', async () => {
    const dir = tempDir()
    expect(listOpencodeDatabases(join(dir, 'missing'), {})).toEqual([])
    expect(listOpencodeDatabases(dir, { OPENCODE_DB: ':memory:' })).toEqual([])
    const r = await report(join(dir, 'missing'))({})
    expect(r).toMatchObject({ ok: true, files: 0, totals: { turns: 0 } })
    expect(opencodeDataDir('/home/u', { XDG_DATA_HOME: '/data' })).toBe(join('/data', 'opencode'))
  })

  it('ignores rows without usage or time', () => {
    expect(parseOpencodeUsageRow({ session_id: 's', data: '{"tokens":{}}' })).toBe(null)
    expect(parseOpencodeUsageRow({ session_id: 's', data: 'not json' })).toBe(null)
    expect(parseOpencodeUsageRow({ session_id: 's', data: '{"tokens":{"input":5}}' })).toBe(null)
    expect(
      parseOpencodeUsageRow({ session_id: 's', time_created: 1790000000, data: '{"tokens":{"input":5}}' })
    ).toMatchObject({ input: 5, time: 1790000000000, cost: null })
  })
})
