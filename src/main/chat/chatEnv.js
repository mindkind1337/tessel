// The environment of a chat agent's process (claude -p behind a chat pane).
//
// `base` is what a terminal pane's shell would get (paneEnv(freshEnv(), …):
// Tessel's clean environment + the agent's and account's variables). From it
// every inherited Tessel identity and Claude session variable is dropped, so
// the child can only speak as its own pane, then that pane's identity is set.
// Deliberately NOT set: TESSEL_AGENT_PROVIDER / TESSEL_AGENT_LAUNCH /
// TESSEL_AGENT_STATE_DIR. The chat manager reports the pane's state itself;
// the child's status hooks must not write a second, competing story.
import fs from 'fs'
import { isAbsolute } from 'path'

// Claude Code variables that are the user's configuration (sign-in, provider,
// Git Bash on Windows), not a parent session's: kept. Every other
// CLAUDE_CODE_* is dropped.
export const KEPT_CLAUDE_CODE = new Set([
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_GIT_BASH_PATH'
])
const EXACT = new Set(['CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_PROJECT_DIR'])

export function isDroppedName(name) {
  const up = String(name).toUpperCase()
  if (up.startsWith('TESSEL_') || EXACT.has(up)) return true
  return up.startsWith('CLAUDE_CODE_') && !KEPT_CLAUDE_CODE.has(up)
}

function isFolder(dir) {
  try {
    return typeof dir === 'string' && isAbsolute(dir) && fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

// Windows names ignore case: setting a name removes every other spelling.
function put(env, name, value) {
  const up = name.toUpperCase()
  for (const k of Object.keys(env)) if (k.toUpperCase() === up) delete env[k]
  env[name] = value
}

// -> a new object; `base` is never changed.
export function buildChatEnv(base, { paneId, teamSecret, projectDir, pathEnv } = {}) {
  const env = {}
  for (const [k, v] of Object.entries(base || {})) {
    if (typeof v === 'string' && !isDroppedName(k)) env[k] = v
  }
  // A PATH the Claude resolver needs (e.g. its install folder first).
  if (typeof pathEnv === 'string' && pathEnv) put(env, 'PATH', pathEnv)
  if (typeof paneId === 'string' && paneId) put(env, 'TESSEL_PANE_ID', paneId)
  if (typeof teamSecret === 'string' && teamSecret) put(env, 'TESSEL_TEAM_SECRET', teamSecret)
  if (isFolder(projectDir)) put(env, 'TESSEL_PROJECT_DIR', projectDir)
  put(env, 'TESSEL_CHAT', '1')
  // system/session_state_changed frames: the adapter's 'state' events.
  put(env, 'CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS', '1')
  return env
}
