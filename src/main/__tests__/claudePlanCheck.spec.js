// @vitest-environment node
// Each Claude account's subscription as Anthropic reports it now
// (claudePlanCheck.js, providerUsage.js claudeProfile): the answer wins over
// the plan Claude Code wrote into its login file, an expired login keeps the
// last result, a usage refusal for want of a subscription is said as that.
// Fixture files in a temporary HOME and answers shaped like the real
// profile endpoint's (no real email, name or token): the real ~/.claude is
// never read and nothing is sent anywhere.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createProviderUsage } from '../providerUsage'
import { createHash } from 'node:crypto'
import { createClaudePlanCheck, emailKey } from '../claudePlanCheck'
import { cleanSubscription, planDisplayName, subscriptionFields, subscriptionPlan, subscriptionState } from '../../shared/claudeSubscription'

const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile'
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const INVOICE = 'https://invoice.example.invalid/pay/FIXTURE-INVOICE-LINK'
const EMAIL = 'canceled.fixture@example.invalid'
const T0 = Date.parse('2026-10-16T12:00:00Z')

// The probe's answers, with fixture values.
function profile(org, account = {}) {
  return {
    account: {
      uuid: '1f0c6d1e-1111-4111-8111-111111111111',
      full_name: 'Fixture Person',
      display_name: 'Fixture',
      email: EMAIL,
      has_claude_max: false,
      has_claude_pro: false,
      created_at: '2025-01-02T00:00:00Z',
      ...account
    },
    organization: {
      uuid: '2f0c6d1e-2222-4222-8222-222222222222',
      name: 'Fixture Organization',
      organization_type: 'claude_free',
      billing_type: 'none',
      rate_limit_tier: 'default_claude_ai',
      seat_tier: null,
      has_extra_usage_enabled: false,
      subscription_status: 'canceled',
      subscription_created_at: '2025-03-04T00:00:00Z',
      claude_code_trial_ends_at: null,
      claude_code_trial_duration_days: null,
      payment_auth_hosted_invoice_url: INVOICE,
      ...org
    }
  }
}
const PROFILES = {
  canceled: profile({}),
  max20: profile(
    { organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_20x', billing_type: 'stripe_subscription', subscription_status: 'active', payment_auth_hosted_invoice_url: null },
    { has_claude_max: true }
  ),
  pro: profile(
    { organization_type: 'claude_pro', rate_limit_tier: 'default_claude_ai', billing_type: 'stripe_subscription', subscription_status: 'active' },
    { has_claude_pro: true }
  ),
  pastDue: profile(
    { organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_5x', billing_type: 'stripe_subscription', subscription_status: 'past_due' },
    { has_claude_max: true }
  )
}
const reply = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })

let home
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tessel-plan-check-'))
})
afterEach(() => {
  const target = path.resolve(home)
  if (!target.startsWith(path.resolve(os.tmpdir()) + path.sep) || !target.includes('tessel-plan-check-'))
    throw new Error('Unexpected cleanup path')
  fs.rmSync(target, { recursive: true, force: true })
})

function login(oauth = {}) {
  const dir = path.join(home, '.claude')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'fixture-secret-access',
        refreshToken: 'fixture-secret-refresh',
        expiresAt: T0 + 3600_000,
        // What the login file still says after the subscription ended.
        subscriptionType: 'max',
        rateLimitTier: 'default_claude_max_20x',
        ...oauth
      }
    })
  )
}

