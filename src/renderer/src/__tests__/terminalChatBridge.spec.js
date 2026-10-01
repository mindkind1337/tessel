// The chat view of a terminal agent pane: which panes have it, the question
// waiting in the conversation, the messages sent from it, and the keys its
// cards type.
import { describe, expect, it, vi } from 'vitest'
import {
  KEY_ALLOW,
  KEY_ESCAPE,
  answerKeyGroups,
  bridgeSlashCommands,
  canShowChatView,
  commandDelivery,
  composerAgent,
  currentAsk,
  liveAskFromState,
  groupBytes,
  isPastedImageCopy,
  mentionMatches,
  mentionToken,
  mergePendingSends,
  pendingAskFromEvents,
  stepKeys,
  tagTesselTurns,
  waitingCard,
  withCommandMarkers,
  withContextWindow
} from '../chat/terminalChatBridge'

const ask = { questions: [{ question: 'Which one?', options: [{ label: 'A' }, { label: 'B' }] }] }

describe('which panes', () => {
  it('Claude Code, OpenClaude and Codex terminal agents on this computer', () => {
    for (const agentId of ['claude', 'openclaude', 'codex']) expect(canShowChatView({ kind: 'agent', agentId })).toBe(true)
    expect(canShowChatView({ kind: 'agent', agentId: 'opencode' })).toBe(false)
    expect(canShowChatView({ kind: 'agent', agentId: 'grok' })).toBe(false)
    expect(canShowChatView({ kind: 'chat', agentId: 'claude' })).toBe(false)
    expect(canShowChatView({ kind: 'agent', agentId: 'claude', remoteHostId: 'ssh-1' })).toBe(false)
    expect(canShowChatView({ kind: 'agent', agentId: 'claude', detected: true })).toBe(false)
    expect(composerAgent('openclaude')).toBe('claude')
    expect(composerAgent('codex')).toBe('codex')
  })
})

describe('the question waiting for you', () => {
  const call = (id, name = 'AskUserQuestion', input = ask) => ({ type: 'tool', id, name, input, status: 'running' })
  it('the last question call with no result and no prompt since', () => {
    expect(pendingAskFromEvents([{ type: 'user', id: 'u', text: 'go' }, call('t1')])).toMatchObject({ id: 't1', prompt: { questions: [{ question: 'Which one?' }] } })
    // The reader closing the turn at the end of the file is not an answer.
    expect(pendingAskFromEvents([call('t1'), { type: 'tool', id: 't1', status: 'done' }, { type: 'turnEnd', status: 'completed' }])).toMatchObject({ id: 't1' })
    expect(pendingAskFromEvents([call('t1'), { type: 'toolResult', id: 't1', text: 'A' }])).toBeNull()
    expect(pendingAskFromEvents([call('t1'), { type: 'user', id: 'u2', text: 'never mind' }])).toBeNull()
    expect(pendingAskFromEvents([call('t1'), { type: 'turnEnd', status: 'interrupted' }])).toBeNull()
    // A Tessel line typed meanwhile does not answer it.
    expect(pendingAskFromEvents([call('t1'), { type: 'user', id: 'u3', text: 'x', origin: 'team' }])).toMatchObject({ id: 't1' })
    expect(pendingAskFromEvents([call('t1', 'Bash', { command: 'ls' })])).toBeNull()
  })
  it("Codex's request_user_input", () => {
    const codex = { questions: [{ id: 'q1', header: 'Pick', question: 'Which?', options: [{ label: 'X', description: 'x' }] }] }
    expect(pendingAskFromEvents([call('c1', 'request_user_input', codex)]).prompt.questions[0]).toMatchObject({ question: 'Which?', header: 'Pick' })
  })
  it('the card: the question first, else Allow/Deny for an approval, else the terminal', () => {
    const pending = { id: 't1', prompt: ask }
    expect(waitingCard({ approval: true, input: true }, pending)).toEqual({ kind: 'question', ask: pending })
    expect(waitingCard({ approval: true, input: true }, null)).toEqual({ kind: 'terminal' })
    expect(waitingCard({ approval: true }, null)).toEqual({ kind: 'approval' })
    expect(waitingCard({ working: true }, pending)).toBeNull()
    expect(waitingCard({}, null)).toBeNull()
  })
})

