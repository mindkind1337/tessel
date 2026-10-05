// A web page moved between the pane grid and the right side panel (App.vue):
// a browser pane dragged by its header onto the side panel becomes one of its
// web tabs (the ones its + opens), a web tab dragged from the panel's tab bar
// onto the grid becomes a browser pane at the drop zone shown. The page keeps
// its address, title and zoom. Its <webview> cannot follow: Electron loads a
// page again whenever its element changes parent, and the panel's pages live
// in their tab, not in the grid's page layer (pageHost.js). So the page opens
// again on its address (its back/forward history and scroll start afresh).
//
// It gets a new id each way: a grid page (pane-…) and a panel page (web-…)
// are named apart, and the agents' browser tools (agentBrowserTargets.js)
// address grid pages by id. A page an agent drove is released by the move:
// in the panel no agent may drive it (its id is gone from their lists and its
// old view is destroyed, which ends the agent's hold on it in the main
// process); back in the grid it is a new page, opened by no agent.

import { clampZoom } from './browserPage'

// Where a pane under the pointer takes the dragged one: its middle swaps the
// two; near a side, that side. center: false (a page from the side panel,
// nothing to swap with): always the nearest side.
// fx, fy: the pointer's place in the pane, 0..1.
export function paneDropZone(fx, fy, { center = true } = {}) {
  const inner = fx >= 0.3 && fx <= 0.7 && fy >= 0.3 && fy <= 0.7
  if (center && inner) return 'center'
  const d = { left: fx, right: 1 - fx, top: fy, bottom: 1 - fy }
  return Object.keys(d).reduce((a, b) => (d[a] <= d[b] ? a : b))
}

// `leaf` placed in `tree` (a new tree; `tree` itself is not changed):
//   { kind: 'pane', id, zone }  beside pane `id` (left/right/top/bottom)
//   { kind: 'edge', zone }      along that whole side of the grid
//   { kind: 'ws' }              to the right of `anchorId` (the workspace's
//                               active pane), or alone in an empty grid
// makeSplit(dir, children, sizes) -> a split node.
// -> the new tree, or null when the target pane is not in it.
export function placeLeaf(tree, target, leaf, { anchorId = null, makeSplit }) {
  if (!tree) return leaf
  if (target.kind === 'edge') {
    const dir = target.zone === 'left' || target.zone === 'right' ? 'row' : 'col'
    const before = target.zone === 'left' || target.zone === 'top'
    return makeSplit(dir, before ? [leaf, tree] : [tree, leaf], before ? [35, 65] : [65, 35])
  }
  const id = target.kind === 'ws' ? anchorId : target.id
  const zone = target.kind === 'ws' ? 'right' : target.zone
  const dir = zone === 'left' || zone === 'right' ? 'row' : 'col'
  const before = zone === 'left' || zone === 'top'
  let found = false
  const walk = (node) => {
    if (node.type === 'leaf') {
      if (node.id !== id) return node
      found = true
      return makeSplit(dir, before ? [leaf, node] : [node, leaf], [50, 50])
    }
    const children = node.children.map(walk)
    return children.some((c, i) => c !== node.children[i]) ? { ...node, children } : node
  }
  const next = walk(tree)
  return found ? next : null
}

// The title worth keeping: the page's own, not the pane's default name.
function keptTitle(title, defaultTitle) {
  const s = typeof title === 'string' ? title.trim() : ''
  return s && s !== defaultTitle ? s.slice(0, 200) : ''
}

// A browser pane of the grid -> a side panel page ({ id, url, title, zoom }).
// url: what the pane shows (BrowserPane keeps node.url up to date); a blank
// page stays blank (the panel's + pages start with '').
export function sidePageFromLeaf(leaf, id, { blankUrl = 'about:blank', defaultTitle = '' } = {}) {
  const url = typeof leaf.url === 'string' && leaf.url !== blankUrl ? leaf.url : ''
  return { id, url, title: keptTitle(leaf.title, defaultTitle), zoom: clampZoom(leaf.zoom || 0) }
}

// A side panel page -> a browser pane: makeLeaf(url) builds it
// (App's makeBrowserLeaf: a new id, its address checked again).
export function leafFromSidePage(page, makeLeaf) {
  const leaf = makeLeaf(page.url || undefined)
  const title = keptTitle(page.title, '')
  if (title) leaf.title = title
  leaf.zoom = clampZoom(page.zoom || 0)
  // Stays out of the agents' count of the pages they opened.
  delete leaf.openedBy
  return leaf
}

// --- Saved with the layout -----------------------------------------------------------------
export const SIDE_BROWSER_ID = /^web-[a-z0-9]{1,16}$/

// The side panel's pages to save.
export function saveSideBrowsers(list) {
  return (list || []).map((b) => ({ id: b.id, url: b.url || '', title: b.title || '', zoom: clampZoom(b.zoom || 0) }))
}

// The saved pages -> the panel's pages (unknown or repeated ids dropped).
export function restoreSideBrowsers(list) {
  if (!Array.isArray(list)) return []
  const out = []
  for (const b of list.slice(0, 50)) {
    if (!b || typeof b.id !== 'string' || !SIDE_BROWSER_ID.test(b.id) || out.some((o) => o.id === b.id)) continue
    out.push({
      id: b.id,
      url: typeof b.url === 'string' ? b.url : '',
      title: typeof b.title === 'string' ? b.title : '',
      zoom: clampZoom(b.zoom || 0)
    })
  }
  return out
}

// A new side page id, unlike the ones in `taken` (ids or { id }).
export function newSidePageId(taken = [], random = Math.random) {
  const ids = new Set(taken.map((x) => (typeof x === 'string' ? x : x && x.id)))
  let id
  do id = 'web-' + random().toString(36).slice(2, 10) // i18n-ignore
  while (ids.has(id) || !SIDE_BROWSER_ID.test(id))
  return id
}
