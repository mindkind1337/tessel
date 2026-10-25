// A project's panes are shown one copy at a time: the project folder's panes
// in one grid, each task copy's (git worktree's) in its own, like the cards
// of the left sidebar (sidebarModel.js buildProjectCards). The panes all stay
// in the workspace's single tree; a view is the part of it that belongs to
// one copy. Pure functions: App picks the view, PaneGrid draws its grid.
// In a view, the editor and browser panes are not in the grid: each is a tab
// of its own above it (ViewTabs.vue: Terminal | Editor | Browser), shown
// alone in the whole room; the Terminal tab is the grid of the others.

function normPath(p) {
  return String(p || '')
    .replace(/[\\/]+$/, '')
    .replace(/\\/g, '/')
    .toLowerCase()
}

// The copy a pane belongs to: its own (leaf.worktree), or the one it was
// opened in (leaf.viewPath: an editor, a browser, a resumed session).
export function leafViewPath(leaf) {
  if (!leaf) return ''
  return (leaf.worktree && leaf.worktree.path) || leaf.viewPath || ''
}

// A pane's view: '' for the project folder, else its copy's folder (compared
// as paths are: case and slashes aside).
export function viewKey(leaf, cwd) {
  const key = normPath(leafViewPath(leaf))
  return key && key !== normPath(cwd) ? key : ''
}

function eachLeaf(node, fn) {
  if (!node) return
  if (node.type === 'leaf') fn(node)
  else node.children.forEach((c) => eachLeaf(c, fn))
}

// A tree's views: [{ key, ids }] (ids: a Set of its panes' ids), the project
// folder's first, then each copy's by its folder. Never in tree order: a
// change of the tree (a pane split, a grid tiled again) never reorders the
// views, whose layers are keyed in the page (App.vue): a layer moved there
// reloads its pages and loses the keyboard.
export function treeViews(tree, cwd) {
  const byKey = new Map()
  eachLeaf(tree, (leaf) => {
    const key = viewKey(leaf, cwd)
    let view = byKey.get(key)
    if (!view) byKey.set(key, (view = { key, ids: new Set() }))
    view.ids.add(leaf.id)
  })
  return [...byKey.values()].sort((a, b) => (a.key === b.key ? 0 : !a.key ? -1 : !b.key ? 1 : a.key < b.key ? -1 : 1))
}

// The view on screen: the active pane's (the first view when none is).
export function activeViewKey(views, activeId) {
  const view = views.find((v) => v.ids.has(activeId)) || views[0]
  return view ? view.key : ''
}

// The tree with only the panes `keep` accepts: a split left with one child
// becomes that child, the others keep their share of the room. A split that
// keeps all its children is itself (its sizes stay live); one that lost some
// is a copy that knows its source (writeViewSizes). null when nothing is kept.
export function pruneTree(node, keep) {
  if (!node) return null
  if (node.type === 'leaf') return keep(node) ? node : null
  const kept = []
  node.children.forEach((c, i) => {
    const k = pruneTree(c, keep)
    if (k) kept.push({ node: k, index: i })
  })
  if (!kept.length) return null
  if (kept.length === 1) return kept[0].node
  if (kept.length === node.children.length && kept.every((k, i) => k.node === node.children[i])) return node
  const size = (i) => (node.sizes && node.sizes[i]) || 0
  const total = kept.reduce((t, k) => t + size(k.index), 0)
  return {
    ...node,
    children: kept.map((k) => k.node),
    sizes: kept.map((k) => (total > 0 ? (size(k.index) / total) * 100 : 100 / kept.length)),
    source: node,
    sourceIndexes: kept.map((k) => k.index)
  }
}

