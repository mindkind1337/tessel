// SSH credential prompts for remote host panes, through OpenSSH's own askpass
// channel. The dialog is Orca's password / passphrase dialog (MIT, Copyright
// (c) 2026 Lovecast Inc.: src/main/ipc/ssh-passphrase.ts requestCredential,
// renderer components/settings/SshPassphraseDialog.tsx).
//
// How it works. A remote host pane runs Windows' OpenSSH client (ssh.exe) with
//   SSH_ASKPASS=<out/main/tessel-askpass.exe>   SSH_ASKPASS_REQUIRE=force
//   TESSEL_ASKPASS_PIPE=<this app's pipe>        TESSEL_ASKPASS_TOKEN=<pane's token>
// so ssh never reads a secret from the terminal: for every question (password,
// key passphrase, keyboard-interactive challenge, the host key question) it
// starts the helper with the question as its argument, and reads the answer
// from the helper's output. The helper (src/main/askpass/TesselAskpass.cs)
// sends { token, question } over the named pipe; this module finds the pane
// the token was made for, shows the dialog, and sends the answer back to that
// helper only. The answer is never written to the terminal, never stored,
// never logged, never broadcast.
//
// Why not read the terminal (the first version did): only ssh can start the
// helper, so a remote program printing "Password:" can never open the dialog,
// and each question gets its own request id (a newer question withdraws the
// older one), so an old password dialog can never answer a host key question.
//
// Verified on this machine (OpenSSH_for_Windows_9.5p2): Win32-OpenSSH honours
// SSH_ASKPASS_REQUIRE=force without DISPLAY, and starts SSH_ASKPASS with
// CreateProcess, the prompt as one quoted argument (a .cmd would go through
// cmd.exe, which cuts a multi-line prompt at its first line and expands % and
// &: hence a small .exe). OpenSSH before 8.4 ignores SSH_ASKPASS_REQUIRE:
// then, and when the helper is missing, the password is typed in the terminal
// as before (no dialog).
//
// "Connected": ssh has no signal Tessel can read without the screen, so a pane
// counts as connected once ssh has been running CONNECTED_AFTER_START_MS
// without asking anything, or CONNECTED_AFTER_ANSWER_MS after the last answer
// without asking again (a wrong password is asked again within that time, the
// server's failure delay included). A later question puts it back to
// Connecting. ssh exiting with 255 is an error (remoteHosts.js).
import net from 'net'
import fs from 'fs'
import crypto from 'crypto'
import { execFile } from 'child_process'
import { join } from 'path'

export const CREDENTIAL_TIMEOUT_MS = 120_000 // Orca's SSH_CREDENTIAL_TIMEOUT_MS
export const CONNECTED_AFTER_START_MS = 3000
export const CONNECTED_AFTER_ANSWER_MS = 5000
export const ASKPASS_EXE = 'tessel-askpass.exe'
const FIRST_LINE_MS = 5000
const MAX_LINE = 256 * 1024
const MAX_PROMPT = 4000
const MAX_SECRET = 4096
const TOKEN_RE = /^[0-9a-f]{64}$/

// --- ssh.exe's version -----------------------------------------------------------
// "OpenSSH_for_Windows_9.5p2, LibreSSL 3.8.2" -> { major: 9, minor: 5 }
export function parseSshVersion(text) {
  const m = /OpenSSH[A-Za-z_]*?_(\d+)\.(\d+)/.exec(String(text || ''))
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null
}
// SSH_ASKPASS_REQUIRE came with OpenSSH 8.4.
export function supportsAskpassRequire(text) {
  const v = parseSshVersion(text)
  return !!v && (v.major > 8 || (v.major === 8 && v.minor >= 4))
}

