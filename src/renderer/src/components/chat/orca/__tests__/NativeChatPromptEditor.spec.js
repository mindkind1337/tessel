// After Orca's NativeChatPromptEditor.test.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { h, shallowRef } from 'vue'
import NativeChatPromptEditor from '../NativeChatPromptEditor.vue'
import { readNativeChatDraftDocument } from '../../../../chat/orca/native-chat-draft-cache.js'
import { promptEditor } from './native-chat-prompt-editor.test-support.js'

let wrappers = []
afterEach(() => {
  wrappers.forEach((w) => w.unmount())
  wrappers = []
  document.body.replaceChildren()
})

async function render(props) {
  const inputRef = props.inputRef ?? shallowRef(null)
  const onChange = vi.fn()
  const wrapper = mount(
    { render: () => h(NativeChatPromptEditor, { inputRef, disabled: false, placeholder: 'Message', onChange, onSelect: vi.fn(), ...props }) },
    { attachTo: document.body }
  )
  wrappers.push(wrapper)
  // useEditor creates the editor on mount; EditorContent attaches it (and the node views) a tick later.
  await flushPromises()
  return { wrapper, inputRef, onChange }
}

async function setup(value = '') {
  const view = await render({ initialValue: value })
  const textbox = view.wrapper.element.querySelector('[role="textbox"]')
  return { ...view, input: view.inputRef.value, editor: promptEditor(textbox), textbox, container: view.wrapper.element }
}

describe('native chat skill editor', () => {
  it('renders only picker insertions as pills and serializes the exact invocation', async () => {
    const { input, container } = await setup('Please $rev')
    input.insertSkill(7, 11, '$review')
    await flushPromises()
    const pill = container.querySelector('[data-native-chat-skill]')
    expect(pill?.textContent.trim()).toBe('Review')
    // The badge's text size (text-xs), not the editor's.
    expect(pill?.classList.contains('nc-ui-badge')).toBe(true)
    expect(input.value).toBe('Please $review ')
    expect(input.selectionStart).toBe(15)
    input.value += '$review typed manually'
    await flushPromises()
    expect(container.querySelectorAll('[data-native-chat-skill]')).toHaveLength(1)
    expect(input.value).toBe('Please $review $review typed manually')
  })

  it('keeps typed and restored invocations plain', async () => {
    const { container, input } = await setup('$review /review')
    expect(container.querySelector('[data-native-chat-skill]')).toBeNull()
    input.value = '$review restored'
    await flushPromises()
    expect(container.querySelector('[data-native-chat-skill]')).toBeNull()
  })

  it('deletes a skill atomically and restores it with undo', async () => {
    const { input, editor, container } = await setup('$rev')
    input.insertSkill(0, 4, '$review')
    input.setSelectionRange(0, 7)
    editor.commands.deleteSelection()
    await flushPromises()
    expect(input.value).toBe(' ')
    expect(container.querySelector('[data-native-chat-skill]')).toBeNull()
    editor.commands.undo()
    await flushPromises()
    expect(input.value).toBe('$review ')
    expect(container.querySelector('[data-native-chat-skill]')).not.toBeNull()
  })

  it('preserves multiple selected skills through multiline edits and clears them on send', async () => {
    const { input, container } = await setup('$one')
    input.insertSkill(0, 4, '$one')
    input.value += '\nthen $two'
    input.insertSkill(11, 15, '$two')
    await flushPromises()
    expect(input.value).toBe('$one \nthen $two ')
    expect(container.querySelectorAll('[data-native-chat-skill]')).toHaveLength(2)
    input.value = ''
    await flushPromises()
    expect(input.value).toBe('')
    expect(container.querySelector('[data-native-chat-skill]')).toBeNull()
  })

  it('restores selected nodes only in their owning pane draft', async () => {
    const inputRef = shallowRef(null)
    const props = { inputRef, scopeKey: 'pill-pane', initialValue: '$rev' }
    const first = await render(props)
    inputRef.value.insertSkill(0, 4, '$review')
    expect(readNativeChatDraftDocument('pill-pane', '$review ')?.content?.[0]?.content?.[0]?.type).toBe('nativeChatSkill')
    first.wrapper.unmount()
    wrappers = wrappers.filter((w) => w !== first.wrapper)
    const second = await render({ ...props, initialValue: '$review ' })
    expect(second.wrapper.element.querySelector('[data-native-chat-skill]')).not.toBeNull()
    second.wrapper.unmount()
    wrappers = wrappers.filter((w) => w !== second.wrapper)
    const other = await render({ ...props, scopeKey: 'other-pane', initialValue: '$review ' })
    expect(other.wrapper.element.querySelector('[data-native-chat-skill]')).toBeNull()
  })

  it.each(['$revision ', '$preview '])('replaces partial skill text with %s without a stale pill', async (replacement) => {
    const { input, container } = await setup('$rev')
    input.insertSkill(0, 4, '$review')
    input.value = replacement
    await flushPromises()
    expect(input.value).toBe(replacement)
    expect(container.querySelector('[data-native-chat-skill]')).toBeNull()
  })

  it('pastes rich clipboard content as literal text without manufacturing pills', async () => {
    const { input, container, textbox } = await setup()
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', {
      value: {
        types: ['text/plain', 'text/html'],
        getData: (format) =>
          format === 'text/plain' ? '$review\nhello' : '<span data-native-chat-skill="$review">review</span>'
      }
    })
    textbox.dispatchEvent(event)
    await flushPromises()
    expect(input.value).toBe('$review\nhello')
    expect(container.querySelector('[data-native-chat-skill]')).toBeNull()
  })

  // Tessel: the placeholder follows the composer's state (busy, starting…).
  it('updates its placeholder and aria-label when the prop changes', async () => {
    const inputRef = shallowRef(null)
    const wrapper = mount(NativeChatPromptEditor, {
      props: { inputRef, disabled: false, placeholder: 'Message Claude…', initialValue: '' },
      attachTo: document.body
    })
    wrappers.push(wrapper)
    await flushPromises()
    const textbox = wrapper.element.querySelector('[role="textbox"]')
    expect(textbox.getAttribute('aria-label')).toBe('Message Claude…')
    expect(textbox.querySelector('p').getAttribute('data-placeholder')).toBe('Message Claude…')
    await wrapper.setProps({ placeholder: 'Wait until Claude has started' })
    await flushPromises()
    expect(textbox.getAttribute('aria-label')).toBe('Wait until Claude has started')
    expect(textbox.querySelector('p').getAttribute('data-placeholder')).toBe('Wait until Claude has started')
  })

  it('disabled: not editable, and back', async () => {
    const inputRef = shallowRef(null)
    const wrapper = mount(NativeChatPromptEditor, {
      props: { inputRef, disabled: true, placeholder: 'x', initialValue: '' },
      attachTo: document.body
    })
    wrappers.push(wrapper)
    await flushPromises()
    const textbox = wrapper.element.querySelector('[role="textbox"]')
    expect(textbox.getAttribute('contenteditable')).toBe('false')
    expect(inputRef.value.disabled).toBe(true)
    await wrapper.setProps({ disabled: false })
    await flushPromises()
    expect(textbox.getAttribute('contenteditable')).toBe('true')
  })
})
