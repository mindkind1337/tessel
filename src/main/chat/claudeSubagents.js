// Claude stream-json observations; no control/approval frames are consumed here.
import { createSubagentTracker, subagentId, subagentTokens } from './subagents.js'
const record = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {})
const taskStates = new Map([
  ['completed', 'completed'],
  ['failed', 'failed'],
  ['killed', 'stopped'],
  ['stopped', 'stopped'],
  ['interrupted', 'stopped']
])
const taskState = (value) => taskStates.get(value)
export function createClaudeSubagents(now = Date.now) {
  return {
    tracker: createSubagentTracker(now),
    aliases: new Map(),
    messages: new Map(),
    background: new Set(),
    groupId: null
  }
}
export function observeClaudeSubagents(m, state) {
  const data = state.subagents,
    out = [],
    tracker = data.tracker
  const parent = subagentId(m.parent_tool_use_id)
  const parentId = parent && (data.aliases.get(parent) || parent)
  const msg = record(m.message)
  const group = () =>
    tracker.get(parentId)?.groupId || data.groupId || subagentId(msg.id) || parentId
  const ensure = (id) =>
    tracker.get(id) || tracker.upsert(id, group() || id, { parentToolUseId: id }, out)
  function background(id) {
    if (data.background.size >= 4096) data.background.delete(data.background.values().next().value)
    data.background.add(id)
  }
  function alias(from, to) {
    if (!subagentId(from) || !subagentId(to)) return
    if (data.aliases.size >= 4096) data.aliases.delete(data.aliases.keys().next().value)
    data.aliases.set(from, to)
  }
  if (
    !parent &&
    m.type === 'command_lifecycle' &&
    m.state === 'started' &&
    subagentId(m.command_uuid)
  )
    data.groupId ||= m.command_uuid
  if (!parent && m.type === 'assistant' && subagentId(msg.id)) data.groupId ||= msg.id
  if (parentId && ['assistant', 'stream_event', 'user'].includes(m.type)) ensure(parentId)
  if (m.type === 'assistant') {
    if (parentId)
      tracker.upsert(
        parentId,
        group() || parentId,
        { model: msg.model, tokens: subagentTokens(msg.usage) },
        out
      )
    for (const block of Array.isArray(msg.content) ? msg.content : []) {
      if (block?.type !== 'tool_use' || !subagentId(block.id)) continue
      if (parentId)
        tracker.progress(parentId, { id: block.id, name: block.name, status: 'running' }, out)
      if (block.name !== 'Task' && block.name !== 'Agent') continue
      const input = record(block.input)
      const id = data.aliases.get(block.id) || block.id
      tracker.upsert(
        id,
        group() || block.id,
        {
          description: input.description || input.name,
          subagentType: input.subagent_type || input.type,
          model: input.model,
          parentToolUseId: parent || undefined
        },
        out
      )
      alias(block.id, id)
      if (input.run_in_background === true) background(id)
    }
  }
  if (m.type === 'stream_event' && parentId && m.event?.type === 'message_start') {
    const id = subagentId(m.event.message?.id)
    if (id) {
      if (data.messages.size >= 4096) data.messages.delete(data.messages.keys().next().value)
      data.messages.set(parentId, id)
    }
  }
  if (m.type === 'user' && !m.isReplay) {
    const details = record(m.tool_use_result)
    for (const block of Array.isArray(msg.content) ? msg.content : []) {
      if (block?.type !== 'tool_result') continue
      const id = data.aliases.get(block.tool_use_id) || block.tool_use_id
      if (parentId)
        tracker.progress(
          parentId,
          { id: block.tool_use_id, status: block.is_error ? 'failed' : 'completed' },
          out
        )
      const entry = tracker.get(id)
      if (!entry) continue
      if (details.status === 'async_launched' || details.isAsync === true) background(id)
      const ended = block.is_error || !data.background.has(id)
      tracker.upsert(
        id,
        entry.groupId,
        {
          ...(ended ? { state: block.is_error ? 'failed' : 'completed' } : {}),
          tokens: subagentTokens(details.usage) ?? details.totalTokens,
          durationMs: details.totalDurationMs ?? details.duration_ms
        },
        out
      )
    }
  }
  if (
    m.type === 'system' &&
    ['task_started', 'task_updated', 'task_progress', 'task_notification'].includes(m.subtype)
  ) {
    const patch = record(m.patch),
      task = subagentId(m.task_id),
      tool = subagentId(m.tool_use_id || patch.tool_use_id)
    const id = (task && data.aliases.get(task)) || (tool && (data.aliases.get(tool) || tool))
    const entry = id && tracker.get(id)
    const isAgent =
      m.task_type === 'local_agent' ||
      m.task_type === 'agent' ||
      (m.task_type == null && typeof m.subagent_type === 'string')
    if (
      id &&
      (entry || (m.subtype === 'task_started' && isAgent && !m.ambient && !m.skip_transcript))
    ) {
      alias(task, id)
      alias(tool, id)
      const usage = record(m.usage)
      tracker.upsert(
        id,
        entry?.groupId || data.groupId || tool,
        {
          description: m.description || patch.description,
          subagentType: m.subagent_type,
          model: m.model,
          state: taskState(m.status || patch.status),
          tokens: subagentTokens(usage),
          durationMs: usage.duration_ms ?? m.duration_ms
        },
        out
      )
    }
  }
  if (m.type === 'result') {
    const status =
      String(m.terminal_reason || '').startsWith('aborted') ||
      (state.interruptRequested && m.subtype !== 'success')
        ? 'interrupted'
        : m.subtype === 'success' && !m.is_error
          ? 'completed'
          : 'failed'
    if (parentId) {
      const entry = ensure(parentId)
      if (entry)
        tracker.upsert(
          parentId,
          entry.groupId,
          {
            state: status === 'interrupted' ? 'stopped' : status,
            tokens: subagentTokens(m.usage),
            durationMs: m.duration_ms
          },
          out
        )
    } else {
      tracker.settle(data.groupId, status, out)
      data.groupId = null
    }
  }
  return {
    out,
    agentId: parentId && tracker.get(parentId) ? parentId : null,
    childMessageId: parentId ? data.messages.get(parentId) || msg.id || null : null
  }
}