describe('messages', () => {
  it("Tessel's own lines are shown as Tessel's", () => {
    const [a, b] = tagTesselTurns([
      { type: 'user', id: '1', text: '[Tessel] You have 1 new team message: read it with team_inbox.' },
      { type: 'user', id: '2', text: 'mine' }
    ])
    expect(a).toMatchObject({ origin: 'team', from: 'Tessel', text: 'You have 1 new team message: read it with team_inbox.' })
    expect(b).toEqual({ type: 'user', id: '2', text: 'mine' })
  })

  it('a sent message shows until the file has it (same text, or the next prompt once delivered)', () => {
    const events = [{ type: 'user', id: 'old', text: 'before', at: 1000 }]
    let r = mergePendingSends(events, [{ id: 1, text: 'hello  there', at: 10000 }])
    expect(r.done).toEqual([])
    expect(r.events.at(-1)).toMatchObject({ type: 'user', id: 'pending-1', text: 'hello  there', status: 'sent' })
    r = mergePendingSends([...events, { type: 'user', id: 'n', text: 'hello there', at: 10500 }], [{ id: 1, text: 'hello  there', at: 10000 }])
    expect(r.done).toEqual([1])
    expect(r.events.some((e) => e.id === 'pending-1')).toBe(false)
    // Shown shortened by the agent: taken once delivered, not before.
    const short = [...events, { type: 'user', id: 'n', text: '[Pasted text #1 +40 lines]', at: 10500 }]
    expect(mergePendingSends(short, [{ id: 2, text: 'long\ntext', at: 10000 }]).done).toEqual([])
    expect(mergePendingSends(short, [{ id: 2, text: 'long\ntext', at: 10000, delivered: true }]).done).toEqual([2])
    // An older prompt is never taken for it.
    expect(mergePendingSends(events, [{ id: 3, text: 'before', at: 60000, delivered: true }]).done).toEqual([])
  })
})

describe('keys', () => {
  it('Allow is the first option, Deny and Stop are Escape', () => {
    expect(KEY_ALLOW).toBe('1')
    expect(KEY_ESCAPE).toBe('\x1b')
  })
  it("answers as each agent's selector expects", () => {
    expect(answerKeyGroups('claude', ask, [{ indices: [1], other: '' }])).toEqual([{ raw: '2' }])
    expect(answerKeyGroups('openclaude', ask, [{ indices: [0], other: '' }])).toEqual([{ raw: '1' }])
    expect(answerKeyGroups('codex', ask, [{ indices: [1], other: '' }])).toEqual([{ raw: '2' }])
    expect(answerKeyGroups('claude', ask, [{ indices: [], other: '' }])).toEqual([])
  })
  it('typed text carries no control sequence; several lines go as one bracketed paste', () => {
    expect(groupBytes({ raw: '\x1b[C' })).toBe('\x1b[C')
    expect(groupBytes({ text: 'ok\x1b[201~\x1b[2Jdone\x07' })).toBe('ok[2Jdone')
    expect(groupBytes({ text: 'a\nb' })).toBe('\x1b[200~a\nb\x1b[201~')
  })
  it('one step apart, cancellable', () => {
    vi.useFakeTimers()
    const write = vi.fn()
    const h = stepKeys([{ raw: '4' }, { text: 'mine' }, { raw: '\r' }], write, { stepMs: 1000 })
    expect(h.settleAfterMs).toBe(2500)
    vi.advanceTimersByTime(1)
    expect(write.mock.calls.map((c) => c[0])).toEqual(['4'])
    vi.advanceTimersByTime(1000)
    expect(write.mock.calls.map((c) => c[0])).toEqual(['4', 'mine'])
    h.cancel()
    vi.advanceTimersByTime(5000)
    expect(write).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })
})

describe('the question from the hook (shown at once)', () => {
  const hookAsk = { toolId: 'call_1', toolName: 'request_user_input', questions: [{ question: 'Red or blue?', options: [{ label: 'Red' }, { label: 'Blue' }] }] }
  it('is preferred over the file, with its tool id as the card id', () => {
    const events = [
      { type: 'user', text: 'go' },
      { type: 'tool', id: 'call_1', name: 'request_user_input', status: 'running', input: { questions: [{ question: 'Old text', options: [{ label: 'X' }] }] } }
    ]
    const live = currentAsk(hookAsk, events)
    expect(live.id).toBe('call_1')
    expect(live.prompt.questions[0].question).toBe('Red or blue?')
    expect(live.prompt.questions[0].options.map((o) => o.label)).toEqual(['Red', 'Blue'])
    expect(currentAsk(hookAsk, []).id).toBe('call_1')
  })
  it('falls back to the file without it, and to "answer in the terminal" without either', () => {
    const events = [{ type: 'tool', id: 'toolu_1', name: 'AskUserQuestion', status: 'running', input: ask }]
    expect(currentAsk(null, events)).toMatchObject({ id: 'toolu_1' })
    expect(currentAsk({ toolName: 'Bash', questions: hookAsk.questions }, events)).toMatchObject({ id: 'toolu_1' })
    expect(currentAsk(null, [])).toBeNull()
    expect(waitingCard({ input: true }, currentAsk(null, []))).toEqual({ kind: 'terminal' })
    expect(waitingCard({ input: true }, currentAsk(hookAsk, []))).toMatchObject({ kind: 'question', ask: { id: 'call_1' } })
  })
  it('a hook question without a tool id still shows; one with no question does not', () => {
    expect(liveAskFromState({ toolName: 'AskUserQuestion', questions: hookAsk.questions })).toMatchObject({ id: 'live-ask' })
    expect(liveAskFromState({ toolName: 'AskUserQuestion', questions: [] })).toBeNull()
    expect(liveAskFromState(null)).toBeNull()
  })
  it('its answer uses the same stepped keys as the file question', () => {
    const live = currentAsk(hookAsk, [])
    expect(answerKeyGroups('codex', live.prompt, [{ indices: [1] }])).toEqual([{ raw: '2' }])
  })
})

