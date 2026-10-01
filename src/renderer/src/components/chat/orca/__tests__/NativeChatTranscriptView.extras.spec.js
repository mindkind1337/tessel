// The terminal agent chat view, closer to the chat pane: its right-click
// menu, background-task dock, skills, earlier history, held messages, slash
// command rows, context window and file drops (a fake window.shellApi).
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
const SESSION = '22222222-3333-4444-8555-666666666666'

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

async function mountChat(props = {}) {
  wrapper = mount(NativeChatTranscriptView, {
    props: { agent: 'claude', sessionId: SESSION, agentName: 'Claude Code', interactive: true, paneId: 'pane-3', accountId: 'acc-1', allowImages: true, ...props },
    attachTo: document.body,
    global: { stubs: { transition: false } }
  })
  await flushPromises()
}
const text = () => document.body.textContent
const composer = () => wrapper.findComponent({ name: 'NativeChatComposer' })
const list = () => wrapper.findComponent({ name: 'NativeChatMessageList' })
const settle = async () => {
  await flushPromises()
  await vi.advanceTimersByTimeAsync(0)
  await flushPromises()
}
const send = (lines) => {
  for (const cb of listeners) cb({ viewId: 'tv-1', ok: true, events: lines })
}

describe('the chat view right-click menu', () => {
  it("Paste into the composer, the pane's own actions, back to the terminal; never the pane's menu under it", async () => {
    const paneActions = { onSplitRight: vi.fn(), onSplitDown: vi.fn(), isPaneExpanded: false, onToggleExpand: vi.fn(), onClosePane: vi.fn() }
    await mountChat({ paneActions })
    const outside = vi.fn()
    document.body.addEventListener('contextmenu', outside)
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 50 })
    document.querySelector('.nc-transcript-body').dispatchEvent(event)
    await settle()
    document.body.removeEventListener('contextmenu', outside)
    expect(event.defaultPrevented).toBe(true)
    expect(outside).not.toHaveBeenCalled()
    const menu = document.querySelector('[data-test="chat-context-menu"]')
    expect(menu).not.toBeNull()
    const labels = [...menu.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent.replace(/Ctrl\+\S+/, '').trim())
    expect(labels).toEqual(['Copy', 'Paste', 'Continue in a terminal', 'Split Right', 'Split Down', 'Maximize Pane', 'Close Pane'])
    const actions = wrapper.findComponent({ name: 'NativeChatContextMenu' }).props('actions')
    actions.onSplitRight()
    actions.onClosePane()
    expect(paneActions.onSplitRight).toHaveBeenCalled()
    expect(paneActions.onClosePane).toHaveBeenCalled()
    actions.onSwitchToTerminal()
    expect(wrapper.emitted('close')).toHaveLength(1)
    expect(typeof actions.onPaste).toBe('function')
  })

  it('the read-only view has no menu of its own', async () => {
    wrapper = mount(NativeChatTranscriptView, { props: { agent: 'grok', sessionId: 'a1b2c3d4-0000', agentName: 'Grok' }, attachTo: document.body })
    await flushPromises()
    expect(wrapper.findComponent({ name: 'NativeChatContextMenu' }).exists()).toBe(false)
  })
})

describe('the background-task dock', () => {
  it('what the file shows running, less what the agent no longer lists; no Stop, where to stop instead', async () => {
    const startedAt = Date.now() - 5000
    api.open.mockResolvedValueOnce({ ok: true, viewId: 'tv-1', events: conversation, background: [{ id: 'bsrv', kind: 'command', description: 'Start the dev server', startedAt }] })
    await mountChat()
    expect(document.querySelector('[data-native-chat-background-tasks]')).not.toBeNull()
    document.querySelector('.nc-bg-tasks__header').click()
    await settle()
    expect(text()).toContain('Start the dev server')
    expect(document.querySelector('[data-test="bg-tasks-stop-note"]')).not.toBeNull()
    expect([...document.querySelectorAll('.nc-bg-tasks button')].some((b) => b.textContent.trim() === 'Stop')).toBe(false)
    // Its last Stop, after it started, no longer lists it: over.
    await wrapper.setProps({ background: { ids: [], listedAt: startedAt + 60000 } })
    expect(document.querySelector('[data-native-chat-background-tasks]')).toBeNull()
  })
})

describe('the "/" menu skills', () => {
  it('asked by agent, account and its own view', async () => {
    const result = { skills: [{ id: 'skill-1', name: 'deploy', providers: ['claude'], rootPath: 'source-1' }], sources: [{ id: 'source-1', path: 'source-1', owner: 'claude' }] }
    api.skills = vi.fn(async () => ({ ok: true, result }))
    await mountChat()
    const options = composer().props('skillsOptions')
    expect(options).toBeTruthy()
    expect(await options.discover({ refresh: true })).toEqual(result)
    expect(api.skills).toHaveBeenCalledWith({ agent: 'claude', accountId: 'acc-1', viewId: 'tv-1', refresh: true })
    api.skills.mockResolvedValueOnce({ ok: false, error: 'nope' })
    await expect(options.discover({})).rejects.toThrow('nope')
  })
})

