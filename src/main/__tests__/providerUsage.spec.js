// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createProviderUsage } from '../providerUsage'

const urls = {
  codex: 'https://chatgpt.com/backend-api/wham/usage',
  credits: 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits',
  consume: 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume',
  claude: 'https://api.anthropic.com/api/oauth/usage'
}
const epoch = Date.parse('2026-09-28T18:00:00Z')
const creditData = {
  available_count: 2,
  credits: [{ status: 'available', expires_at: '2026-09-30T18:00:00Z' }]
}
const codexData = {
  plan_type: 'pro',
  rate_limit: {
    primary_window: {
      used_percent: 42,
      limit_window_seconds: 18000,
      reset_at: epoch / 1000 + 3600
    },
    secondary_window: {
      used_percent: 87,
      limit_window_seconds: 604800,
      reset_at: epoch / 1000 + 86400
    }
  },
  rate_limit_reset_credits: creditData
}
const claudeData = {
  five_hour: { utilization: 12, resets_at: '2026-09-28T23:00:00Z' },
  seven_day: { used_percentage: 35, resets_at: epoch / 1000 + 86400 }
}
const reply = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
const deferred = () => {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { resolve, promise }
}
function fixture(options = {}) {
  const home = path.join(os.tmpdir(), 'provider-usage-fixture-never-read')
  const state = {
    selected: { codex: null, claude: null },
    time: epoch,
    codexAuth: { tokens: { access_token: 'fixture-codex-token', account_id: 'fixture-account' } },
    claudeAuth: { claudeAiOauth: { accessToken: 'fixture-claude-token' } },
    oauth: {
      accountUuid: 'claude-account',
      emailAddress: 'fixture@example.invalid',
      organizationUuid: 'org-one'
    }
  }
  const expectedIdentity = {
    account: 'claude-account',
    email: 'fixture@example.invalid',
    organization: 'org-one'
  }
  const accounts = {
    list: vi.fn(async () => ({
      ok: true,
      providers: ['codex', 'claude'].map((provider) => ({
        provider,
        selectedId: state.selected[provider],
        system: { id: null, status: 'ready' },
        accounts: [
          { id: 'managed-a', status: 'ready', plan: 'pro' },
          { id: 'managed-b', status: 'ready' }
        ]
      })),
      jobs: []
    })),
    usageScope: vi.fn(async (provider, accountId) => ({
      ok: true,
      accountId,
      env: {},
      expectedIdentity: provider === 'claude' && accountId ? expectedIdentity : null
    })),
    launchEnv: vi.fn(() => {
      throw new Error('Must never mutate auth')
    })
  }
  const readFile = vi.fn(async (file) => {
    if (path.basename(file) === 'auth.json') return JSON.stringify(state.codexAuth)
    if (path.basename(file) === '.credentials.json') return JSON.stringify(state.claudeAuth)
    if (path.basename(file) === '.claude.json') return JSON.stringify({ oauthAccount: state.oauth })
    throw new Error('Unexpected fixture path')
  })
  const request = vi.fn(async (url) =>
    reply(
      url === urls.codex
        ? codexData
        : url === urls.claude
          ? claudeData
          : url === urls.credits
            ? creditData
            : { code: 'reset' }
    )
  )
  const service = createProviderUsage({
    accounts,
    home,
    env: {},
    request,
    readFile,
    clock: () => state.time,
    ...options
  })
  return { service, state, accounts, readFile, request, home, expectedIdentity }
}
const selection = { provider: 'codex', accountId: null }

