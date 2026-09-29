// @vitest-environment node
// Synthetic protocol fixtures: no real agent process is started.
import { describe, expect, it } from 'vitest'
import { createFrameState, normalizeFrame } from '../claudeFrames.js'
import { createCodexState, normalizeCodexNotification, newTurn } from '../codexChat.js'
import { createSubagentTracker, subagentTokens, SUBAGENT_THROTTLE_MS } from '../subagents.js'

const task = (extra = {}) => ({
  type: 'assistant',
  message: {
    id: 'parent-message',
    content: [
      {
        type: 'tool_use',
        id: 'task-tool',
        name: 'Agent',
        input: {
          description: 'Inspect fixtures',
          subagent_type: 'Explore',
          model: 'small',
          ...extra
        }
      }
    ]
  }
})
const snapshots = (events) => events.filter((e) => e.type === 'subagents')
const lastAgent = (events) => snapshots(events).at(-1)?.agents[0]
const collab = (status = 'running', extra = {}) => ({
  threadId: 'root',
  turnId: 'root-turn',
  item: {
    type: 'collabAgentToolCall',
    id: 'spawn-tool',
    tool: 'spawnAgent',
    status: 'completed',
    senderThreadId: 'root',
    receiverThreadIds: ['child'],
    prompt: 'Inspect fixtures',
    model: 'small',
    agentsStates: { child: { status, message: null } },
    ...extra
  }
})
function codex() {
  const clock = { t: 1000 }
  const state = createCodexState({ threadId: 'root', now: () => clock.t })
  newTurn(state, 'root-turn')
  const frame = (method, params) => normalizeCodexNotification(method, params, state)
  return { state, frame, clock }
}

