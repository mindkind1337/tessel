// @vitest-environment node
// Claude's plan in the Usage modal, from the two fields Claude Code keeps in
// its login file (claudeAiOauth.subscriptionType, rateLimitTier). Fixture
// files in a temporary HOME only: the real ~/.claude is never read.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createProviderUsage, claudePlanLabel } from '../providerUsage'

const claudeData = {
  five_hour: { utilization: 12, resets_at: '2026-09-28T23:00:00Z' },
  seven_day: { utilization: 35, resets_at: '2026-09-30T23:00:00Z' }
}
const reply = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })

let home
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tessel-claude-plan-'))
})
afterEach(() => {
  const target = path.resolve(home)
  if (!target.startsWith(path.resolve(os.tmpdir()) + path.sep) || !target.includes('tessel-claude-plan-'))
    throw new Error('Unexpected cleanup path')
  fs.rmSync(target, { recursive: true, force: true })
})

function login(dir, oauth) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-secret-token', refreshToken: 'fixture-refresh', ...oauth } })
  )
}
const identity = { accountUuid: 'acc-1', emailAddress: 'fixture@example.invalid', organizationUuid: 'org-1' }
function service({ managedDir = null, status = 200 } = {}) {
  const selected = { id: null }
  const accounts = {
    list: vi.fn(async () => ({
      ok: true,
      providers: [
        {
          provider: 'claude',
          selectedId: selected.id,
          system: { id: null, status: 'ready' },
          accounts: [{ id: 'managed-a', status: 'ready' }]
        }
      ],
      jobs: []
    })),
    usageScope: vi.fn(async (provider, accountId) => ({
      ok: true,
      accountId,
      env: accountId ? { CLAUDE_CONFIG_DIR: managedDir } : {},
      expectedIdentity: accountId
        ? { account: identity.accountUuid, email: identity.emailAddress, organization: identity.organizationUuid }
        : null
    }))
  }
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const request = vi.fn(async () => reply(status === 200 ? claudeData : { error: 'busy' }, status))
  return { usage: createProviderUsage({ accounts, home, env: {}, request, log }), log, request, selected }
}

describe("Claude's plan label", () => {
  it('reads the plan and tier as Claude Code names them', () => {
    expect(claudePlanLabel('max', 'default_claude_max_20x')).toBe('Max 20x')
    expect(claudePlanLabel('max', 'default_claude_max_5x')).toBe('Max 5x')
    expect(claudePlanLabel('max', null)).toBe('Max')
    expect(claudePlanLabel('pro', 'default_claude_ai')).toBe('Pro')
    expect(claudePlanLabel('Team', undefined)).toBe('Team')
    expect(claudePlanLabel('something-else', 'default_claude_max_20x')).toBeUndefined()
    expect(claudePlanLabel(null, null)).toBeUndefined()
  })

  it("shows the system login's plan (Max 20x) and never logs the fields' values or the token", async () => {
    login(path.join(home, '.claude'), { subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' })
    const { usage, log, request } = service()
    const result = await usage.read({ provider: 'claude', accountId: null })
    expect(result).toMatchObject({ ok: true, plan: 'Max 20x' })
    const logged = JSON.stringify([log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls])
    expect(logged).not.toMatch(/20x|default_claude|subscriptionType|fixture-secret|fixture-refresh/)
    expect(JSON.stringify(result)).not.toMatch(/fixture-secret|fixture-refresh|default_claude/)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('shows Pro, and keeps the plan when the usage service fails', async () => {
    login(path.join(home, '.claude'), { subscriptionType: 'pro', rateLimitTier: 'default_claude_ai' })
    const { usage } = service({ status: 503 })
    const result = await usage.read({ provider: 'claude', accountId: null })
    expect(result.ok).toBe(false)
    expect(result.plan).toBe('Pro')
  })

  it("a managed account's plan comes from its own config dir", async () => {
    login(path.join(home, '.claude'), { subscriptionType: 'pro' })
    const managedDir = path.join(home, 'accounts', 'managed-a')
    login(managedDir, { subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x', ...identity })
    fs.writeFileSync(path.join(managedDir, '.claude.json'), JSON.stringify({ oauthAccount: identity }))
    const { usage, selected } = service({ managedDir })
    selected.id = 'managed-a'
    expect(await usage.read({ provider: 'claude', accountId: 'managed-a' })).toMatchObject({ ok: true, plan: 'Max 5x' })
    selected.id = null
    expect(await usage.read({ provider: 'claude', accountId: null })).toMatchObject({ ok: true, plan: 'Pro' })
  })

  it('shows no plan when the login file does not say it', async () => {
    login(path.join(home, '.claude'), {})
    const { usage } = service()
    const result = await usage.read({ provider: 'claude', accountId: null })
    expect(result.ok).toBe(true)
    expect(result.plan).toBeUndefined()
  })
})
