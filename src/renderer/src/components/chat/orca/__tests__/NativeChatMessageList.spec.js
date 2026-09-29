// After Orca's NativeChatMessageList.test.tsx, .turn-indicator.test.tsx,
// .turn-fold.test.tsx, .turn-timing.test.tsx and .turn-history.test.tsx
// (MIT, Copyright (c) 2026 Lovecast Inc.).
//
// The rows (message, receipt, diff rollup, task list) are other lots' and are
// stubbed (native-chat-list-stubs.js): these cases check what the LIST decides —
// which rows mount, what each is handed (live / trailing / folded), the turn
// status and live activity rows, and their order. Cases that only test a row's
// own drawing live with that row's spec.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { subagentGroupFallbackText } from '../../../../chat/orca/shared/native-chat-subagent-summary.js'
import { projectStructuredQuestionMessages } from '../../../../chat/orca/structured-agent-question-projection.js'
import { installNativeChatMessageListTestViewport } from '../../../../chat/orca/native-chat-message-list-test-viewport.js'
import {
  flush,
  getButton,
  getByText,
  installElementScrollTo,
  mountList,
  queryAllButtons,
  queryButton,
  queryByText,
  unmountAll
} from './native-chat-windowing-test-harness.js'
import { rollupFile } from './native-chat-list-stubs.js'

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
let restoreScrollTo = () => {}
beforeAll(() => {
  restoreViewport = installNativeChatMessageListTestViewport()
  restoreScrollTo = installElementScrollTo()
})
afterAll(() => {
  restoreScrollTo()
  restoreViewport()
})
afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
})

const baseSession = {
  messages: [
    {
      id: 'assistant-1',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'Selectable agent response.' }],
      timestamp: 1,
      source: 'transcript'
    }
  ],
  status: 'ready',
  sessionId: 'session-1',
  agent: 'codex',
  hasMore: false,
  loadingEarlier: false,
  olderHistoryGeneration: 0,
  loadEarlier: vi.fn(),
  readPhase: 'ready'
}

function props(overrides) {
  return { session: baseSession, isWorking: false, expandSignal: false, fontScale: 1, ...overrides }
}
const rowOf = (id) => document.querySelector(`[data-stub="message-row"][data-message-id="${id}"]`)
const following = (a, b) => a.compareDocumentPosition(b) === Node.DOCUMENT_POSITION_FOLLOWING
const activityRow = () => document.querySelector('[data-native-chat-turn-activity]')

function runningTool(id, command, state = 'running', timestamp = 1) {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'tool-call', name: 'shell', input: { command }, state }],
    timestamp,
    source: 'transcript'
  }
}

describe('NativeChatMessageList assistant messages', () => {
  it('keeps a running tool live when transcript lifecycle metadata is absent', async () => {
    await mountList(
      props({
        session: { ...baseSession, status: 'working', messages: [runningTool('assistant-tool-1', 'sleep 5')] },
        isWorking: true
      })
    )
    const row = rowOf('assistant-tool-1')
    expect(row.dataset.activeTurnIsWorking).toBe('true')
    expect(row.dataset.trailingRun).toBe('true')
    expect(getButton('sleep 5')).toBeTruthy()
  })

  // Only the turn's trailing run is live. Once the agent has said something
  // after it, that run is done whatever its last call still reports; a
  // reasoning aside is not "after it" — the agent is still inside the batch.
  it('settles a run once prose follows it, but not for a reasoning aside', async () => {
    const run = runningTool('assistant-tool-1', 'sleep 5')
    const after = (role) => ({
      id: `after-${role}`,
      role,
      blocks: [{ type: 'text', text: 'Looking at the output.' }],
      timestamp: 2,
      source: 'transcript'
    })
    const wrapper = await mountList(
      props({ session: { ...baseSession, status: 'working', messages: [run, after('reasoning')] }, isWorking: true })
    )
    expect(rowOf('assistant-tool-1').dataset.trailingRun).toBe('true')

    await wrapper.setProps({ session: { ...baseSession, status: 'working', messages: [run, after('assistant')] } })
    await flush()
    expect(rowOf('assistant-tool-1').dataset.trailingRun).toBe('false')
    expect(rowOf('after-assistant').dataset.trailingRun).toBe('true')
    expect(getButton('sleep 5')).toBeTruthy()
  })

  it('keeps the current tool live when a stale completed lifecycle meets active hook state', async () => {
    await mountList(
      props({
        session: {
          ...baseSession,
          status: 'working',
          transcriptLifecycle: { state: 'completed', turnId: 'old-turn', timestamp: 1 },
          messages: [runningTool('current-tool', 'sleep 5', 'running', 2)]
        },
        isWorking: true
      })
    )
    expect(rowOf('current-tool').dataset.activeTurnIsWorking).toBe('true')
    expect(rowOf('current-tool').dataset.trailingRun).toBe('true')
  })

  it('keeps a turn live from the transcript lifecycle alone (bridge lane)', async () => {
    await mountList(
      props({
        session: {
          ...baseSession,
          transcriptLifecycle: { state: 'working', turnId: 'user-1', timestamp: 1 },
          messages: [runningTool('bridge-tool', 'sleep 5')]
        },
        isWorking: false,
        showTurnStatus: false
      })
    )
    expect(rowOf('bridge-tool').dataset.activeTurnIsWorking).toBe('true')
  })
})

