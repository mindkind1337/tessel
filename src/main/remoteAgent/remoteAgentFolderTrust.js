// The SSH counterpart of agentFolderTrust.js: before Tessel types Claude
// Code's start line in a pane on an SSH host, the host's own Claude config
// gets projects["<folder>"].hasTrustDialogAccepted = true, so Claude Code does
// not stop at "Do you trust the files in this folder?" in a project the user
// added in Tessel. The write itself is the host's (__t_trust in
// remoteAccounts.sh: minimal, atomic, under Claude Code's lock, a file it
// cannot parse left alone).
//
// The same consent rules as on this computer:
//   - only when Settings > Agents "Trust the folder when Tessel starts an
//     agent" is on;
//   - only a folder the user chose in Tessel: exactly a remote project of the
//     saved layout on that same host (compared after normalising, "~" taken
//     from the host's home), checked here in main against the layout main
//     stores, never a folder below it (Claude Code inherits a parent's trust
//     already) and never a path the window or the host names alone (a resumed
//     conversation's folder included); the host refuses /, the home folder,
//     any folder above it, and a folder whose real path is another place (a
//     link), so a link never trusts what the user did not choose;
//   - only Claude Code (its trust is one JSON file; Codex's is TOML, not done
//     here: Codex asks as before);
//   - only the config the agent reads: its account folder, the login shell's
//     CLAUDE_CONFIG_DIR, or its own; not known yet: nothing is written;
//   - only a saved SSH host (never WSL), on a connection already signed in
//     (remoteFs.accountCall without `user`: never a sign-in, never a prompt);
//     a pane of the host still connecting is waited for briefly, nothing else.
// Never throws, never waits more than deadlineMs, and the host writes nothing
// past that deadline (late): anything else means only that the agent asks,
// as it did before.
import { parseRemotePath, remoteRoot } from '../../shared/remotePath.js'
import { ID } from './remoteAccounts.js'

export const REMOTE_TRUST_DEADLINE_MS = 4000
// How long a launch waits for a pane of its host that is still connecting.
export const CONNECT_WAIT_MS = 2000
export const REMOTE_TRUST_AGENTS = ['claude']
export const TRUST_WORDS = ['granted', 'unchanged', 'refused', 'unparseable', 'locked', 'late', 'no-tool', 'failed']
const HOST_ID = /^ssh-[\w-]{1,60}$/
// eslint-disable-next-line no-control-regex
const POSIX_DIR = /^\/[^\u0000-\u001f\u007f-\u009f]{0,1023}$/

// The host's answer -> one of TRUST_WORDS ('failed' for anything else).
export function parseTrustAnswer(res) {
  if (!res || res.error || res.notConnected || res.skipped || typeof res.rc !== 'number' || res.rc !== 0) return 'failed'
  const text = Buffer.isBuffer(res.out) ? res.out.toString('utf8') : String(res.out || '')
  const word = text.split('\n')[0].replace(/\r$/, '').trim()
  return TRUST_WORDS.includes(word) ? word : 'failed'
}

// ~ expanded with the host's home (when known), for comparing two forms of
// one folder (a project saved as ~/app, a pane given /home/me/app).
function expand(path, home) {
  if (typeof home !== 'string' || !home.startsWith('/')) return path
  const h = home.length > 1 ? home.replace(/\/+$/, '') : home
  if (path === '~') return h
  return path.startsWith('~/') ? `${h === '/' ? '' : h}${path.slice(1)}` : path
}

