// @vitest-environment node
// The terminal host's end of the remote-agent socket tunnel
// (remoteAgent/remoteAgentTunnel.js, design/remote-agents.md wire protocol
// v1) with fake ssh2 clients and channel streams, and a fake server.cjs run
// by the real node: hello checks, the token, the MCP pipe, hook framing and
// limits, binding / re-binding / unforwarding.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { EventEmitter } from 'events'
import { Duplex } from 'stream'
import { spawn as realSpawn } from 'child_process'
import {
  createRemoteAgentTunnel,
  validateRemoteAgent,
  validateHome,
  exportPrefix,
  prepCommand,
  HOOK_TIMEOUT_EXIT
} from '../remoteAgent/remoteAgentTunnel'

const TOKEN = 'ab'.repeat(32)
const OTHER = 'cd'.repeat(32)

let dir
let script
beforeAll(() => {
  dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-rat-'))
  script = join(dir, 'server.cjs')
  // A stand-in for server.cjs: MCP echoes its stdin; --hook reports its
  // arguments, stdin and environment, or sleeps on "sleep".
  fs.writeFileSync(
    script,
    `const hook = process.argv.includes('--hook')
let input = ''
if (!hook) {
  process.stdin.on('data', (d) => process.stdout.write('mcp:' + d))
  process.stdin.on('end', () => process.exit(0))
} else {
  process.stdin.on('data', (d) => (input += d))
  process.stdin.on('end', () => {
    if (input === 'sleep') return setTimeout(() => {}, 60000)
    process.stdout.write('args=' + process.argv.slice(2).join(' ') + ';in=' + input + ';x=' + process.env.TESSEL_X)
    process.stderr.write('warn')
    process.exit(3)
  })
}
`
  )
})
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

const agent = (extra = {}) => validateRemoteAgent({ token: TOKEN, instance: 'tessel-h1', node: process.execPath, script, env: { ...process.env, TESSEL_X: 'local' }, provider: 'claude', ...extra })

// A forwarded channel: the test pushes what the shim sends, reads what the
// tunnel answers.
class FakeChannel extends Duplex {
  constructor() {
    super()
    this.received = Buffer.alloc(0)
    this.isClosed = false
  }
  _read() {}
  _write(chunk, _enc, cb) {
    this.received = Buffer.concat([this.received, chunk])
    this.emit('got')
    cb()
  }
  close() {
    if (this.isClosed) return
    this.isClosed = true
    this.destroy()
  }
  text() {
    return this.received.toString('utf8')
  }
  lines() {
    return this.text().split('\n').filter(Boolean)
  }
}

function until(fn, ms = 8000, label = '') {
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
      setTimeout(tick, 10)
    }
    tick()
  })
}

let tunnels = []
afterEach(() => {
  for (const t of tunnels) t.closeAll()
  tunnels = []
})

function makeTunnel(opts = {}) {
  const children = []
  const logs = []
  const t = createRemoteAgentTunnel({
    openExec: opts.openExec || (() => Promise.reject(new Error('no ssh in this test'))),
    log: (level, msg) => logs.push(`${level} ${msg}`),
    spawn: (...args) => {
      const c = realSpawn(...args)
      children.push({ child: c, args })
      return c
    },
    ...opts
  })
  t.children = children
  t.logs = logs
  tunnels.push(t)
  return t
}

const hello = (o = {}) => JSON.stringify({ v: 1, pane: 'p1', token: TOKEN, kind: 'mcp', args: [], ...o }) + '\n'

function connect(t, first, hostId = 'h1') {
  const ch = new FakeChannel()
  t.handleConnection(hostId, ch)
  if (first != null) ch.push(first)
  return ch
}

const closed = (ch) => until(() => ch.isClosed, 8000, 'channel closed')

