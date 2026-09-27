// @vitest-environment node
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join, resolve, sep } from 'path'
import { createHash } from 'crypto'
import { listSessions } from '../agentSessions'
import { parseGeminiHead, parseQwenHead } from '../agentHistory'
import { geminiSessionExists, qwenSessionExists } from '../agentResume'

const A = '11111111-aaaa-4bbb-8ccc-000000000001'
const B = '22222222-aaaa-4bbb-8ccc-000000000002'
const C = '33333333-aaaa-4bbb-8ccc-000000000003'
const T = Date.parse('2026-09-27T12:00:00Z')
let home
beforeEach(() => {
  home = fs.mkdtempSync(join(os.tmpdir(), 'tessel-history-'))
  for (const key of ['GEMINI_CLI_HOME', 'QWEN_HOME', 'QWEN_RUNTIME_DIR', 'XDG_DATA_HOME'])
    vi.stubEnv(key, '')
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  const target = resolve(home)
  if (!target.startsWith(resolve(os.tmpdir()) + sep) || !target.includes('tessel-history-'))
    throw new Error('Unexpected cleanup path')
  fs.rmSync(target, { recursive: true, force: true })
})
function put(rel, text, updated = T) {
  const file = join(home, rel)
  fs.mkdirSync(join(file, '..'), { recursive: true })
  fs.writeFileSync(file, typeof text === 'string' ? text : JSON.stringify(text))
  fs.utimesSync(file, new Date(updated), new Date(updated))
  return file
}
const lines = (...rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
const gemini = (id, text, extra = {}) =>
  lines(
    {
      sessionId: id,
      projectHash: 'project',
      startTime: new Date(T - 1000).toISOString(),
      ...extra
    },
    { id: 'user-1', type: 'user', content: [{ text }] }
  )
const qwen = (id, text, extra = {}) => ({
  sessionId: id,
  cwd: 'C:/Project',
  timestamp: new Date(T).toISOString(),
  type: 'user',
  message: { role: 'user', parts: [{ text }] },
  ...extra
})

describe('Gemini history and resume', () => {
  it('lists JSONL and legacy JSON with full ids, project roots and text parts', () => {
    put('.gemini/projects.json', { projects: { 'C:/Project': 'project-1' } })
    put(
      `.gemini/tmp/project-1/chats/session-now-${A.slice(0, 8)}.jsonl`,
      gemini(A, 'Repair login'),
      T + 1
    )
    put('.gemini/tmp/legacy/.project_root', 'C:/Older')
    put(`.gemini/tmp/legacy/chats/session-then-${B.slice(0, 8)}.json`, {
      sessionId: B,
      startTime: new Date(T - 2000).toISOString(),
      messages: [{ type: 'user', content: 'Add tests' }]
    })
    expect(listSessions({}, home).map((s) => [s.agent, s.id, s.cwd, s.title])).toEqual([
      ['gemini', A, 'C:/Project', 'Repair login'],
      ['gemini', B, 'C:/Older', 'Add tests']
    ])
    expect(listSessions({ cwd: 'c:\\project\\' }, home).map((s) => s.id)).toEqual([A])
    expect(geminiSessionExists(A, home)).toBe(true)
    expect(geminiSessionExists(B, home)).toBe(true)
  })
  it('preserves the beginning of a large legacy document without reading the whole transcript', () => {
    put('.gemini/tmp/project/.project_root', 'C:/Project')
    const file = put(`.gemini/tmp/project/chats/session-large-${A.slice(0, 8)}.json`, {
      sessionId: A,
      messages: [
        { type: 'user', content: 'Braces { and escaped "quotes"' },
        { type: 'gemini', content: 'x'.repeat(700000) }
      ]
    })
    const read = vi.spyOn(fs, 'readSync')
    const all = listSessions({}, home)
    expect(all[0].title).toBe('Braces { and escaped "quotes"')
    expect(read.mock.calls.every((c) => c[3] <= 256 * 1024)).toBe(true)
    expect(fs.statSync(file).size).toBeGreaterThan(700000)
    expect(geminiSessionExists(A, home)).toBe(true)
  })
  it('does not infer a folder from a slug or expose empty/subagent/corrupt conversations', () => {
    put(
      `.gemini/tmp/unknown/chats/session-now-${A.slice(0, 8)}.jsonl`,
      gemini(A, 'No known folder')
    )
    put('.gemini/tmp/project/.project_root', 'C:/Project')
    put(
      `.gemini/tmp/project/chats/session-child-${B.slice(0, 8)}.jsonl`,
      gemini(B, 'Subagent', { kind: 'subagent' })
    )
    put(
      `.gemini/tmp/project/chats/session-empty-${C.slice(0, 8)}.jsonl`,
      lines({ sessionId: C, startTime: new Date(T).toISOString() })
    )
    put('.gemini/tmp/project/chats/session-corrupt.json', '{broken')
    expect(listSessions({}, home).map((s) => [s.id, s.cwd])).toEqual([[A, '']])
    expect(listSessions({ cwd: 'C:/Project' }, home)).toEqual([])
    expect(parseGeminiHead(gemini('bad; command', 'Unsafe'))).toBeNull()
  })
  it('matches a legacy hash only to the supplied exact project and honors GEMINI_CLI_HOME', () => {
    vi.stubEnv('GEMINI_CLI_HOME', join(home, 'override'))
    const hash = createHash('sha256').update('C:/Project').digest('hex')
    put(
      `override/.gemini/tmp/${hash}/chats/session-now-${A.slice(0, 8)}.jsonl`,
      gemini(A, 'Legacy hash')
    )
    expect(listSessions({ cwd: 'C:/Project' }, home)[0]?.id).toBe(A)
    expect(listSessions({ cwd: 'C:/Other' }, home)).toEqual([])
    expect(geminiSessionExists(A, home)).toBe(true)
  })
  it('checks the metadata id rather than a full id mentioned by a different session', () => {
    const other = A.replace('000000000001', '000000000002')
    put(
      `.gemini/tmp/project/chats/session-now-${A.slice(0, 8)}.jsonl`,
      gemini(other, 'Please find ' + A)
    )
    expect(geminiSessionExists(A, home)).toBe(false)
  })
  it('uses a late metadata title without reading an entire large JSONL conversation', () => {
    put('.gemini/tmp/project/.project_root', 'C:/Project')
    put(
      `.gemini/tmp/project/chats/session-now-${A.slice(0, 8)}.jsonl`,
      gemini(A, 'Original prompt') +
        lines(
          { type: 'gemini', content: 'x'.repeat(300000) },
          { $set: { summary: 'Renamed session' } }
        )
    )
    expect(listSessions({}, home)[0].title).toBe('Renamed session')
    expect(listSessions({ limit: 0 }, home)).toEqual([])
  })
})

describe('Qwen history', () => {
  it('uses real user prompts, updated custom titles, archives and project filtering', () => {
    const row = qwen(A, 'Repair login')
    const file = put(
      `.qwen/projects/proj/chats/${A}.jsonl`,
      lines(
        qwen(A, '<environment>context</environment>'),
        row,
        qwen(A, 'Sidechain tool context', { isSidechain: true })
      ) +
        'x'.repeat(300000) +
        '\n' +
        lines({
          ...row,
          type: 'system',
          subtype: 'custom_title',
          systemPayload: { customTitle: 'Login fix' }
        }),
      T + 5
    )
    put(`.qwen/projects/proj/chats/archive/${B}.jsonl`, lines(qwen(B, 'Old work')))
    expect(listSessions({}, home).map((s) => [s.id, s.title])).toEqual([
      [A, 'Login fix'],
      [B, 'Old work']
    ])
    expect(listSessions({ cwd: 'c:/project/', limit: 1 }, home).map((s) => s.id)).toEqual([A])
    expect(listSessions({ cwd: 'C:/Other' }, home)).toEqual([])
    expect(qwenSessionExists(B, home)).toBe(true)
    expect(fs.statSync(file).size).toBeGreaterThan(300000)
  })
  it('ignores injected notifications, mismatched ids and sub-sessions', () => {
    expect(
      parseQwenHead(
        lines(qwen(A, 'Agent notification', { subtype: 'notification', provenance: 'system' })),
        A
      )?.title
    ).toBe('')
    expect(parseQwenHead(lines(qwen(B, 'Wrong session')), A)).toBeNull()
    put(
      `.qwen/projects/proj/chats/${A}.jsonl`,
      lines(qwen(A, 'Child task'), {
        ...qwen(A, ''),
        type: 'system',
        subtype: 'parent_session',
        systemPayload: { parentSessionId: B }
      })
    )
    put(`.qwen/projects/proj/chats/${B}.jsonl`, '{cut')
    expect(listSessions({}, home)).toEqual([])
  })
  it('shares QWEN_RUNTIME_DIR > QWEN_HOME with the resume check and removes duplicates', () => {
    vi.stubEnv('QWEN_HOME', join(home, 'config'))
    vi.stubEnv('QWEN_RUNTIME_DIR', join(home, 'runtime'))
    put(`config/projects/proj/chats/${B}.jsonl`, lines(qwen(B, 'Wrong root')))
    put(`runtime/projects/proj/chats/${A}.jsonl`, lines(qwen(A, 'Current')), T + 1)
    put(`runtime/projects/proj/chats/archive/${A}.jsonl`, lines(qwen(A, 'Archived')))
    expect(listSessions({}, home).map((s) => [s.id, s.title])).toEqual([[A, 'Current']])
    expect(qwenSessionExists(A, home)).toBe(true)
    expect(qwenSessionExists(B, home)).toBe(false)
  })
})

describe('OpenCode read-only SQLite history', () => {
  const sqlite = process.getBuiltinModule?.('node:sqlite')
  it.skipIf(!sqlite)(
    'filters by project BEFORE limiting and excludes subagents and archived sessions',
    () => {
      vi.stubEnv('XDG_DATA_HOME', join(home, 'data'))
      const file = put('data/opencode/opencode.db', '')
      const db = new sqlite.DatabaseSync(file)
      db.exec(
        'CREATE TABLE session (id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER, parent_id TEXT, time_archived INTEGER)'
      )
      const insert = db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?)')
      insert.run('ses_other', 'C:/Other', 'More recent elsewhere', T, T + 10, null, null)
      insert.run('ses_child', 'C:/Project', 'Child', T, T + 9, 'ses_parent', null)
      insert.run('ses_archive', 'C:/Project', 'Archived', T, T + 8, null, T)
      insert.run('ses_parent', 'C:/Project/', 'Fix layout', T, T + 1, null, null)
      db.close()
      const before = fs.readFileSync(file)
      expect(listSessions({ cwd: 'c:\\project', limit: 1 }, home)).toEqual([
        {
          agent: 'opencode',
          id: 'ses_parent',
          cwd: 'C:/Project/',
          title: 'Fix layout',
          started: T,
          updated: T + 1
        }
      ])
      expect(fs.readFileSync(file).equals(before)).toBe(true)
    }
  )
  it('missing or damaged stores stay empty without creating or rewriting files', () => {
    expect(listSessions({}, home)).toEqual([])
    expect(fs.readdirSync(home)).toEqual([])
    const file = put('.local/share/opencode/opencode.db', 'damaged database')
    const writer = vi.spyOn(fs, 'writeFileSync')
    expect(listSessions({}, home)).toEqual([])
    expect(writer).not.toHaveBeenCalled()
    expect(fs.readFileSync(file, 'utf8')).toBe('damaged database')
  })
})