// List-level, because every defect this feature has shipped so far lived in the
// assembly between rows — the roster is its own `role: 'system'` journal row, and
// what reaches the DOM depends on the turn fold and the disclosure state the list owns.
describe('NativeChatMessageList spawn-group roster', () => {
  const ROSTER = [
    { id: 'a', label: 'read', state: 'completed' },
    { id: 'b', label: 'search', state: 'failed' }
  ]
  function rosterMessage(agents, at) {
    return {
      id: 'roster-1',
      role: 'system',
      blocks: [
        { type: 'text', text: subagentGroupFallbackText(agents) },
        { type: 'subagent-group', groupId: 'thread-1:turn-1', agents }
      ],
      timestamp: at,
      source: 'transcript'
    }
  }
  function rosterSession(agents, startedAt) {
    return {
      ...baseSession,
      status: 'ready',
      messages: [
        { id: 'user-fanout', role: 'user', blocks: [{ type: 'text', text: 'Fan this out' }], timestamp: startedAt, source: 'transcript' },
        {
          id: 'assistant-fanout',
          role: 'assistant',
          blocks: [
            { type: 'tool-call', name: 'shell', input: { command: 'pwd' }, state: 'completed' },
            { type: 'tool-result', output: '/repo' }
          ],
          timestamp: startedAt + 1,
          source: 'transcript'
        },
        rosterMessage(agents, startedAt + 2)
      ]
    }
  }

  // A settled turn with its activity collapsed is the resting state of the whole
  // transcript: the roster row must be left behind, unfolded.
  it('leaves the roster row behind on a settled turn whose activity is collapsed', async () => {
    const startedAt = Date.now() - 3000
    await mountList(props({ session: rosterSession(ROSTER, startedAt), workingStartedAt: startedAt }))

    expect(getButton('Toggle turn details').getAttribute('aria-expanded')).toBe('false')
    expect(rowOf('roster-1')).not.toBeNull()
    expect(rowOf('roster-1').dataset.folded).toBe('false')
  })

  // The reordering that kept the roster visible must not have let TOOL activity
  // out from behind the same disclosure.
  it('keeps tool activity behind the disclosure the roster now bypasses', async () => {
    const startedAt = Date.now() - 3000
    await mountList(props({ session: rosterSession(ROSTER, startedAt), workingStartedAt: startedAt }))

    expect(queryButton(/pwd/)).toBeNull()
    getButton('Toggle turn details').click()
    await flush()
    expect(queryAllButtons(/pwd/).length).toBeGreaterThan(0)
    // Expanding must reveal the tools beside the roster, never a second copy of it.
    expect(document.querySelectorAll('[data-message-id="roster-1"]')).toHaveLength(1)
  })

  it('hands the roster a live turn while the turn is still working', async () => {
    const startedAt = Date.now() - 3000
    await mountList(
      props({
        session: {
          ...rosterSession([{ id: 'a', label: 'read', state: 'working' }, { id: 'b', label: 'search', state: 'working' }], startedAt),
          status: 'working'
        },
        isWorking: true,
        workingStartedAt: Date.now()
      })
    )
    expect(rowOf('roster-1').dataset.activeTurnIsWorking).toBe('true')
  })
})

