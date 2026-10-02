// The chat view over a terminal agent: command rows,
// background tasks, Claude's context window (pure helpers).
import { describe, expect, it } from 'vitest'
import { claudeContextWindow, mergeCommandMarkers, splitCommandTurns, terminalBackgroundTasks } from '../chat/terminalChatExtras.js'

const user = (id, text, at, extra = {}) => ({ type: 'user', id, text, origin: 'user', status: 'accepted', at, ...extra })

describe('slash commands as "Ran" rows', () => {
  it('takes the command lines out of the conversation, each run once', () => {
    const events = [
      user('u1', 'Fix the bug', 1000),
      { type: 'assistant', messageId: 'a1', text: 'Done.', at: 2000 },
      user('c1', '/compact', 3000),
      // Claude Code writes it again as its <command-name> echo once it ran.
      user('c2', '/compact', 3000 + 4 * 60 * 1000),
      user('c3', '/model haiku', 400000),
      user('c4', '/compact', 400000 + 6 * 60 * 1000),
      user('t1', '/compact', 900000, { origin: 'team' }),
      user('u2', 'not /a command', 900001),
      user('u3', '/two\nlines', 900002)
    ]
    const { events: kept, commands } = splitCommandTurns(events)
    expect(commands).toEqual([
      { id: 'file-c1', command: '/compact', sentAt: 3000 },
      { id: 'file-c3', command: '/model haiku', sentAt: 400000 },
      { id: 'file-c4', command: '/compact', sentAt: 400000 + 6 * 60 * 1000 }
    ])
    expect(kept.map((e) => e.id || e.messageId)).toEqual(['u1', 'a1', 't1', 'u2', 'u3'])
    // No command: the same list.
    const plain = [user('u1', 'hi', 1)]
    expect(splitCommandTurns(plain).events).toBe(plain)
    expect(splitCommandTurns(null)).toEqual({ events: [], commands: [] })
  })

  it("a command sent from the chat is the file's own once it shows (within two minutes)", () => {
    const local = [
      { id: 'l1', command: '/compact', sentAt: 10000 },
      { id: 'l2', command: '/effort low', sentAt: 20000 }
    ]
    const file = [
      { id: 'file-c1', command: '/compact', sentAt: 12000 },
      { id: 'file-c9', command: '/clear', sentAt: null }
    ]
    expect(mergeCommandMarkers(local, file)).toEqual([
      { id: 'file-c1', command: '/compact', sentAt: 12000 },
      { id: 'l2', command: '/effort low', sentAt: 20000 }
    ])
    expect(mergeCommandMarkers([{ id: 'l1', command: '/compact', sentAt: 10000 }], [{ id: 'f', command: '/compact', sentAt: 10000 + 3 * 60 * 1000 }])).toHaveLength(2)
  })
})

describe('the background-task dock', () => {
  const tasks = [
    { id: 'b1', kind: 'command', description: 'Dev server', startedAt: 1000 },
    { id: 'a1', kind: 'agent', description: 'Review', startedAt: 5000 },
    { id: 'm1', kind: 'monitor', startedAt: 9000 },
    { id: 'x1', kind: 'weird' }
  ]
  it('shown while some run, quietly during a turn, never with a Stop', () => {
    const view = terminalBackgroundTasks(tasks, { working: true })
    expect(view).toMatchObject({ show: true, isMonitoring: false, settledTasks: [], supportsStop: false, supportsStopAll: false })
    expect(view.tasks.map((t) => [t.id, t.kind, t.stoppable])).toEqual([
      ['b1', 'command', false],
      ['a1', 'agent', false],
      ['m1', 'monitor', false],
      ['x1', 'unknown', false]
    ])
    expect(terminalBackgroundTasks([], {})).toMatchObject({ show: false, isMonitoring: true, tasks: [] })
  })
  it("the agent's last Stop listing ends what it no longer lists (started before it)", () => {
    const view = terminalBackgroundTasks(tasks, { ids: ['a1'], listedAt: 8000 })
    // b1: started before the listing, not in it: over. a1: listed. m1: started after. x1: no start time.
    expect(view.tasks.map((t) => t.id)).toEqual(['a1', 'm1', 'x1'])
    expect(terminalBackgroundTasks(tasks, { ids: null, listedAt: 8000 }).tasks).toHaveLength(4)
  })
})

describe("Claude's context window", () => {
  it('1M with [1m], 200k for any other Claude model (1M once more than 200k is used), unknown otherwise', () => {
    expect(claudeContextWindow('opus[1m]')).toBe(1_000_000)
    expect(claudeContextWindow('claude-sonnet-5-5')).toBe(200_000)
    expect(claudeContextWindow('haiku')).toBe(200_000)
    expect(claudeContextWindow('claude-fable-5-1', 250_000)).toBe(1_000_000)
    expect(claudeContextWindow('', 10, 'claude')).toBe(200_000)
    expect(claudeContextWindow('', 10, 'openclaude')).toBeNull()
    expect(claudeContextWindow('gpt-5.1', 10, 'openclaude')).toBeNull()
  })
})
