// A folder on an SSH host that is too broad to share its files with guests
// (or to be a project's root): the host's root, "~", a system folder or
// anything below one, a bare home folder, a home's secret folders (~/.ssh,
// ~/.aws, ~/.gnupg, ~/.config...) or one with fewer than two parts. Pure: the
// main process (Live Share) and the window (Add a project, the share dialog)
// both use it. Compared without case; main checks the real path of the
// project folder too (a link to a broad folder).
const SYSTEM_DIRS = ['/home', '/users', '/opt', '/srv', '/tmp', '/mnt', '/media', '/var', '/usr']
// These folders and everything below them belong to the system.
const SYSTEM_TREES = new Set([
  'etc',
  'var',
  'usr',
  'lib',
  'lib32',
  'lib64',
  'libx32',
  'bin',
  'sbin',
  'boot',
  'proc',
  'sys',
  'dev',
  'root',
  'run'
])
const HOME_SECRETS = new Set([
  '.ssh',
  '.aws',
  '.gnupg',
  '.config',
  '.kube',
  '.docker',
  '.azure',
  '.gcloud'
])
export const isBareRemoteHome = (path) => /^\/(home|users)\/[^/]+\/?$/i.test(String(path || ''))

// A project folder's real path against the host's own $HOME (wherever it
// is: /var/lib/fivem, /opt/app...): the home itself, a folder holding it, or
// one of its secret folders (and below) is too broad to share.
export function remoteRootTooBroadForHome(real, home) {
  const r = String(real || '').replace(/\/+$/, '') || '/'
  const h = String(home || '').replace(/\/+$/, '') || '/'
  if (!real || !home || !h.startsWith('/') || !r.startsWith('/')) return false
  if (r === h || r === '/' || h.startsWith(`${r}/`)) return true
  if (r.startsWith(`${h}/`)) return HOME_SECRETS.has(r.slice(h.length + 1).split('/')[0].toLowerCase())
  return false
}

export function remoteRootTooBroad(path) {
  const raw = String(path || '').trim()
  if (!raw) return true
  const p = raw.replace(/\/+$/, '').toLowerCase() || '/'
  if (p === '~' || p === '/') return true
  const segs = p.split('/').filter(Boolean)
  if (p.startsWith('~/')) return segs.length < 2 || HOME_SECRETS.has(segs[1])
  if (!p.startsWith('/')) return true
  if (segs.length < 2 || SYSTEM_DIRS.includes(p) || isBareRemoteHome(p)) return true
  if (SYSTEM_TREES.has(segs[0])) return true
  // /home/me/.ssh and the like, at any depth below a home.
  if ((segs[0] === 'home' || segs[0] === 'users') && segs.length >= 3 && HOME_SECRETS.has(segs[2]))
    return true
  return false
}