function setup({ answer = PROFILES.canceled, usageReply = null, email = EMAIL } = {}) {
  login()
  let now = T0
  const state = { email, answer }
  const accounts = {
    list: vi.fn(async () => ({
      ok: true,
      providers: [{ provider: 'claude', selectedId: null, system: { id: null, label: 'System default', status: 'ready', email: state.email, plan: 'max' }, accounts: [] }],
      jobs: []
    })),
    usageScope: vi.fn(async (provider, accountId) => ({ ok: true, accountId, env: {}, expectedIdentity: null }))
  }
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const request = vi.fn(async (url) => {
    if (url === PROFILE_URL) return reply(state.answer)
    if (url === USAGE_URL) return usageReply ? usageReply() : reply({ five_hour: { utilization: 3, resets_at: '2026-10-16T15:00:00Z' } })
    return reply({}, 404)
  })
  const onChange = vi.fn()
  const file = path.join(home, 'userData', 'claude-plans.json')
  let plans = null
  const usage = createProviderUsage({
    accounts,
    home,
    env: {},
    request,
    log,
    clock: () => now,
    livePlan: (id) => plans.planOf(id),
    onNoSubscription: (id) => plans.noSubscription(id)
  })
  plans = createClaudePlanCheck({ file, accounts, usage, log, clock: () => now, onChange })
  return {
    usage,
    plans,
    request,
    log,
    onChange,
    file,
    accounts,
    state,
    tick: (ms) => {
      now += ms
    },
    shown: async () => (await plans.decorate(await accounts.list())).providers[0].system
  }
}
const profileCalls = (request) => request.mock.calls.filter(([url]) => url === PROFILE_URL)

describe('the kept fields and their words', () => {
  it('keeps only the plan fields of the profile, never a name, an email or a payment link', () => {
    const kept = subscriptionFields(PROFILES.canceled)
    expect(kept).toEqual({
      plan_display_name: null,
      organization_type: 'claude_free',
      rate_limit_tier: 'default_claude_ai',
      seat_tier: null,
      billing_type: 'none',
      subscription_status: 'canceled',
      has_claude_max: false,
      has_claude_pro: false,
      claude_code_trial_ends_at: null
    })
    expect(JSON.stringify(kept)).not.toMatch(/invoice|example\.invalid|Fixture|uuid/i)
    expect(subscriptionFields({ hello: 'world' })).toBeNull()
    // A kept copy with more in it (an older file, a host's answer) is cut back.
    const cleaned = cleanSubscription({ ...kept, checkedAt: T0, payment_auth_hosted_invoice_url: INVOICE, email: EMAIL })
    expect(Object.keys(cleaned)).not.toContain('payment_auth_hosted_invoice_url')
    expect(JSON.stringify(cleaned)).not.toContain('example.invalid')
    expect(cleanSubscription({ ...kept })).toBeNull() // when it was checked is required
  })

  it('names the plan as Claude does, and says what is wrong', () => {
    const at = (p) => ({ ...subscriptionFields(p), checkedAt: T0 })
    expect(subscriptionState(at(PROFILES.canceled), T0)).toMatchObject({ plan: 'Free', warn: 'none', attention: true })
    expect(subscriptionState(at(PROFILES.max20), T0)).toMatchObject({ plan: 'Max 20x', warn: null, attention: false })
    expect(subscriptionState(at(PROFILES.pro), T0)).toMatchObject({ plan: 'Pro', warn: null })
    expect(subscriptionState(at(PROFILES.pastDue), T0)).toMatchObject({ plan: 'Max 5x', warn: 'payment', attention: true })
    // A paid type whose subscription ended.
    expect(subscriptionState({ ...at(PROFILES.max20), subscription_status: 'canceled' }, T0)).toMatchObject({ plan: 'Max 20x', warn: 'canceled' })
    expect(subscriptionPlan({ organization_type: 'claude_team' })).toBe('Team')
    expect(subscriptionPlan({ organization_type: 'claude_enterprise' })).toBe('Enterprise')
    // A trial still running: shown with its end, no attention asked.
    const trial = subscriptionState({ ...at(PROFILES.canceled), claude_code_trial_ends_at: T0 + 7 * 86400_000 }, T0)
    expect(trial).toMatchObject({ warn: 'none', trialEndsAt: T0 + 7 * 86400_000, attention: false })
    expect(subscriptionState({ ...at(PROFILES.canceled), claude_code_trial_ends_at: T0 - 1000 }, T0).trialEndsAt).toBeNull()
  })
})

