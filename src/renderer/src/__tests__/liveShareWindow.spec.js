import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { reactive, ref, nextTick } from 'vue'
import { createLiveShareWindow } from '../liveShareWindow'
import { NO_RIGHTS } from '../../../shared/liveShareRights'

const flush = async () => {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve()
    await nextTick()
  }
}

// A guest's status as main sends it. `layout` stands for one project of the
// host's (ws-a) with that layout, the panes in it.
const guestStatus = (s) => {
  if (!s || !('layout' in s)) return s
  const { layout, ...rest } = s
  return { ...rest, panes: (s.panes || []).map((p) => ({ project: 'ws-a', ...p })), projects: layout ? [{ id: 'ws-a', layout }] : [] }
}

function setup() {
  const listeners = {}
  // The projects main shares (liveShare:share answers with them).
  const hostIds = []
  const api = {
    state: vi.fn(async () => ({ host: { state: 'off', invite: null, guests: [], progress: null, error: null }, guest: { state: 'off', panes: [], projects: [] }, defaultName: 'cedri' })),
    setLayouts: vi.fn(),
    share: vi.fn(async ({ id, shared }) => {
      const i = hostIds.indexOf(id)
      if (shared && i < 0) hostIds.push(id)
      if (!shared && i >= 0) {
        if (hostIds.length === 1) return { ok: false, reason: 'last' }
        hostIds.splice(i, 1)
      }
      return { ok: true, projectIds: [...hostIds] }
    }),
    approve: vi.fn(async () => ({ ok: true })),
    stop: vi.fn(),
    open: vi.fn(async () => ({ ok: true, asked: false })),
    leave: vi.fn(),
    setAgents: vi.fn(),
    focus: vi.fn(),
    requestDone: vi.fn()
  }
  for (const name of ['onHost', 'onGuest', 'onAsk', 'onHostRequest', 'onNotice', 'onPresence', 'onInviteBlocked']) {
    api[name] = (cb) => {
      listeners[name] = name === 'onGuest' ? (s) => cb(guestStatus(s)) : cb
      return () => delete listeners[name]
    }
  }
  window.shellApi = {
    liveShare: api,
    attachPty: vi.fn(async (id) => ({ ok: true, buffer: `screen ${id}`, shell: { id: 'liveshare', name: 'Ada' }, backend: 'liveshare' }))
  }
  const workspaces = ref([])
  const currentWsId = ref(null)
  const maximizedId = ref(null)
  const layoutReady = ref(false)
  const agentList = ref([{ id: 'claude', name: 'Claude Code' }])
  const activePane = ref(null)
  const seeded = {}
  const toasts = []
  let made = 0
  const deps = {
    workspaces: () => workspaces.value,
    currentWs: () => workspaces.value.find((w) => w.id === currentWsId.value) || null,
    currentWsId: () => currentWsId.value,
    maximizedId: () => maximizedId.value,
    setMaximized: (id) => (maximizedId.value = id),
    makeWorkspace: (name) => reactive({ id: `ws-${++made + 100}`, name, tree: null, activeId: null, cwd: null }),
    selectWorkspace: (id) => (currentWsId.value = id),
    removeWorkspace: vi.fn((id) => (workspaces.value = workspaces.value.filter((w) => w.id !== id))),
    findLeaf: (id) => (id === 'pane-gone' ? null : { id, title: id === 'pane-agent' ? 'Claude Code' : 'PowerShell', kind: id === 'pane-agent' ? 'agent' : 'shell' }),
    closeLeaf: vi.fn(),
    launch: vi.fn(),
    selectedShell: () => 'pwsh',
    seedBuffer: (id, text) => (seeded[id] = text),
    dropBuffer: (id) => delete seeded[id],
    showToast: (text) => toasts.push(text),
    isAgentLeaf: (l) => l.kind === 'agent',
    probeRunningWork: vi.fn(async (id) => (id === 'pane-busy' ? { running: true, unknown: false, names: ['npm'] } : { running: false, unknown: false, names: [] })),
    killPty: vi.fn(),
    adoptLeaves: vi.fn(),
    hasAgent: (id) => id !== 'nope',
    agentName: (id) => ({ claude: 'Claude Code' })[id] || null,
    agentList: () => agentList.value,
    activePaneId: () => activePane.value,
    layoutReady: () => layoutReady.value
  }
  const ls = createLiveShareWindow(deps)
  return { ls, api, listeners, deps, workspaces, currentWsId, maximizedId, layoutReady, seeded, toasts, hostIds, agentList, activePane }
}

const NO = { ...NO_RIGHTS, type: false, open: false, close: false }
const pane = (id, extra = {}) => ({ id, title: id, kind: 'shell', cols: 120, rows: 30, ...extra })
const leaf = (id, view = 'terminal') => ({ type: 'leaf', id, view, title: id, kind: 'shell' })

describe('Live Share in the window, as a guest', () => {
  let t
  beforeEach(async () => {
    t = setup()
    await t.ls.init()
  })
  afterEach(() => t.ls.dispose())

  it("a fullscreen pane the host chose in a project not on screen is applied when that project comes up", async () => {
    const lay = (project, tree, maximizedId = null) => ({ project, tree, activeId: null, maximizedId })
    const two = { type: 'split', dir: 'row', sizes: [50, 50], children: [leaf('pane-ls1-b1'), leaf('pane-ls1-b2')] }
    t.listeners.onGuest({
      state: 'joined',
      host: 'Ada',
      session: 1,
      panes: [pane('pane-ls1-a1', { project: 'ws-a' }), pane('pane-ls1-b1', { project: 'ws-b' }), pane('pane-ls1-b2', { project: 'ws-b' })],
      projects: [
        { id: 'ws-a', layout: lay('a', leaf('pane-ls1-a1')) },
        { id: 'ws-b', layout: lay('b', two, 'pane-ls1-b2') }
      ]
    })
    await flush()
    const b = t.workspaces.value.find((w) => w.liveShare && w.liveShare.project === 'ws-b')
    expect(b).toBeTruthy()
    expect(t.currentWsId.value).not.toBe(b.id)
    expect(t.maximizedId.value).toBeNull()
    t.currentWsId.value = b.id
    await flush()
    expect(t.maximizedId.value).toBe('pane-ls1-b2')
  })

  it('shows the host screen as a Live Share project that follows its layout', async () => {
    const layout = {
      project: 'tessel',
      tree: { type: 'split', dir: 'row', sizes: [50, 30, 20], children: [leaf('pane-ls1-a'), leaf('pane-ls1-b'), leaf('pane-ls1-ed', 'editor')] },
      activeId: 'pane-ls1-b',
      maximizedId: null
    }
    t.listeners.onGuest({ state: 'joined', host: 'Ada', session: 1, panes: [pane('pane-ls1-a'), pane('pane-ls1-b')], layout })
    await flush()
    const ws = t.workspaces.value[0]
    expect(ws.liveShare).toEqual({ session: 1, host: 'Ada', project: 'ws-a', projectName: 'tessel' })
    expect(ws.name).toBe('tessel — Ada')
    expect(t.currentWsId.value).toBe(ws.id)
    expect(t.seeded['pane-ls1-a']).toBe('screen pane-ls1-a')
    expect(ws.tree.type).toBe('split')
    expect(ws.tree.children.map((c) => c.id)).toEqual(['pane-ls1-a', 'pane-ls1-b'])
    expect(ws.tree.children[0].backend).toBe('liveshare')
    expect(ws.tree.children[0].liveShare.cols).toBe(120)
    expect(ws.activeId).toBe('pane-ls1-b')
    const first = ws.tree.children[0]

    // The host goes fullscreen on a pane and resizes another: followed.
    t.listeners.onGuest({ state: 'joined', host: 'Ada', session: 1, panes: [pane('pane-ls1-a', { cols: 90 }), pane('pane-ls1-b')], layout: { ...layout, maximizedId: 'pane-ls1-a' } })
    await flush()
    expect(t.maximizedId.value).toBe('pane-ls1-a')
    expect(ws.tree.children[0]).toBe(first) // same leaf: its terminal stays
    expect(first.liveShare.cols).toBe(90)

    // The host closes a pane.
    t.listeners.onGuest({ state: 'joined', host: 'Ada', session: 1, panes: [pane('pane-ls1-a')], layout: { ...layout, tree: leaf('pane-ls1-a'), activeId: 'pane-ls1-a' } })
    await flush()
    expect(ws.tree.id).toBe('pane-ls1-a')
    expect(t.seeded['pane-ls1-b']).toBe(undefined)
  })

  it('follows what the host lets it do: view only until allowed to type, open or close', async () => {
    const rights = { ...NO_RIGHTS, type: false, open: false, close: false }
    t.listeners.onGuest({ state: 'joined', host: 'Ada', session: 1, panes: [pane('pane-ls1-a')], layout: { project: 'x', tree: leaf('pane-ls1-a'), activeId: null, maximizedId: null }, rights })
    await flush()
    const first = t.workspaces.value[0].tree
    expect(first.liveShare.canType).toBe(false)
    expect(first.liveShare.host).toBe('Ada')
    t.ls.openOnHost({ kind: 'terminal' })
    expect(t.api.open).not.toHaveBeenCalled()
    expect(t.toasts.at(-1)).toMatch(/has not let you open/)
    expect(t.ls.canClose()).toBe(false)
    expect(t.toasts.at(-1)).toMatch(/has not let you close/)

    t.listeners.onGuest({ state: 'joined', host: 'Ada', session: 1, panes: [pane('pane-ls1-a')], layout: { project: 'x', tree: leaf('pane-ls1-a'), activeId: null, maximizedId: null }, rights: { ...NO_RIGHTS, type: true, open: true, close: true } })
    await flush()
    expect(first.liveShare.canType).toBe(true)
    expect(t.toasts.at(-1)).toMatch(/Ada changed what you can do/)
    t.ls.openOnHost({ kind: 'terminal' })
    expect(t.api.open).toHaveBeenCalledWith({ kind: 'terminal', project: 'ws-a' })
    expect(t.ls.canClose()).toBe(true)

    t.listeners.onNotice({ code: 'limit' })
    expect(t.toasts.at(-1)).toMatch(/limits how often/)
  })

  it('closing a host pane only asks the host: it stays until the host closed it', async () => {
    t.listeners.onGuest({ state: 'joined', host: 'Ada', session: 1, panes: [pane('pane-ls1-a')], layout: { project: 'x', tree: leaf('pane-ls1-a'), activeId: null, maximizedId: null }, rights: { ...NO_RIGHTS, type: false, open: false, close: true } })
    await flush()
    t.ls.requestClose('pane-ls1-a', 'Claude Code')
    expect(t.deps.killPty).toHaveBeenCalledWith('pane-ls1-a')
    expect(t.toasts.at(-1)).toBe('Asked Ada to close Claude Code.')
    expect(t.workspaces.value[0].tree.id).toBe('pane-ls1-a')
    expect(t.seeded['pane-ls1-a']).toBe('screen pane-ls1-a')
    // Not one of the host's panes, or not allowed: nothing asked.
    t.ls.requestClose('pane-1', 'x')
    t.listeners.onGuest({ state: 'joined', host: 'Ada', session: 1, panes: [pane('pane-ls1-a')], layout: { project: 'x', tree: leaf('pane-ls1-a'), activeId: null, maximizedId: null }, rights: { ...NO_RIGHTS, type: false, open: false, close: false } })
    await flush()
    t.ls.requestClose('pane-ls1-a', 'Claude Code')
    expect(t.deps.killPty).toHaveBeenCalledTimes(1)
  })

  it('keeps a pane of this computer that opened in the Live Share project, and gives it back at the end', async () => {
    t.listeners.onGuest({ state: 'joined', host: 'Ada', session: 1, panes: [pane('pane-ls1-a')], layout: { project: 'x', tree: leaf('pane-ls1-a'), activeId: null, maximizedId: null } })
    await flush()
    const ws = t.workspaces.value[0]
    const page = reactive({ type: 'leaf', id: 'pane-web', kind: 'browser', title: 'localhost' })
    ws.tree = reactive({ type: 'split', id: 's', dir: 'row', sizes: [50, 50], children: [ws.tree, page] })
    // The host changes its layout: the page stays beside the host's panes.
    t.listeners.onGuest({ state: 'joined', host: 'Ada', session: 1, panes: [pane('pane-ls1-a'), pane('pane-ls1-b')], layout: { project: 'x', tree: { type: 'split', dir: 'col', sizes: [50, 50], children: [leaf('pane-ls1-a'), leaf('pane-ls1-b')] }, activeId: null, maximizedId: null } })
    await flush()
    expect(ws.tree.children.at(-1)).toBe(page)
    t.listeners.onGuest({ state: 'ended', host: 'Ada', session: 1, panes: [], layout: null, reason: 'left' })
    await flush()
    expect(t.deps.adoptLeaves).toHaveBeenCalledWith([page])
  })

  it('opens new panes on the host, and the project goes when the session ends', async () => {
    t.listeners.onGuest({ state: 'joined', host: 'Ada', session: 1, panes: [pane('pane-ls1-a')], layout: { project: 'x', tree: leaf('pane-ls1-a'), activeId: null, maximizedId: null } })
    await flush()
    t.ls.openOnHost({ kind: 'agent', agent: 'codex' })
    expect(t.api.open).toHaveBeenCalledWith({ kind: 'agent', agent: 'codex', project: 'ws-a' })
    t.listeners.onGuest({ state: 'ended', host: 'Ada', session: 1, panes: [], layout: null, reason: 'stopped' })
    await flush()
    expect(t.workspaces.value).toEqual([])
    expect(t.toasts.some((x) => /stopped sharing/.test(x))).toBe(true)
  })

  it('an end reason the host made up ends the session like any other, said as "the session ended"', async () => {
    for (const reason of ['__proto__', 'constructor', 'toString']) {
      t.listeners.onGuest({ state: 'joined', host: 'Ada', session: 1, panes: [pane('pane-ls1-a')], layout: { project: 'x', tree: leaf('pane-ls1-a'), activeId: null, maximizedId: null } })
      await flush()
      expect(() => t.listeners.onGuest({ state: 'ended', host: 'Ada', session: 1, panes: [], layout: null, reason })).not.toThrow()
      await flush()
      expect(t.workspaces.value).toEqual([])
      expect(t.toasts.at(-1)).toBe('Live Share with Ada ended: The session ended.')
    }
  })
})

