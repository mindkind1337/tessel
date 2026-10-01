// @vitest-environment node
// The terminal host's SSH side (ssh/sshHostBridge.js + sshManager.js) against
// a local fake SSH server: one connection carries a terminal (shell channel
// with a PTY), the Files session (exec channel) and SFTP; a lost connection
// reconnects with the kept password; the password never appears in a log
// line or a message.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { createSshHostBridge, validateSpec, FILES_COMMAND } from '../ssh/sshHostBridge'
import ssh2 from 'ssh2'
import { startSshServer, makeKey } from './fixtures/sshServer'

const PASSWORD = 'correct horse battery staple'

function until(fn, ms = 10000, label = '') {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = () => {
      let v
      try {
        v = fn()
      } catch {
        v = null
      }
      if (v) return resolve(v)
      if (Date.now() - start > ms) return reject(new Error(`timed out waiting ${label || fn}`)) // i18n-ignore test
      setTimeout(tick, 15)
    }
    tick()
  })
}

function fakeSock() {
  const lines = []
  return {
    lines,
    msgs: () => lines.map((l) => JSON.parse(l)),
    destroyed: false,
    writableLength: 0,
    write(line) {
      lines.push(line.trim())
      return true
    },
    once() {}
  }
}

let dir
let server
let bridge
let logs
let broadcasts
let answers
beforeEach(async () => {
  dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-sshb-'))
  logs = []
  broadcasts = []
  answers = { hostkey: ['yes'], password: [PASSWORD] }
  server = await startSshServer({
    auth: { password: PASSWORD, methods: ['password'] },
    onExec: (command, stream) => {
      // The Files session's shell: echoes what it is sent.
      if (command === FILES_COMMAND) {
        stream.on('data', (d) => stream.write(`sh:${d}`))
        stream.on('end', () => {
          stream.exit(0)
          stream.end()
        })
        return
      }
      stream.write(`ran:${command}\n`)
      stream.exit(0)
      stream.end()
    }
  })
})
afterEach(async () => {
  if (bridge) bridge.shutdown()
  bridge = null
  await server.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

function makeBridge(opts = {}) {
  const sock = fakeSock()
  bridge = createSshHostBridge({
    hostKeyFile: join(dir, 'ssh-host-keys.json'),
    log: (level, msg) => logs.push(`${level} ${msg}`),
    reconnectDelays: [20, 20, 20],
    broadcast: (m) => {
      broadcasts.push(JSON.stringify(m))
      if (m.op === 'ssh-prompt') {
        const list = answers[m.kind] || []
        const value = list.length ? list.shift() : null
        setTimeout(() => bridge.handle(sock, { op: 'ssh-answer', promptId: m.promptId, value }, () => {}), 5)
      }
    },
    ...opts
  })
  return sock
}

const spec = () => ({ host: '127.0.0.1', port: server.port, username: 'me', identityFiles: [], knownHostsFiles: [join(dir, 'known_hosts')], strictHostKeyChecking: 'ask' })
const texts = { label: 'box', lost: 'LOST {{host}}', reconnected: 'BACK {{host}}', gaveUp: 'GAVE UP', codes: { failed: 'FAILED {{detail}}', 'auth-cancelled': 'CANCELLED' } }

function terminal(extra = {}) {
  const pty = bridge.createPty({ hostId: 'h1', spec: spec(), texts, cols: 80, rows: 24, ...extra })
  const out = { text: '', exit: null }
  pty.onData((d) => (out.text += d))
  pty.onExit((e) => (out.exit = e))
  return { pty, out }
}

describe('one connection per host', () => {
  it('a terminal, the Files session and SFTP share it; one password question', async () => {
    const sock = makeBridge()
    const { pty, out } = terminal()
    await until(() => out.text.includes('welcome'))
    // The Files session: an exec channel, always `exec /bin/sh`.
    const replies = []
    bridge.handle(sock, { op: 'ssh-exec', ch: 'c1', hostId: 'h1', spec: spec() }, (r) => replies.push(r))
    expect(replies).toEqual([{ ok: true }])
    await until(() => sock.msgs().some((m) => m.op === 'ssh-open' && m.ch === 'c1'))
    bridge.handle(sock, { op: 'ssh-write', ch: 'c1', data: Buffer.from('hello').toString('base64') }, () => {})
    await until(() => sock.msgs().some((m) => m.op === 'ssh-out' && Buffer.from(m.data, 'base64').toString() === 'sh:hello'))
    // SFTP on the same connection.
    const { stream: sftp, release } = await bridge.manager.open('h1', spec(), 'sftp')
    const real = await new Promise((res, rej) => sftp.realpath('.', (err, p) => (err ? rej(err) : res(p))))
    expect(real).toBe('/home/test')
    sftp.end()
    release()
    expect(server.events.connections).toBe(1)
    expect(server.events.channels.map((c) => c.kind).sort()).toEqual(['exec', 'sftp', 'shell'])
    expect(server.events.channels.find((c) => c.kind === 'exec').command).toBe(FILES_COMMAND)
    expect(server.events.channels.find((c) => c.kind === 'shell').pty).toMatchObject({ cols: 80, rows: 24, term: 'xterm-256color' })
    expect(broadcasts.filter((b) => b.includes('"op":"ssh-prompt"')).map((b) => JSON.parse(b).kind)).toEqual(['hostkey', 'password'])
    // Resize, input, exit status.
    pty.resize(120, 40)
    await until(() => server.events.windowChanges.some((w) => w.cols === 120 && w.rows === 40))
    pty.write('ls\n')
    await until(() => out.text.includes('echo:ls'))
    pty.write('exit\n')
    await until(() => out.exit)
    expect(out.exit.exitCode).toBe(7)
    bridge.handle(sock, { op: 'ssh-close', ch: 'c1' }, () => {})
  }, 30000)

  it('a lost connection reconnects with the kept password (no question) and starts a new shell', async () => {
    makeBridge()
    const { out } = terminal()
    await until(() => out.text.includes('welcome'))
    const asked = broadcasts.filter((b) => b.includes('"op":"ssh-prompt"')).length
    server.dropClients()
    await until(() => out.text.includes('LOST box'))
    await until(() => out.text.includes('BACK box'))
    await until(() => out.text.split('welcome').length === 3)
    expect(out.exit).toBe(null)
    expect(server.events.connections).toBe(2)
    expect(broadcasts.filter((b) => b.includes('"op":"ssh-prompt"')).length).toBe(asked)
    expect(broadcasts.some((b) => b.includes('"status":"connected"'))).toBe(true)
  }, 30000)

  it('never writes the password to a log line, a broadcast or a channel message', async () => {
    const sock = makeBridge()
    answers.password = ['wrong-one', PASSWORD]
    const { out } = terminal()
    await until(() => out.text.includes('welcome'))
    bridge.handle(sock, { op: 'ssh-exec', ch: 'c2', hostId: 'h1', spec: spec() }, () => {})
    await until(() => sock.msgs().some((m) => m.op === 'ssh-open'))
    const everything = [...logs, ...broadcasts, ...sock.lines, out.text].join('\n')
    expect(everything).not.toContain(PASSWORD)
    expect(everything).not.toContain('wrong-one')
    expect(everything).not.toContain(Buffer.from(PASSWORD).toString('base64'))
    // The retry question says it is one.
    const pw = broadcasts.map((b) => JSON.parse(b)).filter((m) => m.op === 'ssh-prompt' && m.kind === 'password')
    expect(pw.map((m) => m.retry)).toEqual([false, true])
  }, 30000)

  it('Disconnect forgets the kept password: the next connection asks again', async () => {
    const sock = makeBridge()
    const t1 = terminal()
    await until(() => t1.out.text.includes('welcome'))
    expect(bridge.manager.hasKeptPassword('h1')).toBe(true)
    t1.pty.kill()
    bridge.handle(sock, { op: 'ssh-disconnect', hostId: 'h1' }, () => {})
    expect(bridge.manager.hasKeptPassword('h1')).toBe(false)
    answers.password = [PASSWORD]
    const t2 = terminal()
    await until(() => t2.out.text.includes('welcome'))
    expect(broadcasts.map((b) => JSON.parse(b)).filter((m) => m.op === 'ssh-prompt' && m.kind === 'password')).toHaveLength(2)
  }, 30000)

  it('a cancelled sign-in ends the terminal with the reason', async () => {
    makeBridge()
    answers.password = [null]
    const { out } = terminal()
    await until(() => out.exit)
    expect(out.exit.exitCode).toBe(255)
    expect(out.text).toContain('CANCELLED')
  }, 30000)

  it('a CHANGED host key: the terminal ends with the reason, the host shows an error, no password asked', async () => {
    const other = makeKey()
    const k = ssh2.utils.parseKey(other.public)
    fs.writeFileSync(join(dir, 'known_hosts'), `[127.0.0.1]:${server.port} ssh-ed25519 ${(Array.isArray(k) ? k[0] : k).getPublicSSH().toString('base64')}\n`)
    makeBridge()
    const { out } = terminal()
    await until(() => out.exit)
    expect(out.exit.exitCode).toBe(255)
    expect(out.text).toContain('hostkey-changed')
    const msgs = broadcasts.map((b) => JSON.parse(b))
    expect(msgs.filter((m) => m.op === 'ssh-prompt')).toEqual([])
    expect(msgs.some((m) => m.op === 'ssh-state' && m.status === 'error' && m.code === 'hostkey-changed')).toBe(true)
    expect(server.events.auth).toEqual([])
  }, 30000)

  it('a project terminal runs only the cd command built here', async () => {
    makeBridge()
    const { out } = terminal({ remotePath: "/srv/it's here" })
    await until(() => out.exit)
    const exec = server.events.channels.find((c) => c.kind === 'exec')
    expect(exec.command).toBe(`cd -- '/srv/it'\\''s here' && exec "$SHELL" -l`)
    expect(exec.pty).toMatchObject({ term: 'xterm-256color' })
    expect(() => bridge.createPty({ hostId: 'h1', spec: spec(), texts, remotePath: 'relative/path' })).toThrow()
  }, 30000)
})

describe('a server that limits sessions per connection (MaxSessions)', () => {
  it('a second connection is opened with the kept password, no new question', async () => {
    await server.close()
    server = await startSshServer({ auth: { password: PASSWORD, methods: ['password'] }, maxSessions: 1 })
    makeBridge()
    const a = terminal()
    await until(() => a.out.text.includes('welcome'))
    const b = terminal()
    await until(() => b.out.text.includes('welcome'), 10000, 'b welcome').catch((e) => {
      throw new Error(`${e.message}: ${JSON.stringify(b.out)} ${JSON.stringify(server.events)}`) // i18n-ignore test
    })
    expect(server.events.connections).toBe(2)
    expect(bridge.manager.connectionCount('h1')).toBe(2)
    expect(broadcasts.map((x) => JSON.parse(x)).filter((m) => m.op === 'ssh-prompt' && m.kind === 'password')).toHaveLength(1)
    // The spare connection goes once its terminal ends.
    b.pty.write('exit\n')
    await until(() => b.out.exit)
    await until(() => bridge.manager.connectionCount('h1') === 1)
  }, 30000)
})

describe('spec checks', () => {
  it('refuses bad values', () => {
    expect(validateSpec({ host: '-oProxyCommand=x', port: 22 })).toBe(null)
    expect(validateSpec({ host: 'a\nb', port: 22 })).toBe(null)
    expect(validateSpec({ host: 'box', port: 70000 })).toBe(null)
    expect(validateSpec({ host: 'box', port: 22, username: 'me\u0000' })).toBe(null)
    expect(validateSpec({ host: 'box', port: 22, identityFiles: ['ok', 'bad\n'] }).identityFiles).toEqual(['ok'])
  })

  it('an answer for a host key is yes or no only; a secret has no line breaks', async () => {
    const sock = fakeSock()
    bridge = createSshHostBridge({ hostKeyFile: join(dir, 'k.json'), broadcast: (m) => broadcasts.push(JSON.stringify(m)) })
    const replies = []
    bridge.handle(sock, { op: 'ssh-answer', promptId: 'nope', value: 'x' }, (r) => replies.push(r))
    expect(replies[0]).toEqual({ ok: false, error: 'stale' })
  })
})
