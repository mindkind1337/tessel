// After Orca's NativeChatMessageList.task-list-frames.test.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
// The list's part: which checklist is pinned above the composer (outside the
// transcript's scroller), that it follows the latest complete snapshot across
// pagination, and that it resets between sessions. How the checklist and the
// in-transcript task rows draw is NativeChatTaskList's (lot 4).
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { projectStructuredItemToNativeChat } from '../../../../chat/orca/shared/structured-agent-session-projection.js'
import { projectNativeChatTaskListFrames } from '../../../../chat/orca/native-chat-task-list-frames.js'
import { installNativeChatMessageListTestViewport } from '../../../../chat/orca/native-chat-message-list-test-viewport.js'
import { flush, getButton, mountList, queryButton, unmountAll } from './native-chat-windowing-test-harness.js'

vi.mock('../NativeChatMessageRow.vue', async () => ({
  default: (await import('./native-chat-list-stubs.js')).MessageRowStub
}))
vi.mock('../NativeChatResolutionReceipt.vue', async () => ({
  default: (await import('./native-chat-list-stubs.js')).ResolutionReceiptStub
}))
vi.mock('../NativeChatTurnDiffRollup.vue', async () => ({
  default: (await import('./native-chat-list-stubs.js')).TurnDiffRollupStub
}))
vi.mock('../NativeChatTaskList.vue', async () => ({
  default: (await import('./native-chat-list-stubs.js')).TaskListStub
}))

let restoreViewport = () => {}
beforeAll(() => {
  restoreViewport = installNativeChatMessageListTestViewport()
})
afterAll(() => restoreViewport())
afterEach(() => unmountAll())

function frame(id, status, overrides = {}) {
  const kind = overrides.kind ?? 'notification:turn/plan/updated'
  const head = JSON.stringify({
    threadId: 'thread',
    turnId: 'turn',
    explanation: 'Keep verification visible',
    plan: [{ step: 'Verify', status }]
  })
  const message = projectStructuredItemToNativeChat({
    itemId: `frame-${id}`,
    revision: 1,
    sequence: id,
    observedAt: id,
    body: {
      kind: 'status',
      text: `codex · ${kind}`,
      providerFrame: {
        provider: 'codex',
        kind,
        payload: {
          head,
          byteLength: new TextEncoder().encode(head).byteLength,
          digest: 'fixture-digest',
          truncated: overrides.truncated ?? false
        }
      }
    }
  })
  if (!message) throw new Error('Expected a projected message')
  return message
}

function transcript(messages, sessionId = 'live-codex') {
  return {
    session: {
      messages,
      status: 'ready',
      sessionId,
      agent: 'codex',
      hasMore: false,
      loadingEarlier: false,
      olderHistoryGeneration: 0,
      loadEarlier: vi.fn(),
      readPhase: 'ready'
    },
    isWorking: false,
    expandSignal: true,
    fontScale: 1,
    showTurnStatus: false
  }
}
const pinned = () => document.querySelector('[data-stub="task-list"]')

