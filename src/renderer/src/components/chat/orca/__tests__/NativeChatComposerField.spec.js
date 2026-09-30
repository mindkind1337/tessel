// After Orca's native-chat-composer-composition.test.tsx, native-chat-composer-autogrow.test.tsx
// and native-chat-composer-containment.test.ts (MIT, Copyright (c) 2026 Lovecast Inc.)
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, shallowRef } from 'vue'

vi.mock('../NativeChatComposerActions.vue', () => ({
  default: defineComponent({ setup: () => () => h('div', { 'data-testid': 'composer-actions' }) })
}))

import NativeChatComposerField from '../NativeChatComposerField.vue'
import { useImeEnterGestureOwnership } from '../ime-composition-keyboard-event.js'
import { changePrompt, promptValue } from './native-chat-prompt-editor.test-support.js'

// jsdom's import.meta.url is not a file URL; specs run from the repository root.
const readSource = (name) => fs.readFileSync(path.join(process.cwd(), 'src/renderer/src/components/chat/orca', name), 'utf8')

let wrapper = null
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.replaceChildren()
})

function fieldProps(overrides = {}) {
  return {
    composerScopeKey: 'pane-test',
    textareaRef: shallowRef(null),
    draft: '',
    disabled: false,
    placeholder: 'Message Claude…',
    autocomplete: { mode: 'none' },
    activeSuggestion: 0,
    notice: null,
    imageAttachments: [],
    sendButtonDisabled: false,
    isWorking: false,
    attachDisabled: false,
    imeEnterGesture: useImeEnterGestureOwnership(),
    pickerListboxId: 'picker',
    sessionOptionsSnapshot: [],
    ...overrides
  }
}

async function render(props = fieldProps()) {
  wrapper = mount(NativeChatComposerField, { props, attachTo: document.body })
  await flushPromises()
  return wrapper
}
const textarea = () => document.querySelector('[role="textbox"]')
const fire = (el, type, init = {}) => {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.assign(event, init)
  el.dispatchEvent(event)
  return !event.defaultPrevented
}
const key = (el, type, init) => {
  const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init })
  for (const name of ['keyCode', 'isComposing']) {
    if (name in init) Object.defineProperty(event, name, { value: init[name] })
  }
  el.dispatchEvent(event)
  return !event.defaultPrevented
}
const settledCalls = () => wrapper.emitted('imeSettled') ?? []

describe('native chat composer drop-scope marker', () => {
  // The drop pipeline stops walking at the drop-target marker, so a scope key on
  // any other element would never reach the payload.
  it('publishes the scope key on the same element as the drop-target marker', async () => {
    await render(fieldProps({ composerScopeKey: 'tab-7:pane-9' }))
    const marker = wrapper.element.querySelector('[data-native-file-drop-target="composer"]')
    expect(marker).not.toBeNull()
    expect(marker.getAttribute('data-composer-scope-key')).toBe('tab-7:pane-9')
    expect(wrapper.element.querySelectorAll('[data-composer-scope-key]')).toHaveLength(1)
  })
})

