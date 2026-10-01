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

describe('NativeChatTranscriptView, a terminal agent chat view (interactive)', () => {
  const SESSION = '22222222-3333-4444-8555-666666666666'
  async function mountChat(props = {}) {
    await mountView({ agent: 'claude', sessionId: SESSION, agentName: 'Claude Code', interactive: true, paneId: 'pane-3', accountId: 'acc-1', ...props })
  }
  const composer = () => wrapper.findComponent({ name: 'NativeChatComposer' })

  it('asks by pane and account (never a folder), with a composer', async () => {
    await mountChat()
    expect(api.open).toHaveBeenCalledWith({ agent: 'claude', sessionId: SESSION, paneId: 'pane-3', accountId: 'acc-1' })
    expect(document.querySelector('[data-test="chat-composer"]')).not.toBeNull()
    expect(text()).not.toContain('Read only')
    expect(text()).toContain('Show terminal')
  })

  it('no conversation yet: waits for it without asking for a file', async () => {
    await mountChat({ sessionId: '' })
    expect(api.open).not.toHaveBeenCalled()
    expect(text()).toContain('Waiting for the conversation')
    await wrapper.setProps({ sessionId: SESSION })
    await flushPromises()
    expect(api.open).toHaveBeenCalledTimes(1)
    expect(text()).toContain('List the files')
  })

  it('a message goes through the given delivery, shows as sent, then once from the file', async () => {
    const sendMessage = vi.fn()
    await mountChat({ sendMessage })
    expect(await composer().props('send')('Run the tests')).toEqual({ ok: true })
    expect(sendMessage).toHaveBeenCalledWith('Run the tests', expect.objectContaining({ onDelivered: expect.any(Function), onFailed: expect.any(Function) }))
    await flushPromises()
    expect(text()).toContain('Run the tests')
    for (const cb of listeners)
      cb({ viewId: 'tv-1', ok: true, events: [...conversation, { type: 'user', id: 'hist-u9', text: 'Run the tests', status: 'accepted', at: Date.now() }] })
    await flushPromises()
    expect(text().split('Run the tests').length - 1).toBe(1)
    // Failed delivery: no longer shown as sent.
    await composer().props('send')('Lost one')
    sendMessage.mock.calls.at(-1)[1].onFailed()
    await flushPromises()
    expect(text()).not.toContain('Lost one')
  })

  it('nothing is sent while it cannot be (asleep)', async () => {
    const sendMessage = vi.fn()
    await mountChat({ sendMessage, disabledReason: 'Asleep' })
    expect(await composer().props('send')('hi')).toMatchObject({ ok: false })
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('Stop sends Escape, only while it works', async () => {
    const writeKeys = vi.fn()
    await mountChat({ writeKeys })
    composer().vm.$emit('interrupt')
    expect(writeKeys).not.toHaveBeenCalled()
    await wrapper.setProps({ working: true })
    composer().vm.$emit('interrupt')
    expect(writeKeys).toHaveBeenCalledWith('\x1b')
  })

  it('an approval: Allow types 1, Deny Escape', async () => {
    const writeKeys = vi.fn()
    await mountChat({ writeKeys, waiting: { approval: true } })
    document.querySelector('[data-test="terminal-chat-allow"]').click()
    document.querySelector('[data-test="terminal-chat-deny"]').click()
    expect(writeKeys.mock.calls.map((c) => c[0])).toEqual(['1', '\x1b'])
  })

  it("a question from the file: answered with the selector's keys", async () => {
    const writeKeys = vi.fn()
    const question = { questions: [{ question: 'Which file?', options: [{ label: 'a.js' }, { label: 'b.js' }] }] }
    api.open.mockResolvedValueOnce({
      ok: true,
      viewId: 'tv-1',
      events: [...conversation.slice(0, 2), { type: 'tool', id: 'ask-1', name: 'AskUserQuestion', input: question, status: 'running', at: 2500 }]
    })
    await mountChat({ writeKeys, waiting: { approval: true, input: true } })
    expect(document.querySelector('[data-test="terminal-chat-question"]')).not.toBeNull()
    expect(text()).toContain('Which file?')
    wrapper.findComponent({ name: 'NativeChatQuestionCard' }).vm.$emit('answer', [{ indices: [1], other: '' }])
    await vi.advanceTimersByTimeAsync(10)
    expect(writeKeys).toHaveBeenCalledWith('2')
  })
})
