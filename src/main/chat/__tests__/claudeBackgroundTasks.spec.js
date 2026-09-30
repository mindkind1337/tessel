// A chat's background work from Claude's stream-json task frames. The frame
// shapes and order follow Claude CLI 2.1.280 captures (a background shell, a
// background agent, a foreground agent moved to the background); ids,
// descriptions and prompts are made up.
import { describe, expect, it } from 'vitest'
import { createClaudeBackground, observeClaudeBackground } from '../claudeBackgroundTasks.js'
import { createFrameState, normalizeFrame } from '../claudeFrames.js'

const system = (subtype, fields = {}) => ({ type: 'system', subtype, session_id: 'session-1', uuid: `u-${subtype}`, ...fields })
const result = () => ({ type: 'result', subtype: 'success', is_error: false, session_id: 'session-1', result: 'ok' })
const counts = (frames) => {
  const state = createFrameState()
  return frames.flatMap((f) => normalizeFrame(f, state)).filter((e) => e.type === 'backgroundTasks').map((e) => e.running)
}

describe('background work of a chat (Claude)', () => {
  it('a background shell: running at the turn end, over at its notification', () => {
    expect(
      counts([
        system('background_tasks_changed', { tasks: [{ task_id: 'shell-1', task_type: 'local_bash', description: 'Sleep' }] }),
        system('task_started', { task_id: 'shell-1', tool_use_id: 'toolu_1', is_backgrounded: true, task_type: 'local_bash' }),
        result(),
        system('background_tasks_changed', { tasks: [] }),
        system('task_notification', { task_id: 'shell-1', tool_use_id: 'toolu_1', status: 'completed' })
      ])
    ).toEqual([1, 0])
  })

  it('a foreground agent moved to the background counts from then on', () => {
    expect(
      counts([
        system('task_started', { task_id: 'agent-1', tool_use_id: 'toolu_a', is_backgrounded: false, task_type: 'local_agent' }),
        system('task_started', { task_id: 'shell-1', owned_by_subagent: true, tool_use_id: 'toolu_s', is_backgrounded: false, task_type: 'local_bash' }),
        system('background_tasks_changed', { tasks: [{ task_id: 'agent-1', task_type: 'local_agent' }] }),
        system('task_updated', { task_id: 'agent-1', patch: { is_backgrounded: true } }),
        result(),
        system('task_notification', { task_id: 'shell-1', tool_use_id: 'toolu_s', status: 'completed' }),
        system('background_tasks_changed', { tasks: [] }),
        system('task_updated', { task_id: 'agent-1', patch: { status: 'completed' } }),
        system('task_notification', { task_id: 'agent-1', tool_use_id: 'toolu_a', status: 'completed' })
      ])
    ).toEqual([1, 0])
  })

  it('before any roster, a backgrounded start or a monitor counts; a terminal update ends it', () => {
    const state = createClaudeBackground()
    expect(observeClaudeBackground(system('task_started', { task_id: 'a', is_backgrounded: true, task_type: 'local_agent' }), state)).toEqual({ type: 'backgroundTasks', running: 1 })
    expect(observeClaudeBackground(system('task_started', { task_id: 'm', task_type: 'monitor_mcp' }), state)).toEqual({ type: 'backgroundTasks', running: 2 })
    expect(observeClaudeBackground(system('task_started', { task_id: 'f', is_backgrounded: false, task_type: 'local_bash' }), state)).toBeNull()
    expect(observeClaudeBackground(system('task_updated', { task_id: 'a', patch: { status: 'killed' } }), state)).toEqual({ type: 'backgroundTasks', running: 1 })
    expect(observeClaudeBackground(system('task_notification', { task_id: 'm', status: 'stopped' }), state)).toEqual({ type: 'backgroundTasks', running: 0 })
  })

  it("never counts Claude's own helpers, ambient tasks, nor other frames", () => {
    const state = createClaudeBackground()
    expect(
      observeClaudeBackground(
        system('background_tasks_changed', {
          tasks: [
            { task_id: 'mate', task_type: 'in_process_teammate' },
            { task_id: 'dream', task_type: 'dream' },
            { task_id: 'quiet', task_type: 'local_bash', ambient: true }
          ]
        }),
        state
      )
    ).toBeNull()
    expect(observeClaudeBackground(system('task_started', { task_id: 'x', is_backgrounded: true, ambient: true }), state)).toBeNull()
    expect(observeClaudeBackground({ type: 'assistant', message: { content: [] } }, state)).toBeNull()
    expect(observeClaudeBackground(system('init'), state)).toBeNull()
  })

  it('once a roster was seen, it alone says which background tasks live', () => {
    const state = createClaudeBackground()
    observeClaudeBackground(system('background_tasks_changed', { tasks: [] }), state)
    expect(observeClaudeBackground(system('task_started', { task_id: 'late', is_backgrounded: true, task_type: 'local_bash' }), state)).toBeNull()
    expect(observeClaudeBackground(system('background_tasks_changed', { tasks: [{ task_id: 'late', task_type: 'local_bash' }, { task_type: 'monitor_ws' }] }), state)).toEqual({
      type: 'backgroundTasks',
      running: 2
    })
  })
})