describe('reset history and provider credit records', () => {
  it.each(['reset', 'nothing_to_reset', 'no_credit', 'already_redeemed'])(
    'records %s once per redemption, before/after observations and no credentials',
    async (code) => {
      const records = new Map()
      const history = { record: vi.fn((row) => records.set(row.id, row)) }
      const { service, request } = fixture({ history })
      const args = await resetArgs(service)
      let consumed = false
      request.mockImplementation(async (url) => {
        if (url === urls.consume) {
          expect([...records.values()][0].outcome).toBe('pending')
          consumed = true
          return reply({ code })
        }
        return reply({ ...creditData, available_count: consumed ? 1 : 2 })
      })
      const [a, b] = await Promise.all([service.redeemReset(args), service.redeemReset(args)])
      expect(a).toEqual(b)
      expect(a.ok).toBe(true)
      expect(request.mock.calls.filter(([url]) => url === urls.consume)).toHaveLength(1)
      expect(history.record).toHaveBeenCalledTimes(2)
      expect([...records.values()]).toHaveLength(1)
      expect([...records.values()][0]).toMatchObject({
        outcome: code,
        creditsBefore: 2,
        creditsAfter: 1,
        accountId: null,
        accountLabel: 'System default',
        windows: [{ label: '5-hour' }, { label: 'Weekly' }]
      })
      expect(JSON.stringify([...records.values()])).not.toMatch(
        /fixture-codex-token|Authorization|resetToken|fingerprint/
      )
    }
  )
  it('refuses a reset when the write-ahead entry cannot be saved', async () => {
    const history = {
      record: vi.fn(() => {
        throw new Error('disk')
      })
    }
    const { service, request } = fixture({ history })
    const args = await resetArgs(service)
    const result = await service.redeemReset(args)
    expect(result).toMatchObject({ ok: false, code: 'history' })
    expect(request.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(0)
  })
  it('preserves uncertainty after a lost POST response, without retrying or assuming a credit decrement', async () => {
    const history = { record: vi.fn() }
    const { service, request } = fixture({ history })
    const args = await resetArgs(service)
    request.mockImplementation(async (url) => {
      if (url === urls.consume) throw new Error('secret request header')
      return reply(creditData)
    })
    expect(await service.redeemReset(args)).toMatchObject({ ok: false, uncertain: true })
    expect(history.record.mock.calls.at(-1)[0]).toMatchObject({
      outcome: 'error',
      uncertain: true,
      creditsAfter: null
    })
    expect(JSON.stringify(history.record.mock.calls)).not.toContain('secret')
  })
  it('does not turn a confirmed reset into failure when the after-reading is unavailable', async () => {
    const history = { record: vi.fn() }
    const { service, request } = fixture({ history })
    const args = await resetArgs(service)
    let consumed = false
    request.mockImplementation(async (url) => {
      if (url === urls.consume) {
        consumed = true
        return reply({ code: 'reset' })
      }
      if (consumed) throw new Error('offline')
      return reply(creditData)
    })
    expect(await service.redeemReset(args)).toMatchObject({ ok: true, outcome: 'reset' })
    expect(history.record.mock.calls.at(-1)[0]).toMatchObject({
      outcome: 'reset',
      creditsAfter: null
    })
  })
  it('returns only bounded provider credit fields on explicit request, with no invented redemption date', async () => {
    const { service, request, readFile } = fixture()
    expect(readFile).not.toHaveBeenCalled()
    request.mockResolvedValue(
      reply({
        credits: [
          {
            status: 'consumed',
            granted_at: '2026-09-20T12:00:00Z',
            expires_at: '2026-10-20T12:00:00Z',
            token: 'secret'
          },
          { status: 'secret-status' }
        ]
      })
    )
    const result = await service.creditHistory(selection)
    expect(result).toMatchObject({
      ok: true,
      provider: 'codex',
      accountId: null,
      available: true,
      entries: [{ status: 'consumed' }, { status: 'unknown' }]
    })
    expect(Object.keys(result.entries[0])).toEqual(['status', 'grantedAt', 'expiresAt'])
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0][0]).toBe(urls.credits)
  })
  it('rejects credit records when the account changes during the GET', async () => {
    const { service, request, state } = fixture()
    request.mockImplementation(async () => {
      state.selected.codex = 'managed-a'
      return reply(creditData)
    })
    expect(await service.creditHistory(selection)).toMatchObject({ ok: false, code: 'stale' })
  })
})
async function resetArgs(service, query = selection) {
  const read = await service.read(query)
  expect(read.ok).toBe(true)
  expect(read.resetToken).toMatch(/^[a-f0-9]{48}$/)
  return { ...query, resetToken: read.resetToken, confirmed: true }
}

