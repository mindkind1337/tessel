// The chat pane's reducer (chat/chatModel.js): the main process's renderer
// events become the rows, the status, the model and the rate limits.
import { describe, expect, it } from 'vitest'
import {
  chatReducer,
  reduceAll,
  initialChatState,
  toolSummary,
  truncate,
  shortPath,
  formatInput,
  rateLimitParts,
  pendingApproval,
  isBusy
} from '../chat/chatModel'

const run = (events, opts) => reduceAll(initialChatState(), events, opts)
const kinds = (s) => s.rows.map((r) => r.kind)

describe('chatModel reducer', () => {
  it('streams deltas, then the final text replaces them', () => {
    let s = run([
      { type: 'assistantDelta', messageId: 'm1', text: 'Hel' },
      { type: 'assistantDelta', messageId: 'm1', text: 'lo **wor' }
    ])
    expect(s.rows).toHaveLength(1)
    expect(s.rows[0]).toMatchObject({ kind: 'assistant', text: 'Hello **wor', streaming: true })
    s = chatReducer(s, { type: 'assistant', messageId: 'm1', text: 'Hello **world**' })
    expect(s.rows).toHaveLength(1)
    expect(s.rows[0]).toMatchObject({ text: 'Hello **world**', streaming: false })
    // The same final text again (history replay) adds nothing.
    expect(chatReducer(s, { type: 'assistant', messageId: 'm1', text: 'Hello **world**' })).toBe(s)
  })

  it('a final text without deltas is a row; text after a tool is a new row', () => {
    const s = run([
      { type: 'assistant', messageId: 'm1', text: 'First' },
      { type: 'tool', id: 't1', name: 'Read', input: { file_path: 'a.js' }, status: 'running' },
      { type: 'assistantDelta', messageId: 'm1', text: 'Then' }
    ])
    expect(kinds(s)).toEqual(['assistant', 'tool', 'assistant'])
    expect(s.rows[2].text).toBe('Then')
    // Empty final text with nothing streamed: no row.
    expect(chatReducer(s, { type: 'assistant', messageId: 'm2', text: '  ' }).rows).toHaveLength(3)
  })

  it('a tool call and its result', () => {
    let s = run([{ type: 'tool', id: 't1', name: 'Bash', input: JSON.stringify({ command: 'npm test' }), status: 'running' }])
    expect(s.rows[0]).toMatchObject({ kind: 'tool', id: 't1', name: 'Bash', summary: 'Bash: npm test', status: 'running', result: null })
    s = chatReducer(s, { type: 'toolResult', id: 't1', isError: false, text: 'ok' })
    expect(s.rows[0]).toMatchObject({ status: 'done', result: { text: 'ok', isError: false } })
    s = chatReducer(s, { type: 'tool', id: 't2', name: 'Read', summary: 'Read x.js', input: {}, status: 'running' })
    s = chatReducer(s, { type: 'toolResult', id: 't2', isError: true, text: 'ENOENT' })
    expect(s.rows[1]).toMatchObject({ summary: 'Read x.js', status: 'error', result: { isError: true } })
    // The same tool again (history) keeps its result.
    s = chatReducer(s, { type: 'tool', id: 't1', name: 'Bash', input: { command: 'npm test' }, status: 'running' })
    expect(s.rows).toHaveLength(2)
    expect(s.rows[0].status).toBe('done')
  })

  it('rows not touched by an event keep their object (cheap renders)', () => {
    const s = run([
      { type: 'user', id: 'u1', text: 'hi', origin: 'user', status: 'accepted' },
      { type: 'assistantDelta', messageId: 'm1', text: 'a' }
    ])
    const next = chatReducer(s, { type: 'assistantDelta', messageId: 'm1', text: 'b' })
    expect(next.rows[0]).toBe(s.rows[0])
    expect(next.rows[1]).not.toBe(s.rows[1])
    expect(next.rows[1].key).toBe(s.rows[1].key)
  })

  it('approval pending, then decided', () => {
    let s = run([
      { type: 'approval', requestId: 'r1', toolName: 'Bash', displayName: 'Bash', input: { command: 'rm -rf x' }, description: 'Remove x', status: 'pending' }
    ])
    expect(pendingApproval(s)).toMatchObject({ requestId: 'r1', status: 'pending' })
    s = chatReducer(s, { type: 'approvalStatus', requestId: 'r1', status: 'allowedSession' })
    expect(s.rows[0].status).toBe('allowedSession')
    expect(pendingApproval(s)).toBe(null)
    // Unknown status or request: nothing changes.
    expect(chatReducer(s, { type: 'approvalStatus', requestId: 'r1', status: 'maybe' })).toBe(s)
    expect(chatReducer(s, { type: 'approvalStatus', requestId: 'zz', status: 'denied' })).toBe(s)
  })

  it('approval: the main preview, its hidden count and the session rules', () => {
    const s = run([
      {
        type: 'approval',
        requestId: 'r1',
        toolName: 'Bash',
        input: { command: 'short … (9 more bytes)' },
        detail: 'abc',
        hidden: 12000,
        sessionRules: [{ kind: 'rule', tool: 'Bash', content: 'npm:*' }, { kind: 'mode', mode: 'acceptEdits' }, { kind: 'directories', directories: ['C:\\x', 3] }, { kind: 'evil' }, null],
        status: 'pending'
      },
      { type: 'approval', requestId: 'r2', toolName: 'Bash', input: { command: 'ls' }, hidden: -3, sessionRules: 'x', status: 'pending' }
    ])
    expect(s.rows[0]).toMatchObject({ detail: 'abc', hidden: 12000 })
    expect(s.rows[0].sessionRules).toEqual([
      { kind: 'rule', tool: 'Bash', content: 'npm:*' },
      { kind: 'mode', mode: 'acceptEdits' },
      { kind: 'directories', directories: ['C:\\x'] }
    ])
    expect(s.rows[1]).toMatchObject({ detail: null, hidden: 0, sessionRules: [] })
  })

  it('a user message queued, then accepted', () => {
    let s = run([{ type: 'user', id: 'u1', text: 'do it', origin: 'user', status: 'queued', at: 1 }])
    expect(s.rows[0]).toMatchObject({ kind: 'user', origin: 'user', status: 'queued', text: 'do it' })
    s = chatReducer(s, { type: 'userStatus', id: 'u1', status: 'accepted' })
    expect(s.rows[0].status).toBe('accepted')
    // The same user event again updates the row, no duplicate.
    s = chatReducer(s, { type: 'user', id: 'u1', text: 'do it', origin: 'user', status: 'accepted' })
    expect(s.rows).toHaveLength(1)
  })

  it('team rows, marked accepted together', () => {
    let s = run([
      { type: 'user', id: 'x1', text: 'build ok', origin: 'team', from: '#3', status: 'queued' },
      { type: 'user', id: 'x2', text: 'tests ok', origin: 'team', from: '#4', status: 'queued' },
      { type: 'user', id: 'u1', text: 'mine', origin: 'user', status: 'sent' }
    ])
    expect(s.rows[0]).toMatchObject({ origin: 'team', from: '#3' })
    s = chatReducer(s, { type: 'teamAccepted', ids: ['x1', 'x2'] })
    expect(s.rows.map((r) => r.status)).toEqual(['accepted', 'accepted', 'sent'])
  })

  it('turnEnd closes streams, running tools and pending approvals; adds a separator', () => {
    let s = run([
      { type: 'status', state: 'working' },
      { type: 'assistantDelta', messageId: 'm1', text: 'partial' },
      { type: 'tool', id: 't1', name: 'Bash', input: { command: 'sleep 9' }, status: 'running' },
      { type: 'approval', requestId: 'r1', toolName: 'Bash', input: {}, status: 'pending' }
    ])
    s = chatReducer(s, { type: 'turnEnd', status: 'interrupted', durationMs: 1500 })
    expect(kinds(s)).toEqual(['assistant', 'tool', 'approval', 'turn'])
    expect(s.rows[0].streaming).toBe(false)
    expect(s.rows[1].status).toBe('error')
    expect(s.rows[2].status).toBe('cancelled')
    expect(s.rows[3]).toMatchObject({ status: 'interrupted', durationMs: 1500 })
    expect(s.status).toBe('idle')
  })

  it('status carries the model, the session and the error', () => {
    let s = run([{ type: 'status', state: 'idle', model: 'claude-opus-4-8', sessionId: 'abc' }])
    expect(s).toMatchObject({ status: 'idle', model: 'claude-opus-4-8', sessionId: 'abc' })
    expect(isBusy(s.status)).toBe(false)
    s = chatReducer(s, { type: 'status', state: 'crashed', error: 'exit 3' })
    expect(s).toMatchObject({ status: 'crashed', error: 'exit 3', model: 'claude-opus-4-8' })
    s = chatReducer(s, { type: 'status', state: 'working' })
    expect(s.error).toBe('')
    expect(isBusy(s.status)).toBe(true)
    expect(chatReducer(s, { type: 'status', state: 'weird' })).toBe(s)
  })

  it('thinking, notices, rate limits; unknown events are ignored', () => {
    let s = run([
      { type: 'thinking', messageId: 'm1', text: 'hmm' },
      { type: 'thinking', messageId: 'm1', text: 'hmm' },
      { type: 'notice', kind: 'error', text: 'Oops' },
      { type: 'rateLimit', fiveHour: { utilization: 0.42 }, sevenDay: { utilization: 0.1 } },
      { type: 'nope' },
      null
    ])
    expect(kinds(s)).toEqual(['thinking', 'notice'])
    expect(s.rows[1]).toMatchObject({ level: 'error', text: 'Oops' })
    expect(rateLimitParts(s.rateLimit).map((p) => p.pct)).toEqual([42, 10])
    // A history item wrapped as { seq, event } is read too.
    s = reduceAll(s, [{ seq: 4, event: { type: 'notice', kind: 'info', text: 'Hi' } }])
    expect(s.rows[2]).toMatchObject({ kind: 'notice', level: 'info' })
    expect(new Set(s.rows.map((r) => r.key)).size).toBe(3)
  })
})