describe('Claude subagent observations', () => {
  it('keeps the parent tool and groups child content, tools and final metrics', () => {
    let now = 1000
    const state = createFrameState({ now: () => now })
    const first = normalizeFrame(task(), state)
    expect(first).toContainEqual(
      expect.objectContaining({ type: 'assistant', messageId: 'parent-message' })
    )
    expect(lastAgent(first)).toEqual({
      id: 'task-tool',
      label: 'Inspect fixtures',
      state: 'working',
      startedAt: 1000
    })
    expect(first.find((e) => e.type === 'subagent')).toMatchObject({
      phase: 'start',
      subagentType: 'Explore',
      model: 'small',
      groupId: 'parent-message'
    })
    const child = normalizeFrame(
      {
        type: 'assistant',
        parent_tool_use_id: 'task-tool',
        message: {
          id: 'child-message',
          model: 'small',
          usage: { input_tokens: 10, output_tokens: 2 },
          content: [
            { type: 'text', text: 'Reading' },
            { type: 'tool_use', id: 'read-tool', name: 'Read', input: { file_path: 'fixture.txt' } }
          ]
        }
      },
      state
    )
    expect(child).toContainEqual(
      expect.objectContaining({
        type: 'assistant',
        agentId: 'task-tool',
        parentToolUseId: 'task-tool'
      })
    )
    expect(child).toContainEqual(
      expect.objectContaining({
        type: 'subagent',
        phase: 'progress',
        tool: { id: 'read-tool', name: 'Read', status: 'running' }
      })
    )
    now = 1500
    const end = normalizeFrame(
      {
        type: 'result',
        parent_tool_use_id: 'task-tool',
        subtype: 'success',
        usage: { input_tokens: 10, output_tokens: 5 },
        duration_ms: 450
      },
      state
    )
    expect(end.some((e) => e.type === 'turnEnd')).toBe(false)
    expect(lastAgent(end)).toMatchObject({ state: 'completed', tokens: 15, settledAt: 1500 })
    expect(end).toContainEqual(
      expect.objectContaining({ type: 'subagent', phase: 'end', durationMs: 450 })
    )
    expect(
      normalizeFrame({ type: 'result', subtype: 'success' }, state).filter(
        (e) => e.type === 'turnEnd'
      )
    ).toHaveLength(1)
  })

  it('isolates child stream ids and ignores child lifecycle/configuration/auth side effects', () => {
    const state = createFrameState()
    normalizeFrame(task(), state)
    normalizeFrame(
      { type: 'stream_event', event: { type: 'message_start', message: { id: 'root-stream' } } },
      state
    )
    normalizeFrame(
      {
        type: 'stream_event',
        parent_tool_use_id: 'task-tool',
        event: { type: 'message_start', message: { id: 'child-stream' } }
      },
      state
    )
    const delta = (parent) =>
      normalizeFrame(
        {
          type: 'stream_event',
          ...(parent ? { parent_tool_use_id: parent } : {}),
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } }
        },
        state
      ).find((e) => e.type === 'textDelta')
    expect(delta('task-tool')).toMatchObject({ agentId: 'task-tool', messageId: 'child-stream' })
    expect(delta()).toMatchObject({ messageId: 'root-stream' })
    expect(delta().agentId).toBeUndefined()
    state.sent.add('user-uuid')
    state.interruptRequested = true
    for (const fixture of [
      { type: 'system', subtype: 'init', session_id: 'wrong-session' },
      { type: 'command_lifecycle', state: 'started', command_uuid: 'user-uuid' },
      { type: 'user', isReplay: true, uuid: 'user-uuid' },
      { type: 'assistant', error: 'authentication_failed', message: {} }
    ])
      expect(
        normalizeFrame({ ...fixture, parent_tool_use_id: 'task-tool' }, state).some((e) =>
          ['init', 'accepted', 'authError', 'turnEnd'].includes(e.type)
        )
      ).toBe(false)
    expect(state.sessionId).toBeNull()
    expect(state.accepted.size).toBe(0)
    expect(state.interruptRequested).toBe(true)
  })

  it('keeps background launches working until an authoritative task notification', () => {
    const clock = { t: 1000 }
    const state = createFrameState({ now: () => clock.t })
    normalizeFrame(task({ run_in_background: true }), state)
    normalizeFrame(
      {
        type: 'system',
        subtype: 'task_started',
        task_type: 'local_agent',
        tool_use_id: 'task-tool',
        task_id: 'background-id'
      },
      state
    )
    normalizeFrame(
      {
        type: 'user',
        tool_use_result: { status: 'async_launched' },
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'task-tool', content: 'Launched' }]
        }
      },
      state
    )
    expect(state.subagents.tracker.get('task-tool').state).toBe('working')
    clock.t += 1000 // past the snapshot throttle window
    const progress = normalizeFrame(
      {
        type: 'system',
        subtype: 'task_progress',
        task_id: 'background-id',
        usage: { total_tokens: 32 }
      },
      state
    )
    expect(lastAgent(progress)).toMatchObject({ id: 'task-tool', tokens: 32 })
    const end = normalizeFrame(
      {
        type: 'system',
        subtype: 'task_notification',
        task_id: 'background-id',
        status: 'completed',
        usage: { total_tokens: 40 }
      },
      state
    )
    expect(lastAgent(end)).toMatchObject({ state: 'completed', tokens: 40 })
    normalizeFrame(task(), state)
    expect(state.subagents.tracker.get('task-tool').state).toBe('completed')
  })

  it('ignores unrelated task kinds and falls back to an unverifiable final state', () => {
    const state = createFrameState({ now: () => 1000 })
    for (const task_type of ['local_bash', 'local_workflow']) {
      expect(
        snapshots(
          normalizeFrame(
            {
              type: 'system',
              subtype: 'task_started',
              task_type,
              tool_use_id: 'other',
              task_id: 'background',
              subagent_type: 'Explore'
            },
            state
          )
        )
      ).toEqual([])
    }
    normalizeFrame(task(), state)
    expect(lastAgent(normalizeFrame({ type: 'result', subtype: 'success' }, state)).state).toBe(
      'unverifiable'
    )
    expect(
      lastAgent(
        normalizeFrame(
          {
            type: 'user',
            message: {
              content: [
                { type: 'tool_result', tool_use_id: 'task-tool', is_error: true, content: 'Failed' }
              ]
            }
          },
          state
        )
      ).state
    ).toBe('failed')
  })

  it('interruption stops remaining children and alias task notifications cannot restart them', () => {
    const state = createFrameState()
    normalizeFrame(task(), state)
    expect(
      lastAgent(
        normalizeFrame(
          { type: 'result', subtype: 'error_during_execution', terminal_reason: 'aborted_by_user' },
          state
        )
      ).state
    ).toBe('stopped')
    normalizeFrame(task(), state)
    expect(state.subagents.tracker.get('task-tool').state).toBe('stopped')
  })
})

