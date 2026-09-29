// One chat row (components/chat/ChatMessage.vue): an error is shown whole
// and can be copied; a team message not delivered yet says it is sent again.
// And a tool the agent's stop cut short (ChatToolRow.vue): "Stopped".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import ChatMessage from '../components/chat/ChatMessage.vue'
import ChatToolRow from '../components/chat/ChatToolRow.vue'

describe('ChatMessage.vue', () => {
  let prevApi, writeClipboard, wrapper

  beforeEach(() => {
    prevApi = window.shellApi
    writeClipboard = vi.fn()
    window.shellApi = { writeClipboard }
  })
  afterEach(() => {
    if (wrapper) wrapper.unmount()
    wrapper = null
    window.shellApi = prevApi
    vi.useRealTimers()
  })

  const mountRow = (row) => (wrapper = mount(ChatMessage, { props: { row }, attachTo: document.body }))

  it('a failed turn: "Failed" on its line, the whole error under it, copied with a button', async () => {
    vi.useFakeTimers()
    const error = `API Error: 400 ${'x'.repeat(300)}\nsecond line of the error`
    mountRow({ kind: 'turn', status: 'failed', durationMs: null, costUsd: null, error })
    expect(wrapper.find('.chat-turn-text').text()).toBe('Failed')
    const box = wrapper.find('[data-test="chat-turn-error"]')
    // All of it, new lines kept (never cut to one line).
    expect(box.find('.chat-error-text').element.textContent).toBe(error)
    const btn = box.find('[data-test="chat-copy-error"]')
    expect(btn.element.tagName).toBe('BUTTON')
    expect(btn.attributes('type')).toBe('button')
    expect(btn.attributes('aria-label')).toBe('Copy the error text')
    const status = box.find('[role="status"]')
    expect(status.text()).toBe('')
    await btn.trigger('click')
    expect(writeClipboard).toHaveBeenCalledWith(error)
    expect(status.text()).toBe('Copied')
    vi.advanceTimersByTime(2100)
    await nextTick()
    expect(status.text()).toBe('')
  })

  it('an interrupted turn with an error shows it too; a completed turn or one without error has no box', () => {
    mountRow({ kind: 'turn', status: 'interrupted', error: 'Cancelled by the server' })
    expect(wrapper.find('.chat-turn-text').text()).toBe('Interrupted')
    expect(wrapper.find('[data-test="chat-turn-error"]').classes()).toContain('st-interrupted')
    wrapper.unmount()
    mountRow({ kind: 'turn', status: 'failed', error: '' })
    expect(wrapper.find('.chat-turn-text').text()).toBe('Failed')
    expect(wrapper.find('[data-test="chat-turn-error"]').exists()).toBe(false)
    wrapper.unmount()
    mountRow({ kind: 'turn', status: 'completed', durationMs: 2000, error: '' })
    expect(wrapper.find('.chat-turn-text').text()).toBe('Done in 2 s')
    expect(wrapper.find('[data-test="chat-turn-error"]').exists()).toBe(false)
  })

  it('an error notice can be copied; an info notice has no button', async () => {
    mountRow({ kind: 'notice', level: 'error', text: 'The turn failed:\nusage limit' })
    expect(wrapper.find('[data-test="chat-notice"] .chat-error-text').element.textContent).toBe('The turn failed:\nusage limit')
    await wrapper.find('[data-test="chat-copy-error"]').trigger('click')
    expect(writeClipboard).toHaveBeenCalledWith('The turn failed:\nusage limit')
    wrapper.unmount()
    mountRow({ kind: 'notice', level: 'info', text: 'Model changed' })
    expect(wrapper.find('[data-test="chat-notice"]').text()).toBe('Model changed')
    expect(wrapper.find('[data-test="chat-copy-error"]').exists()).toBe(false)
  })

  it('without the clipboard bridge: the error is shown, no Copy button', () => {
    window.shellApi = {}
    mountRow({ kind: 'turn', status: 'failed', error: 'boom' })
    expect(wrapper.find('[data-test="chat-turn-error"]').text()).toBe('boom')
    expect(wrapper.find('[data-test="chat-copy-error"]').exists()).toBe(false)
  })

  it('a team message not delivered: not an error, it will be sent again; a user message: "Not sent"', () => {
    mountRow({ kind: 'user', id: 'x1', text: 'build ok', origin: 'team', from: '3', status: 'failed' })
    const chip = wrapper.find('[data-test="chat-user-status"]')
    expect(chip.text()).toBe('Not delivered yet: will be sent again')
    expect(chip.classes()).not.toContain('err')
    wrapper.unmount()
    mountRow({ kind: 'user', id: 'u1', text: 'mine', origin: 'user', status: 'failed' })
    expect(wrapper.find('[data-test="chat-user-status"]').text()).toBe('Not sent')
    expect(wrapper.find('[data-test="chat-user-status"]').classes()).toContain('err')
  })
})

describe('ChatToolRow.vue', () => {
  it('a stopped tool says so, neither failed nor running', () => {
    const w = mount(ChatToolRow, { props: { row: { kind: 'tool', id: 't1', name: 'Bash', summary: 'Bash: sleep 9', input: null, result: null, status: 'stopped' } } })
    expect(w.find('.chat-tool-status').text()).toBe('Stopped')
    expect(w.find('.chat-tool-icon.err').exists()).toBe(false)
    expect(w.find('.chat-tool-icon.spin').exists()).toBe(false)
    w.unmount()
  })
})
