// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import { dirname, join, resolve, sep } from 'path'
import { createCodexAccounts } from '../codexAccounts'

let fixture, home, userData, system, tick
beforeEach(() => {
  fixture = fs.mkdtempSync(join(os.tmpdir(), 'tessel-codex-accounts-'))
  home = join(fixture, 'user')
  userData = join(fixture, 'tessel')
  system = join(home, '.codex')
  tick = Date.parse('2026-09-28T02:00:00Z')
  fs.mkdirSync(system, { recursive: true })
})
afterEach(() => {
  vi.restoreAllMocks()
  const target = resolve(fixture)
  if (!target.startsWith(resolve(os.tmpdir()) + sep) || !target.includes('tessel-codex-accounts-'))
    throw new Error('Unexpected cleanup path')
  fs.rmSync(target, { recursive: true, force: true })
})
const put = (file, value) => {
  fs.mkdirSync(dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
}
const auth = (email = 'one@example.test', identity = {}) => ({
  auth_mode: 'chatgpt',
  tokens: {
    access_token: 'FAKE-SECRET-ACCESS',
    refresh_token: 'FAKE-SECRET-REFRESH',
    account_id: identity.accountId || 'account-1',
    id_token: `header.${Buffer.from(JSON.stringify({ email, 'https://api.openai.com/auth': { workspace_name: 'Test team', chatgpt_plan_type: 'pro', chatgpt_account_id: identity.workspaceId || 'workspace-1', chatgpt_user_id: identity.userId || 'user-1' } })).toString('base64url')}.signature`
  }
})
const login = vi.fn(async ({ home: target }) => {
  put(join(target, 'auth.json'), auth())
  return { ok: true }
})
const service = (options = {}) =>
  createCodexAccounts({ userData, home, env: {}, runLogin: login, now: () => tick, ...options })
const metadata = () => join(userData, 'codex-accounts', 'accounts.json')
const managed = (id) => join(userData, 'codex-accounts', id, 'home')
const denied = () => Object.assign(new Error('FAKE-SECRET-ERROR'), { code: 'EACCES' })

describe('managed Codex accounts', () => {
  it('lists a read-only system default without creating storage or exposing auth', async () => {
    put(join(system, 'auth.json'), auth())
    expect(await service().list()).toEqual({
      provider: 'codex',
      selectedId: null,
      system: { id: null, label: 'System default', status: 'ready' },
      accounts: [],
      restartRequired: false
    })
    expect(fs.existsSync(userData)).toBe(false)
    expect(await service().launchEnv()).toEqual({ ok: true, env: {}, accountId: null })
  })

  it('adds an isolated account, copies settings/hooks/instructions only and never selects implicitly', async () => {
    const original =
      'model = "gpt-6"\ncli_auth_credentials_store = "keyring" # personal\n[mcp_servers.tessel-team]\ncommand = "node"\n'
    put(join(system, 'config.toml'), original)
    put(join(system, 'hooks.json'), { hooks: { Stop: [] } })
    put(join(system, 'AGENTS.md'), 'Keep the board updated.')
    put(join(system, 'sessions', 'secret.jsonl'), 'private old conversation')
    put(join(system, 'auth.json'), auth('system@example.test'))
    const runLogin = vi.fn(async ({ home: target, provider }) => {
      expect(provider).toBe('codex')
      expect(fs.existsSync(join(target, 'auth.json'))).toBe(false)
      expect(fs.readFileSync(join(target, 'config.toml'), 'utf8')).toContain(
        'cli_auth_credentials_store = "file"'
      )
      put(join(target, 'auth.json'), auth())
      return { ok: true }
    })
    const result = await service({ runLogin }).add()
    expect(result.selectedId).toBe(null)
    expect(result.accounts[0]).toMatchObject({
      id: result.id,
      label: 'one@example.test',
      email: 'one@example.test',
      organization: 'Test team',
      plan: 'pro',
      status: 'ready',
      active: false
    })
    expect(JSON.stringify(result)).not.toContain('SECRET')
    expect(fs.readFileSync(metadata(), 'utf8')).not.toContain('SECRET')
    expect(fs.readFileSync(join(system, 'config.toml'), 'utf8')).toBe(original)
    expect(JSON.parse(fs.readFileSync(join(system, 'auth.json'))).tokens.id_token).toBe(
      auth('system@example.test').tokens.id_token
    )
    expect(fs.readFileSync(join(managed(result.id), 'AGENTS.md'), 'utf8')).toBe(
      'Keep the board updated.'
    )
    expect(fs.existsSync(join(managed(result.id), 'hooks.json'))).toBe(true)
    expect(fs.existsSync(join(managed(result.id), 'sessions'))).toBe(false)
  })

  it('selects explicitly, survives restart and returns managed environment only for that account', async () => {
    const api = service()
    const added = await api.add()
    const selected = await api.select(added.id)
    expect(selected.accounts[0].active).toBe(true)
    expect(await service().launchEnv()).toEqual({
      ok: true,
      env: { CODEX_HOME: managed(added.id) },
      accountId: added.id
    })
    await api.select(null)
    expect(await api.launchEnv()).toEqual({ ok: true, env: {}, accountId: null })
    expect((await api.list()).accounts).toHaveLength(1)
  })

  it('keeps usage environment reads free of config/resource writes', async () => {
    const api = service()
    const { id } = await api.add()
    await api.select(id)
    put(join(system, 'AGENTS.md'), 'changed after selection')
    const write = vi.spyOn(fs, 'writeFileSync')
    expect(await api.usageEnv()).toMatchObject({ ok: true, accountId: id })
    expect(write).not.toHaveBeenCalled()
    await api.launchEnv()
    expect(fs.readFileSync(join(managed(id), 'AGENTS.md'), 'utf8')).toBe('changed after selection')
  })

  it('binds a pane to an explicit saved account or system without changing the selected default', async () => {
    const api = service()
    const first = await api.add()
    const second = await api.add()
    await api.select(second.id)
    expect(await api.launchEnv(first.id)).toMatchObject({
      ok: true,
      accountId: first.id,
      env: { CODEX_HOME: managed(first.id) }
    })
    expect(await api.usageEnv(first.id)).toMatchObject({ ok: true, accountId: first.id })
    expect(await api.launchEnv(null)).toEqual({ ok: true, env: {}, accountId: null })
    expect(await api.usageEnv(null)).toEqual({ ok: true, env: {}, accountId: null })
    expect((await api.list()).selectedId).toBe(second.id)
    expect(await api.launchEnv('missing')).toMatchObject({ ok: false })
    expect((await api.list()).selectedId).toBe(second.id)
  })

  it('refuses a directly replaced auth identity without changing stored account metadata', async () => {
    const api = service()
    const { id } = await api.add()
    await api.select(id)
    const before = fs.readFileSync(metadata(), 'utf8')
    put(join(managed(id), 'auth.json'), auth('other@example.test', { accountId: 'other' }))
    expect((await api.list()).accounts[0]).toMatchObject({
      status: 'unknown',
      email: 'one@example.test'
    })
    expect(await api.launchEnv()).toMatchObject({ ok: false })
    expect(await api.usageEnv(id)).toMatchObject({ ok: false })
    await expect(api.select(id)).rejects.toThrow(/login is unavailable/)
    expect(fs.readFileSync(metadata(), 'utf8')).toBe(before)
  })

  it('does not rewrite unchanged config/resources and removes only unchanged mirrored files', async () => {
    put(join(system, 'hooks.json'), '{"hooks":{}}')
    put(join(system, 'AGENTS.md'), 'global instructions')
    const api = service()
    const { id } = await api.add()
    await api.select(id)
    const write = vi.spyOn(fs, 'writeFileSync')
    expect(await api.launchEnv()).toMatchObject({ ok: true })
    expect(write).not.toHaveBeenCalled()
    fs.unlinkSync(join(system, 'hooks.json'))
    expect(await api.launchEnv()).toMatchObject({ ok: true })
    expect(fs.existsSync(join(managed(id), 'hooks.json'))).toBe(false)
    put(join(managed(id), 'AGENTS.md'), 'independent managed instructions')
    fs.unlinkSync(join(system, 'AGENTS.md'))
    expect(await api.launchEnv()).toMatchObject({
      ok: false,
      error: expect.stringContaining('edited separately')
    })
    expect(fs.readFileSync(join(managed(id), 'AGENTS.md'), 'utf8')).toBe(
      'independent managed instructions'
    )
  })

  it('reports missing credentials after grace without dropping selection or metadata', async () => {
    const api = service()
    const { id } = await api.add()
    await api.select(id)
    fs.unlinkSync(join(managed(id), 'auth.json'))
    expect((await api.list()).accounts[0]).toMatchObject({
      status: 'unknown',
      email: 'one@example.test'
    })
    expect(await api.launchEnv()).toMatchObject({ ok: false })
    tick += 6000
    expect((await api.list()).accounts[0].status).toBe('missing')
    expect((await api.list()).selectedId).toBe(id)
    put(join(managed(id), 'auth.json'), auth())
    expect((await api.list()).accounts[0].status).toBe('ready')
  })

  it('preserves selected metadata on transient unreadable auth/marker and refuses launch', async () => {
    const api = service()
    const { id } = await api.add()
    await api.select(id)
    const original = fs.readFileSync.bind(fs)
    const read = vi.spyOn(fs, 'readFileSync').mockImplementation((path, ...args) => {
      if (String(path) === join(managed(id), 'auth.json')) throw denied()
      return original(path, ...args)
    })
    expect((await api.list()).accounts[0]).toMatchObject({
      status: 'unknown',
      email: 'one@example.test'
    })
    expect(await api.usageEnv()).toMatchObject({ ok: false })
    expect((await api.list()).selectedId).toBe(id)
    read.mockRestore()
    expect(await api.launchEnv()).toMatchObject({ ok: true })
  })

  it('refuses linked account home without deleting the real target or clearing selection', async () => {
    const api = service()
    const { id } = await api.add()
    await api.select(id)
    fs.renameSync(managed(id), `${managed(id)}-original`)
    fs.symlinkSync(system, managed(id), process.platform === 'win32' ? 'junction' : 'dir')
    expect(await api.launchEnv()).toMatchObject({ ok: false })
    await expect(api.remove(id)).rejects.toThrow(/link/)
    expect((await api.list()).selectedId).toBe(id)
    expect(fs.existsSync(system)).toBe(true)
    fs.unlinkSync(managed(id))
    fs.renameSync(`${managed(id)}-original`, managed(id))
  })

  it('rejects symlinked storage ancestors before creating any managed account', async () => {
    fs.mkdirSync(userData)
    fs.symlinkSync(
      system,
      join(userData, 'codex-accounts'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    await expect(service().add()).rejects.toThrow(/link/)
    expect(fs.readdirSync(system)).toEqual([])
    fs.unlinkSync(join(userData, 'codex-accounts'))
  })

  it('refuses removal if ownership marker is missing or mismatched', async () => {
    const api = service()
    const { id } = await api.add()
    const marker = join(managed(id), '.tessel-managed-codex.json')
    fs.unlinkSync(marker)
    await expect(api.remove(id)).rejects.toThrow(/marker/)
    put(marker, { version: 1, provider: 'codex', id: 'other' })
    await expect(api.remove(id)).rejects.toThrow(/marker/)
    expect(fs.existsSync(join(managed(id), 'auth.json'))).toBe(true)
  })

  it('removes only the selected owned account, leaving another account and system auth intact', async () => {
    const api = service()
    put(join(system, 'auth.json'), auth('system@example.test'))
    const first = await api.add()
    const second = await api.add()
    await api.select(first.id)
    expect((await api.remove(first.id)).selectedId).toBe(null)
    expect(fs.existsSync(managed(first.id))).toBe(false)
    expect(fs.existsSync(managed(second.id))).toBe(true)
    expect(fs.existsSync(join(system, 'auth.json'))).toBe(true)
  })

  it('keeps previous valid auth when reauthentication fails, is cancelled or writes malformed credentials', async () => {
    const api = service()
    const { id } = await api.add()
    const original = fs.readFileSync(join(managed(id), 'auth.json'), 'utf8')
    for (const runLogin of [
      async () => ({ ok: false, error: 'FAKE-SECRET' }),
      async ({ home: target }) => {
        put(join(target, 'auth.json'), '{invalid')
        return { ok: true }
      }
    ]) {
      await expect(service({ runLogin }).reauthenticate(id)).rejects.toThrow()
      expect(fs.readFileSync(join(managed(id), 'auth.json'), 'utf8')).toBe(original)
    }
    const signal = AbortSignal.abort()
    await expect(api.reauthenticate(id, { signal })).rejects.toThrow(/cancelled/)
    expect(fs.readFileSync(join(managed(id), 'auth.json'), 'utf8')).toBe(original)
  })

  it('retains empty staging when an aborted login child cannot be confirmed stopped', async () => {
    const api = service()
    const { id } = await api.add()
    const original = fs.readFileSync(join(managed(id), 'auth.json'), 'utf8')
    const staged = []
    for (const reauth of [false, true]) {
      const controller = new AbortController()
      const runLogin = async ({ home: target }) => {
        staged.push(target)
        controller.abort()
        return { ok: false, cleanupSafe: false, error: 'fake process never exited' }
      }
      const test = service({ runLogin })
      const promise = reauth
        ? test.reauthenticate(id, { signal: controller.signal })
        : test.add({ signal: controller.signal })
      await expect(promise).rejects.toMatchObject({ cleanupSafe: false })
    }
    for (const path of staged)
      expect(fs.existsSync(join(path, '.tessel-managed-codex.json'))).toBe(true)
    expect(fs.readFileSync(join(managed(id), 'auth.json'), 'utf8')).toBe(original)
    expect((await api.list()).accounts).toHaveLength(1)
  })

  it('replaces auth only after successful staged login, retaining account id and selection', async () => {
    const api = service()
    const { id } = await api.add()
    await api.select(id)
    tick += 10000
    const runLogin = async ({ home: target }) => {
      expect(target).not.toBe(managed(id))
      expect(JSON.parse(fs.readFileSync(join(managed(id), 'auth.json'))).tokens.id_token).toBe(
        auth().tokens.id_token
      )
      const refreshed = auth()
      refreshed.tokens.access_token = 'FAKE-SECRET-REFRESHED'
      put(join(target, 'auth.json'), refreshed)
      return { ok: true }
    }
    const result = await service({ runLogin }).reauthenticate(id)
    expect(result.selectedId).toBe(id)
    expect(result.accounts[0]).toMatchObject({
      id,
      email: 'one@example.test',
      lastLoginAt: new Date(tick).toISOString()
    })
  })

  it('refuses another email, account, workspace or user during reauthentication', async () => {
    const api = service()
    const { id } = await api.add()
    await api.select(id)
    const originalAuth = fs.readFileSync(join(managed(id), 'auth.json'), 'utf8')
    const originalMetadata = fs.readFileSync(metadata(), 'utf8')
    for (const credential of [
      auth('wrong@example.test'),
      auth(undefined, { accountId: 'other' }),
      auth(undefined, { workspaceId: 'other' }),
      auth(undefined, { userId: 'other' })
    ]) {
      const runLogin = async ({ home: target }) => {
        put(join(target, 'auth.json'), credential)
        return { ok: true }
      }
      await expect(service({ runLogin }).reauthenticate(id)).rejects.toThrow(
        /identity does not match/
      )
      expect(fs.readFileSync(join(managed(id), 'auth.json'), 'utf8')).toBe(originalAuth)
      expect(fs.readFileSync(metadata(), 'utf8')).toBe(originalMetadata)
    }
  })

  it('rolls back reauthentication auth when metadata commit fails', async () => {
    const api = service()
    const { id } = await api.add()
    const originalAuth = fs.readFileSync(join(managed(id), 'auth.json'), 'utf8')
    const originalRename = fs.renameSync.bind(fs)
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) === metadata()) throw Object.assign(new Error('save failure'), { code: 'EIO' })
      return originalRename(from, to)
    })
    const runLogin = async ({ home: target }) => {
      const refreshed = auth()
      refreshed.tokens.access_token = 'FAKE-SECRET-REFRESHED'
      put(join(target, 'auth.json'), refreshed)
      return { ok: true }
    }
    await expect(service({ runLogin }).reauthenticate(id)).rejects.toThrow(/could not be saved/)
    expect(fs.readFileSync(join(managed(id), 'auth.json'), 'utf8')).toBe(originalAuth)
  })

  it('does not delete owned account files when metadata save fails before removal', async () => {
    const api = service()
    const { id } = await api.add()
    const originalRename = fs.renameSync.bind(fs)
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) === metadata()) throw Object.assign(new Error('save failure'), { code: 'EIO' })
      return originalRename(from, to)
    })
    await expect(api.remove(id)).rejects.toThrow()
    expect(fs.existsSync(join(managed(id), 'auth.json'))).toBe(true)
  })

  it('keeps an authenticated home if initial metadata persistence fails', async () => {
    const originalRename = fs.renameSync.bind(fs)
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) === metadata()) throw Object.assign(new Error('save failure'), { code: 'EIO' })
      return originalRename(from, to)
    })
    await expect(service().add()).rejects.toThrow()
    const dirs = fs
      .readdirSync(dirname(metadata()), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
    expect(dirs).toHaveLength(1)
    expect(fs.existsSync(join(dirname(metadata()), dirs[0].name, 'home', 'auth.json'))).toBe(true)
  })

  it('does not expose unsanitized CLI errors, tokens, home paths or arbitrary metadata fields', async () => {
    const api = service()
    const { id } = await api.add()
    const saved = JSON.parse(fs.readFileSync(metadata()))
    saved.accounts[0].access_token = 'FAKE-SECRET-METADATA'
    put(metadata(), saved)
    const result = await api.list()
    expect(JSON.stringify(result)).not.toContain('SECRET')
    expect(JSON.stringify(result)).not.toContain(managed(id))
    await expect(
      service({
        runLogin: async () => {
          throw new Error('FAKE-SECRET-CLI')
        }
      }).add()
    ).rejects.not.toThrow('FAKE-SECRET')
  })

  it('refuses unknown ids and corrupt metadata without replacing it with an empty store', async () => {
    await expect(service().select('../../outside')).rejects.toThrow(/valid saved/)
    put(metadata(), '{broken')
    await expect(service().add()).rejects.toThrow(/could not be read/)
    expect(fs.readFileSync(metadata(), 'utf8')).toBe('{broken')
  })

  it('reads a valid backup after damaged metadata and retains the selected account', async () => {
    const api = service()
    const { id } = await api.add()
    await api.select(id)
    await api.select(id) // backup now holds the same selected account
    put(metadata(), '{broken')
    expect((await service().list()).selectedId).toBe(id)
  })

  it('does not fall back to stale metadata when the primary is temporarily unreadable', async () => {
    const api = service()
    const { id } = await api.add()
    await api.select(id)
    const original = fs.readFileSync.bind(fs)
    const before = original(metadata(), 'utf8')
    vi.spyOn(fs, 'readFileSync').mockImplementation((path, ...args) => {
      if (String(path) === metadata()) throw denied()
      return original(path, ...args)
    })
    await expect(api.list()).rejects.toThrow(/metadata is temporarily unavailable/)
    await expect(api.select(null)).rejects.toThrow(/unavailable/)
    expect(original(metadata(), 'utf8')).toBe(before)
  })

  it('refuses linked mirrored resources without writing through them', async () => {
    const api = service()
    const { id } = await api.add()
    await api.select(id)
    const outside = join(fixture, 'outside')
    fs.mkdirSync(outside)
    fs.symlinkSync(
      outside,
      join(managed(id), 'hooks.json'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    put(join(system, 'hooks.json'), { hooks: {} })
    expect(await api.launchEnv()).toMatchObject({ ok: false })
    expect(fs.readdirSync(outside)).toEqual([])
    fs.unlinkSync(join(managed(id), 'hooks.json'))
  })

  it('serializes concurrent account creation while list stays responsive during login', async () => {
    let release
    let entered
    const start = new Promise((resolve) => {
      entered = resolve
    })
    const wait = new Promise((resolve) => {
      release = resolve
    })
    let running = 0,
      peak = 0
    const runLogin = async ({ home: target }) => {
      running++
      peak = Math.max(peak, running)
      entered()
      await wait
      put(join(target, 'auth.json'), auth())
      running--
      return { ok: true }
    }
    const api = service({ runLogin })
    const first = api.add()
    const second = api.add()
    await start
    expect((await api.list()).accounts).toEqual([])
    release()
    await Promise.all([first, second])
    expect(peak).toBe(1)
    expect((await api.list()).accounts).toHaveLength(2)
  })

  it('mirrors CODEX_HOME override and rejects unsafe/custom config instead of modifying system config', async () => {
    const custom = join(fixture, 'custom-codex')
    put(join(custom, 'config.toml'), "model_provider = 'third-party'\n")
    await expect(service({ env: { CODEX_HOME: custom } }).add()).rejects.toThrow(/custom provider/)
    expect(
      fs
        .readdirSync(dirname(metadata()), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
    ).toEqual([])
    put(join(custom, 'config.toml'), '"cli_auth_credentials_store" = "auto"\nmodel = "gpt-6"\n')
    const { id } = await service({ env: { CODEX_HOME: custom } }).add()
    expect(fs.readFileSync(join(managed(id), 'config.toml'), 'utf8')).toContain('model = "gpt-6"')
    expect(fs.readFileSync(join(custom, 'config.toml'), 'utf8')).toContain('"auto"')
  })

  it('preserves setting-shaped multiline instructions but refuses a profile credential store override', async () => {
    const instructions =
      'developer_instructions = """\n[example]\ncli_auth_credentials_store = "keyring"\n"""\ncli_auth_credentials_store = "auto"\n'
    put(join(system, 'config.toml'), instructions)
    const { id } = await service().add()
    const config = fs.readFileSync(join(managed(id), 'config.toml'), 'utf8')
    expect(config).toContain('[example]\ncli_auth_credentials_store = "keyring"')
    expect(config).not.toContain('cli_auth_credentials_store = "auto"')
    put(join(system, 'config.toml'), '[profiles.other]\ncli_auth_credentials_store = "keyring"\n')
    await expect(service().add()).rejects.toThrow(/table or profile/)
    put(join(system, 'config.toml'), 'profiles.other.cli_auth_credentials_store = "keyring"\n')
    await expect(service().add()).rejects.toThrow(/dotted credential-store/)
    put(join(system, 'config.toml'), '[profiles.other]\nmodel_provider = "custom"\n')
    await expect(service().add()).rejects.toThrow(/custom provider/)
  })

  it('refuses custom credentials on the built-in OpenAI provider while allowing inactive providers', async () => {
    for (const config of [
      '[model_providers.openai]\nenv_key = "OTHER_TOKEN"\n',
      'model_providers.openai.experimental_bearer_token = "FAKE-SECRET"\n',
      '["model_providers"."openai"]\nbase_url = "https://example.test"\n'
    ]) {
      put(join(system, 'config.toml'), config)
      await expect(service().add()).rejects.toThrow(/overrides the built-in OpenAI provider/)
    }
    put(
      join(system, 'config.toml'),
      'model_provider = "openai"\n[model_providers.other]\nenv_key = "OTHER_TOKEN"\n'
    )
    expect((await service().add()).ok).toBe(true)
  })

  it('refuses inline, dotted-profile and escaped provider overrides without blocking ordinary Windows project tables', async () => {
    for (const config of [
      'model_providers = { openai = { env_key = "OTHER_TOKEN" } }\n',
      'profile = "other"\nprofiles.other.model_provider = "custom"\n',
      'profiles = { other = { model_provider = "custom" } }\n',
      '[model_providers."\\u006fpenai"]\nenv_key = "OTHER_TOKEN"\n',
      '["\\u006dodel_providers".openai]\nenv_key = "OTHER_TOKEN"\n'
    ]) {
      put(join(system, 'config.toml'), config)
      await expect(service().add()).rejects.toThrow(/cannot be mirrored safely/)
    }
    put(
      join(system, 'config.toml'),
      '[projects."C:\\\\Projects\\\\example"]\ntrust_level = "trusted"\n'
    )
    expect((await service().add()).ok).toBe(true)
  })
})
