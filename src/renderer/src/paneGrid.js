// The grid of a view's terminals and agents: where each pane sits on screen
// (gridLayout: PaneGrid.vue draws every pane in one flat list, so a pane
// never mounts again when the tree around it changes), and auto-tile (a new
// pane lays the panes out again as a regular grid of equal cells, whatever
// their number). Pure functions: App picks the room and the policy.
//
// A tiled grid is a column of rows (a split 'col' whose children are rows,
// a split 'row' of panes; a row with one pane is that pane). Panes fill it
// row by row, in their order; the rows share the panes as evenly as they can
// (the longer rows first) and each row's panes share its width equally, so a
// shorter row stretches its panes to the full width.

// Cells as square as the room allows, a little wider than tall (a terminal's
// lines are long), never under about 45 columns or 6 lines when avoidable.
export const TARGET_ASPECT = 1.2
export const MIN_CELL_WIDTH = 360
export const MIN_CELL_HEIGHT = 160

// n panes in `rows` rows: how many in each, the longer rows first
// (5 in 2 rows: [3, 2]).
export function rowCounts(n, rows) {
  const base = Math.floor(n / rows)
  const extra = n % rows
  return Array.from({ length: rows }, (_, i) => base + (i < extra ? 1 : 0))
}

// How well a shape fits a room: lower is better. Each pane is a cell of its
// row (room width / panes of the row, room height / rows): its distance from
// the target aspect (in log, so 2:1 and 1:2 weigh the same), a penalty for a
// cell narrower or lower than usable, and one for the cell sizes differing
// (a stretched last row).
function shapeCost(counts, width, height) {
  const rows = counts.length
  const h = height / rows
  const n = counts.reduce((a, b) => a + b, 0)
  const cells = []
  for (const k of counts) for (let i = 0; i < k; i++) cells.push({ w: width / k, h })
  const meanArea = cells.reduce((s, c) => s + c.w * c.h, 0) / n
  let cost = 0
  for (const c of cells) {
    cost += Math.abs(Math.log(c.w / c.h / TARGET_ASPECT))
    if (c.w < MIN_CELL_WIDTH) cost += 4 * (MIN_CELL_WIDTH / c.w - 1)
    if (c.h < MIN_CELL_HEIGHT) cost += 4 * (MIN_CELL_HEIGHT / c.h - 1)
    cost += 0.5 * Math.abs(Math.log((c.w * c.h) / meanArea))
  }
  return cost / n
}

// The rows for n panes in a room of width x height pixels: the number of
// panes in each row, top to bottom ([2, 1]: two panes above one wide pane).
export function gridShape(n, width, height) {
  if (!(n > 1)) return n === 1 ? [1] : []
  const w = width > 0 ? width : 1600
  const h = height > 0 ? height : 900
  let best = null
  for (let rows = 1; rows <= n; rows++) {
    const counts = rowCounts(n, rows)
    const cost = shapeCost(counts, w, h)
    // Ties go to fewer rows.
    if (!best || cost < best.cost - 1e-9) best = { counts, cost }
  }
  return best.counts
}

const near = (a, b) => Math.abs(a - b) <= 2
const shareOf = (node, i) => {
  const k = node.children.length
  const s = Array.isArray(node.sizes) && node.sizes.length === k ? Number(node.sizes[i]) : NaN
  return Number.isFinite(s) && s > 0 ? s : 100 / k
}

// Is a tree (of terminals and agents only) already a grid: a single row, a
// single column, or a column of rows (a pane alone is a row of one), every
// share equal? A grid with no mode saved (an older layout) tiles only then.
export function isNearGrid(tree) {
  if (!tree || tree.type === 'leaf') return true
  const equal = (node) => node.children.every((_, i) => near(shareOf(node, i), 100 / node.children.length))
  if (!equal(tree)) return false
  if (tree.children.every((c) => c.type === 'leaf')) return true
  if (tree.dir !== 'col') return false
  return tree.children.every((c) => c.type === 'leaf' || (c.dir === 'row' && equal(c) && c.children.every((l) => l.type === 'leaf')))
}

// The tree for these panes (leaves, in order) as the rows `counts` say.
// makeSplit(dir, children, sizes) makes a split.
export function buildGridTree(leaves, counts, makeSplit) {
  if (!leaves.length) return null
  if (leaves.length === 1) return leaves[0]
  const rows = []
  let at = 0
  for (const k of counts) {
    rows.push(leaves.slice(at, at + k))
    at += k
  }
  const split = (dir, children) => makeSplit(dir, children, children.map(() => 100 / children.length))
  if (rows.length === 1) return split('row', rows[0])
  return split('col', rows.map((r) => (r.length === 1 ? r[0] : split('row', r))))
}

// The panes of a tree `keep` accepts, left to right and top to bottom.
export function treeLeaves(tree, keep = () => true) {
  const out = []
  const walk = (n) => {
    if (!n) return
    if (n.type === 'leaf') {
      if (keep(n)) out.push(n)
    } else n.children.forEach(walk)
  }
  walk(tree)
  return out
}