// The helper next to the main bundle (in a packaged app, outside app.asar:
// Windows cannot start a program from inside an archive).
export function askpassExePath(dir, exists = fs.existsSync) {
  const file = join(String(dir || '').replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2'), ASKPASS_EXE)
  try {
    return exists(file) ? file : null
  } catch {
    return null
  }
}

// --- What ssh asks ---------------------------------------------------------------
// -> { kind: 'password' | 'passphrase' | 'keyboard-interactive' | 'hostkey' |
//      'confirm', detail, retry? } or { notice: true } (nothing to answer).
// Only ssh starts the helper, so this is only ever one of ssh's questions;
// the kind picks the dialog's words. A keyboard-interactive prompt's text is
// the server's: shown as text, never trusted for more than that.
function cleanPrompt(prompt) {
  return String(prompt || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '')
    .slice(0, MAX_PROMPT)
    .trim()
}
const KI_PREFIX = /^\(([^()\s]+@[^()\s]+)\)\s+([\s\S]*)$/
export function classifyAskpassPrompt(rawPrompt, mode = '') {
  if (mode === 'none') return { notice: true }
  const prompt = cleanPrompt(rawPrompt)
  if (mode === 'confirm') return { kind: 'confirm', detail: prompt }
  // Keyboard-interactive (OpenSSH 8.4+ writes "(user@host) " before the
  // server's text): a password when the server asks for one, else a challenge.
  const ki = KI_PREFIX.exec(prompt)
  if (ki) {
    const text = ki[2].trim()
    if (/^password\s*:?$/i.test(text) || /^password for \S+\s*:?$/i.test(text)) return { kind: 'password', detail: ki[1] }
    return { kind: 'keyboard-interactive', detail: text.replace(/:\s*$/, '') || text }
  }
  // The host key question (ssh's own, several lines, with the fingerprint).
  if (/continue connecting \(yes\/no/i.test(prompt)) return { kind: 'hostkey', detail: prompt }
  if (/\(yes\/no[^)]*\)\s*[?:]?\s*$/i.test(prompt)) return { kind: 'confirm', detail: prompt }
  let m
  if ((m = /^(.+?)'s password:?$/.exec(prompt))) return { kind: 'password', detail: m[1] }
  if ((m = /^Bad passphrase, try again for (.+?):?$/.exec(prompt))) return { kind: 'passphrase', detail: m[1].replace(/^'(.*)'$/, '$1'), retry: true }
  if ((m = /^Enter passphrase(?: for (?:key )?(.+?))?:?$/.exec(prompt)))
    return { kind: 'passphrase', detail: (m[1] || '').replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1') }
  if (/^password\s*:?$/i.test(prompt)) return { kind: 'password', detail: '' }
  return { kind: 'keyboard-interactive', detail: prompt.replace(/:\s*$/, '') || prompt }
}

const YES_NO = ['hostkey', 'confirm']

// --- The broker ------------------------------------------------------------------
// send(channel, payload): to the window. writePty(paneId, data): Ctrl+C only,
// to stop ssh when the user cancels (never an answer). onConnected /
// onConnecting(paneId), onCancel(paneId, hostId): remoteHosts.js.
export function createSshAskpass({
  helperPath = () => null,
  send = () => {},
  writePty = () => {},
  onConnected = () => {},
  onConnecting = () => {},
  onCancel = () => {},
  log = null,
  runFile = execFile,
  netApi = net,
  randomBytes = crypto.randomBytes,
  newId = () => crypto.randomUUID(),
  timers = { setTimeout, clearTimeout }
} = {}) {
  const panes = new Map() // paneId -> pane
  const tokens = new Map() // token -> paneId
  const versions = new Map() // ssh.exe path -> Promise<boolean>
  let server = null
  let serverReady = null
  let pipeName = ''

  const warn = (msg) => {
    try {
      if (log) log.warn('ssh', msg)
    } catch {
      /* logging never breaks a login */
    }
  }

  function clearTimer(obj, name) {
    if (obj && obj[name]) {
      timers.clearTimeout(obj[name])
      obj[name] = null
    }
  }

  // --- The pipe ------------------------------------------------------------------
  // A random name per app run; the default security of a pipe made by this
  // process (only this Windows user, SYSTEM and administrators can write to
  // it; readableAll / writableAll stay off); each connection carries one
  // question and must name a live pane token.
  function ensureServer() {
    if (serverReady) return serverReady
    pipeName = `tessel-askpass-${randomBytes(16).toString('hex')}`
    serverReady = new Promise((resolve) => {
      const srv = netApi.createServer((sock) => onConnection(sock))
      srv.on('error', (err) => {
        warn(`askpass pipe failed: ${err && err.code ? err.code : 'error'}`)
        server = null
        serverReady = null
        resolve(false)
      })
      srv.listen({ path: `\\\\.\\pipe\\${pipeName}`, readableAll: false, writableAll: false }, () => {
        server = srv
        resolve(true)
      })
    })
    return serverReady
  }

  function reply(sock, text) {
    try {
      sock.end(text)
    } catch {
      /* the helper is gone */
    }
  }

  function onConnection(sock) {
    let buf = Buffer.alloc(0)
    let done = false
    const first = timers.setTimeout(() => {
      if (!done) sock.destroy()
    }, FIRST_LINE_MS)
    sock.on('error', () => {})
    sock.on('data', (chunk) => {
      if (done) return // one question per connection
      buf = Buffer.concat([buf, chunk])
      const nl = buf.indexOf(0x0a)
      if (nl < 0) {
        if (buf.length > MAX_LINE) {
          done = true
          timers.clearTimeout(first)
          sock.destroy()
        }
        return
      }
      done = true
      timers.clearTimeout(first)
      const line = buf.subarray(0, nl).toString('ascii')
      buf = null
      handleQuestion(sock, line)
    })
  }

  function decode(b64) {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return null
    return Buffer.from(b64, 'base64').toString('utf8')
  }

  function handleQuestion(sock, line) {
    const parts = line.split(' ')
    const token = parts[2] || ''
    if (parts.length !== 5 || parts[0] !== 'TESSEL-ASKPASS' || parts[1] !== '1' || !TOKEN_RE.test(token)) {
      warn('askpass: refused a malformed request')
      return reply(sock, 'NO\n')
    }
    const paneId = tokens.get(token)
    const pane = paneId !== undefined ? panes.get(paneId) : null
    if (!pane || pane.token !== token) {
      warn('askpass: refused a request with an unknown token')
      return reply(sock, 'NO\n')
    }
    const mode = decode(parts[3])
    const prompt = decode(parts[4])
    if (mode === null || prompt === null) return reply(sock, 'NO\n')
    const q = classifyAskpassPrompt(prompt, mode)
    if (q.notice) return reply(sock, 'OK \n') // a notice (touch your key): nothing to answer
    // A new question withdraws the older one: its helper gets no answer.
    if (pane.pending) withdraw(pane, 'replaced')
    clearTimer(pane, 'connTimer')
    if (pane.connected) {
      pane.connected = false
      onConnecting(paneId)
    }
    const last = pane.lastAnswered
    const retry = !!q.retry || (!!last && last.kind === q.kind && last.detail === q.detail && !YES_NO.includes(q.kind))
    const id = newId()
    const pending = { id, kind: q.kind, detail: q.detail, sock, timer: null, mode }
    pane.pending = pending
    pending.timer = timers.setTimeout(() => {
      // Unanswered for 2 minutes: no answer (ssh counts a failed try).
      if (pane.pending === pending) withdraw(pane, 'timeout')
    }, CREDENTIAL_TIMEOUT_MS)
    sock.on('close', () => {
      // The helper ended first (Ctrl+C in the pane, ssh gone).
      if (pane.pending === pending) {
        closePending(pane)
        armConnected(pane, CONNECTED_AFTER_ANSWER_MS)
      }
    })
    if (log) {
      try {
        log.info('ssh', `askpass: ${q.kind} asked in pane ${paneId}`)
      } catch {
        /* never mind */
      }
    }
    send('ssh:credential-request', {
      paneId,
      promptId: id,
      hostId: pane.hostId,
      label: pane.label,
      kind: q.kind,
      detail: q.detail,
      retry
    })
  }

  // The dialog for this question goes away (answered, withdrawn, pane gone).
  function closePending(pane) {
    const p = pane.pending
    if (!p) return null
    clearTimer(p, 'timer')
    pane.pending = null
    send('ssh:credential-resolved', { paneId: pane.paneId, promptId: p.id })
    return p
  }
  function withdraw(pane, why) {
    const p = closePending(pane)
    if (!p) return
    reply(p.sock, 'NO\n')
    if (why === 'timeout') armConnected(pane, CONNECTED_AFTER_ANSWER_MS)
  }

  function armConnected(pane, ms) {
    clearTimer(pane, 'connTimer')
    if (pane.connected || !pane.started) return
    pane.connTimer = timers.setTimeout(() => {
      pane.connTimer = null
      if (pane.pending || pane.connected || panes.get(pane.paneId) !== pane) return
      pane.connected = true
      onConnected(pane.paneId)
    }, ms)
  }

  // --- Panes -----------------------------------------------------------------------
  function sshSupportsAskpass(sshExe) {
    if (!sshExe) return Promise.resolve(false)
    if (!versions.has(sshExe)) {
      versions.set(
        sshExe,
        new Promise((resolve) => {
          try {
            runFile(sshExe, ['-V'], { timeout: 5000, windowsHide: true, shell: false }, (_err, stdout, stderr) => {
              resolve(supportsAskpassRequire(`${stderr || ''}\n${stdout || ''}`))
            })
          } catch {
            resolve(false)
          }
        })
      )
    }
    return versions.get(sshExe)
  }

  // Before ssh starts: the variables that send its questions here, or null
  // (no helper, an old ssh, no pipe: the terminal asks, as ssh does alone).
  async function preparePane(paneId, { hostId, label, sshExe } = {}) {
    releasePane(paneId)
    const exe = helperPath()
    if (!exe) return null
    if (!(await sshSupportsAskpass(sshExe))) return null
    if (!(await ensureServer())) return null
    const token = randomBytes(32).toString('hex')
    panes.set(paneId, {
      paneId,
      token,
      hostId: hostId || null,
      label: typeof label === 'string' ? label : '',
      pending: null,
      connTimer: null,
      connected: false,
      started: false,
      lastAnswered: null
    })
    tokens.set(token, paneId)
    return {
      SSH_ASKPASS: exe,
      SSH_ASKPASS_REQUIRE: 'force',
      TESSEL_ASKPASS_PIPE: pipeName,
      TESSEL_ASKPASS_TOKEN: token
    }
  }

  // ssh is running: count towards "connected".
  function paneStarted(paneId) {
    const pane = panes.get(paneId)
    if (!pane) return false
    pane.started = true
    if (!pane.pending) armConnected(pane, CONNECTED_AFTER_START_MS)
    return true
  }

  // The pane's ssh ended (or never started): its token dies with it.
  function releasePane(paneId) {
    const pane = panes.get(paneId)
    if (!pane) return
    withdraw(pane, 'gone')
    clearTimer(pane, 'connTimer')
    tokens.delete(pane.token)
    panes.delete(paneId)
  }

  // The dialog's answer: value (string), or null (Cancel). The request id must
  // be the one this pane is waiting on; it is used once.
  function submit(args) {
    const paneId = args && typeof args.paneId === 'string' ? args.paneId : ''
    const promptId = args && typeof args.promptId === 'string' ? args.promptId : ''
    const pane = paneId ? panes.get(paneId) : null
    const p = pane && pane.pending
    if (!p || !promptId || p.id !== promptId) return { ok: false, error: 'stale' }
    const value = args.value
    if (value === null) {
      closePending(pane)
      onCancel(paneId, pane.hostId)
      // Ctrl+C first: ssh (still in its login, the console not in raw mode)
      // stops; then the helper gets no answer.
      writePty(paneId, '\x03')
      reply(p.sock, 'NO\n')
      return { ok: true }
    }
    if (typeof value !== 'string') return { ok: false, error: 'invalid' }
    if (YES_NO.includes(p.kind)) {
      // A yes / no question takes exactly that: never a secret typed for
      // another question.
      if (value !== 'yes' && value !== 'no') return { ok: false, error: 'invalid' }
      closePending(pane)
      if (value === 'no') {
        onCancel(paneId, pane.hostId)
        reply(p.sock, p.kind === 'confirm' && p.mode === 'confirm' ? 'NO\n' : `OK ${Buffer.from('no').toString('base64')}\n`)
        return { ok: true }
      }
      reply(p.sock, `OK ${Buffer.from('yes').toString('base64')}\n`)
      armConnected(pane, CONNECTED_AFTER_ANSWER_MS)
      return { ok: true }
    }
    if (value.length > MAX_SECRET || /[\r\n\0]/.test(value)) return { ok: false, error: 'invalid' }
    if (!value && p.kind !== 'keyboard-interactive') return { ok: false, error: 'invalid' }
    closePending(pane)
    pane.lastAnswered = { kind: p.kind, detail: p.detail }
    reply(p.sock, `OK ${Buffer.from(value, 'utf8').toString('base64')}\n`)
    armConnected(pane, CONNECTED_AFTER_ANSWER_MS)
    return { ok: true }
  }

  function isPrepared(paneId) {
    return panes.has(paneId)
  }

  function close() {
    for (const id of [...panes.keys()]) releasePane(id)
    if (server) {
      try {
        server.close()
      } catch {
        /* closing anyway */
      }
    }
    server = null
    serverReady = null
  }

  return {
    preparePane,
    paneStarted,
    releasePane,
    paneExited: releasePane,
    submit,
    isPrepared,
    close,
    get pipeName() {
      return pipeName
    }
  }
}

// IPC: the single call that carries a secret. Its argument object is emptied
// right away so no reference to the secret outlives the answer; nothing here
// logs it, and an error never echoes the arguments.
export function registerSshAskpass({ ipcMain, broker }) {
  ipcMain.handle('ssh:submitCredential', (_evt, args) => {
    try {
      const a = args && typeof args === 'object' ? args : {}
      const req = { paneId: a.paneId, promptId: a.promptId, value: a.value === null ? null : a.value }
      a.value = undefined
      const res = broker.submit(req)
      req.value = undefined
      return res
    } catch {
      return { ok: false, error: 'failed' }
    }
  })
}
