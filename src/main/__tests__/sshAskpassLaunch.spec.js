// A remote host pane's launch with askpass, end to end in main: the real
// pty:create handler (taken from index.js, as Codex's harness
// check-ssh-askpass-integration.cjs does) with the real broker, and the
// helper's pipe host (askpassPipeHost.js) when the helper cannot start.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import vm from 'node:vm'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { createSshAskpass } from '../sshAskpass'
import { createAskpassPipeHost } from '../askpassPipeHost'
import { STATUS_PROVIDERS } from '../../shared/agentStateModel'

const main = fs.readFileSync(join(__dirname, '..', 'index.js'), 'utf8')
const handlerSource = main.slice(main.indexOf("ipcMain.handle('pty:create',"), main.indexOf('// Re-attach to a terminal'))

// A fake pipe server that is ready at once.
const fakeNet = {
  createServer() {
    const srv = new EventEmitter()
    srv.listen = (_opts, cb) => cb()
    srv.close = () => {}
    return srv
  }
}

function harness({ helper = 'fake.exe', createDelay = null, sshMode = { mode: 'system', reason: 'test' }, remoteAgent = {} } = {}) {
  let answerVersion = null
  const broker = createSshAskpass({
    helperPath: () => helper,
    runFile: (_exe, _args, _opts, cb) => (answerVersion = () => cb(null, '', 'OpenSSH_for_Windows_9.5p2')),
    netApi: fakeNet,
    timers: { setTimeout: () => 0, clearTimeout: () => {} }
  })
  const creates = []
  const sent = []
  const started = []
  const allowed = []
  let finishCreate = null
  const handlers = {}
  vm.runInNewContext(handlerSource, {
    ipcMain: { handle: (k, v) => (handlers[k] = v) },
    app: { getPath: () => "fixture-user-data" },
    getShells: () => [{ id: 'shell', name: 'fixture', file: 'fake.exe', args: [] }],
    defaultShell: () => ({}),
    remoteHosts: {
      get: (id) => ({ id, label: 'fake' }),
      launchFor: (id) => ({ ok: true, target: { id }, name: 'fake', file: 'fake-ssh', args: [] }),
      paneStarted: (...a) => started.push(a)
    },
    // The host's shared ssh2 connection (ssh/sshRemote.js): the system ssh
    // (askpass) here unless a test asks for ssh2.
    sshRemote: {
      modeFor: async () => sshMode,
      terminalRequest: (target, spec, remotePath) => ({ hostId: target.id, spec, remotePath, texts: {} })
    },
    validateRemotePath: (p) => ({ path: p }),
    // Agents on the host (remoteAgent/remoteAgentSetup.js): what main prepared.
    prepareRemoteAgent: async (q) => (typeof remoteAgent === 'function' ? remoteAgent(q) : remoteAgent),
    REMOTE_AGENT_PROVIDERS: ['claude', 'codex'],
    remoteToolsReason: (code) => `reason ${code}`,
    // The host's helper and agent check after its first terminal (background).
    remoteAgentCheck: { hostStarted: async () => {}, waitConnected: () => {}, paneConnected: () => {}, paneExited: () => {} },
    // A terminal opened on a host lets its Files session sign in (remoteFs.js).
    remoteFs: { allow: (id) => allowed.push(id) },
    Date,
    Map,
    remoteProjectLaunch: (r) => r,
    os: { homedir: () => 'C:/fixture' },
    fs: { existsSync: () => false },
    isAbsolute: () => false,
    crypto: { randomBytes: () => Buffer.alloc(16) },
    shouldUseConpty: () => true,
    paneEnv: () => ({}),
    freshEnv: () => ({}),
    prepareStatus: () => ({ ok: true }),
    STATUS_PROVIDERS,
    agentStateStore: { register: async () => {} },
    newTeamSecret: () => 'c'.repeat(64),
    setTeamSecret: () => {},
    revokeTeamSecret: () => {},
    agentStateDir: 'C:/fixture/state',
    ptyInfo: new Map(),
    windowsBuildNumber: () => 22631,
    sshAskpass: broker,
    host: {
      request: (kind, v) => {
        creates.push({ kind, askpass: !!v.env.SSH_ASKPASS, token: v.env.TESSEL_ASKPASS_TOKEN, ...(v.ssh ? { ssh: v.ssh, backend: v.meta.backend } : {}), ...(v.meta && v.meta.agentProvider ? { agent: [v.meta.agentProvider, v.meta.agentLaunchToken] } : {}) })
        if (createDelay) return new Promise((resolve) => (finishCreate = () => resolve({ ok: true, pid: 4242 })))
        return Promise.resolve({ ok: true, pid: 4242 })
      },
      send: (kind, v) => sent.push({ kind, ...v })
    },
    log: { error: () => {}, warn: () => {}, info: () => {} },
    t: (_key, fallback) => fallback
  })
  const create = (id = 'pane-1', extra = {}) => handlers['pty:create'](null, { id, shellId: 'shell', remoteHostId: 'host-1', ...extra })
  return { broker, creates, sent, started, allowed, create, version: () => answerVersion(), finishCreate: () => finishCreate() }
}

