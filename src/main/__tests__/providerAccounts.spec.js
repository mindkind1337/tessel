// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { createProviderAccounts } from '../providerAccounts'
const tick = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}
function service(provider) {
  return {
    list: vi.fn(async () => ({
      provider,
      selectedId: null,
      system: { label: 'System default', status: 'ready' },
      accounts: []
    })),
    add: vi.fn(async () => ({ ok: true })),
    reauthenticate: vi.fn(async () => ({ ok: true })),
    select: vi.fn(async () => ({ ok: true })),
    remove: vi.fn(async () => ({ ok: true })),
    launchEnv: vi.fn(async () => ({ ok: true, env: {}, accountId: null })),
    usageEnv: vi.fn(async () => ({ ok: true, env: {}, accountId: null }))
  }
}
function fixture() {
  const claude = service('claude'),
    codex = service('codex')
  return { claude, codex, accounts: createProviderAccounts({ claude, codex }) }
}
describe('account IPC coordinator', () => {
  it('resolves private quota scope without launching or exposing it in account listings', async () => {
    const f = fixture()
    f.claude.usageScope = vi.fn(async () => ({
      ok: true,
      accountId: 'managed',
      expectedIdentity: { account: 'private-id' }
    }))
    expect(await f.accounts.usageScope('claude', 'managed')).toMatchObject({
      ok: true,
      expectedIdentity: { account: 'private-id' }
    })
    expect(f.claude.usageScope).toHaveBeenCalledWith('managed')
    expect(f.claude.launchEnv).not.toHaveBeenCalled()
    expect(JSON.stringify(await f.accounts.list())).not.toContain('private-id')
    expect(await f.accounts.usageScope('codex', null)).toMatchObject({ ok: true })
    expect(f.codex.usageEnv).toHaveBeenCalledWith(null)
    f.claude.usageScope.mockRejectedValue(new Error('private auth path'))
    expect(await f.accounts.usageScope('claude')).toEqual({
      ok: false,
      error: 'The selected provider account could not be read.'
    })
  })
  it('shows an unconfirmed process stop as an error, never as a successful cancellation', async () => {
    const f = fixture()
    let fail
    f.claude.add.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject
        })
    )
    const { job } = f.accounts.startLogin('claude')
    await tick()
    f.accounts.cancelLogin(job.id)
    fail(Object.assign(new Error('Temporary files retained.'), { cleanupSafe: false }))
    await tick()
    expect(f.accounts.loginStatus(job.id).job).toMatchObject({
      state: 'error',
      error: 'Temporary files retained.'
    })
  })
  it('whitelists display fields, with no credential blob in list or mutation result', async () => {
    const f = fixture()
    f.codex.list.mockResolvedValue({
      selectedId: 'id',
      credentials: 'SECRET',
      system: { label: 'System default' },
      accounts: [
        {
          id: 'id',
          email: 'x@test.invalid',
          status: 'ready',
          credentials: { token: 'SECRET' },
          auth: 'SECRET'
        }
      ]
    })
    f.claude.select.mockResolvedValue({ ok: true, restartRequired: true, credentials: 'SECRET' })
    expect(JSON.stringify(await f.accounts.list())).not.toContain('SECRET')
    expect(await f.accounts.select('claude', 'id')).toEqual({ ok: true, restartRequired: true })
  })
  it('keeps a failed provider visible as unknown rather than pretending its accounts were removed', async () => {
    const f = fixture()
    f.claude.list.mockRejectedValue(new Error('secret path'))
    const result = await f.accounts.list()
    expect(result.providers[0].system.status).toBe('unknown')
    expect(result.providers[0].error).toMatch(/kept/)
    expect(result.providers[1].system.status).toBe('ready')
  })
  it('starts background login once and refuses overlapping provider mutations until it completes', async () => {
    const f = fixture()
    let finish, options
    f.codex.add.mockImplementation((opts) => {
      options = opts
      return new Promise((r) => {
        finish = r
      })
    })
    const started = f.accounts.startLogin('codex')
    expect(started.job.state).toBe('running')
    await tick()
    expect(f.accounts.startLogin('codex').ok).toBe(false)
    expect((await f.accounts.select('codex', 'id')).ok).toBe(false)
    expect((await f.accounts.remove('codex', 'id')).ok).toBe(false)
    expect((await f.accounts.launchEnv('codex')).ok).toBe(false)
    expect((await f.accounts.select('claude', null)).ok).toBe(true)
    options.onProgress({ url: 'file:///secret' })
    expect(f.accounts.loginStatus(started.job.id).job.url).toBeNull()
    options.onProgress({ url: 'https://auth.openai.com/oauth/authorize?state=fixture' })
    expect((await f.accounts.list()).jobs[0].url).toContain('state=fixture')
    finish({ ok: true, secret: 'SECRET' })
    await tick()
    expect(f.accounts.loginStatus(started.job.id).job).toMatchObject({ state: 'done', url: null })
    expect(JSON.stringify(f.accounts.loginStatus(started.job.id))).not.toContain('SECRET')
    expect((await f.accounts.launchEnv('codex')).ok).toBe(true)
  })
  it('cancellation stays in flight until the backend finishes cleanup, and close waits too', async () => {
    const f = fixture()
    let finish, opts
    f.claude.reauthenticate.mockImplementation((id, options) => {
      opts = options
      return new Promise((r) => {
        finish = r
      })
    })
    const { job } = f.accounts.startLogin('claude', 'id')
    await tick()
    expect(f.accounts.cancelLogin(job.id).job.cancelling).toBe(true)
    expect(opts.signal.aborted).toBe(true)
    expect(f.accounts.startLogin('claude').ok).toBe(false)
    let closed = false
    const closing = f.accounts.close().then(() => {
      closed = true
    })
    await tick()
    expect(closed).toBe(false)
    finish({ ok: false, error: 'Sign-in cancelled.' })
    await closing
    expect(f.accounts.loginStatus(job.id).job.state).toBe('cancelled')
  })
  it('preserves system environment and removes competing auth overrides only for a chosen managed account', async () => {
    const f = fixture()
    expect(await f.accounts.launchEnv('codex')).toMatchObject({
      env: {},
      unsetEnv: [],
      accountId: null
    })
    f.codex.launchEnv.mockResolvedValue({
      ok: true,
      env: { CODEX_HOME: 'managed' },
      accountId: 'id'
    })
    const selected = await f.accounts.launchEnv('codex')
    expect(selected.env).toEqual({ CODEX_HOME: 'managed' })
    expect(selected.unsetEnv).toContain('OPENAI_API_KEY')
    expect(selected.unsetEnv).toContain('CODEX_HOME')
    expect(await f.accounts.launchEnv('gemini')).toMatchObject({ ok: true, env: {}, unsetEnv: [] })
    f.codex.launchEnv.mockRejectedValue(new Error('Account home unreadable.'))
    expect(await f.accounts.launchEnv('codex')).toEqual({
      ok: false,
      error: 'Account home unreadable.'
    })
  })
  it('rejects unknown providers and missing jobs without executing a backend', async () => {
    const f = fixture()
    expect(f.accounts.startLogin('__proto__').ok).toBe(false)
    expect((await f.accounts.select('constructor', null)).ok).toBe(false)
    expect(f.accounts.loginStatus('nope').ok).toBe(false)
    expect(f.accounts.cancelLogin('nope').ok).toBe(false)
    expect(f.codex.add).not.toHaveBeenCalled()
    expect(f.claude.select).not.toHaveBeenCalled()
  })
  it('routes usage to the read-only backend without materializing launch resources', async () => {
    const f = fixture()
    expect(await f.accounts.usageEnv()).toMatchObject({ ok: true, env: {} })
    expect(f.codex.launchEnv).not.toHaveBeenCalled()
    f.codex.usageEnv.mockRejectedValue(new Error('EACCES credentials'))
    expect((await f.accounts.usageEnv()).ok).toBe(false)
  })
})
