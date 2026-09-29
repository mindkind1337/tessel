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

function harness({ helper = 'fake.exe', createDelay = null } = {}) {
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
  let finishCreate = null
  const handlers = {}
  vm.runInNewContext(handlerSource, {
    ipcMain: { handle: (k, v) => (handlers[k] = v) },
    getShells: () => [{ id: 'shell', name: 'fixture', file: 'fake.exe', args: [] }],
    defaultShell: () => ({}),
    remoteHosts: {
      launchFor: (id) => ({ ok: true, target: { id }, name: 'fake', file: 'fake-ssh', args: [] }),
      paneStarted: (...a) => started.push(a)
    },
    remoteProjectLaunch: (r) => r,
    os: { homedir: () => 'C:/fixture' },
    fs: { existsSync: () => false },
    isAbsolute: () => false,
    crypto: { randomBytes: () => Buffer.alloc(16) },
    shouldUseConpty: () => true,
    paneEnv: () => ({}),
    freshEnv: () => ({}),
    prepareStatus: () => ({ ok: true }),
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
        creates.push({ kind, askpass: !!v.env.SSH_ASKPASS, token: v.env.TESSEL_ASKPASS_TOKEN })
        if (createDelay) return new Promise((resolve) => (finishCreate = () => resolve({ ok: true, pid: 4242 })))
        return Promise.resolve({ ok: true, pid: 4242 })
      },
      send: (kind, v) => sent.push({ kind, ...v })
    },
    log: { error: () => {}, warn: () => {}, info: () => {} },
    t: (_key, fallback) => fallback
  })
  const create = (id = 'pane-1') => handlers['pty:create'](null, { id, shellId: 'shell', remoteHostId: 'host-1' })
  return { broker, creates, sent, started, create, version: () => answerVersion(), finishCreate: () => finishCreate() }
}

describe('pty:create with askpass (the real handler from index.js)', () => {
  it('a normal launch gives ssh askpass and counts it as started', async () => {
    const h = harness()
    const p = h.create()
    await Promise.resolve()
    h.version()
    const res = await p
    expect(res.ok).toBe(true)
    expect(h.creates).toEqual([{ kind: 'create', askpass: true, token: expect.stringMatching(/^[0-9a-f]{64}$/) }])
    expect(h.started).toEqual([['pane-1', 'host-1', { connected: false }]])
    h.broker.close()
  })

  it('closed while ssh -V runs: no terminal is created at all (not a fallback without askpass)', async () => {
    const h = harness()
    const p = h.create()
    await Promise.resolve()
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
    await Promise.resolve()
    const second = h.create()
    await Promise.resolve()
    h.version()
    expect(await first).toMatchObject({ ok: false, cancelled: true })
    expect((await second).ok).toBe(true)
    expect(h.creates).toHaveLength(1)
    h.broker.close()
  })

  it('closed while the terminal is being created: that ssh is ended, its token revoked', async () => {
    const h = harness({ createDelay: true })
    const p = h.create()
    await Promise.resolve()
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
