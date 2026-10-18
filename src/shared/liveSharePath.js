// Paths of a project a Live Share host shares, as the guest's interface holds
// them (phase 2: the host's files, changes and editor on the guest's screen).
//
// A shared project has no folder on the guest's computer, so its Files,
// Changes and editor tabs use a virtual path, like a remote project's
// (remotePath.js):
//   lshare://<project>               the project's folder on the host
//   lshare://<project>\src\main.js   a file below it (the interface joins
//                                    paths Windows' way; "/" is read too)
// <project> is the host window's project id. The host's own folder never
// appears: the guest only ever names a path relative to the project ("src/
// main.js" on the wire), and the host resolves it inside the project's folder
// itself (src/main/liveShare/shareScope.js).
//
// Such a path is never a local one (path.isAbsolute() is false for it), so
// every local handler refuses it; the guest's main process sends it to the
// host instead (src/main/liveShare/guestFs.js).
//
// Parsing is strict, on both sides: no control characters, no "." or ".."
// segment, nothing Windows reads differently from what it says (a ":" that
// names a stream, a trailing dot or space it drops, a device name like nul or
// com1, the characters a file name cannot hold), at most 255 characters a
// segment and 4096 in all.
import { isRemotePath } from './remotePath.js'

export const LSHARE_PREFIX = 'lshare://'
export const MAX_LSHARE_PATH = 4096
export const MAX_SEGMENT = 255
const PROJECT_RE = /^[\w-]{1,80}$/
// eslint-disable-next-line no-control-regex -- control characters are what it refuses
const BAD_CHAR = /[\u0000-\u001f\u007f<>:"/\\|?*]/
// Device names Windows opens instead of a file, with any extension (nul.txt
// is nul too), the superscript digits it also reads as ports included.
const RESERVED = /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3]|conin\$|conout\$|clock\$)\s*(\..*)?$/i

export function isLsharePath(p) {
  return typeof p === 'string' && p.startsWith(LSHARE_PREFIX)
}

// A path no local handler may take: a remote project's (ssh://) or a shared
// one's (lshare://).
export function isVirtualPath(p) {
  return isRemotePath(p) || isLsharePath(p)
}

export const isShareProjectId = (id) => typeof id === 'string' && PROJECT_RE.test(id)

// One file or folder name as both sides accept it.
export function segmentOk(name) {
  if (typeof name !== 'string' || !name || name.length > MAX_SEGMENT) return false
  if (name === '.' || name === '..') return false
  if (BAD_CHAR.test(name) || /[. ]$/.test(name)) return false
  return !RESERVED.test(name)
}

// A relative path as the wire carries it: segments joined with "/", '' for
// the project's folder itself. -> the same path, or null when it is not one
// (absolute, a drive, a share, \\?\, an empty or refused segment).
export function cleanRel(rel) {
  if (typeof rel !== 'string' || rel.length > MAX_LSHARE_PATH) return null
  if (rel === '') return ''
  const segs = rel.split('/')
  return segs.every(segmentOk) ? rel : null
}

// The segments of a wire path ([] for the project's folder), or null.
export function relSegments(rel) {
  const r = cleanRel(rel)
  return r === null ? null : r ? r.split('/') : []
}

// A project's virtual root, or null.
export function lshareRoot(project) {
  return isShareProjectId(project) ? `${LSHARE_PREFIX}${project}` : null
}

// A virtual path -> { project, rel } (rel '' for the project's folder, else
// "a/b"), or null when it is not a valid one. Either separator is read, and
// a doubled or trailing one is ignored; every segment must pass segmentOk.
export function parseLsharePath(v) {
  if (!isLsharePath(v) || v.length > MAX_LSHARE_PATH + LSHARE_PREFIX.length + 81) return null
  const m = /^([\w-]{1,80})([\\/].*)?$/s.exec(v.slice(LSHARE_PREFIX.length))
  if (!m) return null
  const segs = (m[2] || '').split(/[\\/]+/).filter(Boolean)
  const rel = segs.join('/')
  return cleanRel(rel) === null ? null : { project: m[1], rel }
}

// The virtual path of `rel` ("a/b") in a project, joined like the interface
// joins local paths ("\"). null when either is not valid.
export function lsharePath(project, rel = '') {
  const root = lshareRoot(project)
  const r = cleanRel(rel)
  if (!root || r === null) return null
  return r ? `${root}\\${r.split('/').join('\\')}` : root
}

// A child of a virtual folder (lshare://p\a + "b/c" -> lshare://p\a\b\c), or
// null when either is not valid.
export function lshareChild(base, rel) {
  const p = parseLsharePath(base)
  const r = cleanRel(rel)
  if (!p || r === null) return null
  return lsharePath(p.project, [p.rel, r].filter(Boolean).join('/'))
}

// A path the interface gives for a shared project (a virtual path, or a path
// relative to its folder with either separator) -> its wire path, when it is
// in `project`; null otherwise.
export function relInProject(project, p) {
  if (typeof p !== 'string') return null
  if (isLsharePath(p)) {
    const parsed = parseLsharePath(p)
    return parsed && parsed.project === project ? parsed.rel : null
  }
  if (p.length > MAX_LSHARE_PATH || /^[\\/]/.test(p)) return null
  const rel = p.split(/[\\/]+/).filter(Boolean).join('/')
  return cleanRel(rel)
}

// What both sides agree on: the most a host answers and a guest sends, per
// request (src/main/liveShare/shareRequests.js enforces them on the host,
// guestFs.js on the guest's side).
export const LSHARE_LIMITS = Object.freeze({
  entries: 5000, // a folder's entries
  listMany: 16, // folders in one listMany
  listManyEntries: 20000, // entries in one listMany, all folders together
  results: 200, // search results
  query: 500, // a name search's text
  contentQuery: 1000, // a content search's text
  fileList: 20000, // Jump to file's list
  textBytes: 2 * 1024 * 1024, // a file opened in the editor, a diff side
  imageBytes: 2 * 1024 * 1024,
  notesBytes: 512 * 1024,
  writeBytes: 768 * 1024, // a save: under the 1 MB a guest's message may be
  scmEntries: 5000, // the Changes list, a commit's or a branch's files
  pathsPerCall: 1000, // files staged, unstaged or discarded at once
  historyLimit: 200, // commits asked for at once (pages of 50)
  message: 20000, // a commit message
  detail: 300, // git's own words in an error
  localEntries: 50, // a file's Local History versions (the host keeps 50)
  diffBytes: 2 * 1024 * 1024 // a task branch's diff of one file
})

// The fixed codes a host answers a refused or failed request with (never its
// own error text, which names its folders).
export const LSHARE_CODES = Object.freeze([
  'bad-op',
  'bad-args',
  'bad-path',
  'no-project',
  'remote-project',
  'forbidden',
  'revoked',
  'not-found',
  'not-allowed',
  'exists',
  'not-file',
  'is-folder',
  'binary',
  'too-large',
  'encoding',
  'conflict',
  'not-repo',
  'nothing-staged',
  'staged-outside',
  'staged-hidden',
  'no-message',
  'no-identity',
  'bad-commit',
  'unavailable',
  'git',
  'busy',
  'failed'
])