// A childless spawn group draws nothing, so the row must not be mounted on its
// account: an invisible slot would still consume one gap of the transcript.
describe('NativeChatMessageList childless spawn group', () => {
  function rosterSession(blocks, at) {
    return {
      ...baseSession,
      messages: [
        { id: 'user-fanout', role: 'user', blocks: [{ type: 'text', text: 'Fan this out' }], timestamp: at, source: 'transcript' },
        { id: 'roster-1', role: 'system', blocks, timestamp: at + 1, source: 'transcript' }
      ]
    }
  }

  it('mounts no row for a bare spawn group with no children', async () => {
    const startedAt = Date.now() - 3000
    await mountList(
      props({
        session: rosterSession([{ type: 'subagent-group', groupId: 'thread-1:turn-1', agents: [] }], startedAt),
        workingStartedAt: startedAt
      })
    )
    expect(getByText('Fan this out')).toBeTruthy()
    expect(rowOf('roster-1')).toBeNull()
  })

  it('keeps the row for the plain-text twin when the block it stands in for cannot draw', async () => {
    const startedAt = Date.now() - 3000
    await mountList(
      props({
        session: rosterSession(
          [
            { type: 'text', text: subagentGroupFallbackText([]) },
            { type: 'subagent-group', groupId: 'thread-1:turn-1', agents: [] }
          ],
          startedAt
        ),
        workingStartedAt: startedAt
      })
    )
    expect(rowOf('roster-1')).not.toBeNull()
  })
})

