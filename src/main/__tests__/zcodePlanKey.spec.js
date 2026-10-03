// @vitest-environment node
// A standalone GLM Coding Plan key (Settings > AI provider accounts): saved
// only encrypted, never returned to the window or put in an error, sent only
// over https to the official Z.ai / BigModel quota hosts, and read before
// ZCode CLI's own key. Fake keys and a fake safeStorage only.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createProviderCredentials } from '../providerCredentials'
import { createUsageProviderSources, ProviderReadError } from '../usageProviderSources'
import { createExtraProviderUsage, USAGE_URLS } from '../extraProviderUsage'

const now = Date.parse('2026-09-28T12:00:00Z')
const KEY = 'fixture-glm-plan-key.0123456789'
let home, env
const safeStorage = (available = true, backend = 'dpapi') => ({
  isEncryptionAvailable: () => available,
  getSelectedStorageBackend: () => backend,
  encryptString: (text) => Buffer.from('enc:' + Buffer.from(text).toString('hex')),
  decryptString: (buf) => Buffer.from(buf.toString().slice(4), 'hex').toString()
})
const storeDir = () => path.join(home, 'userData', 'provider-credentials')
const store = (...args) => createProviderCredentials({ dir: storeDir(), safeStorage: safeStorage(...args) })
async function write(rel, value) {
  const file = path.join(home, rel)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value))
  return file
}
const zcodeConfig = (apiKey = 'fixture-zcode-cli-key') => ({
  model: 'zai/glm-5',
  provider: { zai: { options: { apiKey, baseURL: 'https://api.z.ai/api/coding/paas/v4' } } }
})
const quota = {
  success: true,
  code: 200,
  data: {
    limits: [
      { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 40, nextResetTime: now + 3600000 },
      { type: 'TIME_LIMIT', unit: 5, number: 1, percentage: 10 }
    ]
  }
}
const sourcesFor = (credentials) =>
  createUsageProviderSources({ home, env, platform: 'win32', clock: () => now, credentials })
