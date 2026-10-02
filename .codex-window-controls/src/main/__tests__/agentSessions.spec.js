import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { isUuid, claudeSessionExists, parseCodexMeta, findCodexSession } from '../agentSessions'

const A = '01a0d3f5-0b0b-77c3-86cc-15f8e8f93fd7'
const B = '01a0d3ef-cd0b-7af1-b332-68dddd2d119d'
const C = '11111111-2222-3333-4444-555555555555'

let home
beforeEach(() => {
  home = fs.mkdtempSync(join(os.tmpdir(), 'sp-sessions-'))
})
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

function codexSession(id, cwd, iso) {
  const d = new Date(iso)
  const dir = join(
    home,
    '.codex',
    'sessions',
    String(d.getFullYear()),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0')
  )
  fs.mkdirSync(dir, { recursive: true })
  const file = join(dir, `rollout-${iso.replace(/[:.]/g, '-')}-${id}.jsonl`)
  fs.writeFileSync(
    file,
    JSON.stringify({ timestamp: iso, type: 'session_meta', payload: { id, cwd, timestamp: iso } }) +
      '\n{"type":"event"}\n'
  )
  const t = new Date(iso)
  fs.utimesSync(file, t, t)
}

describe('isUuid', () => {
  it('accepts UUIDs only', () => {
    expect(isUuid(A)).toBe(true)
    expect(isUuid('abc')).toBe(false)
    expect(isUuid(null)).toBe(false)
  })
})

describe('claudeSessionExists', () => {
  it('finds a transcript in any project folder', () => {
    const dir = join(home, '.claude', 'projects', 'C--TERMINAL')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(join(dir, `${C}.jsonl`), '{}\n')
    expect(claudeSessionExists(C, home)).toBe(true)
    expect(claudeSessionExists(A, home)).toBe(false)
  })
  it('is false when Claude has no data or the id is not a UUID', () => {
    expect(claudeSessionExists(C, home)).toBe(false)
    expect(claudeSessionExists('../../etc', home)).toBe(false)
  })
})

describe('parseCodexMeta', () => {
  it('reads session_meta lines', () => {
    const line = JSON.stringify({
      type: 'session_meta',
      payload: { id: A, cwd: 'C:\\TERMINAL', timestamp: '2026-09-24T15:07:26.973Z' }
    })
    expect(parseCodexMeta(line)).toEqual({
      id: A,
      cwd: 'C:\\TERMINAL',
      time: Date.parse('2026-09-24T15:07:26.973Z')
    })
  })
  it('rejects other lines', () => {
    expect(parseCodexMeta('{"type":"event"}')).toBe(null)
    expect(parseCodexMeta('not json')).toBe(null)
  })
})

describe('findCodexSession', () => {
  const now = Date.parse('2026-09-24T16:00:00Z')

  it('finds the first session started in the folder after launch', () => {
    codexSession(B, 'C:\\Other', '2026-09-24T15:02:00.000Z')
    codexSession(A, 'C:\\TERMINAL', '2026-09-24T15:07:26.000Z')
    codexSession(C, 'C:\\TERMINAL', '2026-09-24T15:09:00.000Z')
    const since = Date.parse('2026-09-24T15:07:20Z')
    expect(findCodexSession({ cwd: 'c:/terminal/', since }, home, now)).toBe(A)
  })

  it('skips sessions other panes already claimed', () => {
    codexSession(A, 'C:\\TERMINAL', '2026-09-24T15:07:26.000Z')
    codexSession(C, 'C:\\TERMINAL', '2026-09-24T15:09:00.000Z')
    const since = Date.parse('2026-09-24T15:07:20Z')
    expect(findCodexSession({ cwd: 'C:\\TERMINAL', since, exclude: [A] }, home, now)).toBe(C)
  })

  it('ignores sessions that started before the pane', () => {
    codexSession(A, 'C:\\TERMINAL', '2026-09-24T14:00:00.000Z')
    const since = Date.parse('2026-09-24T15:00:00Z')
    expect(findCodexSession({ cwd: 'C:\\TERMINAL', since }, home, now)).toBe(null)
  })

  it('can pick the most recent session instead of the first', () => {
    codexSession(A, 'C:\\TERMINAL', '2026-09-24T15:07:26.000Z')
    codexSession(C, 'C:\\TERMINAL', '2026-09-24T15:09:00.000Z')
    const since = Date.parse('2026-09-24T03:00:00Z')
    expect(findCodexSession({ cwd: 'c:/terminal', since, latest: true }, home, now)).toBe(C)
  })

  it('with activeSince, ignores sessions not written since then', () => {
    codexSession(A, 'C:/TERMINAL', '2026-09-24T15:07:26.000Z')
    const since = Date.parse('2026-09-24T03:00:00Z')
    const activeSince = Date.parse('2026-09-24T15:30:00Z')
    expect(
      findCodexSession({ cwd: 'C:/TERMINAL', since, latest: true, activeSince }, home, now)
    ).toBe(null)
  })

  it('returns null when Codex has no sessions', () => {
    expect(findCodexSession({ cwd: 'C:\\X', since: now - 1000 }, home, now)).toBe(null)
  })
})

describe('listSessions', () => {
  it('lists Claude and Codex conversations with a title, newest first', async () => {
    const { listSessions } = await import('../agentSessions')
    const proj = join(home, '.claude', 'projects', 'C--Work')
    fs.mkdirSync(proj, { recursive: true })
    const claudeFile = join(proj, `${C}.jsonl`)
    fs.writeFileSync(
      claudeFile,
      [
        JSON.stringify({ type: 'queue-operation' }),
        JSON.stringify({
          type: 'user',
          isMeta: true,
          cwd: 'C:\\Work',
          message: { content: '<command-name>/clear</command-name>' }
        }),
        JSON.stringify({
          type: 'user',
          cwd: 'C:\\Work',
          timestamp: '2026-09-24T10:00:00Z',
          message: { content: [{ type: 'text', text: 'Fix the login bug' }] }
        })
      ].join('\n')
    )
    // A Claude session that was never messaged is not listed.
    fs.writeFileSync(join(proj, `${B}.jsonl`), JSON.stringify({ type: 'queue-operation' }) + '\n')
    codexSession(A, 'C:\\Work', '2026-09-24T11:00:00.000Z')
    const codexFile = fs
      .readdirSync(join(home, '.codex', 'sessions', '2026', '09', '24'))
      .map((f) => join(home, '.codex', 'sessions', '2026', '09', '24', f))[0]
    fs.appendFileSync(
      codexFile,
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '<environment_context>x</environment_context>' }]
        }
      }) +
        '\n' +
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Add dark mode' }]
          }
        }) +
        '\n'
    )
    fs.utimesSync(claudeFile, new Date('2026-09-24T12:00:00Z'), new Date('2026-09-24T12:00:00Z'))
    fs.utimesSync(codexFile, new Date('2026-09-24T11:30:00Z'), new Date('2026-09-24T11:30:00Z'))

    const all = listSessions({}, home)
    expect(all.map((s) => [s.agent, s.id, s.title])).toEqual([
      ['claude', C, 'Fix the login bug'],
      ['codex', A, 'Add dark mode']
    ])
    expect(listSessions({ cwd: 'c:/work/' }, home)).toHaveLength(2)
    expect(listSessions({ cwd: 'C:\\Elsewhere' }, home)).toHaveLength(0)
  })
})