describe('Codex subagent observations', () => {
  it('does not confuse a completed spawn/wait call with a completed child', () => {
    const { state, frame } = codex()
    const spawned = frame('item/completed', collab())
    expect(lastAgent(spawned)).toMatchObject({
      id: 'child',
      state: 'working',
      label: 'Inspect fixtures'
    })
    expect(spawned).toContainEqual(
      expect.objectContaining({
        type: 'assistant',
        blocks: [expect.objectContaining({ name: 'Agent' })]
      })
    )
    frame('item/completed', collab('running', { id: 'wait-tool', tool: 'wait' }))
    expect(state.subagents.get('child').state).toBe('working')
    const done = frame('item/completed', collab('completed', { id: 'wait-tool-2', tool: 'wait' }))
    expect(lastAgent(done).state).toBe('completed')
    expect(state.turn.settled).toBe(false)
    expect(frame('item/completed', collab('running')).some((e) => e.type === 'subagents')).toBe(
      false
    )
  })

  it('routes known child content and usage without altering parent state or approval metadata', () => {
    const { state, frame, clock } = codex()
    frame('item/completed', collab())
    expect(
      frame('item/agentMessage/delta', { threadId: 'unknown', itemId: 'a', delta: 'ignored' })
    ).toEqual([])
    expect(
      frame('item/agentMessage/delta', { threadId: 'child', itemId: 'a', delta: 'child text' })
    ).toEqual([
      {
        type: 'textDelta',
        messageId: 'child:a',
        index: 0,
        text: 'child text',
        agentId: 'child',
        parentToolUseId: 'spawn-tool'
      }
    ])
    const change = {
      threadId: 'child',
      item: {
        type: 'commandExecution',
        id: 'command',
        command: 'echo fixture',
        status: 'completed',
        aggregatedOutput: 'fixture',
        exitCode: 0
      }
    }
    const tools = frame('item/completed', change)
    expect(tools).toContainEqual(
      expect.objectContaining({
        type: 'toolResult',
        agentId: 'child',
        parentToolUseId: 'spawn-tool'
      })
    )
    expect(frame('item/completed', change)).toEqual([])
    frame('thread/settings/updated', {
      threadId: 'child',
      settings: { model: 'child-model', approvalPolicy: 'never' }
    })
    frame('thread/tokenUsage/updated', {
      threadId: 'child',
      tokenUsage: { total: { totalTokens: 20 } }
    })
    clock.t += 1000 // past the snapshot throttle window
    const usage = frame('thread/tokenUsage/updated', {
      threadId: 'child',
      tokenUsage: { total: { totalTokens: 25 } }
    })
    expect(lastAgent(usage).tokens).toBe(25)
    expect(state.model).toBeNull()
    expect(state.usage).toBeNull()
    expect(state.fileChanges.size).toBe(0)
    expect(state.turn.lastText).toBe('')
    const done = frame('turn/completed', {
      threadId: 'child',
      turn: { id: 'child-turn', status: 'completed' }
    })
    expect(lastAgent(done).state).toBe('completed')
    expect(done.some((e) => e.type === 'turnEnd')).toBe(false)
    expect(state.turn.settled).toBe(false)
    expect(frame('item/completed', { ...change, item: { ...change.item, id: 'late' } })).toEqual([])
  })

  it('settles root leftovers and accepts only a final correction in the original group', () => {
    const { state, frame } = codex()
    frame('item/completed', collab())
    const end = frame('turn/completed', {
      threadId: 'root',
      turn: { id: 'root-turn', status: 'completed' }
    })
    expect(lastAgent(end).state).toBe('unverifiable')
    newTurn(state, 'second-turn')
    const late = frame('item/completed', { ...collab('completed'), turnId: 'second-turn' })
    expect(snapshots(late).at(-1).groupId).toBe('root-turn')
    expect(lastAgent(late).state).toBe('completed')
  })

  it.each([
    ['pendingInit', 'working'],
    ['errored', 'failed'],
    ['shutdown', 'stopped'],
    ['interrupted', 'stopped'],
    ['notFound', 'unverifiable']
  ])('maps provider status %s to %s', (provider, expected) => {
    const { frame } = codex()
    expect(lastAgent(frame('item/completed', collab(provider))).state).toBe(expected)
  })

  it('supports activity items, bounded siblings and ignores a foreign sender', () => {
    const { frame } = codex()
    expect(
      snapshots(frame('item/completed', collab('running', { senderThreadId: 'foreign' })))
    ).toEqual([])
    const activity = {
      threadId: 'root',
      turnId: 'root-turn',
      item: {
        type: 'subAgentActivity',
        id: 'activity',
        agentThreadId: 'activity-child',
        agentPath: '/review',
        kind: 'started'
      }
    }
    expect(lastAgent(frame('item/started', activity))).toMatchObject({
      state: 'working',
      label: '/review'
    })
    expect(
      lastAgent(
        frame('item/completed', { ...activity, item: { ...activity.item, kind: 'interrupted' } })
      ).state
    ).toBe('stopped')
    const many = frame(
      'item/completed',
      collab('running', {
        receiverThreadIds: Array.from({ length: 100 }, (_, i) => `child-${i}`),
        agentsStates: {}
      })
    )
    expect(snapshots(many).at(-1).agents).toHaveLength(64)
  })
})

