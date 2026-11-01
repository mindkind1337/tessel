// The SSH counterpart of agentFolderTrust.js: before Tessel types Claude
// Code's start line in a pane on an SSH host, the host's own Claude config
// gets projects["<folder>"].hasTrustDialogAccepted = true, so Claude Code does
// not stop at "Do you trust the files in this folder?" in a project the user
// added in Tessel. The write itself is the host's (__t_trust in
// remoteAccounts.sh: minimal, atomic, a file it cannot parse left alone).
//
// The same consent rules as on this computer:
//   - only when Settings > Agents "Trust the folder when Tessel starts an
//     agent" is on;
//   - only a folder the user chose in Tessel: a remote project of the saved
//     layout on that same host (its folder or one below it), checked here in
//     main against the layout main stores, never a path the window names
//     alone; the host refuses /, the home folder and any folder above it;
//   - only Claude Code (its trust is one JSON file; Codex's is TOML, not done
//     here: Codex asks as before);
//   - only a saved SSH host (never WSL), on a connection already signed in
//     (remoteFs.accountCall without `user`: never a sign-in, never a prompt).
// Never throws, never waits more than deadlineMs: anything else means only
// that the agent asks, as it did before.
import { parseRemotePath, remoteRoot, relativeTo } from '../../shared/remotePath.js'
import { ID } from './remoteAccounts.js'

export const REMOTE_TRUST_DEADLINE_MS = 4000
// How long a launch waits for its host's connection to be signed in (a pane
// that has just connected) before it gives up for this start.
export const CONNECT_WAIT_MS = 2000
export const REMOTE_TRUST_AGENTS = ['claude']
export const TRUST_WORDS = ['granted', 'unchanged', 'refused', 'unparseable', 'locked', 'no-tool', 'failed']
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
// homeOf(hostId) -> its $HOME when known ({ ok, home }), never a sign-in;
// loginDir(hostId, 'claude') -> the login shell's CLAUDE_CONFIG_DIR there
// (a folder, null, or undefined when not known).
export function createRemoteAgentFolderTrust({
  run,
  connected = () => false,
  homeOf = async () => null,
  loginDir = () => undefined,
  isSavedHost = () => false,
  deadlineMs = REMOTE_TRUST_DEADLINE_MS,
  connectWaitMs = CONNECT_WAIT_MS,
  pollMs = 200,
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

  // The folder (normalized, "~" kept) when it is a saved project of that
  // host or below one, else null. home: the host's $HOME, when known.
  function eligibleFolder(hostId, path, home = null) {
    if (typeof hostId !== 'string' || !HOST_ID.test(hostId) || typeof path !== 'string') return null
    const p = parseRemotePath(remoteRoot(hostId, path))
    if (!p) return null
    for (const r of roots) {
      if (r.hostId !== hostId) continue
      if (relativeTo(r.path, p.path) !== null) return p.path
      if (home && relativeTo(expand(r.path, home), expand(p.path, home)) !== null) return p.path
    }
    return null
  }

  // The config argument of __t_trust: acct:<id> (a folder Tessel made, the
  // pane's account), the login shell's folder, or - (the agent's own).
  function configArg(hostId, hostAccount) {
    if (hostAccount !== null && hostAccount !== undefined) return typeof hostAccount === 'string' && ID.test(hostAccount) ? `acct:${hostAccount}` : null
    let dir
    try {
      dir = loginDir(hostId, 'claude')
    } catch {
      dir = undefined
    }
    return typeof dir === 'string' && POSIX_DIR.test(dir) ? dir : '-'
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  async function signedIn(hostId, until) {
    for (;;) {
      try {
        if (connected(hostId)) return true
      } catch {
        return false
      }
      if (Date.now() + pollMs > until) return false
      await sleep(pollMs)
    }
  }

  // ({ agentId, hostId, remotePath, hostAccount, enabled }) -> 'granted' |
  // 'unchanged' | 'off' | 'no-preset' | 'not-eligible' | 'not-connected' |
  // 'invalid' | 'refused' | 'unparseable' | 'locked' | 'no-tool' | 'failed' | 'timeout'
  async function apply({ agentId, hostId, remotePath, hostAccount = null, enabled = false } = {}) {
    if (!REMOTE_TRUST_AGENTS.includes(agentId)) return 'no-preset'
    if (enabled !== true) return 'off'
    let timer
    const started = Date.now()
    const where = typeof hostId === 'string' && HOST_ID.test(hostId) ? hostId : '?'
    const job = (async () => {
      if (typeof hostId !== 'string' || !HOST_ID.test(hostId) || !isSavedHost(hostId)) return 'not-eligible'
      let folder = eligibleFolder(hostId, remotePath)
      if (!folder && roots.some((r) => r.hostId === hostId) && connected(hostId)) {
        // A project saved as ~/app and a pane given /home/me/app (or the
        // reverse): compared with the host's home, when it answers.
        const h = await Promise.resolve(homeOf(hostId)).catch(() => null)
        folder = h && h.ok ? eligibleFolder(hostId, remotePath, h.home) : null
      }
      if (!folder) return 'not-eligible'
      const config = configArg(hostId, hostAccount)
      if (!config) return 'invalid'
      if (!(await signedIn(hostId, started + connectWaitMs))) return 'not-connected'
      const res = await run(hostId, '__t_trust', [config, folder], { cap: 4096, timeoutMs: 10_000 })
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
