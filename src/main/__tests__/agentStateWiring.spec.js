// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import vm from 'vm'
import crypto from 'crypto'
import { join, resolve, sep, isAbsolute } from 'path'
import { createAgentStateStore } from '../agentStateStore'
import { paneEnv } from '../paneEnv'

// Exercise the actual IPC handlers with an inert terminal host. No Electron
// instance or real CLI/user configuration is touched by this harness.
const main = fs.readFileSync(join(__dirname, '..', 'index.js'), 'utf8')
const appSource = fs.readFileSync(join(__dirname, '..', '..', 'renderer', 'src', 'App.vue'), 'utf8')
const handlersSource = main.slice(
  main.indexOf("ipcMain.handle('pty:create'"),
  main.indexOf('// After the interface restores its panes')
)
let dir, store
beforeEach(() => {
  dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-state-wire-'))
})
afterEach(async () => {
  await store?.dispose()
  const target = resolve(dir)
  if (!target.startsWith(resolve(os.tmpdir()) + sep) || !target.includes('tessel-state-wire-'))
    throw new Error('Unsafe fixture')
  fs.rmSync(target, { recursive: true, force: true })
})
function wire(hostRecords = new Map()) {
  const handlers = {}
  const setup = vi.fn(() => ({ ok: true }))
  const host = {
    request: vi.fn(async (op, q) => {
      if (op === 'create') {
        const record = { ok: true, pid: 100 + hostRecords.size, ...q.meta, launchEnv: q.env }
        hostRecords.set(q.id, record)
        return record
      }
      return hostRecords.get(q.id) || { ok: false }
    })
  }
  const ptyInfo = new Map()
  vm.runInNewContext(handlersSource, {
    ipcMain: {
      handle: (name, fn) => {
        handlers[name] = fn
      }
    },
    getShells: () => [{ id: 'fixture', name: 'Fixture', file: 'inert-shell', args: [] }],
    defaultShell: () => ({ id: 'fixture', name: 'Fixture', file: 'inert-shell', args: [] }),
    fs,
    os,
    crypto,
    isAbsolute,
    paneEnv,
    freshEnv: () => ({ PATH: 'fixture' }),
    shouldUseConpty: () => true,
    windowsBuildNumber: () => 123,
    prepareStatus: setup,
    host,
    ptyInfo,
    pendingData: new Map(),
    agentStateStore: store,
    agentStateDir: dir,
    log: { error: vi.fn() }
  })
  return { handlers, records: hostRecords, setup, ptyInfo }
}
it('new launches get distinct identities; reconnect retains the exact host identity', async () => {
  store = createAgentStateStore({ dir })
  const one = wire()
  const opts = { id: 'pane-status', shellId: 'fixture', agentId: 'codex', cwd: dir }
  const first = await one.handlers['pty:create'](null, opts)
  expect(first.agentLaunchToken).toMatch(/^[a-f0-9]{32}$/)
  const hostEntry = one.records.get(opts.id)
  expect(hostEntry.launchEnv).toMatchObject({
    TESSEL_AGENT_LAUNCH: first.agentLaunchToken,
    TESSEL_AGENT_PROVIDER: 'codex',
    TESSEL_AGENT_STATE_DIR: dir
  })
  const attached = await one.handlers['pty:attach'](null, opts.id)
  expect(attached.agentLaunchToken).toBe(first.agentLaunchToken)
  await store.dispose()
  store = createAgentStateStore({ dir })
  const reopened = wire(one.records)
  const afterReload = await reopened.handlers['pty:attach'](null, opts.id)
  expect(afterReload.agentLaunchToken).toBe(first.agentLaunchToken)
  expect(store.snapshot()[opts.id]).toMatchObject({ state: 'unknown', confirmed: false })
  const restarted = await reopened.handlers['pty:create'](null, opts)
  expect(restarted.agentLaunchToken).not.toBe(first.agentLaunchToken)
  await store.observe(opts.id, first.agentLaunchToken, { event: 'ScreenApproval' })
  expect(store.snapshot()[opts.id].state).toBe('unknown')
})
it('uses account-scoped environment after all overlays for hook setup', async () => {
  store = createAgentStateStore({ dir })
  const app = wire()
  await app.handlers['pty:create'](null, {
    id: 'pane-account',
    agentId: 'codex',
    cwd: dir,
    extraEnv: { codex_home: 'old' },
    accountEnv: { CODEX_HOME: join(dir, 'managed') }
  })
  expect(app.setup).toHaveBeenCalledWith(
    'codex',
    expect.objectContaining({ CODEX_HOME: join(dir, 'managed') })
  )
  expect(app.setup.mock.calls[0][1]).not.toHaveProperty('codex_home')
})
it('keeps the reset text from the real screen observation boundary', async () => {
  store = createAgentStateStore({ dir })
  const app = wire()
  const result = await app.handlers['pty:create'](null, {
    id: 'pane-reset',
    agentId: 'codex',
    cwd: dir
  })
  await store.observe('pane-reset', result.agentLaunchToken, {
    event: 'ScreenLimit',
    reset: '10pm (America/Toronto)'
  })
  expect(store.snapshot()['pane-reset']).toMatchObject({
    state: 'limited',
    reset: '10pm (America/Toronto)'
  })
})
it('does not force legacy attached agents to restart or invent their hook coverage', async () => {
  store = createAgentStateStore({ dir })
  const records = new Map([
    ['legacy', { ok: true, pid: 321, shellId: 'fixture', shellName: 'Fixture' }]
  ])
  const app = wire(records)
  expect(await app.handlers['pty:attach'](null, 'legacy')).toMatchObject({
    ok: true,
    agentLaunchToken: null
  })
  expect(app.setup).not.toHaveBeenCalled()
  expect(store.snapshot()).toEqual({})
})
it('a delayed exit cannot close the new execution registered for the same pane', async () => {
  store = createAgentStateStore({ dir })
  const ptyInfo = new Map([['pane-1', { pid: 202, agentLaunchToken: 'b'.repeat(32) }]])
  const unregister = vi.fn(async () => {})
  const send = vi.fn()
  const start = main.indexOf('  onExit: (id, exitCode, signal, pid) => {')
  const end = main.indexOf('  onLost:', start)
  const handler = vm.runInNewContext('({' + main.slice(start, end) + '})', {
    ptyInfo,
    agentStateStore: { unregister },
    installLogs: { onExit: vi.fn() },
    remoteHosts: { paneExited: vi.fn() },
    sshAskpass: { paneExited: vi.fn() },
    flushData: vi.fn(),
    send,
    log: { warn: vi.fn() }
  }).onExit
  handler('pane-1', 0, 0, 101)
  expect(unregister).not.toHaveBeenCalled()
  expect(send).not.toHaveBeenCalled()
  handler('pane-1', 0, 0, 202)
  expect(unregister).toHaveBeenCalledWith('pane-1', 'b'.repeat(32))
})

