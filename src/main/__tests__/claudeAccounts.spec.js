// @vitest-environment node
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import fsp from 'fs/promises'
import os from 'os'
import { join, resolve, sep } from 'path'
import { createClaudeAccounts } from '../claudeAccounts'

// These use real, fsynced files and guarded Windows paths; concurrent suite I/O
// can exceed Vitest's 5-second unit-test default.
vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 })

const MARKER = '.tessel-managed-claude-auth'
const NOW = Date.parse('2026-09-28T03:00:00Z')
let root, home, userData, service, runner, selectedIdentity
const who = (name = 'managed') => ({
  accountUuid: `${name}-id`,
  emailAddress: `${name}@fixture.invalid`,
  organizationUuid: `${name}-org`,
  organizationName: `Fixture ${name}`
})
const token = (name = 'managed', suffix = 'original', expiresAt = NOW + 100000) => ({
  claudeAiOauth: {
    accessToken: `fixture-access-${name}-${suffix}`,
    refreshToken: `fixture-refresh-${name}-${suffix}`,
    expiresAt,
    subscriptionType: 'max'
  }
})
const raw = (value) => JSON.stringify(value, null, 2) + '\n'
function put(path, value) {
  fs.mkdirSync(join(path, '..'), { recursive: true })
  fs.writeFileSync(path, typeof value === 'string' ? value : raw(value))
}
const read = (path) => JSON.parse(fs.readFileSync(path, 'utf8'))
const credentialPath = () => join(home, '.claude', '.credentials.json')
const configPath = () => join(home, '.claude.json')
const indexPath = () => join(userData, 'claude-accounts', 'accounts.json')
const runtimePath = (name) => join(userData, 'claude-runtime-auth', name)
const authPath = (id) => join(userData, 'claude-accounts', id, 'auth')
function create(extra = {}) {
  return createClaudeAccounts({
    userData,
    home,
    env: {},
    runLogin: runner,
    now: () => NOW,
    ...extra
  })
}
function seedSystem() {
  put(credentialPath(), token('system'))
  put(configPath(), { theme: 'dark', projects: { fixture: true }, oauthAccount: who('system') })
}
async function add(name = 'managed') {
  selectedIdentity = name
  return (await service.add()).account.id
}
beforeEach(() => {
  root = fs.mkdtempSync(join(os.tmpdir(), 'tessel-claude-accounts-'))
  home = join(root, 'home')
  userData = join(root, 'data')
  fs.mkdirSync(home)
  selectedIdentity = 'managed'
  runner = vi.fn(async ({ provider, home: isolated }) => {
    expect(provider).toBe('claude')
    expect(isolated).not.toBe(home)
    expect(isolated.startsWith(userData + sep)).toBe(true)
    put(join(isolated, '.credentials.json'), token(selectedIdentity))
    put(join(isolated, '.claude.json'), { oauthAccount: who(selectedIdentity) })
    return {
      ok: true,
      status: {
        loggedIn: true,
        email: `${selectedIdentity}@fixture.invalid`,
        orgId: `${selectedIdentity}-org`,
        orgName: `Fixture ${selectedIdentity}`
      }
    }
  })
  service = create()
})
afterEach(() => {
  vi.restoreAllMocks()
  const path = resolve(root)
  if (!path.startsWith(resolve(os.tmpdir()) + sep) || !path.includes('tessel-claude-accounts-'))
    throw new Error('Unsafe fixture cleanup')
  fs.rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
})

