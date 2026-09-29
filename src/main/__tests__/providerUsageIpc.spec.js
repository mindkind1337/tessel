// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
vi.mock('../providerUsage', async (original) => ({
  ...(await original()),
  createProviderUsage: vi.fn()
}))
import { registerProviderUsage } from '../providerUsageIpc'

function setup() {
  const handlers = new Map()
  const order = []
  const service = {
    read: vi.fn(async () => ({ ok: true, windows: [] })),
    redeemReset: vi.fn(async () => ({ ok: true, outcome: 'reset' })),
    invalidate: vi.fn((provider) => order.push(['invalidate', provider]))
  }
  const accounts = Object.fromEntries(
    ['select', 'remove', 'startLogin', 'cancelLogin'].map((name) => [
      name,
      vi.fn(async (...args) => {
        order.push([name, ...args])
        return { ok: true }
      })
    ])
  )
  registerProviderUsage({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    accounts,
    service
  })
  return { handlers, service, accounts, order }
}

describe('provider usage IPC', () => {
  it('does no reads at registration and forwards only explicit requests', async () => {
    const { handlers, service } = setup()
    expect(service.read).not.toHaveBeenCalled()
    expect(service.redeemReset).not.toHaveBeenCalled()
    const query = { provider: 'codex', accountId: null }
    await handlers.get('providerUsage:read')(null, query)
    expect(service.read).toHaveBeenCalledExactlyOnceWith(query)
    const confirmation = { ...query, resetToken: 'opaque', confirmed: true }
    await handlers.get('providerUsage:redeemReset')(null, confirmation)
    expect(service.redeemReset).toHaveBeenCalledExactlyOnceWith(confirmation)
  })

  it.each(['select', 'remove', 'startLogin'])(
    'revokes confirmations before %s, even if that mutation fails',
    async (name) => {
      const { handlers, accounts, order } = setup()
      accounts[name].mockImplementation(async (...args) => {
        order.push([name, ...args])
        throw new Error('private credential material')
      })
      const result = await handlers.get(`accounts:${name}`)(null, { provider: 'codex', id: 'work' })
      expect(order).toEqual([
        ['invalidate', 'codex'],
        [name, 'codex', 'work']
      ])
      expect(result).toEqual({ ok: false, error: 'Could not update the provider account.' })
    }
  )

  it('revokes both providers when a login job is cancelled', async () => {
    const { handlers, order } = setup()
    await handlers.get('accounts:cancelLogin')(null, 'job-1')
    expect(order).toEqual([
      ['invalidate', undefined],
      ['cancelLogin', 'job-1']
    ])
  })

  it('does not expose unexpected errors containing credentials', async () => {
    const { handlers, service } = setup()
    service.read.mockRejectedValue(new Error('Authorization: Bearer fixture-secret'))
    service.redeemReset.mockRejectedValue(new Error('fixture-secret'))
    const read = await handlers.get('providerUsage:read')(null, { provider: 'codex' })
    const reset = await handlers.get('providerUsage:redeemReset')(null, { provider: 'codex' })
    expect(read).toEqual({ ok: false, error: 'Could not read provider usage.' })
    expect(reset.ok).toBe(false)
    expect(JSON.stringify(reset)).not.toContain('fixture-secret')
  })

  it('configures the automatic refresh with valid providers only, and forgets on a switch', async () => {
    const handlers = new Map()
    const poller = { configure: vi.fn(() => ({ ok: true })), read: vi.fn(), forget: vi.fn() }
    const accounts = { select: vi.fn(async () => ({ ok: true })) }
    registerProviderUsage({
      ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
      accounts,
      service: { read: vi.fn(), invalidate: vi.fn() },
      poller
    })
    await handlers.get('providerUsage:autoRefresh')(null, { hidden: ['kimi', 'nope'], intervalMs: 0 })
    expect(poller.configure).toHaveBeenCalledWith({ hidden: ['kimi'], intervalMs: 0 })
    await handlers.get('providerUsage:read')(null, { provider: 'kimi', accountId: null })
    expect(poller.read).toHaveBeenCalledWith({ provider: 'kimi', accountId: null })
    await handlers.get('accounts:select')(null, { provider: 'claude', id: 'work' })
    expect(poller.forget).toHaveBeenCalledWith('claude')
  })
})