describe('Live Share in the window, as a guest of several projects', () => {
  let t
  beforeEach(async () => {
    t = setup()
    await t.ls.init()
  })
  afterEach(() => t.ls.dispose())

  const proj = (id, name, ids) => ({ id, layout: { project: name, tree: ids.length === 1 ? leaf(ids[0]) : { type: 'split', dir: 'row', sizes: ids.map(() => 100 / ids.length), children: ids.map((x) => leaf(x)) }, activeId: ids[0], maximizedId: null } })
  const status = (projects, panes, extra = {}) => ({ state: 'joined', host: 'Ada', session: 1, rights: { ...NO_RIGHTS, type: true, open: true, close: true }, projects, panes, ...extra })
  const wsOf = (project) => t.workspaces.value.find((w) => w.liveShare && w.liveShare.project === project)

  it('one Live Share project per project of the host, each following its own layout; the first one opens', async () => {
    t.listeners.onGuest(status([proj('ws-a', 'site', ['pane-ls1-a']), proj('ws-b', 'api', ['pane-ls1-b1', 'pane-ls1-b2'])], [pane('pane-ls1-a', { project: 'ws-a' }), pane('pane-ls1-b1', { project: 'ws-b' }), pane('pane-ls1-b2', { project: 'ws-b' })]))
    await flush()
    expect(t.workspaces.value.map((w) => w.name)).toEqual(['site — Ada', 'api — Ada'])
    expect(t.currentWsId.value).toBe(wsOf('ws-a').id)
    expect(wsOf('ws-a').tree.id).toBe('pane-ls1-a')
    expect(wsOf('ws-b').tree.children.map((c) => c.id)).toEqual(['pane-ls1-b1', 'pane-ls1-b2'])
    expect(wsOf('ws-b').activeId).toBe('pane-ls1-b1')
    // Opening in a project goes to that project of the host's.
    t.ls.openOnHost({ kind: 'terminal' }, wsOf('ws-b'))
    expect(t.api.open).toHaveBeenLastCalledWith({ kind: 'terminal', project: 'ws-b' })
    // A pane the host lists in one project never shows in another's tree.
    t.listeners.onGuest(status([proj('ws-a', 'site', ['pane-ls1-a', 'pane-ls1-b1']), proj('ws-b', 'api', ['pane-ls1-b1', 'pane-ls1-b2'])], [pane('pane-ls1-a', { project: 'ws-a' }), pane('pane-ls1-b1', { project: 'ws-b' }), pane('pane-ls1-b2', { project: 'ws-b' })]))
    await flush()
    expect(wsOf('ws-a').tree.id).toBe('pane-ls1-a')
  })

  it('a project the host shares with you later comes (said, not opened); one it stops sharing goes, with your own panes kept', async () => {
    t.listeners.onGuest(status([proj('ws-a', 'site', ['pane-ls1-a'])], [pane('pane-ls1-a', { project: 'ws-a' })]))
    await flush()
    const first = wsOf('ws-a')
    t.listeners.onGuest(status([proj('ws-a', 'site', ['pane-ls1-a']), proj('ws-b', 'api', ['pane-ls1-b'])], [pane('pane-ls1-a', { project: 'ws-a' }), pane('pane-ls1-b', { project: 'ws-b' })]))
    await flush()
    expect(wsOf('ws-b').name).toBe('api — Ada')
    expect(t.currentWsId.value).toBe(first.id)
    expect(t.toasts.at(-1)).toBe('Ada now shares api with you.')
    // A page of this computer opened in ws-b.
    const page = reactive({ type: 'leaf', id: 'pane-web', kind: 'browser', title: 'localhost' })
    wsOf('ws-b').tree = reactive({ type: 'split', id: 's', dir: 'row', sizes: [50, 50], children: [wsOf('ws-b').tree, page] })
    const b = wsOf('ws-b')
    t.listeners.onGuest(status([proj('ws-a', 'site', ['pane-ls1-a'])], [pane('pane-ls1-a', { project: 'ws-a' })]))
    await flush()
    expect(wsOf('ws-b')).toBe(undefined)
    expect(t.deps.removeWorkspace).toHaveBeenCalledWith(b.id, true, true)
    expect(t.deps.adoptLeaves).toHaveBeenCalledWith([page])
    expect(t.toasts.at(-1)).toBe('Ada no longer shares api with you.')
    expect(t.seeded['pane-ls1-b']).toBe(undefined)
    // Leaving: every project of the host goes.
    t.listeners.onGuest({ state: 'ended', host: 'Ada', session: 1, panes: [], projects: [], reason: 'left' })
    await flush()
    expect(t.workspaces.value).toEqual([])
  })

  it('a pane the host moves to another of its projects shows there, as a new terminal with its new screen', async () => {
    t.listeners.onGuest(status([proj('ws-a', 'site', ['pane-ls1-a', 'pane-ls1-m']), proj('ws-b', 'api', ['pane-ls1-b'])], [pane('pane-ls1-a', { project: 'ws-a' }), pane('pane-ls1-m', { project: 'ws-a' }), pane('pane-ls1-b', { project: 'ws-b' })]))
    await flush()
    const moving = wsOf('ws-a').tree.children.find((l) => l.id === 'pane-ls1-m')
    window.shellApi.attachPty.mockImplementation(async (id) => ({ ok: true, buffer: `moved screen ${id}`, shell: { id: 'liveshare', name: 'Ada' }, backend: 'liveshare' }))
    t.listeners.onGuest(status([proj('ws-a', 'site', ['pane-ls1-a']), proj('ws-b', 'api', ['pane-ls1-b', 'pane-ls1-m'])], [pane('pane-ls1-a', { project: 'ws-a' }), pane('pane-ls1-m', { project: 'ws-b', gen: 1 }), pane('pane-ls1-b', { project: 'ws-b' })]))
    await flush()
    await flush()
    expect(wsOf('ws-a').tree.id).toBe('pane-ls1-a')
    expect(wsOf('ws-b').tree.children.map((c) => c.id)).toEqual(['pane-ls1-b', 'pane-ls1-m'])
    expect(wsOf('ws-b').tree.children[1]).toBe(moving)
    expect(moving.gen).toBe(1)
    expect(moving.liveShare.project).toBe('ws-b')
    expect(t.seeded['pane-ls1-m']).toBe('moved screen pane-ls1-m')
  })

  it('no project given yet: joined, nothing shown; the first one given opens', async () => {
    t.listeners.onGuest(status([], []))
    await flush()
    expect(t.workspaces.value).toEqual([])
    t.listeners.onGuest(status([proj('ws-b', 'api', ['pane-ls1-b'])], [pane('pane-ls1-b', { project: 'ws-b' })]))
    await flush()
    expect(t.currentWsId.value).toBe(wsOf('ws-b').id)
  })
})

