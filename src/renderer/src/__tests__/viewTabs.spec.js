// The tabs above the panes (App.vue, paneViews.js): an editor or a browser
// opens as a tab of its own (no pane is split) and comes up; a terminal
// opened from it goes to the grid, beside the terminal last used there, and
// the Terminal tab comes up; closing the tab on screen goes back to
// Terminal; going to a pane from elsewhere shows the tab that holds it.
// Run on App.vue's own code, as projectLauncherFlow.spec.js does.
import { describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import vm from 'vm'
import { join } from 'path'
import { computed, nextTick, reactive, ref, watch } from 'vue'
import * as paneViews from '../paneViews'
import * as paneGrid from '../paneGrid'
import { openTab, samePath } from '../editor/editorTabs'
import { fileKind } from '../../../shared/fileKinds'
import { allowedBrowserUrl, BLANK_URL } from '../../../shared/browserUrl'

const source = fs.readFileSync(join(process.cwd(), 'src/renderer/src/App.vue'), 'utf8').replace(/\r\n/g, '\n')
function slice(from, to) {
  const a = source.indexOf(from)
  const b = source.indexOf(to, a)
  if (a < 0 || b < 0) throw new Error(`App.vue changed: ${from}`)
  return source.slice(a, b)
}
// A top-level function of App.vue, from its first line to its closing brace.
function fnSource(head) {
  const start = source.indexOf(head)
  const end = source.indexOf('\n}\n', start)
  if (start < 0 || end < 0) throw new Error(`App.vue changed: ${head}`)
  return source.slice(start, end + 2)
}

const leaf = (id, extra = {}) => reactive({ type: 'leaf', id, kind: 'shell', ...extra })

function load({ tree, activeId, cwd = 'C:\\p' } = {}) {
  const workspaces = ref([])
  const currentWsId = ref('ws1')
  let n = 0
  const ctx = {
    ...paneViews,
    ...paneGrid,
    computed,
    reactive,
    watch,
    nextTick: (fn) => Promise.resolve().then(fn),
    t: (_key, en) => en,
    workspaces,
    currentWsId,
    currentWs: computed(() => workspaces.value.find((w) => w.id === currentWsId.value) || null),
    maximizedId: ref(null),
    newId: (p) => `${p}-${++n}`,
    settings: reactive({ editorPreviewTabs: true, confirmCloseAgent: false }),
    getDoc: () => null,
    openTab,
    samePath,
    fileKind,
    allowedBrowserUrl,
    BLANK_URL,
    selectWorkspace: vi.fn((id) => (currentWsId.value = id)),
    refitSoon: vi.fn(),
    focusActiveInput: vi.fn(),
    getEditorPane: () => null,
    clearAttention: vi.fn(),
    readForPane: vi.fn(),
    liveShare: { isGuestWs: () => false, isGuestLeaf: () => false, state: { guest: { state: 'off' } } },
    createLeaf: vi.fn(async (shellId, agent, dir, worktree) => leaf(`pane-new${++n}`, { kind: agent ? 'agent' : 'shell', ...(worktree ? { worktree } : {}) })),
    wsLeafOpts: (_ws, opts = {}) => opts,
    selectedShell: ref('pwsh'),
    dirtyEditorPaths: () => [],
    askEditorClose: vi.fn(),
    releaseOwner: vi.fn(),
    isAgentLeaf: () => false,
    askConfirm: vi.fn(),
    probeRunningWork: vi.fn(),
    chatStatus: {},
    chatBackground: {},
    dropBuffer: vi.fn(),
    forgetTerminal: vi.fn(),
    agentTerminalTargets: { forget: vi.fn() },
    clearAgentStatus: vi.fn(),
    refillEmptiedWorkspace: vi.fn(),
    pruneTeams: vi.fn(),
    teamById: () => null,
    recordActivity: vi.fn(),
    tellTeam: vi.fn(),
    window: { shellApi: { killPty: vi.fn() } }
  }
  ctx.makeSplit = (dir, children, sizes) => reactive({ type: 'split', id: ctx.newId('split'), dir, sizes, children })
  vm.createContext(ctx)
  vm.runInContext(
    slice('function replaceNode(node, targetId, make) {', '// --- Workspace persistence') +
      fnSource('function findLeaf(id) {') +
      slice('const paneViews = computed(', 'const tree = computed(') +
      slice('// --- Tabs above the panes (paneViews.js, ViewTabs.vue)', 'const initError') +
      slice('let revealSeq = 0', '// An agent pane: a terminal agent') +
      slice('// Panes without a terminal: an editor, a browser page, a chat agent.', '// A page in the system browser') +
      slice('// --- Auto-tile (paneGrid.js)', '// Settings > Git and > General') +
      slice('function closeLeaf(leafId, opts = {})', '// Arrange the workspace as an even grid') +
      fnSource('function showActive(ws, id) {') +
      fnSource('function focusPane(paneId) {') +
      fnSource('function toggleMaximize(id) {') +
      '\nthis.api = { paneViews, paneTabStrips, showViewTab, emptyGridShown, openInTesselEditor, openInBrowser, splitLeaf, closeLeaf, focusPane, toggleMaximize, tabsAlways }',
    ctx
  )
  const ws = reactive({ id: 'ws1', name: 'p', cwd, tree, activeId, remote: null })
  workspaces.value.push(ws)
  const view = () => ctx.api.paneViews.value[ws.id].find((v) => v.active)
  return { api: ctx.api, ctx, ws: workspaces.value[0], view }
}

// Two terminals side by side, the second one used last.
function twoTerminals() {
  const grid = reactive({ type: 'split', id: 'grid', dir: 'row', sizes: [60, 40], children: [leaf('t1'), leaf('t2')] })
  return { ...load({ tree: grid, activeId: 't2' }), grid }
}

describe('opening an editor or a browser', () => {
  it('an editor opens as a tab of its own and comes up: no pane is split, the grid keeps its room', async () => {
    const { api, ws, view, grid } = twoTerminals()
    await nextTick()
    const ed = api.openInTesselEditor({ file: 'C:\\p\\src\\a.js', ws })
    expect(ed.kind).toBe('editor')
    expect(view().grid).toBe(grid)
    expect(grid.sizes).toEqual([60, 40])
    expect(view().tabs.map((l) => l.id)).toEqual([ed.id])
    expect(view().shown).toBe(ed.id)
    expect(ws.activeId).toBe(ed.id)
    // The next file: the same editor, still no split.
    const again = api.openInTesselEditor({ file: 'C:\\p\\src\\b.js', ws })
    expect(again).toBe(ed)
    expect(view().tabs).toHaveLength(1)
    expect(ed.files.map((f) => f.path)).toEqual(['C:\\p\\src\\b.js'])
  })

  it('a browser opens as a tab too; one opened in the background does not come up', async () => {
    const { api, ws, view, grid } = twoTerminals()
    const page = api.openInBrowser({ url: 'https://example.com/', ws })
    expect(view().grid).toBe(grid)
    expect(view().shown).toBe(page.id)
    api.showViewTab(ws, 'terminal')
    const behind = api.openInBrowser({ url: 'https://example.org/', ws, newPane: true, activate: false })
    expect(view().tabs.map((l) => l.id)).toEqual([page.id, behind.id])
    expect(view().shown).toBe('terminal')
  })

  it('the tab strip shows only while the view has an editor or a browser', () => {
    const { api, ws, view } = twoTerminals()
    expect(view().tabs).toEqual([])
    const ed = api.openInTesselEditor({ file: 'C:\\p\\a.js', ws })
    // The editor's header draws the tabs (none for a terminal).
    expect(api.paneTabStrips.value[ed.id]).toMatchObject({ shown: ed.id })
    expect(api.paneTabStrips.value.t1).toBeUndefined()
    api.closeLeaf(ed.id)
    expect(view().tabs).toEqual([])
  })
})

describe('full screen and task copies', () => {
  it('back to Terminal: the keyboard goes to the pane in full screen (the one on screen)', () => {
    const { api, ws, ctx } = twoTerminals()
    // t2 used last, t1 made full screen by its button (it does not become active).
    api.toggleMaximize('t1')
    api.openInTesselEditor({ file: 'C:\\p\\a.js', ws })
    api.showViewTab(ws, 'terminal')
    expect(ctx.maximizedId.value).toBe('t1')
    expect(ws.activeId).toBe('t1')
  })

  it('closing the editor instead: the keyboard goes back to the pane in full screen too', () => {
    const { api, ws, ctx } = twoTerminals()
    api.toggleMaximize('t1')
    const ed = api.openInTesselEditor({ file: 'C:\\p\\a.js', ws })
    api.closeLeaf(ed.id)
    expect(ctx.maximizedId.value).toBe('t1')
    expect(ws.activeId).toBe('t1')
  })

  it("closing a copy's editor: another tab of that copy keeps the view there, not the main project", () => {
    const tree = reactive({
      type: 'split',
      id: 's',
      dir: 'row',
      sizes: [34, 33, 33],
      children: [leaf('t1'), leaf('ed', { kind: 'editor', files: [], viewPath: 'C:\\copy' }), leaf('br', { kind: 'browser', url: 'https://example.com/', viewPath: 'C:\\copy' })]
    })
    const { api, ws, view } = load({ tree, activeId: 'ed' })
    ws.view = 'ed'
    const copyKey = view().key
    api.closeLeaf('ed')
    expect(ws.activeId).toBe('br')
    expect(view().key).toBe(copyKey)
    // Its grid has no terminal: the Terminal tab (the launcher) shows there.
    expect(view().shown).toBe('terminal')
  })
})

describe('the line of tabs, always there', () => {
  it('Terminal first, always; an editor or a browser closed: its tab goes, back to Terminal', () => {
    const { api, ws, view } = twoTerminals()
    expect(api.tabsAlways(ws)).toBe(true)
    const br = api.openInBrowser({ url: 'https://example.com/', ws })
    expect(view().tabs.map((l) => l.id)).toEqual([br.id])
    expect(view().shown).toBe(br.id)
    api.closeLeaf(br.id)
    expect(view().tabs).toEqual([])
    expect(view().shown).toBe('terminal')
    expect(api.tabsAlways(ws)).toBe(true)
  })
})

describe("the line of tabs in a Live Share guest's project", () => {
  it("is there like the host's, with no launcher under it (a guest starts nothing in the host's project)", () => {
    const { api, ctx, ws, view } = twoTerminals()
    ctx.liveShare.isGuestWs = (w) => w === ws
    expect(api.tabsAlways(ws)).toBe(true)
    expect(view().tabs).toEqual([])
    expect(view().shown).toBe('terminal')
    expect(api.emptyGridShown(ws)).toBe(false)
    // Showing the Terminal tab is all it does.
    api.showViewTab(ws, 'terminal')
    expect(view().shown).toBe('terminal')
  })
})

describe('the tabs', () => {
  it('Terminal shows the grid on the terminal last used; a tab shows its pane', async () => {
    const { api, ws, view } = twoTerminals()
    await nextTick()
    const ed = api.openInTesselEditor({ file: 'C:\\p\\a.js', ws })
    const page = api.openInBrowser({ url: 'https://example.com/', ws, newPane: true })
    api.showViewTab(ws, 'terminal')
    expect(view().shown).toBe('terminal')
    expect(ws.activeId).toBe('t2')
    api.showViewTab(ws, page.id)
    expect(view().shown).toBe(page.id)
    api.showViewTab(ws, ed.id)
    expect(view().shown).toBe(ed.id)
    // A pane that is not a tab is not shown as one.
    api.showViewTab(ws, 't1')
    expect(view().shown).toBe(ed.id)
  })

  it('the Terminal tab of a view with no terminal shows the launcher', () => {
    const ed = leaf('ed', { kind: 'editor', files: [], activePath: null })
    const { api, ws, view } = load({ tree: ed, activeId: 'ed' })
    expect(view().shown).toBe('ed')
    expect(api.emptyGridShown(ws)).toBe(false)
    api.showViewTab(ws, 'terminal')
    expect(view().shown).toBe('terminal')
    expect(api.emptyGridShown(ws)).toBe(true)
  })
})

describe('opening a terminal from an editor or a browser tab', () => {
  it('goes to the grid, beside the terminal last used, and the Terminal tab comes up', async () => {
    const { api, ws, view } = twoTerminals()
    await nextTick()
    const ed = api.openInTesselEditor({ file: 'C:\\p\\a.js', ws })
    await nextTick()
    const made = await api.splitLeaf(ed.id, 'col')
    expect(view().shown).toBe('terminal')
    expect(ws.activeId).toBe(made.id)
    // t2 (last used) was split, below it; the editor is still a tab.
    expect(view().grid.children.map((c) => (c.type === 'leaf' ? c.id : c.children.map((x) => x.id)))).toEqual(['t1', ['t2', made.id]])
    expect(view().tabs.map((l) => l.id)).toEqual([ed.id])
    // Back to the editor: still there, as it was.
    api.showViewTab(ws, ed.id)
    expect(view().shown).toBe(ed.id)
  })

  it('a grid with no terminal: the new one has the grid to itself', async () => {
    const ed = leaf('ed', { kind: 'editor', files: [], activePath: null })
    const { api, ws, view } = load({ tree: ed, activeId: 'ed' })
    const made = await api.splitLeaf('ed', 'col')
    expect(view().grid).toBe(made)
    expect(view().tabs.map((l) => l.id)).toEqual(['ed'])
    expect(view().shown).toBe('terminal')
    expect(ws.activeId).toBe(made.id)
  })

  it("from a task copy's tab: in that copy's grid", async () => {
    const ed = leaf('ed', { kind: 'editor', files: [], activePath: null, viewPath: 'C:\\wt' })
    const tree = reactive({ type: 'split', id: 'root', dir: 'row', sizes: [50, 50], children: [leaf('t1'), ed] })
    const { api, ctx, view } = load({ tree, activeId: 'ed' })
    const made = await api.splitLeaf('ed', 'col', null, 'pwsh', null, { inheritView: true })
    expect(ctx.createLeaf.mock.calls[0][3]).toEqual({ path: 'C:\\wt', branch: '' })
    expect(view().key).toBe('c:/wt')
    expect(view().grid).toBe(made)
  })
})

describe('closing and going to a pane', () => {
  it('closing the editor on screen goes back to Terminal, on the terminal last used', async () => {
    const { api, ws, view } = twoTerminals()
    await nextTick()
    const page = api.openInBrowser({ url: 'https://example.com/', ws, newPane: true, activate: false })
    const ed = api.openInTesselEditor({ file: 'C:\\p\\a.js', ws })
    api.closeLeaf(ed.id)
    expect(view().shown).toBe('terminal')
    expect(ws.activeId).toBe('t2')
    expect(view().tabs.map((l) => l.id)).toEqual([page.id])
    // A tab closed while another shows: nothing moves.
    api.showViewTab(ws, page.id)
    const other = api.openInTesselEditor({ file: 'C:\\p\\b.js', ws })
    api.showViewTab(ws, page.id)
    api.closeLeaf(other.id)
    expect(view().shown).toBe(page.id)
  })

  it('going to a pane from elsewhere (sidebar, notification) shows its tab', async () => {
    const { api, ctx, ws, view } = twoTerminals()
    const ed = api.openInTesselEditor({ file: 'C:\\p\\a.js', ws })
    api.focusPane('t1')
    expect(view().shown).toBe('terminal')
    expect(ws.activeId).toBe('t1')
    // The terminal gets the keyboard once its tab is up.
    await nextTick()
    expect(ctx.focusActiveInput).toHaveBeenCalled()
    api.focusPane(ed.id)
    expect(view().shown).toBe(ed.id)
  })

  it('full screen stays in the grid: an editor tab never takes it and is never covered by it', () => {
    const { api, ctx, ws, view } = twoTerminals()
    ctx.maximizedId.value = 't1'
    const ed = api.openInTesselEditor({ file: 'C:\\p\\a.js', ws })
    expect(ctx.maximizedId.value).toBe('t1')
    api.focusPane(ed.id)
    expect(ctx.maximizedId.value).toBe('t1')
    api.toggleMaximize(ed.id)
    expect(ctx.maximizedId.value).toBe('t1')
    api.showViewTab(ws, 'terminal')
    expect(view().shown).toBe('terminal')
    expect(ctx.maximizedId.value).toBe('t1')
  })
})