describe('validateRemoteAgent', () => {
  it('takes a well-formed one and refuses the rest', () => {
    expect(agent()).toMatchObject({ token: TOKEN, instance: 'tessel-h1', provider: 'claude' })
    expect(validateRemoteAgent({ ...agent(), token: 'AB'.repeat(32) })).toBe(null)
    expect(validateRemoteAgent({ ...agent(), token: 'ab' })).toBe(null)
    expect(validateRemoteAgent({ ...agent(), instance: 'Bad_Instance' })).toBe(null)
    expect(validateRemoteAgent({ ...agent(), node: 'node' })).toBe(null)
    expect(validateRemoteAgent({ ...agent(), script: 'server.cjs' })).toBe(null)
    expect(validateRemoteAgent({ ...agent(), env: { A: 1 } })).toBe(null)
    expect(validateRemoteAgent({ ...agent(), env: [] })).toBe(null)
    expect(validateRemoteAgent({ ...agent(), provider: 'x; rm -rf' })).toBe(null)
    expect(validateRemoteAgent({ ...agent(), provider: null, env: { TESSEL_AGENT_PROVIDER: 'codex' } }).provider).toBe('codex')
  })

  it('builds the export prefix with single-quoted values', () => {
    expect(exportPrefix({ paneId: 'p1', token: TOKEN, instance: 'tessel-h1', provider: 'codex', sockPath: "/home/o'k/.tessel-server/run/tessel-h1.sock" })).toBe(
      `export TESSEL_PANE_ID='p1' TESSEL_REMOTE_SOCK='/home/o'\\''k/.tessel-server/run/tessel-h1.sock' TESSEL_REMOTE_TOKEN='${TOKEN}' TESSEL_AGENT_PROVIDER='codex'; `
    )
    expect(exportPrefix({ paneId: 'p1', token: TOKEN, instance: 'tessel-h1', provider: null, sockPath: null })).toContain(`TESSEL_REMOTE_SOCK="$HOME"/'.tessel-server/run/tessel-h1.sock'`)
    expect(() => exportPrefix({ paneId: "p'1", token: TOKEN, instance: 'tessel-h1' })).toThrow()
    expect(validateHome('/home/me\n')).toBe('/home/me')
    expect(validateHome('relative\n')).toBe(null)
    expect(validateHome('/home/a\\b')).toBe(null)
    expect(prepCommand('tessel-h1')).toContain('rm -f "$HOME/.tessel-server/run/tessel-h1.sock"')
    expect(prepCommand('tessel-h1')).toContain('umask 077')
  })
})

describe('hello', () => {
  it('refuses a malformed hello', async () => {
    const t = makeTunnel()
    t.registerPane('h1', 'p1', agent())
    const bad = [
      'not json\n',
      hello({ v: 2 }),
      hello({ kind: 'shell' }),
      hello({ token: 'xyz' }),
      hello({ args: Array(17).fill('a') }),
      hello({ args: ['a'.repeat(257)] }),
      hello({ kind: 'hook', args: ['gemini', 'Stop'] }),
      hello({ kind: 'hook', args: [] }),
      'x'.repeat(9000)
    ]
    for (const first of bad) {
      const ch = connect(t, first)
      await closed(ch)
      expect(ch.lines()).toEqual(['{"ok":false,"error":"bad-hello"}'])
    }
    expect(t.children).toHaveLength(0)
  })

  it('refuses a wrong token and an unknown pane', async () => {
    const t = makeTunnel()
    t.registerPane('h1', 'p1', agent())
    t.registerPane('h2', 'p2', agent({ token: OTHER }))
    let ch = connect(t, hello({ token: OTHER }))
    await closed(ch)
    expect(ch.lines()).toEqual(['{"ok":false,"error":"bad-token"}'])
    ch = connect(t, hello({ pane: 'nope' }))
    await closed(ch)
    expect(ch.lines()).toEqual(['{"ok":false,"error":"unknown-pane"}'])
    // A pane of another host, even with its own token.
    ch = connect(t, hello({ pane: 'p2', token: OTHER }))
    await closed(ch)
    expect(ch.lines()).toEqual(['{"ok":false,"error":"unknown-pane"}'])
    expect(t.children).toHaveLength(0)
    expect(t.logs.join('\n')).not.toContain(TOKEN)
  })

  it('gives up on a client that never says hello', async () => {
    const t = makeTunnel({ limits: { helloTimeoutMs: 50 } })
    t.registerPane('h1', 'p1', agent())
    const ch = connect(t, '{"v":1')
    await closed(ch)
    expect(ch.lines()).toEqual(['{"ok":false,"error":"bad-hello"}'])
  })

  it('answers busy past the connection limit of a host', async () => {
    const t = makeTunnel({ limits: { maxConnections: 2 } })
    t.registerPane('h1', 'p1', agent())
    const a = connect(t)
    const b = connect(t)
    const c = connect(t)
    await closed(c)
    expect(c.lines()).toEqual(['{"ok":false,"error":"busy"}'])
    expect(t.connectionCount('h1')).toBe(2)
    a.close()
    b.close()
    await until(() => t.connectionCount('h1') === 0)
  })
})

