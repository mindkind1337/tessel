// File links in a chat whose agent runs on an SSH host: the agent names
// the host's files (/home/me/app/src/a.js, src/a.js, ~/notes.md). They open
// through the remote file system, by their virtual path
// (src/shared/remotePath.js: ssh://<hostId>/home/me/app/src/a.js), in
// Tessel's editor or image viewer: the same way Files does for an SSH
// project. Never a path on this PC, never Windows' path functions.
import { isRemotePath, parseRemotePath, remoteRoot, relativeTo } from '../../../shared/remotePath.js'

const CONTROL = /[\u0000-\u001f\u007f]/

// A chat pane's folder on a host -> its virtual root, or null (a local one).
export function chatRemoteRoot(folder) {
  if (!isRemotePath(folder)) return null
  const p = parseRemotePath(folder)
  return p ? remoteRoot(p.hostId, p.path) : null
}

// The host of a chat's virtual root, or null.
export function chatRemoteHost(root) {
  const p = isRemotePath(root) ? parseRemotePath(root) : null
  return p ? p.hostId : null
}

// "." and ".." resolved POSIX-wise (never above "/"); null when it would
// climb above a "~" start.
function normalize(path) {
  const home = path === '~' || path.startsWith('~/')
  const segs = []
  for (const s of (home ? path.slice(1) : path).split('/')) {
    if (!s || s === '.') continue
    if (s === '..') {
      if (!segs.length) {
        if (home) return null
        continue
      }
      segs.pop()
    } else segs.push(s)
  }
  if (home) return segs.length ? `~/${segs.join('/')}` : '~'
  return `/${segs.join('/')}`
}

// "~" / "~/…" with the host's home folder put in (POSIX), else as is.
function withHome(path, home) {
  if (!home || !(path === '~' || path.startsWith('~/'))) return path
  const h = home.replace(/\/+$/, '')
  return `${h}${path.slice(1)}` || '/'
}

// A host's home folder (its $HOME): asked once per host (main keeps it too),
// for a project saved as "~/…" whose agent names files by their full path.
// -> Promise<string | null>
const homes = new Map() // hostId -> Promise<string | null>
export function hostHome(hostId, ask = (id) => globalThis.window?.shellApi?.remoteHome?.(id)) {
  if (typeof hostId !== 'string' || !/^ssh-[\w-]{1,60}$/.test(hostId)) return Promise.resolve(null)
  if (homes.has(hostId)) return homes.get(hostId)
  const job = Promise.resolve()
    .then(() => ask(hostId))
    .then((r) => (r && r.ok && typeof r.home === 'string' && r.home.startsWith('/') && !CONTROL.test(r.home) ? r.home : null))
    .catch(() => null)
    .then((home) => {
      // Not known (not connected yet): asked again next time.
      if (!home) homes.delete(hostId)
      return home
    })
  homes.set(hostId, job)
  return job
}
export function forgetHostHomes() {
  homes.clear()
}

// A link's path text (already without its :line:col) in the chat of `root`
// -> { file: virtual path, inside: below the chat's folder } | null.
// home: the host's home folder, when known: a project saved as "~/app" and
// "/home/me/app/a.js" (or the reverse) are the same folder; a file inside
// is named the project's way.
export function remoteLinkTarget(root, pathText, { home = null } = {}) {
  const base = parseRemotePath(root)
  if (!base || typeof pathText !== 'string') return null
  let text = pathText.trim()
  if (!text || text.length > 4096 || CONTROL.test(text)) return null
  // A Windows or network path is this PC's: not the host's.
  if (/^[A-Za-z]:/.test(text) || text.includes('\\')) return null
  if (text.startsWith('file://')) {
    try {
      text = decodeURIComponent(new URL(text).pathname)
    } catch {
      return null
    }
  }
  let abs
  if (text.startsWith('/') || text === '~' || text.startsWith('~/')) abs = text
  else abs = `${base.path.replace(/\/+$/, '')}/${text}`
  let path = normalize(abs)
  if (!path) return null
  const knownHome = typeof home === 'string' && home.startsWith('/') && !CONTROL.test(home) ? home : null
  const rel = relativeTo(withHome(base.path, knownHome), withHome(path, knownHome))
  // Inside: in the project's own form ("~/app/a.js" for a "~/app" project).
  if (rel !== null) path = rel ? `${base.path.replace(/\/+$/, '')}/${rel}` : base.path
  const file = remoteRoot(base.hostId, path)
  if (!file) return null
  return { file, path, inside: rel !== null }
}
