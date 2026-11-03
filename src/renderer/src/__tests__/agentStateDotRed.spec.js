// Red beside an agent: it waits for you, or finished and was not looked at yet.
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import AgentStateDot from '../components/sidebar/AgentStateDot.vue'

const dot = (state, variant = 'row') => mount(AgentStateDot, { props: { state, variant } }).find('.asd-dot')

describe('AgentStateDot', () => {
  for (const state of ['waiting', 'permission', 'done', 'blocked', 'interrupted', 'failed']) {
    it(`shows ${state} as a red dot in a row and in the status lane`, () => {
      expect(dot(state).classes()).toContain('red')
      expect(dot(state, 'status').classes()).toContain('red')
    })
  }
  it('keeps a working agent on its flashing dot', () => {
    expect(dot('working').classes()).toContain('asd-working')
    expect(dot('working').classes()).not.toContain('red')
  })
  it('keeps an idle agent out of the red', () => {
    expect(dot('idle').classes()).not.toContain('red')
  })
  it('keeps an active workspace green in the status lane', () => {
    expect(dot('active', 'status').classes()).toContain('green')
  })
})
