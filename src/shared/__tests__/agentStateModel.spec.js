import { describe, expect, it } from 'vitest'
import {
  AGENT_SETTLE_MS,
  AGENT_STATE_STALE_MS,
  BACKGROUND_MAX_MS,
  SCREEN_WORK_MS,
  createAgentState,
  publicAgentState,
  reduceAgentState,
  validateAgentState,
  hooksAlone,
  STATUS_PROVIDERS,
  SCREEN_READY_PROVIDERS
} from '../agentStateModel.js'

const identity = { paneId: 'pane-1', provider: 'codex', launchToken: 'launch-token-0123456789' }
function fixture(provider = 'codex') {
  let state = createAgentState({ ...identity, provider, startedAt: 100 })
  let serial = 0
  const event = (name, at, fields = {}) => ({
    v: 1,
    id: `event-${++serial}`,
    ...identity,
    provider,
    sessionId: 'session-1',
    source: name.startsWith('Screen') ? 'screen' : 'hook',
    event: name,
    at,
    ...fields
  })
  const send = (name, at, fields = {}) => {
    state = reduceAgentState(state, event(name, at, fields), at)
    return publicAgentState(state, at)
  }
  return {
    event,
    send,
    get state() {
      return state
    },
    set state(value) {
      state = value
    }
  }
}

describe('main agent lifecycle evidence', () => {
  it('starts unknown and only exposes an idle fallback on an explicit ready prompt', () => {
    const f = fixture()
    expect(publicAgentState(f.state, 100)).toMatchObject({
      state: 'unknown',
      reason: 'unconfirmed',
      confirmed: false,
      hookSeen: false,
      since: 100
    })
    expect(f.send('ScreenReady', 101)).toMatchObject({
      state: 'idle',
      source: 'screen',
      confirmed: true,
      hookSeen: false,
      since: 101
    })
    expect(publicAgentState(f.state, 101)).not.toHaveProperty('turnCompletedAt')
  })

  it('establishes startup without asserting work or a successful completion', () => {
    const f = fixture()
    expect(f.send('SessionStart', 101, { startSource: 'startup' })).toMatchObject({
      state: 'unknown',
      reason: 'startup',
      sessionId: 'session-1',
      hookSeen: true
    })
    expect(f.send('ScreenReady', 102)).toMatchObject({ state: 'idle', reason: 'ready' })
    expect(f.state.turnCompletedAt).toBeNull()
  })

  it('never turns silent hooked work or a retained prompt into idle', () => {
    const f = fixture()
    f.send('SessionStart', 101)
    f.send('UserPromptSubmit', 102)
    const working = f.state
    expect(f.send('ScreenReady', 103).state).toBe('working')
    expect(f.state).toBe(working)
    expect(publicAgentState(f.state, 1602)).toMatchObject({ state: 'working', since: 102 })
    expect(publicAgentState(f.state, 15 * 60 * 1000).state).toBe('working')
  })

  it('a Stop with no event at all for AGENT_SETTLE_MS reads idle (a pane nobody watches never reports its screen)', () => {
    const f = fixture()
    f.send('UserPromptSubmit', 101)
    f.send('Stop', 1000)
    expect(publicAgentState(f.state, 1000 + AGENT_SETTLE_MS)).toMatchObject({ state: 'working', reason: 'settling' })
    expect(publicAgentState(f.state, 1001 + AGENT_SETTLE_MS)).toMatchObject({ state: 'idle', reason: 'ready' })
    // A continuing Stop, or new work after it, keeps it working.
    const g = fixture()
    g.send('UserPromptSubmit', 101)
    g.send('Stop', 1000, { continuing: true })
    expect(publicAgentState(g.state, 1000 + 10 * AGENT_SETTLE_MS).state).toBe('working')
    const h = fixture()
    h.send('UserPromptSubmit', 101)
    h.send('Stop', 1000)
    h.send('PreToolUse', 2000, { toolName: 'Bash' })
    expect(publicAgentState(h.state, 2000 + 10 * AGENT_SETTLE_MS).state).toBe('working')
  })

  it('requires ready evidence after Stop and completes only once', () => {
    const f = fixture()
    f.send('UserPromptSubmit', 101)
    expect(f.send('Stop', 102)).toMatchObject({ state: 'working', reason: 'settling', since: 101 })
    expect(f.state.turnCompletedAt).toBeNull()
    expect(f.send('ScreenBusy', 103)).toMatchObject({ state: 'working', reason: 'settling' })
    expect(f.send('ScreenReady', 104)).toMatchObject({
      state: 'idle',
      turnCompletedAt: 104,
      since: 104
    })
    expect(f.send('ScreenReady', 105)).toMatchObject({
      state: 'idle',
      turnCompletedAt: 104,
      since: 104
    })
    expect(f.send('ScreenBusy', 106)).toMatchObject({ state: 'working', source: 'screen' })
  })

  it('holds work for continuing Stop and cancels candidates on further work', () => {
    const f = fixture()
    f.send('UserPromptSubmit', 101)
    expect(f.send('Stop', 102, { continuing: true })).toMatchObject({
      state: 'working',
      reason: 'continuing'
    })
    expect(f.send('ScreenReady', 103).state).toBe('working')
    f.send('Stop', 104)
    f.send('PreToolUse', 105)
    expect(f.send('ScreenReady', 106)).toMatchObject({ state: 'working', reason: 'processing' })
    expect(f.state.turnCompletedAt).toBeNull()
  })

  it.each(['StopFailure', 'Interrupt'])('preserves %s without declaring success', (event) => {
    const f = fixture('claude')
    f.send('UserPromptSubmit', 101)
    const reason = event === 'StopFailure' ? 'error' : 'interrupted'
    expect(f.send(event, 102)).toMatchObject({ state: 'unknown', reason })
    expect(f.send('ScreenReady', 104)).toMatchObject({ state: 'idle', reason })
    expect(f.state.turnCompletedAt).toBeNull()
  })

  it('revokes idle on a real running footer when only SessionStart is trusted', () => {
    const f = fixture()
    f.send('SessionStart', 101)
    f.send('ScreenReady', 102)
    // The new turn's UserPromptSubmit is missing/untrusted, but the CLI shows
    // its explicit running footer. It must no longer look safe to auto-wake.
    expect(f.send('ScreenBusy', 103)).toMatchObject({
      state: 'working',
      source: 'screen',
      hookSeen: true,
      confirmed: true,
      since: 103
    })
    expect(f.send('ScreenReady', 104).state).toBe('working')
    expect(f.state.turnCompletedAt).toBeNull()
  })

  it('keeps hooked work and a pending Stop through a footer until fresh ready proof', () => {
    const f = fixture()
    f.send('UserPromptSubmit', 101)
    const working = f.state
    f.send('ScreenBusy', 102)
    expect(f.state).toBe(working)
    f.send('Stop', 103)
    const candidate = f.state
    expect(f.send('ScreenBusy', 104)).toMatchObject({ state: 'working', reason: 'settling' })
    expect(f.state).toBe(candidate)
    expect(f.send('ScreenReady', 105)).toMatchObject({ state: 'idle', turnCompletedAt: 105 })
  })

  it('treats resumed running after an error as work without completing that failed turn', () => {
    const f = fixture('claude')
    f.send('UserPromptSubmit', 101)
    f.send('StopFailure', 102)
    expect(f.send('ScreenBusy', 103)).toMatchObject({ state: 'working', source: 'screen' })
    expect(f.send('ScreenReady', 104).state).toBe('working')
    expect(f.state.turnCompletedAt).toBeNull()
  })

  it('treats a failed tool as continued work, not a failed turn', () => {
    const f = fixture('claude')
    f.send('UserPromptSubmit', 101)
    expect(f.send('PostToolUseFailure', 102)).toMatchObject({
      state: 'working',
      reason: 'processing'
    })
    expect(f.send('ScreenReady', 103).state).toBe('working')
  })

  it('does not make compaction an idle or session boundary', () => {
    const f = fixture()
    f.send('UserPromptSubmit', 101, { turnId: 'turn-1' })
    f.send('PreCompact', 102)
    f.send('PostCompact', 103)
    expect(f.send('SessionStart', 104, { startSource: 'compact' })).toMatchObject({
      state: 'working',
      sessionId: 'session-1',
      since: 101
    })
    expect(f.send('ScreenReady', 105).state).toBe('working')
  })

  it('closes a session and ignores late screens and tools', () => {
    const f = fixture()
    f.send('UserPromptSubmit', 101)
    expect(f.send('SessionEnd', 102)).toMatchObject({ state: 'closed', reason: 'ended' })
    const closed = f.state
    f.send('ScreenReady', 103)
    f.send('PostToolUse', 104)
    expect(f.state).toBe(closed)
    expect(publicAgentState(f.state, 10 * AGENT_STATE_STALE_MS).state).toBe('closed')
    expect(f.state.turnCompletedAt).toBeNull()
  })

  it('accepts actual PTY closure as lifecycle evidence without inventing a hook', () => {
    const f = fixture()
    expect(f.send('PtyExit', 101, { source: 'lifecycle' })).toMatchObject({
      state: 'closed',
      source: 'lifecycle',
      hookSeen: false,
      confirmed: true
    })
  })
})

