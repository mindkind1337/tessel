// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { join } from 'node:path'
vi.mock('../providerUsage', async (original) => ({
  ...(await original()),
  createProviderUsage: vi.fn()
}))
import { createLiveUsageIngest, loginFolder, registerProviderUsage } from '../providerUsageIpc'

// Fixture folders only: nothing is read from disk.
const HOME = join(process.platform === 'win32' ? 'C:\\' : '/', 'fixture-home')
const WORK = join(HOME, 'accounts', 'work')

function accountsFixture({ selectedId = null, env = {}, status = 'ready' } = {}) {
  return {
    list: vi.fn(async () => ({
      ok: true,
      providers: ['claude', 'codex'].map((provider) => ({
        provider,
        selectedId,
        system: { status },
        accounts: [{ id: 'work', status }]
      }))
    })),
    usageScope: vi.fn(async (_provider, accountId) => ({ ok: true, accountId, env }))
  }
}

function setup(options = {}) {
  let now = 1_000_000
  const clock = () => now
  const poller = { ingest: vi.fn(() => ({ ok: true })) }
  const accounts = accountsFixture(options)
  const live = createLiveUsageIngest({ accounts, poller, clock, home: HOME, base: {} })
  const rateLimit = { fiveHour: { utilization: 0.4, resetsAt: 2_000_000 }, sevenDay: null }
  return { live, poller, accounts, rateLimit, advance: (ms) => (now += ms), now: () => now }
}

describe('live usage ingest', () => {
  it('finds the login folder from the variables, else the default', () => {
    expect(loginFolder('codex', {}, { home: HOME, base: {} })).toBe(
      process.platform === 'win32' ? join(HOME, '.codex').toLowerCase() : join(HOME, '.codex')
    )
    expect(loginFolder('claude', { CLAUDE_CONFIG_DIR: WORK }, { home: HOME, base: {} })).toBe(
      process.platform === 'win32' ? WORK.toLowerCase() : WORK
    )
    expect(loginFolder('claude', { CLAUDE_CONFIG_DIR: 'relative' }, { home: HOME, base: {} })).toBe(null)
    expect(loginFolder('kimi', {}, { home: HOME, base: {} })).toBe(null)
  })

  it('feeds a chat of the shown (system) account to the poller', async () => {
    const { live, poller, rateLimit } = setup()
    await live.ingest({ provider: 'claude', env: {}, since: 1, rateLimit })
    expect(poller.ingest).toHaveBeenCalledWith('claude', null, rateLimit)
  })

  it('feeds a chat of the selected saved account (same CODEX_HOME)', async () => {
    const { live, poller, rateLimit } = setup({ selectedId: 'work', env: { CODEX_HOME: WORK } })
    await live.ingest({ provider: 'codex', env: { CODEX_HOME: WORK + (process.platform === 'win32' ? '\\' : '/') }, since: 1, rateLimit })
    expect(poller.ingest).toHaveBeenCalledWith('codex', 'work', rateLimit)
  })

  it('skips a chat running under another account', async () => {
    const { live, poller, rateLimit } = setup({ selectedId: 'work', env: { CODEX_HOME: WORK } })
    await live.ingest({ provider: 'codex', env: {}, since: 1, rateLimit })
    await live.ingest({ provider: 'codex', env: { CODEX_HOME: join(HOME, 'other') }, since: 1, rateLimit })
    expect(poller.ingest).not.toHaveBeenCalled()
  })

  it('skips a chat started before an account change, and other providers', async () => {
    const { live, poller, rateLimit, advance, now } = setup()
    const started = now()
    advance(1000)
    live.changed('claude')
    await live.ingest({ provider: 'claude', env: {}, since: started, rateLimit })
    await live.ingest({ provider: 'opencode', env: {}, since: now(), rateLimit })
    await live.ingest({ provider: 'claude', env: {}, since: 'soon', rateLimit })
    expect(poller.ingest).not.toHaveBeenCalled()
    advance(1)
    await live.ingest({ provider: 'claude', env: {}, since: now(), rateLimit })
    expect(poller.ingest).toHaveBeenCalledTimes(1)
  })

  it('skips an account that is not signed in', async () => {
    const { live, poller, rateLimit } = setup({ status: 'missing' })
    await live.ingest({ provider: 'claude', env: {}, since: 1, rateLimit })
    expect(poller.ingest).not.toHaveBeenCalled()
  })

  it('remembers the shown account 30 s, and forgets it on a switch', async () => {
    const { live, accounts, rateLimit, advance } = setup()
    await live.ingest({ provider: 'claude', env: {}, since: 1, rateLimit })
    await live.ingest({ provider: 'claude', env: {}, since: 1, rateLimit })
    expect(accounts.list).toHaveBeenCalledTimes(1)
    advance(30_000)
    await live.ingest({ provider: 'claude', env: {}, since: 1, rateLimit })
    expect(accounts.list).toHaveBeenCalledTimes(2)
    live.changed()
    advance(1)
    await live.ingest({ provider: 'claude', env: {}, since: 1_031_001, rateLimit })
    expect(accounts.list).toHaveBeenCalledTimes(3)
  })

  it('registerProviderUsage hands out the ingest, and an account switch resets it', async () => {
    const handlers = new Map()
    const poller = { ingest: vi.fn(), forget: vi.fn(), configure: vi.fn(), read: vi.fn() }
    const accounts = { ...accountsFixture(), select: vi.fn(async () => ({ ok: true })) }
    let ingest = null
    registerProviderUsage({
      ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
      accounts,
      service: { invalidate: vi.fn() },
      poller,
      onLiveIngest: (fn) => {
        ingest = fn
      }
    })
    expect(typeof ingest).toBe('function')
    const since = Date.now() - 1000
    await handlers.get('accounts:select')(null, { provider: 'claude', id: 'work' })
    // Started before the switch: ignored.
    await ingest({ provider: 'claude', env: {}, since, rateLimit: { fiveHour: { utilization: 0.5 } } })
    expect(poller.ingest).not.toHaveBeenCalled()
  })
})
