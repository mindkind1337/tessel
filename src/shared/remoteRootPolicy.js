// A folder on an SSH host that is too broad to share its files with guests
// (or to be a project's root): the host's root, "~", a system folder, a bare
// home folder, or one with fewer than two parts. Pure: the main process
// (Live Share) and the window (Add a project, the share dialog) both use it.
const SYSTEM_DIRS = [
  '/etc',
  '/root',
  '/proc',
  '/sys',
  '/dev',
  '/boot',
  '/var',
  '/usr',
  '/bin',
  '/lib',
  '/lib64',
  '/sbin',
  '/run',
  '/opt',
  '/srv',
  '/tmp',
  '/home',
  '/Users'
]
export const isBareRemoteHome = (path) => /^\/(home|Users)\/[^/]+\/?$/.test(String(path || ''))

export function remoteRootTooBroad(path) {
  const raw = String(path || '').trim()
  if (!raw) return true
  const p = raw.replace(/\/+$/, '') || '/'
  if (p === '~' || p === '/') return true
  if (p.startsWith('~/')) return p.slice(2).split('/').filter(Boolean).length < 1
  if (!p.startsWith('/')) return true
  return p.split('/').filter(Boolean).length < 2 || SYSTEM_DIRS.includes(p) || isBareRemoteHome(p)
}
