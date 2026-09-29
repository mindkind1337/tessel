// After Orca's NativeChatMessageList.stream-render.perf.test.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
// The reference counts markdown rebuilds inside the real rows; with the rows
// stubbed, the list-level equivalent is how often each row re-renders at all
// (a row that does not re-render rebuilds nothing), plus the list's own diff
// summaries.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { projectStructuredAgentSessionMessages } from '../../../../chat/orca/shared/structured-agent-session-message-projection.js'
import { installNativeChatMessageListTestViewport } from '../../../../chat/orca/native-chat-message-list-test-viewport.js'
import { flush, getButton, mountList, session, unmountAll } from './native-chat-windowing-test-harness.js'
import { resetRowRenders, rowRenders } from './native-chat-list-stubs.js'

const patchCalls = vi.hoisted(() => ({ detailed: 0, summary: 0 }))
vi.mock('../../../../chat/orca/shared/native-chat-unified-patch.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    editLinesFromUnifiedPatch: (...args) => {
      patchCalls.detailed += 1
      return actual.editLinesFromUnifiedPatch(...args)
    },
    summarizeUnifiedPatch: (...args) => {
      patchCalls.summary += 1
      return actual.summarizeUnifiedPatch(...args)
    }
  }
})
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

const TRANSCRIPT_LENGTH = 120

function settledMessages() {
  return Array.from({ length: TRANSCRIPT_LENGTH }, (_, index) => ({
    id: `message-${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    blocks: [{ type: 'text', text: `settled line ${index}` }],
    timestamp: index + 1,
    source: 'transcript'
  }))
}
const props = (messages, extra = {}) => ({
  session: session(messages),
  isWorking: true,
  expandSignal: false,
  fontScale: 1,
  ...extra
})

// Pure render work (every row drawn, many frames): no timing inside, but a
// loaded machine can take longer than the default 5 s. What is measured is a
// render count, not a duration, so a longer budget weakens nothing.
describe('native chat transcript re-render cost during a streaming turn', { timeout: 30_000 }, () => {
  it('re-renders only the rows whose blocks changed, not the whole transcript per frame', async () => {
    resetRowRenders()
    const messages = settledMessages()
    const wrapper = await mountList(props(messages))
    const total = () => Array.from(rowRenders.values()).reduce((sum, count) => sum + count, 0)
    const afterFirstPaint = total()
    expect(afterFirstPaint).toBeGreaterThanOrEqual(TRANSCRIPT_LENGTH)

    // A streaming turn publishes a frame per event; only the tail's blocks change.
    const STREAM_FRAMES = 20
    for (let frame = 1; frame <= STREAM_FRAMES; frame += 1) {
      const streaming = messages
        .slice(0, -1)
        .concat({ ...messages.at(-1), blocks: [{ type: 'text', text: `streaming token ${frame}` }] })
      await wrapper.setProps(props(streaming))
      await flush()
    }
    const perFrame = (total() - afterFirstPaint) / STREAM_FRAMES
    // Settled rows keep their block identity, so only the streaming tail re-renders.
    expect(perFrame).toBeLessThan(TRANSCRIPT_LENGTH / 10)
  })

  it('keeps structured diff summaries computed once across journal updates', async () => {
    patchCalls.detailed = 0
    patchCalls.summary = 0
    const user = {
      itemId: 'user',
      revision: 1,
      sequence: 1,
      observedAt: 1000,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Edit a file' }] }
    }
    const diff = {
      itemId: 'diff',
      revision: 1,
      sequence: 2,
      observedAt: 2000,
      body: {
        kind: 'diff',
        path: 'src/a.ts',
        patch: { head: '@@ -1 +1 @@\n-old\n+new', truncated: false, digest: 'fixture', byteLength: 25 }
      }
    }
    const view = (items) =>
      props(projectStructuredAgentSessionMessages(items, [], []), { journalItems: items, isWorking: false })
    const wrapper = await mountList(view([user, diff]))
    expect(patchCalls).toEqual({ summary: 1, detailed: 0 })
    for (let frame = 0; frame < 20; frame += 1) {
      await wrapper.setProps(
        view([
          user,
          diff,
          {
            itemId: 'tail',
            revision: frame + 1,
            sequence: 3,
            observedAt: 3000,
            body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: `Token ${frame}` }] }
          }
        ])
      )
      await flush()
    }
    expect(patchCalls).toEqual({ summary: 1, detailed: 0 })
    // The rollup lists the file from the summary alone.
    getButton(/1 changed file/).click()
    await flush()
    expect(patchCalls.detailed).toBe(0)
  })
})