describe('Claude account capture and public state', () => {
  it('binds quota scope to the selected private identity without materializing auth', async () => {
    seedSystem()
    const id = await add()
    expect(await service.usageScope(id)).toMatchObject({ ok: false })
    expect(await service.usageScope(null)).toEqual({
      ok: true,
      env: {},
      accountId: null,
      expectedIdentity: null
    })
    await service.select(id)
    // An external CLI login changed the runtime. Reading scope must preserve it
    // and return the expected saved identity, not relabel it as the new login.
    put(credentialPath(), token('different'))
    put(configPath(), { oauthAccount: who('different') })
    const before = fs.readFileSync(credentialPath(), 'utf8')
    const result = await service.usageScope(id)
    expect(result).toEqual({
      ok: true,
      env: {},
      accountId: id,
      expectedIdentity: {
        account: 'managed-id',
        email: 'managed@fixture.invalid',
        organization: 'managed-org'
      }
    })
    expect(JSON.stringify(result)).not.toMatch(/fixture-access|fixture-refresh/)
    expect(fs.readFileSync(credentialPath(), 'utf8')).toBe(before)
    expect(await service.usageScope(null)).toMatchObject({ ok: false })
  })
  it('captures an isolated login without changing system auth or exposing tokens', async () => {
    seedSystem()
    const before = fs.readFileSync(credentialPath(), 'utf8')
    const id = await add()
    const listing = await service.list()
    expect(listing).toMatchObject({
      provider: 'claude',
      selectedId: null,
      system: { status: 'ready' },
      accounts: [
        { id, status: 'ready', active: false, email: 'managed@fixture.invalid', plan: 'max' }
      ]
    })
    expect(JSON.stringify(listing)).not.toMatch(
      /fixture-access|fixture-refresh|credentials|oauthAccount/
    )
    expect(fs.readFileSync(credentialPath(), 'utf8')).toBe(before)
    expect(fs.readFileSync(join(authPath(id), MARKER), 'utf8')).toBe(`${id}\n`)
    expect(fs.readdirSync(runtimePath('')).filter((name) => name.startsWith('login-'))).toEqual([])
  })
  it('rejects missing/empty credentials and sanitizes login failures', async () => {
    runner.mockImplementationOnce(async () => ({
      ok: false,
      error: 'fixture-access-secret raw stderr'
    }))
    await expect(service.add()).rejects.toThrow('Claude login did not complete')
    runner.mockImplementationOnce(async ({ home: isolated }) => {
      put(join(isolated, '.credentials.json'), { claudeAiOauth: { accessToken: '' } })
      return { ok: true, status: { loggedIn: true } }
    })
    await expect(service.add()).rejects.toThrow('missing or invalid')
    expect((await service.list()).accounts).toEqual([])
  })
  it.each(['wrong-email', 'wrong-org', 'logged-out', 'credential-conflict'])(
    'requires consistent identity: %s',
    async (mode) => {
      runner.mockImplementationOnce(async ({ home: isolated }) => {
        const value = token()
        if (mode === 'credential-conflict') value.claudeAiOauth.email = 'other@fixture.invalid'
        put(join(isolated, '.credentials.json'), value)
        put(join(isolated, '.claude.json'), { oauthAccount: who() })
        return {
          ok: true,
          status: {
            loggedIn: mode !== 'logged-out',
            email: mode === 'wrong-email' ? 'other@fixture.invalid' : who().emailAddress,
            orgId: mode === 'wrong-org' ? 'other-org' : who().organizationUuid
          }
        }
      })
      await expect(service.add()).rejects.toThrow('identity could not be verified')
      expect((await service.list()).accounts).toHaveLength(0)
    }
  )
  it('preserves a prior login after failed or wrong-account reauthentication', async () => {
    const id = await add()
    const before = fs.readFileSync(join(authPath(id), '.credentials.json'), 'utf8')
    selectedIdentity = 'other'
    await expect(service.reauthenticate(id)).rejects.toThrow('identity could not be verified')
    expect(fs.readFileSync(join(authPath(id), '.credentials.json'), 'utf8')).toBe(before)
    expect((await service.list()).accounts[0].status).toBe('ready')
  })
  it('keeps list responsive and waits for cancelled login runner settlement before cleanup', async () => {
    let release, entered
    const started = new Promise((resolve) => {
      entered = resolve
    })
    runner.mockImplementationOnce(
      ({ home: isolated }) =>
        new Promise((resolve) => {
          release = () => resolve({ ok: false })
          entered(isolated)
        })
    )
    const controller = new AbortController()
    const pending = service.add({ signal: controller.signal })
    const rejected = expect(pending).rejects.toThrow('cancelled')
    const isolated = await started
    controller.abort()
    expect((await service.list()).accounts).toEqual([])
    expect(fs.existsSync(isolated)).toBe(true)
    release()
    await rejected
    expect(fs.existsSync(isolated)).toBe(false)
  })
  it.each([false, true])(
    'retains staging when process death is unconfirmed (aborted=%s)',
    async (aborted) => {
      const controller = new AbortController()
      let isolated
      runner.mockImplementationOnce(async ({ home: directory }) => {
        isolated = directory
        put(join(directory, '.credentials.json'), token('incomplete'))
        if (aborted) controller.abort()
        return { ok: false, cleanupSafe: false, error: 'raw fixture-access-secret stderr' }
      })
      await expect(service.add({ signal: controller.signal })).rejects.toThrow(
        'Temporary files were retained because process termination could not be confirmed'
      )
      expect(fs.existsSync(isolated)).toBe(true)
      expect(fs.existsSync(join(isolated, MARKER))).toBe(true)
      expect(read(join(isolated, '.credentials.json'))).toEqual(token('incomplete'))
      expect((await service.list()).accounts).toEqual([])
    }
  )
})

