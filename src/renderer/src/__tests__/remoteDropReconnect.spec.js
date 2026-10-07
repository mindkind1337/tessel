// Panes on an SSH host reopen with the host, like VS Code's: after Tessel
// restarted (they were restored waiting for Connect) or after a dropped
// connection (ssh ended with 255), once the host is signed in again (Connect
// in one pane, or its shared connection back), all that host's waiting panes
// reopen together: a shell in its folder, an agent resuming its conversation.
// Nothing signs in by itself. Run on App.vue's own code (connectLeaf, its
// watch, waitForHostAgain).
import { describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import vm from 'vm'
import { join } from 'path'
import { reactive } from 'vue'
import { allowDropRetry, droppedRemotePane } from '../projectLauncher'
import { claudeStartChoice, codexResumes } from '../remoteAgentLaunch'

const source = fs.readFileSync(join(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')
function slice(from, to) {
  const a = source.indexOf(from)
  const b = source.indexOf(to, a)
  if (a < 0 || b < 0) throw new Error(`App.vue changed: ${from}`)
  return source.slice(a, b)
}

const HOST = 'ssh-box'
const SESSION = '22222222-3333-4444-8555-666666666666'

function load({ shared = false, disconnected = false } = {}) {
  const states = reactive({ [HOST]: shared ? { status: 'connected', shared: true } : { status: 'disconnected' } })
  const ws = reactive({ id: 'ws1', cwd: null, remote: { hostId: HOST, path: '/srv/app' }, tree: null })
  const watchers = []
  const mounted = []
  const exitHandlers = []
  const findLeafIn = (node, id) => {
    if (!node) return null
    if (node.type === 'leaf') return node.id === id ? node : null
    for (const c of node.children) {
      const f = findLeafIn(c, id)
      if (f) return f
    }
    return null
  }
  const replaceNode = (node, id, make) => {
    if (node.type === 'leaf') return node.id === id ? make(node) : node
    return { ...node, children: node.children.map((c) => replaceNode(c, id, make)) }
  }
  const ctx = {
    reactive,
    watch: (getter, cb) => watchers.push({ getter, cb }),
    onMounted: (fn) => mounted.push(fn),
    onBeforeUnmount: () => {},
    hostShared: (id) => !!(states[id] && states[id].shared),
    recentlyDisconnected: () => disconnected,
    droppedRemotePane,
    allowDropRetry,
    restartingLeaves: new Set(),
    switchingLeaves: new Set(),
    getPane: () => ({ screenText: () => 'what it showed' }),
    setDraft: vi.fn(),
    findLeaf: (id) => findLeafIn(ws.tree, id),
    wsOfLeaf: (id) => (findLeafIn(ws.tree, id) ? ws : null),
    forEachWsLeaf: (fn) => {
      const walk = (n) => (n ? (n.type === 'leaf' ? fn(n) : n.children.forEach(walk)) : null)
      walk(ws.tree)
    },
    replaceNode,
    Date,
    Promise,
    String,
    window: {
      shellApi: {
        killPty: vi.fn(),
        onExit: (fn) => {
          exitHandlers.push(fn)
          return () => {}
        }
      }
    }
  }
  vm.createContext(ctx)
  vm.runInContext(
    slice('const connectingLeaves = new Set()', '// Replace a pane with a fresh process') +
      slice('// --- Panes on an SSH host after a dropped connection', '// Pane menu > Restart in Yolo') +
      '\nthis.api = { connectLeaf, waitForHostAgain }',
    ctx
  )
  // createLeaf is App.vue's (tested in remotePaneRestore.spec.js): here, what it is asked.
  ctx.createLeaf = vi.fn(async (shellId, agent, cwd, worktree, opts) =>
    reactive({ type: 'leaf', id: opts.id, shellId, kind: agent ? 'agent' : 'shell', agentId: agent ? agent.id : null, remoteHostId: opts.remoteHostId, remotePath: opts.remotePath, sessionId: opts.sessionId, pid: 99 })
  )
  for (const fn of mounted) fn()
  const runWatchers = () => {
    for (const w of watchers) w.cb(w.getter())
  }
  const exit = (e) => exitHandlers.forEach((fn) => fn(e))
  return { api: ctx.api, ctx, ws, states, runWatchers, exit }
}

function liveAgent(id = 'pane-a') {
  return reactive({ type: 'leaf', id, shellId: 'pwsh', shellName: 'PowerShell', title: 'Claude', paneName: 'lead', num: 2, team: 'team-1', kind: 'agent', agentId: 'claude', agentCommand: 'claude', remoteHostId: HOST, remotePath: '/srv/app', sessionId: SESSION, pid: 42, broadcast: true })
}
function liveShell(id = 'pane-s') {
  return reactive({ type: 'leaf', id, shellId: 'pwsh', shellName: 'PowerShell', title: 'Box', kind: 'shell', remoteHostId: HOST, remotePath: '/srv/app/sub', pid: 43, broadcast: true })
}
function split(...children) {
  return reactive({ type: 'split', id: 'split-1', dir: 'row', sizes: children.map(() => 100 / children.length), children })
}

describe('after a dropped connection', () => {
  it('its panes wait for the host (not exited), keeping place, name, team, conversation and screen', () => {
    const { ws, exit, ctx } = load()
    ws.tree = split(liveAgent(), liveShell())
    exit({ id: 'pane-a', exitCode: 255, pid: 42 })
    exit({ id: 'pane-s', exitCode: 255, pid: 43 })
    const [a, s] = ws.tree.children
    expect(a).toMatchObject({ id: 'pane-a', kind: 'agent', agentId: 'claude', sessionId: SESSION, paneName: 'lead', num: 2, team: 'team-1', restoredText: 'what it showed', notConnected: { resume: true }, gen: 1 })
    expect(s).toMatchObject({ id: 'pane-s', kind: 'shell', remotePath: '/srv/app/sub', notConnected: { resume: false } })
    // Nothing signs in by itself.
    expect(ctx.createLeaf).not.toHaveBeenCalled()
  })

  it('once the host is signed in again, all of them reopen together: the agent resumes, the shell in its folder', async () => {
    const { ws, exit, ctx, states, runWatchers } = load()
    ws.tree = split(liveAgent(), liveShell())
    exit({ id: 'pane-a', exitCode: 255, pid: 42 })
    exit({ id: 'pane-s', exitCode: 255, pid: 43 })
    runWatchers()
    expect(ctx.createLeaf).not.toHaveBeenCalled()
    states[HOST] = { status: 'connected', shared: true }
    runWatchers()
    await vi.waitFor(() => expect(ctx.createLeaf).toHaveBeenCalledTimes(2))
    const byId = Object.fromEntries(ctx.createLeaf.mock.calls.map((c) => [c[4].id, c]))
    expect(byId['pane-a'][1]).toMatchObject({ id: 'claude', command: 'claude' })
    expect(byId['pane-a'][4]).toMatchObject({ sessionId: SESSION, resume: true, remoteHostId: HOST, remotePath: '/srv/app' })
    expect(byId['pane-s'][1]).toBe(null)
    expect(byId['pane-s'][4]).toMatchObject({ remoteHostId: HOST, remotePath: '/srv/app/sub' })
    await vi.waitFor(() => expect(ws.tree.children.every((l) => !l.notConnected)).toBe(true))
    expect(ws.tree.children[0]).toMatchObject({ id: 'pane-a', paneName: 'lead', team: 'team-1' })
  })

  it('Connect in one pane reopens it; the others follow once the host is signed in', async () => {
    const { ws, exit, ctx, api, states, runWatchers } = load()
    ws.tree = split(liveAgent(), liveShell())
    exit({ id: 'pane-a', exitCode: 255, pid: 42 })
    exit({ id: 'pane-s', exitCode: 255, pid: 43 })
    expect(await api.connectLeaf('pane-s')).toBe(true)
    expect(ctx.createLeaf).toHaveBeenCalledTimes(1)
    states[HOST] = { status: 'connected', shared: true }
    runWatchers()
    await vi.waitFor(() => expect(ctx.createLeaf).toHaveBeenCalledTimes(2))
    expect(ctx.createLeaf.mock.calls[1][4]).toMatchObject({ id: 'pane-a', resume: true, sessionId: SESSION })
  })

  it('not after a normal end, a disconnect on purpose, a late notice from an old process, or a local pane', () => {
    for (const [e, opts, leaf] of [
      [{ id: 'pane-a', exitCode: 0, pid: 42 }, {}, liveAgent()],
      [{ id: 'pane-a', exitCode: 255, pid: 42 }, { disconnected: true }, liveAgent()],
      [{ id: 'pane-a', exitCode: 255, pid: 7 }, {}, liveAgent()],
      [{ id: 'pane-a', exitCode: 255, pid: 42 }, {}, reactive({ ...liveAgent(), remoteHostId: null })]
    ]) {
      const env = load(opts)
      env.ws.tree = leaf
      env.exit(e)
      expect(env.ws.tree.notConnected).toBeFalsy()
    }
  })

  it('a pane restarting in place is left to its restart', () => {
    const { ws, exit, ctx } = load()
    ws.tree = liveAgent()
    ctx.restartingLeaves.add('pane-a')
    exit({ id: 'pane-a', exitCode: 255, pid: 42 })
    expect(ws.tree.notConnected).toBeFalsy()
  })

  it('a host that drops it again and again: after a few times it stays ended', () => {
    const { ws, api } = load()
    ws.tree = liveShell()
    let reopened = 0
    for (let i = 0; i < 5; i++) {
      // Reconnected (a running pane again), then dropped.
      ws.tree = reactive({ ...liveShell(), gen: i })
      if (api.waitForHostAgain('pane-s', { exitCode: 255, pid: 43 })) reopened++
    }
    expect(reopened).toBe(3)
  })
})

describe('after Tessel restarted', () => {
  it("the host's restored panes reopen together once it is signed in, the agent resuming", async () => {
    const { ws, ctx, states, runWatchers } = load()
    const waiting = (leaf, resume) => reactive({ ...leaf, pid: null, notConnected: { cwd: null, resume } })
    ws.tree = split(waiting(liveAgent(), true), waiting(liveShell(), true))
    runWatchers()
    expect(ctx.createLeaf).not.toHaveBeenCalled()
    states[HOST] = { status: 'connected', shared: true }
    runWatchers()
    await vi.waitFor(() => expect(ctx.createLeaf).toHaveBeenCalledTimes(2))
    expect(ctx.createLeaf.mock.calls.find((c) => c[4].id === 'pane-a')[4]).toMatchObject({ sessionId: SESSION, resume: true })
  })
})

// What the reopened agent types (App.vue's agentStartLine, with the options
// the reopen passed to createLeaf): its conversation is on the host, never in
// this computer's transcripts. Found that way: Claude Code refused the old id
// ("Session ID ... is already in use") and the agent never started.
describe('the line the reopened agent starts with', () => {
  function startLine({ onHost }) {
    const ctx = {
      window: {
        shellApi: {
          claudeSessionExists: vi.fn(async () => false),
          remoteAgentSessionExists: vi.fn(onHost)
        }
      },
      sessionKind: (a) => a.id,
      newUuid: () => 'new-uuid',
      claudeStartChoice,
      codexResumes,
      Promise
    }
    vm.createContext(ctx)
    vm.runInContext(slice('async function agentStartLine(', '\n// Codex, OpenCode, Cline and Copilot pick') + '\nthis.agentStartLine = agentStartLine', ctx)
    return ctx
  }
  async function reopenOpts(resume) {
    const { ws, ctx, states, runWatchers } = load()
    ws.tree = reactive({ ...liveAgent(), pid: null, notConnected: { cwd: null, resume } })
    states[HOST] = { status: 'connected', shared: true }
    runWatchers()
    await vi.waitFor(() => expect(ctx.createLeaf).toHaveBeenCalledTimes(1))
    return ctx.createLeaf.mock.calls[0][4]
  }
  const run = (env, opts) => env.agentStartLine({ id: 'claude', command: 'claude' }, opts.sessionId || null, !!opts.resume, undefined, { known: false, hostId: opts.remoteHostId || null })

  it('after a dropped connection: resumed when the host has it (asked there, not here)', async () => {
    const opts = await reopenOpts(true)
    const env = startLine({ onHost: async () => true })
    expect((await run(env, opts)).line).toBe(`claude --resume ${SESSION}`)
    expect(env.window.shellApi.remoteAgentSessionExists).toHaveBeenCalledWith(HOST, 'claude', SESSION)
    expect(env.window.shellApi.claudeSessionExists).not.toHaveBeenCalled()
  })

  it('the host can not be asked (dropped again, too slow): resumed, never --session-id with the old id', async () => {
    const opts = await reopenOpts(true)
    const env = startLine({ onHost: async () => null })
    expect((await run(env, opts)).line).toBe(`claude --resume ${SESSION}`)
  })

  it('restored with "Resume agents" off: a new id when the host has it or can not tell', async () => {
    const opts = await reopenOpts(false)
    for (const answer of [true, null]) {
      const env = startLine({ onHost: async () => answer })
      const start = await run(env, opts)
      expect(start.line).toBe('claude --session-id new-uuid')
      expect(start.line).not.toContain(SESSION)
    }
    // Never written to on the host: its id is free.
    expect((await run(startLine({ onHost: async () => false }), opts)).line).toBe(`claude --session-id ${SESSION}`)
  })
})

// A restart in place (pane menu > Restart, an update, the team tools) of an
// agent on an SSH host starts it on that host again, where its conversation
// is: it used to start on this computer.
describe('an agent on a host restarted in place', () => {
  it('starts on its host again, in its folder, resuming', async () => {
    const leaf = reactive({ ...liveAgent(), gen: 0 })
    const ws = reactive({ id: 'ws1', tree: leaf })
    const ctx = {
      findLeaf: (id) => (ws.tree && ws.tree.id === id ? ws.tree : null),
      wsOfLeaf: (id) => (ws.tree && ws.tree.id === id ? ws : null),
      window: { shellApi: { killPty: vi.fn(), attachPty: vi.fn(async () => ({ ok: false })) } },
      setTimeout: (fn) => fn(),
      dropBuffer: vi.fn(),
      clearAgentStatus: vi.fn(),
      setDraft: vi.fn(),
      replaceNode: (node, id, make) => make(node),
      createLeaf: vi.fn(async (shellId, agent, cwd, worktree, opts) => reactive({ type: 'leaf', id: opts.id })),
      teamToolsVersion: '1',
      Promise,
      Object,
      Date
    }
    vm.createContext(ctx)
    vm.runInContext(slice('async function restartInPlaceNow(leafId, opts) {', '\n// --- Chat <-> terminal') + '\nthis.restartInPlaceNow = restartInPlaceNow', ctx)
    expect(await ctx.restartInPlaceNow('pane-a', { resume: true })).toBe(true)
    expect(ctx.createLeaf.mock.calls[0][4]).toMatchObject({ id: 'pane-a', sessionId: SESSION, resume: true, remoteHostId: HOST, remotePath: '/srv/app' })
  })
})
