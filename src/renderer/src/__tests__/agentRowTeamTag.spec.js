import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import CompactAgentRow from '../components/sidebar/CompactAgentRow.vue'
import { paneModels } from '../paneModels'

const row = (extra = {}) => ({
  id: 'p1',
  num: 2,
  kind: 'agent',
  iconKind: 'claude',
  title: 'Claude Code',
  primary: 'Claude Code',
  secondary: '',
  dotState: 'idle',
  ...extra
})

describe("an agent row shows its team", () => {
  it('names the team, and says lead for its lead; nothing without a team', () => {
    window.shellApi = {}
    const member = mount(CompactAgentRow, { props: { row: row({ team: 't1' }), teamLabel: 'Team 2' } })
    expect(member.get('[data-test="car-team"]').text()).toBe('2')
    const lead = mount(CompactAgentRow, { props: { row: row({ team: 't1', lead: true }), teamLabel: 'Team 2' } })
    expect(lead.get('[data-test="car-team"]').text()).toBe('2')
    expect(lead.get('[data-test="car-team"]').classes()).toContain('lead')
    const alone = mount(CompactAgentRow, { props: { row: row() } })
    expect(alone.find('[data-test="car-team"]').exists()).toBe(false)
  })
})

describe('the task line under an agent', () => {
  it('shows the task, and not when the sidebar option hides it', async () => {
    window.shellApi = {}
    const { settings } = await import('../settings')
    const w = mount(CompactAgentRow, { props: { row: row({ subline: 'Fix the login' }) } })
    expect(w.get('.car-subline').text()).toBe('Fix the login')
    settings.hideAgentTaskLine = true
    await w.vm.$nextTick()
    expect(w.find('.car-subline').exists()).toBe(false)
    settings.hideAgentTaskLine = false
    await w.vm.$nextTick()
    expect(w.find('.car-subline').exists()).toBe(true)
  })
})

describe('an agent row shows its model', () => {
  it('no model on the row (it is in the hover card)', () => {
    window.shellApi = {}
    paneModels.p1 = 'Fable 5.1 · high'
    const w = mount(CompactAgentRow, { props: { row: row() } })
    expect(w.find('[data-test="car-model"]').exists()).toBe(false)
    delete paneModels.p1
    const none = mount(CompactAgentRow, { props: { row: row() } })
    expect(none.find('[data-test="car-model"]').exists()).toBe(false)
  })
})

describe('a chat agent row (no terminal)', () => {
  const chat = (extra = {}) => row({ chat: true, title: 'Reviewer', primary: 'Reviewer', model: 'Opus 4.7 · High', ...extra })

  it('shows its team; no model and no chat tag on the row (screen readers still hear it)', () => {
    window.shellApi = {}
    const w = mount(CompactAgentRow, { props: { row: chat({ team: 't1', lead: true }), teamLabel: 'Team 2' } })
    expect(w.find('[data-test="car-model"]').exists()).toBe(false)
    expect(w.get('[data-test="car-team"]').text()).toBe('2')
    expect(w.find('[data-test="car-chat"]').exists()).toBe(false)
    expect(w.get('.compact-agent-row').attributes('aria-label')).toContain('Chat, no terminal')
    const named = mount(CompactAgentRow, { props: { row: chat({ title: 'Claude (chat)', primary: 'Claude (chat)' }) } })
    expect(named.find('[data-test="car-chat"]').exists()).toBe(false)
    // A terminal agent has no chat tag.
    const terminal = mount(CompactAgentRow, { props: { row: row() } })
    expect(terminal.find('[data-test="car-chat"]').exists()).toBe(false)
    expect(terminal.get('.compact-agent-row').attributes('aria-label')).not.toContain('Chat')
  })

  it('a click goes to its pane like a terminal row', async () => {
    window.shellApi = {}
    const w = mount(CompactAgentRow, { props: { row: chat() } })
    await w.get('.compact-agent-row').trigger('click')
    expect(w.emitted('activate')[0][0]).toMatchObject({ id: 'p1', chat: true })
  })
})
