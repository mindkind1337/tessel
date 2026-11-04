// The SSH side of the terminal host (ptyHost.js). The ssh2 connections live
// here, in the background process that already keeps the terminals alive
// across app restarts, so a remote terminal survives an app restart exactly
// like a local one, and the app's Files / Changes session uses the SAME
// connection (one per host, sshManager.js).
//
// Messages (newline-delimited JSON on the host's pipe, token-authenticated
// like every other op; see ptyHost.js):
//   app -> host
//     create { ..., ssh: { hostId, spec, remotePath?, texts, persistent? } }   a remote terminal
//                                     (persistent: inside a tmux session, see createPty)
//     ssh-exec { ch, hostId, spec, onlyLive? }   the Files session: `exec /bin/sh`
//                                     (the only command an exec channel may run);
//                                     onlyLive: on a live connection only, never a
//                                     new connection or sign-in (a Files lane)
//     ssh-write { ch, data(base64) } / ssh-eof { ch } / ssh-close { ch }
//     ssh-connect { cid, hostId, spec }   sign in (connection test)
//     ssh-disconnect { hostId }        close it, forget its credentials
//     ssh-answer { promptId, value }   the user's answer (the ONLY message
//                                      that carries a secret; never logged)
//     ssh-sync (request)               states + open questions
//   host -> app
//     ssh-open / ssh-out { ch, data(base64), err? } / ssh-exit { ch, code, signal, fail?, params? }
//                                      to the app connection that opened the channel only
//     ssh-connected { cid, ok, fail?, params? }
//     ssh-prompt { promptId, hostId, kind, detail, retry, echo, hostKey }
//     ssh-prompt-done { promptId }     (broadcast: whichever app window answers)
//     ssh-state { hostId, status, code?, params? }
//
// What this process enforces itself (whatever the app sends):
// - an exec channel only ever runs `exec /bin/sh`, a terminal a login shell
//   or `cd -- '<path>' && exec "$SHELL" -l` built here (remoteProject.js), or
//   that command inside a tmux session named after the pane (tmuxCommand);
// - the spec is checked field by field (no control characters, bounded);
// - output to the app is paused while the pipe holds more than OUT_HIGH_WATER;
// - a question waits CREDENTIAL_TIMEOUT_MS at most; answers are bounded.
import crypto from 'crypto'
import { StringDecoder } from 'string_decoder'
import { createSshManager } from './sshManager'
import { createHostKeyStore } from './hostKeyStore'
import { formatSshError, formatSshText } from './sshMessages'
import { remoteCdCommand, validateRemotePath, shellQuote } from '../remoteProject'
import { createRemoteAgentTunnel, validateRemoteAgent, sourcePrefix } from '../remoteAgent/remoteAgentTunnel'

export const SSH_FEATURE = 1
// Agents on an SSH host (remoteAgent/remoteAgentTunnel.js): main checks it, since
// a terminal host started by an older Tessel keeps running without it.
export const REMOTE_AGENT_FEATURE = 1
// ssh-exec onlyLive (remoteFs.js lanes): an exec channel only on a live
// connection, never a new connection or a question; it yields its slot to
// a terminal. Main opens lanes only on a host that says it.
export const ONLY_LIVE_FEATURE = 1
export const CREDENTIAL_TIMEOUT_MS = 120_000
export const FILES_COMMAND = 'exec /bin/sh'
export const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 5000, 10000, 10000, 10000, 30000, 30000]
const OUT_HIGH_WATER = 8 * 1024 * 1024
const MAX_SECRET = 4096
const MAX_QUEUED_INPUT = 64 * 1024
const CONTROL = /[\u0000-\u001f\u007f]/
const ID_RE = /^[A-Za-z0-9_.:-]{1,80}$/
// A remote-agent pane waits this long for its socket before its shell opens
// (then it opens anyway: the agent's team tools say the socket is missing).
export const AGENT_BIND_WAIT_MS = 10_000
// Persistent sessions (a host with "Keep sessions alive on the server"): the
// pane's shell runs inside a tmux session on the host, on a tmux server of
// Tessel's own (socket name TMUX_SOCKET, so its options never touch the
// user's own tmux), and a reconnect re-attaches to it instead of starting a
// new shell. The probe for tmux waits this long at most.
export const TMUX_SOCKET = 'tessel'
// Tessel's own tmux on a host that has none (main puts it there before the
// pane opens: ssh/remoteTmux.js), as the pane's commands name it: a fixed
// path under $HOME, quoted once here and never built from the host's answer.
export const OWN_TMUX = '"$HOME/.tessel-server/bin/tmux"'
const OWN_TMUX_SUFFIX = '/.tessel-server/bin/tmux'
// Exit 0 with the version ("tmux 3.4") then the path of the tmux to use on
// stdout: the host's own tmux when it has one (it always wins), else Tessel's
// copy. Exit 1 when neither is there. Run by sh: the exec channel goes
// through the user's login shell, and fish or tcsh would not take the
// assignments and tests (no quote inside the single-quoted body).
export const TMUX_PROBE = `sh -c 't=$(command -v tmux 2>/dev/null) && [ -x "$t" ] || t="$HOME${OWN_TMUX_SUFFIX}"; [ -x "$t" ] && v=$("$t" -V) && printf "%s\\n%s\\n" "$v" "$t"'`
export const TMUX_PROBE_TIMEOUT_MS = 15_000
const TMUX_SESSION_MAX = 40

