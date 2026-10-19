// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { createExtraProviderUsage, USAGE_URLS, geminiUnsupported } from '../extraProviderUsage'
import { ProviderReadError } from '../usageProviderSources'
import {
  mapGemini,
  mapKimi,
  mapCursor,
  mapCursorLegacy,
  mapGrok,
  mapOpenCodeGo,
  mapMiniMax,
  mapZcode
} from '../usageProviderMapping'
const now = Date.parse('2026-09-28T12:00:00Z')
const fixtures = {
  gemini: {
    buckets: [{ modelId: 'gemini-pro', remainingFraction: 0.25, resetTime: now + 3600000 }]
  },
  kimi: {
    usage: { limit: '100', remaining: '80', resetAt: now + 86400000 },
    limits: [{ window: { duration: 5, timeUnit: 'HOUR' }, detail: { used: '7', limit: '10' } }]
  },
  cursor: {
    individualUsage: { plan: { enabled: true, used: 25, limit: 100 } },
    billingCycleEnd: now + 86400000
  },
  grok: { config: { creditUsagePercent: 30, billingPeriodEnd: now + 86400000 } },
  'opencode-go': {
    usage: {
      rolling: { percent: 20, resetsAt: now + 3600000 },
      weekly: { percent: 50, resetsAt: now + 86400000 }
    }
  },
  minimax: {
    base_resp: { status_code: 0 },
    model_remains: [
      {
        model_name: 'general',
        current_interval_remaining_percent: 25,
        start_time: now - 3600000,
        end_time: now + 3600000,
        current_weekly_remaining_percent: 90,
        weekly_remains_time: 60000
      }
    ]
  }
}
function setup(options = {}) {
  const sources = {
    present: vi.fn(async () => true),
    auth: vi.fn(async () => ({
      headers: { Authorization: 'Bearer fixture-only' },
      fingerprint: 'one'
    }))
  }
  const request = vi.fn(
    async (url) =>
      new Response(
        JSON.stringify(
          url === USAGE_URLS.geminiProject
            ? { cloudaicompanionProject: 'fixture-project' }
            : fixtures[Object.keys(USAGE_URLS).find((k) => USAGE_URLS[k] === url)]
        )
      )
  )
  const listAgents = vi.fn(async () =>
    ['claude', 'codex', 'gemini', 'kimi', 'cursor', 'grok', 'opencode', 'qwen', 'muse'].map(
      (id) => ({ id, available: true })
    )
  )
  // Antigravity's CLI: never this computer's agy in a test.
  const antigravityCli = { present: vi.fn(() => false), read: vi.fn(async () => ({ ok: false, reason: 'missing' })), timeoutMs: 20000 }
  // Nor this computer's Antigravity app.
  const antigravityPlan = { read: vi.fn(() => null) }
  // Nor this computer's Muse Code (`muse serve`).
  const museUsage = { present: vi.fn(() => false), read: vi.fn(async () => ({ ok: false, reason: 'missing' })), timeoutMs: 20000 }
  const service = createExtraProviderUsage({
    sources,
    request,
    listAgents,
    clock: () => now,
    antigravityCli,
    antigravityPlan,
    museUsage,
    ...options
  })
  return { service, sources, request, listAgents }
}
const read = (service, provider) => service.read({ provider, accountId: null })
describe('explicit additional quota collectors', () => {
  it("Gemini CLI on a personal account Google no longer serves: says so, never a failed read", async () => {
    const { service, request } = setup()
    request.mockImplementation(async (url) =>
      new Response(
        JSON.stringify(
          url === USAGE_URLS.geminiProject
            ? {
                allowedTiers: [{ id: 'standard-tier', isDefault: true, userDefinedCloudaicompanionProject: true }],
                ineligibleTiers: [{ tierId: 'free-tier', reasonCode: 'UNSUPPORTED_CLIENT', reasonMessage: 'This client is no longer supported.' }]
              }
            : {}
        )
      )
    )
    const res = await read(service, 'gemini')
    expect(res).toMatchObject({ ok: false, provider: 'gemini', code: 'unsupported' })
    expect(res.error).toMatch(/no longer supports Gemini CLI for personal accounts/)
    expect(res.error).toMatch(/Antigravity/)
    // Only the tier question was asked: no quota read for a project it has not got.
    expect(request.mock.calls.map(([url]) => url)).toEqual([USAGE_URLS.geminiProject])
  })

  it('geminiUnsupported: only UNSUPPORTED_CLIENT among the refused tiers', () => {
    expect(geminiUnsupported({ ineligibleTiers: [{ reasonCode: 'UNSUPPORTED_CLIENT' }] })).toBe(true)
    expect(geminiUnsupported({ ineligibleTiers: [{ reasonCode: 'INELIGIBLE_ACCOUNT' }] })).toBe(false)
    expect(geminiUnsupported({})).toBe(false)
    expect(geminiUnsupported(null)).toBe(false)
  })

  it('detects installed configured capabilities without reading credentials or requesting usage', async () => {
    const { service, sources, request } = setup()
    sources.present.mockImplementation(async (id) => id !== 'kimi')
    const result = await service.capabilities()
    expect(result.providers.map((p) => p.id)).toEqual([
      'claude',
      'codex',
      'gemini',
      'cursor',
      'grok',
      'opencode',
      'opencode-go',
      'minimax'
    ])
    expect(result.providers.filter((p) => p.report).map((p) => p.id)).toEqual([
      'claude',
      'codex',
      'grok',
      'opencode'
    ])
    // OpenCode's token stats are local: no quota row of their own.
    expect(result.providers.find((p) => p.id === 'opencode').quota).toBe(false)
    expect(sources.auth).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })
  it.each(Object.keys(fixtures))(
    'reads %s only on explicit action and returns no credential',
    async (provider) => {
      const { service, sources, request } = setup()
      const result = await read(service, provider)
      expect(result).toMatchObject({
        ok: true,
        provider,
        accountId: null,
        source: 'live',
        observedAt: now
      })
      expect(result.windows.length).toBeGreaterThan(0)
      expect(JSON.stringify(result)).not.toContain('fixture-only')
      expect(sources.auth).toHaveBeenCalledTimes(2)
      for (const [url, init] of request.mock.calls) {
        expect(Object.values(USAGE_URLS)).toContain(url)
        expect(init.redirect).toBe('error')
        expect(init.headers.Authorization).toBe('Bearer fixture-only')
        expect(init.method).toBe(provider === 'gemini' ? 'POST' : 'GET')
      }
      if (provider === 'gemini')
        expect(JSON.parse(request.mock.calls[1][1].body)).toEqual({ project: 'fixture-project' })
    }
  )
  it.each([
    { provider: 'geminiProject', accountId: null },
    { provider: 'kimi', accountId: 'other' },
    { provider: '__proto__', accountId: null },
    { provider: 'kimi' },
    { provider: 'https://example.com', accountId: null }
  ])('rejects an invalid query %j without reading login', async (query) => {
    const { service, sources, request } = setup()
    expect(await service.read(query)).toMatchObject({ ok: false, code: 'validation' })
    expect(sources.auth).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })
  it('refuses uninstalled agents before reading login', async () => {
    const { service, sources } = setup({ listAgents: async () => [] })
    expect(await read(service, 'kimi')).toMatchObject({ ok: false, code: 'unavailable' })
    expect(sources.auth).not.toHaveBeenCalled()
  })
  it('asks the CLI to refresh expired Kimi credentials, never refreshing itself', async () => {
    const { service, sources, request } = setup()
    sources.auth.mockRejectedValue(
      new ProviderReadError('expired', 'Run Kimi to refresh its login.')
    )
    expect(await read(service, 'kimi')).toMatchObject({
      ok: false,
      code: 'expired',
      error: 'Run Kimi to refresh its login.'
    })
    expect(request).not.toHaveBeenCalled()
  })
  it('rejects login changes during a request', async () => {
    const { service, sources } = setup()
    sources.auth
      .mockResolvedValueOnce({ headers: {}, fingerprint: 'A' })
      .mockResolvedValueOnce({ headers: {}, fingerprint: 'B' })
    expect(await read(service, 'kimi')).toMatchObject({ ok: false, code: 'stale' })
  })
  it('rejects a superseded response from the same provider', async () => {
    const { service, request } = setup()
    let finish
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const first = read(service, 'kimi')
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    expect(await read(service, 'kimi')).toMatchObject({ ok: true })
    finish(new Response(JSON.stringify(fixtures.kimi)))
    expect(await first).toMatchObject({ ok: false, code: 'stale' })
  })
  it.each([301, 401, 403, 500])(
    'sanitizes HTTP %s without leaking its response or login',
    async (status) => {
      const { service, request } = setup()
      request.mockResolvedValue(new Response('private-fixture-data', { status }))
      const result = await read(service, 'kimi')
      expect(result.ok).toBe(false)
      expect(JSON.stringify(result)).not.toMatch(/fixture-only|private-fixture-data/)
    }
  )
  it('reports only a Cursor 401 as an expired sign-in', async () => {
    const { service, request } = setup()
    request.mockResolvedValue(new Response('private-fixture-data', { status: 401 }))
    const expired = await read(service, 'cursor')
    expect(expired).toMatchObject({ ok: false, code: 'expired' })
    expect(expired.error).toMatch(/sign-in expired/i)
    expect(JSON.stringify(expired)).not.toMatch(/fixture-only|private-fixture-data/)
  })
  it.each([403, 500, 502])(
    'reports a Cursor HTTP %s as a usage read that failed, not an expired sign-in',
    async (status) => {
      const { service, request } = setup()
      request.mockResolvedValue(new Response('private-fixture-data', { status }))
      const result = await read(service, 'cursor')
      expect(result).toMatchObject({ ok: false, code: 'server' })
      expect(result.error).toBe(`Cursor usage could not be read (HTTP ${status}).`)
      expect(result.error).not.toMatch(/sign in|login/i)
      expect(JSON.stringify(result)).not.toMatch(/fixture-only|private-fixture-data/)
    }
  )
  it("keeps a forbidden answer from Cursor's legacy usage a failed read", async () => {
    const { service, request } = setup()
    request
      .mockResolvedValueOnce(new Response(JSON.stringify({ membershipType: 'free' })))
      .mockResolvedValueOnce(new Response('', { status: 403 }))
    expect(await read(service, 'cursor')).toMatchObject({
      ok: false,
      code: 'server',
      error: 'Cursor usage could not be read (HTTP 403).'
    })
  })
  it('reports a Cursor redirect, network error or unreadable body without asking to sign in', async () => {
    const { service, request } = setup()
    request.mockResolvedValueOnce(new Response('', { status: 302, headers: { Location: '/login' } }))
    expect(await read(service, 'cursor')).toMatchObject({ ok: false, code: 'redirect' })
    request.mockRejectedValueOnce(new TypeError('fetch failed'))
    expect(await read(service, 'cursor')).toMatchObject({ ok: false, code: 'network' })
    request.mockResolvedValueOnce(new Response('not json'))
    expect(await read(service, 'cursor')).toMatchObject({ ok: false, code: 'response' })
  })
  it('reports a 429 with its Retry-After, for the automatic refresh to wait', async () => {
    const { service, request } = setup()
    request.mockResolvedValue(
      new Response('private-fixture-data', { status: 429, headers: { 'Retry-After': '120' } })
    )
    const result = await read(service, 'kimi')
    expect(result).toMatchObject({ ok: false, code: 'rate-limited', retryAfterMs: 120000 })
    expect(JSON.stringify(result)).not.toMatch(/fixture-only|private-fixture-data/)
  })
  it('hides OpenCode accounts without a Go subscription', async () => {
    const { service, request } = setup()
    request.mockResolvedValue(new Response('', { status: 403 }))
    expect(await read(service, 'opencode-go')).toMatchObject({ ok: false, code: 'unavailable' })
  })
  it('bounds body size and sanitizes transport exceptions', async () => {
    const { service, request } = setup()
    request.mockResolvedValueOnce(new Response('x'.repeat(262145)))
    expect(await read(service, 'kimi')).toMatchObject({ ok: false, code: 'response' })
    request.mockRejectedValueOnce(new Error('Bearer fixture-only'))
    const result = await read(service, 'kimi')
    expect(result.code).toBe('network')
    expect(JSON.stringify(result)).not.toContain('fixture-only')
  })
  it('times out without a late network call if credential loading completes later', async () => {
    const { service, sources, request } = setup({ timeoutMs: 5 })
    let finish
    sources.auth.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    expect(await read(service, 'kimi')).toMatchObject({ ok: false, code: 'timeout' })
    finish({ headers: {}, fingerprint: 'late' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(request).not.toHaveBeenCalled()
  })
  it('handles Cursor unlimited without requesting legacy usage', async () => {
    const { service, request } = setup()
    request.mockResolvedValue(new Response('{"isUnlimited":true}'))
    expect(await read(service, 'cursor')).toMatchObject({ ok: true, unlimited: true, windows: [] })
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('uses only fixed legacy endpoints when Cursor or Grok returns no supported primary window', async () => {
    for (const provider of ['cursor', 'grok']) {
      const { service, request } = setup()
      request
        .mockResolvedValueOnce(new Response('{}'))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify(
              provider === 'cursor'
                ? { 'gpt-4': { numRequests: 1, maxRequestUsage: 10 } }
                : { used: { val: '20' }, monthlyLimit: { val: '100' } }
            )
          )
        )
      expect(await read(service, provider)).toMatchObject({ ok: true })
      expect(request.mock.calls[1][0]).toBe(
        USAGE_URLS[provider === 'cursor' ? 'cursorLegacy' : 'grokMonthly']
      )
    }
  })
})
describe('Antigravity quota, from the Antigravity CLI only', () => {
  const withAntigravity = async () => ['antigravity', 'gemini'].map((id) => ({ id, available: true }))
  const rows = [
    { label: 'Gemini 5-hour', usedPct: 25, resetsAt: now + 3600000 },
    { label: 'Gemini weekly', usedPct: 10, resetsAt: now + 86400000 }
  ]
  const cli = (result, present = true) => ({
    present: vi.fn(() => present),
    read: vi.fn(async () => result),
    timeoutMs: 20000
  })
  it('is offered when agy is found, without running it or looking at a Gemini login', async () => {
    const antigravityCli = cli({ ok: true, windows: rows })
    const { service, sources } = setup({ listAgents: async () => [{ id: 'antigravity', available: true }], antigravityCli })
    sources.present.mockResolvedValue(false)
    const result = await service.capabilities()
    expect(result.providers.map((p) => p.id)).toEqual(['antigravity'])
    expect(antigravityCli.present).toHaveBeenCalled()
    expect(antigravityCli.read).not.toHaveBeenCalled()
    expect(sources.present).not.toHaveBeenCalledWith('gemini')
    expect(sources.auth).not.toHaveBeenCalled()
  })
  it('is not offered without agy, even with a Gemini login', async () => {
    const { service, sources } = setup({ listAgents: withAntigravity, antigravityCli: cli(null, false) })
    sources.present.mockResolvedValue(true)
    const result = await service.capabilities()
    expect(result.providers.map((p) => p.id)).toEqual(['gemini'])
  })
  it("reads agy's windows, and never a Gemini login or endpoint", async () => {
    const antigravityCli = cli({ ok: true, windows: rows, observedAt: now - 5000 })
    const { service, sources, request } = setup({ listAgents: withAntigravity, antigravityCli })
    const result = await read(service, 'antigravity')
    expect(result).toEqual({ ok: true, provider: 'antigravity', accountId: null, source: 'live', observedAt: now - 5000, windows: rows })
    expect(antigravityCli.read).toHaveBeenCalledTimes(1)
    expect(sources.auth).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })
  it("adds the plan the Antigravity app keeps; a plan it cannot read leaves it out", async () => {
    const antigravityCli = cli({ ok: true, windows: rows, observedAt: now })
    const plan = { read: vi.fn(() => 'Pro') }
    const { service } = setup({ listAgents: withAntigravity, antigravityCli, antigravityPlan: plan })
    expect(await read(service, 'antigravity')).toMatchObject({ ok: true, windows: rows, plan: 'Pro' })
    const broken = { read: vi.fn(() => { throw new Error('locked') }) }
    const again = setup({ listAgents: withAntigravity, antigravityCli: cli({ ok: true, windows: rows, observedAt: now }), antigravityPlan: broken })
    const result = await read(again.service, 'antigravity')
    expect(result.ok).toBe(true)
    expect(result).not.toHaveProperty('plan')
  })
  it.each(['missing', 'signed-out', 'failed'])('%s: says the Antigravity CLI is needed, never Gemini', async (reason) => {
    const { service, sources, request } = setup({ listAgents: withAntigravity, antigravityCli: cli({ ok: false, reason }) })
    const result = await read(service, 'antigravity')
    expect(result).toEqual({
      ok: false,
      provider: 'antigravity',
      accountId: null,
      code: 'unavailable',
      error: "Antigravity's usage needs the Antigravity CLI (agy), installed and signed in."
    })
    expect(result.error).not.toMatch(/Gemini|Code Assist/)
    expect(sources.auth).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })
  it('a timeout or an unreadable answer offers a retry', async () => {
    for (const [reason, code] of [['timeout', 'timeout'], ['response', 'response']]) {
      const { service, request } = setup({ listAgents: withAntigravity, antigravityCli: cli({ ok: false, reason }) })
      expect(await read(service, 'antigravity')).toMatchObject({ ok: false, code })
      expect(request).not.toHaveBeenCalled()
    }
  })
  it('gives agy its own time before the read times out', async () => {
    vi.useFakeTimers()
    try {
      const antigravityCli = { present: () => true, read: () => new Promise(() => {}), timeoutMs: 100 }
      const { service } = setup({ listAgents: withAntigravity, antigravityCli, timeoutMs: 10 })
      let result = null
      read(service, 'antigravity').then((r) => (result = r))
      await vi.advanceTimersByTimeAsync(1050)
      expect(result).toBe(null)
      await vi.advanceTimersByTimeAsync(100)
      expect(result).toMatchObject({ ok: false, code: 'timeout' })
    } finally {
      vi.useRealTimers()
    }
  })
  it('refuses when Antigravity itself is not installed', async () => {
    const antigravityCli = cli({ ok: true, windows: rows })
    const { service, sources } = setup({ antigravityCli })
    expect(await read(service, 'antigravity')).toMatchObject({
      ok: false,
      code: 'unavailable',
      error: 'The matching agent is not installed.'
    })
    expect(antigravityCli.read).not.toHaveBeenCalled()
    expect(sources.auth).not.toHaveBeenCalled()
  })
})
describe('Orca quota mappings', () => {
  it('deduplicates Gemini shared pools and rejects absent percentages', () => {
    expect(
      mapGemini({
        buckets: [...fixtures.gemini.buckets, ...fixtures.gemini.buckets, { modelId: 'other' }]
      })
    ).toEqual([{ label: 'pro', usedPct: 75, resetsAt: now + 3600000 }])
  })
  it('keeps Kimi weekly and closest five-hour limit, including numeric strings', () => {
    expect(mapKimi(fixtures.kimi).map((w) => [w.label, w.usedPct])).toEqual([
      ['5-hour', 70],
      ['Weekly', 20]
    ])
    expect(mapKimi({ usage: { limit: 0, used: 1 } })).toEqual([])
  })
  it("prefers Cursor's reported plan percentage, the ratio without it, and clamps its calendar reset", () => {
    // The raw base allowance can read 100% while the plan still has capacity.
    expect(
      mapCursor({ individualUsage: { plan: { used: 2000, limit: 2000, totalPercentUsed: 12 } } })
        .windows[0].usedPct
    ).toBe(12)
    expect(
      mapCursor({ individualUsage: { plan: { used: 20, limit: 100, totalPercentUsed: '0' } } })
        .windows[0].usedPct
    ).toBe(0)
    expect(mapCursor({ individualUsage: { plan: { used: 20, limit: 100 } } }).windows[0].usedPct).toBe(20)
    expect(
      mapCursorLegacy({
        startOfMonth: '2026-01-31T12:00:00Z',
        'gpt-4': { numRequests: 1, maxRequestUsage: 10 }
      })[0].resetsAt
    ).toBe(Date.parse('2026-02-28T12:00:00Z'))
  })
  it('does not fabricate zero usage for missing Grok usage', () => {
    expect(mapGrok({})).toEqual([])
    expect(mapGrok({ used: { val: '25' }, monthlyLimit: { val: '100' } })[0].usedPct).toBe(25)
  })
  it('requires both Go primary windows and uses MiniMax remaining percentages', () => {
    expect(mapOpenCodeGo({ usage: { rolling: { percent: 20 } } })).toEqual([])
    expect(mapMiniMax(fixtures.minimax, now)).toEqual([
      { label: '5-hour', usedPct: 75, resetsAt: now + 3600000 },
      { label: 'Weekly', usedPct: 10, resetsAt: now + 60000 }
    ])
    expect(
      mapMiniMax({
        model_remains: [
          { ...fixtures.minimax.model_remains[0], model_name: 'a' },
          { ...fixtures.minimax.model_remains[0], model_name: 'b' }
        ]
      })
    ).toEqual([])
  })
})

describe('ZCode Coding Plan quota', () => {
  const limits = {
    success: true,
    code: 200,
    data: {
      level: 'pro',
      limits: [
        { type: 'TOKENS_LIMIT', unit: 3, number: 5, usage: 1000, currentValue: 250, nextResetTime: now + 3600000 },
        { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 40, nextResetTime: now + 86400000 },
        { type: 'TIME_LIMIT', unit: 5, number: 1, usage: 100, remaining: 90, nextResetTime: now + 7 * 86400000 }
      ]
    }
  }
  it('maps its 5-hour, weekly and monthly limits, and refuses an unsuccessful answer', () => {
    expect(mapZcode(limits, now)).toEqual([
      { label: '5-hour', usedPct: 25, resetsAt: now + 3600000 },
      { label: 'Weekly', usedPct: 40, resetsAt: now + 86400000 },
      { label: 'Monthly', usedPct: 10, resetsAt: now + 7 * 86400000 }
    ])
    // A 5-hour reset further than 5 hours away is not its reset.
    const far = { ...limits, data: { limits: [{ ...limits.data.limits[0], nextResetTime: now + 10 * 3600000 }] } }
    expect(mapZcode(far, now)).toEqual([{ label: '5-hour', usedPct: 25, resetsAt: null }])
    expect(mapZcode({ success: false, msg: 'nope' }, now)).toBe(null)
    expect(mapZcode({ success: true, code: 1001, data: { limits: [] } }, now)).toBe(null)
  })
  it("reads the endpoint of ZCode's configured host, with its key as given", async () => {
    const sources = {
      present: vi.fn(async () => true),
      auth: vi.fn(async () => ({ headers: { Authorization: 'fixture-only' }, endpoint: 'zcodeCn', fingerprint: 'one' }))
    }
    const request = vi.fn(async () => new Response(JSON.stringify(limits)))
    const service = createExtraProviderUsage({
      sources,
      request,
      listAgents: async () => [{ id: 'zcode', available: true }],
      clock: () => now
    })
    expect((await service.capabilities()).providers.map((p) => p.id)).toEqual(['zcode'])
    const result = await read(service, 'zcode')
    expect(result).toMatchObject({ ok: true, provider: 'zcode', windows: [{ label: '5-hour' }, { label: 'Weekly' }, { label: 'Monthly' }] })
    expect(request.mock.calls.map(([url]) => url)).toEqual(['https://open.bigmodel.cn/api/monitor/usage/quota/limit'])
    expect(JSON.stringify(result)).not.toContain('fixture-only')
    // Its other hosts are never providers of their own.
    expect(await read(service, 'zcodeCn')).toMatchObject({ ok: false, code: 'validation' })
    request.mockImplementation(async () => new Response(JSON.stringify({ success: false, msg: 'bad key' })))
    expect(await read(service, 'zcode')).toMatchObject({ ok: false, code: 'response' })
  })
})
