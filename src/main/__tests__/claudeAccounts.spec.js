// @vitest-environment node
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import fsp from 'fs/promises'
import os from 'os'
import { join, resolve, sep } from 'path'
import { createClaudeAccounts, SHARED_FOLDERS, accountState, sharedStateKey } from '../claudeAccounts'
import { createProviderUsage } from '../providerUsage'

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
const systemDir = () => join(home, '.claude')
const credentialPath = () => join(home, '.claude', '.credentials.json')
const configPath = () => join(home, '.claude.json')
const indexPath = () => join(userData, 'claude-accounts', 'accounts.json')
const runtimePath = (name) => join(userData, 'claude-runtime-auth', name)
const authPath = (id) => join(userData, 'claude-accounts', id, 'auth')
const isLink = (path) => {
  try {
    return fs.lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}
const same = (a, b) => fs.realpathSync(a).toLowerCase() === fs.realpathSync(b).toLowerCase()
// Every file under a folder, never through a link or junction.
function filesUnder(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) filesUnder(path, out)
    else out.push(path)
  }
  return out
}
// Another volume: no hard link from the account folder to the system one;
// within the system folder (a copy put in place), they work.
const otherVolume = () => {
  const link = fsp.link.bind(fsp)
  return vi.spyOn(fsp, 'link').mockImplementation(async (from, to) => {
    if (!String(from).includes('.tessel-move-')) throw Object.assign(new Error('other volume'), { code: 'EXDEV' })
    return link(from, to)
  })
}
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
// What an older version left after "selecting" an account: its login in the
// system files and a snapshot of the system's own login.
function legacySwitch(id, systemToken = null) {
  const original = fs.readFileSync(credentialPath(), 'utf8')
  const config = read(configPath())
  put(runtimePath('system-default-auth.json'), {
    version: 1,
    binding: { credentialsPath: credentialPath(), configPath: configPath() },
    credentials: original,
    oauth: { present: true, value: config.oauthAccount }
  })
  put(credentialPath(), systemToken || read(join(authPath(id), '.credentials.json')))
  put(configPath(), { ...config, oauthAccount: who('managed') })
  put(indexPath(), { ...read(indexPath()), selectedId: id })
  return original
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
  it('captures an isolated login without changing system auth or exposing tokens', async () => {
    seedSystem()
    const before = fs.readFileSync(credentialPath(), 'utf8')
    const config = fs.readFileSync(configPath(), 'utf8')
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
    expect(fs.readFileSync(configPath(), 'utf8')).toBe(config)
    expect(fs.readFileSync(join(authPath(id), MARKER), 'utf8')).toBe(`${id}\n`)
    // Its own .claude.json right away: its identity, the system's shared settings.
    expect(read(join(authPath(id), '.claude.json'))).toMatchObject({ oauthAccount: who(), theme: 'dark' })
    expect(fs.readdirSync(runtimePath('')).filter((name) => name.startsWith('login-'))).toEqual([])
  })
  it('lists the system sign-in like an added account: email, organization and plan, never a token', async () => {
    seedSystem()
    const listing = await service.list()
    expect(listing.system).toEqual({
      id: null,
      label: 'System default',
      status: 'ready',
      email: 'system@fixture.invalid',
      organization: 'Fixture system',
      plan: 'max'
    })
    expect(JSON.stringify(listing)).not.toMatch(/fixture-access|fixture-refresh|system-id|accessToken/)
    // Signed out: no plan, its email still shown when Claude kept it.
    fs.unlinkSync(credentialPath())
    expect((await service.list()).system).toMatchObject({ status: 'missing', email: 'system@fixture.invalid', plan: null })
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
  it.each([['no login', {}], ['a null login', { claudeAiOauth: null }]])(
    'an account signed out in its folder (%s) needs a sign-in, and "Sign in again" works',
    async (_name, value) => {
      seedSystem()
      const id = await add()
      await service.select(id)
      put(join(authPath(id), '.credentials.json'), value)
      expect((await service.list()).accounts[0].status).toBe('missing')
      expect(await service.launchEnv(id)).toMatchObject({ ok: false, error: expect.stringMatching(/sign in again/) })
      runner.mockImplementationOnce(async ({ home: isolated }) => {
        put(join(isolated, '.credentials.json'), token('managed', 'reauthenticated'))
        put(join(isolated, '.claude.json'), { oauthAccount: who() })
        return { ok: true, status: { loggedIn: true, email: who().emailAddress, orgId: who().organizationUuid } }
      })
      expect(await service.reauthenticate(id)).toMatchObject({ ok: true })
      expect(read(join(authPath(id), '.credentials.json'))).toEqual(token('managed', 'reauthenticated'))
      expect((await service.list()).accounts[0].status).toBe('ready')
      expect(read(credentialPath())).toEqual(token('system'))
    }
  )
  it('a login with no token in its folder: unreadable, yet "Sign in again" replaces it', async () => {
    const id = await add()
    put(join(authPath(id), '.credentials.json'), { claudeAiOauth: {} })
    expect((await service.list()).accounts[0].status).toBe('unknown')
    runner.mockImplementationOnce(async ({ home: isolated }) => {
      put(join(isolated, '.credentials.json'), token('managed', 'reauthenticated'))
      put(join(isolated, '.claude.json'), { oauthAccount: who() })
      return { ok: true, status: { loggedIn: true, email: who().emailAddress, orgId: who().organizationUuid } }
    })
    expect(await service.reauthenticate(id)).toMatchObject({ ok: true })
    expect((await service.list()).accounts[0].status).toBe('ready')
    // A damaged document is still refused.
    put(join(authPath(id), '.credentials.json'), '{bad')
    await expect(service.reauthenticate(id)).rejects.toThrow('unavailable or invalid')
  })
  it('a same-account reauthentication replaces only its own login, never the system one', async () => {
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
    expect(await service.reauthenticate(id)).toMatchObject({ ok: true, restartRequired: false })
    expect(read(join(authPath(id), '.credentials.json'))).toEqual(token('managed', 'reauthenticated'))
    expect(read(credentialPath())).toEqual(token('system'))
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

describe('sessions on their own account', () => {
  it('runs a managed account in its own folder, the system login with the normal environment', async () => {
    seedSystem()
    const first = await add('one'),
      second = await add('two')
    expect(await service.launchEnv()).toEqual({ ok: true, env: {}, accountId: null })
    expect(await service.launchEnv(first)).toEqual({ ok: true, env: { CLAUDE_CONFIG_DIR: authPath(first) }, accountId: first })
    // The default changes new sessions only: a saved pane restarts on its own account.
    expect(await service.select(second)).toEqual({ ok: true, selectedId: second, restartRequired: false })
    expect(await service.launchEnv()).toEqual({ ok: true, env: { CLAUDE_CONFIG_DIR: authPath(second) }, accountId: second })
    expect(await service.launchEnv(first)).toMatchObject({ ok: true, accountId: first })
    expect(await service.launchEnv(null)).toEqual({ ok: true, env: {}, accountId: null })
    expect((await service.list()).accounts.map((a) => a.active)).toEqual([false, true])
    // Each login stays in one place.
    expect(read(credentialPath())).toEqual(token('system'))
    expect(read(join(authPath(first), '.credentials.json'))).toEqual(token('one'))
    expect(read(join(authPath(second), '.credentials.json'))).toEqual(token('two'))
  })
  it('never writes the system login or settings, and copies no token across', async () => {
    seedSystem()
    put(join(systemDir(), 'settings.json'), { model: 'opus' })
    put(join(systemDir(), 'CLAUDE.md'), 'Keep the board updated.\n')
    const files = [credentialPath(), configPath(), join(systemDir(), 'settings.json'), join(systemDir(), 'CLAUDE.md')]
    const before = files.map((file) => [fs.readFileSync(file, 'utf8'), fs.statSync(file).mtimeMs])
    const id = await add()
    await service.select(id)
    await service.launchEnv()
    await service.launchEnv(null)
    await service.launchEnv(id)
    expect(files.map((file) => [fs.readFileSync(file, 'utf8'), fs.statSync(file).mtimeMs])).toEqual(before)
    for (const file of filesUnder(authPath(id)))
      expect(fs.readFileSync(file, 'utf8')).not.toMatch(/fixture-(access|refresh)-system/)
    for (const file of filesUnder(home)) expect(fs.readFileSync(file, 'utf8')).not.toMatch(/fixture-(access|refresh)-managed/)
    for (const file of filesUnder(userData))
      if (!file.startsWith(authPath(id) + sep)) expect(fs.readFileSync(file, 'utf8')).not.toMatch(/fixture-(access|refresh)/)
  })
  it('does not rewrite anything on a repeated launch', async () => {
    seedSystem()
    const id = await add()
    await service.launchEnv(id)
    const rename = vi.spyOn(fsp, 'rename')
    const symlink = vi.spyOn(fsp, 'symlink')
    expect(await service.launchEnv(id)).toMatchObject({ ok: true })
    expect(await service.select(null)).toMatchObject({ ok: true })
    expect(rename).not.toHaveBeenCalled()
    expect(symlink).not.toHaveBeenCalled()
  })
  it('refuses a removed or signed-out account without starting it on another', async () => {
    seedSystem()
    const id = await add()
    expect(await service.launchEnv('ffffffff-ffff-4fff-8fff-ffffffffffff')).toMatchObject({
      ok: false,
      error: expect.stringContaining('no longer in Tessel')
    })
    fs.unlinkSync(join(authPath(id), '.credentials.json'))
    expect(await service.launchEnv(id)).toMatchObject({ ok: false, error: expect.stringContaining('sign in again') })
    expect((await service.list()).accounts[0].status).toBe('missing')
    put(join(authPath(id), '.credentials.json'), '{bad')
    await expect(service.launchEnv(id)).rejects.toThrow('unreadable')
    expect(await service.launchEnv(null)).toMatchObject({ ok: true, accountId: null })
  })
  it('a broken system login blocks only system sessions', async () => {
    seedSystem()
    const id = await add()
    const original = fsp.open.bind(fsp)
    vi.spyOn(fsp, 'open').mockImplementation(async (path, ...rest) => {
      if (path === credentialPath() && rest[0] === 'r')
        throw Object.assign(new Error('fixture secret'), { code: 'EACCES' })
      return original(path, ...rest)
    })
    expect((await service.list()).system.status).toBe('unknown')
    await expect(service.launchEnv(null)).rejects.toThrow('unavailable or invalid')
    expect(await service.launchEnv(id)).toMatchObject({ ok: true, accountId: id })
  })
  it('preserves an explicit null OAuth field and permits an unsigned system launch', async () => {
    put(configPath(), { oauthAccount: null, theme: 'keep' })
    expect(await service.launchEnv()).toEqual({ ok: true, env: {}, accountId: null })
    expect(read(configPath())).toEqual({ oauthAccount: null, theme: 'keep' })
  })
  it('permits System default with a valid provider-only credential document', async () => {
    put(credentialPath(), { providerCredential: 'fixture-provider-value' })
    expect((await service.list()).system.status).toBe('missing')
    expect(await service.launchEnv()).toEqual({ ok: true, env: {}, accountId: null })
    expect(read(credentialPath())).toEqual({ providerCredential: 'fixture-provider-value' })
  })
  it('removes an account (its default too) without following its shared folders', async () => {
    seedSystem()
    const id = await add()
    await service.select(id)
    await service.launchEnv()
    put(join(authPath(id), 'projects', 'p', 'kept.jsonl'), '{}\n')
    await expect(service.remove('../home')).rejects.toThrow('Unknown Claude account')
    expect(await service.remove(id)).toEqual({ ok: true, selectedId: null, restartRequired: false })
    expect(fs.existsSync(authPath(id))).toBe(false)
    expect(fs.readFileSync(join(systemDir(), 'projects', 'p', 'kept.jsonl'), 'utf8')).toBe('{}\n')
    expect((await service.list()).accounts).toEqual([])
    expect(read(credentialPath())).toEqual(token('system'))
  })
  it("an added account's folder inherited by Tessel is not the system's: its sessions drop it", async () => {
    seedSystem()
    const id = await add()
    const inherited = create({ env: { CLAUDE_CONFIG_DIR: authPath(id) } })
    expect((await inherited.list()).system).toMatchObject({ email: 'system@fixture.invalid' })
    expect(await inherited.launchEnv(null)).toEqual({ ok: true, env: {}, accountId: null, unsetEnv: ['CLAUDE_CONFIG_DIR'] })
    expect(await inherited.launchEnv(id)).toMatchObject({ ok: true, env: { CLAUDE_CONFIG_DIR: authPath(id) }, accountId: id })
  })
  it('uses an overridden system config folder, never the default home one', async () => {
    const override = join(root, 'custom-config')
    put(join(override, '.credentials.json'), token('custom'))
    put(join(override, '.claude.json'), { custom: 1, theme: 'custom-theme', oauthAccount: who('custom') })
    put(join(override, 'CLAUDE.md'), 'Custom memory\n')
    service = create({ env: { CLAUDE_CONFIG_DIR: override } })
    const id = await add()
    expect(await service.launchEnv(id)).toEqual({ ok: true, env: { CLAUDE_CONFIG_DIR: authPath(id) }, accountId: id })
    expect(same(join(authPath(id), 'projects'), join(override, 'projects'))).toBe(true)
    // A custom folder's memory is copied whole (no parent-folder double load).
    expect(fs.readFileSync(join(authPath(id), 'CLAUDE.md'), 'utf8')).toBe('Custom memory\n')
    expect(read(join(authPath(id), '.claude.json'))).toMatchObject({ theme: 'custom-theme', oauthAccount: who() })
    expect(read(join(override, '.claude.json'))).toEqual({ custom: 1, theme: 'custom-theme', oauthAccount: who('custom') })
    expect(fs.existsSync(systemDir())).toBe(false)
    expect(await service.launchEnv(null)).toEqual({ ok: true, env: {}, accountId: null })
    expect(await service.sessionEnv(id)).toEqual({ ok: true, env: { CLAUDE_CONFIG_DIR: override }, accountId: id })
  })
  it('reads usage in the account folder, conversations in the shared system folder', async () => {
    seedSystem()
    const first = await add('one'),
      second = await add('two')
    await service.select(first)
    const rename = vi.spyOn(fsp, 'rename')
    expect(await service.usageScope()).toEqual({
      ok: true,
      env: { CLAUDE_CONFIG_DIR: authPath(first) },
      accountId: first,
      expectedIdentity: { account: 'one-id', email: 'one@fixture.invalid', organization: 'one-org' }
    })
    expect(await service.usageScope(second)).toMatchObject({ ok: true, env: { CLAUDE_CONFIG_DIR: authPath(second) } })
    expect(await service.usageScope(null)).toEqual({ ok: true, env: {}, accountId: null, expectedIdentity: null })
    expect(await service.usageScope('ffffffff-ffff-4fff-8fff-ffffffffffff')).toMatchObject({ ok: false })
    expect(JSON.stringify(await service.usageScope(first))).not.toMatch(/fixture-access|fixture-refresh/)
    for (const [argument, id] of [
      [undefined, first],
      [second, second],
      [null, null],
      // Removed since: its conversations are still in the shared folder.
      ['ffffffff-ffff-4fff-8fff-ffffffffffff', 'ffffffff-ffff-4fff-8fff-ffffffffffff']
    ])
      expect(await service.sessionEnv(argument)).toEqual({ ok: true, env: {}, accountId: id })
    expect(await service.sessionEnv('../x')).toMatchObject({ ok: false })
    fs.unlinkSync(join(authPath(second), '.credentials.json'))
    expect(await service.usageScope(second)).toMatchObject({ ok: false })
    expect(rename).not.toHaveBeenCalled()
  })
  it('reads usage where each sign-in is: before the old switch is undone, the switched account in the system files', async () => {
    seedSystem()
    const id = await add()
    legacySwitch(id)
    const later = create({ canMigrate: async () => false })
    expect(await later.usageScope()).toEqual({ ok: true, env: {}, accountId: id, expectedIdentity: read(indexPath()).accounts[0].identity })
    // The system's own sign-in is only in the snapshot until then.
    expect(await later.usageScope(null)).toMatchObject({ ok: false, error: expect.stringContaining('started before the update') })
  })
  it("an account an older version added gets its .claude.json when its usage is read", async () => {
    seedSystem()
    const id = await add()
    fs.unlinkSync(join(authPath(id), '.claude.json'))
    expect(await service.usageScope(id)).toMatchObject({ ok: true, env: { CLAUDE_CONFIG_DIR: authPath(id) }, accountId: id })
    expect(read(join(authPath(id), '.claude.json')).oauthAccount).toEqual(who('managed'))
  })
  it('a usage read never writes the system settings, even when a session makes the file meanwhile', async () => {
    seedSystem()
    const id = await add()
    fs.unlinkSync(join(authPath(id), '.claude.json'))
    const system = fs.readFileSync(configPath(), 'utf8')
    const real = fsp.open.bind(fsp)
    let made = false
    // Just before it is made, a session writes it (with a theme of its own).
    vi.spyOn(fsp, 'open').mockImplementation(async (path, ...rest) => {
      if (!made && String(path) === join(authPath(id), 'oauth-account.json')) {
        made = true
        put(join(authPath(id), '.claude.json'), { theme: 'session theme', oauthAccount: who('managed') })
      }
      return real(path, ...rest)
    })
    expect(await service.usageScope(id)).toMatchObject({ ok: true, accountId: id })
    expect(fs.readFileSync(configPath(), 'utf8')).toBe(system)
    expect(read(join(authPath(id), '.claude.json')).theme).toBe('session theme')
  })
  it('serializes changes across service instances using the same storage', async () => {
    seedSystem()
    const first = await add('one'),
      second = await add('two')
    const results = await Promise.all([service.select(first), create().select(second), service.launchEnv(first), create().launchEnv(first)])
    expect(results.every((r) => r.ok)).toBe(true)
    expect(read(indexPath()).selectedId).toBe(second)
    expect(isLink(join(authPath(first), 'projects'))).toBe(true)
  })
})

describe('the account folder before a launch', () => {
  it('links the shared folders to the system ones, creating those that are missing', async () => {
    seedSystem()
    put(join(systemDir(), 'skills', 'mine', 'SKILL.md'), 'skill')
    put(join(systemDir(), 'my-tools', 'tool.txt'), 'tool')
    for (const own of ['cache', 'sessions', 'debug', 'statsig', '.hidden']) put(join(systemDir(), own, 'x.txt'), 'private')
    const id = await add()
    await service.launchEnv(id)
    for (const name of [...SHARED_FOLDERS, 'my-tools']) {
      expect(isLink(join(authPath(id), name))).toBe(true)
      expect(fs.statSync(join(systemDir(), name)).isDirectory()).toBe(true)
      expect(same(join(authPath(id), name), join(systemDir(), name))).toBe(true)
    }
    for (const own of ['cache', 'sessions', 'debug', 'statsig', '.hidden']) expect(fs.existsSync(join(authPath(id), own))).toBe(false)
    expect(fs.readFileSync(join(authPath(id), 'skills', 'mine', 'SKILL.md'), 'utf8')).toBe('skill')
    // A conversation the account's session writes is the system's.
    put(join(authPath(id), 'projects', 'C--p', 'a.jsonl'), '{"x":1}\n')
    expect(fs.readFileSync(join(systemDir(), 'projects', 'C--p', 'a.jsonl'), 'utf8')).toBe('{"x":1}\n')
  })
  it('replaces a link to another place without touching what it pointed to', async () => {
    seedSystem()
    const id = await add()
    await service.launchEnv(id)
    const elsewhere = join(root, 'elsewhere')
    put(join(elsewhere, 'keep.txt'), 'keep')
    fs.rmdirSync(join(authPath(id), 'skills'))
    fs.symlinkSync(elsewhere, join(authPath(id), 'skills'), 'junction')
    await service.launchEnv(id)
    expect(same(join(authPath(id), 'skills'), join(systemDir(), 'skills'))).toBe(true)
    expect(fs.readFileSync(join(elsewhere, 'keep.txt'), 'utf8')).toBe('keep')
  })
  it('moves what a real folder there held into the system one, never over a file there', async () => {
    seedSystem()
    const id = await add()
    await service.launchEnv(id)
    fs.rmdirSync(join(authPath(id), 'projects'))
    put(join(authPath(id), 'projects', 'C--p', 'own.jsonl'), 'own\n')
    put(join(authPath(id), 'projects', 'C--p', 'both.jsonl'), 'account copy\n')
    put(join(systemDir(), 'projects', 'C--p', 'both.jsonl'), 'system copy\n')
    fs.rmdirSync(join(authPath(id), 'plans'))
    fs.mkdirSync(join(authPath(id), 'plans'))
    fs.rmdirSync(join(authPath(id), 'todos'))
    put(join(authPath(id), 'todos'), 'a file, not a folder')
    await service.launchEnv(id)
    expect(isLink(join(authPath(id), 'projects'))).toBe(true)
    expect(fs.readFileSync(join(systemDir(), 'projects', 'C--p', 'own.jsonl'), 'utf8')).toBe('own\n')
    expect(fs.readFileSync(join(systemDir(), 'projects', 'C--p', 'both.jsonl'), 'utf8')).toBe('system copy\n')
    expect(fs.readFileSync(join(authPath(id), 'projects.merge', 'C--p', 'both.jsonl'), 'utf8')).toBe('account copy\n')
    // An empty real folder is replaced; a file there is left alone.
    expect(isLink(join(authPath(id), 'plans'))).toBe(true)
    expect(fs.readFileSync(join(authPath(id), 'todos'), 'utf8')).toBe('a file, not a folder')
    // The conflict gone: the next launch moves the rest and removes the folder aside.
    fs.unlinkSync(join(systemDir(), 'projects', 'C--p', 'both.jsonl'))
    await service.launchEnv(id)
    expect(fs.readFileSync(join(systemDir(), 'projects', 'C--p', 'both.jsonl'), 'utf8')).toBe('account copy\n')
    expect(fs.existsSync(join(authPath(id), 'projects.merge'))).toBe(false)
  })
  it('copies the system settings, and its memory as an import; a file gone from the system goes from the account', async () => {
    seedSystem()
    put(join(systemDir(), 'settings.json'), { model: 'opus', hooks: { Stop: [] } })
    put(join(systemDir(), 'settings.local.json'), { local: true })
    put(join(systemDir(), 'keybindings.json'), [{ key: 'ctrl+k' }])
    put(join(systemDir(), 'CLAUDE.md'), 'Keep the board updated.\n')
    const id = await add()
    await service.launchEnv(id)
    for (const name of ['settings.json', 'settings.local.json', 'keybindings.json'])
      expect(fs.readFileSync(join(authPath(id), name), 'utf8')).toBe(fs.readFileSync(join(systemDir(), name), 'utf8'))
    // ~/.claude/CLAUDE.md is also read as a parent folder's: imported once, not copied.
    expect(fs.readFileSync(join(authPath(id), 'CLAUDE.md'), 'utf8')).toBe('@~/.claude/CLAUDE.md\n')
    put(join(systemDir(), 'settings.json'), { model: 'sonnet', hooks: { Stop: [] } })
    fs.unlinkSync(join(systemDir(), 'keybindings.json'))
    await service.launchEnv(id)
    expect(read(join(authPath(id), 'settings.json'))).toEqual({ model: 'sonnet', hooks: { Stop: [] } })
    expect(fs.existsSync(join(authPath(id), 'keybindings.json'))).toBe(false)
    // A copy removed in the account is copied again, never removed from the system.
    fs.unlinkSync(join(authPath(id), 'settings.local.json'))
    await service.launchEnv(id)
    expect(read(join(authPath(id), 'settings.local.json'))).toEqual({ local: true })
    expect(read(join(systemDir(), 'settings.local.json'))).toEqual({ local: true })
  })
  it('gives the account the system user settings, never its login, ids, caches or subscription state', async () => {
    put(credentialPath(), token('system'))
    put(configPath(), {
      oauthAccount: who('system'),
      userID: 'system-user',
      machineID: 'system-machine',
      numStartups: 9,
      firstStartTime: 'then',
      primaryApiKey: 'fixture-api-key',
      customApiKeyResponses: { approved: ['fixture'] },
      cachedGrowthBookFeatures: { a: 1 },
      groveConfigCache: {},
      modelAccessCache: {},
      subscriptionNoticeCount: 2,
      hasAvailableSubscription: true,
      passesEligibilityCache: {},
      hasVisitedPasses: true,
      skillUsage: { s: 1 },
      penguinModeOrgEnabled: true,
      claudeAiMcpEverConnected: true,
      bridgeOauthDeadFailCount: 1,
      claudeCodeFirstTokenDate: 'then',
      theme: 'dark',
      hasCompletedOnboarding: true,
      opusProMigrationComplete: true,
      hasSeenTasksHint: true,
      tipsHistory: { tip: 1 },
      mcpServers: { shared: { command: 'shared' } },
      projects: { 'C:/p': { allowedTools: ['a'] }, 'C:/q': { hasTrustDialogAccepted: false, lastCost: 1 } }
    })
    const id = await add()
    await service.launchEnv(id)
    expect(read(join(authPath(id), '.claude.json'))).toEqual({
      theme: 'dark',
      hasCompletedOnboarding: true,
      opusProMigrationComplete: true,
      hasSeenTasksHint: true,
      tipsHistory: { tip: 1 },
      mcpServers: { shared: { command: 'shared' } },
      projects: { 'C:/p': { allowedTools: ['a'] }, 'C:/q': { hasTrustDialogAccepted: false, lastCost: 1 } },
      oauthAccount: who()
    })
    // Claude keeps a fresher profile there: kept while it is this account's.
    // Its own ids stay its own, and a folder Tessel trusted in it stays trusted.
    const own = read(join(authPath(id), '.claude.json'))
    own.oauthAccount = { ...who(), displayName: 'Fresh' }
    own.userID = 'account-user'
    own.projects['C:/q'].hasTrustDialogAccepted = true
    put(join(authPath(id), '.claude.json'), own)
    await service.launchEnv(id)
    expect(read(join(authPath(id), '.claude.json'))).toMatchObject({
      userID: 'account-user',
      projects: { 'C:/q': { hasTrustDialogAccepted: true, lastCost: 1 } },
      oauthAccount: { ...who(), displayName: 'Fresh' }
    })
    // The account's trust and ids never reach the system.
    expect(read(configPath())).toMatchObject({ userID: 'system-user', projects: { 'C:/q': { hasTrustDialogAccepted: false } } })
  })
  it('chooses the shared keys strictly', () => {
    for (const key of ['theme', 'mcpServers', 'projects', 'hasCompletedOnboarding', 'opusProMigrationComplete', 'fable5ToFableAliasMigrationTimestamp', 'hasSeenTasksHint', 'editorMode', 'githubRepoPaths'])
      expect(sharedStateKey(key)).toBe(true)
    for (const key of ['oauthAccount', 'userID', 'machineID', 'primaryApiKey', 'customApiKeyResponses', 'cachedUsageUtilization', 'metricsStatusCache', 'groveConfigCache', 'passesUpsellSeenCount', 'hasVisitedPasses', 'subscriptionNoticeCount', 'hasAvailableSubscription', 'orgModelDefaultCache', 'penguinModeOrgEnabled', 'skillUsage', 'numStartups', 'firstStartTime', 'claudeCodeFirstTokenDate', 'bridgeOauthDeadExpiresAt', 'claudeAiMcpEverConnected', 'additionalModelOptionsAnsweredAt'])
      expect(sharedStateKey(key)).toBe(false)
    expect(accountState({ a: 1 }, null, who()).account).toEqual({ a: 1, oauthAccount: who() })
  })
  it('leaves its settings file alone while Claude holds its lock', async () => {
    seedSystem()
    const id = await add()
    put(join(authPath(id), '.claude.json'), { oauthAccount: who(), own: true })
    fs.mkdirSync(join(authPath(id), '.claude.json.lock'))
    expect(await service.launchEnv(id)).toMatchObject({ ok: true, accountId: id })
    expect(read(join(authPath(id), '.claude.json'))).toEqual({ oauthAccount: who(), own: true })
  })
  it('never moves an entry over a system file made between its check and its move', async () => {
    seedSystem()
    const id = await add()
    await service.launchEnv(id)
    fs.rmdirSync(join(authPath(id), 'projects'))
    put(join(authPath(id), 'projects', 'C--p', 'race.jsonl'), 'account copy\n')
    put(join(authPath(id), 'projects', 'C--p', 'own.jsonl'), 'own\n')
    const target = join(systemDir(), 'projects', 'C--p', 'race.jsonl')
    const lstat = fsp.lstat.bind(fsp)
    const link = fsp.link.bind(fsp)
    // A system session writes the file right after any check, right before the move.
    vi.spyOn(fsp, 'lstat').mockImplementation(async (path, ...rest) => {
      const result = await lstat(path, ...rest).catch((error) => error)
      if (path === target && !fs.existsSync(target)) put(target, 'system session\n')
      if (result instanceof Error) throw result
      return result
    })
    vi.spyOn(fsp, 'link').mockImplementation(async (from, to) => {
      if (to === target && !fs.existsSync(target)) put(target, 'system session\n')
      return link(from, to)
    })
    await service.launchEnv(id)
    expect(fs.readFileSync(target, 'utf8')).toBe('system session\n')
    expect(fs.readFileSync(join(authPath(id), 'projects.merge', 'C--p', 'race.jsonl'), 'utf8')).toBe('account copy\n')
    expect(fs.readFileSync(join(systemDir(), 'projects', 'C--p', 'own.jsonl'), 'utf8')).toBe('own\n')
  })
  it('moves entries by an exclusive copy where hard links cannot be made, never over a file there', async () => {
    seedSystem()
    const id = await add()
    await service.launchEnv(id)
    fs.rmdirSync(join(authPath(id), 'projects'))
    put(join(authPath(id), 'projects', 'C--p', 'race.jsonl'), 'account copy\n')
    put(join(authPath(id), 'projects', 'C--p', 'own.jsonl'), 'own\n')
    const target = join(systemDir(), 'projects', 'C--p', 'race.jsonl')
    otherVolume()
    const copy = fsp.copyFile.bind(fsp)
    vi.spyOn(fsp, 'copyFile').mockImplementation(async (from, to, mode) => {
      // A system session writes that file while it is copied.
      if (String(from).endsWith('race.jsonl')) put(target, 'system session\n')
      return copy(from, to, mode)
    })
    await service.launchEnv(id)
    expect(fs.readFileSync(target, 'utf8')).toBe('system session\n')
    expect(fs.readFileSync(join(authPath(id), 'projects.merge', 'C--p', 'race.jsonl'), 'utf8')).toBe('account copy\n')
    expect(fs.readFileSync(join(systemDir(), 'projects', 'C--p', 'own.jsonl'), 'utf8')).toBe('own\n')
    expect(fs.existsSync(join(authPath(id), 'projects.merge', 'C--p', 'own.jsonl'))).toBe(false)
  })
  it('moves what still waits in <name>.merge into the system folder when the account is removed, and logs what is left', async () => {
    seedSystem()
    const log = { warn: vi.fn() }
    service = create({ log })
    const id = await add()
    await service.launchEnv(id)
    put(join(authPath(id), 'projects.merge', 'C--p', 'own.jsonl'), 'own\n')
    put(join(authPath(id), 'projects.merge', 'C--p', 'both.jsonl'), 'account copy\n')
    put(join(systemDir(), 'projects', 'C--p', 'both.jsonl'), 'system copy\n')
    expect(await service.remove(id)).toMatchObject({ ok: true })
    expect(fs.readFileSync(join(systemDir(), 'projects', 'C--p', 'own.jsonl'), 'utf8')).toBe('own\n')
    expect(fs.readFileSync(join(systemDir(), 'projects', 'C--p', 'both.jsonl'), 'utf8')).toBe('system copy\n')
    expect(log.warn).toHaveBeenCalledWith('accounts', expect.stringContaining(join('projects.merge', 'C--p', 'both.jsonl')))
    expect(fs.existsSync(authPath(id))).toBe(false)
  })
  it('reads a login a session is refreshing once more before refusing the launch', async () => {
    seedSystem()
    const id = await add()
    const file = join(authPath(id), '.credentials.json')
    const good = fs.readFileSync(file, 'utf8')
    fs.writeFileSync(file, good.slice(0, 20))
    // Half-written when first read; the session finishes writing it just after.
    const open = fsp.open.bind(fsp)
    let reads = 0
    vi.spyOn(fsp, 'open').mockImplementation(async (path, ...rest) => {
      if (path === file && rest[0] === 'r' && reads++ === 0) setTimeout(() => fs.writeFileSync(file, good), 20)
      return open(path, ...rest)
    })
    expect(await service.launchEnv(id)).toMatchObject({ ok: true, accountId: id })
    expect(reads).toBeGreaterThan(1)
  })
})

// A /login inside a session on an added account signs its folder in to
// another account: never launched, selected or read for usage as the first.
describe('an account folder signed in to another account', () => {
  it.each(['names nobody', 'names the other account'])(
    'refuses it, keeps its files, reads no usage, and a new sign-in fixes it (the token %s)',
    async (mode) => {
      seedSystem()
      const id = await add('one')
      await service.select(id)
      await service.launchEnv(id)
      const folder = authPath(id)
      const login = token('two')
      if (mode === 'names the other account') login.claudeAiOauth.emailAddress = who('two').emailAddress
      put(join(folder, '.credentials.json'), login)
      put(join(folder, '.claude.json'), { ...read(join(folder, '.claude.json')), oauthAccount: who('two') })
      const contents = () => filesUnder(folder).map((file) => [file, fs.readFileSync(file, 'utf8')])
      const before = contents()
      expect(await service.launchEnv(id)).toMatchObject({ ok: false, error: expect.stringContaining('/login') })
      expect(await service.launchEnv()).toMatchObject({ ok: false, error: expect.stringContaining('/login') })
      await expect(service.select(id)).rejects.toThrow('/login')
      expect(await service.usageScope(id)).toMatchObject({ ok: false })
      expect((await service.list()).accounts[0].status).toBe('missing')
      // Its usage is never read as the first account's.
      const request = vi.fn()
      const usage = createProviderUsage({
        accounts: {
          list: async () => ({ ok: true, providers: [await service.list()], jobs: [] }),
          usageScope: (provider, accountId) => service.usageScope(accountId)
        },
        home,
        env: {},
        request
      })
      expect(await usage.read({ provider: 'claude', accountId: id })).toMatchObject({ ok: false })
      expect(request).not.toHaveBeenCalled()
      // Nothing "repaired": the other account's files stay as they are.
      expect(contents()).toEqual(before)
      selectedIdentity = 'one'
      expect(await service.reauthenticate(id)).toMatchObject({ ok: true })
      expect(await service.launchEnv(id)).toMatchObject({ ok: true, accountId: id })
      expect(read(join(folder, '.claude.json')).oauthAccount).toEqual(who('one'))
      expect(read(join(folder, '.credentials.json'))).toEqual(token('one'))
    }
  )
  it('gives a folder with no profile yet the saved identity', async () => {
    seedSystem()
    const id = await add()
    fs.unlinkSync(join(authPath(id), '.claude.json'))
    expect(await service.launchEnv(id)).toMatchObject({ ok: true })
    expect(read(join(authPath(id), '.claude.json')).oauthAccount).toEqual(who())
    put(join(authPath(id), '.claude.json'), { ...read(join(authPath(id), '.claude.json')), oauthAccount: null })
    expect(await service.launchEnv(id)).toMatchObject({ ok: true })
    expect(read(join(authPath(id), '.claude.json')).oauthAccount).toEqual(who())
  })
})

describe('settings changed in a session on an added account', () => {
  const tesselHook = (node = 'C:/node/node.exe') => ({
    matcher: '',
    hooks: [{ type: 'command', command: `"${node}" "C:/Users/x/AppData/Roaming/tessel-team/tessel-team-mcp.cjs" --hook` }]
  })
  const account = (id, name) => join(authPath(id), name)
  it('writes a change made in the account back to the system, and a system change to the account', async () => {
    seedSystem()
    put(join(systemDir(), 'settings.json'), { model: 'opus' })
    put(join(systemDir(), 'keybindings.json'), [{ key: 'ctrl+k' }])
    const id = await add()
    await service.launchEnv(id)
    // /model and /plugin install in the account's session.
    put(account(id, 'settings.json'), { model: 'sonnet', enabledPlugins: { 'p@m': true } })
    put(account(id, 'keybindings.json'), [{ key: 'ctrl+j' }])
    await service.launchEnv(id)
    expect(read(join(systemDir(), 'settings.json'))).toEqual({ model: 'sonnet', enabledPlugins: { 'p@m': true } })
    expect(read(join(systemDir(), 'keybindings.json'))).toEqual([{ key: 'ctrl+j' }])
    expect(read(account(id, 'settings.json'))).toEqual({ model: 'sonnet', enabledPlugins: { 'p@m': true } })
    // Then a change in a system session reaches the account.
    put(join(systemDir(), 'settings.json'), { model: 'haiku', enabledPlugins: { 'p@m': true } })
    await service.launchEnv(id)
    expect(read(account(id, 'settings.json'))).toEqual({ model: 'haiku', enabledPlugins: { 'p@m': true } })
    // A second account sees the first one's change.
    const other = await add('other')
    await service.launchEnv(other)
    expect(read(account(other, 'keybindings.json'))).toEqual([{ key: 'ctrl+j' }])
  })
  it('keeps the system version when both changed, the account one aside, and logs it', async () => {
    seedSystem()
    const log = { warn: vi.fn() }
    service = create({ log })
    put(join(systemDir(), 'settings.json'), { model: 'opus' })
    const id = await add()
    await service.launchEnv(id)
    put(account(id, 'settings.json'), { model: 'sonnet' })
    put(join(systemDir(), 'settings.json'), { model: 'haiku' })
    await service.launchEnv(id)
    expect(read(join(systemDir(), 'settings.json'))).toEqual({ model: 'haiku' })
    expect(read(account(id, 'settings.json'))).toEqual({ model: 'haiku' })
    const aside = fs.readdirSync(authPath(id)).filter((name) => name.startsWith('settings.json.conflict-'))
    expect(aside).toHaveLength(1)
    expect(read(account(id, aside[0]))).toEqual({ model: 'sonnet' })
    expect(log.warn).toHaveBeenCalledWith('accounts', expect.stringContaining(aside[0]))
  })
  it('keeps the system version and the account one aside when there is no record of the last sync', async () => {
    seedSystem()
    put(join(systemDir(), 'settings.json'), { model: 'opus' })
    const id = await add()
    await service.launchEnv(id)
    fs.unlinkSync(account(id, '.tessel-sync.json'))
    put(account(id, 'settings.json'), { model: 'sonnet' })
    await service.launchEnv(id)
    expect(read(join(systemDir(), 'settings.json'))).toEqual({ model: 'opus' })
    expect(read(account(id, 'settings.json'))).toEqual({ model: 'opus' })
    expect(fs.readdirSync(authPath(id)).some((name) => name.startsWith('settings.json.conflict-'))).toBe(true)
  })
  it("never takes Tessel's own hooks for a change, and keeps the system's when writing back", async () => {
    seedSystem()
    put(join(systemDir(), 'settings.json'), { hooks: { Stop: [tesselHook()] } })
    const id = await add()
    await service.launchEnv(id)
    // Tessel installs its hooks in the account's copy at the launch (another node path here).
    put(account(id, 'settings.json'), { hooks: { Stop: [tesselHook('D:/other/node.exe')] } })
    const before = fs.readFileSync(join(systemDir(), 'settings.json'), 'utf8')
    await service.launchEnv(id)
    expect(fs.readFileSync(join(systemDir(), 'settings.json'), 'utf8')).toBe(before)
    expect(fs.readdirSync(authPath(id)).some((name) => name.includes('.conflict-'))).toBe(false)
    // /hooks in the session: the user's hook goes to the system, with the system's Tessel hook.
    const mine = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }
    put(account(id, 'settings.json'), { hooks: { Stop: [tesselHook('D:/other/node.exe')], PreToolUse: [mine] } })
    await service.launchEnv(id)
    expect(read(join(systemDir(), 'settings.json'))).toEqual({ hooks: { Stop: [tesselHook()], PreToolUse: [mine] } })
  })
  it('appends what a session added to its memory to the system memory, and keeps the import', async () => {
    seedSystem()
    put(join(systemDir(), 'CLAUDE.md'), 'Keep the board updated.')
    const id = await add()
    await service.launchEnv(id)
    fs.appendFileSync(account(id, 'CLAUDE.md'), '\n- Answer in French.\n')
    await service.launchEnv(id)
    expect(fs.readFileSync(join(systemDir(), 'CLAUDE.md'), 'utf8')).toBe('Keep the board updated.\n- Answer in French.\n')
    expect(fs.readFileSync(account(id, 'CLAUDE.md'), 'utf8')).toBe('@~/.claude/CLAUDE.md\n')
    // A memory a session made where the system had none.
    fs.unlinkSync(join(systemDir(), 'CLAUDE.md'))
    put(account(id, 'CLAUDE.md'), '- Use tabs.\n')
    await service.launchEnv(id)
    expect(fs.readFileSync(join(systemDir(), 'CLAUDE.md'), 'utf8')).toBe('- Use tabs.\n')
    expect(fs.readFileSync(account(id, 'CLAUDE.md'), 'utf8')).toBe('@~/.claude/CLAUDE.md\n')
  })
  it('never copies the system sign-in settings into an account, nor removes them from the system', async () => {
    seedSystem()
    const auth = {
      apiKeyHelper: 'fixture-helper',
      forceLoginOrgUUID: 'fixture-org',
      awsAuthRefresh: 'fixture-refresh-cmd',
      env: { ANTHROPIC_API_KEY: 'fixture-secret-key', claude_code_oauth_token: 'fixture-secret-token', KEEP: '1' }
    }
    put(join(systemDir(), 'settings.json'), { model: 'opus', ...auth })
    const id = await add()
    await service.launchEnv(id)
    expect(read(account(id, 'settings.json'))).toEqual({ model: 'opus', env: { KEEP: '1' } })
    for (const file of filesUnder(authPath(id))) expect(fs.readFileSync(file, 'utf8')).not.toMatch(/fixture-(secret|helper|org)/)
    put(account(id, 'settings.json'), { model: 'sonnet', env: { KEEP: '1' } })
    await service.launchEnv(id)
    expect(read(join(systemDir(), 'settings.json'))).toEqual({ model: 'sonnet', ...auth, env: auth.env })
    expect(read(account(id, 'settings.json'))).toEqual({ model: 'sonnet', env: { KEEP: '1' } })
  })
  it('strips sign-in settings an older copy left in the account', async () => {
    seedSystem()
    put(join(systemDir(), 'settings.json'), { model: 'opus', env: { CLAUDE_CODE_OAUTH_TOKEN: 'fixture-secret-token' } })
    const id = await add()
    put(account(id, 'settings.json'), fs.readFileSync(join(systemDir(), 'settings.json'), 'utf8'))
    await service.launchEnv(id)
    expect(read(account(id, 'settings.json'))).toEqual({ model: 'opus' })
  })
  it('syncs the shared .claude.json keys both ways, under the system file lock', async () => {
    seedSystem()
    put(configPath(), { ...read(configPath()), projects: { 'C:/p': { allowedTools: [] } }, mcpServers: {} })
    const id = await add()
    await service.launchEnv(id)
    const own = read(account(id, '.claude.json'))
    own.theme = 'light'
    own.projects['C:/p'].mcpServers = { local: { command: 'local' } }
    own.projects['C:/p'].lastCost = 3
    own.mcpServers = { mine: { command: 'mine' } }
    put(account(id, '.claude.json'), own)
    // Claude holds the system file: nothing written back yet, the account's changes kept.
    fs.mkdirSync(`${configPath()}.lock`)
    await service.launchEnv(id)
    expect(read(configPath()).theme).toBe('dark')
    expect(read(account(id, '.claude.json')).theme).toBe('light')
    fs.rmdirSync(`${configPath()}.lock`)
    await service.launchEnv(id)
    expect(read(configPath())).toEqual({
      theme: 'light',
      projects: { 'C:/p': { allowedTools: [], mcpServers: { local: { command: 'local' } } } },
      mcpServers: { mine: { command: 'mine' } },
      oauthAccount: who('system')
    })
    expect(read(account(id, '.claude.json')).projects['C:/p'].lastCost).toBe(3)
    expect(fs.existsSync(`${configPath()}.lock`)).toBe(false)
  })
  it('removes from the account what the system removed, unless the account changed it since', async () => {
    seedSystem()
    put(configPath(), {
      ...read(configPath()),
      mcpServers: { dropped: { command: 'a' }, edited: { command: 'b' }, kept: { command: 'c' } },
      projects: { 'C:/gone': { allowedTools: [] }, 'C:/edited': { allowedTools: [] } }
    })
    const id = await add()
    await service.launchEnv(id)
    const own = read(account(id, '.claude.json'))
    own.mcpServers.edited = { command: 'b2' }
    own.projects['C:/edited'].allowedTools = ['Bash']
    put(account(id, '.claude.json'), own)
    put(configPath(), { ...read(configPath()), mcpServers: { kept: { command: 'c' } }, projects: {} })
    await service.launchEnv(id)
    const after = read(account(id, '.claude.json'))
    expect(after.mcpServers).toEqual({ edited: { command: 'b2' }, kept: { command: 'c' } })
    expect(after.projects).toEqual({ 'C:/edited': { allowedTools: ['Bash'] } })
    // Kept by the account alone: not brought back into the system.
    await service.launchEnv(id)
    expect(read(configPath())).toMatchObject({ mcpServers: { kept: { command: 'c' } }, projects: {} })
    // A server removed in the account's session is removed from the system.
    const latest = read(account(id, '.claude.json'))
    delete latest.mcpServers.kept
    put(account(id, '.claude.json'), latest)
    await service.launchEnv(id)
    expect(read(configPath()).mcpServers).toEqual({})
  })
  it('never writes back the fresh defaults of an account file Claude started again', async () => {
    seedSystem()
    put(configPath(), { ...read(configPath()), autoUpdates: false, editorMode: 'vim', hasCompletedOnboarding: true, mcpServers: { s: { command: 's' } } })
    const id = await add()
    await service.launchEnv(id)
    put(account(id, '.claude.json'), { autoUpdates: true, numStartups: 1, oauthAccount: who() })
    await service.launchEnv(id)
    await service.launchEnv(id)
    expect(read(configPath())).toMatchObject({ autoUpdates: false, editorMode: 'vim', mcpServers: { s: { command: 's' } } })
    expect(read(account(id, '.claude.json'))).toMatchObject({ autoUpdates: false, editorMode: 'vim', theme: 'dark', numStartups: 1 })
    expect(fs.readdirSync(authPath(id)).some((name) => name.includes('.conflict-'))).toBe(false)
  })
  it("keeps the system's value of a key changed on both sides, the account's aside, and Claude's counters without a conflict", async () => {
    seedSystem()
    put(configPath(), { ...read(configPath()), tipsHistory: { a: 1 }, promptQueueUseCount: 1 })
    const id = await add()
    await service.launchEnv(id)
    put(account(id, '.claude.json'), { ...read(account(id, '.claude.json')), theme: 'light', tipsHistory: { a: 2 }, promptQueueUseCount: 5 })
    put(configPath(), { ...read(configPath()), theme: 'solarized', tipsHistory: { a: 3 }, promptQueueUseCount: 2 })
    await service.launchEnv(id)
    expect(read(account(id, '.claude.json'))).toMatchObject({ theme: 'solarized', tipsHistory: { a: 3 }, promptQueueUseCount: 2 })
    expect(read(configPath())).toMatchObject({ theme: 'solarized', tipsHistory: { a: 3 } })
    const aside = fs.readdirSync(authPath(id)).filter((name) => name.startsWith('.claude.json.conflict-'))
    expect(aside).toHaveLength(1)
    expect(read(account(id, aside[0]))).toEqual({ theme: 'light' })
  })
  const refuse = (method, matches, code = 'EACCES') => {
    const real = fsp[method].bind(fsp)
    return vi.spyOn(fsp, method).mockImplementation(async (path, ...rest) => {
      if (matches(path, ...rest)) throw Object.assign(new Error('refused'), { code })
      return real(path, ...rest)
    })
  }
  it('never replaces a system edit made while its write-back waits for the file', async () => {
    seedSystem()
    const target = join(systemDir(), 'settings.json')
    put(target, { model: 'opus' })
    const id = await add()
    await service.launchEnv(id)
    put(account(id, 'settings.json'), { model: 'sonnet' })
    const rename = fsp.rename.bind(fsp)
    let tries = 0
    const busy = vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (to === target && tries++ === 0) {
        // The file is held for a moment, and a system session saves its settings meanwhile.
        put(target, { model: 'haiku', userAdded: true })
        throw Object.assign(new Error('busy'), { code: 'EBUSY' })
      }
      return rename(from, to)
    })
    expect(await service.launchEnv(id)).toMatchObject({ ok: true })
    expect(read(target)).toEqual({ model: 'haiku', userAdded: true })
    expect(read(account(id, 'settings.json'))).toEqual({ model: 'sonnet' })
    busy.mockRestore()
    // Worked out again at the next launch: both changed, the system's wins, the account's aside.
    await service.launchEnv(id)
    expect(read(target)).toEqual({ model: 'haiku', userAdded: true })
    expect(read(account(id, 'settings.json'))).toEqual({ model: 'haiku', userAdded: true })
    const aside = fs.readdirSync(authPath(id)).filter((name) => name.startsWith('settings.json.conflict-'))
    expect(aside.map((name) => read(account(id, name)))).toEqual([{ model: 'sonnet' }])
  })
  it.each(['written', 'read'])('refuses the launch when a sign-in setting left in its settings cannot be removed (cannot be %s)', async (mode) => {
    seedSystem()
    put(join(systemDir(), 'settings.json'), { model: 'opus' })
    const id = await add()
    await service.launchEnv(id)
    // An older copy kept the system's key.
    const file = account(id, 'settings.json')
    put(file, { model: 'opus', env: { ANTHROPIC_API_KEY: 'fixture-secret-key' } })
    const held =
      mode === 'written'
        ? refuse('rename', (from, to) => to === file)
        : refuse('open', (path, flags) => path === file && flags === 'r')
    expect(await service.launchEnv(id)).toMatchObject({ ok: false, error: expect.stringContaining('another sign-in setting') })
    held.mockRestore()
    expect(read(file).env).toEqual({ ANTHROPIC_API_KEY: 'fixture-secret-key' })
    expect(await service.launchEnv(id)).toMatchObject({ ok: true, accountId: id })
    expect(read(file)).toEqual({ model: 'opus' })
  })
  it("keeps the account's conflicting value aside before anything else, even when the system file can't be written", async () => {
    seedSystem()
    const id = await add()
    await service.launchEnv(id)
    put(account(id, '.claude.json'), { ...read(account(id, '.claude.json')), theme: 'account-theme', editorMode: 'vim' })
    put(configPath(), { ...read(configPath()), theme: 'new-system-theme' })
    const refused = refuse('rename', (from, to) => to === configPath())
    expect(await service.launchEnv(id)).toMatchObject({ ok: true })
    const aside = fs.readdirSync(authPath(id)).filter((name) => name.startsWith('.claude.json.conflict-'))
    expect(aside.map((name) => read(account(id, name)))).toEqual([{ theme: 'account-theme' }])
    expect(read(account(id, '.claude.json'))).toMatchObject({ theme: 'new-system-theme', editorMode: 'vim' })
    expect(read(configPath()).editorMode).toBeUndefined()
    refused.mockRestore()
    await service.launchEnv(id)
    expect(read(configPath())).toMatchObject({ theme: 'new-system-theme', editorMode: 'vim' })
    // Its value can't be kept aside: nothing is replaced.
    put(account(id, '.claude.json'), { ...read(account(id, '.claude.json')), theme: 'mine-again' })
    put(configPath(), { ...read(configPath()), theme: 'system-again' })
    const before = fs.readFileSync(account(id, '.claude.json'), 'utf8')
    refuse('rename', (from, to) => String(to).includes('.claude.json.conflict-'))
    await service.launchEnv(id)
    expect(fs.readFileSync(account(id, '.claude.json'), 'utf8')).toBe(before)
  })
  it('keeps in <name>.merge a file a session wrote to while it was copied to another volume', async () => {
    seedSystem()
    const id = await add()
    await service.launchEnv(id)
    fs.rmdirSync(join(authPath(id), 'projects'))
    put(join(authPath(id), 'projects', 'C--probe', 'active.jsonl'), 'old line\n')
    otherVolume()
    const copy = fsp.copyFile.bind(fsp)
    const copying = vi.spyOn(fsp, 'copyFile').mockImplementation(async (from, to, mode) => {
      await copy(from, to, mode)
      // An older pane's session still has it open and writes a line.
      fs.appendFileSync(from, 'new live line\n')
    })
    await service.launchEnv(id)
    const shared = join(systemDir(), 'projects', 'C--probe', 'active.jsonl')
    expect(fs.readFileSync(join(authPath(id), 'projects.merge', 'C--probe', 'active.jsonl'), 'utf8')).toBe('old line\nnew live line\n')
    expect(fs.existsSync(shared)).toBe(false)
    // Once nothing writes to it any more: moved whole at a later launch.
    copying.mockRestore()
    await service.launchEnv(id)
    expect(fs.readFileSync(shared, 'utf8')).toBe('old line\nnew live line\n')
    expect(fs.existsSync(join(authPath(id), 'projects.merge'))).toBe(false)
  })
  it('never removes a file it put in place on another volume, even one a session writes to at once', async () => {
    seedSystem()
    const id = await add()
    await service.launchEnv(id)
    fs.rmdirSync(join(authPath(id), 'projects'))
    put(join(authPath(id), 'projects', 'C--probe', 'live.jsonl'), 'old line\n')
    const shared = join(systemDir(), 'projects', 'C--probe', 'live.jsonl')
    const link = fsp.link.bind(fsp)
    vi.spyOn(fsp, 'link').mockImplementation(async (from, to) => {
      if (!String(from).includes('.tessel-move-')) throw Object.assign(new Error('other volume'), { code: 'EXDEV' })
      await link(from, to)
      // In place: a system session writes to it right away.
      fs.appendFileSync(to, 'new line\n')
    })
    await service.launchEnv(id)
    expect(fs.readFileSync(shared, 'utf8')).toBe('old line\nnew line\n')
    expect(fs.existsSync(join(authPath(id), 'projects.merge'))).toBe(false)
    expect(fs.readdirSync(join(systemDir(), 'projects', 'C--probe')).filter((n) => n.includes('.tessel-move-'))).toEqual([])
  })
  it('a note that is part of a longer system line is still moved (whole lines only)', async () => {
    seedSystem()
    put(join(systemDir(), 'CLAUDE.md'), 'Never deploy without approval\n')
    const id = await add()
    await service.launchEnv(id)
    const file = account(id, 'CLAUDE.md')
    fs.appendFileSync(file, 'deploy without approval\n')
    // Its first move to the system file is refused.
    const held = refuse('rename', (from, to) => to === join(systemDir(), 'CLAUDE.md'))
    await service.launchEnv(id)
    held.mockRestore()
    await service.launchEnv(id)
    expect(fs.readFileSync(join(systemDir(), 'CLAUDE.md'), 'utf8')).toBe('Never deploy without approval\ndeploy without approval\n')
    expect(fs.readFileSync(file, 'utf8')).toBe('@~/.claude/CLAUDE.md\n')
  })
  it('notes moved while the account file could not be put back, twice: each goes once', async () => {
    seedSystem()
    put(join(systemDir(), 'CLAUDE.md'), 'System memory\n')
    const id = await add()
    await service.launchEnv(id)
    const file = account(id, 'CLAUDE.md')
    const held = refuse('rename', (from, to) => to === file)
    fs.appendFileSync(file, '- A\n')
    await service.launchEnv(id)
    fs.appendFileSync(file, '- B\n')
    await service.launchEnv(id)
    held.mockRestore()
    await service.launchEnv(id)
    expect(fs.readFileSync(join(systemDir(), 'CLAUDE.md'), 'utf8')).toBe('System memory\n- A\n- B\n')
    expect(fs.readFileSync(file, 'utf8')).toBe('@~/.claude/CLAUDE.md\n')
  })
  it('adds a memory note to the system once, even when the account file could not be put back', async () => {
    seedSystem()
    put(join(systemDir(), 'CLAUDE.md'), 'System memory\n')
    const id = await add()
    await service.launchEnv(id)
    const file = account(id, 'CLAUDE.md')
    fs.appendFileSync(file, '- My note\n')
    const held = refuse('rename', (from, to) => to === file)
    await service.launchEnv(id)
    expect(fs.readFileSync(join(systemDir(), 'CLAUDE.md'), 'utf8')).toBe('System memory\n- My note\n')
    expect(fs.readFileSync(file, 'utf8')).toBe('@~/.claude/CLAUDE.md\n- My note\n')
    held.mockRestore()
    // A note added since still goes; the first one is not added again.
    fs.appendFileSync(file, '- Second note\n')
    await service.launchEnv(id)
    expect(fs.readFileSync(join(systemDir(), 'CLAUDE.md'), 'utf8')).toBe('System memory\n- My note\n- Second note\n')
    expect(fs.readFileSync(file, 'utf8')).toBe('@~/.claude/CLAUDE.md\n')
    await service.launchEnv(id)
    expect(fs.readFileSync(join(systemDir(), 'CLAUDE.md'), 'utf8')).toBe('System memory\n- My note\n- Second note\n')
  })
  it("puts the system's Tessel hooks in the account's copy, added to or removed from the system after a first launch", async () => {
    seedSystem()
    put(join(systemDir(), 'settings.json'), { model: 'opus' })
    const id = await add()
    await service.launchEnv(id)
    // Tessel sets its hooks up in the system's settings.
    put(join(systemDir(), 'settings.json'), { model: 'opus', hooks: { Stop: [tesselHook()] } })
    await service.launchEnv(id)
    expect(read(account(id, 'settings.json'))).toEqual({ model: 'opus', hooks: { Stop: [tesselHook()] } })
    // A session on the account set its own up (its node), and the model changed there.
    put(account(id, 'settings.json'), { model: 'sonnet', hooks: { Stop: [tesselHook('D:/other/node.exe')] } })
    // Settings > Remove Tessel hooks: gone from the system's.
    put(join(systemDir(), 'settings.json'), { model: 'opus' })
    await service.launchEnv(id)
    expect(read(join(systemDir(), 'settings.json'))).toEqual({ model: 'sonnet' })
    expect(read(account(id, 'settings.json'))).toEqual({ model: 'sonnet' })
  })
  it("never gives an account the sign-in and endpoint entries of .claude.json's env, nor writes its own back", async () => {
    seedSystem()
    const systemEnv = { ANTHROPIC_API_KEY: 'fixture-secret-key', ANTHROPIC_BASE_URL: 'https://gateway.invalid' }
    put(configPath(), { ...read(configPath()), env: { ...systemEnv, KEEP: '1' } })
    const id = await add()
    await service.launchEnv(id)
    expect(read(account(id, '.claude.json')).env).toEqual({ KEEP: '1' })
    // A session on the account changes an entry and sets a token.
    put(account(id, '.claude.json'), { ...read(account(id, '.claude.json')), env: { KEEP: '2', CLAUDE_CODE_OAUTH_TOKEN: 'fixture-account-token' } })
    await service.launchEnv(id)
    expect(read(configPath()).env).toEqual({ KEEP: '2', ...systemEnv })
    expect(read(account(id, '.claude.json')).env).toEqual({ KEEP: '2' })
    // Removed there (Claude drops an empty env): the system's own entries stay.
    const own = read(account(id, '.claude.json'))
    delete own.env
    put(account(id, '.claude.json'), own)
    await service.launchEnv(id)
    expect(read(configPath()).env).toEqual(systemEnv)
    expect(fs.readFileSync(configPath(), 'utf8')).not.toMatch(/fixture-account-token/)
    for (const file of filesUnder(authPath(id))) expect(fs.readFileSync(file, 'utf8')).not.toMatch(/fixture-secret-key|gateway\.invalid/)
  })
  it(".claude.json's env: refuses the launch when a sign-in entry an older copy left there can't be removed", async () => {
    seedSystem()
    const id = await add()
    await service.launchEnv(id)
    put(account(id, '.claude.json'), { ...read(account(id, '.claude.json')), env: { ANTHROPIC_API_KEY: 'fixture-old-copy' } })
    // A session on the account holds its file.
    fs.mkdirSync(account(id, '.claude.json.lock'))
    expect(await service.launchEnv(id)).toMatchObject({ ok: false, error: expect.stringContaining('another sign-in setting') })
    fs.rmdirSync(account(id, '.claude.json.lock'))
    expect(await service.launchEnv(id)).toMatchObject({ ok: true, accountId: id })
    expect(read(account(id, '.claude.json')).env).toBeUndefined()
  })
  it("never sends an account's requests to the system's gateway, and keeps the gateway in the system's settings", async () => {
    seedSystem()
    const gateway = {
      ANTHROPIC_BASE_URL: 'https://gateway.invalid',
      ANTHROPIC_CUSTOM_HEADERS: 'x-gateway-key: fixture-secret',
      ANTHROPIC_BEDROCK_BASE_URL: 'https://bedrock.invalid',
      CLAUDE_CODE_USE_VERTEX: '1'
    }
    put(join(systemDir(), 'settings.json'), { model: 'opus', env: { ...gateway, KEEP: '1' } })
    const id = await add()
    await service.launchEnv(id)
    expect(read(account(id, 'settings.json'))).toEqual({ model: 'opus', env: { KEEP: '1' } })
    put(account(id, 'settings.json'), { model: 'sonnet', env: { KEEP: '1' } })
    await service.launchEnv(id)
    expect(read(join(systemDir(), 'settings.json'))).toEqual({ model: 'sonnet', env: { KEEP: '1', ...gateway } })
    // An older copy still sends to the gateway, and it can't be removed: refused.
    put(account(id, 'settings.json'), { model: 'sonnet', env: { KEEP: '1', ANTHROPIC_BASE_URL: 'https://gateway.invalid' } })
    const held = refuse('rename', (from, to) => to === account(id, 'settings.json'))
    expect(await service.launchEnv(id)).toMatchObject({ ok: false, error: expect.stringContaining('gateway') })
    held.mockRestore()
    expect(await service.launchEnv(id)).toMatchObject({ ok: true })
    expect(read(account(id, 'settings.json'))).toEqual({ model: 'sonnet', env: { KEEP: '1' } })
  })
  it('removes from the system a preference a session set back to its default (Claude drops it from the file)', async () => {
    seedSystem()
    put(configPath(), { ...read(configPath()), theme: 'light' })
    const id = await add()
    await service.launchEnv(id)
    const own = read(account(id, '.claude.json'))
    delete own.theme
    put(account(id, '.claude.json'), own)
    await service.launchEnv(id)
    expect(read(configPath()).theme).toBeUndefined()
    expect(read(account(id, '.claude.json')).theme).toBeUndefined()
    // A missing account file removes nothing.
    put(configPath(), { ...read(configPath()), theme: 'light' })
    await service.launchEnv(id)
    fs.unlinkSync(account(id, '.claude.json'))
    await service.launchEnv(id)
    expect(read(configPath()).theme).toBe('light')
    expect(read(account(id, '.claude.json')).theme).toBe('light')
  })
})

describe('the older account switch, undone once', () => {
  it('puts the system login back, keeps the account refreshed meanwhile and as the default', async () => {
    seedSystem()
    const id = await add()
    const refreshed = token('managed', 'refreshed', NOW + 200000)
    const original = legacySwitch(id, refreshed)
    put(configPath(), { ...read(configPath()), theme: 'changed meanwhile' })
    const later = create()
    // Before the restore, the system row already shows the system's own login.
    expect((await later.list()).system).toMatchObject({ status: 'ready', email: 'system@fixture.invalid' })
    await later.migrate()
    expect(fs.readFileSync(credentialPath(), 'utf8')).toBe(original)
    expect(read(configPath())).toMatchObject({ theme: 'changed meanwhile', oauthAccount: who('system') })
    expect(read(join(authPath(id), '.credentials.json'))).toEqual(refreshed)
    expect(read(indexPath())).toMatchObject({ selectedId: id, perSession: true })
    expect(fs.existsSync(runtimePath('system-default-auth.json'))).toBe(false)
    expect(await later.launchEnv()).toEqual({ ok: true, env: { CLAUDE_CONFIG_DIR: authPath(id) }, accountId: id })
    // Once only: a stray snapshot never restores again over a newer system login.
    put(credentialPath(), token('new-system'))
    put(runtimePath('system-default-auth.json'), { stray: true })
    await later.migrate()
    expect(read(credentialPath())).toEqual(token('new-system'))
    expect(fs.existsSync(runtimePath('system-default-auth.json'))).toBe(false)
  })
  it('restores the system login without capturing an older token', async () => {
    seedSystem()
    const id = await add()
    const before = read(join(authPath(id), '.credentials.json'))
    const original = legacySwitch(id, token('managed', 'changed', NOW - 1))
    await create().launchEnv()
    expect(read(join(authPath(id), '.credentials.json'))).toEqual(before)
    expect(fs.readFileSync(credentialPath(), 'utf8')).toBe(original)
  })
  it.each(['other-identity', 'embedded-conflict', 'signed-out'])(
    'keeps a system sign-in made since the switch, captures nothing: %s',
    async (mode) => {
      seedSystem()
      const id = await add()
      const before = read(join(authPath(id), '.credentials.json'))
      const replacement = token('other', 'changed', NOW + 200000)
      if (mode === 'embedded-conflict') replacement.claudeAiOauth.accountUuid = 'different-id'
      legacySwitch(id, replacement)
      if (mode === 'other-identity') put(configPath(), { ...read(configPath()), oauthAccount: who('other') })
      if (mode === 'signed-out') fs.rmSync(credentialPath())
      const now = mode === 'signed-out' ? null : fs.readFileSync(credentialPath(), 'utf8')
      const later = create()
      await later.launchEnv()
      expect(read(join(authPath(id), '.credentials.json'))).toEqual(before)
      expect(fs.existsSync(credentialPath()) ? fs.readFileSync(credentialPath(), 'utf8') : null).toBe(now)
      expect(read(indexPath())).toMatchObject({ selectedId: id, perSession: true })
      expect(fs.existsSync(runtimePath('system-default-auth.json'))).toBe(false)
      expect((await later.list()).switchPending).toBeUndefined()
    }
  )
  it('a sign-in made while it runs (after its check) is never overwritten: it stops, and keeps it next time', async () => {
    seedSystem()
    const id = await add()
    legacySwitch(id)
    const real = fsp.open.bind(fsp)
    let reads = 0
    // The snapshot is read again after the check: another account signs in then.
    vi.spyOn(fsp, 'open').mockImplementation(async (path, ...rest) => {
      if (String(path) === runtimePath('system-default-auth.json') && ++reads === 2) {
        put(credentialPath(), token('other'))
        put(configPath(), { ...read(configPath()), oauthAccount: who('other') })
      }
      return real(path, ...rest)
    })
    const later = create()
    await expect(later.migrate()).rejects.toThrow('changed during the operation')
    expect(read(credentialPath())).toEqual(token('other'))
    vi.mocked(fsp.open).mockRestore()
    await later.migrate()
    expect(read(credentialPath())).toEqual(token('other'))
    expect(read(configPath()).oauthAccount).toEqual(who('other'))
    expect(fs.existsSync(runtimePath('system-default-auth.json'))).toBe(false)
  })
  it("its own copy of the sign-in gone, the account keeps the one the system held", async () => {
    seedSystem()
    const id = await add()
    const live = token('managed', 'refreshed', NOW + 200000)
    const original = legacySwitch(id, live)
    fs.rmSync(join(authPath(id), '.credentials.json'))
    await create().migrate()
    expect(read(join(authPath(id), '.credentials.json'))).toEqual(live)
    expect(fs.readFileSync(credentialPath(), 'utf8')).toBe(original)
    expect(await create().launchEnv(id)).toMatchObject({ ok: true, accountId: id })
  })
  it('its whole folder gone, the account keeps the sign-in the system held, in a folder made again', async () => {
    seedSystem()
    const id = await add()
    const live = token('managed', 'refreshed', NOW + 200000)
    const original = legacySwitch(id, live)
    fs.rmSync(join(authPath(id), '..'), { recursive: true, force: true })
    await create().migrate()
    expect(read(join(authPath(id), '.credentials.json'))).toEqual(live)
    expect(fs.readFileSync(join(authPath(id), MARKER), 'utf8')).toBe(`${id}\n`)
    expect(fs.readFileSync(credentialPath(), 'utf8')).toBe(original)
    expect(await create().launchEnv(id)).toMatchObject({ ok: true, accountId: id })
  })
  it('waits while Claude sessions an older version started still run; a sign-in still works', async () => {
    seedSystem()
    const id = await add()
    const original = legacySwitch(id)
    let free = false
    const later = create({ canMigrate: async () => free })
    expect((await later.list()).switchPending).toBe(true)
    await expect(later.launchEnv()).rejects.toThrow('started before the update')
    await expect(later.launchEnv(null)).rejects.toThrow('started before the update')
    await expect(later.select(null)).rejects.toThrow('started before the update')
    expect(await later.switchPending()).toBe(true)
    // Nothing was put back meanwhile.
    expect(fs.readFileSync(credentialPath(), 'utf8')).not.toBe(original)
    selectedIdentity = 'second'
    expect((await later.add()).ok).toBe(true)
    // They stopped: undone at the next try.
    free = true
    expect(await later.migrate()).toEqual({ ok: true })
    expect(fs.readFileSync(credentialPath(), 'utf8')).toBe(original)
    expect(await later.switchPending()).toBe(false)
    expect((await later.list()).switchPending).toBeUndefined()
  })
  it('says before anything is stopped whether the switch can be undone', async () => {
    seedSystem()
    const id = await add()
    legacySwitch(id)
    const later = create()
    expect(await later.checkSwitch()).toEqual({ ok: true })
    put(runtimePath('system-default-auth.json'), { version: 1, binding: { credentialsPath: join(root, 'elsewhere') } })
    expect(await later.checkSwitch()).toMatchObject({ ok: false, snapshotInvalid: true })
    // Signed in to another account since: nothing to put back, nothing to check.
    put(credentialPath(), token('other'))
    put(configPath(), { ...read(configPath()), oauthAccount: who('other') })
    expect(await later.checkSwitch()).toEqual({ ok: true })
  })
  it("gives a broken switch up: the account's sign-in goes to its own folder, the system is signed out", async () => {
    seedSystem()
    const id = await add()
    const refreshed = token('managed', 'refreshed', NOW + 200000)
    legacySwitch(id, refreshed)
    put(runtimePath('system-default-auth.json'), { version: 1, binding: { credentialsPath: join(root, 'elsewhere') } })
    let free = false
    const later = create({ canMigrate: async () => free })
    await expect(later.migrate()).rejects.toThrow('started before the update')
    // Not while the sessions that version started still run.
    await expect(later.discardSwitch()).rejects.toThrow('started before the update')
    free = true
    await expect(later.migrate()).rejects.toThrow('snapshot is unavailable or invalid')
    expect(await later.discardSwitch()).toEqual({ ok: true, signedOut: true })
    expect(fs.existsSync(credentialPath())).toBe(false)
    expect(read(configPath()).oauthAccount).toBeUndefined()
    expect(read(join(authPath(id), '.credentials.json'))).toEqual(refreshed)
    expect(read(indexPath())).toMatchObject({ selectedId: id, perSession: true })
    expect(fs.existsSync(runtimePath('system-default-auth.json'))).toBe(false)
    expect(await later.launchEnv()).toMatchObject({ ok: true, accountId: id })
  })
  it('gives a broken switch up keeping a system sign-in made since', async () => {
    seedSystem()
    const id = await add()
    legacySwitch(id)
    put(runtimePath('system-default-auth.json'), { version: 1, binding: { credentialsPath: join(root, 'elsewhere') } })
    put(credentialPath(), token('other'))
    put(configPath(), { ...read(configPath()), oauthAccount: who('other') })
    const later = create()
    expect(await later.discardSwitch()).toEqual({ ok: true })
    expect(read(credentialPath())).toEqual(token('other'))
    expect(read(configPath()).oauthAccount).toEqual(who('other'))
    expect(fs.existsSync(runtimePath('system-default-auth.json'))).toBe(false)
  })
  it('restores the system login when the selected account record is gone', async () => {
    seedSystem()
    const id = await add()
    legacySwitch(id)
    put(indexPath(), { ...read(indexPath()), accounts: [] })
    expect(await create().launchEnv()).toEqual({ ok: true, env: {}, accountId: null })
    expect(read(credentialPath())).toEqual(token('system'))
    expect(read(indexPath()).selectedId).toBeNull()
  })
  it('only deletes the copy of the system login when nothing was switched', async () => {
    seedSystem()
    await add()
    put(runtimePath('system-default-auth.json'), { version: 1, binding: {}, credentials: 'fixture-refresh-copy', oauth: { present: false, value: null } })
    const config = fs.readFileSync(configPath(), 'utf8')
    await create().migrate()
    expect(fs.existsSync(runtimePath('system-default-auth.json'))).toBe(false)
    expect(fs.readFileSync(configPath(), 'utf8')).toBe(config)
    expect(read(credentialPath())).toEqual(token('system'))
  })
  it('rolls the restore back when the metadata commit fails, retaining unrelated settings', async () => {
    seedSystem()
    const id = await add()
    legacySwitch(id)
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
    await expect(create().migrate()).rejects.toThrow('previous login was restored')
    expect(read(credentialPath())).toEqual(token())
    expect(read(configPath())).toMatchObject({ oauthAccount: who(), addedDuringOperation: true })
    expect(read(indexPath()).perSession).toBeUndefined()
    expect(fs.existsSync(runtimePath('transaction.json'))).toBe(false)
    await create().migrate()
    expect(read(credentialPath())).toEqual(token('system'))
    expect(read(configPath())).toMatchObject({ oauthAccount: who('system'), addedDuringOperation: true })
  })
  it('retains a durable intent when rollback fails and recovers before the next launch', async () => {
    seedSystem()
    const id = await add()
    legacySwitch(id)
    const original = fsp.rename.bind(fsp)
    let credentialWrites = 0
    const spy = vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (to === credentialPath()) credentialWrites++
      if (to === indexPath() || (to === credentialPath() && credentialWrites > 1))
        throw Object.assign(new Error('secret'), { code: 'EIO' })
      return original(from, to)
    })
    await expect(create().migrate()).rejects.toThrow('could not be rolled back')
    expect(fs.existsSync(runtimePath('transaction.json'))).toBe(true)
    spy.mockRestore()
    expect(await create().launchEnv()).toMatchObject({ ok: true, accountId: id })
    expect(read(credentialPath())).toEqual(token('system'))
    expect(read(configPath()).oauthAccount).toEqual(who('system'))
    expect(fs.existsSync(runtimePath('transaction.json'))).toBe(false)
  })
  it('refuses invalid snapshots and journal paths instead of writing a supplied target', async () => {
    seedSystem()
    const id = await add()
    legacySwitch(id)
    put(runtimePath('system-default-auth.json'), {
      version: 1,
      binding: { credentialsPath: join(root, 'victim') }
    })
    await expect(create().launchEnv()).rejects.toThrow('snapshot is unavailable or invalid')
    put(runtimePath('transaction.json'), {
      version: 1,
      binding: {},
      changes: [{ kind: 'file', path: join(root, 'victim'), after: 'bad' }]
    })
    await expect(create().launchEnv()).rejects.toThrow('unavailable or invalid')
    expect(fs.existsSync(join(root, 'victim'))).toBe(false)
  })
})

