// Where a browser pane's page lives. Electron loads a <webview>'s page again
// whenever the element leaves its parent, and a pane leaves its parent each
// time the layout changes (a split, a move, a neighbour closed). So the page
// is not in the pane: it is in a box of the workspace's page layer
// (.browser-host, outside the split tree), laid over the pane's page area
// (BrowserPane.vue places it). A pane built again for the same id takes its
// box back as it is: same page, scroll, form fields, history.
// After Orca's src/renderer/src/components/browser-pane/host-guest/
// browser-page-viewport.ts and webview-registry.ts (MIT, Copyright (c) 2026
// Lovecast Inc.), written for Tessel's panes.

// A pane gone for longer than this is closed: its page goes too.
export const RELEASE_MS = 400

// pane id -> { paneId, host, box, overlay, webview, ready, guestId, timer }
const pages = new Map()

// The page element, hardened as BrowserPane always made it (browserGuest.js
// in the main process checks and locks it down again when it attaches).
export const MAIN_PARTITION = 'persist:tessel-browser'
// The agents' own session (Settings > Browser: "Agents use a separate browser
// session"): pages an agent opens keep away from the user's imported logins.
export const AGENT_PARTITION = 'persist:tessel-browser-agent'

export function createWebview(src, partition = MAIN_PARTITION) {
  const el = document.createElement('webview')
  el.setAttribute('partition', partition === AGENT_PARTITION ? AGENT_PARTITION : MAIN_PARTITION)
  el.setAttribute('allowpopups', 'true')
  el.setAttribute('webpreferences', 'contextIsolation=yes,sandbox=yes,nodeIntegration=no')
  el.className = 'bp-webview'
  // Fills its box whatever the size (a flex item that may shrink), inline so
  // no stylesheet can undo it; pointer-events is left to webviewPassthrough.js.
  Object.assign(el.style, {
    display: 'flex',
    flex: '1 1 auto',
    width: '100%',
    height: '100%',
    minWidth: '0',
    minHeight: '0',
    border: 'none'
  })
  // Last: the page starts loading once the element is in the document.
  el.setAttribute('src', src)
  return el
}

// The page of pane `paneId` in `host`: the one it had (adopted: true), or a
// new one on `src`. A page left in another workspace's layer cannot move
// without loading again: it is replaced. owner: who holds it now (the pane
// built last), so the pane it replaces letting go later changes nothing.
export function claimPage(paneId, host, src, owner = null, partition = MAIN_PARTITION) {
  const had = pages.get(paneId)
  if (had) {
    clearTimeout(had.timer)
    had.timer = null
    if (had.host === host && had.box.parentElement === host) {
      had.owner = owner
      return { page: had, adopted: true }
    }
    destroyPage(paneId)
  }
  const box = document.createElement('div')
  box.className = 'bp-box'
  box.dataset.browserPage = paneId
  // Hidden until the pane places it.
  box.style.visibility = 'hidden'
  const webview = createWebview(src, partition)
  const overlay = document.createElement('div')
  overlay.className = 'bp-box-overlay'
  box.append(webview, overlay)
  host.appendChild(box)
  const page = { paneId, host, box, overlay, webview, ready: false, guestId: null, timer: null, owner }
  pages.set(paneId, page)
  return { page, adopted: false }
}

// The pane let go of its page: hidden at once, gone unless a pane takes it
// back soon (the same pane built again elsewhere in the layout).
export function releasePage(paneId, owner = null, ms = RELEASE_MS) {
  const page = pages.get(paneId)
  if (!page || page.owner !== owner) return
  page.box.style.visibility = 'hidden'
  clearTimeout(page.timer)
  page.timer = setTimeout(() => destroyPage(paneId), ms)
}

export function destroyPage(paneId) {
  const page = pages.get(paneId)
  if (!page) return
  clearTimeout(page.timer)
  pages.delete(paneId)
  page.box.remove()
}

export function pageOf(paneId) {
  return pages.get(paneId) || null
}

// Lays the box over `area` (the pane's page area), in the host's coordinates.
// hidden: another pane is maximized over it.
export function placePage(page, area, { hidden = false } = {}) {
  if (!page || !area) return
  const a = area.getBoundingClientRect()
  const h = page.host.getBoundingClientRect()
  const s = page.box.style
  s.left = `${a.left - h.left}px`
  s.top = `${a.top - h.top}px`
  s.width = `${Math.max(0, a.width)}px`
  s.height = `${Math.max(0, a.height)}px`
  // Never 'visible': the box follows its workspace's layer when that is hidden.
  s.visibility = hidden || a.width <= 0 || a.height <= 0 ? 'hidden' : ''
}

// Tests.
export function _resetPagesForTests() {
  for (const id of Array.from(pages.keys())) destroyPage(id)
}
