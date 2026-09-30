// The background work a chat's Claude runs (background shells, background
// sub-agents, monitors, workflows), from its stream-json task frames, after
// the reference's ClaudeBackgroundTaskTracker (Orca, MIT, Copyright (c) 2026
// Lovecast Inc.): `background_tasks_changed` lists every live background task
// (replace semantics) and, once seen, is the only judge of that class; a
// terminal `task_updated` / `task_notification` retires one at once. Before
// any list, a start marked backgrounded (or a monitor/workflow) counts.
// Only the number of tasks leaves this module: "monitoring" in the sidebar
// once the turn has ended.
const MAX_TASKS = 256
const OVER = new Set(['idle', 'done', 'success', 'succeeded', 'complete', 'completed', 'finished', 'failed', 'error', 'terminated', 'exited', 'aborted', 'expired', 'skipped', 'crashed', 'killed', 'stopped', 'interrupted', 'cancelled', 'canceled', 'timed_out'])
// Claude's own helpers, not the agent's work (a teammate stays listed idle).
const NOT_WORK = new Set(['in_process_teammate', 'teammate', 'dream', 'auto_mode_scan', 'local_memory_import'])
const ALWAYS_BACKGROUND = new Set(['monitor_mcp', 'monitor_ws', 'local_workflow'])
const record = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null)
const id = (v) => (typeof v === 'string' && v.length > 0 && v.length <= 512 ? v : null)
const status = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '')

export function createClaudeBackground() {
  return { ids: new Set(), roster: false, reported: 0 }
}

function add(state, taskId) {
  if (state.ids.size >= MAX_TASKS && !state.ids.has(taskId)) return
  state.ids.add(taskId)
}

// One frame -> { type: 'backgroundTasks', running } when the number of
// running background tasks changed, else null.
export function observeClaudeBackground(m, state) {
  if (!m || m.type !== 'system' || !state) return null
  if (m.subtype === 'background_tasks_changed' && Array.isArray(m.tasks)) {
    state.roster = true
    state.ids.clear()
    m.tasks.forEach((task, i) => {
      const t = record(task)
      if (!t || t.ambient === true || NOT_WORK.has(t.task_type)) return
      add(state, id(t.task_id) || id(t.id) || `task-${i + 1}`)
    })
  } else if (m.subtype === 'task_notification') {
    const taskId = id(m.task_id)
    if (taskId) state.ids.delete(taskId)
  } else if (m.subtype === 'task_updated') {
    const taskId = id(m.task_id)
    const patch = record(m.patch) || {}
    if (!taskId) return null
    if (OVER.has(status(patch.status))) state.ids.delete(taskId)
    else if (patch.is_backgrounded === true && !state.roster) add(state, taskId)
  } else if (m.subtype === 'task_started') {
    const taskId = id(m.task_id)
    if (!taskId || state.roster || m.ambient === true || m.skip_transcript === true || NOT_WORK.has(m.task_type)) return null
    if (m.is_backgrounded === true || ALWAYS_BACKGROUND.has(m.task_type)) add(state, taskId)
  } else return null
  if (state.ids.size === state.reported) return null
  state.reported = state.ids.size
  return { type: 'backgroundTasks', running: state.reported }
}
