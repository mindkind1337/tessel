// A pane on an SSH host reopened when Tessel starts (its terminal gone, the
// terminal host restarted) does not connect by itself: it waits for Connect
// (or Enter) in the pane, unless the host's shared connection is already
// signed in. Run on App.vue's own code (deserializeNode, createLeaf,
// connectLeaf), as chatSwitch.spec.js does.
import { describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import vm from 'vm'
import { join } from 'path'
import { reactive } from 'vue'
import { savedPaneModel } from '../paneLastModel'
import { HOST_ACCOUNT_AGENTS, validHostAccount, hostAccountChoice, defaultHostAccount } from '../hostAccounts'

const source = fs.readFileSync(join(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')
function slice(from, to) {
  const a = source.indexOf(from)
  const b = source.indexOf(to, a)
  if (a < 0 || b < 0) throw new Error(`App.vue changed: ${from}`)
  return source.slice(a, b)
}

const HOST = 'ssh-box'

function load({ shared = false, tree = null } = {}) {
  const states = reactive({ [HOST]: shared ? { status: 'connected', shared: true } : { status: 'disconnected' } })
  const ws = reactive({ id: 'ws1', cwd: null, remote: { hostId: HOST, path: '/srv/app' }, tree })
  const watchers = []
  const shellApi = {
    attachPty: vi.fn(async () => ({ ok: false })),
    createPty: vi.fn(async (o) => ({ ok: true, shell: { id: 'pwsh', name: 'PowerShell' }, backend: 'ssh', pid: null, cwd: 'C:\\Users\\me', remoteHost: { id: o.remoteHostId, label: 'Box' } })),
    killPty: vi.fn(),
    writePty: vi.fn()
  }
  const findLeafIn = (node, id) => {
    if (!node) return null
    if (node.type === 'leaf') return node.id === id ? node : null
    for (const c of node.children) {
      const f = findLeafIn(c, id)
      if (f) return f
    }
    return null
  }
  const ctx = {
    HOST_ACCOUNT_AGENTS,
    validHostAccount,
    hostAccountChoice,
    defaultHostAccount,
    refreshHostAccounts: () => {},
    t: (k, en, vars) => en.replace(/\{\{(\w+)\}\}/g, (_, n) => (vars && vars[n] != null ? vars[n] : '')),
    reactive,
    watch: (getter, cb) => watchers.push({ getter, cb }),
    newId: () => 'pane-new',
    seedBuffer: () => {},
    exitOf: () => null,
    performance,
    validPaneSessionOptions: (o) => (o && o.model ? o : null),
    savedPaneModel,
    validSavedFiles: () => [],
    launchPermissions: () => 'manual',
    hostShared: (id) => !!(states[id] && states[id].shared),
    remoteHostLabel: () => 'Box',
    safeSessionId: (v) => (typeof v === 'string' ? v : null),
    savedOutput: { 'pane-r1': 'last output' },
    readDrafts: () => ({}),
    userDraft: {},
    draftUnknown: {},
    agents: { value: [] },
    settings: { resumeAgents: true, yoloFolders: [], agentPermissions: 'manual' },
    FOUND_AFTER_START: [],
    sessionKind: () => null,
    teamToolsReady: false,
    teamToolsVersion: null,
    showToast: vi.fn(),
    initError: { value: '' },
    setDraft: vi.fn(),
    findLeaf: (id) => findLeafIn(ws.tree, id),
    wsOfLeaf: (id) => (findLeafIn(ws.tree, id) ? ws : null),
    forEachWsLeaf: (fn) => {
      const walk = (n) => (n ? (n.type === 'leaf' ? fn(n) : n.children.forEach(walk)) : null)
      walk(ws.tree)
    },
    replaceNode: (tree, id, make) => (tree.id === id ? make(tree) : tree),
    setTimeout: (fn) => fn(),
    Promise,
    Object,
    Number,
    window: { shellApi }
  }
  vm.createContext(ctx)
  vm.runInContext(
    slice('async function deserializeNode(snap, cwd = null, attaching = null)', 'let persistReady') +
      slice('async function createLeaf(shellId, agent = null', 'function replaceNode(') +
      slice('const connectingLeaves = new Set()', '// Replace a pane with a fresh process') +
      '\nthis.api = { deserializeNode, createLeaf, connectLeaf }',
    ctx
  )
  // The auto-connect watch: run it as Vue would when the states change.
  const runWatchers = () => {
    for (const w of watchers) w.cb(w.getter())
  }
  return { api: ctx.api, ctx, ws, shellApi, states, runWatchers }
}

const snap = {
  type: 'leaf',
  id: 'pane-r1',
  shellId: 'pwsh',
  kind: 'shell',
  title: 'Box shell',
  paneName: 'logs',
  num: 4,
  remoteHostId: HOST,
  remotePath: '/srv/app',
  broadcast: false
}

describe('a remote pane restored after a restart', () => {
  it('is not connected: no terminal is created, its place, name and saved output are kept', async () => {
    const { api, shellApi } = load()
    const leaf = await api.deserializeNode(snap)
    // Re-attached first (a terminal host that kept running keeps it as before).
    expect(shellApi.attachPty).toHaveBeenCalledWith('pane-r1')
    expect(shellApi.createPty).not.toHaveBeenCalled()
    expect(leaf).toMatchObject({ id: 'pane-r1', remoteHostId: HOST, remotePath: '/srv/app', title: 'Box shell', paneName: 'logs', num: 4, broadcast: false, restoredText: 'last output' })
    expect(leaf.notConnected).toBeTruthy()
  })

  it('a terminal still running in the terminal host is re-attached as before (nothing to ask)', async () => {
    const { api, shellApi } = load()
    shellApi.attachPty.mockResolvedValue({ ok: true, shell: { id: 'pwsh', name: 'PowerShell' }, backend: 'ssh', buffer: '', remoteHostId: HOST })
    const leaf = await api.deserializeNode(snap)
    expect(leaf.attached).toBe(true)
    expect(leaf.notConnected).toBeFalsy()
    expect(shellApi.createPty).not.toHaveBeenCalled()
  })

  it('Connect starts its terminal on the host, in the same pane', async () => {
    const { api, ws, shellApi } = load()
    ws.tree = await api.deserializeNode(snap)
    expect(await api.connectLeaf('pane-r1')).toBe(true)
    expect(shellApi.createPty).toHaveBeenCalledTimes(1)
    expect(shellApi.createPty.mock.calls[0][0]).toMatchObject({ id: 'pane-r1', remoteHostId: HOST, remotePath: '/srv/app' })
    expect(ws.tree).toMatchObject({ id: 'pane-r1', remoteHostId: HOST, title: 'Box shell', paneName: 'logs', num: 4, broadcast: false, restoredText: 'last output' })
    expect(ws.tree.notConnected).toBeFalsy()
    // Pressed twice: one terminal.
    expect(await api.connectLeaf('pane-r1')).toBe(false)
    expect(shellApi.createPty).toHaveBeenCalledTimes(1)
  })

  it('a failed start keeps it waiting for Connect', async () => {
    const { api, ws, shellApi } = load()
    ws.tree = await api.deserializeNode(snap)
    shellApi.createPty.mockResolvedValueOnce({ ok: false, error: 'nope' })
    expect(await api.connectLeaf('pane-r1')).toBe(false)
    expect(ws.tree.notConnected).toBeTruthy()
    expect(ws.tree.connecting).toBe(false)
  })

  it('the host already signed in (shared connection): it starts at once, nothing to ask', async () => {
    const { api, shellApi } = load({ shared: true })
    const leaf = await api.deserializeNode(snap)
    expect(shellApi.createPty).toHaveBeenCalledTimes(1)
    expect(leaf.notConnected).toBeFalsy()
  })

  it('once the host signs in (another pane, Files), the waiting panes on it start by themselves', async () => {
    const { api, ws, shellApi, states, runWatchers } = load()
    ws.tree = await api.deserializeNode(snap)
    runWatchers()
    expect(shellApi.createPty).not.toHaveBeenCalled()
    states[HOST] = { status: 'connected', shared: true }
    runWatchers()
    await vi.waitFor(() => expect(ws.tree.notConnected).toBeFalsy())
    expect(shellApi.createPty).toHaveBeenCalledTimes(1)
  })

  it('a new pane on a host connects at once, as before', async () => {
    const { api, shellApi } = load()
    const leaf = await api.createLeaf('pwsh', null, null, null, { remoteHostId: HOST, remotePath: '/srv/app' })
    expect(shellApi.createPty).toHaveBeenCalledTimes(1)
    expect(leaf.notConnected).toBeFalsy()
  })

  it('a local pane restored is untouched (started at once)', async () => {
    const { api, shellApi } = load()
    const leaf = await api.deserializeNode({ type: 'leaf', id: 'pane-l1', shellId: 'pwsh', kind: 'shell', title: 'PowerShell' }, 'C:\\proj')
    expect(shellApi.createPty).toHaveBeenCalledTimes(1)
    expect(shellApi.createPty.mock.calls[0][0].remoteHostId).toBeUndefined()
    expect(leaf.notConnected).toBeFalsy()
  })
})

describe("a terminal agent's chat view is kept with the layout", () => {
  it('an agent restored asleep comes back in its chat view (nothing started)', async () => {
    const { api, shellApi } = load()
    const leaf = await api.deserializeNode({ type: 'leaf', id: 'pane-c1', shellId: 'pwsh', kind: 'agent', agentId: 'claude', agentCommand: 'claude', title: 'Claude', sessionId: '22222222-3333-4444-8555-666666666666', sleeping: { at: 1 }, chatView: true })
    expect(leaf).toMatchObject({ kind: 'agent', chatView: true, sleeping: { at: 1 } })
    expect(shellApi.createPty).not.toHaveBeenCalled()
    const plain = await api.deserializeNode({ type: 'leaf', id: 'pane-c2', shellId: 'pwsh', kind: 'agent', agentId: 'claude', agentCommand: 'claude', title: 'Claude', sessionId: '22222222-3333-4444-8555-666666666666', sleeping: { at: 1 }, chatView: 'yes' })
    expect(plain.chatView).toBeUndefined()
  })
})

// Startup asks for a pane's re-attach ahead (restoreAttach.js): its terminal
// may end before the pane is rebuilt. Its end, kept by process id
// (ptyStore.js exitOf), wins over the older answer that said it was running.
describe('a pane re-attached from an answer asked ahead at startup', () => {
  const answer = { ok: true, shell: { id: 'pwsh', name: 'PowerShell' }, backend: 'conpty', pid: 42, cwd: 'C:\\proj', exited: false, buffer: 'SCREEN' }
  it('comes back ended when its terminal ended since the answer', async () => {
    const { api, ctx, shellApi } = load()
    let since = null
    ctx.exitOf = (id, pid, at) => ((since = at), id === 'pane-l1' && pid === 42 ? { exitCode: 1 } : null)
    const leaf = await api.createLeaf('pwsh', null, 'C:\\proj', null, { id: 'pane-l1', attaching: Promise.resolve({ ...answer, answeredAt: 1234 }) })
    expect(leaf).toMatchObject({ id: 'pane-l1', pid: 42, exitedAtStart: true, answeredAt: 1234 })
    // Asked with the time its answer came (a terminal with no process id).
    expect(since).toBe(1234)
    // Answered ahead: not asked again, and its output was seeded already.
    expect(shellApi.attachPty).not.toHaveBeenCalled()
    expect(shellApi.createPty).not.toHaveBeenCalled()
  })
  it('still running: comes back running', async () => {
    const { api, ctx } = load()
    ctx.exitOf = () => null
    const leaf = await api.createLeaf('pwsh', null, 'C:\\proj', null, { id: 'pane-l2', attaching: Promise.resolve({ ...answer }) })
    expect(leaf).toMatchObject({ id: 'pane-l2', exitedAtStart: false })
  })
})