describe('mcp', () => {
  it('pipes both ways with the pane environment, no shell, hidden window', async () => {
    const t = makeTunnel()
    t.registerPane('h1', 'p1', agent())
    // Bytes after the hello line in the same chunk reach server.cjs too.
    const ch = connect(t, hello() + 'one\n')
    await until(() => ch.text().includes('mcp:one'))
    expect(ch.lines()[0]).toBe('{"ok":true}')
    ch.push('two\n')
    await until(() => ch.text().includes('mcp:two'))
    const [{ args }] = t.children
    expect(args[0]).toBe(process.execPath)
    expect(args[1]).toEqual([script])
    expect(args[2]).toMatchObject({ windowsHide: true, shell: false })
    expect(args[2].env.TESSEL_X).toBe('local')
    // The client ends its side: server.cjs ends, the channel closes.
    ch.push(null)
    await closed(ch)
  })

  it('kills server.cjs when the connection closes', async () => {
    const t = makeTunnel()
    t.registerPane('h1', 'p1', agent())
    const ch = connect(t, hello())
    await until(() => ch.text().includes('{"ok":true}'))
    const child = t.children[0].child
    ch.close()
    await until(() => child.exitCode !== null || child.signalCode !== null)
  })

  it('says failed when node cannot start', async () => {
    const t = makeTunnel()
    t.registerPane('h1', 'p1', agent({ node: join(dir, 'no-such-node.exe') }))
    const ch = connect(t, hello())
    await closed(ch)
    expect(ch.lines()).toEqual(['{"ok":false,"error":"failed"}'])
  })
})

describe('hook', () => {
  const resultOf = (ch) => {
    const lines = ch.lines()
    expect(lines[0]).toBe('{"ok":true}')
    const r = JSON.parse(lines[1])
    return { exit: r.exit, stdout: Buffer.from(r.stdout, 'base64').toString(), stderr: Buffer.from(r.stderr, 'base64').toString() }
  }

  it('runs server.cjs --hook with the stdin, frames its result', async () => {
    const t = makeTunnel()
    t.registerPane('h1', 'p1', agent())
    const ch = connect(t, hello({ kind: 'hook', args: ['claude', 'Stop'] }) + '{"a":')
    ch.push('1}')
    ch.push(null)
    await closed(ch)
    // The event name is dropped: server.cjs reads it from stdin.
    expect(resultOf(ch)).toEqual({ exit: 3, stdout: 'args=--hook;in={"a":1};x=local', stderr: 'warn' })
  })

  it('adds --codex for a Codex hook', async () => {
    const t = makeTunnel()
    t.registerPane('h1', 'p1', agent())
    const ch = connect(t, hello({ kind: 'hook', args: ['codex', 'Stop'] }))
    ch.push(null)
    await closed(ch)
    expect(resultOf(ch).stdout).toBe('args=--hook --codex;in=;x=local')
  })

  it('kills a hook that runs too long: exit 124', async () => {
    const t = makeTunnel({ limits: { hookTimeoutMs: 300 } })
    t.registerPane('h1', 'p1', agent())
    const ch = connect(t, hello({ kind: 'hook', args: ['claude'] }) + 'sleep')
    ch.push(null)
    await closed(ch)
    expect(resultOf(ch).exit).toBe(HOOK_TIMEOUT_EXIT)
    const child = t.children[0].child
    await until(() => child.exitCode !== null || child.signalCode !== null)
  })

  it('refuses more stdin than the limit without running anything', async () => {
    const t = makeTunnel({ limits: { hookStdinMax: 10 } })
    t.registerPane('h1', 'p1', agent())
    const ch = connect(t, hello({ kind: 'hook', args: ['claude'] }) + '12345')
    ch.push('678901')
    ch.push(null)
    await closed(ch)
    const r = resultOf(ch)
    expect(r.exit).toBe(1)
    expect(r.stderr).toMatch(/too large/)
    expect(t.children).toHaveLength(0)
  })

  it('closes a hook whose stdin never ends', async () => {
    const t = makeTunnel({ limits: { hookTimeoutMs: 100 } })
    t.registerPane('h1', 'p1', agent())
    const ch = connect(t, hello({ kind: 'hook', args: ['claude'] }) + 'partial')
    await closed(ch)
    expect(t.children).toHaveLength(0)
  })
})

// A fake ssh2 client: records forwards, emits 'unix connection'.
function fakeClient() {
  const c = new EventEmitter()
  c.forwards = []
  c.unforwards = []
  c.openssh_forwardInStreamLocal = (path, cb) => {
    c.forwards.push(path)
    setTimeout(() => cb(c.refuse ? new Error('refused') : undefined), 1)
  }
  c.openssh_unforwardInStreamLocal = (path, cb) => {
    c.unforwards.push(path)
    setTimeout(() => cb(), 1)
  }
  // The shim connecting to the socket.
  c.dial = (socketPath) => {
    const ch = new FakeChannel()
    let accepted = false
    c.emit('unix connection', { socketPath }, () => ((accepted = true), ch), () => (ch.rejected = true))
    ch.accepted = accepted
    return ch
  }
  return c
}

