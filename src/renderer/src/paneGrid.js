// Auto-tile: a tab's panes laid out as a regular grid (equal cells), whatever
// the number of panes. Pure functions: App picks the room and the policy,
// these pick the rows and build the tree.
//
// A grid is a column of rows (a split 'col' whose children are rows, a split
// 'row' of panes; a row with one pane is that pane). Panes fill it row by
// row, in their order; the rows share the panes as evenly as they can (the
// longer rows first) and each row's panes share its width equally, so a
// shorter row stretches its panes to the full width.

// Cells a terminal can live in: a bit wider than tall (80-120 columns by
// 25-40 lines), never under about 50 columns or 6 lines when avoidable.
export const TARGET_ASPECT = 1.6
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

// Is a tree (of terminals and agents only) already a grid: a single row, a
// single column, or a column of rows (a pane alone is a row of one), every
// share equal? An older layout without the manualSizes flag tiles only then.
export function isNearGrid(tree) {
  if (!tree) return true
  if (tree.type === 'leaf') return true
  const equal = (node) => {
    const k = node.children.length
    const sizes = node.sizes && node.sizes.length === k ? node.sizes : null
    return !!sizes && sizes.every((s) => near(s, 100 / k))
  }
  if (!equal(tree)) return false
  if (tree.children.every((c) => c.type === 'leaf')) return true
  if (tree.dir !== 'col') return false
  return tree.children.every((c) => c.type === 'leaf' || (c.dir === 'row' && equal(c) && c.children.every((l) => l.type === 'leaf')))
}

// The tree for these panes (leaves, in order) as the rows `counts` say.
// makeSplit(dir, children, sizes) makes a split; `old` (the tree it
// replaces) lends its split ids where its shape allows, so the panes that
// stay in the same row stay mounted (a pane is keyed by its place in the
// tree: moving it to another split mounts it again).
export function buildGridTree(leaves, counts, makeSplit, old = null) {
  if (!leaves.length) return null
  if (leaves.length === 1) return leaves[0]
  const rows = []
  let at = 0
  for (const k of counts) {
    rows.push(leaves.slice(at, at + k))
    at += k
  }
  const reuse = (node, dir) => (node && node.type === 'split' && node.dir === dir ? node.id : null)
  const split = (dir, children, oldNode) => {
    const node = makeSplit(dir, children, children.map(() => 100 / children.length))
    const id = reuse(oldNode, dir)
    if (id) node.id = id
    return node
  }
  if (rows.length === 1) return split('row', rows[0], old)
  const oldRows = old && old.type === 'split' && old.dir === 'col' ? old.children : []
  const rowNodes = rows.map((r, i) => (r.length === 1 ? r[0] : split('row', r, oldRows[i])))
  return split('col', rowNodes, old)
}

// The panes of a tree, left to right and top to bottom.
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

// The part of a workspace's tree that holds its grid: the tree itself, or,
// when editor and browser panes were added beside it (paneViews.js
// addTabLeaf: row [grid, tab]), the child the tabs were added to. null when
// the grid is not one subtree with all the panes and no tab (then it is
// built again whole). isTab(leaf): is it a tab pane?
export function gridRootOf(tree, isTab) {
  if (!tree) return null
  const hasTab = (n) => (n.type === 'leaf' ? isTab(n) : n.children.some(hasTab))
  let node = tree
  while (node.type === 'split' && node.children.some((c) => c.type === 'leaf' && isTab(c))) {
    const rest = node.children.filter((c) => !(c.type === 'leaf' && isTab(c)))
    if (rest.length !== 1) return null
    node = rest[0]
  }
  return hasTab(node) ? null : node
}

// The tree with `target` (a node of it) replaced by `next`: the splits on
// the way keep their ids, so the panes beside it are not mounted again.
export function swapNode(node, target, next) {
  if (node === target) return next
  if (!node || node.type === 'leaf') return node
  return { ...node, children: node.children.map((c) => swapNode(c, target, next)) }
}
