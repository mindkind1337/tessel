import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  agentStatus,
  agentStates,
  approvals,
  limits,
  clearAgentStatus,
  applyAgentStates,
  agentStateKnown,
  getAgentState,
  setAgentStatus,
  setApproval,
  setLimit,
  agentScreenObservation,
  createAgentActivityMonitor
} from '../agentStatus'
import {
  createAgentState,
  reduceAgentState,
  publicAgentState
} from '../../../shared/agentStateModel'

describe('terminal activity and authoritative agent events', () => {
  let monitor, node, state, screen, callbacks, sequence
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(100000)
    for (const id of Object.keys(agentStatus)) clearAgentStatus(id)
    for (const id of Object.keys(agentStates)) clearAgentStatus(id)
    node = { id: 'pane-1', agentId: 'claude', agentLaunchToken: 'launch-1' }
    state = createAgentState({
      paneId: node.id,
      provider: 'claude',
      launchToken: 'launch-1',
      startedAt: Date.now()
    })
    screen = { screen: 'Working', ready: false, busy: false, approval: false, limit: null }
    sequence = 0
    callbacks = {
      onStatus: vi.fn((value) => setAgentStatus(node.id, value, node.agentLaunchToken)),
      onWorking: vi.fn(),
      onCompleted: vi.fn(),
      onApproval: vi.fn((value) => setApproval(node.id, value)),
      onLimit: vi.fn((value) => setLimit(node.id, value))
    }
    monitor = createAgentActivityMonitor({
      getNode: () => node,
      readScreen: () => screen,
      report: (event) => applyEvent('screen', event.event, event),
      ...callbacks
    })
    publish()
  })
  afterEach(() => {
    monitor.dispose()
    for (const id of Object.keys(agentStatus)) clearAgentStatus(id)
    vi.useRealTimers()
  })
  function publish() {
    const entry = publicAgentState(state, Date.now())
    applyAgentStates({ [node.id]: entry })
    monitor.stateChanged(getAgentState(node.id, node.agentLaunchToken))
  }
  function applyEvent(source, event, extra = {}) {
    state = reduceAgentState(
      state,
      {
        v: 1,
        id: `event-${++sequence}`,
        paneId: node.id,
        provider: 'claude',
        launchToken: 'launch-1',
        sessionId: 'session-1',
        source,
        event,
        at: Date.now(),
        ...extra
      },
      Date.now()
    )
    publish()
  }
  const hook = (event, extra) => applyEvent('hook', event, extra)

  it('keeps a silent hooked tool working and ignores a legacy idle write', async () => {
    hook('UserPromptSubmit')
    hook('PreToolUse', { toolId: 'tool-1' })
    monitor.output()
    await vi.advanceTimersByTimeAsync(20000)
    expect(agentStatus[node.id]).toBe('busy')
    expect(agentStateKnown(node.id, 'launch-1')).toBe(true)
    setAgentStatus(node.id, 'idle', 'launch-1')
    expect(agentStatus[node.id]).toBe('busy')
    expect(callbacks.onCompleted).not.toHaveBeenCalled()
    expect(callbacks.onWorking).toHaveBeenCalledTimes(1)
  })

  it('does not finish known work just because an input prompt is visible', async () => {
    hook('UserPromptSubmit')
    screen = { ...screen, ready: true }
    monitor.output()
    await vi.advanceTimersByTimeAsync(1400)
    expect(agentStatus[node.id]).toBe('busy')
    expect(callbacks.onCompleted).not.toHaveBeenCalled()
  })

  it('does not postpone readiness forever when other panes publish unchanged snapshots', async () => {
    hook('UserPromptSubmit')
    hook('Stop')
    screen = { ...screen, ready: true }
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(250)
      publish()
    }
    expect(agentStatus[node.id]).toBe('idle')
    expect(callbacks.onCompleted).toHaveBeenCalledTimes(1)
  })

  it('treats Stop as a candidate until actual prompt readiness is observed', async () => {
    hook('UserPromptSubmit')
    hook('Stop')
    await vi.advanceTimersByTimeAsync(5000)
    expect(agentStates[node.id].reason).toBe('settling')
    expect(agentStatus[node.id]).toBe('busy')
    expect(callbacks.onCompleted).not.toHaveBeenCalled()
    screen = { ...screen, ready: true, screen: 'TASK_COMPLETE\n❯ ' }
    monitor.output()
    await vi.advanceTimersByTimeAsync(1400)
    expect(agentStatus[node.id]).toBe('idle')
    expect(callbacks.onCompleted).toHaveBeenCalledTimes(1)
    expect(callbacks.onCompleted.mock.calls[0][0]).toMatchObject({
      estimated: false,
      screen: 'TASK_COMPLETE\n❯ '
    })
    const completedAt = callbacks.onCompleted.mock.calls[0][0].at
    for (let i = 0; i < 4; i++) {
      monitor.output({ redraw: true })
      await vi.advanceTimersByTimeAsync(2000)
    }
    expect(callbacks.onCompleted).toHaveBeenCalledTimes(1)
    expect(agentStates[node.id].turnCompletedAt).toBe(completedAt)
  })

  it.each(['Interrupt', 'StopFailure'])(
    'a ready prompt after %s is not a completed answer',
    async (event) => {
      hook('UserPromptSubmit')
      hook(event)
      screen = { ...screen, ready: true }
      monitor.output()
      await vi.advanceTimersByTimeAsync(1400)
      expect(agentStatus[node.id]).toBe('idle')
      expect(callbacks.onCompleted).not.toHaveBeenCalled()
    }
  )

  it('keeps a Stop continued by another hook working even with a visible prompt', async () => {
    hook('UserPromptSubmit')
    hook('Stop', { continuing: true })
    screen = { ...screen, ready: true }
    monitor.output()
    await vi.advanceTimersByTimeAsync(3000)
    expect(agentStatus[node.id]).toBe('busy')
    expect(callbacks.onCompleted).not.toHaveBeenCalled()
  })

  it('only exposes human approval when screen or notification confirms it', async () => {
    hook('UserPromptSubmit')
    hook('PermissionRequest', { toolId: 'tool-1' })
    expect(approvals[node.id]).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1400)
    expect(agentStatus[node.id]).toBe('busy')
    screen = { ...screen, approval: true }
    monitor.output()
    await vi.advanceTimersByTimeAsync(1400)
    expect(approvals[node.id]).toBe(true)
    expect(agentStates[node.id].state).toBe('approval')
    screen = { ...screen, approval: false, busy: true }
    monitor.output()
    await vi.advanceTimersByTimeAsync(1400)
    expect(approvals[node.id]).toBe(true)
    screen = { ...screen, busy: false, ready: true }
    monitor.output()
    await vi.advanceTimersByTimeAsync(1400)
    expect(approvals[node.id]).toBeUndefined()
    expect(agentStatus[node.id]).toBe('busy')
    expect(callbacks.onCompleted).not.toHaveBeenCalled()
  })

  it('gives quota priority over ready/approval and never treats its reset as completion', async () => {
    hook('UserPromptSubmit')
    hook('Stop')
    screen = { ...screen, ready: true, approval: true, limit: { reset: 'in 1 minute' } }
    monitor.output()
    await vi.advanceTimersByTimeAsync(61000)
    expect(agentStates[node.id].state).toBe('limited')
    expect(limits[node.id].reset).toBe('in 1 minute')
    expect(callbacks.onCompleted).not.toHaveBeenCalled()
  })

  it('exposes missing/stale execution state as unknown; estimated readiness is not known', async () => {
    expect(agentStatus[node.id]).toBe('unknown')
    monitor.output()
    await vi.advanceTimersByTimeAsync(1400)
    expect(agentStatus[node.id]).toBe('unknown')
    screen = { ...screen, ready: true }
    monitor.output()
    await vi.advanceTimersByTimeAsync(1400)
    expect(agentStatus[node.id]).toBe('idle')
    expect(agentStateKnown(node.id, 'launch-1')).toBe(false)
    hook('UserPromptSubmit')
    await vi.advanceTimersByTimeAsync(31 * 60000)
    publish()
    expect(agentStatus[node.id]).toBe('unknown')
    expect(agentStateKnown(node.id, 'launch-1')).toBe(false)
    expect(callbacks.onCompleted).not.toHaveBeenCalled()
  })

  it('rejects an old execution in a reused pane and never replays an old completion', async () => {
    hook('UserPromptSubmit')
    node = { ...node, agentLaunchToken: 'new-launch' }
    monitor.stateChanged(agentStates[node.id])
    expect(getAgentState(node.id, 'new-launch')).toBeNull()
    expect(agentStatus[node.id]).toBe('unknown')
    monitor.stateChanged({
      ...agentStates[node.id],
      launchToken: 'new-launch',
      state: 'idle',
      turnCompletedAt: Date.now()
    })
    expect(callbacks.onCompleted).not.toHaveBeenCalled()
  })

  it.each(['gemini', 'claude'])(
    'preserves the existing output estimate for %s without a managed token',
    async (provider) => {
      clearAgentStatus(node.id)
      node = { id: 'pane-1', agentId: provider }
      monitor.output()
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(1000)
        monitor.output()
      }
      expect(agentStatus[node.id]).toBe('busy')
      await vi.advanceTimersByTimeAsync(1400)
      expect(agentStatus[node.id]).toBe('idle')
      expect(callbacks.onCompleted).toHaveBeenCalledTimes(1)
      expect(callbacks.onCompleted.mock.calls[0][0].estimated).toBe(true)
      expect(callbacks.onWorking).toHaveBeenCalledTimes(1)
    }
  )

  it('cancels screen/completion timers when the terminal closes', async () => {
    hook('UserPromptSubmit')
    hook('Stop')
    screen = { ...screen, ready: true }
    monitor.dispose()
    await vi.advanceTimersByTimeAsync(5000)
    expect(callbacks.onCompleted).not.toHaveBeenCalled()
  })
})

