// A project's panes are shown one copy at a time: the project folder's panes
// in one grid, each task copy's (git worktree's) in its own, like the cards
// of the left sidebar (sidebarModel.js buildProjectCards). The panes all stay
// in the workspace's single tree; a view is the part of it that belongs to
// one copy. Pure functions: App picks the view, SplitNode draws it.

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
// folder's first, then each copy's as met.
export function treeViews(tree, cwd) {
  const views = []
  const byKey = new Map()
  eachLeaf(tree, (leaf) => {
    const key = viewKey(leaf, cwd)
    let view = byKey.get(key)
    if (!view) {
      view = { key, ids: new Set() }
      byKey.set(key, view)
      if (key) views.push(view)
      else views.unshift(view)
    }
    view.ids.add(leaf.id)
  })
  return views
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

// What the workspace shows: a layer per view ({ key, tree, active }), the
// active pane's view on screen. One view: the tree as it is.
export function workspaceViews(ws) {
  if (!ws || !ws.tree) return []
  const views = treeViews(ws.tree, ws.cwd)
  const active = activeViewKey(views, ws.activeId)
  return views.map((v) => ({
    key: v.key || ':main',
    tree: views.length === 1 ? ws.tree : pruneTree(ws.tree, (leaf) => v.ids.has(leaf.id)),
    active: v.key === active
  }))
}
