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
import { wakeLaunchArgs, WAKE_LAUNCH_PROMPT } from '../../shared/orchestration'
import { STATUS_PROVIDERS } from '../../shared/agentStateModel'
// Claude Code and Codex panes: status from their hooks from launch.
const managedAgentStatus = (leaf) => !!leaf.agentLaunchToken

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
    join,
    paneEnv,
    freshEnv: () => ({ PATH: 'fixture' }),
    shouldUseConpty: () => true,
    windowsBuildNumber: () => 123,
    prepareStatus: setup,
    // Folder pre-trust is covered by agentFolderTrust.spec.js: inert here.
    agentFolderTrust: { apply: async () => 'off' },
    app: { getPath: () => dir },
    STATUS_PROVIDERS,
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
    expect.objectContaining({ CODEX_HOME: join(dir, 'managed') }),
    undefined // no Settings opt-in sent (Cursor's status hooks stay off)
  )
  expect(app.setup.mock.calls[0][1]).not.toHaveProperty('codex_home')
  // Its rollout is read in that home (codexTurnEnd.js), also after a reattach.
  expect(app.ptyInfo.get('pane-account').agentCodexHome).toBe(join(dir, 'managed'))
  await app.handlers['pty:attach'](null, 'pane-account')
  expect(app.ptyInfo.get('pane-account').agentCodexHome).toBe(join(dir, 'managed'))
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
    managedAgentStatus,
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
    managedAgentStatus,
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

// The wake-up code (offerWake .. typeWake, noteLaunchWake, unreadAtLaunch)
// and, for launches, agentStartLine and createLeaf's launch block, run in a
// sandbox with inert stand-ins (nothing is started, nothing typed).
function wakeSandbox(over = {}) {
  const start = appSource.indexOf('// Messages wait for an agent whose state')
  const end = appSource.indexOf('\nconst restartedForTools', start)
  const lineStart = appSource.indexOf('async function agentStartLine(')
  const lineEnd = appSource.indexOf('\n// Codex, OpenCode, Cline and Copilot pick', lineStart)
  const launchStart = appSource.indexOf('  // Launch the agent CLI once the shell has had a moment')
  const launchEnd = appSource.indexOf('  return leaf', launchStart)
  expect(start).toBeGreaterThan(0)
  expect(lineStart).toBeGreaterThan(0)
  expect(launchStart).toBeGreaterThan(0)
  const written = []
  const ctx = {
    agentStateKnown: () => false,
    managedAgentStatus,
    teamUnread: {},
    settings: { teamWakeUps: true, agentPrefs: {} },
    wakeState: {},
    trackedState: {},
    approvals: {},
    limits: {},
    pendingMessages: {},
    unsent: {},
    delivering: new Set(),
    restartingLeaves: new Set(),
    agentInboxes: {},
    inboxDownAt: {},
    teams: { value: [] },
    window: {
      shellApi: {
        agentInbox: vi.fn(async () => ({ ok: true })),
        codexNoDaemon: async () => true,
        writePty: (id, text) => written.push(text),
        channel: { poll: vi.fn(async () => ({ ok: true, unreadCounts: {} })) }
      }
    },
    WAKE_AFTER_MS: 0,
    REWAKE_AFTER_MS: 600000,
    WAKE_AFTER_RESTART_MS: 120000,
    teamPointer: { notify: vi.fn(), state: () => null },
    wakeAllowed: vi.fn(() => true),
    deliverToAgent: vi.fn(),
    showToast: vi.fn(),
    t: (_k, english) => english,
    paneLabel: () => '#2 Codex',
    findLeaf: () => null,
    awaitingApproval: () => false,
    inputShownEmpty: () => false,
    getPane: () => null,
    userDraft: {},
    teamToolsReady: true,
    sessionKind: (a) => a.id,
    safeSessionId: () => true,
    newUuid: () => 'new-uuid',
    FOUND_AFTER_START: [],
    watchFoundSession: () => {},
    workerLaunchArgs: () => '',
    wakeLaunchArgs,
    setTimeout: (fn) => fn(),
    ...over
  }
  const api = vm.runInNewContext(
    appSource.slice(lineStart, lineEnd) +
      appSource.slice(start, end) +
      '\n;({ wakeIfNeeded, noteLaunchWake, pointerBlocked, launch: async (leaf, agent, opts, id, launch, accountId, agentModels) => {\n' +
      appSource.slice(launchStart, launchEnd) +
      '\n} })',
    ctx
  )
  // Launches the agent in pane opts.id the way createLeaf does; -> the line typed to start it.
  const launchLine = async (agentId, opts) => {
    written.length = 0
    const leaf = { id: opts.id }
    await api.launch(leaf, { id: agentId, name: agentId, command: agentId }, opts, opts.id, { command: agentId, args: '' }, undefined, null)
    return written[0]
  }
  return { ctx, api, launchLine, written: () => written }
}