describe('Live Share in the window, as the host', () => {
  let t
  beforeEach(async () => {
    t = setup()
    await t.ls.init()
  })
  afterEach(() => t.ls.dispose())

  function twoProjects() {
    const shared = reactive({ id: 'ws-1', name: 'tessel', activeId: 'pane-1', tree: { type: 'leaf', id: 'pane-1', kind: 'shell', title: 'PowerShell' } })
    const other = reactive({ id: 'ws-2', name: 'private', activeId: 'pane-2', tree: { type: 'leaf', id: 'pane-2', kind: 'shell', title: 'secrets' } })
    t.workspaces.value.push(shared, other)
    t.currentWsId.value = 'ws-1'
    return { shared, other }
  }
  // Main says it shares these projects.
  const sharingNow = (ids, extra = {}) => {
    t.hostIds.splice(0, t.hostIds.length, ...ids)
    t.listeners.onHost({ state: 'sharing', invite: 'TS1.x.y', projectIds: [...ids], guests: [], progress: null, error: null, ...extra })
  }
  const lastLayouts = () => t.api.setLayouts.mock.calls.at(-1)[0]

  it('shares the projects chosen, not the one on screen', async () => {
    const { shared } = twoProjects()
    t.ls.prepareShare()
    expect(t.ls.state.pickedIds).toEqual(['ws-1'])
    expect(t.ls.chosenIds()).toEqual(['ws-1'])
    await flush()
    expect(t.api.setLayouts).not.toHaveBeenCalled()
    sharingNow(['ws-1'])
    await flush()
    expect(lastLayouts()).toEqual([{ id: 'ws-1', layout: expect.objectContaining({ project: 'tessel', activeId: 'pane-1' }), chats: [], root: null, tabs: { files: [], active: null } }])
    shared.tree.title = 'npm run dev'
    await flush()
    expect(lastLayouts()[0].layout.tree.title).toBe('npm run dev')

    // You switch to another project: the guests keep seeing the shared one
    // (without the fullscreen pane of the window, which is the other project's).
    t.maximizedId.value = 'pane-2'
    t.currentWsId.value = 'ws-2'
    await flush()
    const sent = t.api.setLayouts.mock.calls.map((c) => c[0].map((x) => x.id).join())
    expect(sent.every((ids) => ids === 'ws-1')).toBe(true)
    expect(lastLayouts()[0].layout.maximizedId).toBe(null)
  })

  it('after a restart (nothing picked in this window), ticks the projects main kept from the last share, not only the one on screen', async () => {
    twoProjects()
    t.listeners.onHost({ state: 'off', projectIds: [], guests: [], lastProjectIds: ['ws-2', 'ws-gone'] })
    t.ls.prepareShare()
    expect(t.ls.chosenIds()).toEqual(['ws-2'])
  })

  it('a share back after a restart says so once (a toast)', async () => {
    twoProjects()
    sharingNow(['ws-1'], { resumed: 1234 })
    sharingNow(['ws-1'], { resumed: 1234 })
    expect(t.toasts.filter((x) => /started again/.test(x))).toHaveLength(1)
  })

  it('picks the projects before you start: several, at least one', async () => {
    twoProjects()
    t.ls.prepareShare()
    await t.ls.setShared('ws-2', true)
    expect(t.ls.chosenIds()).toEqual(['ws-1', 'ws-2'])
    await t.ls.setShared('ws-1', false)
    expect(t.ls.chosenIds()).toEqual(['ws-2'])
    expect(t.api.share).not.toHaveBeenCalled()
    // Picked last time and still there: offered again.
    t.ls.prepareShare()
    expect(t.ls.chosenIds()).toEqual(['ws-2'])
    // A Live Share project (someone else's) can't be picked.
    t.workspaces.value.push(reactive({ id: 'ws-ls', name: 'x — Bo', liveShare: { session: 1, project: 'p' }, tree: null }))
    expect(await t.ls.setShared('ws-ls', true)).toBe(false)
    expect(t.ls.chosenIds()).toEqual(['ws-2'])
  })

  it('adds and takes out projects while sharing; the last one stays', async () => {
    twoProjects()
    t.ls.prepareShare()
    sharingNow(['ws-1'])
    await flush()
    expect(await t.ls.setShared('ws-2', true)).toBe(true)
    expect(t.api.share).toHaveBeenLastCalledWith({ id: 'ws-2', shared: true })
    expect(t.ls.sharedIds()).toEqual(['ws-1', 'ws-2'])
    expect(t.toasts.at(-1)).toMatch(/private is shared now\. Guests already in see it only once you give it to them/)
    await flush()
    expect(lastLayouts().map((x) => [x.id, x.layout.project])).toEqual([
      ['ws-1', 'tessel'],
      ['ws-2', 'private']
    ])
    expect(await t.ls.setShared('ws-1', false)).toBe(true)
    expect(t.ls.sharedIds()).toEqual(['ws-2'])
    expect(t.toasts.at(-1)).toBe('tessel is no longer shared: guests no longer see it.')
    await flush()
    expect(lastLayouts().map((x) => x.id)).toEqual(['ws-2'])
    // The last one: not taken out (Stop sharing ends the share).
    t.api.share.mockClear()
    expect(await t.ls.setShared('ws-2', false)).toBe(false)
    expect(t.api.share).not.toHaveBeenCalled()
    expect(t.toasts.at(-1)).toMatch(/only project you share\. To stop sharing it, use Stop sharing/)
    // Main says no (too many): said.
    t.api.share.mockResolvedValueOnce({ ok: false, reason: 'full', max: 16 })
    expect(await t.ls.setShared('ws-1', true)).toBe(false)
    expect(t.toasts.at(-1)).toBe('You can share up to 16 projects at once.')
  })

  it('a shared project closed is taken out of the share; the last one closed stops sharing', async () => {
    twoProjects()
    t.ls.prepareShare()
    sharingNow(['ws-1', 'ws-2'])
    await flush()
    t.workspaces.value = t.workspaces.value.filter((w) => w.id !== 'ws-2')
    await flush()
    expect(t.api.share).toHaveBeenCalledWith({ id: 'ws-2', shared: false })
    expect(t.api.stop).not.toHaveBeenCalled()
    expect(t.toasts.at(-1)).toBe('You closed private: guests no longer see it.')
    sharingNow(['ws-1'])
    t.workspaces.value = t.workspaces.value.filter((w) => w.id !== 'ws-1')
    await flush()
    expect(t.api.stop).toHaveBeenCalled()
    expect(t.toasts.at(-1)).toMatch(/Live Share stopped/)
  })

  it('asks before a guest joins, answers that guest only (with the projects ticked), and says who joined and left', async () => {
    twoProjects()
    sharingNow(['ws-1', 'ws-2'], { guests: [{ id: 'g1', name: 'Alex', state: 'waiting' }, { id: 'g2', name: 'Bea', state: 'waiting' }] })
    t.listeners.onAsk({ guestId: 'g1', name: 'Alex', code: '123 456' })
    t.listeners.onAsk({ guestId: 'g2', name: 'Bea', code: '654 321' })
    expect(t.ls.state.asks[0]).toEqual({ kind: 'join', key: 'g1', guestId: 'g1', name: 'Alex', code: '123 456', invite: null, offer: null, trustable: false })
    // Alex leaves before the answer: a yes meant for Alex never lets Bea in.
    sharingNow(['ws-1', 'ws-2'], { guests: [{ id: 'g2', name: 'Bea', state: 'waiting' }] })
    t.ls.answerAsk({ key: 'g1', yes: true })
    expect(t.api.approve).not.toHaveBeenCalled()
    expect(t.ls.state.asks.map((a) => a.key)).toEqual(['g2'])
    // Only shared projects are given.
    t.ls.answerAsk({ key: 'g2', yes: true, projects: ['ws-2', 'ws-9'] })
    expect(t.api.approve).toHaveBeenCalledWith({ guestId: 'g2', yes: true, projects: ['ws-2'], rights: NO, trust: false })
    // A yes without projects gives none (never every shared one).
    t.listeners.onAsk({ guestId: 'g3', name: 'Cy' })
    sharingNow(['ws-1', 'ws-2'], { guests: [{ id: 'g3', name: 'Cy', state: 'waiting' }] })
    t.ls.answerAsk({ key: 'g3', yes: true })
    expect(t.api.approve).toHaveBeenLastCalledWith({ guestId: 'g3', yes: true, projects: [], rights: NO, trust: false })
    sharingNow(['ws-1', 'ws-2'], { guests: [{ id: 'g2', name: 'Bea', state: 'joined' }] })
    sharingNow(['ws-1', 'ws-2'], { guests: [] })
    expect(t.toasts.filter((x) => /Bea/.test(x)).length).toBe(2)
  })

  it("People's Let in… puts that guest's prompt first, or makes it again from the status", async () => {
    twoProjects()
    sharingNow(['ws-1', 'ws-2'], {
      guests: [
        { id: 'g1', name: 'Alex', state: 'waiting' },
        { id: 'g2', name: 'Bea', state: 'waiting', code: '42', invite: { id: 'iv-aaaaaaaaaa', label: 'Team' } }
      ],
      invites: [{ id: 'iv-aaaaaaaaaa', label: 'Team', projects: ['ws-2', 'ws-9'], rights: { open: true } }]
    })
    t.listeners.onAsk({ guestId: 'g1', name: 'Alex' })
    t.listeners.onAsk({ guestId: 'g2', name: 'Bea' })
    expect(t.ls.showAsk('g2')).toBe(true)
    expect(t.ls.state.asks.map((a) => a.key)).toEqual(['g2', 'g1'])
    // One this window lost (answered elsewhere, a reload): made again, first,
    // with what its invitation offers now.
    t.ls.state.asks.splice(0, 1)
    expect(t.ls.showAsk('g2')).toBe(true)
    expect(t.ls.state.asks[0]).toMatchObject({ key: 'g2', name: 'Bea', code: '42', offer: { projects: ['ws-2'], rights: { open: true } } })
    expect(t.ls.state.asks.map((a) => a.key)).toEqual(['g2', 'g1'])
    // Someone no longer waiting: nothing.
    expect(t.ls.showAsk('g9')).toBe(false)
  })

  it('the prompt comes with the invitation, its offer and whether to trust; the answer carries the rights and trust', async () => {
    twoProjects()
    sharingNow(['ws-1', 'ws-2'], { guests: [{ id: 'g1', name: 'Alex', state: 'waiting' }, { id: 'g2', name: 'Bea', state: 'waiting' }] })
    t.listeners.onAsk({ guestId: 'g1', name: 'Alex', code: '1', invite: { id: 'iv-aaaaaaaaaa', label: 'Team' }, offer: { projects: ['ws-2'], rights: { open: true, made: true } }, trustable: true })
    expect(t.ls.state.asks[0]).toMatchObject({ invite: { id: 'iv-aaaaaaaaaa', label: 'Team' }, offer: { projects: ['ws-2'], rights: { ...NO_RIGHTS, type: false, open: true, close: false } }, trustable: true })
    t.ls.answerAsk({ key: 'g1', yes: true, projects: ['ws-2'], rights: { type: 1, open: true, made: true }, trust: true })
    expect(t.api.approve).toHaveBeenLastCalledWith({ guestId: 'g1', yes: true, projects: ['ws-2'], rights: { ...NO_RIGHTS, type: false, open: true, close: false }, trust: true })
    // An older guest (no identity key) is never trusted; a no gives nothing.
    t.listeners.onAsk({ guestId: 'g2', name: 'Bea', trustable: false })
    t.ls.answerAsk({ key: 'g2', yes: false, projects: ['ws-1'], rights: { type: true }, trust: true })
    expect(t.api.approve).toHaveBeenLastCalledWith({ guestId: 'g2', yes: false, projects: [], rights: NO, trust: false })
  })

  it('a full trusted list: the guest is let in, and the host is told plainly it was not trusted', async () => {
    t.api.approve.mockResolvedValue({ ok: true, reason: 'trust-full', max: 50 })
    twoProjects()
    sharingNow(['ws-1'], { guests: [{ id: 'g1', name: 'Alex', state: 'waiting' }] })
    t.listeners.onAsk({ guestId: 'g1', name: 'Alex', code: '1', trustable: true })
    t.ls.answerAsk({ key: 'g1', yes: true, projects: ['ws-1'], trust: true })
    await flush()
    expect(t.toasts.at(-1)).toBe('Trusted list full (50): Alex joined without being trusted. Remove someone from Trusted people to trust them.')
  })

  it('a guest whose Tessel can not be trusted: main says so, and the toast says it joined untrusted', async () => {
    t.api.approve.mockResolvedValue({ ok: true, reason: 'not-trustable' })
    twoProjects()
    sharingNow(['ws-1'], { guests: [{ id: 'g1', name: 'Alex', state: 'waiting' }] })
    t.listeners.onAsk({ guestId: 'g1', name: 'Alex', code: '1', trustable: false })
    t.ls.answerAsk({ key: 'g1', yes: true, projects: ['ws-1'], trust: true })
    // Main decides whether it can be trusted.
    expect(t.api.approve).toHaveBeenLastCalledWith(expect.objectContaining({ guestId: 'g1', yes: true, trust: true }))
    await flush()
    expect(t.toasts.at(-1)).toBe('Alex joined without being trusted: their Tessel is too old to be trusted (it needs an update).')
  })

  it('says who joined which project, trusted people let in at once included', async () => {
    twoProjects()
    sharingNow(['ws-1', 'ws-2'], { guests: [{ id: 'g1', name: 'Simpa', state: 'joined', trusted: true, projects: ['ws-1'] }] })
    expect(t.toasts.at(-1)).toBe('Simpa joined tessel.')
    sharingNow(['ws-1', 'ws-2'], { guests: [{ id: 'g1', name: 'Simpa', state: 'joined', projects: ['ws-1'] }, { id: 'g2', name: 'Eve', state: 'joined', projects: ['ws-1', 'ws-2'] }] })
    expect(t.toasts.at(-1)).toBe('Eve joined tessel and 1 more.')
    sharingNow(['ws-1', 'ws-2'], { guests: [{ id: 'g2', name: 'Eve', state: 'joined', projects: ['ws-1', 'ws-2'] }] })
    expect(t.toasts.at(-1)).toBe('Simpa left your Live Share.')
  })

  it('a guest without the right to open asks: you are asked, and it opens on your yes (checked again)', async () => {
    twoProjects()
    const alexIn = (projects = ['ws-1']) => sharingNow(['ws-1', 'ws-2'], { guests: [{ id: 'g1', name: 'Alex', state: 'joined', rights: { open: false }, projects }] })
    alexIn()
    let n = 0
    const ask = (spec) => t.listeners.onHostRequest({ action: 'ask-open', request: `r${++n}`, spec, guest: { id: 'g1', name: 'Alex' } })
    ask({ kind: 'agent', agent: 'claude', project: 'ws-1' })
    ask({ kind: 'terminal', project: 'ws-2' }) // a project Alex does not see
    ask({ kind: 'agent', agent: 'nope', project: 'ws-1' }) // an agent this host does not have
    expect(t.deps.launch).not.toHaveBeenCalled()
    expect(t.ls.state.asks.map((a) => [a.kind, a.request, a.agentName, a.projectName])).toEqual([['open', 'r1', 'Claude Code', 'tessel']])
    // The two dropped at once are done with.
    expect(t.api.requestDone.mock.calls).toEqual([['r2'], ['r3']])
    // An 'open' without the right is not done either (and done with).
    t.listeners.onHostRequest({ action: 'open', request: 'r9', spec: { kind: 'terminal', project: 'ws-1' }, guest: { id: 'g1', name: 'Alex' } })
    expect(t.deps.launch).not.toHaveBeenCalled()
    expect(t.api.requestDone).toHaveBeenLastCalledWith('r9')
    t.ls.answerAsk({ key: t.ls.state.asks[0].key, yes: true })
    expect(t.deps.launch).toHaveBeenCalledWith({ kind: 'agent', id: 'claude' }, 'pane-1', 'right')
    expect(t.toasts.at(-1)).toBe('Alex opened Claude Code in your Tessel.')
    expect(t.api.requestDone).toHaveBeenLastCalledWith('r1')
    // Asked, then the project taken from Alex: the ask goes, nothing opens.
    ask({ kind: 'terminal', project: 'ws-1' })
    expect(t.ls.state.asks).toHaveLength(1)
    alexIn([])
    expect(t.ls.state.asks).toEqual([])
    // At most three asks per guest wait at once.
    alexIn()
    for (let i = 0; i < 5; i++) ask({ kind: 'terminal', project: 'ws-1' })
    expect(t.ls.state.asks).toHaveLength(3)
    t.ls.answerAsk({ key: t.ls.state.asks[0].key, yes: false })
    expect(t.deps.launch).toHaveBeenCalledTimes(1)
  })

  it('main calls a request off: its prompt goes and nothing opens; one opened with the right is done with', async () => {
    twoProjects()
    sharingNow(['ws-1'], { guests: [{ id: 'g1', name: 'Alex', state: 'joined', rights: { open: false }, projects: ['ws-1'] }] })
    t.listeners.onHostRequest({ action: 'ask-open', request: 'r1', spec: { kind: 'terminal', project: 'ws-1' }, guest: { id: 'g1', name: 'Alex' } })
    t.listeners.onHostRequest({ action: 'ask-open', request: 'r2', spec: { kind: 'terminal', project: 'ws-1' }, guest: { id: 'g1', name: 'Alex' } })
    expect(t.ls.state.asks.map((a) => a.request)).toEqual(['r1', 'r2'])
    t.listeners.onHostRequest({ action: 'cancel', request: 'r1' })
    t.listeners.onHostRequest({ action: 'cancel', request: 'r-unknown' })
    expect(t.ls.state.asks.map((a) => a.request)).toEqual(['r2'])
    t.ls.answerAsk({ key: t.ls.state.asks[0].key, yes: false })
    expect(t.deps.launch).not.toHaveBeenCalled()
    expect(t.api.requestDone).toHaveBeenLastCalledWith('r2')
    sharingNow(['ws-1'], { guests: [{ id: 'g1', name: 'Alex', state: 'joined', rights: { open: true }, projects: ['ws-1'] }] })
    t.listeners.onHostRequest({ action: 'open', request: 'r3', spec: { kind: 'terminal', project: 'ws-1' }, guest: { id: 'g1', name: 'Alex' } })
    expect(t.deps.launch).toHaveBeenCalledTimes(1)
    expect(t.api.requestDone).toHaveBeenLastCalledWith('r3')
  })

  it('a trusted person’s new connection replacing the old one is neither a join nor a leave', async () => {
    twoProjects()
    const tess = (id, since) => ({ id, name: 'Tess', state: 'joined', trusted: true, trustId: 't-1', since, projects: ['ws-1'] })
    sharingNow(['ws-1'], { guests: [tess('g1', 1)] })
    expect(t.toasts.at(-1)).toBe('Tess joined tessel.')
    const said = t.toasts.length
    sharingNow(['ws-1'], { guests: [tess('g2', 2)] })
    expect(t.toasts.length).toBe(said)
    // Both for a moment: presence shows the newest only.
    sharingNow(['ws-1'], { guests: [tess('g2', 2), tess('g3', 3)], presence: [{ id: 'pane-1', guests: [{ id: 'g2', watching: true }, { id: 'g3', watching: true }] }] })
    expect(t.ls.presenceOf('pane-1').map((p) => p.id)).toEqual(['g3'])
  })

  it('tells main the agents guests may ask for, at once and when they change', async () => {
    expect(t.api.setAgents).toHaveBeenLastCalledWith([{ id: 'claude', name: 'Claude Code' }])
    t.agentList.value = [{ id: 'claude', name: 'Claude Code' }, { id: 'codex' }, { name: 'no id' }]
    await flush()
    expect(t.api.setAgents).toHaveBeenLastCalledWith([{ id: 'claude', name: 'Claude Code' }, { id: 'codex', name: 'codex' }])
  })

  it('opens what guests ask in the project they asked in, beside its active pane, only a shared project they see', async () => {
    twoProjects()
    sharingNow(['ws-1', 'ws-2'], { guests: [{ id: 'g1', name: 'Alex', state: 'joined', rights: { open: true }, projects: ['ws-1'] }] })
    t.currentWsId.value = 'ws-2'
    const alexAsks = (spec) => t.listeners.onHostRequest({ action: 'open', spec, guest: { id: 'g1', name: 'Alex' } })
    alexAsks({ kind: 'agent', agent: 'claude', project: 'ws-1' })
    alexAsks({ kind: 'terminal', project: 'ws-1' })
    alexAsks({ kind: 'terminal', project: 'ws-2' }) // shared, not one Alex sees
    alexAsks({ kind: 'terminal' }) // no project
    t.listeners.onHostRequest({ action: 'open', spec: { kind: 'terminal', project: 'ws-1' }, guest: { id: 'g9', name: 'Mallory' } })
    expect(t.deps.launch.mock.calls).toEqual([
      [{ kind: 'agent', id: 'claude' }, 'pane-1', 'right'],
      [{ kind: 'shell', id: 'pwsh' }, 'pane-1', 'right']
    ])
    // Taken out of the share: nothing opens there any more.
    sharingNow(['ws-2'], { guests: [{ id: 'g1', name: 'Alex', state: 'joined', rights: { open: true }, projects: ['ws-1'] }] })
    alexAsks({ kind: 'terminal', project: 'ws-1' })
    expect(t.deps.launch).toHaveBeenCalledTimes(2)
  })

  function sharedWithPanes(ids) {
    const ws = reactive({ id: 'ws-1', name: 'tessel', activeId: ids[0], tree: { type: 'split', id: 's', dir: 'row', sizes: ids.map(() => 100 / ids.length), children: ids.map((id) => ({ type: 'leaf', id, kind: 'shell', title: id })) } })
    t.workspaces.value.push(ws)
    t.currentWsId.value = 'ws-1'
    t.ls.prepareShare()
    return ws
  }
  const alex = (rights = { ...NO_RIGHTS, type: false, open: false, close: true }, projects = ['ws-1']) => ({ id: 'g1', name: 'Alex', state: 'joined', rights, projects })
  const hostSays = (guests, ids = ['ws-1']) => t.listeners.onHost({ state: 'sharing', invite: 'x', projectIds: ids, guests })

  it('closes an idle terminal a guest asks to close; an agent or a busy one waits for your yes', async () => {
    sharedWithPanes(['pane-9', 'pane-agent', 'pane-busy'])
    hostSays([alex()])
    const guest = { id: 'g1', name: 'Alex' }
    t.listeners.onHostRequest({ action: 'close', id: 'pane-9', guest })
    await flush()
    expect(t.deps.closeLeaf).toHaveBeenCalledWith('pane-9', { force: true })

    t.listeners.onHostRequest({ action: 'close', id: 'pane-agent', guest })
    t.listeners.onHostRequest({ action: 'close', id: 'pane-busy', guest })
    t.listeners.onHostRequest({ action: 'close', id: 'pane-busy', guest }) // asked twice: one question
    await flush()
    expect(t.deps.closeLeaf).toHaveBeenCalledTimes(1)
    expect(t.ls.state.asks.map((a) => [a.kind, a.paneId])).toEqual([
      ['close', 'pane-agent'],
      ['close', 'pane-busy']
    ])
    expect(t.ls.state.asks[1].detail).toMatch(/npm still runs/)
    t.ls.answerAsk({ key: 'close-pane-agent', yes: false })
    t.ls.answerAsk({ key: 'close-pane-busy', yes: true })
    expect(t.deps.closeLeaf.mock.calls).toEqual([
      ['pane-9', { force: true }],
      ['pane-busy', { force: true }]
    ])
    // A guest who left: its questions go.
    t.listeners.onHostRequest({ action: 'close', id: 'pane-agent', guest })
    await flush()
    hostSays([])
    expect(t.ls.state.asks).toEqual([])
  })

  it('does nothing for a close request that no longer stands', async () => {
    sharedWithPanes(['pane-9', 'pane-busy', 'pane-agent'])
    const guest = { id: 'g1', name: 'Alex' }
    // The guest leaves while Tessel checks what runs in the pane.
    let answer
    t.deps.probeRunningWork.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))
    hostSays([alex()])
    t.listeners.onHostRequest({ action: 'close', id: 'pane-9', guest })
    hostSays([])
    answer({ running: false, unknown: false, names: [] })
    await flush()
    expect(t.deps.closeLeaf).not.toHaveBeenCalled()

    // No right to close, or a pane outside the shared projects: nothing.
    hostSays([alex({ ...NO_RIGHTS, type: true, open: true, close: false })])
    t.listeners.onHostRequest({ action: 'close', id: 'pane-9', guest })
    hostSays([alex()])
    t.listeners.onHostRequest({ action: 'close', id: 'pane-elsewhere', guest })
    await flush()
    expect(t.deps.closeLeaf).not.toHaveBeenCalled()

    // A yes given after the guest lost the right closes nothing.
    t.listeners.onHostRequest({ action: 'close', id: 'pane-agent', guest })
    await flush()
    const ask = t.ls.state.asks.find((a) => a.paneId === 'pane-agent')
    expect(ask).toBeTruthy()
    hostSays([alex({ ...NO_RIGHTS, type: true, open: false, close: false })])
    expect(t.ls.state.asks).toEqual([])
    t.ls.answerAsk({ key: ask.key, yes: true })

    // Sharing stopped and started again: a request of the earlier sharing is stale.
    t.listeners.onHostRequest({ action: 'close', id: 'pane-busy', guest }) // refused: no right now
    hostSays([alex()])
    t.listeners.onHostRequest({ action: 'close', id: 'pane-busy', guest })
    await flush()
    const busy = t.ls.state.asks.find((a) => a.paneId === 'pane-busy')
    t.listeners.onHost({ state: 'off', invite: null, guests: [] })
    hostSays([alex()])
    t.ls.state.asks.push(busy)
    t.ls.answerAsk({ key: busy.key, yes: true })
    expect(t.deps.closeLeaf).not.toHaveBeenCalled()
  })

  it('a close request about a project the guest no longer sees, or one taken out of the share, stands no more', async () => {
    sharedWithPanes(['pane-agent', 'pane-9'])
    const guest = { id: 'g1', name: 'Alex' }
    hostSays([alex()])
    t.listeners.onHostRequest({ action: 'close', id: 'pane-agent', guest })
    await flush()
    expect(t.ls.state.asks.map((a) => a.paneId)).toEqual(['pane-agent'])
    // The host takes ws-1 away from Alex: the question goes, a yes does nothing.
    const ask = t.ls.state.asks[0]
    hostSays([alex(undefined, [])])
    expect(t.ls.state.asks).toEqual([])
    t.ls.state.asks.push(ask)
    t.ls.answerAsk({ key: ask.key, yes: true })
    // A project Alex does not see: an idle terminal there is not closed either.
    t.listeners.onHostRequest({ action: 'close', id: 'pane-9', guest })
    await flush()
    expect(t.deps.closeLeaf).not.toHaveBeenCalled()
  })
})

