// Files, editor and Changes of a project on a remote host (SSH).
//
// The window addresses a remote project's files with virtual paths
// (src/shared/remotePath.js: ssh://<hostId>/home/me/app\src\a.js); the IPC
// handlers of index.js send those here instead of to explorer.js,
// editorFiles.js and sourceControl.js. Everything runs through one SSH
// session per host (remoteShell.js), started by the first operation that
// needs it, signed in through the same askpass dialog as the terminals, and
// shown as that host's connection in the status bar.
//
// Rules held here (and again by the host-side functions of remoteShell.js):
// - A path is only used once it is found below a remote project folder the
//   window declared (setRoots) or named in the same call; on the host, every
//   path is resolved (links included) and must stay inside that folder's
//   real path, else the operation is refused.
// - Nothing from the window becomes a command: the functions and their fixed
//   arguments are Tessel's; paths, names and search text are single-quoted
//   arguments (control characters refused); file contents and commit
//   messages go through the session's stdin as base64, never an argument.
// - Every operation is bounded in size and time and can be cancelled (the
//   session ends, the next operation starts a new one).
// - Delete goes to the host user's trash (the freedesktop.org Trash folder,
//   ~/.local/share/Trash, with its .trashinfo so a file manager or
//   `gio trash --restore` can put it back), never rm.
import { createRemoteSession, sessionArgs, remotePathArg, rawArg, RC } from './remoteShell'
import { createScm } from './sourceControl'
import { looksBinary, MAX_EDIT_BYTES, MAX_HEAD_BYTES } from './editorFiles'
import { cleanEnv } from './cleanEnv'
import { RISKY_CONFIG_ARGS, parseRisky, hookEntries, neutralize, gitTrust } from './gitSafety'
import { parseRemotePath, remoteRoot, relativeTo, childPath, isRemotePath } from '../shared/remotePath'
import { fileKind, extOf, IMAGE_MIME } from '../shared/fileKinds'
import { t } from './i18n'
import { validateCloneUrl, deriveCloneRepoName, cloneFailureMessage, errorText as addProjectErrorText } from './addProject'
import { parseWorktreeList, MAX_WORKTREES } from './worktreeList'
import { parseSparseList, sparseDirsUnder } from './sparseCheckout'
import { parseAgentTools, parseRemoteSessions, remoteSessionsLimit } from './remoteAgent/remoteAgentSetup'

export const SESSION_PREFIX = 'rfs:'
const MAX_ENTRIES = 5000
const MAX_ROOTS = 200
const MAX_WATCHED = 500
const MAX_IMAGE = 30 * 1024 * 1024
const MAX_VERSION = 10 * 1024 * 1024 // like sourceControl.js's MAX_FILE
const SEARCH_LIMIT = 500
const SEARCH_OUTPUT = 4 * 1024 * 1024
const FILE_POLL_MS = 3000
const ROOT_POLL_TICKS = 2 // the project's fingerprint every other file poll
const IDLE_CLOSE_MS = 20 * 60 * 1000
const HEADER_SLACK = 64 * 1024
const BOM = Buffer.from([0xef, 0xbb, 0xbf])
// core.hooksPath of a repository not trusted: a folder that has no hooks.
const NO_HOOKS = '/nonexistent-tessel-no-hooks'
const ROOT_POLL_MAX_TICKS = 20 // a slow project is looked at less often (60 s at most)
const CONTROL = /[\u0000-\u001f\u007f]/
// The folder picker of Add a project (browse): how many names one listing
// returns at most, and how long it may take.
export const MAX_BROWSE_ENTRIES = 2000
const BROWSE_TIMEOUT_MS = 20_000
const CLONE_TIMEOUT_MS = 10 * 60 * 1000
const NEWPROJ_TIMEOUT_MS = 60_000
// The sidebar's branch and worktrees of a remote project: bounded output
// (a few hundred worktrees fit) and time.
export const WORKTREES_OUTPUT = 256 * 1024
const WORKTREES_TIMEOUT_MS = 15_000

const arg = (path) => rawArg(remotePathArg(path))
const joinPath = (base, rel) => (rel ? (base.endsWith('/') ? `${base}${rel}` : `${base}/${rel}`) : base)

// "size mtime inode mode" (stat on the host) -> the editor's fields.
export function parseStat(line) {
  const m = /^(\d+) (\d+) (\d+) ([0-7]+)/.exec(String(line || '').trim())
  if (!m) return null
  return { size: Number(m[1]), mtimeMs: Number(m[2]) * 1000, sig: `r:${m[1]}:${m[2]}:${m[3]}` }
}
// The editor's signature back to what the host compares ("size mtime inode").
function sigForHost(sig) {
  const m = /^r:(\d+):(\d+):(\d+)$/.exec(String(sig || ''))
  return m ? `${m[1]} ${m[2]} ${m[3]}` : ''
}
const HASH_RE = /^(sha256:[0-9a-f]{64}|cksum:\d+:\d+)$/

// A name for a new file or folder, or a rename, on a POSIX host.
export function checkRemoteName(name) {
  const n = String(name || '').trim()
  if (!n) return t('main.explorer.noName', 'Give it a name.')
  if (Buffer.byteLength(n) > 255) return t('main.explorer.nameTooLong', 'The name is too long.')
  if (n === '.' || n === '..' || /[/\\]/.test(n) || CONTROL.test(n))
    return t('main.remoteFs.badName', '"{{name}}" is not a valid name on the remote host.', { name: n.replace(CONTROL, '?') })
  return ''
}

// A folder the picker of Add a project may list, or a parent folder for a
// clone / a new project: "~", "~/...", or absolute POSIX; no control
// characters, no backslash (a project path cannot hold one either: see
// the renderer's remotePathError). Repeated and trailing slashes are
// dropped; ".." stays (the host resolves it). -> the path, or null.
export function cleanBrowsePath(p) {
  if (typeof p !== 'string') return null
  const s = p.trim()
  if (!s || s.length > 4096 || CONTROL.test(s) || s.includes('\\')) return null
  if (!(s === '~' || s.startsWith('~/') || s.startsWith('/'))) return null
  const out = s.replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1')
  return out
}

// The host's answer to __t_browse: its real path, then "k name" records
// (d folder, f file, L link to a folder, l other link, o other).
// -> { path, entries, truncated }
export function parseBrowse(buf, max = MAX_BROWSE_ENTRIES) {
  const recs = Buffer.from(buf || '').toString('utf8').split('\0')
  const path = recs.shift() || ''
  const entries = []
  let count = 0
  for (const rec of recs) {
    const m = /^([dfLlo]) (.+)$/s.exec(rec)
    if (!m) continue
    count++
    const name = m[2]
    // A name the window could not send back (control characters, backslash).
    if (CONTROL.test(name) || name.includes('\\') || name === '.' || name === '..') continue
    if (entries.length >= max) break
    const dir = m[1] === 'd' || m[1] === 'L'
    entries.push({ name, dir, ...(m[1] === 'L' || m[1] === 'l' ? { link: true } : {}) })
  }
  entries.sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })))
  return { path, entries, truncated: count > max }
}

// The host's answer to __t_wtl: a header ("tessel-wtl 1", root, top, branch,
// head lines), a blank line, then `git worktree list --porcelain`.
// truncated: the output was cut at its cap (its last, partial worktree is
// left out). -> { root, top, branch, head, worktrees: [{ path, branch,
// head, isMain, locked, prunable }] } | null when the header is not there.
export function parseRemoteWorktrees(buf, { truncated = false, max = MAX_WORKTREES } = {}) {
  const text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf || '')
  const cut = text.indexOf('\n\n')
  const head = (cut < 0 ? text : text.slice(0, cut)).split('\n')
  if (head[0] !== 'tessel-wtl 1') return null
  const field = (name) => {
    const line = head.find((l) => l.startsWith(`${name} `) || l === name)
    return line ? line.slice(name.length + 1) : null
  }
  const root = field('root')
  const top = field('top')
  if (!root || !top || !root.startsWith('/') || !top.startsWith('/')) return null
  const branch = field('branch') || ''
  const sha = field('head') || ''
  let body = cut < 0 ? '' : text.slice(cut + 2)
  // Cut at its cap: only whole worktrees (a block ends with a blank line).
  if (truncated) {
    const last = body.lastIndexOf('\n\n')
    body = last < 0 ? '' : body.slice(0, last)
  }
  const worktrees = parseWorktreeList(body, max).filter(
    (w) => w.path.startsWith('/') && !CONTROL.test(w.path) && !w.path.includes('\\') && !CONTROL.test(w.branch)
  )
  return {
    root,
    top,
    branch: CONTROL.test(branch) ? '' : branch,
    head: /^[0-9a-f]{7,64}$/.test(sha) ? sha : '',
    worktrees
  }
}

// A relative path from the window ("a/b", git's) -> clean "a/b", or null.
export function cleanRel(p) {
  if (typeof p !== 'string' || !p || p.length > 4096 || CONTROL.test(p)) return null
  const segs = p.split(/[\\/]+/).filter(Boolean)
  if (!segs.length || segs.some((s) => s === '.' || s === '..')) return null
  return segs.join('/')
}

// `git status --porcelain=v1 -z` -> [[path relative to the top, letter]]
// (the explorer's letters: M, A, D, R, C, U untracked, ! ignored).
export function porcelainLetters(out) {
  const list = []
  const parts = String(out || '').split('\0')
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i]
    if (rec.length < 4) continue
    const x = rec[0]
    const y = rec[1]
    let letter
    if (x === '?' && y === '?') letter = 'U'
    else if (x === '!' && y === '!') letter = '!'
    else if (x === 'R' || y === 'R') letter = 'R'
    else if (x === 'C' || y === 'C') letter = 'C'
    else if (x === 'D' || y === 'D') letter = 'D'
    else if (x === 'A') letter = 'A'
    else letter = 'M'
    if (x === 'R' || x === 'C') i++
    list.push([rec.slice(3).replace(/\/$/, ''), letter])
  }
  return list
}

// A find glob that matches `query` literally, anywhere in a name.
export function findPattern(query) {
  return `*${String(query).replace(/[*?[\]\\]/g, (c) => `\\${c}`)}*`
}