it('Tessel relaunching a Codex with team messages waiting: a first prompt on its command line, fresh or resumed; none when nothing waits', async () => {
  const { ctx, launchLine } = wakeSandbox({ teamUnread: { 'pane-2': 2 } })
  const prompt = `"${WAKE_LAUNCH_PROMPT}"`
  // Resumed in place: `codex resume [OPTIONS] [SESSION_ID] [PROMPT]` (codex resume --help).
  expect(await launchLine('codex', { id: 'pane-2', sessionId: 's-2', resume: true, wake: { teamId: 'team-1', gen: 1 } })).toBe(
    `codex resume s-2 --no-daemon -c check_for_update_on_startup=false ${prompt}\r`
  )
  // Its reminder is given: recorded for this launch.
  expect(ctx.wakeState['pane-2']).toMatchObject({ woken: true, offered: true, launchPrompt: true, gen: 1 })
  // Fresh: `codex [OPTIONS] [PROMPT]`.
  expect(await launchLine('codex', { id: 'pane-2', wake: { teamId: 'team-1', gen: 0 } })).toBe(
    `codex --no-daemon -c check_for_update_on_startup=false ${prompt}\r`
  )
  // Nothing waiting: no prompt, nothing recorded.
  expect(await launchLine('codex', { id: 'pane-9', sessionId: 's-9', resume: true, wake: { teamId: 'team-1', gen: 1 } })).toBe(
    'codex resume s-9 --no-daemon -c check_for_update_on_startup=false\r'
  )
  expect(ctx.wakeState['pane-9']).toBeUndefined()
  // Not relaunched by Tessel as a team member (no opts.wake): never.
  expect(await launchLine('codex', { id: 'pane-2', sessionId: 's-2', resume: true })).not.toContain(WAKE_LAUNCH_PROMPT)
  // Claude Code has its own inbox: no first prompt.
  ctx.teamUnread['pane-c'] = 1
  expect(await launchLine('claude', { id: 'pane-c', wake: { teamId: 'team-1', gen: 1 } })).not.toContain(WAKE_LAUNCH_PROMPT)
  // Team tools not set up: it could not read them.
  ctx.teamToolsReady = false
  expect(await launchLine('codex', { id: 'pane-2', sessionId: 's-2', resume: true, wake: { teamId: 'team-1', gen: 1 } })).not.toContain(WAKE_LAUNCH_PROMPT)
})

it('team wake-ups off: no launch prompt, checked before and after counting and when the line is typed; nothing recorded', async () => {
  const prompt = WAKE_LAUNCH_PROMPT
  const opts = () => ({ id: 'pane-2', sessionId: 's-2', resume: true, wake: { teamId: 'team-1', gen: 1 } })
  // Off from the start.
  const off = wakeSandbox({ teamUnread: { 'pane-2': 2 } })
  off.ctx.settings.teamWakeUps = false
  expect(await off.launchLine('codex', opts())).not.toContain(prompt)
  expect(off.ctx.wakeState['pane-2']).toBeUndefined()
  // Turned off while the count was read (Tessel just started).
  const during = wakeSandbox({ teams: { value: [{ id: 'team-1', channelDir: 'C:\\proj' }] } })
  during.ctx.window.shellApi.channel.poll = vi.fn(async () => {
    during.ctx.settings.teamWakeUps = false
    return { ok: true, unreadCounts: { 'pane-2': 2 } }
  })
  expect(await during.launchLine('codex', opts())).not.toContain(prompt)
  expect(during.ctx.wakeState['pane-2']).toBeUndefined()
  // Turned off before the deferred line is typed.
  const timers = []
  const late = wakeSandbox({ teamUnread: { 'pane-2': 2 }, setTimeout: (fn) => timers.push(fn) })
  expect(await late.launchLine('codex', opts())).toBeUndefined()
  late.ctx.settings.teamWakeUps = false
  timers.forEach((fn) => fn())
  expect(late.written()[0]).toBe('codex resume s-2 --no-daemon -c check_for_update_on_startup=false\r')
  expect(late.ctx.wakeState['pane-2']).toBeUndefined()
})

