// Freebuff's status from its screen (it has no hooks): synthetic screens shaped
// like its UI, after the captured transcripts Orca tests against.
import { describe, it, expect } from 'vitest'
import { freebuffScreenState } from '../freebuffScreen'
import { agentScreenObservation } from '../../renderer/src/agentStatus'

const composer = (status, extra = []) => [
  'Freebuff',
  ...extra,
  status,
  '╭──────────────────────────────╮',
  '│ >                            │',
  '╰──────────────────────────────╯',
  '  /model to change · Chat: 3 · esc'
]

describe('Freebuff screen state', () => {
  it('reads its status line over the composer, never words in the conversation', () => {
    expect(freebuffScreenState(composer('thinking...'), true)).toEqual({ state: 'working' })
    expect(freebuffScreenState(composer('high demand — in line (3)'), true)).toEqual({ state: 'working' })
    expect(freebuffScreenState(composer('59m left · End session'), true)).toEqual({ state: 'ready' })
    expect(freebuffScreenState(composer('', ['Your first message starts the session.']), true)).toEqual({ state: 'ready' })
    // "thinking..." quoted in an answer above is not its status.
    expect(freebuffScreenState(composer('an answer', ['thinking...']), true)).toBe(null)
    expect(freebuffScreenState(['$ freebuff'], true)).toBe(null)
  })
  it('a question dialog waits for an answer; login and the agent-file prompt block it', () => {
    const dialog = [
      '╭─── Some questions for you ───╮',
      '│ ▼ Which database?            │',
      '│ ○ Postgres                   │',
      '│ ○ SQLite                     │',
      '│ ↑↓ navigate · enter select   │',
      '╰──────────────────────────────╯'
    ]
    expect(freebuffScreenState([...dialog, '  /model to change · Chat: 1'], true)).toEqual({ state: 'waiting', question: 'Which database?' })
    expect(freebuffScreenState(['Press ENTER to login...'], true)).toEqual({ state: 'blocked' })
    const trust = ['freebuff found agent files in this repository', 'Load and run these? [y/N]']
    expect(freebuffScreenState(trust, false)).toEqual({ state: 'blocked' })
    expect(freebuffScreenState(composer('thinking...'), false)).toBe(null)
  })
  it("a Freebuff pane's observation: its question is an approval, its status line its work", () => {
    const term = (lines, type = 'alternate') => ({
      rows: lines.length,
      buffer: { active: { type, viewportY: 0, getLine: (y) => ({ translateToString: () => lines[y] || '' }) } }
    })
    expect(agentScreenObservation(term(composer('thinking...')), 'freebuff', '')).toMatchObject({ busy: true, approval: false, ready: false })
    expect(agentScreenObservation(term(composer('59m left · End session')), 'freebuff', '')).toMatchObject({ busy: false, ready: true })
    expect(agentScreenObservation(term(['Press ENTER to login...']), 'freebuff', '')).toMatchObject({ approval: true, busy: false })
    // Nothing of its own on screen: the usual reading.
    expect(agentScreenObservation(term(['$']), 'freebuff', '')).toMatchObject({ approval: false, ready: false })
  })
})
