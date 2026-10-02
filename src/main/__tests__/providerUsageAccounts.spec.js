// @vitest-environment node
// Settings > AI provider accounts for Cursor, Grok, Gemini, OpenCode Go and
// MiniMax: saved credentials (encrypted, never returned), sign-in status read
// from fake homes, and the usage reads that use them.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createProviderCredentials, cleanSecret } from '../providerCredentials'
import { createUsageProviderSources, cookiePairs, openCodeCookie } from '../usageProviderSources'
import { createExtraProviderUsage, USAGE_URLS } from '../extraProviderUsage'
import { mapMiniMax, mapOpenCodeConsole, openCodeWorkspaceIds } from '../usageProviderMapping'
import { extractGeminiOAuthClient, createGeminiRefresher, GOOGLE_TOKEN_URL } from '../geminiCliOAuth'

const now = Date.parse('2026-09-28T12:00:00Z')
let home, env
// A stand-in for Electron's safeStorage: reversible, but never the plain text.
const safeStorage = (available = true) => ({
  isEncryptionAvailable: () => available,
  getSelectedStorageBackend: () => 'dpapi',
  encryptString: (text) => Buffer.from('enc:' + Buffer.from(text).toString('hex')),
  decryptString: (buf) => Buffer.from(buf.toString().slice(4), 'hex').toString()
})
async function write(rel, value) {
  const file = path.join(home, rel)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value))
  return file
}
const jwt = (sub = 'fixture-user', exp = now / 1000 + 3600) =>
  `header.${Buffer.from(JSON.stringify({ sub, exp })).toString('base64url')}.fixture`

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'tessel-usage-accounts-'))
  env = { APPDATA: path.join(home, 'roaming'), XDG_DATA_HOME: path.join(home, 'data'), PATH: '' }
})
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('saved provider credentials', () => {
  const store = (available = true) =>
    createProviderCredentials({ dir: path.join(home, 'userData', 'provider-credentials'), safeStorage: safeStorage(available) })

  it('encrypts keys and cookies and only reports whether each is saved', async () => {
    const credentials = store()
    const result = credentials.saveSecret('minimaxApiKey', '  fixture-minimax-key  ')
    expect(result).toMatchObject({ ok: true, secure: true, protection: 'sealed', saved: { minimaxApiKey: true, minimaxCookie: false } })
    expect(JSON.stringify(result)).not.toContain('fixture-minimax-key')
    const raw = await fs.readFile(path.join(home, 'userData', 'provider-credentials', 'secrets.json'), 'utf8')
    expect(raw).not.toContain('fixture-minimax-key')
    // A new process reads it back through the OS encryption.
    expect(store().secret('minimaxApiKey')).toBe('fixture-minimax-key')
    expect(JSON.stringify(store().status())).not.toContain('fixture-minimax-key')
  })

  it('forgets one secret, and removes the file with the last one', async () => {
    const credentials = store()
    credentials.saveSecret('opencodeGoApiKey', 'fixture-go')
    credentials.saveSecret('opencodeCookie', 'Cookie: auth=fixture; __Host-console_session=s')
    expect(credentials.secret('opencodeCookie')).toBe('auth=fixture; __Host-console_session=s')
    expect(credentials.clearSecret('opencodeGoApiKey').saved).toMatchObject({ opencodeGoApiKey: false, opencodeCookie: true })
    credentials.clearSecret('opencodeCookie')
    await expect(fs.stat(path.join(home, 'userData', 'provider-credentials', 'secrets.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('saves nothing without secure storage, and refuses unknown names and bad values', () => {
    const plain = store(false)
    const refused = plain.saveSecret('minimaxApiKey', 'fixture-key')
    expect(refused.ok).toBe(false)
    expect(refused.error).not.toContain('fixture-key')
    expect(plain.status()).toMatchObject({ secure: false, protection: null, saved: { minimaxApiKey: false } })
    const credentials = store()
    expect(credentials.saveSecret('claudeToken', 'x').ok).toBe(false)
    expect(credentials.saveSecret('minimaxApiKey', 'two words').ok).toBe(false)
    expect(cleanSecret('minimaxCookie', '_token=a; b=c')).toBe('_token=a; b=c')
    expect(cleanSecret('minimaxApiKey', 'line\nbreak')).toBe(null)
  })

  it('keeps plain options with Orca’s defaults and validates them', () => {
    const credentials = store()
    expect(credentials.settings()).toEqual({
      geminiCliOAuth: false,
      opencodeWorkspaceId: '',
      minimaxEndpoint: 'overseas',
      minimaxGroupId: '',
      minimaxUsageModels: 'general'
    })
    expect(credentials.update({ minimaxEndpoint: 'cn', opencodeWorkspaceId: ' wrk_abc123 ' }).settings).toMatchObject({
      minimaxEndpoint: 'cn',
      opencodeWorkspaceId: 'wrk_abc123'
    })
    expect(credentials.update({ minimaxEndpoint: 'mars' }).ok).toBe(false)
    expect(credentials.update({ opencodeWorkspaceId: '../etc' }).ok).toBe(false)
    expect(credentials.update({ secretsFile: 'x' }).ok).toBe(false)
    expect(store().settings().minimaxEndpoint).toBe('cn')
  })

  it('reports an unreadable store without losing it until a save or forget', async () => {
    const dir = path.join(home, 'userData', 'provider-credentials')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'secrets.json'), '{"v":1,"ciphertext":"!!"}')
    const credentials = store()
    expect(credentials.status().error).toBeTruthy()
    expect(credentials.secret('minimaxApiKey')).toBe(null)
    expect(credentials.clearSecret('minimaxApiKey').ok).toBe(true)
    expect(credentials.status().error).toBeUndefined()
  })
})

describe('Cursor and Grok sign-in status (read only)', () => {
  it('names the Cursor CLI user from cli-config.json and never returns a token', async () => {
    const raw = jwt('fixture|user')
    await write('roaming/Cursor/auth.json', { accessToken: raw })
    await write('.cursor/cli-config.json', { authInfo: { email: 'person@example.test', displayName: 'Person' } })
    const sources = createUsageProviderSources({ home, env, platform: 'win32', clock: () => now })
    const status = await sources.signIn('cursor')
    expect(status).toMatchObject({ signedIn: true, email: 'person@example.test', credentialSource: 'cli', tokenFresh: true })
    expect(JSON.stringify(status)).not.toContain(raw)
  })

  it('prefers a live Cursor IDE session over an expired CLI one', async () => {
    await write('roaming/Cursor/auth.json', { accessToken: jwt('fixture-user', now / 1000 - 10) })
    const file = path.join(home, 'roaming/Cursor/User/globalStorage/state.vscdb')
    await fs.mkdir(path.dirname(file), { recursive: true })
    const db = new DatabaseSync(file)
    db.exec('CREATE TABLE ItemTable (key TEXT, value TEXT)')
    const insert = db.prepare('INSERT INTO ItemTable VALUES (?,?)')
    insert.run('cursorAuth/accessToken', jwt())
    insert.run('cursorAuth/cachedEmail', 'ide@example.test')
    insert.run('cursorAuth/stripeMembershipType', 'pro')
    db.close()
    const sources = createUsageProviderSources({ home, env, platform: 'win32', clock: () => now })
    expect(await sources.signIn('cursor')).toMatchObject({
      signedIn: true,
      email: 'ide@example.test',
      planType: 'pro',
      credentialSource: 'desktop',
      tokenFresh: true
    })
  })

  it('reports an expired Cursor login, and no login', async () => {
    const sources = createUsageProviderSources({ home, env, platform: 'win32', clock: () => now })
    expect(await sources.signIn('cursor')).toMatchObject({ signedIn: false, error: null })
    await write('roaming/Cursor/auth.json', { accessToken: jwt('fixture-user', now / 1000 - 10) })
    expect(await sources.signIn('cursor')).toMatchObject({ signedIn: true, tokenFresh: false })
  })

  it('reads the Grok email and team from the preferred issuer', async () => {
    const sources = createUsageProviderSources({ home, env, platform: 'win32', clock: () => now })
    expect((await sources.signIn('grok')).signedIn).toBe(false)
    await write('.grok/auth.json', {
      'https://auth.x.ai': { key: 'fixture-grok', email: 'g@example.test', team_id: 'team-1', expires_at: new Date(now + 3600000).toISOString() }
    })
    const status = await sources.signIn('grok')
    expect(status).toMatchObject({ signedIn: true, email: 'g@example.test', teamId: 'team-1', tokenFresh: true })
    expect(JSON.stringify(status)).not.toContain('fixture-grok')
    await write('.grok/auth.json', {
      'https://auth.x.ai': { key: 'fixture-grok', expires_at: new Date(now + 60000).toISOString() }
    })
    expect((await sources.signIn('grok')).tokenFresh).toBe(false)
    await write('.grok/auth.json', 'not json')
    expect((await sources.signIn('grok')).error).toBeTruthy()
  })

  it('reads whether the Gemini CLI login is valid or refreshable, with its email only', async () => {
    const sources = createUsageProviderSources({ home, env, platform: 'win32', clock: () => now })
    expect(await sources.signIn('gemini')).toMatchObject({ signedIn: false, tokenFresh: false })
    const idToken = `h.${Buffer.from(JSON.stringify({ email: 'gem@example.test' })).toString('base64url')}.s`
    await write('.gemini/oauth_creds.json', { access_token: 'fixture-gem', refresh_token: 'fixture-gem-refresh', id_token: idToken, expiry_date: now + 3600000 })
    const status = await sources.signIn('gemini')
    expect(status).toMatchObject({ signedIn: true, email: 'gem@example.test', tokenFresh: true, refreshable: true })
    expect(JSON.stringify(status)).not.toMatch(/fixture-gem|h\./)
    await write('.gemini/oauth_creds.json', { access_token: 'fixture-gem', expiry_date: now - 1 })
    expect(await sources.signIn('gemini')).toMatchObject({ signedIn: true, email: null, tokenFresh: false, refreshable: false })
  })
})

describe('usage reads with saved credentials', () => {
  const fakeCredentials = (secrets = {}, settings = {}) => ({
    secret: (name) => secrets[name] || null,
    settings: () => ({ ...settings })
  })

  it('MiniMax: a saved key wins over the cookie, then the cookie with its group, on the chosen endpoint', async () => {
    let creds = fakeCredentials({ minimaxApiKey: 'fixture-key', minimaxCookie: '_token=t; minimax_group_id_v2=42' })
    let sources = createUsageProviderSources({ home, env, platform: 'win32', credentials: creds })
    expect(await sources.present('minimax')).toBe(true)
    let auth = await sources.auth('minimax')
    expect(auth).toMatchObject({ headers: { Authorization: 'Bearer fixture-key' }, endpoint: 'minimax', transport: 'api-key' })
    creds = fakeCredentials({ minimaxCookie: 'Cookie: _token=t; minimax_group_id_v2=42' }, { minimaxEndpoint: 'cn', minimaxUsageModels: 'pro, general' })
    sources = createUsageProviderSources({ home, env, platform: 'win32', credentials: creds })
    auth = await sources.auth('minimax')
    expect(auth.headers).toMatchObject({ Cookie: '_token=t; minimax_group_id_v2=42', 'X-Group-Id': '42' })
    expect(auth.headers.Referer).toContain('platform.minimaxi.com')
    expect(auth).toMatchObject({ endpoint: 'minimaxCn', models: ['pro', 'general'], transport: 'cookie' })
    sources = createUsageProviderSources({ home, env, platform: 'win32', credentials: fakeCredentials({ minimaxCookie: 'other=1' }) })
    await expect(sources.auth('minimax')).rejects.toMatchObject({ code: 'credentials' })
  })

  it('OpenCode Go: the Settings key overrides /connect; a cookie alone reads the console', async () => {
    await write('data/opencode/auth.json', { 'opencode-go': { type: 'api', key: 'fixture-file' } })
    let sources = createUsageProviderSources({ home, env, platform: 'win32', credentials: fakeCredentials({ opencodeGoApiKey: 'fixture-override' }) })
    expect((await sources.auth('opencode-go')).headers.Authorization).toBe('Bearer fixture-override')
    await fs.rm(path.join(home, 'data'), { recursive: true })
    sources = createUsageProviderSources({
      home,
      env,
      platform: 'win32',
      credentials: fakeCredentials({ opencodeCookie: 'auth=a; other=x; __Host-console_session=s' }, { opencodeWorkspaceId: 'wrk_1' })
    })
    expect(await sources.present('opencode-go')).toBe(true)
    const auth = await sources.auth('opencode-go')
    expect(auth.headers.Authorization).toBeUndefined()
    expect(auth.console).toEqual({ cookie: 'auth=a; __Host-console_session=s', workspaceId: 'wrk_1' })
    expect(openCodeCookie('Fe26.2**seal')).toBe('auth=Fe26.2**seal')
    expect(cookiePairs('a:"1"; b=2')).toEqual([{ name: 'b', value: '2' }, { name: 'a', value: '1' }])
  })

  it('Gemini: an expired login is refreshed in memory only when opted in', async () => {
    const file = await write('.gemini/oauth_creds.json', { access_token: 'fixture-old', refresh_token: 'fixture-refresh', expiry_date: now - 1 })
    const before = await fs.readFile(file, 'utf8')
    const refresh = vi.fn(async () => 'fixture-new')
    let sources = createUsageProviderSources({ home, env, platform: 'win32', clock: () => now, geminiRefresh: refresh, credentials: fakeCredentials() })
    await expect(sources.auth('gemini')).rejects.toMatchObject({ code: 'expired' })
    expect(refresh).not.toHaveBeenCalled()
    sources = createUsageProviderSources({
      home,
      env,
      platform: 'win32',
      clock: () => now,
      geminiRefresh: refresh,
      credentials: fakeCredentials({}, { geminiCliOAuth: true })
    })
    expect((await sources.auth('gemini')).headers.Authorization).toBe('Bearer fixture-new')
    expect(refresh).toHaveBeenCalledWith('fixture-refresh', expect.anything())
    expect(await fs.readFile(file, 'utf8')).toBe(before)
  })

  it('reads MiniMax China with the configured model, and OpenCode’s console with a cookie', async () => {
    const sources = {
      present: vi.fn(async () => true),
      auth: vi.fn(async (provider) =>
        provider === 'minimax'
          ? { headers: { Cookie: '_token=t' }, endpoint: 'minimaxCn', models: ['pro'], transport: 'cookie', fingerprint: 'm' }
          : { headers: { Accept: 'application/json' }, console: { cookie: 'auth=a', workspaceId: null }, fingerprint: 'o' }
      )
    }
    const seen = []
    const request = vi.fn(async (url, init) => {
      seen.push([url, init.headers])
      if (url === USAGE_URLS.minimaxCn)
        return new Response(
          JSON.stringify({
            base_resp: { status_code: 0 },
            model_remains: [
              { model_name: 'general', current_interval_remaining_percent: 90, start_time: now, end_time: now + 1 },
              { model_name: 'pro', current_interval_remaining_percent: 40, start_time: now, end_time: now + 1 }
            ]
          })
        )
      if (url === USAGE_URLS.opencodeWorkspaces) return new Response('[{id:"wrk_abc",name:"x"}]')
      if (url === USAGE_URLS.opencodeConsole)
        return new Response(
          JSON.stringify({
            access: { meters: { fiveHour: { usedMicroCents: 25, limitMicroCents: 100 }, week: { usedMicroCents: 50, limitMicroCents: 100 } } }
          })
        )
      return new Response('{}', { status: 404 })
    })
    const listAgents = async () => [{ id: 'opencode', available: true }]
    const usage = createExtraProviderUsage({ listAgents, sources, request, clock: () => now })
    const mini = await usage.read({ provider: 'minimax', accountId: null })
    expect(mini.ok).toBe(true)
    expect(mini.windows[0]).toMatchObject({ label: '5-hour', usedPct: 60 })
    const go = await usage.read({ provider: 'opencode-go', accountId: null })
    expect(go).toMatchObject({ ok: true, windows: [{ usedPct: 25 }, { usedPct: 50 }] })
    const status = seen.find(([url]) => url === USAGE_URLS.opencodeConsole)
    expect(status[1]).toMatchObject({ 'x-org-id': 'wrk_abc', Cookie: 'auth=a' })
    // Sub-requests are never providers of their own.
    expect((await usage.read({ provider: 'minimaxCn', accountId: null })).ok).toBe(false)
  })

  it('maps MiniMax models in order and the console meters', () => {
    const rows = {
      model_remains: [
        { model_name: 'a', current_interval_remaining_percent: 10, start_time: 1, end_time: 2 },
        { model_name: 'b', current_interval_remaining_percent: 70, start_time: 1, end_time: 2 }
      ]
    }
    expect(mapMiniMax(rows, now, ['b', 'a'])[0].usedPct).toBe(30)
    expect(mapMiniMax(rows, now, ['general'])).toEqual([])
    expect(mapOpenCodeConsole({ access: { meters: { fiveHour: { usedMicroCents: 1, limitMicroCents: 0 } } } })).toEqual([])
    expect(openCodeWorkspaceIds('{id:"wrk_1"},{id: \'wk_2\'},{id:"wrk_1"},{uid:"x"}')).toEqual(['wrk_1', 'wk_2'])
  })
})

describe('Gemini CLI OAuth client (opt-in)', () => {
  it('finds the client in an npm global install and refreshes once per token', async () => {
    const npm = path.join(home, 'npm')
    await write('npm/gemini.cmd', '@echo off')
    await write('npm/node_modules/@google/gemini-cli/package.json', { name: '@google/gemini-cli' })
    await write(
      'npm/node_modules/@google/gemini-cli/bundle/chunk-1.js',
      "const OAUTH_CLIENT_ID = 'fixture-client.apps.example'; const OAUTH_CLIENT_SECRET = 'fixture-secret';"
    )
    const client = await extractGeminiOAuthClient({ env: { PATH: npm }, home, platform: 'win32' })
    expect(client).toEqual({ clientId: 'fixture-client.apps.example', clientSecret: 'fixture-secret' })
    expect(await extractGeminiOAuthClient({ env: { PATH: path.join(home, 'none') }, home, platform: 'win32' })).toBe(null)

    const request = vi.fn(async () => new Response(JSON.stringify({ access_token: 'fixture-access', expires_in: 3600 })))
    const refresh = createGeminiRefresher({ request, extract: async () => client, clock: () => now })
    expect(await refresh('fixture-refresh')).toBe('fixture-access')
    expect(await refresh('fixture-refresh')).toBe('fixture-access')
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0][0]).toBe(GOOGLE_TOKEN_URL)
    const failing = createGeminiRefresher({ request: async () => new Response('{}', { status: 400 }), extract: async () => client })
    expect(await failing('fixture-refresh')).toBe(null)
  })
})

