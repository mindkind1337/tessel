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
import crypto from 'crypto'
import { ACCOUNT_FUNCTIONS } from './remoteAgent/remoteAccounts'
import { createRemoteSession, sessionArgs, remotePathArg, rawArg, RC, DEFAULT_TIMEOUT_MS } from './remoteShell'
import { createScm } from './sourceControl'
import { looksBinary, MAX_EDIT_BYTES, MAX_HEAD_BYTES } from './editorFiles'
import { cleanEnv } from './cleanEnv'
import { RISKY_CONFIG_ARGS, GUEST_FIXED_ARGS, parseRisky, hookEntries, neutralize, gitTrust } from './gitSafety'
import { codexDayHint } from './remoteAgent/codexDayHint'
import { parseRemotePath, remoteRoot, relativeTo, childPath, isRemotePath } from '../shared/remotePath'
import { fileKind, extOf, IMAGE_MIME } from '../shared/fileKinds'
import { sortEntries } from '../shared/explorerSort'
import { t } from './i18n'
import { validateCloneUrl, deriveCloneRepoName, cloneFailureMessage, errorText as addProjectErrorText } from './addProject'
import { parseWorktreeList, MAX_WORKTREES } from './worktreeList'
import { parseSparseList, sparseDirsUnder } from './sparseCheckout'
import { BIN_NAME, parseAgentTools, parseRemoteSessions, remoteSessionsLimit } from './remoteAgent/remoteAgentSetup'

export const SESSION_PREFIX = 'rfs:'
const MAX_ENTRIES = 5000
const MAX_LIST_MANY = 64 // folders in one listMany request
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
// An operation with no answer after this long shows as slow (the badge says
// the host is slow to answer and offers Cancel).
export const SLOW_MS = 12_000
// git status of a remote project: the line counts of new (untracked) files
// cost several processes per file on the host and hold the session's one
// shell meanwhile; only this many files are counted (the rest show no count).
export const REMOTE_UNTRACKED_COUNTS = 200
// Paths of one terminal link batch looked up on a host (statLinks).
export const MAX_LINK_STATS = 50

// How long a cancelled sign-in is left alone by what runs on its own.
export const AUTH_CANCEL_COOLDOWN_MS = 60_000

// Lanes. The host's session runs one command at a time, and the Files panel
// of a big project (a git status, a search, the change poll over the whole
// tree) can hold it for many seconds: what must never wait behind it runs on
// a session of its own over the same signed-in ssh2 connection (one more
// exec channel each, opened when needed and closed when idle). A lane's
// channel is only ever opened on a live connection (never a new connection,
// never a question), only on a terminal host that keeps that promise (its
// onlyLive feature), and gives its slot up to a terminal that needs it (the
// server's MaxSessions): terminals and the Files session always win. A lane
// that cannot be opened is not tried again for LANE_RETRY_MS.
// - 'pane': what a terminal opening on the host waits for (the shim install,
//   the agent check, whether its conversation is there, its account folder),
//   closed a moment after (PANE idleMs). Not available or full: in the host's
//   session as before, first in its turn.
// - 'guest': a Live Share guest's requests (liveShare/shareRemoteFiles.js,
//   the chat views and histories guests read). On an ssh2 host never in the
//   host's session: guests can never hold it (no lane: the host is "not
//   connected" for them). A host on the system ssh keeps them in its open
//   session, behind the host's own requests, as before (never a second
//   connection, never a sign-in).
// - 'bg': the host's own background work (the Files panel's git status for
//   its colours and its refreshes after a change, the change poll, the
//   readers of agent conversations and sub-agents): never in front of what
//   you click. Not available: in the host's session, behind your requests,
//   as before.
// Lanes never show in the remote badge (it says what YOU wait for). The
// Files session's idle close and the badge's Cancel leave them alone; only
// Disconnect, a removed host and Tessel closing end them.
export const LANES = Object.freeze({
  pane: Object.freeze({ idleMs: 5_000, maxQueued: 16, maxBgQueued: 16, queueWait: 20_000 }),
  guest: Object.freeze({ idleMs: 90_000, maxQueued: 6, maxBgQueued: 6, queueWait: 10_000 }),
  bg: Object.freeze({ idleMs: 120_000, maxQueued: 32, maxBgQueued: 32, queueWait: 30_000 })
})
const LANE_READY_MS = 15_000
export const LANE_RETRY_MS = 45_000
// No background lane (an older terminal host, the system ssh, no slot): the
// Files panel's own git work (its colours, the Changes count: `low`) shares
// the host's one session with the agent readers, a pane's setup and the
// user's clicks. There it runs last (remoteShell.js pump), is stopped on the
// host after SHARED_GIT_MS, and one that ran out of time is not run in the
// background again for that repository for SHARED_GIT_HOLD_MS (the Changes
// tab, which asks in the foreground, still runs it at once). A huge tree
// (2026-10-25: a FiveM server) held the session 30 s at a time, over and
// over, and the agent views and new panes gave up behind it.
export const SHARED_GIT_MS = 8000
export const SHARED_GIT_HOLD_MS = 5 * 60_000
// The pane lane's requests that may run a second time when their channel
// went away under them: reads, the shim install (written by a rename, then
// its idempotent `install`), an account folder made whole (never a new one,
// never a removal or a sign-out).
const LANE_RERUN = new Set(['__t_ragent', '__t_agents', '__t_tread', '__t_sread', '__t_accts', '__t_acctdiag', '__t_acctplan', '__t_acctpane'])
export const laneRerunSafe = (fn, args = []) => LANE_RERUN.has(fn) || (fn === '__t_acctmk' && args[2] !== 'new')
// What ends the lanes too (else only the Files session ends).
const LANE_ENDS = new Set(['disconnect', 'removed', 'shutdown'])
// A guest's requests, bounded on the host (its watchdog ends them).
export const GUEST_MS = Object.freeze({ list: 8000, stat: 5000, read: 10_000, write: 15_000, check: 8000, hooks: 8000, search: 8000 })
// Search results a guest's search checks at most (links, nested
// repositories, what git ignores).
export const GUEST_CHECK_MAX = 2000
// The guest functions' exit codes -> a guest answer's code.
// 87: git on the host is too old to tell what it ignores (check-ignore --no-index).
const GUEST_RC = { 87: 'old-git', 90: 'refused', 91: 'missing', 92: 'not-file', 93: 'too-large', 95: 'conflict', 96: 'is-folder', 97: 'unknown', 124: 'busy' }
// A slow / busy line about the same function on the same lane, at most this often.
const SLOW_LOG_EVERY_MS = 30_000

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
// __t_fp's answer -> null (nothing changed, or the first look) or
// { rels }: the paths that changed, relative to the project ('' for the
// project folder itself), or rels null when the list was cut (too many).
// find prints "<real root>/./<rel>"; a real path has no "/./" of its own.
export const FP_PATHS_BYTES = 64 * 1024
export function parseFingerprint(out, max = FP_PATHS_BYTES) {
  const buf = Buffer.isBuffer(out) ? out : Buffer.from(String(out || ''), 'utf8')
  const nul = buf.indexOf(0)
  const head = (nul < 0 ? buf : buf.subarray(0, nul)).toString('latin1').trim()
  if (head !== 'changed') return null
  const body = buf.subarray(nul + 1)
  if (body.length >= max) return { rels: null }
  const rels = new Set()
  for (const rec of body.toString('utf8').split('\0')) {
    if (!rec) continue
    const at = rec.indexOf('/./')
    if (at < 0) {
      if (rec.endsWith('/.')) rels.add('')
      continue
    }
    const rel = rec.slice(at + 3)
    if (!rel || CONTROL.test(rel) || rel.includes('\\')) continue
    rels.add(rel)
  }
  return { rels: [...rels] }
}

// The path __t_paste gives back for a pasted image: in ~/.tessel-server/paste,
// with no control character anywhere (a \r pasted would be an Enter), or ''.
export function remotePastePath(out) {
  const path = String(out || '').replace(/\r?\n$/, '')
  return /^\/[^\x00-\x1f\x7f]*\/\.tessel-server\/paste\/image-[0-9a-z-]+\.png$/.test(path) ? path : ''
}

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

// The host's answer to __t_skills: per SKILL.md, a "@@S <kind> <path, base64>"
// line, then its first bytes (base64) on the next line. __t_cxskills (Codex)
// also names the skills folder: "@@S <kind> <folder, base64> <path, base64>".
// -> [{ kind: 'home' | 'repo', path, text, root? }] (absolute POSIX paths only)
export function parseSkillListing(out, max = 1000) {
  const lines = String(out || '').split('\n')
  const files = []
  const seen = new Set()
  const okPath = (p) => p.startsWith('/') && p.length <= 4096 && !CONTROL.test(p)
  for (let i = 0; i < lines.length && files.length < max; i++) {
    const m = /^@@S (home|repo) ([A-Za-z0-9+/=]*)(?: ([A-Za-z0-9+/=]*))?\r?$/.exec(lines[i])
    if (!m) continue
    const root = m[3] !== undefined ? Buffer.from(m[2], 'base64').toString('utf8') : null
    const path = Buffer.from(m[3] !== undefined ? m[3] : m[2], 'base64').toString('utf8')
    const body = (lines[i + 1] || '').trim()
    if (!/^[A-Za-z0-9+/=]*$/.test(body)) continue
    i++
    if (!okPath(path) || !path.endsWith('/SKILL.md') || seen.has(path)) continue
    if (root !== null && (!okPath(root) || root.endsWith('/') || !path.startsWith(root + '/'))) continue
    seen.add(path)
    files.push({ kind: m[1], path, text: Buffer.from(body, 'base64').toString('utf8'), ...(root !== null ? { root } : {}) })
  }
  return files
}

// A sub-agent transcript's name on a host, without .jsonl (Claude Code's
// agent-<id>): what __t_subs lists and __t_sread reads.
export const SUBAGENT_NAME = /^[0-9A-Za-z_][0-9A-Za-z_.-]{0,150}$/
export const MAX_SUBAGENT_FILES = 50

// The host's answer to __t_subs: "<size> <mtime in seconds> <name>.jsonl"
// lines. -> [{ name, size, mtimeMs }] (names as SUBAGENT_NAME, at most max)
export function parseSubagentListing(out, max = MAX_SUBAGENT_FILES) {
  const files = []
  const seen = new Set()
  for (const line of String(out || '').split('\n')) {
    if (files.length >= max) break
    const m = /^(\d{1,15}) (\d{1,15}) (.+)\.jsonl\r?$/.exec(line)
    if (!m || !SUBAGENT_NAME.test(m[3]) || seen.has(m[3])) continue
    seen.add(m[3])
    files.push({ name: m[3], size: Number(m[1]), mtimeMs: Number(m[2]) * 1000 })
  }
  return files
}

