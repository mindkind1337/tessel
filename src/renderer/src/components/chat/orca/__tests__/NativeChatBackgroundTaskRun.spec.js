// After Orca's NativeChatBackgroundTaskRun.test.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
import { afterEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import NativeChatBackgroundTaskRun from '../NativeChatBackgroundTaskRun.vue'
import { deriveNativeChatRowContent } from '../../../../chat/orca/shared/native-chat-row-content.js'
import { queryByText } from './native-chat-tool-test-dom.js'

let wrapper = null
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

function render(block) {
  wrapper = mount(NativeChatBackgroundTaskRun, { props: { block } })
  return { container: wrapper.element }
}

function task(overrides = {}) {
  return {
    type: 'background-task',
    taskId: 'byjnee2no',
    kind: 'command',
    label: 'Wait for the verification verdict',
    state: 'working',
    startedAt: 1_000,
    ...overrides
  }
}

describe('NativeChatBackgroundTaskRun', () => {
  it('draws the failure as a state, with the provider sentence beside it', () => {
    const { container } = render(
      task({
        state: 'blocked',
        settledAt: 61_000,
        summary: 'Background command "Wait" failed with exit code 1',
        tokens: 18_200
      })
    )
    expect(queryByText(container, 'Wait for the verification verdict')).not.toBeNull()
    // The outcome is a state word plus its reason — the same vocabulary the
    // strip above the composer uses — not a red row of prose.
    expect(queryByText(container, /^blocked · failed · 18\.2k · 1m 0s$/)).not.toBeNull()
    expect(queryByText(container, 'Background command "Wait" failed with exit code 1')).not.toBeNull()
  })

  it('never draws a wire opcode, whatever the task reported', () => {
    const { container } = render(task({ state: 'blocked' }))
    expect(container.textContent).not.toContain('message:system')
    expect(container.textContent).not.toContain('task_notification')
  })

  it('falls through to the kind when the provider named nothing usable', () => {
    const { container } = render(task({ label: 'task', kind: 'workflow' }))
    expect(queryByText(container, 'Background workflow')).not.toBeNull()
  })

  it('reads a state this build has no word for as no contact, never as live', () => {
    const { container } = render(task({ state: 'teleported' }))
    expect(container.textContent).toMatch(/unverifiable/)
  })

  it('masks a secret in a task named by its command (Tessel)', () => {
    const { container } = render(task({ label: 'curl -H "Authorization: Bearer abc123SECRETtoken" https://x.test' }))
    expect(container.textContent).not.toContain('abc123SECRETtoken')
    expect(container.textContent).toContain('Authorization: ***')
  })
})

describe('background task rows in a transcript message', () => {
  it('drops the frozen twin the block replaces, and keeps real prose', () => {
    const block = task({ state: 'blocked', summary: 'it failed' })
    const content = deriveNativeChatRowContent([
      { type: 'text', text: 'here is what happened' },
      { type: 'text', text: 'it failed' },
      block
    ])
    expect(content.markdown).toBe('here is what happened')
    expect(content.backgroundTasks).toEqual([block])
  })

  it('counts a task row as content, so the transcript reserves its slot', () => {
    const content = deriveNativeChatRowContent([
      { type: 'text', text: 'it failed' },
      task({ state: 'blocked', summary: 'it failed' })
    ])
    expect(content.markdown).toBe('')
    expect(content.backgroundTasks).toHaveLength(1)
  })
})
