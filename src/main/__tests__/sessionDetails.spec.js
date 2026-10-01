// @vitest-environment node
// One past conversation for the Agent Session History panel
// (src/main/sessionDetails.js): its transcript found inside the agent's own
// folder, its first prompt and latest turns, its deletion to the Recycle Bin.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join, relative, resolve, sep } from 'path'
import { DELETABLE_AGENTS, HEAD_BYTES, deleteSession, deleteTargets, findSessionFile, revealSessionFile, sessionDetails } from '../sessionDetails'

const ID = '11111111-2222-4333-8444-555555555555'
const OTHER = '22222222-2222-4333-8444-555555555555'
let root, home
function put(path, rows) {
  fs.mkdirSync(join(path, '..'), { recursive: true })
  fs.writeFileSync(path, rows.map((row) => (typeof row === 'string' ? row : JSON.stringify(row))).join('\n') + '\n')
}
const user = (text, i) => ({ type: 'user', uuid: `u${i}`, timestamp: new Date(1_700_000_000_000 + i * 1000).toISOString(), cwd: 'C:\\proj', message: { role: 'user', content: text } })
const assistant = (text, i) => ({ type: 'assistant', uuid: `a${i}`, timestamp: new Date(1_700_000_000_000 + i * 1000).toISOString(), message: { id: `m${i}`, role: 'assistant', content: [{ type: 'text', text }] } })
const claudeFile = (id = ID) => join(home, '.claude', 'projects', 'C--proj', `${id}.jsonl`)

beforeEach(() => {
  root = fs.mkdtempSync(join(os.tmpdir(), 'tessel-session-details-'))
  home = join(root, 'home')
  fs.mkdirSync(home)
  for (const key of ['GROK_HOME', 'PI_CODING_AGENT_DIR', 'OMP_CODING_AGENT_DIR']) vi.stubEnv(key, '')
})
afterEach(() => {
  vi.unstubAllEnvs()
  const rel = relative(resolve(os.tmpdir()), resolve(root))
  if (!rel.startsWith('tessel-session-details-') || rel.includes(sep)) throw new Error('Unexpected fixture cleanup')
  fs.rmSync(root, { recursive: true, force: true })
})

describe('findSessionFile', () => {
  it('finds a Claude Code transcript by its id, in the given account folder', () => {
    put(claudeFile(), [user('hello', 1)])
    expect(findSessionFile({ agent: 'claude', id: ID }, home)).toMatchObject({ file: claudeFile(), root: join(home, '.claude', 'projects') })
    const other = join(root, 'claude-other')
    put(join(other, 'projects', 'x', `${OTHER}.jsonl`), [user('hi', 1)])
    expect(findSessionFile({ agent: 'claude', id: OTHER }, home)).toBe(null)
    expect(findSessionFile({ agent: 'claude', id: OTHER }, home, { claude: other })).toMatchObject({ file: join(other, 'projects', 'x', `${OTHER}.jsonl`) })
  })

  it('refuses ids of another shape, unknown agents and agents without a transcript', () => {
    put(claudeFile(), [user('hello', 1)])
    expect(findSessionFile({ agent: 'claude', id: '../' + ID }, home)).toBe(null)
    expect(findSessionFile({ agent: 'gemini', id: ID }, home)).toBe(null)
    expect(findSessionFile({ agent: 'nope', id: ID }, home)).toBe(null)
    expect(findSessionFile({ agent: 'claude', id: OTHER }, home)).toBe(null)
  })

  it('finds a Codex rollout of any day, and a Grok session folder', () => {
    const codex = join(home, '.codex', 'sessions', '2024', '01', '15', `rollout-2024-01-15T10-00-00-${ID}.jsonl`)
    put(codex, [{ type: 'session_meta', timestamp: '2024-01-15T10:00:00Z', payload: { id: ID, cwd: 'C:\\proj', timestamp: '2024-01-15T10:00:00Z' } }])
    expect(findSessionFile({ agent: 'codex', id: ID.toUpperCase() }, home)).toMatchObject({ file: codex })
    const grok = join(home, '.grok', 'sessions', 'enc', 'sess_abc123', 'chat_history.jsonl')
    put(grok, [{ type: 'user', content: 'hi' }])
    expect(findSessionFile({ agent: 'grok', id: 'sess_abc123' }, home)).toMatchObject({ file: grok, root: join(home, '.grok', 'sessions') })
  })
})