describe('Live Share in the window: what the review found', () => {
  let t
  beforeEach(async () => {
    t = setup()
    await t.ls.init()
  })
  afterEach(() => t.ls.dispose())

  const twoPanes = (extra = {}) => ({
    state: 'joined',
    host: 'Ada',
    session: 1,
    panes: [pane('pane-ls1-a'), pane('pane-ls1-b')],
    layout: { project: 'x', tree: { type: 'split', dir: 'row', sizes: [50, 50], children: [leaf('pane-ls1-a'), leaf('pane-ls1-b')] }, activeId: 'pane-ls1-a', maximizedId: null },
    rights: { ...NO_RIGHTS, type: true, open: false, close: false },
    ...extra
  })

  it('the keyboard stays in the pane you chose when the host changes its layout', async () => {
    t.listeners.onGuest(twoPanes())
    await flush()
    const ws = t.workspaces.value[0]
    expect(ws.activeId).toBe('pane-ls1-a') // the host's, at first
    ws.activeId = 'pane-ls1-b' // you click pane b
    t.listeners.onGuest(twoPanes({ layout: { ...twoPanes().layout, tree: { ...twoPanes().layout.tree, sizes: [30, 70] } } }))
    t.listeners.onGuest(twoPanes({ layout: { ...twoPanes().layout, activeId: 'pane-ls1-a' } }))
    await flush()
    expect(ws.activeId).toBe('pane-ls1-b')
  })

  it('the host going fullscreen is followed when it changes, not on every update', async () => {
    t.listeners.onGuest(twoPanes({ layout: { ...twoPanes().layout, maximizedId: 'pane-ls1-a' } }))
    await flush()
    expect(t.maximizedId.value).toBe('pane-ls1-a')
    t.maximizedId.value = null // you leave fullscreen
    t.listeners.onGuest(twoPanes({ layout: { ...twoPanes().layout, maximizedId: 'pane-ls1-a', tree: { ...twoPanes().layout.tree, sizes: [40, 60] } } }))
    await flush()
    expect(t.maximizedId.value).toBe(null)
  })

  it('a pane the host restarted gets a new terminal here, with its new screen (attached again)', async () => {
    t.listeners.onGuest(twoPanes())
    await flush()
    const leafA = t.workspaces.value[0].tree.children[0]
    expect(leafA.gen).toBe(0)
    expect(t.seeded['pane-ls1-a']).toBe('screen pane-ls1-a')
    window.shellApi.attachPty.mockImplementation(async (id) => ({ ok: true, buffer: `new screen ${id}`, shell: { id: 'liveshare', name: 'Ada' }, backend: 'liveshare' }))
    t.listeners.onGuest(twoPanes({ panes: [pane('pane-ls1-a', { gen: 1 }), pane('pane-ls1-b')] }))
    await flush()
    // The new screen is there before the new terminal opens on it.
    expect(t.seeded['pane-ls1-a']).toBe('new screen pane-ls1-a')
    expect(leafA.gen).toBe(1)
    expect(window.shellApi.attachPty.mock.calls.filter(([id]) => id === 'pane-ls1-a')).toHaveLength(2)
  })

  it('a pane restarted on the host while it is first attached here: its new screen still comes', async () => {
    let release
    const firstAttach = new Promise((r) => (release = r))
    window.shellApi.attachPty.mockImplementationOnce(async () => {
      await firstAttach
      return { ok: true, buffer: 'OLD-SCREEN', shell: { id: 'liveshare', name: 'Ada' }, backend: 'liveshare' }
    })
    t.listeners.onGuest(twoPanes())
    await flush()
    // The host restarts pane a before its first attach answered.
    t.listeners.onGuest(twoPanes({ panes: [pane('pane-ls1-a', { gen: 1 }), pane('pane-ls1-b')] }))
    window.shellApi.attachPty.mockImplementation(async (id) => ({ ok: true, buffer: `new screen ${id}`, shell: { id: 'liveshare', name: 'Ada' }, backend: 'liveshare' }))
    release()
    await flush()
    await flush()
    const leafA = t.workspaces.value[0].tree.children.find((l) => l.id === 'pane-ls1-a')
    expect(leafA.gen).toBe(1)
    expect(t.seeded['pane-ls1-a']).toBe('new screen pane-ls1-a')
  })

  it('a lost connection keeps the project, view only, until it comes back', async () => {
    t.listeners.onGuest(twoPanes())
    await flush()
    const ws = t.workspaces.value[0]
    const leafA = ws.tree.children[0]
    expect(leafA.liveShare.canType).toBe(true)
    t.listeners.onGuest({ ...twoPanes(), state: 'reconnecting', reason: 'closed' })
    await flush()
    expect(t.workspaces.value).toEqual([ws])
    expect(leafA.liveShare.canType).toBe(false)
    expect(t.toasts.at(-1)).toBe('Connection to Ada lost: reconnecting…')
    t.listeners.onGuest(twoPanes())
    await flush()
    expect(leafA.liveShare.canType).toBe(true)
    expect(t.toasts.at(-1)).toBe('Back in Ada’s Live Share.')
    // Given up: the project goes.
    t.listeners.onGuest({ ...twoPanes(), state: 'reconnecting' })
    t.listeners.onGuest({ state: 'ended', host: 'Ada', session: 1, panes: [], layout: null, reason: 'lost' })
    await flush()
    expect(t.workspaces.value).toEqual([])
  })

  it('the first word on rights is not a change', async () => {
    t.listeners.onGuest(twoPanes({ rights: null }))
    t.listeners.onGuest(twoPanes())
    await flush()
    expect(t.toasts.some((x) => /changed what you can do/.test(x))).toBe(false)
  })

  it('a share taken back after a restart finds its projects again, and its waiting guests are asked', async () => {
    t.ls.dispose()
    t = setup()
    t.api.state.mockResolvedValue({
      host: { state: 'sharing', invite: 'TS1.x.y', projectIds: ['ws-1', 'ws-2'], guests: [{ id: 'g3', name: 'Cy', state: 'waiting', code: '111 222' }] },
      guest: { state: 'off', panes: [], projects: [] },
      defaultName: 'ada'
    })
    await t.ls.init()
    await flush()
    expect(t.ls.state.asks.map((a) => [a.kind, a.guestId, a.code])).toEqual([['join', 'g3', '111 222']])
    // Guests are not sent an empty project while it is not found yet.
    expect(t.api.setLayouts.mock.calls.every(([list]) => list.length === 0)).toBe(true)
    t.workspaces.value.push(reactive({ id: 'ws-1', name: 'tessel', activeId: 'pane-1', tree: { type: 'leaf', id: 'pane-1', kind: 'shell', title: 'PowerShell' } }))
    await flush()
    expect(t.api.setLayouts).toHaveBeenLastCalledWith([{ id: 'ws-1', layout: expect.objectContaining({ project: 'tessel' }), chats: [], root: null, tabs: { files: [], active: null } }])
    expect(t.ls.sharedWss().map((w) => w.id)).toEqual(['ws-1'])
    expect(t.api.share).not.toHaveBeenCalled()
    // The window has its projects back and ws-2 is not among them: out of the share.
    t.layoutReady.value = true
    await flush()
    expect(t.api.share).toHaveBeenCalledWith({ id: 'ws-2', shared: false })
    expect(t.api.stop).not.toHaveBeenCalled()
  })

  it('asks before a guest closes a pane on an SSH host or in WSL (Tessel cannot see what runs there)', async () => {
    const ws = reactive({ id: 'ws-1', name: 'tessel', activeId: 'pane-ssh', tree: { type: 'leaf', id: 'pane-ssh', kind: 'shell', title: 'box' } })
    t.workspaces.value.push(ws)
    t.currentWsId.value = 'ws-1'
    t.deps.findLeaf = (id) => (id === 'pane-ssh' ? { id, title: 'box', kind: 'shell', remoteHostId: 'box' } : null)
    t.ls.prepareShare()
    t.listeners.onHost({ state: 'sharing', invite: 'x', projectIds: ['ws-1'], guests: [{ id: 'g1', name: 'Alex', state: 'joined', rights: { close: true }, projects: ['ws-1'] }] })
    t.listeners.onHostRequest({ action: 'close', id: 'pane-ssh', guest: { id: 'g1', name: 'Alex' } })
    await flush()
    expect(t.deps.closeLeaf).not.toHaveBeenCalled()
    expect(t.ls.state.asks[0]).toMatchObject({ kind: 'close', paneId: 'pane-ssh' })
    expect(t.ls.state.asks[0].detail).toMatch(/SSH host or WSL/)
    expect(t.deps.probeRunningWork).not.toHaveBeenCalled()
  })

  it('says nothing about an agent it does not open', async () => {
    const ws = reactive({ id: 'ws-1', name: 'tessel', activeId: 'pane-1', tree: { type: 'leaf', id: 'pane-1', kind: 'shell', title: 'p' } })
    t.workspaces.value.push(ws)
    t.currentWsId.value = 'ws-1'
    t.ls.prepareShare()
    t.listeners.onHost({ state: 'sharing', invite: 'x', projectIds: ['ws-1'], guests: [{ id: 'g1', name: 'Alex', state: 'joined', rights: { open: true }, projects: ['ws-1'] }] })
    const before = t.toasts.length
    t.listeners.onHostRequest({ action: 'open', spec: { kind: 'agent', agent: 'nope', project: 'ws-1' }, guest: { id: 'g1', name: 'Alex' } })
    expect(t.deps.launch).not.toHaveBeenCalled()
    expect(t.toasts.length).toBe(before)
  })

  it('a guest without a name is "A guest" in the notices', () => {
    t.listeners.onHost({ state: 'sharing', invite: 'x', guests: [{ id: 'g1', name: '', state: 'joined' }] })
    expect(t.toasts.at(-1)).toBe('A guest joined your Live Share.')
  })

  it('what this computer would run in a Live Share project is not opened there', () => {
    t.ls.notHere()
    expect(t.toasts.at(-1)).toMatch(/runs on your computer/)
  })

  it('tells the host when an invitation got blocked, by its label', () => {
    t.listeners.onHost({ state: 'sharing', projectIds: [], invites: [{ id: 'iv-aaaaaaaaaa', label: 'Design', state: 'blocked' }], guests: [] })
    t.listeners.onInviteBlocked({ id: 'iv-aaaaaaaaaa' })
    expect(t.toasts.at(-1)).toBe('Several connections used the code of “Design” without joining: it no longer lets anyone in. Make a new code for it in Live Share.')
  })
})

