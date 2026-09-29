// Tessel's chat events through the adapter, then the ported reducer and
// projections, as the chat UI will read them.
import { describe, it, expect } from 'vitest'
import { createJournalAdapter } from '../journalAdapter'
import { reduceStructuredAgentSession, EMPTY_STRUCTURED_AGENT_SESSION } from '../../shared/structured-agent-session-reducer.js'
import { projectStructuredAgentSessionMessages, pendingStructuredSessionPrompts } from '../../structured-agent-session-message-projection.js'
import { activeStructuredAgentSessionTurnId } from '../../shared/structured-agent-session-live-turn.js'
import { agentJournalSubmissionKey } from '../../shared/agent-session-journal-item-key.js'

function run(events) {
  let t = 1000
  const adapter = createJournalAdapter({ now: () => (t += 10) })
  let state = reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, { type: 'event', event: adapter.snapshotEvent() }, t)
  const states = []
  for (const ev of events) {
    const out = adapter.apply(ev)
    if (out) state = reduceStructuredAgentSession(state, { type: 'event', event: out }, t)
    states.push(state)
  }
  return { adapter, state, states }
}
const messages = (state) => projectStructuredAgentSessionMessages(state.items, [], state.submissions)
const text = (m) => m.blocks.filter((b) => b.type === 'text').map((b) => b.text).join('')

