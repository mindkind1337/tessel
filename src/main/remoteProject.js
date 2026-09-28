// A project on a remote host (Add a project > Host: an SSH host): its
// terminals run ssh.exe on that host and start in the project's folder.
//
// The argv comes from remoteHosts.js (launchFor: the saved host's options and
// destination, all checked there); this adds "-t" (a terminal, for the
// interactive shell) and one remote command:
//   cd -- '<path>' && exec "$SHELL" -l
// The remote shell reads that command, so the path is single-quoted (a quote
// in it becomes '\''): nothing in the path is ever run. A leading "~" stays
// outside the quotes so the remote shell expands it to the home folder.
// Only POSIX paths are taken (absolute, "~" or "~/..."), without control
// characters. The renderer sends only the host id and the path.

const CONTROL = /[\u0000-\u001f\u007f]/
export const MAX_REMOTE_PATH = 1024

// -> { path } | { error: code }
export function validateRemotePath(raw) {
  const path = typeof raw === 'string' ? raw.trim() : ''
  if (!path) return { error: 'path-required' }
  if (path.length > MAX_REMOTE_PATH || CONTROL.test(path)) return { error: 'path-invalid' }
  if (!(path.startsWith('/') || path === '~' || path.startsWith('~/'))) return { error: 'path-not-absolute' }
  return { path }
}

// POSIX shell single quotes: everything literal; a quote closes, is escaped,
// and reopens.
export function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

// The remote command that opens a login shell in `path`.
export function remoteCdCommand(rawPath) {
  const { path, error } = validateRemotePath(rawPath)
  if (error) throw new Error(error)
  let target
  if (path === '~') target = '~'
  else if (path.startsWith('~/')) target = path.length > 2 ? `~/${shellQuote(path.slice(2))}` : '~/'
  else target = shellQuote(path)
  return `cd -- ${target} && exec "$SHELL" -l`
}

// launch: remoteHosts.launchFor(id) (ok). -> the same launch with the argv of
// a terminal in `rawPath`, or { ok: false, error: code }.
export function remoteProjectLaunch(launch, rawPath) {
  if (!launch || !launch.ok || !Array.isArray(launch.args)) return { ok: false, error: 'host-invalid' }
  const checked = validateRemotePath(rawPath)
  if (checked.error) return { ok: false, error: checked.error }
  return { ...launch, args: ['-t', ...launch.args, remoteCdCommand(checked.path)], remotePath: checked.path }
}