describe('provider settings IPC', () => {
  it('answers with sign-ins and saved flags only, and drops the provider’s old reading on a change', async () => {
    const { registerProviderUsage } = await import('../providerUsageIpc')
    const handlers = new Map()
    const poller = { read: vi.fn(), forget: vi.fn(), configure: vi.fn(), ingest: vi.fn() }
    const credentials = createProviderCredentials({ dir: path.join(home, 'store'), safeStorage: safeStorage() })
    await write('.grok/auth.json', { 'https://auth.x.ai': { key: 'fixture-grok', email: 'g@example.test' } })
    registerProviderUsage({
      ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
      accounts: {},
      service: { invalidate: vi.fn() },
      poller,
      credentials,
      usageSources: createUsageProviderSources({ home, env, platform: 'win32', clock: () => now, credentials })
    })
    const saved = await handlers.get('providerSettings:saveSecret')(null, { name: 'minimaxCookie', value: '_token=fixture-cookie' })
    expect(saved).toMatchObject({ ok: true, saved: { minimaxCookie: true } })
    expect(poller.forget).toHaveBeenCalledWith('minimax')
    const status = await handlers.get('providerSettings:status')(null)
    expect(status).toMatchObject({ ok: true, grok: { signedIn: true, email: 'g@example.test' }, cursor: { signedIn: false }, gemini: { signedIn: false } })
    expect(JSON.stringify(status)).not.toMatch(/fixture-(cookie|grok)/)
    await handlers.get('providerSettings:update')(null, { patch: { geminiCliOAuth: true } })
    expect(poller.forget).toHaveBeenCalledWith('gemini')
    const refused = await handlers.get('providerSettings:update')(null, { patch: { minimaxEndpoint: 'x' } })
    expect(refused.ok).toBe(false)
    expect(poller.forget).toHaveBeenCalledTimes(2)
  })
})
