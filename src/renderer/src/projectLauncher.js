// What a project shows when it has no pane (ProjectLauncher.vue): a new
// project (this computer or an SSH host), a project whose last pane was
// closed, or one restored empty. Instead of a shell nobody asked for, the
// launcher asks which program to start: an installed agent (on an SSH host,
// the agents found there), a terminal (with its shell), a browser page, or a
// recent conversation of the project to resume. Settings > Agents "When a
// project opens" can skip the question (settings.projectOpen):
//   'ask'                the launcher (default)
//   'terminal'           a terminal in the default shell
//   'terminal:<shellId>' a terminal in that shell (on an SSH host: its login shell)
//   'agent:<agentId>'    that agent
// Pure functions: App.vue and the launcher use them.
import { filterSessions } from './sessionHistory'

export const PROJECT_OPEN_DEFAULT = 'ask'
const PROJECT_OPEN = /^(ask|terminal|terminal:[\w.-]{1,60}|agent:[\w.-]{1,60})$/

export function validProjectOpen(v) {
  return typeof v === 'string' && PROJECT_OPEN.test(v)
}

// The agents Tessel can start on an SSH host (team 4's detection,
// remoteAgents:status: { claude, codex, vscodeClaude }).
export const REMOTE_AGENT_IDS = ['claude', 'codex']

// Is this agent on the host? true / false, or null: not checked yet (the
// host was not connected since Tessel started; nothing connects to ask).
export function remoteAgentFound(id, status) {
  if (!status || status.error) return null
  if (id === 'claude') return !!(status.claude || status.vscodeClaude)
  if (id === 'codex') return !!status.codex
  return false
}

// The agents the launcher offers: here, the installed and enabled ones; on
// an SSH host, the ones found there (both, marked unchecked, before the
// host was checked). -> [{ id, name, accent, unchecked }]
export function launcherAgents({ agents = [], remote = false, remoteStatus = null, enabled = () => true } = {}) {
  const list = Array.isArray(agents) ? agents : []
  if (!remote)
    return list
      .filter((a) => a && a.available !== false && enabled(a.id))
      .map((a) => ({ id: a.id, name: a.name, accent: a.accent || null, unchecked: false }))
  const out = []
  for (const id of REMOTE_AGENT_IDS) {
    const a = list.find((x) => x && x.id === id)
    if (!a || !enabled(id)) continue
    const found = remoteAgentFound(id, remoteStatus)
    if (found === false) continue
    out.push({ id, name: a.name, accent: a.accent || null, unchecked: found === null })
  }
  return out
}

// The shells a terminal can open in here, the default one first. On an SSH
// host: none to choose (its login shell).
export function launcherShells({ shells = [], selectedShell = null, remote = false } = {}) {
  if (remote || !Array.isArray(shells)) return []
  const list = shells.filter((s) => s && s.id)
  const def = list.find((s) => s.id === selectedShell)
  return def ? [def, ...list.filter((s) => s !== def)] : list
}

// What a new project starts by itself (the setting), or null: the launcher.
// An agent that is not here (or, on an SSH host, was found missing there)
// asks instead; a shell gone since falls back to the default shell.
// -> null | { kind: 'terminal', shellId } | { kind: 'agent', id }
export function projectOpenChoice(setting, { agents = [], shells = [], remote = false, remoteStatus = null, enabled = () => true } = {}) {
  if (!validProjectOpen(setting) || setting === 'ask') return null
  if (setting === 'terminal') return { kind: 'terminal', shellId: null }
  const [kind, id] = setting.split(':')
  if (kind === 'terminal') return { kind: 'terminal', shellId: !remote && shells.some((s) => s && s.id === id) ? id : null }
  const offered = launcherAgents({ agents, remote, remoteStatus, enabled })
  return offered.some((a) => a.id === id) ? { kind: 'agent', id } : null
}

// The setting a launcher choice is remembered as ("Remember for new
// projects"), or null when it is not one a project can start by itself
// (a browser page, a conversation to resume).
export function rememberedValue(choice, { remote = false } = {}) {
  if (!choice) return null
  if (choice.kind === 'agent' && typeof choice.id === 'string') {
    const v = `agent:${choice.id}` // i18n-ignore
    return validProjectOpen(v) ? v : null
  }
  if (choice.kind === 'terminal') {
    if (remote || !choice.shellId) return 'terminal'
    const v = `terminal:${choice.shellId}` // i18n-ignore
    return validProjectOpen(v) ? v : 'terminal'
  }
  return null
}

// A project whose last pane closed (or was moved away): a fresh terminal,
// as before, when "When a project opens" is a terminal; else the launcher
// (an agent is never started by closing a pane).
// -> { kind: 'terminal', shellId } | null (the launcher)
export function emptiedWorkspaceChoice(setting, { shells = [], remote = false } = {}) {
  if (!validProjectOpen(setting) || !setting.startsWith('terminal')) return null
  return projectOpenChoice(setting, { shells, remote })
}

// The project's recent conversations (Agent Session History's rows, from
// sessions:list or an SSH host's sessions:listRemote): those in its folder
// and below, newest first.
export function recentProjectSessions(sessions, dir, limit = 5) {
  if (!dir) return []
  return filterSessions(sessions, { scope: 'project', cwd: dir }).slice(0, limit)
}

// ssh's own failure code: the connection to the host dropped (ssh.exe and
// Tessel's ssh2 terminals both end with it).
export const SSH_DROPPED = 255

// A pane on an SSH host whose terminal ended because the connection
// dropped: it waits for the host again (and reopens with it) instead of
// staying exited. Not one closed or disconnected on purpose, nor a pane
// already waiting, asleep or failed.
export function droppedRemotePane(leaf, { exitCode, pid = null, userDisconnected = false } = {}) {
  if (!leaf || leaf.type !== 'leaf' || !leaf.remoteHostId) return false
  if (leaf.kind !== 'shell' && leaf.kind !== 'agent') return false
  if (leaf.notConnected || leaf.sleeping || leaf.failed || leaf.closing) return false
  if (pid && leaf.pid && pid !== leaf.pid) return false
  if (userDisconnected) return false
  return exitCode === SSH_DROPPED
}

// Reopened by itself at most this many times in RETRY_WINDOW_MS (a host
// that drops it again at once is left as it is, its exit shown).
export const DROP_RETRIES = 3
export const DROP_RETRY_WINDOW_MS = 5 * 60_000
export function allowDropRetry(times = [], now = Date.now()) {
  const recent = (Array.isArray(times) ? times : []).filter((at) => now - at < DROP_RETRY_WINDOW_MS)
  return { ok: recent.length < DROP_RETRIES, times: recent.length < DROP_RETRIES ? [...recent, now] : recent }
}
