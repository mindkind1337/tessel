import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import ProviderAccounts from '../components/ProviderAccounts.vue'
import { setOpenPanesSource } from '../accountChoices'

const provider = (id = 'codex') => ({
  provider: id,
  selectedId: null,
  system: { id: null, label: 'System default', status: 'ready' },
  accounts: [
    {
      id: 'saved-1',
      label: 'Work',
      email: 'person@example.test',
      organization: 'Studio',
      plan: 'Pro',
      status: 'ready',
      lastLoginAt: '2026-09-27T14:00:00Z'
    }
  ]
})
const running = (extra = {}) => ({
  id: 'login-1',
  provider: 'codex',
  accountId: null,
  state: 'running',
  url: 'https://auth.openai.com/authorize?state=fixture',
  ...extra
})

describe('provider account management', () => {
  let wrapper, state, api, previousApi
  beforeEach(() => {
    previousApi = window.shellApi
    state = { ok: true, providers: [provider(), provider('claude')] }
    api = {
      list: vi.fn(async () => structuredClone(state)),
      select: vi.fn(async (id, accountId) => {
        state.providers.find((p) => p.provider === id).selectedId = accountId
        return { ok: true, restartRequired: id === 'claude' }
      }),
      remove: vi.fn(async (id, accountId) => {
        state.providers.find((p) => p.provider === id).accounts = []
        return { ok: true }
      }),
      startLogin: vi.fn(async () => ({ ok: true, job: running() })),
      loginStatus: vi.fn(async () => ({ ok: true, job: running() })),
      cancelLogin: vi.fn(async () => ({ ok: true, job: running({ state: 'cancelled' }) }))
    }
    window.shellApi = {
      accounts: api,
      openExternal: vi.fn(async () => ({ ok: true })),
      writeClipboard: vi.fn()
    }
  })
  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    window.shellApi = previousApi
    vi.useRealTimers()
  })
  async function render() {
    wrapper = mount(ProviderAccounts)
    await flushPromises()
    return wrapper
  }
  const section = (id = 'codex') => wrapper.get(`[data-provider="${id}"]`)
  const row = (id = 'saved-1', type = 'codex') => section(type).get(`[data-account="${id}"]`)

  it('shows identities, system default, current selection and provider-specific effect', async () => {
    await render()
    expect(wrapper.findAll('.account-row')).toHaveLength(4)
    expect(row('system').get('.account-select').attributes('aria-pressed')).toBe('true')
    expect(row().text()).toContain('person@example.test')
    expect(row().text()).toContain('Studio')
    expect(row().text()).toContain('Pro')
    expect(row().text()).toContain('Last signed in')
    expect(section().text()).toContain('New Codex terminals use the selected account')
    expect(section('claude').text()).toContain('Each Claude session keeps the account it started with')
    expect(section('claude').text()).toContain('shared between accounts')
    expect(section('claude').text()).not.toContain('restart Claude terminals')
    expect(row('system').find('[data-test="account-remove"]').exists()).toBe(false)
  })

  it('the system sign-in is not listed twice: hidden while the added account with its address is the one for new sessions', async () => {
    const claude = state.providers[1]
    claude.system = { id: null, label: 'System default', status: 'unknown', email: 'Person@example.test', organization: 'Studio', plan: 'max' }
    claude.selectedId = 'saved-1'
    await render()
    expect(section('claude').find('[data-account="system"]').exists()).toBe(false)
    expect(row('saved-1', 'claude').text()).toContain('New sessions')
    // Another account picked (or none): the system sign-in is a choice again.
    claude.selectedId = null
    wrapper.unmount()
    await render()
    expect(section('claude').find('[data-account="system"]').exists()).toBe(true)
    // A different address on the system side: both rows.
    claude.selectedId = 'saved-1'
    claude.system.email = 'other@example.test'
    wrapper.unmount()
    await render()
    expect(section('claude').find('[data-account="system"]').exists()).toBe(true)
  })

  it('shows the system sign-in with the same details as an added account', async () => {
    state.providers[1].system = { id: null, label: 'System default', status: 'ready', email: 'me@example.test', organization: 'Home org', plan: 'max' }
    await render()
    const system = row('system', 'claude')
    // Named by its address, tagged as the system sign-in.
    expect(system.text()).not.toContain('System default')
    expect(system.get('[data-test="account-system-tag"]').text()).toBe('System sign-in')
    expect(system.text()).toContain('me@example.test')
    expect(section('claude').get('[data-test="provider-status"]').text()).toBe('New sessions: me@example.test · Signed in')
    expect(system.text()).toContain('Home org')
    expect(system.text()).toContain('max')
    expect(system.text()).toContain('Signed in')
    expect(system.text()).not.toContain('Last signed in')
    expect(system.text()).toContain('New sessions')
  })

  it('a Claude account Anthropic reports with no subscription: "Free" and "No subscription", not the login file’s "max"; the row says it first', async () => {
    const at = Date.now() - 60_000
    state.providers[1].system = { id: null, label: 'System default', status: 'ready', email: 'me@example.test', plan: 'max', subscription: { organization_type: 'claude_free', subscription_status: 'canceled', has_claude_max: false, has_claude_pro: false, checkedAt: at } }
    state.providers[1].accounts[0] = { ...state.providers[1].accounts[0], plan: 'max', subscription: { organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_20x', subscription_status: 'active', has_claude_max: true, checkedAt: at } }
    let changed = null
    api.onPlansChanged = vi.fn((cb) => ((changed = cb), () => {}))
    await render()
    const system = row('system', 'claude')
    expect(system.get('[data-test="account-plan"]').text()).toBe('Free')
    expect(system.get('[data-test="account-plan-warn"]').text()).toBe('No subscription')
    expect(system.get('[data-test="account-plan"]').attributes('title')).toContain('checked')
    expect(system.text()).not.toContain('max')
    expect(row('saved-1', 'claude').get('[data-test="account-plan"]').text()).toBe('Max 20x')
    expect(row('saved-1', 'claude').find('[data-test="account-plan-warn"]').exists()).toBe(false)
    expect(section('claude').get('[data-test="provider-status"]').text()).toBe('New sessions: me@example.test · No subscription')
    // A check that changed something: the rows read again.
    const calls = api.list.mock.calls.length
    changed()
    await flushPromises()
    expect(api.list.mock.calls.length).toBe(calls + 1)
  })

  it('says a Claude default changes only new sessions', async () => {
    await render()
    await row('saved-1', 'claude').get('.account-select').trigger('click')
    await flushPromises()
    expect(api.select).toHaveBeenCalledWith('claude', 'saved-1')
    expect(wrapper.text()).toContain('New Claude sessions will use this account; open ones keep theirs.')
    expect(wrapper.text()).not.toContain('Restart your Claude terminals')
  })

  it('warns before removing an account open panes run on', async () => {
    setOpenPanesSource(() => [
      { agentId: 'claude', accountId: 'saved-1' },
      { agentId: 'claude', accountId: 'saved-1' },
      { agentId: 'claude', accountId: null },
      { agentId: 'codex', accountId: 'saved-1' }
    ])
    try {
      await render()
      await row('saved-1', 'claude').get('[data-test="account-remove"]').trigger('click')
      expect(section('claude').get('[data-test="account-remove-in-use"]').text()).toContain('2 open panes run on this account')
      await section('claude').get('[data-test="account-remove-cancel"]').trigger('click')
      setOpenPanesSource(() => [{ agentId: 'claude', accountId: null }])
      await row('saved-1', 'claude').get('[data-test="account-remove"]').trigger('click')
      expect(section('claude').find('[data-test="account-remove-in-use"]').exists()).toBe(false)
    } finally {
      setOpenPanesSource(null)
    }
  })

  it('says that added accounts keep their sign-in unencrypted, only when there are some', async () => {
    state.providers[1].accounts = []
    await render()
    expect(section().get('[data-test="accounts-unsealed"]').text()).toContain('stored unencrypted')
    expect(section().get('[data-test="accounts-unsealed"]').text()).toContain('Codex')
    expect(section('claude').find('[data-test="accounts-unsealed"]').exists()).toBe(false)
  })

  it('shows one row per provider with the account in use; its accounts stay folded until Details', async () => {
    await render()
    const details = () => section().get('[data-test="provider-details"]')
    expect(section().get('[data-test="provider-status"]').text()).toBe('New sessions: System default · Signed in')
    expect(section().get('[data-test="provider-status"]').classes()).toContain('ok')
    expect(details().attributes('style')).toContain('display: none')
    const toggle = section().get('[data-test="provider-details-toggle"]')
    expect(toggle.attributes('aria-expanded')).toBe('false')
    await toggle.trigger('click')
    expect(toggle.attributes('aria-expanded')).toBe('true')
    expect(details().attributes('style') || '').not.toContain('display: none')
    await toggle.trigger('click')
    expect(details().attributes('style')).toContain('display: none')
  })

  it('opens the details by themselves when the account in use needs a sign-in', async () => {
    state.providers[0].selectedId = 'saved-1'
    state.providers[0].accounts[0].status = 'missing'
    await render()
    expect(section().get('[data-test="provider-status"]').text()).toBe('New sessions: Work · Sign-in needed')
    expect(section().get('[data-test="provider-status"]').classes()).toContain('warn')
    expect(section().get('[data-test="provider-details-toggle"]').attributes('aria-expanded')).toBe('true')
    expect(section('claude').get('[data-test="provider-details-toggle"]').attributes('aria-expanded')).toBe('false')
  })

  it('switches explicitly, confirms persisted selection and announces the change', async () => {
    const changed = vi.fn()
    window.addEventListener('tessel:accounts-changed', changed)
    await render()
    await row().get('.account-select').trigger('click')
    await flushPromises()
    expect(api.select).toHaveBeenCalledWith('codex', 'saved-1')
    expect(row().get('.account-select').attributes('aria-pressed')).toBe('true')
    expect(wrapper.text()).toContain('New Codex terminals will use this selection')
    expect(changed).toHaveBeenCalledTimes(1)
    expect(wrapper.emitted('changed')).toEqual([['codex']])
    await row('system').get('.account-select').trigger('click')
    await flushPromises()
    expect(api.select).toHaveBeenLastCalledWith('codex', null)
    window.removeEventListener('tessel:accounts-changed', changed)
  })

  it('preserves rows and selected state when switching fails; retry remains available', async () => {
    api.select.mockResolvedValueOnce({ ok: false, error: 'Credentials are locked' })
    await render()
    await row().get('.account-select').trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('Credentials are locked')
    expect(row('system').get('.account-select').attributes('aria-pressed')).toBe('true')
    expect(row().get('.account-select').element.disabled).toBe(false)
    expect(wrapper.findAll('.account-row')).toHaveLength(4)
  })

  it('requires inline confirmation and describes loss of local Codex history', async () => {
    await render()
    await row().get('[data-test="account-remove"]').trigger('click')
    expect(api.remove).not.toHaveBeenCalled()
    expect(section().get('.account-confirm').text()).toContain('local Codex history')
    expect(section().get('.account-confirm').text()).toContain('OpenAI account is kept')
    await section().get('[data-test="account-remove-cancel"]').trigger('click')
    expect(api.remove).not.toHaveBeenCalled()
    await row().get('[data-test="account-remove"]').trigger('click')
    api.remove.mockResolvedValueOnce({ ok: false, error: 'Cannot remove a locked account' })
    await section().get('[data-test="account-remove-confirm"]').trigger('click')
    await flushPromises()
    expect(row().exists()).toBe(true)
    expect(section().find('.account-confirm').exists()).toBe(true)
    await section().get('[data-test="account-remove-confirm"]').trigger('click')
    await flushPromises()
    expect(api.remove).toHaveBeenCalledWith('codex', 'saved-1')
    expect(section().find('[data-account="saved-1"]').exists()).toBe(false)
  })

  it('starts reauthentication with the saved id and refreshes on completion', async () => {
    vi.useFakeTimers()
    await render()
    await row().get('[data-test="account-reauth"]').trigger('click')
    await flushPromises()
    expect(api.startLogin).toHaveBeenCalledWith('codex', 'saved-1')
    expect(section().get('[data-test="account-add"]').element.disabled).toBe(true)
    api.loginStatus.mockResolvedValueOnce({ ok: true, job: running({ state: 'done' }) })
    await vi.advanceTimersByTimeAsync(1000)
    await flushPromises()
    expect(api.list).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).toContain('account saved')
    expect(section().get('[data-test="account-add"]').element.disabled).toBe(false)
    await vi.advanceTimersByTimeAsync(5000)
    expect(api.loginStatus).toHaveBeenCalledTimes(1)
  })

  it('uses the approved HTTPS login link for open/copy and never renders CLI output', async () => {
    vi.useFakeTimers()
    await render()
    await section().get('[data-test="account-add"]').trigger('click')
    await flushPromises()
    await section().get('[data-test="account-login-open"]').trigger('click')
    await section().get('[data-test="account-login-copy"]').trigger('click')
    await flushPromises()
    expect(window.shellApi.openExternal).toHaveBeenCalledWith(running().url)
    expect(window.shellApi.writeClipboard).toHaveBeenCalledWith(running().url)
    expect(section().text()).toContain('Link copied')
    expect(wrapper.text()).not.toContain('state=fixture')
  })

  it('does not offer a malformed or non-HTTPS login URL', async () => {
    vi.useFakeTimers()
    api.startLogin.mockResolvedValue({ ok: true, job: running({ url: 'javascript:alert(1)' }) })
    await render()
    await section().get('[data-test="account-add"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="account-login-open"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="account-login-copy"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="account-login-cancel"]').exists()).toBe(true)
  })

  it('keeps cancellation pending until the backend job exits', async () => {
    vi.useFakeTimers()
    state.jobs = [running()]
    api.cancelLogin.mockResolvedValueOnce({ ok: true, job: running({ cancelling: true }) })
    await render()
    await section().get('[data-test="account-login-cancel"]').trigger('click')
    await flushPromises()
    expect(api.cancelLogin).toHaveBeenCalledWith('login-1')
    expect(section().get('[data-test="account-login-cancel"]').text()).toContain('Cancelling')
    expect(section().get('[data-test="account-login-cancel"]').element.disabled).toBe(true)
    api.loginStatus.mockResolvedValueOnce({ ok: true, job: running({ state: 'cancelled' }) })
    await vi.advanceTimersByTimeAsync(1000)
    expect(section().text()).toContain('Sign-in cancelled')
    expect(section().get('[data-test="account-add"]').element.disabled).toBe(false)
  })

  it('restores a running job when reopened and clears polling without cancelling on close', async () => {
    vi.useFakeTimers()
    state.jobs = [running()]
    await render()
    expect(section().find('[data-test="account-login-open"]').exists()).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(api.loginStatus).toHaveBeenCalledTimes(1)
    wrapper.unmount()
    wrapper = null
    await vi.advanceTimersByTimeAsync(5000)
    expect(api.loginStatus).toHaveBeenCalledTimes(1)
    expect(api.cancelLogin).not.toHaveBeenCalled()
    await render()
    expect(section().text()).toContain('Waiting for Codex sign-in')
  })

  it('shows a sign-in failure that completed while Settings was closed', async () => {
    state.jobs = [running({ state: 'error', url: null, error: 'The sign-in timed out.' })]
    await render()
    expect(section().get('[role="alert"]').text()).toContain('The sign-in timed out')
    expect(section().get('[data-test="account-add"]').element.disabled).toBe(false)
  })

  it('does not resurrect a cancelled job when an older status request finishes late', async () => {
    vi.useFakeTimers()
    state.jobs = [running()]
    let finishStatus
    api.loginStatus.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishStatus = resolve
        })
    )
    await render()
    await vi.advanceTimersByTimeAsync(1000)
    await section().get('[data-test="account-login-cancel"]').trigger('click')
    await flushPromises()
    finishStatus({ ok: true, job: running() })
    await flushPromises()
    expect(section().text()).toContain('Sign-in cancelled')
    expect(section().find('[data-test="account-login-open"]').exists()).toBe(false)
    await vi.advanceTimersByTimeAsync(3000)
    expect(api.loginStatus).toHaveBeenCalledTimes(1)
  })

  it('keeps existing rows disabled after a provider read error and recovers on Retry', async () => {
    await render()
    api.list.mockResolvedValueOnce({
      ok: true,
      providers: [
        { provider: 'codex', accounts: [], status: 'unknown', error: 'Home is locked' },
        provider('claude')
      ]
    })
    await row().get('.account-select').trigger('click')
    await flushPromises()
    expect(row().exists()).toBe(true)
    expect(row().get('.account-select').element.disabled).toBe(true)
    expect(section().get('[role="alert"]').text()).toContain('Home is locked')
    await section().get('[data-test="provider-retry"]').trigger('click')
    await flushPromises()
    expect(row().get('.account-select').element.disabled).toBe(false)
    expect(row().get('.account-select').attributes('aria-pressed')).toBe('true')
  })

  it('shows an error state without fabricating an empty system account after initial read failure', async () => {
    state.providers = [
      { provider: 'codex', accounts: [], error: 'Permission denied', status: 'unknown' }
    ]
    await render()
    expect(wrapper.text()).toContain('Permission denied')
    expect(wrapper.find('.account-row').exists()).toBe(false)
    expect(section().get('[data-test="account-add"]').element.disabled).toBe(true)
  })

  it('is compatible with older preload APIs', async () => {
    window.shellApi = {}
    await render()
    expect(wrapper.text()).toContain('not available in this version')
    expect(wrapper.find('button').exists()).toBe(false)
  })

  it('keeps a successful removal warning visible instead of hiding it behind success', async () => {
    api.remove.mockResolvedValueOnce({
      ok: true,
      warning: 'Some local account files could not be deleted.'
    })
    await render()
    await row().get('[data-test="account-remove"]').trigger('click')
    await section().get('[data-test="account-remove-confirm"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('.accounts-notice').text()).toContain(
      'Some local account files could not be deleted'
    )
    expect(section().find('.account-confirm').exists()).toBe(false)
  })

  it('one verb for its details; actions are bordered buttons, Remove a danger one; the unencrypted note a warning', async () => {
    await render()
    expect(section().get('[data-test="provider-details-toggle"]').text()).toBe('Details')
    expect(row().get('[data-test="account-reauth"]').classes()).toEqual(expect.arrayContaining(['exit-btn', 'small']))
    expect(row().get('[data-test="account-remove"]').classes()).toEqual(expect.arrayContaining(['exit-btn', 'small', 'danger']))
    expect(section().get('[data-test="accounts-unsealed"]').classes()).toEqual(expect.arrayContaining(['set-callout', 'warn']))
  })

  it('while the accounts are read: placeholder rows, never an empty list', async () => {
    let answer
    api.list.mockImplementationOnce(() => new Promise((r) => (answer = r)))
    wrapper = mount(ProviderAccounts)
    await flushPromises()
    expect(wrapper.findAll('[data-test="accounts-skeleton"]')).toHaveLength(2)
    expect(wrapper.find('[data-provider]').exists()).toBe(false)
    answer(structuredClone(state))
    await flushPromises()
    expect(wrapper.find('[data-test="accounts-skeleton"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-provider]')).toHaveLength(2)
  })

  it('a failed first read: one sentence with Retry, the raw message behind Details, the rows still listed', async () => {
    api.list.mockRejectedValueOnce(new Error('EACCES: permission denied, open accounts.json'))
    await render()
    const error = wrapper.get('[data-test="accounts-load-error"]')
    expect(error.get('[data-test="panel-error-text"]').text()).toBe('Could not read your accounts.')
    expect(error.get('details').text()).toContain('EACCES')
    expect(error.get('details').attributes('open')).toBeUndefined()
    expect(section('claude').get('[data-test="provider-status"]').text()).toBe('Accounts could not be read')
    expect(section('codex').get('[data-test="account-add"]').element.disabled).toBe(true)
    await error.get('[data-test="panel-retry"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="accounts-load-error"]').exists()).toBe(false)
    expect(wrapper.findAll('.account-row')).toHaveLength(4)
  })

  it('a refresh that fails keeps the rows read before, with the error above them', async () => {
    await render()
    api.list.mockRejectedValueOnce(new Error('EBUSY'))
    await row().get('.account-select').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="accounts-load-error"]').exists()).toBe(true)
    expect(wrapper.findAll('.account-row')).toHaveLength(4)
  })
})
