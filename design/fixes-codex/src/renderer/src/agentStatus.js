// Live agent state keyed by pane id, kept out of the layout tree so these flips
// never trigger a layout save.
//   agentStatus[id]  -> 'busy' | 'idle'   (TerminalPane writes it)
//   attention[id]    -> true when an agent finished a stretch of work while you
//                       were looking elsewhere, i.e. it is waiting on you.
//   limits[id]       -> { reset } when the agent has hit its usage limit
//                       (see agentLimit.js); reset is its reset time or ''.
//   approvals[id]    -> true while the agent shows an approval prompt
//                       ("Would you like to run...", see agentLimit.js).
// The workspace sidebar reads both to badge workspaces.
import { reactive } from 'vue'

export const agentStatus = reactive({})
export const attention = reactive({})
export const limits = reactive({})
export const approvals = reactive({})

export function setApproval(id, on) {
  if (on) approvals[id] = true
  else if (approvals[id]) delete approvals[id]
}

export function setLimit(id, info) {
  // Keep a reset time already known when this read of the screen shows none.
  const reset = (info && info.reset) || (limits[id] && limits[id].reset) || ''
  limits[id] = { reset }
}

export function clearLimit(id) {
  if (limits[id]) delete limits[id]
}

export function setAgentStatus(id, status) {
  if (agentStatus[id] !== status) agentStatus[id] = status
}

export function setAttention(id) {
  attention[id] = true
}

export function clearAttention(id) {
  if (attention[id]) delete attention[id]
}

export function clearAgentStatus(id) {
  delete agentStatus[id]
  delete attention[id]
  delete limits[id]
  delete approvals[id]
}