// The live turn renders exactly one indicator row; a settled turn keeps its own.
describe('NativeChatMessageList turn indicator', () => {
  const turnItem = { kind: 'turn', turnId: 'turn-1', state: 'running' }
  const legacyTurnRow = { kind: 'status', text: 'Codex is working…', turnLifecycle: { turnId: 'turn-1', state: 'running' } }
  const reasoningRow = { kind: 'message', role: 'reasoning', blocks: [{ type: 'text', text: '' }] }
  const journalItem = (sequence, body) => ({ itemId: `item-${sequence}`, revision: 1, sequence, observedAt: sequence, body })
  const userMessage = (id, text, timestamp = 1) => ({ id, role: 'user', blocks: [{ type: 'text', text }], timestamp, source: 'transcript' })
  const assistantMessage = (id, text, timestamp = 2) => ({ id, role: 'assistant', blocks: [{ type: 'text', text }], timestamp, source: 'transcript' })

  it('keeps a reduced-motion-safe spinner on the live row of a no-tool Codex turn', async () => {
    await mountList(
      props({
        session: {
          ...baseSession,
          status: 'working',
          messages: [userMessage('user-prose', 'Write a long answer'), assistantMessage('assistant-prose', 'The answer is still streaming.')]
        },
        isWorking: true
      })
    )
    const activity = getByText('Working for 0s')
    const row = activity.closest('[data-native-chat-turn-activity]')
    const spinner = row.querySelector('svg')
    expect(activity.classList.contains('nc-animate-pulse')).toBe(false)
    expect(activity.classList.contains('nc-animate-spin')).toBe(false)
    // nc-animate-spin stops under prefers-reduced-motion (orca-tokens.css).
    expect(spinner.classList.contains('nc-animate-spin')).toBe(true)
    expect(spinner.classList.contains('nc-turn-activity__spinner')).toBe(true)
    expect(row.getAttribute('aria-live')).toBe('polite')
    expect(following(getByText('The answer is still streaming.'), row)).toBe(true)
  })

  it('keeps the live row distinct from the running tool row', async () => {
    await mountList(
      props({
        session: { ...baseSession, status: 'working', messages: [runningTool('assistant-running-tool', 'pnpm test')] },
        isWorking: true
      })
    )
    expect(getButton('pnpm test')).toBeTruthy()
    const activity = getByText('Working for 0s')
    expect(activity.textContent).not.toContain('shell')
    expect(activity.textContent).not.toContain('pnpm test')
    expect(document.querySelectorAll('[data-native-chat-turn-status]')).toHaveLength(1)
    expect(activity.closest('[data-native-chat-turn-activity]').querySelector('svg').classList.contains('nc-animate-spin')).toBe(true)
  })

  it('hides foreground turn activity without settling live tool state', async () => {
    await mountList(
      props({
        session: { ...baseSession, status: 'working', messages: [runningTool('assistant-running-tool', 'pnpm test')] },
        journalItems: [journalItem(1, turnItem), journalItem(2, reasoningRow)],
        isWorking: true,
        showLiveTurnActivity: false
      })
    )
    expect(activityRow()).toBeNull()
    expect(queryByText(/Working for/)).toBeNull()
    expect(queryByText('Thinking')).toBeNull()
    expect(rowOf('assistant-running-tool').dataset.activeTurnIsWorking).toBe('true')
  })

  it('keeps the live row up after a tool settles', async () => {
    const settled = {
      id: 'assistant-completed-tool',
      role: 'assistant',
      blocks: [
        { type: 'tool-call', name: 'shell', input: { command: 'pnpm test' }, state: 'completed' },
        { type: 'tool-result', output: 'passed' }
      ],
      timestamp: 1,
      source: 'transcript'
    }
    await mountList(props({ session: { ...baseSession, status: 'working', messages: [settled] }, isWorking: true }))
    const activity = getByText('Working for 0s')
    expect(activity.textContent).not.toContain('pnpm test')
    expect(activity.closest('[data-native-chat-turn-activity]').querySelector('svg').classList.contains('nc-animate-spin')).toBe(true)
  })

  // The run is the turn's trailing one, so it stays live between calls and only
  // settles with the turn; both the run and the tail's spinner are gone once the turn is.
  it('keeps the trailing run live while the turn tail spins, then settles both', async () => {
    const workingSession = {
      ...baseSession,
      status: 'working',
      messages: [
        {
          id: 'assistant-settled-tool',
          role: 'assistant',
          blocks: [
            { type: 'tool-call', name: 'shell', input: { command: 'pnpm test' }, state: 'completed' },
            { type: 'tool-result', output: 'passed' }
          ],
          timestamp: 1,
          source: 'transcript'
        }
      ]
    }
    const turnActivity = { kind: 'description', text: 'Preparing the answer' }
    const wrapper = await mountList(props({ session: workingSession, isWorking: true, turnActivity }))
    const liveRun = rowOf('assistant-settled-tool')
    expect(liveRun.dataset.trailingRun).toBe('true')
    expect(liveRun.dataset.activeTurnIsWorking).toBe('true')
    const activity = getByText('Preparing the answer')
    expect(activity.closest('[data-native-chat-turn-activity]').querySelector('svg').classList.contains('nc-animate-spin')).toBe(true)

    await wrapper.setProps({ session: { ...workingSession, status: 'ready' }, isWorking: false })
    await flush()
    expect(activityRow()).toBeNull()
    expect(document.querySelector('.nc-animate-spin')).toBeNull()
    // Same element, now settled.
    expect(rowOf('assistant-settled-tool')).toBe(liveRun)
    expect(liveRun.dataset.activeTurnIsWorking).toBe('false')
  })

  it('keeps bridge chats on the legacy activity chrome', async () => {
    await mountList(
      props({
        session: { ...baseSession, status: 'working', messages: [runningTool('bridge-tool', 'sleep 5')] },
        isWorking: true,
        showTurnStatus: false
      })
    )
    expect(queryByText('Thinking')).toBeNull()
    expect(queryButton('Toggle turn details')).toBeNull()
    expect(activityRow()).toBeNull()
    expect(rowOf('bridge-tool').dataset.structuredActivityUi).toBe('false')
    expect(document.querySelectorAll('.nc-animate-bounce')).toHaveLength(3)
  })

  it('reads "Thinking" on the one live row while the turn is reasoning', async () => {
    await mountList(
      props({
        session: { ...baseSession, status: 'working', messages: [userMessage('user-thinking', 'Start the task', Date.now())] },
        journalItems: [journalItem(1, turnItem), journalItem(2, reasoningRow)],
        isWorking: true
      })
    )
    const thinking = getByText('Thinking')
    expect(following(getByText('Start the task'), thinking)).toBe(true)
    // One indicator, not a "Thinking" row stacked above a spinning "Working…" row.
    expect(document.querySelectorAll('[data-native-chat-turn-status]')).toHaveLength(1)
    expect(thinking.closest('[data-native-chat-turn-activity]').querySelector('svg').classList.contains('nc-animate-spin')).toBe(true)
    expect(document.querySelector('.nc-animate-bounce')).toBeNull()
  })

  it('does not reuse completed-turn reasoning while the next dispatch is pending', async () => {
    await mountList(
      props({
        session: { ...baseSession, status: 'working', messages: [userMessage('user-next', 'Start the next task', Date.now())] },
        journalItems: [journalItem(1, { kind: 'turn', turnId: 'turn-1', state: 'completed' }), journalItem(2, reasoningRow)],
        isWorking: true
      })
    )
    expect(queryByText('Thinking')).toBeNull()
    expect(getByText('Working for 0s')).toBeTruthy()
  })

  it('lets provider activity text beat the reasoning label on the same single row', async () => {
    await mountList(
      props({
        session: { ...baseSession, status: 'working', messages: [userMessage('user-activity', 'Start the task', Date.now())] },
        journalItems: [journalItem(1, legacyTurnRow), journalItem(2, reasoningRow)],
        turnActivity: { kind: 'description', text: 'Exploring the repo layout' },
        isWorking: true
      })
    )
    expect(getByText('Exploring the repo layout')).toBeTruthy()
    expect(queryByText('Thinking')).toBeNull()
    expect(document.querySelectorAll('[data-native-chat-turn-status]')).toHaveLength(1)
  })

  it('places the one live row after the newest content in the turn', async () => {
    await mountList(
      props({
        session: {
          ...baseSession,
          status: 'working',
          messages: [userMessage('user-1', 'Run the checks'), assistantMessage('assistant-1', 'I am checking now.')]
        },
        isWorking: true
      })
    )
    const status = getByText('Working for 0s')
    // The live row trails the newest content instead of sitting under the prompt.
    expect(following(getByText('I am checking now.'), status)).toBe(true)
    expect(document.querySelectorAll('[data-native-chat-turn-status]')).toHaveLength(1)
  })

  it('shows elapsed working time once tool activity starts', async () => {
    await mountList(
      props({
        session: { ...baseSession, status: 'working', messages: [runningTool('tool-1', 'sleep 5')] },
        isWorking: true,
        workingStartedAt: Date.now() - 3000
      })
    )
    expect(getByText('Working for 3s')).toBeTruthy()
  })

  it('keeps the completed duration below the user message', async () => {
    const startedAt = Date.now() - 3000
    const turnSession = {
      ...baseSession,
      status: 'working',
      messages: [userMessage('user-complete', 'Complete this task', startedAt), assistantMessage('assistant-complete', 'Task complete.', Date.now())]
    }
    const wrapper = await mountList(props({ session: turnSession, isWorking: true, workingStartedAt: startedAt }))

    await wrapper.setProps({ session: { ...turnSession, status: 'ready' }, isWorking: false, workingStartedAt: null })
    await flush()
    const status = getByText('Worked for 3s')
    expect(following(getByText('Complete this task'), status)).toBe(true)
    expect(following(status, getByText('Task complete.'))).toBe(true)

    await wrapper.setProps({
      session: { ...turnSession, status: 'working', messages: [...turnSession.messages, userMessage('user-next', 'Start another task', Date.now())] },
      isWorking: true,
      workingStartedAt: Date.now()
    })
    await flush()
    expect(getByText('Worked for 3s')).toBeTruthy()
    expect(getByText('Working for 0s')).toBeTruthy()
  })

  it("uses the completed caret to expand that turn's tool details", async () => {
    const startedAt = Date.now() - 3000
    await mountList(
      props({
        session: {
          ...baseSession,
          messages: [
            userMessage('user-details', 'Inspect the repo', startedAt),
            {
              id: 'assistant-details',
              role: 'assistant',
              blocks: [
                { type: 'tool-call', name: 'shell', input: { command: 'pwd' }, state: 'completed' },
                { type: 'tool-result', output: '/repo' }
              ],
              timestamp: Date.now(),
              source: 'transcript'
            }
          ]
        },
        workingStartedAt: startedAt
      })
    )
    const status = getButton('Toggle turn details')
    expect(status.getAttribute('aria-expanded')).toBe('false')
    expect(queryButton(/pwd/)).toBeNull()
    status.click()
    await flush()
    expect(getButton('Toggle turn details').getAttribute('aria-expanded')).toBe('true')
    // Opening the turn status reveals the turn, but does not open its nested
    // tool-run disclosure. The command remains a separate reader action.
    const tools = queryAllButtons(/pwd/)
    expect(tools).toHaveLength(1)
    expect(tools[0].getAttribute('aria-expanded')).toBe('false')
  })
})