describe('the check of each Claude login', () => {
  it('a canceled Max: "Free", no subscription, over the login file’s "max"; the request is fixed, no redirect, no token kept or logged', async () => {
    const { plans, request, log, onChange, file, shown } = setup()
    expect(await plans.checkAll()).toEqual({ ok: true, checked: 1 })
    const calls = profileCalls(request)
    expect(calls).toHaveLength(1)
    const [, init] = calls[0]
    expect(init.method).toBe('GET')
    expect(init.redirect).toBe('error')
    expect(init.signal).toBeDefined()
    expect(init.headers).toMatchObject({ Authorization: 'Bearer fixture-secret-access', 'anthropic-beta': 'oauth-2025-04-20' })
    expect(request.mock.calls.some(([url, i]) => /token/.test(url) || i?.method === 'POST')).toBe(false)
    const system = await shown()
    expect(system.plan).toBe('max') // the login file's, still there
    expect(system.subscription).toMatchObject({ organization_type: 'claude_free', subscription_status: 'canceled', checkedAt: T0 })
    expect(subscriptionState(system.subscription, T0)).toMatchObject({ plan: 'Free', warn: 'none', attention: true })
    expect(plans.planOf(null)).toBe('Free')
    expect(onChange).toHaveBeenCalledTimes(1)
    await plans.saved()
    const kept = fs.readFileSync(file, 'utf8')
    expect(kept).toContain('claude_free')
    expect(kept).not.toMatch(/fixture-secret|example\.invalid|Fixture|invoice|payment_auth|uuid/i)
    const logged = JSON.stringify([log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls])
    expect(logged).not.toMatch(/fixture-secret|example\.invalid|invoice|claude_free|canceled/i)
    expect(JSON.stringify(system)).not.toMatch(/fixture-secret|invoice/i)
  })

  it('an active Max 20x and a Pro are named so; the usage read shows that plan', async () => {
    const max = setup({ answer: PROFILES.max20 })
    await max.plans.checkAll()
    expect(subscriptionState((await max.shown()).subscription, T0)).toMatchObject({ plan: 'Max 20x', warn: null, attention: false })
    expect(await max.usage.read({ provider: 'claude', accountId: null })).toMatchObject({ ok: true, plan: 'Max 20x' })
    max.state.answer = PROFILES.pro
    max.tick(2 * 60_000)
    await max.plans.checkAll()
    expect(subscriptionState((await max.shown()).subscription, T0)).toMatchObject({ plan: 'Pro', warn: null })
    expect(await max.usage.read({ provider: 'claude', accountId: null })).toMatchObject({ ok: true, plan: 'Pro' })
  })

  it('past due: a payment issue', async () => {
    const { plans, shown } = setup({ answer: PROFILES.pastDue })
    await plans.checkAll()
    expect(subscriptionState((await shown()).subscription, T0)).toMatchObject({ plan: 'Max 5x', warn: 'payment', attention: true })
  })

  it('an expired login is never used or refreshed: the last result stays, with when it was checked', async () => {
    const { plans, request, tick, shown, file } = setup({ answer: PROFILES.max20 })
    await plans.checkAll()
    await plans.saved()
    const before = fs.readFileSync(file, 'utf8')
    login({ expiresAt: T0 + 60_000 })
    tick(3 * 3600_000)
    expect(await plans.checkAll({ force: true })).toEqual({ ok: true, checked: 0 })
    expect(profileCalls(request)).toHaveLength(1)
    expect(request.mock.calls.some(([url, i]) => /token/.test(url) || i?.method === 'POST')).toBe(false)
    const system = await shown()
    expect(system.subscription).toMatchObject({ organization_type: 'claude_max', checkedAt: T0 })
    await plans.saved()
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
  })

  it('checks at most once a minute when the page opens; a forced one (after a sign-in) a little sooner', async () => {
    const { plans, request, tick } = setup()
    await plans.checkAll()
    await plans.checkAll()
    expect(profileCalls(request)).toHaveLength(1)
    tick(15_000)
    await plans.checkAll({ force: true })
    expect(profileCalls(request)).toHaveLength(2)
    tick(30_000)
    await plans.checkAll()
    expect(profileCalls(request)).toHaveLength(2)
  })

  it('a result kept for another account (another sign-in in that folder) is not shown for this one', async () => {
    const { plans, state, shown } = setup()
    await plans.checkAll()
    expect((await shown()).subscription).toBeTruthy()
    state.email = 'someone.else@example.invalid'
    expect((await shown()).subscription).toBeUndefined()
  })

  it('the email is kept as an HMAC with this install’s random key, never as a plain hash; an older result with another kind is dropped', async () => {
    const { plans, file, accounts } = setup()
    await plans.checkAll()
    await plans.saved()
    const secret = fs.readFileSync(path.join(path.dirname(file), 'claude-plans.key'), 'utf8').trim()
    expect(secret).toMatch(/^[0-9a-f]{64}$/)
    const kept = JSON.parse(fs.readFileSync(file, 'utf8')).accounts.system
    expect(kept.who).toBe(emailKey(EMAIL, secret))
    expect(kept.who).toMatch(/^[0-9a-f]{32}$/)
    const plain = createHash('sha256').update(EMAIL).digest('hex')
    expect(fs.readFileSync(file, 'utf8')).not.toContain(plain.slice(0, 16))
    expect(emailKey(EMAIL, 'ab'.repeat(32))).not.toBe(kept.who)
    expect(emailKey(EMAIL)).toBeNull()
    // A file from before (a plain 16-character hash): not shown for anyone.
    fs.writeFileSync(file, JSON.stringify({ version: 1, accounts: { system: { ...kept, who: plain.slice(0, 16) } } }))
    const again = createClaudePlanCheck({ file, accounts, usage: { claudeProfile: vi.fn() }, clock: () => T0 })
    expect((await again.decorate(await accounts.list())).providers[0].system.subscription).toBeUndefined()
  })

  it('kept in userData across a restart; what an edited file adds is dropped', async () => {
    const first = setup()
    await first.plans.checkAll()
    await first.plans.saved()
    const raw = JSON.parse(fs.readFileSync(first.file, 'utf8'))
    raw.accounts.system.payment_auth_hosted_invoice_url = INVOICE
    raw.accounts.system.email = EMAIL
    fs.writeFileSync(first.file, JSON.stringify(raw))
    const again = createClaudePlanCheck({ file: first.file, accounts: first.accounts, usage: { claudeProfile: vi.fn() }, clock: () => T0 })
    const list = await again.decorate(await first.accounts.list())
    const sub = list.providers[0].system.subscription
    expect(sub).toMatchObject({ organization_type: 'claude_free', checkedAt: T0 })
    expect(JSON.stringify(sub)).not.toMatch(/invoice|example\.invalid/)
  })

  it('after startup has settled, then every few hours (its timers never keep Tessel open)', async () => {
    const { usage, accounts } = setup()
    const timers = { setTimeout: vi.fn(() => ({ unref: vi.fn() })), clearTimeout: vi.fn(), setInterval: vi.fn(() => ({ unref: vi.fn() })), clearInterval: vi.fn() }
    const plans = createClaudePlanCheck({ file: path.join(home, 'p.json'), accounts, usage, timers, startDelayMs: 120_000, everyMs: 4 * 3600_000 })
    plans.start()
    expect(timers.setTimeout).toHaveBeenCalledWith(expect.any(Function), 120_000)
    timers.setTimeout.mock.calls[0][0]()
    expect(timers.setInterval).toHaveBeenCalledWith(expect.any(Function), 4 * 3600_000)
    plans.stop()
    expect(timers.clearInterval).toHaveBeenCalled()
  })
})