describe('permissions and screen evidence', () => {
  it.each(['AskUserQuestion', 'request_user_input'])(
    'recognizes only the native %s question tool',
    (toolName) => {
      const f = fixture()
      expect(f.send('PreToolUse', 101, { toolName, toolId: 'question-1' })).toMatchObject({
        state: 'approval',
        reason: 'input'
      })
      expect(f.send('PostToolUse', 102, { toolId: 'unrelated' }).state).toBe('approval')
      expect(f.send('PostToolUse', 103, { toolId: 'question-1' }).state).toBe('working')
      expect(f.send('PreToolUse', 104, { toolName: 'plugin_AskUserQuestion' }).state).toBe(
        'working'
      )
      expect(JSON.stringify(f.state)).not.toContain('toolName')
    }
  )

  it('keeps pre-tool execution and automatic review out of human approval', () => {
    const f = fixture()
    f.send('PreToolUse', 101, { toolId: 'tool-1' })
    expect(f.send('PermissionRequest', 102, { toolId: 'tool-1' })).toMatchObject({
      state: 'working',
      reason: 'decision',
      since: 101
    })
    expect(f.send('PostToolUse', 103, { toolId: 'tool-1' })).toMatchObject({
      state: 'working',
      reason: 'processing',
      since: 101
    })
  })

  it('uses positive prompt evidence and ignores redraws or unrelated tools', () => {
    const f = fixture('claude')
    f.send('UserPromptSubmit', 101)
    expect(
      f.send('Notification', 102, { notificationType: 'permission_prompt', toolId: 'a' }).state
    ).toBe('approval')
    expect(f.send('ScreenBusy', 103).state).toBe('approval')
    expect(f.send('PostToolUse', 104, { toolId: 'b' })).toMatchObject({
      state: 'approval',
      since: 102
    })
    expect(f.send('PostToolUse', 105, { toolId: 'a' })).toMatchObject({
      state: 'working',
      since: 105
    })
  })

  it('retains each simultaneous approval until its own tool resolves', () => {
    const f = fixture('claude')
    f.send('UserPromptSubmit', 101, { turnId: 'turn-1' })
    f.send('Notification', 102, {
      notificationType: 'permission_prompt',
      toolId: 'a',
      turnId: 'turn-1'
    })
    f.send('Notification', 103, {
      notificationType: 'permission_prompt',
      toolId: 'b',
      turnId: 'turn-1'
    })
    expect(f.send('PostToolUse', 104, { toolId: 'a', turnId: 'turn-1' }).state).toBe('approval')
    expect(f.send('PostToolUse', 105, { toolId: 'b', turnId: 'different' }).state).toBe('approval')
    expect(f.send('PostToolUse', 106, { toolId: 'b', turnId: 'turn-1' }).state).toBe('working')
  })

  it('never guesses a missing permission tool identity', () => {
    const f = fixture('claude')
    f.send('UserPromptSubmit', 101)
    f.send('Notification', 102, { notificationType: 'permission_prompt' })
    expect(f.send('PostToolUse', 103, { toolId: 'arbitrary' }).state).toBe('approval')
    expect(f.send('ScreenClearApproval', 104)).toMatchObject({
      state: 'working',
      reason: 'processing'
    })
    expect(f.send('ScreenReady', 105).state).toBe('working')
  })

  it('clears resolved screen approval without manufacturing completion', () => {
    const f = fixture()
    f.send('UserPromptSubmit', 101)
    f.send('ScreenApproval', 102)
    expect(f.send('ScreenReady', 103).state).toBe('working')
    f.send('ScreenApproval', 104)
    expect(f.send('Stop', 105).state).toBe('approval')
    expect(f.send('ScreenReady', 106)).toMatchObject({ state: 'idle', turnCompletedAt: 106 })
  })

  it('does not lose a candidate behind an uncorrelated automatic decision', () => {
    const f = fixture()
    f.send('PermissionRequest', 101)
    expect(f.send('Stop', 102)).toMatchObject({ state: 'working', reason: 'settling' })
    expect(f.send('ScreenReady', 103)).toMatchObject({ state: 'idle', turnCompletedAt: 103 })
  })

  it('revokes prior ready eligibility when new permission or compaction work begins', () => {
    const f = fixture()
    f.send('SessionStart', 101)
    f.send('ScreenReady', 102)
    f.send('PermissionRequest', 103)
    expect(f.send('ScreenReady', 104).state).toBe('working')
    f.send('Stop', 105)
    f.send('PreCompact', 106)
    expect(f.send('ScreenReady', 107).state).toBe('working')
    expect(f.state.turnCompletedAt).toBeNull()
  })

  it('does not clear quota on a reset timer, redraw, or tool completion', () => {
    const f = fixture()
    f.send('UserPromptSubmit', 101)
    f.send('ScreenLimit', 102, { reset: 105 })
    expect(f.send('ScreenBusy', 106).state).toBe('limited')
    expect(f.send('PostToolUse', 107).state).toBe('limited')
    expect(publicAgentState(f.state, 200)).toMatchObject({
      state: 'limited',
      reason: 'quota',
      since: 102
    })
    expect(f.send('UserPromptSubmit', 201).state).toBe('working')
  })

  it('preserves bounded reset display text without interpreting it as a timer', () => {
    const f = fixture()
    expect(f.send('ScreenLimit', 101, { reset: '10pm' })).toMatchObject({
      state: 'limited',
      reset: '10pm'
    })
    expect(f.send('ScreenBusy', 102)).toMatchObject({ state: 'limited', reset: '10pm' })
    expect(f.send('ScreenLimit', 103, { reset: '  2026-09-28T22:00:00Z\n' }).reset).toBe(
      '2026-09-28T22:00:00Z'
    )
    f.send('ScreenLimit', 104, { reset: 'x'.repeat(1000) })
    expect(f.state.reset).toHaveLength(160)
    expect(f.send('UserPromptSubmit', 105)).not.toHaveProperty('reset')
  })

  it('bounds unresolved requests without silently losing an older approval', () => {
    const f = fixture('claude')
    for (let i = 0; i < 40; i++) {
      f.send('Notification', 101 + i, {
        notificationType: 'permission_prompt',
        toolId: `tool-${i}`
      })
    }
    expect(f.state.pendingApprovals).toHaveLength(32)
    for (let i = 0; i < 40; i++) f.send('PostToolUse', 201 + i, { toolId: `tool-${i}` })
    expect(f.state.state).toBe('approval')
    expect(f.send('ScreenClearApproval', 300).state).toBe('working')
  })
})

