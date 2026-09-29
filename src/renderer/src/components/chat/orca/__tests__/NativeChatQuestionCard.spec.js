// NativeChatQuestionCard (after Orca's NativeChatQuestionCard.test.tsx, MIT,
// Copyright (c) 2026 Lovecast Inc.): the card turns its selections into
// index-based answers (a non-first pick must come out as its option INDEX,
// not the first option or the raw label).
import { afterEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import NativeChatQuestionCard from '../NativeChatQuestionCard.vue'

let wrapper = null
let container = null
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

function render(prompt, allowOther = true, extra = {}) {
  wrapper = mount(NativeChatQuestionCard, { props: { prompt, allowOther, ...extra }, attachTo: document.body })
  container = wrapper.element
}
const answers = () => wrapper.emitted('answer') || []

async function click(button, what) {
  if (!button) throw new Error(`button not found: ${what}`)
  button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await nextTick()
}
// Option rows carry a badge number + label: matched by the label they contain.
const clickOption = (label) =>
  click(
    [...container.querySelectorAll('button[aria-pressed]')].find((b) => b.textContent.includes(label)),
    `option ${label}`
  )
const clickOptionAt = (i) => click(container.querySelectorAll('button[aria-pressed]')[i], `option index ${i}`)
const clickAction = (text) =>
  click(
    [...container.querySelectorAll('button')].find((b) => b.textContent.trim() === text),
    text
  )
async function typeAnswer(value) {
  const input = container.querySelector('input')
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
}
const optionPressed = (label) =>
  [...container.querySelectorAll('button[aria-pressed]')].find((b) => b.textContent.includes(label))?.getAttribute('aria-pressed')

const tabsOrSpaces = {
  questions: [{ question: 'Do you prefer tabs or spaces?', header: 'Indent', multiSelect: false, options: [{ label: 'Tabs' }, { label: 'Spaces' }] }]
}

describe('NativeChatQuestionCard', () => {
  it('delivers the SECOND option as index 1, not the default', async () => {
    render(tabsOrSpaces)
    await clickOption('Spaces')
    await clickAction('Submit')
    expect(answers()[0][0]).toEqual([{ indices: [1], other: '' }])
  })

  it('delivers a multi-select pick as its option indices', async () => {
    render({ questions: [{ question: 'Which fruits?', multiSelect: true, options: [{ label: 'Apple' }, { label: 'Banana' }, { label: 'Cherry' }] }] })
    await clickOption('Cherry')
    await clickOption('Apple')
    await clickAction('Submit')
    expect(answers()[0][0]).toEqual([{ indices: [0, 2], other: '' }])
  })

  it('keeps duplicate labels distinct by their numbered row', async () => {
    render({ questions: [{ question: 'Which duplicate row?', multiSelect: false, options: [{ label: 'Same' }, { label: 'Same' }] }] })
    await clickOptionAt(1)
    await clickAction('Submit')
    expect(answers()[0][0]).toEqual([{ indices: [1], other: '' }])
  })

  it('carries free text through as the other answer', async () => {
    render(tabsOrSpaces)
    await typeAnswer('four spaces')
    await clickAction('Submit')
    expect(answers()[0][0]).toEqual([{ indices: [], other: 'four spaces' }])
  })

  it('hides free text when the provider requires a listed option', () => {
    render(tabsOrSpaces, false)
    expect(container.querySelector('input')).toBeNull()
    expect(container.textContent).not.toContain('Type your answer')
  })

  it('applies free-text capability per question in a grouped prompt', async () => {
    render(
      {
        questions: [
          { header: 'Listed', question: 'Pick a listed value', multiSelect: false, options: [{ label: 'One' }] },
          { header: 'Custom', question: 'Provide a custom value', multiSelect: false, options: [] }
        ]
      },
      [false, true]
    )
    expect(container.querySelector('input')).toBeNull()
    await clickAction('Skip')
    expect(container.querySelector('input')).not.toBeNull()
  })

  it('submits grouped multi-select and free-text answers together', async () => {
    render(
      {
        questions: [
          { header: 'Targets', question: 'Which targets?', multiSelect: true, options: [{ label: 'Web' }, { label: 'Mobile' }] },
          { header: 'Notes', question: 'Anything else?', multiSelect: false, options: [] }
        ]
      },
      [false, true]
    )
    await clickOption('Web')
    await clickOption('Mobile')
    await clickAction('Next')
    await typeAnswer('SSH host')
    await clickAction('Submit')
    expect(answers()[0][0]).toEqual([
      { indices: [0, 1], other: '' },
      { indices: [], other: 'SSH host' }
    ])
  })

  it('replaces a picked option with a typed answer on a single-select question', async () => {
    render(tabsOrSpaces)
    await clickOption('Spaces')
    await typeAnswer('two spaces')
    expect(optionPressed('Spaces')).toBe('false')
    await clickAction('Submit')
    expect(answers()[0][0]).toEqual([{ indices: [], other: 'two spaces' }])
  })

  it('keeps typed text in the field but sends a later-picked option', async () => {
    render(tabsOrSpaces)
    await typeAnswer('two spaces')
    await clickOption('Tabs')
    expect(container.querySelector('input').value).toBe('two spaces')
    await clickAction('Submit')
    expect(answers()[0][0]).toEqual([{ indices: [0], other: '' }])
  })

  it('chooses the kept typed text again when its field is clicked', async () => {
    render(tabsOrSpaces)
    await typeAnswer('two spaces')
    await clickOption('Tabs')
    await click(container.querySelector('input'), 'input')
    expect(optionPressed('Tabs')).toBe('false')
    await clickAction('Submit')
    expect(answers()[0][0]).toEqual([{ indices: [], other: 'two spaces' }])
  })

  it('ignores a click on the answer field while the answer is sending', async () => {
    render(tabsOrSpaces)
    await typeAnswer('two spaces')
    await clickOption('Tabs')
    await wrapper.setProps({ isSubmitting: true })
    // Chromium still delivers pointer events to a disabled input.
    const input = container.querySelector('input')
    input.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    input.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()
    expect(optionPressed('Tabs')).toBe('true')
  })

  it('keeps the picked option when keyboard focus passes through the field', async () => {
    render(tabsOrSpaces)
    await typeAnswer('two spaces')
    await clickOption('Tabs')
    container.querySelector('input').dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    await nextTick()
    await clickAction('Submit')
    expect(answers()[0][0]).toEqual([{ indices: [0], other: '' }])
  })

  it('leaves nothing chosen when a picked option is unpicked over kept text', async () => {
    render(tabsOrSpaces)
    await typeAnswer('two spaces')
    await clickOption('Tabs')
    await clickOption('Tabs')
    expect(optionPressed('Tabs')).toBe('false')
    expect([...container.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Skip')).toBe(true)
    expect(answers()).toHaveLength(0)
  })

  it('sends picked options and typed text together on a multi-select question', async () => {
    render({ questions: [{ question: 'Which targets?', multiSelect: true, options: [{ label: 'Web' }, { label: 'Mobile' }] }] })
    await clickOption('Mobile')
    await typeAnswer('Desktop')
    await typeAnswer('')
    await typeAnswer('Desktop app')
    await clickAction('Submit')
    expect(answers()[0][0]).toEqual([{ indices: [1], other: 'Desktop app' }])
  })

  // Tessel additions: the close button, Enter in an empty field, the exposed field.
  it('Skip on the last question with nothing answered cancels; Enter in the empty field does not', async () => {
    render(tabsOrSpaces)
    const input = container.querySelector('input')
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await nextTick()
    expect(wrapper.emitted('cancel')).toBeUndefined()
    await clickAction('Skip')
    expect(wrapper.emitted('cancel')).toHaveLength(1)
    await click(container.querySelector('button[aria-label="Cancel"]'), 'Cancel')
    expect(wrapper.emitted('cancel')).toHaveLength(2)
    expect(wrapper.vm.answerInput).toBe(input)
  })
})
