// Auto-tile (paneGrid.js, App.vue, PaneGrid.vue): a new pane lays out the
// panes of its grid again as an equal grid, as square as the room allows; a
// grid arranged by hand keeps its shape; closing a pane of a tiled grid tiles
// again; each task copy's grid is tiled on its own; the setting off, a Live
// Share guest's screen and a split asked in a direction leave the layout
// alone. The grid draws every pane in one flat list, so tiling never mounts a
// pane again. Run on App.vue's own code.
import { describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import vm from 'vm'
import { join } from 'path'
import { computed, defineComponent, h, nextTick, reactive, ref } from 'vue'
import { mount } from '@vue/test-utils'
import * as paneViews from '../paneViews'
import * as paneGrid from '../paneGrid'
import PaneGrid from '../components/PaneGrid.vue'

// A pane of the grid: its mounts counted (globalThis.__paneMounts).
vi.mock('../components/SplitNode.vue', async () => {
  const { defineComponent: define, h: render, onMounted } = await import('vue')
  return {
    default: define({
      name: 'SplitNode',
      props: { node: Object },
      setup(props) {
        onMounted(() => {
          const m = (globalThis.__paneMounts = globalThis.__paneMounts || {})
          m[props.node.id] = (m[props.node.id] || 0) + 1
        })
        return () => render('div', { class: 'pane', 'data-pane-id': props.node.id })
      }
    })
  }
})

const source = fs.readFileSync(join(process.cwd(), 'src/renderer/src/App.vue'), 'utf8').replace(/\r\n/g, '\n')
function slice(from, to) {
  const a = source.indexOf(from)
  const b = source.indexOf(to, a)
  if (a < 0 || b < 0) throw new Error(`App.vue changed: ${from}`)
  return source.slice(a, b)
}
function fnSource(head) {
  const start = source.indexOf(head)
  const end = source.indexOf('\n}\n', start)
  if (start < 0 || end < 0) throw new Error(`App.vue changed: ${head}`)
  return source.slice(start, end + 2)
}

const leaf = (id, extra = {}) => reactive({ type: 'leaf', id, kind: 'shell', ...extra })
const ids = (node) => (node.type === 'leaf' ? [node.id] : node.children.flatMap(ids))
// The rows of a tiled tree: [2, 1] = two panes above one.
const shape = (node) => (node.type === 'leaf' ? [1] : node.dir === 'row' ? [node.children.length] : node.children.map((c) => (c.type === 'leaf' ? 1 : c.children.length)))
const WT = 'C:\\p-copies\\fix'
const inCopy = (id) => leaf(id, { worktree: { path: WT, branch: 'fix' } })

function load({ tree, settings = {}, guest = false, room = { w: 2000, h: 1500 }, gridModes, more = [] } = {}) {
  const workspaces = ref([])
  let n = 0
  const ctx = {
    ...paneViews,
    ...paneGrid,
    computed,
    reactive,
    refitSoon: vi.fn(),
    workspaces,
    currentWsId: ref('ws1'),
    maximizedId: ref(null),
    newId: (p) => `${p}-${++n}`,
    settings: reactive({ confirmCloseAgent: false, tileNewPanes: true, ...settings }),
    hasNoTerminal: () => false,
    liveShare: { notHere: vi.fn(), isGuestWs: () => guest, isGuestLeaf: () => false, state: { guest: { state: 'off' } } },
    createLeaf: vi.fn(async (_shell, _agent, _cwd, worktree) => leaf(`pane-new${++n}`, worktree ? { worktree } : {})),
    wsLeafOpts: (_ws, opts = {}) => opts,
    selectedShell: ref('pwsh'),
    showActive: vi.fn((ws, id) => (ws.activeId = id)),
    dirtyEditorPaths: () => [],
    releaseOwner: vi.fn(),
    isAgentLeaf: () => false,
    chatStatus: {},
    chatBackground: {},
    dropBuffer: vi.fn(),
    forgetTerminal: vi.fn(),
    agentTerminalTargets: { forget: vi.fn(), touch: vi.fn() },
    clearAgentStatus: vi.fn(),
    refillEmptiedWorkspace: vi.fn(),
    pruneTeams: vi.fn(),
    teamById: () => null,
    gridReturnLeaf: () => null,
    scheduleSave: vi.fn(),
    showToast: vi.fn(),
    selectWorkspace: vi.fn(),
    placeLeaf: vi.fn(),
    mapLeaves: (tree) => tree,
    t: (_k, d) => d,
    CSS: { escape: (s) => s },
    document: { querySelector: () => ({ clientWidth: room.w, clientHeight: room.h }) },
    window: { shellApi: { killPty: vi.fn() } }
  }
  vm.createContext(ctx)
  vm.runInContext(
    'const makeSplit = (dir, children, sizes) => reactive({ type: "split", id: newId("split"), dir, sizes, children })\n' +
      'const wsById = (id) => workspaces.value.find((w) => w.id === id) || null\n' +
      slice('function replaceNode(node, targetId, make) {', '// --- Workspace persistence') +
      fnSource('function findLeaf(id) {') +
      fnSource('function detachLeaf(ws, leafId) {') +
      slice('function movePane(srcId, target) {', 'const makeSplit') +
      slice('function largestLeaf(', '// Reviews a lead had not done yet') +
      slice('// --- Auto-tile (paneGrid.js)', '// Settings > Git and > General') +
      slice('function closeLeaf(leafId, opts = {})', '// Arrange the workspace as an even grid') +
      '\nthis.api = { splitLeaf, closeLeaf, arrangePanes, canArrangePanes, tileWorkspace, movePane }',
    ctx
  )
  const ws = reactive({ id: 'ws1', name: 'p', cwd: 'C:\\p', tree, activeId: null, remote: null, ...(gridModes ? { gridModes } : {}) })
  workspaces.value.push(ws, ...more)
  return { api: ctx.api, ctx, ws }
}

const equalRow = (...ls) => reactive({ type: 'split', id: 'r' + ls[0].id, dir: 'row', sizes: ls.map(() => 100 / ls.length), children: ls })

describe('the grid shape', () => {
  it('picks rows and columns from the room, as square as it allows', () => {
    // Two panes side by side, in a wide room and in a squarer one.
    expect(paneGrid.gridShape(2, 2000, 1500)).toEqual([2])
    expect(paneGrid.gridShape(2, 1400, 900)).toEqual([2])
    expect(paneGrid.gridShape(3, 2400, 900)).toEqual([3])
    expect(paneGrid.gridShape(3, 2000, 1500)).toEqual([2, 1])
    expect(paneGrid.gridShape(4, 2000, 1500)).toEqual([2, 2])
    expect(paneGrid.gridShape(6, 1400, 900)).toEqual([3, 3])
    expect(paneGrid.gridShape(9, 2000, 1500)).toEqual([3, 3, 3])
    expect(paneGrid.gridShape(5, 1400, 900)).toEqual([3, 2])
    // A tall room stacks.
    expect(paneGrid.gridShape(2, 900, 1400)).toEqual([1, 1])
  })
  it('keeps every row within one pane of the others and every pane placed', () => {
    for (const [w, h] of [[2000, 1500], [1400, 900], [900, 1200], [3000, 800]])
      for (let n = 1; n <= 16; n++) {
        const rows = paneGrid.gridShape(n, w, h)
        expect(rows.reduce((a, b) => a + b, 0)).toBe(n)
        expect(Math.max(...rows) - Math.min(...rows)).toBeLessThanOrEqual(1)
      }
  })
  it('keeps a cell as wide as usable when it can', () => {
    const rows = paneGrid.gridShape(9, 1100, 1200)
    expect(1100 / Math.max(...rows)).toBeGreaterThanOrEqual(paneGrid.MIN_CELL_WIDTH)
  })
  it('builds equal shares in order', () => {
    const make = (dir, children, sizes) => ({ type: 'split', id: 'new-' + dir + children.length, dir, sizes, children })
    const ls = [1, 2, 3, 4, 5].map((i) => ({ type: 'leaf', id: 'p' + i }))
    const tree = paneGrid.buildGridTree(ls, [3, 2], make)
    expect(tree.dir).toBe('col')
    expect(tree.sizes).toEqual([50, 50])
    expect(tree.children[0].sizes.every((s) => Math.abs(s - 100 / 3) < 1e-9)).toBe(true)
    expect(tree.children[1].sizes).toEqual([50, 50])
    expect(ids(tree)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5'])
  })
  it('knows a grid from a hand-made layout', () => {
    const a = { type: 'leaf', id: 'a' }
    const b = { type: 'leaf', id: 'b' }
    const c = { type: 'leaf', id: 'c' }
    expect(paneGrid.isNearGrid(a)).toBe(true)
    expect(paneGrid.isNearGrid({ type: 'split', dir: 'row', sizes: [50, 50], children: [a, b] })).toBe(true)
    expect(paneGrid.isNearGrid({ type: 'split', dir: 'row', sizes: [30, 70], children: [a, b] })).toBe(false)
    // One tall pane beside two stacked: not a grid.
    expect(paneGrid.isNearGrid({ type: 'split', dir: 'row', sizes: [50, 50], children: [a, { type: 'split', dir: 'col', sizes: [50, 50], children: [b, c] }] })).toBe(false)
    expect(paneGrid.isNearGrid({ type: 'split', dir: 'col', sizes: [50, 50], children: [{ type: 'split', dir: 'row', sizes: [50, 50], children: [a, b] }, c] })).toBe(true)
  })
  it('reads the grid modes of a saved layout, and the one flag of the version before', () => {
    expect(paneGrid.savedGridModes({ gridModes: { '': 'manual', 'c:/x': 'tiled', 'c:/y': 'odd' } })).toEqual({ '': 'manual', 'c:/x': 'tiled' })
    expect(paneGrid.savedGridModes({ manualSizes: true })).toEqual({ '': 'manual' })
    expect(paneGrid.savedGridModes({ manualSizes: false })).toEqual({ '': 'tiled' })
    expect(paneGrid.savedGridModes({})).toEqual({})
    expect(paneGrid.savedGridModes({ gridModes: ['manual'] })).toEqual({})
  })
})

describe('where each pane sits (gridLayout)', () => {
  it('places panes and dividers by the shares, the dividers counted in thicknesses', () => {
    const a = { type: 'leaf', id: 'a' }
    const b = { type: 'leaf', id: 'b' }
    const c = { type: 'leaf', id: 'c' }
    const tree = { type: 'split', id: 'root', dir: 'col', sizes: [50, 50], children: [{ type: 'split', id: 'top', dir: 'row', sizes: [25, 75], children: [a, b] }, c] }
    const { tiles, dividers } = paneGrid.gridLayout(tree)
    expect(tiles.map((t) => t.leaf.id)).toEqual(['a', 'b', 'c'])
    const [ta, tb, tc] = tiles.map((t) => t.rect)
    // a: a quarter of the width less a quarter of the divider; half the height less half a divider.
    expect(ta.w).toEqual({ p: 25, d: -0.25 })
    expect(ta.h).toEqual({ p: 50, d: -0.5 })
    expect(tb.x).toEqual({ p: 25, d: 0.75 })
    expect(tc.y).toEqual({ p: 50, d: 0.5 })
    expect(tc.w).toEqual({ p: 100, d: 0 })
    expect(dividers.map((d) => d.key)).toEqual(['top:0', 'root:0'])
    expect(paneGrid.cssLength(tb.x)).toBe('calc(25% + 0.75 * var(--divider-thickness, 3px))')
    expect(paneGrid.cssLength(tc.w)).toBe('100%')
    expect(paneGrid.pxLength(tb.x, 1000, 4)).toBe(253)
  })
})

describe('tiling a tree (tileTree)', () => {
  const make = (dir, children, sizes) => ({ type: 'split', id: 'n', dir, sizes, children })
  it('lays out one grid again in the place of its first pane; the rest (another copy, the tabs) keeps its shape and place', () => {
    const a = leaf('a')
    const b = leaf('b')
    const x = inCopy('x')
    const y = inCopy('y')
    const ed = leaf('ed', { kind: 'editor' })
    const copy = { type: 'split', id: 'copy', dir: 'col', sizes: [30, 70], children: [x, y] }
    const tree = { type: 'split', id: 'root', dir: 'row', sizes: [40, 30, 30], children: [{ type: 'split', id: 'main', dir: 'row', sizes: [80, 20], children: [a, b] }, copy, ed] }
    const inMain = (l) => !paneViews.isTabLeaf(l) && paneViews.viewKey(l, 'C:\\p') === ''
    const next = paneGrid.tileTree(tree, { inView: inMain, extra: leaf('c'), room: { w: 2000, h: 1500 }, makeSplit: make })
    expect(next.id).toBe('root')
    expect(next.sizes).toEqual([40, 30, 30])
    expect(ids(next.children[0])).toEqual(['a', 'b', 'c'])
    expect(shape(next.children[0])).toEqual([2, 1])
    // The copy's grid is the same object (its own shares), the editor tab still after it.
    expect(next.children[1]).toBe(copy)
    expect(next.children[2]).toBe(ed)
    // A grid with no pane yet goes after it all.
    const first = paneGrid.tileTree(tree, { inView: () => false, extra: leaf('z'), room: { w: 2000, h: 1500 }, makeSplit: make })
    expect(first.children[0]).toBe(tree)
    expect(first.children[1].id).toBe('z')
  })
  it('keeps the grid modes of the grids that still have panes, and manualSizes for the version before', () => {
    const tree = { type: 'split', id: 's', dir: 'row', sizes: [50, 50], children: [leaf('a'), inCopy('x')] }
    const ws = { cwd: 'C:\\p', tree, gridModes: { '': 'manual', 'c:/p-copies/fix': 'tiled', 'c:/gone': 'manual' } }
    expect(paneGrid.gridModeFields(ws)).toEqual({ gridModes: { '': 'manual', 'c:/p-copies/fix': 'tiled' }, manualSizes: true })
    expect(paneGrid.gridModeFields({ ...ws, gridModes: { 'c:/p-copies/fix': 'tiled' } })).toEqual({ gridModes: { 'c:/p-copies/fix': 'tiled' } })
    expect(paneGrid.gridModeFields({ ...ws, gridModes: { 'c:/gone': 'manual' } })).toEqual({})
    // Read back as saved.
    expect(paneGrid.savedGridModes(paneGrid.gridModeFields(ws))).toEqual({ '': 'manual', 'c:/p-copies/fix': 'tiled' })
  })
  it('without the panes taken out, the others keep their share (as removeLeaf)', () => {
    const t = { type: 'split', id: 's', dir: 'row', sizes: [20, 30, 50], children: [leaf('a'), leaf('b'), leaf('c')] }
    const rest = paneGrid.withoutLeaves(t, new Set(['a']))
    expect(rest.sizes).toEqual([37.5, 62.5])
    expect(paneGrid.withoutLeaves(t, new Set(['a', 'b', 'c']))).toBe(null)
    expect(paneGrid.withoutLeaves(t, new Set(['z']))).toBe(t)
  })
})

describe('adding a pane', () => {
  it('tiles: the new pane is last and every pane has the same room', async () => {
    const { api, ws } = load({ tree: equalRow(leaf('a'), leaf('b')), gridModes: { '': 'tiled' } })
    const made = await api.splitLeaf('b', 'row')
    expect(ids(ws.tree)).toEqual(['a', 'b', made.id])
    expect(shape(ws.tree)).toEqual([2, 1])
    expect(ws.gridModes['']).toBe('tiled')
    expect(ws.activeId).toBe(made.id)
  })
  it('five panes in a squarer room become 3 + 2, then six 3 + 3', async () => {
    const { api, ws } = load({ tree: equalRow(leaf('a'), leaf('b'), leaf('c'), leaf('d')), room: { w: 1400, h: 900 }, gridModes: { '': 'tiled' } })
    await api.splitLeaf('a', 'row')
    expect(shape(ws.tree)).toEqual([3, 2])
    await api.splitLeaf('a', 'row')
    expect(shape(ws.tree)).toEqual([3, 3])
  })
  it('a single pane and a new one: side by side', async () => {
    const { api, ws } = load({ tree: leaf('a'), room: { w: 1400, h: 900 } })
    await api.splitLeaf('a', 'col')
    expect(shape(ws.tree)).toEqual([2])
  })
  it('a grid arranged by hand keeps its shape: the largest pane is split along its longer side', async () => {
    const tree = reactive({ type: 'split', id: 's', dir: 'row', sizes: [70, 30], children: [leaf('a'), leaf('b')] })
    const { api, ws } = load({ tree, room: { w: 2000, h: 1000 } })
    const made = await api.splitLeaf('b', 'col')
    expect(ws.tree.children[0].type).toBe('split')
    expect(ws.tree.children[0].dir).toBe('row')
    expect(ids(ws.tree)).toEqual(['a', made.id, 'b'])
    expect(ws.tree.sizes).toEqual([70, 30])
  })
  it('the mode decides over a layout that looks like a grid', async () => {
    const { api, ws } = load({ tree: equalRow(leaf('a'), leaf('b')), gridModes: { '': 'manual' } })
    await api.splitLeaf('a', 'row')
    expect(ws.tree.sizes).toEqual([50, 50])
    expect(ws.tree.children.some((c) => c.type === 'split')).toBe(true)
    expect(ws.gridModes['']).toBe('manual')
  })
  it('a grid of one pane tiles whatever was done before', async () => {
    const { api, ws } = load({ tree: leaf('a'), gridModes: { '': 'manual' } })
    await api.splitLeaf('a', 'row')
    expect(shape(ws.tree)).toEqual([2])
    expect(ws.gridModes['']).toBe('tiled')
  })
  it('a split asked in a direction (the pane menu) is made as asked and makes that grid manual', async () => {
    const { api, ws } = load({ tree: equalRow(leaf('a'), leaf('b')), gridModes: { '': 'tiled' } })
    const made = await api.splitLeaf('a', 'col', null, 'pwsh', null, { exact: true })
    expect(ws.tree.children[0].dir).toBe('col')
    expect(ids(ws.tree)).toEqual(['a', made.id, 'b'])
    expect(ws.gridModes['']).toBe('manual')
  })
  it('with the setting off, a pane splits the one asked as before', async () => {
    const { api, ws } = load({ tree: equalRow(leaf('a'), leaf('b')), settings: { tileNewPanes: false }, gridModes: { '': 'tiled' } })
    const made = await api.splitLeaf('b', 'row')
    expect(ws.tree.children[1].type).toBe('split')
    expect(ids(ws.tree)).toEqual(['a', 'b', made.id])
  })
  it("a Live Share guest's screen is not tiled", async () => {
    const { api, ws } = load({ tree: equalRow(leaf('a'), leaf('b')), guest: true })
    const before = JSON.stringify(ws.tree)
    expect(await api.splitLeaf('b', 'row')).toBe(null)
    api.arrangePanes(ws)
    expect(api.canArrangePanes(ws)).toBe(false)
    expect(JSON.stringify(ws.tree)).toBe(before)
  })
  it('a saved layout with no mode tiles only when it already is a grid', async () => {
    const grid = load({ tree: equalRow(leaf('a'), leaf('b')), room: { w: 2000, h: 1500 } })
    await grid.api.splitLeaf('a', 'row')
    expect(shape(grid.ws.tree)).toEqual([2, 1])
    const hand = load({ tree: reactive({ type: 'split', id: 's', dir: 'row', sizes: [80, 20], children: [leaf('a'), leaf('b')] }) })
    await hand.api.splitLeaf('a', 'row')
    expect(hand.ws.gridModes).toBeUndefined()
    expect(hand.ws.tree.sizes).toEqual([80, 20])
  })
  it('editor and browser tabs stay tabs beside the grid', async () => {
    const ed = leaf('ed', { kind: 'editor' })
    const tree = reactive({ type: 'split', id: 'wrap', dir: 'row', sizes: [50, 50], children: [equalRow(leaf('a'), leaf('b')), ed] })
    const { api, ws } = load({ tree, gridModes: { '': 'tiled' } })
    const made = await api.splitLeaf('a', 'row')
    expect(ids(ws.tree.children[0])).toEqual(['a', 'b', made.id])
    expect(ws.tree.children[1].id).toBe('ed')
  })
  it("a task copy's grid is tiled on its own: the project folder's grid, arranged by hand, is untouched", async () => {
    const main = reactive({ type: 'split', id: 'main', dir: 'row', sizes: [70, 30], children: [leaf('a'), leaf('b')] })
    const copy = equalRow(inCopy('x'), inCopy('y'))
    const tree = reactive({ type: 'split', id: 'root', dir: 'row', sizes: [50, 50], children: [main, copy] })
    const { api, ws } = load({ tree, gridModes: { '': 'manual' } })
    const made = await api.splitLeaf('x', 'row', null, 'pwsh', null, { inheritView: true })
    const views = paneViews.workspaceViews(ws)
    const copyView = views.find((v) => v.key !== ':main')
    expect(ids(copyView.grid)).toEqual(['x', 'y', made.id])
    expect(shape(copyView.grid)).toEqual([2, 1])
    // The folder's grid: the same panes and shares, still its own.
    const mainView = views.find((v) => v.key === ':main')
    expect(ids(mainView.grid)).toEqual(['a', 'b'])
    expect(mainView.grid.sizes).toEqual([70, 30])
    expect(ws.gridModes['']).toBe('manual')
    expect(ws.gridModes['c:/p-copies/fix']).toBe('tiled')
  })
})

describe('the views of the task copies', () => {
  it('adding a pane in copy K never reorders the views (their layers are keyed in the page) and leaves the others where they are', async () => {
    const inK = (id) => leaf(id, { worktree: { path: 'C:\\p-copies\\k', branch: 'k' } })
    const inJ = (id) => leaf(id, { worktree: { path: 'C:\\p-copies\\j', branch: 'j' } })
    const tree = reactive({ type: 'split', id: 'root', dir: 'row', sizes: [40, 30, 30], children: [leaf('a'), equalRow(inK('k1'), inK('k2')), inJ('j1')] })
    const { api, ws } = load({ tree })
    const keys = () => paneViews.workspaceViews(ws).map((v) => v.key)
    const before = keys()
    expect(before).toEqual([':main', 'c:/p-copies/j', 'c:/p-copies/k'])
    const made = await api.splitLeaf('k2', 'row', null, 'pwsh', null, { inheritView: true })
    expect(keys()).toEqual(before)
    // K's grid tiled where it was; the folder's pane and J's stay in their places.
    expect(ws.tree.id).toBe('root')
    expect(ws.tree.children[0].id).toBe('a')
    expect(ids(ws.tree.children[1])).toEqual(['k1', 'k2', made.id])
    expect(ws.tree.children[2].id).toBe('j1')
  })
})

describe('arranging, closing and moving', () => {
  it('"Arrange panes in a grid" tiles a hand-made layout, in order, and makes it tiled', () => {
    const tree = reactive({ type: 'split', id: 's', dir: 'row', sizes: [70, 30], children: [leaf('a'), reactive({ type: 'split', id: 't', dir: 'col', sizes: [20, 80], children: [leaf('b'), leaf('c')] })] })
    const { api, ws } = load({ tree, room: { w: 2000, h: 1500 }, gridModes: { '': 'manual' } })
    expect(api.canArrangePanes(ws)).toBe(true)
    api.arrangePanes(ws)
    expect(ws.gridModes['']).toBe('tiled')
    expect(ids(ws.tree)).toEqual(['a', 'b', 'c'])
    expect(shape(ws.tree)).toEqual([2, 1])
  })
  it('one pane is nothing to arrange', () => {
    const { api, ws } = load({ tree: leaf('a') })
    expect(api.canArrangePanes(ws)).toBe(false)
  })
  it('closing a pane of a tiled grid tiles the rest again', () => {
    const { api, ws } = load({ tree: equalRow(leaf('a'), leaf('b'), leaf('c'), leaf('d')), room: { w: 1400, h: 900 }, gridModes: { '': 'tiled' } })
    api.closeLeaf('d')
    expect(ids(ws.tree)).toEqual(['a', 'b', 'c'])
    expect(shape(ws.tree)).toEqual([2, 1])
  })
  it("closing a pane of a hand-made layout leaves the others' shares", () => {
    const tree = reactive({ type: 'split', id: 's', dir: 'row', sizes: [20, 30, 50], children: [leaf('a'), leaf('b'), leaf('c')] })
    const { api, ws } = load({ tree, gridModes: { '': 'manual' } })
    api.closeLeaf('a')
    expect(ws.tree.sizes).toEqual([37.5, 62.5])
  })
  it('a pane dropped on another project joins its grid; its own grid closes up', () => {
    const other = reactive({ id: 'ws2', name: 'q', cwd: 'C:\\q', tree: equalRow(leaf('m'), leaf('n')), activeId: 'm', remote: null, gridModes: { '': 'tiled' } })
    const { api, ws } = load({ tree: equalRow(leaf('a'), leaf('b'), leaf('c')), room: { w: 2000, h: 1500 }, gridModes: { '': 'tiled' }, more: [other] })
    api.movePane('c', { kind: 'ws', id: 'ws2' })
    expect(ids(ws.tree)).toEqual(['a', 'b'])
    expect(ids(other.tree)).toEqual(['m', 'n', 'c'])
    expect(shape(other.tree)).toEqual([2, 1])
    expect(ws.gridModes['']).toBe('tiled')
  })
  it('a pane put at an edge or beside another makes that grid manual; a swap keeps it tiled', () => {
    const { api, ws } = load({ tree: equalRow(leaf('a'), leaf('b'), leaf('c')), gridModes: { '': 'tiled' } })
    api.movePane('a', { kind: 'pane', id: 'b', zone: 'center' })
    expect(ws.gridModes['']).toBe('tiled')
    api.movePane('a', { kind: 'pane', id: 'c', zone: 'left' })
    expect(ws.gridModes['']).toBe('manual')
  })
})

describe('the grid on screen (PaneGrid.vue)', () => {
  it('never mounts a pane again when the panes are tiled again or closed', async () => {
    const mounts = (globalThis.__paneMounts = {})
    let seq = 0
    const make = (dir, children, sizes) => reactive({ type: 'split', id: `s${++seq}`, dir, sizes, children })
    const state = reactive({ tree: null })
    const w = mount(defineComponent({ setup: () => () => (state.tree ? h(PaneGrid, { node: state.tree }) : null) }))
    const all = []
    for (let i = 1; i <= 7; i++) {
      const l = leaf('p' + i)
      all.push(l)
      state.tree = paneGrid.tileTree(state.tree, { inView: () => true, extra: l, room: { w: 1400, h: 900 }, makeSplit: make })
      await nextTick()
    }
    expect(w.findAll('.pane-tile')).toHaveLength(7)
    // 4 + 3 panes: three dividers in the first row, two in the second, one between them.
    expect(w.findAll('.divider')).toHaveLength(6)
    state.tree = paneGrid.tileTree(paneGrid.withoutLeaves(state.tree, new Set(['p3'])), { inView: () => true, room: { w: 1400, h: 900 }, makeSplit: make })
    await nextTick()
    expect(w.findAll('.pane-tile')).toHaveLength(6)
    expect(mounts).toEqual({ p1: 1, p2: 1, p3: 1, p4: 1, p5: 1, p6: 1, p7: 1 })
    // The panes stay in the page in the order they came (none moved in it).
    expect(w.findAll('.pane').map((p) => p.attributes('data-pane-id'))).toEqual(['p1', 'p2', 'p4', 'p5', 'p6', 'p7'])
    w.unmount()
  })
})