describe('launch, session, actor, and ordering fences', () => {
  it('accepts a delayed UserPromptSubmit behind a newer fallback-ready screen', () => {
    const f = fixture()
    f.send('ScreenReady', 120)
    f.state = reduceAgentState(f.state, f.event('UserPromptSubmit', 110), 500)
    expect(publicAgentState(f.state, 500)).toMatchObject({
      state: 'working',
      hookSeen: true,
      source: 'hook',
      since: 110,
      observedAt: 120
    })
    expect(f.state.lastHookAt).toBe(110)
    expect(f.send('ScreenReady', 501).state).toBe('working')
  })

  it('preserves newer screen approval while accepting a delayed Stop candidate', () => {
    const f = fixture()
    f.send('UserPromptSubmit', 101)
    f.send('ScreenApproval', 120)
    f.state = reduceAgentState(f.state, f.event('Stop', 110), 500)
    expect(publicAgentState(f.state, 500)).toMatchObject({ state: 'approval', since: 120 })
    expect(f.state.stopCandidateAt).toBe(110)
    expect(f.state.turnCompletedAt).toBeNull()
    expect(f.send('ScreenReady', 501)).toMatchObject({ state: 'idle', turnCompletedAt: 501 })
  })

  it('binds delayed SessionStart and UserPromptSubmit without erasing newer approval or quota', () => {
    const f = fixture()
    f.send('ScreenApproval', 120)
    f.state = reduceAgentState(f.state, f.event('SessionStart', 105), 500)
    f.state = reduceAgentState(f.state, f.event('UserPromptSubmit', 110), 500)
    expect(publicAgentState(f.state, 500)).toMatchObject({
      state: 'approval',
      sessionId: 'session-1',
      since: 120,
      hookSeen: true
    })
    f.send('ScreenLimit', 501, { reset: '10pm' })
    f.state = reduceAgentState(f.state, f.event('UserPromptSubmit', 490), 510)
    expect(publicAgentState(f.state, 510)).toMatchObject({
      state: 'limited',
      reset: '10pm',
      since: 501
    })
  })

  it('does not resurrect an older permission after positive screen resolution', () => {
    const f = fixture('claude')
    f.send('ScreenApproval', 120)
    f.send('ScreenReady', 130)
    f.state = reduceAgentState(
      f.state,
      f.event('Notification', 110, { notificationType: 'permission_prompt' }),
      500
    )
    expect(f.state.state).toBe('working')
    expect(f.state.pendingApprovals).toHaveLength(0)
  })

  it('never retroactively confirms Stop with a screen observed before its ingestion', () => {
    const f = fixture()
    f.send('ScreenReady', 120)
    f.state = reduceAgentState(f.state, f.event('Stop', 110), 500)
    expect(publicAgentState(f.state, 500)).toMatchObject({ state: 'working', reason: 'settling' })
    expect(f.state.turnCompletedAt).toBeNull()
    expect(reduceAgentState(f.state, f.event('ScreenReady', 109), 500)).toBe(f.state)
    expect(f.send('ScreenReady', 501).turnCompletedAt).toBe(501)
  })

  it.each([
    { paneId: 'other-pane' },
    { launchToken: 'other-launch' },
    { provider: 'claude' },
    { sessionId: 'other-session' },
    { at: 99 },
    { at: 103 },
    { v: 2 },
    { event: 'UnknownHook' },
    { source: 'arbitrary' },
    { id: '' }
  ])('rejects mismatched or invalid events %j', (fields) => {
    const f = fixture()
    f.send('UserPromptSubmit', 101)
    const state = f.state
    expect(reduceAgentState(state, f.event('Stop', 102, fields), 102)).toBe(state)
  })

  it('rejects out-of-order events and duplicates without updating freshness or since', () => {
    const f = fixture()
    const event = f.event('UserPromptSubmit', 110)
    f.state = reduceAgentState(f.state, event, 110)
    const state = f.state
    expect(reduceAgentState(state, { ...event, at: 112 }, 112)).toBe(state)
    expect(reduceAgentState(state, f.event('Stop', 109), 113)).toBe(state)
    expect(f.send('PreToolUse', 114)).toMatchObject({
      state: 'working',
      since: 110,
      observedAt: 114
    })
  })

  it('does not let an older turn finishing late invalidate a newer Stop candidate', () => {
    const f = fixture()
    f.send('UserPromptSubmit', 101, { turnId: 'old-turn' })
    f.send('UserPromptSubmit', 102, { turnId: 'new-turn' })
    f.send('Stop', 103, { turnId: 'new-turn' })
    const candidate = f.state
    f.send('PostToolUse', 104, { turnId: 'old-turn' })
    expect(f.state).toBe(candidate)
    expect(f.send('ScreenReady', 105)).toMatchObject({ state: 'idle', turnCompletedAt: 105 })
  })

  it('ignores unrelated notifications without refreshing working evidence', () => {
    const f = fixture('claude')
    f.send('UserPromptSubmit', 101)
    const working = f.state
    f.send('Notification', 102, { notificationType: 'idle_prompt' })
    expect(f.state).toBe(working)
  })

  it('permits explicit clear/resume but rejects an inherited nested startup', () => {
    const f = fixture()
    f.send('UserPromptSubmit', 101)
    const active = f.state
    f.send('SessionStart', 102, { sessionId: 'nested', startSource: 'startup' })
    f.send('SessionStart', 103, { sessionId: 'different', startSource: 'compact' })
    expect(f.state).toBe(active)
    expect(
      f.send('SessionStart', 104, { sessionId: 'session-2', startSource: 'clear' })
    ).toMatchObject({ sessionId: 'session-2', state: 'unknown', reason: 'startup' })
    const newer = f.state
    f.send('Stop', 105)
    expect(f.state).toBe(newer)
    expect(f.send('SessionStart', 106, { startSource: 'resume' }).sessionId).toBe('session-1')
  })

  it('never lets an orphan child establish or replace the lead session', () => {
    const f = fixture()
    const initial = f.state
    f.send('SessionStart', 101, { agentId: 'child-1' })
    expect(f.state).toBe(initial)
    f.send('UserPromptSubmit', 102)
    const active = f.state
    f.send('SessionStart', 103, { agentId: 'child-1', sessionId: 'foreign' })
    expect(f.state).toBe(active)
  })

  it('binds a child session only after its lead-announced SubagentStart', () => {
    const f = fixture('claude')
    f.send('UserPromptSubmit', 101)
    f.send('SubagentStart', 102, { agentId: 'child-1' })
    f.send('SessionStart', 103, { agentId: 'child-1', sessionId: 'child-session' })
    f.send('PreToolUse', 104, {
      agentId: 'child-1',
      sessionId: 'child-session',
      toolName: 'AskUserQuestion',
      toolId: 'q'
    })
    expect(publicAgentState(f.state, 104)).toMatchObject({
      state: 'working',
      sessionId: 'session-1',
      observedAt: 101,
      children: [
        { agentId: 'child-1', sessionId: 'child-session', state: 'approval', reason: 'input' }
      ]
    })
    const state = f.state
    f.send('PostToolUse', 105, {
      agentId: 'child-1',
      sessionId: 'other-child-session',
      toolId: 'q'
    })
    expect(f.state).toBe(state)
    f.send('PostToolUse', 106, { agentId: 'child-1', sessionId: 'child-session', toolId: 'q' })
    expect(f.state.children[0].state).toBe('working')
    expect(f.state.sessionId).toBe('session-1')
  })

  it('keeps child work, Stop, errors and approvals separate from the lead and siblings', () => {
    const f = fixture()
    f.send('UserPromptSubmit', 101)
    f.send('SubagentStart', 102, { agentId: 'child-1' })
    f.send('Notification', 103, {
      agentId: 'child-1',
      notificationType: 'permission_prompt',
      toolId: 'a'
    })
    f.send('PostToolUse', 104, { agentId: 'child-2', toolId: 'a' })
    f.send('SubagentStop', 105, { agentId: 'child-2' })
    expect(publicAgentState(f.state, 105)).toMatchObject({
      state: 'working',
      observedAt: 101,
      since: 101,
      children: [
        { agentId: 'child-1', state: 'approval' },
        { agentId: 'child-2', state: 'working', reason: 'settling' }
      ]
    })
    f.send('StopFailure', 106, { agentId: 'child-2' })
    expect(f.state.state).toBe('working')
    expect(f.state.children[0].state).toBe('approval')
    expect(f.state.turnCompletedAt).toBeNull()
  })

  it('orders each actor independently without a child blocking newer lead evidence', () => {
    const f = fixture()
    f.send('UserPromptSubmit', 101)
    f.send('PreToolUse', 110, { agentId: 'child-1' })
    const rootStop = f.event('Stop', 105)
    f.state = reduceAgentState(f.state, rootStop, 115)
    expect(f.state.reason).toBe('settling')
    const child = f.state.children[0]
    f.state = reduceAgentState(f.state, f.event('SubagentStop', 109, { agentId: 'child-1' }), 115)
    expect(f.state.children[0]).toBe(child)
  })

  it('bounds child storage and marks incomplete coverage without changing the lead', () => {
    const f = fixture()
    f.send('UserPromptSubmit', 101)
    for (let i = 0; i < 40; i++) f.send('PreToolUse', 102 + i, { agentId: `child-${i}` })
    expect(f.state.children).toHaveLength(32)
    expect(f.state.childrenTruncated).toBe(true)
    expect(f.state.observedAt).toBe(101)
    expect(f.state.state).toBe('working')
  })
})