describe('system account switching and restoration', () => {
  it('snapshots original auth once, preserves unrelated config and restores after switching accounts', async () => {
    seedSystem()
    const original = fs.readFileSync(credentialPath(), 'utf8')
    const first = await add('one'),
      second = await add('two')
    expect(await service.select(first)).toMatchObject({
      ok: true,
      selectedId: first,
      restartRequired: true
    })
    const snap = fs.readFileSync(runtimePath('system-default-auth.json'), 'utf8')
    put(configPath(), { ...read(configPath()), theme: 'light', newSetting: 7 })
    await service.select(second)
    expect(fs.readFileSync(runtimePath('system-default-auth.json'), 'utf8')).toBe(snap)
    expect(read(configPath())).toMatchObject({
      theme: 'light',
      newSetting: 7,
      oauthAccount: who('two')
    })
    expect(await service.select(null)).toMatchObject({
      ok: true,
      selectedId: null,
      restartRequired: true
    })
    expect(fs.readFileSync(credentialPath(), 'utf8')).toBe(original)
    expect(read(configPath())).toMatchObject({
      theme: 'light',
      newSetting: 7,
      oauthAccount: who('system')
    })
    expect(await service.launchEnv()).toEqual({ ok: true, env: {}, accountId: null })
  })
  it('restores originally absent credentials/oauth while retaining settings added during use', async () => {
    const id = await add()
    await service.select(id)
    put(configPath(), { ...read(configPath()), theme: 'keep' })
    await service.select(null)
    expect(fs.existsSync(credentialPath())).toBe(false)
    expect(read(configPath())).toEqual({ theme: 'keep' })
    expect((await service.list()).system.status).toBe('missing')
  })
  it('does not rewrite identical system credentials or config on repeated launches', async () => {
    seedSystem()
    const id = await add()
    await service.select(id)
    const rename = vi.spyOn(fsp, 'rename')
    expect(await service.launchEnv()).toEqual({ ok: true, env: {}, accountId: id })
    expect(await service.select(id)).toMatchObject({ restartRequired: false })
    expect(rename).not.toHaveBeenCalled()
  })
  it('uses overridden config-dir paths and leaves the default home auth intact', async () => {
    seedSystem()
    const override = join(root, 'custom-config')
    put(join(override, '.credentials.json'), token('custom'))
    put(join(override, '.claude.json'), { custom: 1, oauthAccount: who('custom') })
    service = create({ env: { CLAUDE_CONFIG_DIR: override } })
    const id = await add()
    await service.select(id)
    expect(await service.launchEnv()).toEqual({
      ok: true,
      env: { CLAUDE_CONFIG_DIR: override },
      accountId: id
    })
    expect(read(join(override, '.claude.json'))).toMatchObject({ custom: 1, oauthAccount: who() })
    expect(read(credentialPath())).toEqual(token('system'))
    await service.select(null)
    expect(await service.launchEnv()).toEqual({ ok: true, env: {}, accountId: null })
    expect(read(join(override, '.credentials.json'))).toEqual(token('custom'))
  })
  it('restores before deleting the selected account and rejects arbitrary account paths', async () => {
    seedSystem()
    const id = await add()
    await service.select(id)
    await expect(service.remove('../home')).rejects.toThrow('Unknown Claude account')
    await service.remove(id)
    expect(read(credentialPath())).toEqual(token('system'))
    expect(fs.existsSync(authPath(id))).toBe(false)
    expect((await service.list()).accounts).toEqual([])
  })
  it.each(['missing-auth', 'missing-record'])(
    'restores system auth on launch when selection is invalid: %s',
    async (mode) => {
      seedSystem()
      const id = await add()
      await service.select(id)
      if (mode === 'missing-auth') fs.unlinkSync(join(authPath(id), '.credentials.json'))
      else put(indexPath(), { ...read(indexPath()), accounts: [] })
      expect(await create().launchEnv()).toMatchObject({
        ok: false,
        error: expect.stringContaining('System default was restored')
      })
      expect(read(credentialPath())).toEqual(token('system'))
      expect(read(indexPath()).selectedId).toBeNull()
    }
  )
  it('captures a newer system login when leaving System default again', async () => {
    seedSystem()
    const id = await add()
    await service.select(id)
    await service.select(null)
    put(credentialPath(), token('new-system'))
    put(configPath(), { theme: 'new', oauthAccount: who('new-system') })
    await service.select(id)
    await service.select(null)
    expect(read(credentialPath())).toEqual(token('new-system'))
    expect(read(configPath())).toEqual({ theme: 'new', oauthAccount: who('new-system') })
  })
  it('keeps an earlier snapshot intact if the new system login cannot be read', async () => {
    seedSystem()
    const id = await add()
    await service.select(id)
    await service.select(null)
    const before = fs.readFileSync(runtimePath('system-default-auth.json'), 'utf8')
    const original = fsp.open.bind(fsp)
    vi.spyOn(fsp, 'open').mockImplementation(async (path, ...rest) => {
      if (path === configPath() && rest[0] === 'r')
        throw Object.assign(new Error('fixture failure'), { code: 'EACCES' })
      return original(path, ...rest)
    })
    await expect(service.select(id)).rejects.toThrow('unavailable or invalid')
    expect(fs.readFileSync(runtimePath('system-default-auth.json'), 'utf8')).toBe(before)
    expect(read(indexPath()).selectedId).toBeNull()
  })
  it('preserves an explicit null OAuth field and permits an unsigned system launch', async () => {
    put(configPath(), { oauthAccount: null, theme: 'keep' })
    expect(await service.launchEnv()).toEqual({ ok: true, env: {}, accountId: null })
    const id = await add()
    await service.select(id)
    await service.select(null)
    expect(read(configPath())).toEqual({ oauthAccount: null, theme: 'keep' })
    expect(fs.existsSync(credentialPath())).toBe(false)
  })
  it('permits System default with a valid provider-only credential document', async () => {
    put(credentialPath(), { providerCredential: 'fixture-provider-value' })
    expect((await service.list()).system.status).toBe('missing')
    expect(await service.launchEnv()).toEqual({ ok: true, env: {}, accountId: null })
    expect(read(credentialPath())).toEqual({ providerCredential: 'fixture-provider-value' })
  })
  it('updates selected runtime auth only after a successful same-account reauthentication', async () => {
    seedSystem()
    const id = await add()
    await service.select(id)
    runner.mockImplementationOnce(async ({ home: isolated }) => {
      put(join(isolated, '.credentials.json'), token('managed', 'reauthenticated'))
      put(join(isolated, '.claude.json'), { oauthAccount: who() })
      return {
        ok: true,
        status: { loggedIn: true, email: who().emailAddress, orgId: who().organizationUuid }
      }
    })
    expect(await service.reauthenticate(id)).toMatchObject({ ok: true, restartRequired: true })
    expect(read(credentialPath())).toEqual(token('managed', 'reauthenticated'))
    await service.select(null)
    expect(read(credentialPath())).toEqual(token('system'))
  })
})

