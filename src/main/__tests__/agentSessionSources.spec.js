// @vitest-environment node
// Synthetic session folders in a temp home only: never the real home, never an agent.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import {
  droidSessions,
  grokSessions,
  piSessions,
  antigravitySessions,
  devinSessions,
  cursorSessions,
  copilotHistorySessions,
  kimiHistorySessions,
  clineHistorySessions,
  moreAgentsHistory,
  insideDir,
  piResumeFile,
  ompSessions,
  ompResumeFile,
  grokUserText,
  zcodeSessions
} from '../agentSessionSources'
import { findAgentSession, resumeTarget } from '../agentResume'
import { listSessions } from '../agentSessions'

const ENV = ['GROK_HOME', 'PI_CODING_AGENT_DIR', 'OMP_CODING_AGENT_DIR', 'DEVIN_HOME', 'COPILOT_HOME', 'KIMI_CODE_HOME', 'CLINE_DIR', 'CLINE_DATA_DIR', 'XDG_DATA_HOME', 'GEMINI_CLI_HOME', 'QWEN_HOME', 'QWEN_RUNTIME_DIR']
const U1 = '11111111-2222-4333-8444-555555555555'
const U2 = '66666666-7777-4888-9999-aaaaaaaaaaaa'
const T = Date.parse('2026-09-28T10:00:00Z')
let home
const saved = {}
beforeEach(() => {
  home = fs.mkdtempSync(join(os.tmpdir(), 'tessel-sources-'))
  for (const k of ENV) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
})
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
  for (const k of ENV) if (saved[k] !== undefined) process.env[k] = saved[k]
})
const put = (rel, text) => {
  const f = join(home, rel)
  fs.mkdirSync(join(f, '..'), { recursive: true })
  fs.writeFileSync(f, typeof text === 'string' ? text : JSON.stringify(text))
  return f
}
const lines = (...rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
const iso = (ms) => new Date(ms).toISOString()
const sqlite = process.getBuiltinModule && process.getBuiltinModule('node:sqlite')

describe('Droid', () => {
  it('reads id, folder, title and start from its session file', () => {
    put(
      `.factory/sessions/-C-Proj/${U1}.jsonl`,
      lines(
        { type: 'session_start', id: U1, title: 'Fix the login', cwd: 'C:\\Proj', timestamp: iso(T) },
        { type: 'message', role: 'user', text: 'fix the login please', timestamp: iso(T + 1000) }
      )
    )
    const [s] = droidSessions(home)
    expect(s).toMatchObject({ agent: 'droid', id: U1, cwd: 'C:\\Proj', started: T, title: 'Fix the login' })
    expect(findAgentSession({ agent: 'droid', cwd: 'c:/proj', since: T - 1000 }, home)).toBe(U1)
    expect(findAgentSession({ agent: 'droid', cwd: 'c:/proj', since: T - 1000, exclude: [U1] }, home)).toBe(null)
    expect(resumeTarget({ agent: 'droid', sessionId: U1 }, home)).toEqual({})
    expect(resumeTarget({ agent: 'droid', sessionId: U2 }, home)).toBe(null)
  })
  it('takes the first real prompt when there is no title', () => {
    put(`.factory/sessions/x/${U2}.jsonl`, lines({ type: 'session_start', id: U2, cwd: 'C:\\P' }, { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hello droid' }] } }))
    expect(droidSessions(home)[0].title).toBe('hello droid')
  })
})

describe('Grok', () => {
  it('reads summary.json and the typed ask of chat_history.jsonl', () => {
    const dir = `.grok/sessions/${encodeURIComponent('C:\\Proj')}/${U1}`
    put(`${dir}/summary.json`, { info: { id: U1, cwd: 'C:\\Proj' }, created_at: iso(T), last_active_at: iso(T + 5000) })
    put(`${dir}/chat_history.jsonl`, lines({ type: 'user', content: '<user_info>os: windows</user_info>' }, { type: 'user', content: '<user_info>x</user_info><user_query>add tests</user_query>' }))
    const [s] = grokSessions(home)
    expect(s).toMatchObject({ id: U1, cwd: 'C:\\Proj', started: T, title: 'add tests' })
    expect(s.updated).toBeGreaterThanOrEqual(T + 5000)
    expect(findAgentSession({ agent: 'grok', cwd: 'C:\\Proj', since: T }, home)).toBe(U1)
    expect(resumeTarget({ agent: 'grok', sessionId: U1 }, home)).toEqual({})
  })
  it('honours GROK_HOME and unwraps queries', () => {
    process.env.GROK_HOME = join(home, 'g')
    put(`g/sessions/x/${U2}/summary.json`, { info: { cwd: 'C:\\A' }, generated_title: 'Named' })
    expect(grokSessions(home).map((s) => [s.id, s.title])).toEqual([[U2, 'Named']])
    expect(grokUserText([{ type: 'text', text: '<user_query>hi' }])).toBe('hi')
  })
})

describe('Pi', () => {
  it('reads its session header and resumes by its session file', () => {
    const f = put(`.pi/agent/sessions/--C--Proj--/2026-09-28T10-00-00-000Z_${U1}.jsonl`, lines({ type: 'session', id: U1, cwd: 'C:\\Proj', timestamp: iso(T) }, { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'explain pi' }] } }))
    const [s] = piSessions(home)
    expect(s).toMatchObject({ id: U1, cwd: 'C:\\Proj', started: T, title: 'explain pi' })
    expect(findAgentSession({ agent: 'pi', cwd: 'C:\\Proj', since: T }, home)).toBe(U1)
    const target = resumeTarget({ agent: 'pi', sessionId: U1 }, home)
    // Written with forward slashes; null when the path could not go on a command line.
    if (/^[A-Za-z0-9_.:\\/-]+$/.test(f)) expect(target).toEqual({ transcriptPath: fs.realpathSync(f).replace(/\\/g, '/').replace(/^.*?(?=\/)/, (d) => d) })
    else expect(target).toBe(null)
    expect(piResumeFile('bad id', home)).toBe(null)
  })
  it('honours PI_CODING_AGENT_DIR (the agent folder)', () => {
    process.env.PI_CODING_AGENT_DIR = join(home, 'custom', 'agent')
    put(`custom/agent/sessions/x/a_${U2}.jsonl`, lines({ type: 'session', id: U2, cwd: 'C:\\B', timestamp: iso(T) }))
    expect(piSessions(home).map((s) => s.id)).toEqual([U2])
  })
})

describe('OMP', () => {
  it("reads Pi's header in its own folder, not its sub-agents' files, and resumes by its session file", () => {
    const f = put(`.omp/agent/sessions/-C-Proj/2026-09-28T10-00-00-000Z_${U1}.jsonl`, lines({ type: 'session', version: 3, id: U1, cwd: 'C:\\Proj', timestamp: iso(T) }, { type: 'message', message: { role: 'user', content: 'explain omp' } }))
    // A task sub-agent's file, in the session's own sub-folder.
    put(`.omp/agent/sessions/-C-Proj/2026-09-28T10-00-00-000Z_${U1}/task_${U2}.jsonl`, lines({ type: 'session', id: U2, cwd: 'C:\\Proj', timestamp: iso(T + 1000) }, { type: 'message', message: { role: 'user', content: 'sub-agent task' } }))
    expect(ompSessions(home).map((s) => [s.id, s.cwd, s.title])).toEqual([[U1, 'C:\\Proj', 'explain omp']])
    expect(findAgentSession({ agent: 'omp', cwd: 'C:\\Proj', since: T }, home)).toBe(U1)
    const target = resumeTarget({ agent: 'omp', sessionId: U1 }, home)
    // Written with forward slashes; null when the path could not go on a command line.
    if (/^[A-Za-z0-9_.:\\/-]+$/.test(f)) expect(target.transcriptPath).toMatch(/\/2026-09-28T10-00-00-000Z_11111111-2222-4333-8444-555555555555\.jsonl$/)
    else expect(target).toBe(null)
    expect(target && target.transcriptPath && target.transcriptPath.includes('\\')).toBeFalsy()
    // The sub-agent's own file is not a session to resume.
    expect(resumeTarget({ agent: 'omp', sessionId: U2 }, home)).toBe(null)
    expect(ompResumeFile('../x', home)).toBe(null)
    expect(moreAgentsHistory({ cwd: 'C:\\Proj' }, home).filter((r) => r.agent === 'omp').map((r) => r.id)).toEqual([U1])
  })
  it('honours OMP_CODING_AGENT_DIR (its .omp folder)', () => {
    process.env.OMP_CODING_AGENT_DIR = join(home, 'o', '.omp')
    put(`o/.omp/agent/sessions/x/a_${U2}.jsonl`, lines({ type: 'session', id: U2, cwd: 'C:\\B', timestamp: iso(T) }))
    expect(ompSessions(home).map((s) => s.id)).toEqual([U2])
  })
})

describe('Antigravity', () => {
  it('reads the transcript and joins its folder from history.jsonl on a unique prompt match', () => {
    put(
      `.gemini/antigravity-cli/brain/${U1}/.system_generated/logs/transcript.jsonl`,
      lines({ source: 'USER_EXPLICIT', type: 'USER_INPUT', content: '<USER_REQUEST>build the thing</USER_REQUEST>', created_at: iso(T) }, { source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'ok' })
    )
    put(`.gemini/antigravity-cli/history.jsonl`, lines({ display: 'build the thing', workspace: 'C:\\Proj', timestamp: T + 500 }, { display: 'build the thing', workspace: 'C:\\Else', timestamp: T + 60000 }))
    const [s] = antigravitySessions(home)
    expect(s).toMatchObject({ agent: 'antigravity', id: U1, cwd: 'C:\\Proj', title: 'build the thing' })
    expect(findAgentSession({ agent: 'antigravity', cwd: 'C:\\Proj', since: T }, home)).toBe(U1)
    expect(resumeTarget({ agent: 'antigravity', sessionId: U1 }, home)).toEqual({})
  })
  it('leaves the folder unknown when two workspaces match', () => {
    put(`.gemini/antigravity-cli/brain/${U2}/.system_generated/logs/transcript.jsonl`, lines({ source: 'USER', type: 'REQUEST', content: 'same', created_at: iso(T) }))
    put(`.gemini/antigravity-cli/history.jsonl`, lines({ display: 'same', workspace: 'C:\\A', timestamp: T }, { display: 'same', workspace: 'C:\\B', timestamp: T + 100 }))
    expect(antigravitySessions(home)[0].cwd).toBe('')
  })
})

describe.skipIf(!sqlite)('Devin', () => {
  it('lists its sessions.db (seconds), skips hidden ones, titles from the transcript', () => {
    process.env.DEVIN_HOME = join(home, 'devin')
    fs.mkdirSync(join(home, 'devin', 'transcripts'), { recursive: true })
    const db = new sqlite.DatabaseSync(join(home, 'devin', 'sessions.db'))
    db.exec('CREATE TABLE sessions (id TEXT, working_directory TEXT, title TEXT, created_at INTEGER, last_activity_at INTEGER, hidden INTEGER)')
    const ins = db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)')
    ins.run('devin-abc123', 'C:\\Proj', null, T / 1000, T / 1000 + 60, 0)
    ins.run('devin-hidden', 'C:\\Proj', 'Hidden', T / 1000, T / 1000, 1)
    db.close()
    put('devin/transcripts/devin-abc123.json', { steps: [{ source: 'system', message: 'setup' }, { source: 'user', message: 'port the parser' }] })
    const rows = devinSessions(home)
    expect(rows).toEqual([{ agent: 'devin', id: 'devin-abc123', cwd: 'C:\\Proj', started: T, updated: T + 60000, title: 'port the parser' }])
    expect(findAgentSession({ agent: 'devin', cwd: 'C:\\Proj', since: T }, home)).toBe('devin-abc123')
    expect(resumeTarget({ agent: 'devin', sessionId: 'devin-hidden' }, home)).toBe(null)
  })
})

