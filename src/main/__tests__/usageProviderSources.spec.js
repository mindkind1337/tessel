// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createUsageProviderSources } from '../usageProviderSources'
const now = Date.parse('2026-09-28T12:00:00Z')
let home, env, sources
async function write(rel, value) {
  const file = path.join(home, rel)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value))
  return file
}
const jwt = (sub = 'fixture-user', exp = now / 1000 + 3600) =>
  `header.${Buffer.from(JSON.stringify({ sub, exp })).toString('base64url')}.fixture`
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'tessel-provider-fixture-'))
  env = { APPDATA: path.join(home, 'roaming'), XDG_DATA_HOME: path.join(home, 'data') }
  sources = createUsageProviderSources({ home, env, platform: 'win32', clock: () => now })
})
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})
describe('read-only provider logins in isolated homes', () => {
  it('detects file metadata without parsing or opening credentials', async () => {
    await write('.gemini/oauth_creds.json', 'not json')
    const s = createUsageProviderSources({
      home,
      env,
      readFile: () => {
        throw Error('must not read')
      }
    })
    expect(await s.present('gemini')).toBe(true)
    expect(await s.present('kimi')).toBe(false)
  })
  it('reads Gemini fresh each action and never modifies credentials', async () => {
    const file = await write('.gemini/oauth_creds.json', {
      access_token: 'fixture-A',
      expiry_date: now + 60000
    })
    const a = await sources.auth('gemini')
    expect(a.headers.Authorization).toBe('Bearer fixture-A')
    await write('.gemini/oauth_creds.json', { access_token: 'fixture-B', expiry_date: now + 60000 })
    const before = await fs.readFile(file, 'utf8'),
      b = await sources.auth('gemini')
    expect(b.fingerprint).not.toBe(a.fingerprint)
    expect(await fs.readFile(file, 'utf8')).toBe(before)
  })
  it.each(['gemini', 'kimi'])('leaves %s refresh to its CLI when expired', async (provider) => {
    const rel =
      provider === 'gemini' ? '.gemini/oauth_creds.json' : '.kimi-code/credentials/kimi-code.json'
    const file = await write(rel, {
      access_token: 'fixture-token',
      expiry_date: now - 1,
      expires_at: now / 1000 - 1
    })
    const before = await fs.readFile(file, 'utf8')
    await expect(sources.auth(provider)).rejects.toMatchObject({ code: 'expired' })
    expect(await fs.readFile(file, 'utf8')).toBe(before)
  })
  it('supports KIMI_CODE_HOME without copying its rotating token', async () => {
    env.KIMI_CODE_HOME = path.join(home, 'custom-kimi')
    sources = createUsageProviderSources({ home, env, clock: () => now })
    await write('custom-kimi/credentials/kimi-code.json', {
      access_token: 'fixture-kimi',
      expires_at: now / 1000 + 60
    })
    expect((await sources.auth('kimi')).headers.Authorization).toBe('Bearer fixture-kimi')
  })
  it('uses preferred Grok issuer and does not fall back to an unrelated fresh login', async () => {
    await write('.grok/auth.json', {
      'https://auth.x.ai': { key: 'fixture-old', expires_at: new Date(now - 1000).toISOString() },
      'https://other.invalid': { key: 'fixture-new' }
    })
    await expect(sources.auth('grok')).rejects.toMatchObject({ code: 'expired' })
    await write('.grok/auth.json', {
      'https://auth.x.ai::personal': { key: 'fixture-good', user_id: 'fixture-user' }
    })
    expect((await sources.auth('grok')).headers).toMatchObject({
      Authorization: 'Bearer fixture-good',
      'X-XAI-Token-Auth': 'xai-grok-cli',
      'x-userid': 'fixture-user'
    })
  })
  it('uses a Cursor CLI JWT as a dashboard cookie', async () => {
    const raw = jwt('fixture|user')
    await write('roaming/Cursor/auth.json', { accessToken: raw })
    expect((await sources.auth('cursor')).headers.Cookie).toBe(
      `WorkosCursorSessionToken=fixture%7Cuser%3A%3A${raw}`
    )
  })
  it('reads Cursor desktop SQLite when CLI login is missing', async () => {
    const file = path.join(home, 'roaming/Cursor/User/globalStorage/state.vscdb')
    await fs.mkdir(path.dirname(file), { recursive: true })
    const db = new DatabaseSync(file)
    db.exec('CREATE TABLE ItemTable (key TEXT, value TEXT)')
    db.prepare('INSERT INTO ItemTable VALUES (?,?)').run('cursorAuth/accessToken', jwt())
    db.close()
    expect((await sources.auth('cursor')).headers.Cookie).toContain(jwt())
  })
  it('finds a versioned OpenCode credential database and queries only Go rows', async () => {
    const file = path.join(home, 'data/opencode/opencode-preview.db')
    await fs.mkdir(path.dirname(file), { recursive: true })
    const db = new DatabaseSync(file)
    db.exec(
      'CREATE TABLE credential (integration_id TEXT, value TEXT, active INTEGER, time_created INTEGER)'
    )
    db.prepare('INSERT INTO credential VALUES (?,?,?,?)').run(
      'opencode-go',
      JSON.stringify({ type: 'key', key: 'fixture-go' }),
      1,
      1
    )
    db.close()
    expect(await sources.present('opencode-go')).toBe(true)
    expect((await sources.auth('opencode-go')).headers.Authorization).toBe('Bearer fixture-go')
  })
  it('prefers the Go file and rereads environment fallback without storing it', async () => {
    env.OPENCODE_API_KEY = 'fixture-env'
    expect((await sources.auth('opencode-go')).headers.Authorization).toBe('Bearer fixture-env')
    await write('data/opencode/auth.json', { 'opencode-go': { type: 'api', key: 'fixture-file' } })
    expect((await sources.auth('opencode-go')).headers.Authorization).toBe('Bearer fixture-file')
    env.MINIMAX_API_KEY = 'fixture-mini'
    expect(await sources.present('minimax')).toBe(true)
    expect((await sources.auth('minimax')).headers.Authorization).toBe('Bearer fixture-mini')
  })
  it('refuses hardlinked credentials and junction ancestors', async () => {
    const target = await write('outside/oauth_creds.json', {
      access_token: 'fixture-outside',
      expiry_date: now + 60000
    })
    await fs.mkdir(path.join(home, '.gemini'))
    await fs.link(target, path.join(home, '.gemini/oauth_creds.json'))
    await expect(sources.auth('gemini')).rejects.toMatchObject({ code: 'credentials' })
    await fs.unlink(path.join(home, '.gemini/oauth_creds.json'))
    await fs.rmdir(path.join(home, '.gemini'))
    await fs.symlink(
      path.join(home, 'outside'),
      path.join(home, '.gemini'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    await expect(sources.auth('gemini')).rejects.toMatchObject({ code: 'credentials' })
  })
  it('refuses oversized or malformed files without reflecting content', async () => {
    for (const value of ['fixture-secret', 'x'.repeat(1024 * 1024 + 1)]) {
      await write('.gemini/oauth_creds.json', value)
      try {
        await sources.auth('gemini')
        throw Error('expected rejection')
      } catch (error) {
        expect(error.code).toBe('credentials')
        expect(error.message).not.toContain('fixture-secret')
      }
    }
  })
})

describe('ZCode Coding Plan login', () => {
  const config = (model, baseURL, apiKey = 'fixture-zai') => ({
    model,
    provider: {
      zai: { options: { apiKey, baseURL } },
      other: { options: { apiKey: 'fixture-other', baseURL: 'https://api.z.ai/api/coding/paas/v4' } }
    }
  })
  it("uses only the selected model's provider key, on Z.ai's or BigModel's https hosts", async () => {
    expect(await sources.present('zcode')).toBe(false)
    await write('.zcode/cli/config.json', config('zai/glm-5', 'https://api.z.ai/api/coding/paas/v4'))
    expect(await sources.present('zcode')).toBe(true)
    const login = await sources.auth('zcode')
    expect(login.headers.Authorization).toBe('fixture-zai')
    expect(login.endpoint).toBe('zcode')
    await write('.zcode/cli/config.json', config({ main: 'zai/glm-5' }, 'https://open.bigmodel.cn/api/coding/paas/v4'))
    expect((await sources.auth('zcode')).endpoint).toBe('zcodeCn')
    for (const bad of [
      config('glm-5', 'https://api.z.ai/x'),
      config('zai/glm-5', 'http://api.z.ai/x'),
      config('zai/glm-5', 'https://api.z.ai.evil.example/x'),
      config('zai/glm-5', 'https://api.z.ai:8443/x'),
      config('zai/glm-5', 'https://api.z.ai/x', 'two\nlines')
    ]) {
      await write('.zcode/cli/config.json', bad)
      await expect(sources.auth('zcode')).rejects.toMatchObject({ code: 'unavailable' })
    }
  })
})