describe('refresh identity and protected unknown state', () => {
  it('captures refreshed credentials only with positive matching identity', async () => {
    seedSystem()
    const id = await add()
    await service.select(id)
    const newer = token('managed', 'refreshed', NOW + 200000)
    put(credentialPath(), newer)
    await service.launchEnv()
    expect(read(join(authPath(id), '.credentials.json'))).toEqual(newer)
    await service.select(null)
    await service.select(id)
    expect(read(credentialPath())).toEqual(newer)
  })
  it.each(['other-identity', 'empty-token', 'stale-token', 'embedded-conflict'])(
    'does not copy unproven runtime credentials into an account: %s',
    async (mode) => {
      seedSystem()
      const id = await add()
      await service.select(id)
      const before = read(join(authPath(id), '.credentials.json'))
      const replacement = token(
        'unproven',
        'changed',
        mode === 'stale-token' ? NOW - 1 : NOW + 200000
      )
      if (mode === 'empty-token') replacement.claudeAiOauth.accessToken = ''
      if (mode === 'embedded-conflict') replacement.claudeAiOauth.accountUuid = 'different-id'
      put(credentialPath(), replacement)
      if (mode === 'other-identity') put(configPath(), { oauthAccount: who('other') })
      await service.select(null)
      expect(read(join(authPath(id), '.credentials.json'))).toEqual(before)
    }
  )
  it('does not mistake system permission failures for absent auth', async () => {
    seedSystem()
    const id = await add()
    const original = fsp.open.bind(fsp)
    vi.spyOn(fsp, 'open').mockImplementation(async (path, ...rest) => {
      if (path === credentialPath() && rest[0] === 'r')
        throw Object.assign(new Error('fixture secret'), { code: 'EACCES' })
      return original(path, ...rest)
    })
    expect((await service.list()).system.status).toBe('unknown')
    await expect(service.select(id)).rejects.toThrow('unavailable or invalid')
    expect(fs.existsSync(runtimePath('system-default-auth.json'))).toBe(false)
    expect(read(indexPath()).selectedId).toBeNull()
  })
  it('refuses malformed config, registry and selected credentials without replacing them', async () => {
    seedSystem()
    const id = await add()
    put(configPath(), '{invalid secret')
    await expect(service.select(id)).rejects.toThrow('unavailable or invalid')
    expect(fs.readFileSync(configPath(), 'utf8')).toBe('{invalid secret')
    seedSystem()
    await service.select(id)
    put(join(authPath(id), '.credentials.json'), '{bad')
    expect((await service.list()).accounts[0].status).toBe('unknown')
    await expect(service.launchEnv()).rejects.toThrow('unreadable')
    put(indexPath(), '{bad registry')
    await expect(service.select(null)).rejects.toThrow('unavailable or invalid')
  })
  it('refuses an auth directory junction and never deletes its external target', async () => {
    const id = await add()
    const path = authPath(id)
    const target = join(root, 'external-auth')
    fs.renameSync(path, target)
    fs.symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')
    expect((await service.list()).accounts[0].status).toBe('unknown')
    await expect(service.select(id)).rejects.toThrow('valid login')
    await expect(service.remove(id)).rejects.toThrow('cannot be removed safely')
    expect(read(join(target, '.credentials.json'))).toEqual(token())
  })
  it('refuses an ancestor junction or corrupted ownership marker', async () => {
    const id = await add()
    put(join(authPath(id), MARKER), 'not-owned\n')
    await expect(service.remove(id)).rejects.toThrow('cannot be removed safely')
    const linked = join(root, 'linked-data')
    fs.symlinkSync(userData, linked, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(create({ userData: linked }).list()).rejects.toThrow('unavailable or invalid')
  })
})

describe('transactions and recovery', () => {
  it('rolls back system credentials and OAuth when metadata commit fails, retaining unrelated settings', async () => {
    seedSystem()
    const id = await add()
    const original = fsp.rename.bind(fsp)
    let failed = false
    vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (to === indexPath() && !failed) {
        failed = true
        put(configPath(), { ...read(configPath()), addedDuringOperation: true })
        throw Object.assign(new Error('fixture-secret'), { code: 'EIO' })
      }
      return original(from, to)
    })
    await expect(service.select(id)).rejects.toThrow('previous login was restored')
    expect(read(credentialPath())).toEqual(token('system'))
    expect(read(configPath())).toMatchObject({
      oauthAccount: who('system'),
      addedDuringOperation: true
    })
    expect(read(indexPath()).selectedId).toBeNull()
    expect(fs.existsSync(runtimePath('transaction.json'))).toBe(false)
  })
  it('retains a durable intent when rollback fails and recovers before the next launch', async () => {
    seedSystem()
    const id = await add()
    const original = fsp.rename.bind(fsp)
    let credentialWrites = 0
    const spy = vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (to === credentialPath()) credentialWrites++
      if (to === indexPath() || (to === credentialPath() && credentialWrites > 1))
        throw Object.assign(new Error('secret'), { code: 'EIO' })
      return original(from, to)
    })
    await expect(service.select(id)).rejects.toThrow('could not be rolled back')
    expect(fs.existsSync(runtimePath('transaction.json'))).toBe(true)
    spy.mockRestore()
    expect(await create().launchEnv()).toEqual({ ok: true, env: {}, accountId: null })
    expect(read(credentialPath())).toEqual(token('system'))
    expect(read(configPath()).oauthAccount).toEqual(who('system'))
    expect(fs.existsSync(runtimePath('transaction.json'))).toBe(false)
  })
  it('refuses invalid snapshots and journal paths instead of writing a supplied target', async () => {
    seedSystem()
    const id = await add()
    await service.select(id)
    put(runtimePath('system-default-auth.json'), {
      version: 1,
      binding: { credentialsPath: join(root, 'victim') }
    })
    await expect(service.select(null)).rejects.toThrow('snapshot is unavailable or invalid')
    put(runtimePath('transaction.json'), {
      version: 1,
      binding: {},
      changes: [{ kind: 'file', path: join(root, 'victim'), after: 'bad' }]
    })
    await expect(create().launchEnv()).rejects.toThrow('unavailable or invalid')
    expect(fs.existsSync(join(root, 'victim'))).toBe(false)
  })
  it('serializes changes across service instances using the same storage', async () => {
    seedSystem()
    const first = await add('one'),
      second = await add('two')
    await Promise.all([service.select(first), create().select(second)])
    expect(read(indexPath()).selectedId).toBe(second)
    expect(read(credentialPath())).toEqual(token('two'))
  })
})