describe('on-demand provider usage', () => {
  it('does nothing at construction and reads only the fixed Codex endpoint at invocation', async () => {
    const { service, request, readFile, accounts } = fixture()
    expect(request).not.toHaveBeenCalled()
    expect(readFile).not.toHaveBeenCalled()
    const result = await service.read(selection)
    expect(result).toMatchObject({
      ok: true,
      provider: 'codex',
      accountId: null,
      source: 'live',
      observedAt: epoch,
      plan: 'pro',
      windows: [
        { label: '5-hour', usedPct: 42, resetsAt: epoch + 3600000 },
        { label: 'Weekly', usedPct: 87, resetsAt: epoch + 86400000 }
      ],
      resetCredits: { availableCount: 2, eligible: true }
    })
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0]).toEqual([
      urls.codex,
      expect.objectContaining({
        method: 'GET',
        redirect: 'error',
        headers: expect.objectContaining({
          Authorization: 'Bearer fixture-codex-token',
          'ChatGPT-Account-Id': 'fixture-account',
          'OpenAI-Beta': 'codex-1'
        })
      })
    ])
    expect(accounts.launchEnv).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toMatch(
      /fixture-codex-token|fixture-account|auth\.json|Authorization|fingerprint/
    )
  })
  it('maps a weekly primary window by duration and does not invent a 5-hour window', async () => {
    const { service, request } = fixture()
    request.mockResolvedValue(
      reply({
        plan_type: 'plus',
        rate_limit: { primary_window: codexData.rate_limit.secondary_window },
        rate_limit_reset_credits: { available_count: 0 }
      })
    )
    expect(await service.read(selection)).toMatchObject({
      ok: true,
      windows: [{ label: 'Weekly', usedPct: 87 }],
      resetCredits: { eligible: false }
    })
  })
  it('maps Claude windows without exposing a reset action', async () => {
    const { service, request } = fixture()
    request.mockResolvedValue(
      reply({
        ...claudeData,
        seven_day_sonnet: { utilization: 56, resets_at: epoch + 500000 },
        limits: [
          {
            kind: 'weekly_scoped',
            percent: 80,
            resets_at: epoch / 1000 + 1000,
            scope: { model: { display_name: 'Fable' } }
          }
        ],
        secret: 'fixture upstream token'
      })
    )
    const result = await service.read({ provider: 'claude', accountId: null })
    expect(result).toMatchObject({
      ok: true,
      windows: [
        { label: '5-hour', usedPct: 12 },
        { label: 'Weekly', usedPct: 35 },
        { label: 'Sonnet weekly', usedPct: 56, resetsAt: epoch + 500000 },
        { label: 'Fable weekly', usedPct: 80 }
      ]
    })
    expect(result).not.toHaveProperty('resetToken')
    expect(result).not.toHaveProperty('resetCredits')
    expect(JSON.stringify(result)).not.toContain('fixture upstream token')
    expect(request.mock.calls[0][1].headers).toMatchObject({
      'anthropic-beta': 'oauth-2025-04-20',
      Authorization: 'Bearer fixture-claude-token'
    })
  })
  it('keeps quota windows and reports optional credit errors explicitly', async () => {
    const { service, request } = fixture()
    request.mockImplementation(async (url) =>
      url === urls.codex
        ? reply({ ...codexData, rate_limit_reset_credits: undefined })
        : reply({ error: 'Bearer fixture-secret' }, 500)
    )
    const result = await service.read(selection)
    expect(result).toMatchObject({
      ok: true,
      windows: expect.any(Array),
      resetCreditsError: expect.any(String)
    })
    expect(result).not.toHaveProperty('resetToken')
    expect(JSON.stringify(result)).not.toContain('fixture-secret')
  })
  it('supplements missing credit metadata from the exact credits endpoint', async () => {
    const { service, request } = fixture()
    request.mockImplementation(async (url) =>
      reply(
        url === urls.codex
          ? { ...codexData, rate_limit_reset_credits: { available_count: 2 } }
          : creditData
      )
    )
    expect(await service.read(selection)).toMatchObject({
      ok: true,
      resetCredits: { nextExpiresAt: Date.parse('2026-09-30T18:00:00Z'), eligible: true }
    })
    expect(request.mock.calls.map(([url]) => url)).toEqual([urls.codex, urls.credits])
  })
  it.each([
    { provider: 'other', accountId: null },
    { provider: 'codex' },
    { provider: 'codex', accountId: '../outside' }
  ])('requires explicit known provider/account (%j)', async (query) => {
    const { service, request, readFile } = fixture()
    expect(await service.read(query)).toMatchObject({ ok: false, code: 'validation' })
    expect(request).not.toHaveBeenCalled()
    expect(readFile).not.toHaveBeenCalled()
  })
  it('refuses nonselected accounts and unavailable metadata with no fallback', async () => {
    const { service, state, request } = fixture()
    state.selected.codex = 'managed-a'
    expect(await service.read(selection)).toMatchObject({ ok: false, code: 'stale' })
    expect(await service.read({ provider: 'codex', accountId: 'managed-b' })).toMatchObject({
      ok: false,
      code: 'stale'
    })
    expect(request).not.toHaveBeenCalled()
  })
  it('honors selected account home overrides and keeps reads readonly', async () => {
    const { service, accounts, readFile, state, home } = fixture()
    state.selected.codex = 'managed-a'
    const scoped = path.join(home, 'managed-codex')
    accounts.usageScope.mockResolvedValue({
      ok: true,
      accountId: 'managed-a',
      env: { CODEX_HOME: scoped }
    })
    expect((await service.read({ provider: 'codex', accountId: 'managed-a' })).ok).toBe(true)
    expect(readFile.mock.calls.every(([file]) => file === path.join(scoped, 'auth.json'))).toBe(
      true
    )
    expect(accounts.launchEnv).not.toHaveBeenCalled()
  })
  it.each(['account', 'email', 'organization', 'missingOrg', 'missingIdentity'])(
    'refuses an unproven managed Claude runtime identity (%s)',
    async (conflict) => {
      const { service, state, request } = fixture()
      state.selected.claude = 'managed-a'
      if (conflict === 'account') state.oauth.accountUuid = 'other'
      if (conflict === 'email') state.oauth.emailAddress = 'other@example.invalid'
      if (conflict === 'organization') state.oauth.organizationUuid = 'org-two'
      if (conflict === 'missingOrg') delete state.oauth.organizationUuid
      if (conflict === 'missingIdentity') state.oauth = {}
      expect(await service.read({ provider: 'claude', accountId: 'managed-a' })).toMatchObject({
        ok: false,
        code: 'identity'
      })
      expect(request).not.toHaveBeenCalled()
    }
  )
  it('accepts the positively matched managed Claude identity and override config', async () => {
    const { service, state, accounts, readFile, home, expectedIdentity } = fixture()
    state.selected.claude = 'managed-a'
    const config = path.join(home, 'custom-claude')
    accounts.usageScope.mockResolvedValue({
      ok: true,
      accountId: 'managed-a',
      env: { CLAUDE_CONFIG_DIR: config },
      expectedIdentity
    })
    expect((await service.read({ provider: 'claude', accountId: 'managed-a' })).ok).toBe(true)
    expect(readFile.mock.calls.map(([file]) => file)).toContain(path.join(config, '.claude.json'))
  })
  it.each(['accountUuid', 'emailAddress', 'organizationUuid'])(
    'refuses a Claude token identity that conflicts with the selected runtime account: %s',
    async (field) => {
      const { service, state, request } = fixture()
      state.selected.claude = 'managed-a'
      state.claudeAuth.claudeAiOauth[field] = 'other-account-fixture'
      expect(await service.read({ provider: 'claude', accountId: 'managed-a' })).toMatchObject({
        ok: false,
        code: 'identity'
      })
      expect(request).not.toHaveBeenCalled()
    }
  )
  it('compares token identity to saved metadata even when runtime config omits that field', async () => {
    const { service, state, request } = fixture()
    state.selected.claude = 'managed-a'
    delete state.oauth.accountUuid
    state.claudeAuth.claudeAiOauth.accountUuid = 'other-account-fixture'
    expect(await service.read({ provider: 'claude', accountId: 'managed-a' })).toMatchObject({
      ok: false,
      code: 'identity'
    })
    expect(request).not.toHaveBeenCalled()
  })
  it('rejects changed credentials and A→B→A invalidation during a read', async () => {
    const first = fixture()
    first.request.mockImplementation(async () => {
      first.state.codexAuth.tokens.access_token = 'new-fixture-token'
      return reply(codexData)
    })
    expect(await first.service.read(selection)).toMatchObject({ ok: false, code: 'stale' })
    const second = fixture()
    second.request.mockImplementation(async () => {
      second.service.invalidate('codex')
      second.service.invalidate('codex')
      return reply(codexData)
    })
    expect((await second.service.read(selection)).ok).toBe(false)
  })
  it('a later read cannot be overwritten by an older response', async () => {
    const gate = deferred()
    const { service, request } = fixture()
    request.mockImplementationOnce(() => gate.promise)
    const old = service.read(selection)
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
    const recent = await service.read(selection)
    gate.resolve(reply(codexData))
    expect(recent.ok).toBe(true)
    expect(await old).toMatchObject({ ok: false, code: 'stale' })
  })
  it('isolates invalidation between providers', async () => {
    const { service } = fixture()
    const args = await resetArgs(service)
    service.invalidate('claude')
    expect(await service.redeemReset(args)).toMatchObject({ ok: true, outcome: 'reset' })
  })
})

