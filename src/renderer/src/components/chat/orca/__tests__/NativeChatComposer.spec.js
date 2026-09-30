// After Orca's NativeChatComposer.test.tsx (structured cases; MIT, Copyright (c) 2026
// Lovecast Inc.) and Tessel's composer rules (chatPane.spec.js / ChatComposer.vue).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'

vi.mock('../NativeChatSessionOptionPickers.vue', () => ({
  default: defineComponent({
    props: ['surface', 'snapshot', 'isWorking', 'pickerRequest'],
    setup: (props) => () =>
      h('div', { 'data-testid': 'session-option-pickers', 'data-snapshot': JSON.stringify(props.snapshot ?? null) })
  })
}))
vi.mock('../NativeChatContextUsageRing.vue', () => ({
  default: defineComponent({ props: ['usage'], setup: () => () => h('div', { 'data-testid': 'context-ring' }) })
}))

import NativeChatComposer from '../NativeChatComposer.vue'
import NativeChatComposerPane from '../NativeChatComposerPane.vue'
import { clearNativeChatDraftCacheForTests } from '../../../../chat/orca/native-chat-draft-cache.js'
import { clearNativeChatAttachmentCacheForTests } from '../../../../chat/orca/composables/use-native-chat-composer-attachments.js'
import { changePrompt, promptEditor, promptValue } from './native-chat-prompt-editor.test-support.js'

let wrapper = null
beforeEach(() => {
  clearNativeChatDraftCacheForTests()
  clearNativeChatAttachmentCacheForTests()
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.replaceChildren()
})

// A parent that binds v-model like the chat pane will.
async function render(props = {}, { vModel = true } = {}) {
  const Host = defineComponent({
    data: () => ({ draft: props.modelValue ?? '' }),
    render() {
      return h(NativeChatComposer, {
        ref: 'composer',
        paneKey: 'pane-1',
        send: props.send ?? vi.fn(async () => ({ ok: true })),
        ...props,
        ...(vModel ? { modelValue: this.draft, 'onUpdate:modelValue': (v) => (this.draft = v) } : {})
      })
    }
  })
  wrapper = mount(Host, { attachTo: document.body, global: { stubs: { transition: false } } })
  await flushPromises()
  return wrapper
}
// Exposed methods live on NativeChatComposer; events are emitted by its pane.
const composer = () => wrapper.findComponent(NativeChatComposer)
const pane = () => wrapper.findComponent(NativeChatComposerPane)
const input = () => document.querySelector('[data-test="chat-input"]')
const sendButton = () => wrapper.find('[data-test="chat-send"]')
const stopButton = () => wrapper.find('[data-test="chat-interrupt"]')
const notice = () => wrapper.find('[data-test="chat-composer-notice"]')
async function type(text) {
  changePrompt(input(), text)
  await flushPromises()
}
async function key(init) {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  for (const name of ['keyCode', 'isComposing']) {
    if (name in init) Object.defineProperty(event, name, { value: init[name] })
  }
  input().dispatchEvent(event)
  await flushPromises()
  return event
}