// A finished turn should read as the answer to the prompt — not as the
// transcript of the work that produced it.
describe('NativeChatMessageList settled turn fold', () => {
  const NARRATION = 'I am starting with the required readiness pass.'
  const MORE_NARRATION = 'The branch is current and the reference corpus is refreshed.'
  const ANSWER = 'Review complete: clean after fixes.'
  function foldSession(startedAt) {
    return {
      ...baseSession,
      messages: [
        { id: 'user-1', role: 'user', blocks: [{ type: 'text', text: 'Please review this PR.' }], timestamp: startedAt, source: 'transcript' },
        { id: 'narration-1', role: 'assistant', blocks: [{ type: 'text', text: NARRATION }], timestamp: startedAt + 1, source: 'transcript' },
        {
          id: 'work-1',
          role: 'assistant',
          blocks: [
            { type: 'tool-call', name: 'shell', input: { command: 'pnpm test' }, state: 'completed' },
            { type: 'tool-result', output: 'ok' }
          ],
          timestamp: startedAt + 2,
          source: 'transcript'
        },
        { id: 'narration-2', role: 'assistant', blocks: [{ type: 'text', text: MORE_NARRATION }], timestamp: startedAt + 3, source: 'transcript' },
        { id: 'answer-1', role: 'assistant', blocks: [{ type: 'text', text: ANSWER }], timestamp: startedAt + 4, source: 'transcript' }
      ]
    }
  }

  it('shows a settled turn as its prompt, its duration and its answer', async () => {
    const startedAt = Date.now() - 3000
    await mountList(props({ session: foldSession(startedAt), workingStartedAt: startedAt }))
    expect(getByText('Please review this PR.')).toBeTruthy()
    expect(getByText(ANSWER)).toBeTruthy()
    expect(queryByText(NARRATION)).toBeNull()
    expect(queryByText(MORE_NARRATION)).toBeNull()
    expect(getButton('Toggle turn details').getAttribute('aria-expanded')).toBe('false')
  })

  it('returns the whole turn when the reader opens it', async () => {
    const startedAt = Date.now() - 3000
    await mountList(props({ session: foldSession(startedAt), workingStartedAt: startedAt }))
    getButton('Toggle turn details').click()
    await flush()
    expect(getByText(NARRATION)).toBeTruthy()
    expect(getByText(MORE_NARRATION)).toBeTruthy()
    expect(getByText(ANSWER)).toBeTruthy()
    expect(getButton('Toggle turn details').getAttribute('aria-expanded')).toBe('true')
  })

  // While the turn runs there is no fold at all, so the reader watches the work happen.
  it('folds nothing while the turn is still running', async () => {
    const startedAt = Date.now() - 3000
    await mountList(
      props({ session: { ...foldSession(startedAt), status: 'working' }, isWorking: true, workingStartedAt: startedAt })
    )
    expect(getByText(NARRATION)).toBeTruthy()
    expect(getByText(MORE_NARRATION)).toBeTruthy()
    expect(queryButton('Toggle turn details')).toBeNull()
  })

  // The answer is the LAST prose the agent produced, even when a tool run follows it.
  it('keeps the last prose row when the turn ends on tool activity', async () => {
    const startedAt = Date.now() - 3000
    const base = foldSession(startedAt)
    await mountList(
      props({
        session: {
          ...base,
          messages: [
            ...base.messages,
            {
              id: 'work-2',
              role: 'assistant',
              blocks: [
                { type: 'tool-call', name: 'shell', input: { command: 'git push' }, state: 'completed' },
                { type: 'tool-result', output: 'done' }
              ],
              timestamp: startedAt + 5,
              source: 'transcript'
            }
          ]
        },
        workingStartedAt: startedAt
      })
    )
    expect(getByText(ANSWER)).toBeTruthy()
    expect(queryByText(NARRATION)).toBeNull()
  })
})