describe('Live Share, as a guest: your own view of a host’s agent pane', () => {
  let t
  beforeEach(async () => {
    t = setup()
    t.api.chatWatch = vi.fn(async ({ on }) => (on ? { ok: true, last: t.last || null } : { ok: true }))
    t.api.onChat = (cb) => {
      t.listeners.onChat = cb
      return () => delete t.listeners.onChat
    }
    await t.ls.init()
  })
  afterEach(() => t.ls.dispose())

  const agent = (id, extra = {}) => pane(id, { kind: 'agent', agentId: 'claude', ...extra })
  const layoutOf = (...children) => ({ project: 'site', tree: children.length === 1 ? children[0] : { type: 'split', dir: 'row', sizes: children.map(() => 100 / children.length), children }, activeId: null, maximizedId: null })
  const chatOf = (id, terminal = true) => ({ id, project: 'ws-a', title: id, agentId: 'claude', accent: null, terminal })
  // Everything that would reach the host's pane or this window's terminals.
  const reachedHost = () => [t.api.open, t.api.leave, t.api.approve, t.api.stop, t.deps.killPty, t.deps.closeLeaf, t.deps.launch].some((fn) => fn.mock.calls.length)
  const leafOf = (id) => {
    const find = (n) => (!n ? null : n.type === 'leaf' ? (n.id === id ? n : null) : n.children.map(find).find(Boolean) || null)
    return find(t.workspaces.value[0].tree)
  }

  it('a shared agent pane has the chat button (its terminal shown first); switching is yours only', async () => {
    t.listeners.onGuest({ state: 'joined', host: 'Ada', session: 1, panes: [agent('pane-ls1-a'), pane('pane-ls1-ps')], layout: layoutOf(leaf('pane-ls1-a'), leaf('pane-ls1-ps')), chat: true, chats: [chatOf('pane-ls1-a')] })
    await flush()
    const a = leafOf('pane-ls1-a')
    expect(a.liveShare).toMatchObject({ chat: 'shared', terminal: true, view: 'terminal' })
    expect(leafOf('pane-ls1-ps').liveShare.chat).toBe(null)
    const attaches = window.shellApi.attachPty.mock.calls.length

    expect(t.ls.setGuestView('pane-ls1-a', 'chat')).toBe(true)
    expect(a.liveShare.view).toBe('chat')
    expect(t.ls.setGuestView('pane-ls1-a', 'terminal')).toBe(true)
    expect(a.liveShare.view).toBe('terminal')
    // A pane with no conversation, or a view that is not one: nothing.
    expect(t.ls.setGuestView('pane-ls1-ps', 'chat')).toBe(false)
    expect(t.ls.setGuestView('pane-ls1-a', 'editor')).toBe(false)
    // Nothing went to the host, nor to a terminal: not even a read.
    expect(reachedHost()).toBe(false)
    expect(t.api.chatWatch).not.toHaveBeenCalled()
    expect(window.shellApi.attachPty.mock.calls.length).toBe(attaches)
  })

  it('your choice stays for each pane during the session, also when the host switches its pane to chat mode and back', async () => {
    const status = (panes, chats) => ({ state: 'joined', host: 'Ada', session: 1, panes, layout: layoutOf(...chats.map((c) => leaf(c.id, c.terminal ? 'terminal' : 'chat'))), chat: true, chats })
    t.listeners.onGuest(status([agent('pane-ls1-a')], [chatOf('pane-ls1-a')]))
    await flush()
    t.ls.setGuestView('pane-ls1-a', 'chat')
    // The host's pane goes to chat mode: no terminal here, the chat kept.
    t.listeners.onGuest(status([], [chatOf('pane-ls1-a', false)]))
    await flush()
    const asChat = leafOf('pane-ls1-a')
    expect(asChat.liveShare).toMatchObject({ terminal: false, chat: 'shared', view: 'chat' })
    t.ls.setGuestView('pane-ls1-a', 'terminal')
    // Back to a terminal on the host: your last choice (its terminal).
    t.listeners.onGuest(status([agent('pane-ls1-a')], [chatOf('pane-ls1-a')]))
    await flush()
    const back = leafOf('pane-ls1-a')
    expect(back).not.toBe(asChat)
    expect(back.liveShare).toMatchObject({ terminal: true, view: 'terminal' })
    t.ls.setGuestView('pane-ls1-a', 'chat')
    t.listeners.onGuest(status([agent('pane-ls1-a')], [chatOf('pane-ls1-a')]))
    await flush()
    expect(leafOf('pane-ls1-a').liveShare.view).toBe('chat')
    expect(reachedHost()).toBe(false)
  })

  it('your text size for a host terminal: fit at first, yours only, kept for the session, forgotten after it', async () => {
    const status = (session = 1, ids = ['pane-ls1-ps', 'pane-ls1-b']) => ({ state: 'joined', host: 'Ada', session, panes: ids.map((id) => pane(id)), layout: layoutOf(...ids.map((id) => leaf(id))) })
    t.listeners.onGuest(status())
    await flush()
    const first = leafOf('pane-ls1-ps')
    expect(first.liveShare.textSize).toBe('fit')
    const attaches = window.shellApi.attachPty.mock.calls.length
    expect(t.ls.setGuestTextSize('pane-ls1-ps', 'normal')).toBe(true)
    expect(first.liveShare.textSize).toBe('normal')
    expect(t.ls.setGuestTextSize('pane-ls1-ps', 'width')).toBe(true)
    expect(first.liveShare.textSize).toBe('width')
    // Not a text size, or not a pane of the host's: nothing.
    expect(t.ls.setGuestTextSize('pane-ls1-ps', 'huge')).toBe(false)
    expect(t.ls.setGuestTextSize('pane-nope', 'fit')).toBe(false)
    expect(first.liveShare.textSize).toBe('width')
    // Nothing went to the host, nor to a terminal.
    expect(reachedHost()).toBe(false)
    expect(window.shellApi.attachPty.mock.calls.length).toBe(attaches)
    // The pane closed and opened again in the session: your choice.
    t.listeners.onGuest(status(1, ['pane-ls1-b']))
    await flush()
    expect(leafOf('pane-ls1-ps')).toBe(null)
    await flush()
    t.listeners.onGuest(status())
    await flush()
    const again = leafOf('pane-ls1-ps')
    expect(again).not.toBe(first)
    expect(again.liveShare.textSize).toBe('width')
    // A new session: fit again.
    t.listeners.onGuest({ state: 'ended', host: 'Ada', session: 1, panes: [], layout: null, reason: 'left' })
    await flush()
    t.listeners.onGuest(status(2))
    await flush()
    expect(leafOf('pane-ls1-ps').liveShare.textSize).toBe('fit')
  })

  it('a pane the host has in chat mode shows as a chat (no terminal attached)', async () => {
    t.listeners.onGuest({ state: 'joined', host: 'Ada', session: 1, panes: [pane('pane-ls1-ps')], layout: layoutOf(leaf('pane-ls1-ps'), leaf('pane-ls1-c', 'chat')), chat: true, chats: [chatOf('pane-ls1-c', false)] })
    await flush()
    const c = leafOf('pane-ls1-c')
    expect(c).toBeTruthy()
    expect(c.backend).toBe('liveshare')
    expect(c.liveShare).toMatchObject({ terminal: false, chat: 'shared', view: 'chat', canType: false, project: 'ws-a' })
    expect(window.shellApi.attachPty.mock.calls.map(([id]) => id)).toEqual(['pane-ls1-ps'])
  })

  it('a host whose Tessel does not share conversations: its agent panes still have the button (the chat view says why)', async () => {
    t.listeners.onGuest({ state: 'joined', host: 'Ada', session: 1, panes: [agent('pane-ls1-a'), pane('pane-ls1-ps')], layout: layoutOf(leaf('pane-ls1-a'), leaf('pane-ls1-ps')) })
    await flush()
    expect(leafOf('pane-ls1-a').liveShare.chat).toBe('old-host')
    expect(leafOf('pane-ls1-ps').liveShare.chat).toBe(null)
    expect(t.ls.setGuestView('pane-ls1-a', 'chat')).toBe(true)
    expect(reachedHost()).toBe(false)
  })

  it('an agent pane the host cannot send a conversation for has the button off, with the reason; it never opens', async () => {
    t.listeners.onGuest({ state: 'joined', host: 'Ada', session: 1, panes: [agent('pane-ls1-a', { agentId: 'antigravity' }), pane('pane-ls1-ps')], layout: layoutOf(leaf('pane-ls1-a'), leaf('pane-ls1-ps')), chat: true, chats: [{ ...chatOf('pane-ls1-a'), agentId: 'antigravity', reason: 'agent' }] })
    await flush()
    expect(leafOf('pane-ls1-a').liveShare).toMatchObject({ chat: 'unavailable', chatWhy: 'agent', view: 'terminal' })
    expect(leafOf('pane-ls1-ps').liveShare).toMatchObject({ chat: null, chatWhy: null })
    expect(t.ls.setGuestView('pane-ls1-a', 'chat')).toBe(false)
    expect(leafOf('pane-ls1-a').liveShare.view).toBe('terminal')
    expect(t.api.chatWatch).not.toHaveBeenCalled()
    expect(reachedHost()).toBe(false)
    // The host later has a conversation for it: the button turns on.
    t.listeners.onGuest({ state: 'joined', host: 'Ada', session: 1, panes: [agent('pane-ls1-a', { agentId: 'antigravity' })], layout: layoutOf(leaf('pane-ls1-a')), chat: true, chats: [chatOf('pane-ls1-a')] })
    await flush()
    expect(leafOf('pane-ls1-a').liveShare).toMatchObject({ chat: 'shared', chatWhy: null })
  })

  it('the chat view reads the host’s conversation through main, read only, for its own pane', async () => {
    t.listeners.onGuest({ state: 'joined', host: 'Ada', session: 1, panes: [agent('pane-ls1-a')], layout: layoutOf(leaf('pane-ls1-a')), chat: true, chats: [chatOf('pane-ls1-a')] })
    await flush()
    const source = t.ls.chatSource('pane-ls1-a')
    const events = []
    const off = source.onEvent((m) => events.push(m))
    t.last = { ok: true, events: [{ type: 'assistant', messageId: 'm1', text: 'hi' }], truncated: false }
    expect(await source.open({ agent: 'claude', sessionId: 'x' })).toEqual({ viewId: 'pane-ls1-a', ok: true, events: t.last.events, truncated: false, more: false, background: [] })
    expect(t.api.chatWatch).toHaveBeenCalledWith({ id: 'pane-ls1-a', on: true })
    t.listeners.onChat({ id: 'pane-ls1-other', ok: true, events: [] })
    t.listeners.onChat({ id: 'pane-ls1-a', ok: false, code: 'busy' })
    t.listeners.onChat({ id: 'pane-ls1-a', ok: true, events: [{ type: 'assistant', messageId: 'm2', text: 'more' }] })
    expect(events).toEqual([
      { viewId: 'pane-ls1-a', ok: false, code: 'closed' },
      { viewId: 'pane-ls1-a', ok: true, events: [{ type: 'assistant', messageId: 'm2', text: 'more' }], truncated: false, more: false, background: [] }
    ])
    source.close()
    await flush()
    expect(t.api.chatWatch).toHaveBeenLastCalledWith({ id: 'pane-ls1-a', on: false })
    off()
    // Nothing else went to the host.
    expect(reachedHost()).toBe(false)
  })
})

