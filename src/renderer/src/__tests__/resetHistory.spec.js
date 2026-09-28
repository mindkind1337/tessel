import { afterEach, describe, it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import ResetHistory from '../components/ResetHistory.vue'
let wrapper
const previous = window.shellApi
afterEach(() => {
  wrapper?.unmount()
  window.shellApi = previous
})
const row = {
  id: 'one',
  at: 1780000000000,
  provider: 'codex',
  accountId: 'work',
  accountLabel: 'Work',
  outcome: 'reset',
  creditsBefore: 2,
  creditsAfter: 1,
  windows: [{ label: 'Weekly', usedPct: 90 }]
}
function api() {
  window.shellApi = {
    accounts: {
      list: vi.fn(async () => ({
        ok: true,
        providers: [
          { provider: 'codex', selectedId: 'work', accounts: [{ id: 'work', label: 'Work' }] }
        ]
      }))
    },
    providerUsage: {
      resetHistory: vi.fn(async () => ({ ok: true, entries: [row] })),
      creditHistory: vi.fn(async (query) => ({
        ok: true,
        ...query,
        available: true,
        entries: [{ status: 'consumed', grantedAt: 1780000000000, expiresAt: null }]
      }))
    }
  }
  return window.shellApi
}
describe('reset history UI', () => {
  it('loads local history on open, only reads provider records on click', async () => {
    const mock = api()
    wrapper = mount(ResetHistory)
    await flushPromises()
    expect(wrapper.text()).toContain('Limits reset')
    expect(wrapper.text()).toContain('Credits: 2 → 1')
    expect(mock.providerUsage.creditHistory).not.toHaveBeenCalled()
    await wrapper.get('[data-test="reset-provider-credits"]').trigger('click')
    await flushPromises()
    expect(mock.providerUsage.creditHistory).toHaveBeenCalledExactlyOnceWith({
      provider: 'codex',
      accountId: 'work'
    })
    expect(wrapper.text()).toContain('consumed')
    expect(wrapper.text()).toContain('grant and expiry dates are not reset dates')
  })
  it('keeps the compact flyout closed initially and filters the system account explicitly', async () => {
    const mock = api()
    wrapper = mount(ResetHistory, { props: { compact: true, provider: 'codex', accountId: null } })
    await flushPromises()
    expect(mock.providerUsage.resetHistory).not.toHaveBeenCalled()
    await wrapper.get('.rh-title').trigger('click')
    await flushPromises()
    expect(mock.providerUsage.resetHistory).toHaveBeenCalledWith({
      provider: 'codex',
      accountId: null
    })
  })
  it('ignores late account responses and reloads after a reset', async () => {
    const mock = api()
    let release
    mock.providerUsage.resetHistory.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    wrapper = mount(ResetHistory, { props: { accountId: 'a' } })
    await wrapper.setProps({ accountId: 'work' })
    await flushPromises()
    release({ ok: true, entries: [{ ...row, accountLabel: 'Wrong account' }] })
    await flushPromises()
    expect(wrapper.text()).not.toContain('Wrong account')
    await wrapper.setProps({ revision: 1 })
    await flushPromises()
    expect(mock.providerUsage.resetHistory).toHaveBeenCalledTimes(3)
  })
  it('shows uncertain and missing observations honestly, plus read errors', async () => {
    const mock = api()
    mock.providerUsage.resetHistory.mockResolvedValueOnce({
      ok: true,
      entries: [{ ...row, outcome: 'pending', uncertain: true, creditsAfter: null }]
    })
    wrapper = mount(ResetHistory)
    await flushPromises()
    expect(wrapper.text()).toContain('Result unknown')
    expect(wrapper.text()).toContain('Credits: 2 → Unknown')
    mock.providerUsage.resetHistory.mockResolvedValueOnce({ ok: false, error: 'Read failed' })
    await wrapper.get('.rh-heading .rh-button').trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toBe('Read failed')
  })
})