describe('NativeChatComposer (structured)', () => {
  it('routes structured sends and session options through the composer', async () => {
    const send = vi.fn(async () => ({ ok: true }))
    const snapshot = [{ id: 'model' }]
    await render({ send, sessionOptionsSnapshot: snapshot })
    expect(JSON.parse(wrapper.find('[data-testid="session-option-pickers"]').attributes('data-snapshot'))).toEqual(snapshot)
    await type('hello')
    await sendButton().trigger('click')
    await flushPromises()
    expect(send).toHaveBeenCalledWith('hello')
    expect(promptValue(input())).toBe('')
    expect(wrapper.vm.draft).toBe('')
    expect(pane().emitted('sent')[0]).toEqual(['hello'])
  })

  // The structured menu offers only what a pick can carry out: the host's own
  // commands, plus the ones the agent itself runs from message text (Codex `/goal`).
  it.each([
    ['claude', 'compact', ['model', 'effort']],
    ['codex', 'vim', ['model', 'effort', 'goal']]
  ])('offers %s only actionable structured slash commands', async (agent, withheld, offered) => {
    await render({ agent, paneKey: `pane-${agent}`, modelValue: '/', setOption: vi.fn(async () => ({ ok: true })) })
    const names = [...document.querySelectorAll('[role="option"]')].map((option) =>
      option.querySelector('.nc-picker-token').textContent.replace(/^\//, '')
    )
    expect(names).toEqual(offered)
    expect(names).not.toContain(withheld)
  })

  it('keeps the draft scope anchored to the pane and remounts the field for another pane', async () => {
    await render({ paneKey: 'tab-1:leaf-1' })
    const first = input()
    await type('draft one')
    await wrapper.setProps({})
    expect(input()).toBe(first)

    // Another pane: a fresh field (fresh IME state) with that pane's own draft.
    wrapper.unmount()
    await render({ paneKey: 'tab-1:leaf-2' }, { vModel: false })
    expect(input()).not.toBe(first)
    expect(promptValue(input())).toBe('')
    wrapper.unmount()
    await render({ paneKey: 'tab-1:leaf-1' }, { vModel: false })
    expect(promptValue(input())).toBe('draft one')
  })

  it('remounts the pane composer when paneKey changes', async () => {
    const Host = defineComponent({
      data: () => ({ pane: 'p1' }),
      render() {
        return h(NativeChatComposer, { paneKey: this.pane, send: vi.fn() })
      }
    })
    wrapper = mount(Host, { attachTo: document.body })
    await flushPromises()
    const first = input()
    changePrompt(first, 'in p1')
    await flushPromises()
    wrapper.vm.pane = 'p2'
    await flushPromises()
    expect(input()).not.toBe(first)
    expect(promptValue(input())).toBe('')
    wrapper.vm.pane = 'p1'
    await flushPromises()
    expect(promptValue(input())).toBe('in p1')
  })

  it('adopts an IME deletion delivered only by compositionend', async () => {
    await render({ modelValue: 'hello' })
    const el = input()
    el.dispatchEvent(new Event('compositionstart', { bubbles: true }))
    // The browser emptied the field without a change event the composer adopted.
    promptEditor(el).commands.setContent({ type: 'doc', content: [{ type: 'paragraph' }] }, { emitUpdate: false })
    el.dispatchEvent(new Event('compositionend', { bubbles: true }))
    await flushPromises()
    expect(wrapper.vm.draft).toBe('')
  })

  it('does not duplicate a composition value already adopted by onChange', async () => {
    await render({ modelValue: 'hell' })
    const el = input()
    el.dispatchEvent(new Event('compositionstart', { bubbles: true }))
    changePrompt(el, 'hello')
    await flushPromises()
    const updates = pane().emitted('update:modelValue').length
    el.dispatchEvent(new Event('compositionend', { bubbles: true }))
    await flushPromises()
    expect(pane().emitted('update:modelValue')).toHaveLength(updates)
    expect(wrapper.vm.draft).toBe('hello')
  })
})

describe('NativeChatComposer (Tessel rules)', () => {
  it('Enter sends, Shift+Enter does not (and neither does a chorded Enter)', async () => {
    const send = vi.fn(async () => ({ ok: true }))
    await render({ send })
    await type('run the tests')
    // Shift+Enter: the editor's own new line (a hard break), never a send.
    await key({ key: 'Enter', keyCode: 13, shiftKey: true })
    expect(send).not.toHaveBeenCalled()
    expect(promptValue(input())).toBe('run the tests\n')
    await type('run the tests')
    await key({ key: 'Enter', keyCode: 13, ctrlKey: true })
    expect(send).not.toHaveBeenCalled()
    await type('run the tests')
    const enter = await key({ key: 'Enter', keyCode: 13 })
    expect(enter.defaultPrevented).toBe(true)
    expect(send).toHaveBeenCalledWith('run the tests')
    expect(promptValue(input())).toBe('')
  })

  it('an IME composition never sends', async () => {
    const send = vi.fn(async () => ({ ok: true }))
    await render({ send })
    await type('漢字')
    input().dispatchEvent(new Event('compositionstart', { bubbles: true }))
    await key({ key: 'Enter', keyCode: 13, isComposing: true })
    await key({ key: 'Enter', keyCode: 229 })
    await key({ key: 'Enter', keyCode: 13 })
    expect(send).not.toHaveBeenCalled()
    expect(promptValue(input())).toBe('漢字')
    // Composition over: the confirming Enter's redispatch is swallowed; the
    // next deliberate Enter sends.
    input().dispatchEvent(new Event('compositionend', { bubbles: true }))
    await key({ key: 'Enter', keyCode: 13 })
    expect(send).not.toHaveBeenCalled()
    input().dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }))
    await key({ key: 'Enter', keyCode: 13 })
    expect(send).toHaveBeenCalledWith('漢字')
  })

  it('whitespace cannot be sent', async () => {
    const send = vi.fn(async () => ({ ok: true }))
    await render({ send })
    await type('   ')
    expect(sendButton().element.disabled).toBe(true)
    await key({ key: 'Enter', keyCode: 13 })
    expect(send).not.toHaveBeenCalled()
  })

  it('Escape interrupts while working, not when idle', async () => {
    await render()
    await key({ key: 'Escape' })
    expect(pane().emitted('interrupt')).toBeUndefined()
    expect(stopButton().exists()).toBe(false)
    await wrapper.setProps({ isWorking: true })
    await nextTick()
    const event = await key({ key: 'Escape' })
    expect(event.defaultPrevented).toBe(true)
    expect(pane().emitted('interrupt')).toHaveLength(1)
    await stopButton().trigger('click')
    expect(pane().emitted('interrupt')).toHaveLength(2)
  })

  it('Escape closes the "/" picker first, and only then interrupts', async () => {
    await render({ isWorking: true, commands: [{ name: 'review', kind: 'command', description: 'Review' }] })
    await type('/')
    expect(document.querySelector('[role="listbox"]')).not.toBeNull()
    await key({ key: 'Escape' })
    expect(document.querySelector('[role="listbox"]')).toBeNull()
    expect(pane().emitted('interrupt')).toBeUndefined()
    await key({ key: 'Escape' })
    expect(pane().emitted('interrupt')).toHaveLength(1)
  })

  it('Escape closes the "@file" hint first, and only then interrupts', async () => {
    await render({ isWorking: true })
    await type('see @src')
    expect(wrapper.text()).toContain('Referencing file:')
    await key({ key: 'Escape' })
    expect(wrapper.text()).not.toContain('Referencing file:')
    expect(pane().emitted('interrupt')).toBeUndefined()
    await key({ key: 'Escape' })
    expect(pane().emitted('interrupt')).toHaveLength(1)
  })

  it('a message typed during a turn is sent (at once for Codex); the placeholder stays plain', async () => {
    const send = vi.fn(async () => ({ ok: true }))
    await render({ send, agent: 'codex', agentName: 'Codex' })
    expect(input().getAttribute('aria-label')).toBe('Message Codex…')
    await wrapper.setProps({ isWorking: true })
    await flushPromises()
    expect(input().getAttribute('aria-label')).toBe('Message Codex…')
    expect(sendButton().exists()).toBe(false)
    expect(stopButton().element.disabled).toBe(false)
    await type('next')
    await key({ key: 'Enter', keyCode: 13 })
    expect(send).toHaveBeenCalledWith('next')
  })

  it('OpenCode during a turn: the placeholder stays plain (its row says it waits)', async () => {
    await render({ agent: 'opencode', agentName: 'OpenCode', isWorking: true })
    expect(input().getAttribute('aria-label')).toBe('Message OpenCode…')
  })

  it('Send waits while the agent starts (typing works), and says why', async () => {
    const send = vi.fn(async () => ({ ok: true }))
    await render({ send, sendBlockedReason: 'Wait until Claude has started' })
    expect(input().getAttribute('contenteditable')).toBe('true')
    await type('early')
    expect(sendButton().element.disabled).toBe(true)
    expect(sendButton().attributes('title')).toBe('Wait until Claude has started')
    expect(wrapper.find('[data-test="chat-send-blocked"]').text()).toBe('Wait until Claude has started')
    expect(input().getAttribute('aria-describedby')).toBe(wrapper.find('[data-test="chat-send-blocked"]').attributes('id'))
    await key({ key: 'Enter', keyCode: 13 })
    expect(send).not.toHaveBeenCalled()
    expect(promptValue(input())).toBe('early')
    await wrapper.setProps({ sendBlockedReason: '' })
    await flushPromises()
    expect(sendButton().element.disabled).toBe(false)
    await key({ key: 'Enter', keyCode: 13 })
    expect(send).toHaveBeenCalledWith('early')
  })

  it('disabled with a reason: nothing can be typed or sent, the reason is the placeholder', async () => {
    const send = vi.fn(async () => ({ ok: true }))
    await render({ send, modelValue: 'kept', disabledReason: 'Claude is not signed in' })
    expect(input().getAttribute('contenteditable')).toBe('false')
    expect(input().getAttribute('aria-label')).toBe('Claude is not signed in')
    expect(sendButton().element.disabled).toBe(true)
    await key({ key: 'Enter', keyCode: 13 })
    expect(send).not.toHaveBeenCalled()
    await wrapper.setProps({ disabledReason: '' })
    await flushPromises()
    expect(input().getAttribute('contenteditable')).toBe('true')
    expect(promptValue(input())).toBe('kept')
  })

  it('a refused message keeps the draft, says why, and tells the pane', async () => {
    const send = vi.fn(async () => ({ ok: false, error: 'no session' }))
    await render({ send })
    await type('message A')
    await key({ key: 'Enter', keyCode: 13 })
    expect(send).toHaveBeenCalledWith('message A')
    expect(promptValue(input())).toBe('message A')
    expect(wrapper.vm.draft).toBe('message A')
    expect(notice().text()).toBe('no session')
    expect(pane().emitted('error').at(-1)).toEqual(['no session'])
    expect(pane().emitted('sent')).toBeUndefined()

    // A reply that is not strictly { ok: true } is a refusal too.
    send.mockResolvedValueOnce(undefined)
    await key({ key: 'Enter', keyCode: 13 })
    expect(notice().text()).toBe('The message was not sent. Your draft was kept.')
    expect(promptValue(input())).toBe('message A')

    // Accepted: the draft is cleared and the notice goes.
    send.mockResolvedValueOnce({ ok: true })
    await key({ key: 'Enter', keyCode: 13 })
    expect(promptValue(input())).toBe('')
    expect(notice().exists()).toBe(false)
    expect(pane().emitted('error').at(-1)).toEqual([null])
  })

  it('what was typed while a send was on its way is kept', async () => {
    let resolve
    const send = vi.fn(() => new Promise((r) => (resolve = r)))
    await render({ send })
    await type('message A')
    await key({ key: 'Enter', keyCode: 13 })
    await type('message A and draft B')
    resolve({ ok: true })
    await flushPromises()
    // The sent text leaves the composer; what was typed since stays.
    expect(promptValue(input())).toBe(' and draft B')
    expect(wrapper.vm.draft).toBe(' and draft B')
  })

  it('a refusal while more was typed keeps everything', async () => {
    let resolve
    const send = vi.fn(() => new Promise((r) => (resolve = r)))
    await render({ send })
    await type('message A')
    await key({ key: 'Enter', keyCode: 13 })
    await type('message A and draft B')
    resolve({ ok: false, error: 'no session' })
    await flushPromises()
    expect(promptValue(input())).toBe('message A and draft B')
  })

  it('v-model: the parent sees the draft and can set it', async () => {
    await render({ modelValue: 'from the pane' })
    expect(promptValue(input())).toBe('from the pane')
    await type('typed')
    expect(wrapper.vm.draft).toBe('typed')
    wrapper.vm.draft = ''
    await flushPromises()
    expect(promptValue(input())).toBe('')
    wrapper.vm.draft = 'restored'
    await flushPromises()
    expect(promptValue(input())).toBe('restored')
  })

  it('paste is text only: rich content arrives as plain text, an image is refused with a notice', async () => {
    await render()
    const paste = (data) => {
      const event = new Event('paste', { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'clipboardData', { value: data })
      input().focus()
      input().dispatchEvent(event)
      return event
    }
    const event = paste({
      types: ['text/plain', 'text/html'],
      items: [],
      getData: (format) => (format === 'text/plain' ? 'plain **text**' : '<b>rich</b>')
    })
    await flushPromises()
    expect(event.defaultPrevented).toBe(true)
    expect(promptValue(input())).toBe('plain **text**')
    expect(input().querySelector('b')).toBeNull()

    paste({ types: ['Files'], items: [{ kind: 'file', type: 'image/png' }], getData: () => '' })
    await flushPromises()
    expect(notice().text()).toBe('This chat accepts text only.')
    expect(promptValue(input())).toBe('plain **text**')
  })

  it('images are off by default: no Attach, no chips; allowImages attaches them and sends their ids', async () => {
    const send = vi.fn(async () => ({ ok: true }))
    await render({ send })
    expect(wrapper.find('button[aria-label="Attach images"]').exists()).toBe(false)
    // A dropped image path is inserted as text.
    composer().vm.attachResolvedPaths(['C:\\shots\\a.png'])
    await flushPromises()
    expect(promptValue(input())).toBe('C:\\shots\\a.png ')
    wrapper.unmount()

    let n = 0
    const image = (name) => ({ id: `img_${String(++n).padStart(24, '0')}`, name, width: 688, height: 478 })
    const chat = {
      imageSave: vi.fn(async ({ name }) => ({ ok: true, image: image(name) })),
      imageImport: vi.fn(async ({ path }) => ({ ok: true, image: image(path.split('\\').pop()) })),
      imageDiscard: vi.fn(async () => ({ ok: true }))
    }
    const hadApi = 'shellApi' in window
    const priorApi = window.shellApi
    window.shellApi = { ...(priorApi || {}), chat }
    try {
      await render({ send, paneKey: 'pane-images', allowImages: true })
      expect(wrapper.find('button[aria-label="Attach images"]').exists()).toBe(true)
      composer().vm.attachResolvedPaths(['C:\\shots\\a.png'])
      await flushPromises()
      expect(chat.imageImport).toHaveBeenCalledWith({ paneId: 'pane-images', path: 'C:\\shots\\a.png', thumb: true })
      // A pasted image: saved from its bytes, named image.png.
      const file = { type: 'image/png', size: 4, arrayBuffer: async () => new ArrayBuffer(4) }
      const event = new Event('paste', { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'clipboardData', {
        value: { types: ['Files'], items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }], getData: () => '' }
      })
      input().focus()
      input().dispatchEvent(event)
      await flushPromises()
      expect(event.defaultPrevented).toBe(true)
      expect(chat.imageSave).toHaveBeenCalledWith(expect.objectContaining({ paneId: 'pane-images', name: 'image.png' }))
      expect(wrapper.find('button[aria-label="View image: a.png"]').exists()).toBe(true)
      expect(wrapper.find('button[aria-label="View image: image.png"]').exists()).toBe(true)
      expect(wrapper.findAll('[data-test="chat-attachment-size"]').map((w) => w.text())).toEqual(['688×478', '688×478'])
      await type('look')
      await key({ key: 'Enter', keyCode: 13 })
      await flushPromises()
      expect(send).toHaveBeenCalledWith('look', { images: ['img_000000000000000000000001', 'img_000000000000000000000002'] })
      expect(wrapper.findAll('[data-test="chat-attachment"]')).toHaveLength(0)
      expect(chat.imageDiscard).not.toHaveBeenCalled()
    } finally {
      if (hadApi) window.shellApi = priorApi
      else delete window.shellApi
    }
  })

  it('no "/" picker while the session offers nothing (commands empty, no skills)', async () => {
    await render({ commands: [] })
    await type('/')
    expect(document.querySelector('[role="listbox"]')).toBeNull()
  })

  it('a picked command is sent as "/name"; a bare "/model" opens the picker through onOptionCommand', async () => {
    const send = vi.fn(async () => ({ ok: true }))
    const onOptionCommand = vi.fn(async () => ({ ok: true }))
    await render({
      send,
      onOptionCommand,
      setOption: vi.fn(async () => ({ ok: true })),
      commands: [
        { name: 'review', kind: 'command', description: 'Review changes' },
        { name: 'model', kind: 'command' }
      ]
    })
    await type('/rev')
    expect(document.getElementById(document.querySelector('[role="listbox"]').id + '-option-0')).not.toBeNull()
    await key({ key: 'Enter', keyCode: 13 })
    expect(send).toHaveBeenCalledWith('/review')
    expect(pane().emitted('slashCommand')[0]).toEqual(['/review'])
    await type('/mod')
    await key({ key: 'Enter', keyCode: 13 })
    expect(onOptionCommand).toHaveBeenCalledWith('model')
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('a typed "/model x" goes through setOption, never to the agent as text', async () => {
    const send = vi.fn(async () => ({ ok: true }))
    const setOption = vi.fn(async () => ({ ok: true }))
    await render({ send, setOption, commands: [] })
    await type('/model opus')
    await key({ key: 'Enter', keyCode: 13 })
    expect(setOption).toHaveBeenCalledWith({ model: 'opus' })
    expect(send).not.toHaveBeenCalled()
    expect(promptValue(input())).toBe('')
  })

  it('a typed "/permissionMode bypassPermissions" is refused for a chat not started in Yolo', async () => {
    const setOption = vi.fn(async () => ({ ok: true }))
    await render({ setOption, commands: [] })
    await type('/permissionMode bypassPermissions')
    await key({ key: 'Enter', keyCode: 13 })
    expect(setOption).not.toHaveBeenCalled()
    expect(notice().exists()).toBe(true)
    expect(promptValue(input())).toBe('/permissionMode bypassPermissions')
  })

  it('exposes focus, insertTypedText and the editable element', async () => {
    await render({ modelValue: 'ab' })
    expect(composer().vm.el()).toBe(input())
    expect(composer().vm.focus()).toBe(true)
    expect(document.activeElement).toBe(input())
    composer().vm.insertTypedText('X')
    await flushPromises()
    expect(wrapper.vm.draft).toContain('X')
    expect(composer().vm.draft).toBe(wrapper.vm.draft)
  })

  it('a dropped Tessel explorer path is inserted as text', async () => {
    await render()
    const event = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', {
      value: {
        types: ['text/x-tessel-path'],
        effectAllowed: 'copy',
        dropEffect: 'none',
        files: [],
        getData: (type) => (type === 'text/x-tessel-path' ? 'C:\\repo\\my file.txt' : '')
      }
    })
    input().dispatchEvent(event)
    await flushPromises()
    expect(event.defaultPrevented).toBe(true)
    expect(promptValue(input())).toBe('"C:\\\\repo\\\\my file.txt" ')
  })
})

