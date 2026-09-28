// SSH prompts in remote host panes (sshPrompts.js): OpenSSH's prompt forms,
// no false positives, the one-time prompt id, the single write, the
// connected / cancelled transitions, and the secret never reaching a log,
// a file or a broadcast. A fake pty only; ssh is never run.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  detectSshPrompt,
  stripTerminal,
  hasRemoteOutput,
  createSshPromptWatcher,
  registerSshPrompts,
  SETTLE_MS,
  CONNECTED_QUIET_MS,
  CREDENTIAL_TIMEOUT_MS
} from '../sshPrompts'
import { createRemoteHosts } from '../remoteHosts'
import { createLogger } from '../logger'

describe('detectSshPrompt: OpenSSH prompt forms', () => {
  it.each([
    ["deploy@148.113.224.19's password: ", 'password', 'deploy@148.113.224.19'],
    ["root@srv.example.com's password:", 'password', 'root@srv.example.com'],
    ['(deploy@srv) Password: ', 'password', 'deploy@srv'],
    ['Password: ', 'password', ''],
    ['password:', 'password', ''],
    ["Enter passphrase for key 'C:\\Users\\me/.ssh/id_ed25519': ", 'passphrase', 'C:\\Users\\me/.ssh/id_ed25519'],
    ['Enter passphrase for C:\\Users\\me/.ssh/id_rsa: ', 'passphrase', 'C:\\Users\\me/.ssh/id_rsa'],
    ['(deploy@srv) Verification code: ', 'keyboard-interactive', 'Verification code'],
    ['Verification code: ', 'keyboard-interactive', 'Verification code'],
    ['One-time password (OATH) for `deploy\': ', 'keyboard-interactive', "One-time password (OATH) for `deploy'"],
    ['Passcode or option (1-3): ', 'keyboard-interactive', 'Passcode or option (1-3)']
  ])('%j -> %s', (line, kind, detail) => {
    expect(detectSshPrompt(`Warning: Permanently added 'srv' (ED25519) to the list of known hosts.\r\n${line}`)).toMatchObject({ kind, detail })
  })

  it('a wrong passphrase asks again with a retry', () => {
    expect(detectSshPrompt("Bad passphrase, try again for C:\\k\\id: ")).toMatchObject({ kind: 'passphrase', detail: 'C:\\k\\id', retry: true })
  })

  it('the host key question is recognised (with its fingerprint), not treated as a credential', () => {
    const text = [
      "The authenticity of host 'srv (10.0.0.5)' can't be established.",
      'ED25519 key fingerprint is SHA256:AbCdEf0123456789abcdef0123456789ABCDEFghij.',
      'This key is not known by any other names.',
      'Are you sure you want to continue connecting (yes/no/[fingerprint])? '
    ].join('\r\n')
    expect(detectSshPrompt(text)).toEqual({ kind: 'hostkey', detail: 'ED25519 SHA256:AbCdEf0123456789abcdef0123456789ABCDEFghij' })
    expect(detectSshPrompt('Are you sure you want to continue connecting (yes/no)? ')).toMatchObject({ kind: 'hostkey' })
  })

  it('works through ConPTY escape sequences and cursor moves', () => {
    const conpty = "\x1b[?25l\x1b[2J\x1b[m\x1b[HWarning: something\x1b[2;1Hdeploy@srv's password: \x1b[?25h"
    expect(detectSshPrompt(stripTerminal(conpty))).toMatchObject({ kind: 'password', detail: 'deploy@srv' })
    expect(stripTerminal('\x1b]0;title\x07ok')).toBe('ok')
  })

  it.each([
    "deploy@srv's password: \r\n", // already answered (newline after it)
    'Password: changed on 2026-01-01',
    'Last login: Mon Sep 28 10:00:00 2026 from 10.0.0.2',
    'deploy@srv:~$ ',
    '(venv) deploy@srv:~/app$ ',
    'Welcome to Ubuntu 24.04 LTS',
    'Your password will expire in 5 days',
    'Enter the password for the database in config.yml',
    'Permission denied, please try again.',
    'ssh: connect to host srv port 22: Connection refused',
    '',
    'Password: ' + 'x'.repeat(400)
  ])('no prompt in %j', (text) => {
    expect(detectSshPrompt(text)).toBe(null)
  })

  it('remote output vs the ssh client\'s own lines', () => {
    expect(hasRemoteOutput("Warning: Permanently added 'srv' (ED25519) to the list of known hosts.\r\n")).toBe(false)
    expect(hasRemoteOutput('Permission denied, please try again.\r\n')).toBe(false)
    expect(hasRemoteOutput('yes\r\n')).toBe(false)
    expect(hasRemoteOutput('\r\n')).toBe(false)
    expect(hasRemoteOutput('Welcome to Ubuntu 24.04 LTS\r\ndeploy@srv:~$ ')).toBe(true)
  })
})