function usage(credentials, { agents = ['claude'], respond } = {}) {
  const request = vi.fn(respond || (async () => new Response(JSON.stringify(quota))))
  const service = createExtraProviderUsage({
    listAgents: async () => agents.map((id) => ({ id, available: true })),
    sources: sourcesFor(credentials),
    request,
    clock: () => now
  })
  return { service, request }
}

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'tessel-glm-plan-'))
  env = { APPDATA: path.join(home, 'roaming'), PATH: '' }
})
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('GLM Coding Plan key storage', () => {
  it('is saved only encrypted, and the window learns only that it is saved', async () => {
    const credentials = store()
    const result = credentials.saveSecret('zcodePlanApiKey', `  ${KEY}  `)
    expect(result).toMatchObject({ ok: true, secure: true, protection: 'sealed', saved: { zcodePlanApiKey: true } })
    expect(JSON.stringify(result)).not.toContain(KEY)
    const raw = await fs.readFile(path.join(storeDir(), 'secrets.json'), 'utf8')
    expect(raw).not.toContain(KEY)
    expect(store().secret('zcodePlanApiKey')).toBe(KEY)
    expect(JSON.stringify(store().status())).not.toContain(KEY)
  })

  it.each([
    [false, 'dpapi'],
    [true, 'basic_text']
  ])('refuses to store it without OS encryption (available %s, backend %s)', async (available, backend) => {
    const credentials = store(available, backend)
    const refused = credentials.saveSecret('zcodePlanApiKey', KEY)
    expect(refused.ok).toBe(false)
    expect(refused.error).toMatch(/Secure credential storage is unavailable/)
    expect(refused.error).not.toContain(KEY)
    await expect(fs.stat(path.join(storeDir(), 'secrets.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(credentials.status()).toMatchObject({ secure: false, saved: { zcodePlanApiKey: false } })
  })

  it('replaces and removes the key, and accepts only the two official sites', () => {
    const credentials = store()
    credentials.saveSecret('zcodePlanApiKey', KEY)
    credentials.saveSecret('zcodePlanApiKey', 'fixture-replacement-key')
    expect(credentials.secret('zcodePlanApiKey')).toBe('fixture-replacement-key')
    expect(credentials.saveSecret('zcodePlanApiKey', 'two words').ok).toBe(false)
    expect(credentials.saveSecret('zcodePlanApiKey', 'line\nbreak').ok).toBe(false)
    expect(credentials.clearSecret('zcodePlanApiKey').saved.zcodePlanApiKey).toBe(false)
    expect(credentials.secret('zcodePlanApiKey')).toBe(null)
    expect(credentials.settings().zcodePlanSite).toBe('zai')
    expect(credentials.update({ zcodePlanSite: 'bigmodel' })).toMatchObject({ ok: true, settings: { zcodePlanSite: 'bigmodel' } })
    for (const site of ['evil.example', 'https://api.z.ai.evil.example', 'dev', ''])
      expect(credentials.update({ zcodePlanSite: site }).ok).toBe(false)
    expect(credentials.settings().zcodePlanSite).toBe('bigmodel')
  })
})

describe('GLM Coding Plan quota', () => {
  it('links the plan without ZCode installed, named after the plan', async () => {
    const credentials = store()
    const before = usage(credentials)
    expect((await before.service.capabilities()).providers.some((p) => p.id === 'zcode')).toBe(false)
    expect(await before.service.read({ provider: 'zcode', accountId: null })).toMatchObject({ ok: false, code: 'unavailable' })
    expect(before.request).not.toHaveBeenCalled()
    credentials.saveSecret('zcodePlanApiKey', KEY)
    const { service, request } = usage(credentials)
    const zcode = (await service.capabilities()).providers.find((p) => p.id === 'zcode')
    expect(zcode).toMatchObject({ quota: true, name: 'GLM Coding Plan' })
    const result = await service.read({ provider: 'zcode', accountId: null })
    expect(result).toMatchObject({ ok: true, provider: 'zcode' })
    expect(result.windows.map((w) => w.label)).toEqual(['5-hour', 'Monthly'])
    expect(JSON.stringify(result)).not.toContain(KEY)
    // Z.ai takes the key itself; only over https, to the official host, no redirects.
    for (const [url, init] of request.mock.calls) {
      expect(url).toBe(USAGE_URLS.zcode)
      expect(new URL(url).protocol).toBe('https:')
      expect(new URL(url).hostname).toBe('api.z.ai')
      expect(init.redirect).toBe('error')
      expect(init.headers.Authorization).toBe(KEY)
    }
  })

  it('uses the BigModel host for a BigModel plan, and only the allowed hosts', async () => {
    const credentials = store()
    credentials.saveSecret('zcodePlanApiKey', KEY)
    credentials.update({ zcodePlanSite: 'bigmodel' })
    const { service, request } = usage(credentials)
    expect(await service.read({ provider: 'zcode', accountId: null })).toMatchObject({ ok: true })
    expect(request.mock.calls.map(([url]) => url)).toEqual([USAGE_URLS.zcodeCn])
    expect(new URL(USAGE_URLS.zcodeCn).hostname).toBe('open.bigmodel.cn')
    const hosts = ['zcode', 'zcodeCn', 'zcodeDev'].map((k) => new URL(USAGE_URLS[k]))
    expect(hosts.every((u) => u.protocol === 'https:' && u.port === '')).toBe(true)
    expect(hosts.map((u) => u.hostname)).toEqual(['api.z.ai', 'open.bigmodel.cn', 'dev.bigmodel.cn'])
  })

  it("is read before ZCode CLI's own key, which is used again once it is removed", async () => {
    await write('.zcode/cli/config.json', zcodeConfig())
    const credentials = store()
    credentials.saveSecret('zcodePlanApiKey', KEY)
    const sources = sourcesFor(credentials)
    expect((await sources.auth('zcode')).headers.Authorization).toBe(KEY)
    credentials.clearSecret('zcodePlanApiKey')
    expect((await sources.auth('zcode')).headers.Authorization).toBe('fixture-zcode-cli-key')
  })

  it('refuses a redirect and never puts the key in an error', async () => {
    const credentials = store()
    credentials.saveSecret('zcodePlanApiKey', KEY)
    const redirected = usage(credentials, {
      respond: async () => new Response('', { status: 302, headers: { Location: `https://evil.example/?k=${KEY}` } })
    })
    const refused = await redirected.service.read({ provider: 'zcode', accountId: null })
    expect(refused).toMatchObject({ ok: false, code: 'redirect' })
    expect(JSON.stringify(refused)).not.toContain(KEY)
    const thrown = usage(credentials, {
      respond: async () => {
        throw new Error(`connect failed with Authorization: ${KEY}`)
      }
    })
    const failed = await thrown.service.read({ provider: 'zcode', accountId: null })
    expect(failed).toMatchObject({ ok: false, code: 'network' })
    expect(JSON.stringify(failed)).not.toContain(KEY)
    const body = usage(credentials, {
      respond: async () => new Response(JSON.stringify({ success: false, msg: `bad key ${KEY}` }))
    })
    const unread = await body.service.read({ provider: 'zcode', accountId: null })
    expect(unread.ok).toBe(false)
    expect(JSON.stringify(unread)).not.toContain(KEY)
  })

  it('redacts the key even from a message that would carry it', async () => {
    const sources = {
      present: async () => true,
      linked: async () => ['zcode'],
      auth: async () => ({ headers: { Authorization: KEY }, endpoint: 'zcode', fingerprint: 'one' })
    }
    const service = createExtraProviderUsage({
      listAgents: async () => [],
      sources,
      request: async () => {
        throw new ProviderReadError('response', `Unexpected answer for ${KEY}`)
      },
      clock: () => now
    })
    const result = await service.read({ provider: 'zcode', accountId: null })
    expect(result.error).toBe('Unexpected answer for [redacted]')
  })

  it('crosses IPC with only "saved", and drops the old ZCode reading on a change', async () => {
    const { registerProviderUsage } = await import('../providerUsageIpc')
    const handlers = new Map()
    const poller = { read: vi.fn(), forget: vi.fn(), configure: vi.fn(), ingest: vi.fn() }
    const credentials = store()
    registerProviderUsage({
      ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
      accounts: {},
      service: { invalidate: vi.fn() },
      poller,
      credentials,
      usageSources: sourcesFor(credentials)
    })
    const saved = await handlers.get('providerSettings:saveSecret')(null, { name: 'zcodePlanApiKey', value: KEY })
    expect(saved).toMatchObject({ ok: true, saved: { zcodePlanApiKey: true } })
    expect(JSON.stringify(saved)).not.toContain(KEY)
    expect(poller.forget).toHaveBeenCalledWith('zcode')
    const status = await handlers.get('providerSettings:status')(null)
    expect(status.saved.zcodePlanApiKey).toBe(true)
    expect(JSON.stringify(status)).not.toContain(KEY)
    await handlers.get('providerSettings:update')(null, { patch: { zcodePlanSite: 'bigmodel' } })
    expect(poller.forget).toHaveBeenCalledTimes(2)
    const cleared = await handlers.get('providerSettings:clearSecret')(null, { name: 'zcodePlanApiKey' })
    expect(cleared.saved.zcodePlanApiKey).toBe(false)
    expect(poller.forget).toHaveBeenCalledTimes(3)
  })
})