// The tree without the panes whose id is in `ids`: a split left with one
// child becomes that child, the others keep their share of the room (as
// App.vue removeLeaf). Untouched branches are the same objects. null when
// nothing is left.
export function withoutLeaves(node, ids) {
  if (!node) return null
  if (node.type === 'leaf') return ids.has(node.id) ? null : node
  const kept = []
  node.children.forEach((c, i) => {
    const k = withoutLeaves(c, ids)
    if (k) kept.push({ node: k, size: shareOf(node, i) })
  })
  if (!kept.length) return null
  if (kept.length === 1) return kept[0].node
  if (kept.length === node.children.length && kept.every((k, i) => k.node === node.children[i])) return node
  const total = kept.reduce((t, k) => t + k.size, 0)
  return { ...node, children: kept.map((k) => k.node), sizes: kept.map((k) => (k.size / total) * 100) }
}

// The tree with the panes `inView` accepts (one view's terminals and agents)
// laid out again as a grid for a room of room.w x room.h pixels, in their
// order, `extra` (a new pane) last. The rest of the tree (another task
// copy's panes, the editor and browser tabs: each view and tab is drawn on
// its own, paneViews.js) keeps its shape beside it. The panes keep running:
// only the tree changes (PaneGrid.vue keeps every pane mounted).
export function tileTree(tree, { inView, extra = null, room, makeSplit }) {
  const leaves = treeLeaves(tree, inView)
  if (extra) leaves.push(extra)
  if (!leaves.length) return tree
  const grid = buildGridTree(leaves, gridShape(leaves.length, room && room.w, room && room.h), makeSplit)
  const rest = withoutLeaves(tree, new Set(leaves.map((l) => l.id)))
  return rest ? makeSplit('row', [grid, rest], [50, 50]) : grid
}

// A project's grid modes as its saved layout has them ({ [grid key]:
// 'manual' | 'tiled' }), or the one flag a layout of the version before had
// (manualSizes, for the project folder's grid). {} when none.
export function savedGridModes(snap) {
  const out = {}
  const modes = snap && snap.gridModes
  if (modes && typeof modes === 'object' && !Array.isArray(modes)) {
    for (const [key, mode] of Object.entries(modes).slice(0, 64)) if (key.length <= 1024 && (mode === 'manual' || mode === 'tiled')) out[key] = mode
  } else if (snap && typeof snap.manualSizes === 'boolean') out[''] = snap.manualSizes ? 'manual' : 'tiled'
  return out
}

// --- Where each pane sits (PaneGrid.vue) --------------------------------------------
// A length on screen: p percent of the room's side plus d divider
// thicknesses (Settings > Appearance, --divider-thickness), so the room can
// be any size and the dividers any thickness without measuring anything.
// rect: { x, y, w, h }, each { p, d }.
const len = (p, d) => ({ p, d })
const plus = (a, b) => len(a.p + b.p, a.d + b.d)
const times = (a, f) => len(a.p * f, a.d * f)

// tree -> { tiles: [{ leaf, rect }], dividers: [{ key, split, index, dir, rect, splitRect }] }
// in tree order. A split's children share its length minus its dividers by
// their sizes (as flex-grow did); a divider sits between child i and i+1.
export function gridLayout(tree) {
  const tiles = []
  const dividers = []
  const walk = (node, rect, path = 's') => {
    if (!node) return
    if (node.type === 'leaf') {
      tiles.push({ leaf: node, rect })
      return
    }
    const n = node.children.length
    if (!n) return
    const row = node.dir === 'row'
    const total = row ? rect.w : rect.h
    const room = len(total.p, total.d - (n - 1))
    const sum = node.children.reduce((s, _, i) => s + shareOf(node, i), 0)
    let at = row ? rect.x : rect.y
    node.children.forEach((child, i) => {
      const size = times(room, shareOf(node, i) / sum)
      walk(child, row ? { ...rect, x: at, w: size } : { ...rect, y: at, h: size }, `${path}.${i}`)
      at = plus(at, size)
      if (i < n - 1) {
        const line = len(0, 1)
        dividers.push({
          key: `${node.id || path}:${i}`,
          split: node,
          index: i,
          dir: node.dir,
          rect: row ? { ...rect, x: at, w: line } : { ...rect, y: at, h: line },
          splitRect: rect
        })
        at = plus(at, line)
      }
    })
  }
  walk(tree, { x: len(0, 0), y: len(0, 0), w: len(100, 0), h: len(100, 0) })
  return { tiles, dividers }
}

// A length as CSS (calc only when it needs the divider thickness).
export function cssLength({ p, d }) {
  const pct = `${+p.toFixed(4)}%`
  if (Math.abs(d) < 1e-6) return pct
  return `calc(${pct} + ${+d.toFixed(4)} * var(--divider-thickness, 3px))` // i18n-ignore
}
// A length in pixels, for a room of `side` pixels and dividers `thick` wide.
export const pxLength = ({ p, d }, side, thick) => (p / 100) * side + d * thick