describe('explicit confirmed Codex resets', () => {
  it('requires confirmation, explicit scope and a minted ticket before any POST', async () => {
    const { service, request } = fixture()
    const args = await resetArgs(service)
    expect(await service.redeemReset({ ...args, confirmed: false })).toMatchObject({
      ok: false,
      code: 'confirmation'
    })
    expect(await service.redeemReset({ ...args, provider: 'claude' })).toMatchObject({ ok: false })
    expect(await service.redeemReset({ ...args, resetToken: 'forged' })).toMatchObject({
      ok: false,
      code: 'stale'
    })
    expect(request.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true)
  })
  it.each([
    ['reset', 'reset'],
    ['nothing_to_reset', 'nothingToReset'],
    ['no_credit', 'noCredit'],
    ['already_redeemed', 'alreadyRedeemed']
  ])('maps %s without exposing response fields', async (code, outcome) => {
    const { service, request } = fixture()
    const args = await resetArgs(service)
    request.mockImplementation(async (url) =>
      reply(url === urls.credits ? creditData : { code, extra: 'fixture-secret' })
    )
    const result = await service.redeemReset(args)
    expect(result).toMatchObject({ ok: true, outcome })
    expect(JSON.stringify(result)).not.toContain('fixture-secret')
    const post = request.mock.calls.find(([, init]) => init.method === 'POST')
    expect(post[0]).toBe(urls.consume)
    expect(post[1].redirect).toBe('error')
    expect(JSON.parse(post[1].body)).toEqual({
      redeem_request_id: expect.stringMatching(/^[a-f0-9-]{36}$/)
    })
  })
  it('shares duplicate clicks and never repeats the POST, even after completion', async () => {
    const gate = deferred()
    const { service, request } = fixture()
    const args = await resetArgs(service)
    request.mockImplementation(async (url) =>
      url === urls.consume ? gate.promise : reply(creditData)
    )
    const first = service.redeemReset(args)
    const second = service.redeemReset(args)
    await vi.waitFor(() =>
      expect(request.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1)
    )
    gate.resolve(reply({ code: 'reset' }))
    expect(await first).toEqual(await second)
    expect(await service.redeemReset(args)).toMatchObject({ ok: true, outcome: 'reset' })
    expect(request.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1)
  })
  it('does not issue another ticket while a reset is in flight', async () => {
    const gate = deferred()
    const { service, request } = fixture()
    const args = await resetArgs(service)
    request.mockImplementation(async (url) =>
      url === urls.consume ? gate.promise : reply(url === urls.codex ? codexData : creditData)
    )
    const inFlight = service.redeemReset(args)
    await vi.waitFor(() =>
      expect(request.mock.calls.some(([, init]) => init.method === 'POST')).toBe(true)
    )
    const during = await service.read(selection)
    expect(during).toMatchObject({ ok: true, resetCredits: { eligible: false } })
    expect(during).not.toHaveProperty('resetToken')
    expect((await service.redeemReset({ ...args, resetToken: during.resetToken })).ok).toBe(false)
    gate.resolve(reply({ code: 'reset' }))
    await inFlight
    const next = await resetArgs(service)
    expect(next.resetToken).not.toBe(args.resetToken)
    expect(request.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1)
  })
  it.each(['expiry', 'invalidate', 'credentials', 'selection'])(
    'rejects changed confirmation state before a POST: %s',
    async (change) => {
      const { service, state, request } = fixture()
      const args = await resetArgs(service)
      if (change === 'expiry') state.time += 300001
      if (change === 'invalidate') service.invalidate('codex')
      if (change === 'credentials') state.codexAuth.tokens.access_token = 'new-fixture-token'
      if (change === 'selection') state.selected.codex = 'managed-a'
      expect((await service.redeemReset(args)).ok).toBe(false)
      expect(request.mock.calls.some(([, init]) => init.method === 'POST')).toBe(false)
    }
  )
  it('rechecks credentials after credits preflight and refuses a race', async () => {
    const { service, state, request } = fixture()
    const args = await resetArgs(service)
    request.mockImplementation(async () => {
      state.codexAuth.tokens.access_token = 'changed-during-preflight'
      return reply(creditData)
    })
    expect(await service.redeemReset(args)).toMatchObject({ ok: false, code: 'stale' })
    expect(request.mock.calls.some(([, init]) => init.method === 'POST')).toBe(false)
  })
  it('does not POST if credits have disappeared', async () => {
    const { service, request } = fixture()
    const args = await resetArgs(service)
    request.mockResolvedValue(reply({ available_count: 0 }))
    expect(await service.redeemReset(args)).toMatchObject({ ok: true, outcome: 'noCredit' })
    expect(request.mock.calls.some(([, init]) => init.method === 'POST')).toBe(false)
  })
  it('caches timeout uncertainty and never blindly retries the POST', async () => {
    const { service, request } = fixture({ timeoutMs: 10 })
    const args = await resetArgs(service)
    request.mockImplementation(async (url) =>
      url === urls.consume ? new Promise(() => {}) : reply(creditData)
    )
    expect(await service.redeemReset(args)).toMatchObject({ ok: false, uncertain: true })
    expect(await service.redeemReset(args)).toMatchObject({ ok: false, uncertain: true })
    expect(request.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1)
  })
  it('reports uncertainty if selection changes after the confirmed POST', async () => {
    const { service, request } = fixture()
    const args = await resetArgs(service)
    request.mockImplementation(async (url) => {
      if (url === urls.consume) {
        service.invalidate('codex')
        return reply({ code: 'reset' })
      }
      return reply(creditData)
    })
    expect(await service.redeemReset(args)).toMatchObject({
      ok: false,
      uncertain: true,
      accountId: null
    })
    expect((await service.redeemReset(args)).ok).toBe(false)
    expect(request.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1)
  })
})