describe('the composer', () => {
  it('a one-line "/command" is a command: typed key by key for Codex, pasted for Claude Code and OpenClaude', () => {
    expect(commandDelivery('codex', '/model')).toBe('type')
    expect(commandDelivery('claude', ' /compact ')).toBe('paste')
    expect(commandDelivery('openclaude', '/review the diff')).toBe('paste')
    expect(commandDelivery('claude', 'Fix /src please')).toBeNull()
    expect(commandDelivery('claude', '/clear\nrm -rf')).toBeNull()
    expect(commandDelivery('claude', '/ hello')).toBeNull()
    // With images it is a message (its images are never dropped).
    expect(commandDelivery('claude', '/review', 1)).toBeNull()
  })
  it('names to the agent only Tessel\u2019s own image copies', () => {
    const win = (...parts) => parts.join(String.fromCharCode(92))
    const copy = 'img_0123456789abcdef01234567'
    expect(isPastedImageCopy(win('C:', 'Users', 'me', 'AppData', 'Local', 'Temp', 'tessel-paste', 'chat', `${copy}.png`))).toBe(true)
    expect(isPastedImageCopy(`/tmp/tessel-paste/chat/${copy}.webp`)).toBe(true)
    expect(isPastedImageCopy(win('C:', 'Users', 'me', 'secret.png'))).toBe(false)
    expect(isPastedImageCopy(win('C:', 'Temp', 'tessel-paste', 'chat', '..', '..', 'tessel-paste', 'chat', `${copy}.png`))).toBe(false)
    expect(isPastedImageCopy(win('C:', 'Temp', 'tessel-paste', 'chat', `${copy}.png`) + String.fromCharCode(13) + '/clear')).toBe(false)
    expect(isPastedImageCopy(win('tessel-paste', 'chat', `${copy}.png`))).toBe(false)
    expect(isPastedImageCopy(win('C:', 'Temp', 'tessel-paste', 'chat', `${copy}.exe`))).toBe(false)
  })
  it('the "/" menu: the agent\u2019s own commands, model and effort first for Claude Code', () => {
    const claude = bridgeSlashCommands('claude', { options: ['model', 'effort'] }).map((c) => c.name)
    expect(claude.slice(0, 3)).toEqual(['model', 'effort', 'clear'])
    expect(claude).toContain('compact')
    expect(bridgeSlashCommands('openclaude').map((c) => c.name)).not.toContain('model')
    const codex = bridgeSlashCommands('codex', { options: ['model', 'effort'] })
    expect(codex.filter((c) => c.name === 'model')).toHaveLength(1)
    expect(codex.every((c) => c.kind === 'command')).toBe(true)
  })
  it('"Ran /command" rows go where they were sent', () => {
    const msgs = [{ id: 'a', timestamp: 1000 }, { id: 'b', timestamp: 3000 }]
    const out = withCommandMarkers(msgs, [{ id: 'm', command: '/compact', sentAt: 2000 }])
    expect(out.map((m) => m.id)).toEqual(['a', 'command:m', 'b'])
    expect(out[1].role).toBe('system')
    expect(withCommandMarkers([{ id: 'x', timestamp: null }], [{ id: 'm', command: '/clear', sentAt: 5 }]).map((m) => m.id)).toEqual(['x', 'command:m'])
    expect(withCommandMarkers(msgs, [])).toEqual(msgs)
  })
  it('"@": the project files best first, quoted with a space', () => {
    expect(mentionMatches(['src/App.vue', 'README.md', 'src/app.js', 'bad\nname'], 'app', 2).sort()).toEqual(['src/App.vue', 'src/app.js'])
    expect(mentionMatches(['a/b/c.js', 'bad\napp'], 'app')).toEqual([])
    expect(mentionToken('src/App.vue')).toBe('src/App.vue')
    expect(mentionToken('docs/my notes.md')).toBe('"docs/my notes.md"')
    expect(mentionToken(['src', 'x.js'].join(String.fromCharCode(92)))).toBe('src/x.js')
  })
  it('the context ring knows Claude\u2019s window only from a 1M model', () => {
    const ev = [{ type: 'contextUsage', usedTokens: 10, windowTokens: null }]
    expect(withContextWindow(ev, 'claude-opus-5-5[1m]')[0].windowTokens).toBe(1000000)
    expect(withContextWindow(ev, 'opus')).toBe(ev)
  })
})