// openExec answering the prep command with a home, on the current client.
function fakeExec(state) {
  return (hostId, spec, command) => {
    state.commands.push(command)
    const stream = new FakeChannel()
    stream.stderr = new EventEmitter()
    setTimeout(() => {
      stream.push(`${state.home}\n`)
      stream.push(null)
      stream.tesselExit = [state.code ?? 0]
      stream.emit('close')
    }, 2)
    return Promise.resolve({ stream, release: () => state.released++, client: state.client })
  }
}

describe('binding', () => {
  const spec = { host: 'box', port: 22 }

  it('prepares the run folder, binds, routes connections, unforwards with the last pane', async () => {
    const state = { commands: [], home: '/home/me', client: fakeClient(), released: 0 }
    const t = makeTunnel({ openExec: fakeExec(state) })
    t.registerPane('h1', 'p1', agent(), spec)
    t.registerPane('h1', 'p2', agent({ token: OTHER }), spec)
    const path = await t.ensure('h1', spec)
    expect(path).toBe('/home/me/.tessel-server/run/tessel-h1.sock')
    expect(state.commands).toEqual([prepCommand('tessel-h1')])
    expect(state.released).toBe(1)
    expect(state.client.forwards).toEqual([path])
    expect(t.isBound('h1')).toBe(true)
    // Bound already: nothing run again.
    expect(await t.ensure('h1', spec)).toBe(path)
    expect(state.commands).toHaveLength(1)

    const ch = state.client.dial(path)
    ch.push(hello())
    await until(() => ch.text().includes('{"ok":true}'))
    // Another socket path on this client: refused.
    expect(state.client.dial('/tmp/other.sock').rejected).toBe(true)

    // p1 exits: its connection ends, the socket stays for p2.
    t.forgetPane('p1')
    await closed(ch)
    expect(state.client.unforwards).toEqual([])
    t.forgetPane('p2')
    expect(state.client.unforwards).toEqual([path])
    expect(t.isBound('h1')).toBe(false)
    expect(t.logs.join('\n')).not.toContain(TOKEN)
  })

  it('binds again on the new connection after the old one went away', async () => {
    const state = { commands: [], home: '/home/me', client: fakeClient(), released: 0 }
    const t = makeTunnel({ openExec: fakeExec(state), limits: { bindRetryMs: [20, 20, 20] } })
    t.registerPane('h1', 'p1', agent(), spec)
    const path = await t.ensure('h1', spec)
    const first = state.client
    state.client = fakeClient()
    first.emit('close')
    expect(t.isBound('h1')).toBe(false)
    await until(() => t.isBound('h1'))
    expect(state.client.forwards).toEqual([path])
    expect(state.commands).toHaveLength(2)
    // The old client's late connection is not ours any more.
    expect(first.dial(path).rejected).toBe(true)
    const ch = state.client.dial(path)
    ch.push(hello())
    await until(() => ch.text().includes('{"ok":true}'))
  })

  it('a failed prep or bind leaves it unbound, logged without secrets', async () => {
    const state = { commands: [], home: '/home/me', client: fakeClient(), released: 0, code: 1 }
    const t = makeTunnel({ openExec: fakeExec(state) })
    t.registerPane('h1', 'p1', agent(), spec)
    expect(await t.ensure('h1', spec)).toBe(null)
    state.code = 0
    state.client.refuse = true
    expect(await t.ensure('h1', spec)).toBe(null)
    expect(t.isBound('h1')).toBe(false)
    expect(t.logs.some((l) => l.startsWith('warn remote agent socket'))).toBe(true)
    state.client.refuse = false
    expect(await t.ensure('h1', spec)).toBe('/home/me/.tessel-server/run/tessel-h1.sock')
  })

  it('no pane, no binding; a host disconnected is not bound again', async () => {
    const state = { commands: [], home: '/home/me', client: fakeClient(), released: 0 }
    const t = makeTunnel({ openExec: fakeExec(state), limits: { bindRetryMs: [10] } })
    expect(await t.ensure('h1', spec)).toBe(null)
    expect(state.commands).toHaveLength(0)
    t.registerPane('h1', 'p1', agent(), spec)
    await t.ensure('h1', spec)
    t.dropHost('h1')
    state.client.emit('close')
    await new Promise((r) => setTimeout(r, 60))
    expect(state.commands).toHaveLength(1)
  })
})