describe('Live Share, as the host: who is at which pane', () => {
  let t
  beforeEach(async () => {
    t = setup()
    await t.ls.init()
  })
  afterEach(() => {
    t.ls.dispose()
    vi.useRealTimers()
  })
  const guests = [
    { id: 'g1', name: 'Alex', state: 'joined' },
    { id: 'g2', name: '', state: 'joined' },
    { id: 'g3', name: 'Cy', state: 'waiting' }
  ]

  it('names the guests reading a pane’s conversation now, only while sharing (from presence)', () => {
    expect(t.ls.readersOf('pane-1')).toEqual([])
    const reading = (id) => ({ id, watching: false, typing: false, reading: true })
    t.listeners.onHost({ state: 'sharing', projectIds: ['ws-1'], guests, presence: [{ id: 'pane-1', guests: [reading('g1'), reading('g2'), reading('g3')] }] })
    expect(t.ls.readersOf('pane-1')).toEqual(['Alex', 'A guest'])
    expect(t.ls.readersOf('pane-2')).toEqual([])
    t.listeners.onHost({ state: 'sharing', projectIds: ['ws-1'], guests: [{ id: 'g1', name: 'Alex', state: 'joined' }] })
    expect(t.ls.readersOf('pane-1')).toEqual([])
    t.listeners.onHost({ state: 'off', guests: [], presence: [{ id: 'pane-1', guests: [reading('g1')] }] })
    expect(t.ls.readersOf('pane-1')).toEqual([])
  })

  it('watching and typing, with initials, from the presence pushes', () => {
    t.listeners.onHost({ state: 'sharing', projectIds: ['ws-1'], guests })
    t.listeners.onPresence([{ id: 'pane-1', guests: [{ id: 'g1', watching: true, typing: true, reading: false }, { id: 'g9', watching: true, typing: false, reading: false }] }])
    expect(t.ls.presenceOf('pane-1')).toEqual([{ id: 'g1', name: 'Alex', initials: 'AL', watching: true, typing: true, reading: false }])
    // Main says the typing ended.
    t.listeners.onPresence([{ id: 'pane-1', guests: [{ id: 'g1', watching: true, typing: false, reading: false }] }])
    expect(t.ls.presenceOf('pane-1')[0].typing).toBe(false)
    t.listeners.onPresence([])
    expect(t.ls.presenceOf('pane-1')).toEqual([])
  })

  it('a typing mark main never ended goes after a few seconds', () => {
    vi.useFakeTimers()
    t.listeners.onHost({ state: 'sharing', projectIds: ['ws-1'], guests })
    t.listeners.onPresence([{ id: 'pane-1', guests: [{ id: 'g1', watching: false, typing: true, reading: false }] }])
    expect(t.ls.presenceOf('pane-1')).toHaveLength(1)
    const tick = t.ls.state.presenceTick
    vi.advanceTimersByTime(13000)
    expect(t.ls.state.presenceTick).toBe(tick + 1)
    expect(t.ls.presenceOf('pane-1')).toEqual([])
  })
})