it('the pointer is blocked once team wake-ups are off, a usage limit shows, or it works', () => {
  for (const unconfirmed of [false, true]) {
    const node = { id: 'pane-7', agentLaunchToken: 'a'.repeat(32), agentId: 'codex', sessionId: 's-7', team: 'team-1', kind: 'agent', teamTools: true, launchedAt: 0 }
    const { ctx, api } = wakeSandbox({
      teamUnread: { 'pane-7': 1 },
      findLeaf: () => node,
      agentStateKnown: () => !unconfirmed,
      trackedState: { 'pane-7': { state: unconfirmed ? 'unknown' : 'idle' } }
    })
    ctx.settings.teamWakeUnconfirmed = unconfirmed
    api.wakeIfNeeded(node)
    // Typed by the pointer delivery (src/renderer/src/teamDelivery.js), never
    // as a queued message.
    expect(ctx.teamPointer.notify).toHaveBeenCalledWith('pane-7')
    expect(ctx.deliverToAgent).not.toHaveBeenCalled()
    const state = ctx.trackedState['pane-7'].state
    expect(api.pointerBlocked('pane-7')).toBe('')
    ctx.settings.teamWakeUps = false
    expect(api.pointerBlocked('pane-7')).not.toBe('')
    ctx.settings.teamWakeUps = true
    ctx.limits['pane-7'] = { reset: '' }
    expect(api.pointerBlocked('pane-7')).not.toBe('')
    delete ctx.limits['pane-7']
    for (const s of ['limited', 'working', 'approval']) {
      ctx.trackedState['pane-7'].state = s
      expect(api.pointerBlocked('pane-7')).not.toBe('')
    }
    ctx.trackedState['pane-7'].state = state
    expect(api.pointerBlocked('pane-7')).toBe('')
    // Never into a pane that is not an agent's (a plain terminal, a chat).
    node.kind = 'terminal'
    expect(api.pointerBlocked('pane-7')).not.toBe('')
    node.kind = 'agent'
    // Another message is being typed there, or one is left unsent.
    ctx.delivering.add('pane-7')
    expect(api.pointerBlocked('pane-7')).not.toBe('')
    ctx.delivering.delete('pane-7')
    ctx.unsent['pane-7'] = {}
    expect(api.pointerBlocked('pane-7')).not.toBe('')
    delete ctx.unsent['pane-7']
    expect(api.pointerBlocked('pane-7')).toBe('')
  }
})

it('Tessel just started (nothing polled yet): the count comes from the team channel, only counts asked', async () => {
  const poll = vi.fn(async () => ({ ok: true, unreadCounts: { 'pane-4': 3 } }))
  const { ctx, launchLine } = wakeSandbox({ teams: { value: [{ id: 'team-1', channelDir: 'C:\\proj' }] } })
  ctx.window.shellApi.channel.poll = poll
  expect(await launchLine('codex', { id: 'pane-4', sessionId: 's-4', resume: true, wake: { teamId: 'team-1', gen: 0 } })).toContain(`"${WAKE_LAUNCH_PROMPT}"`)
  expect(poll).toHaveBeenCalledWith({ dir: 'C:\\proj', teamId: 'team-1', availableIds: [] })
  // Another team (none recorded): no count, no prompt.
  expect(await launchLine('codex', { id: 'pane-4', sessionId: 's-4', resume: true, wake: { teamId: 'team-x', gen: 0 } })).not.toContain(WAKE_LAUNCH_PROMPT)
})

