// SSH questions through OpenSSH's askpass (sshAskpass.js): what ssh asks and
// how it is shown, the pipe and its tokens, the one-time request ids, the
// connected / cancelled transitions, and the secret never reaching a log, a
// file, a broadcast or a terminal. Includes Codex's repros of the screen-
// reading version (4158647) and, on Windows, the real helper
// (src/main/askpass/TesselAskpass.cs) started by the real ssh-keygen.exe
// with SSH_ASKPASS_REQUIRE=force on a throwaway key. ssh never connects
// anywhere.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import net from 'node:net'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile, execFileSync } from 'node:child_process'
import {
  classifyAskpassPrompt,
  parseSshVersion,
  supportsAskpassRequire,
  askpassExePath,
  createSshAskpass,
  registerSshAskpass,
  CREDENTIAL_TIMEOUT_MS,
  CONNECTED_AFTER_START_MS,
  CONNECTED_AFTER_ANSWER_MS
} from '../sshAskpass'
import { createRemoteHosts } from '../remoteHosts'
import { createLogger } from '../logger'
import { buildAskpass } from '../../../scripts/build-askpass.mjs'

const HOSTKEY = [
  "The authenticity of host 'srv (10.0.0.5)' can't be established.",
  'ED25519 key fingerprint is SHA256:AbCd+Ef//0123456789abcdef0123456789ABCDEFgh.',
  'This key is not known by any other names.',
  'Are you sure you want to continue connecting (yes/no/[fingerprint])? '
].join('\r\n')

describe('classifyAskpassPrompt: what ssh asks', () => {
  it.each([
    ["deploy@148.113.224.19's password: ", 'password', 'deploy@148.113.224.19'],
    ['(deploy@srv) Password: ', 'password', 'deploy@srv'],
    ['(deploy@srv) Password for deploy@srv: ', 'password', 'deploy@srv'],
    ["Enter passphrase for key 'C:\\Users\\me/.ssh/id_ed25519': ", 'passphrase', 'C:\\Users\\me/.ssh/id_ed25519'],
    ['Enter passphrase for C:\\Users\\me/.ssh/id_rsa: ', 'passphrase', 'C:\\Users\\me/.ssh/id_rsa'],
    ['Enter passphrase: ', 'passphrase', ''],
    ['(deploy@srv) Verification code: ', 'keyboard-interactive', 'Verification code'],
    ['Enter PIN for ECDSA-SK key C:\\k: ', 'keyboard-interactive', 'Enter PIN for ECDSA-SK key C:\\k'],
    ['Accept updated hostkeys? (yes/no): ', 'confirm', 'Accept updated hostkeys? (yes/no):']
  ])('%j -> %s', (prompt, kind, detail) => {
    expect(classifyAskpassPrompt(prompt)).toMatchObject({ kind, detail })
  })

  it('the host key question keeps ssh\'s whole text, fingerprint included', () => {
    const q = classifyAskpassPrompt(HOSTKEY)
    expect(q.kind).toBe('hostkey')
    expect(q.detail).toContain('SHA256:AbCd+Ef//0123456789abcdef0123456789ABCDEFgh')
    expect(q.detail).toContain("host 'srv (10.0.0.5)'")
    expect(q.detail).not.toContain('\r')
  })

  it('a server\'s keyboard-interactive text dressed as a host key question stays a challenge', () => {
    expect(classifyAskpassPrompt('(u@srv) Are you sure you want to continue connecting (yes/no)? ').kind).toBe('keyboard-interactive')
  })

  it('a wrong passphrase is a retry; SSH_ASKPASS_PROMPT picks confirm / notice', () => {
    expect(classifyAskpassPrompt('Bad passphrase, try again for C:\\k\\id: ')).toMatchObject({ kind: 'passphrase', detail: 'C:\\k\\id', retry: true })
    expect(classifyAskpassPrompt('Allow use of key k?', 'confirm')).toMatchObject({ kind: 'confirm' })
    expect(classifyAskpassPrompt('Confirm user presence for key', 'none')).toEqual({ notice: true })
  })

  it('control characters go (the text is only shown)', () => {
    expect(classifyAskpassPrompt('\x1b[31mVerification\x07 code: ').detail).toBe('[31mVerification code')
  })
})

