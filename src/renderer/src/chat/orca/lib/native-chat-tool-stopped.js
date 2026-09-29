// Tessel (not in Orca): a tool call the agent's stop cut short. The reference's
// calls are running | completed | failed; Tessel's engine also knows a call
// that was stopped mid-run, whose outcome is unknown: it reads "Stopped",
// neither failed nor running (chatMessage.spec 'ChatToolRow').
const STOPPED_TOOL_STATES = new Set(['stopped', 'interrupted', 'cancelled', 'canceled'])

export function isStoppedToolCall(block) {
  return block?.type === 'tool-call' && STOPPED_TOOL_STATES.has(block.state)
}