describe('freshness, recovery, and private data', () => {
  it('exposes unknown after 30 minutes without evidence even when the screen redraws', () => {
    const f = fixture()
    f.send('UserPromptSubmit', 101)
    f.send('PreToolUse', 103)
    f.send('ScreenBusy', 102 + AGENT_STATE_STALE_MS)
    expect(publicAgentState(f.state, 104 + AGENT_STATE_STALE_MS)).toMatchObject({
      state: 'unknown',
      reason: 'stale',
      stale: true,
      hookSeen: true,
      since: 101
    })
  })

  it('reconfirms stale state with an actually visible approval or ready prompt', () => {
    const f = fixture()
    f.send('UserPromptSubmit', 101)
    const late = 102 + AGENT_STATE_STALE_MS
    expect(f.send('ScreenApproval', late)).toMatchObject({ state: 'approval', stale: false })
    f.send('Stop', late + 1)
    f.state = { ...f.state, confirmed: false }
    expect(f.send('ScreenReady', late + AGENT_STATE_STALE_MS + 2)).toMatchObject({
      state: 'idle',
      stale: false,
      confirmed: true
    })
    expect(f.state.turnCompletedAt).toBeNull()
  })

  it('does not treat restored snapshots or child observations as fresh main evidence', () => {
    const f = fixture()
    f.send('UserPromptSubmit', 101)
    f.send('PreToolUse', 102, { agentId: 'child-1' })
    f.state = { ...JSON.parse(JSON.stringify(f.state)), confirmed: false }
    expect(validateAgentState(f.state)).toBe(true)
    expect(publicAgentState(f.state, 103)).toMatchObject({
      state: 'unknown',
      reason: 'unconfirmed',
      children: [{ state: 'unknown' }]
    })
    f.send('PostToolUse', 104, { agentId: 'child-1' })
    expect(publicAgentState(f.state, 104).confirmed).toBe(false)
    expect(f.send('PreToolUse', 105)).toMatchObject({ state: 'working', confirmed: true })
  })

  it('does not turn a recovered Stop or completed timestamp into a fresh completion', () => {
    const f = fixture()
    f.send('UserPromptSubmit', 101)
    f.send('Stop', 102)
    f.state = { ...f.state, confirmed: false }
    expect(f.send('ScreenReady', 103)).toMatchObject({ state: 'idle', confirmed: true })
    expect(f.state.turnCompletedAt).toBeNull()
    f.send('UserPromptSubmit', 104)
    f.send('Stop', 105)
    f.send('ScreenReady', 106)
    expect(f.state.turnCompletedAt).toBe(106)
    f.state = { ...f.state, confirmed: false }
    f.send('ScreenReady', 107)
    expect(f.state.turnCompletedAt).toBeNull()
  })

  it('retains no prompts, arguments, transcript paths, errors or arbitrary extra fields', () => {
    const f = fixture()
    f.send('UserPromptSubmit', 101, {
      prompt: 'private user text',
      tool_input: { credential: 'secret-token' },
      transcript_path: 'private-path',
      error_details: 'sensitive error',
      extra: 'private field'
    })
    const serialized = JSON.stringify(f.state)
    for (const value of ['private', 'secret-token', 'sensitive'])
      expect(serialized).not.toContain(value)
    expect(validateAgentState(f.state)).toBe(true)
    expect(validateAgentState({ ...f.state, prompt: 'private' })).toBe(false)
    expect(validateAgentState({ ...f.state, children: [null] })).toBe(false)
    expect(validateAgentState({ ...f.state, pendingApprovals: [{}] })).toBe(false)
    expect(validateAgentState({ ...f.state, observedAt: 'yesterday' })).toBe(false)
    expect(validateAgentState(null)).toBe(false)
  })

  it('is immutable, serializable, and bounded over a long stream of same-state events', () => {
    const f = fixture()
    f.send('UserPromptSubmit', 101)
    const prior = JSON.stringify(f.state)
    const saved = f.state
    for (let i = 0; i < 300; i++) f.send('PreToolUse', 102 + i)
    expect(JSON.stringify(saved)).toBe(prior)
    expect(f.state.seenIds).toHaveLength(256)
    expect(f.state.since).toBe(101)
    expect(validateAgentState(JSON.parse(JSON.stringify(f.state)))).toBe(true)
  })
})