// The tmux session name of a pane: only [A-Za-z0-9_-], so it is never read as
// an option or a target pattern. -> 'tessel-<pane>'
export function tmuxSessionName(paneId) {
  return `tessel-${String(paneId).replace(/[^A-Za-z0-9_-]/g, '')}`.slice(0, TMUX_SESSION_MAX)
}

// "tmux 3.4" / "tmux 3.3a" / "tmux next-3.5" -> { major, minor } | null.
export function parseTmuxVersion(stdout) {
  const m = /(\d+)\.(\d+)/.exec(String(stdout || ''))
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null
}
const atLeast = (v, major, minor) => !!v && (v.major > major || (v.major === major && v.minor >= minor))

// What TMUX_PROBE printed -> { version, bin }: bin is `tmux` (the host's own,
// on its PATH) or OWN_TMUX (the probe named Tessel's copy); nothing else is
// ever put in a command.
export function parseTmuxProbe(stdout) {
  const lines = String(stdout || '').split('\n')
  const path = (lines[1] || '').trim()
  return { version: parseTmuxVersion(lines[0]), bin: path.endsWith(OWN_TMUX_SUFFIX) ? OWN_TMUX : 'tmux' }
}
const tmuxBin = (bin) => (bin === OWN_TMUX ? OWN_TMUX : 'tmux')

// The command that runs `inner` (a POSIX sh command) inside the pane's tmux
// session. A first open starts a FRESH session (a session of that name left
// by a crash or an earlier pane is ended first: an agent in there would run
// with a stale pane token), a reconnect attaches to the one that is there
// (-A; the inner command is then ignored by tmux) and detaches the client the
// lost connection left (-D, or the window stays clipped to its size).
// The options are globals of Tessel's own tmux server (-L), set before the
// first window exists (history-limit applies to windows created after it):
// no status bar, so the pane looks as it does today; screen-256color is on
// every host and matches the pane's xterm-256color; true colour, a short
// escape delay and focus events for the agents' TUIs; the mouse, so the
// wheel scrolls the session's history (tmux keeps it, the pane's own
// scrollback stays empty) while the arrow keys stay the shell's history, and
// a selection made in tmux reaches the clipboard (set-clipboard, OSC 52).
// A program on the alternate screen that did not take the mouse gets
// PageUp/PageDown per notch, not tmux's arrow keys: in Claude Code's
// full-screen view the arrows walk the sent prompts and PgUp/PgDn scroll the
// transcript (it says so itself: "Scroll wheel is sending arrow keys, use
// PgUp/PgDn"); less and vim page as well. A program that took the mouse
// (htop, vim with mouse on) gets the wheel itself (-M), and copy mode keeps
// its own wheel (its key table, not this root one);
// and, when tmux takes it (3.2+), no prefix key: a detach would end the pane
// and its session.
// Nothing here is interpolated unquoted: the name is sanitized, the inner
// command single-quoted, bin one of two fixed strings (tmuxBin).
export function tmuxCommand(paneId, inner, { reattach = false, version = null, bin = 'tmux' } = {}) {
  const name = tmuxSessionName(paneId)
  const options = [
    'set-option -g status off',
    'set-option -g history-limit 50000',
    'set-option -g default-terminal screen-256color',
    'set-option -g escape-time 10',
    'set-option -g focus-events on',
    'set-option -g mouse on',
    'set-option -g set-clipboard on',
    `bind-key -n WheelUpPane if-shell -Ft= "#{mouse_any_flag}" "send-keys -M" "if-shell -Ft= '#{alternate_on}' 'send-keys PPage' 'copy-mode -e; send-keys -M'"`,
    `bind-key -n WheelDownPane if-shell -Ft= "#{mouse_any_flag}" "send-keys -M" "if-shell -Ft= '#{alternate_on}' 'send-keys NPage' 'send-keys -M'"`,
    `set-option -ga terminal-overrides ',xterm-256color:RGB:Ms=\\E]52;%p1%s;%p2%s\\007'`,
    ...(atLeast(version, 3, 2) ? ['set-option -g prefix None'] : [])
  ]
  const tmux = `exec ${tmuxBin(bin)} -u -L ${TMUX_SOCKET} ${options.join(' \\; ')} \\; new-session ${reattach ? '-A -D ' : ''}-s ${name} ${shellQuote(inner)}`
  return reattach ? tmux : `${tmuxKillCommand(paneId, bin)}; ${tmux}`
}

