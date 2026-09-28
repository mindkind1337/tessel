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
