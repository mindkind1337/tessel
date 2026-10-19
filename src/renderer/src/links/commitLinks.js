// A commit hash found in text (commitRefs.js) becomes a link only once the
// repository of the pane that wrote it says it is a commit there: asked
// when the pointer reaches it (or it is clicked), never for every message
// shown, four questions at a time at most. The main process asks git
// (scm:resolveCommit: this computer's repository, an SSH host's over its
// connection, a Live Share host's through the history it shares), and only
// for a folder inside one the window has open (setCommitRoots:
// shared/commitRoots.js; main checks it again). The answers are kept here:
//   a commit      -> kept (a commit never changes);
//   not one       -> kept a minute (a fetch or a new commit may add it);
//   no answer     -> kept 10 seconds (asked again after that).
// Every surface (the chat, the Conversations tab, task cards, the activity
// log, terminals) opens it through the link router: { kind: 'commit',
// commit, root } (openTarget.js), so a click does the same everywhere.
import { t, intlLocale } from '../i18n'
import { dateTimeFormat } from '../../../shared/intlCache'
import { cleanCommitRoots, commitRootAllowed, insideFolder, isForeignShare } from '../../../shared/commitRoots.js'
import { isCommitHash } from './commitRefs.js'
import { localPath, wslToWindows } from './terminalLinkPaths.js'
import { remoteRoot } from '../../../shared/remotePath.js'
import { lshareRoot } from '../../../shared/liveSharePath.js'

const MISSING_MS = 60 * 1000
const FAILED_MS = 10 * 1000
const MAX_CACHE = 2000
const MAX_RUNNING = 4
const cache = new Map() // root \n hash -> { info, at, failed }
const pending = new Map() // root \n hash -> Promise
let roots = []

const keyOf = (root, hash) => `${root}\n${hash}`
const scmApi = () => globalThis.window?.shellApi?.scm || null

// The folders the window has open (App.vue: its projects, the side panel's
// folder, the task and pane worktree copies), told to main as well.
export function setCommitRoots(list, { api = scmApi } = {}) {
  roots = cleanCommitRoots(list)
  const scm = api()
  if (scm && typeof scm.setCommitRoots === 'function') scm.setCommitRoots(roots)
}
export const commitRootKnown = (root) => commitRootAllowed(root, roots)

// The repository folder a message is read against (a file link context:
// useMessageLinks().contextFor, useNativeChatFileLinkContext), or null:
// the pane's worktree copy, its SSH host's folder (ssh://…).
export function commitRootOf(context) {
  if (!context || typeof context !== 'object') return null
  const root = context.remoteRoot || context.worktreePath || (Array.isArray(context.roots) ? context.roots[0] : null)
  return typeof root === 'string' && root && !/[\u0000-\u001f]/.test(root) && !isForeignShare(root) ? root : null
}

// A terminal pane's repository folder: the folder it started in (its
// worktree copy, its SSH host's folder, a WSL pane's start folder), or the
// shell's current folder when its shell reports one inside that folder (lc:
// TerminalPane's link context, terminalLinkPaths.js). What a shell reports
// is text a program printed: only a hint, never a folder of its own. A Live
// Share host's pane: its shared project (lshare://…, asked through what the
// host shares of its history).
export function paneCommitRoot(lc, node = {}) {
  if (node && node.backend === 'liveshare') return node.liveShare && node.liveShare.project ? lshareRoot(node.liveShare.project) : null
  if (!lc) return null
  const isHome = (c) => c === '~' || (typeof c === 'string' && c.startsWith('~/'))
  const pick = (cwd, base) => (base && cwd && insideFolder(cwd, base) ? cwd : base) || null
  if (lc.mode === 'ssh') {
    const posix = (c) => typeof c === 'string' && (c.startsWith('/') || isHome(c))
    const base = posix(lc.remotePath) ? lc.remotePath : null
    const where = pick(posix(lc.cwd) ? lc.cwd : null, base)
    return where && lc.hostId ? remoteRoot(lc.hostId, where) : null
  }
  if (lc.mode === 'wsl') {
    const cwd = typeof lc.cwd === 'string' && lc.cwd.startsWith('/') ? wslToWindows(lc.cwd, lc.distro) : null
    const where = pick(cwd, lc.startDir || null)
    return where && !isForeignShare(where) ? where : null
  }
  const base = (node && node.worktree && node.worktree.path) || lc.startDir || (node && node.cwd) || null
  const cwd = localPath(lc.cwd, { gitbash: !!lc.gitbash })
  const where = pick(typeof cwd === 'string' ? cwd : null, base)
  return where && !isForeignShare(where) ? where : null
}