describe('refused storage', () => {
  it('refuses malformed config, registry and account credentials without replacing them', async () => {
    seedSystem()
    const id = await add()
    put(configPath(), '{invalid secret')
    await expect(service.launchEnv(null)).rejects.toThrow('unavailable or invalid')
    expect(fs.readFileSync(configPath(), 'utf8')).toBe('{invalid secret')
    seedSystem()
    put(join(authPath(id), '.credentials.json'), '{bad')
    expect((await service.list()).accounts[0].status).toBe('unknown')
    await expect(service.select(id)).rejects.toThrow('valid login')
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
    await expect(service.launchEnv(id)).rejects.toThrow('unreadable')
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

describe('sign-in folders', () => {
  const link = (target, path) => {
    fs.mkdirSync(join(path, '..'), { recursive: true })
    fs.symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')
  }
  it('adds the account when its sign-in folder holds a junction (a browser profile), removes the folder and keeps what the junction points to', async () => {
    seedSystem()
    const outside = join(root, 'outside')
    put(join(outside, 'keep.txt'), 'keep')
    const signIn = runner.getMockImplementation()
    let isolated
    runner.mockImplementationOnce(async (options) => {
      isolated = options.home
      link(outside, join(isolated, 'AppData', 'INetCache', 'Content.IE5'))
      return signIn(options)
    })
    const result = await service.add()
    expect(result.ok).toBe(true)
    expect(fs.existsSync(isolated)).toBe(false)
    expect(fs.readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('keep')
  })
  it('a sign-in folder that cannot be removed does not undo the sign-in', async () => {
    seedSystem()
    const signIn = runner.getMockImplementation()
    let isolated
    runner.mockImplementationOnce(async (options) => {
      isolated = options.home
      // Deeper than the cleanup goes.
      fs.mkdirSync(join(isolated, ...Array(14).fill('d')), { recursive: true })
      return signIn(options)
    })
    const result = await service.add()
    expect(result.ok).toBe(true)
    expect((await service.list()).accounts.map((a) => a.email)).toEqual(['managed@fixture.invalid'])
    expect(fs.existsSync(isolated)).toBe(true)
  })
  it('removes a sign-in folder an earlier sign-in left once it is an hour old, and only one of its own', async () => {
    seedSystem()
    const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333']
    const [old, recent, foreign] = ids.map((id) => runtimePath(`login-${id}`))
    const hoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
    put(join(old, MARKER), `login:${ids[0]}\n`)
    put(join(old, '.credentials.json'), token('old'))
    link(join(root, 'home'), join(old, 'AppData', 'Content.IE5'))
    fs.utimesSync(join(old, MARKER), hoursAgo, hoursAgo)
    put(join(recent, MARKER), `login:${ids[1]}\n`)
    put(join(foreign, MARKER), 'someone else\n')
    fs.utimesSync(join(foreign, MARKER), hoursAgo, hoursAgo)
    await add()
    expect(fs.existsSync(old)).toBe(false)
    expect(fs.existsSync(recent)).toBe(true)
    expect(fs.existsSync(foreign)).toBe(true)
    expect(read(credentialPath())).toEqual(token('system'))
  })
  it('a cleanup that fails halfway keeps the folder marked (a later sign-in finishes it), and its copy of the login goes at once', async () => {
    seedSystem()
    const signIn = runner.getMockImplementation()
    let isolated
    runner.mockImplementationOnce(async (options) => {
      isolated = options.home
      put(join(isolated, 'AppData', 'Profile', 'cookies.sqlite'), 'held by a browser')
      return signIn(options)
    })
    const real = fsp.unlink.bind(fsp)
    const unlink = vi.spyOn(fsp, 'unlink').mockImplementation(async (path) => {
      if (String(path).endsWith('cookies.sqlite')) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
      return real(path)
    })
    expect((await service.add()).ok).toBe(true)
    expect(fs.existsSync(join(isolated, MARKER))).toBe(true)
    expect(fs.existsSync(join(isolated, '.credentials.json'))).toBe(false)
    // The browser let go; an hour on, the next sign-in removes the folder.
    unlink.mockRestore()
    const hoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
    fs.utimesSync(join(isolated, MARKER), hoursAgo, hoursAgo)
    await add('other')
    expect(fs.existsSync(isolated)).toBe(false)
  })
  it('keeps the folder of a sign-in whose end was never confirmed until its process is gone, whatever its age', async () => {
    seedSystem()
    const alive = new Set([4242])
    service = create({ pidAlive: (pid) => alive.has(pid) })
    const hoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
    const folders = []
    for (const pid of [4242, null]) {
      runner.mockImplementationOnce(async ({ home: isolated }) => {
        folders.push(isolated)
        return { ok: false, cleanupSafe: false, pid }
      })
      await expect(service.add()).rejects.toThrow('could not be confirmed')
    }
    for (const folder of folders) fs.utimesSync(join(folder, MARKER), hoursAgo, hoursAgo)
    // Its process still runs, or is unknown: kept.
    await add()
    expect(folders.map((f) => fs.existsSync(f))).toEqual([true, true])
    // Seen gone: removed at the next sign-in; the unknown one stays.
    alive.clear()
    await add('other')
    expect(folders.map((f) => fs.existsSync(f))).toEqual([false, true])
  })
  it('writes its guard before the sign-in starts: if it cannot, nothing starts and its folder goes', async () => {
    seedSystem()
    const real = fsp.rename.bind(fsp)
    vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (String(to).endsWith('.tessel-login-pid')) throw Object.assign(new Error('denied'), { code: 'EACCES' })
      return real(from, to)
    })
    await expect(service.add()).rejects.toThrow()
    expect(runner).not.toHaveBeenCalled()
    expect(fs.readdirSync(runtimePath('')).filter((n) => n.startsWith('login-'))).toEqual([])
  })
  it("keeps the folder while the sign-in's process runs, from the moment it starts (a later write that fails changes nothing)", async () => {
    seedSystem()
    const alive = new Set([4242])
    service = create({ pidAlive: (pid) => alive.has(pid) })
    let isolated
    const real = fsp.rename.bind(fsp)
    runner.mockImplementationOnce(async ({ home: directory, onSpawn }) => {
      isolated = directory
      await onSpawn(4242)
      // Every write of the guard from now on fails.
      vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
        if (String(to).endsWith('.tessel-login-pid')) throw Object.assign(new Error('denied'), { code: 'EACCES' })
        return real(from, to)
      })
      return { ok: false, cleanupSafe: false, pid: 4242 }
    })
    await expect(service.add()).rejects.toThrow('could not be confirmed')
    vi.mocked(fsp.rename).mockRestore()
    expect(fs.readFileSync(join(isolated, '.tessel-login-pid'), 'utf8').trim()).toBe('4242')
    const hoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
    fs.utimesSync(join(isolated, MARKER), hoursAgo, hoursAgo)
    await add()
    expect(fs.existsSync(isolated)).toBe(true)
    alive.clear()
    await add('other')
    expect(fs.existsSync(isolated)).toBe(false)
  })
})