// Ends the pane's session on the host (the pane was closed, or its client
// left and the session is of no use to anyone). =name: that session exactly.
export function tmuxKillCommand(paneId, bin = 'tmux') {
  return `${tmuxBin(bin)} -L ${TMUX_SOCKET} kill-session -t =${tmuxSessionName(paneId)} >/dev/null 2>&1`
}

function cleanStr(v, max) {
  return typeof v === 'string' && v.length > 0 && v.length <= max && !CONTROL.test(v) ? v : null
}
function cleanList(v, maxItems, maxLen) {
  if (!Array.isArray(v)) return []
  return v.map((x) => cleanStr(x, maxLen)).filter(Boolean).slice(0, maxItems)
}

// The connection spec from the app, checked. -> spec | null
export function validateSpec(raw) {
  if (!raw || typeof raw !== 'object') return null
  const host = cleanStr(raw.host, 253)
  if (!host || host.startsWith('-')) return null
  const port = Number(raw.port || 22)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  const username = raw.username === '' || raw.username == null ? '' : cleanStr(raw.username, 64)
  if (username === null) return null
  return {
    host,
    port,
    username,
    identityFiles: cleanList(raw.identityFiles, 32, 1024),
    identitiesOnly: raw.identitiesOnly === true,
    identityAgent: raw.identityAgent == null ? null : cleanStr(raw.identityAgent, 1024),
    strictHostKeyChecking: cleanStr(raw.strictHostKeyChecking, 32) || 'ask',
    knownHostsFiles: cleanList(raw.knownHostsFiles, 16, 1024),
    hostKeyAlias: cleanStr(raw.hostKeyAlias, 253) || null,
    // From ssh -G: PasswordAuthentication / KbdInteractiveAuthentication /
    // PubkeyAuthentication no, and the algorithm lists.
    passwordAuthentication: raw.passwordAuthentication !== false,
    kbdInteractiveAuthentication: raw.kbdInteractiveAuthentication !== false,
    pubkeyAuthentication: raw.pubkeyAuthentication !== false,
    algorithms: cleanAlgorithms(raw.algorithms)
  }
}

function cleanAlgorithms(raw) {
  if (!raw || typeof raw !== 'object') return null
  const out = {}
  for (const k of ['kex', 'serverHostKey', 'cipher', 'hmac']) {
    const list = cleanList(raw[k], 64, 128).filter((a) => /^[A-Za-z0-9@._+-]+$/.test(a))
    if (list.length) out[k] = list
  }
  return Object.keys(out).length ? out : null
}

function cleanTexts(raw) {
  const out = { codes: {} }
  const s = (v) => (typeof v === 'string' ? v.slice(0, 2000) : '')
  if (raw && typeof raw === 'object') {
    out.lost = s(raw.lost)
    out.reconnected = s(raw.reconnected)
    out.reconnectedSame = s(raw.reconnectedSame)
    out.noTmux = s(raw.noTmux)
    out.gaveUp = s(raw.gaveUp)
    out.notConnected = s(raw.notConnected)
    out.label = s(raw.label).slice(0, 120)
    if (raw.codes && typeof raw.codes === 'object') for (const [k, v] of Object.entries(raw.codes).slice(0, 64)) out.codes[k] = s(v)
  }
  return out
}

const STABLE_MS = 60_000

// The exit status a channel reported (kept by sshManager.js even when it
// came before the listeners): { code, signal } | null.
function exitOf(stream) {
  const a = stream && stream.tesselExit
  if (!a) return null
  const [code, signal] = a
  return { code: typeof code === 'number' ? code : signal ? 128 : 0, signal: signal || null }
}

const red = (text) => `\r\n\x1b[31m${String(text).replace(/\r?\n/g, '\r\n')}\x1b[0m\r\n`
const dim = (text) => `\r\n\x1b[2m${String(text).replace(/\r?\n/g, '\r\n')}\x1b[0m\r\n`