describe.skipIf(!sqlite)('ZCode', () => {
  it("lists ~/.zcode/cli/db/db.sqlite (OpenCode's tables), titles from its first visible prompt", () => {
    fs.mkdirSync(join(home, '.zcode', 'cli', 'db'), { recursive: true })
    const db = new sqlite.DatabaseSync(join(home, '.zcode', 'cli', 'db', 'db.sqlite'))
    db.exec('CREATE TABLE session (id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER, parent_id TEXT, time_archived INTEGER)')
    db.exec('CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT)')
    db.exec('CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, data TEXT)')
    const ins = db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?)')
    ins.run('ses_zcode01', 'C:\\Proj', 'Fix the import', T, T + 60000, null, null)
    ins.run('ses_zcode02', 'C:\\Proj', '', T + 1000, T + 2000, null, null)
    ins.run('ses_child01', 'C:\\Proj', 'child', T, T, 'ses_zcode01', null)
    ins.run('ses_archiv1', 'C:\\Proj', 'old', T, T, null, T)
    const msg = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)')
    const part = db.prepare('INSERT INTO part VALUES (?, ?, ?, ?)')
    // A hidden message (ZCode's own) comes first: never the title.
    msg.run('m1', 'ses_zcode02', T + 1000, JSON.stringify({ role: 'user', semantics: { transcriptVisibility: 'hidden' } }))
    part.run('p1', 'm1', 'ses_zcode02', JSON.stringify({ type: 'text', text: 'system preamble' }))
    msg.run('m2', 'ses_zcode02', T + 1500, JSON.stringify({ role: 'user' }))
    part.run('p2', 'm2', 'ses_zcode02', JSON.stringify({ type: 'text', text: 'explain zcode' }))
    db.close()
    expect(zcodeSessions(home).map((r) => [r.id, r.cwd, r.title])).toEqual([
      ['ses_zcode01', 'C:\\Proj', 'Fix the import'],
      ['ses_zcode02', 'C:\\Proj', 'explain zcode']
    ])
    expect(findAgentSession({ agent: 'zcode', cwd: 'C:\\Proj', since: T }, home)).toBe('ses_zcode01')
    expect(resumeTarget({ agent: 'zcode', sessionId: 'ses_zcode02' }, home)).toEqual({})
    expect(resumeTarget({ agent: 'zcode', sessionId: 'ses_child01' }, home)).toBe(null)
    expect(moreAgentsHistory({ cwd: 'C:\\Proj' }, home).filter((r) => r.agent === 'zcode').map((r) => r.id)).toEqual(['ses_zcode01', 'ses_zcode02'])
  })
})

