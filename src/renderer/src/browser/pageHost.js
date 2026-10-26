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

import { reactive } from 'vue'

// A pane gone for longer than this is closed: its page goes too.
export const RELEASE_MS = 400

// pane id -> { paneId, host, box, overlay, webview, ready, guestId, timer }
const pages = new Map()
// pane id -> its page's webContents id once ready, reactive (Live Share:
// the host's window lists its shared pages with them, liveShareWindowFeeds.js).
export const pageGuests = reactive({})
export function notePageGuest(paneId, id) {
  const page = pages.get(paneId)
  if (page) page.guestId = id
  if (Number.isSafeInteger(id)) pageGuests[paneId] = id
  else delete pageGuests[paneId]
}

// The page element, hardened as BrowserPane always made it (browserGuest.js
// in the main process checks and locks it down again when it attaches).
export const MAIN_PARTITION = 'persist:tessel-browser'
// The agents' own session (Settings > Browser: "Agents use a separate browser
// session"): pages an agent opens keep away from the user's imported logins.
export const AGENT_PARTITION = 'persist:tessel-browser-agent'
// Pages a Live Share guest opens from your pages it uses: a session in
// memory only, with none of your logins (src/main/browserGuest.js).
export const GUEST_PARTITION = 'tessel-browser-guest'
const PARTITIONS = [MAIN_PARTITION, AGENT_PARTITION, GUEST_PARTITION]
// A Live Share guest's view of the host's pages: a session of its own per
// Live Share session, in memory only (src/main/liveShareView.js).
export const VIEW_PARTITION = /^liveshare-view-[\w-]{1,40}$/
export const viewPartition = (session) => `liveshare-view-${String(session).replace(/[^\w-]/g, '_').slice(0, 40)}` // i18n-ignore
const allowedPartition = (p) => PARTITIONS.includes(p) || (typeof p === 'string' && VIEW_PARTITION.test(p))

export function createWebview(src, partition = MAIN_PARTITION) {
  const el = document.createElement('webview')
  el.setAttribute('partition', allowedPartition(partition) ? partition : MAIN_PARTITION)
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
  concealPage(page)
  page.box.style.visibility = 'hidden'
  clearTimeout(page.timer)
  page.timer = setTimeout(() => destroyPage(paneId), ms)
}

export function destroyPage(paneId) {
  const page = pages.get(paneId)
  if (!page) return
  clearTimeout(page.timer)
  pages.delete(paneId)
  delete pageGuests[paneId]
  unwatch(page)
  page.reveal = null
  page.keep = false
  clearCaptures(page)
  page.box.remove()
}

export function pageOf(paneId) {
  return pages.get(paneId) || null
}

// Lays the box over `area` (the pane's page area), in the host's coordinates.
// hidden: another pane is maximized over it.
// An area of no size (the pane squeezed to nothing): the page keeps its last
// size, hidden, so it is never laid out at 0x0 (an agent driving it out of
// sight still has a real viewport).
export function placePage(page, area, { hidden = false } = {}) {
  if (!page || !area) return
  const a = area.getBoundingClientRect()
  const h = page.host.getBoundingClientRect()
  const empty = !(a.width > 0 && a.height > 0)
  if (!empty) page.size = { width: a.width, height: a.height }
  const size = empty && page.size ? page.size : { width: Math.max(0, a.width), height: Math.max(0, a.height) }
  page.place = {
    left: `${a.left - h.left}px`,
    top: `${a.top - h.top}px`,
    width: `${size.width}px`,
    height: `${size.height}px`,
    // Never 'visible': the box follows its workspace's layer when that is hidden.
    visibility: hidden || empty ? 'hidden' : ''
  }
  Object.assign(page.box.style, page.place)
  // Drawn for an agent meanwhile: still drawn, from its new place.
  if (page.reveal || page.keep || capturing(page)) refreshDrawn(page)
}

