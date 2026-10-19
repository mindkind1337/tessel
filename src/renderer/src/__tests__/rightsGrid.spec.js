// Live Share's RightsGrid (components/liveshare/RightsGrid.vue): the presets,
// one tile per right of the catalog (Type first, marked), the line saying
// what a preset or a right means, the agents row, and the dense row of
// chips; RightsChecks.vue (the same tiles without presets) and RightsChip.vue.
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { RIGHT_IDS } from '../../../shared/liveShareRights'
import { presetRights } from '../liveShareRights'
import RightsGrid from '../components/liveshare/RightsGrid.vue'
import RightsChecks from '../components/liveshare/RightsChecks.vue'
import RightsChip from '../components/liveshare/RightsChip.vue'

const tile = (w, id, key = 'x') => w.find(`[data-test="ls-right-${id}-${key}"]`)

describe('RightsGrid', () => {
  it('one tile per right, in the catalog’s order, each with its short label and its full words for screen readers', () => {
    const w = mount(RightsGrid, { props: { rights: { open: true }, testKey: 'x' } })
    const tiles = w.findAll('.lsr-item')
    expect(tiles.map((x) => x.attributes('data-test'))).toEqual(RIGHT_IDS.map((id) => `ls-right-${id}-x`))
    expect(tiles.map((x) => x.find('input').element.checked)).toEqual(RIGHT_IDS.map((id) => id === 'open'))
    expect(tile(w, 'open').find('.lsr-short').text()).toBe('Open')
    expect(tile(w, 'open').find('.sr-only').text()).toBe('Open terminals and agents on your computer (they can run commands)')
    expect(tile(w, 'open').attributes('title')).toContain('Without it, each terminal or agent they ask for waits for your yes.')
    expect(tile(w, 'open').classes()).toContain('on')
  })

  it('Type has a red outline and says it runs commands as you', () => {
    const w = mount(RightsGrid, { props: { rights: {}, testKey: 'x' } })
    expect(tile(w, 'type').classes()).toContain('danger')
    expect(tile(w, 'type').text()).toContain('Runs commands as you')
    expect(w.findAll('.lsr-item.danger')).toHaveLength(1)
  })

  it('a tile asks for the change and shows what the subject has until it comes back', async () => {
    const w = mount(RightsGrid, { props: { rights: {}, testKey: 'x' } })
    const box = tile(w, 'git').find('input')
    box.element.checked = true
    await box.trigger('change')
    expect(w.emitted('toggle')).toEqual([['git', true]])
    expect(box.element.checked).toBe(false)
    await w.setProps({ rights: { git: true } })
    expect(box.element.checked).toBe(true)
  })

  it('a right whose change is on its way waits', () => {
    const w = mount(RightsGrid, { props: { rights: {}, testKey: 'x', busy: (id) => id === 'edit' } })
    expect(tile(w, 'edit').find('input').attributes('disabled')).toBeDefined()
    expect(tile(w, 'open').find('input').attributes('disabled')).toBeUndefined()
  })

  it('presets: the one the rights match is lit, a pick asks for the whole set, Custom for rights that match none', async () => {
    const w = mount(RightsGrid, { props: { rights: presetRights('collaborate'), testKey: 'inv', presets: true } })
    const lit = () => w.findAll('.lsr-seg-item.on').map((x) => x.attributes('data-test'))
    expect(lit()).toEqual(['ls-inv-preset-collaborate'])
    expect(w.find('[data-test="ls-inv-preset-hint"]').text()).toContain('never type in your terminals')
    await w.find('[data-test="ls-inv-preset-full"] input').trigger('change')
    expect(w.emitted('preset')).toEqual([['full']])
    await w.setProps({ rights: presetRights('full') })
    expect(w.find('[data-test="ls-inv-preset-hint"]').classes()).toContain('warn')
    await w.setProps({ rights: { open: true, usage: true } })
    expect(lit()).toEqual(['ls-inv-customize'])
    expect(w.find('[data-test="ls-inv-preset-hint"]').text()).toBe('Custom: Open, Usage')
  })

  it('Custom can be picked from a preset, to change the tiles one by one', async () => {
    const w = mount(RightsGrid, { props: { rights: {}, testKey: 'inv', presets: true } })
    await w.find('[data-test="ls-inv-customize"]').trigger('click')
    expect(w.findAll('.lsr-seg-item.on').map((x) => x.attributes('data-test'))).toEqual(['ls-inv-customize'])
    expect(w.emitted('preset')).toBeUndefined()
  })

  it('the line under the tiles says what the right under the pointer allows', async () => {
    const w = mount(RightsGrid, { props: { rights: {}, testKey: 'x' } })
    expect(w.find('.lsr-describe').exists()).toBe(false)
    await tile(w, 'type').trigger('mouseenter')
    expect(w.find('.lsr-describe').text()).toContain('Only for people you trust')
    expect(w.find('.lsr-describe').classes()).toContain('warn')
    await tile(w, 'type').trigger('mouseleave')
    expect(w.find('.lsr-describe').exists()).toBe(false)
  })

  it('the agents row: every agent for now, or what the slot gives', () => {
    const w = mount(RightsGrid, { props: { rights: {}, testKey: 'x', agents: true } })
    expect(w.find('[data-test="ls-agents-x"]').text()).toContain('All agents')
    const slotted = mount(RightsGrid, { props: { rights: {}, testKey: 'x', agents: true }, slots: { agents: '<span class="mine">Claude Code</span>' } })
    expect(slotted.find('[data-test="ls-agents-x"] .mine').text()).toBe('Claude Code')
    expect(slotted.find('[data-test="ls-agents-x"]').text()).not.toContain('All agents')
    expect(mount(RightsGrid, { props: { rights: {}, testKey: 'x' } }).find('[data-test="ls-agents-x"]').exists()).toBe(false)
  })

  it('dense: a row of chips, no presets, no line, no agents row', () => {
    const w = mount(RightsGrid, { props: { rights: { type: true }, testKey: 'x', dense: true, presets: true, agents: true } })
    expect(w.classes()).toContain('dense')
    expect(w.find('.lsr-seg').exists()).toBe(false)
    expect(w.find('.lsr-tag').exists()).toBe(false)
    expect(w.find('[data-test="ls-agents-x"]').exists()).toBe(false)
    expect(w.findAll('.lsr-item')).toHaveLength(RIGHT_IDS.length)
  })
})

describe('RightsChecks and RightsChip', () => {
  it('RightsChecks: the same tiles without presets, compact as a dense row', async () => {
    const w = mount(RightsChecks, { props: { rights: { close: true }, testKey: 'g1', compact: true } })
    expect(w.find('.lsr').classes()).toContain('dense')
    expect(w.find('.lsr-seg').exists()).toBe(false)
    const box = w.find('[data-test="ls-right-close-g1"] input')
    expect(box.element.checked).toBe(true)
    box.element.checked = false
    await box.trigger('change')
    expect(w.emitted('toggle')).toEqual([['close', false]])
  })

  it('RightsChip: the preset’s name or Custom with a count, red when they can type', () => {
    expect(mount(RightsChip, { props: { rights: {} } }).text()).toBe('View only')
    const full = mount(RightsChip, { props: { rights: presetRights('full') } })
    expect(full.text()).toBe('Full control')
    expect(full.classes()).toContain('tag-danger')
    const custom = mount(RightsChip, { props: { rights: { open: true, pagesView: true } } })
    expect(custom.text()).toBe('Custom · 2')
    expect(custom.attributes('title')).toBe('Open, Pages')
    expect(custom.classes()).toContain('tag-info')
  })
})
