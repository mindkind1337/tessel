// Live Share phase 2c in the window (liveShareWindowFeeds.js through
// liveShareWindow.js, LiveSharePageView.vue, SessionHistoryPanel.vue,
// ConversationsPanel.vue, BrowserPane.vue, browser/pageHost.js). Host: the
// browser panes of the shared projects go to main with their page and the
// host's "hide" (never another project's, never one without a page yet);
// the eye says who watches; the activity goes only while guests follow it.
// Guest: the host's browser panes show only with "See my browser pages"; a
// page view watches only while it is on screen, shows the frames, sends
// clicks and keys only with "Use my browser pages", opens the address in
// your own browser only when it is not the host's network; the Agents tab
// and the Conversations tab of a host's project read the host's, read only.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { reactive, ref, nextTick } from 'vue'
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
    pageWatch: vi.fn(async () => ({ ok: true })),
    pageInput: vi.fn(),
    share: vi.fn(async () => ({ ok: true })),
    focus: vi.fn(),
    requestDone: vi.fn()
  }
  for (const name of ['onHost', 'onGuest', 'onAsk', 'onHostRequest', 'onNotice', 'onPresence', 'onInviteBlocked', 'onGuestAction', 'onPush', 'onFeeds', 'onPagesWatched', 'onPageFrame', 'onPageEvent']) {
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
    activityRev: () => log.length
  }
  const ls = createLiveShareWindow(deps)
  return { ls, api, listeners, workspaces, currentWsId, pages, log }
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
    expect(t.ls.pageShare('b1')).toEqual({ project: 'ws-1', hidden: false, watchers: [] })
    expect(t.ls.pageShare('b9')).toBe(null)
    expect(t.ls.setPageHidden('b1', true)).toBe(true)
    await flush()
    expect(t.api.setPages.mock.calls.at(-1)[0][0]).toEqual({ project: 'ws-1', paneId: 'b1', webContentsId: 11, hidden: true })
    expect(t.ls.pageShare('b1').hidden).toBe(true)
    expect(t.ls.setPageHidden('p1', true)).toBe(false)
    // The eye: the guests watching (names of those in).
    t.listeners.onPagesWatched([{ id: 'b1', guests: [{ id: 'g1', name: 'x' }, { id: 'gone', name: 'y' }] }])
    expect(t.ls.pageShare('b1').watchers).toEqual(['Ana'])
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
  const joined = (rights = {}, extra = {}) => ({ state: 'joined', host: 'Cedric', session: 1, panes: [], projects: [{ id: 'ws-1', layout }], rights: { ...NO_RIGHTS, ...rights }, features: ['chat', 'files', 'scm', 'tasks', 'history', 'pages'], ...extra })
  const lsWs = () => t.workspaces.value.find((w) => w.liveShare)
  const leaves = (n, out = []) => {
    if (!n) return out
    if (n.type === 'leaf') out.push(n)
    else n.children.forEach((c) => leaves(c, out))
    return out
  }

  it('shows the host browser panes only with "See my browser pages", as page views', async () => {
    t.listeners.onGuest(joined())
    await flush()
    expect(leaves(lsWs().tree).some((l) => l.id === 'pane-ls1-web')).toBe(false)
    t.listeners.onGuest(joined({ pagesView: true }))
    await flush()
    const page = leaves(lsWs().tree).find((l) => l.id === 'pane-ls1-web')
    expect(page).toMatchObject({ kind: 'shell', backend: 'liveshare', liveShare: { page: true, terminal: false, project: 'ws-1' } })
    const src = t.ls.pageSource('pane-ls1-web')
    expect(src.info()).toMatchObject({ host: 'Cedric', joined: true, canView: true, canUse: false, outdated: false, project: 'ws-1' })
    await src.watch(true)
    expect(t.api.pageWatch).toHaveBeenLastCalledWith({ id: 'pane-ls1-web', on: true })
    const got = []
    const off = src.onFrame((m) => got.push(m.seq))
    t.listeners.onPageFrame({ id: 'other', seq: 1 })
    t.listeners.onPageFrame({ id: 'pane-ls1-web', seq: 2 })
    off()
    t.listeners.onPageFrame({ id: 'pane-ls1-web', seq: 3 })
    expect(got).toEqual([2])
    t.listeners.onGuest(joined({ pagesView: true, pagesUse: true }))
    await flush()
    expect(t.ls.pageSource('pane-ls1-web').info().canUse).toBe(true)
    // An older host: its page views say it needs to update.
    t.listeners.onGuest(joined({ pagesView: true }, { features: ['chat', 'files'] }))
    await flush()
    expect(t.ls.pageSource('pane-ls1-web').info().outdated).toBe(true)
    // The right taken away: the page view goes.
    t.listeners.onGuest(joined())
    await flush()
    expect(leaves(lsWs().tree).some((l) => l.id === 'pane-ls1-web')).toBe(false)
  })

  // 2026-10-19: the host's page showed inside the guest's grid, beside the
  // terminals ("about:blank" pane), where the host has it as a tab.
  it('the host browser page is a tab of its own, as on the host, never a pane of the grid', async () => {
    t.listeners.onGuest(joined({ pagesView: true }))
    await flush()
    const [view] = workspaceViews(lsWs())
    expect(view.tabs.map((l) => l.id)).toEqual(['pane-ls1-web'])
    // (No terminal attached in this test: the grid holds none of the pages.)
    expect(leaves(view.grid).map((l) => l.id)).not.toContain('pane-ls1-web')
    expect(view.shown).toBe('terminal')
    // The host on its page: that tab comes up here too (the host's active pane
    // is taken once, when there is one).
    t.listeners.onGuest(joined({ pagesView: true }, { projects: [{ id: 'ws-1', layout: { ...layout, activeId: 'pane-ls1-web' } }] }))
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
describe('LiveSharePageView.vue', () => {
  let wrapper, src, info, frameCb, eventCb, ctx, askConfirm
  beforeEach(() => {
    askConfirm = vi.fn(async () => true)
    info = reactive({ host: 'Cedric', joined: true, ended: false, outdated: false, canView: true, canUse: false, project: 'ws-1' })
    src = {
      info: () => info,
      watch: vi.fn(async () => ({ ok: true })),
      input: vi.fn(),
      onFrame: (cb) => ((frameCb = cb), () => (frameCb = null)),
      onEvent: (cb) => ((eventCb = cb), () => (eventCb = null))
    }
    ctx = { activeId: ref(null), maximizedId: ref(null), highlightId: ref(null), setActive: vi.fn(), toggleMaximize: vi.fn(), liveSharePageSource: () => src }
    window.shellApi = { openExternal: vi.fn() }
    URL.createObjectURL = vi.fn(() => 'blob:frame')
    URL.revokeObjectURL = vi.fn()
  })
  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    node = null
  })
  let node = null
  const wrapperNode = () => node
  const mountView = async () => {
    node = node || reactive({ type: 'leaf', id: 'pane-ls1-web', backend: 'liveshare', liveShare: { page: true, host: 'Cedric', project: 'ws-1' } })
    wrapper = mount(LiveSharePageView, { props: { node }, attachTo: document.body, global: { provide: { panelCtx: ctx, askConfirm: (q) => askConfirm(q) } } })
    await flushPromises()
  }
  const frame = (seq, url = 'https://mail.example/inbox?…') => frameCb({ id: 'pane-ls1-web', seq, jpeg: new Uint8Array([0xff, 0xd8]), w: 1000, h: 700, meta: { title: 'Inbox', url } })

  it('watches while on screen, shows the frames, the title and the masked address; stops when it goes', async () => {
    await mountView()
    expect(src.watch).toHaveBeenCalledWith(true)
    expect(wrapper.find('[data-test="liveshare-page-note"]').text()).toBe('Waiting for the page…')
    frame(1)
    await nextTick()
    expect(wrapper.find('[data-test="liveshare-page-frame"]').attributes('src')).toBe('blob:frame')
    expect(wrapper.find('[data-test="pane-title"]').text()).toBe('Inbox')
    expect(wrapper.find('[data-test="liveshare-page-url"]').text()).toBe('https://mail.example/inbox?…')
    expect(wrapper.find('[data-test="liveshare-page-mode"]').text()).toBe('View only: Cedric’s page, live.')
    // An older frame after a newer one: dropped.
    frame(1)
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
    eventCb({ id: 'pane-ls1-web', state: 'paused', reason: 'password' })
    await nextTick()
    expect(wrapper.find('[data-test="liveshare-page-note"]').text()).toBe('Hidden by the host')
    eventCb({ id: 'pane-ls1-web', state: 'ended', reason: 'gone' })
    await nextTick()
    expect(wrapper.find('[data-test="liveshare-page-note"]').text()).toBe('This page is no longer shared.')
    // The window hidden: no watching.
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    await flushPromises()
    expect(src.watch).toHaveBeenLastCalledWith(false)
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    await flushPromises()
    expect(src.watch).toHaveBeenLastCalledWith(true)
    wrapper.unmount()
    wrapper = null
    expect(src.watch).toHaveBeenLastCalledWith(false)
  })

  it('as a tab: its header is the line of tabs (Terminal, then the page by its title, which only the host closes); the address goes under it', async () => {
    ctx.paneTabs = (id) => (id === 'pane-ls1-web' ? { leaves: [wrapperNode()], shown: 'pane-ls1-web' } : null)
    ctx.selectViewTab = vi.fn()
    await mountView()
    const tabs = () => wrapper.findAll('[data-test="view-tab"]')
    expect(tabs().map((x) => x.text())).toEqual(['Terminal', 'Browser page'])
    expect(wrapper.find('[data-test="pane-title"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="view-tab-close"]').exists()).toBe(false)
    expect(wrapper.find('[aria-label="Maximize pane"]').exists()).toBe(false)
    frame(1)
    await nextTick()
    expect(tabs().map((x) => x.text())).toEqual(['Terminal', 'Inbox'])
    expect(wrapperNode().liveShare).toMatchObject({ pageTitle: 'Inbox', pageUrl: 'https://mail.example/inbox?…' })
    expect(wrapper.find('[data-test="liveshare-page-mode"] [data-test="liveshare-page-url"]').text()).toBe('https://mail.example/inbox?…')
    await tabs()[0].trigger('click')
    expect(ctx.selectViewTab).toHaveBeenCalledWith('pane-ls1-web', 'terminal', null)
  })

  it('sends clicks and keys only with "use"; opens the address in your browser unless it is the host network', async () => {
    await mountView()
    frame(1)
    await nextTick()
    const img = wrapper.find('[data-test="liveshare-page-frame"]')
    img.element.getBoundingClientRect = () => ({ left: 0, top: 0, width: 500, height: 350 })
    await img.trigger('mousedown', { button: 0, clientX: 250, clientY: 175 })
    await new Promise((r) => setTimeout(r, 80))
    expect(src.input).not.toHaveBeenCalled()
    info.canUse = true
    await nextTick()
    expect(wrapper.find('[data-test="liveshare-page-mode"]').text()).toBe('Your clicks and keys act in Cedric’s browser, signed in as Cedric.')
    await img.trigger('mousedown', { button: 0, clientX: 250, clientY: 175 })
    await img.trigger('mouseup', { button: 0, clientX: 250, clientY: 175 })
    await wrapper.find('[data-test="liveshare-page"]').trigger('keydown', { key: 'a' })
    await wrapper.find('[data-test="liveshare-page"]').trigger('keydown', { key: 'Enter' })
    await img.trigger('mousedown', { button: 2, clientX: 10, clientY: 10 })
    await new Promise((r) => setTimeout(r, 80))
    const sent = src.input.mock.calls.flatMap(([events]) => events)
    expect(sent).toEqual([
      { type: 'mouse', action: 'down', x: 0.5, y: 0.5, modifiers: { ctrl: false, alt: false, shift: false, meta: false }, button: 'left', clicks: 1 },
      { type: 'mouse', action: 'up', x: 0.5, y: 0.5, modifiers: { ctrl: false, alt: false, shift: false, meta: false }, button: 'left', clicks: 1 },
      { type: 'text', text: 'a' },
      { type: 'key', key: 'Enter', modifiers: { ctrl: false, alt: false, shift: false, meta: false } }
    ])
    expect(wrapper.find('[data-test="liveshare-page-notice"]').text()).toMatch(/Only the left mouse button/)
    // Refusals the host says back.
    eventCb({ id: 'pane-ls1-web', state: 'input', refused: ['key'] })
    await nextTick()
    expect(wrapper.find('[data-test="liveshare-page-notice"]').text()).toMatch(/That key is not sent/)
    eventCb({ id: 'pane-ls1-web', state: 'input', refused: [], notice: 'limit' })
    await nextTick()
    expect(wrapper.find('[data-test="liveshare-page-notice"]').text()).toMatch(/limits how fast/)
    // Open in your own browser: origin and path, once the whole address was
    // shown and you said yes.
    const open = wrapper.find('[data-test="liveshare-page-open"]')
    expect(open.attributes('disabled')).toBeUndefined()
    askConfirm.mockResolvedValueOnce(false)
    await open.trigger('click')
    await flushPromises()
    expect(askConfirm).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('https://mail.example/inbox') }))
    expect(window.shellApi.openExternal).not.toHaveBeenCalled()
    await open.trigger('click')
    await flushPromises()
    expect(window.shellApi.openExternal).toHaveBeenCalledWith('https://mail.example/inbox')
    frame(2, 'http://localhost:5173/app')
    await nextTick()
    expect(open.attributes('disabled')).toBeDefined()
    expect(open.attributes('title')).toBe('This address only works on the host’s computer or network.')
  })

  it('says why nothing shows: no right, an older host, the session ended', async () => {
    info.canView = false
    await mountView()
    expect(src.watch).not.toHaveBeenCalled()
    expect(wrapper.find('[data-test="liveshare-page-note"]').text()).toBe('Cedric has not let you see their browser pages.')
    info.canView = true
    info.outdated = true
    await nextTick()
    expect(wrapper.find('[data-test="liveshare-page-note"]').text()).toMatch(/too old to share its browser pages/)
    info.ended = true
    await nextTick()
    expect(wrapper.find('[data-test="liveshare-page-note"]').text()).toBe('The Live Share session ended.')
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
      setLiveSharePageHidden: vi.fn((id, hidden) => (share.value = { ...share.value, hidden }))
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

  it('the eye says who watches; "Hide this page from guests" toggles; nothing while not shared', async () => {
    await mountPane()
    expect(wrapper.find('[data-test="browser-live-hide"]').exists()).toBe(false)
    share.value = { project: 'ws-1', hidden: false, watchers: ['Ana', 'Bo'] }
    await nextTick()
    const eye = wrapper.find('[data-test="browser-live-eye"]')
    expect(eye.attributes('title')).toBe('Guests watching this page: Ana, Bo')
    expect(eye.text()).toBe('2')
    await wrapper.find('[data-test="browser-live-hide"]').trigger('click')
    expect(ctx.setLiveSharePageHidden).toHaveBeenCalledWith('b1', true)
    await nextTick()
    expect(wrapper.find('[data-test="browser-live-hide"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.find('[data-test="browser-live-eye"]').exists()).toBe(false)
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