// The host's answer to __t_smeta: "@@M <name> <base64 of its meta file's
// first bytes>" lines -> { name: object } (only the names asked for, each
// one's JSON object; one cut or not JSON is left out).
export function parseSubagentMetas(out, names = []) {
  const want = new Set(names)
  const metas = {}
  for (const line of String(out || '').split('\n')) {
    const m = /^@@M (\S+) ([A-Za-z0-9+/=]*)\r?$/.exec(line)
    if (!m || !want.has(m[1]) || Object.prototype.hasOwnProperty.call(metas, m[1])) continue
    try {
      const o = JSON.parse(Buffer.from(m[2], 'base64').toString('utf8'))
      if (o && typeof o === 'object' && !Array.isArray(o)) metas[m[1]] = o
    } catch {
      // cut or not JSON
    }
  }
  return metas
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
  const gitHolds = new Map() // hostId\nrepository top -> time before which its background git work is held (SHARED_GIT_MS)
  const watchedRoots = new Map() // virtual root -> { hostId, root, last }
  const watchedFiles = new Map() // hostId\npath -> { virtual, loc, sig }
  const changeListeners = new Set() // fn(virtual root): a watched project changed
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
        slow: !!(entry && entry.busy > 0 && entry.slow > 0),
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
      case 'busy':
        return t('main.remoteFs.busy', '{{host}} is still busy with earlier operations: try again in a moment.', { host })
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
  // A sign-in the user cancelled is not asked again for AUTH_CANCEL_COOLDOWN_MS
  // by what runs on its own (the agent check, the shim install, a poll, the
  // Files panel): each of them opened a new session and a new question, one
  // every 1-2 s (2026-10-24 19:00). The user's own action (Connect, a terminal
  // opened on the host: userAllow) ends the wait.
  const cancelledAt = new Map() // hostId -> time of the cancel
  const cancelCoolingDown = (hostId) => {
    const at = cancelledAt.get(hostId)
    if (at === undefined) return false
    if (now() - at < AUTH_CANCEL_COOLDOWN_MS) return true
    cancelledAt.delete(hostId)
    return false
  }
  function userAllow(hostId) {
    if (typeof hostId === 'string' && hostId) cancelledAt.delete(hostId)
    allow(hostId)
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
  const sharedNow = (hostId) => {
    try {
      return !!(hosts.sharedConnected && hosts.sharedConnected(hostId))
    } catch {
      return false
    }
  }
  // What held a host's session: a request that waited or ran 5 s or more, or
  // one given up as busy, with what ran and what waited (remoteShell.js
  // onSlow). One line per function and lane every 30 s at most.
  const slowSaid = new Map() // hostId|lane|kind|fn -> time
  const secs = (ms) => `${(Math.max(0, ms || 0) / 1000).toFixed(1)} s`
  function slowLog(hostId, lane) {
    return (i) => {
      const key = `${hostId}|${lane}|${i.kind}|${i.fn}`
      const at = now()
      if (at - (slowSaid.get(key) || 0) < SLOW_LOG_EVERY_MS) return
      if (slowSaid.size > 500) slowSaid.clear()
      slowSaid.set(key, at)
      const running = i.running ? `${i.running.fn} for ${secs(i.running.ms)}` : 'nothing'
      const waiting = i.waiting ? `${i.waiting} waiting (${i.queued})` : 'nothing waiting'
      if (i.kind === 'busy')
        warn(`busy on ${hostId} (${lane}): ${i.fn} given up ${i.why === 'full' ? 'at once, the queue is full' : `after ${secs(i.waitMs)} in the queue`}; running ${running}; ${waiting}`) // i18n-ignore log line
      else warn(`slow on ${hostId} (${lane}): ${i.fn} waited ${secs(i.waitMs)}, ran ${secs(i.runMs)} (exit ${i.rc}); ${waiting}`) // i18n-ignore log line
    }
  }

  function open(hostId) {
    const existing = sessions.get(hostId)
    if (existing && !existing.closed) return existing.ready
    if (cancelCoolingDown(hostId)) {
      // Said as "not connected" (the Files panel then offers Connect), not as
      // a sign-in error nobody can act on.
      activity(hostId, null, { needsConnect: true })
      return Promise.reject(Object.assign(new Error('not connected'), { code: 'not-connected' })) // i18n-ignore internal, replaced by sessionErrorText
    }
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
          onSlow: slowLog(hostId, 'files'),
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
        onSlow: slowLog(hostId, 'files'),
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

  // --- Lanes (see LANES) ------------------------------------------------------------
  const lanes = new Map() // hostId\nlane -> { hostId, lane, key, closed, session, ready, idleTimer }
  const laneRetryAt = new Map() // hostId\nlane -> time before which it is not tried again
  const laneError = (code) => Object.assign(new Error(`lane ${code}`), { code }) // i18n-ignore internal, replaced by sessionErrorText
  // Whether a lane can be had on this host now: an ssh2 connection signed
  // in, on a terminal host that keeps an exec channel to it (onlyLive).
  // -> 'ok' | 'system' (the system ssh) | 'none'
  async function laneMode(hostId) {
    const target = ssh ? hosts.get(hostId) : null
    if (!target) return { kind: 'system' }
    const mode = await ssh.modeFor(target)
    if (mode.mode !== 'ssh2') return { kind: 'system' }
    if (typeof ssh.onlyLiveSupported !== 'function' || !ssh.onlyLiveSupported()) return { kind: 'none', why: 'old-host' }
    if (!sharedNow(hostId)) return { kind: 'none', why: 'not-connected' }
    return { kind: 'ok', spec: mode.spec }
  }
  function openLane(hostId, lane) {
    const conf = LANES[lane]
    if (!conf) return Promise.reject(laneError('no-lane'))
    const key = `${hostId}\n${lane}`
    const existing = lanes.get(key)
    if (existing && !existing.closed) return existing.ready
    // Could not be had a moment ago: not tried again yet (no retry storm).
    if ((laneRetryAt.get(key) || 0) > now()) return Promise.reject(laneError('no-lane'))
    const entry = { hostId, lane, key, closed: false, session: null, idleTimer: null }
    lanes.set(key, entry)
    entry.ready = (async () => {
      const mode = await laneMode(hostId)
      if (entry.closed) throw laneError('cancelled')
      if (mode.kind === 'system') throw laneError('system')
      if (mode.kind !== 'ok') throw laneError(mode.why === 'not-connected' ? 'not-connected' : 'no-lane')
      const session = createRemoteSession({
        file: 'ssh2',
        args: [],
        env: {},
        spawnImpl: ssh.spawnFor(hostId, mode.spec, { onlyLive: true }),
        timers,
        readyTimeoutMs: LANE_READY_MS,
        maxQueued: conf.maxQueued,
        maxBgQueued: conf.maxBgQueued,
        queueWait: conf.queueWait,
        onSlow: slowLog(hostId, lane),
        onExit: (reason) => laneEnded(entry, reason)
      })
      entry.session = session
      await session.start()
      if (entry.closed) throw laneError('cancelled')
      entry.opened = true
      return session
    })()
    entry.ready.catch((err) => laneEnded(entry, (err && err.code) || 'connect'))
    return entry.ready
  }
  // Ends that say nothing about the lane itself (it is opened again when
  // needed); the others (refused, dropped, given up to a terminal) leave it
  // alone for LANE_RETRY_MS, said once.
  const LANE_QUIET = new Set(['cancelled', 'idle', 'shutdown', 'disconnect', 'removed', 'not-connected', 'no-lane', 'system'])
  function laneEnded(entry, reason) {
    if (entry.closed) return
    entry.closed = true
    if (entry.idleTimer) timers.clearTimeout(entry.idleTimer)
    entry.idleTimer = null
    if (lanes.get(entry.key) === entry) lanes.delete(entry.key)
    if (entry.session && entry.session.state !== 'closed') entry.session.close(reason)
    if (LANE_QUIET.has(reason)) return
    const again = (laneRetryAt.get(entry.key) || 0) > now()
    laneRetryAt.set(entry.key, now() + LANE_RETRY_MS)
    if (!again) warn(`remote ${entry.lane} lane for ${entry.hostId} ${entry.opened ? 'ended' : 'could not open'}: ${reason} (not tried again for ${LANE_RETRY_MS / 1000} s)`) // i18n-ignore log line
  }
  // Closed after LANES[lane].idleMs with nothing asked of it (its channel freed).
  function armLaneIdle(entry) {
    if (entry.idleTimer) timers.clearTimeout(entry.idleTimer)
    entry.idleTimer = timers.setTimeout(() => {
      entry.idleTimer = null
      if (entry.closed) return
      if (entry.session && entry.session.busy) armLaneIdle(entry)
      else laneEnded(entry, 'idle')
    }, LANES[entry.lane].idleMs)
    if (entry.idleTimer && entry.idleTimer.unref) entry.idleTimer.unref()
  }
  function closeLanes(hostId, reason) {
    for (const entry of [...lanes.values()]) if (hostId === null || entry.hostId === hostId) laneEnded(entry, reason)
    for (const k of [...laneRetryAt.keys()]) if (hostId === null || k.startsWith(`${hostId}\n`)) laneRetryAt.delete(k)
  }
  // One request on a lane. -> like callOnce; laneFailed: the lane could not
  // be had (nothing was sent); code 'system': the host is on the system ssh.
  // low: the Files panel's git work, behind the lane's other requests.
  async function laneCall(hostId, lane, fn, args, { cap, timeoutMs, upload, low = false } = {}) {
    let session
    try {
      session = await openLane(hostId, lane)
    } catch (err) {
      return { error: sessionErrorText(hostId, err), code: (err && err.code) || 'failed', laneFailed: true, notSent: true }
    }
    const entry = lanes.get(`${hostId}\n${lane}`)
    if (entry && entry.idleTimer) {
      timers.clearTimeout(entry.idleTimer)
      entry.idleTimer = null
    }
    try {
      return await session.run(fn, args, { ...(cap ? { cap } : {}), ...(timeoutMs ? { timeoutMs } : {}), ...(upload ? { upload } : {}), ...(low ? { background: true, low: true } : {}) })
    } catch (err) {
      return { error: sessionErrorText(hostId, err), code: (err && err.code) || 'failed', ...(err && err.notSent ? { notSent: true } : {}) }
    } finally {
      if (entry && !entry.closed) armLaneIdle(entry)
    }
  }

  function ended(hostId, entry, reason) {
    if (entry.closed) return
    entry.closed = true
    if (reason === 'auth-cancelled') cancelledAt.set(hostId, now())
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
    if (!['cancelled', 'idle', 'shutdown', 'disconnect', 'removed'].includes(reason)) warn(`remote session for ${hostId} ended: ${reason}`)
    activity(hostId, null)
  }

  // Ends a host's session (Disconnect, cancel, a sign-in cancelled, idle).
  // Its lanes only with Disconnect, a removed host or Tessel closing
  // (LANE_ENDS): a guest's save or a background read on its way is not cut
  // by the Files session's idle close or the badge's Cancel.
  function closeHost(hostId, reason = 'cancelled') {
    if (LANE_ENDS.has(reason)) {
      closeLanes(hostId, reason)
      for (const k of [...gitHolds.keys()]) if (k.startsWith(`${hostId}\n`)) gitHolds.delete(k)
    }
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
  // background: behind the user's own requests in the session's queue (a
  // poll, a reader of agent files; quiet and ifOpen calls always are).
  // The connection dropped under the session (the network went away, the
  // host closed it): the operation runs once more on a new session (signed
  // in again with what is kept; a sign-in nobody asked for never happens:
  // open() says "not connected" instead) when it never reached the host
  // (it was waiting its turn), or when it only reads (retry: true). Not
  // after a time-out (a host that does not answer would only keep the user
  // waiting longer), a cancel or a shutdown, and not for polls.
  // (`now` is the factory's clock.)
  const RETRY_ON = new Set(['closed', 'ssh', 'connect'])
  // Only a drop that came quickly: a connection that died after a long
  // silence (a stalled link, ended by its keep-alive) would only start a
  // new sign-in to a host that does not answer, and keep the user waiting.
  async function call(hostId, fn, args, opts = {}) {
    const t0 = now()
    const res = await callOnce(hostId, fn, args, opts)
    if (res && res.error && !opts.guest && !opts.quiet && !opts.ifOpen && RETRY_ON.has(res.code) && (res.notSent || opts.retry) && now() - t0 < SLOW_MS) {
      return callOnce(hostId, fn, args, opts)
    }
    return res
  }
  // lane: 'pane' | 'guest' | 'bg' (see LANES). A guest's call is always on
  // its lane; a background one (a poll, a refresh, a reader) on the 'bg' lane
  // when the host has one.
  // low (with background): the Files panel's own git work; holdKey: its
  // repository (SHARED_GIT_MS).
  async function callOnce(hostId, fn, args, opts = {}) {
    const { cap, upload, op = '', ifOpen = false, background = false, first = false, guest = false } = opts
    let { quiet = false, timeoutMs } = opts
    const low = !!opts.low && background && !first
    const lane = guest ? 'guest' : opts.lane || ((background || quiet || ifOpen) && !opts.noLane ? 'bg' : null)
    if (lane) {
      const res = await laneCall(hostId, lane, fn, args, { cap, timeoutMs, upload, low: low && lane === 'bg' })
      const inSession = { ...opts, lane: null, noLane: true }
      // The pane's or the background lane cannot be had (a connection not
      // signed in yet, the system ssh, an older terminal host, no slot, not
      // tried again yet), or the pane's is full: in the host's session as
      // before, the pane's first in its turn (a pane never fails to start
      // because of a busy lane).
      if (res && ((res.laneFailed && (lane === 'pane' || lane === 'bg')) || (lane === 'pane' && res.code === 'busy')))
        return callOnce(hostId, fn, args, { ...inSession, ...(lane === 'pane' ? { first: true } : {}) })
      // The lane's channel went away under its request (it gave its slot to
      // a terminal, the connection dropped): run again in the Files session
      // when that is safe (background reads; the pane's reads and installs
      // that may run twice: LANE_RERUN). A guest's request is never run
      // again by itself: it gets a "busy, try again" answer.
      const dropped = res && res.error && !res.laneFailed && (res.code === 'closed' || res.code === 'ssh')
      if (dropped && (lane === 'bg' || (lane === 'pane' && laneRerunSafe(fn, args))))
        return callOnce(hostId, fn, args, { ...inSession, ...(lane === 'pane' ? { first: true } : {}) })
      // A guest on a host with the system ssh: in its open session, behind the
      // host's own requests, as before; never a new connection or a sign-in.
      if (res && res.laneFailed && lane === 'guest' && res.code === 'system') {
        const r = await callOnce(hostId, fn, args, { ...inSession, guest: false, ifOpen: true, background: true })
        return r && r.skipped ? { error: sessionErrorText(hostId, laneError('not-connected')), code: 'not-connected' } : r
      }
      return res
    }
    // The Files panel's git work in the host's one shared session (no lane):
    // held back after one ran out of time there, else stopped on the host
    // after SHARED_GIT_MS (see SHARED_GIT_MS).
    const holdKey = `${hostId}\n${opts.holdKey || ''}`
    if (low) {
      if ((gitHolds.get(holdKey) || 0) > now()) return { error: t('main.explorer.statusSlow', 'Git status took too long.'), code: 'held' }
      timeoutMs = Math.min(timeoutMs || DEFAULT_TIMEOUT_MS, SHARED_GIT_MS)
    }
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
        return { error: sessionErrorText(hostId, err), code: (err && err.code) || 'failed' }
      }
    }
    const entry = sessions.get(hostId)
    let slowTimer = null
    let slowCounted = false
    // The badge says what you wait for: background work (a refresh, the git
    // colours, a reader) is never "busy" or "slow to answer" there.
    const shown = !quiet && !background
    if (shown && entry) {
      entry.busy++
      entry.op = op
      activity(hostId, entry)
      // Still no answer after a while: the window says the host is slow
      // (with Cancel) instead of a spinner that looks the same forever.
      slowTimer = timers.setTimeout(() => {
        slowTimer = null
        if (entry.closed) return
        slowCounted = true
        entry.slow = (entry.slow || 0) + 1
        activity(hostId, entry)
      }, SLOW_MS)
    }
    try {
      const res = await session.run(fn, args, {
        ...(cap ? { cap } : {}),
        ...(timeoutMs ? { timeoutMs } : {}),
        ...(upload ? { upload } : {}),
        ...(ifOpen ? { touch: false } : {}),
        ...(quiet || background ? { background: true } : {}),
        ...(first ? { first: true } : {}),
        ...(low ? { low: true } : {})
      })
      if (low && res && res.rc === RC.TIMEOUT) {
        if (!((gitHolds.get(holdKey) || 0) > now()))
          warn(`remote git work on ${hostId} ran out of time in the shared session (${secs(timeoutMs)}): not run in the background again for ${SHARED_GIT_HOLD_MS / 60_000} min`) // i18n-ignore log line
        if (gitHolds.size > 200) gitHolds.clear()
        gitHolds.set(holdKey, now() + SHARED_GIT_HOLD_MS)
      }
      return res
    } catch (err) {
      return { error: sessionErrorText(hostId, err), code: (err && err.code) || 'failed', ...(err && err.notSent ? { notSent: true } : {}) }
    } finally {
      if (slowTimer) timers.clearTimeout(slowTimer)
      if (slowCounted) entry.slow = Math.max(0, entry.slow - 1)
      if (shown && entry && !entry.closed) {
        entry.busy = Math.max(0, entry.busy - 1)
        if (!entry.busy) entry.op = ''
        activity(hostId, entry)
      }
    }
  }

  // The same read asked again while it runs (a refresh on focus, on a
  // change notice, from two panels): one request, the same answer for all.
  // Reads only; never a write, a git command that changes anything, or a
  // poll (their own guards).
  const inflight = new Map()
  function shared(key, fn) {
    const running = inflight.get(key)
    if (running) return running
    const p = Promise.resolve()
      .then(fn)
      .finally(() => {
        if (inflight.get(key) === p) inflight.delete(key)
      })
    inflight.set(key, p)
    return p
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
  // background: asked for the Files panel's colours: on the background lane.
  function repoInfo(loc, { background = false } = {}) {
    const bg = background ? { background: true } : {}
    const key = `${loc.hostId}\n${loc.root.path}`
    if (!repoInfos.has(key)) {
      const p = call(loc.hostId, '__t_top', [arg(loc.root.path)], { cap: 64 * 1024, op: 'status', retry: true, ...bg }).then(async (res) => {
        if (res.error) return { error: res.error }
        const lines = res.out.toString('utf8').split('\n')
        if (res.rc === RC.NOT_REPO) {
          loc.root.real = lines[0] || null
          return { realRoot: lines[0], top: null, gitArgs: [] }
        }
        if (res.rc === RC.MISSING) return { missing: true }
        if (res.rc !== 0 || !lines[0] || !lines[1]) return { error: rcText(res, t('main.scm.statusFailed', 'Git status failed.')) }
        loc.root.real = lines[0]
        const cfg = await call(loc.hostId, '__t_gitin', [arg(loc.root.path), arg(lines[1]), ...RISKY_CONFIG_ARGS], { cap: 256 * 1024, op: 'status', retry: true, ...bg })
        if (cfg.error) return { error: cfg.error }
        // Its runnable hooks ($GIT_DIR/hooks, not the *.sample ones) count too.
        const hooks = await call(loc.hostId, '__t_hooks', [arg(loc.root.path), arg(lines[1])], { cap: 64 * 1024, op: 'status', retry: true, ...bg })
        if (hooks.error) return { error: hooks.error }
        // Exit 1: none of them set. Unreadable: everything they could be stays off.
        const risky = [
          ...(cfg.rc === 0 ? parseRisky(cfg.out.toString('utf8')) : []),
          ...(hooks.rc === 0 ? hookEntries(hooks.out.toString('utf8').split('\0')) : [])
        ]
        let gitArgs = []
        if ((cfg.rc !== 0 && cfg.rc !== 1) || hooks.rc !== 0) {
          gitArgs = neutralize([], { hooksDir: NO_HOOKS })
        } else if (risky.length) {
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

  function listDir(q = {}) {
    // (A click never joins a background refresh: that one may wait behind
    // the git status on the background lane.)
    return shared(`ls${q.background === true ? 'b' : ''}
${q.root}
${q.dir || ''}
${q.dotfiles !== false}`, () => listDirNow(q))
  }
  // background: a refresh of what is shown (after a change notice), behind
  // the user's own requests; a folder opened by the user is not.
  async function listDirNow({ root, dir, dotfiles = true, background = false } = {}) {
    const loc = under(root, dir || root)
    if (!loc) return { ok: false, error: t('main.explorer.outside', 'Outside the project.') }
    const res = await call(loc.hostId, '__t_ls', [arg(loc.root.path), arg(loc.path), String(MAX_ENTRIES + 1)], { cap: 16 * 1024 * 1024, op: 'list', background: background === true, retry: true })
    // transient: the host did not answer (slow, busy, connection lost), the
    // folder itself may be fine: the window keeps what it showed.
    if (res.error) return { ok: false, error: res.error, transient: true }
    const failed = listFailure(res.rc, res)
    if (failed) return failed
    return listEntries(res.out.toString('utf8').split('\0'), dir || root, dotfiles, MAX_ENTRIES)
  }
  // A folder's rc from __t_ls / __t_lsm -> null (read) or the answer to give.
  function listFailure(rc, res) {
    if (rc === 0) return null
    if (rc === RC.MISSING) return { ok: false, error: t('main.explorer.folderGone', 'The folder is gone.') }
    return { ok: false, error: rcText({ ...res, rc }, t('main.explorer.folderUnreadable', 'The folder could not be read.')) }
  }
  // "<kind> <name>" records -> { ok, entries, truncated }, folders first.
  function listEntries(records, base, dotfiles, max) {
    const entries = []
    let count = 0
    for (const rec of records) {
      const m = /^([dfLlo]) (.+)$/s.exec(rec)
      if (!m) continue
      count++
      const name = m[2]
      // Not addressable (a backslash or a control character in the name) or hidden.
      if (CONTROL.test(name) || name.includes('\\') || name === '.git') continue
      if (!dotfiles && name.startsWith('.')) continue
      if (entries.length >= max) break
      entries.push({ name, path: childPath(base, name), dir: m[1] === 'd' || m[1] === 'L', ...(m[1] === 'L' || m[1] === 'l' ? { link: true } : {}) })
    }
    sortEntries(entries)
    return { ok: true, entries, truncated: count > max }
  }

  // Several folders in one round trip (a refresh of the open ones, a
  // prefetch), each folder's sole sub-folder too when chain (VS Code's
  // resolveSingleChildDescendants: a compact row "a / b / c" opens with one
  // request). max: entries per folder (a prefetch asks fewer).
  // -> { ok, results: [{ dir, ok, entries, truncated } | { dir, ok: false, error }] }
  // A folder the answer did not reach (cut at its size) is left out.
  function listMany(q = {}) {
    const dirs = Array.isArray(q.dirs) ? q.dirs.filter((d) => typeof d === 'string').slice(0, MAX_LIST_MANY) : []
    return shared(`lm${q.background === true ? 'b' : ''}
${q.root}
${dirs.join('\n')}
${q.dotfiles !== false}
${!!q.chain}
${q.max || ''}`, () => listManyNow({ ...q, dirs }))
  }
  async function listManyNow({ root, dirs, dotfiles = true, chain = false, background = false, max = MAX_ENTRIES } = {}) {
    const top = under(root, root)
    if (!top) return { ok: false, error: t('main.explorer.outside', 'Outside the project.') }
    const limit = Number.isInteger(max) && max > 0 ? Math.min(max, MAX_ENTRIES) : MAX_ENTRIES
    const asked = []
    const results = []
    for (const d of dirs) {
      const loc = under(root, d)
      if (loc) asked.push({ dir: d, loc })
      else results.push({ dir: d, ok: false, error: t('main.explorer.outside', 'Outside the project.') })
    }
    if (!asked.length) return { ok: true, results }
    const res = await call(top.hostId, '__t_lsm', [arg(top.root.path), String(limit + 1), chain ? '1' : '0', dotfiles ? '1' : '0', ...asked.map((a) => arg(a.loc.path))], {
      cap: 16 * 1024 * 1024,
      timeoutMs: 60000,
      op: 'list',
      background: background === true,
      retry: true
    })
    if (res.error) return { ok: false, error: res.error, transient: true }
    const sections = []
    let cur = null
    let at = -1
    for (const rec of res.out.toString('utf8').split('\0')) {
      const h = /^([DC]) (\d+) (.*)$/s.exec(rec)
      if (h) {
        let dir
        if (h[1] === 'D') {
          at++
          if (at >= asked.length) break
          dir = asked[at].dir
        } else {
          if (!cur || !h[3] || CONTROL.test(h[3]) || h[3].includes('\\')) break
          dir = childPath(cur.dir, h[3])
        }
        cur = { dir, rc: Number(h[2]), records: [] }
        sections.push(cur)
      } else if (cur) cur.records.push(rec)
    }
    // Cut at the cap: the last folder may be incomplete.
    if (res.truncated && sections.length) sections.pop()
    for (const s of sections) {
      const failed = listFailure(s.rc, res)
      results.push({ dir: s.dir, ...(failed || listEntries(s.records, s.dir, dotfiles, limit)) })
    }
    return { ok: true, results }
  }

  // The explorer's letters, keyed by the files' virtual paths.
  function projectStatus(q = {}) {
    return shared(`st
${q.root}
${!!q.ignored}`, () => projectStatusNow(q))
  }
  async function projectStatusNow({ root, ignored = false, background = false } = {}) {
    const loc = under(root, root)
    if (!loc) return { ok: false, error: t('main.explorer.invalidFolder', 'Invalid folder.') }
    const info = await repoInfo(loc, { background: background === true })
    if (info.error) return { ok: false, error: info.error }
    if (info.missing || !info.top) return { ok: true, files: {}, repo: false }
    // An untracked folder is one entry ("?? dir/"; the explorer shows what is
    // inside it as untracked too: explorerStatus.js), never every file in it:
    // on a huge tree the full list ran out of time and held the host's
    // session. The Changes tab still lists every file (sourceControl.js).
    const args = ['status', '--porcelain=v1', '-z', '--untracked-files=normal', ...(ignored ? ['--ignored=matching'] : [])]
    // How long it took is said (ms): the Files panel asks less often for a
    // big project, and backs off after one that ran out of time.
    const t0 = now()
    const bg = background === true ? { background: true, low: true, holdKey: info.top } : {}
    const res = await call(loc.hostId, '__t_gitin', [arg(loc.root.path), arg(info.top), ...info.gitArgs, ...args], { cap: 32 * 1024 * 1024, timeoutMs: 30000, op: 'status', retry: true, ...bg })
    const ms = now() - t0
    if (res.error) return { ok: false, error: res.error, ms }
    if (res.rc !== 0) return { ok: false, error: rcText(res, t('main.scm.statusFailed', 'Git status failed.')), ms }
    const files = {}
    for (const [p, letter] of porcelainLetters(res.out.toString('utf8'))) {
      const rel = relativeTo(info.realRoot, joinPath(info.top, p))
      if (rel === null || !rel || CONTROL.test(rel) || rel.includes('\\')) continue
      files[childPath(root, rel)] = letter
    }
    return { ok: true, files, repo: true, ms }
  }

  // The folders a sparse checkout keeps below the project (explorer.js
  // sparseInfo): -> { ok, sparse, dirs: [{ rel, path }] }.
  function sparseInfo(q = {}) {
    return shared(`sp
${q.root}`, () => sparseInfoNow(q))
  }
  async function sparseInfoNow({ root } = {}) {
    const loc = under(root, root)
    if (!loc) return { ok: false, error: t('main.explorer.invalidFolder', 'Invalid folder.') }
    const none = { ok: true, sparse: false, dirs: [] }
    // Asked by the Files panel by itself (each time it shows the project):
    // background work, never in front of a click.
    const info = await repoInfo(loc, { background: true })
    if (info.error) return { ok: false, error: info.error }
    if (info.missing || !info.top) return none
    const res = await call(loc.hostId, '__t_gitin', [arg(loc.root.path), arg(info.top), ...info.gitArgs, '-c', 'core.quotePath=false', 'sparse-checkout', 'list'], { cap: 1024 * 1024, timeoutMs: 15000, op: 'status', retry: true, background: true })
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

  // git grep's arguments for a fixed, case-blind text (paths as given, a
  // line number, NUL after the path and the number; the heavy folders left out).
  const gitGrepArgs = (q) => [
    '-c', 'grep.fullName=false', '-c', 'grep.lineNumber=true', '-c', 'grep.column=false', '-c', 'grep.patternType=fixed',
    '-c', 'grep.extendedRegexp=false', '-c', 'color.grep=never',
    'grep', '-n', '-I', '-z', '-i', '-F', '--untracked', '--no-color', '-e', q, '--', '.',
    ...HEAVY.map((h) => `:(exclude,glob)**/${h}/**`)
  ]
  // git grep's (-z) or grep's lines -> { results: [{ rel, line, text }], truncated }
  function grepRecords(out, git, max, lower) {
    const results = []
    let truncated = false
    for (const rec of out.split('\n')) {
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
      results.push({ rel, line, text: clip(text, lower) })
    }
    return { results, truncated }
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
    const args = git ? [arg(loc.root.path), 'git', ...gitGrepArgs(q)] : [arg(loc.root.path), 'plain', q]
    const res = await call(loc.hostId, '__t_grep', args, { cap: SEARCH_OUTPUT + 1, timeoutMs: 30000, op: 'search' })
    if (res.error) return { ok: false, error: res.error }
    // 0: matches, 1: none, 141: cut at the cap; anything else is a failure.
    if (res.rc !== 0 && res.rc !== 1 && res.rc !== RC.PIPE) return { ok: false, error: rcText(res, t('main.explorer.grepFailed', 'The search failed (git grep).')) }
    const found = grepRecords(res.out.toString('utf8'), git, max, q.toLowerCase())
    return { ok: true, results: found.results.map((r) => ({ path: childPath(root, r.rel), ...r })), truncated: !!res.truncated || res.rc === RC.PIPE || found.truncated }
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

  // --- A Live Share guest's requests (liveShare/shareRemoteFiles.js) -----------------
  // On the guest's lane only (never the host's session), each one bounded on
  // the host (GUEST_MS), never a sign-in. Paths are relative to a saved
  // project ('' for the project itself). On the host every request checks its
  // path first (remoteShell.js __t_gp: no link, no nested repository below
  // the project) and, with ignore, asks git which of its own paths it ignores
  // (git check-ignore: never a scan of the project). Answers carry codes,
  // never the host's words: { ok: false, code: 'not-connected' | 'busy' |
  // 'refused' | 'missing' | 'not-file' | 'is-folder' | 'too-large' |
  // 'conflict' | 'unknown' | 'failed' } ('unknown': what git ignores could
  // not be read there, so nothing is given: it fails closed).
  const LANE_DOWN = new Set(['not-connected', 'host', 'connect', 'connect-timeout', 'ssh', 'closed', 'auth-cancelled', 'no-lane', 'spawn', 'cancelled', 'shutdown'])
  function guestFail(res) {
    // No guests' lane on this host now (an older terminal host, no slot, not
    // tried again yet): 'no-lane' (the host's own session is never used).
    if (res && res.error && res.laneFailed && res.code === 'no-lane') return { ok: false, code: 'no-lane' }
    if (res && res.error) return { ok: false, code: res.code === 'busy' || res.code === 'timeout' ? 'busy' : LANE_DOWN.has(res.code) ? 'not-connected' : 'failed' }
    return { ok: false, code: (res && GUEST_RC[res.rc]) || 'failed' }
  }
  const guestCall = (hostId, fn, args, ms, extra = {}) => call(hostId, fn, args, { guest: true, timeoutMs: ms, op: 'guest', ...extra })
  const relOk = (rel) => rel === '' || (typeof rel === 'string' && rel.length <= 4096 && cleanRel(rel) === rel && !rel.includes('\\'))
  const hostPathOf = (top, rel) => (rel ? joinPath(top.root.path, rel) : top.root.path)
  const flag = (on) => (on ? '1' : '0')
  // The ignore part of an answer, from records[at] (the paths asked: `asked`).
  // -> { ok: true, ignored: Set } | { ok: false }: git failed there, the
  // answer was cut, or it named a path that was not asked (fail closed).
  function ignoreSection(records, at, asked) {
    if (records[at] === '/@@I n') return { ok: true, ignored: new Set() }
    if (records[at] !== '/@@I y') return { ok: false }
    const ignored = new Set()
    for (let i = at + 1; i < records.length; i++) {
      const r = records[i]
      if (r === '/@@I e') return { ok: true, ignored }
      if (r === '/@@I o') return { ok: false, old: true }
      const p = r.startsWith('./') ? r.slice(2) : r
      if (!asked.has(p)) return { ok: false }
      ignored.add(p)
    }
    return { ok: false }
  }

  // Folders of the project, in one request. -> { ok: true, results: [{ rel,
  // ok: true, entries: [{ name, kind }], truncated, ignored: Set of names |
  // null (not asked) } | { rel, ok: false, code }] } | { ok: false, code }
  // kind: d folder, f file, o other, l a link, r a folder holding a .git (a
  // nested repository).
  async function guestList({ root, dirs, ignore = true, max = MAX_ENTRIES } = {}) {
    const top = under(root, root)
    if (!top) return { ok: false, code: 'refused' }
    const limit = Number.isInteger(max) && max > 0 ? Math.min(max, MAX_ENTRIES) : MAX_ENTRIES
    const results = []
    const asked = []
    for (const rel of Array.isArray(dirs) ? dirs.slice(0, MAX_LIST_MANY) : []) {
      if (relOk(rel)) asked.push(rel)
      else results.push({ rel, ok: false, code: 'refused' })
    }
    if (!asked.length) return { ok: true, results }
    const res = await guestCall(top.hostId, '__t_glsm', [arg(top.root.path), String(limit + 1), flag(ignore), ...asked.map((rel) => arg(hostPathOf(top, rel)))], GUEST_MS.list, { cap: 16 * 1024 * 1024 })
    if (res.error || (res.rc !== 0 && res.rc !== RC.PIPE)) return guestFail(res)
    const sections = []
    let cur = null
    for (const r of res.out.toString('utf8').split('\0')) {
      const h = /^\/@@D (\d+)$/.exec(r)
      if (h) sections.push((cur = { rc: Number(h[1]), recs: [] }))
      else if (cur) cur.recs.push(r)
    }
    // Cut at its size: the last folder may be incomplete.
    if ((res.truncated || res.rc === RC.PIPE) && sections.length) sections.pop()
    sections.slice(0, asked.length).forEach((sec, i) => {
      const rel = asked[i]
      if (sec.rc !== 0) return results.push({ rel, ok: false, code: GUEST_RC[sec.rc] || 'failed' })
      const entries = []
      // The folder itself is asked too (one inside an ignored folder is hidden).
      const sent = new Set(rel ? [rel] : [])
      let count = 0
      let at = 0
      for (; at < sec.recs.length; at++) {
        const m = /^([dflor]) (.+)$/s.exec(sec.recs[at])
        if (!m) break
        count++
        if (m[1] !== 'l' && m[1] !== 'r' && m[2] !== '.git') sent.add(rel ? `${rel}/${m[2]}` : m[2])
        if (entries.length < limit) entries.push({ name: m[2], kind: m[1] })
      }
      let ignored = null
      if (ignore) {
        const part = ignoreSection(sec.recs, at, sent)
        if (!part.ok) return results.push({ rel, ok: false, code: part.old ? 'old-git' : 'unknown' })
        if (rel && part.ignored.has(rel)) return results.push({ rel, ok: false, code: 'missing' })
        ignored = new Set([...part.ignored].map((p) => (rel ? p.slice(rel.length + 1) : p)))
      }
      results.push({ rel, ok: true, entries, truncated: count > limit, ignored })
    })
    for (const rel of asked.slice(sections.length)) results.push({ rel, ok: false, code: 'too-large' })
    return { ok: true, results }
  }

  // -> { ok: true, exists, size?, mtimeMs?, sig? } | { ok: false, code }
  async function guestStat({ root, rel, ignore = true } = {}) {
    const top = under(root, root)
    if (!top || !rel || !relOk(rel)) return { ok: false, code: 'refused' }
    const res = await guestCall(top.hostId, '__t_gst', [arg(top.root.path), arg(hostPathOf(top, rel)), flag(ignore)], GUEST_MS.stat, { cap: 4096 })
    if (res.error || res.rc !== 0) return guestFail(res)
    const st = parseStat(res.out.toString('latin1'))
    return st ? { ok: true, exists: true, ...st } : { ok: true, exists: false }
  }

  // A file's bytes, max at most (the host cuts its read there).
  // -> { ok: true, buf, size, mtimeMs, sig, hostHash } | { ok: false, code }
  async function guestRead({ root, rel, max, ignore = true } = {}) {
    const top = under(root, root)
    if (!top || !rel || !relOk(rel) || !(Number.isInteger(max) && max > 0 && max <= MAX_EDIT_BYTES)) return { ok: false, code: 'refused' }
    const res = await guestCall(top.hostId, '__t_grd', [arg(top.root.path), arg(hostPathOf(top, rel)), String(max), flag(ignore)], GUEST_MS.read, { cap: max + HEADER_SLACK })
    if (res.error || res.rc !== 0) return guestFail(res)
    if (res.truncated) return { ok: false, code: 'too-large' }
    const nl = res.out.indexOf(0x0a)
    const head = nl < 0 ? '' : res.out.subarray(0, nl).toString('latin1')
    const st = parseStat(head)
    if (!st) return { ok: false, code: 'failed' }
    const buf = res.out.subarray(nl + 1)
    if (buf.length > max) return { ok: false, code: 'too-large' }
    const hash = head.split(' ')[4] || ''
    return { ok: true, buf, size: buf.length, mtimeMs: st.mtimeMs, sig: st.sig, hostHash: HASH_RE.test(hash) ? hash : '' }
  }

  // Saves a file: one that is there only while it is still the version
  // expectHash names (the host's hash, compared right before the rename),
  // a new one only when nothing is there (createOnly).
  // -> { ok: true, size, mtimeMs, sig, hostHash } | { ok: false, code }
  async function guestWrite({ root, rel, data, expectHash = '', createOnly = false, ignore = true } = {}) {
    const top = under(root, root)
    if (!top || !rel || !relOk(rel) || !Buffer.isBuffer(data) || data.length > MAX_EDIT_BYTES) return { ok: false, code: 'refused' }
    const hash = typeof expectHash === 'string' && HASH_RE.test(expectHash) ? expectHash : ''
    if (!hash && !createOnly) return { ok: false, code: 'refused' }
    const ms = GUEST_MS.write + Math.ceil(data.length / (512 * 1024)) * 1000
    const res = await guestCall(top.hostId, '__t_gwr', [arg(top.root.path), arg(hostPathOf(top, rel)), createOnly ? '' : hash, '', createOnly ? 'new' : '', flag(ignore)], ms, { cap: 64 * 1024, upload: data })
    if (res.error || res.rc !== 0) return guestFail(res)
    const line = res.out.toString('latin1').trim()
    const st = parseStat(line)
    if (!st) return { ok: false, code: 'failed' }
    const fresh = line.split(' ')[4] || ''
    return { ok: true, size: st.size, mtimeMs: st.mtimeMs, sig: st.sig, hostHash: HASH_RE.test(fresh) ? fresh : '' }
  }

  // Of these paths (search results), the ones a guest may name: below real
  // folders only (no link, no nested repository) and, with ignore, not
  // ignored by git. -> { ok: true, good: Set } | { ok: false, code }
  async function guestCheck({ root, rels, ignore = true } = {}) {
    const top = under(root, root)
    if (!top) return { ok: false, code: 'refused' }
    const list = [...new Set((Array.isArray(rels) ? rels : []).filter((r) => r && relOk(r)))].slice(0, GUEST_CHECK_MAX)
    if (!list.length) return { ok: true, good: new Set() }
    const res = await guestCall(top.hostId, '__t_gchk', [arg(top.root.path), flag(ignore)], GUEST_MS.check, { cap: 4 * 1024 * 1024, upload: Buffer.from(`${list.join('\n')}\n`, 'utf8') })
    if (res.error || res.rc !== 0) return guestFail(res)
    if (res.truncated) return { ok: false, code: 'too-large' }
    const recs = res.out.toString('utf8').split('\0')
    const end = recs.indexOf('/@@C')
    if (end < 0) return { ok: false, code: 'failed' }
    const asked = new Set(list)
    const passed = recs.slice(0, end).filter((r) => asked.has(r))
    if (!ignore) return { ok: true, good: new Set(passed) }
    const part = ignoreSection(recs, end + 1, new Set(passed))
    if (!part.ok) return { ok: false, code: part.old ? 'old-git' : 'unknown' }
    return { ok: true, good: new Set(passed.filter((r) => !part.ignored.has(r))) }
  }

  // The project folder's real path (links resolved: a link to a broad folder
  // must not pass for a project), the host's $HOME (a project that is the
  // home folder, or holds it, is no project to share), the folders its git
  // runs hooks from (core.hooksPath), relative to it, lower case ('' for the
  // project itself, its real place too when it is a link): a guest never
  // writes there; and its repository's own folders when they are inside the
  // project under another name than .git (a worktree's .bare, a
  // --separate-git-dir): hidden from guests like .git.
  // hooks null: it cannot be told (git missing, or refusing a repository
  // that is there): a guest writes nothing.
  // -> { ok: true, real, home, hooks: string[] | null, gitDirs: string[] } | { ok: false, code }
  async function guestInfo({ root } = {}) {
    const top = under(root, root)
    if (!top) return { ok: false, code: 'refused' }
    const res = await guestCall(top.hostId, '__t_ghk', [arg(top.root.path)], GUEST_MS.hooks, { cap: 64 * 1024 })
    if (res.error) return guestFail(res)
    const lines = res.out.toString('utf8').split('\n')
    if (lines[lines.length - 1] === '') lines.pop()
    const real = lines[0] && lines[0].startsWith('R /') ? lines[0].slice(2) : null
    if (!real || CONTROL.test(real)) return guestFail(res.rc === 0 ? { rc: 98 } : res)
    // $HOME as set (M) and its real path (P); the repository's own folders
    // (G, C); the rest says where its hooks run.
    const okPath = (p) => p.startsWith('/') && !CONTROL.test(p)
    const homes = []
    const gitDirs = []
    let rootIsGitDir = false
    const rest = []
    for (const l of lines.slice(1)) {
      const v = l.slice(2)
      if (/^[MP] /.test(l)) {
        if (okPath(v)) homes.push(v.replace(/(.)\/+$/, '$1'))
      } else if (/^[GC] /.test(l)) {
        if (!okPath(v)) continue
        const rel = relativeTo(real, v)
        // The project folder is itself a repository's folder (a bare one),
        // or inside one: nothing of it is shared.
        if (rel === '' || relativeTo(v, real) !== null) rootIsGitDir = true
        else if (rel !== null && !CONTROL.test(rel)) gitDirs.push(rel.toLowerCase())
      } else rest.push(l)
    }
    return { ok: true, real, home: homes[0] || null, homes: [...new Set(homes)], rootIsGitDir, hooks: res.rc === 0 ? hooksFrom(real, rest) : null, gitDirs: [...new Set(gitDirs)] }
  }
  // __t_ghk's lines after the real root and $HOME -> [rels] | null (cannot be told).
  function hooksFrom(real, lines) {
    if (lines.length === 1 && lines[0] === 'N') return []
    if (!lines.length || lines.some((l) => !/^[THQ] /.test(l))) return null
    const one = (k) => {
      const all = lines.filter((l) => l[0] === k)
      return all.length > 1 ? undefined : all.length ? all[0].slice(2) : null
    }
    const top = one('T')
    const where = one('H')
    const target = one('Q')
    if (!top || !top.startsWith('/') || where === undefined || target === undefined) return null
    if (where === null || where === '') return []
    // A home-relative value cannot be placed here: nothing is written.
    if (where.startsWith('~') || CONTROL.test(where)) return null
    const segs = []
    for (const seg of (where.startsWith('/') ? where : joinPath(top, where)).split('/')) {
      if (!seg || seg === '.') continue
      if (seg === '..') segs.pop()
      else segs.push(seg)
    }
    const rels = new Set()
    const lexical = relativeTo(real, `/${segs.join('/')}`)
    if (lexical !== null) rels.add(lexical.toLowerCase())
    // Where the folder really is (a link to another folder of the project
    // makes the files there run as hooks too).
    const really = target && target.startsWith('/') ? relativeTo(real, target) : null
    if (really !== null) rels.add(really.toLowerCase())
    return [...rels]
  }


  // A name search (folders, then files). -> { ok: true, results: [{ rel,
  // dir }], truncated } | { ok: false, code }
  async function guestSearchNames({ root, query, limit = SEARCH_LIMIT } = {}) {
    const top = under(root, root)
    if (!top) return { ok: false, code: 'refused' }
    const max = Number.isInteger(limit) && limit > 0 ? Math.min(limit, SEARCH_LIMIT) : SEARCH_LIMIT
    const q = String(query || '').trim()
    if (!q || CONTROL.test(q) || q.length > 500) return { ok: true, results: [], truncated: false }
    const res = await guestCall(top.hostId, '__t_gfind', [arg(top.root.path), findPattern(q)], GUEST_MS.search, { cap: 1024 * 1024 })
    if (res.error) return guestFail(res)
    const cut = !!res.truncated || res.rc === RC.PIPE
    if (!cut && res.rc !== 0 && res.rc !== 1) return guestFail(res)
    const results = []
    let truncated = cut
    let dir = true
    for (const rec of res.out.toString('utf8').split('\0')) {
      if (rec === '/@@F') {
        dir = false
        continue
      }
      const at = rec.indexOf('/./')
      if (at < 0) continue
      const rel = cleanRel(rec.slice(at + 3))
      if (!rel || rel.includes('\\')) continue
      if (results.length >= max) {
        truncated = true
        break
      }
      results.push({ rel, dir })
    }
    return { ok: true, results, truncated }
  }

  // A text search (git grep in a repository: what git ignores is not
  // searched; plain grep elsewhere). -> { ok: true, results: [{ rel, line,
  // text }], truncated } | { ok: false, code }
  async function guestSearchContent({ root, query, limit = SEARCH_LIMIT } = {}) {
    const top = under(root, root)
    if (!top) return { ok: false, code: 'refused' }
    const max = Number.isInteger(limit) && limit > 0 ? Math.min(limit, SEARCH_LIMIT) : SEARCH_LIMIT
    const q = String(query || '')
    if (!q.trim() || CONTROL.test(q) || q.length > 1000) return { ok: true, results: [], truncated: false }
    const res = await guestCall(top.hostId, '__t_ggrep', [arg(top.root.path), q, ...GUEST_FIXED_ARGS, ...gitGrepArgs(q)], GUEST_MS.search, { cap: SEARCH_OUTPUT + 1 })
    if (res.error) return guestFail(res)
    const cut = !!res.truncated || res.rc === RC.PIPE
    if (!cut && res.rc !== 0 && res.rc !== 1) return guestFail(res)
    const text = res.out.toString('utf8')
    const nl = text.indexOf('\n')
    const mode = nl < 0 ? '' : text.slice(0, nl)
    if (mode !== 'G' && mode !== 'P' && mode !== 'L') return { ok: false, code: 'failed' }
    const body = text.slice(nl + 1)
    const found = mode === 'G' ? grepRecords(body, true, max, q.toLowerCase()) : mode === 'P' ? nulGrepRecords(body, max, q.toLowerCase()) : fileGrepRecords(body, max, q.toLowerCase())
    return { ok: true, results: found.results, truncated: cut || found.truncated }
  }
  // A grep without --null (BusyBox): each file on a "/@@F ./<path>" line of
  // its own, then its "<line>:<text>" lines: a name is never taken from a
  // matched line. -> { results, truncated }
  function fileGrepRecords(out, max, lower) {
    const results = []
    let truncated = false
    let rel = null
    for (const rec of out.split('\n')) {
      if (rec.startsWith('/@@F ')) {
        const p = rec.slice(5)
        rel = p.startsWith('./') ? cleanRel(p.slice(2)) : null
        if (rel && rel.includes('\\')) rel = null
        continue
      }
      const m = rel && /^(\d+):(.*)$/s.exec(rec)
      if (!m) continue
      const line = Number(m[1])
      if (!Number.isInteger(line) || line < 1) continue
      if (results.length >= max) {
        truncated = true
        break
      }
      results.push({ rel, line, text: clip(m[2], lower) })
    }
    return { results, truncated }
  }
  // grep --null's lines ("./<path>" NUL "<line>:<text>"), read strictly: a
  // file name is never guessed from a ":" (a line whose text looks like one
  // could name another file). -> { results, truncated }
  function nulGrepRecords(out, max, lower) {
    const results = []
    let truncated = false
    for (const rec of out.split('\n')) {
      const z = rec.indexOf('\0')
      if (z < 2 || !rec.startsWith('./')) continue
      const m = /^(\d+):(.*)$/s.exec(rec.slice(z + 1))
      if (!m) continue
      const rel = cleanRel(rec.slice(2, z))
      const line = Number(m[1])
      if (!rel || rel.includes('\\') || !Number.isInteger(line) || line < 1) continue
      if (results.length >= max) {
        truncated = true
        break
      }
      results.push({ rel, line, text: clip(m[2], lower) })
    }
    return { results, truncated }
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
      op: 'read',
      retry: true
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
    const res = await call(loc.hostId, '__t_stats', [arg(loc.root.path), arg(loc.path)], { cap: 4096, op: 'read', retry: true })
    if (res.error) return { ok: false, error: res.error }
    const st = res.rc === 0 ? parseStat(res.out.toString('latin1')) : null
    return st ? { ok: true, exists: true, ...st } : { ok: true, exists: false, sig: null }
  }

  // Paths printed in an SSH pane's terminal (ssh://<host>/…): which are files
  // or folders, for its links. In a saved remote project only (the files
  // Tessel can open), one round trip per project, at most MAX_LINK_STATS
  // paths, and only on a host already signed in: hovering a terminal never
  // starts a sign-in. -> { [path]: 'file' | 'dir' | null }
  async function statLinks(paths) {
    const out = {}
    const groups = new Map() // "<hostId>\n<root path>" -> { loc, items: [[virtual, loc]] }
    for (const v of Array.isArray(paths) ? paths.slice(0, MAX_LINK_STATS) : []) {
      if (typeof v !== 'string') continue
      out[v] = null
      const loc = isRemotePath(v) ? locate(v) : null
      if (!loc || !connectedQuietly(loc.hostId)) continue
      const key = `${loc.hostId}\n${loc.root.path}`
      if (!groups.has(key)) groups.set(key, { loc, items: [] })
      groups.get(key).items.push([v, loc])
    }
    await Promise.all(
      [...groups.values()].map(async ({ loc, items }) => {
        const entry = sessions.get(loc.hostId)
        const open = !!(entry && !entry.closed && entry.session && entry.session.state === 'ready')
        const res = await call(loc.hostId, '__t_kinds', [arg(loc.root.path), ...items.map(([, l]) => arg(l.path))], {
          cap: 64 * 1024,
          timeoutMs: 10_000,
          op: 'read',
          background: true,
          ...(open ? { ifOpen: true } : {})
        })
        if (!res || res.error || res.skipped || res.rc !== 0) return
        const lines = String(Buffer.isBuffer(res.out) ? res.out.toString('latin1') : res.out || '').split('\n')
        items.forEach(([v], i) => {
          out[v] = lines[i] === 'f' ? 'file' : lines[i] === 'd' ? 'dir' : null
        })
      })
    )
    return out
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
    const res = await call(loc.hostId, '__t_write', [arg(loc.root.path), arg(loc.path), hash, hash ? '' : sigForHost(expectSig), privateNew ? '600' : '', ''], {
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
    const res = await call(loc.hostId, '__t_gitin', [arg(loc.root.path), arg(info.top), ...info.gitArgs, 'show', '--no-textconv', `HEAD:${fromTop}`], { cap: MAX_HEAD_BYTES + 1, timeoutMs: 30000, op: 'read', retry: true })
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
    const res = await call(loc.hostId, '__t_read', [arg(loc.root.path), arg(loc.path), String(MAX_IMAGE)], { cap: MAX_IMAGE + HEADER_SLACK, timeoutMs: 120000, op: 'read', retry: true })
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
        const res = await call(w.hostId, '__t_fp', [arg(w.root.path), String(w.marker), String(FP_PATHS_BYTES)], { cap: FP_PATHS_BYTES + 4096, quiet: true, timeoutMs: 10000 })
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
        const change = res.rc === 0 ? parseFingerprint(res.out, FP_PATHS_BYTES) : null
        if (change && watchedRoots.get(virtual) === w) {
          // Its files or its git state changed: the window reads again what
          // they touch (everything when not known). The repository's top,
          // settings and hooks are looked at again only when git's own
          // folder may have changed them.
          const rels = change.rels
          if (!rels || rels.some((r) => r === '.git' || /^\.git\/(config|hooks|commondir|worktrees)/.test(r))) {
            repoInfos.delete(`${w.hostId}\n${w.root.path}`)
          }
          for (const fn of [...changeListeners]) {
            try {
              fn(virtual)
            } catch {
              /* a listener's own matter */
            }
          }
          send('explorer:changed', { root: virtual, paths: rels ? rels.map((r) => (r ? childPath(virtual, r) : virtual)) : null })
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
  const READ_ONLY_GIT = new Set(['status', 'diff', 'remote', 'log', 'show', 'rev-parse', 'for-each-ref', 'symbolic-ref', 'ls-files', 'cat-file', 'merge-base', 'rev-list'])
  // bg: { background: true, low: true } for the reads made by themselves
  // (scmBg below): the Files panel's git work, held for its repository after
  // one ran out of time in the shared session (SHARED_GIT_MS).
  const scmBgFor = (bg, top) => (bg.low ? { ...bg, holdKey: top.real } : bg)
  const makeScmBackend = (bg = {}) => ({
    async repoOf(root) {
      const loc = isRemotePath(root) && rootOf(root) ? locate(root, root) : null
      if (!loc) return { error: t('main.scm.invalidFolder', 'Invalid folder.') }
      const info = await repoInfo(loc, bg)
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
        op: slow ? list[0] === '-F' ? 'commit' : list[0] : 'git',
        // A read (nothing changes on the host): run again after a dropped connection.
        retry: READ_ONLY_GIT.has(list[0]),
        ...scmBgFor(bg, top)
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
      const res = await call(top.hostId, '__t_gitop', [arg(top.rootPath), arg(top.real)], { cap: 1024, op: 'status', ...scmBgFor(bg, top) })
      const op = !res.error && res.rc === 0 ? res.out.toString('latin1').trim() : ''
      return ['rebase', 'merge', 'cherry-pick'].includes(op) ? op : null
    },
    async untracked(top, rels) {
      const out = new Map()
      const list = (rels || []).filter((r) => typeof r === 'string' && r && !CONTROL.test(r)).slice(0, REMOTE_UNTRACKED_COUNTS)
      for (let i = 0; i < list.length; i += 200) {
        const chunk = list.slice(i, i + 200)
        const res = await call(top.hostId, '__t_wcl', [arg(top.rootPath), arg(top.real), ...chunk], { cap: 256 * 1024, timeoutMs: 30000, op: 'status', ...scmBgFor(bg, top) })
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
  })
  const scmBackend = makeScmBackend()
  const scm = createScm(scmBackend)
  // The Changes count read by itself (a change notice, the panel shown):
  // the same reads as background work, never in front of a click and never
  // "busy" in the badge.
  const scmBg = createScm(makeScmBackend({ background: true, low: true }))
  const remoteOnly = () => ({ ok: false, error: t('main.remoteFs.localOnly', 'Not available for a project on a remote host.') })

  // The window's view of a host's session.
  function snapshot() {
    const out = {}
    for (const [hostId, e] of sessions) out[hostId] = { state: e.session && e.session.state === 'ready' ? (e.busy ? 'busy' : 'ready') : 'connecting', pending: e.busy, op: e.op, slow: !!(e.busy > 0 && e.slow > 0) }
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
  function gitWorktrees(root) {
    return shared(`wt
${root}`, () => gitWorktreesNow(root))
  }
  async function gitWorktreesNow(root) {
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
    userAllow(hostId)
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
    // A terminal opening there waits for it: on the pane's lane (never behind
    // the Files panel or a guest).
    return call(hostId, '__t_ragent', [version], { cap: 64 * 1024, timeoutMs: 60_000, upload: Buffer.from(String(source || ''), 'utf8'), op: 'agent', lane: 'pane' })
  }

  // The agents installed on this host (__t_agents): their paths (none is run,
  // but Codex for its --version and --help), and what an install there
  // needs. Only through a session the host allows
  // (a terminal opened on it).
  // -> { claude, codex, vscodeClaude, bins, host, uid } (null when missing) | { error }
  // An image pasted for an agent in a terminal on this host (its own
  // program would read the host's clipboard, which a server has not): written
  // in ~/.tessel-server/paste there (kept a day), its path given back to be
  // pasted. -> { ok, path } | { ok: false, error }
  const MAX_PASTE_BYTES = 20 * 1024 * 1024
  async function pasteImage(hostId, png) {
    if (!hostIdOk(hostId)) return { ok: false, error: t('main.remote.notFound', 'This remote host is no longer saved in Tessel.') }
    if (!Buffer.isBuffer(png) || !png.length) return { ok: false, error: t('main.remoteFs.noImage', 'The clipboard has no image.') }
    if (png.length > MAX_PASTE_BYTES) return { ok: false, error: t('main.remoteFs.imageTooBig', 'The image is too large to send (over 20 MB).') }
    allow(hostId)
    const name = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`
    const res = await call(hostId, '__t_paste', [name], { cap: 4096, upload: png, timeoutMs: 30000 + Math.ceil(png.length / (512 * 1024)) * 1000, op: 'save' })
    if (!res || res.error) return { ok: false, error: (res && res.error) || t('main.remoteFs.pasteFailed', 'The image could not be written on the host.') }
    const path = res.rc === 0 ? remotePastePath(res.out.toString('utf8')) : ''
    if (!path) return { ok: false, error: t('main.remoteFs.pasteFailed', 'The image could not be written on the host.') }
    return { ok: true, path }
  }

  // bins: the command names looked for (each agent's), else Claude Code's
  // and Codex's.
  // first: asked for a terminal that is opening: on the pane's lane, never
  // behind the host's Files session (its agent check waited 20 s there behind
  // the host's own work and gave up as "still busy", 2026-10-24).
  async function agentTools(hostId, bins = null, { first = false } = {}) {
    if (!hostIdOk(hostId)) return { error: t('main.remote.notFound', 'This remote host is no longer saved in Tessel.') }
    const names = Array.isArray(bins) ? [...new Set(bins.filter((b) => typeof b === 'string' && BIN_NAME.test(b)))].slice(0, 128) : []
    const res = await call(hostId, '__t_agents', names, { cap: 64 * 1024, timeoutMs: 30_000, op: 'agents', background: true, ...(first ? { first: true, lane: 'pane' } : {}) })
    if (!res || res.error) return { error: (res && res.error) || 'failed' }
    if (res.rc !== 0) return { error: rcText(res, `rc ${res.rc}`) }
    return parseAgentTools(Buffer.isBuffer(res.out) ? res.out.toString('utf8') : String(res.out || ''))
  }

  // A reader's call options: a Live Share guest's (lane 'guest': on the
  // guests' lane, see LANES), else the host's own background read (the
  // open session's turn when it is up).
  const guestOr = (lane, open) => (lane === 'guest' ? { lane: 'guest', guest: true } : open ? { ifOpen: true } : {})

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
    const res = await call(hostId, '__t_rsess', [String(n)], { cap: 4 * 1024 * 1024, timeoutMs: 30_000, op: 'sessions', background: true, ...(open ? { ifOpen: true } : {}) })
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
  // sub: one of a Claude session's sub-agent transcripts instead (its name
  // without .jsonl, from listSubagentFiles; __t_sread).
  // lane: 'pane' (a terminal opening waits for it), 'guest' (a Live Share
  // guest's chat view): on that lane (see LANES), not in the host's session.
  // -> { ok: true, size, data: Buffer } | { ok: false, missing? , notConnected?, error }
  async function readAgentFile(hostId, { agent, id, offset = null, cap = 4 * 1024 * 1024, sub = null, lane = null } = {}) {
    if (!hostIdOk(hostId)) return { ok: false, error: t('main.remote.notFound', 'This remote host is no longer saved in Tessel.') }
    if ((agent !== 'claude' && agent !== 'codex') || typeof id !== 'string' || !/^[0-9A-Za-z-]{8,100}$/.test(id)) return { ok: false, error: 'invalid' }
    if (sub !== null && sub !== undefined && (agent !== 'claude' || !SUBAGENT_NAME.test(sub))) return { ok: false, error: 'invalid' }
    if (offset !== null && !(Number.isSafeInteger(offset) && offset >= 0)) return { ok: false, error: 'invalid' }
    const max = Number.isSafeInteger(cap) && cap > 0 ? Math.min(cap, 32 * 1024 * 1024) : 4 * 1024 * 1024
    if (!connectedQuietly(hostId)) return { ok: false, notConnected: true, error: t('main.remoteFs.notConnected', '{{host}} is not connected. Use Connect to sign in.', { host: hostLabel(hostId) }) }
    const entry = sessions.get(hostId)
    const open = !!(entry && !entry.closed && entry.session && entry.session.state === 'ready')
    const where = offset === null ? '-' : String(offset)
    const how = lane === 'pane' ? { lane } : guestOr(lane, open)
    const timeoutMs = lane === 'guest' ? 15_000 : 30_000
    const res = sub
      ? await call(hostId, '__t_sread', [id, `${sub}.jsonl`, where, String(max)], { cap: max + 64, timeoutMs, op: 'read', background: true, ...how })
      : await call(hostId, '__t_tread', [agent, id, where, String(max), agent === 'codex' ? codexDayHint(id) : ''], { cap: max + 64, timeoutMs, op: 'read', background: true, ...how })
    if (!res || res.skipped) return { ok: false, notConnected: true, error: t('main.remoteFs.notConnected', '{{host}} is not connected. Use Connect to sign in.', { host: hostLabel(hostId) }) }
    if (res.error) return { ok: false, error: res.error }
    if (res.rc === RC.MISSING) return { ok: false, missing: true, error: 'missing' }
    if (res.rc !== 0) return { ok: false, error: rcText(res, `rc ${res.rc}`) }
    const out = Buffer.isBuffer(res.out) ? res.out : Buffer.from(String(res.out || ''), 'utf8')
    const nl = out.indexOf(10)
    // "<size> <mtime in seconds>"
    const [sizeText, mtimeText] = nl > 0 ? out.toString('latin1', 0, nl).split(' ') : []
    const size = Number(sizeText)
    if (!Number.isSafeInteger(size) || size < 0) return { ok: false, error: 'unreadable' }
    const mtime = Number(mtimeText)
    return { ok: true, size, mtimeMs: Number.isSafeInteger(mtime) && mtime >= 0 ? mtime * 1000 : null, data: out.subarray(nl + 1) }
  }

  // A Claude Code session's sub-agent transcripts on this host (__t_subs:
  // <id>/subagents/*.jsonl next to its transcript, no link followed), at
  // most `limit`: their names (without .jsonl), sizes and change times, never
  // their contents. Never a sign-in.
  // -> { ok: true, files: [{ name, size, mtimeMs }] } | { ok: false, missing?, notConnected?, error }
  async function listSubagentFiles(hostId, { id, limit = MAX_SUBAGENT_FILES, lane = null } = {}) {
    if (!hostIdOk(hostId)) return { ok: false, error: t('main.remote.notFound', 'This remote host is no longer saved in Tessel.') }
    if (typeof id !== 'string' || !/^[0-9A-Za-z-]{8,100}$/.test(id)) return { ok: false, error: 'invalid' }
    const n = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, MAX_SUBAGENT_FILES) : MAX_SUBAGENT_FILES
    if (!connectedQuietly(hostId)) return { ok: false, notConnected: true, error: t('main.remoteFs.notConnected', '{{host}} is not connected. Use Connect to sign in.', { host: hostLabel(hostId) }) }
    const entry = sessions.get(hostId)
    const open = !!(entry && !entry.closed && entry.session && entry.session.state === 'ready')
    const res = await call(hostId, '__t_subs', [id, String(n)], { cap: 64 * 1024, timeoutMs: 20_000, op: 'read', background: true, ...guestOr(lane, open) })
    if (!res || res.skipped) return { ok: false, notConnected: true, error: t('main.remoteFs.notConnected', '{{host}} is not connected. Use Connect to sign in.', { host: hostLabel(hostId) }) }
    if (res.error) return { ok: false, error: res.error }
    if (res.rc === RC.MISSING) return { ok: false, missing: true, error: 'missing' }
    if (res.rc !== 0 && res.rc !== RC.PIPE && !res.truncated) return { ok: false, error: rcText(res, `rc ${res.rc}`) }
    return { ok: true, files: parseSubagentListing(Buffer.isBuffer(res.out) ? res.out.toString('utf8') : String(res.out || ''), n) }
  }

  // The meta files of some of a Claude Code session's sub-agents on this host
  // (__t_smeta: <id>/subagents/<name>.meta.json, its first 4 KB each), by
  // their names from listSubagentFiles. Never a sign-in.
  // -> { ok: true, metas: { name: object } } (a name without one is left out)
  //    | { ok: false, missing?, notConnected?, error }
  async function readSubagentMetas(hostId, { id, names, lane = null } = {}) {
    if (!hostIdOk(hostId)) return { ok: false, error: t('main.remote.notFound', 'This remote host is no longer saved in Tessel.') }
    if (typeof id !== 'string' || !/^[0-9A-Za-z-]{8,100}$/.test(id)) return { ok: false, error: 'invalid' }
    const list = Array.isArray(names) ? [...new Set(names.filter((n) => typeof n === 'string' && SUBAGENT_NAME.test(n)))].slice(0, MAX_SUBAGENT_FILES) : []
    if (!list.length) return { ok: true, metas: {} }
    if (!connectedQuietly(hostId)) return { ok: false, notConnected: true, error: t('main.remoteFs.notConnected', '{{host}} is not connected. Use Connect to sign in.', { host: hostLabel(hostId) }) }
    const entry = sessions.get(hostId)
    const open = !!(entry && !entry.closed && entry.session && entry.session.state === 'ready')
    const res = await call(hostId, '__t_smeta', [id, ...list], { cap: 512 * 1024, timeoutMs: 20_000, op: 'read', background: true, ...guestOr(lane, open) })
    if (!res || res.skipped) return { ok: false, notConnected: true, error: t('main.remoteFs.notConnected', '{{host}} is not connected. Use Connect to sign in.', { host: hostLabel(hostId) }) }
    if (res.error) return { ok: false, error: res.error }
    if (res.rc === RC.MISSING) return { ok: false, missing: true, error: 'missing' }
    if (res.rc !== 0) return { ok: false, error: rcText(res, `rc ${res.rc}`) }
    return { ok: true, metas: parseSubagentMetas(Buffer.isBuffer(res.out) ? res.out.toString('utf8') : String(res.out || ''), list) }
  }

  // A Codex session's sub-agents on this host (__t_cxkids: the rollouts
  // written in the last two days whose first line names it), at most
  // `limit`: names (rollout-<time>-<id>, without .jsonl), sizes and change
  // times. Each one is then read by its id (readAgentFile). Never a sign-in.
  // -> { ok: true, files: [{ name, size, mtimeMs }] } | { ok: false, notConnected?, error }
  async function listCodexChildren(hostId, { id, limit = MAX_SUBAGENT_FILES, lane = null } = {}) {
    if (!hostIdOk(hostId)) return { ok: false, error: t('main.remote.notFound', 'This remote host is no longer saved in Tessel.') }
    if (typeof id !== 'string' || !/^[0-9A-Za-z-]{8,100}$/.test(id)) return { ok: false, error: 'invalid' }
    const n = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, MAX_SUBAGENT_FILES) : MAX_SUBAGENT_FILES
    if (!connectedQuietly(hostId)) return { ok: false, notConnected: true, error: t('main.remoteFs.notConnected', '{{host}} is not connected. Use Connect to sign in.', { host: hostLabel(hostId) }) }
    const entry = sessions.get(hostId)
    const open = !!(entry && !entry.closed && entry.session && entry.session.state === 'ready')
    const res = await call(hostId, '__t_cxkids', [id, String(n)], { cap: 64 * 1024, timeoutMs: lane === 'guest' ? 15_000 : 30_000, op: 'read', background: true, ...guestOr(lane, open) })
    if (!res || res.skipped) return { ok: false, notConnected: true, error: t('main.remoteFs.notConnected', '{{host}} is not connected. Use Connect to sign in.', { host: hostLabel(hostId) }) }
    if (res.error) return { ok: false, error: res.error }
    if (res.rc !== 0 && res.rc !== RC.PIPE && !res.truncated) return { ok: false, error: rcText(res, `rc ${res.rc}`) }
    return { ok: true, files: parseSubagentListing(Buffer.isBuffer(res.out) ? res.out.toString('utf8') : String(res.out || ''), n) }
  }

  // The signed-in user's home folder on this host ($HOME), kept once known
  // (it does not change while Tessel runs). Never a sign-in.
  // -> { ok: true, home } | { ok: false, notConnected?, error }
  const homes = new Map() // hostId -> home
  async function hostHome(hostId) {
    if (!hostIdOk(hostId)) return { ok: false, error: t('main.remote.notFound', 'This remote host is no longer saved in Tessel.') }
    if (homes.has(hostId)) return { ok: true, home: homes.get(hostId) }
    if (!connectedQuietly(hostId)) return { ok: false, notConnected: true, error: t('main.remoteFs.notConnected', '{{host}} is not connected. Use Connect to sign in.', { host: hostLabel(hostId) }) }
    const entry = sessions.get(hostId)
    const open = !!(entry && !entry.closed && entry.session && entry.session.state === 'ready')
    const res = await call(hostId, '__t_home', [], { cap: 8192, timeoutMs: 15_000, op: 'read', background: true, ...(open ? { ifOpen: true } : {}) })
    if (!res || res.skipped) return { ok: false, notConnected: true, error: t('main.remoteFs.notConnected', '{{host}} is not connected. Use Connect to sign in.', { host: hostLabel(hostId) }) }
    if (res.error) return { ok: false, error: res.error }
    const home = res.rc === 0 ? String(Buffer.isBuffer(res.out) ? res.out.toString('utf8') : res.out || '').split('\n')[0] : ''
    if (!home.startsWith('/') || home.length > 4096 || CONTROL.test(home) || home.includes('\\')) return { ok: false, error: 'unreadable' }
    const clean = home.length > 1 ? home.replace(/\/+$/, '') : home
    homes.set(hostId, clean)
    return { ok: true, home: clean }
  }

  // The agents' accounts on this host (remoteAgent/remoteAccounts.js): its
  // functions only. A read runs in the background on a host already signed
  // in (never a sign-in). user: something you asked for (a pane started on an
  // account, a folder made or removed), in your turn, signing in like a
  // terminal opened there would (on the pane's lane: a pane starting on an
  // account waits for it). -> { rc, out } | { error, notConnected? }
  async function accountCall(hostId, fn, args, { cap = 64 * 1024, timeoutMs = 25_000, user = false } = {}) {
    if (!hostIdOk(hostId)) return { error: t('main.remote.notFound', 'This remote host is no longer saved in Tessel.') }
    if (!ACCOUNT_FUNCTIONS.includes(fn) || !Array.isArray(args) || args.some((a) => typeof a !== 'string')) return { error: 'invalid' }
    const notConnected = () => ({ notConnected: true, error: t('main.remoteFs.notConnected', '{{host}} is not connected. Use Connect to sign in.', { host: hostLabel(hostId) }) })
    if (user) {
      allow(hostId)
      return call(hostId, fn, args, { cap, timeoutMs, op: 'accounts', lane: 'pane' })
    }
    if (!connectedQuietly(hostId)) return notConnected()
    const entry = sessions.get(hostId)
    const open = !!(entry && !entry.closed && entry.session && entry.session.state === 'ready')
    const res = await call(hostId, fn, args, { cap, timeoutMs, op: 'accounts', background: true, ...(open ? { ifOpen: true } : {}) })
    if (!res || res.skipped) return notConnected()
    return res
  }

  // Claude Code's skills on this host (__t_skills): ~/.claude/skills, and
  // the project's .claude/skills when `project` (a remote path) is given.
  // agent 'codex': Codex's (__t_cxskills): $CODEX_HOME/skills and
  // ~/.agents/skills, the project's .agents/skills and .codex/skills, each
  // file with its skills folder (root). No link followed.
  // Their SKILL.md paths and first 8 KB only, at most `limit` per folder.
  // Never a sign-in. -> { ok: true, files: [{ kind: 'home'|'repo', path, text }] } | { ok: false, notConnected?, error }
  async function listAgentSkills(hostId, { project = null, limit = 200, agent = 'claude' } = {}) {
    if (!hostIdOk(hostId)) return { ok: false, error: t('main.remote.notFound', 'This remote host is no longer saved in Tessel.') }
    if (agent !== 'claude' && agent !== 'codex') return { ok: false, error: 'invalid' }
    let projectArg = '-'
    if (project !== null && project !== undefined) {
      const p = cleanBrowsePath(project)
      if (!p) return { ok: false, error: 'invalid' }
      projectArg = arg(p)
    }
    const n = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 500) : 200
    if (!connectedQuietly(hostId)) return { ok: false, notConnected: true, error: t('main.remoteFs.notConnected', '{{host}} is not connected. Use Connect to sign in.', { host: hostLabel(hostId) }) }
    const entry = sessions.get(hostId)
    const open = !!(entry && !entry.closed && entry.session && entry.session.state === 'ready')
    const res = await call(hostId, agent === 'codex' ? '__t_cxskills' : '__t_skills', [projectArg, String(n)], { cap: 4 * 1024 * 1024, timeoutMs: 20_000, op: 'read', background: true, ...(open ? { ifOpen: true } : {}) })
    if (!res || res.skipped) return { ok: false, notConnected: true, error: t('main.remoteFs.notConnected', '{{host}} is not connected. Use Connect to sign in.', { host: hostLabel(hostId) }) }
    if (res.error) return { ok: false, error: res.error }
    if (res.rc !== 0 && res.rc !== RC.PIPE && !res.truncated) return { ok: false, error: rcText(res, `rc ${res.rc}`) }
    return { ok: true, files: parseSkillListing(Buffer.isBuffer(res.out) ? res.out.toString('latin1') : String(res.out || '')) }
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
    closeLanes(null, 'shutdown')
    watchedRoots.clear()
    watchedFiles.clear()
    stopPollIfIdle()
    if (idleTimer) timers.clearInterval(idleTimer)
    idleTimer = null
  }

  return {
    allow,
    userAllow,
    allowPath,
    setRoots,
    hasRoot: (virtual) => !!rootOf(virtual),
    onChange: (fn) => {
      changeListeners.add(fn)
      return () => changeListeners.delete(fn)
    },
    listDir,
    listMany,
    projectStatus,
    sparseInfo,
    searchNames,
    searchContent,
    // A Live Share guest's requests (on the guest's lane, checked on the host).
    guest: {
      list: guestList,
      stat: guestStat,
      read: guestRead,
      write: guestWrite,
      check: guestCheck,
      info: guestInfo,
      searchNames: guestSearchNames,
      searchContent: guestSearchContent
    },
    create,
    rename,
    trash,
    readForEdit,
    statForEdit,
    statLinks,
    writeForEdit,
    headContent,
    readImage,
    watchRoot,
    unwatchRoots,
    watchFiles,
    // Discard sends untracked files to the host's trash (no Recycle Bin here).
    // q.background: read by itself (the Changes count after a change notice).
    scm: { ...scm, scmStatus: (q = {}) => shared(`scm${q && q.background === true ? 'b' : ''}
${q && q.root}`, () => (q && q.background === true ? scmBg : scm).scmStatus(q)), scmDiscard: (q) => scm.scmDiscard(q) },
    remoteOnly,
    gitWorktrees,
    githubContext,
    connect,
    installAgentShim,
    pasteImage,
    agentTools,
    connectedQuietly,
    listAgentSessions,
    readAgentFile,
    listSubagentFiles,
    readSubagentMetas,
    listCodexChildren,
    hostHome,
    listAgentSkills,
    accountCall,
    browse,
    cloneProject,
    createProject,
    closeHost,
    closePane,
    snapshot,
    // The lanes open now (tests, diagnostics): ["hostId lane"].
    lanesOpen: () => [...lanes.values()].filter((e) => !e.closed).map((e) => `${e.hostId} ${e.lane}`),
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