// The freedesktop.org trash wants the original path URL-escaped.
export function trashInfoPath(abs) {
  return abs
    .split('/')
    .map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join('/')
}
function trashDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function firstLine(text) {
  return (
    String(text || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !/^hint:/i.test(l))
      .pop() || ''
  ).slice(0, 300)
}

// hosts: remoteHosts.js's service; askpass: sshAskpass.js's broker;
// ssh: ssh/sshRemote.js (the host's shared ssh2 connection, when it applies);
// send(channel, payload): to the window.
export function createRemoteFs({
  hosts,
  askpass = null,
  ssh = null,
  send = () => {},
  log = null,
  spawnImpl,
  env = process.env,
  timers = { setTimeout, clearTimeout, setInterval, clearInterval },
  now = () => Date.now(),
  trust = gitTrust
} = {}) {
  const sessions = new Map() // hostId -> entry
  const roots = new Map() // hostId\npath -> { hostId, path }
  const repoInfos = new Map() // hostId\nroot path -> Promise<info>
  const watchedRoots = new Map() // virtual root -> { hostId, root, last }
  const watchedFiles = new Map() // hostId\npath -> { virtual, loc, sig }
  let pollTimer = null
  let pollTick = 0
  let markerSeq = 0
  let polling = false
  let idleTimer = null

  const warn = (msg) => {
    try {
      if (log) log.warn('remote', msg)
    } catch {
      /* never mind */
    }
  }
  const hostLabel = (hostId) => {
    try {
      const h = hosts.get(hostId)
      return (h && h.label) || hostId
    } catch {
      return hostId
    }
  }

  // --- Activity (the window's remote badge: connecting, busy) ---------------
  function activity(hostId, entry, extra = {}) {
    try {
      send('remoteFs:activity', {
        hostId,
        label: hostLabel(hostId),
        state: entry ? (entry.session && entry.session.state === 'ready' ? (entry.busy > 0 ? 'busy' : 'ready') : 'connecting') : 'closed',
        pending: entry ? entry.busy : 0,
        op: entry ? entry.op || '' : '',
        ...extra
      })
    } catch {
      /* the window may be gone */
    }
  }

  // --- Errors ------------------------------------------------------------------
  function sessionErrorText(hostId, err) {
    const host = hostLabel(hostId)
    const code = err && err.code
    const detail = firstLine(err && err.stderr)
    switch (code) {
      case 'host':
        return (err && err.message) || t('main.remote.notFound', 'This remote host is no longer saved in Tessel.')
      case 'connect':
        return detail
          ? t('main.remoteFs.connectFailed', 'Could not connect to {{host}}: {{error}}', { host, error: detail })
          : t('main.remoteFs.connectExit', 'Could not connect to {{host}} (ssh exit code {{code}}).', { host, code: err.exitCode ?? '?' })
      case 'connect-timeout':
        return t('main.remoteFs.connectTimeout', 'The connection to {{host}} timed out.', { host })
      case 'timeout':
        return t('main.remoteFs.timeout', 'The operation on {{host}} took too long and was stopped.', { host })
      case 'cancelled':
        return t('main.remoteFs.cancelled', 'Cancelled.')
      case 'not-connected':
        return t('main.remoteFs.notConnected', '{{host}} is not connected. Use Connect to sign in.', { host })
      case 'auth-cancelled':
        return t('main.remoteFs.signInCancelled', 'Sign-in to {{host}} was cancelled.', { host })
      case 'ssh':
        // The ssh2 connection's own reason (already in words: ssh/sshMessages.js).
        return detail || t('main.remoteFs.lost', 'The connection to {{host}} was lost.', { host })
      case 'no-base64':
        return t('main.remoteFs.noBase64', '{{host}} has neither base64 nor openssl, which Tessel needs to transfer files.', { host })
      case 'prelude':
        return t('main.remoteFs.noTemp', '{{host}} has no writable temporary folder for Tessel’s session.', { host })
      case 'too-large':
        return t('main.remoteFs.tooMuch', 'The answer from {{host}} was too large.', { host })
      case 'spawn':
        return t('main.remoteFs.noSshStart', 'ssh.exe could not be started.')
      case 'bad-argument':
        return t('main.remoteFs.badPath', 'This path has characters Tessel cannot send to the remote host.')
      default:
        return t('main.remoteFs.lost', 'The connection to {{host}} was lost.', { host })
    }
  }

  function rcText(res, fallback) {
    switch (res.rc) {
      case RC.OUTSIDE:
        return t('main.remoteFs.outside', 'This path leads outside the project folder on the host (a link?): refused.')
      case RC.MISSING:
        return t('main.remoteFs.missing', 'Not found on the host.')
      case RC.NOT_FILE:
        return t('main.remoteFs.notFile', 'This is not a file.')
      case RC.IS_DIR:
        return t('main.editor.isFolder', 'This is a folder.')
      case RC.TIMEOUT:
        return t('main.remoteFs.hostTimeout', 'It took too long on the host and was stopped.')
      case RC.NO_TRASH:
        return t('main.remoteFs.noTrash', 'This item is on another disk than the host’s trash, and that disk has no trash Tessel can use: nothing was moved. Delete it from a terminal if you are sure.')
      default: {
        const line = firstLine(res.err)
        return line ? `${fallback} ${line}` : fallback
      }
    }
  }

  // --- Sessions ------------------------------------------------------------------
  // Never a sign-in (a password question) nobody asked for: a session starts
  // only for a host the user connected to in this run (Connect, a terminal
  // opened on it, Add a project), or whose shared ssh2 connection is already
  // signed in (nothing to ask). Otherwise, as after a restart of Tessel with
  // a remote project shown, the operation says the host is not connected and
  // the remote badge offers Connect (needsConnect).
  const allowed = new Set() // hostIds
  function allow(hostId) {
    if (typeof hostId === 'string' && hostId) allowed.add(hostId)
  }
  // A path of a remote project (ssh://…): its host.
  function allowPath(virtual) {
    const p = parseRemotePath(virtual)
    if (p) allow(p.hostId)
  }
  function mayOpen(hostId) {
    if (allowed.has(hostId)) return true
    try {
      return !!(hosts.sharedConnected && hosts.sharedConnected(hostId))
    } catch {
      return false
    }
  }
  function open(hostId) {
    const existing = sessions.get(hostId)
    if (existing && !existing.closed) return existing.ready
    if (!mayOpen(hostId)) {
      activity(hostId, null, { needsConnect: true })
      return Promise.reject(Object.assign(new Error('not connected'), { code: 'not-connected' })) // i18n-ignore internal
    }
    const paneId = `${SESSION_PREFIX}${hostId}`
    const entry = { paneId, closed: false, session: null, token: undefined, busy: 0, op: '' }
    sessions.set(hostId, entry)
    entry.ready = (async () => {
      // The host's shared ssh2 connection (one exec channel running the
      // same `exec /bin/sh` protocol), unless the host needs the system ssh.
      const target = ssh ? hosts.get(hostId) : null
      if (ssh && !target) throw Object.assign(new Error(t('main.remote.notFound', 'This remote host is no longer saved in Tessel.')), { code: 'host' })
      const mode = target ? await ssh.modeFor(target) : { mode: 'system' }
      if (entry.closed) throw Object.assign(new Error('cancelled'), { code: 'cancelled' }) // i18n-ignore internal
      if (mode.mode === 'ssh2') {
        activity(hostId, entry)
        const session = createRemoteSession({
          file: 'ssh2',
          args: [],
          env: {},
          spawnImpl: ssh.spawnFor(hostId, mode.spec),
          timers,
          // The sign-in may ask a host key and a password (2 minutes each).
          readyTimeoutMs: 6 * 60 * 1000,
          onExit: (reason) => ended(hostId, entry, reason)
        })
        entry.session = session
        hosts.paneStarted(paneId, hostId, { connected: false, ssh2: true })
        await session.start()
        if (hosts.paneConnected) hosts.paneConnected(paneId)
        activity(hostId, entry)
        armIdle()
        return session
      }
      const launch = hosts.launchFor(hostId)
      if (!launch || !launch.ok) throw Object.assign(new Error((launch && launch.error) || 'host'), { code: 'host' }) // i18n-ignore replaced by sessionErrorText
      activity(hostId, entry)
      const lease = askpass
        ? await askpass.prepareLaunch(paneId, { hostId, label: launch.name, sshExe: launch.file })
        : { status: 'fallback' }
      if (lease.status === 'cancelled' || entry.closed) throw Object.assign(new Error('cancelled'), { code: 'cancelled' }) // i18n-ignore internal
      const ready = lease.status === 'ready'
      entry.token = ready ? lease.env.TESSEL_ASKPASS_TOKEN : undefined
      const session = createRemoteSession({
        file: launch.file,
        args: sessionArgs(launch.args, { batch: !ready }),
        env: { ...cleanEnv(env), ...(ready ? lease.env : {}) },
        ...(spawnImpl ? { spawnImpl } : {}),
        timers,
        onExit: (reason) => ended(hostId, entry, reason)
      })
      entry.session = session
      hosts.paneStarted(paneId, hostId, { connected: !ready })
      if (entry.token && askpass) askpass.paneStarted(paneId, entry.token)
      await session.start()
      if (hosts.paneConnected) hosts.paneConnected(paneId)
      activity(hostId, entry)
      armIdle()
      return session
    })()
    entry.ready.catch((err) => {
      if (!entry.closed) ended(hostId, entry, (err && err.code) || 'connect')
    })
    return entry.ready
  }

  function ended(hostId, entry, reason) {
    if (entry.closed) return
    entry.closed = true
    if (sessions.get(hostId) === entry) sessions.delete(hostId)
    for (const k of [...repoInfos.keys()]) if (k.startsWith(`${hostId}\n`)) repoInfos.delete(k)
    if (askpass) {
      try {
        askpass.releasePane(entry.paneId, entry.token)
      } catch {
        /* gone */
      }
    }
    try {
      // Never "ssh failed, see its terminal": this session has none; the
      // operation that needed it says what went wrong.
      if (hosts.paneClosing) hosts.paneClosing(entry.paneId)
      hosts.paneExited(entry.paneId, 0)
    } catch {
      /* gone */
    }
    if (entry.session && entry.session.state !== 'closed') entry.session.close(reason)
    if (reason !== 'cancelled' && reason !== 'idle' && reason !== 'shutdown') warn(`remote session for ${hostId} ended: ${reason}`)
    activity(hostId, null)
  }

  // Ends a host's session (Disconnect, cancel, a sign-in cancelled).
  function closeHost(hostId, reason = 'cancelled') {
    const entry = sessions.get(hostId)
    if (!entry) return false
    if (entry.session) entry.session.close(reason)
    ended(hostId, entry, reason)
    return true
  }
  function closePane(paneId, reason = 'cancelled') {
    if (typeof paneId !== 'string' || !paneId.startsWith(SESSION_PREFIX)) return false
    return closeHost(paneId.slice(SESSION_PREFIX.length), reason)
  }

  function armIdle() {
    if (idleTimer) return
    idleTimer = timers.setInterval(() => {
      for (const [hostId, entry] of sessions) {
        const s = entry.session
        if (s && s.state === 'ready' && !s.busy && now() - s.lastUsed > IDLE_CLOSE_MS) closeHost(hostId, 'idle')
      }
      if (!sessions.size && idleTimer) {
        timers.clearInterval(idleTimer)
        idleTimer = null
      }
    }, 60_000)
    if (idleTimer && idleTimer.unref) idleTimer.unref()
  }

  // One operation: -> { rc, out, err, truncated } | { error }. quiet: a poll
  // (never starts a session, never shows as activity). ifOpen: like quiet,
  // but waits its turn behind a busy session instead of being skipped.
  async function call(hostId, fn, args, { cap, timeoutMs, upload, op = '', quiet = false, ifOpen = false } = {}) {
    let session
    const entry0 = sessions.get(hostId)
    if (ifOpen) quiet = true
    if (quiet) {
      if (!entry0 || !entry0.session || entry0.session.state !== 'ready' || (entry0.session.busy && !ifOpen)) return { skipped: true }
      session = entry0.session
    } else {
      try {
        session = await open(hostId)
      } catch (err) {
        return { error: sessionErrorText(hostId, err) }
      }
    }
    const entry = sessions.get(hostId)
    if (!quiet && entry) {
      entry.busy++
      entry.op = op
      activity(hostId, entry)
    }
    try {
      return await session.run(fn, args, { ...(cap ? { cap } : {}), ...(timeoutMs ? { timeoutMs } : {}), ...(upload ? { upload } : {}), ...(ifOpen ? { touch: false } : {}) })
    } catch (err) {
      return { error: sessionErrorText(hostId, err) }
    } finally {
      if (!quiet && entry && !entry.closed) {
        entry.busy = Math.max(0, entry.busy - 1)
        if (!entry.busy) entry.op = ''
        activity(hostId, entry)
      }
    }
  }

  // --- Project folders -------------------------------------------------------------
  // The remote projects are the saved ones (index.js reads them from the
  // layout it stores): no call from the window adds a folder, and a git
  // repository's top (which may be above the project, even the home folder)
  // is never one. root: { hostId, path, real } (real: its real path on the
  // host once known).
  function setRoots(list) {
    const next = new Map()
    for (const v of Array.isArray(list) ? list.slice(0, MAX_ROOTS) : []) {
      const p = parseRemotePath(v)
      if (!p) continue
      const key = `${p.hostId}\n${p.path}`
      next.set(key, roots.get(key) || { hostId: p.hostId, path: p.path, real: null })
    }
    roots.clear()
    for (const [k, v] of next) roots.set(k, v)
    return roots.size
  }
  const rootOf = (virtual) => {
    const p = parseRemotePath(virtual)
    return p ? roots.get(`${p.hostId}\n${p.path}`) || null : null
  }
  // A path below `rootVirtual` (a saved project, given) or below the deepest
  // saved project, by its saved path or its real one.
  // -> { hostId, root, rel, path, virtual } | null
  function locate(virtual, rootVirtual = null) {
    const p = parseRemotePath(virtual)
    if (!p) return null
    let best = null
    const candidates = rootVirtual ? [rootOf(rootVirtual)] : [...roots.values()]
    for (const r of candidates) {
      if (!r || r.hostId !== p.hostId) continue
      for (const base of [r.path, r.real]) {
        if (!base) continue
        const rel = relativeTo(base, p.path)
        if (rel !== null && (!best || base.length > best.len)) best = { root: r, rel, len: base.length }
      }
    }
    return best ? { hostId: p.hostId, root: best.root, rel: best.rel, path: joinPath(best.root.path, best.rel), virtual } : null
  }
  const rootVirtualOf = (root) => remoteRoot(root.hostId, root.path)

  // The folder's real path, its repository's top on the host, and the -c
  // arguments its git calls get (gitSafety.js: the repository's own settings
  // that run programs stay off until the user trusts it).
  // -> { realRoot, top | null, gitArgs } | { error } | { missing }
  function repoInfo(loc) {
    const key = `${loc.hostId}\n${loc.root.path}`
    if (!repoInfos.has(key)) {
      const p = call(loc.hostId, '__t_top', [arg(loc.root.path)], { cap: 64 * 1024, op: 'status' }).then(async (res) => {
        if (res.error) return { error: res.error }
        const lines = res.out.toString('utf8').split('\n')
        if (res.rc === RC.NOT_REPO) {
          loc.root.real = lines[0] || null
          return { realRoot: lines[0], top: null, gitArgs: [] }
        }
        if (res.rc === RC.MISSING) return { missing: true }
        if (res.rc !== 0 || !lines[0] || !lines[1]) return { error: rcText(res, t('main.scm.statusFailed', 'Git status failed.')) }
        loc.root.real = lines[0]
        const cfg = await call(loc.hostId, '__t_gitin', [arg(loc.root.path), arg(lines[1]), ...RISKY_CONFIG_ARGS], { cap: 256 * 1024, op: 'status' })
        if (cfg.error) return { error: cfg.error }
        // Its runnable hooks ($GIT_DIR/hooks, not the *.sample ones) count too.
        const hooks = await call(loc.hostId, '__t_hooks', [arg(loc.root.path), arg(lines[1])], { cap: 64 * 1024, op: 'status' })
        if (hooks.error) return { error: hooks.error }
        // Exit 1: none of them set. Unreadable: everything they could be stays off.
        const risky = [
          ...(cfg.rc === 0 ? parseRisky(cfg.out.toString('utf8')) : []),
          ...(hooks.rc === 0 ? hookEntries(hooks.out.toString('utf8').split('\0')) : [])
        ]
        let gitArgs = []
        if ((cfg.rc !== 0 && cfg.rc !== 1) || hooks.rc !== 0) gitArgs = neutralize([], { hooksDir: NO_HOOKS })
        else if (risky.length) {
          const trusted = await trust().decide(`${loc.hostId}:${lines[1]}`, risky, { name: lines[1], where: hostLabel(loc.hostId) })
          if (!trusted) gitArgs = neutralize(risky, { hooksDir: NO_HOOKS })
        }
        return { realRoot: lines[0], top: lines[1], gitArgs }
      })
      repoInfos.set(key, p)
      p.then((info) => {
        if (info.error || info.missing) repoInfos.delete(key)
      })
    }
    return repoInfos.get(key)
  }
  // The top as the window addresses it (for git paths only): the project
  // folder itself when they are the same folder, else its own virtual path —
  // which the editor can reach only below a saved project.
  function topVirtual(loc, info) {
    if (info.top === info.realRoot) return rootVirtualOf(loc.root)
    return remoteRoot(loc.hostId, info.top)
  }

  // --- Explorer ------------------------------------------------------------------------
  // A path below the saved project `root` (the window names it; it must be one).
  function under(root, p) {
    if (!isRemotePath(root) || !rootOf(root)) return null
    return locate(p || root, root)
  }

  async function listDir({ root, dir, dotfiles = true } = {}) {
    const loc = under(root, dir || root)
    if (!loc) return { ok: false, error: t('main.explorer.outside', 'Outside the project.') }
    const res = await call(loc.hostId, '__t_ls', [arg(loc.root.path), arg(loc.path), String(MAX_ENTRIES + 1)], { cap: 16 * 1024 * 1024, op: 'list' })
    if (res.error) return { ok: false, error: res.error }
    if (res.rc === RC.MISSING) return { ok: false, error: t('main.explorer.folderGone', 'The folder is gone.') }
    if (res.rc !== 0) return { ok: false, error: rcText(res, t('main.explorer.folderUnreadable', 'The folder could not be read.')) }
    const base = dir || root
    const entries = []
    let count = 0
    for (const rec of res.out.toString('utf8').split('\0')) {
      const m = /^([dfLlo]) (.+)$/s.exec(rec)
      if (!m) continue
      count++
      const name = m[2]
      // Not addressable (a backslash or a control character in the name) or hidden.
      if (CONTROL.test(name) || name.includes('\\') || name === '.git') continue
      if (!dotfiles && name.startsWith('.')) continue
      if (entries.length >= MAX_ENTRIES) break
      entries.push({ name, path: childPath(base, name), dir: m[1] === 'd' || m[1] === 'L', ...(m[1] === 'L' || m[1] === 'l' ? { link: true } : {}) })
    }
    entries.sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })))
    return { ok: true, entries, truncated: count > MAX_ENTRIES }
  }

  // The explorer's letters, keyed by the files' virtual paths.
  async function projectStatus({ root, ignored = false } = {}) {
    const loc = under(root, root)
    if (!loc) return { ok: false, error: t('main.explorer.invalidFolder', 'Invalid folder.') }
    const info = await repoInfo(loc)
    if (info.error) return { ok: false, error: info.error }
    if (info.missing || !info.top) return { ok: true, files: {}, repo: false }
    const args = ['status', '--porcelain=v1', '-z', '--untracked-files=all', ...(ignored ? ['--ignored=matching'] : [])]
    const res = await call(loc.hostId, '__t_gitin', [arg(loc.root.path), arg(info.top), ...info.gitArgs, ...args], { cap: 32 * 1024 * 1024, timeoutMs: 30000, op: 'status' })
    if (res.error) return { ok: false, error: res.error }
    if (res.rc !== 0) return { ok: false, error: rcText(res, t('main.scm.statusFailed', 'Git status failed.')) }
    const files = {}
    for (const [p, letter] of porcelainLetters(res.out.toString('utf8'))) {
      const rel = relativeTo(info.realRoot, joinPath(info.top, p))
      if (rel === null || !rel || CONTROL.test(rel) || rel.includes('\\')) continue
      files[childPath(root, rel)] = letter
    }
    return { ok: true, files, repo: true }
  }

  // The folders a sparse checkout keeps below the project (explorer.js
  // sparseInfo): -> { ok, sparse, dirs: [{ rel, path }] }.
  async function sparseInfo({ root } = {}) {
    const loc = under(root, root)
    if (!loc) return { ok: false, error: t('main.explorer.invalidFolder', 'Invalid folder.') }
    const none = { ok: true, sparse: false, dirs: [] }
    const info = await repoInfo(loc)
    if (info.error) return { ok: false, error: info.error }
    if (info.missing || !info.top) return none
    const res = await call(loc.hostId, '__t_gitin', [arg(loc.root.path), arg(info.top), ...info.gitArgs, '-c', 'core.quotePath=false', 'sparse-checkout', 'list'], { cap: 1024 * 1024, timeoutMs: 15000, op: 'status' })
    if (res.error) return { ok: false, error: res.error }
    // Exit 128 ("this worktree is not sparse") or an old git: not sparse.
    if (res.rc !== 0) return none
    const rootRel = relativeTo(info.top, info.realRoot)
    if (rootRel === null) return none
    const dirs = sparseDirsUnder(parseSparseList(res.out.toString('utf8')), rootRel, { caseless: false })
      .filter((rel) => !CONTROL.test(rel))
      .map((rel) => ({ rel, path: childPath(root, rel) }))
    return { ok: true, sparse: true, dirs }
  }

  // `dir`: only names below that folder of the project (the tree's root
  // when it shows one sparse folder).
  async function searchNames({ root, dir, query, dotfiles = true, limit = SEARCH_LIMIT } = {}) {
    const loc = under(root, root)
    if (!loc) return { ok: false, error: t('main.explorer.invalidFolder', 'Invalid folder.') }
    const scope = dir ? under(root, dir) : loc
    if (!scope) return { ok: false, error: t('main.explorer.outside', 'Outside the project.') }
    const within = scope.rel ? `${scope.rel}/` : ''
    const max = Number.isInteger(limit) && limit > 0 ? Math.min(limit, SEARCH_LIMIT) : SEARCH_LIMIT
    const q = String(query || '').trim()
    if (!q) return { ok: true, results: [], truncated: false }
    if (CONTROL.test(q) || q.length > 500) return { ok: true, results: [], truncated: false }
    const results = []
    let truncated = false
    for (const kind of ['d', 'f']) {
      const res = await call(loc.hostId, '__t_findn', [arg(loc.root.path), findPattern(q), kind], { cap: 1024 * 1024, timeoutMs: 20000, op: 'search' })
      if (res.error) return { ok: false, error: res.error }
      if (res.rc !== 0 && res.rc !== RC.PIPE && !res.truncated && res.rc !== 1) return { ok: false, error: rcText(res, t('main.remoteFs.searchFailed', 'The search failed.')) }
      if (res.truncated || res.rc === RC.PIPE) truncated = true
      for (const rec of res.out.toString('utf8').split('\0')) {
        const at = rec.indexOf('/./')
        if (at < 0) continue
        const rel = cleanRel(rec.slice(at + 3))
        if (!rel || rel.includes('\\')) continue
        if (!dotfiles && rel.split('/').some((s) => s.startsWith('.'))) continue
        if (within && !rel.startsWith(within)) continue
        if (results.length >= max) {
          truncated = true
          break
        }
        results.push({ name: rel.split('/').pop(), path: childPath(root, rel), rel, dir: kind === 'd' })
      }
    }
    results.sort((a, b) => a.rel.localeCompare(b.rel, undefined, { numeric: true, sensitivity: 'base' }))
    return { ok: true, results, truncated }
  }

  const HEAVY = ['node_modules', 'dist', 'build', 'out', '.next', '.cache', 'target', '.venv', '__pycache__']
  function clip(text, q) {
    const s = String(text).replace(/\r$/, '').replace(/\t/g, '  ').trim()
    if (s.length <= 240) return s
    const at = Math.max(0, s.toLowerCase().indexOf(q))
    const start = Math.max(0, Math.min(at - 60, s.length - 240))
    return (start > 0 ? '…' : '') + s.slice(start, start + 240) + (start + 240 < s.length ? '…' : '')
  }

  async function searchContent({ root, query, limit = SEARCH_LIMIT } = {}) {
    const loc = under(root, root)
    if (!loc) return { ok: false, error: t('main.explorer.invalidFolder', 'Invalid folder.') }
    const max = Number.isInteger(limit) && limit > 0 ? Math.min(limit, SEARCH_LIMIT) : SEARCH_LIMIT
    const q = String(query || '')
    if (!q.trim()) return { ok: true, results: [], truncated: false }
    if (CONTROL.test(q) || q.length > 1000) return { ok: true, results: [], truncated: false }
    const info = await repoInfo(loc)
    if (info.error) return { ok: false, error: info.error }
    const git = !!info.top
    const args = git
      ? [
          arg(loc.root.path), 'git',
          '-c', 'grep.fullName=false', '-c', 'grep.lineNumber=true', '-c', 'grep.column=false', '-c', 'grep.patternType=fixed',
          '-c', 'grep.extendedRegexp=false', '-c', 'color.grep=never',
          'grep', '-n', '-I', '-z', '-i', '-F', '--untracked', '--no-color', '-e', q, '--', '.',
          ...HEAVY.map((h) => `:(exclude,glob)**/${h}/**`)
        ]
      : [arg(loc.root.path), 'plain', q]
    const res = await call(loc.hostId, '__t_grep', args, { cap: SEARCH_OUTPUT + 1, timeoutMs: 30000, op: 'search' })
    if (res.error) return { ok: false, error: res.error }
    // 0: matches, 1: none, 141: cut at the cap; anything else is a failure.
    if (res.rc !== 0 && res.rc !== 1 && res.rc !== RC.PIPE) return { ok: false, error: rcText(res, t('main.explorer.grepFailed', 'The search failed (git grep).')) }
    const lower = q.toLowerCase()
    const results = []
    let truncated = !!res.truncated || res.rc === RC.PIPE
    for (const rec of res.out.toString('utf8').split('\n')) {
      let relRaw
      let line
      let text
      if (git) {
        const a = rec.indexOf('\0')
        const b = a < 0 ? -1 : rec.indexOf('\0', a + 1)
        if (b < 0) continue
        relRaw = rec.slice(0, a)
        line = Number(rec.slice(a + 1, b))
        text = rec.slice(b + 1)
      } else {
        const m = /^\.\/(.*?):(\d+):(.*)$/s.exec(rec)
        if (!m) continue
        relRaw = m[1]
        line = Number(m[2])
        text = m[3]
      }
      const rel = cleanRel(relRaw)
      if (!rel || rel.includes('\\') || !Number.isInteger(line) || line < 1) continue
      if (results.length >= max) {
        truncated = true
        break
      }
      results.push({ path: childPath(root, rel), rel, line, text: clip(text, lower) })
    }
    return { ok: true, results, truncated }
  }

  async function create({ root, dir, name, folder = false } = {}) {
    const bad = checkRemoteName(name)
    if (bad) return { ok: false, error: bad }
    const parent = under(root, dir || root)
    if (!parent) return { ok: false, error: t('main.explorer.outside', 'Outside the project.') }
    const n = name.trim()
    const target = childPath(dir || root, n)
    const res = await call(parent.hostId, '__t_mk', [arg(parent.root.path), arg(joinPath(parent.path, n)), folder ? '1' : '0'], { cap: 4096, op: 'save' })
    if (res.error) return { ok: false, error: res.error }
    if (res.rc === RC.EXISTS) return { ok: false, error: t('main.explorer.exists', '"{{name}}" already exists here.', { name: n }) }
    if (res.rc !== 0) return { ok: false, error: rcText(res, t('main.remoteFs.createFailed', 'It could not be created on the host.')) }
    return { ok: true, path: target }
  }

  async function rename({ root, path: p, name } = {}) {
    const bad = checkRemoteName(name)
    if (bad) return { ok: false, error: bad }
    const loc = under(root, p)
    if (!loc || !loc.rel) return { ok: false, error: t('main.explorer.outside', 'Outside the project.') }
    const n = name.trim()
    const parentVirtual = String(p).replace(/[\\/][^\\/]*$/, '')
    const to = childPath(parentVirtual, n)
    if (loc.path.split('/').pop() === n) return { ok: true, path: p }
    const res = await call(loc.hostId, '__t_mv', [arg(loc.root.path), arg(loc.path), n], { cap: 4096, op: 'save' })
    if (res.error) return { ok: false, error: res.error }
    if (res.rc === RC.EXISTS) return { ok: false, error: t('main.explorer.exists', '"{{name}}" already exists here.', { name: n }) }
    if (res.rc === RC.MISSING) return { ok: false, error: t('main.explorer.gone', 'It is already gone.') }
    if (res.rc !== 0) return { ok: false, error: rcText(res, t('main.remoteFs.renameFailed', 'It could not be renamed on the host.')) }
    return { ok: true, path: to }
  }

  // To the host user's trash (never rm): -> { ok, name } | { ok: false, error }
  // rootPath: the saved project (the host checks the item is below it);
  // entryPath: the item on the host; absPath: its absolute path (.trashinfo).
  async function trashAt(hostId, rootPath, entryPath, absPath) {
    const res = await call(
      hostId,
      '__t_trash',
      [arg(rootPath), arg(entryPath), trashInfoPath(absPath), trashDate()],
      { cap: 8192, timeoutMs: 120000, op: 'save' }
    )
    if (res.error) return { ok: false, error: res.error }
    if (res.rc === RC.MISSING) return { ok: false, error: t('main.explorer.gone', 'It is already gone.'), gone: true }
    if (res.rc !== 0) return { ok: false, error: rcText(res, t('main.remoteFs.trashFailedPlain', 'It could not be moved to the host’s trash.')) }
    return { ok: true, name: entryPath.split('/').pop(), trashPath: res.out.toString('utf8').trim() }
  }

  async function trash({ root, path: p } = {}) {
    const loc = under(root, p)
    if (!loc || !loc.rel) return { ok: false, error: t('main.explorer.outside', 'Outside the project.') }
    const info = await repoInfo(loc)
    if (info.error) return { ok: false, error: info.error }
    if (info.missing) return { ok: false, error: t('main.explorer.folderGone', 'The folder is gone.') }
    return trashAt(loc.hostId, loc.root.path, loc.path, joinPath(info.realRoot, loc.rel))
  }

  // --- Editor ----------------------------------------------------------------------------
  function locateFile(file) {
    const loc = isRemotePath(file) ? locate(file) : null
    return loc && loc.rel ? loc : null
  }
  const notInProject = () => t('main.remoteFs.noProject', 'This remote file is not in an open remote project.')

  // -> { ok, text, bom, size, mtimeMs, sig, hash } | { ok: false, error, code }
  async function readForEdit(file) {
    const loc = locateFile(file)
    if (!loc) return { ok: false, error: notInProject(), code: 'error' }
    const res = await call(loc.hostId, '__t_read', [arg(loc.root.path), arg(loc.path), String(MAX_EDIT_BYTES)], {
      cap: MAX_EDIT_BYTES + HEADER_SLACK,
      timeoutMs: 120000,
      op: 'read'
    })
    if (res.error) return { ok: false, error: res.error, code: 'error' }
    if (res.rc === RC.MISSING) return { ok: false, error: t('main.editor.notFound', 'The file was not found.'), code: 'missing' }
    if (res.rc === RC.TOO_LARGE) return { ok: false, error: t('main.editor.tooLarge', 'This file is too large to edit here (over 50 MB).'), code: 'too-large' }
    if (res.rc === RC.NOT_FILE || res.rc === RC.IS_DIR) return { ok: false, error: t('main.editor.notFile', 'This is not a file.'), code: 'not-file' }
    if (res.rc !== 0 || res.truncated) return { ok: false, error: rcText(res, t('main.editor.readFailed', 'The file could not be read.')), code: 'error' }
    const nl = res.out.indexOf(0x0a)
    const head = nl < 0 ? '' : res.out.subarray(0, nl).toString('latin1')
    const st = parseStat(head)
    const hash = head.split(' ')[4] || ''
    if (!st) return { ok: false, error: t('main.editor.readFailed', 'The file could not be read.'), code: 'error' }
    const buf = res.out.subarray(nl + 1)
    if (looksBinary(buf)) return { ok: false, error: t('main.editor.binary', 'Binary file: open it with its own program'), code: 'binary' }
    const bom = buf.length >= 3 && buf.subarray(0, 3).equals(BOM)
    let text
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bom ? buf.subarray(3) : buf)
    } catch {
      return { ok: false, error: t('main.editor.notUtf8', 'This file is not UTF-8 text: open it with another editor.'), code: 'encoding' }
    }
    const entry = watchedFiles.get(`${loc.hostId}\n${loc.path}`)
    if (entry) entry.sig = st.sig
    return { ok: true, text, bom, size: buf.length, mtimeMs: st.mtimeMs, sig: st.sig, hash: HASH_RE.test(hash) ? hash : undefined }
  }

  async function statForEdit(file) {
    const loc = locateFile(file)
    if (!loc) return { ok: false, error: notInProject() }
    const res = await call(loc.hostId, '__t_stats', [arg(loc.root.path), arg(loc.path)], { cap: 4096, op: 'read' })
    if (res.error) return { ok: false, error: res.error }
    const st = res.rc === 0 ? parseStat(res.out.toString('latin1')) : null
    return st ? { ok: true, exists: true, ...st } : { ok: true, exists: false, sig: null }
  }

  // { file, text, bom, expectSig, expectHash } -> like editorFiles.writeForEdit.
  // privateNew: a file created by this write is readable by its owner only
  // (0600; an automation's prompt).
  async function writeForEdit({ file, text, bom = false, expectSig, expectHash, privateNew = false } = {}) {
    const loc = locateFile(file)
    if (!loc) return { ok: false, error: notInProject() }
    if (typeof text !== 'string') return { ok: false, error: t('main.editor.nothingToWrite', 'Nothing to write.') }
    const data = bom ? Buffer.concat([BOM, Buffer.from(text, 'utf8')]) : Buffer.from(text, 'utf8')
    if (data.length > MAX_EDIT_BYTES) return { ok: false, error: t('main.editor.textTooLarge', 'The text is too large to save (over 50 MB).') }
    const hash = typeof expectHash === 'string' && HASH_RE.test(expectHash) ? expectHash : ''
    const res = await call(loc.hostId, '__t_write', [arg(loc.root.path), arg(loc.path), hash, hash ? '' : sigForHost(expectSig), privateNew ? '600' : ''], {
      cap: 64 * 1024,
      upload: data,
      timeoutMs: 30000 + Math.ceil(data.length / (512 * 1024)) * 1000,
      op: 'save'
    })
    if (res.error) return { ok: false, error: res.error }
    if (res.rc === RC.CONFLICT) {
      const st = parseStat(res.out.toString('latin1'))
      return { ok: false, conflict: true, sig: st ? st.sig : null, error: t('main.editor.changedOnDisk', 'The file was changed on disk by another program.') }
    }
    if (res.rc === RC.IS_DIR) return { ok: false, error: t('main.editor.isFolder', 'This is a folder.') }
    if (res.rc !== 0) return { ok: false, error: rcText(res, t('main.editor.writeFailed', 'The file could not be written.')) }
    const line = res.out.toString('latin1').trim()
    const st = parseStat(line)
    const newHash = line.split(' ')[4] || ''
    if (!st) return { ok: false, error: t('main.editor.writeFailed', 'The file could not be written.') }
    const entry = watchedFiles.get(`${loc.hostId}\n${loc.path}`)
    if (entry) entry.sig = st.sig
    return { ok: true, size: st.size, mtimeMs: st.mtimeMs, sig: st.sig, hash: HASH_RE.test(newHash) ? newHash : undefined }
  }

  // The file as in the last commit, for the editor's Changes view.
  async function headContent(file) {
    const loc = locateFile(file)
    if (!loc) return { ok: false, error: notInProject() }
    const info = await repoInfo(loc)
    if (info.error) return { ok: false, error: info.error }
    if (info.missing || !info.top)
      return { ok: true, repo: false, isNew: true, text: '', note: t('main.editor.noteNotRepo', 'Not in a git repository: there is no committed version to compare with.') }
    const fromTop = relativeTo(info.top, joinPath(info.realRoot, loc.rel))
    if (!fromTop)
      return { ok: true, repo: false, isNew: true, text: '', note: t('main.editor.noteOutside', 'Outside the repository: there is no committed version to compare with.') }
    const res = await call(loc.hostId, '__t_gitin', [arg(loc.root.path), arg(info.top), ...info.gitArgs, 'show', '--no-textconv', `HEAD:${fromTop}`], { cap: MAX_HEAD_BYTES + 1, timeoutMs: 30000, op: 'read' })
    if (res.error) return { ok: false, error: res.error }
    if (res.truncated) return { ok: false, error: t('main.editor.headTooLarge', 'The committed version is too large to compare (over 10 MB).') }
    if (res.rc !== 0) {
      const noHead = /bad revision|unknown revision|invalid object name 'HEAD'|ambiguous argument 'HEAD'/i.test(res.err)
      return {
        ok: true,
        repo: true,
        isNew: true,
        text: '',
        note: noHead
          ? t('main.editor.noteNoCommit', 'No commit yet: the left side is empty.')
          : t('main.editor.noteNewFile', 'Not in the last commit (a new file): the left side is empty.')
      }
    }
    const buf = res.out
    if (looksBinary(buf)) return { ok: false, error: t('main.editor.headBinary', 'The committed version is binary: it cannot be compared here.') }
    const body = buf.length >= 3 && buf.subarray(0, 3).equals(BOM) ? buf.subarray(3) : buf
    return { ok: true, repo: true, isNew: false, text: body.toString('utf8'), note: '' }
  }

  // An image (Markdown pictures, the image view) as a data URL.
  async function readImage(file) {
    if (fileKind(file) !== 'image') return { ok: false, error: t('main.file.notImage', 'Not an image.') }
    const loc = locateFile(file)
    if (!loc) return { ok: false, error: notInProject() }
    const res = await call(loc.hostId, '__t_read', [arg(loc.root.path), arg(loc.path), String(MAX_IMAGE)], { cap: MAX_IMAGE + HEADER_SLACK, timeoutMs: 120000, op: 'read' })
    if (res.error) return { ok: false, error: res.error }
    if (res.rc === RC.TOO_LARGE) return { ok: false, kind: 'image', error: t('main.file.imageTooLarge', 'This image is too large to show here.') }
    if (res.rc !== 0 || res.truncated) return { ok: false, error: rcText(res, t('main.file.notFound', 'The file was not found.')) }
    const nl = res.out.indexOf(0x0a)
    const data = res.out.subarray(nl + 1)
    return { ok: true, kind: 'image', size: data.length, dataUrl: `data:${IMAGE_MIME[extOf(file)]};base64,${data.toString('base64')}` }
  }

  // --- Watching (polled: nothing like inotify reaches Windows over ssh) -----------
  function ensurePoll() {
    if (pollTimer || (!watchedRoots.size && !watchedFiles.size)) return
    pollTimer = timers.setInterval(() => {
      poll().catch(() => {})
    }, FILE_POLL_MS)
    if (pollTimer && pollTimer.unref) pollTimer.unref()
  }
  function stopPollIfIdle() {
    if (pollTimer && !watchedRoots.size && !watchedFiles.size) {
      timers.clearInterval(pollTimer)
      pollTimer = null
    }
  }

  async function poll() {
    if (polling) return
    polling = true
    pollTick++
    try {
      // The project: anything newer than the last look (find -newer, no git:
      // a repository's settings never run from a background check). Bounded
      // on the host (10 s); a project too big for that is looked at less
      // often, and the session goes on (no new sign-in).
      for (const [virtual, w] of watchedRoots) {
        if (pollTick < w.next) continue
        const res = await call(w.hostId, '__t_fp', [arg(w.root.path), String(w.marker)], { cap: 4096, quiet: true, timeoutMs: 10000 })
        if (res.skipped || res.error) {
          w.next = pollTick + 1
          continue
        }
        if (res.rc === RC.TIMEOUT) {
          w.every = Math.min(w.every * 2, ROOT_POLL_MAX_TICKS)
          w.next = pollTick + w.every
          continue
        }
        w.every = ROOT_POLL_TICKS
        w.next = pollTick + w.every
        if (res.rc === 0 && res.out.toString('latin1').trim() === 'changed' && watchedRoots.get(virtual) === w) {
          // Its files or its git state changed: the window reads again.
          repoInfos.delete(`${w.hostId}\n${w.root.path}`)
          send('explorer:changed', virtual)
        }
      }
      const groups = new Map()
      for (const e of watchedFiles.values()) {
        const k = `${e.loc.hostId}\n${e.loc.root.path}`
        if (!groups.has(k)) groups.set(k, [])
        groups.get(k).push(e)
      }
      for (const list of groups.values()) {
        const { hostId, root } = list[0].loc
        const res = await call(hostId, '__t_stats', [arg(root.path), ...list.map((e) => arg(e.loc.path))], { cap: 256 * 1024, quiet: true, timeoutMs: 20000 })
        if (res.skipped || res.error || res.rc !== 0) continue
        const lines = res.out.toString('latin1').split('\n')
        list.forEach((e, i) => {
          if (watchedFiles.get(`${hostId}\n${e.loc.path}`) !== e) return
          const st = parseStat(lines[i])
          const sig = st ? st.sig : null
          if (e.sig === undefined) {
            e.sig = sig
            return
          }
          if (sig === e.sig) return
          e.sig = sig
          send('editor:changed', { path: e.virtual, exists: sig !== null, size: st ? st.size : 0, mtimeMs: st ? st.mtimeMs : 0, sig })
        })
      }
    } finally {
      polling = false
    }
  }

  // The project the Files tab shows (one at a time, like the local watch).
  function watchRoot(root) {
    const loc = under(root, root)
    if (!loc) return { ok: false }
    if (!watchedRoots.has(root)) {
      watchedRoots.clear()
      watchedRoots.set(root, { hostId: loc.hostId, root: loc.root, marker: ++markerSeq, every: ROOT_POLL_TICKS, next: 0 })
    }
    ensurePoll()
    return { ok: true }
  }
  function unwatchRoots() {
    watchedRoots.clear()
    stopPollIfIdle()
    return { ok: true }
  }
  // The remote files open in the editor (others stop being watched).
  function watchFiles(paths) {
    const want = new Map()
    for (const p of Array.isArray(paths) ? paths.slice(0, MAX_WATCHED) : []) {
      const loc = locateFile(p)
      if (loc) want.set(`${loc.hostId}\n${loc.path}`, { virtual: p, loc })
    }
    for (const k of [...watchedFiles.keys()]) if (!want.has(k)) watchedFiles.delete(k)
    for (const [k, v] of want) if (!watchedFiles.has(k)) watchedFiles.set(k, { ...v, sig: undefined })
    ensurePoll()
    stopPollIfIdle()
    return watchedFiles.size
  }

  // --- Source control: sourceControl.js's operations over the session ---------
  // A top: { hostId, rootPath (the saved project: every file read, counted or
  // moved must be below it on the host), real (the repository's real path,
  // for git -C only), virtual (as the window has it), args (the -c overrides
  // of gitSafety.js until the repository is trusted) }.
  const gitResult = (res, maxBuffer) => {
    if (res.error) return { ok: false, code: -1, stdout: '', stderr: '', error: res.error }
    const truncated = res.out.length > maxBuffer
    return {
      ok: res.rc === 0 && !truncated,
      code: res.rc,
      stdout: res.out.toString('utf8'),
      stderr: res.err || '',
      error: truncated ? 'maxBuffer exceeded' : res.rc === 0 ? null : `exit code ${res.rc}` // i18n-ignore matched by sourceControl.js, not shown
    }
  }
  const scmBackend = {
    async repoOf(root) {
      const loc = isRemotePath(root) && rootOf(root) ? locate(root, root) : null
      if (!loc) return { error: t('main.scm.invalidFolder', 'Invalid folder.') }
      const info = await repoInfo(loc)
      if (info.error) return { error: info.error }
      if (info.missing) return { error: t('main.scm.folderMissing', 'The folder is missing.') }
      if (!info.top) return { error: t('main.scm.notRepo', 'This folder is not in a git repository.'), notRepo: true }
      return { top: { hostId: loc.hostId, rootPath: loc.root.path, real: info.top, virtual: topVirtual(loc, info), args: info.gitArgs } }
    },
    async git(top, args, opts = {}) {
      const maxBuffer = opts.maxBuffer || 32 * 1024 * 1024
      let list = args
      let upload = null
      // A commit message goes in through stdin (base64), never as an argument.
      if (args[0] === 'commit' && args[1] === '-m') {
        upload = Buffer.from(String(args[2] || ''), 'utf8')
        list = ['-F', 'commit', ...args.slice(3)]
      }
      const slow = ['push', 'pull', 'fetch', 'commit'].includes(list[0] === '-F' ? list[1] : list[0])
      // "-F" (the uploaded message) must come first for __t_gitin; the -c
      // overrides go right after it, before the git command.
      const gitArgs = list[0] === '-F' ? ['-F', ...top.args, ...list.slice(1)] : [...top.args, ...list]
      const res = await call(top.hostId, '__t_gitin', [arg(top.rootPath), arg(top.real), ...gitArgs], {
        cap: maxBuffer + 1,
        timeoutMs: opts.timeout || 30000,
        upload,
        op: slow ? list[0] === '-F' ? 'commit' : list[0] : 'git'
      })
      return gitResult(res, maxBuffer)
    },
    relIn(top, p) {
      if (typeof p !== 'string' || !p || p.includes('\0') || p.length > 4096) return null
      let rel
      if (isRemotePath(p)) {
        const pp = parseRemotePath(p)
        const tp = parseRemotePath(top.virtual)
        if (!pp || !tp || pp.hostId !== tp.hostId) return null
        rel = relativeTo(tp.path, pp.path)
        if (!rel) return null
      } else rel = cleanRel(p)
      if (!rel || rel.split('/')[0].toLowerCase() === '.git') return null
      return rel
    },
    key: (top) => `${top.hostId}\n${top.real}`,
    present: (top) => top.virtual,
    fullPath: (top, rel) => childPath(top.virtual, rel),
    async operation(top) {
      const res = await call(top.hostId, '__t_gitop', [arg(top.rootPath), arg(top.real)], { cap: 1024, op: 'status' })
      const op = !res.error && res.rc === 0 ? res.out.toString('latin1').trim() : ''
      return ['rebase', 'merge', 'cherry-pick'].includes(op) ? op : null
    },
    async untracked(top, rels) {
      const out = new Map()
      const list = (rels || []).filter((r) => typeof r === 'string' && r && !CONTROL.test(r)).slice(0, 2000)
      for (let i = 0; i < list.length; i += 200) {
        const chunk = list.slice(i, i + 200)
        const res = await call(top.hostId, '__t_wcl', [arg(top.rootPath), arg(top.real), ...chunk], { cap: 256 * 1024, timeoutMs: 30000, op: 'status' })
        if (res.error || res.rc !== 0) break
        const lines = res.out.toString('latin1').split('\n')
        chunk.forEach((rel, j) => {
          const n = Number(lines[j])
          out.set(rel, Number.isInteger(n) && n >= 0 ? { added: n } : {})
        })
      }
      return out
    },
    // The host's checks happen in the trash operation itself.
    prepareTrash: (_top, rels) => ({ targets: rels }),
    async trash(top, rels) {
      let trashed = 0
      for (const rel of rels) {
        const res = await trashAt(top.hostId, top.rootPath, joinPath(top.real, rel), joinPath(top.real, rel))
        if (res.ok) trashed++
        else if (!res.gone)
          return { trashed, error: t('main.remoteFs.trashFailed', 'Could not move {{path}} to the host’s trash: {{error}}', { path: rel, error: res.error }) }
      }
      return { trashed }
    },
    async working(top, rel, { content = true } = {}) {
      const file = joinPath(top.real, rel)
      if (!content) {
        const res = await call(top.hostId, '__t_stats', [arg(top.rootPath), arg(file)], { cap: 4096, op: 'read' })
        if (res.error) return { error: res.error }
        return { exists: res.rc === 0 && !!parseStat(res.out.toString('latin1')), version: { text: '' } }
      }
      const res = await call(top.hostId, '__t_read', [arg(top.rootPath), arg(file), String(MAX_VERSION)], { cap: MAX_VERSION + HEADER_SLACK, timeoutMs: 60000, op: 'read' })
      if (res.error) return { error: res.error }
      if (res.rc === RC.TOO_LARGE) return { exists: true, version: { tooBig: true } }
      if (res.rc === RC.OUTSIDE) return { error: rcText(res, '') }
      if (res.rc !== 0) return { exists: false, version: { text: '' } }
      const nl = res.out.indexOf(0x0a)
      return { exists: true, version: { text: res.out.subarray(nl + 1).toString('utf8') } }
    }
  }
  const scm = createScm(scmBackend)
  const remoteOnly = () => ({ ok: false, error: t('main.remoteFs.localOnly', 'Not available for a project on a remote host.') })

  // The window's view of a host's session.
  function snapshot() {
    const out = {}
    for (const [hostId, e] of sessions) out[hostId] = { state: e.session && e.session.state === 'ready' ? (e.busy ? 'busy' : 'ready') : 'connecting', pending: e.busy, op: e.op }
    return out
  }

  // --- The sidebar's branch and worktrees -------------------------------------------
  // Like worktreeList.js for a local project, over the host's session, and
  // only when that session is already signed in (never a password question
  // from a background refresh: a host not connected keeps what was shown).
  // Paths come back as the window addresses them (virtual). ->
  // { ok: true, repo, branch, head, worktrees: [{ path, branch, head, isMain,
  // locked, prunable, self }] } | { ok: false, error: 'invalid' |
  // 'unknown-folder' | 'not-repo' | 'offline' | 'failed' }
  async function gitWorktrees(root) {
    if (!isRemotePath(root)) return { ok: false, error: 'invalid' }
    const r = rootOf(root)
    if (!r) return { ok: false, error: 'unknown-folder' }
    const res = await call(r.hostId, '__t_wtl', [arg(r.path), String(MAX_WORKTREES + 1)], { cap: WORKTREES_OUTPUT, timeoutMs: WORKTREES_TIMEOUT_MS, ifOpen: true })
    if (res.skipped) return { ok: false, error: 'offline' }
    if (res.error) return { ok: false, error: 'failed' }
    if (res.rc === RC.NOT_REPO || res.rc === RC.NO_GIT || res.rc === RC.MISSING) return { ok: true, repo: false, branch: '', head: '', worktrees: [] }
    const truncated = !!res.truncated || res.rc === RC.PIPE
    if (res.rc !== 0 && !truncated) return { ok: false, error: 'failed' }
    const parsed = parseRemoteWorktrees(res.out, { truncated })
    if (!parsed) return { ok: false, error: 'failed' }
    r.real = parsed.root
    const worktrees = []
    for (const w of parsed.worktrees) {
      const path = remoteRoot(r.hostId, w.path)
      if (!path) continue
      // The project's own checkout (its repository's top: the project
      // folder or a folder above it) is the project's card, not another branch.
      worktrees.push({ ...w, path, ...(w.path === parsed.top ? { self: true } : {}) })
    }
    return { ok: true, repo: true, branch: parsed.branch, head: parsed.head, truncated, worktrees }
  }

  // --- GitHub (Create PR, the GitHub form) ---------------------------------------
  // What gh needs to work on a remote project's repository from this
  // computer: its GitHub remote's URL and its branch, read on the host (the
  // user asked: the session may sign in). Remotes in gh's own order
  // (upstream, github, origin, then the first). -> { ok, remoteUrl, branch } |
  // { ok: false, error }
  async function githubContext(root) {
    const loc = under(root, root)
    if (!loc) return { ok: false, error: t('main.scm.invalidFolder', 'Invalid folder.') }
    const info = await repoInfo(loc)
    if (info.error) return { ok: false, error: info.error }
    if (info.missing || !info.top) return { ok: false, error: t('main.scm.notRepo', 'This folder is not in a git repository.') }
    const git = (args, cap = 64 * 1024) => call(loc.hostId, '__t_gitin', [arg(loc.root.path), arg(info.top), ...info.gitArgs, ...args], { cap, op: 'git' })
    const rem = await git(['remote', '-v'])
    if (rem.error) return { ok: false, error: rem.error }
    const fetchUrls = new Map()
    for (const line of rem.out.toString('utf8').split('\n')) {
      const m = /^(\S+)\t(\S+) \(fetch\)$/.exec(line.replace(/\r$/, ''))
      if (m && !fetchUrls.has(m[1])) fetchUrls.set(m[1], m[2])
    }
    const name = ['upstream', 'github', 'origin'].find((n) => fetchUrls.has(n)) || [...fetchUrls.keys()][0]
    if (!name) return { ok: false, error: t('main.github.noRepo', 'The current directory has no supported GitHub repository.') }
    const head = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], 4096)
    if (head.error) return { ok: false, error: head.error }
    const branch = head.rc === 0 ? head.out.toString('utf8').trim() : ''
    return { ok: true, remoteUrl: fetchUrls.get(name), branch: CONTROL.test(branch) ? '' : branch }
  }

  // --- Add a project on the host ------------------------------------------------
  // The one exception to "only below a saved project": the window picks a
  // folder on the host before any project exists. Only through the host's
  // signed-in session; listing gives names and kinds (never contents),
  // bounded in count, size and time; clone and create make ONE new folder
  // in a folder the user chose, with a name checked here and on the host.
  const hostIdOk = (hostId) => typeof hostId === 'string' && /^[\w-]{1,80}$/.test(hostId)

  // Signs in to the host (askpass dialog as the terminals) and keeps the
  // session. -> { ok } | { ok: false, error, cancelled? }
  async function connect(hostId) {
    if (!hostIdOk(hostId)) return { ok: false, error: t('main.remote.notFound', 'This remote host is no longer saved in Tessel.') }
    // The user's own action (Connect, Add a project): it may sign in.
    allow(hostId)
    try {
      await open(hostId)
      return { ok: true }
    } catch (err) {
      const code = err && err.code
      return { ok: false, error: sessionErrorText(hostId, err), ...(code === 'cancelled' || code === 'auth-cancelled' ? { cancelled: true } : {}) }
    }
  }

  function addErrorText(hostId, res, fallback) {
    switch (res.rc) {
      case RC.MISSING:
        return t('main.remoteFs.browseMissing', 'This folder does not exist on the host.')
      case RC.DENIED:
        return t('main.remoteFs.browseDenied', 'Permission denied: this folder cannot be read.')
      case RC.NO_GIT:
        return t('main.remoteFs.noGit', 'Git is not installed on {{host}}.', { host: hostLabel(hostId) })
      case RC.OUTSIDE:
        return t('main.remoteFs.badProjectName', 'This name cannot be a folder name on the host.')
      default:
        return rcText(res, fallback)
    }
  }

  // -> { ok, path (its real path), entries: [{ name, dir, link? }], truncated } | { ok: false, error }
  // Agents on this host (remoteAgent/remoteAgentSetup.js): the shim put in
  // ~/.tessel-server (once per version) and its `install` run there.
  // -> { rc, out, err } | { error }
  async function installAgentShim(hostId, { version, source } = {}) {
    if (!hostIdOk(hostId)) return { error: t('main.remote.notFound', 'This remote host is no longer saved in Tessel.') }
    if (typeof version !== 'string' || !/^[0-9A-Za-z.-]{1,40}$/.test(version)) return { error: 'bad shim version' } // i18n-ignore internal
    allow(hostId)
    return call(hostId, '__t_ragent', [version], { cap: 64 * 1024, timeoutMs: 60_000, upload: Buffer.from(String(source || ''), 'utf8'), op: 'agent' })
  }

  // The agents installed on this host (__t_agents): their paths, never run.
  // Only through a session the host allows (a terminal opened on it).
  // -> { claude, codex, vscodeClaude } (null when missing) | { error }
  async function agentTools(hostId) {
    if (!hostIdOk(hostId)) return { error: t('main.remote.notFound', 'This remote host is no longer saved in Tessel.') }
    const res = await call(hostId, '__t_agents', [], { cap: 16 * 1024, timeoutMs: 30_000, op: 'agents' })
    if (!res || res.error) return { error: (res && res.error) || 'failed' }
    if (res.rc !== 0) return { error: rcText(res, `rc ${res.rc}`) }
    return parseAgentTools(Buffer.isBuffer(res.out) ? res.out.toString('utf8') : String(res.out || ''))
  }

  // Whether a request can run on the host without any sign-in: its
  // session is up, or its shared ssh2 connection is signed in already.
  function connectedQuietly(hostId) {
    if (!hostIdOk(hostId)) return false
    const entry = sessions.get(hostId)
    if (entry && !entry.closed && entry.session && entry.session.state === 'ready') return true
    try {
      return !!(hosts.sharedConnected && hosts.sharedConnected(hostId))
    } catch {
      return false
    }
  }

  // The agent sessions on this host (the shim's `sessions`: ids, folders,
  // titles). Never a sign-in: a host that is not connected says so.
  // -> { ok: true, sessions: [row + host] } | { ok: false, error, notConnected? }
  async function listAgentSessions(hostId, limit) {
    if (!hostIdOk(hostId)) return { ok: false, error: t('main.remote.notFound', 'This remote host is no longer saved in Tessel.') }
    const notConnected = () => ({ ok: false, notConnected: true, error: t('main.remoteFs.notConnected', '{{host}} is not connected. Use Connect to sign in.', { host: hostLabel(hostId) }) })
    if (!connectedQuietly(hostId)) return notConnected()
    const n = remoteSessionsLimit(limit)
    const entry = sessions.get(hostId)
    const open = !!(entry && !entry.closed && entry.session && entry.session.state === 'ready')
    // An open session: used as is (never reopened). None yet on a signed-in
    // shared connection: one exec channel there, nothing to ask.
    const res = await call(hostId, '__t_rsess', [String(n)], { cap: 4 * 1024 * 1024, timeoutMs: 30_000, op: 'sessions', ...(open ? { ifOpen: true } : {}) })
    if (!res || res.skipped) return notConnected()
    if (res.error) return { ok: false, error: res.error }
    if (res.rc === 81) return { ok: false, noHelper: true, error: t('main.remoteFs.sessionsNoHelper', "Tessel's helper is not set up on {{host}} yet: its agent sessions cannot be listed.", { host: hostLabel(hostId) }) }
    const unreadable = () => ({ ok: false, error: t('main.remoteFs.sessionsUnreadable', 'The agent sessions on {{host}} could not be read.', { host: hostLabel(hostId) }) })
    if (res.rc !== 0) return unreadable()
    const rows = parseRemoteSessions(Buffer.isBuffer(res.out) ? res.out.toString('utf8') : String(res.out || ''), hostId, n)
    return rows ? { ok: true, sessions: rows } : unreadable()
  }

  // One agent conversation file on this host (__t_tread: Claude Code's
  // transcript or a Codex rollout, found by its id in the agent's own folder
  // there), a bounded window of it: offset null = its last `cap` bytes, else
  // from that byte on. Never a sign-in, like listAgentSessions.
  // -> { ok: true, size, data: Buffer } | { ok: false, missing? , notConnected?, error }
  async function readAgentFile(hostId, { agent, id, offset = null, cap = 4 * 1024 * 1024 } = {}) {
    if (!hostIdOk(hostId)) return { ok: false, error: t('main.remote.notFound', 'This remote host is no longer saved in Tessel.') }
    if ((agent !== 'claude' && agent !== 'codex') || typeof id !== 'string' || !/^[0-9A-Za-z-]{8,100}$/.test(id)) return { ok: false, error: 'invalid' }
    if (offset !== null && !(Number.isSafeInteger(offset) && offset >= 0)) return { ok: false, error: 'invalid' }
    const max = Number.isSafeInteger(cap) && cap > 0 ? Math.min(cap, 32 * 1024 * 1024) : 4 * 1024 * 1024
    if (!connectedQuietly(hostId)) return { ok: false, notConnected: true, error: t('main.remoteFs.notConnected', '{{host}} is not connected. Use Connect to sign in.', { host: hostLabel(hostId) }) }
    const entry = sessions.get(hostId)
    const open = !!(entry && !entry.closed && entry.session && entry.session.state === 'ready')
    const res = await call(hostId, '__t_tread', [agent, id, offset === null ? '-' : String(offset), String(max)], { cap: max + 64, timeoutMs: 30_000, op: 'read', ...(open ? { ifOpen: true } : {}) })
    if (!res || res.skipped) return { ok: false, notConnected: true, error: t('main.remoteFs.notConnected', '{{host}} is not connected. Use Connect to sign in.', { host: hostLabel(hostId) }) }
    if (res.error) return { ok: false, error: res.error }
    if (res.rc === RC.MISSING) return { ok: false, missing: true, error: 'missing' }
    if (res.rc !== 0) return { ok: false, error: rcText(res, `rc ${res.rc}`) }
    const out = Buffer.isBuffer(res.out) ? res.out : Buffer.from(String(res.out || ''), 'utf8')
    const nl = out.indexOf(10)
    const size = nl > 0 ? Number(out.toString('latin1', 0, nl)) : NaN
    if (!Number.isSafeInteger(size) || size < 0) return { ok: false, error: 'unreadable' }
    return { ok: true, size, data: out.subarray(nl + 1) }
  }

  async function browse({ hostId, path } = {}) {
    if (!hostIdOk(hostId)) return { ok: false, error: t('main.remote.notFound', 'This remote host is no longer saved in Tessel.') }
    allow(hostId)
    const p = cleanBrowsePath(path === undefined || path === null || path === '' ? '~' : path)
    if (!p) return { ok: false, error: t('main.remoteFs.badPath', 'This path has characters Tessel cannot send to the remote host.') }
    const res = await call(hostId, '__t_browse', [arg(p), String(MAX_BROWSE_ENTRIES + 1)], { cap: 4 * 1024 * 1024, timeoutMs: BROWSE_TIMEOUT_MS, op: 'list' })
    if (res.error) return { ok: false, error: res.error }
    const parsed = parseBrowse(res.out)
    if (res.rc === RC.DENIED && parsed.path) return { ok: false, path: parsed.path, error: addErrorText(hostId, res) }
    if (res.rc !== 0 && !(res.rc === RC.PIPE || res.truncated)) return { ok: false, error: addErrorText(hostId, res, t('main.explorer.folderUnreadable', 'The folder could not be read.')) }
    if (!parsed.path.startsWith('/')) return { ok: false, error: t('main.explorer.folderUnreadable', 'The folder could not be read.') }
    return { ok: true, path: parsed.path, entries: parsed.entries, truncated: parsed.truncated || !!res.truncated }
  }

  // git clone <url> into <parent>/<name from the URL>, on the host.
  // -> { ok, path, name } | { ok: false, error }
  async function cloneProject({ hostId, url, parent } = {}) {
    if (!hostIdOk(hostId)) return { ok: false, error: t('main.remote.notFound', 'This remote host is no longer saved in Tessel.') }
    allow(hostId)
    const checked = validateCloneUrl(url)
    if (checked.error) return { ok: false, error: addProjectErrorText(checked.error) }
    // A Windows path names a folder on this computer, not on the host.
    if (/^([A-Za-z]:[\\/]|\\\\)/.test(checked.url)) return { ok: false, error: addProjectErrorText('url-scheme') }
    const dest = cleanBrowsePath(parent)
    if (!dest) return { ok: false, error: addProjectErrorText('destination-invalid') }
    const name = deriveCloneRepoName(checked.url)
    if (!name || checkRemoteName(name)) return { ok: false, error: addProjectErrorText('name-invalid') }
    const res = await call(hostId, '__t_clone', [arg(dest), name, checked.url], { cap: 64 * 1024, timeoutMs: CLONE_TIMEOUT_MS, op: 'clone' })
    if (res.error) return { ok: false, error: res.error }
    if (res.rc === RC.EXISTS)
      return { ok: false, error: t('main.project.clone.exists', 'Destination already exists and is not empty: {{path}}. Choose a different parent folder, delete the existing folder, or add the existing repository instead.', { path: `${dest.replace(/\/$/, '')}/${name}` }) }
    if (res.rc === RC.FAILED) return { ok: false, error: cloneFailureMessage(res.err, `${dest}/${name}`) }
    if (res.rc !== 0) return { ok: false, error: addErrorText(hostId, res, t('main.remoteFs.cloneFailed', 'The clone failed on the host.')) }
    const path = res.out.toString('utf8').split('\n')[0]
    if (!path.startsWith('/') || CONTROL.test(path)) return { ok: false, error: t('main.remoteFs.cloneFailed', 'The clone failed on the host.') }
    return { ok: true, path, name }
  }

  // mkdir <parent>/<name> (or an empty folder there), git init and an empty
  // first commit, on the host. -> { ok, path, name } | { ok: false, error }
  async function createProject({ hostId, parent, name } = {}) {
    if (!hostIdOk(hostId)) return { ok: false, error: t('main.remote.notFound', 'This remote host is no longer saved in Tessel.') }
    allow(hostId)
    const n = String(name ?? '').trim()
    if (!n) return { ok: false, error: t('main.project.create.nameEmpty', 'Name cannot be empty') }
    const bad = checkRemoteName(n)
    if (bad) return { ok: false, error: bad }
    const dest = cleanBrowsePath(parent)
    if (!dest) return { ok: false, error: t('main.project.create.parentAbsolute', 'Parent directory must be an absolute path') }
    const res = await call(hostId, '__t_newproj', [arg(dest), n], { cap: 64 * 1024, timeoutMs: NEWPROJ_TIMEOUT_MS, op: 'create' })
    if (res.error) return { ok: false, error: res.error }
    if (res.rc === RC.EXISTS)
      return { ok: false, error: t('main.project.create.notEmpty', '"{{name}}" already exists at this location and is not empty.', { name: n }) }
    if (res.rc !== 0) return { ok: false, error: addErrorText(hostId, res, t('main.project.create.initFailed', 'Failed to initialize git repository: {{error}}', { error: firstLine(res.err) })) }
    const path = res.out.toString('utf8').split('\n')[0]
    if (!path.startsWith('/') || CONTROL.test(path)) return { ok: false, error: t('main.project.unknownError', 'unknown error') }
    return { ok: true, path, name: n }
  }

  function close() {
    for (const hostId of [...sessions.keys()]) closeHost(hostId, 'shutdown')
    watchedRoots.clear()
    watchedFiles.clear()
    stopPollIfIdle()
    if (idleTimer) timers.clearInterval(idleTimer)
    idleTimer = null
  }

  return {
    allow,
    allowPath,
    setRoots,
    listDir,
    projectStatus,
    sparseInfo,
    searchNames,
    searchContent,
    create,
    rename,
    trash,
    readForEdit,
    statForEdit,
    writeForEdit,
    headContent,
    readImage,
    watchRoot,
    unwatchRoots,
    watchFiles,
    // Discard sends untracked files to the host's trash (no Recycle Bin here).
    scm: { ...scm, scmDiscard: (q) => scm.scmDiscard(q) },
    remoteOnly,
    gitWorktrees,
    githubContext,
    connect,
    installAgentShim,
    agentTools,
    connectedQuietly,
    listAgentSessions,
    readAgentFile,
    browse,
    cloneProject,
    createProject,
    closeHost,
    closePane,
    snapshot,
    close,
    poll
  }
}