describe('journal adapter', () => {
  it('a simple turn: the user message, a running turn, the streamed answer, then the turn ends', () => {
    const { state, states } = run([
      { type: 'status', state: 'idle', agent: 'claude', model: 'haiku', sessionId: 's1' },
      { type: 'user', id: 'u1', text: 'Reply OK', origin: 'user', status: 'sent' },
      { type: 'status', state: 'working' },
      { type: 'userStatus', id: 'u1', status: 'accepted' },
      { type: 'assistantDelta', messageId: 'm1', text: 'O' },
      { type: 'assistantDelta', messageId: 'm1', text: 'K' },
      { type: 'assistant', messageId: 'm1', text: 'OK' },
      { type: 'turnEnd', status: 'completed', durationMs: 1200, usage: { input_tokens: 10, output_tokens: 2 } },
      { type: 'status', state: 'idle' }
    ])
    // While streaming, a turn is open.
    expect(activeStructuredAgentSessionTurnId(states[4].items)).toBeTruthy()
    expect(activeStructuredAgentSessionTurnId(state.items)).toBeNull()
    const ms = messages(state)
    expect(ms.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(text(ms[0])).toBe('Reply OK')
    expect(text(ms[1])).toBe('OK')
    // The user item is keyed like the reference's outbox bubble (no duplicate).
    expect(state.items[0].itemId).toBe(agentJournalSubmissionKey('u1'))
    expect(state.submissions.find((s) => s.clientMessageId === 'u1').dispatchState).toBe('accepted')
    // The turn row comes after the user message and before the answer.
    const seq = Object.fromEntries(state.items.map((i) => [i.body.kind + ':' + (i.body.role || ''), i.sequence]))
    expect(seq['message:user']).toBeLessThan(seq['turn:'])
    expect(seq['turn:']).toBeLessThan(seq['message:assistant'])
    const turn = state.items.find((i) => i.body.kind === 'turn').body
    expect(turn).toMatchObject({ state: 'completed', outcome: 'success', durationMs: 1200 })
    expect(turn.contextUsage.used).toMatchObject({ kind: 'estimate', usage: { inputTokens: 10, outputTokens: 2 } })
  })

  it('a tool call and its result fold into the assistant row; a failure is marked', () => {
    const { state } = run([
      { type: 'user', id: 'u1', text: 'list', status: 'accepted' },
      { type: 'assistant', messageId: 'm1', text: 'Listing.' },
      { type: 'tool', id: 't1', name: 'Bash', input: { command: 'ls' }, status: 'running' },
      { type: 'toolResult', id: 't1', isError: false, text: 'a\nb' },
      { type: 'tool', id: 't2', name: 'Read', input: '{"file_path":"x"}', status: 'running' },
      { type: 'toolResult', id: 't2', isError: true, text: 'nope' },
      { type: 'turnEnd', status: 'completed' }
    ])
    const tool1 = state.items.find((i) => i.itemId === 'tool:t1').body
    expect(tool1).toMatchObject({ kind: 'tool-call', name: 'Bash', state: 'completed', input: { command: 'ls' } })
    expect(tool1.output).toMatchObject({ head: 'a\nb', truncated: false })
    expect(state.items.find((i) => i.itemId === 'tool:t2').body).toMatchObject({ state: 'failed', input: { file_path: 'x' } })
    const blocks = messages(state).flatMap((m) => m.blocks.map((b) => b.type))
    expect(blocks).toContain('tool-call')
    expect(blocks).toContain('tool-result')
  })

  it('an approval is a pending prompt, then a resolved one; Codex without acceptForSession offers no session option', () => {
    const { state, states } = run([
      { type: 'user', id: 'u1', text: 'go', status: 'accepted' },
      { type: 'approval', requestId: 'r1', toolName: 'Bash', displayName: 'Bash', input: { command: 'rm x' }, detail: 'rm x', hidden: 0, choices: ['accept', 'decline'], status: 'pending' },
      { type: 'status', state: 'approval' },
      { type: 'approvalStatus', requestId: 'r1', status: 'denied' }
    ])
    const pendingNow = pendingStructuredSessionPrompts(states[2].items)
    expect(pendingNow.length).toBe(1)
    const item = state.items.find((i) => i.itemId === 'approval:r1').body
    expect(item.options.map((o) => o.id)).toEqual(['allow', 'deny'])
    expect(item.tessel).toMatchObject({ requestId: 'r1', toolName: 'Bash', choices: ['accept', 'decline'] })
    expect(item.resolution).toMatchObject({ state: 'resolved', selectedOptionId: 'deny' })
    expect(pendingStructuredSessionPrompts(state.items).length).toBe(0)
  })

  it("a teammate's message is labelled; a failed one stays visible (unknown, never rejected)", () => {
    const { state } = run([
      { type: 'user', id: 'team-1', text: 'Team messages…', origin: 'team', from: '#2 Claude', status: 'queued' },
      { type: 'teamFailed', ids: ['team-1'] },
      { type: 'user', id: 'u2', text: 'mine', status: 'sent' },
      { type: 'userStatus', id: 'u2', status: 'failed' }
    ])
    const team = state.items.find((i) => i.itemId === agentJournalSubmissionKey('team-1')).body
    expect(team).toMatchObject({ sentAs: 'team', from: '#2 Claude' })
    expect(state.submissions.find((s) => s.clientMessageId === 'team-1').dispatchState).toBe('unknown')
    expect(state.submissions.find((s) => s.clientMessageId === 'u2').dispatchState).toBe('unknown')
    expect(messages(state).map((m) => text(m))).toEqual(['Team messages…', 'mine'])
  })

  it('an interrupted or failed turn, a crash and notices', () => {
    const { state } = run([
      { type: 'user', id: 'u1', text: 'a', status: 'accepted' },
      { type: 'turnEnd', status: 'failed', error: 'content filter' },
      { type: 'user', id: 'u2', text: 'b', status: 'accepted' },
      { type: 'status', state: 'crashed' },
      { type: 'notice', kind: 'warning', text: 'careful' }
    ])
    const turns = state.items.filter((i) => i.body.kind === 'turn').map((i) => i.body)
    expect(turns.map((t) => [t.state, t.outcome])).toEqual([
      ['completed', 'failure'],
      ['interrupted', 'cancellation']
    ])
    const statuses = state.items.filter((i) => i.body.kind === 'status').map((i) => i.body)
    expect(statuses).toEqual([
      { kind: 'status', text: 'content filter', tone: 'error' },
      { kind: 'status', text: 'careful', tone: 'warning' }
    ])
    expect(activeStructuredAgentSessionTurnId(state.items)).toBeNull()
  })

  it('revisions only go up; a replayed history gives the same items as live events', () => {
    const events = [
      { type: 'user', id: 'u1', text: 'x', status: 'accepted' },
      { type: 'assistantDelta', messageId: 'm1', text: 'a' },
      { type: 'assistant', messageId: 'm1', text: 'ab' },
      { type: 'turnEnd', status: 'completed' }
    ]
    const live = run(events).adapter.items()
    const replayed = createJournalAdapter({ now: () => 0 })
    replayed.replay(events)
    expect(replayed.items().map((i) => [i.itemId, i.body.kind, i.sequence])).toEqual(live.map((i) => [i.itemId, i.body.kind, i.sequence]))
    expect(live.find((i) => i.itemId === 'm1').revision).toBe(2)
  })

  it('session facts outside the journal: agent, model, session, rate limits', () => {
    const { adapter } = run([
      { type: 'status', state: 'idle', agent: 'codex', model: 'gpt-6', sessionId: 'thread-1' },
      { type: 'rateLimit', fiveHour: { utilization: 0.4 }, sevenDay: null }
    ])
    expect(adapter.meta).toMatchObject({ agent: 'codex', model: 'gpt-6', sessionId: 'thread-1', status: 'idle', rateLimit: { fiveHour: { utilization: 0.4 } } })
  })
})