// After Orca's native-chat-structured-send-composition-clear.test.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
describe('structured send racing the next IME composition', () => {
  function deferred() {
    let resolve
    const promise = new Promise((settle) => (resolve = settle))
    return { promise, resolve }
  }
  const compositionStart = () => input().dispatchEvent(new Event('compositionstart', { bubbles: true }))
  const compositionEnd = () => input().dispatchEvent(new Event('compositionend', { bubbles: true }))
  const pressEnter = () => key({ key: 'Enter', keyCode: 13, isComposing: false })

  // The regression: the send's clear lands while the NEXT composition is live, so the DOM sync
  // drops it and settlement used to adopt the sent text back into the composer.
  it('does not resurrect the sent message when the clear lands mid-composition', async () => {
    const dispatch = deferred()
    const send = vi.fn(() => dispatch.promise)
    await render({ send, agent: 'codex', commands: [] })
    await type('안녕')
    await pressEnter()
    expect(send).toHaveBeenCalledWith('안녕')

    compositionStart()
    changePrompt(input(), '안녕하')
    dispatch.resolve({ ok: true })
    await flushPromises()
    compositionEnd()
    await flushPromises()

    expect(promptValue(input())).toBe('하')
    send.mockResolvedValueOnce({ ok: true })
    await pressEnter()
    expect(send).toHaveBeenLastCalledWith('하')
  })

  it('keeps the composed text when a mid-composition clear lands away from the caret', async () => {
    const dispatch = deferred()
    await render({ send: vi.fn(() => dispatch.promise), agent: 'codex', commands: [] })
    await type('abcd')
    await pressEnter()
    compositionStart()
    changePrompt(input(), 'ab가cd')
    dispatch.resolve({ ok: true })
    await flushPromises()
    compositionEnd()
    await flushPromises()
    expect(promptValue(input())).toBe('가')
  })

  // Clearing optimistically before the reply would lose the draft here, which is why the clear
  // stays on the acceptance path and is instead replayed at settlement.
  it('keeps the draft when the send is rejected', async () => {
    const send = vi.fn(async () => ({ ok: false }))
    await render({ send, agent: 'codex', commands: [] })
    await type('안녕')
    await pressEnter()
    expect(send).toHaveBeenCalledWith('안녕')
    expect(promptValue(input())).toBe('안녕')
  })

  it('keeps the draft when a rejected send races the next composition', async () => {
    const dispatch = deferred()
    await render({ send: vi.fn(() => dispatch.promise), agent: 'codex', commands: [] })
    await type('안녕')
    await pressEnter()
    compositionStart()
    changePrompt(input(), '안녕하')
    dispatch.resolve({ ok: false })
    await flushPromises()
    compositionEnd()
    await flushPromises()
    expect(promptValue(input())).toBe('안녕하')
  })

  // A rejected command still reports its error, and the composer keeps the text to retry.
  it('keeps the draft when a handled command is rejected', async () => {
    const send = vi.fn(async () => ({ ok: true }))
    const onOptionCommand = vi.fn(async () => ({ ok: false, error: 'nope' }))
    await render({ send, onOptionCommand, agent: 'codex', commands: [] })
    await type('/model')
    await pressEnter()
    expect(onOptionCommand).toHaveBeenCalledWith('model')
    expect(pane().emitted('error').at(-1)).toEqual(['nope'])
    expect(send).not.toHaveBeenCalled()
    expect(promptValue(input())).toBe('/model')
  })

  // Tessel: Windows voice typing from the composer's mic.
  it('the mic focuses the composer, then starts voice typing; hidden without it, disabled when nothing can be typed', async () => {
    await render()
    expect(wrapper.find('[data-test="chat-dictation"]').exists()).toBe(false)
    wrapper.unmount()
    const dictate = vi.fn(() => {
      expect(document.activeElement).toBe(input())
    })
    await render({ dictate, dictationTitle: 'Voice typing (French)' })
    const mic = wrapper.find('[data-test="chat-dictation"]')
    expect(mic.attributes('aria-label')).toBe('Voice typing (French)')
    await mic.trigger('click')
    expect(dictate).toHaveBeenCalledTimes(1)
    wrapper.unmount()
    await render({ dictate, disabledReason: 'Stopped' })
    expect(wrapper.find('[data-test="chat-dictation"]').attributes('disabled')).toBeDefined()
  })
})