describe('ssh.exe version and the helper path', () => {
  it('SSH_ASKPASS_REQUIRE needs OpenSSH 8.4', () => {
    expect(parseSshVersion('OpenSSH_for_Windows_9.5p2, LibreSSL 3.8.2')).toEqual({ major: 9, minor: 5 })
    expect(supportsAskpassRequire('OpenSSH_for_Windows_9.5p2, LibreSSL 3.8.2')).toBe(true)
    expect(supportsAskpassRequire('OpenSSH_8.4p1')).toBe(true)
    expect(supportsAskpassRequire('OpenSSH_for_Windows_8.1p1, LibreSSL 3.0.2')).toBe(false)
    expect(supportsAskpassRequire('OpenSSH_for_Windows_7.7p1')).toBe(false)
    expect(supportsAskpassRequire('garbage')).toBe(false)
  })

  it('in a packaged app the helper is taken from app.asar.unpacked', () => {
    expect(askpassExePath('C:\\Tessel\\resources\\app.asar\\out\\main', () => true)).toBe(
      join('C:\\Tessel\\resources\\app.asar.unpacked\\out\\main', 'tessel-askpass.exe')
    )
    expect(askpassExePath('C:\\dev\\out\\main', () => false)).toBe(null)
  })
})

// --- The broker over a real named pipe ----------------------------------------------
function clock() {
  let now = 0
  let n = 0
  const jobs = new Map()
  return {
    timers: {
      setTimeout(fn, ms) {
        jobs.set(++n, { at: now + ms, fn })
        return n
      },
      clearTimeout(id) {
        jobs.delete(id)
      }
    },
    advance(ms) {
      const end = now + ms
      for (;;) {
        const first = [...jobs].sort((a, b) => a[1].at - b[1].at)[0]
        if (!first || first[1].at > end) break
        now = first[1].at
        jobs.delete(first[0])
        first[1].fn()
      }
      now = end
    }
  }
}

const B64 = (s) => Buffer.from(s, 'utf8').toString('base64')
const pipePath = (name) => `\\\\.\\pipe\\${name}`

// What the helper does: one question, one answer line.
function ask(env, prompt, { mode = '', raw = null } = {}) {
  return new Promise((resolve) => {
    const s = net.connect(pipePath(env.TESSEL_ASKPASS_PIPE))
    let out = ''
    s.setEncoding('utf8')
    s.on('data', (d) => (out += d))
    s.on('close', () => resolve(out))
    s.on('error', () => resolve(out || 'ERROR'))
    s.on('connect', () => s.write(raw !== null ? raw : `TESSEL-ASKPASS 1 ${env.TESSEL_ASKPASS_TOKEN} ${B64(mode)} ${B64(prompt)}\n`))
  })
}
const answerOf = (line) => (line.startsWith('OK ') ? Buffer.from(line.slice(3).trim(), 'base64').toString('utf8') : null)
const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 5))
  }
}

function fixture(extra = {}) {
  const c = clock()
  const sent = []
  const writes = []
  const events = []
  let n = 0
  const broker = createSshAskpass({
    helperPath: () => 'C:\\fake\\tessel-askpass.exe',
    runFile: (_f, _a, _o, cb) => cb(null, '', 'OpenSSH_for_Windows_9.5p2, LibreSSL 3.8.2'),
    send: (channel, data) => sent.push({ channel, data }),
    writePty: (id, data) => writes.push({ id, data }),
    onConnected: (id) => events.push(['connected', id]),
    onConnecting: (id) => events.push(['connecting', id]),
    onCancel: (id, hostId) => events.push(['cancel', id, hostId]),
    newId: () => `req-${++n}`,
    timers: c.timers,
    ...extra
  })
  const requests = () => sent.filter((x) => x.channel === 'ssh:credential-request').map((x) => x.data)
  const resolved = () => sent.filter((x) => x.channel === 'ssh:credential-resolved').map((x) => x.data.promptId)
  return { ...c, broker, sent, writes, events, requests, resolved }
}