describe('sessionDetails', () => {
  it('reads the first prompt, the latest turns and the count of a small transcript', () => {
    put(claudeFile(), [
      { type: 'summary', summary: 'x' },
      user('Fix the build', 1),
      assistant('On it', 2),
      user('Thanks', 3),
      assistant('Done', 4),
      user('One more', 5)
    ])
    const d = sessionDetails({ agent: 'claude', id: ID }, home)
    expect(d.ok).toBe(true)
    expect(d.file).toBe(claudeFile())
    expect(d.firstPrompt).toBe('Fix the build')
    expect(d.turns.map((t) => [t.role, t.text])).toEqual([
      ['user', 'Thanks'],
      ['assistant', 'Done'],
      ['user', 'One more']
    ])
    expect(d.turns[0].at).toBe(1_700_000_000_000 + 3000)
    expect(d.messageCount).toBe(5)
  })

  it('reads a big transcript by its head and its tail, without a count', () => {
    const rows = [user('First ask', 1)]
    const filler = 'x'.repeat(4000)
    for (let i = 2; i < 200; i++) rows.push(assistant(filler, i))
    rows.push(user('Last ask', 300))
    put(claudeFile(), rows)
    expect(fs.statSync(claudeFile()).size).toBeGreaterThan(HEAD_BYTES)
    const d = sessionDetails({ agent: 'claude', id: ID }, home)
    expect(d.ok).toBe(true)
    expect(d.firstPrompt).toBe('First ask')
    expect(d.turns.at(-1)).toMatchObject({ role: 'user', text: 'Last ask' })
    expect(d.turns).toHaveLength(3)
    expect(d.turns[0].text).toHaveLength(2000) // cut for display
    expect(d.messageCount).toBe(null)
  })

  it('says so when there is nothing to read', () => {
    expect(sessionDetails({ agent: 'claude', id: ID }, home)).toEqual({ ok: false })
    expect(sessionDetails({ agent: 'gemini', id: ID }, home)).toEqual({ ok: false })
  })
})

describe('reveal and delete', () => {
  it('reveals the file, or says it is missing', () => {
    put(claudeFile(), [user('hello', 1)])
    const show = vi.fn()
    expect(revealSessionFile({ agent: 'claude', id: ID }, home, {}, show)).toEqual({ ok: true })
    expect(show).toHaveBeenCalledWith(claudeFile())
    expect(revealSessionFile({ agent: 'claude', id: OTHER }, home, {}, show)).toEqual({ ok: false, error: 'missing' })
  })

  it("removes a Claude Code transcript and its sub-agents folder, a Grok session's folder, never more", () => {
    put(claudeFile(), [user('hello', 1)])
    const sidecar = join(home, '.claude', 'projects', 'C--proj', ID)
    fs.mkdirSync(join(sidecar, 'subagents'), { recursive: true })
    const found = findSessionFile({ agent: 'claude', id: ID }, home)
    expect(deleteTargets('claude', found)).toEqual([sidecar, claudeFile()])
    const grokRoot = join(home, '.grok', 'sessions')
    const grok = join(grokRoot, 'enc', 'sess_abc123', 'chat_history.jsonl')
    put(grok, [{ type: 'user', content: 'hi' }])
    expect(deleteTargets('grok', { file: grok, root: grokRoot })).toEqual([join(grokRoot, 'enc', 'sess_abc123')])
    // A chat file sitting right under a group folder names no session folder of its own.
    expect(deleteTargets('grok', { file: join(grokRoot, 'enc', 'chat_history.jsonl'), root: grokRoot })).toEqual([])
  })

  it('deletes through the given trash, only the deletable agents', async () => {
    put(claudeFile(), [user('hello', 1)])
    const trashed = []
    const trash = vi.fn(async (p) => trashed.push(p))
    expect(DELETABLE_AGENTS).not.toContain('codex')
    expect(await deleteSession({ agent: 'codex', id: ID }, home, {}, trash)).toEqual({ ok: false, error: 'unsupported' })
    expect(await deleteSession({ agent: 'claude', id: OTHER }, home, {}, trash)).toEqual({ ok: false, error: 'missing' })
    expect(await deleteSession({ agent: 'claude', id: ID }, home, {}, trash)).toEqual({ ok: true })
    expect(trashed).toEqual([claudeFile()])
    const failing = vi.fn(async () => {
      throw new Error('locked')
    })
    expect(await deleteSession({ agent: 'claude', id: ID }, home, {}, failing)).toEqual({ ok: false, error: 'failed' })
  })
})
