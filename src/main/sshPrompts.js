// SSH credential prompts for remote host panes, like Orca's password /
// passphrase dialog (MIT, Copyright (c) 2026 Lovecast Inc.:
// src/main/ipc/ssh-passphrase.ts requestCredential / registerCredentialHandler,
// renderer components/settings/SshPassphraseDialog.tsx).
//
// Orca runs its own SSH client and asks for the secret directly. Tessel runs
// Windows' OpenSSH client (ssh.exe) in a terminal pane, so this module watches
// that pane's output while it connects, recognises OpenSSH's own prompts
// ("user@host's password:", "Enter passphrase for key '...':",
// "(user@host) Password:", keyboard-interactive challenges) and asks the
// interface for the answer. The answer comes back through ONE invoke call,
// bound to the pane and a one-time prompt id; it is written to that pane's
// terminal and nowhere else: never stored, never logged, never broadcast.
// ssh reads it with echo off, so it never appears in the terminal output
// (and so never in the saved scrollback).
//
// The host key question ("Are you sure you want to continue connecting
// (yes/no/[fingerprint])?") is never answered here: Orca has no dialog for
// it (it checks known_hosts itself), so the user answers it in the terminal.
//
// The pane counts as connected once the remote side printed something of its
// own (a banner, a shell prompt) and went quiet without asking anything; ssh
// exiting first means it failed (remoteHosts.js shows the error).
import { randomUUID } from 'crypto'

const TAIL_MAX = 4096
export const SETTLE_MS = 150
export const CONNECTED_QUIET_MS = 1200
export const CREDENTIAL_TIMEOUT_MS = 120_000 // Orca's SSH_CREDENTIAL_TIMEOUT_MS
const MAX_SECRET = 4096

// --- Terminal output -> text ----------------------------------------------------
// Escape sequences go; the ones that move the cursor to another line (ConPTY
// draws its first screen with cursor positions, not newlines) become newlines.
export function stripTerminal(data) {
  return String(data || '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC (titles...)
    .replace(/\x1b\[[0-9;?]*[HfBEF]/g, '\n') // cursor to another line
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '') // other CSI
    .replace(/\x1b[@-_]/g, '') // other ESC x
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
}

function lastLine(text) {
  const lines = String(text).split(/\r\n|\n|\r/)
  // Trailing spaces are part of a prompt; an empty last line is not a prompt.
  return (lines[lines.length - 1] || '').trim()
}

// --- OpenSSH's prompts ----------------------------------------------------------
// -> { kind: 'password' | 'passphrase' | 'keyboard-interactive' | 'hostkey',
//      detail, retry? } or null. Only the LAST line of the output counts, and
// only when it ends with the prompt (ssh waits there, nothing follows).
const USER_HOST = '[^\\s()\'"@]+@[^\\s()\'"]+'
const PROMPTS = [
  // Enter passphrase for key 'C:\Users\me/.ssh/id_ed25519':
  // Enter passphrase for C:\Users\me/.ssh/id_rsa:
  { re: /^Enter passphrase for (?:key )?'?(.+?)'?:$/, kind: 'passphrase' },
  // Wrong passphrase: OpenSSH asks again with this line.
  { re: /^Bad passphrase, try again for (.+?):$/, kind: 'passphrase', retry: true },
  // user@host's password:
  { re: new RegExp(`^(${USER_HOST})'s password:$`), kind: 'password' },
  // (user@host) Password:  /  (user@host) Password for user@host:  /  Password:
  { re: new RegExp(`^(?:\\((${USER_HOST})\\) )?Password(?: for (\\S+))?:$`, 'i'), kind: 'password' },
  // Keyboard-interactive challenges, (user@host) prefix (OpenSSH 8.4+):
  // (user@host) Verification code:
  { re: new RegExp(`^\\((${USER_HOST})\\) ([^:\\n]{1,80}):$`), kind: 'keyboard-interactive', challenge: 2 },
  // ... and the usual ones without it.
  {
    re: /^((?:Verification code|One-time password[^:]{0,60}|OTP(?: code)?|Passcode(?: or option \([^)]*\))?|Enter PASSCODE|Token(?: code)?|PIN(?: code)?|Duo two-factor login[^:]{0,60}))\s*:$/i,
    kind: 'keyboard-interactive',
    challenge: 1
  }
]
const HOST_KEY = /Are you sure you want to continue connecting \(yes\/no(?:\/\[fingerprint\])?\)\?$/
const FINGERPRINT = /(\S+) key fingerprint is (\S+?)\.?\s*$/m

