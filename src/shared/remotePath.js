// Paths of a project on a remote host (SSH), as the interface holds them.
//
// A remote project ({ remote: { hostId, path } }) has no local folder, so its
// Files, Changes and editor tabs use a virtual path:
//   ssh://<hostId><path>        path absolute:  ssh://ssh-1a2b/home/me/app
//   ssh://<hostId>/<~path>      path from home: ssh://ssh-1a2b/~/app
// and a file below it adds its segments with "\" (the interface joins paths
// Windows' way) or "/": ssh://ssh-1a2b/home/me/app\src\main.js.
//
// Such a path is never a local one: path.isAbsolute() is false for it on
// Windows, so every local handler refuses it, and the main process sends it
// to the remote implementation (src/main/remoteFs.js) instead. Parsing is
// strict: no control characters, no "." or ".." segment, a known host id
// shape; a backslash is always a separator (a remote name holding one cannot
// be reached).

export const REMOTE_PREFIX = 'ssh://'
const HOST_ID_RE = /^ssh-[\w-]{1,60}$/
const CONTROL = /[\u0000-\u001f\u007f]/
export const MAX_REMOTE_VIRTUAL = 4096

export function isRemotePath(p) {
  return typeof p === 'string' && p.startsWith(REMOTE_PREFIX)
}

// A saved remote project path (absolute, "~" or "~/...") -> its segments and
// whether it starts from home. null when it is not one.
function segmentsOf(path) {
  if (typeof path !== 'string' || !path || path.length > MAX_REMOTE_VIRTUAL || CONTROL.test(path)) return null
  let home = false
  let rest = path
  if (rest === '~' || rest.startsWith('~/') || rest.startsWith('~\\')) {
    home = true
    rest = rest.slice(1)
  } else if (!rest.startsWith('/')) return null
  const segs = rest.split(/[\\/]+/).filter(Boolean)
  if (segs.some((s) => s === '.' || s === '..')) return null
  return { home, segs }
}

function join({ home, segs }) {
  if (home) return segs.length ? `~/${segs.join('/')}` : '~'
  return `/${segs.join('/')}`
}

// { hostId, path } of a remote project -> its virtual root, or null.
export function remoteRoot(hostId, path) {
  if (typeof hostId !== 'string' || !HOST_ID_RE.test(hostId)) return null
  // A backslash is a separator in virtual paths: a host path holding one
  // (refused when a project is added) has no virtual root.
  if (typeof path === 'string' && path.includes('\\')) return null
  const parts = segmentsOf(typeof path === 'string' ? path.trim() : '')
  if (!parts) return null
  const p = join(parts)
  return `${REMOTE_PREFIX}${hostId}${p.startsWith('/') ? '' : '/'}${p}`
}

// A virtual path -> { hostId, path } with path normalized ("/" separators,
// "~" kept first), or null when it is not a valid one.
export function parseRemotePath(v) {
  if (!isRemotePath(v) || v.length > MAX_REMOTE_VIRTUAL || CONTROL.test(v)) return null
  const rest = v.slice(REMOTE_PREFIX.length)
  const m = /^(ssh-[\w-]{1,60})([\\/].*)?$/.exec(rest)
  if (!m) return null
  const tail = (m[2] || '/').replace(/^[\\/]+/, '/')
  // "/~" or "/~/..." is a path from the home folder.
  const path = tail === '/~' || /^\/~[\\/]/.test(tail) ? tail.slice(1) : tail
  const parts = segmentsOf(path)
  if (!parts) return null
  return { hostId: m[1], path: join(parts) }
}

// Is `path` (normalized) `root` itself or below it? -> the relative part
// ('' for the root itself, "a/b" below it), or null.
export function relativeTo(root, path) {
  if (typeof root !== 'string' || typeof path !== 'string') return null
  if (path === root) return ''
  const base = root.endsWith('/') ? root : `${root}/`
  return path.startsWith(base) ? path.slice(base.length) : null
}

// The virtual path of `rel` ("a/b") below a virtual root, joined like the
// interface joins local paths ("\").
export function childPath(root, rel) {
  const r = String(root || '').replace(/[\\/]+$/, '')
  const parts = String(rel || '')
    .split('/')
    .filter(Boolean)
  return parts.length ? `${r}\\${parts.join('\\')}` : r
}

// The folder a remote path means on its host ("/home/me/app/src", "~/app"),
// for a terminal there or to show to the user.
export function remoteHostPath(v) {
  const p = parseRemotePath(v)
  return p ? p.path : null
}
