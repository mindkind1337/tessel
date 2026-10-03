// @vitest-environment node
// A remote-agent pane end to end on a local ssh2 server (ssh/sshHostBridge.js
// + remoteAgent/remoteAgentTunnel.js): the run folder prepared, the socket
// forwarded (streamlocal), the pane's shell started with its variables, a
// connection from "the shim" reaching a local server.cjs, the socket bound
// again after the connection drops, unforwarded when the pane exits. The
// token never appears in a log line or a message.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import ssh2 from 'ssh2'
import { createSshHostBridge } from '../ssh/sshHostBridge'
import { makeKey } from './fixtures/sshServer'
import { prepCommand } from '../remoteAgent/remoteAgentTunnel'

const { Server } = ssh2
const PASSWORD = 'pw-remote-agent'
const TOKEN = '5e'.repeat(32)
const HOME = '/home/test'
const SOCK = `${HOME}/.tessel-server/run/tessel-h1.sock`

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

// An sshd stand-in: answers the prep command with HOME, records forwards,
// cancels and the pane's command, and can dial a forwarded socket.
function startServer() {
  const events = { execs: [], forwards: [], cancels: [], connections: 0 }
  const clients = new Set()
  const server = new Server({ hostKeys: [makeKey().private] }, (client) => {
    events.connections++
    clients.add(client)
    client.on('error', () => {})
    client.on('close', () => clients.delete(client))
    client.on('authentication', (ctx) => (ctx.method === 'password' && ctx.password === PASSWORD ? ctx.accept() : ctx.reject(['password'])))
    client.on('ready', () => {
      client.on('request', (accept, reject, name, info) => {
        if (name === 'streamlocal-forward@openssh.com') {
          events.forwards.push({ path: info.socketPath, client })
          client.forwarded = info.socketPath
          return accept && accept()
        }
        if (name === 'cancel-streamlocal-forward@openssh.com') {
          events.cancels.push(info.socketPath)
          client.forwarded = null
          return accept && accept()
        }
        reject && reject()
      })
      client.on('session', (accept) => {
        const session = accept()
        session.on('pty', (ok) => ok && ok())
        session.on('window-change', (ok) => ok && ok())
        session.on('exec', (ok, _no, info) => {
          const stream = ok()
          events.execs.push(info.command)
          if (info.command.includes('.tessel-server/run') && info.command.startsWith('umask')) {
            stream.write(`${HOME}\n`)
            stream.exit(0)
            stream.end()
            return
          }
          // The pane's shell.
          stream.write('shell ready\r\n')
        })
      })
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        events,
        // "The shim" connecting to the forwarded socket on the live connection.
        dial() {
          const c = [...clients].find((x) => x.forwarded === SOCK)
          if (!c) return Promise.reject(new Error('not forwarded')) // i18n-ignore test
          return new Promise((res, rej) => c.openssh_forwardOutStreamLocal(SOCK, (err, ch) => (err ? rej(err) : res(ch))))
        },
        dropClients() {
          for (const c of clients) c.end()
        },
        close() {
          for (const c of clients) c.end()
          return new Promise((r) => server.close(() => r()))
        }
      })
    })
  })
}

let dir
let script
beforeAll(() => {
  dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-sshra-'))
  script = join(dir, 'server.cjs')
  fs.writeFileSync(
    script,
    `if (process.argv.includes('--hook')) {
  let s = ''
  process.stdin.on('data', (d) => (s += d))
  process.stdin.on('end', () => { process.stdout.write('hooked:' + s + ':' + process.env.TESSEL_PANE_ID); process.exit(0) })
} else process.stdin.on('data', (d) => process.stdout.write('mcp:' + d))
`
  )
})
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

let server
let bridge
let logs
let broadcasts
beforeEach(async () => {
  server = await startServer()
  logs = []
  broadcasts = []
})
afterEach(async () => {
  if (bridge) bridge.shutdown()
  bridge = null
  await server.close()
})

function makeBridge() {
  bridge = createSshHostBridge({
    hostKeyFile: join(dir, `keys-${Date.now()}.json`),
    log: (level, msg) => logs.push(`${level} ${msg}`),
    reconnectDelays: [30, 30, 30],
    tunnelOptions: { limits: { bindRetryMs: [30, 30, 30] } },
    broadcast: (m) => {
      broadcasts.push(JSON.stringify(m))
      if (m.op === 'ssh-prompt') {
        const value = m.kind === 'hostkey' ? 'yes' : PASSWORD
        setTimeout(() => bridge.handle({ destroyed: false, write() {} }, { op: 'ssh-answer', promptId: m.promptId, value }, () => {}), 5)
      }
    }
  })
}

const spec = () => ({ host: '127.0.0.1', port: server.port, username: 'me', identityFiles: [], knownHostsFiles: [join(dir, 'known_hosts')], strictHostKeyChecking: 'ask' })
const remoteAgent = () => ({ token: TOKEN, instance: 'tessel-h1', provider: 'claude', node: process.execPath, script, env: { ...process.env, TESSEL_PANE_ID: 'pane-1' } })