// --- Drawn for an agent, unseen (src/main/agentBrowser.js) ---------------------------
// A page out of sight (another project or tab shown, a pane maximized over
// it, the window minimized) is not drawn. Chromium then takes no screenshot
// of it (capturePage fails, the debugger's capture never answers), and a page
// drawn once then hidden again is slowed to about one frame a second, its
// mouse moves with it (bare Electron 42 harness, 2026-10-25). So while an
// agent drives it (its badge on: keepDrawn), and for the moment of a capture
// (revealPage / endCapture), its box is laid out inside the window's
// viewport, at its own size, nearly transparent and letting every click
// through: drawn, but not seen. Nothing else of the layout changes, the
// user's project and tab stay as they are, and as soon as the page is on
// screen by itself it is left as it is.
// While the window is minimized it is not kept so (nothing is drawn then and a
// page in the viewport would be slowed the same way): only for a capture.
// (Fully transparent is not drawn at all: Chromium slows such a page too.)
// Unseen also for the pointer, the keyboard and screen readers: nothing in
// the box (the page, Tessel's own panels over it: blank page, failure page,
// find bar, Design Mode) takes a click or the focus (.bp-unseen in
// style.css, the overlay inert), it is aria-hidden, and the focus guard
// counts it as out of sight (focusWatch.js).
export const REVEAL_OPACITY = '0.01'
export const UNSEEN_CLASS = 'bp-unseen'
// A capture the main process never said was over ends by itself after this.
export const CAPTURE_TTL_MS = 15000
const REVEALED = ['visibility', 'opacity', 'pointerEvents', 'translate', 'filter']

// On screen as it is: visible, of some size, at least partly in the viewport.
function onScreen(box) {
  const view = box.ownerDocument && box.ownerDocument.defaultView
  if (!view) return false
  if (view.getComputedStyle(box).visibility !== 'visible') return false
  const r = box.getBoundingClientRect()
  return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < view.innerWidth && r.top < view.innerHeight
}

const windowHidden = (box) => box.ownerDocument.documentElement.classList.contains('window-hidden')

// Why it was out of sight, for the agent's answer.
function hiddenBy(page) {
  const box = page.box
  const doc = box.ownerDocument
  if (windowHidden(box)) return 'window'
  for (let el = box.parentElement; el && el !== doc.body; el = el.parentElement) if (el.classList.contains('ws-layer') && el.classList.contains('hidden')) return 'layer'
  if (page.place && page.place.visibility === 'hidden') return 'covered'
  return 'offscreen'
}

// Unseen for the pointer, the keyboard and screen readers (or no longer).
function markUnseen(page, on) {
  const r = page.reveal
  const box = page.box
  if (on === !!r.marked) return
  r.marked = on
  const wv = page.webview
  if (on) {
    r.attrs = { ariaHidden: box.getAttribute('aria-hidden'), tabindex: wv ? wv.getAttribute('tabindex') : null, inert: !!(page.overlay && page.overlay.inert) }
    box.classList.add(UNSEEN_CLASS)
    box.setAttribute('aria-hidden', 'true')
    if (page.overlay) page.overlay.inert = true
    if (wv) wv.setAttribute('tabindex', '-1')
    // The keyboard in it (the user's typing would go into a page they cannot see).
    const active = box.ownerDocument.activeElement
    if (active && box.contains(active) && typeof active.blur === 'function') active.blur()
    return
  }
  const a = r.attrs || {}
  box.classList.remove(UNSEEN_CLASS)
  if (a.ariaHidden == null) box.removeAttribute('aria-hidden')
  else box.setAttribute('aria-hidden', a.ariaHidden)
  if (page.overlay) page.overlay.inert = !!a.inert
  if (wv) {
    if (a.tabindex == null) wv.removeAttribute('tabindex')
    else wv.setAttribute('tabindex', a.tabindex)
  }
}

function undoReveal(page) {
  const r = page.reveal
  const s = page.box.style
  markUnseen(page, false)
  for (const [el, display, visibility] of r.ancestors.splice(0)) {
    el.style.display = display
    el.style.visibility = visibility
  }
  for (const k of REVEALED) s[k] = r.saved[k]
  if (page.place) Object.assign(s, page.place)
  else {
    s.width = r.saved.width
    s.height = r.saved.height
  }
}