// The handler first asks which SSH client the host uses (ssh2 or the system
// ssh): a few promise turns before askpass is prepared.
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('pty:create on the shared ssh2 connection (the real handler from index.js)', () => {
  it('opens a shell channel in the terminal host: no askpass, no ssh.exe', async () => {
    const spec = { host: 'box', port: 22, username: 'me' }
    const h = harness({ sshMode: { mode: 'ssh2', spec } })
    const res = await h.create()
    expect(res).toMatchObject({ ok: true, backend: 'ssh', remoteHost: { id: 'host-1', label: 'fake' } })
    expect(h.creates).toEqual([{ kind: 'create', askpass: false, token: undefined, ssh: { hostId: 'host-1', spec, remotePath: null, texts: {} }, backend: 'ssh' }])
    expect(h.started).toEqual([['pane-1', 'host-1', { ssh2: true }]])
    // A terminal opened on the host: its Files session may sign in too.
    expect(h.allowed).toEqual(['host-1'])
    h.broker.close()
  })

  it('an agent pane carries its remote-agent setup to the terminal host and its status token back', async () => {
    const spec = { host: 'box', port: 22, username: 'me' }
    const seen = []
    const remoteAgent = { token: 'a'.repeat(64), instance: 'tessel-abc', provider: 'claude', env: { TESSEL_PANE_ID: 'pane-1' }, node: 'C:/node.exe', script: 'C:/s.cjs' }
    const h = harness({ sshMode: { mode: 'ssh2', spec }, remoteAgent: (q) => (seen.push(q), { remoteAgent, launchToken: 'b'.repeat(32) }) })
    const res = await h.create('pane-1', { agentId: 'claude', remotePath: '/srv/app' })
    expect(seen).toEqual([{ id: 'pane-1', target: { id: 'host-1', label: 'fake' }, remotePath: '/srv/app', agentId: 'claude', teamSecret: 'c'.repeat(64) }])
    expect(h.creates[0].ssh.remoteAgent).toEqual(remoteAgent)
    expect(h.creates[0].agent).toEqual(['claude', 'b'.repeat(32)])
    expect(res).toMatchObject({ ok: true, agentLaunchToken: 'b'.repeat(32), agentStatusWarning: null })
    h.broker.close()
  })

  it('an agent pane whose host could not be set up still opens, with the reason for its pane', async () => {
    const h = harness({ sshMode: { mode: 'ssh2', spec: { host: 'box', port: 22, username: 'me' } }, remoteAgent: { toolsReason: 'no node there' } })
    const res = await h.create('pane-1', { agentId: 'claude' })
    expect(res).toMatchObject({ ok: true, agentLaunchToken: null, agentStatusWarning: null, remoteToolsWarning: { host: 'fake', reason: 'no node there' } })
    expect(h.creates[0].ssh.remoteAgent).toBeUndefined()
    h.broker.close()
  })
})

