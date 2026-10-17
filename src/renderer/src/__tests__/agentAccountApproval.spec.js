// The card an agent's account switch shows (AgentAccountApproval.vue): who
// asks, the account and its sign-in (kind, organization, plan), a summary by
// project, each pane, what the agent says (below the facts), Refuse first,
// Don't ask again, Allow armed a moment after it shows; English and French.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { nextTick } from 'vue'
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
  requester: { label: 'Fable', project: 'Tessel', host: null },
  account: { agent: 'claude', agentName: 'Claude Code', email: 'max@example.com', login: null, unknown: false },
  signIns: [{ id: 'fd69', kind: 'pc', where: '', scope: 'tessel', org: 'Work Corp', plan: 'max', sub: { organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_20x', subscription_status: 'active', has_claude_max: true, checkedAt: NOW } }],
  panes: [
    { id: 'p-curie', name: 'Curie', project: 'BridgeClip', host: null, from: 'old@example.com', state: null },
    { id: 'p-lovelace', name: 'Lovelace', project: 'BridgeClip', host: null, from: 'old@example.com', state: null },
    { id: 'p-kepler', name: 'Kepler', project: 'Visual Code', host: null, from: 'old@example.com', state: 'working' }
  ],
  projects: [
    { name: 'BridgeClip', count: 2 },
    { name: 'Visual Code', count: 1 }
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
  const open = (extra, props = { armMs: 0 }) => {
    wrapper = mount(AgentAccountApproval, { props: { card: card(extra), ...props }, attachTo: document.body })
    return wrapper
  }

  it('names who asks, the account and its sign-in, the projects, each pane; the agent\'s words below them; starts on Refuse', async () => {
    open()
    await flushPromises()
    const text = wrapper.text()
    expect(text).toContain('Fable wants to restart 3 panes on another account')
    expect(wrapper.find('[data-test="agent-account-requester"]').text()).toBe('Asked by agent pane “Fable” · project Tessel · this PC')
    const target = wrapper.find('[data-test="agent-account-target"]').text()
    expect(target).toContain('max@example.com')
    expect(target).toContain('added in Tessel, on this PC · organization Work Corp · Max 20x')
    expect(target).toContain('Claude Code')
    expect(wrapper.find('[data-test="agent-account-projects"]').text()).toBe('BridgeClip (2), Visual Code (1)')
    const items = wrapper.findAll('[data-test="agent-account-panes"] li').map((li) => li.text())
    expect(items[0]).toContain('project BridgeClip · this PC · now on old@example.com')
    expect(items[2]).toContain('working now: its turn stops')
    // The agent's words: a quote, after the facts.
    const html = wrapper.html()
    expect(wrapper.find('[data-test="agent-account-says"]').text()).toBe('The agent says: “The old Max subscription ended.”')
    expect(html.indexOf('agent-account-says')).toBeGreaterThan(html.indexOf('agent-account-panes'))
    expect(text).toContain('No answer in 2 min counts as Refuse.')
    expect(document.activeElement).toBe(wrapper.find('[data-test="agent-account-refuse"]').element)
  })

  it('an agent on an SSH host, a folder there: said; a short card says its seconds', () => {
    open({
      requester: { label: 'Remote', project: 'Server', host: 'build-box' },
      signIns: [{ id: 'ssh:box:claude:f1', kind: 'ssh', where: 'build-box', scope: 'tessel', org: null, plan: null, sub: null }],
      timeoutMs: 50000
    })
    expect(wrapper.find('[data-test="agent-account-requester"]').text()).toBe('Asked by agent pane “Remote” · project Server · SSH build-box')
    expect(wrapper.find('[data-test="agent-account-target"]').text()).toContain('an account folder made by Tessel on SSH build-box')
    expect(wrapper.text()).toContain('No answer in 50 s counts as Refuse.')
  })

  it('Allow answers yes; Refuse, Escape and a click outside answer no; Don\'t ask again says so', async () => {
    open()
    await wrapper.find('[data-test="agent-account-allow"]').trigger('click')
    await wrapper.find('[data-test="agent-account-refuse"]').trigger('click')
    await wrapper.find('[role="alertdialog"]').trigger('keydown', { key: 'Escape' })
    await wrapper.find('[data-test="agent-account-approval"]').trigger('pointerdown')
    await wrapper.find('[data-test="agent-account-block"]').trigger('click')
    expect(wrapper.emitted('answer').map((e) => e[0])).toEqual([{ allow: true }, { allow: false }, { allow: false }, { allow: false }, { allow: false, block: true }])
  })

  it('Allow is armed only a moment after the card shows, again after the window comes back, and a mouse click must be pressed on it', async () => {
    vi.useFakeTimers()
    try {
      open({}, {})
      const allow = () => wrapper.find('[data-test="agent-account-allow"]')
      await nextTick()
      expect(allow().attributes('disabled')).toBeDefined()
      await allow().trigger('click')
      expect(wrapper.emitted('answer')).toBeUndefined()
      vi.advanceTimersByTime(800)
      await nextTick()
      expect(allow().attributes('disabled')).toBeUndefined()
      window.dispatchEvent(new Event('focus'))
      await nextTick()
      expect(allow().attributes('disabled')).toBeDefined()
      vi.advanceTimersByTime(800)
      await nextTick()
      // A click whose press began elsewhere (a card closed meanwhile): nothing.
      allow().element.dispatchEvent(new MouseEvent('click', { detail: 1, bubbles: true }))
      await nextTick()
      expect(wrapper.emitted('answer')).toBeUndefined()
      await allow().trigger('pointerdown')
      allow().element.dispatchEvent(new MouseEvent('click', { detail: 1, bubbles: true }))
      await nextTick()
      expect(wrapper.emitted('answer')[0][0]).toEqual({ allow: true })
    } finally {
      vi.useRealTimers()
    }
  })

  it('a Codex account says a new conversation starts; its own pane in the list says it restarts last', () => {
    open({ account: { agent: 'codex', agentName: 'Codex', email: 'dev@example.com' }, signIns: [{ id: 'x', kind: 'ssh', where: 'build-box', scope: 'default', org: null, plan: 'plus', sub: null }], panes: [{ id: 'p-cx', name: 'Box Codex', project: 'Afterlife', host: 'build-box', self: true }], projects: [{ name: 'Afterlife', count: 1 }] })
    const text = wrapper.text()
    expect(text).toContain('Fable wants to restart a pane on another account')
    expect(text).toContain('in a new conversation: a Codex conversation stays with its account')
    expect(text).toContain('SSH build-box’s own sign-in')
    expect(text).toContain('Fable is in the list: it restarts last, once it has your answer.')
  })

  it('in French', async () => {
    setMessages('fr', fr)
    open()
    await flushPromises()
    const text = wrapper.text()
    expect(text).toContain('Fable veut redémarrer 3 panneaux sur un autre compte')
    expect(wrapper.find('[data-test="agent-account-requester"]').text()).toBe('Demandé par le panneau d’agent « Fable » · projet Tessel · ce PC')
    expect(text).toContain('ajouté dans Tessel, sur ce PC · organisation Work Corp')
    expect(text).toContain('Chaque panneau redémarre sur place avec ce compte, sa conversation reprise.')
    expect(text).toContain('projet BridgeClip · ce PC · actuellement sur old@example.com')
    expect(wrapper.find('[data-test="agent-account-says"]').text()).toBe('L’agent dit : « The old Max subscription ended. »')
    expect(wrapper.find('[data-test="agent-account-refuse"]').text()).toBe('Refuser')
    expect(wrapper.find('[data-test="agent-account-block"]').text()).toBe('Ne plus demander pour cet agent')
    expect(wrapper.find('[data-test="agent-account-allow"]').text()).toBe('Autoriser')
  })
})
