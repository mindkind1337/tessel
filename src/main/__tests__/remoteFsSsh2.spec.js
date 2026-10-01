// @vitest-environment node
// A remote project's Files / Changes session over the host's shared ssh2
// connection, end to end: remoteFs.js -> ssh/sshRemote.js -> (the terminal
// host's messages, in process here) -> ssh/sshHostBridge.js -> ssh2 -> a
// local fake SSH server whose exec channel runs Git for Windows' sh on a
// temporary folder. The password is asked once through the dialog path
// (ssh:credential-request / submit) and kept for a reconnect.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { createRemoteFs } from '../remoteFs'
import { createSshRemote } from '../ssh/sshRemote'
import { createSshHostBridge } from '../ssh/sshHostBridge'
import { remoteRoot, childPath } from '../../shared/remotePath'
import { gitSh, posixPath } from './fixtures/fakeSsh'
import { startSshServer, shExec } from './fixtures/sshServer'

const HOST = 'ssh-e2e'
const PASSWORD = 's3cret-pass'
const t = (_k, english, vars) => String(english).replace(/\{\{\s*(\w+)\s*\}\}/g, (m, n) => (vars && n in vars ? String(vars[n]) : m))

describe.skipIf(!gitSh())('remote project over the shared ssh2 connection', () => {
  let base
  let proj
  let home
  let server
  let bridge
  let ssh
  let rfs
  let root
  const sent = []
  const events = []
  const logs = []

  beforeAll(async () => {
    base = fs.mkdtempSync(join(os.tmpdir(), 'tessel-rfs2-'))
    proj = join(base, 'proj')
    home = join(base, 'home')
    fs.mkdirSync(proj)
    fs.mkdirSync(home)
    const g = (...args) => execFileSync('git', ['-C', proj, ...args], { stdio: 'pipe' })
    g('init', '-q', '-b', 'main')
    g('config', 'user.email', 't@example.com')
    g('config', 'user.name', 'T')
    fs.writeFileSync(join(proj, 'a.txt'), 'one\n')
    g('add', '-A')
    g('commit', '-q', '-m', 'first')
    server = await startSshServer({ auth: { password: PASSWORD, methods: ['password'] }, onExec: shExec(gitSh(), { home: posixPath(home) }) })

    // The terminal host's pipe, in process: requests go to the bridge, its
    // messages come back to sshRemote.
    const sock = {
      destroyed: false,
      writableLength: 0,
      write: (line) => {
        ssh.onEvent(JSON.parse(line))
        return true
      },
      once() {}
    }
    bridge = createSshHostBridge({
      hostKeyFile: join(base, 'ssh-host-keys.json'),
      log: (level, msg) => logs.push(`${level} ${msg}`),
      broadcast: (m) => sock.write(JSON.stringify(m))
    })
    const host = {
      connected: true,
      features: { ssh: true },
      ensure: async () => ({}),
      request: async (op, body) => new Promise((resolve) => bridge.handle(sock, { op, ...body }, resolve)),
      send: (op, body) => bridge.handle(sock, { op, ...body }, () => {})
    }
    const spec = { host: '127.0.0.1', port: server.port, username: 'me', identityFiles: [], knownHostsFiles: [join(base, 'known_hosts')], strictHostKeyChecking: 'ask' }
    const hosts = {
      get: () => ({ id: HOST, label: 'Box', host: '127.0.0.1' }),
      launchFor: () => ({ ok: false, error: 'the system ssh is not used here' }),
      paneStarted: (id, hostId, o) => events.push(['started', id, hostId, o]),
      paneConnected: (id) => events.push(['connected', id]),
      paneClosing: (id) => events.push(['closing', id]),
      paneExited: (id) => events.push(['exited', id]),
      connectionState: (hostId, status) => events.push(['state', hostId, status])
    }
    // The dialog: answers the questions it is sent, through submit().
    const send = (channel, payload) => {
      sent.push([channel, payload])
      if (channel === 'ssh:credential-request') {
        const value = payload.kind === 'hostkey' ? 'yes' : PASSWORD
        setTimeout(() => ssh.submit({ paneId: payload.paneId, promptId: payload.promptId, value }), 5)
      }
    }
    ssh = createSshRemote({ host, hosts, send, t, resolver: { resolve: async () => ({ ok: true, spec }) } })
    rfs = createRemoteFs({ hosts, ssh, send })
    root = remoteRoot(HOST, posixPath(proj))
    rfs.setRoots([root])
  }, 60000)

  afterAll(async () => {
    if (rfs) rfs.close()
    if (bridge) bridge.shutdown()
    if (server) await server.close()
    fs.rmSync(base, { recursive: true, force: true })
  })

  it('lists, reads and saves through one exec channel; asks the host key and password once', async () => {
    const listed = await rfs.listDir({ root })
    expect(listed.ok).toBe(true)
    expect(listed.entries.map((e) => e.name)).toEqual(['a.txt'])
    const read = await rfs.readForEdit(childPath(root, 'a.txt'))
    expect(read.ok).toBe(true)
    expect(read.text).toBe('one\n')
    const saved = await rfs.writeForEdit({ file: childPath(root, 'a.txt'), text: 'two\n', expectHash: read.hash, expectSig: read.sig })
    expect(saved.ok).toBe(true)
    expect(fs.readFileSync(join(proj, 'a.txt'), 'utf8')).toBe('two\n')
    const asked = sent.filter(([c]) => c === 'ssh:credential-request').map(([, p]) => p.kind)
    expect(asked).toEqual(['hostkey', 'password'])
    expect(server.events.connections).toBe(1)
    expect(server.events.channels.filter((c) => c.kind === 'exec').map((c) => c.command)).toEqual(['exec /bin/sh'])
    expect(events.some((e) => e[0] === 'started' && e[3] && e[3].ssh2)).toBe(true)
  }, 60000)

  it('after the connection drops, the next operation reconnects with the kept password (no question)', async () => {
    const before = sent.filter(([c]) => c === 'ssh:credential-request').length
    server.dropClients()
    // The session notices it ended; the next operation starts a new one.
    let res = null
    for (let i = 0; i < 20 && !(res && res.ok); i++) {
      res = await rfs.listDir({ root })
      if (!res.ok) await new Promise((r) => setTimeout(r, 100))
    }
    expect(res.ok).toBe(true)
    expect(server.events.connections).toBe(2)
    expect(sent.filter(([c]) => c === 'ssh:credential-request').length).toBe(before)
  }, 60000)

  it('the password is in no log line, window message or status', () => {
    const everything = [...logs, ...sent.map(([c, p]) => `${c} ${JSON.stringify(p)}`), ...events.map((e) => JSON.stringify(e))].join('\n')
    expect(everything).not.toContain(PASSWORD)
  })
})