describe('native chat composer composition ownership', () => {
  it('preserves the focused browser preedit through 120 stale streaming rerenders', async () => {
    await render()
    const input = textarea()
    input.focus()
    fire(input, 'compositionstart')
    changePrompt(input, '가')

    for (let index = 0; index < 120; index += 1) {
      await wrapper.setProps({ draft: `stale streaming draft ${index}` })
      expect(textarea()).toBe(input)
      expect(document.activeElement).toBe(input)
      expect(promptValue(input)).toBe('가')
    }

    fire(input, 'compositionend', { data: '가' })
    expect(settledCalls()).toHaveLength(1)
    expect(settledCalls()[0][0].value).toBe(promptValue(input))
    expect(promptValue(input)).toBe('가')
  })

  it('synchronizes launch, programmatic, cleared, and pane-scoped drafts while idle', async () => {
    await render(fieldProps({ draft: 'launch draft' }))
    const input = textarea()
    expect(promptValue(input)).toBe('launch draft')
    for (const draft of ['programmatic insertion', '', 'next pane draft']) {
      await wrapper.setProps({ draft })
      expect(textarea()).toBe(input)
      expect(promptValue(input)).toBe(draft)
    }
  })

  it('keeps adopting change events and exposes the final deletion at composition end', async () => {
    let settledValue = null
    await render(fieldProps({ draft: '한', onImeSettled: (element) => (settledValue = element.value) }))
    const input = textarea()
    fire(input, 'compositionstart')
    changePrompt(input, '한글')
    const changes = wrapper.emitted('draftChange')
    expect(changes.at(-1)[0]).toBe('한글')
    expect(changes.at(-1)[1].value).toBe('한글')

    changePrompt(input, '')
    fire(input, 'compositionend', { data: '' })
    expect(settledValue).toBe('')
  })

  it('uses the shared Enter gesture owner without swallowing the next deliberate Enter', async () => {
    await render(fieldProps({ draft: '가' }))
    const input = textarea()
    fire(input, 'compositionstart')

    key(input, 'keydown', { key: 'Process', keyCode: 229, isComposing: true })
    fire(input, 'compositionend', { data: '가' })
    const redispatch = key(input, 'keydown', { key: 'Enter', keyCode: 13, isComposing: false })

    expect(redispatch).toBe(false)
    expect(wrapper.emitted('keyDown')).toBeUndefined()

    key(input, 'keyup', { key: 'Enter', keyCode: 13 })
    key(input, 'keydown', { key: 'Enter', keyCode: 13, isComposing: false })
    expect(wrapper.emitted('keyDown')).toHaveLength(1)
  })

  it('releases composition ownership on blur even when compositionend is omitted', async () => {
    await render(fieldProps({ draft: '가' }))
    const input = textarea()
    fire(input, 'compositionstart')
    changePrompt(input, '각')

    fire(input, 'focusout')
    await wrapper.setProps({ draft: 'external draft' })
    key(input, 'keydown', { key: 'Enter', keyCode: 13, isComposing: false })

    expect(settledCalls()).toHaveLength(1)
    expect(promptValue(input)).toBe('external draft')
    expect(wrapper.emitted('keyDown')).toHaveLength(1)
  })

  it('settles the browser value instead of an unrelated draft rerender on blur', async () => {
    await render()
    const input = textarea()
    fire(input, 'compositionstart')
    changePrompt(input, '각')

    await wrapper.setProps({ draft: 'programmatic draft' })
    expect(promptValue(input)).toBe('각')
    fire(input, 'focusout')

    expect(settledCalls()).toHaveLength(1)
    expect(settledCalls()[0][0].value).toBe(promptValue(input))
    expect(promptValue(input)).toBe('각')
  })

  it('exposes the browser value on blur when compositionend is omitted', async () => {
    await render()
    const input = textarea()
    fire(input, 'compositionstart')
    changePrompt(input, '각')
    fire(input, 'focusout')
    expect(settledCalls()).toHaveLength(1)
    expect(settledCalls()[0][0].value).toBe('각')
  })

  it('settles once when compositionend and blur arrive in one batch', async () => {
    await render()
    const input = textarea()
    fire(input, 'compositionstart')
    changePrompt(input, '각')
    fire(input, 'compositionend', { data: '각' })
    fire(input, 'focusout')
    expect(settledCalls()).toHaveLength(1)
    expect(settledCalls()[0][0].value).toBe(promptValue(input))
  })

  it('settles once when blur precedes compositionend in one batch', async () => {
    await render()
    const input = textarea()
    fire(input, 'compositionstart')
    changePrompt(input, '각')
    fire(input, 'focusout')
    fire(input, 'compositionend', { data: '각' })
    expect(settledCalls()).toHaveLength(1)
    expect(settledCalls()[0][0].value).toBe(promptValue(input))
  })

  it('replays a draft clear dropped mid-composition when the field settles on blur', async () => {
    let settledValue = null
    await render(fieldProps({ draft: '안녕', onImeSettled: (element) => (settledValue = element.value) }))
    const input = textarea()
    fire(input, 'compositionstart')
    changePrompt(input, '안녕하')
    await wrapper.setProps({ draft: '안녕하' })

    // The accepted structured send lands while the next composition is still open.
    await wrapper.setProps({ draft: '' })
    expect(promptValue(input)).toBe('안녕하')

    fire(input, 'focusout')
    expect(settledValue).toBe('하')
    expect(promptValue(input)).toBe('하')
  })

  it('forgets a dropped clear that the browser already settled', async () => {
    await render(fieldProps({ draft: '안녕' }))
    const input = textarea()
    fire(input, 'compositionstart')
    changePrompt(input, '안녕하')
    await wrapper.setProps({ draft: '' })
    fire(input, 'focusout')

    // A second composition must not inherit the first one's clear.
    fire(input, 'compositionstart')
    changePrompt(input, '하늘')
    fire(input, 'focusout')

    expect(promptValue(input)).toBe('하늘')
  })

  it('keeps the browser value through a same-draft streaming rerender', async () => {
    await render()
    const input = textarea()
    fire(input, 'compositionstart')
    changePrompt(input, '각')
    await wrapper.setProps({ draft: '' })
    fire(input, 'focusout')
    expect(promptValue(input)).toBe('각')
    expect(settledCalls()[0][0].value).toBe(promptValue(input))
  })
})

/** The composer grows with the draft up to 8 lines, then scrolls internally.
 *  Sizing is layout-driven (an lh-relative cap) rather than a JS measure pass,
 *  so these assert the class/CSS contract that produces it. jsdom has no
 *  layout engine, so real pixel growth is covered by app validation. */
