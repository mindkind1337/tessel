// Starting an agent in a pane on an SSH host (App.vue createLeaf and
// agentStartLine). Pure functions: tested in __tests__/remoteAgentLaunch.spec.js.
//
// - Which conversation id it starts with: a host's conversations live on the
//   host, never in this computer's transcripts, so "does it exist" is asked
//   there (remote:agentSessionExists). When it can't be told (not connected,
//   too slow), an id is never reused with --session-id: Claude Code refuses an
//   id in use ("Session ID ... is already in use") and the agent never starts.
// - Whether the agent is on the host (team 4's detection, remoteAgents:status):
//   a missing one is offered for install instead of typing a command the
//   host lacks ("Command 'codex' not found").
import { remoteAgentFound } from './projectLauncher'

// Claude Code / OpenClaude: resume the pane's conversation, start fresh with
// its id, or start fresh with a new id. exists: true / false, or null when it
// could not be checked.
// -> { resume: boolean, id }
export function claudeStartChoice({ sessionId = null, resume = false, exists = null, newId } = {}) {
  // Resuming one that exists, or might (an id never reused blindly).
  if (sessionId && resume && exists !== false) return { resume: true, id: sessionId }
  // Never written to (no transcript): the same id is free.
  if (sessionId && exists === false) return { resume: false, id: sessionId }
  // Not resuming one that exists, or can't tell: a new id.
  return { resume: false, id: newId() }
}

// Codex: `codex resume <id>` unless the host says its rollout is not there
// (then a fresh `codex`; Codex picks its own id). Never an id reused.
export function codexResumes({ sessionId = null, resume = false, exists = null } = {}) {
  return !!(sessionId && resume && exists !== false)
}

// The command typed to start agent `id` on a host, from its last check
// (remoteAgents:status { claude, codex, vscodeClaude }): by the path found
// there (~/.local/bin may not be on PATH), else VS Code's Claude; a host
// never checked (or a failed check) keeps `command`. Missing there: null.
const POSIX_ABS = /^\/[^'\u0000-\u001f\u007f]{1,1024}$/
export function remoteAgentLine(id, status, command) {
  if (!status || status.error) return command
  const own = id === 'claude' ? status.claude : id === 'codex' ? status.codex : undefined
  if (own === undefined) return command
  if (typeof own === 'string' && POSIX_ABS.test(own)) return `'${own}'`
  if (own) return command
  if (id === 'claude' && typeof status.vscodeClaude === 'string' && POSIX_ABS.test(status.vscodeClaude)) return `'${status.vscodeClaude}'`
  return null
}

// Whether to ask the host again before typing the agent's command: missing
// in the last check (installed since?), or never checked while the host is
// connected (a check never signs in by itself).
export function needsRemoteAgentCheck(id, status, { connected = false } = {}) {
  const found = remoteAgentFound(id, status)
  if (found === true) return false
  if (found === false) return true
  return !!connected
}

// The official installs on a Linux / macOS host, run in a new pane there
// after you confirm (shown exactly as typed).
// - Claude Code: its installer puts it in ~/.local/bin (which PATH may lack),
//   then it starts to show its sign-in link.
// - Codex CLI: npm when the host has it (`npm install -g @openai/codex`),
//   else OpenAI's standalone installer (Codex README).
export const REMOTE_INSTALL_COMMANDS = {
  claude: 'curl -fsSL https://claude.ai/install.sh | bash && ~/.local/bin/claude', // i18n-ignore shell command
  codex: 'if command -v npm >/dev/null 2>&1; then npm install -g @openai/codex; else curl -fsSL https://chatgpt.com/codex/install.sh | sh; fi' // i18n-ignore shell command
}
export function remoteInstallCommand(id) {
  return Object.prototype.hasOwnProperty.call(REMOTE_INSTALL_COMMANDS, id) ? REMOTE_INSTALL_COMMANDS[id] : null
}

// The "+" menu's agents for a pane on an SSH host: Claude Code and Codex as
// found there (missing: offered as Install…, never as ready); the others as
// on this computer. Not on a host: unchanged.
// -> [{ ...agent, available, installOnHost? }]
export function hostMenuAgents(agents, { remote = false, status = null } = {}) {
  const list = Array.isArray(agents) ? agents : []
  if (!remote) return list
  return list.map((a) => {
    if (!a || (a.id !== 'claude' && a.id !== 'codex')) return a
    const found = remoteAgentFound(a.id, status)
    if (found === false) return { ...a, available: false, installOnHost: true }
    // Found there, or not checked yet: started there (its own install, not
    // this computer's, decides).
    return { ...a, available: true }
  })
}