describe('Live Share, as a guest: asking the host to open, and what is on screen', () => {
  let t
  beforeEach(async () => {
    t = setup()
    await t.ls.init()
  })
  afterEach(() => t.ls.dispose())
  const joined = (extra = {}) => t.listeners.onGuest({ state: 'joined', host: 'Ada', session: 1, panes: [pane('pane-ls1-a')], layout: { project: 'x', tree: leaf('pane-ls1-a'), activeId: null, maximizedId: null }, rights: NO, agents: [{ id: 'claude', name: 'Claude Code' }], ...extra })

  it('a host that lists its agents: the "+" menu offers them, and without the right the host is asked', async () => {
    joined()
    await flush()
    const ws = t.workspaces.value[0]
    expect(t.ls.hostMenu(ws)).toEqual({ host: 'Ada', agents: [{ id: 'claude', name: 'Claude Code' }], canOpen: false })
    t.api.open.mockResolvedValue({ ok: true, asked: true })
    await t.ls.openOnHost({ kind: 'agent', agent: 'claude' }, ws)
    expect(t.api.open).toHaveBeenCalledWith({ kind: 'agent', agent: 'claude', project: 'ws-a' })
    expect(t.toasts.at(-1)).toBe('Asked Ada to open it: it opens once they say yes.')
    t.api.open.mockResolvedValue({ ok: false, reason: 'agent' })
    await t.ls.openOnHost({ kind: 'agent', agent: 'gone' }, ws)
    expect(t.toasts.at(-1)).toBe('Ada does not have that agent.')
    t.listeners.onNotice({ code: 'agent' })
    expect(t.toasts.at(-1)).toBe('Ada does not have that agent.')
    // With the right: opened at once.
    joined({ rights: { ...NO_RIGHTS, type: false, open: true, close: false } })
    await flush()
    expect(t.ls.hostMenu(ws).canOpen).toBe(true)
    t.api.open.mockResolvedValue({ ok: true, asked: false })
    await t.ls.openOnHost({ kind: 'terminal' }, ws)
    expect(t.toasts.at(-1)).toBe('Opening it on Ada’s computer…')
  })

  it('a host from before that list: no host menu, and nothing asked without the right', async () => {
    joined({ agents: null })
    await flush()
    const ws = t.workspaces.value[0]
    expect(t.ls.hostMenu(ws)).toBe(null)
    await t.ls.openOnHost({ kind: 'terminal' }, ws)
    expect(t.api.open).not.toHaveBeenCalled()
    expect(t.toasts.at(-1)).toMatch(/has not let you open/)
  })

  it('says which of the host’s panes is on screen; none on a project of yours', async () => {
    const mine = reactive({ id: 'ws-mine', name: 'mine', tree: { type: 'leaf', id: 'pane-1', kind: 'shell' }, activeId: 'pane-1' })
    t.workspaces.value.push(mine)
    joined()
    await flush()
    const ws = t.workspaces.value.find((w) => w.liveShare)
    t.currentWsId.value = ws.id
    t.activePane.value = 'pane-ls1-a'
    await flush()
    expect(t.api.focus).toHaveBeenLastCalledWith('pane-ls1-a')
    t.currentWsId.value = 'ws-mine'
    t.activePane.value = 'pane-1'
    await flush()
    expect(t.api.focus).toHaveBeenLastCalledWith(null)
  })
})

