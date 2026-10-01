// @vitest-environment node
// Synthetic Claude Code session lines only.
import { describe, expect, it } from 'vitest'
import { claudeBackgroundFromLines, transcriptCwd } from '../transcriptBackground'

const NOW = Date.parse('2026-10-01T12:00:00.000Z')
const at = (s) => new Date(NOW - 600000 + s * 1000).toISOString()
const json = (records) => records.map((r) => JSON.stringify(r))
const toolUse = (s, id, name, input) => ({ type: 'assistant', timestamp: at(s), message: { id: `m-${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } })
const toolResult = (s, id, result, text = 'ok', extra = {}) => ({ type: 'user', timestamp: at(s), toolUseResult: result, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, ...extra }] } })
const notification = (s, taskId, status) => ({
  type: 'user',
  timestamp: at(s),
  message: { role: 'user', content: `<task-notification>\n<task-id>${taskId}</task-id>\n${status ? `<status>${status}</status>\n` : ''}<summary>Background command done</summary>\n</task-notification>` }
})

describe('background tasks from a Claude Code session file', () => {
  it('lists background shells, async sub-agents and monitors still running', () => {
    const lines = json([
      toolUse(1, 'tu1', 'Bash', { command: 'npm run dev', description: 'Start the dev server', run_in_background: true }),
      toolResult(2, 'tu1', { backgroundTaskId: 'bshell1' }),
      toolUse(3, 'tu2', 'Agent', { description: 'Review the diff', prompt: 'secret prompt', run_in_background: true }),
      toolResult(4, 'tu2', { isAsync: true, status: 'async_launched', agentId: 'a1234abcd' }),
      toolUse(5, 'tu3', 'Monitor', { command: 'tail -f log', description: 'Watch the log', timeout_ms: 3600000 }),
      toolResult(6, 'tu3', { taskId: 'bmon1', timeoutMs: 3600000, persistent: false }),
      // A foreground sub-agent and a plain command are not background work.
      toolUse(7, 'tu4', 'Agent', { description: 'Inline', prompt: 'x' }),
      toolResult(8, 'tu4', { status: 'completed', agentId: 'afore' }),
      toolUse(9, 'tu5', 'Bash', { command: 'ls' }),
      toolResult(10, 'tu5', { stdout: '' })
    ])
    expect(claudeBackgroundFromLines(lines, NOW)).toEqual([
      { id: 'bshell1', kind: 'command', description: 'Start the dev server', startedAt: Date.parse(at(1)) },
      { id: 'a1234abcd', kind: 'agent', description: 'Review the diff', startedAt: Date.parse(at(3)) },
      { id: 'bmon1', kind: 'monitor', description: 'Watch the log', startedAt: Date.parse(at(5)) }
    ])
  })

  it('its end: a final notification, a TaskStop, the sub-agents killed; a monitor event is not an end', () => {
    const lines = json([
      toolUse(1, 'tu1', 'Bash', { command: 'a', description: 'A', run_in_background: true }),
      toolResult(2, 'tu1', {}, 'Command running in background with ID: bone. Output is being written to: x'),
      toolUse(3, 'tu2', 'Bash', { command: 'b', description: 'B', run_in_background: true }),
      toolResult(4, 'tu2', { backgroundTaskId: 'btwo' }),
      toolUse(5, 'tu3', 'Monitor', { command: 'c', description: 'C', persistent: true }),
      toolResult(6, 'tu3', { taskId: 'bmon' }),
      toolUse(7, 'tu4', 'Agent', { description: 'D', prompt: 'p', run_in_background: true }),
      toolResult(8, 'tu4', { isAsync: true, agentId: 'aagent' }),
      notification(9, 'bone', 'completed'),
      notification(10, 'bmon'),
      toolUse(11, 'tu5', 'TaskStop', { task_id: 'btwo' }),
      { type: 'system', subtype: 'agents_killed', timestamp: at(12) }
    ])
    expect(claudeBackgroundFromLines(lines, NOW).map((t) => t.id)).toEqual(['bmon'])
    // A failed start is no task; nor is a sub-agent's own line.
    const failed = json([
      toolUse(1, 'tu1', 'Bash', { command: 'a', run_in_background: true }),
      toolResult(2, 'tu1', { backgroundTaskId: 'bx' }, 'error', { is_error: true }),
      { ...toolUse(3, 'tu2', 'Bash', { command: 'b', run_in_background: true }), isSidechain: true },
      { ...toolResult(4, 'tu2', { backgroundTaskId: 'by' }), isSidechain: true }
    ])
    expect(claudeBackgroundFromLines(failed, NOW)).toEqual([])
  })

  it('a monitor past its timeout and a task older than 6 hours are not shown; ids are checked; lines that do not parse are skipped', () => {
    const lines = json([
      toolUse(1, 'tu1', 'Monitor', { command: 'c', description: 'Short', timeout_ms: 1000 }),
      toolResult(2, 'tu1', { taskId: 'bshort' }),
      toolUse(3, 'tu2', 'Bash', { command: 'x', run_in_background: true }),
      toolResult(4, 'tu2', { backgroundTaskId: '../../etc' }, 'no id here')
    ])
    lines.push('{"broken": run_in_background')
    expect(claudeBackgroundFromLines(lines, NOW)).toEqual([])
    const old = json([toolUse(1, 'tu1', 'Bash', { command: 'x', run_in_background: true }), toolResult(2, 'tu1', { backgroundTaskId: 'bold' })])
    expect(claudeBackgroundFromLines(old, NOW + 7 * 60 * 60 * 1000)).toEqual([])
  })

  it('the description is one short line (no control characters)', () => {
    const lines = json([toolUse(1, 'tu1', 'Bash', { command: `echo ${'y'.repeat(400)}\nsecond line\u0007`, run_in_background: true }), toolResult(2, 'tu1', { backgroundTaskId: 'blong' })])
    const [task] = claudeBackgroundFromLines(lines, NOW)
    expect(task.description.length).toBeLessThanOrEqual(200)
    expect(task.description).not.toMatch(/[\n\u0007]/)
  })
})

describe('the folder the agent works in', () => {
  it("its newest line's cwd (Claude Code), or Codex's payload cwd; only an absolute path", () => {
    const abs = process.platform === 'win32' ? 'C:/work/proj' : '/work/proj'
    expect(transcriptCwd(json([{ type: 'user', cwd: '/old' }, { type: 'user', cwd: abs }]))).toBe(abs)
    expect(transcriptCwd(json([{ type: 'turn_context', payload: { cwd: abs } }]))).toBe(abs)
    expect(transcriptCwd(json([{ type: 'user', cwd: 'relative/dir' }]))).toBeNull()
    expect(transcriptCwd([])).toBeNull()
    expect(transcriptCwd(null)).toBeNull()
  })
})