describe('a usage read refused for want of a subscription', () => {
  it('is "no usage limits" (not asserting no subscription), not a sign-in error; the plan is checked again at once, then not on every refusal', async () => {
    const refused = () => reply({ type: 'error', error: { type: 'permission_error', message: 'fixture-secret-detail' } }, 403)
    const { usage, plans, request, shown, log } = setup({ usageReply: refused })
    const result = await usage.read({ provider: 'claude', accountId: null })
    expect(result).toMatchObject({ ok: false, code: 'no-usage-limits' })
    expect(result.error).toMatch(/no usage limits/i)
    expect(result.error).not.toMatch(/subscription/i)
    expect(JSON.stringify(result)).not.toMatch(/fixture-secret/)
    await vi.waitFor(() => expect(profileCalls(request)).toHaveLength(1))
    await vi.waitFor(async () => expect((await shown()).subscription).toMatchObject({ organization_type: 'claude_free' }))
    // Already known to have none: the next refusal does not ask again.
    await usage.read({ provider: 'claude', accountId: null })
    await new Promise((r) => setTimeout(r, 20))
    expect(profileCalls(request)).toHaveLength(1)
    expect(JSON.stringify(log.info.mock.calls)).not.toMatch(/fixture-secret/)
    expect(plans.planOf(null)).toBe('Free')
  })

  it('another 403 stays a refused access', async () => {
    const other = () => reply({ type: 'error', error: { type: 'authentication_error' } }, 403)
    const { usage, request } = setup({ usageReply: other })
    expect(await usage.read({ provider: 'claude', accountId: null })).toMatchObject({ ok: false, code: 'auth' })
    await new Promise((r) => setTimeout(r, 20))
    expect(profileCalls(request)).toHaveLength(0)
  })
})

