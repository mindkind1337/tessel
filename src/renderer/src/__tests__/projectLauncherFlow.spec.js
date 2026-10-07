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
    createLeaf: vi.fn(async (shellId, agent, cwd, worktree, opts) => reactive({ type: 'leaf', id: `pane-${++n}`, shellId, agentId: agent ? agent.id : null, cwd, ...opts })),
    openInBrowser: vi.fn(({ ws }) => {
      ws.tree = { type: 'leaf', id: 'pane-browser', kind: 'browser' }
      return ws.tree
    }),
    resumeSession: vi.fn(async () => {}),
    window: { shellApi: { killPty: vi.fn() } },
    Promise,
    Array,
    String
  }
  vm.createContext(ctx)
  vm.runInContext(
    slice('function wsLeafOpts(ws, opts = {})', 'function folderName(') +
      slice('function sameProject(ws, spec)', 'function manageHostsFromAddProject') +
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

  it('an agent missing on the host (Install…): its install, nothing started; installed by hand since: started', async () => {
    const env = load({ remoteStatus: { 'ssh-box': { claude: 'x', codex: null } } })
    env.ctx.recheckOrInstall = vi.fn(async () => false)
    await env.api.addProjects({ projects: [REMOTE] })
    await env.api.pickFromLauncher({ kind: 'install', id: 'codex' }, { remember: true })
    expect(env.ctx.recheckOrInstall).toHaveBeenCalledWith('ssh-box', 'codex')
    expect(env.ctx.createLeaf).not.toHaveBeenCalled()
    // Never remembered as what new projects start.
    expect(env.ctx.settings.projectOpen).toBe('ask')
    env.ctx.recheckOrInstall = vi.fn(async () => true)
    await env.api.pickFromLauncher({ kind: 'install', id: 'codex' }, { remember: false })
    expect(env.ctx.createLeaf).toHaveBeenCalledTimes(1)
    expect(env.ctx.createLeaf.mock.calls[0][1]).toBe(AGENTS[1])
    expect(env.ctx.createLeaf.mock.calls[0][4]).toEqual({ remoteHostId: 'ssh-box', remotePath: '/srv/app' })
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
  function restore(snaps, deserialize) {
    const workspaces = ref([])
    const ctx = {
      workspaces,
      makeWorkspace: (name) => reactive({ id: 'ws-new', name, tree: null, activeId: null, cwd: null, remote: null, group: null }),
      nextWorkspaceName: () => 'Workspace',
      savedRemote: (r) => (r ? { ...r } : null),
      savedGroup: () => null,
      deserializeNode: vi.fn(deserialize),
      createLeaf: vi.fn(async () => ({ type: 'leaf', id: 'pane-fresh' })),
      selectedShell: ref('powershell'),
      wsLeafOpts: (_ws, o = {}) => o,
      firstAwakeLeafId: (tree) => tree.id
    }
    vm.createContext(ctx)
    vm.runInContext(`this.run = async function (snaps) {\n${slice('    for (const snap of snaps) {', '    if (workspaces.value.length) {')}\n}`, ctx)
    return ctx.run(snaps).then(() => ctx)
  }

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
