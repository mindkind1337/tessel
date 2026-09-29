// After Orca's NativeChatAutocompleteMenus.test.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
import { afterEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { NativeChatMentionHint, NativeChatPickerMenu } from '../NativeChatAutocompleteMenus.js'
import { buildNativeChatPickerItems } from '../../../../chat/orca/native-chat-picker-items.js'
import { sessionSlashCommandSuggestions } from '../../../../chat/orca/shared/native-chat-slash-commands.js'

function autocomplete(overrides = {}) {
  return {
    mode: 'slash',
    query: '',
    triggerKey: '/:0',
    prefix: '/',
    dispatchable: true,
    grouped: true,
    commandsEnabled: true,
    skillsEnabled: true,
    items: [
      {
        kind: 'command',
        id: 'command:clear',
        name: 'clear',
        token: '/clear',
        description: 'Clear history',
        skillCollision: false
      },
      {
        kind: 'skill',
        id: 'skill:browser',
        name: 'browser',
        token: '/browser',
        description: 'Use a browser',
        sources: [{ sourceKind: 'repo', skillFilePath: '/repo/browser/SKILL.md' }]
      }
    ],
    skillStatus: 'ready',
    ...overrides
  }
}

let wrapper = null
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

function render(value, activeIndex = 0) {
  wrapper = mount(NativeChatPickerMenu, { props: { autocomplete: value, activeIndex, listboxId: 'picker' } })
  return wrapper
}
const option = (pattern) => wrapper.findAll('[role="option"]').find((o) => pattern.test(o.text()))
// Elements whose own text (not their children's) is this text, like getAllByText.
const ownText = (el) => Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim()
const textCount = (text) => wrapper.findAll('div, span').filter((el) => ownText(el.element) === text).length

describe('NativeChatPickerMenu', () => {
  it('renders grouped command and skill options with active-descendant ids', () => {
    render(autocomplete(), 1)
    expect(wrapper.text()).toContain('Commands')
    expect(wrapper.text()).toContain('Skills')
    expect(option(/browser/i).attributes('aria-selected')).toBe('true')
    expect(option(/browser/i).attributes('id')).toBe('picker-option-1')
    expect(option(/clear/i).attributes('id')).toBe('picker-option-0')
    expect(wrapper.text()).toContain('Project')
  })

  it('completes a command on pointer down instead of dispatching it internally', async () => {
    const value = autocomplete()
    render(value, 0)
    const event = new Event('pointerdown', { bubbles: true, cancelable: true })
    option(/clear/i).element.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(wrapper.emitted('choose')[0]).toEqual([value.items[0]])
  })

  it('keeps commands selectable while skills load', () => {
    render(autocomplete({ items: [autocomplete().items[0]], skillStatus: 'loading' }))
    expect(option(/clear/i)).toBeTruthy()
    expect(textCount('Loading skills...')).toBe(2)
  })

  it('renders a retryable error instead of the loading spinner when discovery fails', async () => {
    render(autocomplete({ items: [], skillStatus: 'error', skillErrorKind: 'host' }))
    expect(textCount('Could not load skills from this host')).toBe(2)
    expect(wrapper.text()).not.toContain('Loading skills...')
    const retry = wrapper.findAll('button').find((b) => b.text() === 'Retry')
    await retry.trigger('click')
    expect(wrapper.emitted('retry')).toHaveLength(1)
  })

  it('says skills are unavailable (no Retry) when the host has no skill discovery', () => {
    render(autocomplete({ items: [], skillStatus: 'error', skillErrorKind: 'unavailable' }))
    expect(wrapper.text()).toContain('Skills are unavailable for this host')
    expect(wrapper.findAll('button').some((b) => b.text() === 'Retry')).toBe(false)
  })

  it('uses command-only empty copy for a picker without skill support', () => {
    render(autocomplete({ grouped: false, items: [], skillsEnabled: false, skillStatus: 'ready' }))
    expect(textCount('No matching commands')).toBe(2)
  })

  it('shows the argument hint the provider reported beside the command token', () => {
    render(
      autocomplete({
        items: buildNativeChatPickerItems(
          sessionSlashCommandSuggestions('claude', [
            {
              name: 'goal',
              kind: 'command',
              description: 'Set a goal and keep working until it is met',
              argumentHint: '<objective>'
            },
            { name: 'clear', kind: 'command' },
            { name: 'wordy', kind: 'command', argumentHint: `<${'a'.repeat(200)}>` }
          ]),
          [],
          '',
          '/'
        )
      })
    )
    const goal = option(/goal/i)
    expect(goal.text()).toContain('<objective>')
    expect(goal.text()).toContain('Set a goal and keep working until it is met')
    // A command the report left hintless renders its row unchanged.
    expect(option(/clear/i).element.textContent).toBe('/clearClear conversation history')
    // A hint long enough to swamp the row is capped before it reaches the DOM.
    expect(option(/wordy/i).element.textContent).toBe(`/wordy<${'a'.repeat(79)}`)
  })

  it('announces a successful empty skill result distinctly from loading', () => {
    render(autocomplete({ commandsEnabled: false, items: [], skillStatus: 'ready' }))
    expect(textCount('No matching skills')).toBe(2)
  })

  it('announces loaded skills and a name collision politely', () => {
    const items = autocomplete().items.map((item) => (item.kind === 'command' ? { ...item, skillCollision: true } : item))
    render(autocomplete({ items }))
    expect(wrapper.find('[aria-live="polite"]').text()).toBe('Skills loaded. Also a skill name - agent decides')
  })
})

describe('NativeChatMentionHint', () => {
  it('accepts on pointer down and keeps the focus in the input', () => {
    wrapper = mount(NativeChatMentionHint, { props: { query: 'src/app' } })
    expect(wrapper.text()).toBe('Referencing file: @src/app')
    const event = new Event('pointerdown', { bubbles: true, cancelable: true })
    wrapper.element.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(wrapper.emitted('accept')).toHaveLength(1)
  })

  it('shows an ellipsis for an empty query', () => {
    wrapper = mount(NativeChatMentionHint, { props: { query: '' } })
    expect(wrapper.text()).toBe('Referencing file: @…')
  })
})
