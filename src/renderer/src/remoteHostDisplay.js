// How a saved SSH host and a folder on it read in the interface: the host
// picker of Add a project and the sidebar's remote cards. Only what the
// saved record says (remote-hosts.json): never `ssh -G`, never a password,
// a key path or a proxy command.

export const DEFAULT_SSH_PORT = 22

function str(v) {
  return typeof v === 'string' ? v.trim() : ''
}

// user@host[:port]. The port shows when it is not 22, or always with
// { port: true } (tooltips).
export function hostAddress(target, { port: alwaysPort = false } = {}) {
  if (!target || typeof target !== 'object') return ''
  const host = str(target.host) || str(target.configHost)
  if (!host) return ''
  const user = str(target.username)
  const p = Number(target.port) || DEFAULT_SSH_PORT
  const withPort = alwaysPort || p !== DEFAULT_SSH_PORT
  // An IPv6 address takes brackets before a port.
  const h = withPort && host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  return `${user ? `${user}@` : ''}${h}${withPort ? `:${p}` : ''}`
}

// The host's default remote folder, when the saved record has one.
export function hostFolder(target) {
  if (!target || typeof target !== 'object') return ''
  return str(target.defaultPath) || str(target.remotePath)
}

// /home/<user>/x -> ~/x (and /root for root), when the user is known.
export function homeRelative(path, user = '') {
  const p = str(path)
  const u = str(user)
  if (!p || !u) return p
  const home = u === 'root' ? '/root' : `/home/${u}` // i18n-ignore
  if (p === home) return '~'
  if (p.startsWith(home + '/')) return '~' + p.slice(home.length)
  return p
}

// A short form of a folder on the host: its first folder and its last one,
// ~/FXServer/server-data/resources -> ~/FXServer/…/resources.
export function shortRemotePath(path, user = '') {
  const p = homeRelative(path, user).replace(/\/+$/, '') || (str(path).startsWith('/') ? '/' : '')
  if (!p || p === '/' || p === '~') return p
  const tilde = p === '~' || p.startsWith('~/')
  const prefix = tilde ? '~/' : p.startsWith('/') ? '/' : ''
  const parts = p.slice(tilde ? 2 : prefix.length).split('/').filter(Boolean)
  if (parts.length <= 2) return p
  return `${prefix}${parts[0]}/…/${parts[parts.length - 1]}`
}

// The width of a host list (Add a project): the width of what it opens
// under (the dialog's content), between min and max, and never wider than
// the window less its margins.
export const HOST_LIST_MIN_WIDTH = 460
export const HOST_LIST_MAX_WIDTH = 640
export function hostListWidth(anchorWidth, viewportWidth, { min = HOST_LIST_MIN_WIDTH, max = HOST_LIST_MAX_WIDTH, margin = 8 } = {}) {
  const want = Math.min(max, Math.max(min, Number(anchorWidth) || 0))
  return Math.max(0, Math.min(want, (Number(viewportWidth) || 0) - 2 * margin))
}