describe('privacy and bounded I/O', () => {
  it.each([401, 403, 500])(
    'does not expose raw HTTP %s errors or refresh OAuth',
    async (status) => {
      const { service, request } = fixture()
      request.mockResolvedValue(reply({ error: 'Bearer fixture-secret' }, status))
      const result = await service.read(selection)
      expect(result.ok).toBe(false)
      expect(JSON.stringify(result)).not.toContain('fixture-secret')
      expect(request.mock.calls.map(([url]) => url)).toEqual([urls.codex])
    }
  )
  it('refuses redirects without sending the token to another URL', async () => {
    const { service, request } = fixture()
    request.mockResolvedValue(
      new Response('', { status: 302, headers: { Location: 'https://untrusted.invalid/' } })
    )
    expect(await service.read(selection)).toMatchObject({ ok: false, code: 'redirect' })
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0][1].redirect).toBe('error')
  })
  it('bounds streamed response size and auth size', async () => {
    const largeResponse = fixture()
    largeResponse.request.mockResolvedValue(reply({ ignored: 'x'.repeat(256 * 1024) }))
    expect(await largeResponse.service.read(selection)).toMatchObject({
      ok: false,
      code: 'response'
    })
    const largeAuth = fixture()
    largeAuth.readFile.mockResolvedValue('x'.repeat(1024 * 1024 + 1))
    expect(await largeAuth.service.read(selection)).toMatchObject({ ok: false, code: 'auth' })
    expect(largeAuth.request).not.toHaveBeenCalled()
  })
  it('rejects malformed auth, API-key auth, unreadable credentials and header injection', async () => {
    for (const content of [
      'not JSON fixture-secret',
      JSON.stringify({ OPENAI_API_KEY: 'fixture-secret' }),
      JSON.stringify({ tokens: { access_token: 'token\r\nInjected: bad' } })
    ]) {
      const { service, readFile, request } = fixture()
      readFile.mockResolvedValue(content)
      const result = await service.read(selection)
      expect(result.ok).toBe(false)
      expect(JSON.stringify(result)).not.toContain('fixture-secret')
      expect(request).not.toHaveBeenCalled()
    }
    const denied = fixture()
    denied.readFile.mockRejectedValue(new Error('EACCES C:/private/token fixture-secret'))
    expect(JSON.stringify(await denied.service.read(selection))).not.toMatch(
      /private|fixture-secret/
    )
  })
  it('never contacts a server after missing credentials and keeps providers independent', async () => {
    const { service, state, request } = fixture()
    state.codexAuth = {}
    expect((await service.read(selection)).ok).toBe(false)
    expect((await service.read({ provider: 'claude', accountId: null })).ok).toBe(true)
    expect(request.mock.calls.map(([url]) => url)).toEqual([urls.claude])
  })
})

