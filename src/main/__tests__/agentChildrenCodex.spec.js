// @vitest-environment node
// Sub-agents of a Codex conversation (spawn_agent threads' rollouts), an
// OpenCode one (child sessions) and a Cline one, read from fixtures only.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import {
  codexSubagents,
  parseCodexHead,
  summarizeCodexTail,
  summarizeTail,
  uuidTime,
  opencodeSubagents,
  summarizeOpencodeMessage,
  clineSubagents,
  _clearCodexCacheForTest
} from '../agentChildren'

const line = (o) => JSON.stringify(o)
const iso = (ms) => new Date(ms).toISOString()
// A UUID v7 made at `ms` (its first 48 bits), like Codex's thread ids.
function v7(ms, tail) {
  const h = ms.toString(16).padStart(12, '0')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-7000-8000-${String(tail).padStart(12, '0')}`
}
const two = (n) => String(n).padStart(2, '0')
function dayDir(home, ms) {
  const d = new Date(ms)
  return join(home, 'sessions', String(d.getFullYear()), two(d.getMonth() + 1), two(d.getDate()))
}
function rollout(home, id, startMs, rows, mtime) {
  const dir = dayDir(home, startMs)
  fs.mkdirSync(dir, { recursive: true })
  const d = new Date(startMs)
  const file = join(dir, `rollout-${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T10-00-00-${id}.jsonl`)
  fs.writeFileSync(file, rows.map(line).join('\n') + '\n')
  if (mtime) fs.utimesSync(file, new Date(mtime), new Date(mtime))
  return file
}
function childMeta(id, root, parent, startMs, { nickname = 'Hubble', path = '/root/accounts_ui', role = null } = {}) {
  return {
    type: 'session_meta',
    timestamp: iso(startMs),
    payload: {
      id,
      session_id: root,
      parent_thread_id: parent,
      timestamp: iso(startMs),
      source: { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1, agent_path: path, agent_nickname: nickname, agent_role: role } } },
      thread_source: 'subagent',
      agent_nickname: nickname,
      agent_path: path,
      base_instructions: { text: 'x'.repeat(30000) }
    }
  }
}
const ev = (ms, payload) => ({ type: 'event_msg', timestamp: iso(ms), payload })
const tokens = (ms, total) => ev(ms, { type: 'token_count', info: { last_token_usage: { input_tokens: total - 10, output_tokens: 10, total_tokens: total } } })
const ctx = (ms, model) => ({ type: 'turn_context', timestamp: iso(ms), payload: { model, effort: 'high' } })

describe("a Codex conversation's sub-agents", () => {
  let home
  const now = Date.now()
  const born = now - 60 * 60000
  const P = v7(born, 1)
  beforeEach(() => {
    _clearCodexCacheForTest()
    home = fs.mkdtempSync(join(os.tmpdir(), 'tessel-codexkids-'))
    // The conversation itself (not a child).
    rollout(home, P, born, [{ type: 'session_meta', timestamp: iso(born), payload: { id: P, session_id: P, thread_source: 'user', source: 'cli' } }])
  })
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

  it('reads the time a UUID v7 was made', () => {
    expect(uuidTime(P)).toBe(born)
    expect(uuidTime('11111111-2222-4333-8444-555555555555')).toBe(null)
  })

  it('lists running, done and quiet ones with type, title, tokens and model', () => {
    const run = v7(now - 5 * 60000, 2)
    rollout(home, run, now - 5 * 60000, [
      childMeta(run, P, P, now - 5 * 60000, { role: 'explorer', nickname: 'Boole', path: '/root/cli_research' }),
      ctx(now - 5 * 60000, 'gpt-6-astra'),
      ev(now - 5 * 60000, { type: 'task_started' }),
      tokens(now - 60000, 4200)
    ])
    const done = v7(now - 20 * 60000, 3)
    rollout(home, done, now - 20 * 60000, [
      childMeta(done, P, P, now - 20 * 60000),
      { type: 'event_msg', timestamp: iso(now - 20 * 60000), payload: { type: 'thread_settings_applied', thread_settings: { model: 'gpt-5.5-codex' } } },
      ev(now - 20 * 60000, { type: 'task_started' }),
      tokens(now - 11 * 60000, 900),
      ev(now - 10 * 60000, { type: 'task_complete' })
    ])
    const quiet = v7(now - 40 * 60000, 4)
    rollout(
      home,
      quiet,
      now - 40 * 60000,
      [childMeta(quiet, P, P, now - 40 * 60000, { nickname: 'Hume', path: '/root/slow' }), ev(now - 30 * 60000, { type: 'task_started' })],
      now - 30 * 60000
    )
    // A child of that child: same conversation (session_id), listed too.
    const nested = v7(now - 2 * 60000, 5)
    rollout(home, nested, now - 2 * 60000, [
      childMeta(nested, P, run, now - 2 * 60000, { nickname: 'Kant', path: '/root/cli_research/deep' }),
      ev(now - 2 * 60000, { type: 'task_started' }),
      ev(now - 60000, { type: 'turn_aborted' })
    ])
    // Another conversation's child: not listed.
    const other = v7(born + 1000, 9)
    const foreign = v7(now - 3 * 60000, 6)
    rollout(home, foreign, now - 3 * 60000, [childMeta(foreign, other, other, now - 3 * 60000), ev(now - 3 * 60000, { type: 'task_started' })])

    const list = codexSubagents(P, home, now)
    expect(list.map((c) => [c.id, c.type, c.title, c.state, c.tokens, c.model])).toEqual([
      [nested, 'default', 'deep (Kant)', 'done', null, null],
      [run, 'explorer', 'cli_research (Boole)', 'running', 4200, 'gpt-6-astra'],
      [done, 'default', 'accounts_ui (Hubble)', 'done', 900, 'gpt-5.5-codex'],
      [quiet, 'default', 'slow (Hume)', 'quiet', null, null]
    ])
    const d = list.find((c) => c.id === done)
    expect(d.startedAt).toBe(now - 20 * 60000)
    expect(d.endedAt).toBe(now - 10 * 60000)
    const q = list.find((c) => c.id === quiet)
    expect(q.endedAt).toBe(null)
    expect(q.lastAt).toBe(now - 30 * 60000)
    // Upper case ids and bad ids.
    expect(codexSubagents(P.toUpperCase(), home, now).length).toBe(4)
    expect(codexSubagents('not-an-id', home, now)).toEqual([])
    expect(codexSubagents(v7(now - 1000, 7), home, now)).toEqual([])
  })

  it('the model from the start of the rollout when its end has none (a forked one: its own settings last)', () => {
    const text =
      [
        line(childMeta('c', P, P, now)),
        line(ctx(now, 'parent-model')),
        line({ type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { model: 'child-model' } } })
      ].join('\n') + '\n{"type":"turn_con'
    expect(parseCodexHead(text)).toMatchObject({ child: true, root: P, parent: P, nickname: 'Hubble', path: '/root/accounts_ui', role: null, model: 'child-model' })
    expect(parseCodexHead('{"type":"session_meta","payload":{"id":"x"')).toBe(null) // first line not written yet
    expect(parseCodexHead(line({ type: 'session_meta', payload: { id: 'x', thread_source: 'user' } }) + '\n')).toEqual({ child: false })
  })

  it('reads a turn from its end: started, completed, aborted', () => {
    const t0 = Date.parse('2026-09-28T10:00:00Z')
    expect(summarizeCodexTail([line(ev(t0, { type: 'task_complete' })), line(ev(t0 + 1000, { type: 'task_started' }))])).toMatchObject({ done: false, last: t0 + 1000 })
    expect(summarizeCodexTail([line(ev(t0, { type: 'task_started' })), line(tokens(t0 + 500, 77)), line(ev(t0 + 1000, { type: 'task_complete' }))])).toEqual({ done: true, last: t0 + 1000, tokens: 77, model: null })
    expect(summarizeCodexTail(['{broken', line(ev(t0, { type: 'turn_aborted' }))]).done).toBe(true)
  })

  it('reads in the account home it is given (another CODEX_HOME sees nothing)', () => {
    const c = v7(now - 60000, 2)
    rollout(home, c, now - 60000, [childMeta(c, P, P, now - 60000), ev(now - 60000, { type: 'task_started' })])
    const otherHome = fs.mkdtempSync(join(os.tmpdir(), 'tessel-codexkids-other-'))
    try {
      expect(codexSubagents(P, home, now).map((x) => x.id)).toEqual([c])
      expect(codexSubagents(P, otherHome, now)).toEqual([])
    } finally {
      fs.rmSync(otherHome, { recursive: true, force: true })
    }
  })

  describe('never reads outside the Codex home through a link or junction', () => {
    let outside
    beforeEach(() => {
      outside = fs.mkdtempSync(join(os.tmpdir(), 'tessel-codexkids-outside-'))
      const c = v7(now - 60000, 8)
      rollout(outside, c, now - 60000, [childMeta(c, P, P, now - 60000), ev(now - 60000, { type: 'task_started' })])
    })
    afterEach(() => fs.rmSync(outside, { recursive: true, force: true }))

    it('a junction for the sessions folder', () => {
      fs.rmSync(join(home, 'sessions'), { recursive: true, force: true })
      fs.symlinkSync(join(outside, 'sessions'), join(home, 'sessions'), 'junction')
      expect(codexSubagents(P, home, now)).toEqual([])
    })

    it('a junction for a day folder', () => {
      const day = dayDir(home, now - 60000)
      fs.rmSync(day, { recursive: true, force: true })
      fs.mkdirSync(join(day, '..'), { recursive: true })
      fs.symlinkSync(dayDir(outside, now - 60000), day, 'junction')
      expect(codexSubagents(P, home, now)).toEqual([])
    })
  })
})

describe('the model of a Claude Code sub-agent', () => {
  it('comes from its last assistant message (not a synthetic one)', () => {
    const a = (model) => line({ type: 'assistant', timestamp: '2026-09-28T10:00:00Z', message: { model, stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } })
    expect(summarizeTail([a('claude-opus-5-5'), a('<synthetic>')]).model).toBe('claude-opus-5-5')
    expect(summarizeTail([a('claude-sonnet-5')]).model).toBe('claude-sonnet-5')
    expect(summarizeTail([line({ type: 'user', timestamp: '2026-09-28T10:00:00Z' })]).model).toBe(null)
  })
})

const sqlite = process.getBuiltinModule && process.getBuiltinModule('node:sqlite')

describe.skipIf(!sqlite)('database agents', () => {
  let dir
  beforeEach(() => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-dbkids-'))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('OpenCode: child sessions, done when the last reply finished without asking for tools', () => {
    const now = Date.now()
    fs.mkdirSync(join(dir, 'opencode'))
    const db = new sqlite.DatabaseSync(join(dir, 'opencode', 'opencode.db'))
    db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT NOT NULL, agent TEXT, model TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);`)
    const ses = db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?)')
    const msg = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)')
    ses.run('ses_parent01', null, 'Parent', 'build', null, now - 600000, now)
    ses.run('ses_child001', 'ses_parent01', 'Find the bug (@explore subagent)', 'explore', null, now - 300000, now - 5000)
    msg.run('m1', 'ses_child001', now - 290000, now - 290000, JSON.stringify({ role: 'user', time: { created: now - 290000 } }))
    msg.run('m2', 'ses_child001', now - 280000, now - 5000, JSON.stringify({ role: 'assistant', time: { created: now - 280000, completed: now - 5000 }, finish: 'tool-calls', modelID: 'mimo-v2.6-flash-free', tokens: { input: 100, output: 20, cache: { read: 1000, write: 0 } } }))
    ses.run('ses_child002', 'ses_parent01', 'Write the tests', 'general', '{"providerID":"x","modelID":"big-model"}', now - 200000, now - 100000)
    msg.run('m3', 'ses_child002', now - 150000, now - 100000, JSON.stringify({ role: 'assistant', time: { created: now - 150000, completed: now - 100000 }, finish: 'stop', tokens: { input: 5, output: 5, cache: { read: 0, write: 0 } } }))
    ses.run('ses_other001', 'ses_someone', 'Not mine', 'general', null, now - 1000, now - 1000)
    db.close()
    const list = opencodeSubagents('ses_parent01', dir, now)
    expect(list.map((c) => [c.id, c.type, c.title, c.state, c.tokens, c.model])).toEqual([
      ['ses_child002', 'general', 'Write the tests', 'done', 10, 'big-model'],
      ['ses_child001', 'explore', 'Find the bug (@explore subagent)', 'running', 1120, 'mimo-v2.6-flash-free']
    ])
    expect(list[0].endedAt).toBe(now - 100000)
    expect(opencodeSubagents('bad id!', dir, now)).toEqual([])
    expect(opencodeSubagents('ses_parent01', join(dir, 'nowhere'), now)).toEqual([])
    expect(summarizeOpencodeMessage('{bad')).toEqual({ done: false, endedAt: null, tokens: null, model: null })
    expect(summarizeOpencodeMessage({ role: 'assistant', error: { name: 'x' }, time: { created: 1 } }).done).toBe(true)
  })

  it('OpenCode: a database folder reached through a junction is not read', () => {
    const outside = fs.mkdtempSync(join(os.tmpdir(), 'tessel-dbkids-outside-'))
    try {
      const db = new sqlite.DatabaseSync(join(outside, 'opencode.db'))
      db.exec('CREATE TABLE session (id TEXT, parent_id TEXT, title TEXT, agent TEXT, model TEXT, time_created INTEGER, time_updated INTEGER); CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);')
      db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?)').run('ses_child001', 'ses_parent01', 'OUTSIDE', 'x', null, 1, 1)
      db.close()
      fs.symlinkSync(outside, join(dir, 'opencode'), 'junction')
      expect(opencodeSubagents('ses_parent01', dir, Date.now())).toEqual([])
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('Cline: sessions whose parent is the conversation', () => {
    const now = Date.now()
    fs.mkdirSync(join(dir, 'db'))
    const db = new sqlite.DatabaseSync(join(dir, 'db', 'sessions.db'))
    db.exec('CREATE TABLE sessions (session_id TEXT PRIMARY KEY, status TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, updated_at TEXT NOT NULL, model TEXT NOT NULL, prompt TEXT, parent_session_id TEXT, is_subagent INTEGER NOT NULL DEFAULT 0)')
    const add = db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    add.run('root_session', 'running', iso(now - 600000), null, iso(now), 'm', 'root', null, 0)
    add.run('kid_one_1', 'running', iso(now - 60000), null, iso(now - 1000), 'claude-sonnet-5', 'Check the logs\nmore', 'root_session', 1)
    add.run('kid_two_2', 'completed', iso(now - 500000), iso(now - 400000), iso(now - 400000), 'gpt-5', 'Old task', 'root_session', 1)
    add.run('kid_slow_3', 'running', iso(now - 3600000), null, iso(now - 20 * 60000), 'm', 'Slow', 'root_session', 1)
    db.close()
    const list = clineSubagents('root_session', dir, now)
    expect(list.map((c) => [c.id, c.title, c.state, c.model])).toEqual([
      ['kid_one_1', 'Check the logs', 'running', 'claude-sonnet-5'],
      ['kid_two_2', 'Old task', 'done', 'gpt-5'],
      ['kid_slow_3', 'Slow', 'quiet', 'm']
    ])
    expect(list[1].endedAt).toBe(now - 400000)
    expect(clineSubagents('root_session', null, now)).toEqual([])
  })
})
