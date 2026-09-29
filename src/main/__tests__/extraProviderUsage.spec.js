// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { createExtraProviderUsage, USAGE_URLS } from '../extraProviderUsage'
import { ProviderReadError } from '../usageProviderSources'
import {
  mapGemini,
  mapKimi,
  mapCursor,
  mapCursorLegacy,
  mapGrok,
  mapOpenCodeGo,
  mapMiniMax
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
  const service = createExtraProviderUsage({
    sources,
    request,
    listAgents,
    clock: () => now,
    ...options
  })
  return { service, sources, request, listAgents }
}
const read = (service, provider) => service.read({ provider, accountId: null })
describe('explicit additional quota collectors', () => {
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
describe('Antigravity quota, from the shared Gemini quota', () => {
  const withAntigravity = async () =>
    ['antigravity'].map((id) => ({ id, available: true }))
  it('is offered when Antigravity is installed and a Gemini login exists', async () => {
    const { service, sources } = setup({ listAgents: withAntigravity })
    sources.present.mockImplementation(async (id) => id === 'gemini')
    const result = await service.capabilities()
    expect(result.providers.map((p) => p.id)).toEqual(['antigravity'])
    expect(sources.present).toHaveBeenCalledWith('gemini')
    expect(sources.auth).not.toHaveBeenCalled()
  })
  it('reads Gemini quota endpoints and labels them Antigravity', async () => {
    const { service, sources, request } = setup({ listAgents: withAntigravity })
    const result = await read(service, 'antigravity')
    expect(result).toMatchObject({ ok: true, provider: 'antigravity', source: 'live' })
    expect(result.windows).toEqual(mapGemini(fixtures.gemini))
    expect(sources.auth).toHaveBeenCalledWith('gemini')
    expect(request.mock.calls.map(([url]) => url)).toEqual([USAGE_URLS.geminiProject, USAGE_URLS.gemini])
    expect(JSON.stringify(result)).not.toContain('fixture-only')
  })
  it('says a Gemini sign-in is needed, not that Antigravity failed', async () => {
    const { service, sources, request } = setup({ listAgents: withAntigravity })
    sources.auth.mockRejectedValue(new ProviderReadError('unavailable', 'Sign in with Gemini CLI.'))
    const result = await read(service, 'antigravity')
    expect(result).toMatchObject({ ok: false, provider: 'antigravity', code: 'unavailable' })
    expect(result.error).toMatch(/Gemini CLI sign-in/)
    expect(request).not.toHaveBeenCalled()
  })
  it('says the shared quota could not be read when Gemini answers badly', async () => {
    const { service, request } = setup({ listAgents: withAntigravity })
    request.mockResolvedValue(new Response('', { status: 500 }))
    const result = await read(service, 'antigravity')
    expect(result).toMatchObject({ ok: false, code: 'unavailable' })
    expect(result.error).toMatch(/could not be read/)
  })
  it('refuses when Antigravity itself is not installed', async () => {
    const { service, sources } = setup()
    expect(await read(service, 'antigravity')).toMatchObject({
      ok: false,
      code: 'unavailable',
      error: 'The matching agent is not installed.'
    })
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
  it('prefers Cursor actual ratio to rounded percentage and clamps its calendar reset', () => {
    expect(
      mapCursor({ individualUsage: { plan: { used: 20, limit: 100, totalPercentUsed: 99 } } })
        .windows[0].usedPct
    ).toBe(20)
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