describe('NativeChatMessageList host-settled turn timing', () => {
  const session = {
    ...baseSession,
    messages: [
      { id: 'user-settled', role: 'user', blocks: [{ type: 'text', text: 'Settled on the host' }], timestamp: 1, source: 'transcript' },
      { id: 'assistant-settled', role: 'assistant', blocks: [{ type: 'text', text: 'Done.' }], timestamp: 2, source: 'transcript' }
    ]
  }
  const settledTurns = new Map([['user-settled', { startedAt: 1, workedSeconds: 197 }]])

  it('does not render a local completed duration when the host cannot verify the end', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const unknownTurns = new Map([['user-settled', null]])
    const wrapper = await mountList(props({ session, isWorking: true, workingStartedAt: 1_000, settledTurns: unknownTurns }))
    now.mockReturnValue(60_000)
    await wrapper.setProps({ isWorking: false, workingStartedAt: null })
    await flush()
    expect(queryByText(/Worked for/)).toBeNull()
  })

  it('renders a host-settled duration without ever clocking the turn locally', async () => {
    // A local clock nowhere near the host's: the value must still be the host's.
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    const wrapper = await mountList(props({ session, workingStartedAt: null, settledTurns }))
    expect(getByText('Worked for 3m 17s')).toBeTruthy()
    now.mockReturnValue(1_700_000_099_000)
    await wrapper.setProps({ session: { ...session } })
    await flush()
    expect(getByText('Worked for 3m 17s')).toBeTruthy()
  })
})

