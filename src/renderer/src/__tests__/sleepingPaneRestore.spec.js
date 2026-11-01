// An agent put to sleep, restored when Tessel starts or its window reloads:
// it stays asleep (no terminal) and keeps its team, name and number. Run on
// App.vue's own code (deserializeNode), as remotePaneRestore.spec.js does.
import { describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import vm from 'vm'
import { join } from 'path'
import { reactive } from 'vue'
import { savedPaneModel } from '../paneLastModel'
import { HOST_ACCOUNT_AGENTS, validHostAccount, hostAccountChoice, defaultHostAccount } from '../hostAccounts'
import { sleepsAtStart } from '../../../shared/agentSleep'

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
    sleepsAtStart,
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
    restartingLeaves: new Set(),
    setTimeout: (fn) => fn(),
    Promise,
    Object,
    Number,
    window: { shellApi }
  }
  vm.createContext(ctx)
  vm.runInContext(
    slice('async function deserializeNode(snap, cwd = null, attaching = null, startAsleep = false)', 'let persistReady') +
      slice('async function createLeaf(shellId, agent = null', 'function replaceNode(') +
      slice('const connectingLeaves = new Set()', '// Replace a pane with a fresh process') +
      slice('async function wakeLeaf(leafId)', '// A sleeping pane you open wakes up.') +
      '\nthis.api = { deserializeNode, createLeaf, connectLeaf, wakeLeaf }',
    ctx
  )
  // The auto-connect watch: run it as Vue would when the states change.
  const runWatchers = () => {
    for (const w of watchers) w.cb(w.getter())
  }
  return { api: ctx.api, ctx, ws, shellApi, states, runWatchers }
}

const asleep = {
  type: 'leaf',
  id: 'pane-s1',
  shellId: 'pwsh',
  kind: 'agent',
  agentId: 'claude',
  agentCommand: 'claude',
  title: 'Claude Code',
  paneName: 'Ada',
  num: 2,
  sessionId: '93a8705f-aaa7-4012-9f2e-de7e1d0a95c7',
  sleeping: { at: 1000 },
  team: 'team-9',
  teamTools: true,
  toolsVersion: 'v3',
  broadcast: true
}

describe('a sleeping agent restored after a restart or a reload', () => {
  it('stays asleep, in its team, with its name and number', async () => {
    const { api, shellApi } = load()
    const leaf = await api.deserializeNode(asleep)
    expect(shellApi.createPty).not.toHaveBeenCalled()
    expect(leaf).toMatchObject({ id: 'pane-s1', sleeping: { at: 1000 }, paneName: 'Ada', num: 2, team: 'team-9', teamTools: true, toolsVersion: 'v3' })
    const alone = await api.deserializeNode({ ...asleep, team: undefined, teamTools: undefined, toolsVersion: undefined })
    expect(alone.team).toBeUndefined()
    expect(alone.teamTools).toBeUndefined()
  })
})

describe('the pane a workspace opens on after a restart or a reload', () => {
  // App.vue's own functions: the first pane, else (all asleep) the first one.
  const ctx = {}
  vm.createContext(ctx)
  vm.runInContext(slice('function firstLeafId(node)', '// --- Workspace persistence') + '\nthis.api = { firstLeafId, firstAwakeLeafId }', ctx)
  const leaf = (id, extra = {}) => ({ type: 'leaf', id, ...extra })
  const split = (...children) => ({ type: 'split', children })

  it('is not an agent put to sleep (opening it would wake it)', () => {
    const tree = split(leaf('ada', { sleeping: { at: 1 } }), split(leaf('bohr'), leaf('curie')))
    expect(ctx.api.firstAwakeLeafId(tree)).toBe('bohr')
    expect(ctx.api.firstAwakeLeafId(split(leaf('a', { sleeping: { at: 1 } }), leaf('b', { sleeping: { at: 2 } })))).toBe('a')
    expect(ctx.api.firstAwakeLeafId(null)).toBe(null)
  })
})

