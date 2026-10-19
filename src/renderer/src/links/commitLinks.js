// A commit hash found in text (commitRefs.js) becomes a link only once the
// repository of the pane that wrote it says it is a commit there: asked
// when the pointer reaches it (or it is clicked), never for every message
// shown. The main process asks git (scm:resolveCommit: this computer's
// repository, an SSH host's over its connection, a Live Share host's
// through the history it shares); the answers are kept here:
//   a commit      -> kept (a commit never changes);
//   not one       -> kept a minute (a fetch or a new commit may add it);
//   no answer     -> not kept (asked again next time).
// Every surface (the chat, the Conversations tab, task cards, the activity
// log, terminals) opens it through the link router: { kind: 'commit',
// commit, root } (openTarget.js), so a click does the same everywhere.
import { t, intlLocale } from '../i18n'
import { dateTimeFormat } from '../../../shared/intlCache'
import { isCommitHash } from './commitRefs.js'
import { localPath, wslToWindows } from './terminalLinkPaths.js'
import { remoteRoot } from '../../../shared/remotePath.js'
import { lshareRoot } from '../../../shared/liveSharePath.js'

const MISSING_MS = 60 * 1000
const MAX_CACHE = 2000
const cache = new Map() // root \n hash -> { info, at }
const pending = new Map() // root \n hash -> Promise

const keyOf = (root, hash) => `${root}\n${hash}`
const scmApi = () => globalThis.window?.shellApi?.scm || null

// The repository folder a message is read against (a file link context:
// useMessageLinks().contextFor, useNativeChatFileLinkContext), or null:
// the pane's worktree copy, its SSH host's folder (ssh://…).
export function commitRootOf(context) {
  if (!context || typeof context !== 'object') return null
  const root = context.remoteRoot || context.worktreePath || (Array.isArray(context.roots) ? context.roots[0] : null)
  return typeof root === 'string' && root && !/[\u0000-\u001f]/.test(root) ? root : null
}

// A terminal pane's repository folder: the shell's current folder when its
// shell reports it (lc: TerminalPane's link context, terminalLinkPaths.js),
// else the folder the pane started in. An SSH pane's is its host's folder
// (ssh://…), never this computer's; a WSL pane's the distro's folder as
// Windows reaches it; a Live Share host's pane its shared project
// (lshare://…: asked through what the host shares of its history).
export function paneCommitRoot(lc, node = {}) {
  if (node && node.backend === 'liveshare') return node.liveShare && node.liveShare.project ? lshareRoot(node.liveShare.project) : null
  if (!lc) return null
  const isHome = (c) => c === '~' || (typeof c === 'string' && c.startsWith('~/'))
  if (lc.mode === 'ssh') {
    const base = [lc.cwd, lc.remotePath].find((c) => typeof c === 'string' && (c.startsWith('/') || isHome(c)))
    return base && lc.hostId ? remoteRoot(lc.hostId, base) : null
  }
  if (lc.mode === 'wsl') {
    if (typeof lc.cwd === 'string' && lc.cwd.startsWith('/')) return wslToWindows(lc.cwd, lc.distro) || null
    return lc.startDir || null
  }
  const cwd = localPath(lc.cwd, { gitbash: !!lc.gitbash })
  return (typeof cwd === 'string' && cwd) || (node && node.worktree && node.worktree.path) || lc.startDir || (node && node.cwd) || null
}

// What is known now: info ({ id, subject, author, timestamp }), null (not a
// commit there) or undefined (not asked yet, or a while ago).
export function cachedCommit(root, hash, now = Date.now()) {
  const hit = cache.get(keyOf(root, hash))
  if (!hit) return undefined
  if (!hit.info && now - hit.at > MISSING_MS) {
    cache.delete(keyOf(root, hash))
    return undefined
  }
  return hit.info
}

// -> Promise<info | null>
export function resolveCommit(root, hash, { api = scmApi } = {}) {
  if (!root || !isCommitHash(hash)) return Promise.resolve(null)
  const known = cachedCommit(root, hash)
  if (known !== undefined) return Promise.resolve(known)
  const key = keyOf(root, hash)
  if (pending.has(key)) return pending.get(key)
  const scm = api()
  if (!scm || typeof scm.resolveCommit !== 'function') return Promise.resolve(null)
  const job = Promise.resolve()
    .then(() => scm.resolveCommit({ root, commit: hash }))
    .then((res) => {
      const ok = !!(res && res.ok && typeof res.id === 'string' && /^[0-9a-f]{7,64}$/.test(res.id) && res.id.startsWith(hash))
      const info = ok ? { id: res.id, subject: String(res.subject || ''), author: String(res.author || ''), timestamp: Number.isFinite(res.timestamp) ? res.timestamp : null } : null
      // A refusal the host or git gave is an answer; a failed call is not.
      if (res && typeof res === 'object') {
        if (cache.size >= MAX_CACHE) for (const k of [...cache.keys()].slice(0, MAX_CACHE / 4)) cache.delete(k)
        cache.set(key, { info, at: Date.now() })
      }
      return info
    })
    .catch(() => null)
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
