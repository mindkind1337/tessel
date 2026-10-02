// Live agent state keyed by pane id, kept out of the layout tree so these flips
// never trigger a layout save.
//   agentStatus[id]  -> 'busy' | 'idle'   (TerminalPane writes it)
//   attention[id]    -> true when an agent finished a stretch of work while you
//                       were looking elsewhere, i.e. it is waiting on you.
// The workspace sidebar reads both to badge workspaces.
import { reactive } from 'vue'

export const agentStatus = reactive({})
export const attention = reactive({})

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
}
