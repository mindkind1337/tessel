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

// ---- Claude Code's Yolo as root ----------------------------------------------
// Claude Code refuses --dangerously-skip-permissions as root ("cannot be used
// with root/sudo privileges for security reasons") and never starts. On a host
// signed in as root it starts in Accept edits instead, the closest mode it
// allows there (a chat's own --permission-mode kept). Never IS_SANDBOX or any
// other bypass: that is for real sandboxes, and yours to choose.
// Codex's --dangerously-bypass-approvals-and-sandbox has no such check.
export const CLAUDE_YOLO_FLAG = '--dangerously-skip-permissions'
export const ROOT_PERMISSION_MODE = 'acceptEdits'

// Whether a host's sessions run as root: its saved user is root, its agent
// check says uid 0 (when the check reports it), or the agent found there is
// in root's home (/root/...).
export function hostRunsAsRoot({ username = '', status = null, command = '' } = {}) {
  if (String(username || '').trim() === 'root') return true
  if (status && !status.error && (status.uid === 0 || status.user === 'root')) return true
  return /^'?\/root\//.test(String(command || ''))
}

// Whether these arguments carry Claude Code's Yolo flag (refused as root).
export function hasClaudeYoloFlag(args) {
  return /(^|\s)--dangerously-skip-permissions(?=\s|$)/.test(String(args || ''))
}

// The arguments without the Yolo flag, in Accept edits unless they (or the
// chat's mode) already set a permission mode.
export function rootSafeClaudeArgs(args, mode = null) {
  const rest = String(args || '')
    .replace(/(^|\s+)--dangerously-skip-permissions(?=\s|$)/g, '')
    .trim()
  if (/--permission-mode\b/.test(rest)) return rest
  return [rest, `--permission-mode ${mode || ROOT_PERMISSION_MODE}`].filter(Boolean).join(' ') // i18n-ignore
}

// Claude Code's refusal, seen in a pane's output (the safety net when root was
// not known before: a host with no saved user). Spaces and line breaks are
// ignored (the terminal may wrap the line), as are colours.
const ROOT_REFUSAL = '--dangerously-skip-permissionscannotbeusedwithroot/sudoprivileges'
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g
// -> a function fed each chunk of output; true (once) when the refusal shows.
export function rootRefusalWatcher() {
  let tail = ''
  let seen = false
  return (data) => {
    if (seen) return false
    tail = (tail + String(data || '').replace(ANSI, '').replace(/\s+/g, '')).slice(-600)
    if (!tail.includes(ROOT_REFUSAL)) return false
    seen = true
    return true
  }
}

// The official installs on a Linux / macOS host, run in a new pane there
// after you confirm (shown exactly as typed). Never as root: most servers'
// global npm folder (/usr/local/lib/node_modules) is root's (EACCES).
// - Claude Code: its installer puts it in ~/.local/bin (which PATH may lack),
//   then it starts to show its sign-in link.
// - Codex CLI: npm when the host has it, into ~/.local (its binary in
//   ~/.local/bin/codex, where the host check looks), else OpenAI's
//   standalone installer (Codex README).
export const REMOTE_INSTALL_COMMANDS = {
  claude: 'curl -fsSL https://claude.ai/install.sh | bash && ~/.local/bin/claude', // i18n-ignore shell command
  codex: 'if command -v npm >/dev/null 2>&1; then npm install -g --prefix "$HOME/.local" @openai/codex; else curl -fsSL https://chatgpt.com/codex/install.sh | sh; fi' // i18n-ignore shell command
}
export function remoteInstallCommand(id) {
  return Object.prototype.hasOwnProperty.call(REMOTE_INSTALL_COMMANDS, id) ? REMOTE_INSTALL_COMMANDS[id] : null
}
// Installed from a pane that waits for the agent (its "not installed" card):
// the install alone (that pane starts the agent, Claude Code's sign-in there
// too), then its shell ends with 0 when it worked, so Tessel checks the host
// again; a failure leaves the shell open with its error.
const PANE_INSTALL_COMMANDS = {
  claude: 'curl -fsSL https://claude.ai/install.sh | bash && exit', // i18n-ignore shell command
  codex: REMOTE_INSTALL_COMMANDS.codex + ' && exit' // i18n-ignore shell command
}
export function remotePaneInstallCommand(id) {
  return Object.prototype.hasOwnProperty.call(PANE_INSTALL_COMMANDS, id) ? PANE_INSTALL_COMMANDS[id] : null
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