describe('the askpass broker', () => {
  const opened = []
  afterEach(() => {
    for (const b of opened.splice(0)) b.close()
  })
  async function pane(f, id = 'p', opts = {}) {
    if (!opened.includes(f.broker)) opened.push(f.broker)
    const env = await f.broker.preparePane(id, { hostId: 'host-1', label: 'Fixture', sshExe: 'ssh.exe', ...opts })
    f.broker.paneStarted(id)
    return env
  }

  it('gives ssh the helper, force, the pipe and a pane token', async () => {
    const f = fixture()
    const env = await pane(f)
    expect(env).toEqual({
      SSH_ASKPASS: 'C:\\fake\\tessel-askpass.exe',
      SSH_ASKPASS_REQUIRE: 'force',
      TESSEL_ASKPASS_PIPE: expect.stringMatching(/^tessel-askpass-[0-9a-f]{32}$/),
      TESSEL_ASKPASS_TOKEN: expect.stringMatching(/^[0-9a-f]{64}$/)
    })
    const other = await pane(f, 'q')
    expect(other.TESSEL_ASKPASS_TOKEN).not.toBe(env.TESSEL_ASKPASS_TOKEN)
    expect(other.TESSEL_ASKPASS_PIPE).toBe(env.TESSEL_ASKPASS_PIPE)
  })

  it('falls back to the terminal (null) with an old ssh or no helper', async () => {
    const old = fixture({ runFile: (_f, _a, _o, cb) => cb(null, '', 'OpenSSH_for_Windows_8.1p1') })
    opened.push(old.broker)
    expect(await old.broker.preparePane('p', { sshExe: 'ssh.exe' })).toBe(null)
    const none = fixture({ helperPath: () => null })
    opened.push(none.broker)
    expect(await none.broker.preparePane('p', { sshExe: 'ssh.exe' })).toBe(null)
  })

  it('a question -> the dialog; the answer goes back to that helper only, once', async () => {
    const f = fixture()
    const env = await pane(f)
    const reply = ask(env, "me@srv's password: ")
    await until(() => f.requests().length === 1)
    expect(f.requests()[0]).toEqual({ paneId: 'p', promptId: 'req-1', hostId: 'host-1', label: 'Fixture', kind: 'password', detail: 'me@srv', retry: false })
    expect(f.broker.submit({ paneId: 'q', promptId: 'req-1', value: 'hunter2' })).toEqual({ ok: false, error: 'stale' })
    expect(f.broker.submit({ paneId: 'p', promptId: 'nope', value: 'hunter2' })).toEqual({ ok: false, error: 'stale' })
    expect(f.broker.submit({ paneId: 'p', promptId: 'req-1', value: 'a\nb' })).toEqual({ ok: false, error: 'invalid' })
    expect(f.broker.submit({ paneId: 'p', promptId: 'req-1', value: '' })).toEqual({ ok: false, error: 'invalid' })
    expect(f.broker.submit({ paneId: 'p', promptId: 'req-1', value: 'hunter2' })).toEqual({ ok: true })
    expect(answerOf(await reply)).toBe('hunter2')
    expect(f.broker.submit({ paneId: 'p', promptId: 'req-1', value: 'hunter2' })).toEqual({ ok: false, error: 'stale' })
    expect(f.resolved()).toEqual(['req-1'])
    // Never through the terminal.
    expect(f.writes).toEqual([])
  })

  it('refuses unknown tokens, malformed lines, and a token after its pane exited', async () => {
    const f = fixture()
    const env = await pane(f)
    expect(await ask({ ...env, TESSEL_ASKPASS_TOKEN: 'f'.repeat(64) }, 'Password: ')).toBe('NO\n')
    expect(await ask(env, '', { raw: 'hello\n' })).toBe('NO\n')
    expect(await ask(env, '', { raw: `TESSEL-ASKPASS 1 ${env.TESSEL_ASKPASS_TOKEN} !! ${B64('x')}\n` })).toBe('NO\n')
    f.broker.paneExited('p')
    expect(await ask(env, "me@srv's password: ")).toBe('NO\n')
    expect(f.requests()).toEqual([])
  })

  it('a connection that never sends its question is dropped', async () => {
    const f = fixture()
    const env = await pane(f)
    const s = net.connect(pipePath(env.TESSEL_ASKPASS_PIPE))
    const closed = new Promise((r) => s.on('close', r))
    s.on('error', () => {})
    await new Promise((r) => s.on('connect', r))
    s.write('TESSEL-ASKPASS 1 ')
    await new Promise((r) => setTimeout(r, 20))
    f.advance(5000)
    await closed
    expect(f.requests()).toEqual([])
  })

  it('a token is bound to its pane: another pane\'s request id cannot answer it', async () => {
    const f = fixture()
    const a = await pane(f, 'a')
    const b = await pane(f, 'b')
    const ra = ask(a, "me@a's password: ")
    const rb = ask(b, "me@b's password: ")
    await until(() => f.requests().length === 2)
    const ida = f.requests().find((r) => r.paneId === 'a').promptId
    const idb = f.requests().find((r) => r.paneId === 'b').promptId
    expect(f.broker.submit({ paneId: 'a', promptId: idb, value: 'x' })).toEqual({ ok: false, error: 'stale' })
    f.broker.submit({ paneId: 'a', promptId: ida, value: 'for-a' })
    f.broker.submit({ paneId: 'b', promptId: idb, value: 'for-b' })
    expect([answerOf(await ra), answerOf(await rb)]).toEqual(['for-a', 'for-b'])
  })

  it('host key: Yes / No only, never a password', async () => {
    const f = fixture()
    const env = await pane(f)
    const reply = ask(env, HOSTKEY)
    await until(() => f.requests().length === 1)
    const req = f.requests()[0]
    expect(req.kind).toBe('hostkey')
    expect(req.detail).toContain('SHA256:AbCd+Ef//0123456789abcdef0123456789ABCDEFgh')
    expect(f.broker.submit({ paneId: 'p', promptId: req.promptId, value: 'hunter2' })).toEqual({ ok: false, error: 'invalid' })
    expect(f.broker.submit({ paneId: 'p', promptId: req.promptId, value: 'yes' })).toEqual({ ok: true })
    expect(answerOf(await reply)).toBe('yes')
  })

  it('host key No: ssh is told no, the host ends up disconnected (not an error)', async () => {
    const f = fixture()
    const env = await pane(f)
    const reply = ask(env, HOSTKEY)
    await until(() => f.requests().length === 1)
    f.broker.submit({ paneId: 'p', promptId: 'req-1', value: 'no' })
    expect(answerOf(await reply)).toBe('no')
    expect(f.events).toContainEqual(['cancel', 'p', 'host-1'])
  })

  it('Cancel: Ctrl+C to that pane, no answer to the helper, host marked disconnecting', async () => {
    const f = fixture()
    const env = await pane(f)
    const reply = ask(env, "me@srv's password: ")
    await until(() => f.requests().length === 1)
    expect(f.broker.submit({ paneId: 'p', promptId: 'req-1', value: null })).toEqual({ ok: true })
    expect(await reply).toBe('NO\n')
    expect(f.writes).toEqual([{ id: 'p', data: '\x03' }])
    expect(f.events).toContainEqual(['cancel', 'p', 'host-1'])
  })

  it('unanswered for 2 minutes: the dialog goes and the helper gets no answer', async () => {
    const f = fixture()
    const env = await pane(f)
    const reply = ask(env, "me@srv's password: ")
    await until(() => f.requests().length === 1)
    f.advance(CREDENTIAL_TIMEOUT_MS)
    expect(await reply).toBe('NO\n')
    expect(f.resolved()).toEqual(['req-1'])
    expect(f.broker.submit({ paneId: 'p', promptId: 'req-1', value: 'late' })).toEqual({ ok: false, error: 'stale' })
  })

  it('the helper ending first (Ctrl+C in the pane) closes the dialog', async () => {
    const f = fixture()
    const env = await pane(f)
    const s = net.connect(pipePath(env.TESSEL_ASKPASS_PIPE))
    s.on('error', () => {})
    await new Promise((r) => s.on('connect', r))
    s.write(`TESSEL-ASKPASS 1 ${env.TESSEL_ASKPASS_TOKEN} ${B64('')} ${B64("me@srv's password: ")}\n`)
    await until(() => f.requests().length === 1)
    s.destroy()
    await until(() => f.resolved().length === 1)
    expect(f.broker.submit({ paneId: 'p', promptId: 'req-1', value: 'x' })).toEqual({ ok: false, error: 'stale' })
  })

  it('connected: after the start without questions, or after the last answer; a new question goes back to connecting', async () => {
    const f = fixture()
    const env = await pane(f)
    f.advance(CONNECTED_AFTER_START_MS - 1)
    expect(f.events).toEqual([])
    const reply = ask(env, "me@srv's password: ")
    await until(() => f.requests().length === 1)
    f.advance(60_000)
    expect(f.events).toEqual([]) // waiting on the user
    f.broker.submit({ paneId: 'p', promptId: 'req-1', value: 'wrong' })
    await reply
    // Wrong: ssh asks again before the delay ends -> a retry.
    f.advance(CONNECTED_AFTER_ANSWER_MS - 1)
    const again = ask(env, "me@srv's password: ")
    await until(() => f.requests().length === 2)
    expect(f.requests()[1].retry).toBe(true)
    f.broker.submit({ paneId: 'p', promptId: 'req-2', value: 'right' })
    await again
    f.advance(CONNECTED_AFTER_ANSWER_MS)
    expect(f.events).toEqual([['connected', 'p']])
    // Something asked later (a jump host, a key): Connecting again.
    const later = ask(env, 'Enter passphrase for key C:\\k: ')
    await until(() => f.requests().length === 3)
    expect(f.events).toEqual([['connected', 'p'], ['connecting', 'p']])
    f.broker.submit({ paneId: 'p', promptId: 'req-3', value: 'pp' })
    await later
  })

  it('a notice (SSH_ASKPASS_PROMPT=none) is answered at once, without a dialog', async () => {
    const f = fixture()
    const env = await pane(f)
    expect(await ask(env, 'Confirm user presence for key ED25519-SK', { mode: 'none' })).toBe('OK \n')
    expect(f.requests()).toEqual([])
  })
})