function applyReveal(page) {
  const r = page.reveal
  const box = page.box
  const s = box.style
  const view = box.ownerDocument.defaultView
  // As it is placed, first: maybe on screen already.
  undoReveal(page)
  if (onScreen(box)) return (r.moved = false)
  r.why = hiddenBy(page)
  // A layer of display:none (not one of Tessel's own ways to hide): laid out, unseen.
  for (let el = box.parentElement; el && el !== box.ownerDocument.body; el = el.parentElement) {
    if (view.getComputedStyle(el).display !== 'none') continue
    r.ancestors.push([el, el.style.display, el.style.visibility])
    el.style.display = 'block'
    el.style.visibility = 'hidden'
  }
  // No size yet: the window's.
  if (!(box.offsetWidth > 0 && box.offsetHeight > 0)) {
    const size = page.size || { width: view.innerWidth, height: view.innerHeight }
    s.width = `${Math.max(1, Math.round(size.width))}px`
    s.height = `${Math.max(1, Math.round(size.height))}px`
  }
  markUnseen(page, true)
  s.visibility = 'visible'
  s.opacity = REVEAL_OPACITY
  // Black, so what the page shows (a game, a picture) never shows through a
  // see-through terminal over it: only the shade of 1% remains. The page's
  // own capture is not touched by the box's filter.
  s.filter = 'brightness(0)'
  s.pointerEvents = 'none'
  s.translate = 'none'
  // Into the viewport, at its top left corner, whatever moved its layer away.
  const at = box.getBoundingClientRect()
  s.translate = `${-Math.round(at.left)}px ${-Math.round(at.top)}px`
  return (r.moved = true)
}

// Another project or tab shown, the window minimized or back: a class
// changes on one of the box's ancestors. Looked at again at once (before the
// window draws), so a page coming on screen is never seen out of place.
function watchAncestors(page) {
  if (page.watcher || typeof MutationObserver !== 'function') return
  page.watcher = new MutationObserver(() => refreshDrawn(page))
  for (let el = page.box.parentElement; el; el = el.parentElement) page.watcher.observe(el, { attributes: true, attributeFilter: ['class'] })
}
function unwatch(page) {
  if (page.watcher) page.watcher.disconnect()
  page.watcher = null
}

const capturing = (page) => !!page.captures && page.captures.size > 0

// Drawn (unseen) when an agent needs it, as placed otherwise.
function refreshDrawn(page) {
  if (!page || !page.box) return false
  const wanted = page.box.isConnected && (capturing(page) || (!!page.keep && !windowHidden(page.box)))
  if (!wanted) {
    if (page.reveal) {
      undoReveal(page)
      page.reveal = null
    }
    if (!page.keep && !capturing(page)) unwatch(page)
    else watchAncestors(page)
    return false
  }
  if (!page.reveal) {
    const s = page.box.style
    page.reveal = { saved: Object.fromEntries([...REVEALED, 'width', 'height'].map((k) => [k, s[k]])), ancestors: [], moved: false, why: null }
  }
  watchAncestors(page)
  return applyReveal(page)
}

// An agent drives the page (its badge on), or no longer.
export function keepDrawn(page, on) {
  if (!page) return
  page.keep = !!on
  refreshDrawn(page)
}

function clearCaptures(page) {
  if (!page.captures) return
  for (const timer of page.captures.values()) clearTimeout(timer)
  page.captures.clear()
}

// For a capture, named by its token (the main process ends it with the same
// token; one it never ends ends by itself after ttl ms).
// -> { moved, why } (moved: false when the page was on screen already).
export function revealPage(page, token = 'capture', ttl = CAPTURE_TTL_MS) {
  if (!page || !page.box || !page.box.isConnected) return { moved: false, why: 'gone' }
  if (!page.captures) page.captures = new Map()
  const key = String(token).slice(0, 64)
  clearTimeout(page.captures.get(key))
  page.captures.set(
    key,
    setTimeout(() => endCapture(page, key), ttl)
  )
  const moved = refreshDrawn(page)
  return { moved, why: moved ? page.reveal.why : null }
}
export function endCapture(page, token = 'capture') {
  const key = String(token).slice(0, 64)
  if (!page || !page.captures || !page.captures.has(key)) return false
  clearTimeout(page.captures.get(key))
  page.captures.delete(key)
  refreshDrawn(page)
  return true
}

// Its pane let go of it: as placed, nothing kept.
export function concealPage(page) {
  if (!page) return false
  const had = !!page.reveal
  page.keep = false
  clearCaptures(page)
  refreshDrawn(page)
  return had
}

// Tests.
export function _resetPagesForTests() {
  for (const id of Array.from(pages.keys())) destroyPage(id)
}