describe('saved pane account scope', () => {
  it('refuses mismatched saved managed/system accounts without changing global files', async () => {
    seedSystem()
    const first = await add('one'),
      second = await add('two')
    await service.select(first)
    const credentialsBefore = fs.readFileSync(credentialPath(), 'utf8')
    const configBefore = fs.readFileSync(configPath(), 'utf8')
    const indexBefore = fs.readFileSync(indexPath(), 'utf8')
    const rename = vi.spyOn(fsp, 'rename')
    const unlink = vi.spyOn(fsp, 'unlink')
    for (const id of [second, null, 'ffffffff-ffff-4fff-8fff-ffffffffffff']) {
      expect(await service.launchEnv(id)).toEqual({
        ok: false,
        error:
          "Select this pane's saved Claude account in AI provider accounts before restarting it."
      })
    }
    expect(rename).not.toHaveBeenCalled()
    expect(unlink).not.toHaveBeenCalled()
    expect(fs.readFileSync(credentialPath(), 'utf8')).toBe(credentialsBefore)
    expect(fs.readFileSync(configPath(), 'utf8')).toBe(configBefore)
    expect(fs.readFileSync(indexPath(), 'utf8')).toBe(indexBefore)
    expect(await service.launchEnv(first)).toEqual({ ok: true, env: {}, accountId: first })
  })
  it('permits a matching saved System default and does not restore missing explicit auth', async () => {
    seedSystem()
    expect(await service.launchEnv(null)).toEqual({ ok: true, env: {}, accountId: null })
    const id = await add()
    await service.select(id)
    fs.unlinkSync(join(authPath(id), '.credentials.json'))
    const before = fs.readFileSync(credentialPath(), 'utf8')
    expect(await service.launchEnv(id)).toMatchObject({
      ok: false,
      error: expect.stringContaining("pane's saved Claude account")
    })
    expect(fs.readFileSync(credentialPath(), 'utf8')).toBe(before)
    expect(read(indexPath()).selectedId).toBe(id)
    expect(await service.launchEnv()).toMatchObject({
      ok: false,
      error: expect.stringContaining('System default was restored')
    })
  })
  it('resolves saved history scope read-only, including a valid nonselected managed account', async () => {
    const override = join(root, 'history-config')
    service = create({ env: { CLAUDE_CONFIG_DIR: override } })
    const first = await add('one'),
      second = await add('two')
    await service.select(first)
    const rename = vi.spyOn(fsp, 'rename')
    const unlink = vi.spyOn(fsp, 'unlink')
    for (const [argument, id] of [
      [undefined, first],
      [second, second],
      [null, null]
    ]) {
      expect(await service.sessionEnv(argument)).toEqual({
        ok: true,
        env: { CLAUDE_CONFIG_DIR: override },
        accountId: id
      })
    }
    expect(await service.sessionEnv('ffffffff-ffff-4fff-8fff-ffffffffffff')).toMatchObject({
      ok: false
    })
    fs.unlinkSync(join(authPath(second), '.credentials.json'))
    expect(await service.sessionEnv(second)).toMatchObject({ ok: false })
    expect(rename).not.toHaveBeenCalled()
    expect(unlink).not.toHaveBeenCalled()
    expect(read(indexPath()).selectedId).toBe(first)
    expect(read(join(override, '.credentials.json'))).toEqual(token('one'))
  })
})