describe('agents whose hooks alone report their status (hooksAlone)', () => {
  it.each(['gemini', 'copilot', 'kimi', 'opencode', 'cursor', 'droid', 'grok', 'antigravity', 'openclaude', 'commandcode', 'amp', 'pi'])(
    '%s: idle when its session opens, working on a prompt, idle again at its turn end',
    (provider) => {
      expect(hooksAlone(provider)).toBe(true)
      const f = fixture(provider)
      expect(f.send('SessionStart', 101, { startSource: 'startup' })).toMatchObject({ state: 'idle', reason: 'startup', confirmed: true })
      expect(f.send('UserPromptSubmit', 102)).toMatchObject({ state: 'working', reason: 'processing' })
      expect(f.send('PostToolUse', 103)).toMatchObject({ state: 'working' })
      const done = f.send('Stop', 104, { continuing: false })
      expect(done).toMatchObject({ state: 'idle', reason: 'ready', turnCompletedAt: 104 })
    }
  )
  it('keeps Claude Code and Codex on their screen confirmation', () => {
    expect(hooksAlone('claude')).toBe(false)
    expect(hooksAlone('codex')).toBe(false)
    expect(STATUS_PROVIDERS).toEqual(expect.arrayContaining(SCREEN_READY_PROVIDERS))
    const f = fixture('claude')
    f.send('SessionStart', 101)
    f.send('UserPromptSubmit', 102)
    expect(f.send('Stop', 103, { continuing: false })).toMatchObject({ state: 'working', reason: 'settling' })
  })
  it('a continuing Stop (team messages delivered) stays working', () => {
    const f = fixture('gemini')
    f.send('UserPromptSubmit', 101)
    expect(f.send('Stop', 102, { continuing: true })).toMatchObject({ state: 'working', reason: 'continuing' })
  })
  it('an interrupted or failed turn is idle, with its reason', () => {
    const f = fixture('kimi')
    f.send('UserPromptSubmit', 101)
    expect(f.send('Interrupt', 102)).toMatchObject({ state: 'idle', reason: 'interrupted' })
    f.send('UserPromptSubmit', 103)
    expect(f.send('StopFailure', 104)).toMatchObject({ state: 'idle', reason: 'error' })
  })
  it('a permission notice waits for the user; the agent moving on answers it', () => {
    const f = fixture('copilot')
    f.send('UserPromptSubmit', 101)
    expect(f.send('Notification', 102, { notificationType: 'permission_prompt' })).toMatchObject({ state: 'approval' })
    expect(f.send('PostToolUse', 103)).toMatchObject({ state: 'working', reason: 'processing' })
    expect(f.send('Stop', 104, { continuing: false })).toMatchObject({ state: 'idle' })
  })
  it('a question tool waits for the answer, then work goes on', () => {
    const f = fixture('pi')
    f.send('UserPromptSubmit', 101)
    expect(f.send('PreToolUse', 102, { toolName: 'AskUserQuestion' })).toMatchObject({ state: 'approval', reason: 'input' })
    expect(f.send('PostToolUse', 103)).toMatchObject({ state: 'working' })
  })
  it('an elicitation is resolved by its own result (OpenCode permissions)', () => {
    const f = fixture('opencode')
    f.send('UserPromptSubmit', 101)
    expect(f.send('Elicitation', 102, { toolId: 'perm-1' })).toMatchObject({ state: 'approval' })
    expect(f.send('ElicitationResult', 103, { toolId: 'perm-1' })).toMatchObject({ state: 'working' })
  })
  it('a screen approval is cleared when the screen no longer shows it, and a stale busy footer cannot revive work', () => {
    const f = fixture('gemini')
    f.send('UserPromptSubmit', 101)
    expect(f.send('ScreenApproval', 102)).toMatchObject({ state: 'approval' })
    expect(f.send('ScreenClearApproval', 103)).toMatchObject({ state: 'working' })
    expect(f.send('Stop', 104, { continuing: false })).toMatchObject({ state: 'idle' })
    expect(f.send('ScreenBusy', 105)).toMatchObject({ state: 'idle' })
  })
  it('sub-agents (Copilot, Pi) are children of the pane, never its own state', () => {
    const f = fixture('copilot')
    f.send('SessionStart', 101)
    f.send('UserPromptSubmit', 102)
    f.send('SubagentStart', 103, { agentId: 'explore' })
    f.send('PreToolUse', 104, { agentId: 'explore' })
    let s = publicAgentState(f.state, 104)
    expect(s.state).toBe('working')
    expect(s.children).toEqual([expect.objectContaining({ agentId: 'explore', state: 'working' })])
    s = f.send('SubagentStop', 105, { agentId: 'explore', continuing: false })
    expect(s.children[0]).toMatchObject({ state: 'idle' })
    expect(s.state).toBe('working')
  })
})