function setup(extra = {}) {
  const sent = []
  const writes = []
  const connected = []
  const cancelled = []
  let n = 0
  const w = createSshPromptWatcher({
    send: (ch, payload) => sent.push({ ch, payload }),
    write: (id, data) => writes.push({ id, data }),
    onConnected: (id) => connected.push(id),
    onCancel: (id, hostId) => cancelled.push({ id, hostId }),
    newId: () => `prompt-${++n}`,
    ...extra
  })
  return { w, sent, writes, connected, cancelled }
}
const requests = (sent) => sent.filter((s) => s.ch === 'ssh:credential-request').map((s) => s.payload)

describe('the watcher', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('asks once per prompt, writes the answer once to that pane, then connects', () => {
    const { w, sent, writes, connected } = setup()
    w.watch('pane-1', { hostId: 'ssh-1', label: '148.113.224.19' })
    w.watch('pane-2', { hostId: 'ssh-2', label: 'other' })
    w.onData('pane-1', "deploy@148.113.224.19's password: ")
    vi.advanceTimersByTime(SETTLE_MS)
    expect(requests(sent)).toEqual([
      { paneId: 'pane-1', promptId: 'prompt-1', hostId: 'ssh-1', label: '148.113.224.19', kind: 'password', detail: 'deploy@148.113.224.19', retry: false }
    ])
    // Nothing secret in any broadcast so far, and no second request while waiting.
    vi.advanceTimersByTime(5000)
    expect(requests(sent)).toHaveLength(1)

    expect(w.submit({ paneId: 'pane-2', promptId: 'prompt-1', value: 'hunter2' })).toEqual({ ok: false, error: 'stale' })
    expect(w.submit({ paneId: 'pane-1', promptId: 'nope', value: 'hunter2' })).toEqual({ ok: false, error: 'stale' })
    expect(w.submit({ paneId: 'pane-1', promptId: 'prompt-1', value: 'hunter2' })).toEqual({ ok: true })
    // The prompt id is used once.
    expect(w.submit({ paneId: 'pane-1', promptId: 'prompt-1', value: 'hunter2' })).toEqual({ ok: false, error: 'stale' })
    expect(writes).toEqual([{ id: 'pane-1', data: 'hunter2\r' }])
    expect(sent.some((s) => s.ch === 'ssh:credential-resolved' && s.payload.promptId === 'prompt-1')).toBe(true)
    // The secret is in no broadcast at all.
    expect(JSON.stringify(sent)).not.toContain('hunter2')

    w.onData('pane-1', '\r\nWelcome to Ubuntu 24.04 LTS\r\n\r\ndeploy@srv:~$ ')
    vi.advanceTimersByTime(SETTLE_MS + CONNECTED_QUIET_MS)
    expect(connected).toEqual(['pane-1'])
    expect(w.isWatching('pane-1')).toBe(false)
    // Once connected, a remote "Password:" (sudo...) is the terminal's business.
    w.onData('pane-1', 'Password: ')
    vi.advanceTimersByTime(SETTLE_MS)
    expect(requests(sent)).toHaveLength(1)
  })

  it('a wrong password asks again with the retry line', () => {
    const { w, sent } = setup()
    w.watch('p', { hostId: 'h', label: 'srv' })
    w.onData('p', "me@srv's password: ")
    vi.advanceTimersByTime(SETTLE_MS)
    w.submit({ paneId: 'p', promptId: 'prompt-1', value: 'wrong' })
    w.onData('p', '\r\nPermission denied, please try again.\r\n')
    w.onData('p', "me@srv's password: ")
    vi.advanceTimersByTime(SETTLE_MS)
    expect(requests(sent).map((r) => [r.promptId, r.retry])).toEqual([['prompt-1', false], ['prompt-2', true]])
  })

  it('stays connecting while ssh prints only its own lines, and on the host key question', () => {
    const { w, sent, connected } = setup()
    w.watch('p', { hostId: 'h' })
    w.onData('p', "The authenticity of host 'srv' can't be established.\r\nED25519 key fingerprint is SHA256:abc.\r\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ")
    vi.advanceTimersByTime(SETTLE_MS + CONNECTED_QUIET_MS * 3)
    expect(requests(sent)).toEqual([])
    expect(connected).toEqual([])
    // The user types yes in the terminal (echoed), then ssh asks for the password.
    w.onData('p', "yes\r\nWarning: Permanently added 'srv' (ED25519) to the list of known hosts.\r\n")
    vi.advanceTimersByTime(SETTLE_MS + CONNECTED_QUIET_MS * 3)
    expect(connected).toEqual([])
    w.onData('p', "me@srv's password: ")
    vi.advanceTimersByTime(SETTLE_MS)
    expect(requests(sent)).toHaveLength(1)
  })

  it('connects without any prompt (key in the agent)', () => {
    const { w, connected } = setup()
    w.watch('p', { hostId: 'h' })
    w.onData('p', 'Last login: Mon Sep 28 10:00:00 2026\r\n')
    vi.advanceTimersByTime(SETTLE_MS + 100)
    w.onData('p', 'me@srv:~$ ')
    vi.advanceTimersByTime(SETTLE_MS + CONNECTED_QUIET_MS - 1)
    expect(connected).toEqual([])
    vi.advanceTimersByTime(1)
    expect(connected).toEqual(['p'])
  })

  it('cancel: Ctrl+C to that pane, the host is marked as disconnecting', () => {
    const { w, sent, writes, cancelled } = setup()
    w.watch('p', { hostId: 'h' })
    w.onData('p', "Enter passphrase for key 'C:\\k\\id': ")
    vi.advanceTimersByTime(SETTLE_MS)
    expect(requests(sent)[0]).toMatchObject({ kind: 'passphrase', detail: 'C:\\k\\id' })
    expect(w.submit({ paneId: 'p', promptId: 'prompt-1', value: null })).toEqual({ ok: true })
    expect(writes).toEqual([{ id: 'p', data: '\x03' }])
    expect(cancelled).toEqual([{ id: 'p', hostId: 'h' }])
    expect(w.isWatching('p')).toBe(false)
  })

  it('rejects answers that would type more than one line, and empty passwords', () => {
    const { w, writes } = setup()
    w.watch('p', { hostId: 'h' })
    w.onData('p', 'Password: ')
    vi.advanceTimersByTime(SETTLE_MS)
    expect(w.submit({ paneId: 'p', promptId: 'prompt-1', value: 'a\rrm -rf /\r' })).toEqual({ ok: false, error: 'invalid' })
    expect(w.submit({ paneId: 'p', promptId: 'prompt-1', value: '' })).toEqual({ ok: false, error: 'invalid' })
    expect(w.submit({ paneId: 'p', promptId: 'prompt-1', value: 42 })).toEqual({ ok: false, error: 'invalid' })
    expect(writes).toEqual([])
    // Still pending: a valid answer goes through.
    expect(w.submit({ paneId: 'p', promptId: 'prompt-1', value: 'ok' })).toEqual({ ok: true })
  })

  it('keyboard-interactive may be answered empty', () => {
    const { w, writes } = setup()
    w.watch('p', { hostId: 'h' })
    w.onData('p', '(me@srv) Verification code: ')
    vi.advanceTimersByTime(SETTLE_MS)
    expect(w.submit({ paneId: 'p', promptId: 'prompt-1', value: '' })).toEqual({ ok: true })
    expect(writes).toEqual([{ id: 'p', data: '\r' }])
  })

  it('the dialog goes when the prompt is answered in the terminal, when ssh exits, or after 2 minutes', () => {
    const { w, sent } = setup()
    const resolved = () => sent.filter((s) => s.ch === 'ssh:credential-resolved').map((s) => s.payload.promptId)
    w.watch('p', { hostId: 'h' })
    w.onData('p', 'Password: ')
    vi.advanceTimersByTime(SETTLE_MS)
    w.onData('p', '\r\n') // typed in the terminal
    expect(resolved()).toEqual(['prompt-1'])
    expect(w.submit({ paneId: 'p', promptId: 'prompt-1', value: 'x' }).ok).toBe(false)
    w.onData('p', 'Password: ')
    vi.advanceTimersByTime(SETTLE_MS)
    w.onExit('p')
    expect(resolved()).toEqual(['prompt-1', 'prompt-2'])
    w.watch('q', { hostId: 'h' })
    w.onData('q', 'Password: ')
    vi.advanceTimersByTime(SETTLE_MS + CREDENTIAL_TIMEOUT_MS)
    expect(resolved()).toEqual(['prompt-1', 'prompt-2', 'prompt-3'])
  })

  it('an unwatched pane (a local shell) is never looked at', () => {
    const { w, sent } = setup()
    w.onData('local', 'Password: ')
    vi.advanceTimersByTime(SETTLE_MS)
    expect(sent).toEqual([])
  })
})

