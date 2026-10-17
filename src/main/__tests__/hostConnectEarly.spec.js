// @vitest-environment node
// The terminal host is reached as soon as Tessel runs (index.js's own code),
// before the window's page has loaded: what the connection tells the window
// (ssh's questions, the sync on connecting, an agent's missing tools) waits
// for that page, channels and connection states go on at once, and the
// agent list is looked up at start once the PATH and Python's folder are known.
import { describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import vm from 'vm'
import { join } from 'path'

// Line ends as written (a Windows checkout has CRLF).
const main = fs.readFileSync(join(__dirname, '..', 'index.js'), 'utf8').replace(/\r\n/g, '\n')
function slice(from, to) {
  const a = main.indexOf(from)
  const b = main.indexOf(to, a)
  if (a < 0 || b < 0) throw new Error(`index.js changed: ${from}`)
  return main.slice(a, b)
}

function load() {
  const calls = []
  const sshRemote = {
    onEvent: vi.fn((msg) => calls.push(['event', msg.op])),
    onConnected: vi.fn(async () => calls.push(['sync'])),
    onLost: vi.fn(() => calls.push(['lost']))
  }
  const ctx = {
    sshRemote,
    remoteToolsMissing: vi.fn((msg) => calls.push(['tools', msg.id])),
    hostConnectedAt: 0,
    hostPtysAtConnect: [],
    quitting: false,
    log: { error: vi.fn() },
    ptyInfo: new Map(),
    agentStateStore: { unregister: vi.fn(async () => {}) },
    sshAskpass: { paneExited: vi.fn() },
    remoteHosts: { paneExited: vi.fn() },
    send: vi.fn(),
    Date
  }
  vm.createContext(ctx)
  vm.runInContext(
    slice('let pageLoaded = false', 'const host = createPtyClient({') +
      '\nthis.client = {' +
      slice('  // ssh2 connections, channels and questions', '\n})\nliveShare = registerLiveShare(') +
      '}\nthis.api = { pageDidLoad, beforePage, pageLoadedAt: () => pageLoadedAt, connectedAt: () => hostConnectedAt, ptys: () => hostPtysAtConnect }',
    ctx
  )
  return { ctx, calls, client: ctx.client, api: ctx.api, sshRemote }
}

describe('the terminal host reached before the page has loaded', () => {
  it('holds the sync and the questions for the page, passes channels and states at once', () => {
    const env = load()
    env.client.onConnected({ pid: 9, ptys: [{ id: 'pane-1' }] })
    expect(env.api.connectedAt()).toBeGreaterThan(0)
    expect(env.api.ptys()).toEqual([{ id: 'pane-1' }])
    env.client.onEvent({ op: 'ssh-prompt', promptId: 'p1' })
    env.client.onEvent({ op: 'ssh-state', hostId: 'ssh-a' })
    env.client.onEvent({ op: 'ssh-out', ch: 'c1' })
    env.client.onEvent({ op: 'remote-tools', id: 'pane-2' })
    env.client.onEvent({ op: 'ssh-prompt-done', promptId: 'p1' })
    // Only what the window does not show went on.
    expect(env.calls).toEqual([
      ['event', 'ssh-state'],
      ['event', 'ssh-out']
    ])
    env.api.pageDidLoad()
    expect(env.api.pageLoadedAt()).toBeGreaterThan(0)
    // Then, in their order: the sync first (asked on connecting), then the
    // question, the missing tools and the question's end.
    expect(env.calls.slice(2)).toEqual([['sync'], ['event', 'ssh-prompt'], ['tools', 'pane-2'], ['event', 'ssh-prompt-done']])
    // Once loaded, nothing waits; a second load event changes nothing.
    env.client.onEvent({ op: 'ssh-prompt', promptId: 'p2' })
    env.client.onConnected({ pid: 9, ptys: [] })
    env.api.pageDidLoad()
    expect(env.calls.slice(6)).toEqual([['event', 'ssh-prompt'], ['sync']])
    expect(env.sshRemote.onConnected).toHaveBeenCalledTimes(2)
  })

  it('a page already loaded gets the sync at once (a reconnection later on)', () => {
    const env = load()
    env.api.pageDidLoad()
    env.client.onConnected({ pid: 9, ptys: [] })
    expect(env.calls).toEqual([['sync']])
  })

  it('a connection lost before the page loaded leaves nothing held for it', () => {
    const env = load()
    env.client.onConnected({ pid: 9, ptys: [] })
    env.client.onEvent({ op: 'ssh-prompt', promptId: 'p1' })
    env.client.onLost()
    expect(env.calls).toEqual([['lost']])
    // The next connection's own sync is what the page gets.
    env.client.onConnected({ pid: 10, ptys: [] })
    env.api.pageDidLoad()
    expect(env.calls).toEqual([['lost'], ['sync']])
  })

  it('what waits is bounded, and one failure does not stop the rest', () => {
    const env = load()
    env.sshRemote.onEvent.mockImplementationOnce(() => {
      throw new Error('boom')
    })
    for (let i = 0; i < 600; i++) env.client.onEvent({ op: 'ssh-prompt', promptId: 'p' + i })
    expect(env.api.beforePage).toHaveLength(500)
    env.api.pageDidLoad()
    expect(env.sshRemote.onEvent).toHaveBeenCalledTimes(500)
    expect(env.api.beforePage).toHaveLength(0)
  })
})

describe('the start wiring', () => {
  const start = slice('Promise.all([acquireInstanceLock(), app.whenReady()]).then(', "app.on('child-process-gone'")
  it('connects once this copy holds the lock, before the window is made', () => {
    const lock = start.indexOf('if (!gotInstanceLock)')
    const ensure = start.indexOf('host.ensure()')
    expect(lock).toBeGreaterThan(0)
    expect(ensure).toBeGreaterThan(lock)
    expect(ensure).toBeLessThan(start.indexOf('createWindow()'))
    // A failure is said in the log; the window's first terminal tries again.
    expect(start).toMatch(/host\.ensure\(\)\.catch\(\(err\) => log\.warn\('pty'/)
    expect(start.indexOf('warmAgentList()')).toBeLessThan(start.indexOf('createWindow()'))
  })

  it('the page releases what waits for it when it has loaded', () => {
    const createWindow = slice('function createWindow()', '// Windows takes a taskbar button')
    expect(createWindow).toMatch(/webContents\.on\('did-finish-load', pageDidLoad\)/)
  })

  it('the agent list waits for the PATH and Python\'s scripts folder', async () => {
    const order = []
    let pathDone, pythonDone
    const ctx = {
      freshPathRead: new Promise((r) => (pathDone = r)),
      pythonDirsRead: new Promise((r) => (pythonDone = r)),
      getAgents: vi.fn(async () => order.push('agents')),
      Date
    }
    vm.createContext(ctx)
    vm.runInContext(slice('let agentListReadyAt = 0', '\nfunction defaultShell()') + '\nthis.warm = warmAgentList; this.readyAt = () => agentListReadyAt', ctx)
    ctx.warm()
    await new Promise((r) => setImmediate(r))
    pathDone()
    await new Promise((r) => setImmediate(r))
    expect(ctx.getAgents).not.toHaveBeenCalled()
    pythonDone()
    await new Promise((r) => setImmediate(r))
    expect(order).toEqual(['agents'])
    expect(ctx.readyAt()).toBeGreaterThan(0)
  })
})
