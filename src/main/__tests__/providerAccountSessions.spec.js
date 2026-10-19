// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join, resolve, relative, sep } from 'path'
import { createAccountSessions } from '../providerAccountSessions'

const A = '11111111-2222-4333-8444-555555555555'
const B = '22222222-2222-4333-8444-555555555555'
const C = '33333333-2222-4333-8444-555555555555'
let root, home, system, managed, claude, accounts, api
function put(path, rows) {
  fs.mkdirSync(join(path, '..'), { recursive: true })
  fs.writeFileSync(path, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
}
function codex(path, id, prompt) {
  const time = new Date(),
    iso = time.toISOString()
  put(
    join(
      path,
      'sessions',
      String(time.getFullYear()),
      String(time.getMonth() + 1).padStart(2, '0'),
      String(time.getDate()).padStart(2, '0'),
      `rollout-fixture-${id}.jsonl`
    ),
    [
      { type: 'session_meta', timestamp: iso, payload: { id, cwd: root, timestamp: iso } },
      { type: 'event_msg', payload: { type: 'user_message', message: prompt } }
    ]
  )
}
beforeEach(() => {
  root = fs.mkdtempSync(join(os.tmpdir(), 'tessel-account-sessions-'))
  home = join(root, 'home')
  fs.mkdirSync(home)
  system = join(root, 'system')
  managed = join(root, 'managed')
  claude = join(root, 'claude-override')
  for (const key of ['GEMINI_CLI_HOME', 'QWEN_RUNTIME_DIR', 'QWEN_HOME', 'XDG_DATA_HOME'])
    vi.stubEnv(key, join(root, key))
  accounts = {
    list: async () => ({
      providers: [{ provider: 'codex', accounts: [{ id: 'managed', label: 'Fixture account' }] }]
    }),
    sessionEnv: vi.fn(async (provider, id) => {
      if (id === 'missing') return { ok: false }
      if (provider === 'claude')
        return { ok: true, env: { CLAUDE_CONFIG_DIR: claude }, accountId: 'claude-id' }
      const chosen = id === undefined ? 'managed' : id
      return {
        ok: true,
        env: { CODEX_HOME: chosen === null ? system : managed },
        accountId: chosen
      }
    })
  }
  api = createAccountSessions({ accounts, home, env: {} })
})
afterEach(() => {
  vi.unstubAllEnvs()
  const rel = relative(resolve(os.tmpdir()), resolve(root))
  if (!rel.startsWith('tessel-account-sessions-') || rel.includes(sep))
    throw new Error('Unexpected fixture cleanup')
  fs.rmSync(root, { recursive: true })
})
describe('account-aware session paths', () => {
  it('finds each Codex pane in its original account, preserving explicit null', async () => {
    codex(system, A, 'System task')
    codex(managed, B, 'Managed task')
    const q = { agent: 'codex', cwd: root, since: Date.now() - 10000 }
    expect(await api.find(q)).toBe(B)
    expect(await api.find({ ...q, accountId: null })).toBe(A)
    expect(await api.find({ ...q, accountId: 'managed' })).toBe(B)
    expect(await api.find({ ...q, accountId: 'missing' })).toBeNull()
    expect(accounts.sessionEnv).toHaveBeenCalledWith('codex', null)
  })
  it('lists both Codex homes with account ids for resuming without changing selection', async () => {
    codex(system, A, 'System task')
    codex(managed, B, 'Managed task')
    const rows = await api.list({ cwd: root })
    expect(rows.find((row) => row.id === A)).toMatchObject({
      accountId: null,
      accountLabel: 'System default'
    })
    expect(rows.find((row) => row.id === B)).toMatchObject({
      accountId: 'managed',
      accountLabel: 'Fixture account'
    })
  })
  it("reads a Codex conversation's sub-agents in the pane's account CODEX_HOME", async () => {
    const time = new Date()
    const iso = time.toISOString()
    const kid = '44444444-2222-4333-8444-555555555555'
    put(
      join(
        managed,
        'sessions',
        String(time.getFullYear()),
        String(time.getMonth() + 1).padStart(2, '0'),
        String(time.getDate()).padStart(2, '0'),
        `rollout-2026-09-28T10-00-00-${kid}.jsonl`
      ),
      [
        { type: 'session_meta', timestamp: iso, payload: { id: kid, session_id: A, parent_thread_id: A, thread_source: 'subagent', agent_nickname: 'Boole', agent_path: '/root/research', timestamp: iso } },
        { type: 'event_msg', timestamp: iso, payload: { type: 'task_started' } }
      ]
    )
    const managedKids = await api.children({ agent: 'codex', sessionId: A, accountId: 'managed' })
    expect(managedKids.map((c) => [c.id, c.title, c.state])).toEqual([[kid, 'research (Boole)', 'running']])
    expect(await api.children({ agent: 'codex', sessionId: A, accountId: null })).toEqual([])
    expect(await api.children({ agent: 'codex', sessionId: A, accountId: 'missing' })).toEqual([])
    expect(await api.children({ agent: 'aider', sessionId: A })).toEqual([])
  })
  it("reads Gemini, Copilot and Kimi sub-agents in the pane's home (Gemini's in GEMINI_CLI_HOME when set)", async () => {
    const at = new Date().toISOString()
    const kid = '44444444-2222-4333-8444-555555555555'
    put(join(home, '.gemini', 'tmp', 'proj', 'chats', A, `${kid}.jsonl`), [{ sessionId: kid, startTime: at, kind: 'subagent' }])
    put(join(home, '.copilot', 'session-state', A, 'events.jsonl'), [{ type: 'subagent.started', timestamp: at, agentId: 'call_1', data: { toolCallId: 'call_1', agentName: 'explore' } }])
    put(join(home, '.kimi-code', 'sessions', 'wd_proj', 'session_fixture', 'agents', 'main', 'wire.jsonl'), [{ type: 'subagent.spawned', time: Date.now(), subagentId: 'agent-1', subagentName: 'coder' }])
    expect((await api.children({ agent: 'gemini', sessionId: A })).map((c) => c.id)).toEqual([kid])
    expect((await api.children({ agent: 'copilot', sessionId: A })).map((c) => c.type)).toEqual(['explore'])
    expect((await api.children({ agent: 'kimi', sessionId: 'session_fixture' })).map((c) => c.id)).toEqual(['agent-1'])
    expect(await api.children({ agent: 'antigravity', sessionId: A })).toEqual([])
    expect(await api.children({ agent: 'cursor', sessionId: A })).toEqual([])
    const other = createAccountSessions({ accounts, home, env: { GEMINI_CLI_HOME: join(root, 'gemini-home') } })
    expect(await other.children({ agent: 'gemini', sessionId: A })).toEqual([])
  })
  it('uses the configured Claude directory and refuses missing scoped accounts', async () => {
    put(join(claude, 'projects', 'fixture', `${C}.jsonl`), [
      {
        type: 'user',
        cwd: root,
        timestamp: new Date().toISOString(),
        message: { content: 'Claude task' }
      }
    ])
    expect(await api.claudeExists(C, { accountId: 'claude-id' })).toBe(true)
    expect(await api.claudeExists(C, { accountId: 'missing' })).toBe(false)
    expect((await api.list()).find((row) => row.id === C)).toMatchObject({ accountId: 'claude-id' })
  })
})

describe('the readers given by index.js (read in the session list process)', () => {
  it("sub-agents and resume lookups go through readChildren / readFind with the account's folder", async () => {
    const readChildren = vi.fn(async (name, ...args) => [{ name, args }])
    const readFind = vi.fn(async (name, ...args) => ({ name, args }))
    const remote = createAccountSessions({ accounts, home, env: {}, readChildren, readFind })
    expect(await remote.children({ agent: 'codex', sessionId: A, accountId: null })).toEqual([{ name: 'codex', args: [A, system] }])
    expect(await remote.children({ agent: 'claude', sessionId: B })).toEqual([{ name: 'claude', args: [B, claude] }])
    expect(await remote.children({ agent: 'cursor', sessionId: C })).toEqual([{ name: 'cursor', args: [C, join(home, '.cursor')] }])
    expect(await remote.children({ agent: 'unknown', sessionId: C })).toEqual([])
    expect(await remote.children({ agent: 'codex', sessionId: A, accountId: 'missing' })).toEqual([])
    expect(await remote.find({ agent: 'claude', sessionId: B })).toEqual({ name: 'findAgentSession', args: [{ agent: 'claude', sessionId: B }, home] })
    const codexFind = await remote.find({ agent: 'codex', accountId: null })
    expect(codexFind.name).toBe('findCodexSession')
    expect(codexFind.args[3]).toBe(system)
    expect(readChildren).toHaveBeenCalledTimes(3)
  })
})