describe('ssh:submitCredential IPC and the secret', () => {
  let dir
  beforeEach(() => {
    vi.useFakeTimers()
    dir = mkdtempSync(join(tmpdir(), 'tessel-sshprompt-'))
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  it('one handler; the secret is written to the pane only: no log, no file, no broadcast', async () => {
    const SECRET = 'S3cr3t-Pa55!'
    const log = createLogger({ dir, minLevel: 'debug' })
    const logSpies = ['debug', 'info', 'warn', 'error'].filter((k) => typeof log[k] === 'function').map((k) => vi.spyOn(log, k))
    const consoleSpies = ['log', 'info', 'warn', 'error', 'debug'].map((k) => vi.spyOn(console, k).mockImplementation(() => {}))
    const fsSpies = ['writeFileSync', 'appendFileSync', 'writeFile', 'appendFile', 'createWriteStream'].map((k) => vi.spyOn(fs, k))
    const handlers = {}
    const sent = []
    const writes = []
    const hosts = createRemoteHosts({ dir, home: dir, sshExe: () => 'ssh.exe', onChange: (st) => sent.push({ ch: 'remoteHosts:state', st }) })
    const { target } = hosts.add({ host: 'srv' })
    hosts.paneStarted('pane-1', target.id, { connected: false })
    const watcher = createSshPromptWatcher({
      send: (ch, payload) => sent.push({ ch, payload }),
      write: (id, data) => writes.push({ id, data }),
      onConnected: (id) => hosts.paneConnected(id),
      newId: () => 'prompt-x'
    })
    registerSshPrompts({ ipcMain: { handle: (ch, fn) => (handlers[ch] = fn) }, watcher })
    expect(Object.keys(handlers)).toEqual(['ssh:submitCredential'])

    watcher.watch('pane-1', { hostId: target.id, label: 'srv' })
    watcher.onData('pane-1', "me@srv's password: ")
    vi.advanceTimersByTime(SETTLE_MS)
    const args = { paneId: 'pane-1', promptId: 'prompt-x', value: SECRET }
    expect(await handlers['ssh:submitCredential'](null, args)).toEqual({ ok: true })
    // The argument object no longer holds it.
    expect(args.value).toBe(undefined)
    expect(writes).toEqual([{ id: 'pane-1', data: `${SECRET}\r` }])
    // Replayed: refused.
    expect(await handlers['ssh:submitCredential'](null, { paneId: 'pane-1', promptId: 'prompt-x', value: SECRET })).toEqual({ ok: false, error: 'stale' })
    expect(await handlers['ssh:submitCredential'](null, null)).toEqual({ ok: false, error: 'stale' })

    expect(hosts.snapshot()[target.id].status).toBe('connecting')
    watcher.onData('pane-1', '\r\nWelcome\r\nme@srv:~$ ')
    vi.advanceTimersByTime(SETTLE_MS + CONNECTED_QUIET_MS)
    expect(hosts.snapshot()[target.id].status).toBe('connected')

    const everything = JSON.stringify([
      sent,
      logSpies.map((s) => s.mock.calls),
      consoleSpies.map((s) => s.mock.calls),
      fsSpies.map((s) => s.mock.calls.map((c) => c.map((x) => (typeof x === 'string' || Buffer.isBuffer(x) ? String(x) : '')))),
    ])
    expect(everything).not.toContain(SECRET)
    for (const f of fs.readdirSync(dir)) {
      const p = join(dir, f)
      if (fs.statSync(p).isFile()) expect(fs.readFileSync(p, 'utf8')).not.toContain(SECRET)
    }
  })
})