describe('live Codex checklist frames', () => {
  it('updates one pinned checklist from journal notifications without rewinding on pagination', async () => {
    const first = frame(1, 'pending')
    const active = frame(2, 'inProgress')
    const last = frame(3, 'completed')
    const wrapper = await mountList(transcript([first]))
    const toggle = getButton('Tasks 0 of 1 tasks completed')
    // Pinned above the composer, outside the transcript's scroller.
    expect(document.querySelector('[data-native-chat-scroll]').contains(toggle)).toBe(false)
    expect(pinned().dataset.presentation).toBe('composer')
    toggle.click()
    await flush()
    await wrapper.setProps(transcript([first, active]))
    await flush()
    await wrapper.setProps(transcript([last]))
    await flush()
    expect(getButton('Tasks 1 of 1 tasks completed')).toBe(toggle)
    // Paging the earlier frames back in does not rewind the checklist.
    await wrapper.setProps(transcript([first, active, last]))
    await flush()
    expect(getButton('Tasks 1 of 1 tasks completed')).toBe(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(projectNativeChatTaskListFrames([last])[0]).toBe(projectNativeChatTaskListFrames([last])[0])
  })

  it('uses the latest complete snapshot across Codex tool calls and notifications', async () => {
    const tool = {
      id: 'tool',
      role: 'assistant',
      timestamp: 1,
      source: 'transcript',
      blocks: [{ type: 'tool-call', name: 'update_plan', input: { plan: [{ step: 'Verify', status: 'pending' }] } }]
    }
    await mountList(transcript([tool, frame(3, 'completed')]))
    expect(getButton('Tasks 1 of 1 tasks completed')).toBeTruthy()
  })

  it('keeps malformed, truncated, other-provider, and plan-document frames unchanged', async () => {
    const truncated = frame(1, 'pending', { truncated: true })
    const document_ = frame(2, 'pending', { kind: 'item:plan' })
    const malformed = frame(3, 'pending')
    const otherProvider = frame(4, 'pending')
    const malformedBlock = malformed.blocks[0]
    const otherBlock = otherProvider.blocks[0]
    if (malformedBlock.type === 'text' && malformedBlock.providerFrame) {
      malformedBlock.providerFrame.payload.head = '{"plan":null}'
    }
    if (otherBlock.type === 'text' && otherBlock.providerFrame) {
      otherBlock.providerFrame.provider = 'claude'
    }
    const messages = [truncated, document_, malformed, otherProvider]
    const projected = projectNativeChatTaskListFrames(messages)
    projected.forEach((message, index) => expect(message).toBe(messages[index]))
    await mountList(transcript([truncated]))
    expect(pinned()).toBeNull()
  })

  it('does not consume a neighboring tool failure as a notification result', async () => {
    const command = {
      id: 'command',
      role: 'assistant',
      timestamp: 2,
      source: 'transcript',
      blocks: [
        { type: 'tool-call', name: 'shell', input: { command: 'verify' }, state: 'failed' },
        { type: 'tool-result', output: 'Verification failed', isError: true }
      ]
    }
    await mountList(transcript([frame(1, 'pending'), command]))
    expect(getButton('Tasks 0 of 1 tasks completed')).toBeTruthy()
  })
})

describe('NativeChatMessageList task list history', () => {
  it('keeps the latest Claude state after pagination and resets disclosure between sessions', async () => {
    const first = {
      id: 'first-list',
      role: 'assistant',
      timestamp: 1,
      source: 'transcript',
      blocks: [
        {
          type: 'tool-call',
          name: 'TodoWrite',
          input: { todos: [{ content: 'Read', status: 'pending' }, { content: 'Test', status: 'pending' }] }
        }
      ]
    }
    const last = {
      ...first,
      id: 'last-list',
      timestamp: 3,
      blocks: [
        { type: 'text', text: 'Ready for verification' },
        {
          type: 'tool-call',
          name: 'TodoWrite',
          input: { todos: [{ content: 'Read', status: 'completed' }, { content: 'Test', status: 'pending' }] }
        }
      ]
    }
    const wrapper = await mountList(transcript([last]))
    getButton('Tasks 1 of 2 tasks completed').click()
    await flush()
    await wrapper.setProps(transcript([first, last]))
    await flush()
    expect(getButton('Tasks 1 of 2 tasks completed').getAttribute('aria-expanded')).toBe('true')
    await wrapper.setProps(transcript([first], 'two'))
    await flush()
    // Keyed by session: a new session's checklist starts closed.
    expect(getButton('Tasks 0 of 2 tasks completed').getAttribute('aria-expanded')).toBe('false')
    await wrapper.setProps(transcript([], 'three'))
    await flush()
    expect(queryButton(/^Tasks/)).toBeNull()
  })
})
