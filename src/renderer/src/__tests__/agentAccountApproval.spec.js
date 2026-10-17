// The card an agent's account switch shows (AgentAccountApproval.vue): each
// pane with its project, the agent, the account (email and plan), Refuse
// first, Allow; in English and in French.
import { describe, it, expect, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import AgentAccountApproval from '../components/AgentAccountApproval.vue'
import { setMessages } from '../i18n'
import fr from '../i18n/locales/fr/app.json'

const NOW = Date.now()
const card = (extra = {}) => ({
  kind: 'accounts',
  token: 'tok-1',
  agentLabel: 'Fable',
  explanation: 'The old Max subscription ended.',
  timeoutMs: 120000,
  account: { agent: 'claude', agentName: 'Claude Code', email: 'max@example.com', plan: 'max', sub: { organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_20x', subscription_status: 'active', has_claude_max: true, checkedAt: NOW }, where: [''] },
  panes: [
    { id: 'p-curie', name: 'Curie', project: 'BridgeClip', host: null, from: 'old@example.com', state: null },
    { id: 'p-kepler', name: 'Kepler', project: 'Visual Code', host: null, from: 'old@example.com', state: 'working' },
    { id: 'p-remote', name: 'Remote', project: 'Server', host: 'build-box', from: null, state: null }
  ],
  already: [],
  ...extra
})

describe('the account switch card', () => {
  let wrapper
  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    setMessages('en', {})
  })
  const open = (extra) => {
    wrapper = mount(AgentAccountApproval, { props: { card: card(extra) }, attachTo: document.body })
    return wrapper
  }

  it('names each pane and its project, the agent, the account and its plan; starts on Refuse', async () => {
    open()
    await flushPromises()
    const text = wrapper.text()
    expect(text).toContain('Fable wants to restart 3 panes on another account')
    expect(text).toContain('The old Max subscription ended.')
    expect(text).toContain('max@example.com · Max 20x')
    expect(text).toContain('Claude Code')
    expect(text).toContain('Each pane restarts in place on this account, its conversation resumed.')
    const items = wrapper.findAll('[data-test="agent-account-panes"] li').map((li) => li.text())
    expect(items[0]).toContain('Curie')
    expect(items[0]).toContain('project BridgeClip · this PC · now on old@example.com')
    expect(items[1]).toContain('working now: its turn stops')
    expect(items[2]).toContain('project Server · SSH build-box')
    expect(text).toContain('No answer in 2 min counts as Refuse.')
    expect(document.activeElement).toBe(wrapper.find('[data-test="agent-account-refuse"]').element)
  })

  it('Allow answers yes; Refuse, Escape and a click outside answer no', async () => {
    open()
    await wrapper.find('[data-test="agent-account-allow"]').trigger('click')
    await wrapper.find('[data-test="agent-account-refuse"]').trigger('click')
    await wrapper.find('[role="alertdialog"]').trigger('keydown', { key: 'Escape' })
    await wrapper.find('[data-test="agent-account-approval"]').trigger('pointerdown')
    expect(wrapper.emitted('answer').map((e) => e[0])).toEqual([{ allow: true }, { allow: false }, { allow: false }, { allow: false }])
  })

  it('a Codex account says a new conversation starts; its own pane in the list says it restarts last', () => {
    open({ account: { agent: 'codex', agentName: 'Codex', email: 'dev@example.com', plan: 'plus', where: ['build-box'] }, panes: [{ id: 'p-cx', name: 'Box Codex', project: 'Afterlife', host: 'build-box', self: true }] })
    const text = wrapper.text()
    expect(text).toContain('Fable wants to restart a pane on another account')
    expect(text).toContain('in a new conversation: a Codex conversation stays with its account')
    expect(text).toContain('SSH build-box')
    expect(text).toContain('Fable is in the list: it restarts last, once it has your answer.')
  })

  it('in French', async () => {
    setMessages('fr', fr)
    open()
    await flushPromises()
    const text = wrapper.text()
    expect(text).toContain('Fable veut redémarrer 3 panneaux sur un autre compte')
    expect(text).toContain('Chaque panneau redémarre sur place avec ce compte, sa conversation reprise.')
    expect(text).toContain('projet BridgeClip · ce PC · actuellement sur old@example.com')
    expect(text).toContain('travaille en ce moment')
    expect(wrapper.find('[data-test="agent-account-refuse"]').text()).toBe('Refuser')
    expect(wrapper.find('[data-test="agent-account-allow"]').text()).toBe('Autoriser')
  })
})