export function createSshHostBridge({
  hostKeyFile,
  broadcast = () => {},
  log = () => {},
  timers = { setTimeout, clearTimeout },
  managerOptions = {},
  reconnectDelays = RECONNECT_DELAYS_MS,
  credentialTimeoutMs = CREDENTIAL_TIMEOUT_MS,
  tunnelOptions = {},
  agentBindWaitMs = AGENT_BIND_WAIT_MS
} = {}) {
  const prompts = new Map() // promptId -> { hostId, resolve, timer, public }
  const chans = new Map() // ch -> { sock, stream, release, closed, pending }
  const shells = new Set() // remote terminals (createPty)
  const hostKeys = hostKeyFile ? createHostKeyStore({ file: hostKeyFile, log }) : null

  function ask(hostId, prompt) {
    return new Promise((resolve) => {
      const promptId = crypto.randomBytes(16).toString('hex')
      const pub = {
        promptId,
        hostId,
        kind: prompt.kind,
        detail: typeof prompt.detail === 'string' ? prompt.detail.slice(0, 4096) : '',
        retry: !!prompt.retry,
        echo: !!prompt.echo,
        user: prompt.user || '',
        host: prompt.host || '',
        port: prompt.port || 22,
        hostKey: prompt.hostKey || null
      }
      const timer = timers.setTimeout(() => settle(promptId, null), credentialTimeoutMs)
      prompts.set(promptId, { hostId, resolve, timer, public: pub })
      broadcast({ op: 'ssh-prompt', ...pub })
    })
  }

  function settle(promptId, value) {
    const p = prompts.get(promptId)
    if (!p) return false
    prompts.delete(promptId)
    timers.clearTimeout(p.timer)
    broadcast({ op: 'ssh-prompt-done', promptId })
    p.resolve(value)
    return true
  }

  function cancelPrompts(hostId) {
    for (const [id, p] of [...prompts]) if (p.hostId === hostId) settle(id, null)
  }

  const manager = createSshManager({
    ask,
    hostKeys,
    log,
    timers,
    // A host's kept credentials outlive its connections only while a
    // terminal there may reconnect.
    hasShells: (hostId) => [...shells].some((sh) => sh.hostId === hostId),
    onState: (hostId, state) => broadcast({ op: 'ssh-state', hostId, ...state }),
    ...managerOptions
  })

  // Agents on the host: their team tools come back through a forwarded
  // socket (remoteAgent/remoteAgentTunnel.js).
  const tunnel = createRemoteAgentTunnel({
    openExec: (hostId, spec, command) => manager.open(hostId, spec, 'exec', { command }),
    log,
    timers,
    ...tunnelOptions
  })

  function sendTo(sock, msg) {
    if (!sock || sock.destroyed) return false
    try {
      sock.write(JSON.stringify(msg) + '\n')
    } catch {
      return false
    }
    return true
  }

  // Output paused while the app's pipe is backed up, resumed on drain.
  function flowControl(sock, stream) {
    if (sock.writableLength > OUT_HIGH_WATER) {
      stream.pause()
      if (!sock.__tesselDrainArmed) {
        sock.__tesselDrainArmed = true
        sock.once('drain', () => {
          sock.__tesselDrainArmed = false
          for (const c of chans.values()) if (c.sock === sock && c.stream) c.stream.resume()
        })
      }
    }
  }

  function openExec(sock, msg) {
    const ch = typeof msg.ch === 'string' && ID_RE.test(msg.ch) ? msg.ch : null
    const hostId = cleanStr(msg.hostId, 80)
    const spec = validateSpec(msg.spec)
    if (!ch || !hostId || !spec || chans.has(ch)) return { ok: false, error: 'invalid' }
    const c = { sock, stream: null, release: null, closed: false }
    chans.set(ch, c)
    manager
      .open(hostId, spec, 'exec', { command: FILES_COMMAND, onlyLive: msg.onlyLive === true })
      .then(({ stream, release }) => {
        if (c.closed || sock.destroyed) {
          try {
            stream.close()
          } catch {
            /* gone */
          }
          release()
          chans.delete(ch)
          return
        }
        c.stream = stream
        c.release = release
        sendTo(sock, { op: 'ssh-open', ch })
        stream.on('data', (d) => {
          sendTo(sock, { op: 'ssh-out', ch, data: d.toString('base64') })
          flowControl(sock, stream)
        })
        stream.stderr.on('data', (d) => sendTo(sock, { op: 'ssh-out', ch, err: true, data: d.toString('base64') }))
        stream.on('error', () => {})
        const onClose = () => {
          release()
          if (chans.get(ch) === c) chans.delete(ch)
          c.closed = true
          const exit = exitOf(stream)
          sendTo(sock, { op: 'ssh-exit', ch, code: exit ? exit.code : null, signal: exit ? exit.signal : null, ...(exit ? {} : { fail: 'lost' }) })
        }
        // Closed already: after the output still buffered in the stream.
        if (stream.tesselClosed) timers.setTimeout(onClose, 0)
        else stream.once('close', () => timers.setTimeout(onClose, 0))
      })
      .catch((err) => {
        if (chans.get(ch) === c) chans.delete(ch)
        c.closed = true
        sendTo(sock, { op: 'ssh-exit', ch, code: 255, signal: null, fail: (err && err.code) || 'failed', params: (err && err.params) || {} })
      })
    return { ok: true }
  }

  function closeChan(ch, how) {
    const c = chans.get(ch)
    if (!c) return
    if (!c.stream) {
      c.closed = true
      return
    }
    try {
      if (how === 'eof') c.stream.end()
      else c.stream.close()
    } catch {
      /* gone */
    }
  }

  // --- Remote terminals ---------------------------------------------------------
  // A node-pty-like object (pid, write, resize, kill, onData, onExit) on a
  // shell channel, so ptyHost.js keeps its screen, re-attach and dump as for
  // a local terminal. A lost connection reconnects (RECONNECT_DELAYS_MS) and
  // starts a new shell in the same pane; a refused key, a failed or
  // cancelled sign-in ends the pane with the reason in it.
  //
  // remoteAgent (from main, with paneId): an agent's pane. Its shell gets
  // TESSEL_PANE_ID / TESSEL_REMOTE_SOCK / TESSEL_REMOTE_TOKEN /
  // TESSEL_AGENT_PROVIDER, and the pane and its token are known to the
  // tunnel until the pane exits. (The token is never logged.)
  //
  // persistent (the host's "Keep sessions alive on the server"): the shell
  // runs inside a tmux session named after the pane (tmuxCommand). A lost
  // connection re-attaches to it, so what ran there (an agent) survives; a
  // host without tmux gets the plain command, and the pane says so once.
  function createPty({ hostId, spec: rawSpec, remotePath, texts: rawTexts, cols, rows, paneId, remoteAgent: rawAgent, persistent: rawPersistent }) {
    const spec = validateSpec(rawSpec)
    const texts = cleanTexts(rawTexts)
    const label = texts.label || (spec && spec.host) || ''
    let cdCommand = null
    if (remotePath != null && remotePath !== '') {
      const checked = validateRemotePath(remotePath)
      if (checked.error) throw new Error('invalid remote path') // i18n-ignore internal
      cdCommand = remoteCdCommand(checked.path)
    }
    if (!spec || !cleanStr(hostId, 80)) throw new Error('invalid ssh spec') // i18n-ignore internal
    const agent = rawAgent == null ? null : validateRemoteAgent(rawAgent)
    if (rawAgent != null && (!agent || typeof paneId !== 'string' || !ID_RE.test(paneId))) throw new Error('invalid remote agent') // i18n-ignore internal
    const persistent = rawPersistent === true
    if (persistent && (typeof paneId !== 'string' || !ID_RE.test(paneId))) throw new Error('invalid persistent pane') // i18n-ignore internal
    // The command of each (re)opened shell: the pane's variables come from
    // the env file the tunnel writes just before (writeEnv).
    const plainCommandFor = () =>
      agent
        ? sourcePrefix(paneId) +
          (cdCommand || 'exec "$SHELL" -l')
        : cdCommand
    // tmux: the same command runs inside the session (the env file is sourced
    // in there, where the agent starts); a plain pane gets a login shell.
    // On a re-attach the inner command does not run, so the env file written
    // for that open stays until the pane ends for good (tunnel.forgetPane
    // removes it then); the agent in the session keeps the variables of its
    // first open, which stay valid for the pane.
    const commandFor = (tmux, reattach) => (tmux ? tmuxCommand(paneId, plainCommandFor() || 'exec "$SHELL" -l', { reattach, version: tmux.version, bin: tmux.bin }) : plainCommandFor())
    const dataFns = []
    const exitFns = []
    const size = { cols: Math.max(2, cols | 0), rows: Math.max(1, rows | 0) }
    let stream = null
    let release = null
    let decoder = null
    let killed = false
    let exited = false
    let reconnectTimer = null
    let attempt = 0
    let openedAt = 0
    let notConnectedShown = false
    let noTmuxShown = false
    // The shell open now (or the last one) runs inside the pane's tmux session,
    // and which tmux it is (the host's, or Tessel's copy: OWN_TMUX).
    let inTmux = false
    let inTmuxBin = 'tmux'
    let queued = []
    let queuedBytes = 0
    const self = { pid: null, hostId, noReconnect: false }

    // One command on an exec channel of the host's connection -> Promise<{
    // code, stdout }> (code null: no status, or nothing within timeoutMs;
    // stdout bounded). Rejects as manager.open does (not connected, refused...).
    function runExec(command, timeoutMs, opts = {}) {
      return manager.open(hostId, spec, 'exec', { command, ...opts }).then(
        ({ stream: s, release: rel }) =>
          new Promise((resolve) => {
            let done = false
            let out = ''
            const settle = (code) => {
              if (done) return
              done = true
              timers.clearTimeout(timer)
              rel()
              resolve({ code, stdout: out })
            }
            const timer = timers.setTimeout(() => {
              try {
                s.close()
              } catch {
                /* gone */
              }
              settle(null)
            }, timeoutMs)
            s.on('data', (d) => {
              if (out.length < 256) out += d.toString('utf8')
            })
            if (s.stderr) s.stderr.on('data', () => {})
            s.on('error', () => {})
            const onClose = () => {
              const exit = exitOf(s)
              settle(exit ? exit.code : null)
            }
            if (s.tesselClosed) timers.setTimeout(onClose, 0)
            else s.once('close', () => timers.setTimeout(onClose, 0))
          })
      )
    }
    // Is tmux on the host (its own, or Tessel's copy), and which version?
    // Asked before each (re)open of a persistent pane, so a tmux installed
    // since is used. -> { version, bin } | false. A probe that hangs, or cannot be run on a first open, counts as
    // no tmux: the pane opens as it does today rather than not at all. On a
    // reconnect a probe that cannot run is the connection's problem: it goes
    // through the reconnect ladder like the shell itself.
    const hasTmux = (isReconnect) =>
      runExec(TMUX_PROBE, TMUX_PROBE_TIMEOUT_MS).then(
        ({ code, stdout }) => (code === 0 ? parseTmuxProbe(stdout) : false),
        (err) => {
          if (isReconnect) throw err
          return false
        }
      )
    // Best effort, on a live connection only (closing a pane never asks for
    // a password), and nothing waits for it.
    function killSession() {
      runExec(tmuxKillCommand(paneId, inTmuxBin), TMUX_PROBE_TIMEOUT_MS, { onlyLive: true }).catch(() => {})
    }

    const emit = (text) => {
      if (!text) return
      for (const fn of dataFns) fn(text)
    }
    function finish(exitCode, signal = 0) {
      if (exited) return
      exited = true
      shells.delete(self)
      if (agent) tunnel.forgetPane(paneId, agent)
      // The host's last terminal: credentials kept only for it may go.
      manager.forgetIfUnused(hostId)
      if (reconnectTimer) timers.clearTimeout(reconnectTimer)
      reconnectTimer = null
      for (const fn of exitFns) fn({ exitCode, signal })
    }
    const pty = { term: 'xterm-256color', cols: size.cols, rows: size.rows, width: 0, height: 0 }

    // An agent's pane: signed in first (a failure ends the pane as for any
    // terminal), then the socket bound and the env file written (or not,
    // after agentBindWaitMs).
    function agentReady() {
      if (!agent) return Promise.resolve()
      return manager.connectHost(hostId, spec).then(
        () =>
          new Promise((resolve) => {
            const t = timers.setTimeout(resolve, agentBindWaitMs)
            tunnel
              .ensure(hostId, spec)
              .then(() => tunnel.writeEnv(hostId, spec, paneId))
              .then(() => {
                timers.clearTimeout(t)
                resolve()
              })
          })
      )
    }

    function open(isReconnect) {
      agentReady()
        .then(() => (persistent && !killed && !exited ? hasTmux(isReconnect) : false))
        .then((tmux) => {
          if (killed || exited) return { stream: null }
          // Re-attach only to a session this pane opened (a reconnect after a
          // shell that ran in tmux); any other open starts fresh.
          const command = commandFor(tmux, isReconnect && inTmux)
          const asked = { ...pty, cols: size.cols, rows: size.rows }
          const opts = command ? { command, pty: asked } : { pty: asked }
          return manager.open(hostId, spec, command ? 'exec' : 'shell', opts).then((res) => ({ ...res, asked, useTmux: !!tmux, tmuxBin: tmux ? tmux.bin : 'tmux' }))
        })
        .then((res) => {
          if (!res.stream) return
          if (killed || exited) {
            try {
              res.stream.close()
            } catch {
              /* gone */
            }
            res.release()
            return
          }
          const s = res.stream
          stream = s
          release = res.release
          decoder = new StringDecoder('utf8')
          openedAt = Date.now()
          notConnectedShown = false
          const wasTmux = inTmux
          inTmux = res.useTmux === true
          if (inTmux) inTmuxBin = res.tmuxBin
          if (isReconnect) {
            // Back in the same tmux session (its program still running), or a
            // new shell as before. (tmux redraws the screen as it re-attaches.)
            const text = wasTmux && inTmux ? texts.reconnectedSame : texts.reconnected
            if (text) emit(dim(formatSshText(text, { host: label })))
          }
          if (persistent && !inTmux && !noTmuxShown && texts.noTmux) {
            noTmuxShown = true
            emit(dim(formatSshText(texts.noTmux, { host: label })))
          }
          s.on('data', (d) => emit(decoder.write(d)))
          s.stderr.on('data', (d) => emit(decoder.write(d)))
          s.on('error', () => {})
          const onClose = () => {
            if (release) release()
            if (stream === s) stream = null
            if (killed) return finish(0)
            const exit = exitOf(s)
            if (exit) {
              // The tmux client left with a status: its session ended, or the
              // user detached. Either way nothing shows it any more.
              if (inTmux) killSession()
              return finish(exit.code, 0)
            }
            // No exit status: the connection went away under the shell (a
            // reconnect), or the host closed the channel (the end).
            timers.setTimeout(() => {
              if (killed || exited) return
              if (res.connectionAlive && res.connectionAlive()) finish(0)
              else lost()
            }, 100)
          }
          // After the output still buffered in the stream.
          if (s.tesselClosed) timers.setTimeout(onClose, 0)
          else s.once('close', () => timers.setTimeout(onClose, 0))
          // Resized while the channel was opening (the pane is created at
          // 80x24 and fitted once on screen, often during the sign-in or the
          // channel's own round trips): that size was asked for too late for
          // the PTY request, and resize() had no channel to send it to. The
          // host's terminal takes the pane's size now, before anything typed
          // meanwhile (an agent's command) reaches it; a TUI started there
          // reads it, and drew for 80x24 in a shorter, wider pane otherwise.
          if (res.asked && (res.asked.cols !== size.cols || res.asked.rows !== size.rows)) {
            try {
              s.setWindow(size.rows, size.cols, 0, 0)
            } catch {
              /* resize race */
            }
          }
          for (const q of queued) s.write(q)
          queued = []
          queuedBytes = 0
        })
        .catch((err) => {
          if (killed || exited) return
          const code = (err && err.code) || 'failed'
          if (isReconnect && !self.noReconnect && (code === 'network' || code === 'timeout' || code === 'closed' || code === 'lost' || (err && err.transient))) return scheduleReconnect()
          emit(red(formatSshError(texts, code, (err && err.params) || {}, label)))
          finish(255)
        })
    }

    function lost() {
      if (killed || exited) return
      if (self.noReconnect) return finish(255)
      // A shell that stayed up a while starts the ladder again; one that
      // keeps dropping right after it reconnects does not loop forever.
      if (Date.now() - openedAt >= STABLE_MS) attempt = 0
      if (texts.lost) emit(dim(formatSshText(texts.lost, { host: label })))
      scheduleReconnect()
    }

    function scheduleReconnect() {
      if (attempt >= reconnectDelays.length) {
        if (texts.gaveUp) emit(red(formatSshText(texts.gaveUp, { host: label })))
        return finish(255)
      }
      const delay = reconnectDelays[attempt++]
      reconnectTimer = timers.setTimeout(() => {
        reconnectTimer = null
        if (!killed && !exited) open(true)
      }, delay)
    }

    Object.assign(self, {
      write(data) {
        if (exited) return
        if (stream) {
          try {
            stream.write(data)
          } catch {
            /* closing */
          }
          return
        }
        // After a shell was lost (a reconnect): dropped, never replayed into
        // the next login shell (a sudo password or editor keys would become
        // commands there); the pane says so once.
        if (openedAt) {
          if (!notConnectedShown && texts.notConnected) emit(dim(formatSshText(texts.notConnected, { host: label })))
          notConnectedShown = true
          return
        }
        // Typed while the first shell is starting: kept (bounded), sent to it.
        const n = Buffer.byteLength(String(data))
        if (queuedBytes + n > MAX_QUEUED_INPUT) return
        queued.push(String(data))
        queuedBytes += n
      },
      resize(c, r) {
        size.cols = Math.max(2, c | 0)
        size.rows = Math.max(1, r | 0)
        if (stream) {
          try {
            stream.setWindow(size.rows, size.cols, 0, 0)
          } catch {
            /* resize race */
          }
        }
      },
      kill() {
        if (killed) return
        killed = true
        if (stream) {
          try {
            stream.close()
          } catch {
            /* gone */
          }
        }
        // The pane was closed: its session on the host goes too (a lost
        // connection never comes here, so a detached session stays).
        if (inTmux) killSession()
        // node-pty reports an exit after kill: so does this.
        timers.setTimeout(() => finish(0), 0)
      },
      onData(fn) {
        dataFns.push(fn)
      },
      onExit(fn) {
        exitFns.push(fn)
      }
    })
    shells.add(self)
    if (agent) tunnel.registerPane(hostId, paneId, agent, spec)
    open(false)
    return self
  }

  // --- Ops ------------------------------------------------------------------------
  // -> true when the op was an SSH one (handled here).
  function handle(sock, msg, reply) {
    switch (msg.op) {
      case 'ssh-exec':
        reply(openExec(sock, msg))
        return true
      case 'ssh-write': {
        const c = chans.get(msg.ch)
        if (c && c.sock === sock && c.stream && typeof msg.data === 'string') {
          try {
            c.stream.write(Buffer.from(msg.data, 'base64'))
          } catch {
            /* closing */
          }
        }
        return true
      }
      case 'ssh-eof':
      case 'ssh-close': {
        const c = chans.get(msg.ch)
        if (c && c.sock === sock) closeChan(msg.ch, msg.op === 'ssh-eof' ? 'eof' : 'close')
        return true
      }
      case 'ssh-connect': {
        const cid = typeof msg.cid === 'string' && ID_RE.test(msg.cid) ? msg.cid : null
        const hostId = cleanStr(msg.hostId, 80)
        const spec = validateSpec(msg.spec)
        if (!cid || !hostId || !spec) {
          reply({ ok: false, error: 'invalid' })
          return true
        }
        reply({ ok: true })
        manager.connectHost(hostId, spec).then(
          () => sendTo(sock, { op: 'ssh-connected', cid, ok: true }),
          (err) => sendTo(sock, { op: 'ssh-connected', cid, ok: false, fail: (err && err.code) || 'failed', params: (err && err.params) || {} })
        )
        return true
      }
      case 'ssh-disconnect': {
        const hostId = cleanStr(msg.hostId, 80)
        if (hostId) {
          for (const s of shells) if (s.hostId === hostId) s.noReconnect = true
          tunnel.dropHost(hostId)
          cancelPrompts(hostId)
          manager.disconnect(hostId)
        }
        reply({ ok: true })
        return true
      }
      case 'ssh-answer': {
        const p = typeof msg.promptId === 'string' ? prompts.get(msg.promptId) : null
        if (!p) {
          reply({ ok: false, error: 'stale' })
          return true
        }
        const v = msg.value
        if (v !== null && (typeof v !== 'string' || v.length > MAX_SECRET || /[\r\n\0]/.test(v))) {
          reply({ ok: false, error: 'invalid' })
          return true
        }
        if (p.public.kind === 'hostkey' && v !== null && v !== 'yes' && v !== 'no') {
          reply({ ok: false, error: 'invalid' })
          return true
        }
        settle(msg.promptId, v)
        reply({ ok: true })
        return true
      }
      case 'ssh-sync':
        reply({ ok: true, states: manager.snapshot(), prompts: [...prompts.values()].map((p) => p.public) })
        return true
      default:
        return false
    }
  }

  // The app connection went away: its exec channels end with it (the
  // terminals do not: they belong to the host).
  function sockClosed(sock) {
    for (const [ch, c] of [...chans]) {
      if (c.sock !== sock) continue
      c.closed = true
      if (c.stream) {
        try {
          c.stream.close()
        } catch {
          /* gone */
        }
      }
      chans.delete(ch)
    }
  }

  function shutdown() {
    for (const id of [...prompts.keys()]) settle(id, null)
    tunnel.closeAll()
    manager.closeAll()
  }

  return { handle, createPty, sockClosed, shutdown, manager, tunnel, hello: () => ({ ssh: SSH_FEATURE, remoteAgent: REMOTE_AGENT_FEATURE, onlyLive: ONLY_LIVE_FEATURE }) }
}