// --- Codex's review of 4158647 (design/check-ssh-prompts-review.cjs), redone ------
describe('Codex repros: nothing leaks any more', () => {
  const opened = []
  afterEach(() => {
    for (const b of opened.splice(0)) b.close()
  })

  it('a stale password id cannot answer the host key question that follows', async () => {
    const f = fixture()
    opened.push(f.broker)
    const env = await f.broker.preparePane('p', { hostId: 'fixture-host', label: 'Fixture', sshExe: 'ssh.exe' })
    f.broker.paneStarted('p')
    const pw = ask(env, "u@host's password: ")
    await until(() => f.requests().length === 1)
    const old = f.requests()[0]
    const hk = ask(env, HOSTKEY)
    await until(() => f.requests().length === 2)
    // The new question withdrew the old one: its helper got no answer.
    expect(await pw).toBe('NO\n')
    expect(f.resolved()).toContain(old.promptId)
    expect(f.broker.submit({ paneId: 'p', promptId: old.promptId, value: 'yes' })).toEqual({ ok: false, error: 'stale' })
    const cur = f.requests()[1]
    expect(cur.promptId).not.toBe(old.promptId)
    expect(f.broker.submit({ paneId: 'p', promptId: cur.promptId, value: 'fixture-old-password' })).toEqual({ ok: false, error: 'invalid' })
    f.broker.submit({ paneId: 'p', promptId: cur.promptId, value: 'no' })
    expect(answerOf(await hk)).toBe('no')
    expect(f.writes).toEqual([])
  })

  it('a changed challenge gets a new id; the old one is refused', async () => {
    const f = fixture()
    opened.push(f.broker)
    const env = await f.broker.preparePane('p', { hostId: 'fixture-host', sshExe: 'ssh.exe' })
    f.broker.paneStarted('p')
    const first = ask(env, "u@host's password: ")
    await until(() => f.requests().length === 1)
    const otp = ask(env, '(other@host) Verification code: ')
    await until(() => f.requests().length === 2)
    expect(await first).toBe('NO\n')
    expect(f.broker.submit({ paneId: 'p', promptId: f.requests()[0].promptId, value: 'fixture-old-password' })).toEqual({ ok: false, error: 'stale' })
    expect(f.requests()[1]).toMatchObject({ kind: 'keyboard-interactive', detail: 'Verification code' })
    f.broker.submit({ paneId: 'p', promptId: f.requests()[1].promptId, value: '123456' })
    expect(answerOf(await otp)).toBe('123456')
    expect(f.writes).toEqual([])
  })

  it('a remote program printing "Password:" opens nothing: there is no screen reading at all', async () => {
    const f = fixture()
    opened.push(f.broker)
    await f.broker.preparePane('p', { hostId: 'fixture-host', sshExe: 'ssh.exe' })
    f.broker.paneStarted('p')
    // The broker has no way to be fed terminal output...
    expect(Object.keys(f.broker)).not.toContain('onData')
    // ...and index.js no longer hands pty output to any SSH code.
    const main = fs.readFileSync(join(__dirname, '..', 'index.js'), 'utf8')
    expect(main).not.toMatch(/sshPrompts|detectSshPrompt|SSH_PROMPT_DIALOG/)
    const onData = /onData: \(id, data\) => \{([\s\S]*?)\n  \},/.exec(main)[1]
    expect(onData).not.toMatch(/ssh/i)
    expect(existsSync(join(__dirname, '..', 'sshPrompts.js'))).toBe(false)
    expect(f.requests()).toEqual([])
    expect(f.writes).toEqual([])
  })
})

