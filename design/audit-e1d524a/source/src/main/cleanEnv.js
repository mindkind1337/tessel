// Environment for the terminals Tessel opens.
//
// If Tessel itself was started from inside an AI agent session (say, a
// Claude Code terminal), it inherits that session's private variables. Passed
// on to every pane they would make a Claude Code started there think it is a
// sub-session (it then stops saving its conversation, so it can't be resumed)
// and would hand the parent session's messaging token to every program in the
// pane. These are removed; your own settings (API keys, CLAUDE_CODE_USE_BEDROCK,
// proxies...) are kept.

// Exact names that only describe the session that launched us.
const SESSION_VARS = new Set([
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING',
  'CLAUDE_CODE_ENABLE_TASKS',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CLAUDE_AGENT_SDK_VERSION',
  'MCP_CONNECTION_NONBLOCKING',
  'CODEX_SANDBOX',
  'CODEX_SANDBOX_NETWORK_DISABLED',
  // Tessel' own internals.
  'ELECTRON_RUN_AS_NODE',
  'TESSEL_PTYHOST_PIPE',
  'TESSEL_PTYHOST_TOKEN',
  'TESSEL_LOG_DIR'
])

export function isSessionVar(name) {
  return SESSION_VARS.has(String(name).toUpperCase())
}

// A copy of `env` without the launching session's variables.
export function cleanEnv(env) {
  const out = {}
  for (const [k, v] of Object.entries(env || {})) {
    if (!isSessionVar(k)) out[k] = v
  }
  return out
}
