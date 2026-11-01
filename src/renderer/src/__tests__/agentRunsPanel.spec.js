// What agents ran in a terminal (AgentRunsPanel.vue): cards, newest first,
// the long command folded, a copy button.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mount } from '@vue/test-utils'
import AgentRunsPanel from '../components/AgentRunsPanel.vue'

const run = (n, extra = {}) => ({ at: Date.parse('2026-11-01T13:01:47Z') + n * 1000, agent: 'Hardy', kind: 'run', text: `cmd ${n}`, ...extra })

describe('the list of what agents ran', () => {
  it('a card each, newest first, with the agent, the kind, the time and the command', () => {
    const w = mount(AgentRunsPanel, { props: { runs: [run(1), run(2, { kind: 'keys', text: 'Ctrl+C' }), run(3, { kind: 'read', text: '' })] } })
    const cards = w.findAll('[data-test="pane-agent-term-row"]')
    expect(cards).toHaveLength(3)
    expect(cards[0].text()).toContain('Read')
    expect(cards[0].find('[data-test="arp-cmd"]').exists()).toBe(false)
    expect(cards[1].text()).toContain('Keys')
    expect(cards[1].text()).toContain('Ctrl+C')
    expect(cards[2].text()).toContain('Command')
    expect(cards[2].text()).toContain('Hardy')
    expect(cards[2].find('time').text()).toMatch(/\d/)
    expect(w.get('[data-test="arp-count"]').text()).toBe('3')
  })

  it('a long command starts folded and unfolds; a short one has no fold button', async () => {
    const long = Array.from({ length: 12 }, (_, i) => `Write-Output ${i}`).join('\n')
    const w = mount(AgentRunsPanel, { props: { runs: [run(1), run(2, { text: long })] } })
    const [longCard, shortCard] = w.findAll('[data-test="pane-agent-term-row"]')
    expect(longCard.get('[data-test="arp-cmd"]').classes()).toContain('folded')
    expect(shortCard.find('[data-test="arp-fold"]').exists()).toBe(false)
    await longCard.get('[data-test="arp-fold"]').trigger('click')
    expect(longCard.get('[data-test="arp-cmd"]').classes()).not.toContain('folded')
    expect(longCard.get('[data-test="arp-cmd"]').text()).toContain('Write-Output 11')
    await longCard.get('[data-test="arp-fold"]').trigger('click')
    expect(longCard.get('[data-test="arp-cmd"]').classes()).toContain('folded')
  })

  it('a very long single line folds too; copy sends the whole command', async () => {
    const oneLine = 'x'.repeat(500)
    const w = mount(AgentRunsPanel, { props: { runs: [run(1, { text: oneLine })] } })
    expect(w.get('[data-test="arp-cmd"]').classes()).toContain('folded')
    await w.get('[data-test="arp-copy"]').trigger('click')
    expect(w.emitted('copy')[0]).toEqual([oneLine])
  })

  it('Yolo is said; nothing yet is said', () => {
    const w = mount(AgentRunsPanel, { props: { runs: [run(1, { yolo: true })] } })
    expect(w.text()).toContain('Yolo, not asked')
    const e = mount(AgentRunsPanel, { props: { runs: [] } })
    expect(e.text()).toContain('Nothing run yet')
    expect(e.find('[data-test="pane-agent-term-row"]').exists()).toBe(false)
  })

  it('a new run does not unfold or refold the others (stable keys)', async () => {
    const long = 'y'.repeat(400)
    const w = mount(AgentRunsPanel, { props: { runs: [run(1, { text: long })] } })
    await w.get('[data-test="arp-fold"]').trigger('click')
    await w.setProps({ runs: [run(1, { text: long }), run(2)] })
    const cards = w.findAll('[data-test="pane-agent-term-row"]')
    expect(cards).toHaveLength(2)
    expect(cards[1].get('[data-test="arp-cmd"]').classes()).not.toContain('folded')
  })
})

describe('its place in the pane', () => {
  it('stays inside the pane however narrow: placed against the header, never a fixed width from the badge', () => {
    const css = readFileSync(join(__dirname, '..', 'style.css'), 'utf8').replace(/\r/g, '')
    const rule = css.slice(css.indexOf('\n.pane-agent-term-log {'), css.indexOf('}', css.indexOf('\n.pane-agent-term-log {')))
    expect(rule).toContain('left: 8px')
    expect(rule).toContain('right: 8px')
    expect(rule).toContain('max-width: 580px')
    expect(rule).not.toMatch(/\n\s*width:/)
    const badge = css.slice(css.indexOf('\n.pane-agent-term {'), css.indexOf('}', css.indexOf('\n.pane-agent-term {')))
    expect(badge).not.toContain('position: relative')
  })
})
