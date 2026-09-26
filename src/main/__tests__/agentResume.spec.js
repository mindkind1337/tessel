// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { pickSession, isSessionId, geminiSessionExists, findAgentSession } from '../agentResume'

const G = '6f1d0780-1111-4222-8333-444455556666'
let home
const saved = {}
beforeEach(() => {
  home = fs.mkdtempSync(join(os.tmpdir(), 'tessel-resume-'))
  for (const k of ['XDG_DATA_HOME', 'CLINE_DIR', 'CLINE_DATA_DIR']) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
})
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
  for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v
})
const put = (rel, text) => {
  const f = join(home, rel)
  fs.mkdirSync(join(f, '..'), { recursive: true })
  fs.writeFileSync(f, text)
  return f
}
const sqlite = process.getBuiltinModule && process.getBuiltinModule('node:sqlite')

describe('which session a pane started', () => {
  const T = Date.parse('2026-09-26T20:00:00Z')
  const list = [
    { id: 'ses_old', cwd: 'C:/Proj', time: T - 3600e3, updated: T },
    { id: 'ses_first', cwd: 'C:/Proj', time: T + 10e3, updated: T + 20e3 },
    { id: 'ses_second', cwd: 'C:\\Proj\\', time: T + 30e3, updated: T + 40e3 },
    { id: 'ses_other', cwd: 'C:/Else', time: T + 5e3, updated: T + 6e3 },
    { id: 'bad id; rm -rf', cwd: 'C:/Proj', time: T + 1e3, updated: T + 1e3 }
  ]
  it('the first one in its folder since it started, not one another pane has', () => {
    expect(pickSession(list, { cwd: 'C:\\Proj', since: T })).toBe('ses_first')
    expect(pickSession(list, { cwd: 'C:\\Proj', since: T, exclude: ['ses_first'] })).toBe('ses_second')
    expect(pickSession(list, { cwd: 'C:\\Proj', since: T, latest: true })).toBe('ses_second')
    expect(pickSession(list, { cwd: 'C:\\Nowhere', since: T })).toBe(null)
  })
  it('never an id a shell could misread', () => {
    expect(isSessionId('ses_f21da30aaffelTqHWQKl0BP8Jq')).toBe(true)
    expect(isSessionId('1790450764736_xww6d')).toBe(true)
    expect(isSessionId('bad id; rm -rf')).toBe(false)
    expect(isSessionId('a&b')).toBe(false)
  })
})

describe('Gemini', () => {
  it('there is something to resume only once its file exists, with the whole id', () => {
    expect(geminiSessionExists(G, home)).toBe(false)
    put(`.gemini/tmp/proj/chats/session-2026-09-26T20-00-${G.slice(0, 8)}.jsonl`, `{"sessionId":"6f1d0780-9999-4222-8333-444455556666"}\n`)
    expect(geminiSessionExists(G, home)).toBe(false) // same first 8, another id
    put(`.gemini/tmp/proj/chats/session-2026-09-26T20-01-${G.slice(0, 8)}.jsonl`, `{"sessionId":"${G}"}\n`)
    expect(geminiSessionExists(G, home)).toBe(true)
    expect(geminiSessionExists('not-a-uuid', home)).toBe(false)
  })
})

describe('found after start', () => {
  const T = Date.now() - 60e3
  it('Copilot: from session-state/<id>/events.jsonl', () => {
    const start = (id, cwd, at) =>
      put(`.copilot/session-state/${id}/events.jsonl`, JSON.stringify({ type: 'session.start', data: { sessionId: id, startTime: new Date(at).toISOString(), context: { cwd } } }) + '\n')
    start('11111111-aaaa-4bbb-8ccc-000000000001', 'C:\\Proj', T - 3600e3)
    start('11111111-aaaa-4bbb-8ccc-000000000002', 'C:\\Proj', T + 5e3)
    expect(findAgentSession({ agent: 'copilot', cwd: 'C:/Proj', since: T }, home)).toBe('11111111-aaaa-4bbb-8ccc-000000000002')
  })

  it.skipIf(!sqlite)('OpenCode and Cline: from their databases', () => {
    fs.mkdirSync(join(home, '.local/share/opencode'), { recursive: true })
    let db = new sqlite.DatabaseSync(join(home, '.local/share/opencode/opencode.db'))
    db.exec('CREATE TABLE session (id TEXT, parent_id TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER)')
    const ins = db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?)')
    ins.run('ses_before', null, 'C:/Proj', T - 600e3, T - 500e3)
    ins.run('ses_child', 'ses_mine', 'C:/Proj', T + 2e3, T + 3e3)
    ins.run('ses_mine', null, 'C:/Proj', T + 4e3, T + 9e3)
    db.close()
    expect(findAgentSession({ agent: 'opencode', cwd: 'C:\\Proj', since: T }, home)).toBe('ses_mine')

    fs.mkdirSync(join(home, '.cline/data/db'), { recursive: true })
    db = new sqlite.DatabaseSync(join(home, '.cline/data/db/sessions.db'))
    db.exec('CREATE TABLE sessions (session_id TEXT, cwd TEXT, started_at TEXT, updated_at TEXT, is_subagent INTEGER, parent_session_id TEXT)')
    const c = db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)')
    c.run('1790450764736_sub', 'C:\\Proj', new Date(T + 1e3).toISOString(), new Date(T + 1e3).toISOString(), 1, '1790450764736_xww6d')
    c.run('1790450764736_xww6d', 'C:\\Proj', new Date(T + 3e3).toISOString(), new Date(T + 8e3).toISOString(), 0, null)
    db.close()
    expect(findAgentSession({ agent: 'cline', cwd: 'C:/Proj', since: T }, home)).toBe('1790450764736_xww6d')
    expect(findAgentSession({ agent: 'kimi', cwd: 'C:/Proj', since: T }, home)).toBe(null)
  })
})