function agentPane(extra = {}) {
  const pty = bridge.createPty({ hostId: 'h1', spec: spec(), texts: { label: 'box' }, cols: 80, rows: 24, paneId: 'pane-1', remoteAgent: remoteAgent(), ...extra })
  const out = { text: '', exit: null }
  pty.onData((d) => (out.text += d))
  pty.onExit((e) => (out.exit = e))
  return { pty, out }
}

function readAll(ch) {
  const st = { text: '' }
  ch.on('data', (d) => (st.text += d))
  return st
}

describe('remote-agent pane on ssh2', () => {
  it('binds the socket, then starts the shell with the pane variables', async () => {
    makeBridge()
    const { out } = agentPane({ remotePath: '/srv/my app' })
    await until(() => out.text.includes('shell ready'))
    expect(server.events.execs[0]).toBe(prepCommand('tessel-h1'))
    expect(server.events.forwards.map((f) => f.path)).toEqual([SOCK])
    expect(server.events.execs[1]).toBe(
      `export TESSEL_PANE_ID='pane-1' TESSEL_REMOTE_SOCK='${SOCK}' TESSEL_REMOTE_TOKEN='${TOKEN}' TESSEL_AGENT_PROVIDER='claude'; cd -- '/srv/my app' && exec "$SHELL" -l`
    )
  })

  it('a plain agent shell becomes exec "$SHELL" -l; a pane without remoteAgent is unchanged', async () => {
    makeBridge()
    const { out } = agentPane()
    await until(() => out.text.includes('shell ready'))
    expect(server.events.execs[1]).toMatch(/; exec "\$SHELL" -l$/)
    expect(() => bridge.createPty({ hostId: 'h1', spec: spec(), texts: {}, cols: 80, rows: 24, paneId: 'p2', remoteAgent: { ...remoteAgent(), token: 'nope' } })).toThrow(/invalid remote agent/)
    expect(() => bridge.createPty({ hostId: 'h1', spec: spec(), texts: {}, cols: 80, rows: 24, remoteAgent: remoteAgent() })).toThrow(/invalid remote agent/)
  })

  it('a connection through the socket reaches server.cjs (mcp and hook)', async () => {
    makeBridge()
    const { out } = agentPane()
    await until(() => out.text.includes('shell ready'))
    const ch = await server.dial()
    const got = readAll(ch)
    ch.write(JSON.stringify({ v: 1, pane: 'pane-1', token: TOKEN, kind: 'mcp', args: [] }) + '\n')
    await until(() => got.text.includes('{"ok":true}'))
    ch.write('ping\n')
    await until(() => got.text.includes('mcp:ping'))
    ch.close()

    const hk = await server.dial()
    const hg = readAll(hk)
    let ended = false
    hk.on('close', () => (ended = true))
    hk.write(JSON.stringify({ v: 1, pane: 'pane-1', token: TOKEN, kind: 'hook', args: ['claude', 'Stop'] }) + '\n')
    await until(() => hg.text.includes('{"ok":true}'))
    // EOF only, like the shim's half-close (ssh2's server-side end() would
    // close the whole channel, which sshd does not do).
    hk.write('{"e":1}')
    hk.eof()
    await until(() => ended)
    const r = JSON.parse(hg.text.trim().split('\n')[1])
    expect(r.exit).toBe(0)
    expect(Buffer.from(r.stdout, 'base64').toString()).toBe('hooked:{"e":1}:pane-1')

    const bad = await server.dial()
    const bg = readAll(bad)
    bad.write(JSON.stringify({ v: 1, pane: 'pane-1', token: 'ff'.repeat(32), kind: 'mcp' }) + '\n')
    await until(() => bg.text.includes('bad-token'))
  })

  it('binds again after the connection drops; unforwards when the pane exits', async () => {
    makeBridge()
    const { pty, out } = agentPane()
    await until(() => out.text.includes('shell ready'))
    server.dropClients()
    await until(() => server.events.forwards.length === 2, 10000, 'second forward')
    expect(server.events.forwards[1].path).toBe(SOCK)
    await until(() => (out.text.match(/shell ready/g) || []).length === 2)
    const ch = await server.dial()
    const got = readAll(ch)
    ch.write(JSON.stringify({ v: 1, pane: 'pane-1', token: TOKEN, kind: 'mcp' }) + '\n')
    await until(() => got.text.includes('{"ok":true}'))

    pty.kill()
    await until(() => out.exit)
    await until(() => server.events.cancels.length === 1)
    expect(server.events.cancels).toEqual([SOCK])
    // The pane is forgotten: its connection is gone, a new one is refused.
    expect(bridge.tunnel.paneCount()).toBe(0)
    expect([...logs, ...broadcasts].join('\n')).not.toContain(TOKEN)
  })
})
