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

// A link's path text (already without its :line:col) in the chat of `root`
// -> { file: virtual path, inside: below the chat's folder } | null.
export function remoteLinkTarget(root, pathText) {
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
  const path = normalize(abs)
  if (!path) return null
  const file = remoteRoot(base.hostId, path)
  if (!file) return null
  return { file, path, inside: relativeTo(base.path, path) !== null }
}
