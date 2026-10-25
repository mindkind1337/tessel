// What a project with no pane gets, run on App.vue's own code (as
// remotePaneRestore.spec.js does): a new project (here or on an SSH host)
// shows the launcher and starts nothing; each choice starts the right pane;
// "When a project opens" starts it by itself; a project whose last pane
// closed shows the launcher (a terminal, as before, when that is the
// setting); a restored layout comes back as it was saved.
import { describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import vm from 'vm'
import { join } from 'path'
import { computed, reactive, ref } from 'vue'
import * as launcher from '../projectLauncher'
import { viewKey, leafViewPath } from '../paneViews'
import { validHostAccount, hostAccountChoice, defaultHostAccount } from '../hostAccounts'
import { prefetchAttaches, terminalLeafIds } from '../restoreAttach'
import { savedGridModes } from '../paneGrid'

// App.vue's Live Share helper (liveShareWindow.js): nothing shared or joined.
const noLiveShare = { isGuestWs: () => false, isGuestLeaf: () => false, state: { host: { state: 'off', guests: [] }, guest: { state: 'off' } } }

const source = fs.readFileSync(join(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')
function slice(from, to) {
  const a = source.indexOf(from)
  const b = source.indexOf(to, a)
  if (a < 0 || b < 0) throw new Error(`App.vue changed: ${from}`)
  return source.slice(a, b)
}

const AGENTS = [
  { id: 'claude', name: 'Claude Code', command: 'claude', available: true },
  { id: 'codex', name: 'Codex', command: 'codex', available: true },
  { id: 'gemini', name: 'Gemini', command: 'gemini', available: false }
]
const SHELLS = [
  { id: 'powershell', name: 'PowerShell' },
  { id: 'cmd', name: 'Command Prompt' }
]

function load({ projectOpen = 'ask', remoteStatus = {} } = {}) {
  const workspaces = ref([])
  const currentWsId = ref(null)
  let n = 0
  const ctx = {
    validHostAccount,
    hostAccountChoice,
    defaultHostAccount,
    ...launcher,
    t: (k, en, vars) => en.replace(/\{\{(\w+)\}\}/g, (_, x) => (vars && vars[x] != null ? vars[x] : '')),
    computed,
    reactive,
    agents: ref(AGENTS),
    shells: ref(SHELLS),
    selectedShell: ref('powershell'),
    layoutReady: ref(true),
    remoteAgentTools: reactive(remoteStatus),
    agentEnabled: () => true,
    settings: reactive({ projectOpen, agentPrefs: {} }),
    workspaces,
    currentWsId,
    currentWs: computed(() => workspaces.value.find((w) => w.id === currentWsId.value) || null),
    remoteHostLabel: () => 'Box',
    hostShared: () => false,
    addProjectOpen: ref(true),
    makeWorkspace: (name) => reactive({ id: `ws-${++n}`, name, tree: null, activeId: null, cwd: null, remote: null, group: null }),
    nextWorkspaceName: () => 'Workspace',
    samePath: (a, b) => a === b,
    selectWorkspace: vi.fn((id) => (currentWsId.value = id)),
    showToast: vi.fn(),
    newId: (p) => `${p}-${++n}`,
    agentById: (id) => AGENTS.find((a) => a.id === id) || null,
    findLeafIn: (node, id) => (node && node.id === id ? node : null),
    viewKey,
    leafViewPath,
    // Its tabs above the panes (paneViews.js): none here.
    emptyGridShown: () => false,
    createLeaf: vi.fn(async (shellId, agent, cwd, worktree, opts) => reactive({ type: 'leaf', id: `pane-${++n}`, shellId, agentId: agent ? agent.id : null, cwd, ...opts })),
    openInBrowser: vi.fn(({ ws }) => {
      ws.tree = { type: 'leaf', id: 'pane-browser', kind: 'browser' }
      return ws.tree
    }),
    resumeSession: vi.fn(async () => {}),
    // Picked as Install… (App.vue launch): its install asked in its pane's card.
    offerHostInstall: vi.fn(),
    window: { shellApi: { killPty: vi.fn() } },
    Promise,
    Array,
    String
  }
  vm.createContext(Object.assign(ctx, { liveShare: noLiveShare }))
  vm.runInContext(
    slice('function wsLeafOpts(ws, opts = {})', 'function folderName(') +
      slice('function sameProject(ws, spec)', '// Run a command (or steps) in a new terminal pane') +
      '\nthis.api = { addProjects, startInEmptyWorkspace, seedNewWorkspace, refillEmptiedWorkspace, pickFromLauncher, launcherProps, launcherWs }',
    ctx
  )
  return { api: ctx.api, ctx, workspaces }
}

const LOCAL = { name: 'proj', cwd: 'C:\\proj' }
const REMOTE = { name: 'app', remote: { hostId: 'ssh-box', path: '/srv/app' } }

describe('a new project', () => {
  it('here: the launcher shows, no pane is started', async () => {
    const { api, ctx, workspaces } = load()
    await api.addProjects({ projects: [LOCAL] })
    expect(ctx.createLeaf).not.toHaveBeenCalled()
    expect(workspaces.value[0].tree).toBe(null)
    expect(api.launcherProps.value).toMatchObject({ name: 'proj', cwd: 'C:\\proj', remote: null, hostConnected: false })
    expect(api.launcherProps.value.agents.map((a) => a.id)).toEqual(['claude', 'codex'])
    expect(api.launcherProps.value.shells.map((s) => s.id)).toEqual(['powershell', 'cmd'])
  })

  it('on an SSH host: the launcher shows, nothing connects (no terminal, no agent check)', async () => {
    const { api, ctx, workspaces } = load()
    await api.addProjects({ projects: [REMOTE], source: 'remote' })
    expect(ctx.createLeaf).not.toHaveBeenCalled()
    expect(workspaces.value[0].tree).toBe(null)
    expect(api.launcherProps.value).toMatchObject({ cwd: null, remote: { hostId: 'ssh-box', host: 'Box', path: '/srv/app' }, shells: [] })
    // The host not checked yet: its agents are offered, marked so.
    expect(api.launcherProps.value.agents.map((a) => [a.id, a.unchecked])).toEqual([
      ['claude', true],
      ['codex', true]
    ])
  })

  it('on an SSH host already checked: the agents found there ready, a missing one as Install…', async () => {
    const { api } = load({ remoteStatus: { 'ssh-box': { claude: '/usr/bin/claude', codex: null } } })
    await api.addProjects({ projects: [REMOTE] })
    expect(api.launcherProps.value.agents.map((a) => [a.id, a.missing])).toEqual([
      ['claude', false],
      ['codex', true]
    ])
  })

  it('no launcher while the layout is not back yet', async () => {
    const { api, ctx } = load()
    ctx.layoutReady.value = false
    await api.addProjects({ projects: [LOCAL] })
    expect(api.launcherProps.value).toBe(null)
  })
})

describe('each choice starts the right pane', () => {
  async function pick(choice, project = LOCAL, opts = {}) {
    const env = load(opts)
    await env.api.addProjects({ projects: [project] })
    await env.api.pickFromLauncher(choice, { remember: false })
    return { ...env, ws: env.workspaces.value[0] }
  }

  it('an agent, in the project folder', async () => {
    const { ctx, ws } = await pick({ kind: 'agent', id: 'codex' })
    expect(ctx.createLeaf).toHaveBeenCalledTimes(1)
    expect(ctx.createLeaf.mock.calls[0].slice(0, 3)).toEqual(['powershell', AGENTS[1], 'C:\\proj'])
    expect(ws.tree).toMatchObject({ agentId: 'codex' })
    expect(ws.activeId).toBe(ws.tree.id)
  })

  it('a terminal in the shell chosen', async () => {
    const { ctx, ws } = await pick({ kind: 'terminal', shellId: 'cmd' })
    expect(ctx.createLeaf.mock.calls[0].slice(0, 3)).toEqual(['cmd', null, 'C:\\proj'])
    expect(ws.tree).toMatchObject({ shellId: 'cmd', agentId: null })
  })

  it('on an SSH host: the agent or the terminal runs on the host, in its folder', async () => {
    const a = await pick({ kind: 'agent', id: 'claude' }, REMOTE)
    expect(a.ctx.createLeaf.mock.calls[0][4]).toEqual({ remoteHostId: 'ssh-box', remotePath: '/srv/app' })
    const b = await pick({ kind: 'terminal', shellId: null }, REMOTE)
    expect(b.ctx.createLeaf.mock.calls[0][0]).toBe('powershell')
    expect(b.ctx.createLeaf.mock.calls[0][4]).toEqual({ remoteHostId: 'ssh-box', remotePath: '/srv/app' })
  })

  it('on an SSH host, the account chosen beside an agent: that account folder of the host (never this PC’s account)', async () => {
    const a = await pick({ kind: 'agent', id: 'claude', accountId: 'abc123' }, REMOTE)
    expect(a.ctx.createLeaf.mock.calls[0][4]).toEqual({ hostAccount: 'abc123', remoteHostId: 'ssh-box', remotePath: '/srv/app' })
    // The host's own sign-in chosen: said (the host's default does not apply).
    const b = await pick({ kind: 'agent', id: 'claude', accountId: null }, REMOTE)
    expect(b.ctx.createLeaf.mock.calls[0][4]).toEqual({ hostAccount: null, remoteHostId: 'ssh-box', remotePath: '/srv/app' })
    // An id that is not a host folder's: nothing more.
    const c = await pick({ kind: 'agent', id: 'claude', accountId: '1f0c6d1e-0000-4000-8000-000000000000' }, REMOTE)
    expect(c.ctx.createLeaf.mock.calls[0][4]).toEqual({ remoteHostId: 'ssh-box', remotePath: '/srv/app' })
  })

  it('a browser page', async () => {
    const { ctx, ws } = await pick({ kind: 'browser' })
    expect(ctx.openInBrowser).toHaveBeenCalledWith({ ws, newPane: true, focusAddress: true })
    expect(ctx.createLeaf).not.toHaveBeenCalled()
  })

  it('a recent conversation, resumed as the history resumes it, in this project', async () => {
    const session = { agent: 'claude', id: 'aaaaaaaa-1111-4222-8333-444444444444', cwd: 'C:\\proj' }
    const { ctx, ws } = await pick({ kind: 'session', session })
    expect(ctx.selectWorkspace).toHaveBeenLastCalledWith(ws.id)
    expect(ctx.resumeSession).toHaveBeenCalledWith(session)
  })

  it('an agent missing on the host (Install…): its pane on the host (its card, the host checked as it starts), and its install asked there', async () => {
    const env = load({ remoteStatus: { 'ssh-box': { claude: 'x', codex: null } } })
    await env.api.addProjects({ projects: [REMOTE] })
    await env.api.pickFromLauncher({ kind: 'install', id: 'codex' }, { remember: true })
    expect(env.ctx.createLeaf).toHaveBeenCalledTimes(1)
    expect(env.ctx.createLeaf.mock.calls[0][1]).toBe(AGENTS[1])
    expect(env.ctx.createLeaf.mock.calls[0][4]).toEqual({ remoteHostId: 'ssh-box', remotePath: '/srv/app' })
    const leaf = await env.ctx.createLeaf.mock.results[0].value
    expect(env.ctx.offerHostInstall).toHaveBeenCalledWith(leaf, true)
    // Never remembered as what new projects start.
    expect(env.ctx.settings.projectOpen).toBe('ask')
  })

  it('an agent that is not in the list starts nothing', async () => {
    const { ctx, ws } = await pick({ kind: 'agent', id: 'nope' })
    expect(ctx.createLeaf).not.toHaveBeenCalled()
    expect(ws.tree).toBe(null)
  })
})

describe('the remembered default', () => {
  it('Remember for new projects keeps the choice; the next project starts it by itself', async () => {
    const { api, ctx, workspaces } = load()
    await api.addProjects({ projects: [LOCAL] })
    await api.pickFromLauncher({ kind: 'agent', id: 'claude' }, { remember: true })
    expect(ctx.settings.projectOpen).toBe('agent:claude')
    expect(ctx.showToast).toHaveBeenCalledWith('New projects will start this way. Change it in Settings > Agents.')
    await api.addProjects({ projects: [{ name: 'two', cwd: 'C:\\two' }] })
    expect(ctx.createLeaf).toHaveBeenCalledTimes(2)
    expect(ctx.createLeaf.mock.calls[1].slice(0, 3)).toEqual(['powershell', AGENTS[0], 'C:\\two'])
    expect(workspaces.value[1].tree).toMatchObject({ agentId: 'claude' })
  })

  it('a terminal in a shell, remembered with it', async () => {
    const { api, ctx } = load()
    await api.addProjects({ projects: [LOCAL] })
    await api.pickFromLauncher({ kind: 'terminal', shellId: 'cmd' }, { remember: true })
    expect(ctx.settings.projectOpen).toBe('terminal:cmd')
    await api.addProjects({ projects: [{ name: 'two', cwd: 'C:\\two' }] })
    expect(ctx.createLeaf.mock.calls[1].slice(0, 2)).toEqual(['cmd', null])
  })

  it('a browser page is not remembered', async () => {
    const { api, ctx } = load()
    await api.addProjects({ projects: [LOCAL] })
    await api.pickFromLauncher({ kind: 'browser' }, { remember: true })
    expect(ctx.settings.projectOpen).toBe('ask')
  })

  it('an agent missing on the SSH host: the launcher instead', async () => {
    const { api, ctx, workspaces } = load({ projectOpen: 'agent:codex', remoteStatus: { 'ssh-box': { claude: 'x', codex: null } } })
    await api.addProjects({ projects: [REMOTE] })
    expect(ctx.createLeaf).not.toHaveBeenCalled()
    expect(workspaces.value[0].tree).toBe(null)
  })

  it('a terminal default on an SSH host opens its login shell there', async () => {
    const { api, ctx } = load({ projectOpen: 'terminal:cmd' })
    await api.addProjects({ projects: [REMOTE] })
    expect(ctx.createLeaf).toHaveBeenCalledTimes(1)
    expect(ctx.createLeaf.mock.calls[0][4]).toEqual({ remoteHostId: 'ssh-box', remotePath: '/srv/app' })
  })
})

describe('the last pane of a project closed', () => {
  it('the launcher: no new shell', async () => {
    const { api, ctx } = load()
    const ws = reactive({ id: 'ws-x', tree: null, cwd: 'C:\\proj', remote: null })
    ctx.workspaces.value.push(ws)
    api.refillEmptiedWorkspace(ws)
    await Promise.resolve()
    expect(ctx.createLeaf).not.toHaveBeenCalled()
    expect(ws.tree).toBe(null)
  })

  it('an agent default does not start an agent then either', async () => {
    const { api, ctx } = load({ projectOpen: 'agent:claude' })
    const ws = reactive({ id: 'ws-x', tree: null, cwd: 'C:\\proj', remote: null })
    ctx.workspaces.value.push(ws)
    api.refillEmptiedWorkspace(ws)
    expect(ctx.createLeaf).not.toHaveBeenCalled()
  })

  it('a terminal default: a fresh terminal, as before (dropped if a pane came meanwhile)', async () => {
    const { api, ctx } = load({ projectOpen: 'terminal:cmd' })
    const ws = reactive({ id: 'ws-x', tree: null, cwd: 'C:\\proj', remote: null })
    ctx.workspaces.value.push(ws)
    api.refillEmptiedWorkspace(ws)
    await vi.waitFor(() => expect(ws.tree).toMatchObject({ shellId: 'cmd' }))
    const other = reactive({ id: 'ws-y', tree: null, cwd: 'C:\\proj', remote: null })
    ctx.workspaces.value.push(other)
    api.refillEmptiedWorkspace(other)
    other.tree = { type: 'leaf', id: 'pane-dropped' }
    await vi.waitFor(() => expect(ctx.window.shellApi.killPty).toHaveBeenCalled())
    expect(other.tree.id).toBe('pane-dropped')
  })

  it('App.vue routes the last close and a pane moved away through it', () => {
    expect(slice('function closeLeaf(leafId, opts = {})', '// Arrange the workspace as an even grid')).toContain('refillEmptiedWorkspace(ws)')
    expect(slice('function detachLeaf(ws, leafId)', '// The band along')).toContain('if (!next) refillEmptiedWorkspace(ws)')
  })
})

describe('a restored layout', () => {
  function restore(snaps, deserialize, { currentIndex = 0, attachPty = null, onCtx = null } = {}) {
    const workspaces = ref([])
    const ctx = {
      workspaces,
      makeWorkspace: (name) => reactive({ id: 'ws-new', name, tree: null, activeId: null, cwd: null, remote: null, group: null }),
      nextWorkspaceName: () => 'Workspace',
      savedRemote: (r) => (r ? { ...r } : null),
      savedGroup: () => null,
      savedGridModes,
      deserializeNode: vi.fn(deserialize),
      createLeaf: vi.fn(async () => ({ type: 'leaf', id: 'pane-fresh' })),
      selectedShell: ref('powershell'),
      wsLeafOpts: (_ws, o = {}) => o,
      firstAwakeLeafId: (tree) => tree.id,
      currentWsId: ref(null),
      restoreReport: { shownAt: null, attach: null },
      prefetchAttaches,
      terminalLeafIds,
      restoresTerminal: (leaf) => leaf.type === 'leaf',
      seedBuffer: vi.fn(),
      performance,
      window: { shellApi: attachPty ? { attachPty } : {} },
      forEachLeaf: (node, fn) => {
        if (!node) return
        if (node.type === 'leaf') fn(node)
        else node.children.forEach((c) => ctx.forEachLeaf(c, fn))
      },
      exitOf: () => null,
      waitForHostAgain: vi.fn()
    }
    vm.createContext(Object.assign(ctx, { liveShare: noLiveShare }))
    vm.runInContext(`this.run = async function (snaps, saved) {\n${slice('    // Every project as saved, in the saved order', '    if (workspaces.value.length) {')}\n}`, ctx)
    if (onCtx) onCtx(ctx)
    return ctx.run(snaps, { currentIndex }).then(() => ctx)
  }

  it('the project you were in comes back first and shows at once; the others in their saved place', async () => {
    const leaf = (id) => ({ type: 'leaf', id })
    const snaps = [
      { id: 'ws-a', name: 'A', cwd: 'C:\a', tree: { type: 'split', children: [leaf('pane-a1'), leaf('pane-a2')] } },
      { id: 'ws-b', name: 'B', cwd: 'C:\b', tree: leaf('pane-b1') },
      { id: 'ws-c', name: 'C', cwd: 'C:\c', tree: { type: 'split', children: [leaf('pane-c1'), leaf('pane-c2')] } }
    ]
    const seen = []
    const attachPty = vi.fn(async () => ({ ok: false }))
    let live = null
    const ctx = await restore(
      snaps,
      async (tree, _cwd, attaching) => {
        const name = tree === snaps[0].tree ? 'a' : tree === snaps[1].tree ? 'b' : 'c'
        // Which project shows while this one is rebuilt, and the projects listed.
        seen.push([name, live.currentWsId.value, live.workspaces.value.map((w) => w.id).join(','), typeof (attaching && attaching.get)])
        return tree.type === 'leaf' ? { ...tree } : { ...tree.children[0] }
      },
      { currentIndex: 2, attachPty, onCtx: (c) => (live = c) }
    )
    // Its terminals asked first, then the others in the saved order.
    expect(attachPty.mock.calls.map((c) => c[0])).toEqual(['pane-c1', 'pane-c2', 'pane-a1', 'pane-a2', 'pane-b1'])
    expect(seen).toEqual([
      ['c', null, '', 'function'],
      // Shown, before the others are rebuilt; each then put in its place.
      ['a', 'ws-c', 'ws-c', 'function'],
      ['b', 'ws-c', 'ws-a,ws-c', 'function']
    ])
    expect(ctx.workspaces.value.map((w) => w.id)).toEqual(['ws-a', 'ws-b', 'ws-c'])
    expect(ctx.currentWsId.value).toBe('ws-c')
    expect(ctx.restoreReport.shownAt).toBeGreaterThan(0)
    expect(ctx.restoreReport.attach).toMatchObject({ count: 5, attached: 0 })
  })

  it('a pane on an SSH host whose connection dropped since its answer waits for its host once it is in the tree', async () => {
    const live = []
    const ctx = await restore(
      [{ id: 'ws-a', name: 'A', tree: { type: 'split', children: [{ type: 'leaf', id: 'pane-s1' }, { type: 'leaf', id: 'pane-l1' }] } }],
      async (tree) => ({
        ...tree,
        children: [
          { type: 'leaf', id: 'pane-s1', attached: true, remoteHostId: 'ssh-box', pid: null, answeredAt: 100 },
          { type: 'leaf', id: 'pane-l1', attached: true, pid: 42, answeredAt: 100 }
        ]
      }),
      {
        onCtx: (c) => {
          c.exitOf = (id, pid, since) => (id === 'pane-s1' && pid === null && since === 100 ? { exitCode: 255 } : id === 'pane-l1' ? { exitCode: 1 } : null)
          c.waitForHostAgain = vi.fn((id) => live.push([id, c.workspaces.value.map((w) => w.id)]))
        }
      }
    )
    // Only the SSH pane (a local one shows its end itself), once placed.
    expect(ctx.waitForHostAgain).toHaveBeenCalledTimes(1)
    expect(ctx.waitForHostAgain).toHaveBeenCalledWith('pane-s1', { exitCode: 255, pid: null })
    expect(live).toEqual([['pane-s1', ['ws-a']]])
  })

  it('the project you were in could not come back: the one at its place is shown, as before', async () => {
    const ctx = await restore(
      [
        { id: 'ws-a', name: 'A', tree: { type: 'leaf', id: 'pane-a' } },
        { id: 'ws-b', name: 'B', tree: { type: 'leaf', id: 'pane-b' } }
      ],
      async (tree) => (tree.id === 'pane-b' ? null : { ...tree }),
      // Not even a shell could start for it.
      { currentIndex: 1, onCtx: (c) => c.createLeaf.mockImplementation(async () => null) }
    )
    expect(ctx.workspaces.value.map((w) => w.id)).toEqual(['ws-a'])
    // Left to the end of the restore (App.vue: the one now at its place).
    expect(ctx.currentWsId.value).toBe(null)
  })

  it('its panes come back as before; nothing new is started', async () => {
    const ctx = await restore([{ id: 'ws-a', name: 'A', cwd: 'C:\\a', tree: { type: 'leaf', id: 'pane-1' } }], async (snap) => ({ ...snap }))
    expect(ctx.createLeaf).not.toHaveBeenCalled()
    expect(ctx.workspaces.value[0]).toMatchObject({ id: 'ws-a', tree: { id: 'pane-1' }, activeId: 'pane-1' })
  })

  it('panes that could not come back: a shell, as before', async () => {
    const ctx = await restore([{ id: 'ws-a', name: 'A', cwd: 'C:\\a', tree: { type: 'leaf', id: 'pane-1' } }], async () => null)
    expect(ctx.createLeaf).toHaveBeenCalledTimes(1)
    expect(ctx.workspaces.value[0].tree).toMatchObject({ id: 'pane-fresh' })
  })

  it('a project saved with its launcher (no pane) comes back with it, here or on a host', async () => {
    const ctx = await restore(
      [
        { id: 'ws-a', name: 'A', cwd: 'C:\\a', tree: null },
        { id: 'ws-b', name: 'B', cwd: null, remote: { hostId: 'ssh-box', path: '/srv' }, tree: null }
      ],
      async () => null
    )
    expect(ctx.createLeaf).not.toHaveBeenCalled()
    expect(ctx.workspaces.value.map((w) => [w.tree, w.activeId])).toEqual([
      [null, null],
      [null, null]
    ])
  })
})
