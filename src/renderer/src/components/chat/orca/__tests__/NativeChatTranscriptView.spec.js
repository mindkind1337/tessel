// The read-only conversation view of a terminal agent (Grok, OpenClaude, OMP)
// with a fake window.shellApi.transcriptView.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import NativeChatTranscriptView from '../NativeChatTranscriptView.vue'
import { installNativeChatMessageListTestViewport } from '../../../../chat/orca/native-chat-message-list-test-viewport.js'

let restoreViewport = () => {}
beforeAll(() => {
  restoreViewport = installNativeChatMessageListTestViewport()
})
afterAll(() => restoreViewport())

const conversation = [
  { type: 'user', id: 'hist-u1', text: 'List the files', origin: 'user', status: 'accepted', imported: true, at: 1000 },
  { type: 'assistant', messageId: 'hist-a1', text: 'Two files.', imported: true, at: 2000 },
  { type: 'turnEnd', status: 'completed', imported: true, at: 3000 }
]

let api, listeners, wrapper, prevApi
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  listeners = []
  api = {
    open: vi.fn(async () => ({ ok: true, viewId: 'tv-1', events: conversation, truncated: false })),
    close: vi.fn(async () => ({ ok: true })),
    onEvent: vi.fn((cb) => {
      listeners.push(cb)
      return () => (listeners = listeners.filter((l) => l !== cb))
    })
  }
  prevApi = window.shellApi
  window.shellApi = { transcriptView: api }
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  window.shellApi = prevApi
  vi.useRealTimers()
  document.body.replaceChildren()
})

async function mountView(props = {}) {
  wrapper = mount(NativeChatTranscriptView, {
    props: { agent: 'grok', sessionId: 'a1b2c3d4-0000', agentName: 'Grok', ...props },
    attachTo: document.body,
    global: { stubs: { transition: false } }
  })
  await flushPromises()
}
const text = () => document.body.textContent

describe('NativeChatTranscriptView', () => {
  it('asks the main process by agent and session id only, and shows the conversation read-only', async () => {
    await mountView()
    expect(api.open).toHaveBeenCalledWith({ agent: 'grok', sessionId: 'a1b2c3d4-0000' })
    expect(text()).toContain('List the files')
    expect(text()).toContain('Two files.')
    expect(text()).toContain('Read only: type in the terminal')
    expect(document.querySelector('[data-test="chat-composer"]')).toBeNull()
    expect(document.querySelector('[contenteditable="true"]')).toBeNull()
  })

  it('follows what the agent writes (its own view only)', async () => {
    await mountView()
    for (const cb of listeners) cb({ viewId: 'other', ok: true, events: [{ type: 'user', id: 'x', text: 'not mine', status: 'accepted' }] })
    for (const cb of listeners)
      cb({ viewId: 'tv-1', ok: true, events: [...conversation, { type: 'user', id: 'hist-u2', text: 'And now?', status: 'accepted', at: 4000 }] })
    await flushPromises()
    expect(text()).toContain('And now?')
    expect(text()).not.toContain('not mine')
  })

  it('no file yet: says so and looks again while shown', async () => {
    api.open.mockResolvedValueOnce({ ok: false, code: 'missing' })
    await mountView()
    expect(document.querySelector('[data-test="transcript-view-missing"]')).not.toBeNull()
    await vi.advanceTimersByTimeAsync(3000)
    await flushPromises()
    expect(api.open).toHaveBeenCalledTimes(2)
    expect(text()).toContain('List the files')
  })

  it('hidden, it stops watching; shown again, it opens again; closed, the watch ends', async () => {
    await mountView()
    await wrapper.setProps({ isVisible: false })
    expect(api.close).toHaveBeenCalledWith({ viewId: 'tv-1' })
    await wrapper.setProps({ isVisible: true })
    await flushPromises()
    expect(api.open).toHaveBeenCalledTimes(2)
    wrapper.unmount()
    wrapper = null
    expect(api.close).toHaveBeenCalledTimes(2)
    expect(listeners).toHaveLength(0)
  })

  it('Back to terminal asks to close', async () => {
    await mountView()
    document.querySelector('[data-test="transcript-view-close"]').click()
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('an unreadable conversation says so; without the bridge too', async () => {
    api.open.mockResolvedValueOnce({ ok: false, code: 'invalid' })
    await mountView()
    expect(document.querySelector('[data-test="transcript-view-error"]')).not.toBeNull()
    wrapper.unmount()
    window.shellApi = {}
    await mountView()
    expect(document.querySelector('[data-test="transcript-view-error"]')).not.toBeNull()
  })
})
