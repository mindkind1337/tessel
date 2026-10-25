// A folder too broad, or the system's, to be a project's root: its files are
// read and written by agents and, shared in Live Share, by guests. Pure: the
// window (a project added or moved, renderer/src/addProject.js) and the main
// process (Live Share, on the project's real path: liveShare.js cleanRoot,
// liveShare/shareScope.js rootInfo) both use it, so the guests' rule never
// depends on the window.
//
// POSIX (macOS, Linux, a WSL distribution, an SSH host): the filesystem root,
// the system folders, the folder of all homes, the kernel's trees (/proc,
// /sys, /dev), a Windows drive mounted in WSL (/mnt/c; inside it, the
// Windows rule). A project folder inside a system folder (/etc/nginx,
// /opt/app) or a top folder of its own (/app, /workspace) is fine.
// Windows: a drive's root, C:\Windows and all inside, the drive's system
// folders (Program Files, ProgramData, Users...), a server without a share,
// an administrative share (\\host\c$: its drive's rule), the device and
// long-path forms, a WSL distribution's root (\\wsl$\Ubuntu: the POSIX rule).
// Compared without case (macOS and Windows volumes).
const POSIX_BROAD = new Set(
  ('/ /bin /boot /dev /etc /home /lib /lib32 /lib64 /libx32 /lost+found /media /mnt /opt /proc /run /sbin /snap /srv /sys /tmp ' +
    '/usr /usr/bin /usr/lib /usr/local /usr/sbin /usr/share /var /var/lib /var/log /var/tmp /users /volumes /system /library /applications ' +
    '/private /private/etc /private/tmp /private/var /cores').split(' ')
)
const WIN_SYSTEM_DIR = /^[a-z]:\\(windows|program files|program files \(x86\)|programdata|users|\$recycle\.bin|system volume information|recovery|perflogs|config\.msi)$/i

// A Windows drive mounted in WSL (/mnt/c/...): its Windows path, else null.
function wslDrive(p) {
  const m = /^\/mnt\/([a-z])(\/.*)?$/i.exec(p)
  return m ? `${m[1]}:\\${(m[2] || '').replace(/^\/+/, '').replace(/\//g, '\\')}` : null
}
// A WSL distribution's files seen from Windows (\\wsl$\Ubuntu\home\me): its
// own POSIX path, else null.
function wslPath(raw) {
  const m = /^[\\/]{2}(?:wsl\$|wsl\.localhost)[\\/]+[^\\/]+(.*)$/i.exec(raw)
  return m ? m[1].replace(/\\/g, '/') || '/' : null
}
// An administrative share (\\host\c$\...): its drive's path, else null.
function adminShare(raw) {
  const m = /^[\\/]{2}[^\\/]+[\\/]+([a-z])\$(?:[\\/]+(.*))?$/i.exec(raw)
  return m ? `${m[1]}:\\${(m[2] || '').replace(/\//g, '\\')}` : null
}

function windowsTooBroad(raw) {
  const p = raw.replace(/\//g, '\\').replace(/\\+$/, '')
  if (/^[a-z]:$/i.test(p)) return true
  return WIN_SYSTEM_DIR.test(p) || /^[a-z]:\\windows\\/i.test(p)
}

export function posixRootTooBroad(path) {
  const p = String(path || '').trim().replace(/\/+$/, '') || '/'
  if (!p.startsWith('/')) return false
  if (POSIX_BROAD.has(p.toLowerCase()) || /^\/(proc|sys|dev)(\/|$)/i.test(p)) return true
  const drive = wslDrive(p)
  return drive !== null && windowsTooBroad(drive)
}

// A folder on this computer (any form). -> true when it must not be a root.
export function localRootTooBroad(path) {
  const raw = String(path || '').trim()
  if (!raw) return true
  // The device and long-path forms (backslash-backslash-? and -.) are never a project folder.
  if (/^[\\/]{2}[?.][\\/]/.test(raw)) return true
  if (/^[a-z]:([\\/]|$)/i.test(raw)) return windowsTooBroad(raw)
  const wsl = wslPath(raw)
  if (wsl !== null) return posixRootTooBroad(wsl)
  const admin = adminShare(raw)
  if (admin !== null) return windowsTooBroad(admin)
  // \\host\admin$ is its Windows folder; ipc$ and print$ hold no files.
  if (/^[\\/]{2}[^\\/]+[\\/]+(admin|ipc|print)\$([\\/]|$)/i.test(raw)) return true
  // A server alone has no share: too broad.
  if (/^[\\/]{2}/.test(raw)) return raw.split(/[\\/]+/).filter(Boolean).length < 2
  return posixRootTooBroad(raw)
}

// The folder of one user (/home/me, /Users/me, root's /root; C:\Users\me, in
// WSL /mnt/c/Users/me, through a WSL or admin share): allowed, after a
// confirmation.
const posixHome = (p) => /^\/((home|users)\/[^/]+|root)\/?$/i.test(p)
const windowsHome = (p) => /^[a-z]:[\\/]users[\\/][^\\/]+[\\/]?$/i.test(p)
export function isBareHomePath(path) {
  const raw = String(path || '').trim()
  if (windowsHome(raw) || posixHome(raw)) return true
  const wsl = wslPath(raw)
  const posix = wsl !== null ? wsl : raw.startsWith('/') ? raw : null
  if (posix !== null) {
    if (posixHome(posix)) return true
    const drive = wslDrive(posix.replace(/\/+$/, ''))
    if (drive !== null && windowsHome(drive)) return true
  }
  const admin = adminShare(raw)
  return admin !== null && windowsHome(admin.replace(/\\+$/, ''))
}
