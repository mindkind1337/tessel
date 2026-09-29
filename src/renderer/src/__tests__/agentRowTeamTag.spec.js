import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import CompactAgentRow from '../components/sidebar/CompactAgentRow.vue'

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
    expect(member.get('[data-test="car-team"]').text()).toBe('Team 2')
    const lead = mount(CompactAgentRow, { props: { row: row({ team: 't1', lead: true }), teamLabel: 'Team 2' } })
    expect(lead.get('[data-test="car-team"]').text()).toBe('Team 2 · lead')
    const alone = mount(CompactAgentRow, { props: { row: row() } })
    expect(alone.find('[data-test="car-team"]').exists()).toBe(false)
  })
})
