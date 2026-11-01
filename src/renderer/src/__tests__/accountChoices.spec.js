// The account a Claude Code or Codex session starts on: offered by the "+"
// menu and the empty project's launcher only when the agent has more than one
// signed in, the default one first; what each pane runs on, for its header.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import LaunchMenu from '../components/LaunchMenu.vue'
import ProjectLauncher from '../components/ProjectLauncher.vue'
import { accountChoices, accountSubscription, choicesFrom, paneAccount, refreshAccountChoices, shortAccount } from '../accountChoices'

const claude = (extra = {}) => ({
  provider: 'claude',
  selectedId: null,
  system: { id: null, label: 'System default', status: 'ready', email: 'me@home.test' },
  accounts: [
    { id: 'acc-1', label: 'work.person@corp.test', email: 'work.person@corp.test', status: 'ready' },
    { id: 'acc-2', label: 'old@corp.test', email: 'old@corp.test', status: 'missing' }
  ],
  ...extra
})
const AGENTS = [
  { id: 'claude', name: 'Claude Code', command: 'claude', available: true },
  { id: 'codex', name: 'Codex', command: 'codex', available: true }
]
let previous, wrapper
async function accounts(providers) {
  window.shellApi = { ...(window.shellApi || {}), accounts: { list: vi.fn(async () => ({ ok: true, providers })) } }
  await refreshAccountChoices()
}
beforeEach(() => {
  previous = window.shellApi
})
afterEach(async () => {
  wrapper?.unmount()
  wrapper = null
  await accounts([])
  window.shellApi = previous
})