// Your screen follows the host's in its project (its tab, its active pane,
// its editor file, the task copy it looks at) until you pick something
// yourself; "Follow host" takes it up again. The host's editor tabs are a
// tab here, its files through your access to the project's (lshare://);
// closing one only hides it on your screen.
describe('Live Share in the window, as a guest: following the host', () => {
  let t
  beforeEach(async () => {
    t = setup()
    t.api.subscribe = vi.fn(async () => ({ ok: true }))
    t.api.onPush = (cb) => {
      t.listeners.onPush = cb
      return () => delete t.listeners.onPush
    }
    await t.ls.init()
  })
  afterEach(() => t.ls.dispose())

  const tree = { type: 'split', dir: 'row', sizes: [40, 40, 20], children: [leaf('pane-ls1-a'), leaf('pane-ls1-b'), leaf('pane-ls1-ed', 'editor')] }
  const status = (layout = {}) => ({
    state: 'joined',
    host: 'Ada',
    session: 1,
    panes: [pane('pane-ls1-a'), pane('pane-ls1-b')],
    layout: { project: 'site', tree, activeId: 'pane-ls1-a', maximizedId: null, shown: 'terminal', copy: null, ...layout },
    rights: { ...NO_RIGHTS },
    features: ['files', 'tabs', 'links']
  })
  const tabs = (list, active = null) => t.listeners.onPush({ topic: 'tabs', project: 'ws-a', data: { tabs: list, active } })
  const ws = () => t.workspaces.value[0]
  const tabsLeaf = () => {
    let found = null
    const walk = (n) => {
      if (!n || found) return
      if (n.type === 'leaf') n.liveShare && n.liveShare.hostTabs && (found = n)
      else n.children.forEach(walk)
    }
    walk(ws().tree)
    return found
  }

  it("follows the host's active pane and tab switches (terminal, an editor tab) live", async () => {
    t.listeners.onGuest(status())
    await flush()
    expect(ws().activeId).toBe('pane-ls1-a')
    t.listeners.onGuest(status({ activeId: 'pane-ls1-b' }))
    await flush()
    expect(ws().activeId).toBe('pane-ls1-b')
    // The host's editor tabs: one tab here, its files read through lshare://.
    tabs(['src/app.js', 'README.md'], 'README.md')
    await flush()
    const lt = tabsLeaf()
    expect(lt).toMatchObject({ kind: 'editor', backend: 'liveshare', files: [{ path: 'lshare://ws-a\\src\\app.js' }, { path: 'lshare://ws-a\\README.md' }] })
    expect(t.ls.isHostTab(lt)).toBe(true)
    // The host shows its editor, on README.md: here too.
    t.listeners.onGuest(status({ activeId: 'pane-ls1-b', shown: 'pane-ls1-ed' }))
    await flush()
    expect(ws().activeId).toBe(lt.id)
    expect(ws().view).toBe(lt.id)
    expect(lt.activePath).toBe('lshare://ws-a\\README.md')
    tabs(['src/app.js', 'README.md'], 'src/app.js')
    await flush()
    expect(lt.activePath).toBe('lshare://ws-a\\src\\app.js')
    // Back to its terminals.
    t.listeners.onGuest(status({ activeId: 'pane-ls1-a', shown: 'terminal' }))
    await flush()
    expect(ws().activeId).toBe('pane-ls1-a')
    expect(ws().view).toBe('terminal')
    expect(t.ls.followInfo()).toEqual({ on: true, copy: null })
  })

  it("stops when you pick something yourself; Follow host takes it up again", async () => {
    t.listeners.onGuest(status())
    await flush()
    ws().activeId = 'pane-ls1-b'
    await flush()
    expect(t.ls.followInfo().on).toBe(false)
    t.listeners.onGuest(status({ activeId: 'pane-ls1-a' }))
    await flush()
    expect(ws().activeId).toBe('pane-ls1-b')
    expect(t.ls.followHost()).toBe(true)
    expect(t.ls.followInfo().on).toBe(true)
    expect(ws().activeId).toBe('pane-ls1-a')
    // Another editor file picked by you: your own pick too.
    tabs(['a.js', 'b.js'], 'a.js')
    t.listeners.onGuest(status({ shown: 'pane-ls1-ed' }))
    await flush()
    tabsLeaf().activePath = 'lshare://ws-a\\b.js'
    await flush()
    expect(t.ls.followInfo().on).toBe(false)
  })

  it("the host's editor tabs: a tab the host closes goes; one you close is only hidden here; none left, no tab", async () => {
    t.listeners.onGuest(status())
    await flush()
    tabs(['a.js', 'b.js', 'c.js'])
    await flush()
    const lt = tabsLeaf()
    tabs(['a.js', 'c.js'])
    await flush()
    expect(lt.files.map((f) => f.path)).toEqual(['lshare://ws-a\\a.js', 'lshare://ws-a\\c.js'])
    // You close c.js (the editor's own close): hidden from now on.
    lt.files = lt.files.filter((f) => !f.path.endsWith('c.js'))
    tabs(['a.js', 'c.js', 'd.js'])
    await flush()
    expect(lt.files.map((f) => f.path)).toEqual(['lshare://ws-a\\a.js', 'lshare://ws-a\\d.js'])
    // Its whole tab closed here: hidden, never closed on the host.
    expect(t.ls.hideHostTab(lt.id)).toBe(true)
    expect(tabsLeaf()).toBe(null)
    expect(t.deps.closeLeaf).not.toHaveBeenCalled()
    // Follow host: the tabs you hid are back.
    t.ls.followHost()
    expect(tabsLeaf().files.map((f) => f.path)).toEqual(['lshare://ws-a\\a.js', 'lshare://ws-a\\c.js', 'lshare://ws-a\\d.js'])
    tabs([])
    await flush()
    expect(tabsLeaf()).toBe(null)
  })

  it('says which task copy the host looks at', async () => {
    t.listeners.onGuest(status({ copy: 'tessel/fix-login' }))
    await flush()
    expect(t.ls.followInfo()).toEqual({ on: true, copy: 'tessel/fix-login' })
  })
})
