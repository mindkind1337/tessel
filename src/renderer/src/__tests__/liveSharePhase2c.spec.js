// Live Share phase 2c in the window (liveShareWindowFeeds.js through
// liveShareWindow.js, LiveSharePageView.vue, SessionHistoryPanel.vue,
// ConversationsPanel.vue, BrowserPane.vue, browser/pageHost.js). Host: the
// browser panes of the shared projects (and the side panel's pages while a
// shared project is on screen) go to main with their page and the host's
// "hide" (never another project's, never one without a page yet); the
// activity goes only while guests follow it. Guest: the host's pages are
// links, shown only with "See my browser pages": each one your own browser
// on its address, following the host's page (a new address, its videos)
// until you go elsewhere ("Follow host" brings it back); an address only the
// host's side opens is a note with the address to copy, never opened; the
// Agents tab and the Conversations tab of a host's project read the host's,
// read only.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { reactive, ref, nextTick, watch } from 'vue'
import { mount, flushPromises, config } from '@vue/test-utils'
import { createLiveShareWindow } from '../liveShareWindow'
import { buildGuestTree } from '../liveShareLayout'
import { workspaceViews } from '../paneViews'
import { pageGuests, notePageGuest, claimPage, destroyPage, createWebview, GUEST_PARTITION, MAIN_PARTITION, AGENT_PARTITION } from '../browser/pageHost'
import { NO_RIGHTS } from '../../../shared/liveShareRights'
import { sidePageFromLeaf, leafFromSidePage, saveSideBrowsers, restoreSideBrowsers } from '../browser/pageMove'
import LiveSharePageView from '../components/LiveSharePageView.vue'
import SessionHistoryPanel from '../components/SessionHistoryPanel.vue'
import ConversationsPanel from '../components/ConversationsPanel.vue'

config.global.stubs.transition = false

const design = vi.hoisted(() => ({}))
vi.mock('../components/DesignModePanel.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      name: 'DesignModePanel',
      props: { guestId: { type: Number, default: null }, pageUrl: String, pageTitle: String, paneId: String },
      emits: ['active'],
      setup(_props, { expose }) {
        expose({ toggle() {}, stop() {}, screenshot() {}, isActive: () => false })
        return () => h('div', { class: 'dm-stub' })
      }
    })
  }
})
import BrowserPane from '../components/BrowserPane.vue'
void design