// A divider moved in a view's copy of a split: the source split's panes of
// that view take the new shares (of the room they had together), the others
// keep theirs.
export function writeViewSizes(node) {
  const src = node && node.source
  if (!src || !Array.isArray(node.sourceIndexes)) return
  const sizes = src.sizes ? src.sizes.slice() : src.children.map(() => 100 / src.children.length)
  const room = node.sourceIndexes.reduce((t, i) => t + (sizes[i] || 0), 0)
  const own = node.sizes.reduce((t, n) => t + n, 0)
  if (!(room > 0) || !(own > 0)) return
  node.sourceIndexes.forEach((i, k) => (sizes[i] = (node.sizes[k] / own) * room))
  src.sizes = sizes
}

// --- Tabs above the grid ----------------------------------------------------------
// An editor or a browser pane: a tab of its own. It stays in the workspace's
// tree (saved, listed and closed as before); where it sits there changes
// nothing on screen. A Live Share host's browser page on a guest's screen
// (liveShareWindowFeeds.js pageLeaf) is a tab too, as it is on the host's.
export const isLiveSharePage = (leaf) => !!leaf && leaf.backend === 'liveshare' && !!leaf.liveShare && leaf.liveShare.page === true
export function isTabLeaf(leaf) {
  return !!leaf && leaf.type === 'leaf' && (leaf.kind === 'editor' || leaf.kind === 'browser' || isLiveSharePage(leaf))
}

// The tab a view shows ({ ids, grid, tabs }): 'terminal' (its grid) or the id
// of one of its tab panes. The active pane is always on screen: its own tab,
// or the grid for a terminal or an agent. ws.view keeps the Terminal tab
// chosen by hand in a view whose grid is empty (the launcher shows there),
// and the tab of a view that is not on screen.
export function shownTab(ws, view) {
  const ids = view.tabs.map((l) => l.id)
  if (ws.activeId && view.ids.has(ws.activeId)) {
    if (!ids.includes(ws.activeId)) return 'terminal'
    return ws.view === 'terminal' && !view.grid ? 'terminal' : ws.activeId
  }
  return ids.includes(ws.view) ? ws.view : 'terminal'
}

// The tree with a new tab pane beside it all: the grid is not split (it is
// the same tree, with all its room). makeSplit(dir, children, sizes).
export function addTabLeaf(tree, leaf, makeSplit) {
  return tree ? makeSplit('row', [tree, leaf], [50, 50]) : leaf
}

// The terminal or agent a pane opened from a tab goes beside, in the tab's
// grid (its copy's): the last one made active there (ws.gridId), else the
// first one. null when that grid has none.
export function gridLeafFor(ws, from) {
  if (!ws || !ws.tree) return null
  const key = viewKey(from, ws.cwd)
  let first = null
  let last = null
  eachLeaf(ws.tree, (leaf) => {
    if (isTabLeaf(leaf) || viewKey(leaf, ws.cwd) !== key) return
    if (!first) first = leaf
    if (leaf.id === ws.gridId) last = leaf
  })
  return last || first
}

// What the workspace shows: a layer per view ({ key, tree, grid, tabs, shown,
// active }), the active pane's view on screen. tree: the view's panes (one
// view: the tree as it is); grid: its terminals and agents (the Terminal
// tab; null when it has none); tabs: its editor and browser panes, in tree
// order; shown: the tab on screen (shownTab).
export function workspaceViews(ws) {
  if (!ws || !ws.tree) return []
  const views = treeViews(ws.tree, ws.cwd)
  const active = activeViewKey(views, ws.activeId)
  return views.map((v) => {
    const tabs = []
    eachLeaf(ws.tree, (leaf) => v.ids.has(leaf.id) && isTabLeaf(leaf) && tabs.push(leaf))
    // One pass over the tree: a divider moved in the grid writes back to the
    // tree's own split (writeViewSizes).
    const grid = pruneTree(ws.tree, (leaf) => v.ids.has(leaf.id) && !isTabLeaf(leaf))
    return {
      key: v.key || ':main',
      tree: views.length === 1 ? ws.tree : pruneTree(ws.tree, (leaf) => v.ids.has(leaf.id)),
      grid,
      tabs,
      shown: shownTab(ws, { ids: v.ids, grid, tabs }),
      active: v.key === active
    }
  })
}