describe('Start terminals asleep (Settings > General)', () => {
  const shell = { type: 'leaf', id: 'pane-t1', shellId: 'pwsh', kind: 'shell', title: 'PowerShell', paneName: 'Logs', num: 3, startDir: 'C:\\p', broadcast: true }
  const agent = { ...asleep, id: 'pane-a1', sleeping: undefined, team: undefined, teamTools: undefined, toolsVersion: undefined }
  const running = (id) => new Map([[id, Promise.resolve({ ok: true, buffer: '', shell: { id: 'pwsh', name: 'PowerShell' }, backend: 'conpty', pid: 42, cwd: 'C:\\p' })]])
  const gone = (id) => new Map([[id, Promise.resolve({ ok: false })]])

  it('an agent whose terminal no longer runs comes back asleep, its conversation kept', async () => {
    const { api, shellApi } = load()
    const leaf = await api.deserializeNode(agent, 'C:\\p', gone('pane-a1'), true)
    expect(shellApi.createPty).not.toHaveBeenCalled()
    expect(leaf).toMatchObject({ id: 'pane-a1', kind: 'agent', sessionId: asleep.sessionId, paneName: 'Ada', num: 2 })
    expect(Number.isFinite(leaf.sleeping.at)).toBe(true)
    const fresh = await api.deserializeNode({ ...agent, sessionId: null }, 'C:\\p', null, true)
    expect(fresh.sleeping).toBeTruthy()
    expect(fresh.sessionId).toBe(null)
  })

  it('a terminal comes back asleep with its name, folder and last output', async () => {
    const { api, shellApi } = load()
    const leaf = await api.deserializeNode({ ...shell, id: 'pane-r1' }, 'C:\\p', gone('pane-r1'), true)
    expect(shellApi.createPty).not.toHaveBeenCalled()
    expect(leaf).toMatchObject({ id: 'pane-r1', kind: 'shell', agentCommand: null, paneName: 'Logs', num: 3, startDir: 'C:\\p', restoredText: 'last output' })
    expect(leaf.sleeping).toBeTruthy()
  })

  it('a pane whose terminal still runs is kept as it is', async () => {
    const { api, shellApi } = load()
    const leaf = await api.deserializeNode(shell, 'C:\\p', running('pane-t1'), true)
    expect(shellApi.createPty).not.toHaveBeenCalled()
    expect(leaf.sleeping).toBeUndefined()
    expect(leaf.attached).toBe(true)
  })

  it('off: every pane starts as before', async () => {
    const { api, shellApi } = load()
    const leaf = await api.deserializeNode(shell, 'C:\\p', gone('pane-t1'))
    expect(shellApi.createPty).toHaveBeenCalledTimes(1)
    expect(leaf.sleeping).toBeUndefined()
  })

  it('in a split too, and never a pane on an SSH host', async () => {
    const { api, shellApi } = load()
    const tree = { type: 'split', dir: 'row', sizes: [50, 50], children: [shell, { ...shell, id: 'pane-t2', remoteHostId: 'ssh-box' }] }
    const built = await api.deserializeNode(tree, 'C:\\p', null, true)
    expect(built.children[0].sleeping).toBeTruthy()
    expect(built.children[1].sleeping).toBeUndefined()
    expect(built.children[1].notConnected).toBeTruthy()
    expect(shellApi.createPty).not.toHaveBeenCalled()
  })
})

describe('a terminal asleep since launch, opened', () => {
  it('starts a new shell in the same pane, with its name and last output', async () => {
    const { api, ws, shellApi } = load()
    ws.tree = await api.deserializeNode({ type: 'leaf', id: 'pane-r1', shellId: 'pwsh', kind: 'shell', title: 'PowerShell', paneName: 'Logs', num: 3, broadcast: true }, null, null, true)
    expect(ws.tree.sleeping).toBeTruthy()
    await api.wakeLeaf('pane-r1')
    expect(shellApi.createPty).toHaveBeenCalledTimes(1)
    expect(ws.tree).toMatchObject({ id: 'pane-r1', paneName: 'Logs', num: 3, restoredText: 'last output' })
    expect(ws.tree.sleeping).toBeUndefined()
  })
})
