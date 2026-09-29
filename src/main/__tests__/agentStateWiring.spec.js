// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import vm from 'vm'
import crypto from 'crypto'
import { join, resolve, sep, isAbsolute } from 'path'
import { createAgentStateStore } from '../agentStateStore'
import { paneEnv } from '../paneEnv'
import { newTeamSecret, setTeamSecret, revokeTeamSecret, teamSecretOf, _resetTeamAuth } from '../teamAuth'

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
    newTeamSecret,
    setTeamSecret,
    revokeTeamSecret,
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
    revokeTeamSecret: vi.fn(),
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

it('unconfirmed state without an inbox for its session: no typing, the user is asked', () => {
  const start = appSource.indexOf('// Messages wait for an agent whose state')
  const end = appSource.indexOf('\nconst restartedForTools', start)
  const agentInbox = vi.fn(async () => ({ ok: true })),
    deliverToAgent = vi.fn(),
    showToast = vi.fn()
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
    agentInboxes: { 'pane-1': 'an-older-session' },
    inboxDownAt: {},
    window: { shellApi: { agentInbox } },
    WAKE_AFTER_MS: 0,
    REWAKE_AFTER_MS: 0,
    wakeAllowed: () => true,
    deliverToAgent,
    showToast,
    t: (_k, english) => english,
    paneLabel: () => '#1 Claude Code',
    findLeaf: () => node,
    awaitingApproval: () => false,
    userDraft: {}
  })
  run(node)
  expect(agentInbox).not.toHaveBeenCalled()
  expect(deliverToAgent).not.toHaveBeenCalled()
  // Instead it asks the user once; only their click sends the reminder.
  expect(showToast).toHaveBeenCalledTimes(1)
  run(node)
  expect(showToast).toHaveBeenCalledTimes(1)
  // A stale toast does nothing: relaunched meanwhile (another launch token).
  const token = node.agentLaunchToken
  node.agentLaunchToken = 'c'.repeat(32)
  showToast.mock.calls[0][1].action.run()
  expect(deliverToAgent).not.toHaveBeenCalled()
  node.agentLaunchToken = token
  showToast.mock.calls[0][1].action.run()
  expect(deliverToAgent).toHaveBeenCalledTimes(1)
  const meta = deliverToAgent.mock.calls[0][2]
  expect(meta).toMatchObject({ source: 'user', scope: 'wake', dropIfNotNow: true })
  // The guard runs again right before typing: a relaunch meanwhile drops it.
  expect(meta.guard()).toBe(true)
  node.agentLaunchToken = 'd'.repeat(32)
  expect(meta.guard()).toBe(false)
})

it("unconfirmed Claude with its current session's inbox: the reminder goes to the inbox, never typed; a failed inbox asks the user", async () => {
  const start = appSource.indexOf('// Messages wait for an agent whose state')
  const end = appSource.indexOf('\nconst restartedForTools', start)
  const make = (inboxResult) => {
    const agentInbox = vi.fn(async () => inboxResult)
    const deliverToAgent = vi.fn()
    const showToast = vi.fn()
    const node = { id: 'pane-3', agentLaunchToken: 'e'.repeat(32), agentId: 'claude', sessionId: 's-3', kind: 'agent', teamTools: true }
    const run = vm.runInNewContext(appSource.slice(start, end) + '; wakeIfNeeded', {
      agentStateKnown: () => false,
      teamUnread: { 'pane-3': 1 },
      settings: { teamWakeUps: true },
      wakeState: {},
      trackedState: {},
      approvals: {},
      limits: {},
      pendingMessages: {},
      unsent: {},
      delivering: new Set(),
      restartingLeaves: new Set(),
      agentInboxes: { 'pane-3': 's-3' },
      inboxDownAt: {},
      window: { shellApi: { agentInbox } },
      WAKE_AFTER_MS: 0,
      REWAKE_AFTER_MS: 600000,
      wakeAllowed: () => true,
      deliverToAgent,
      showToast,
      t: (_k, english) => english,
      paneLabel: () => '#3 Claude Code',
      findLeaf: () => node,
      awaitingApproval: () => false,
      userDraft: {}
    })
    return { run, node, agentInbox, deliverToAgent, showToast }
  }
  const ok = make({ ok: true })
  ok.run(ok.node)
  ok.run(ok.node)
  await new Promise((r) => setTimeout(r, 0))
  expect(ok.agentInbox).toHaveBeenCalledTimes(1)
  expect(ok.agentInbox.mock.calls[0][0]).toMatchObject({ paneId: 'pane-3', sessionId: 's-3' })
  expect(ok.deliverToAgent).not.toHaveBeenCalled()
  expect(ok.showToast).not.toHaveBeenCalled()
  const down = make({ ok: false, error: 'gone' })
  down.run(down.node)
  await new Promise((r) => setTimeout(r, 0))
  expect(down.deliverToAgent).not.toHaveBeenCalled()
  expect(down.showToast).toHaveBeenCalledTimes(1)
})

it("each launch gets its own team secret, only in the pane's environment and main's memory", async () => {
  _resetTeamAuth()
  store = createAgentStateStore({ dir })
  const one = wire()
  const opts = { id: 'pane-secret', shellId: 'fixture', agentId: 'claude', cwd: dir }
  const res = await one.handlers['pty:create'](null, opts)
  const secret = one.records.get(opts.id).launchEnv.TESSEL_TEAM_SECRET
  expect(secret).toMatch(/^[a-f0-9]{64}$/)
  expect(teamSecretOf(opts.id)).toBe(secret)
  // Never handed to the interface.
  expect(JSON.stringify(res)).not.toContain(secret)
  // Tessel restarted, the terminal kept running: its secret comes back from the host.
  revokeTeamSecret(opts.id)
  const attached = await wire(one.records).handlers['pty:attach'](null, opts.id)
  expect(JSON.stringify(attached)).not.toContain(secret)
  expect(teamSecretOf(opts.id)).toBe(secret)
  // A relaunch: a new secret, the old one void.
  await one.handlers['pty:create'](null, opts)
  expect(teamSecretOf(opts.id)).not.toBe(secret)
  _resetTeamAuth()
})
