// After Orca's NativeChatComposerActions.test.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'

vi.mock('../NativeChatSessionOptionPickers.vue', () => ({
  default: defineComponent({
    props: ['surface', 'snapshot', 'isWorking', 'pickerRequest'],
    setup: () => () => h('div', { 'data-testid': 'session-option-pickers' })
  })
}))
vi.mock('../NativeChatContextUsageRing.vue', () => ({
  default: defineComponent({ props: ['usage'], setup: () => () => h('div', { 'data-testid': 'context-ring' }) })
}))

import NativeChatComposerActions from '../NativeChatComposerActions.vue'

let wrapper = null
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.replaceChildren()
})

function render(props = {}) {
  wrapper = mount(NativeChatComposerActions, {
    props: { sessionOptionsSurface: null, sessionOptionsSnapshot: [], ...props },
    attachTo: document.body
  })
  return wrapper
}
const button = (label) => wrapper.find(`button[aria-label="${label}"]`)

describe('NativeChatComposerActions', () => {
  it('places session option pickers immediately beside dictation', () => {
    render()
    const pickers = wrapper.find('[data-testid="session-option-pickers"]').element
    expect(pickers.nextElementSibling).toBe(button('Start dictation').element)
  })

  it('marks the streaming Stop control as the critical hit target', () => {
    render({ isWorking: true })
    expect(button('Stop the agent').attributes('data-native-chat-critical-action')).toBe('stop')
  })

  it('ignores the second click of a double-click after send becomes Stop', async () => {
    render({ isWorking: true })
    button('Stop the agent').element.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }))
    expect(wrapper.emitted('send')).toBeUndefined()
    expect(wrapper.emitted('stop')).toBeUndefined()
  })

  // Tessel.
  it('sends when idle and stops while working', async () => {
    render()
    await button('Send').trigger('click')
    expect(wrapper.emitted('send')).toHaveLength(1)
    await wrapper.setProps({ isWorking: true })
    await button('Stop the agent').trigger('click')
    expect(wrapper.emitted('stop')).toHaveLength(1)
    expect(wrapper.find('[data-test="chat-interrupt"]').exists()).toBe(true)
  })

  it('hides Attach and dictation when asked (Tessel: text only, no dictation)', () => {
    render({ showAttach: false, showDictation: false })
    expect(button('Attach file').exists()).toBe(false)
    expect(button('Start dictation').exists()).toBe(false)
    expect(button('Send').exists()).toBe(true)
  })

  it('shows the context ring only with a usage summary', async () => {
    render()
    expect(wrapper.find('[data-testid="context-ring"]').exists()).toBe(false)
    await wrapper.setProps({ contextUsage: { percentage: 10 } })
    expect(wrapper.find('[data-testid="context-ring"]').exists()).toBe(true)
  })

  it('the session-options slot replaces the default pickers', () => {
    wrapper = mount(NativeChatComposerActions, {
      slots: { 'session-options': '<span data-testid="custom-pickers" />' },
      attachTo: document.body
    })
    expect(wrapper.find('[data-testid="custom-pickers"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="session-option-pickers"]').exists()).toBe(false)
  })
})
