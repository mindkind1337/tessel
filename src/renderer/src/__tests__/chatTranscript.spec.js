// A chat worker's conversation as text for its coordinator (chatTranscript.js).
import { describe, it, expect } from 'vitest'
import { formatChatTranscript, MAX_MESSAGE } from '../chat/chatTranscript'

// The history as chat:history gives it: { seq, event }.
const history = (events) => events.map((event, i) => ({ seq: i + 1, event }))

describe('formatChatTranscript', () => {
  it('messages, tools as one line, approvals, failed turns, notices and stops', () => {
    const text = formatChatTranscript(
      history([
        { type: 'status', state: 'idle', agent: 'claude', sessionId: 'sess-secret', launchToken: 'tok-secret', model: 'claude-x' },
        { type: 'user', id: 'u1', text: 'You are a Tessel worker.', origin: 'user', status: 'sent' },
        { type: 'user', id: 'u2', text: 'Fix the cart', origin: 'team', from: '#1 Claude Code', status: 'queued' },
        { type: 'thinking', messageId: 'm1', text: 'private thoughts' },
        { type: 'assistantDelta', messageId: 'm1', text: 'Looking at ' },
        { type: 'assistantDelta', messageId: 'm1', text: 'the tests.' },
        { type: 'assistant', messageId: 'm1', text: 'Looking at the tests.' },
        { type: 'tool', id: 't1', name: 'Bash', summary: 'Bash: npm test', input: { command: 'npm test', env: { TOKEN: 'abc' } }, status: 'running' },
        { type: 'toolResult', id: 't1', isError: true, text: 'FAIL TOKEN=abc' },
        { type: 'tool', id: 't2', name: 'Read', input: { file_path: 'C:\\repo\\src\\cart.js' }, status: 'running' },
        { type: 'approval', requestId: 'a1', toolName: 'Bash', input: { command: 'git push' }, status: 'pending' },
        { type: 'turnEnd', status: 'failed', error: 'usage limit' },
        { type: 'notice', kind: 'error', text: 'The turn failed: usage limit' },
        { type: 'status', state: 'crashed', error: 'exit 1' }
      ])
    )
    expect(text.split('\n')).toEqual([
      '> User: You are a Tessel worker.',
      '> Team message from #1 Claude Code: Fix the cart',
      'Looking at the tests.',
      '▸ Bash: npm test (error)',
      '▸ Read C:\\repo\\src\\cart.js (error)',
      '? Approval cancelled: Bash: git push',
      '[turn failed: usage limit]',
      '[error] The turn failed: usage limit',
      '[stopped: the agent stopped: exit 1]'
    ])
    // Never an input, a result, a token or a session id.
    expect(text).not.toMatch(/abc|secret|private|env/)
  })

  it('a pending approval, a completed turn and a relative path in the project', () => {
    const text = formatChatTranscript(
      [
        { type: 'tool', id: 't1', name: 'Edit', input: { file_path: 'C:\\repo\\src\\a.js', old_string: 'x', new_string: 'y' }, status: 'running' },
        { type: 'toolResult', id: 't1', text: 'ok' },
        { type: 'approval', requestId: 'a1', toolName: 'Bash', input: { command: 'rm -rf build\nsecond line' }, status: 'pending' }
      ],
      60,
      { cwd: 'C:\\repo' }
    )
    expect(text).toBe("▸ Edit src/a.js (done)\n? Waiting for the user's approval: Bash: rm -rf build")
    expect(formatChatTranscript([{ type: 'turnEnd', status: 'completed' }, { type: 'turnEnd', status: 'interrupted' }])).toBe('[turn ended]\n[turn interrupted]')
  })

  it('strips terminal escapes and control characters, keeps lines', () => {
    const text = formatChatTranscript([{ type: 'assistant', messageId: 'm', text: '\x1b[31mred\x1b[0m\r\nnext\x07 line\x00' }])
    expect(text).toBe('red\nnext line')
  })

  it('caps each message, then keeps the last lines', () => {
    const long = formatChatTranscript([{ type: 'assistant', messageId: 'm', text: 'x'.repeat(MAX_MESSAGE * 3) }])
    expect(long.length).toBe(MAX_MESSAGE)
    expect(long.endsWith('…')).toBe(true)
    const many = Array.from({ length: 100 }, (_, i) => ({ type: 'user', id: `u${i}`, text: `message ${i}`, status: 'sent' }))
    const tail = formatChatTranscript(many, 5).split('\n')
    expect(tail).toEqual(['> User: message 95', '> User: message 96', '> User: message 97', '> User: message 98', '> User: message 99'])
  })

  it('nothing to show: empty text', () => {
    expect(formatChatTranscript([])).toBe('')
    expect(formatChatTranscript(null)).toBe('')
    expect(formatChatTranscript([{ type: 'thinking', messageId: 'm', text: 'hmm' }, { type: 'rateLimit', fiveHour: { utilization: 0.4 } }])).toBe('')
  })
})