describe('review fixes', () => {
  it("namespaces a child's item ids so they never meet the parent's or another child's", () => {
    const { frame } = codex()
    frame('item/completed', collab('running', { receiverThreadIds: ['child', 'child-2'], agentsStates: {} }))
    const item = { type: 'commandExecution', id: 'call-1', command: 'echo x', status: 'inProgress' }
    const one = frame('item/started', { threadId: 'child', item })
    const two = frame('item/started', { threadId: 'child-2', item })
    const toolIds = (events) =>
      events.filter((e) => e.type === 'assistant').flatMap((e) => e.blocks.map((b) => b.id))
    expect(toolIds(one)).toEqual(['child:call-1'])
    expect(toolIds(two)).toEqual(['child-2:call-1'])
    const message = frame('item/completed', {
      threadId: 'child',
      item: { type: 'agentMessage', id: 'msg', text: 'hi' }
    })
    expect(message[0]).toMatchObject({ messageId: 'child:msg', agentId: 'child' })
  })

  it('settles, at turn end, a working child first seen in that turn whatever its group', () => {
    const { frame, state } = codex()
    // Group from another turn id (the item said so), but first seen in root-turn.
    frame('item/completed', { ...collab(), turnId: 'other-turn' })
    expect(state.subagents.get('child')).toMatchObject({ groupId: 'other-turn', state: 'working' })
    const end = frame('turn/completed', { threadId: 'root', turn: { id: 'root-turn', status: 'interrupted' } })
    expect(lastAgent(end)).toMatchObject({ id: 'child', state: 'stopped' })
    expect(end.some((e) => e.type === 'turnEnd')).toBe(true)
  })

  it('does not settle a child of another open turn at an unrelated turn end', () => {
    const tracker = createSubagentTracker(() => 1),
      out = []
    const turnA = {},
      turnB = {}
    tracker.upsert('a', 'ga', { owner: turnA }, out)
    tracker.upsert('b', 'gb', { owner: turnB }, out)
    tracker.settle(null, 'completed', out, turnA)
    expect(tracker.get('a').state).toBe('unverifiable')
    expect(tracker.get('b').state).toBe('working')
    tracker.settle(null, 'failed', out) // process exit: everything
    expect(tracker.get('b').state).toBe('unverifiable')
  })

  it("Manual: a child thread's settings leaving the posture ask to close, as the parent's", () => {
    const { frame, state } = codex()
    frame('item/completed', collab())
    const settings = { threadId: 'child', settings: { model: 'child-model', approvalPolicy: 'never' } }
    expect(frame('thread/settings/updated', settings).some((e) => e.type === 'postureMismatch')).toBe(false)
    state.postureCheck = true
    const out = frame('thread/settings/updated', { ...settings, settings: { approvalPolicy: 'never' } })
    expect(out).toContainEqual({ type: 'postureMismatch', reason: expect.stringContaining('approvalPolicy') })
    const fine = frame('thread/settings/updated', {
      threadId: 'child',
      settings: { approvalPolicy: 'on-request' }
    })
    expect(fine.some((e) => e.type === 'postureMismatch')).toBe(false)
  })

  it('reads agentsStates by own property only', () => {
    const { frame, state } = codex()
    frame(
      'item/completed',
      collab('running', {
        receiverThreadIds: ['constructor', 'toString'],
        agentsStates: Object.assign(Object.create({ constructor: { status: 'completed' } }), {})
      })
    )
    expect(state.subagents.get('constructor').state).toBe('working')
    expect(state.subagents.get('toString').state).toBe('working')
  })

  it('throttles token-only snapshots per group, never state changes, and delivers the last one', () => {
    let t = 0
    const timers = []
    const tracker = createSubagentTracker(() => t, {
      setTimer: (fn, ms) => (timers.push({ fn, at: t + ms }), timers.length),
      clearTimer: () => {}
    })
    const delivered = []
    tracker.deliverTo((events) => delivered.push(...events))
    const out = []
    tracker.upsert('a', 'g', { description: 'x' }, out) // start: snapshot
    expect(snapshots(out)).toHaveLength(1)
    for (let i = 1; i <= 50; i++) {
      t += 10
      tracker.upsert('a', 'g', { tokens: i }, out)
    }
    // 500 ms of token updates: nothing more yet, one timer pending.
    expect(snapshots(out)).toHaveLength(1)
    expect(out.filter((e) => e.type === 'subagent' && e.phase === 'progress')).toHaveLength(0)
    expect(timers).toHaveLength(1)
    t = timers[0].at
    timers[0].fn()
    expect(snapshots(delivered)).toHaveLength(1)
    expect(snapshots(delivered)[0].agents[0].tokens).toBe(50)
    // A state change is never held back, even inside the window.
    t += 1
    tracker.upsert('a', 'g', { tokens: 60, state: 'completed' }, out)
    expect(lastAgent(out)).toMatchObject({ state: 'completed', tokens: 60 })
    expect(out.at(-2)).toMatchObject({ type: 'subagent', phase: 'end' })
    // Past the window, a token change emits at once.
    const tracker2 = createSubagentTracker(() => t)
    const out2 = []
    tracker2.upsert('b', 'g', {}, out2)
    t += SUBAGENT_THROTTLE_MS
    tracker2.upsert('b', 'g', { tokens: 5 }, out2)
    expect(lastAgent(out2).tokens).toBe(5)
  })

  it('keeps a held-back change for the next event after its window without a timer', () => {
    let t = 0
    const tracker = createSubagentTracker(() => t),
      out = []
    tracker.upsert('a', 'g', {}, out)
    t += 100
    tracker.upsert('a', 'g', { tokens: 7 }, out)
    expect(snapshots(out)).toHaveLength(1)
    t += SUBAGENT_THROTTLE_MS
    tracker.progress('a', { id: 'tool', name: 'Read' }, out)
    expect(lastAgent(out).tokens).toBe(7)
  })
})

