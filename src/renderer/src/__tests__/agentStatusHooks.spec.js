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
  createAgentActivityMonitor,
  managedAgentStatus,
  paneAgentState,
  paneMonitoring,
  monitoring,
  turnEndedSince
} from '../agentStatus'
import {
  createAgentState,
  reduceAgentState,
  publicAgentState
} from '../../../shared/agentStateModel'
import { Terminal } from '@xterm/headless'

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

  it('an answered approval clears once the agent works again (its running footer), not on an approval footer', async () => {
    hook('UserPromptSubmit')
    hook('PermissionRequest', { toolId: 'tool-1' })
    screen = { ...screen, approval: true, screen: 'Do you want to proceed?\nEsc to cancel' }
    monitor.output()
    await vi.advanceTimersByTimeAsync(1400)
    expect(approvals[node.id]).toBe(true)
    // An approval's own "Esc to cancel" is no proof it was answered.
    screen = { screen: 'Esc to cancel', ready: false, busy: true, approval: false, limit: null }
    monitor.output()
    await vi.advanceTimersByTimeAsync(1400)
    expect(approvals[node.id]).toBe(true)
    screen = { screen: '✻ Working… (esc to interrupt)', ready: false, busy: true, approval: false, limit: null }
    monitor.output()
    await vi.advanceTimersByTimeAsync(1400)
    expect(approvals[node.id]).toBeFalsy()
    expect(state.state).toBe('working')
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

  it('a settled turn shows idle in the pane and the sidebar with no new event', async () => {
    hook('UserPromptSubmit')
    hook('Stop')
    const stopAt = Date.now()
    // The pane is not looked at: no screen observation, no hook. Main
    // publishes its snapshot on each scan; only the clock moves.
    for (let i = 0; i < 50; i++) {
      await vi.advanceTimersByTimeAsync(500)
      publish()
    }
    expect(agentStates[node.id]).toMatchObject({ state: 'idle', reason: 'ready', since: stopAt })
    expect(agentStatus[node.id]).toBe('idle')
    expect(callbacks.onStatus).toHaveBeenLastCalledWith('idle')
    expect(paneAgentState(node)).toBe('ready')
    expect(turnEndedSince(node.id, node.agentLaunchToken)).toBe(stopAt)
  })

  it('a turn that ends with background work still running shows monitoring, then ready when it ends', async () => {
    hook('UserPromptSubmit')
    hook('Stop', { background: ['shell-1'] })
    screen = { ...screen, ready: true, screen: 'Started it\n❯ ' }
    monitor.output()
    await vi.advanceTimersByTimeAsync(1400)
    expect(agentStatus[node.id]).toBe('idle')
    expect(monitoring[node.id]).toBe(1)
    expect(paneMonitoring(node)).toBe(true)
    expect(paneAgentState(node)).toBe('monitoring')
    // Monitoring outranks the finished turn waiting for you and sub-agents.
    expect(paneAgentState(node, { childrenRunning: 1 })).toBe('monitoring')
    // The shell ends: Claude's follow-up turn works, then lists nothing.
    hook('UserPromptSubmit')
    expect(paneAgentState(node)).toBe('working')
    expect(monitoring[node.id]).toBeUndefined()
    hook('Stop', { background: [] })
    monitor.output()
    await vi.advanceTimersByTimeAsync(1400)
    expect(agentStatus[node.id]).toBe('idle')
    expect(paneAgentState(node)).toBe('ready')
    // An approval still comes first.
    hook('UserPromptSubmit')
    hook('Stop', { background: ['shell-2'] })
    monitor.output()
    await vi.advanceTimersByTimeAsync(1400)
    setApproval(node.id, true)
    expect(paneAgentState(node)).toBe('approval')
    setApproval(node.id, false)
    expect(paneAgentState(node)).toBe('monitoring')
    // The pane's status goes away: so does its monitoring.
    applyAgentStates({})
    expect(monitoring[node.id]).toBeUndefined()
  })

  it('a Stop is confirmed by Claude waiting at its input, a draft typed in it or not', async () => {
    hook('UserPromptSubmit')
    hook('Stop')
    screen = { ...screen, ready: false, waiting: true, screen: 'Done.\n> next que' }
    monitor.output()
    await vi.advanceTimersByTimeAsync(1400)
    expect(agentStates[node.id]).toMatchObject({ state: 'idle', reason: 'ready' })
    expect(agentStatus[node.id]).toBe('idle')
    expect(callbacks.onCompleted).toHaveBeenCalledTimes(1)
  })

  it('an interrupted Claude turn (no Stop hook) is idle once its screen says so', async () => {
    hook('UserPromptSubmit')
    hook('PreToolUse', { toolId: 'tool-1' })
    screen = { ...screen, ready: true, interrupted: true }
    monitor.output()
    await vi.advanceTimersByTimeAsync(1400)
    expect(agentStates[node.id]).toMatchObject({ state: 'idle', reason: 'interrupted' })
    expect(agentStatus[node.id]).toBe('idle')
    expect(paneAgentState(node)).toBe('ready')
    expect(callbacks.onCompleted).not.toHaveBeenCalled()
  })

  it('a stale running footer after the turn ended does not keep the pane working', async () => {
    hook('UserPromptSubmit')
    hook('Stop')
    screen = { ...screen, ready: true }
    monitor.output()
    await vi.advanceTimersByTimeAsync(1400)
    expect(agentStatus[node.id]).toBe('idle')
    screen = { ...screen, ready: false, busy: true }
    monitor.output({ redraw: true })
    await vi.advanceTimersByTimeAsync(1400)
    expect(agentStatus[node.id]).toBe('busy')
    // The footer is not seen again: after a minute the work is over.
    for (let i = 0; i < 130; i++) {
      await vi.advanceTimersByTimeAsync(500)
      publish()
    }
    expect(agentStatus[node.id]).toBe('idle')
    expect(paneAgentState(node)).toBe('ready')
  })

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
  it("recognizes Claude's interruption above a ready prompt", () => {
    const observed = agentScreenObservation(
      terminal('❯ ', 2),
      'claude',
      '> fix it\n  ⎿  Interrupted · What should Claude do instead?\n\n❯ '
    )
    expect(observed).toMatchObject({ ready: true, interrupted: true })
    expect(agentScreenObservation(terminal('❯ ', 2), 'claude', 'Answer\n❯ ').interrupted).toBe(false)
    expect(
      agentScreenObservation(terminal('❯ ', 2), 'claude', '  ⎿  Interrupted by user\nWorking… esc to interrupt\n❯ ')
        .interrupted
    ).toBe(false)
  })
  it('finds the interruption above a tall status line, and Codex\'s too', () => {
    const status = Array.from({ length: 9 }, (_, i) => `status line ${i}`).join('\n')
    expect(
      agentScreenObservation(terminal('❯ ', 2), 'claude', `  ⎿  Interrupted · What should Claude do instead?\n\n❯ \n${status}`).interrupted
    ).toBe(true)
    expect(
      agentScreenObservation(terminal('› ', 2), 'codex', '■ Conversation interrupted - tell the model what to do differently.\n\n› ').interrupted
    ).toBe(true)
    expect(agentScreenObservation(terminal('› ', 2), 'codex', 'Done.\n\n› ').interrupted).toBe(false)
  })
  // Claude Code 2.1 in a Tessel pane (cmd under ConPTY, no WT_SESSION): its
  // prompt is the ASCII ">" (figures' fallback), its dim text is grey, and
  // it keeps the cursor in its input. From a live pane's screen.
  const GREY = '\x1b[38;2;153;153;153m'
  const RULE_ROW = `\x1b[38;2;136;136;136m${'─'.repeat(50)}\x1b[0m`
  const STATUS = '  \x1b[38;2;255;107;128m⏵⏵ bypass permissions on \x1b[38;2;153;153;153m(shift+tab to cycle)\x1b[0m'
  async function claudeScreen(rows, [row, col]) {
    const term = new Terminal({ cols: 60, rows: rows.length + 2, allowProposedApi: true })
    await new Promise((resolve) => term.write(`${rows.join('\r\n')}\x1b[${row + 1};${col + 1}H`, resolve))
    const buffer = term.buffer.active
    const text = []
    for (let y = 0; y < term.rows; y++) {
      const line = buffer.getLine(y).translateToString(true)
      if (line.trim()) text.push(line)
    }
    return agentScreenObservation(term, 'claude', text.join('\n'))
  }
  it("reads Claude Code's ASCII prompt under its input rule, empty or with its grey placeholder", async () => {
    const box = (input) => ['● Done.', '', RULE_ROW, input, RULE_ROW, '', STATUS]
    expect(await claudeScreen(box('> '), [3, 2])).toMatchObject({ ready: true, waiting: true, busy: false })
    expect(await claudeScreen(box('> '), [3, 1])).toMatchObject({ ready: true, waiting: true })
    expect(await claudeScreen(box(`> ${GREY}Try "fix lint errors"\x1b[0m`), [3, 2])).toMatchObject({ ready: true, waiting: true })
    // A draft typed in it: waiting at its input, but not an empty prompt.
    expect(await claudeScreen(box('> fix the tests'), [3, 15])).toMatchObject({ ready: false, waiting: true })
  })
  it('reads an interrupted Claude Code turn with text left in its input', async () => {
    const observed = await claudeScreen(
      [
        `  ${GREY}Searched for 2 patterns, read 1 file`,
        '  ⎿  Interrupted · What should Claude do instead?\x1b[0m',
        RULE_ROW,
        '> Interrupted',
        RULE_ROW,
        '',
        STATUS
      ],
      [3, 13]
    )
    expect(observed).toMatchObject({ waiting: true, interrupted: true })
  })
  it('a ">" elsewhere is not Claude\'s input: quoted text, a shell prompt, or the cursor before it', async () => {
    expect(await claudeScreen(['Answer:', '> quoted line', '', STATUS], [1, 13])).toMatchObject({ ready: false, waiting: false })
    expect(await claudeScreen(['C:\\Tessel>'], [0, 10])).toMatchObject({ ready: false, waiting: false })
    expect(await claudeScreen(['● Done.', RULE_ROW, '> ', RULE_ROW], [2, 0])).toMatchObject({ waiting: false })
  })
  it("sees Claude's running footer above its input under a tall status line", async () => {
    const status = Array.from({ length: 9 }, (_, i) => `  status line ${i}`)
    const observed = await claudeScreen(
      ['✻ Thinking… (12s · esc to interrupt)', '', RULE_ROW, '> ', RULE_ROW, ...status],
      [3, 2]
    )
    expect(observed).toMatchObject({ busy: true, ready: false, waiting: false })
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

describe('agents whose hooks alone report their status (Gemini, Droid...)', () => {
  let monitor, node, state, screen, callbacks, sequence
  const launch = 'launch-hooks-1'
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(200000)
    for (const id of Object.keys(agentStatus)) clearAgentStatus(id)
    for (const id of Object.keys(agentStates)) clearAgentStatus(id)
    node = { id: 'pane-g', agentId: 'gemini', agentLaunchToken: launch }
    state = createAgentState({ paneId: node.id, provider: 'gemini', launchToken: launch, startedAt: Date.now() })
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
      report: (event) => apply('screen', event.event, event),
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
    applyAgentStates({ [node.id]: publicAgentState(state, Date.now()) })
    monitor.stateChanged(getAgentState(node.id, node.agentLaunchToken))
  }
  function apply(source, event, extra = {}) {
    const { event: _name, paneId: _pane, launchToken: _token, ...fields } = extra
    state = reduceAgentState(
      state,
      { v: 1, id: `ev-${++sequence}`, paneId: node.id, provider: 'gemini', launchToken: launch, sessionId: 'gem-1', source, event, at: Date.now(), ...fields },
      Date.now()
    )
    publish()
  }

  it('keeps the screen estimate until its first hook, then follows its hooks', async () => {
    expect(managedAgentStatus(node)).toBe(false)
    monitor.output()
    expect(agentStatus[node.id]).toBe('busy')
    await vi.advanceTimersByTimeAsync(1500)
    expect(agentStatus[node.id]).toBe('idle')
    apply('hook', 'SessionStart', { startSource: 'startup' })
    expect(managedAgentStatus(node)).toBe(true)
    expect(agentStateKnown(node.id, launch)).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    apply('hook', 'UserPromptSubmit')
    expect(agentStatus[node.id]).toBe('busy')
    expect(callbacks.onWorking).toHaveBeenLastCalledWith({ estimated: false })
    await vi.advanceTimersByTimeAsync(1000)
    apply('hook', 'Stop', { continuing: false })
    expect(agentStatus[node.id]).toBe('idle')
    expect(callbacks.onCompleted).toHaveBeenLastCalledWith(expect.objectContaining({ estimated: false }))
  })

  it('an approval its screen showed ends when the screen no longer shows it', async () => {
    apply('hook', 'UserPromptSubmit')
    screen = { ...screen, approval: true }
    monitor.output()
    await vi.advanceTimersByTimeAsync(1500)
    expect(getAgentState(node.id, launch).state).toBe('approval')
    expect(approvals[node.id]).toBe(true)
    screen = { ...screen, approval: false }
    await vi.advanceTimersByTimeAsync(1100)
    monitor.output()
    await vi.advanceTimersByTimeAsync(1500)
    expect(getAgentState(node.id, launch).state).toBe('working')
    expect(approvals[node.id]).toBeUndefined()
  })

  it('an agent without status hooks keeps its screen estimate', () => {
    node = { id: 'pane-a', agentId: 'aider', agentLaunchToken: 'x' }
    expect(managedAgentStatus(node)).toBe(false)
  })
})