describe('native chat composer autogrow', () => {
  const source = readSource('NativeChatComposerField.vue')

  it('grows naturally with editable content', async () => {
    await render()
    expect(textarea().getAttribute('contenteditable')).toBe('true')
    expect(textarea().classList.contains('nc-composer-input')).toBe(true)
  })

  it('caps growth at 8 lines plus the py-1 padding box', () => {
    expect(source).toContain('max-height: calc(8lh + 0.5rem);')
  })

  it('keeps the sleek scrollbar for the overflow past the cap', async () => {
    await render(fieldProps({ draft: 'a\n'.repeat(20) }))
    expect(textarea().classList.contains('nc-ui-scrollbar-sleek')).toBe(true)
  })

  it('starts with one text line and its vertical padding', () => {
    expect(source).toContain('min-height: 52px;')
  })

  it('does not pin an inline height that a resize could leave stale', async () => {
    await render(fieldProps({ draft: 'a\n'.repeat(6) }))
    expect(textarea().style.height).toBe('')
  })
})

describe('native chat composer paint containment (#10481)', () => {
  const field = readSource('NativeChatComposerField.vue')
  const style = field.slice(field.indexOf('<style'))
  const picker = readSource('NativeChatPickerMenu.vue')
  const hint = readSource('NativeChatMentionHint.vue')

  it('bounds caret repaints to the composer input shell', () => {
    expect(style).toMatch(/\.nc-composer-box \{[^}]*contain: paint;/)
  })

  it('keeps the outer composer uncontained so the pickers can overflow it', () => {
    // The pickers are siblings that render above the shell via bottom: 100%;
    // containing their parent would clip them.
    for (const outer of ['.nc-composer {', '.nc-composer-pad {', '.nc-composer-column {']) {
      const rule = style.slice(style.indexOf(outer), style.indexOf('}', style.indexOf(outer)))
      expect(rule).not.toContain('contain')
    }
  })

  it('lifts both pickers above the contained shell', () => {
    // The shell is a stacking context, so it paints at z-index 0 in tree
    // order — an unlayered picker would lose its drop shadow to it.
    for (const source of [picker, hint]) {
      expect(source).toMatch(/bottom: 100%;[\s\S]*z-index: 20;/)
    }
  })
})

describe('Tessel: the field', () => {
  it('shows a notice, and says why Send waits (read with the input)', async () => {
    await render(fieldProps({ notice: 'This chat accepts text only.', sendBlockedReason: 'Wait until Claude has started' }))
    expect(wrapper.find('[data-test="chat-composer-notice"]').text()).toBe('This chat accepts text only.')
    const reason = wrapper.find('[data-test="chat-send-blocked"]')
    expect(reason.text()).toBe('Wait until Claude has started')
    expect(textarea().getAttribute('aria-describedby')).toBe(reason.attributes('id'))
  })

  it('shows no image chips unless images are allowed', async () => {
    const imageAttachments = [{ id: 'image-1', imageId: 'img_000000000000000000000001', name: 'example.png', width: 688, height: 478 }]
    await render(fieldProps({ imageAttachments }))
    expect(wrapper.find('button[aria-label="View image: example.png"]').exists()).toBe(false)
    await wrapper.setProps({ allowImages: true })
    expect(wrapper.find('button[aria-label="View image: example.png"]').exists()).toBe(true)
  })

  it('wires the slash picker to the input (expanded, controls, active descendant)', async () => {
    const autocomplete = {
      mode: 'slash',
      query: '',
      triggerKey: '/:0',
      prefix: '/',
      dispatchable: true,
      grouped: false,
      commandsEnabled: true,
      skillsEnabled: false,
      items: [
        { kind: 'command', id: 'command:a', name: 'a', token: '/a' },
        { kind: 'command', id: 'command:b', name: 'b', token: '/b' }
      ],
      skillStatus: 'ready'
    }
    await render(fieldProps({ autocomplete, activeSuggestion: 5 }))
    await flushPromises()
    expect(textarea().getAttribute('aria-expanded')).toBe('true')
    expect(textarea().getAttribute('aria-controls')).toBe('picker')
    expect(textarea().getAttribute('aria-activedescendant')).toBe('picker-option-1')
    await wrapper.setProps({ autocomplete: { mode: 'none' } })
    await flushPromises()
    expect(textarea().getAttribute('aria-expanded')).toBe('false')
    expect(textarea().hasAttribute('aria-activedescendant')).toBe(false)
  })
})

describe('dictation beside the text', () => {
  it('keeps the mic below image chips and forwards dictation', async () => {
    await render(fieldProps({ showDictation: true, dictationDisabled: false, allowImages: true, imageAttachments: [{ id: 'image', name: 'image.png', width: 702, height: 56 }] }))
    const mic = wrapper.get('[data-test="chat-dictation"]')
    expect(mic.element.closest('.nc-composer-text-row')).toBeTruthy()
    expect(mic.element.closest('.nc-composer-attachments')).toBeNull()
    await mic.trigger('click')
    expect(wrapper.emitted('dictationToggle')).toHaveLength(1)
  })
})
