// Live Share, as a guest: what a link in a host's terminal or conversation
// may become on your screen. A host's pane prints the host's paths and
// addresses: none of them is ever looked up or opened on your own computer.
//
// - A file path: only one relative to the host's project ("src/app.js:12")
//   becomes a link, to the project's virtual path (lshare://<project>\src\
//   app.js), opened like any of its files in your Files panel and editor,
//   through your access to the project (main's guestFs.js). An absolute path
//   (C:\..., /home/..., \\server\..., ~/...) names the host's disk, whose
//   folder a guest never learns: plain text, never clickable, never checked
//   on your own disk (a host could print the path of a program of yours).
// - An address: filtered as the host's browser pages are (liveShareLink.js
//   linkForGuest: http and https only, secrets out, only the origin when one
//   shows); an address that only works on the host's side never opens.
import { linkForGuest } from '../../shared/liveShareLink.js'
import { lsharePath, isShareProjectId } from '../../shared/liveSharePath.js'

// A path that names a disk, a share, a home or a root: the host's own.
const ABSOLUTE = /^(?:[A-Za-z]:|[\\/]|~|\$|%)/

// A file reference's path in a host's pane -> its virtual path in the host's
// project, or null (not a link).
export function guestFileTarget(project, path) {
  if (!isShareProjectId(project) || typeof path !== 'string' || !path || path.length > 1024) return null
  if (ABSOLUTE.test(path) || /^[a-z][a-z0-9+.-]*:/i.test(path)) return null
  const rel = path
    .split(/[\\/]+/)
    .filter((seg) => seg && seg !== '.')
    .join('/')
  // ".." would leave the project: lsharePath refuses any such segment.
  return rel ? lsharePath(project, rel) : null
}

// An address in a host's pane -> { url, local, trimmed } (the address you
// may open, filtered) | null (not a web address).
export function guestUrlTarget(raw) {
  return linkForGuest(typeof raw === 'string' ? raw : '')
}