// The remote projects of a saved layout (the window's workspace-layout.json,
// which index.js stores): their virtual roots. Only these are ever read.
export function remoteRootsOfLayout(data) {
  const list = data && typeof data === 'object' && Array.isArray(data.workspaces) ? data.workspaces : []
  const out = []
  for (const w of list.slice(0, MAX_ROOTS)) {
    const r = w && w.remote
    const v = r && typeof r === 'object' ? remoteRoot(r.hostId, r.path) : null
    if (v && !out.includes(v)) out.push(v)
  }
  return out
}

// IPC of the remote session itself (the rest goes through the usual
// explorer:*, editor:* and scm:* channels).
export function registerRemoteFs({ ipcMain, service }) {
  const guard = (fn) => async (_evt, arg) => {
    try {
      return await fn(arg)
    } catch {
      return { ok: false, error: 'failed' }
    }
  }
  ipcMain.handle('remoteFs:cancel', guard((hostId) => ({ ok: true, closed: service.closeHost(String(hostId || ''), 'cancelled') })))
  ipcMain.handle('remoteFs:state', guard(() => ({ ok: true, sessions: service.snapshot() })))
  // Add a project on a host: ids, paths, a URL and a name; never a command.
  const obj = (q) => (q && typeof q === 'object' ? q : {})
  ipcMain.handle('remoteFs:connect', guard((hostId) => service.connect(String(hostId || ''))))
  ipcMain.handle('remoteFs:browse', guard((q) => service.browse({ hostId: String(obj(q).hostId || ''), path: obj(q).path })))
  ipcMain.handle('remoteFs:clone', guard((q) => service.cloneProject({ hostId: String(obj(q).hostId || ''), url: obj(q).url, parent: obj(q).parent })))
  ipcMain.handle('remoteFs:create', guard((q) => service.createProject({ hostId: String(obj(q).hostId || ''), parent: obj(q).parent, name: obj(q).name })))
}
