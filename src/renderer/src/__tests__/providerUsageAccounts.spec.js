import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import ProviderUsageAccounts from '../components/ProviderUsageAccounts.vue'
import ThemedSelect from '../components/ui/ThemedSelect.vue'

const status = (extra = {}) => ({
  ok: true,
  secure: true,
  saved: { minimaxApiKey: false, minimaxCookie: false, opencodeGoApiKey: false, opencodeCookie: false },
  settings: {
    geminiCliOAuth: false,
    opencodeWorkspaceId: '',
    minimaxEndpoint: 'overseas',
    minimaxGroupId: '',
    minimaxUsageModels: 'general'
  },
  cursor: { signedIn: true, email: 'person@example.test', credentialSource: 'cli', tokenFresh: true, error: null },
  grok: { signedIn: false, email: null, tokenFresh: false, error: null },
  ...extra
})

describe('usage-only provider sections', () => {
  let wrapper, previous, api, state, usageRead, agents
  beforeEach(() => {
    previous = window.shellApi
    state = status()
    agents = ['cursor', 'grok', 'gemini', 'opencode', 'claude']
    api = {
      status: vi.fn(async () => structuredClone(state)),
      saveSecret: vi.fn(async (name) => {
        state.saved[name] = true
        return structuredClone(state)
      }),
      clearSecret: vi.fn(async (name) => {
        state.saved[name] = false
        return structuredClone(state)
      }),
      update: vi.fn(async (patch) => {
        if (patch.minimaxEndpoint === 'mars') return { ok: false, error: 'Paste a valid value.' }
        Object.assign(state.settings, patch)
        return structuredClone(state)
      })
    }
    usageRead = vi.fn(async ({ provider }) =>
      provider === 'cursor'
        ? { ok: true, provider, accountId: null, windows: [{ label: 'Monthly', usedPct: 42.4, resetsAt: Date.parse('2026-10-20T00:00:00Z') }, { label: 'Cursor models', usedPct: 10, resetsAt: null }] }
        : { ok: false, provider, accountId: null, code: 'unavailable', error: 'No usage.' }
    )
    window.shellApi = {
      providerSettings: api,
      providerUsage: { read: usageRead, onUpdate: vi.fn(() => () => {}) },
      listAgents: vi.fn(async () => agents.map((id) => ({ id, available: true }))),
      openExternal: vi.fn(async () => ({ ok: true }))
    }
  })
  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    window.shellApi = previous
  })
  const mountIt = async () => {
    wrapper = mount(ProviderUsageAccounts)
    await flushPromises()
    await flushPromises()
  }

  it('shows one row per provider in Orca’s order for the installed agents, the others on one line', async () => {
    await mountIt()
    expect(wrapper.findAll('[data-provider]').map((s) => s.attributes('data-provider'))).toEqual([
      'gemini',
      'opencode-go',
      'minimax',
      'grok',
      'cursor'
    ])
    wrapper.unmount()
    agents = ['claude']
    state.cursor.signedIn = false
    await mountIt()
    expect(wrapper.findAll('[data-provider]').map((s) => s.attributes('data-provider'))).toEqual(['minimax'])
    expect(wrapper.get('[data-test="providers-not-installed"]').text()).toBe('Not installed: Gemini, OpenCode Go, Grok, Cursor')
    await wrapper.get('[data-test="reveal-grok"]').trigger('click')
    expect(wrapper.findAll('[data-provider]').map((s) => s.attributes('data-provider'))).toEqual(['minimax', 'grok'])
    expect(wrapper.get('[data-test="providers-not-installed"]').text()).not.toContain('Grok')
  })

  it('Cursor: the signed-in account, its usage, Refresh and the dashboard link', async () => {
    await mountIt()
    const cursor = wrapper.get('[data-provider="cursor"]')
    expect(cursor.get('[data-test="usage-account-name"]').text()).toBe('person@example.test')
    expect(cursor.text()).toContain('Cursor CLI auth file')
    expect(usageRead).toHaveBeenCalledWith({ provider: 'cursor', accountId: null })
    expect(cursor.get('[data-test="usage-account-usage"]').text()).toContain('42%')
    expect(cursor.text()).toContain('Cursor models')
    await cursor.get('[data-test="usage-account-refresh"]').trigger('click')
    await flushPromises()
    expect(usageRead).toHaveBeenCalledTimes(2)
    expect(api.status).toHaveBeenCalledTimes(2)
    await cursor.get('[data-test="usage-account-link"]').trigger('click')
    expect(window.shellApi.openExternal).toHaveBeenCalledWith('https://cursor.com/dashboard/spending')
  })

  it('Grok: signed out says how to sign in, and reads no usage', async () => {
    await mountIt()
    const grok = wrapper.get('[data-provider="grok"]')
    expect(grok.text()).toContain('Not signed in to Grok CLI')
    expect(grok.text()).toContain('grok login')
    expect(usageRead).not.toHaveBeenCalledWith({ provider: 'grok', accountId: null })
  })

  it('MiniMax: a pasted key goes to the main process and the field empties; only “Saved” comes back', async () => {
    await mountIt()
    const minimax = wrapper.get('[data-provider="minimax"]')
    const field = minimax.get('[data-secret="minimax-api-key"]')
    await field.get('[data-test="secret-input"]').setValue('fixture-minimax-key')
    await field.get('[data-test="secret-save"]').trigger('click')
    await flushPromises()
    expect(api.saveSecret).toHaveBeenCalledWith('minimaxApiKey', 'fixture-minimax-key')
    expect(field.get('[data-test="secret-input"]').element.value).toBe('')
    expect(field.get('[data-test="secret-state"]').text()).toBe('Saved')
    expect(minimax.get('[data-test="provider-status"]').text()).toBe('API key saved · Overseas')
    expect(wrapper.html()).not.toContain('fixture-minimax-key')
    await field.get('[data-test="secret-forget"]').trigger('click')
    await flushPromises()
    expect(api.clearSecret).toHaveBeenCalledWith('minimaxApiKey')
    expect(field.get('[data-test="secret-state"]').text()).toBe('Not saved')
  })

  it('MiniMax: the endpoint changes the console link; options are saved on change', async () => {
    await mountIt()
    const minimax = wrapper.get('[data-provider="minimax"]')
    minimax.getComponent(ThemedSelect).vm.$emit('update:modelValue', 'cn')
    await flushPromises()
    expect(api.update).toHaveBeenCalledWith({ minimaxEndpoint: 'cn' })
    await minimax.get('[data-test="minimax-console"]').trigger('click')
    expect(window.shellApi.openExternal).toHaveBeenCalledWith('https://platform.minimaxi.com/console/usage')
    await minimax.get('[data-test="minimax-models"]').setValue('pro, general')
    await minimax.get('[data-test="minimax-models"]').trigger('change')
    await flushPromises()
    expect(api.update).toHaveBeenCalledWith({ minimaxUsageModels: 'pro, general' })
    await minimax.get('[data-test="minimax-cookie-help"]').trigger('click')
    expect(minimax.text()).toContain('coding_plan/remains')
  })

  it('Gemini and OpenCode Go: the opt-in switch and the workspace override', async () => {
    await mountIt()
    await wrapper.get('[data-test="gemini-cli-oauth"]').setValue(true)
    await flushPromises()
    expect(api.update).toHaveBeenCalledWith({ geminiCliOAuth: true })
    const input = wrapper.get('[data-test="opencode-workspace"]')
    await input.setValue('wrk_abc')
    await input.trigger('change')
    await flushPromises()
    expect(api.update).toHaveBeenCalledWith({ opencodeWorkspaceId: 'wrk_abc' })
  })

  it('every row starts folded with a one-line status; Configure opens it', async () => {
    await mountIt()
    expect(wrapper.find('[data-test="providers-not-installed"]').exists()).toBe(false)
    for (const row of wrapper.findAll('[data-provider]')) {
      expect(row.get('[data-test="provider-details"]').attributes('style')).toContain('display: none')
      expect(row.get('[data-test="provider-details-toggle"]').attributes('aria-expanded')).toBe('false')
    }
    expect(wrapper.get('[data-provider="cursor"] [data-test="provider-status"]').text()).toBe('Signed in as person@example.test · 42% used')
    expect(wrapper.get('[data-provider="opencode-go"] [data-test="provider-status"]').text()).toBe('Uses the key OpenCode saved with /connect')
    expect(wrapper.get('[data-provider="minimax"] [data-test="provider-status"]').text()).toBe('Not set up')
    const opencode = wrapper.get('[data-provider="opencode-go"]')
    await opencode.get('[data-test="provider-details-toggle"]').trigger('click')
    expect(opencode.get('[data-test="provider-details-toggle"]').text()).toContain('Configure')
    expect(opencode.get('[data-test="provider-details"]').attributes('style') || '').not.toContain('display: none')
  })

  it('an expired sign-in opens its row and says what to do', async () => {
    state.grok = { signedIn: true, email: 'g@example.test', tokenFresh: false, error: null }
    await mountIt()
    const grok = wrapper.get('[data-provider="grok"]')
    expect(grok.get('[data-test="provider-status"]').text()).toBe('Sign-in expired')
    expect(grok.get('[data-test="usage-account-help"]').text()).toContain('Refresh usage')
    expect(grok.get('[data-test="provider-details-toggle"]').attributes('aria-expanded')).toBe('true')
  })

  it('Gemini: an expired login with the CLI credentials off says how to read usage again', async () => {
    state.gemini = { signedIn: true, email: 'gem@example.test', tokenFresh: false, refreshable: true, error: null }
    await mountIt()
    const gemini = () => wrapper.get('[data-provider="gemini"]')
    expect(gemini().get('[data-test="provider-status"]').text()).toBe('Sign-in expired')
    expect(gemini().get('[data-test="provider-status"]').classes()).toContain('warn')
    expect(gemini().get('[data-test="gemini-expired-help"]').text()).toContain('Turn on “Use Gemini CLI credentials”')
    expect(gemini().get('[data-test="gemini-expired-help"]').text()).toContain('Antigravity')
    expect(gemini().get('[data-test="provider-details-toggle"]').attributes('aria-expanded')).toBe('true')
    await gemini().get('[data-test="gemini-cli-oauth"]').setValue(true)
    await flushPromises()
    expect(api.update).toHaveBeenCalledWith({ geminiCliOAuth: true })
    expect(gemini().find('[data-test="gemini-expired-help"]').exists()).toBe(false)
    expect(gemini().get('[data-test="provider-status"]').text()).toBe(
      'Signed in as gem@example.test · renewed with the Gemini CLI credentials'
    )
  })

  it('Gemini: a valid login is quiet; no refresh token means signing in again', async () => {
    state.gemini = { signedIn: true, email: null, tokenFresh: true, refreshable: false, error: null }
    await mountIt()
    expect(wrapper.get('[data-provider="gemini"] [data-test="provider-status"]').text()).toBe('Signed in')
    expect(wrapper.get('[data-provider="gemini"] [data-test="provider-details-toggle"]').attributes('aria-expanded')).toBe('false')
    wrapper.unmount()
    state.gemini = { signedIn: true, email: null, tokenFresh: false, refreshable: false, error: null }
    state.settings.geminiCliOAuth = true
    await mountIt()
    expect(wrapper.get('[data-provider="gemini"] [data-test="gemini-expired-help"]').text()).toContain('Run gemini to sign in again')
  })

  it('without secure storage, keys and cookies cannot be typed in', async () => {
    state.secure = false
    await mountIt()
    const field = wrapper.get('[data-secret="opencode-go-api-key"]')
    expect(field.get('[data-test="secret-input"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-provider="opencode-go"]').text()).toContain('Secure credential storage is unavailable')
  })

  it('warns where the keys are managed when the saved file is readable as it is', async () => {
    state.protection = 'plaintext'
    await mountIt()
    expect(wrapper.get('[data-provider="opencode-go"] [data-test="credentials-unsealed"]').text()).toContain('stored unencrypted')
    wrapper.unmount()
    state.protection = 'sealed'
    await mountIt()
    expect(wrapper.find('[data-test="credentials-unsealed"]').exists()).toBe(false)
  })
})