describe('actual terminal prompt evidence', () => {
  function terminal(text, cursorX, dim = false) {
    return {
      buffer: {
        active: {
          baseY: 0,
          cursorY: 0,
          cursorX,
          getLine: () => ({
            translateToString: () => text,
            getCell: (x) => ({ getChars: () => text[x] || '', isDim: () => dim })
          })
        }
      }
    }
  }
  it('recognizes an empty Claude input and a dim Codex placeholder at the cursor', () => {
    expect(agentScreenObservation(terminal('❯ ', 2), 'claude', 'Answer\n❯ ').ready).toBe(true)
    expect(
      agentScreenObservation(terminal('› Ask anything', 2, true), 'codex', 'Answer\n› Ask anything')
        .ready
    ).toBe(true)
  })
  it('rejects typed text, transcript prompts and a visible prompt below a running footer', () => {
    expect(agentScreenObservation(terminal('❯ draft', 7), 'claude', '❯ draft').ready).toBe(false)
    expect(agentScreenObservation(terminal('Example: ❯ ', 11), 'claude', 'Example: ❯ ').ready).toBe(
      false
    )
    expect(
      agentScreenObservation(terminal('› Ask anything', 2, false), 'codex', '› Ask anything').ready
    ).toBe(false)
    expect(
      agentScreenObservation(terminal('❯ ', 2), 'claude', 'Working… esc to interrupt\n❯ ').ready
    ).toBe(false)
  })
  it('keeps approval and quota evidence ahead of prompt readiness', () => {
    expect(
      agentScreenObservation(terminal('❯ ', 2), 'claude', 'Would you like to run this?\n❯ ')
    ).toMatchObject({ ready: false, approval: true })
    expect(
      agentScreenObservation(
        terminal('› ', 2),
        'codex',
        "You've hit your usage limit. Try again at 5 PM.\n› "
      )
    ).toMatchObject({ ready: false, limit: { reset: '5 PM' } })
  })
})