describe('earlier history', () => {
  it('scrolled up: earlier lines are read from the same view and shown before', async () => {
    api.open.mockResolvedValueOnce({ ok: true, viewId: 'tv-1', events: conversation, more: true })
    api.earlier = vi.fn(async () => ({
      ok: true,
      added: 2,
      more: false,
      events: [{ type: 'user', id: 'hist-u0', text: 'An older question', status: 'accepted', imported: true, at: 500 }, ...conversation]
    }))
    await mountChat()
    expect(list().props('session').hasMore).toBe(true)
    expect(await list().props('session').loadEarlier()).toBe('applied')
    expect(api.earlier).toHaveBeenCalledWith({ viewId: 'tv-1' })
    await flushPromises()
    expect(text()).toContain('An older question')
    expect(list().props('session').hasMore).toBe(false)
    expect(list().props('session').olderHistoryGeneration).toBe(1)
    expect(await list().props('session').loadEarlier()).toBe('unchanged')
  })

  it('a failed read says so (the list stops asking)', async () => {
    api.open.mockResolvedValueOnce({ ok: true, viewId: 'tv-1', events: conversation, more: true })
    api.earlier = vi.fn(async () => ({ ok: false, code: 'changed' }))
    await mountChat()
    expect(await list().props('session').loadEarlier()).toBe('failed')
  })
})

describe('messages and commands', () => {
  it('a message the delivery holds shows as waiting, with why, until it is typed; a send scrolls to it', async () => {
    const sendMessage = vi.fn()
    let held = 'Waiting: a line is typed in its terminal.'
    await mountChat({ sendMessage, sendHeldReason: () => held })
    const before = list().props('scrollToLatestSignal')
    await composer().props('send')('Hold me')
    await flushPromises()
    expect(list().props('scrollToLatestSignal')).toBe(before + 1)
    expect(document.querySelector('[data-test="nc-user-queued"]').textContent).toContain('Waiting: a line is typed in its terminal.')
    held = ''
    sendMessage.mock.calls[0][1].onDelivered()
    await flushPromises()
    expect(document.querySelector('[data-test="nc-user-queued"]')).toBeNull()
  })

  it('slash commands from the file are "Ran" rows (each run once, with the one sent from here), not your messages', async () => {
    const sendMessage = vi.fn()
    await mountChat({ sendMessage })
    await composer().props('send')('/compact')
    const now = Date.now()
    send([
      ...conversation,
      { type: 'user', id: 'hist-c1', text: '/compact', status: 'accepted', imported: true, at: now },
      { type: 'user', id: 'hist-c2', text: '/compact', status: 'accepted', imported: true, at: now + 30000 },
      { type: 'user', id: 'hist-c3', text: '/model haiku', status: 'accepted', imported: true, at: now + 40000 }
    ])
    await flushPromises()
    expect(text().split('Ran /compact').length - 1).toBe(1)
    expect(text().split('Ran /model haiku').length - 1).toBe(1)
    expect(text().replace(/Ran \/compact|Ran \/model haiku/g, '')).not.toMatch(/\/compact|\/model haiku/)
  })

  it('the context ring of a Claude model without [1m]: its 200k window', async () => {
    api.open.mockResolvedValueOnce({ ok: true, viewId: 'tv-1', events: [...conversation, { type: 'contextUsage', usedTokens: 50000, windowTokens: null }] })
    await mountChat({ contextModel: 'claude-opus-5-5' })
    expect(composer().props('contextUsage')).toMatchObject({ usedTokens: 50000, windowTokens: 200000, percentage: 25 })
  })
})

describe('files dropped on the chat view', () => {
  function dropEvent(dataTransfer) {
    const drop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(drop, 'dataTransfer', { value: { effectAllowed: 'all', dropEffect: 'none', files: [], getData: () => '', ...dataTransfer } })
    return drop
  }

  it('an image dropped anywhere on it is attached as a pasted one, never passed to the terminal under it', async () => {
    const image = { id: 'img_0123456789abcdef01234567', name: 'shot.png', width: 1, height: 1 }
    const imageImport = vi.fn(async () => ({ ok: true, image }))
    window.shellApi.chat = { imageSave: vi.fn(), imageImport, imageDiscard: vi.fn(), imagePaths: vi.fn() }
    window.shellApi.pathForFile = () => 'C:/Users/me/shot.png'
    await mountChat()
    const outside = vi.fn()
    document.body.addEventListener('drop', outside)
    const drop = dropEvent({ types: ['Files'], files: [{ name: 'shot.png', type: 'image/png' }] })
    document.querySelector('.nc-transcript-body').dispatchEvent(drop)
    await flushPromises()
    document.body.removeEventListener('drop', outside)
    expect(drop.defaultPrevented).toBe(true)
    expect(outside).not.toHaveBeenCalled()
    expect(imageImport).toHaveBeenCalledTimes(1)
    expect(imageImport.mock.calls[0][0]).toMatchObject({ paneId: 'terminal-chat-pane-3' })
  })

  it("a path from Tessel's file tree (not an image) goes into the draft", async () => {
    await mountChat()
    const drop = dropEvent({ types: ['text/x-tessel-path'], getData: (type) => (type === 'text/x-tessel-path' ? 'C:/repo/notes.md' : '') })
    document.querySelector('.nc-transcript-body').dispatchEvent(drop)
    await flushPromises()
    expect(drop.defaultPrevented).toBe(true)
    expect(composer().vm.draft).toContain('C:/repo/notes.md')
  })

  it('asleep: a drop is taken (not passed to the terminal) but nothing is attached', async () => {
    const imageImport = vi.fn()
    window.shellApi.chat = { imageImport }
    window.shellApi.pathForFile = () => 'C:/Users/me/shot.png'
    await mountChat({ disabledReason: 'Asleep' })
    const outside = vi.fn()
    document.body.addEventListener('drop', outside)
    const drop = dropEvent({ types: ['Files'], files: [{ name: 'shot.png', type: 'image/png' }] })
    document.querySelector('.nc-transcript-body').dispatchEvent(drop)
    await flushPromises()
    document.body.removeEventListener('drop', outside)
    expect(outside).not.toHaveBeenCalled()
    expect(imageImport).not.toHaveBeenCalled()
  })
})