describe('pty:create with askpass (the real handler from index.js)', () => {
  it('a normal launch gives ssh askpass and counts it as started', async () => {
    const h = harness()
    const p = h.create()
    await flush()
    h.version()
    const res = await p
    expect(res.ok).toBe(true)
    expect(h.creates).toEqual([{ kind: 'create', askpass: true, token: expect.stringMatching(/^[0-9a-f]{64}$/) }])
    expect(h.started).toEqual([['pane-1', 'host-1', { connected: false }]])
    h.broker.close()
  })

  it('an agent on a host opened with the system ssh: its pane says the tools are not connected there', async () => {
    const h = harness()
    const p = h.create('pane-1', { agentId: 'claude' })
    await flush()
    h.version()
    const res = await p
    expect(res.ok).toBe(true)
    expect(res.remoteToolsWarning).toEqual({ host: 'fake', reason: 'reason system-ssh' })
    // A plain shell there: nothing to say.
    const h2 = harness()
    const p2 = h2.create('pane-2')
    await flush()
    h2.version()
    expect((await p2).remoteToolsWarning).toBe(null)
    h.broker.close()
    h2.broker.close()
  })

  it('closed while ssh -V runs: no terminal is created at all (not a fallback without askpass)', async () => {
    const h = harness()
    const p = h.create()
    await flush()
    h.broker.releasePane('pane-1') // pty:kill
    h.version()
    const res = await p
    expect(res).toMatchObject({ ok: false, cancelled: true })
    expect(h.creates).toEqual([])
    h.broker.close()
  })

  it('launched again while the first launch is prepared: the first creates nothing, the second runs', async () => {
    const h = harness()
    const first = h.create()
    await flush()
    const second = h.create()
    await flush()
    h.version()
    expect(await first).toMatchObject({ ok: false, cancelled: true })
    expect((await second).ok).toBe(true)
    expect(h.creates).toHaveLength(1)
    h.broker.close()
  })

  it('closed while the terminal is being created: that ssh is ended, its token revoked', async () => {
    const h = harness({ createDelay: true })
    const p = h.create()
    await flush()
    h.version()
    while (!h.creates.length) await new Promise((r) => setTimeout(r, 1))
    h.broker.releasePane('pane-1') // pty:kill reached the host before the terminal existed
    h.finishCreate()
    expect(await p).toMatchObject({ ok: false, cancelled: true })
    expect(h.sent).toEqual([{ kind: 'kill', id: 'pane-1' }])
    expect(h.broker.isPrepared('pane-1')).toBe(false)
    expect(h.started).toEqual([])
    h.broker.close()
  })

  it('no helper: the allowed fallback, ssh asks in the terminal', async () => {
    const h = harness({ helper: null })
    const res = await h.create()
    expect(res.ok).toBe(true)
    expect(h.creates).toEqual([{ kind: 'create', askpass: false, token: undefined }])
    expect(h.started).toEqual([['pane-1', 'host-1', { connected: true }]])
    h.broker.close()
  })
})

describe('askpassPipeHost: a helper that does not start', () => {
  const brokers = []
  afterEach(() => {
    for (const b of brokers.splice(0)) b.close()
  })
  const brokerWith = (netApi) => {
    const b = createSshAskpass({ helperPath: () => 'fake.exe', runFile: (_e, _a, _o, cb) => cb(null, '', 'OpenSSH_for_Windows_9.5p2'), netApi })
    brokers.push(b)
    return b
  }

  it('a missing program (error + close, never exit): preparation falls back, and the next one is not blocked', async () => {
    const events = []
    const netApi = createAskpassPipeHost({
      exePath: () => join(tmpdir(), 'definitely-absent-tessel-askpass', 'tessel-askpass.exe'),
      spawnImpl: (...args) => {
        const child = spawn(...args)
        for (const e of ['error', 'exit', 'close']) child.on(e, () => events.push(e))
        return child
      }
    })
    const b = brokerWith(netApi)
    expect(await b.prepareLaunch('p', { sshExe: 'fake' })).toMatchObject({ status: 'fallback' })
    expect(events).toContain('error')
    expect(events).not.toContain('exit')
    // Not stuck: the next launch tries again and settles too.
    expect(await b.prepareLaunch('q', { sshExe: 'fake' })).toMatchObject({ status: 'fallback' })
  }, 20_000)

  it('a helper that never says READY: given up after the timeout, the process is ended', async () => {
    let fire = null
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stdout.setEncoding = () => {}
    child.stdin = Object.assign(new EventEmitter(), { write: () => {}, end: () => {} })
    let killed = 0
    child.kill = () => killed++
    const netApi = createAskpassPipeHost({
      exePath: () => 'C:/fake/tessel-askpass.exe',
      spawnImpl: () => child,
      timers: { setTimeout: (fn) => ((fire = fn), 1), clearTimeout: () => {} },
      readyTimeoutMs: 10
    })
    const b = brokerWith(netApi)
    const p = b.prepareLaunch('p', { sshExe: 'fake' })
    while (!fire) await new Promise((r) => setTimeout(r, 1))
    fire()
    expect(await p).toMatchObject({ status: 'fallback' })
    expect(killed).toBe(1)
    // Its late events change nothing.
    child.emit('exit', 0)
    child.emit('close', 0)
  })
})