describe('the plan name the service gives', () => {
  const answer = (over = {}) => ({
    account: { has_claude_max: true, has_claude_pro: false },
    organization: { organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_20x', subscription_status: 'active', plan_display_name: 'Ultra', plan_display_label: 'Ultra plan', ...over }
  })

  it('a renamed plan shows its new name, its type and tier keeping their old words', () => {
    const fields = subscriptionFields(answer())
    expect(fields.plan_display_name).toBe('Ultra')
    expect(subscriptionPlan(fields)).toBe('Ultra')
    expect(subscriptionState(fields).plan).toBe('Ultra')
  })

  it('kept and read back from the cache', () => {
    const kept = cleanSubscription({ ...subscriptionFields(answer()), checkedAt: 1700000000000 })
    expect(kept.plan_display_name).toBe('Ultra')
    expect(subscriptionPlan(kept)).toBe('Ultra')
  })

  it('a copy kept before this field: the name from its type and tier', () => {
    const kept = cleanSubscription({ organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_20x', checkedAt: 1700000000000 })
    expect(kept.plan_display_name).toBe(null)
    expect(subscriptionPlan(kept)).toBe('Max 20x')
  })

  it('an answer without it, or with text that is not a plain name: the name from its type and tier', () => {
    for (const bad of [undefined, null, 7, '', '   ', '<b>Ultra</b>', 'Ultra\nplan', 'x'.repeat(41), 'https://example.com/plan']) {
      const fields = subscriptionFields(answer({ plan_display_name: bad }))
      expect(fields.plan_display_name).toBe(null)
      expect(subscriptionPlan(fields)).toBe('Max 20x')
    }
  })

  it('a name in any language, with its capitals', () => {
    expect(planDisplayName('Équipe Plus')).toBe('Équipe Plus')
    expect(planDisplayName('  Max 20x ')).toBe('Max 20x')
    expect(planDisplayName('Pro+')).toBe('Pro+')
  })

  it('warnings do not depend on the name', () => {
    const free = subscriptionFields(answer({ organization_type: 'claude_free', rate_limit_tier: null, plan_display_name: 'Gratuit' }))
    expect(subscriptionState(free)).toMatchObject({ plan: 'Gratuit', warn: 'none' })
    const ended = subscriptionFields(answer({ subscription_status: 'canceled' }))
    expect(subscriptionState(ended)).toMatchObject({ plan: 'Ultra', warn: 'canceled' })
    const named = subscriptionFields(answer({ plan_display_name: 'Free' }))
    expect(subscriptionState(named).warn).toBe(null)
  })
})