it('does not overwrite an authoritative state clock with the previous execution history', () => {
  const start = appSource.indexOf('function logState(id, info, state) {')
  const end = appSource.indexOf('\nwatch(', start)
  const trackedState = {},
    restoreDone = {},
    activity = [],
    lastStateEvent = {}
  const restoreSince = vi.fn(() => {
    throw new Error('Old activity must not override a confirmed clock')
  })
  const run = vm.runInNewContext(appSource.slice(start, end) + '; logState', {
    loggedState: {},
    trackedState,
    restoreDone,
    lastStateEvent,
    activity,
    restoreSince,
    appStartedAt: Date.now(),
    RESTORE_WINDOW_MS: 60000,
    recordActivity: (event) => activity.push(event)
  })
  const since = Date.now() - 2000
  run('pane-1', { state: 'approval', since, confirmed: true, title: 'Fixture' }, 'approval')
  expect(trackedState['pane-1']).toMatchObject({ since, sinceStart: false })
  expect(restoreSince).not.toHaveBeenCalled()
})

it('blocks both native-inbox and typed wake paths when managed status is not confirmed', () => {
  const start = appSource.indexOf('function wakeIfNeeded(leaf) {')
  const end = appSource.indexOf('\nconst restartedForTools', start)
  const agentInbox = vi.fn(async () => ({ ok: true })),
    deliverToAgent = vi.fn()
  const node = {
    id: 'pane-1',
    agentLaunchToken: 'a'.repeat(32),
    agentId: 'claude',
    sessionId: 'session-1',
    kind: 'agent',
    teamTools: true
  }
  const run = vm.runInNewContext(appSource.slice(start, end) + '; wakeIfNeeded', {
    agentStateKnown: () => false,
    teamUnread: { 'pane-1': 1 },
    settings: { teamWakeUps: true },
    wakeState: { 'pane-1': { since: 0, woken: false } },
    trackedState: { 'pane-1': { state: 'idle' } },
    approvals: {},
    limits: {},
    pendingMessages: {},
    unsent: {},
    delivering: new Set(),
    restartingLeaves: new Set(),
    agentInboxes: { 'pane-1': 'session-1' },
    inboxDownAt: {},
    window: { shellApi: { agentInbox } },
    WAKE_AFTER_MS: 0,
    REWAKE_AFTER_MS: 0,
    wakeAllowed: () => true,
    deliverToAgent
  })
  run(node)
  expect(agentInbox).not.toHaveBeenCalled()
  expect(deliverToAgent).not.toHaveBeenCalled()
})
