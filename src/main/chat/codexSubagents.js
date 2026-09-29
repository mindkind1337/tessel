// app-server v2 collabAgentToolCall / subAgentActivity items. A completed spawn
// or wait CALL does not mean the child completed: only agentsStates does.
import { subagentId } from './subagents.js'
const STATES = new Map([
  ['pendingInit', 'working'],
  ['running', 'working'],
  ['interrupted', 'stopped'],
  ['completed', 'completed'],
  ['errored', 'failed'],
  ['shutdown', 'stopped'],
  ['notFound', 'unverifiable']
])
export function observeCodexSubagents(method, params, state) {
  const out = [],
    item = params.item
  if (!item || !['item/started', 'item/completed'].includes(method)) return out
  const tracker = state.subagents
  const groupId = subagentId(params.turnId) || subagentId(state.turn?.id) || subagentId(item.id)
  if (!groupId) return out
  if (item.type === 'collabAgentToolCall') {
    if (item.senderThreadId && state.threadId && item.senderThreadId !== state.threadId) return out
    const statuses =
      item.agentsStates && typeof item.agentsStates === 'object' ? item.agentsStates : {}
    const ids = [
      ...new Set([
        ...(Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []),
        ...Object.keys(statuses)
      ])
    ].slice(0, 64)
    for (const id of ids) {
      if (!subagentId(id) || id === state.threadId) continue
      const known = tracker.get(id),
        status = STATES.get(statuses[id]?.status)
      const spawn = item.tool === 'spawnAgent' || item.tool === 'spawn_agent'
      const fields = {
        state: status,
        ...(spawn
          ? {
              description: item.prompt,
              model: item.model,
              subagentType: item.agentType || item.agentRole || 'subagent',
              parentToolUseId: item.id
            }
          : {})
      }
      // A failed call without child verdict does not prove the child's outcome.
      if (!status && spawn && item.status === 'failed') fields.state = 'unverifiable'
      tracker.upsert(id, known?.groupId || groupId, fields, out)
    }
  } else if (item.type === 'subAgentActivity' && subagentId(item.agentThreadId)) {
    const id = item.agentThreadId,
      known = tracker.get(id)
    if (id === state.threadId) return out
    const status =
      item.kind === 'completed' ? 'completed' : item.kind === 'interrupted' ? 'stopped' : 'working'
    tracker.upsert(
      id,
      known?.groupId || groupId,
      {
        state: status,
        description: known?.description || item.agentPath,
        parentToolUseId: known?.parentToolUseId || item.id
      },
      out
    )
  }
  return out
}