describe('turn history presentation', () => {
  const item = (itemId, body, sequence) => ({ itemId, body, sequence, observedAt: sequence * 1000, revision: 1 })
  const user = item('user', { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Make the change' }] }, 1)
  const prose = item('prose', { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Updating the files.' }] }, 2)
  const diff = (patch = '@@ -1 +1 @@\n-before\n+after') =>
    item('diff', { kind: 'diff', path: 'src/a.ts', patch: { head: patch, truncated: false, digest: 'fixture', byteLength: patch.length } }, 3)
  const historySession = (items) => ({
    ...baseSession,
    sessionId: 'session',
    messages: projectStructuredQuestionMessages(items)
  })
  const view = (items, structured = true) =>
    props({ session: historySession(items), journalItems: structured ? items : undefined })
  const receipts = () => document.querySelectorAll('[data-native-chat-receipt]')

  const pending = { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }

  it('renders canonical pending questions while idle and keeps resolved answers at their row', async () => {
    const question = item(
      'question',
      { kind: 'question', question: 'Which branch?', options: [{ id: 'main', label: 'main' }], resolution: pending },
      3
    )
    const wrapper = await mountList(view([user, prose, question]))
    expect(getByText('Awaiting user input:')).toBeTruthy()
    const settled = item(
      'question',
      {
        ...question.body,
        resolution: { state: 'resolved', selectedOptionId: 'main', resolvedBy: 'desktop', resolvedAt: 4000 }
      },
      3
    )
    await wrapper.setProps(view([user, prose, settled]))
    await flush()
    expect(queryByText('Awaiting user input:')).toBeNull()
    expect(receipts()).toHaveLength(1)
    expect(getByText('Asked:')).toBeTruthy()
  })

  it('groups pending Codex questions then narrows the awaiting group after one answer', async () => {
    const first = item(
      'q1',
      { kind: 'question', question: 'Which branch?', options: [{ id: 'main', label: 'main' }], resolution: pending },
      3
    )
    const second = item('q2', { kind: 'question', question: 'Proceed?', options: [], resolution: pending }, 4)
    const wrapper = await mountList(view([user, first, second]))
    // One receipt row stands for the whole pending group.
    expect(receipts()).toHaveLength(1)
    expect(document.querySelectorAll('[data-native-chat-receipt]')[0].textContent).toContain('Awaiting user input:')
    const answered = item(
      'q1',
      {
        ...first.body,
        resolution: { state: 'resolved', selectedOptionId: 'main', resolvedBy: 'phone', resolvedAt: 5000 }
      },
      3
    )
    await wrapper.setProps(view([user, answered, second]))
    await flush()
    expect(receipts()).toHaveLength(2)
    expect(getByText('Asked:')).toBeTruthy()
    expect(getByText('Awaiting user input:')).toBeTruthy()
  })

  it('renders one resolved row when Claude journals both the call and receipt', async () => {
    const call = item(
      'ask-call',
      {
        kind: 'tool-call',
        name: 'AskUserQuestion',
        input: { questions: [{ question: 'Which branch?' }] },
        state: 'completed',
        output: { head: 'main', byteLength: 4, truncated: false, digest: 'answer' }
      },
      3
    )
    const question = item(
      'question-receipt',
      {
        kind: 'question',
        question: 'Which branch?',
        options: [{ id: 'main', label: 'main' }],
        resolution: { state: 'resolved', selectedOptionId: 'main', resolvedBy: 'desktop', resolvedAt: 4000 }
      },
      4
    )
    await mountList(view([user, call, question]))
    expect(receipts()).toHaveLength(1)
  })

  it('reveals and scrolls to a diff card from a collapsed completed turn', async () => {
    const scrollTo = vi.spyOn(HTMLElement.prototype, 'scrollTo')
    await mountList(view([user, prose, diff()]))
    expect(queryByText('Edited file')).toBeNull()
    const header = getButton(/1 changed file/)
    expect(header.getAttribute('aria-expanded')).toBe('false')
    header.click()
    await flush()
    rollupFile('src/a.ts').click()
    await flush()
    expect(getByText('Edited file')).toBeTruthy()
    expect(scrollTo).toHaveBeenCalled()
    const first = scrollTo.mock.calls.length
    rollupFile('src/a.ts').click()
    await flush()
    // A second reveal is a new request, serviced again.
    expect(scrollTo.mock.calls.length).toBeGreaterThan(first)
  })

  it('replaces a resolved approval with a passive receipt', async () => {
    const approval = item(
      'approval',
      {
        kind: 'approval',
        title: 'Run tests?',
        detail: 'pnpm test',
        options: [{ id: 'allow', label: 'Allow once' }],
        resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
      },
      4
    )
    const wrapper = await mountList(view([user, prose, diff(), approval]))
    expect(receipts()).toHaveLength(0)
    const resolved = {
      ...approval,
      revision: 2,
      body: { ...approval.body, resolution: { state: 'resolved', selectedOptionId: 'allow', resolvedBy: 'desktop', resolvedAt: 5000 } }
    }
    await wrapper.setProps(view([user, prose, diff('@@ -0,0 +1,2 @@\n+first\n+second'), resolved]))
    await flush()
    expect(getButton(/1 changed file/)).toBeTruthy()
    expect(receipts()).toHaveLength(1)
    expect(getByText('Resolved').closest('[data-native-chat-receipt]')).not.toBeNull()
  })

  it('keeps rollups turn-local and leaves legacy message lists unchanged', async () => {
    const secondUser = item('user-two', { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Again' }] }, 5)
    const secondDiff = { ...diff(), itemId: 'second-diff', sequence: 6, observedAt: 6000 }
    const items = [user, prose, diff(), secondUser, secondDiff]
    const wrapper = await mountList(view(items))
    expect(queryAllButtons(/1 changed file/)).toHaveLength(2)
    await wrapper.setProps(view(items, false))
    await flush()
    expect(queryButton(/changed file/)).toBeNull()
  })
})