// What is known now: info ({ id, subject, author, timestamp }), null (not a
// commit there) or undefined (not asked yet, or a while ago).
export function cachedCommit(root, hash, now = Date.now()) {
  const hit = cache.get(keyOf(root, hash))
  if (!hit) return undefined
  if (!hit.info && now - hit.at > (hit.failed ? FAILED_MS : MISSING_MS)) {
    cache.delete(keyOf(root, hash))
    return undefined
  }
  return hit.info
}

// Four questions at a time; the rest wait their turn.
let running = 0
const waiting = []
function queued(fn) {
  return new Promise((resolve, reject) => {
    waiting.push({ fn, resolve, reject })
    pump()
  })
}
function pump() {
  while (running < MAX_RUNNING && waiting.length) {
    const { fn, resolve, reject } = waiting.shift()
    running++
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        running--
        pump()
      })
  }
}

function remember(key, entry) {
  if (cache.size >= MAX_CACHE) for (const k of [...cache.keys()].slice(0, MAX_CACHE / 4)) cache.delete(k)
  cache.set(key, entry)
}

// -> Promise<info | null>
export function resolveCommit(root, hash, { api = scmApi } = {}) {
  if (!root || !isCommitHash(hash) || !commitRootKnown(root)) return Promise.resolve(null)
  const known = cachedCommit(root, hash)
  if (known !== undefined) return Promise.resolve(known)
  const key = keyOf(root, hash)
  if (pending.has(key)) return pending.get(key)
  const scm = api()
  if (!scm || typeof scm.resolveCommit !== 'function') return Promise.resolve(null)
  const job = queued(() => scm.resolveCommit({ root, commit: hash }))
    .then((res) => {
      const ok = !!(res && res.ok && typeof res.id === 'string' && /^[0-9a-f]{7,64}$/.test(res.id) && res.id.startsWith(hash))
      const info = ok ? { id: res.id, subject: String(res.subject || ''), author: String(res.author || ''), timestamp: Number.isFinite(res.timestamp) ? res.timestamp : null } : null
      // A refusal the host or git gave is an answer; anything else a failure.
      remember(key, { info, at: Date.now(), failed: !(res && typeof res === 'object') })
      return info
    })
    .catch(() => {
      remember(key, { info: null, at: Date.now(), failed: true })
      return null
    })
    .finally(() => pending.delete(key))
  pending.set(key, job)
  return job
}

export function clearCommitCache() {
  cache.clear()
  pending.clear()
}

// The link router's target for a commit found there.
export const commitTarget = (root, info) => ({ kind: 'commit', commit: info.id, root })

function when(timestamp) {
  if (!Number.isFinite(timestamp)) return ''
  try {
    return dateTimeFormat(intlLocale(), { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(timestamp))
  } catch {
    return ''
  }
}

// The hover: "1f6ccc7 Fix the link router", "Ann · 6 Oct 2026, 23:12", and
// what a click does.
export function commitTip(info) {
  if (!info) return ''
  const short = info.id.slice(0, 7)
  const subject = info.subject.length > 120 ? `${info.subject.slice(0, 120)}…` : info.subject
  const by = [info.author, when(info.timestamp)].filter(Boolean).join(' · ')
  return [subject ? `${short} ${subject}` : short, by, t('links.commit.hint', 'Click: show in Source Control. Ctrl+click: copy the full hash.')].filter(Boolean).join('\n')
}
