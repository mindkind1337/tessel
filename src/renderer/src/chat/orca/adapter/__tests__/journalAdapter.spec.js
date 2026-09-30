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

  it("tool paths inside the chat's folder are shown relative; outside it, whole", () => {
    const adapter = createJournalAdapter({ now: () => 1, cwd: 'C:\\proj' })
    adapter.replay([
      { type: 'tool', id: 't1', name: 'Read', input: { file_path: 'C:\\proj\\src\\x.js' }, status: 'running' },
      { type: 'tool', id: 't2', name: 'Read', input: { file_path: 'C:\\other\\y.js' }, status: 'running' },
      { type: 'tool', id: 't3', name: 'Edit', input: { changes: [{ path: 'c:/PROJ/a.md' }, { path: 'D:\\z' }] }, status: 'running' }
    ])
    const input = (id) => adapter.items().find((i) => i.itemId === `tool:${id}`).body.input
    expect(input('t1').file_path).toBe('src/x.js')
    expect(input('t2').file_path).toBe('C:\\other\\y.js')
    expect(input('t3').changes.map((c) => c.path)).toEqual(['a.md', 'D:\\z'])
  })

  it("a team message shows without its id header (that header is for the agent's reply_to)", () => {
    const { state } = run([
      { type: 'user', id: 't9', origin: 'team', from: '#2 Claude Code', status: 'accepted', text: '(message db16-pane-12-383991, reply to 0225-pane-6-336010) Merci, fusionné.' },
      { type: 'user', id: 't10', origin: 'team', from: '#1 Codex', status: 'accepted', text: '(message aa11-pane-1-1) Bien reçu.' },
      { type: 'user', id: 'u9', status: 'accepted', text: '(message x) typed by the user: kept as it is' }
    ])
    const texts = JSON.stringify(messages(state))
    expect(texts).toContain('Merci, fusionné.')
    expect(texts).toContain('Bien reçu.')
    expect(texts).not.toContain('db16-pane-12-383991')
    expect(texts).not.toContain('aa11-pane-1-1')
    expect(texts).toContain('(message x) typed by the user')
  })

  it('a queued message is listed until the engine takes it', () => {
    const adapter = createJournalAdapter({ now: () => 1 })
    adapter.replay([
      { type: 'user', id: 'u1', text: 'next', status: 'queued' },
      { type: 'user', id: 't1', text: 'team', origin: 'team', status: 'queued' }
    ])
    expect(adapter.meta.queuedIds).toEqual(['u1', 't1'])
    adapter.apply({ type: 'userStatus', id: 'u1', status: 'accepted' })
    adapter.apply({ type: 'teamAccepted', ids: ['t1'] })
    expect(adapter.meta.queuedIds).toEqual([])
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
    // The projection keeps the label and the sender for the row.
    expect(messages(state)[0]).toMatchObject({ sentAs: 'team', from: '#2 Claude' })
    expect(messages(state)[1].sentAs).toBeUndefined()
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

  it('a stopped process leaves nothing open: running tools stop, pending questions are cancelled; its error stays', () => {
    const { state, adapter } = run([
      { type: 'user', id: 'u1', text: 'go', status: 'accepted' },
      { type: 'tool', id: 't1', name: 'Bash', input: { command: 'sleep 9' }, status: 'running' },
      { type: 'approval', requestId: 'r1', toolName: 'Bash', input: { command: 'rm x' }, status: 'pending' },
      { type: 'status', state: 'crashed', error: 'exit 1' },
      { type: 'status', state: 'crashed' }
    ])
    expect(state.items.find((i) => i.itemId === 'tool:t1').body.state).toBe('interrupted')
    expect(state.items.find((i) => i.itemId === 'approval:r1').body.resolution.state).toBe('cancelled')
    expect(pendingStructuredSessionPrompts(state.items).length).toBe(0)
    expect(adapter.meta).toMatchObject({ status: 'crashed', error: 'exit 1' })
    adapter.apply({ type: 'status', state: 'idle' })
    expect(adapter.meta.error).toBe('')
  })

  it('rows keep their order when events share a millisecond; a replayed event keeps its journal time', () => {
    const adapter = createJournalAdapter({ now: () => 5000 })
    adapter.replay([
      { type: 'user', id: 'u1', text: 'a', status: 'accepted', at: 1000 },
      { type: 'assistant', messageId: 'm1', text: 'b', at: 1000 },
      { type: 'notice', kind: 'info', text: 'c', at: 900 }
    ])
    const times = adapter.items().map((i) => i.observedAt)
    expect(times[0]).toBe(1000)
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThan(times[i - 1])
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

  it("subagents: the engine's roster is one row revised in place; children's rows carry their agent", () => {
    const { state, states } = run([
      { type: 'user', id: 'u1', text: 'go', status: 'accepted' },
      { type: 'subagents', groupId: 'root-turn', agents: [{ id: 'child', label: 'Inspect fixtures', state: 'working', startedAt: 1000 }] },
      { type: 'assistantDelta', messageId: 'a', text: 'Child', agentId: 'child', parentToolUseId: 'spawn-tool' },
      { type: 'tool', id: 't1', name: 'Read', input: { file_path: 'x' }, status: 'running', parentToolUseId: 'spawn-tool' },
      { type: 'subagents', groupId: 'root-turn', agents: [{ id: 'child', label: 'Inspect fixtures', state: 'completed', tokens: 25, startedAt: 1000, settledAt: 1500 }] }
    ])
    const rows = state.items.filter((i) => i.itemId === 'subagents:root-turn')
    expect(rows.length).toBe(1)
    expect(rows[0].agentId).toBeUndefined()
    expect(rows[0].body.blocks[0]).toEqual({ type: 'text', text: 'Ran 1 subagent' })
    expect(rows[0].body.blocks[1]).toEqual({ type: 'subagent-group', groupId: 'root-turn', agents: [{ id: 'child', label: 'Inspect fixtures', state: 'completed', tokens: 25, startedAt: 1000, settledAt: 1500 }] })
    expect(states[1].items.find((i) => i.itemId === 'subagents:root-turn').body.blocks[0].text).toBe('Kicked off 1 subagent')
    // Keyed by agent and message id: never the parent's message 'a'.
    expect(state.items.find((i) => i.itemId === 'child:child:a')).toMatchObject({ agentId: 'child', providerParentRef: 'spawn-tool' })
    // Older events without agentId: the provider reference stands in.
    expect(state.items.find((i) => i.itemId === 'tool:t1')).toMatchObject({ agentId: 'spawn-tool', providerParentRef: 'spawn-tool' })
  })

  it("a background child's text after the turn ended does not reopen the main agent's turn", () => {
    const { state } = run([
      { type: 'user', id: 'u1', text: 'go', status: 'accepted' },
      { type: 'turnEnd', status: 'completed' },
      { type: 'assistantDelta', messageId: 'm', text: 'still going', agentId: 'bg', parentToolUseId: 'spawn' },
      { type: 'tool', id: 'bg:t', name: 'Bash', input: { command: 'ls' }, status: 'running', agentId: 'bg', parentToolUseId: 'spawn' }
    ])
    expect(activeStructuredAgentSessionTurnId(state.items)).toBeNull()
    expect(state.items.filter((i) => i.body.kind === 'turn').length).toBe(1)
  })

  it('an empty roster removes its row (never "Ran 0")', () => {
    const { state } = run([
      { type: 'subagents', groupId: 'g', agents: [{ id: 'c', label: 'x', state: 'working' }] },
      { type: 'subagents', groupId: 'g', agents: [] }
    ])
    expect(state.items.find((i) => i.itemId === 'subagents:g')).toBeUndefined()
  })

  it('session facts outside the journal: agent, model, session, rate limits', () => {
    const { adapter } = run([
      { type: 'status', state: 'idle', agent: 'codex', model: 'gpt-6', sessionId: 'thread-1' },
      { type: 'rateLimit', fiveHour: { utilization: 0.4 }, sevenDay: null }
    ])
    expect(adapter.meta).toMatchObject({ agent: 'codex', model: 'gpt-6', sessionId: 'thread-1', status: 'idle', rateLimit: { fiveHour: { utilization: 0.4 } } })
  })
})

describe('journal adapter: questions', () => {
  const ask = { type: 'question', requestId: 'question_1', status: 'pending', questions: [{ id: 'q0', header: 'Format', question: 'Which format?', multiSelect: false, options: [{ id: 'o0', label: 'Short' }, { id: 'o1', label: 'Long', description: 'All of it' }], freeTextQuestionId: 'q0' }] }
  it('a question is a pending prompt until answered or cancelled; a stopped process cancels it', () => {
    const { state, states } = run([{ type: 'user', id: 'u1', text: 'go', status: 'accepted' }, ask, { type: 'questionStatus', requestId: 'question_1', status: 'answered', answers: [{ questionId: 'q0', optionIds: ['o1'] }] }])
    expect(pendingStructuredSessionPrompts(states[1].items).map((i) => i.body.kind)).toEqual(['question'])
    const body = states[1].items.find((i) => i.itemId === 'question:question_1').body
    expect(body).toMatchObject({ question: 'Which format?', questions: [{ id: 'q0', freeTextQuestionId: 'q0', options: [{ id: 'o0' }, { id: 'o1', description: 'All of it' }] }], tessel: { requestId: 'question_1' } })
    expect(pendingStructuredSessionPrompts(state.items)).toEqual([])
    expect(state.items.find((i) => i.itemId === 'question:question_1').body.resolution.state).toBe('resolved')
    const stopped = run([{ type: 'user', id: 'u1', text: 'go', status: 'accepted' }, ask, { type: 'status', state: 'crashed' }])
    expect(stopped.state.items.find((i) => i.itemId === 'question:question_1').body.resolution.state).toBe('cancelled')
  })
})

describe('journal adapter: an older page', () => {
  it('goes before everything held, in its order, with earlier sequences and times, ids of its own', () => {
    const adapter = createJournalAdapter({ now: () => 9000 })
    adapter.replay([
      { type: 'notice', kind: 'info', text: 'Earlier conversation', imported: true, at: 5000 },
      { type: 'user', id: 'hist-u9', text: 'recent', status: 'accepted', imported: true, at: 5000 },
      { type: 'assistant', messageId: 'hist-a9', text: 'recent answer', imported: true, at: 5100 },
      { type: 'turnEnd', status: 'completed', imported: true, at: 5200 }
    ])
    let state = reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, { type: 'event', event: adapter.snapshotEvent() }, 0)
    const held = state.items.map((i) => i.itemId)
    const page = adapter.olderPage([
      { type: 'user', id: 'hist-u1', text: 'old one', status: 'accepted', imported: true, at: 1000 },
      { type: 'assistant', messageId: 'hist-a1', text: 'old answer', imported: true, at: 1100 },
      { type: 'turnEnd', status: 'completed', imported: true, at: 1200 },
      { type: 'notice', kind: 'warning', text: 'old notice', imported: true, at: 7000 }
    ])
    state = reduceStructuredAgentSession(state, { type: 'older-page', requestedCursor: { epoch: state.epoch, sequence: state.items[0].sequence }, page: { epoch: state.epoch, items: page.items, removedItemIds: [], submissions: page.submissions, hasOlder: true } }, 0)
    expect(state.hasOlder).toBe(true)
    // The held items keep their place and ids; the page sits before them.
    expect(state.items.slice(-held.length).map((i) => i.itemId)).toEqual(held)
    expect(page.items.every((i) => !held.includes(i.itemId))).toBe(true)
    const seqs = state.items.map((i) => i.sequence)
    const times = state.items.map((i) => i.observedAt)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(new Set(seqs).size).toBe(seqs.length)
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThan(times[i - 1])
    expect(messages(state).map((m) => text(m)).filter(Boolean).slice(0, 2)).toEqual(['old one', 'old answer'])
    // The same page again adds nothing.
    expect(adapter.olderPage([{ type: 'user', id: 'hist-u1', text: 'old one', status: 'accepted', at: 1000 }]).items.filter((i) => i.body.kind === 'message')).toEqual([])
  })
})