describe('ssh:submitCredential IPC and the secret', () => {
  let dir
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'tessel-askpass-'))
  })
  afterAll(() => {
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  it('one handler; the secret reaches the helper only: no log, no file, no broadcast, no terminal', async () => {
    const SECRET = 'S3cr3t-Pa55!'
    const log = createLogger({ dir, minLevel: 'debug' })
    const logSpies = ['debug', 'info', 'warn', 'error'].filter((k) => typeof log[k] === 'function').map((k) => vi.spyOn(log, k))
    const consoleSpies = ['log', 'info', 'warn', 'error', 'debug'].map((k) => vi.spyOn(console, k).mockImplementation(() => {}))
    const fsSpies = ['writeFileSync', 'appendFileSync', 'writeFile', 'appendFile', 'createWriteStream'].map((k) => vi.spyOn(fs, k))
    const handlers = {}
    const hosts = createRemoteHosts({ dir, home: dir, sshExe: () => 'ssh.exe', onChange: () => {} })
    const { target } = hosts.add({ host: 'srv' })
    const f = fixture({
      log,
      onConnected: (id) => hosts.paneConnected(id),
      onConnecting: (id) => hosts.paneConnecting(id)
    })
    try {
      registerSshAskpass({ ipcMain: { handle: (ch, fn) => (handlers[ch] = fn) }, broker: f.broker })
      expect(Object.keys(handlers)).toEqual(['ssh:submitCredential'])
      const env = await f.broker.preparePane('pane-1', { hostId: target.id, label: 'srv', sshExe: 'ssh.exe' })
      hosts.paneStarted('pane-1', target.id, { connected: false })
      f.broker.paneStarted('pane-1')
      const reply = ask(env, "me@srv's password: ")
      await until(() => f.requests().length === 1)
      const args = { paneId: 'pane-1', promptId: 'req-1', value: SECRET }
      expect(await handlers['ssh:submitCredential'](null, args)).toEqual({ ok: true })
      expect(args.value).toBe(undefined)
      expect(answerOf(await reply)).toBe(SECRET)
      expect(await handlers['ssh:submitCredential'](null, { paneId: 'pane-1', promptId: 'req-1', value: SECRET })).toEqual({ ok: false, error: 'stale' })
      expect(await handlers['ssh:submitCredential'](null, null)).toEqual({ ok: false, error: 'stale' })
      expect(hosts.snapshot()[target.id].status).toBe('connecting')
      f.advance(CONNECTED_AFTER_ANSWER_MS)
      expect(hosts.snapshot()[target.id].status).toBe('connected')

      const everything = JSON.stringify([
        f.sent,
        f.writes,
        logSpies.map((s) => s.mock.calls),
        consoleSpies.map((s) => s.mock.calls),
        fsSpies.map((s) => s.mock.calls.map((c) => c.map((x) => (typeof x === 'string' || Buffer.isBuffer(x) ? String(x) : ''))))
      ])
      expect(everything).not.toContain(SECRET)
      expect(everything).not.toContain(Buffer.from(SECRET).toString('base64'))
      for (const name of fs.readdirSync(dir)) {
        const p = join(dir, name)
        if (fs.statSync(p).isFile()) expect(fs.readFileSync(p, 'utf8')).not.toContain(SECRET)
      }
    } finally {
      f.broker.close()
    }
  })
})

