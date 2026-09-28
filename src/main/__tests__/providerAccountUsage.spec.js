// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { createAccountUsage } from '../providerAccountUsage'

describe('usage follows the selected local account', () => {
  it('separates account caches and suppresses unbound Claude quota observations', async () => {
    let id = null,
      claudeId = null
    const accounts = {
      usageEnv: async () => ({
        ok: true,
        accountId: id,
        env: id ? { CODEX_HOME: `/managed/${id}` } : {}
      }),
      list: async () => ({ providers: [{ provider: 'claude', selectedId: claudeId }] })
    }
    const readUsage = vi.fn(async ({ env }) => ({
      agents: [
        { id: 'codex', windows: [], source: env.CODEX_HOME || 'system' },
        { id: 'claude', windows: [{ usedPct: 10 }] }
      ]
    }))
    const makeReport = vi.fn(({ env, userData }) => async (query) => ({
      ok: true,
      root: env.CODEX_HOME,
      userData,
      query
    }))
    const api = createAccountUsage({
      accounts,
      userData: '/fixture/data',
      home: '/fixture/home',
      env: {},
      readUsage,
      makeReport
    })
    expect((await api.usage()).agents[0].source).toBe('system')
    id = 'one'
    claudeId = 'claude-one'
    expect((await api.usage()).agents).toMatchObject([
      { accountId: 'one', source: '/managed/one' },
      { accountId: 'claude-one', windows: [] }
    ])
    const first = await api.report({ from: null })
    id = 'two'
    const second = await api.report()
    expect(first.userData).not.toBe(second.userData)
    expect(first.query).toEqual({ from: null })
    expect(second.accountId).toBe('two')
    id = 'one'
    await api.usage()
    expect(readUsage).toHaveBeenCalledTimes(2)
    expect(makeReport).toHaveBeenCalledTimes(3)
  })
  it('refuses a broken selected home rather than showing system account usage', async () => {
    const readUsage = vi.fn(),
      makeReport = vi.fn()
    const api = createAccountUsage({
      accounts: { usageEnv: async () => ({ ok: false, error: 'Account unavailable.' }) },
      userData: '/fixture/data',
      readUsage,
      makeReport
    })
    await expect(api.report()).rejects.toThrow('Account unavailable.')
    expect((await api.usage()).agents[0].error).toMatch(/selected Codex account/)
    expect(readUsage).not.toHaveBeenCalled()
    expect(makeReport).not.toHaveBeenCalled()
  })
})