describe('chatModel helpers', () => {
  it('toolSummary: file tools, Bash, searches, MCP, strings', () => {
    expect(toolSummary('Read', { file_path: 'C:\\p\\src\\x.js' }, { cwd: 'C:\\p' })).toBe('Read src/x.js')
    expect(toolSummary('Edit', { file_path: '/other/y.js' }, { cwd: 'C:\\p' })).toBe('Edit /other/y.js')
    expect(toolSummary('Edit', {})).toBe('Edit')
    expect(toolSummary('Bash', { command: 'npm test\nnpm run lint' })).toBe('Bash: npm test')
    expect(toolSummary('Grep', { pattern: 'TODO', path: 'src' })).toBe('Grep TODO')
    expect(toolSummary('WebFetch', '{"url":"https://a.test"}')).toBe('WebFetch https://a.test')
    expect(toolSummary('mcp__tessel-team__team_send', { to: '#2' })).toBe('tessel-team: team_send')
    expect(toolSummary('Task', 'not json')).toBe('Task not json')
    expect(toolSummary('Bash', { command: 'x'.repeat(200) })).toHaveLength(80)
  })

  it('truncate, shortPath, formatInput', () => {
    expect(truncate('abcdef', 4)).toBe('abc…')
    expect(truncate('abc', 4)).toBe('abc')
    expect(shortPath('C:/p/a/b.js', 'C:\\p\\')).toBe('a/b.js')
    expect(shortPath('C:/q/a.js', 'C:/p')).toBe('C:/q/a.js')
    expect(formatInput({ a: 1 })).toBe('{\n  "a": 1\n}')
    expect(formatInput('{"a":1}')).toBe('{\n  "a": 1\n}')
    expect(formatInput('{"a":1')).toBe('{"a":1')
    expect(formatInput(null)).toBe('')
  })

  it('rateLimitParts: 0..1 or 0..100, missing windows skipped', () => {
    expect(rateLimitParts(null)).toEqual([])
    expect(rateLimitParts({ sevenDay: { utilization: 55 } })).toEqual([{ id: 'sevenDay', pct: 55, resetsAt: null }])
    expect(rateLimitParts({ fiveHour: { utilization: 'x' } })).toEqual([])
  })
})
