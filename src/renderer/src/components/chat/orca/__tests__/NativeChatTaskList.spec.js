// After Orca's NativeChatTaskList.test.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
import { afterEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import NativeChatTaskList from '../NativeChatTaskList.vue'
import { buttonNamed, byText, clickEvent, queryByText } from './native-chat-tool-test-dom.js'

let wrapper = null
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

function render(props) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  wrapper = mount(NativeChatTaskList, { props, attachTo: container })
  return { container }
}

const previous = {
  tasks: [
    { content: 'Read', status: 'in_progress', activeForm: 'Reading' },
    { content: 'Write', status: 'pending', activeForm: 'Writing' },
    { content: 'Test', status: 'pending' }
  ]
}
const current = {
  tasks: [
    { content: 'Read', status: 'completed', activeForm: 'Reading' },
    { content: 'Write', status: 'in_progress', activeForm: 'Writing' },
    { content: 'Test', status: 'pending' }
  ]
}

function progress(container, label) {
  return container.querySelector(`[aria-label="${label}"]`)
}

describe('NativeChatTaskList', () => {
  it('shows tri-state glyphs, progress, and activeForm in the first checklist', () => {
    const { container } = render({ list: current })
    expect(byText(container, 'Read').classList).toContain('nc-task-list__label--done')
    expect(byText(container, 'Writing').closest('li').classList).toContain('nc-task-list__row--active')
    expect(queryByText(container, 'Test')).not.toBeNull()
    expect(progress(container, '1 of 3 tasks completed').textContent).toBe('1/3')
    for (const glyph of ['circle', 'circle-dot', 'circle-check']) {
      expect(container.querySelector(`.lucide-${glyph}`)).not.toBeNull()
    }
    expect(byText(container, 'In progress:').classList).toContain('nc-task-list__sr-only')
  })

  it('leads with the diff and expands the complete checklist on demand', async () => {
    const { container } = render({ list: current, previous })
    expect(queryByText(container, 'Completed Read')).not.toBeNull()
    expect(queryByText(container, 'Started Write')).not.toBeNull()
    expect(queryByText(container, 'Test')).toBeNull()
    const disclosure = buttonNamed(container, 'Full task list')
    expect(disclosure.getAttribute('aria-expanded')).toBe('false')
    clickEvent(disclosure)
    await nextTick()
    expect(disclosure.getAttribute('aria-expanded')).toBe('true')
    expect(queryByText(container, 'Writing')).not.toBeNull()
    expect(queryByText(container, 'Test')).not.toBeNull()
  })

  it('shows unchanged feedback and the current explanation', () => {
    const { container } = render({ list: { ...current, explanation: 'Continuing verification' }, previous: current })
    expect(queryByText(container, 'Tasks unchanged')).not.toBeNull()
    expect(queryByText(container, 'Continuing verification')).not.toBeNull()
    expect(queryByText(container, 'Test')).toBeNull()
  })

  it('renders empty lists without claiming any task completed', () => {
    const { container } = render({ list: { tasks: [] } })
    expect(queryByText(container, 'No tasks')).not.toBeNull()
    expect(progress(container, '0 of 0 tasks completed').textContent).toBe('0/0')
  })

  it('switches from full list to diff when earlier history supplies a predecessor', async () => {
    const { container } = render({ list: current })
    expect(queryByText(container, 'Test')).not.toBeNull()
    await wrapper.setProps({ list: current, previous })
    expect(queryByText(container, 'Test')).toBeNull()
    expect(queryByText(container, 'Started Write')).not.toBeNull()
  })

  it('above the composer: a collapsed checklist with its progress', async () => {
    const { container } = render({ list: current, presentation: 'composer' })
    const trigger = container.querySelector('button')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(progress(container, '1 of 3 tasks completed').textContent).toBe('1/3')
    expect(queryByText(container, 'Writing')).toBeNull()
    clickEvent(trigger)
    await nextTick()
    expect(queryByText(container, 'Writing')).not.toBeNull()
  })
})
