// Agents on an SSH host (remoteAgent/REMOTE_AGENTS.md): why one has no
// Tessel tools there, in words for its pane ("Tessel tools are not connected
// on <host>: <reason>", App.vue noteRemoteToolsMissing). Pure, for the tests.
// t: main's i18n; noNodeError: nodePath.js's text for no node on this computer.
export function remoteToolsReason(t, reason, detail = '', { noNodeError = () => '' } = {}) {
  // eslint-disable-next-line no-control-regex
  const more = String(detail || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 200)
  if (reason === 'no-node') return t('main.remoteAgent.reason.noNode', 'Node.js 18 or newer was not found on the host (Tessel also looks for the copy of VS Code Remote-SSH). Install Node.js there, then Retry.')
  if (reason === 'old-node') return t('main.remoteAgent.reason.oldNode', 'Node.js on the host is older than 18. Update it there, then Retry.')
  if (reason === 'timeout') return t('main.remoteAgent.reason.timeout', 'setting them up on the host took too long.')
  if (reason === 'old-host') return t('main.remoteAgent.reason.oldHost', "Tessel's terminal host was started by an older version. Quit Tessel completely and start it again.")
  if (reason === 'local-node') return noNodeError()
  if (reason === 'system-ssh') return t('main.remoteAgent.reason.systemSsh', 'this host is opened with the system ssh (a jump host or a proxy), which cannot carry them yet.')
  if (reason === 'skipped') return t('main.remoteAgent.reason.skipped', '{{agent}} has no settings on the host yet. Start it there once, then Retry.', { agent: detail === 'codex' ? 'Codex' : 'Claude Code' })
  // The tunnel in the terminal host (remote-tools events).
  if (reason === 'bind') return t('main.remoteAgent.reason.bind', "the host's sshd refused to forward Tessel's socket (AllowStreamLocalForwarding or DisableForwarding in its sshd_config).")
  if (reason === 'prep' || reason === 'home') return t('main.remoteAgent.reason.prep', "Tessel's folder on the host (~/.tessel-server) could not be prepared.")
  if (reason === 'env') return t('main.remoteAgent.reason.env', "the pane's Tessel settings could not be written on the host.")
  if (reason === 'tunnel-timeout') return t('main.remoteAgent.reason.tunnelTimeout', "Tessel's socket on the host was not ready in time.")
  if (reason === 'config') return t('main.remoteAgent.reason.config', 'its settings on the host could not be updated ({{detail}}).', { detail: more })
  return more ? t('main.remoteAgent.reason.failedDetail', 'they could not be set up on the host ({{detail}}).', { detail: more }) : t('main.remoteAgent.reason.failed', 'they could not be set up on the host.')
}
// The codes the terminal host's tunnel sends (remote-tools events).
export const REMOTE_TOOLS_CODES = new Set(['bind', 'prep', 'home', 'env', 'tunnel-timeout', 'failed'])
// The install's error about the file that registers this agent's MCP server
// (~/.claude.json, ~/.codex/config.toml): its tools were not registered.
export function remoteInstallErrorFor(result, provider) {
  const errors = result && Array.isArray(result.errors) ? result.errors : []
  const mine = provider === 'codex' ? /\/\.codex\/config\.toml:/ : /\/\.claude\.json:/
  return errors.find((e) => typeof e === 'string' && mine.test(e)) || ''
}
