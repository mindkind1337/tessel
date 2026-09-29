// NativeChatCopyButton (after Orca's NativeChatCopyButton.tsx, MIT, Copyright
// (c) 2026 Lovecast Inc.; the reference has no spec of its own): Tessel's
// clipboard bridge, the "Copied" feedback, no button without the bridge.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import NativeChatCopyButton from '../NativeChatCopyButton.vue'

let prevApi, writeClipboard, wrapper
beforeEach(() => {
  prevApi = window.shellApi
  writeClipboard = vi.fn()
  window.shellApi = { writeClipboard }
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  window.shellApi = prevApi
  vi.useRealTimers()
})

describe('NativeChatCopyButton', () => {
  it('copies its text, says "Copied" (label and live region), then resets', async () => {
    vi.useFakeTimers()
    wrapper = mount(NativeChatCopyButton, { props: { text: 'hello\nworld' } })
    const button = wrapper.find('button')
    expect(button.attributes('type')).toBe('button')
    expect(button.attributes('aria-label')).toBe('Copy message')
    expect(wrapper.find('[role="status"]').text()).toBe('')
    await button.trigger('click')
    await flushPromises()
    expect(writeClipboard).toHaveBeenCalledWith('hello\nworld')
    expect(button.attributes('aria-label')).toBe('Copied')
    expect(button.classes()).toContain('is-copied')
    expect(wrapper.find('[role="status"]').text()).toBe('Copied')
    vi.advanceTimersByTime(1600)
    await flushPromises()
    expect(button.attributes('aria-label')).toBe('Copy message')
    expect(wrapper.find('[role="status"]').text()).toBe('')
  })

  it('uses the given label for what it copies', () => {
    wrapper = mount(NativeChatCopyButton, { props: { text: 'x', label: 'Copy code' } })
    expect(wrapper.find('button').attributes('title')).toBe('Copy code')
  })

  it('a clipboard failure is harmless and shows no success', async () => {
    window.shellApi = { writeClipboard: vi.fn(() => Promise.reject(new Error('unfocused'))) }
    wrapper = mount(NativeChatCopyButton, { props: { text: 'x' } })
    await wrapper.find('button').trigger('click')
    await flushPromises()
    expect(wrapper.find('button').attributes('aria-label')).toBe('Copy message')
  })

  it('without the clipboard bridge there is no button', () => {
    window.shellApi = {}
    wrapper = mount(NativeChatCopyButton, { props: { text: 'x' } })
    expect(wrapper.find('button').exists()).toBe(false)
  })
})
