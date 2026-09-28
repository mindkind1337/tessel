import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import UsageMenu from '../components/UsageMenu.vue'

describe('usage menu account switching', () => {
  let wrapper, api, state, previousApi
  beforeEach(() => {
    previousApi = window.shellApi
    state = {
      ok: true,
      providers: [
        {
          provider: 'codex',
          selectedId: null,
          system: { label: 'System default', status: 'ready' },
          accounts: [{ id: 'work', label: 'Work', status: 'ready' }]
        }
      ]
    }
    api = {
      getUsage: vi.fn(async () => ({ agents: [{ id: 'codex', windows: [] }] })),
      accounts: {
        list: vi.fn(async () => structuredClone(state)),
        select: vi.fn(async (provider, id) => {
          state.providers[0].selectedId = id
          return { ok: true }
        })
      }
    }
    window.shellApi = api
  })
  afterEach(() => {
    wrapper?.unmount()
    window.shellApi = previousApi
  })
  async function open() {
    wrapper = mount(UsageMenu)
    await flushPromises()
    expect(api.accounts.list).not.toHaveBeenCalled()
    await wrapper.get('[data-test="usage-button"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-test="usage-row-codex"]').trigger('click')
  }
  it('loads accounts only on opening and refreshes usage after a successful selection', async () => {
    await open()
    const before = api.getUsage.mock.calls.length
    const select = wrapper.get('[data-test="usage-account-codex"]')
    expect(select.element.value).toBe('')
    await select.setValue('work')
    await flushPromises()
    expect(api.accounts.select).toHaveBeenCalledWith('codex', 'work')
    expect(select.element.value).toBe('work')
    expect(api.getUsage.mock.calls.length).toBe(before + 1)
    expect(wrapper.text()).toContain('New Codex terminals will use this account')
    await select.setValue('')
    await flushPromises()
    expect(api.accounts.select).toHaveBeenLastCalledWith('codex', null)
  })
  it('retains the confirmed account on failed selection and permits a retry', async () => {
    api.accounts.select.mockResolvedValueOnce({ ok: false, error: 'Could not save selection' })
    await open()
    const select = wrapper.get('[data-test="usage-account-codex"]')
    await select.setValue('work')
    await flushPromises()
    expect(select.element.value).toBe('')
    expect(select.element.disabled).toBe(false)
    expect(wrapper.get('[role="alert"]').text()).toContain('Could not save selection')
    await select.setValue('work')
    await flushPromises()
    expect(select.element.value).toBe('work')
  })
  it('offers a Settings navigation event and refreshes when another account view changes', async () => {
    await open()
    const before = api.accounts.list.mock.calls.length
    window.dispatchEvent(
      new CustomEvent('tessel:accounts-changed', { detail: { provider: 'codex' } })
    )
    await flushPromises()
    expect(api.accounts.list.mock.calls.length).toBe(before + 1)
    await wrapper.get('[data-test="usage-manage-accounts"]').trigger('click')
    expect(wrapper.emitted('accounts')).toHaveLength(1)
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
  })
  it('retains existing options and exposes Retry after a read failure', async () => {
    await open()
    api.accounts.list.mockResolvedValueOnce({ ok: false, error: 'Registry locked' })
    window.dispatchEvent(new CustomEvent('tessel:accounts-changed'))
    await flushPromises()
    expect(wrapper.get('select').findAll('option')).toHaveLength(2)
    expect(wrapper.get('select').element.disabled).toBe(true)
    await wrapper.get('[data-test="usage-accounts-retry"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('select').element.disabled).toBe(false)
  })

  it('does not overwrite the new account quota with an old request that finishes late', async () => {
    let finishOldUsage
    api.getUsage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOldUsage = resolve
        })
    )
    await open()
    api.getUsage.mockResolvedValue({
      agents: [{ id: 'codex', windows: [{ label: 'week', usedPct: 10 }] }]
    })
    await wrapper.get('[data-test="usage-account-codex"]').setValue('work')
    await flushPromises()
    finishOldUsage({ agents: [{ id: 'codex', windows: [{ label: 'week', usedPct: 99 }] }] })
    await flushPromises()
    expect(wrapper.get('.usage-pct').text()).toBe('10%')
  })
})