describe('the accounts to choose from', () => {
  it('none when the agent has only the system sign-in, else the system first and the signed-in ones', () => {
    expect(choicesFrom(claude({ accounts: [] }))).toEqual([])
    expect(choicesFrom(claude({ accounts: [claude().accounts[1]] }))).toEqual([])
    const choices = choicesFrom(claude({ selectedId: 'acc-1' }))
    expect(choices.map((c) => [c.id, c.name, c.isDefault])).toEqual([
      [null, 'me', false],
      ['acc-1', 'work.person', true]
    ])
    expect(choices[0].title).toContain('me@home.test')
    // The same name before the @: the whole email tells them apart.
    const twins = choicesFrom(claude({ system: { status: 'ready', email: 'jc@home.test' }, accounts: [{ id: 'a', email: 'jc@work.test', status: 'ready' }] }))
    expect(twins.map((c) => c.name)).toEqual(['jc@home.test', 'jc@work.test'])
    expect(shortAccount('a-very-long-name-for-a-mailbox@x.test')).toBe('a-very-long-name-for-…')
  })
  it('the same login twice (the system\u2019s sign-in and an added account with its email) is one choice: the default one stays', () => {
    const dup = { id: 'a', email: 'ME@home.test', status: 'ready' }
    // The system's sign-in is the default: the added copy goes, nothing left to choose.
    expect(choicesFrom(claude({ accounts: [dup] }))).toEqual([])
    // The added account is the default: it stays, the system's goes (new sessions keep their account).
    expect(choicesFrom(claude({ selectedId: 'a', accounts: [dup] }))).toEqual([])
    // Beside a really different one: that one and a single copy of the login.
    const withOther = choicesFrom(claude({ selectedId: 'a', accounts: [dup, claude().accounts[0]] }))
    expect(withOther.map((c) => [c.id, c.isDefault])).toEqual([['a', true], ['acc-1', false]])
    const sys = choicesFrom(claude({ accounts: [dup, claude().accounts[0]] }))
    expect(sys.map((c) => [c.id, c.isDefault])).toEqual([[null, true], ['acc-1', false]])
    // Accounts with no email are never taken for each other.
    const blank = choicesFrom(claude({ system: { status: 'ready', email: '' }, accounts: [{ id: 'b', email: '', status: 'ready' }] }))
    expect(blank).toHaveLength(2)
  })
  it('names the account a pane runs on only when its agent has more than one', async () => {
    await accounts([claude()])
    expect(accountChoices('claude')).toHaveLength(2)
    expect(paneAccount('claude', 'acc-1')).toEqual({ name: 'work.person', title: 'work.person@corp.test' })
    expect(paneAccount('claude', null)).toMatchObject({ name: 'me' })
    expect(paneAccount('claude', 'acc-2')).toEqual({ name: 'old', title: 'old@corp.test' })
    expect(paneAccount('claude', undefined)).toBeNull()
    expect(paneAccount('codex', null)).toBeNull()
    await accounts([claude({ accounts: [] })])
    expect(paneAccount('claude', null)).toBeNull()
  })

  it('a pane on an account Anthropic reports with no subscription says it beside the name; the plan is in its title', async () => {
    const at = Date.now() - 60_000
    const canceled = { organization_type: 'claude_free', subscription_status: 'canceled', has_claude_max: false, has_claude_pro: false, checkedAt: at }
    const max20 = { organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_20x', subscription_status: 'active', has_claude_max: true, checkedAt: at }
    const base = claude()
    await accounts([claude({ system: { ...base.system, plan: 'max', subscription: canceled }, accounts: [{ ...base.accounts[0], subscription: max20 }, base.accounts[1]] })])
    expect(paneAccount('claude', null).name).toBe('me · No subscription')
    expect(paneAccount('claude', null).title).toContain('Free · No subscription')
    expect(paneAccount('claude', 'acc-1').name).toBe('work.person')
    expect(paneAccount('claude', 'acc-1').title).toContain('Max 20x')
    // Its plan never in another account's header; undefined counts as the system's.
    expect(paneAccount('claude', 'acc-2')).toEqual({ name: 'old', title: 'old@corp.test' })
    expect(accountSubscription('claude', undefined)).toMatchObject({ organization_type: 'claude_free' })
    expect(accountSubscription('codex', null)).toBeNull()
  })
})

describe('the + menu', () => {
  const open = (props = {}) => {
    wrapper = mount(LaunchMenu, { props: { shells: [], agents: AGENTS, ...props }, attachTo: document.body })
    return flushPromises()
  }
  const agentItem = (name) => wrapper.findAll('.launch-item').find((b) => b.text().includes(name) && !b.text().includes('chat'))

  it('starts Claude Code on the default account, or on the one chosen', async () => {
    await accounts([claude({ selectedId: 'acc-1' })])
    await open()
    const row = wrapper.get('[data-test="launch-account-claude"]')
    expect(row.text()).toContain('Claude Code account')
    expect(row.get('[data-test="launch-account-claude-acc-1"]').attributes('aria-checked')).toBe('true')
    expect(wrapper.find('[data-test="launch-account-codex"]').exists()).toBe(false)
    await agentItem('Claude Code').trigger('click')
    expect(wrapper.emitted('launch').at(-1)[0]).toEqual({ kind: 'agent', id: 'claude', accountId: 'acc-1' })
    await row.get('[data-test="launch-account-claude-system"]').trigger('click')
    await agentItem('Claude Code').trigger('click')
    expect(wrapper.emitted('launch').at(-1)[0]).toEqual({ kind: 'agent', id: 'claude', accountId: null })
    // Codex has a single account here: started as before.
    await agentItem('Codex').trigger('click')
    expect(wrapper.emitted('launch').at(-1)[0]).toEqual({ kind: 'agent', id: 'codex' })
  })
  it('asks nothing with a single account, or on an SSH host (its own sign-in)', async () => {
    await accounts([claude({ accounts: [] })])
    await open()
    expect(wrapper.find('.launch-account').exists()).toBe(false)
    await agentItem('Claude Code').trigger('click')
    expect(wrapper.emitted('launch').at(-1)[0]).toEqual({ kind: 'agent', id: 'claude' })
    wrapper.unmount()
    await accounts([claude()])
    await open({ accountChoice: false })
    expect(wrapper.find('.launch-account').exists()).toBe(false)
  })
})

describe('the empty project launcher', () => {
  const open = (props = {}) => {
    window.shellApi.listSessions = vi.fn(async () => [])
    wrapper = mount(ProjectLauncher, {
      props: { name: 'proj', cwd: 'C:\\proj', agents: AGENTS.map((a) => ({ id: a.id, name: a.name })), shells: [{ id: 'powershell', name: 'PowerShell' }], ...props },
      attachTo: document.body
    })
    return flushPromises()
  }
  it('offers the account beside the agent and starts on the default one', async () => {
    await accounts([claude({ selectedId: 'acc-1' })])
    await open()
    expect(wrapper.find('[data-test="launcher-account-claude"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="launcher-account-codex"]').exists()).toBe(false)
    await wrapper.get('[data-test="launcher-agent-claude"]').trigger('click')
    expect(wrapper.emitted('pick').at(-1)[0]).toEqual({ kind: 'agent', id: 'claude', accountId: 'acc-1' })
    await wrapper.get('[data-test="launcher-agent-codex"]').trigger('click')
    expect(wrapper.emitted('pick').at(-1)[0]).toEqual({ kind: 'agent', id: 'codex' })
  })
  it('on an SSH host, never', async () => {
    await accounts([claude()])
    await open({ cwd: null, remote: { hostId: 'h', host: 'box', path: '/srv' } })
    expect(wrapper.find('[data-test="launcher-account-claude"]').exists()).toBe(false)
  })
})