// --- The real helper, and the real Win32-OpenSSH starting it -------------------------
const onWindows = process.platform === 'win32'
const sysRoot = process.env.SystemRoot || 'C:\\Windows'
const sshKeygen = join(sysRoot, 'System32', 'OpenSSH', 'ssh-keygen.exe')

describe.runIf(onWindows)('the helper (tessel-askpass.exe)', () => {
  let dir
  let exe
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'tessel-askpass-exe-'))
    const res = buildAskpass(join(dir, 'tessel-askpass.exe'))
    exe = res.ok ? res.file : null
  }, 60_000)
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const opened = []
  afterEach(() => {
    for (const b of opened.splice(0)) b.close()
  })

  function realFixture() {
    const f = fixture({ helperPath: () => exe, timers: { setTimeout, clearTimeout } })
    opened.push(f.broker)
    return f
  }
  function runHelper(env, args) {
    return new Promise((resolve) => {
      execFile(exe, args, { env: { SystemRoot: sysRoot, ...env }, windowsHide: true, encoding: 'buffer' }, (err, stdout) =>
        resolve({ code: err ? err.code : 0, out: stdout.toString('utf8') })
      )
    })
  }

  it('is built', () => {
    expect(exe).toBeTruthy()
  })

  it('passes a multi-line prompt with quotes, %, & and a leading -- as plain text; prints the answer with no line break', async () => {
    const f = realFixture()
    const env = await f.broker.preparePane('p', { hostId: 'h', sshExe: 'ssh.exe' })
    f.broker.paneStarted('p')
    const nasty = `--eval=process.exit(7) "q" %PATH% & echo x\n${HOSTKEY}`
    const run = runHelper(env, [nasty])
    await until(() => f.requests().length === 1, 10_000)
    expect(f.requests()[0].kind).toBe('hostkey')
    expect(f.requests()[0].detail).toBe(nasty.replace(/\r\n/g, '\n').trim())
    f.broker.submit({ paneId: 'p', promptId: 'req-1', value: 'yes' })
    expect(await run).toEqual({ code: 0, out: 'yes' })
  }, 20_000)

  it('exits 1 on cancel, on an unknown token, and without Tessel', async () => {
    const f = realFixture()
    const env = await f.broker.preparePane('p', { hostId: 'h', sshExe: 'ssh.exe' })
    f.broker.paneStarted('p')
    const run = runHelper(env, ["u@h's password: "])
    await until(() => f.requests().length === 1, 10_000)
    f.broker.submit({ paneId: 'p', promptId: 'req-1', value: null })
    expect(await run).toEqual({ code: 1, out: '' })
    expect(await runHelper({ ...env, TESSEL_ASKPASS_TOKEN: '0'.repeat(64) }, ['Password: '])).toEqual({ code: 1, out: '' })
    expect(await runHelper({ ...env, TESSEL_ASKPASS_PIPE: `tessel-askpass-${'0'.repeat(32)}` }, ['Password: '])).toEqual({ code: 1, out: '' })
    expect(await runHelper({}, ['Password: '])).toEqual({ code: 1, out: '' })
  }, 30_000)

  it.runIf(existsSync(sshKeygen))('Win32-OpenSSH starts it with SSH_ASKPASS_REQUIRE=force (no DISPLAY) and reads its answer', async () => {
    const key = join(dir, 'throwaway_ed25519')
    execFileSync(sshKeygen, ['-q', '-t', 'ed25519', '-N', 'fixture-passphrase', '-C', 'fixture', '-f', key], { windowsHide: true, stdio: 'ignore' })
    const f = realFixture()
    const ssh = join(sysRoot, 'System32', 'OpenSSH', 'ssh.exe')
    const env = await f.broker.preparePane('p', { hostId: 'h', sshExe: ssh })
    expect(env).not.toBe(null) // the installed ssh is 8.4 or later
    f.broker.paneStarted('p')
    const clean = { ...process.env, ...env }
    delete clean.DISPLAY
    const run = new Promise((resolve) => {
      execFile(sshKeygen, ['-y', '-f', key], { env: clean, windowsHide: true }, (err, stdout) => resolve({ code: err ? err.code : 0, out: String(stdout) }))
    })
    await until(() => f.requests().length === 1, 15_000)
    expect(f.requests()[0]).toMatchObject({ kind: 'passphrase' })
    f.broker.submit({ paneId: 'p', promptId: 'req-1', value: 'fixture-passphrase' })
    const res = await run
    expect(res.code).toBe(0)
    expect(res.out).toMatch(/^ssh-ed25519 \S+ fixture/)
  }, 30_000)
})