export function detectSshPrompt(text) {
  const line = lastLine(text)
  if (!line || line.length > 300) return null
  if (HOST_KEY.test(line)) {
    const m = FINGERPRINT.exec(String(text))
    return { kind: 'hostkey', detail: m ? `${m[1]} ${m[2]}` : '' }
  }
  for (const p of PROMPTS) {
    const m = p.re.exec(line)
    if (!m) continue
    let detail
    if (p.challenge) detail = m[p.challenge].trim()
    else detail = (m[1] || m[2] || '').trim()
    // "(user@host) Password:" is keyboard-interactive password auth: still a password.
    if (p.kind === 'keyboard-interactive' && /^password\b/i.test(detail)) continue
    return { kind: p.kind, detail, ...(p.retry ? { retry: true } : {}) }
  }
  return null
}

// The line OpenSSH prints before asking again after a wrong answer.
const DENIED = /Permission denied, please try again\.?|Bad passphrase|Sorry, try again\.?|Access denied/i

// Lines printed by the ssh client itself (not the remote side): they do not
// mean "connected".
const CLIENT_LINE = new RegExp(
  [
    '^Warning: Permanently added',
    '^Warning: ',
    '^Permission denied',
    '^Bad passphrase',
    '^Authenticated to',
    '^debug\\d?:',
    '^ssh: ',
    '^ssh_',
    '^kex_exchange_identification',
    '^Connection (?:to .* closed|closed|refused|reset|timed out)',
    '^Load key',
    '^Bad owner',
    '^Host key verification failed',
    '^The authenticity of host',
    '^\\S+ key fingerprint is',
    '^This key is not known',
    '^This host key is known',
    '^Are you sure you want to continue connecting',
    '^Please type',
    '^(?:yes|no|y|n|SHA256:\\S+|MD5:\\S+)$',
    '^Pseudo-terminal will not be allocated',
    '^Received disconnect',
    '^Disconnected from',
    '^Too many authentication failures',
    '^Could not resolve hostname',
    '^Enter passphrase',
    '^Access denied'
  ].join('|'),
  'i'
)
export function hasRemoteOutput(text) {
  return String(text)
    .split(/\r\n|\n|\r/)
    .map((l) => l.trim())
    .some((l) => l && !CLIENT_LINE.test(l) && !detectSshPrompt(l))
}