describe('real disposable credential files', () => {
  let root
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'tessel-provider-usage-'))
  })
  afterAll(async () => {
    await fs.rmdir(root)
  })
  it('reads a fixture at request time and rejects a junction to another fixture', async () => {
    const home = path.join(root, 'home')
    const outside = path.join(root, 'outside')
    await fs.mkdir(home)
    await fs.mkdir(outside)
    const dir = path.join(home, '.codex')
    await fs.mkdir(dir)
    const auth = path.join(dir, 'auth.json')
    await fs.writeFile(auth, JSON.stringify({ tokens: { access_token: 'fixture-token-only' } }))
    const context = fixture()
    const service = createProviderUsage({
      accounts: context.accounts,
      home,
      env: {},
      request: context.request,
      clock: () => epoch
    })
    try {
      expect((await service.read(selection)).ok).toBe(true)
      await fs.unlink(auth)
      await fs.rmdir(dir)
      await fs.writeFile(
        path.join(outside, 'auth.json'),
        JSON.stringify({ tokens: { access_token: 'outside-fixture-token' } })
      )
      await fs.symlink(outside, dir, 'junction')
      const before = context.request.mock.calls.length
      expect(await service.read(selection)).toMatchObject({ ok: false, code: 'auth' })
      expect(context.request).toHaveBeenCalledTimes(before)
    } finally {
      const stat = await fs.lstat(dir)
      if (stat.isSymbolicLink()) await fs.unlink(dir)
      else {
        await fs.unlink(auth).catch(() => {})
        await fs.rmdir(dir)
      }
      await fs.unlink(path.join(outside, 'auth.json')).catch(() => {})
      await fs.rmdir(outside)
      await fs.rmdir(home)
    }
  })
})
