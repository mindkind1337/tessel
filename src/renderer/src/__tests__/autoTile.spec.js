// Auto-tile (paneGrid.js, App.vue): a new pane re-tiles the project's panes
// as an equal grid; a layout arranged by hand is kept; closing a pane of a
// tiled project tiles again; the setting off, a Live Share guest's screen
// and an explicit split leave the layout alone. Run on App.vue's own code.
import { describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import vm from 'vm'
import { join } from 'path'
import { computed, reactive, ref } from 'vue'
import * as paneViews from '../paneViews'
import * as paneGrid from '../paneGrid'

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

function load({ tree, settings = {}, guest = false, room = { w: 2000, h: 1500 } } = {}) {
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
    createLeaf: vi.fn(async () => leaf(`pane-new${++n}`)),
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
    agentTerminalTargets: { forget: vi.fn() },
    clearAgentStatus: vi.fn(),
    refillEmptiedWorkspace: vi.fn(),
    pruneTeams: vi.fn(),
    teamById: () => null,
    gridReturnLeaf: () => null,
    scheduleSave: vi.fn(),
    document: { querySelector: () => ({ clientWidth: room.w, clientHeight: room.h }) },
    window: { shellApi: { killPty: vi.fn() } }
  }
  vm.createContext(ctx)
  vm.runInContext(
    'const makeSplit = (dir, children, sizes) => reactive({ type: "split", id: newId("split"), dir, sizes, children })\n' +
      slice('function replaceNode(node, targetId, make) {', '// --- Workspace persistence') +
      fnSource('function findLeaf(id) {') +
      slice('function largestLeaf(', '// Reviews a lead had not done yet') +
      slice('// --- Auto-tile (paneGrid.js)', '// Settings > Git and > General') +
      slice('function closeLeaf(leafId, opts = {})', '// Arrange the workspace as an even grid') +
      '\nthis.api = { splitLeaf, closeLeaf, arrangePanes, tileWorkspace }',
    ctx
  )
  const ws = reactive({ id: 'ws1', name: 'p', cwd: 'C:\\p', tree, activeId: null, remote: null })
  workspaces.value.push(ws)
  return { api: ctx.api, ctx, ws }
}

const equalRow = (...ls) => reactive({ type: 'split', id: 'r' + ls[0].id, dir: 'row', sizes: ls.map(() => 100 / ls.length), children: ls })

