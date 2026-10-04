// Which browser page an agent's browser tools act on (src/main/agentBrowser.js
// asks the window). After Orca's browser command targeting (MIT, Copyright
// (c) 2026 Lovecast Inc.: src/main/runtime/runtime-browser-commands-
// browser-command-target-params.ts and the tab list / create commands): the
// agent's own worktree's page by default, a page it names, or a new one.
//
// The rules:
// - Only an agent pane (a terminal agent or a chat) may drive a page.
// - Only browser panes of its own project and of its own worktree grid
//   (paneViews.js): never another project's, never the side panel's pages.
// - "Let agents use the browser" off: nothing.
// - A new page opens next to the agent's pane, in its grid, without taking
//   the screen or the keyboard.
//
// The answers go to the agent: English on purpose.

export class AgentBrowserTargetError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}
const refuse = (code, message) => new AgentBrowserTargetError(code, message)

// Where a page an agent opens goes in its grid (a new tree; `tree` is not
// changed). The first one: beside the agent (`near` = the agent, dir 'row').
// The next ones: with the pages it opened (`near` = its last page, dir
// 'col'), as one more equal row of that group, so the agent's own pane keeps
// its room (each page used to halve the agent's pane: five pages left it a
// sliver). mine(node): a page this agent opened.
// makeSplit(dir, children, sizes) -> a split node.
export function addPageNear(tree, nearId, page, { dir = 'row', mine = () => false, makeSplit }) {
  const walk = (node) => {
    if (!node) return node
    if (node.type === 'leaf') return node.id === nearId ? makeSplit(dir, [node, page], [50, 50]) : node
    const i = node.children.findIndex((c) => c.type === 'leaf' && c.id === nearId)
    if (i >= 0 && node.dir === dir && node.children.every(mine)) {
      const children = [...node.children.slice(0, i + 1), page, ...node.children.slice(i + 1)]
      return { ...node, children, sizes: children.map(() => 100 / children.length) }
    }
    return { ...node, children: node.children.map(walk) }
  }
  return walk(tree)
}

export const GUEST_WAIT_MS = 10000
// Pages one agent may have opened at a time (browser_open).
export const MAX_AGENT_PAGES = 5

// deps:
//   enabled() -> bool
//   workspaces() -> [ws]; forEachLeaf(tree, fn)
//   sameView(leaf, other, ws) -> bool (the same worktree grid)
//   guestOf(paneId) -> webContents id of its page | null (pageHost.js)
//   paneLabel(leaf) -> "Gauss"
//   openPage({ ws, near, url }) -> the new browser leaf
//   sleep(ms)
export function createAgentBrowserTargets(deps) {
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)))

  function findAgent(paneId) {
    for (const ws of deps.workspaces()) {
      let hit = null
      deps.forEachLeaf(ws.tree, (l) => {
        if (!hit && l.id === paneId) hit = l
      })
      if (hit) return { ws, leaf: hit }
    }
    return null
  }

  // The browser panes the agent may drive, the shown one first.
  function pagesOf(ws, agentLeaf) {
    const list = []
    deps.forEachLeaf(ws.tree, (l) => {
      if (l.kind === 'browser' && deps.sameView(l, agentLeaf, ws)) list.push(l)
    })
    const active = list.find((l) => l.id === ws.activeId)
    return active ? [active, ...list.filter((l) => l !== active)] : list
  }

  function agentOf(paneId) {
    if (typeof paneId !== 'string' || !paneId) throw refuse('not_agent', 'Unknown pane.') // i18n-ignore
    const found = findAgent(paneId)
    if (!found) throw refuse('not_agent', 'Your pane is not open in Tessel.') // i18n-ignore
    if (found.leaf.kind !== 'agent' && found.leaf.kind !== 'chat') throw refuse('not_agent', 'Only an agent pane may use the browser tools.') // i18n-ignore
    if (found.ws.remote) throw refuse('remote_project', 'The browser tools work in local projects only.') // i18n-ignore
    return found
  }

  async function waitGuest(paneId) {
    const until = Date.now() + GUEST_WAIT_MS
    for (;;) {
      const id = deps.guestOf(paneId)
      if (id != null) return id
      if (Date.now() >= until) return null
      await sleep(100)
    }
  }

  const describe = (l, current) => ({ page: l.id, url: l.url || '', title: String(l.title || '').slice(0, 200), ready: deps.guestOf(l.id) != null, current })

  // { agent, op: 'list' | 'resolve' | 'open', page, last, url }
  async function handle(req = {}) {
    if (!deps.enabled()) throw refuse('disabled', 'The user turned off "Let agents use the browser" (Tessel Settings > Agents).') // i18n-ignore
    const { ws, leaf } = agentOf(req.agent)
    const agent = deps.paneLabel(leaf)
    const pages = pagesOf(ws, leaf)

    if (req.op === 'list') {
      const def = pages.find((l) => l.id === req.last) || pages[0] || null
      return { agent, pages: pages.map((l) => describe(l, l === def)) }
    }

    if (req.op === 'open') {
      let mine = 0
      for (const w of deps.workspaces()) deps.forEachLeaf(w.tree, (l) => l.kind === 'browser' && l.openedBy === leaf.id && mine++)
      if (mine >= MAX_AGENT_PAGES) throw refuse('too_many_pages', `You already opened ${MAX_AGENT_PAGES} browser pages: reuse one (browser_pages, then "page" or browser_navigate).`) // i18n-ignore
      // Its last page still in its grid: the new one goes with it.
      let last = null
      deps.forEachLeaf(ws.tree, (l) => l.kind === 'browser' && l.openedBy === leaf.id && deps.sameView(l, leaf, ws) && (last = l))
      const page = deps.openPage({ ws, near: last || leaf, url: req.url, stack: !!last })
      if (!page) throw refuse('open_failed', 'Tessel could not open a browser pane.') // i18n-ignore
      page.openedBy = leaf.id
      return { agent, page: page.id, guestId: await waitGuest(page.id) }
    }

    if (req.op === 'resolve') {
      let page = null
      if (req.page) {
        page = pages.find((l) => l.id === req.page) || null
        if (!page) throw refuse('page_not_found', `No browser page "${String(req.page).slice(0, 80)}" in your project: see browser_pages.`) // i18n-ignore
      } else page = pages.find((l) => l.id === req.last) || pages[0] || null
      if (!page) throw refuse('no_page', 'No browser page in your project: open one with browser_open.') // i18n-ignore
      return { agent, page: page.id, url: page.url || '', guestId: await waitGuest(page.id) }
    }
    throw refuse('invalid_argument', 'Unknown request.') // i18n-ignore
  }

  return { handle, pagesOf, findAgent }
}
