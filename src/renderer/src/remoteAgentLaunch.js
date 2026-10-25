// Starting an agent in a pane on an SSH host (App.vue createLeaf and
// agentStartLine). Pure functions: tested in __tests__/remoteAgentLaunch.spec.js.
//
// - Which conversation id it starts with: a host's conversations live on the
//   host, never in this computer's transcripts, so "does it exist" is asked
//   there (remote:agentSessionExists). When it can't be told (not connected,
//   too slow), an id is never reused with --session-id: Claude Code refuses an
//   id in use ("Session ID ... is already in use") and the agent never starts.
// - Whether the agent is on the host (team 4's detection, remoteAgents:status,
//   every built-in agent by its command): a missing one is offered for
//   install instead of typing a command the host lacks ("Command 'codex' not
//   found", "Command 'agy' not found"). Its install: remoteAgentInstalls.js.
import { hostAgentEntry, remoteAgentFound } from './projectLauncher'

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
// (remoteAgents:status { claude, codex, vscodeClaude, agents }): by the path
// found there (~/.local/bin may not be on PATH: a fresh install there, or a
// shell started before it), else VS Code's Claude; a host never checked, a
// failed check or an agent it did not look for keeps `command`. Missing
// there: null.
const POSIX_ABS = /^\/[^'\u0000-\u001f\u007f]{1,1024}$/
export function remoteAgentLine(id, status, command) {
  if (!status || status.error) return command
  const own = hostAgentEntry(id, status)
  if (own === undefined) return command
  if (typeof own === 'string' && POSIX_ABS.test(own)) return hostPathLine(command, own)
  if (own) return command
  if (id === 'claude' && typeof status.vscodeClaude === 'string' && POSIX_ABS.test(status.vscodeClaude)) return hostPathLine(command, status.vscodeClaude)
  return null
}
// The agent's command with its program replaced by the path found
// ('/home/u/.local/bin/kiro-cli' chat --tui). In an nvm folder, an npm
// agent runs with the node next to it: that folder first on PATH, for a
// shell that did not load nvm.
const NVM_BIN = /\/\.nvm\/versions\/node\/[^/]+\/bin\/[^/]+$/
export function hostPathLine(command, path) {
  const rest = String(command || '').trim().replace(/^\S+/, '')
  const dir = path.slice(0, path.lastIndexOf('/'))
  return `${NVM_BIN.test(path) ? `PATH='${dir}':"$PATH" ` : ''}'${path}'${rest}` // i18n-ignore
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
  return /(?:^|[\s'])\/root\//.test(String(command || ''))
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

// ---- Codex's shared daemon on a host --------------------------------------------
// Codex 0.157+ runs its sessions in a shared background server (its daemon,
// started by the first `codex` of that user there). That server starts the MCP
// servers itself, with the environment of the pane that started it, and the
// next Codex joins it and its servers (seen with Codex 0.157 and 0.164 on
// Linux): tessel-team then runs as another pane, and stops with that pane's
// link ("Transport closed"). --no-daemon (Codex 0.156+) keeps a Codex and its
// servers in its own pane; older ones refuse it ("error: unexpected argument
// '--no-daemon' found") and have no daemon. -c features.daemon_auto_start=false
// is no way around it: a Codex started so still joins a daemon already running.
// The host's check says whether the Codex found there knows it
// (host.codexNoDaemon, from its --help). -> true | false | null (not known)
export function hostCodexNoDaemon(status) {
  const host = status && !status.error ? status.host : null
  return host && typeof host.codexNoDaemon === 'boolean' ? host.codexNoDaemon : null
}
// Whether the host's Codex starts with --no-daemon: unless its Codex is known
// to refuse it. Not known: with it, its refusal watched for
// (codexNoDaemonRefusalWatcher) and the line typed again without it.
export function remoteCodexNoDaemon(known) {
  return known !== false
}
export function withoutNoDaemon(line) {
  return String(line || '').replace(/ --no-daemon(?=\s|$)/, '')
}
// The refusal of an older Codex, seen in a pane's output (spaces, line breaks
// and colours ignored). -> a function fed each chunk; true (once) when it shows.
const NO_DAEMON_REFUSAL = /unexpectedargument['"‘’`]?--no-daemon/
export function codexNoDaemonRefusalWatcher() {
  let tail = ''
  let seen = false
  return (data) => {
    if (seen) return false
    tail = (tail + String(data || '').replace(ANSI, '').replace(/\s+/g, '')).slice(-600)
    if (!NO_DAEMON_REFUSAL.test(tail)) return false
    seen = true
    return true
  }
}

// The "+" menu's agents for a pane on an SSH host, as found there: ready
// when the host has it; missing, offered as Install… (never as ready):
// Claude Code, Codex and the agents installed on this computer (the ones
// you use; the others stay out of the menu, as here). Before the host was
// checked: Claude Code and Codex start there (their own check decides), the
// others as on this computer. Your own agents, and not on a host: unchanged.
// -> [{ ...agent, available, installOnHost? }]
export function hostMenuAgents(agents, { remote = false, status = null } = {}) {
  const list = Array.isArray(agents) ? agents : []
  if (!remote) return list
  return list.map((a) => {
    if (!a || a.custom) return a
    const always = a.id === 'claude' || a.id === 'codex'
    const found = remoteAgentFound(a.id, status)
    if (found === false) return { ...a, available: false, installOnHost: always || a.available !== false }
    if (found === true || always) return { ...a, available: true }
    return a
  })
}