describe('Cursor', () => {
  it('reads chats/<hash>/<id>/meta.json and titles from its transcript', () => {
    put(`.cursor/chats/abcd/${U1}/meta.json`, { cwd: 'C:\\Proj', createdAtMs: T, updatedAtMs: T + 10 })
    put(`.cursor/projects/c-proj/agent-transcripts/${U1}/${U1}.jsonl`, lines({ role: 'user', message: { content: [{ type: 'text', text: '<user_query>\nrefactor\n</user_query>' }] } }))
    expect(cursorSessions(home)[0]).toMatchObject({ id: U1, cwd: 'C:\\Proj', started: T, title: '' })
    const hist = moreAgentsHistory({ cwd: 'c:/proj' }, home).filter((r) => r.agent === 'cursor')
    expect(hist).toEqual([{ agent: 'cursor', id: U1, cwd: 'C:\\Proj', started: T, updated: T + 10, title: 'refactor' }])
    expect(findAgentSession({ agent: 'cursor', cwd: 'C:\\Proj', since: T }, home)).toBe(U1)
  })
})

describe('Copilot, Kimi and Cline titles', () => {
  it('Copilot: the first user message', () => {
    put(`.copilot/session-state/${U1}/events.jsonl`, lines({ type: 'session.start', data: { sessionId: U1, startTime: iso(T), context: { cwd: 'C:\\Proj' } } }, { type: 'user.message', data: { content: 'copilot task' } }))
    expect(copilotHistorySessions(home)[0]).toMatchObject({ id: U1, cwd: 'C:\\Proj', started: T, title: 'copilot task' })
  })
  it('Kimi: state.json title, folder from session_index.jsonl', () => {
    put('.kimi-code/sessions/wd_proj_1/session_abc123/state.json', { title: 'kimi work', createdAt: iso(T) })
    put('.kimi-code/session_index.jsonl', lines({ sessionId: 'session_abc123', workDir: 'C:\\Proj' }))
    expect(kimiHistorySessions(home)[0]).toMatchObject({ id: 'session_abc123', cwd: 'C:\\Proj', started: T, title: 'kimi work' })
    expect(findAgentSession({ agent: 'kimi', cwd: 'C:\\Proj', since: T }, home)).toBe('session_abc123')
  })
  it('Cline: the metadata prompt, not sub-agents', () => {
    put('.cline/data/sessions/1790450764736_xww6d/1790450764736_xww6d.json', { session_id: '1790450764736_xww6d', cwd: 'C:\\Proj', started_at: iso(T), prompt: 'cline job' })
    put('.cline/data/sessions/1790450764999_child/1790450764999_child.json', { session_id: '1790450764999_child', cwd: 'C:\\Proj', is_subagent: true, prompt: 'x' })
    expect(clineHistorySessions(home).map((s) => [s.id, s.title])).toEqual([['1790450764736_xww6d', 'cline job']])
  })
})