it('launched with the prompt: no toast and nothing typed for the same messages, whatever the setting', async () => {
  for (const teamWakeUnconfirmed of [false, true]) {
    const node = { id: 'pane-2', agentLaunchToken: 'f'.repeat(32), agentId: 'codex', sessionId: 's-2', kind: 'agent', teamTools: true, gen: 1, launchedAt: 0 }
    const { ctx, launchLine, api } = wakeSandbox({ teamUnread: { 'pane-2': 2 }, findLeaf: () => node, trackedState: { 'pane-2': { state: 'unknown' } } })
    ctx.settings.teamWakeUnconfirmed = teamWakeUnconfirmed
    await launchLine('codex', { id: 'pane-2', sessionId: 's-2', resume: true, wake: { teamId: 'team-1', gen: 1 } })
    api.wakeIfNeeded(node)
    api.wakeIfNeeded(node)
    expect(ctx.showToast).not.toHaveBeenCalled()
    expect(ctx.deliverToAgent).not.toHaveBeenCalled()
    if (teamWakeUnconfirmed) expect(api.pointerBlocked('pane-2')).toMatch(/launched with a prompt/)
    // All read: the next messages get a reminder again.
    ctx.teamUnread['pane-2'] = 0
    api.wakeIfNeeded(node)
    expect(ctx.wakeState['pane-2']).toBeUndefined()
  }
})

it('setting on: an unconfirmed Codex gets the pointer typed, with the same checks', () => {
  const node = { id: 'pane-5', agentLaunchToken: 'a'.repeat(32), agentId: 'codex', sessionId: 's-5', team: 'team-1', kind: 'agent', teamTools: true, launchedAt: 0 }
  const { ctx, api } = wakeSandbox({ teamUnread: { 'pane-5': 1 }, findLeaf: () => node, trackedState: { 'pane-5': { state: 'unknown' } } })
  ctx.settings.teamWakeUnconfirmed = true
  api.wakeIfNeeded(node)
  expect(ctx.showToast).not.toHaveBeenCalled()
  expect(ctx.teamPointer.notify).toHaveBeenCalledWith('pane-5')
  expect(api.pointerBlocked('pane-5')).toBe('')
  // You are typing there (wakeAllowed without the launch-state requirement says no).
  ctx.wakeAllowed.mockReturnValue(false)
  expect(api.pointerBlocked('pane-5')).not.toBe('')
  expect(ctx.wakeAllowed).toHaveBeenCalledWith('pane-5', true)
  ctx.wakeAllowed.mockReturnValue(true)
  // Working, an approval, or just launched: nothing either.
  ctx.trackedState['pane-5'].state = 'working'
  expect(api.pointerBlocked('pane-5')).not.toBe('')
  ctx.trackedState['pane-5'].state = 'unknown'
  ctx.approvals['pane-5'] = true
  expect(api.pointerBlocked('pane-5')).not.toBe('')
  delete ctx.approvals['pane-5']
  node.launchedAt = Date.now()
  expect(api.pointerBlocked('pane-5')).not.toBe('')
  node.launchedAt = 0
  ctx.unsent['pane-5'] = {}
  expect(api.pointerBlocked('pane-5')).not.toBe('')
  delete ctx.unsent['pane-5']
  // The setting turned off meanwhile: not typed.
  ctx.settings.teamWakeUnconfirmed = false
  expect(api.pointerBlocked('pane-5')).not.toBe('')
  ctx.settings.teamWakeUnconfirmed = true
  expect(api.pointerBlocked('pane-5')).toBe('')
})

it('setting off (the default): an unconfirmed Codex is not typed into, the user is asked', () => {
  const node = { id: 'pane-6', agentLaunchToken: 'a'.repeat(32), agentId: 'codex', sessionId: 's-6', kind: 'agent', teamTools: true, launchedAt: 0 }
  const { ctx, api } = wakeSandbox({ teamUnread: { 'pane-6': 2 }, findLeaf: () => node, trackedState: { 'pane-6': { state: 'unknown' } } })
  api.wakeIfNeeded(node)
  expect(ctx.deliverToAgent).not.toHaveBeenCalled()
  expect(ctx.showToast).toHaveBeenCalledTimes(1)
})