describe('work that ends without a new event (finished agents never stay working)', () => {
  // A Claude Code pane whose screen never reported ready (its prompt went
  // unread): each Stop left it "working"/settling; the next turn went on
  // from there, so it read working since its first turn, for hours.
  it('a settled Stop really ends the turn: the next one is new work, not the old one going on', () => {
    const f = fixture('claude')
    f.send('UserPromptSubmit', 1000)
    f.send('Stop', 5000)
    const next = 5001 + AGENT_SETTLE_MS
    expect(f.send('UserPromptSubmit', next)).toMatchObject({ state: 'working', reason: 'processing', since: next })
    expect(f.send('Stop', next + 10)).toMatchObject({ state: 'working', reason: 'settling', since: next })
    // A turn started by the agent itself (a background task's end): no
    // prompt hook, only its tools.
    const tool = next + 20 + AGENT_SETTLE_MS
    expect(f.send('PreToolUse', tool, { toolName: 'Bash', toolId: 'tool-1' })).toMatchObject({
      state: 'working',
      reason: 'processing',
      since: tool
    })
    // Within the settle time, it is the same turn going on.
    const g = fixture('claude')
    g.send('UserPromptSubmit', 1000)
    g.send('Stop', 5000)
    expect(g.send('PreToolUse', 5000 + AGENT_SETTLE_MS, { toolName: 'Bash' })).toMatchObject({ state: 'working', since: 1000 })
  })

  it('a settled Stop still completes on a later ready screen, and a running footer after it shows work again', () => {
    const f = fixture('claude')
    f.send('UserPromptSubmit', 1000)
    f.send('Stop', 5000)
    const later = 5000 + 3 * AGENT_SETTLE_MS
    expect(f.send('ScreenReady', later)).toMatchObject({ state: 'idle', reason: 'ready', turnCompletedAt: later })
    const g = fixture('claude')
    g.send('UserPromptSubmit', 1000)
    g.send('Stop', 5000)
    const busy = 5001 + AGENT_SETTLE_MS
    expect(g.send('ScreenBusy', busy)).toMatchObject({ state: 'working', source: 'screen', since: busy })
    // ...only while that footer is seen.
    expect(publicAgentState(g.state, busy + SCREEN_WORK_MS + 1)).toMatchObject({ state: 'idle', reason: 'ready' })
  })

  it('a settled Stop is idle, since the Stop, with no later event', () => {
    const f = fixture('claude')
    f.send('UserPromptSubmit', 1000)
    f.send('Stop', 5000)
    expect(publicAgentState(f.state, 5000 + AGENT_SETTLE_MS)).toMatchObject({ state: 'working', reason: 'settling' })
    // Only the clock moves (the pane is in another workspace: no screen).
    expect(publicAgentState(f.state, 5001 + AGENT_SETTLE_MS)).toMatchObject({ state: 'idle', reason: 'ready', since: 5000 })
    expect(publicAgentState(f.state, 5000 + 25 * 60 * 1000)).toMatchObject({ state: 'idle', reason: 'ready', since: 5000 })
  })

  it('a stale running footer cannot keep a finished hooked turn working', () => {
    const f = fixture('claude')
    f.send('UserPromptSubmit', 1000)
    f.send('Stop', 2000)
    f.send('ScreenReady', 3000)
    // An old "esc to interrupt" line still in view on a redraw.
    expect(f.send('ScreenBusy', 4000)).toMatchObject({ state: 'working', reason: 'processing', source: 'screen' })
    expect(publicAgentState(f.state, 4000 + SCREEN_WORK_MS)).toMatchObject({ state: 'working' })
    expect(publicAgentState(f.state, 4001 + SCREEN_WORK_MS)).toMatchObject({ state: 'idle', reason: 'ready', since: 4000 })
  })

  it('screen-only work stays working while its running footer is still seen', () => {
    const f = fixture('claude')
    f.send('UserPromptSubmit', 1000)
    f.send('Stop', 2000)
    f.send('ScreenReady', 3000)
    f.send('ScreenBusy', 4000)
    // Seen again within the refresh interval: not recorded (no write per frame).
    const before = f.state
    f.send('ScreenBusy', 5000)
    expect(f.state.lastScreenAt).toBe(before.lastScreenAt)
    let at = 4000
    for (let i = 0; i < 30; i++) {
      at += 6000
      f.send('ScreenBusy', at)
    }
    expect(publicAgentState(f.state, at + SCREEN_WORK_MS - 1)).toMatchObject({ state: 'working', reason: 'processing' })
    // A hook takes over as usual.
    f.send('Stop', at + 1000)
    expect(publicAgentState(f.state, at + 1001)).toMatchObject({ state: 'working', reason: 'settling' })
  })

  it('an interrupted Claude turn (no hook runs) ends when its screen says so', () => {
    const f = fixture('claude')
    f.send('UserPromptSubmit', 1000)
    f.send('PreToolUse', 2000, { toolId: 'tool-1' })
    // A ready prompt alone cannot end hooked work.
    expect(f.send('ScreenReady', 3000)).toMatchObject({ state: 'working' })
    expect(f.send('ScreenInterrupted', 4000)).toMatchObject({ state: 'idle', reason: 'interrupted' })
    expect(f.state.turnCompletedAt).toBeNull()
    // A hook of that turn delivered late does not bring it back.
    expect(f.send('PostToolUseFailure', 3500, { toolId: 'tool-1' })).toMatchObject({ state: 'idle', reason: 'interrupted' })
    // A new prompt works again.
    expect(f.send('UserPromptSubmit', 5000)).toMatchObject({ state: 'working', reason: 'processing' })
  })

  it('an old "Interrupted" line after a finished turn is an ordinary ready prompt', () => {
    const f = fixture('claude')
    f.send('UserPromptSubmit', 1000)
    f.send('Stop', 2000)
    expect(f.send('ScreenInterrupted', 3000)).toMatchObject({ state: 'idle', reason: 'ready', turnCompletedAt: 3000 })
  })
})

