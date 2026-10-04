// An agent put to sleep, restored when Tessel starts or its window reloads:
// it stays asleep (no terminal) and keeps its team, name and number. Run on
// App.vue's own code (deserializeNode), as remotePaneRestore.spec.js does.
import { describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import vm from 'vm'
import { join } from 'path'
import { reactive } from 'vue'

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
    t: (k, en, vars) => en.replace(/\{\{(\w+)\}\}/g, (_, n) => (vars && vars[n] != null ? vars[n] : '')),
    reactive,
    watch: (getter, cb) => watchers.push({ getter, cb }),
    newId: () => 'pane-new',
    seedBuffer: () => {},
    validPaneSessionOptions: (o) => (o && o.model ? o : null),
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
    slice('async function deserializeNode(snap, cwd = null)', 'let persistReady') +
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