describe('the Sessions dialog list', () => {
  it('includes the other agents and OpenClaude, only titled ones, by folder', () => {
    put(`.factory/sessions/x/${U1}.jsonl`, lines({ type: 'session_start', id: U1, title: 'droid one', cwd: 'C:\\Proj' }))
    put(`.factory/sessions/x/${U2}.jsonl`, lines({ type: 'session_start', id: U2, cwd: 'C:\\Proj' })) // never messaged
    put(`.openclaude/projects/C--Proj/${U2}.jsonl`, lines({ type: 'user', cwd: 'C:\\Proj', timestamp: iso(T), message: { role: 'user', content: 'open claude task' } }))
    const all = listSessions({ cwd: 'C:\\Proj' }, home)
    expect(all.map((s) => [s.agent, s.title]).sort()).toEqual([
      ['droid', 'droid one'],
      ['openclaude', 'open claude task']
    ])
    expect(resumeTarget({ agent: 'openclaude', sessionId: U2 }, home)).toEqual({})
    expect(resumeTarget({ agent: 'openclaude', sessionId: U1 }, home)).toBe(null)
  })
})

describe('safety', () => {
  it('never an unsafe id, and Qoder / DeepSeek Harness (hooks only) resume the id as given', () => {
    expect(resumeTarget({ agent: 'droid', sessionId: 'a b; rm -rf' }, home)).toBe(null)
    expect(resumeTarget({ agent: 'qoder', sessionId: 'qd_123456' }, home)).toEqual({})
    expect(resumeTarget({ agent: 'dsh', sessionId: 'dsh_123456' }, home)).toEqual({})
    expect(resumeTarget({ agent: 'qoder', sessionId: '--help' }, home)).toBe(null)
    // ZCode: only a session in its database.
    expect(resumeTarget({ agent: 'zcode', sessionId: 'zc_123456' }, home)).toBe(null)
    expect(resumeTarget({ agent: 'nope', sessionId: U1 }, home)).toBe(null)
  })
  it('does not follow a link out of the agent folder', () => {
    const outside = fs.mkdtempSync(join(os.tmpdir(), 'tessel-outside-'))
    try {
      fs.writeFileSync(join(outside, 'summary.json'), JSON.stringify({ info: { id: U1, cwd: 'C:\\Secret' }, generated_title: 'secret' }))
      fs.mkdirSync(join(home, '.grok', 'sessions', 'grp'), { recursive: true })
      let linked = true
      try {
        fs.symlinkSync(outside, join(home, '.grok', 'sessions', 'grp', U1), 'junction')
      } catch {
        linked = false
      }
      if (linked) {
        expect(grokSessions(home)).toEqual([])
        expect(insideDir(join(home, '.grok', 'sessions'), join(home, '.grok', 'sessions', 'grp', U1, 'summary.json'))).toBe(false)
      }
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })
  it('does not read a JSON document over its size bound', () => {
    put(`.grok/sessions/x/${U1}/summary.json`, JSON.stringify({ info: { id: U1, cwd: 'C:\\P' }, generated_title: 't', pad: 'x'.repeat(1100 * 1024) }))
    expect(grokSessions(home)).toEqual([])
  })
})