describe('background work after the turn (monitoring)', () => {
  // Claude Code: its Stop lists the background work left running; the end of
  // that work starts a follow-up turn whose Stop lists what is left.
  const started = () => {
    const f = fixture('claude')
    f.send('SessionStart', 101, { startSource: 'startup' })
    f.send('UserPromptSubmit', 102)
    f.send('PreToolUse', 103, { toolName: 'Bash' })
    f.send('PostToolUse', 104, { toolName: 'Bash' })
    return f
  }

  it('start background task, turn end: monitoring; task end: idle again', () => {
    const f = started()
    expect(f.send('Stop', 200, { background: ['shell-1'] })).toMatchObject({ state: 'working', reason: 'settling' })
    expect(publicAgentState(f.state, 200)).not.toHaveProperty('monitoring')
    expect(f.send('ScreenReady', 201)).toMatchObject({ state: 'idle', monitoring: true, backgroundTasks: 1, turnCompletedAt: 201 })
    // The shell ends: Claude's follow-up turn, then its Stop lists nothing.
    expect(f.send('UserPromptSubmit', 300)).toMatchObject({ state: 'working' })
    expect(publicAgentState(f.state, 300)).not.toHaveProperty('monitoring')
    f.send('Stop', 301, { background: [] })
    const idle = f.send('ScreenReady', 302)
    expect(idle).toMatchObject({ state: 'idle' })
    expect(idle).not.toHaveProperty('monitoring')
  })

  it('a Stop nobody watches settles into monitoring too', () => {
    const f = started()
    f.send('Stop', 200, { background: ['shell-1', 'agent-1'] })
    expect(publicAgentState(f.state, 201 + AGENT_SETTLE_MS)).toMatchObject({ state: 'idle', monitoring: true, backgroundTasks: 2 })
  })

  it('resumed work shows working, then monitoring again at its end', () => {
    const f = started()
    f.send('Stop', 200, { background: ['shell-1'] })
    f.send('ScreenReady', 201)
    const working = f.send('UserPromptSubmit', 300)
    expect(working.state).toBe('working')
    expect(working).not.toHaveProperty('monitoring')
    f.send('Stop', 400, { background: ['shell-1'] })
    expect(f.send('ScreenReady', 401)).toMatchObject({ state: 'idle', monitoring: true })
  })

  it('a background sub-agent ends with its own SubagentStop', () => {
    const f = started()
    f.send('SubagentStart', 150, { agentId: 'agent-1' })
    f.send('Stop', 200, { background: ['agent-1', 'shell-1'] })
    f.send('ScreenReady', 201)
    expect(f.send('SubagentStop', 250, { agentId: 'agent-1' })).toMatchObject({ monitoring: true, backgroundTasks: 1 })
    expect(f.state.background).toEqual(['shell-1'])
  })

  it('never shows monitoring past its bound, a closed pane, a new session or an older CLI', () => {
    const f = started()
    f.send('Stop', 200, { background: ['shell-1'] })
    f.send('ScreenReady', 201)
    // A task never seen ending stops counting.
    f.send('ScreenReady', 200 + BACKGROUND_MAX_MS)
    expect(publicAgentState(f.state, 200 + BACKGROUND_MAX_MS)).toMatchObject({ monitoring: true })
    expect(f.send('ScreenReady', 201 + BACKGROUND_MAX_MS)).not.toHaveProperty('monitoring')
    // The session ends.
    const g = started()
    g.send('Stop', 200, { background: ['shell-1'] })
    g.send('ScreenReady', 201)
    g.send('SessionEnd', 300)
    expect(g.state.background).toEqual([])
    // The process exits.
    const h = started()
    h.send('Stop', 200, { background: ['shell-1'] })
    h.send('ScreenReady', 201)
    h.state = reduceAgentState(h.state, { ...h.event('PtyExit', 300), source: 'lifecycle' }, 300)
    expect(h.state.background).toEqual([])
    expect(publicAgentState(h.state, 300)).not.toHaveProperty('monitoring')
    // /clear: another conversation.
    const c = started()
    c.send('Stop', 200, { background: ['shell-1'] })
    c.send('ScreenReady', 201)
    c.send('SessionStart', 300, { startSource: 'clear', sessionId: 'session-2' })
    expect(c.state.background).toEqual([])
    // A Stop without the list (an older Claude Code) keeps what was known;
    // none was known: no monitoring.
    const o = started()
    o.send('Stop', 200)
    expect(o.send('ScreenReady', 201)).not.toHaveProperty('monitoring')
    // A stale pane is unknown, never monitoring.
    const s = started()
    s.send('Stop', 200, { background: ['shell-1'] })
    s.send('ScreenReady', 201)
    expect(publicAgentState(s.state, 202 + AGENT_STATE_STALE_MS)).toMatchObject({ state: 'unknown' })
    expect(publicAgentState(s.state, 202 + AGENT_STATE_STALE_MS)).not.toHaveProperty('monitoring')
  })

  it('rejects a list on anything but a lead Stop, and a malformed one', () => {
    const f = started()
    const before = f.state
    expect(reduceAgentState(before, f.event('PostToolUse', 150, { background: ['x'] }), 150)).toBe(before)
    expect(reduceAgentState(before, f.event('Stop', 150, { background: 'x' }), 150)).toBe(before)
    expect(reduceAgentState(before, f.event('Stop', 150, { background: Array(33).fill('x') }), 150)).toBe(before)
  })

  it('reads a snapshot saved before background tracking', () => {
    const f = started()
    const { background, backgroundAt, ...old } = f.state
    expect(background).toEqual([])
    expect(backgroundAt).toBeNull()
    expect(validateAgentState(old)).toBe(true)
    f.state = old
    f.send('Stop', 200, { background: ['shell-1'] })
    expect(f.send('ScreenReady', 201)).toMatchObject({ monitoring: true })
    expect(validateAgentState({ ...old, background: ['a', 7] })).toBe(false)
  })
})