describe('bounded lifecycle tracker', () => {
  it('bounds fields, groups and siblings, and disambiguates labels deterministically', () => {
    const tracker = createSubagentTracker(() => 42),
      out = []
    for (let i = 0; i < 70; i++)
      tracker.upsert(`agent-${i}`, 'group', { description: 'a'.repeat(1000) }, out)
    const agents = snapshots(out).at(-1).agents
    expect(agents).toHaveLength(64)
    expect(new Set(agents.map((a) => a.label)).size).toBe(64)
    expect(agents.every((a) => a.label.length <= 120)).toBe(true)
    for (let i = 0; i < 32; i++) tracker.upsert(`new-agent-${i}`, `group-${i}`, {}, out)
    expect(tracker.get('agent-0')).toBeUndefined()
    expect(tracker.upsert('bad\nidentifier', 'group', {}, out)).toBeNull()
  })

  it('does not sum successive token totals or accept non-finite metrics', () => {
    const tracker = createSubagentTracker(() => 1),
      out = []
    tracker.upsert('a', 'g', { tokens: 10 }, out)
    tracker.upsert('a', 'g', { tokens: 12 }, out)
    tracker.upsert('a', 'g', { tokens: Infinity, durationMs: -1 }, out)
    expect(tracker.get('a').tokens).toBe(12)
    expect(subagentTokens({ input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 5 })).toBe(
      17
    )
    expect(subagentTokens({ totalTokens: 7, input_tokens: 10 })).toBe(7)
  })
})
