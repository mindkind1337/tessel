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
    // No bar of its own: "Show terminal" is in the pane header.
    expect(document.querySelector('.nc-transcript-head')).toBeNull()
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

describe('NativeChatTranscriptView, the full composer of a terminal agent chat view', () => {
  const SESSION = '22222222-3333-4444-8555-666666666666'
  const COPY = ['C:', 'Temp', 'tessel-paste', 'chat', 'img_0123456789abcdef01234567.png'].join(String.fromCharCode(92))
  async function mountChat(props = {}) {
    await mountView({ agent: 'claude', sessionId: SESSION, agentName: 'Claude Code', interactive: true, paneId: 'pane-3', allowImages: true, ...props })
  }
  const composer = () => wrapper.findComponent({ name: 'NativeChatComposer' })

  it('takes images: their copies are named by id, and the paths go with the message', async () => {
    const imagePaths = vi.fn(async () => ({ ok: true, paths: [COPY] }))
    window.shellApi.chat = { imagePaths }
    const sendMessage = vi.fn()
    await mountChat({ sendMessage })
    expect(composer().props('allowImages')).toBe(true)
    expect(await composer().props('send')('What is this?', { images: ['img_0123456789abcdef01234567'] })).toEqual({ ok: true })
    expect(imagePaths).toHaveBeenCalledWith({ paneId: 'terminal-chat-pane-3', ids: ['img_0123456789abcdef01234567'] })
    expect(sendMessage).toHaveBeenCalledWith('What is this?', expect.objectContaining({ images: [COPY] }))
  })

  it('a dropped image: saved and taken back under the same pane key, its path sent with the message', async () => {
    const image = { id: 'img_0123456789abcdef01234567', name: 'shot.png', width: 1, height: 1 }
    const imageImport = vi.fn(async () => ({ ok: true, image }))
    const imagePaths = vi.fn(async () => ({ ok: true, paths: [COPY] }))
    window.shellApi.chat = { imageSave: vi.fn(), imageImport, imageDiscard: vi.fn(), imagePaths }
    const sendMessage = vi.fn()
    await mountChat({ sendMessage })
    expect(composer().vm.attachResolvedPaths(['C:/Users/me/shot.png'])).toBe(true)
    await flushPromises()
    await composer().vm.setDraft('this one')
    await composer().vm.send()
    await flushPromises()
    expect(imagePaths.mock.calls[0][0].paneId).toBe(imageImport.mock.calls[0][0].paneId)
    expect(sendMessage).toHaveBeenCalledWith('this one', expect.objectContaining({ images: [COPY] }))
  })

  it('never names a file other than its own copies', async () => {
    window.shellApi.chat = { imagePaths: vi.fn(async () => ({ ok: true, paths: ['C:/Users/me/secret.png'] })) }
    const sendMessage = vi.fn()
    await mountChat({ sendMessage })
    expect(await composer().props('send')('x', { images: ['img_0123456789abcdef01234567'] })).toMatchObject({ ok: false })
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('a slash command is typed as one, with a "Ran" row; the "/" menu lists the agent commands', async () => {
    const sendMessage = vi.fn()
    await mountChat({ sendMessage })
    const names = composer().props('commands').map((c) => c.name)
    expect(names).toContain('compact')
    expect(await composer().props('send')('/compact')).toEqual({ ok: true })
    expect(sendMessage).toHaveBeenCalledWith('/compact', { command: 'paste' })
    await flushPromises()
    expect(text()).toContain('Ran /compact')
  })

  it('Claude Code: model and effort pickers go through the pane (setOption), shown as changed once it confirms', async () => {
    const setOption = vi.fn(async () => ({ ok: true }))
    await mountChat({
      setOption,
      sessionOptions: { models: [{ id: 'opus', label: 'Opus', options: [] }, { id: 'sonnet', label: 'Sonnet', options: [] }], values: { model: 'sonnet' } }
    })
    const snapshot = composer().props('sessionOptionsSnapshot')
    expect(snapshot.map((o) => o.id)).toContain('model')
    expect(snapshot.some((o) => o.id === 'permissionMode')).toBe(false)
    expect(snapshot.find((o) => o.id === 'model').kind.currentValue).toBe('sonnet')
    const res = await composer().props('sessionOptionsSurface').setOption('model', 'opus')
    expect(res).toEqual({ ok: true })
    expect(setOption).toHaveBeenCalledWith({ model: 'opus' })
    await flushPromises()
    expect(composer().props('sessionOptionsSnapshot').find((o) => o.id === 'model').kind.currentValue).toBe('opus')
    // A bare /model opens the picker here.
    expect(composer().props('onOptionCommand')('model')).toEqual({ ok: true })
    await flushPromises()
    expect(composer().props('sessionOptionsPickerRequest')).toMatchObject({ id: 'model' })
  })

  it("Codex: /model opens its own picker in the terminal (typed key by key)", async () => {
    const sendMessage = vi.fn()
    await mountChat({ agent: 'codex', sendMessage, setOption: vi.fn(), sessionOptions: { models: [{ id: 'gpt-5.5', label: 'GPT-5.5', options: [] }], values: {} } })
    expect(composer().props('onOptionCommand')('model')).toEqual({ ok: true })
    expect(sendMessage).toHaveBeenCalledWith('/model', { command: 'type' })
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('OpenClaude without a model list: /model goes to its own picker', async () => {
    const sendMessage = vi.fn()
    await mountChat({ agent: 'openclaude', sendMessage })
    expect(composer().props('sessionOptionsSnapshot')).toEqual([])
    expect(composer().props('onOptionCommand')('model')).toEqual({ ok: true })
    expect(sendMessage).toHaveBeenCalledWith('/model', { command: 'paste' })
  })

  it('"@": the project files, loaded once asked', async () => {
    const listFiles = vi.fn(async () => ['src/App.vue', 'README.md'])
    await mountChat({ listFiles })
    const suggest = composer().props('mentionSuggest')
    expect(suggest('app')).toEqual([])
    await flushPromises()
    expect(suggest('app')).toEqual(['src/App.vue'])
    expect(listFiles).toHaveBeenCalledTimes(1)
  })

  it('the context ring: what the latest answer read', async () => {
    api.open.mockResolvedValueOnce({
      ok: true,
      viewId: 'tv-1',
      events: [...conversation, { type: 'contextUsage', usedTokens: 50000, windowTokens: null }]
    })
    await mountChat({ contextModel: 'claude-opus-5-5[1m]' })
    expect(composer().props('contextUsage')).toMatchObject({ usedTokens: 50000, windowTokens: 1000000, percentage: 5 })
  })
})