describe('the grid shape', () => {
  it('picks rows and columns from the room: 3 panes are columns in a wide room, 2 + 1 in a squarer one', () => {
    expect(paneGrid.gridShape(3, 2400, 900)).toEqual([3])
    expect(paneGrid.gridShape(3, 2000, 1500)).toEqual([2, 1])
    expect(paneGrid.gridShape(4, 2000, 1500)).toEqual([2, 2])
    expect(paneGrid.gridShape(9, 2000, 1500)).toEqual([3, 3, 3])
    expect(paneGrid.gridShape(5, 1400, 900)).toEqual([3, 2])
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
  it('builds equal shares in order and keeps the ids of the splits that stay', () => {
    const make = (dir, children, sizes) => ({ type: 'split', id: 'new-' + dir + children.length, dir, sizes, children })
    const ls = [1, 2, 3, 4, 5].map((i) => ({ type: 'leaf', id: 'p' + i }))
    const old = { type: 'split', id: 'old-root', dir: 'col', sizes: [50, 50], children: [{ type: 'split', id: 'old-r0', dir: 'row', sizes: [50, 50], children: ls.slice(0, 2) }, ls[2]] }
    const tree = paneGrid.buildGridTree(ls, [3, 2], make, old)
    expect(tree.id).toBe('old-root')
    expect(tree.sizes).toEqual([50, 50])
    expect(tree.children[0].id).toBe('old-r0')
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
})

describe('adding a pane', () => {
  it('tiles: the new pane is last and every pane has the same room', async () => {
    const { api, ws } = load({ tree: equalRow(leaf('a'), leaf('b')) })
    ws.manualSizes = false
    const made = await api.splitLeaf('b', 'row')
    expect(ids(ws.tree)).toEqual(['a', 'b', made.id])
    expect(shape(ws.tree)).toEqual([2, 1])
    expect(ws.manualSizes).toBe(false)
    expect(ws.activeId).toBe(made.id)
  })
  it('keeps the split of the row that stays, so its panes are not mounted again', async () => {
    const { api, ws } = load({ tree: equalRow(leaf('a'), leaf('b'), leaf('c')), room: { w: 3000, h: 800 } })
    ws.manualSizes = false
    await api.splitLeaf('a', 'row')
    // 4 panes in a wide room: still one row, the same split.
    expect(ws.tree.id).toBe('ra')
    expect(ws.tree.children.map((c) => c.id).slice(0, 3)).toEqual(['a', 'b', 'c'])
  })
  it('five panes in a wide room become 3 + 2, then six become 2 + 2 + 2 in a squarer one', async () => {
    const { api, ws } = load({ tree: equalRow(leaf('a'), leaf('b'), leaf('c'), leaf('d')), room: { w: 1400, h: 900 } })
    ws.manualSizes = false
    await api.splitLeaf('a', 'row')
    expect(shape(ws.tree)).toEqual([3, 2])
    await api.splitLeaf('a', 'row')
    expect(shape(ws.tree)).toEqual([2, 2, 2])
  })
  it('a single pane and a new one: side by side in a wide room', async () => {
    const { api, ws } = load({ tree: leaf('a'), room: { w: 1800, h: 800 } })
    await api.splitLeaf('a', 'row')
    expect(shape(ws.tree)).toEqual([2])
  })
  it('a layout arranged by hand is kept: the largest pane is split along its longer side', async () => {
    const tree = reactive({ type: 'split', id: 's', dir: 'row', sizes: [70, 30], children: [leaf('a'), leaf('b')] })
    const { api, ws } = load({ tree, room: { w: 2000, h: 1000 } })
    const made = await api.splitLeaf('b', 'col')
    expect(ws.tree.children[0].type).toBe('split')
    expect(ws.tree.children[0].dir).toBe('row')
    expect(ids(ws.tree)).toEqual(['a', made.id, 'b'])
    expect(ws.tree.sizes).toEqual([70, 30])
  })
  it('manualSizes decides over a layout that looks like a grid', async () => {
    const { api, ws } = load({ tree: equalRow(leaf('a'), leaf('b')) })
    ws.manualSizes = true
    await api.splitLeaf('a', 'row')
    expect(ws.tree.sizes).toEqual([50, 50])
    expect(ws.tree.children.some((c) => c.type === 'split')).toBe(true)
    expect(ws.manualSizes).toBe(true)
  })
  it('an explicit split (the pane menu) is made as asked and makes the layout manual', async () => {
    const { api, ws } = load({ tree: equalRow(leaf('a'), leaf('b')) })
    ws.manualSizes = false
    const made = await api.splitLeaf('a', 'col', null, 'pwsh', null, { exact: true })
    expect(ws.tree.children[0].dir).toBe('col')
    expect(ids(ws.tree)).toEqual(['a', made.id, 'b'])
    expect(ws.manualSizes).toBe(true)
  })
  it('with the setting off, a pane splits the one asked as before', async () => {
    const { api, ws } = load({ tree: equalRow(leaf('a'), leaf('b')), settings: { tileNewPanes: false } })
    ws.manualSizes = false
    const made = await api.splitLeaf('b', 'row')
    expect(ws.tree.children[1].type).toBe('split')
    expect(ids(ws.tree)).toEqual(['a', 'b', made.id])
  })
  it("a Live Share guest's screen is not tiled", async () => {
    const { api, ws } = load({ tree: equalRow(leaf('a'), leaf('b')), guest: true })
    const before = JSON.stringify(ws.tree)
    expect(await api.splitLeaf('b', 'row')).toBe(null)
    api.arrangePanes(ws)
    expect(JSON.stringify(ws.tree)).toBe(before)
  })
  it('a saved layout without the flag tiles only when it already is a grid', async () => {
    const grid = load({ tree: equalRow(leaf('a'), leaf('b')), room: { w: 2000, h: 1500 } })
    await grid.api.splitLeaf('a', 'row')
    expect(shape(grid.ws.tree)).toEqual([2, 1])
    const hand = load({ tree: reactive({ type: 'split', id: 's', dir: 'row', sizes: [80, 20], children: [leaf('a'), leaf('b')] }) })
    await hand.api.splitLeaf('a', 'row')
    expect(hand.ws.manualSizes).toBeUndefined()
    expect(hand.ws.tree.sizes).toEqual([80, 20])
  })
  it('editor and browser tabs stay tabs beside the grid', async () => {
    const ed = leaf('ed', { kind: 'editor' })
    const tree = reactive({ type: 'split', id: 'wrap', dir: 'row', sizes: [50, 50], children: [equalRow(leaf('a'), leaf('b')), ed] })
    const { api, ws } = load({ tree })
    ws.manualSizes = false
    const made = await api.splitLeaf('a', 'row')
    expect(ws.tree.id).toBe('wrap')
    expect(ws.tree.children[1].id).toBe('ed')
    expect(ids(ws.tree.children[0])).toEqual(['a', 'b', made.id])
  })
})

describe('arranging and closing', () => {
  it('"Arrange panes in a grid" tiles a hand-made layout, in order, and clears the flag', () => {
    const tree = reactive({ type: 'split', id: 's', dir: 'row', sizes: [70, 30], children: [leaf('a'), reactive({ type: 'split', id: 't', dir: 'col', sizes: [20, 80], children: [leaf('b'), leaf('c')] })] })
    const { api, ws } = load({ tree, room: { w: 2000, h: 1500 } })
    ws.manualSizes = true
    api.arrangePanes(ws)
    expect(ws.manualSizes).toBe(false)
    expect(ids(ws.tree)).toEqual(['a', 'b', 'c'])
    expect(shape(ws.tree)).toEqual([2, 1])
  })
  it('closing a pane of a tiled project tiles the rest again', () => {
    const { api, ws } = load({ tree: equalRow(leaf('a'), leaf('b'), leaf('c'), leaf('d')), room: { w: 1400, h: 900 } })
    ws.manualSizes = false
    api.closeLeaf('d')
    expect(ids(ws.tree)).toEqual(['a', 'b', 'c'])
    expect(shape(ws.tree)).toEqual([2, 1])
  })
  it("closing a pane of a hand-made layout leaves the others' shares", () => {
    const tree = reactive({ type: 'split', id: 's', dir: 'row', sizes: [20, 30, 50], children: [leaf('a'), leaf('b'), leaf('c')] })
    const { api, ws } = load({ tree })
    ws.manualSizes = true
    api.closeLeaf('a')
    expect(ws.tree.sizes).toEqual([37.5, 62.5])
  })
})