// --- The watcher -------------------------------------------------------------------
// send(channel, payload): to the window. write(paneId, data): to that pane's
// terminal. onConnected(paneId) / onCancel(paneId): remoteHosts.js.
export function createSshPromptWatcher({
  send = () => {},
  write = () => {},
  onConnected = () => {},
  onCancel = () => {},
  newId = () => randomUUID(),
  timers = { setTimeout, clearTimeout }
} = {}) {
  const panes = new Map() // paneId -> watch state

  function clearTimer(w, name) {
    if (w[name]) {
      timers.clearTimeout(w[name])
      w[name] = null
    }
  }

  // The dialog for this prompt closes (answered, withdrawn, pane gone).
  function resolvePending(paneId, w) {
    if (!w.pending) return
    clearTimer(w.pending, 'timer')
    const promptId = w.pending.id
    w.pending = null
    send('ssh:credential-resolved', { paneId, promptId })
  }

  function watch(paneId, { hostId, label } = {}) {
    unwatch(paneId)
    panes.set(paneId, {
      hostId: hostId || null,
      label: typeof label === 'string' ? label : '',
      tail: '',
      since: '', // output since the last prompt (or the start)
      answered: false,
      pending: null,
      settle: null,
      quiet: null
    })
  }

  function unwatch(paneId) {
    const w = panes.get(paneId)
    if (!w) return
    resolvePending(paneId, w)
    clearTimer(w, 'settle')
    clearTimer(w, 'quiet')
    panes.delete(paneId)
  }

  function onData(paneId, data) {
    const w = panes.get(paneId)
    if (!w) return
    const text = stripTerminal(data)
    if (!text) return // cursor show/hide and the like
    w.tail = (w.tail + text).slice(-TAIL_MAX)
    w.since = (w.since + text).slice(-TAIL_MAX)
    clearTimer(w, 'quiet')
    // Something new after a prompt (typed in the terminal instead, or ssh
    // moved on): the dialog is out of date.
    if (w.pending && !detectSshPrompt(w.tail)) resolvePending(paneId, w)
    clearTimer(w, 'settle')
    w.settle = timers.setTimeout(() => evaluate(paneId), SETTLE_MS)
  }

  function evaluate(paneId) {
    const w = panes.get(paneId)
    if (!w) return
    w.settle = null
    const prompt = detectSshPrompt(w.tail)
    if (prompt && prompt.kind === 'hostkey') {
      // Left to the terminal; its answer is not remote output.
      w.since = ''
      return
    }
    if (prompt) {
      if (w.pending) return
      const retry = !!prompt.retry || (w.answered && DENIED.test(w.since))
      const id = newId()
      w.pending = { id, kind: prompt.kind }
      w.pending.timer = timers.setTimeout(() => {
        // Unanswered for 2 minutes: the dialog goes, the terminal still asks.
        const cur = panes.get(paneId)
        if (cur && cur.pending && cur.pending.id === id) resolvePending(paneId, cur)
      }, CREDENTIAL_TIMEOUT_MS)
      w.since = ''
      send('ssh:credential-request', {
        paneId,
        promptId: id,
        hostId: w.hostId,
        label: w.label,
        kind: prompt.kind,
        detail: prompt.detail,
        retry
      })
      return
    }
    w.quiet = timers.setTimeout(() => {
      const cur = panes.get(paneId)
      if (!cur) return
      cur.quiet = null
      if (cur.pending || !hasRemoteOutput(cur.since)) return
      unwatch(paneId)
      onConnected(paneId)
    }, CONNECTED_QUIET_MS)
  }

  // The dialog's answer: value (string) or null (Cancel). The prompt id must
  // be the one this pane is waiting on; it is used once.
  function submit(args) {
    const paneId = args && typeof args.paneId === 'string' ? args.paneId : ''
    const promptId = args && typeof args.promptId === 'string' ? args.promptId : ''
    const w = paneId ? panes.get(paneId) : null
    if (!w || !w.pending || !promptId || w.pending.id !== promptId) return { ok: false, error: 'stale' }
    const value = args.value
    if (value === null) {
      resolvePending(paneId, w)
      const hostId = w.hostId
      unwatch(paneId)
      onCancel(paneId, hostId)
      // Ctrl+C: ssh stops asking and exits.
      write(paneId, '\x03')
      return { ok: true }
    }
    if (typeof value !== 'string' || value.length > MAX_SECRET || /[\r\n\0]/.test(value)) return { ok: false, error: 'invalid' }
    if (!value && w.pending.kind !== 'keyboard-interactive') return { ok: false, error: 'invalid' }
    resolvePending(paneId, w)
    w.answered = true
    w.tail = ''
    write(paneId, value + '\r')
    return { ok: true }
  }

  function isWatching(paneId) {
    return panes.has(paneId)
  }

  return { watch, unwatch, onData, onExit: unwatch, submit, isWatching }
}

// IPC: the single call that carries a secret. Its argument object is emptied
// right away so no reference to the secret outlives the write; nothing here
// logs it, and an error never echoes the arguments.
export function registerSshPrompts({ ipcMain, watcher }) {
  ipcMain.handle('ssh:submitCredential', (_evt, args) => {
    try {
      const a = args && typeof args === 'object' ? args : {}
      const req = { paneId: a.paneId, promptId: a.promptId, value: a.value === null ? null : a.value }
      a.value = undefined
      const res = watcher.submit(req)
      req.value = undefined
      return res
    } catch {
      return { ok: false, error: 'failed' }
    }
  })
}
