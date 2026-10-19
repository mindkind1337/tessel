// Where a path printed in a terminal pane points, before it is looked up.
//
// A relative path counts from the shell's current folder: the one its shell
// integration reports (OSC 633 "P;Cwd=…", VS Code's; or OSC 7
// "file://host/path", which bash/zsh/fish setups and WSL print), else the
// folder the pane started in.
//
// Each kind of pane names its files its own way:
//   local  -> this PC's paths; Git Bash's /c/Users/… is C:\Users\….
//   wsl    -> Linux paths of the distro: /mnt/c/… is C:\…, the rest is
//             \\wsl.localhost\<distro>\… (Windows paths stay as they are).
//   ssh    -> the host's paths, never this PC's: looked up and opened over
//             the connection as ssh://<host>/… (src/shared/remotePath.js).
// linkTarget() -> { query, cwd } for files:resolve (query: the path to look
// up, cwd: what a relative one counts from on this PC), or null when the
// path cannot be on that system.
import { parseShellSequence } from '../agentTerminal/screenRead'
import { remoteRoot } from '../../../shared/remotePath.js'
import { toWindowsWslDrivePath, toWindowsWslUncPath, parseWslUncPath } from '../chat/orca/shared/wsl-paths.js'

const CONTROL = /[\u0000-\u001f\u007f]/
const MAX_PATH = 4096

// OSC 7's "file://host/path" -> the path (percent-decoded), or null.
export function osc7Path(data) {
  const s = String(data || '')
  if (!/^file:\/\//i.test(s) || s.length > MAX_PATH * 3) return null
  const rest = s.slice(7)
  const slash = rest.indexOf('/')
  if (slash < 0) return null
  let path
  try {
    path = decodeURIComponent(rest.slice(slash))
  } catch {
    return null
  }
  return path && !CONTROL.test(path) && path.length <= MAX_PATH ? path : null
}

// The shell's current folder, from its OSC 633 and OSC 7 reports (the last
// one wins).
export function createCwdTracker() {
  let cwd = null
  return {
    feed633(data) {
      const e = parseShellSequence(data)
      if (e && e.type === 'P' && e.key === 'Cwd' && typeof e.value === 'string' && e.value && !CONTROL.test(e.value)) cwd = e.value.slice(0, MAX_PATH)
    },
    feed7(data) {
      const p = osc7Path(data)
      if (p) cwd = p
    },
    get: () => cwd,
    reset() {
      cwd = null
    }
  }
}

// The kind of pane -> 'ssh' | 'wsl' | 'local'.
export function paneLinkMode(node) {
  if (!node) return 'local'
  if (node.remoteHostId) return 'ssh'
  if (node.shellId === 'wsl') return 'wsl'
  return 'local'
}

// "." and ".." of a POSIX path ("/a/b/../c" -> "/a/c"; never above "/").
export function normalizePosix(path) {
  const segs = []
  for (const s of path.split('/')) {
    if (!s || s === '.') continue
    if (s === '..') segs.pop()
    else segs.push(s)
  }
  return `/${segs.join('/')}`
}

const isWindowsPath = (p) => /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}wsl(?:\$|\.localhost)[\\/]/i.test(p)
const isHomePath = (p) => p === '~' || p.startsWith('~/') || p.startsWith('~\\')

// A path a local shell wrote -> this PC's way: "/C:/x" (OSC 7 on Windows)
// and Git Bash's "/c/x" -> "C:\x".
export function localPath(p, { gitbash = false } = {}) {
  if (typeof p !== 'string' || !p) return p
  let m = /^\/([A-Za-z]):(?:[\\/](.*))?$/.exec(p)
  if (!m && gitbash) m = /^\/([A-Za-z])(?:\/(.*))?$/.exec(p)
  if (m) return `${m[1].toUpperCase()}:\\${(m[2] || '').replace(/\//g, '\\')}`
  return p
}

// A Linux path of the distro -> its Windows path (null without the distro,
// except /mnt/<drive>/…).
export function wslToWindows(linuxPath, distro) {
  const drive = toWindowsWslDrivePath(linuxPath)
  if (drive) return drive
  if (!distro || !/^[\w.-]{1,64}$/.test(distro)) return null
  return toWindowsWslUncPath(linuxPath, distro)
}

// A distro user's home, read from the folder the shell is in.
function wslHome(cwd) {
  const m = /^(\/home\/[^/]+|\/root)(?:\/|$)/.exec(cwd || '')
  return m ? m[1] : null
}

// ctx: { mode, cwd (the shell's), startDir (local panes), remotePath,
//        hostId (SSH), home (the host's, SSH), distro (WSL), gitbash }
export function linkTarget(path, ctx = {}) {
  if (typeof path !== 'string' || !path || path.length > MAX_PATH || CONTROL.test(path)) return null
  const mode = ctx.mode || 'local'
  if (mode === 'ssh') {
    // This PC's paths are never the host's.
    if (/^[A-Za-z]:/.test(path) || path.includes('\\')) return null
    let abs
    if (isHomePath(path)) abs = ctx.home ? `${ctx.home.replace(/\/+$/, '')}${path.slice(1)}` : path
    else if (path.startsWith('/')) abs = path
    else {
      const base = [ctx.cwd, ctx.remotePath].find((c) => typeof c === 'string' && (c.startsWith('/') || isHomePath(c)))
      if (!base) return null
      abs = `${base.replace(/\/+$/, '')}/${path}`
    }
    const fromHome = isHomePath(abs)
    let norm = fromHome ? `~${normalizePosix(abs.slice(1))}`.replace(/^~\/$/, '~') : normalizePosix(abs)
    // A project saved as "~/app": its files are named that way too (the
    // remote file system finds a file by its project's saved path).
    const home = typeof ctx.home === 'string' && ctx.home.startsWith('/') ? ctx.home.replace(/\/+$/, '') : null
    if (home && !fromHome && typeof ctx.remotePath === 'string' && isHomePath(ctx.remotePath)) {
      if (norm === home) norm = '~'
      else if (norm.startsWith(`${home}/`)) norm = `~${norm.slice(home.length)}`
    }
    const query = remoteRoot(ctx.hostId, norm)
    return query ? { query, cwd: null } : null
  }
  if (mode === 'wsl') {
    if (isWindowsPath(path)) {
      // \\wsl$\… and \\wsl.localhost\… are the same share.
      const unc = parseWslUncPath(path)
      return { query: unc ? toWindowsWslUncPath(unc.linuxPath, unc.distro) : path, cwd: null }
    }
    const cwd = typeof ctx.cwd === 'string' ? ctx.cwd : null
    const posixCwd = cwd && cwd.startsWith('/') ? cwd : null
    let linux = null
    if (isHomePath(path)) {
      const home = wslHome(posixCwd)
      if (!home) return null
      linux = `${home}${path.slice(1)}`
    } else if (path.startsWith('/')) linux = path
    else if (posixCwd) linux = `${posixCwd.replace(/\/+$/, '')}/${path}`
    if (linux !== null) {
      const win = wslToWindows(normalizePosix(linux.replace(/\\/g, '/')), ctx.distro)
      return win ? { query: win, cwd: null } : null
    }
    // A relative path, the shell's folder unknown: from where the pane started.
    const base = (cwd && isWindowsPath(cwd) ? cwd : null) || ctx.startDir || null
    return base ? { query: path, cwd: base } : null
  }
  const gitbash = !!ctx.gitbash
  const cwd = localPath(ctx.cwd, { gitbash }) || ctx.startDir || null
  return { query: localPath(path, { gitbash }), cwd: cwd || null }
}
