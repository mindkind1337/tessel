// @vitest-environment node
// Muse Code's subscription usage: the key call Muse makes at every start
// (POST https://api.meta.ai/muse-code/key with its stored Meta login), whose
// answer names the plan and carries its 5-hour and weekly windows. Shaped
// like the real answer of Muse Code 1.4.10; a fake home and a fake network.
import { describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { mapMuse } from '../usageProviderMapping'
import { createUsageProviderSources } from '../usageProviderSources'
import { createExtraProviderUsage, USAGE_URLS } from '../extraProviderUsage'
import { museAuthFile } from '../museSessions'

const NOW = 1792405000000
// What the key call answers (its key fields are never read).
const ANSWER = {
  api_key: 'mk-SECRET-never-kept-0123456789abcdef0123456789',
  base_url: 'https://api.meta.ai/v1',
  has_payment_method: false,
  require_payment: false,
  is_subs_active: true,
  can_subscribe: false,
  show_subs_upsell: true,
  user_full_name: 'Jane Doe',
  user_email: 'jane@example.com',
  user_avatar_url: null,
  payment_method: null,
  action_url: null,
  subs_tier_id: '27681527378179523',
  subs_tier_name: 'Muse Code High Usage',
  is_subs_upgrade_available: false,
  subs_usage: { window: { used_percent: 16, window_duration_mins: 300, resets_at: 1792422801 }, weekly: { used_percent: 5, resets_at: 1792972800 }, tier: '27681527378179523' }
}
const auth = (meta) => ({ schema_version: 1, providers: { meta } })
const LOGIN = { access_token: 'meta-access-token-A', obtained_via: 'device_code', mechanism: 'oauth', api_key: 'mk-stored', api_base_url: 'https://api.meta.ai/v1', subs_active: true, user_full_name: 'Jane Doe', user_email: 'jane@example.com' }

function home(meta) {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-muse-usage-'))
  if (meta !== undefined) {
    fs.mkdirSync(join(dir, '.config', 'muse'), { recursive: true })
    fs.writeFileSync(museAuthFile(dir, {}), JSON.stringify(auth(meta)))
  }
  return dir
}
function service(dir, respond = () => new Response(JSON.stringify(ANSWER))) {
  const sources = createUsageProviderSources({ home: dir, env: {}, clock: () => NOW })
  const request = vi.fn(async (url, init) => respond(url, init))
  const usage = createExtraProviderUsage({
    sources,
    request,
    clock: () => NOW,
    listAgents: async () => [{ id: 'muse', available: true }],
    antigravityCli: { present: () => false, read: async () => ({ ok: false }) },
    antigravityPlan: { read: () => null }
  })
  return { usage, request, sources }
}

describe('Muse Code usage: its key call', () => {
  it('maps the 5-hour and weekly windows (resets in seconds) and the plan name', () => {
    expect(mapMuse(ANSWER)).toEqual({
      windows: [
        { label: '5-hour', usedPct: 16, resetsAt: 1792422801000 },
        { label: 'Weekly', usedPct: 5, resetsAt: 1792972800000 }
      ],
      plan: 'Muse Code High Usage',
      subscribed: true
    })
    expect(mapMuse({ subs_usage: { window: { used_percent: 140, window_duration_mins: 240, resets_at: 1 } } }).windows[0]).toMatchObject({ label: '4-hour', usedPct: 100 })
    expect(mapMuse(null)).toEqual({ windows: [], plan: null, subscribed: false })
  })

  it('POSTs {} with the stored login and x-api-version; shows windows and plan, never the key', async () => {
    const dir = home(LOGIN)
    try {
      const { usage, request } = service(dir)
      expect((await usage.capabilities()).providers.find((p) => p.id === 'muse')).toMatchObject({ quota: true })
      const res = await usage.read({ provider: 'muse', accountId: null })
      expect(res).toMatchObject({ ok: true, provider: 'muse', plan: 'Muse Code High Usage', windows: [{ label: '5-hour', usedPct: 16 }, { label: 'Weekly', usedPct: 5 }] })
      expect(JSON.stringify(res)).not.toContain('SECRET')
      const [url, init] = request.mock.calls[0]
      expect(url).toBe(USAGE_URLS.muse)
      expect(url).toBe('https://api.meta.ai/muse-code/key')
      expect(init.method).toBe('POST')
      expect(init.body).toBe('{}')
      expect(init.redirect).toBe('error')
      expect(init.headers).toMatchObject({ Authorization: 'Bearer meta-access-token-A', 'x-api-version': '1.0.0' })
      // Settings: who signed in, and the plan the call named for this login.
      const s = await usage.signIn('muse')
      expect(s).toMatchObject({ signedIn: true, email: 'jane@example.com', displayName: 'Jane Doe', planType: 'Muse Code High Usage', subscribed: true })
      expect(JSON.stringify(s)).not.toMatch(/meta-access-token|mk-/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('another sign-in never shows the previous plan', async () => {
    const dir = home(LOGIN)
    try {
      const { usage } = service(dir)
      await usage.read({ provider: 'muse', accountId: null })
      fs.writeFileSync(museAuthFile(dir, {}), JSON.stringify(auth({ ...LOGIN, access_token: 'meta-access-token-B', user_email: 'other@example.com', subs_active: false })))
      const s = await usage.signIn('muse')
      expect(s).toMatchObject({ signedIn: true, email: 'other@example.com', planType: null, subscribed: false })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('an inactive subscription is kept as the plan (Settings says "No subscription"); a refused sign-in forgets it', async () => {
    const dir = home(LOGIN)
    try {
      let answer = () => new Response(JSON.stringify(ANSWER))
      const { usage } = service(dir, () => answer())
      await usage.read({ provider: 'muse', accountId: null })
      expect(await usage.signIn('muse')).toMatchObject({ planType: 'Muse Code High Usage', subscribed: true })
      answer = () => new Response(JSON.stringify({ ...ANSWER, is_subs_active: false, subs_tier_name: null, subs_usage: null }))
      expect(await usage.read({ provider: 'muse', accountId: null })).toMatchObject({ ok: false, code: 'unavailable' })
      expect(await usage.signIn('muse')).toMatchObject({ planType: null, subscribed: false })
      answer = () => new Response(JSON.stringify(ANSWER))
      await usage.read({ provider: 'muse', accountId: null })
      answer = () => new Response('{}', { status: 401 })
      expect(await usage.read({ provider: 'muse', accountId: null })).toMatchObject({ ok: false, code: 'expired' })
      const s = await usage.signIn('muse')
      expect(s.planType).toBe(null)
      expect(s.plan).toBeUndefined()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('says why there is nothing: signed out, API key, expired login, no subscription', async () => {
    const out = home(undefined)
    const key = home({ api_key: 'mk-only', mechanism: 'api_key' })
    const ok = home(LOGIN)
    try {
      expect(await service(out).usage.read({ provider: 'muse', accountId: null })).toMatchObject({ ok: false, code: 'unavailable', error: expect.stringMatching(/\/login/) })
      expect(await service(key).usage.read({ provider: 'muse', accountId: null })).toMatchObject({ ok: false, code: 'unsupported', error: expect.stringMatching(/API key/) })
      expect(await service(key).usage.signIn('muse')).toMatchObject({ signedIn: true, credentialSource: 'api-key', plan: { kind: 'api-key' } })
      const expired = await service(ok, () => new Response('{"title":"Unauthorized"}', { status: 401 })).usage.read({ provider: 'muse', accountId: null })
      expect(expired).toMatchObject({ ok: false, code: 'expired', error: expect.stringMatching(/Run muse/) })
      const none = await service(ok, () => new Response(JSON.stringify({ ...ANSWER, is_subs_active: false, subs_tier_name: null, subs_usage: null }))).usage.read({ provider: 'muse', accountId: null })
      expect(none).toMatchObject({ ok: false, code: 'unavailable', error: expect.stringMatching(/no active Muse Code subscription/) })
    } finally {
      for (const d of [out, key, ok]) fs.rmSync(d, { recursive: true, force: true })
    }
  })
})