// run(hostId, fn, args, opts) -> remoteFs.accountCall's answer;
// connected(hostId) -> whether the host is signed in already (no question);
// connecting(hostId) -> whether a pane of it is connecting now;
// homeOf(hostId) -> its $HOME when known ({ ok, home }), never a sign-in;
// loginDir(hostId, 'claude') -> the login shell's CLAUDE_CONFIG_DIR there
// (a folder, null, or undefined when not known); learnLoginDir(hostId):
// have it read (in the background) for the next start.
export function createRemoteAgentFolderTrust({
  run,
  connected = () => false,
  connecting = () => false,
  homeOf = async () => null,
  loginDir = () => undefined,
  learnLoginDir = () => {},
  isSavedHost = () => false,
  deadlineMs = REMOTE_TRUST_DEADLINE_MS,
  connectWaitMs = CONNECT_WAIT_MS,
  pollMs = 200,
  now = Date.now,
  log = null
} = {}) {
  let roots = [] // [{ hostId, path }]

  // The saved layout's remote projects (remoteFs.remoteRootsOfLayout: virtual roots).
  function setRoots(list) {
    const next = []
    for (const v of Array.isArray(list) ? list.slice(0, 500) : []) {
      const p = parseRemotePath(v)
      if (p && !next.some((r) => r.hostId === p.hostId && r.path === p.path)) next.push(p)
    }
    roots = next
  }

  // The folder (normalized, "~" kept) when it is exactly a saved project of
  // that host, else null. home: the host's $HOME, when known.
  function eligibleFolder(hostId, path, home = null) {
    if (typeof hostId !== 'string' || !HOST_ID.test(hostId) || typeof path !== 'string') return null
    const p = parseRemotePath(remoteRoot(hostId, path))
    if (!p) return null
    for (const r of roots) {
      if (r.hostId !== hostId) continue
      if (r.path === p.path) return p.path
      if (home && expand(r.path, home) === expand(p.path, home)) return p.path
    }
    return null
  }

  // The config argument of __t_trust: acct:<id> (a folder Tessel made, the
  // pane's account), the login shell's folder, or - (the agent's own).
  // null: not a valid account; undefined: the login shell's folder is not
  // known yet on this connection.
  function configArg(hostId, hostAccount) {
    if (hostAccount !== null && hostAccount !== undefined) return typeof hostAccount === 'string' && ID.test(hostAccount) ? `acct:${hostAccount}` : null
    let dir
    try {
      dir = loginDir(hostId, 'claude')
    } catch {
      dir = undefined
    }
    if (dir === undefined) return undefined
    return typeof dir === 'string' && POSIX_DIR.test(dir) ? dir : '-'
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const safely = (fn) => {
    try {
      return !!fn()
    } catch {
      return false
    }
  }
  // Signed in now, or soon when a pane of the host is connecting (the one
  // being started); a host nobody is connecting to is not waited for.
  async function signedIn(hostId, until) {
    for (;;) {
      if (safely(() => connected(hostId))) return true
      if (!safely(() => connecting(hostId)) || now() + pollMs > until) return false
      await sleep(pollMs)
    }
  }

  // ({ agentId, hostId, remotePath, hostAccount, enabled }) -> 'granted' |
  // 'unchanged' | 'off' | 'no-preset' | 'not-eligible' | 'not-connected' |
  // 'not-known' | 'invalid' | 'refused' | 'unparseable' | 'locked' | 'late' |
  // 'no-tool' | 'failed' | 'timeout'
  async function apply({ agentId, hostId, remotePath, hostAccount = null, enabled = false } = {}) {
    if (!REMOTE_TRUST_AGENTS.includes(agentId)) return 'no-preset'
    if (enabled !== true) return 'off'
    let timer
    const started = now()
    const until = started + deadlineMs
    const where = typeof hostId === 'string' && HOST_ID.test(hostId) ? hostId : '?'
    const job = (async () => {
      if (typeof hostId !== 'string' || !HOST_ID.test(hostId) || !isSavedHost(hostId)) return 'not-eligible'
      let folder = eligibleFolder(hostId, remotePath)
      if (!folder && roots.some((r) => r.hostId === hostId) && safely(() => connected(hostId))) {
        // A project saved as ~/app and a pane given /home/me/app (or the
        // reverse): compared with the host's home, when it answers.
        const h = await Promise.resolve(homeOf(hostId)).catch(() => null)
        folder = h && h.ok ? eligibleFolder(hostId, remotePath, h.home) : null
      }
      if (!folder) return 'not-eligible'
      const config = configArg(hostId, hostAccount)
      if (config === null) return 'invalid'
      if (config === undefined) {
        // Read for the next start (once per connection, as Tessel does anyway).
        try {
          void Promise.resolve(learnLoginDir(hostId)).catch(() => null)
        } catch {
          /* the next start asks again */
        }
        return 'not-known'
      }
      if (!(await signedIn(hostId, started + Math.min(connectWaitMs, deadlineMs)))) return 'not-connected'
      const left = until - now()
      if (left < 1000) return 'timeout'
      // The host writes nothing past this (its own clock), and its watchdog
      // ends the work within what is left.
      const deadline = String(Math.floor(until / 1000))
      const res = await run(hostId, '__t_trust', [config, folder, deadline], { cap: 4096, timeoutMs: left })
      if (res && res.notConnected) return 'not-connected'
      return parseTrustAnswer(res)
    })()
    try {
      const outcome = await Promise.race([job, new Promise((r) => (timer = setTimeout(() => r('timeout'), deadlineMs)))])
      if (!['off', 'no-preset', 'not-eligible'].includes(outcome)) log?.info?.('agents', `claude folder trust on ${where}: ${outcome}`) // i18n-ignore log
      return outcome
    } catch {
      log?.warn?.('agents', `claude folder trust on ${where}: failed`) // i18n-ignore log
      return 'failed'
    } finally {
      clearTimeout(timer)
      job.catch(() => {})
    }
  }

  return { setRoots, eligibleFolder, apply }
}
