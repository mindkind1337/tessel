// The permission mode a terminal agent says it is in (Claude Code's,
// OpenClaude's and Codex's hooks give it as permission_mode on each event),
// for its chat view's mode picker: the enum value only, nothing else.
//
// src/main/teamMcp/server.cjs has its own copy of these lists (it runs outside
// the application); the main process checks the value again on what it reads
// (agentStateStore.js), like a question's card (agentAsk.js).
export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions']
export const MODE_PROVIDERS = ['claude', 'openclaude', 'codex']

export const validPermissionMode = (value) => (typeof value === 'string' && PERMISSION_MODES.includes(value) ? value : null)

// The mode a spooled hook event carries, checked again: only from a lead
// (a sub-agent's may differ) of an agent with a chat view. -> the mode | null
export function eventPermissionMode(event) {
  if (!event || typeof event !== 'object' || event.permissionMode === undefined) return null
  if (event.agentId || !MODE_PROVIDERS.includes(event.provider)) return null
  return validPermissionMode(event.permissionMode)
}