const flush = async () => {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('a page moved through the side panel keeps its session and its hide', () => {
  const makeLeaf = (url) => ({ type: 'leaf', kind: 'browser', id: 'pane-new', url: url || 'about:blank', openedBy: 'agent' })
  it('the guest session, the agents\u2019 and "Hide this page from guests" go to the panel, are saved, and come back', () => {
    const page = sidePageFromLeaf({ url: 'https://a.test/', title: 'A', guestSession: true, hiddenFromGuests: true }, 'web-1')
    expect(page).toMatchObject({ id: 'web-1', guestSession: true, hiddenFromGuests: true })
    const saved = restoreSideBrowsers(JSON.parse(JSON.stringify(saveSideBrowsers([page, sidePageFromLeaf({ url: 'https://b.test/', agentSession: true }, 'web-2')]))))
    expect(saved[0]).toMatchObject({ guestSession: true, hiddenFromGuests: true })
    expect(saved[1]).toMatchObject({ agentSession: true, hiddenFromGuests: false })
    expect(saved[1].guestSession).toBeUndefined()
    const back = leafFromSidePage(saved[0], makeLeaf)
    expect(back).toMatchObject({ guestSession: true, hiddenFromGuests: true })
    const agent = leafFromSidePage(saved[1], makeLeaf, { hiddenDefault: true })
    expect(agent.agentSession).toBe(true)
    // Known visible: stays visible, whatever the default.
    expect(agent.hiddenFromGuests).toBeUndefined()
  })
  it('a panel page that never was a pane comes back hidden while its project is shared', () => {
    const page = restoreSideBrowsers([{ id: 'web-3', url: 'https://c.test/' }])[0]
    expect(leafFromSidePage(page, makeLeaf, { hiddenDefault: true }).hiddenFromGuests).toBe(true)
    expect(leafFromSidePage(page, makeLeaf, { hiddenDefault: false }).hiddenFromGuests).toBeUndefined()
  })
})

describe('the guest tree and the page host', () => {
  it('keeps the host browser panes only with "See my browser pages"', () => {
    const layout = { tree: { type: 'split', dir: 'row', sizes: [50, 50], children: [{ type: 'leaf', id: 't1', view: 'terminal' }, { type: 'leaf', id: 'w1', view: 'browser' }] } }
    const getLeaf = (l) => ({ type: 'leaf', id: l.id })
    expect(buildGuestTree(layout, getLeaf)).toEqual({ type: 'leaf', id: 't1' })
    const both = buildGuestTree(layout, getLeaf, { pages: true })
    expect(both.children.map((c) => c.id)).toEqual(['t1', 'w1'])
  })

  it('knows each pane page (reactive) and makes the guest session page', () => {
    const host = document.createElement('div')
    claimPage('pane-x', host, 'about:blank')
    notePageGuest('pane-x', 77)
    expect(pageGuests['pane-x']).toBe(77)
    destroyPage('pane-x')
    expect(pageGuests['pane-x']).toBeUndefined()
    expect(createWebview('about:blank', GUEST_PARTITION).getAttribute('partition')).toBe('tessel-browser-guest')
    expect(createWebview('about:blank', AGENT_PARTITION).getAttribute('partition')).toBe(AGENT_PARTITION)
    expect(createWebview('about:blank', 'persist:other').getAttribute('partition')).toBe(MAIN_PARTITION)
  })
})

// --- The window ---------------------------------------------------------------------
function setup() {
  const listeners = {}
  const api = {
    state: vi.fn(async () => ({ host: { state: 'off', guests: [] }, guest: { state: 'off', panes: [], projects: [] }, defaultName: 'ada' })),
    setLayouts: vi.fn(),
    setAgents: vi.fn(),
    setTasks: vi.fn(),
    setPages: vi.fn(),
    setActivity: vi.fn(),
    subscribe: vi.fn(async () => ({ ok: true })),
    sessions: vi.fn(async () => ({ ok: true, sessions: [] })),
    share: vi.fn(async () => ({ ok: true })),
    focus: vi.fn(),
    requestDone: vi.fn()
  }
  for (const name of ['onHost', 'onGuest', 'onAsk', 'onHostRequest', 'onNotice', 'onPresence', 'onInviteBlocked', 'onGuestAction', 'onPush', 'onFeeds']) {
    api[name] = (cb) => {
      listeners[name] = cb
      return () => delete listeners[name]
    }
  }
  window.shellApi = { liveShare: api, attachPty: vi.fn(async () => ({ ok: true, buffer: '', shell: { name: 'Ada' } })) }
  const workspaces = ref([])
  const currentWsId = ref(null)
  const pages = reactive({})
  const log = reactive([])
  const side = ref([])
  let made = 0
  const findLeaf = (id) => {
    let found = null
    const walk = (n) => {
      if (!n || found) return
      if (n.type === 'leaf') {
        if (n.id === id) found = n
      } else (n.children || []).forEach(walk)
    }
    workspaces.value.forEach((w) => walk(w.tree))
    return found
  }
  const deps = {
    workspaces: () => workspaces.value,
    currentWs: () => workspaces.value.find((w) => w.id === currentWsId.value) || null,
    currentWsId: () => currentWsId.value,
    maximizedId: () => null,
    setMaximized: () => {},
    makeWorkspace: (name) => reactive({ id: `ws-${++made + 100}`, name, tree: null, activeId: null, cwd: null }),
    selectWorkspace: (id) => (currentWsId.value = id),
    removeWorkspace: vi.fn((id) => (workspaces.value = workspaces.value.filter((w) => w.id !== id))),
    findLeaf,
    closeLeaf: vi.fn(),
    launch: vi.fn(),
    selectedShell: () => 'pwsh',
    seedBuffer: () => {},
    dropBuffer: () => {},
    showToast: () => {},
    isAgentLeaf: () => false,
    probeRunningWork: vi.fn(async () => ({ running: false, unknown: false, names: [] })),
    killPty: vi.fn(),
    adoptLeaves: vi.fn(),
    hasAgent: () => true,
    layoutReady: () => true,
    pageGuest: (id) => (Number.isSafeInteger(pages[id]) ? pages[id] : null),
    activityOf: (wsId) => ({ events: log.filter((e) => e.wsId === wsId), teams: [{ id: 'team-1', name: 'Builders', color: '#00ff00' }] }),
    activityRev: () => log.length,
    sidePages: () => side.value
  }
  const ls = createLiveShareWindow(deps)
  return { ls, api, listeners, workspaces, currentWsId, pages, log, side }
}
const browser = (id, extra = {}) => reactive({ type: 'leaf', id, kind: 'browser', url: 'https://a.test/', ...extra })
const shell = (id) => reactive({ type: 'leaf', id, kind: 'shell' })
const sharing = (extra = {}) => ({ state: 'sharing', projectIds: ['ws-1'], invites: [], guests: [{ id: 'g1', name: 'Ana', state: 'joined', rights: { ...NO_RIGHTS, pagesView: true }, projects: ['ws-1'] }], offline: [], trusted: [], presence: [], settings: { hideIgnored: true }, actions: [], ...extra })

describe('Live Share phase 2c in the window, as the host', () => {
  let t
  afterEach(() => t.ls.dispose())

  async function host() {
    t = setup()
    await t.ls.init()
    t.workspaces.value.push(
      reactive({ id: 'ws-1', name: 'site', cwd: 'C:\\site', activeId: null, tree: reactive({ type: 'split', dir: 'row', sizes: [50, 25, 25], children: [shell('p1'), browser('b1'), browser('b2')] }) }),
      reactive({ id: 'ws-2', name: 'other', cwd: 'C:\\other', activeId: null, tree: browser('b9') })
    )
    t.pages.b1 = 11
    t.pages.b9 = 19
    t.listeners.onHost(sharing())
    await flush()
  }

  it('sends the shared projects browser panes with their page and the host "hide", again when they change', async () => {
    await host()
    // b2 has no page yet; b9 is another project's.
    expect(t.api.setPages).toHaveBeenLastCalledWith([{ project: 'ws-1', paneId: 'b1', webContentsId: 11, hidden: false }])
    t.pages.b2 = 12
    await flush()
    expect(t.api.setPages.mock.calls.at(-1)[0].map((p) => p.paneId)).toEqual(['b1', 'b2'])
    // Hidden by the host: said to main, shown on the page.
    // Guests get its address now (Ana, in, sees its project with the right): said on it.
    expect(t.ls.pageShare('b1')).toEqual({ project: 'ws-1', side: false, hidden: false, shared: true, sent: true })
    expect(t.ls.pageShare('b9')).toBe(null)
    expect(t.ls.setPageHidden('b1', true)).toBe(true)
    await flush()
    expect(t.api.setPages.mock.calls.at(-1)[0][0]).toEqual({ project: 'ws-1', paneId: 'b1', webContentsId: 11, hidden: true })
    expect(t.ls.pageShare('b1')).toMatchObject({ hidden: true, sent: false })
    expect(t.ls.setPageHidden('p1', true)).toBe(false)
    // Nobody in with the right: nothing is sent, nothing said.
    t.ls.setPageHidden('b1', false)
    t.listeners.onHost(sharing({ guests: [{ id: 'g1', name: 'Ana', state: 'joined', rights: { ...NO_RIGHTS }, projects: ['ws-1'] }] }))
    await flush()
    expect(t.ls.pageShare('b1').sent).toBe(false)
  })

  it('a side panel page is never sent unless the host shares it, and then only with the shared project on screen', async () => {
    await host()
    t.side.value = [reactive({ id: 'web-side1', url: 'https://bank.example.com/', hiddenFromGuests: false })]
    t.pages['web-side1'] = 21
    t.currentWsId.value = 'ws-1'
    await flush()
    // Not shared by the host (whatever an old "hide" said): not sent.
    expect(t.api.setPages.mock.calls.at(-1)[0].some((p) => p.paneId === 'web-side1')).toBe(false)
    expect(t.ls.pageShare('web-side1')).toEqual({ project: 'ws-1', side: true, hidden: true, shared: false, sent: false })
    expect(t.ls.setPageShared('web-side1', true)).toBe(true)
    await flush()
    expect(t.api.setPages.mock.calls.at(-1)[0].find((p) => p.paneId === 'web-side1')).toEqual({ project: 'ws-1', paneId: 'web-side1', webContentsId: 21, hidden: false, side: true, optIn: true })
    expect(t.ls.pageShare('web-side1')).toMatchObject({ shared: true, sent: true })
    // Another project on screen (not shared): the panel's pages are not sent.
    t.currentWsId.value = 'ws-2'
    await flush()
    expect(t.api.setPages.mock.calls.at(-1)[0].some((p) => p.paneId === 'web-side1')).toBe(false)
    t.currentWsId.value = 'ws-1'
    expect(t.ls.setPageShared('web-side1', false)).toBe(true)
    await flush()
    expect(t.api.setPages.mock.calls.at(-1)[0].some((p) => p.paneId === 'web-side1')).toBe(false)
  })

  it('sends a project activity only while guests follow it, at most every 2 s', async () => {
    vi.useFakeTimers()
    try {
      await host()
      t.log.push({ t: 1, type: 'task', wsId: 'ws-1' }, { t: 2, type: 'task', wsId: 'ws-2' })
      await flush()
      await vi.advanceTimersByTimeAsync(3000)
      expect(t.api.setActivity).not.toHaveBeenCalled()
      t.listeners.onFeeds({ activity: ['ws-1', 'ws-9'] })
      await flush()
      await vi.advanceTimersByTimeAsync(50)
      expect(t.api.setActivity).toHaveBeenCalledTimes(1)
      expect(t.api.setActivity).toHaveBeenLastCalledWith([{ project: 'ws-1', events: [{ t: 1, type: 'task', wsId: 'ws-1' }], teams: [{ id: 'team-1', name: 'Builders', color: '#00ff00' }] }])
      t.log.push({ t: 3, type: 'task', wsId: 'ws-1' })
      await flush()
      t.log.push({ t: 4, type: 'task', wsId: 'ws-1' })
      await flush()
      expect(t.api.setActivity).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(2100)
      expect(t.api.setActivity).toHaveBeenCalledTimes(2)
      expect(t.api.setActivity.mock.calls[1][0][0].events).toHaveLength(3)
      t.listeners.onFeeds({ activity: [] })
      t.log.push({ t: 5, type: 'task', wsId: 'ws-1' })
      await flush()
      await vi.advanceTimersByTimeAsync(3000)
      expect(t.api.setActivity).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('Live Share phase 2c in the window, as a guest', () => {
  let t
  beforeEach(async () => {
    t = setup()
    await t.ls.init()
  })
  afterEach(() => t.ls.dispose())
  const layout = { project: 'site', tree: { type: 'split', dir: 'row', sizes: [50, 50], children: [{ type: 'leaf', id: 'pane-ls1-t', view: 'terminal', title: 't', kind: 'shell' }, { type: 'leaf', id: 'pane-ls1-web', view: 'browser', title: '' }] }, activeId: null }
  const joined = (rights = {}, extra = {}) => ({ state: 'joined', host: 'Cedric', session: 1, panes: [], projects: [{ id: 'ws-1', layout }], rights: { ...NO_RIGHTS, ...rights }, features: ['chat', 'files', 'scm', 'tasks', 'history', 'tabs', 'links'], ...extra })
  const links = (pages) => t.listeners.onPush({ topic: 'links', project: 'ws-1', data: { pages } })
  const web = (extra = {}) => ({ id: 'pane-ls1-web', url: 'https://mail.example/inbox', local: false, title: 'Inbox', side: false, ...extra })
  const lsWs = () => t.workspaces.value.find((w) => w.liveShare)
  const leaves = (n, out = []) => {
    if (!n) return out
    if (n.type === 'leaf') out.push(n)
    else n.children.forEach((c) => leaves(c, out))
    return out
  }

  it('shows the host pages only with "See my browser pages", in a view session of their own, a new site after one click', async () => {
    t.listeners.onGuest(joined())
    await flush()
    links([web()])
    await flush()
    expect(leaves(lsWs().tree).some((l) => l.id === 'pane-ls1-web')).toBe(false)
    t.listeners.onGuest(joined({ pagesView: true }))
    await flush()
    links([web()])
    await flush()
    const page = leaves(lsWs().tree).find((l) => l.id === 'pane-ls1-web')
    // A browser of this computer in a session of its own (never your
    // signed-in one), blank until you open the host's site.
    expect(page).toMatchObject({ kind: 'browser', url: 'about:blank', viewPartition: 'liveshare-view-1', backend: 'liveshare', liveShare: { link: true, following: true, project: 'ws-1', host: 'Cedric', pendingUrl: 'https://mail.example/inbox' } })
    expect(t.ls.approvePage('pane-ls1-web')).toBe(true)
    expect(page.url).toBe('https://mail.example/inbox')
    expect(page.liveShare.pendingUrl).toBe('')
    // A page the host hid (or never sent): no tab.
    links([])
    await flush()
    expect(leaves(lsWs().tree).some((l) => l.id === 'pane-ls1-web')).toBe(false)
    links([web()])
    await flush()
    // The right taken away: the page goes.
    t.listeners.onGuest(joined())
    await flush()
    expect(leaves(lsWs().tree).some((l) => l.id === 'pane-ls1-web')).toBe(false)
  })

  it('follows the host page (paced; a new site asks first) until you go elsewhere; "Follow host" brings it back', async () => {
    vi.useFakeTimers()
    try {
      t.listeners.onGuest(joined({ pagesView: true }))
      await flush()
      links([web()])
      await flush()
      const page = () => leaves(lsWs().tree).find((l) => l.id === 'pane-ls1-web')
      const leaf = page()
      t.ls.approvePage('pane-ls1-web')
      // The same site: followed, but at least a second apart.
      links([web({ url: 'https://mail.example/inbox/2', title: 'Second', media: [{ kind: 'video', i: 0, paused: false, ended: false, t: 12, rate: 1 }] })])
      await flush()
      expect(page()).toBe(leaf)
      expect(leaf.url).toBe('https://mail.example/inbox')
      await vi.advanceTimersByTimeAsync(1100)
      expect(leaf.url).toBe('https://mail.example/inbox/2')
      links([web({ url: 'https://mail.example/inbox/2', media: [{ kind: 'video', i: 0, paused: false, ended: false, t: 12, rate: 1 }] })])
      await flush()
      expect(leaf.liveShare.media).toMatchObject({ items: [{ kind: 'video', i: 0, paused: false, t: 12 }] })
      // Another site: not opened before your click.
      await vi.advanceTimersByTimeAsync(1100)
      links([web({ url: 'https://other.example.com/x' })])
      await flush()
      expect(leaf.url).toBe('https://mail.example/inbox/2')
      expect(leaf.liveShare.pendingUrl).toBe('https://other.example.com/x')
      t.ls.approvePage('pane-ls1-web')
      expect(leaf.url).toBe('https://other.example.com/x')
      // You went elsewhere yourself (well after following loaded it): not following.
      await vi.advanceTimersByTimeAsync(61000)
      leaf.url = 'https://other.example.com/mine'
      await flush()
      expect(leaf.liveShare.following).toBe(false)
      const at = leaf.url
      links([web({ url: 'https://other.example.com/next' })])
      await flush()
      await vi.advanceTimersByTimeAsync(2000)
      expect(leaf.url).toBe(at)
      expect(t.ls.followPage('pane-ls1-web')).toBe(true)
      expect(leaf.liveShare.following).toBe(true)
      await vi.advanceTimersByTimeAsync(2000)
      expect(leaf.url).toBe('https://other.example.com/next')
    } finally {
      vi.useRealTimers()
    }
  })

  it('followed navigations: 30 a minute at most', async () => {
    vi.useFakeTimers()
    try {
      t.listeners.onGuest(joined({ pagesView: true }))
      await flush()
      links([web()])
      await flush()
      const leaf = leaves(lsWs().tree).find((l) => l.id === 'pane-ls1-web')
      t.ls.approvePage('pane-ls1-web')
      const urls = []
      const stop = watch(() => leaf.url, (u) => urls.push(u))
      for (let i = 0; i < 50; i++) {
        links([web({ url: `https://mail.example/p${i}` })])
        await flush()
        await vi.advanceTimersByTimeAsync(1001)
      }
      stop()
      // 50 s, one a second at most, and the first minute holds 30 (the one
      // approved included).
      expect(urls.length).toBeLessThanOrEqual(30)
      expect(urls.length).toBeGreaterThan(20)
    } finally {
      vi.useRealTimers()
    }
  })

  it('an address only the host side opens is a note with the address, never a page', async () => {
    t.listeners.onGuest(joined({ pagesView: true }))
    await flush()
    links([web({ url: 'http://localhost:5173/app', local: true, title: 'Dev' })])
    await flush()
    const page = leaves(lsWs().tree).find((l) => l.id === 'pane-ls1-web')
    expect(page).toMatchObject({ kind: 'shell', liveShare: { page: true, link: true, local: true } })
    expect(page.url).toBeUndefined()
    expect(t.ls.pageNote('pane-ls1-web')).toEqual({ host: 'Cedric', url: 'http://localhost:5173/app', title: 'Dev', ended: false })
    // The host goes to a public address: your browser on it.
    links([web({ url: 'https://example.com/' })])
    await flush()
    expect(leaves(lsWs().tree).find((l) => l.id === 'pane-ls1-web')).toMatchObject({ kind: 'browser', url: 'about:blank', liveShare: { pendingUrl: 'https://example.com/' } })
  })

  it('the side panel pages of the host are tabs too; closing a host tab only hides it here', async () => {
    t.listeners.onGuest(joined({ pagesView: true }))
    await flush()
    links([web(), { id: 'pane-ls1-web-side1', url: 'https://docs.test/a', local: false, title: 'Docs', side: true }])
    await flush()
    const [view] = workspaceViews(lsWs())
    expect(view.tabs.map((l) => l.id)).toEqual(['pane-ls1-web', 'pane-ls1-web-side1'])
    expect(t.ls.isHostTab(view.tabs[1])).toBe(true)
    expect(t.ls.hideHostTab('pane-ls1-web-side1')).toBe(true)
    expect(workspaceViews(lsWs())[0].tabs.map((l) => l.id)).toEqual(['pane-ls1-web'])
    links([web(), { id: 'pane-ls1-web-side1', url: 'https://docs.test/b', local: false, title: 'Docs', side: true }])
    await flush()
    expect(workspaceViews(lsWs())[0].tabs.map((l) => l.id)).toEqual(['pane-ls1-web'])
    // "Follow host": everything of that project back.
    t.currentWsId.value = lsWs().id
    expect(t.ls.followHost()).toBe(true)
    expect(workspaceViews(lsWs())[0].tabs.map((l) => l.id)).toEqual(['pane-ls1-web', 'pane-ls1-web-side1'])
  })

  // 2026-10-19: the host's page showed inside the guest's grid, beside the
  // terminals ("about:blank" pane), where the host has it as a tab.
  it('the host browser page is a tab of its own, as on the host, never a pane of the grid', async () => {
    t.listeners.onGuest(joined({ pagesView: true }))
    await flush()
    links([web()])
    await flush()
    const [view] = workspaceViews(lsWs())
    expect(view.tabs.map((l) => l.id)).toEqual(['pane-ls1-web'])
    // (No terminal attached in this test: the grid holds none of the pages.)
    expect(leaves(view.grid).map((l) => l.id)).not.toContain('pane-ls1-web')
    expect(view.shown).toBe('terminal')
    // The host shows its page: that tab comes up here too.
    t.listeners.onGuest(joined({ pagesView: true }, { projects: [{ id: 'ws-1', layout: { ...layout, shown: 'pane-ls1-web' } }] }))
    await flush()
    const ws = lsWs()
    expect(ws.activeId).toBe('pane-ls1-web')
    expect(workspaceViews(ws)[0].shown).toBe('pane-ls1-web')
  })

  it('reads the host past conversations and follows its activity while shown', async () => {
    t.listeners.onGuest(joined())
    await flush()
    const h = t.ls.sessionSource('ws-1')
    expect(h).toMatchObject({ project: 'ws-1', host: 'Cedric', state: 'ok' })
    await h.list({ limit: 40 })
    expect(t.api.sessions).toHaveBeenLastCalledWith({ op: 'list', project: 'ws-1', args: { limit: 40 } })
    await h.details('r'.repeat(22))
    expect(t.api.sessions).toHaveBeenLastCalledWith({ op: 'details', project: 'ws-1', args: { ref: 'r'.repeat(22) } })
    expect(t.ls.sessionSource('ws-9').state).toBe('no-access')
    const a = t.ls.activitySource('ws-1')
    a.follow(true)
    a.follow(true)
    await flush()
    // Once for two followers (the board's own subscription aside).
    expect(t.api.subscribe.mock.calls.filter(([q]) => q.topic === 'activity')).toEqual([[{ topic: 'activity', project: 'ws-1', on: true }]])
    t.listeners.onPush({ topic: 'activity', project: 'ws-1', data: { events: [{ t: 1, type: 'task', wsId: 'ws-1' }], teams: [] } })
    await flush()
    const got = t.ls.activitySource('ws-1')
    expect(got.loaded).toBe(true)
    expect(got.events).toEqual([{ t: 1, type: 'task', wsId: lsWs().id }])
    a.follow(false)
    await flush()
    expect(t.api.subscribe.mock.calls.filter(([q]) => q.topic === 'activity' && q.on === false)).toHaveLength(0)
    a.follow(false)
    await flush()
    expect(t.api.subscribe).toHaveBeenLastCalledWith({ topic: 'activity', project: 'ws-1', on: false })
    await t.ls.activitySource('ws-1').terminal({ from: 5, known: { p: 'k' } })
    expect(t.api.sessions).toHaveBeenLastCalledWith({ op: 'terminal', project: 'ws-1', args: { from: 5, known: { p: 'k' } } })
    t.listeners.onGuest(joined({}, { features: ['chat'] }))
    await flush()
    expect(t.ls.sessionSource('ws-1').state).toBe('outdated-host')
  })
})

// --- The page view ------------------------------------------------------------------
describe('LiveSharePageView.vue (an address only the host side opens)', () => {
  let wrapper, ctx, note
  beforeEach(() => {
    note = reactive({ host: 'Cedric', url: 'http://localhost:5173/app', title: 'Dev', ended: false })
    ctx = { activeId: ref(null), maximizedId: ref(null), highlightId: ref(null), setActive: vi.fn(), liveSharePageNote: () => note }
  })
  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
  })
  const node = () => reactive({ type: 'leaf', id: 'pane-ls1-web', backend: 'liveshare', liveShare: { page: true, link: true, local: true, host: 'Cedric', project: 'ws-1', pageTitle: 'Dev', pageUrl: 'http://localhost:5173/app' } })
  const mountView = async (n = node()) => {
    wrapper = mount(LiveSharePageView, { props: { node: n }, attachTo: document.body, global: { provide: { panelCtx: ctx } } })
    await flushPromises()
    return n
  }

  it('says calmly where it runs, with the address to copy; no picture, no input', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await mountView()
    expect(wrapper.find('[data-test="liveshare-page-note"] p').text()).toBe('This page runs on Cedric’s computer: it can’t open here.')
    expect(wrapper.find('[data-test="liveshare-page-url"]').text()).toBe('http://localhost:5173/app')
    expect(wrapper.find('img').exists()).toBe(false)
    await wrapper.find('[data-test="liveshare-page-copy"]').trigger('click')
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith('http://localhost:5173/app')
    expect(wrapper.find('[data-test="liveshare-page-copy"]').text()).toBe('Copied')
    note.ended = true
    await nextTick()
    expect(wrapper.find('[data-test="liveshare-page-note"] p').text()).toBe('The Live Share session ended.')
  })

  it('as a tab: its header is the line of tabs, the page by its title; its x hides it here', async () => {
    const n = node()
    ctx.paneTabs = (id) => (id === 'pane-ls1-web' ? { leaves: [n], shown: 'pane-ls1-web' } : null)
    ctx.closeViewTab = vi.fn()
    await mountView(n)
    const tabs = () => wrapper.findAll('[data-test="view-tab"]')
    expect(tabs().map((x) => x.text())).toEqual(['Terminal', 'Dev'])
    expect(tabs()[1].attributes('title')).toBe('Cedric’s tab: http://localhost:5173/app')
    await wrapper.find('[data-test="view-tab-close"]').trigger('click')
    expect(ctx.closeViewTab).toHaveBeenCalledWith('pane-ls1-web', null)
  })
})

// --- The Agents and Conversations tabs of a host's project ------------------------------
describe('the host project in the Agents and Conversations tabs', () => {
  let wrapper
  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    document.body.replaceChildren()
  })

  it('Agents: the host sessions, read only, details from the host', async () => {
    window.shellApi = { listSessions: vi.fn(async () => []), writeClipboard: vi.fn() }
    const source = {
      project: 'ws-1',
      host: 'Cedric',
      state: 'ok',
      list: vi.fn(async () => ({ ok: true, sessions: [{ id: 'r'.repeat(22), agent: 'claude', title: 'Fix the build', started: 1, updated: Date.now() - 60000 }] })),
      details: vi.fn(async () => ({ ok: true, firstPrompt: 'Fix it', turns: [{ role: 'assistant', text: 'Done.', at: 1 }], messageCount: 2 }))
    }
    wrapper = mount(SessionHistoryPanel, { props: { cwd: null, openIds: {}, source }, attachTo: document.body, global: { provide: { askConfirm: () => Promise.resolve(true) } } })
    await flushPromises()
    expect(source.list).toHaveBeenCalledWith({ limit: expect.any(Number) })
    expect(window.shellApi.listSessions).not.toHaveBeenCalled()
    expect(wrapper.find('[data-test="session-scopes"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('Cedric’s sessions of this project, read only')
    const row = wrapper.find('[data-test="session-row"]')
    expect(row.text()).toContain('Fix the build')
    expect(row.find('[data-test="session-resume"]').exists()).toBe(false)
    expect(row.find('[data-test="session-more"]').exists()).toBe(false)
    await row.find('[data-test="session-toggle"]').trigger('click')
    await flushPromises()
    expect(source.details).toHaveBeenCalledWith('r'.repeat(22))
    expect(wrapper.find('[data-test="details-prompt"]').text()).toBe('Fix it')
    expect(wrapper.find('[data-test="details-turns"]').text()).toContain('Done.')
    expect(wrapper.find('[data-test="details-resume"]').exists()).toBe(false)
  })

  it('Agents: says why the host sessions are not there', async () => {
    window.shellApi = { listSessions: vi.fn(async () => []) }
    const source = { project: 'ws-1', host: 'Cedric', state: 'outdated-host', list: vi.fn(async () => ({ ok: false, code: 'outdated-host' })), details: vi.fn() }
    wrapper = mount(SessionHistoryPanel, { props: { cwd: null, openIds: {}, source }, attachTo: document.body, global: { provide: { askConfirm: () => Promise.resolve(true) } } })
    await flushPromises()
    expect(wrapper.find('[data-test="session-error"]').text()).toContain('The host’s Tessel is too old for this')
  })

  it('Conversations: the host activity and terminal agents, followed while shown; "You" is the host', async () => {
    window.shellApi = { conversations: { terminal: vi.fn(async () => ({ ok: true, panes: {} })) } }
    const now = Date.now()
    const source = reactive({
      project: 'ws-1',
      host: 'Cedric',
      state: 'ok',
      loaded: true,
      events: [{ t: now - 60000, type: 'message', paneId: 'pane-ls1-a', agent: { title: 'Ada', agentId: 'claude' }, status: 'sent', source: 'you', scope: 'workspace', wsId: 'ws-101', text: 'Ship it' }],
      teams: [],
      follow: vi.fn(),
      terminal: vi.fn(async () => ({ ok: true, panes: { 'pane-ls1-a': { key: 'k'.repeat(22), items: [{ role: 'agent', t: now - 30000, text: 'Shipped.' }], title: 'Ada', agentId: 'claude' } } }))
    })
    wrapper = mount(ConversationsPanel, { props: { events: [], teams: [], projects: [], workspaceId: 'ws-101', now, active: true, source }, attachTo: document.body })
    await flushPromises()
    expect(source.follow).toHaveBeenCalledWith(true)
    expect(source.terminal).toHaveBeenCalledWith({ from: expect.any(Number), known: {} })
    expect(window.shellApi.conversations.terminal).not.toHaveBeenCalled()
    const text = wrapper.text()
    expect(text).toContain('Ship it')
    expect(text).toContain('Shipped.')
    expect(text).toContain('Cedric and Ada')
    expect(text).not.toContain('You and')
    await wrapper.setProps({ active: false })
    expect(source.follow).toHaveBeenLastCalledWith(false)
  })
})

// --- The host's browser pane ---------------------------------------------------------------
describe('BrowserPane.vue while sharing', () => {
  let wrapper, ctx, handlers, share
  beforeEach(() => {
    handlers = {}
    const sub = (name) => vi.fn((cb) => ((handlers[name] = cb), () => {}))
    window.shellApi = { browser: { onPopup: sub('popup'), onShortcut: sub('shortcut'), onPermissionDenied: sub('permission'), onDownloadBlocked: sub('download'), onAudio: sub('audio') }, writeClipboard: vi.fn(), openExternal: vi.fn() }
    share = ref(null)
    ctx = {
      activeId: ref('b1'),
      maximizedId: ref(null),
      highlightId: ref(null),
      setActive: vi.fn(),
      closeLeaf: vi.fn(),
      toggleMaximize: vi.fn(),
      beginPaneDrag: vi.fn(),
      toast: vi.fn(),
      copied: vi.fn(),
      browserPorts: () => [],
      openExternal: vi.fn(),
      openBrowserPane: vi.fn(),
      liveSharePageShare: () => share.value,
      setLiveSharePageHidden: vi.fn((id, hidden) => (share.value = { ...share.value, hidden })),
      liveShareFollowPage: vi.fn()
    }
  })
  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
  })
  const mountPane = async (extra = {}) => {
    const node = reactive({ type: 'leaf', kind: 'browser', id: 'b1', title: '', url: 'https://mail.example/', zoom: 0, focusAddress: 0, ...extra })
    wrapper = mount(BrowserPane, { props: { node }, attachTo: document.body, global: { provide: { panelCtx: ctx } } })
    const el = wrapper.find('webview').element
    Object.assign(el, { loadURL: vi.fn(() => Promise.resolve()), getWebContentsId: vi.fn(() => 42), getURL: () => 'https://mail.example/', getTitle: () => '', setZoomLevel: vi.fn(), setAudioMuted: vi.fn(), isCurrentlyAudible: () => false, isLoading: () => false, canGoBack: () => false, canGoForward: () => false })
    await nextTick()
    return node
  }

  it('"Hide this page from guests" toggles; "Shared with guests" shows on a page sent; a side panel page is shared only on your click', async () => {
    await mountPane()
    expect(wrapper.find('[data-test="browser-live-hide"]').exists()).toBe(false)
    share.value = { project: 'ws-1', side: false, hidden: false, shared: true, sent: true }
    await nextTick()
    expect(wrapper.find('[data-test="browser-live-sent"]').text()).toBe('Shared with guests')
    await wrapper.find('[data-test="browser-live-hide"]').trigger('click')
    expect(ctx.setLiveSharePageHidden).toHaveBeenCalledWith('b1', true)
    share.value = { ...share.value, hidden: true, sent: false }
    await nextTick()
    expect(wrapper.find('[data-test="browser-live-hide"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.find('[data-test="browser-live-sent"]').exists()).toBe(false)
    wrapper.unmount()
    share.value = { project: 'ws-1', side: true, hidden: true, shared: false, sent: false }
    ctx.setLiveSharePageShared = vi.fn()
    wrapper = mount(BrowserPane, { props: { node: reactive({ type: 'leaf', kind: 'browser', id: 'web-side1', title: '', url: 'https://docs.test/', zoom: 0, focusAddress: 0 }), inSidePanel: true }, attachTo: document.body, global: { provide: { panelCtx: ctx } } })
    await nextTick()
    expect(wrapper.find('[data-test="browser-live-hide"]').exists()).toBe(false)
    const shareBtn = wrapper.find('[data-test="browser-live-share"]')
    expect(shareBtn.attributes('aria-pressed')).toBe('false')
    await shareBtn.trigger('click')
    expect(ctx.setLiveSharePageShared).toHaveBeenCalledWith('web-side1', true)
  })

  it('a host page not opened yet: one click opens its site; "Open in my own browser session" on your word only; in its own view session', async () => {
    ctx.liveShareApprovePage = vi.fn()
    const node = await mountPane({ url: 'about:blank', viewPartition: 'liveshare-view-1', backend: 'liveshare', liveShare: { link: true, host: 'Cedric', following: true, hostUrl: 'https://mail.example/a', pendingUrl: 'https://mail.example/a', setAt: 0, media: null } })
    expect(wrapper.find('webview').attributes('partition')).toBe('liveshare-view-1')
    expect(wrapper.find('[data-test="browser-host-pending"]').text()).toContain('Cedric opened mail.example')
    await wrapper.find('[data-test="browser-host-approve"]').trigger('click')
    expect(ctx.liveShareApprovePage).toHaveBeenCalledWith('b1')
    await wrapper.find('[data-test="browser-open-own"]').trigger('click')
    expect(ctx.openBrowserPane).toHaveBeenCalledWith('https://mail.example/a', { activate: true })
    void node
  })

  it('a host page followed here: says so; going elsewhere yourself stops it, "Follow host" asks again; the host videos played here', async () => {
    const node = await mountPane({ backend: 'liveshare', liveShare: { link: true, host: 'Cedric', following: true, hostUrl: 'https://mail.example/', setAt: Date.now(), media: null } })
    const el = wrapper.find('webview').element
    el.executeJavaScript = vi.fn(async () => 1)
    el.dispatchEvent(new Event('dom-ready'))
    await nextTick()
    expect(wrapper.find('[data-test="browser-host-link"]').text()).toBe('Following Cedric')
    expect(wrapper.find('[data-test="browser-follow-host"]').exists()).toBe(false)
    // The host's video: played here (numbers only reach the page).
    node.liveShare.media = { seq: 1, items: [{ kind: 'video', i: 0, paused: false, ended: false, t: 30, rate: 1 }], at: Date.now() }
    await nextTick()
    expect(el.executeJavaScript).toHaveBeenCalledTimes(1)
    expect(el.executeJavaScript.mock.calls[0][0]).toMatch(/"kind":"video","i":0,"paused":false,"ended":false,"t":30(\.\d+)?,"rate":1/)
    // An address typed here: not following any more.
    const input = wrapper.find('.bp-address-input')
    await input.setValue('https://other.example/')
    await wrapper.find('[data-test="browser-address"]').trigger('submit')
    expect(node.liveShare.following).toBe(false)
    await nextTick()
    expect(wrapper.find('[data-test="browser-host-link"]').text()).toContain('Not following')
    node.liveShare.media = { seq: 2, items: [{ kind: 'video', i: 0, paused: true, ended: false, t: 31, rate: 1 }], at: Date.now() }
    await nextTick()
    expect(el.executeJavaScript).toHaveBeenCalledTimes(1)
    await wrapper.find('[data-test="browser-follow-host"]').trigger('click')
    expect(ctx.liveShareFollowPage).toHaveBeenCalledWith('b1')
  })

  it('a page a guest opened is in the guest session; a guest popup opens a new pane there', async () => {
    await mountPane({ guestSession: true })
    expect(wrapper.find('webview').attributes('partition')).toBe('tessel-browser-guest')
    wrapper.unmount()
    await mountPane()
    wrapper.find('webview').element.dispatchEvent(new Event('dom-ready'))
    await nextTick()
    handlers.popup({ webContentsId: 42, url: 'https://other.example/x', newPane: true, guest: true })
    await flushPromises()
    expect(ctx.openBrowserPane).toHaveBeenCalledWith('https://other.example/x', { fromId: 'b1', activate: false, guestSession: true })
  })
})
