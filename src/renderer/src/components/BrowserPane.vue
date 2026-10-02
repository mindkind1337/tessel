<script setup>
// A web page in a pane: Tessel's built-in browser. One page per pane (no
// inner tabs): back, forward, reload / stop, an address bar (a URL, a
// local dev server like "localhost:5173", or a search), the project's local
// ports one click away, Design Mode (pick an element and send it to an
// agent), a screenshot, the page's devtools and "open in the default
// browser". A page that cannot load shows why and how to recover; a blank
// page offers the active local servers.
// Look and texts after Orca's browser pane (MIT, Copyright (c) 2026
// Lovecast Inc.): src/renderer/src/components/browser-pane/assemble-chrome/
// browser-navigation-control-row.tsx, browser-reload-control.tsx,
// browser-chrome-toolbar.tsx, BrowserAddressBar.tsx,
// browser-page-viewport-overlays.tsx, browser-page-zoom-indicator.tsx,
// navigate/browser-load-failure-overlay.tsx, navigate/browser-notices.ts and
// src/renderer/src/components/status-bar/PortsStatusSegment.tsx,
// ports-status-popover-rows.tsx, written for Vue.
// The page's sizing, its input during Tessel's drags and its find bar after
// Orca's host-guest/browser-page-webview.ts, browser-page-viewport.ts,
// webview-drag-passthrough.ts and assemble-chrome/BrowserFind.tsx (MIT,
// Copyright (c) 2026 Lovecast Inc.).
import { ref, shallowRef, computed, watch, inject, nextTick, onMounted, onBeforeUnmount } from 'vue'
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Camera,
  ChevronDown,
  ChevronUp,
  Copy,
  Crosshair,
  Eraser,
  ExternalLink,
  Globe,
  Loader2,
  Plug,
  RefreshCw,
  Search,
  ShieldAlert,
  SquareCode,
  X
} from 'lucide-vue-next'
import { BLANK_URL, allowedBrowserUrl, normalizeBrowserInput, displayUrl, hostOf } from '../../../shared/browserUrl'
import {
  nextZoom,
  clampZoom,
  zoomPercent,
  isShownLoadFailure,
  loadFailureView,
  pageTitleFor,
  permissionNotice,
  downloadNotice,
  shortcutAction,
  portAddress
} from '../browser/browserPage'
import { registerWebview } from '../browser/webviewPassthrough'
import { claimPage, releasePage, placePage, createWebview } from '../browser/pageHost'
import DesignModePanel from './DesignModePanel.vue'
import { t } from '../i18n'

const props = defineProps({
  node: { type: Object, required: true },
  // A page in the side panel (SideBrowser.vue): no pane header (move,
  // maximize, close are the side panel's tab bar).
  inSidePanel: { type: Boolean, default: false }
})

const ctx = inject('panelCtx')
const askConfirm = inject('askConfirm', null)

const isActive = computed(() => ctx.activeId.value === props.node.id)
const isMaximized = computed(() => ctx.maximizedId.value === props.node.id)

const rootEl = ref(null)
// The page (a <webview>): made in onMounted, in the workspace's page layer
// when there is one (browser/pageHost.js), else in the pane itself.
const webviewEl = shallowRef(null)
const pageEl = ref(null) // the pane's page area, where the page is laid
const overlayTarget = shallowRef(null) // where the overlays over the page go
let page = null // pageHost's entry
const pageOwner = Symbol('pane')
const addressEl = ref(null)
const design = ref(null)

// The page shown. The webview gets its first address once (src); every
// later page goes through loadURL.
const currentUrl = ref(allowedBrowserUrl(props.node.url) || BLANK_URL)
const initialSrc = currentUrl.value
const pageTitle = ref(pageTitleFor(props.node.title, currentUrl.value))
const loading = ref(false)
const canGoBack = ref(false)
const canGoForward = ref(false)
const guestId = ref(null)
const failure = ref(null) // { kind: 'load' | 'crash', code, description, url }
const designActive = ref(false)
// An agent driving this page (its browser tools, src/main/agentBrowser.js):
// { agent } while it does; the badge's Stop takes the page back.
const agentControl = ref(null)
const agentText = computed(() =>
  agentControl.value && agentControl.value.agent
    ? t('browser.agent.controlling', '{{agent}} is driving', { agent: agentControl.value.agent })
    : t('browser.agent.controllingAnon', 'Agent driving')
)

let ready = false // loadURL needs the webview attached and its first dom-ready
let pendingUrl = null


// --- Scroll kept when the pane is rebuilt ------------------------------------------------------
// A layout change keeps the page itself (browser/pageHost.js); a pane moved
// to another workspace, or shown without a page layer, gets a new one, which
// Electron loads again: where the page was scrolled is noted (when
// the pointer or the keyboard leaves the page, before a link opens in a new
// pane) and put back once the same page is loaded.
const MAX_SCROLL = 10000000
function scrollNumber(n) {
  const v = Math.round(Number(n))
  return Number.isFinite(v) ? Math.min(MAX_SCROLL, Math.max(0, v)) : 0
}
async function saveScroll() {
  if (!ready || isBlank.value) return
  let pos
  try {
    pos = await call('executeJavaScript', '[window.scrollX, window.scrollY]', false)
  } catch {
    return
  }
  if (!Array.isArray(pos)) return
  props.node.scroll = { url: currentUrl.value, x: scrollNumber(pos[0]), y: scrollNumber(pos[1]) }
}
let scrollToRestore = props.node.scroll && props.node.scroll.url === currentUrl.value ? props.node.scroll : null
function restoreScroll() {
  const s = scrollToRestore
  scrollToRestore = null
  if (props.node.scroll === s) props.node.scroll = null
  if (!s || s.url !== currentUrl.value || (!s.x && !s.y)) return
  const code = 'window.scrollTo(' + scrollNumber(s.x) + ', ' + scrollNumber(s.y) + ')'
  Promise.resolve(call('executeJavaScript', code, false)).catch(() => {})
}

const isBlank = computed(() => !displayUrl(currentUrl.value))
const headerTitle = computed(() => pageTitle.value || (isBlank.value ? '' : hostOf(currentUrl.value)) || t('browser.pane.title', 'Browser'))
const failureView = computed(() => (failure.value ? loadFailureView(failure.value) : null))
const showEmpty = computed(() => isBlank.value && !failure.value && !loading.value)

// --- The webview ---------------------------------------------------------------------------
function wv() {
  return webviewEl.value
}
// The webview's methods throw before it is attached; a failed call changes nothing.
function call(name, ...args) {
  const el = wv()
  if (!el || typeof el[name] !== 'function') return undefined
  try {
    return el[name](...args)
  } catch {
    return undefined
  }
}
function syncHistory() {
  canGoBack.value = !!call('canGoBack')
  canGoForward.value = !!call('canGoForward')
}

function load(url) {
  if (!ready) {
    pendingUrl = url
    return
  }
  loading.value = true
  // loadURL rejects when a load is replaced or fails; did-fail-load reports it.
  Promise.resolve(call('loadURL', url)).catch(() => {})
}

// Opens a page in this pane (an address, a port, a popup). -> false when refused.
function navigate(raw) {
  const url = allowedBrowserUrl(raw)
  if (!url) return false
  failure.value = null
  addressError.value = ''
  if (!addressFocused()) addressText.value = displayUrl(url)
  load(url)
  return true
}

function setPage(url) {
  currentUrl.value = url
  if (props.node.url !== url) props.node.url = url
  if (!addressFocused()) addressText.value = displayUrl(url)
}
function setTitle(title) {
  pageTitle.value = title
  if (props.node.title !== title) props.node.title = title
}

function onDomReady() {
  const first = !ready
  ready = true
  const id = call('getWebContentsId')
  if (id != null) guestId.value = id
  if (page) {
    page.ready = true
    page.guestId = guestId.value
  }
  call('setZoomLevel', clampZoom(props.node.zoom || 0))
  syncHistory()
  if (first && pendingUrl) {
    const url = pendingUrl
    pendingUrl = null
    load(url)
  }
}
function onStartLoading() {
  loading.value = true
}
function onStopLoading() {
  loading.value = false
  syncHistory()
}
function onFinishLoad() {
  if (scrollToRestore) restoreScroll()
}
function onNavigate(e) {
  if (!e || !e.url) return
  if (scrollToRestore && e.url !== scrollToRestore.url) scrollToRestore = null
  closeFind()
  failure.value = null
  setPage(e.url)
  setTitle(pageTitleFor('', e.url))
  syncHistory()
}
function onNavigateInPage(e) {
  if (!e || !e.url || e.isMainFrame === false) return
  setPage(e.url)
  setTitle(pageTitleFor(call('getTitle'), e.url))
  syncHistory()
}
function onTitle(e) {
  setTitle(pageTitleFor(e && e.title, currentUrl.value))
}
function onFailLoad(e) {
  if (!isShownLoadFailure(e)) return
  const url = allowedBrowserUrl(e.validatedURL) || currentUrl.value
  failure.value = { kind: 'load', code: Number(e.errorCode), description: e.errorDescription || '', url }
  loading.value = false
  // The pane remembers the page it was asked for (a dev server started later).
  if (url !== BLANK_URL) {
    setPage(url)
    setTitle(pageTitleFor('', url))
  }
}
function onGone() {
  failure.value = { kind: 'crash', url: currentUrl.value }
  loading.value = false
}
// A click in the page: the pane becomes the active one, menus close.
function onPageFocus() {
  closeMenus()
  if (!isActive.value) ctx.setActive(props.node.id)
}

const WEBVIEW_EVENTS = {
  'dom-ready': onDomReady,
  'did-start-loading': onStartLoading,
  'did-stop-loading': onStopLoading,
  'did-navigate': onNavigate,
  'did-navigate-in-page': onNavigateInPage,
  'page-title-updated': onTitle,
  'did-fail-load': onFailLoad,
  'did-finish-load': onFinishLoad,
  'render-process-gone': onGone,
  'found-in-page': onFoundInPage,
  focus: onPageFocus,
  blur: saveScroll
}

// --- Navigation controls ---------------------------------------------------------------------
function goBack() {
  if (canGoBack.value) call('goBack')
}
function goForward() {
  if (canGoForward.value) call('goForward')
}
function reload() {
  if (failure.value) return retry()
  loading.value = true
  call('reload')
}
function hardReload() {
  if (failure.value) return retry()
  loading.value = true
  call('reloadIgnoringCache')
}
function stop() {
  call('stop')
  loading.value = false
}
function onReloadClick() {
  closeMenus()
  if (loading.value) stop()
  else reload()
}
const reloadLabel = computed(() => {
  if (loading.value) return t('browser.nav.stop', 'Stop')
  if (failure.value) return t('browser.failure.retry', 'Retry')
  return t('browser.nav.reload', 'Reload')
})
const reloadMenu = ref(false)
function onReloadContext() {
  portsOpen.value = false
  reloadMenu.value = !reloadMenu.value
}

// Retry after a failure: the same address again (a crashed page reloads,
// which gives it a new renderer). The overlay stays until the page loads.
function retry() {
  const f = failure.value
  closeMenus()
  if (!f) return reload()
  loading.value = true
  if (f.kind === 'crash') {
    call('reload')
    return
  }
  if (!ready) {
    pendingUrl = f.url
    return
  }
  Promise.resolve(call('loadURL', f.url)).catch(() => {})
}

function openDevTools() {
  const api = window.shellApi && window.shellApi.browser
  if (api && guestId.value != null) api.openDevTools(guestId.value)
}
// Cookies, site storage and cache of the browser session (shared by every
// browser pane), after a confirm: it signs the user out of sites.
async function clearData() {
  closeMenus()
  const api = window.shellApi && window.shellApi.browser
  if (!api || typeof api.clearData !== 'function') return
  const question = {
    title: t('browser.clearData.title', 'Clear browsing data?'),
    text: t('browser.clearData.text', "Cookies, site storage and the cache of Tessel's browser are deleted for every browser pane. You will be signed out of sites."),
    confirmLabel: t('browser.clearData.confirm', 'Clear'),
    danger: true
  }
  const ok = askConfirm ? await askConfirm(question) : window.confirm(question.title)
  if (!ok) return
  let r
  try {
    r = await api.clearData()
  } catch {
    r = null
  }
  if (!ctx.toast) return
  if (r && r.ok) ctx.toast(t('browser.clearData.done', 'Browsing data cleared'), { timeout: 3000 })
  else ctx.toast(t('browser.clearData.failed', 'Could not clear the browsing data.'), { kind: 'error' })
}
function openExternal(url = currentUrl.value) {
  if (!displayUrl(url)) return
  if (ctx.openExternal) ctx.openExternal(url)
  else if (window.shellApi && window.shellApi.openExternal) window.shellApi.openExternal(url)
}
function copyAddress(url) {
  if (window.shellApi && window.shellApi.writeClipboard) window.shellApi.writeClipboard(url)
  if (ctx.toast) ctx.toast(t('browser.failure.addressCopied', 'Copied the current page address.'), { timeout: 2000 })
}
function toggleDesign() {
  closeMenus()
  if (design.value && design.value.toggle) design.value.toggle()
}
function screenshot() {
  closeMenus()
  if (design.value && design.value.screenshot) design.value.screenshot()
}

// --- Address bar (Orca's BrowserAddressBar) ------------------------------------------------
const addressText = ref(displayUrl(currentUrl.value))
const addressError = ref('')
let addressFirstClick = false

function addressFocused() {
  return !!addressEl.value && document.activeElement === addressEl.value
}
function focusAddress() {
  nextTick(() => {
    const input = addressEl.value
    if (!input) return
    input.focus()
    input.select()
  })
}
function onAddressMouseDown(e) {
  addressFirstClick = e.button === 0 && document.activeElement !== e.currentTarget
}
// The first click selects the whole address; a drag keeps its own selection.
function onAddressClick(e) {
  const input = e.currentTarget
  if (addressFirstClick && input.selectionStart === input.selectionEnd) input.select()
  addressFirstClick = false
}
function onAddressInput() {
  addressError.value = ''
}
function submitAddress() {
  closeMenus()
  const url = normalizeBrowserInput(addressText.value)
  if (!url) {
    addressError.value = t('browser.address.invalid', 'Enter a valid http(s) or localhost URL.')
    return
  }
  navigate(url)
  // The page gets the keys once it starts loading.
  if (addressEl.value) addressEl.value.blur()
}
function onAddressKeydown(e) {
  if (e.key !== 'Escape') return
  // Escape puts the current address back (and stays here: not the app's Escape).
  e.preventDefault()
  e.stopPropagation()
  addressText.value = displayUrl(currentUrl.value)
  addressError.value = ''
  nextTick(() => addressEl.value && addressEl.value.select())
}
function onAddressBlur() {
  addressError.value = ''
}

// --- Ports (Orca's ports status popover) ----------------------------------------------------
const portsOpen = ref(false)
const portsTick = ref(0)
const SYSTEM_PROCESSES = new Set(['system', 'system idle process', 'svchost.exe', 'lsass.exe', 'services.exe', 'wininit.exe', 'spoolsv.exe', 'smss.exe', 'csrss.exe'])
const SYSTEM_PORTS = new Set([135, 137, 138, 139, 445, 5040])
const ports = computed(() => {
  portsTick.value // re-read when the popover opens
  const list = ctx.browserPorts ? ctx.browserPorts() : []
  if (!Array.isArray(list)) return []
  // Windows' own listeners (file sharing, RPC…) are no local servers to
  // browse; one row per port.
  const seen = new Set()
  return list.filter((p) => {
    if (!p || SYSTEM_PROCESSES.has(String(p.processName || '').toLowerCase()) || SYSTEM_PORTS.has(Number(p.port))) return false
    const key = `${p.port}:${p.url || ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
})
// The ports popover stays inside the pane: a narrow pane (the side panel)
// would otherwise cut its left side off.
const portsShift = ref(0)
const portsWidth = ref(0)
function fitPorts() {
  portsShift.value = 0
  portsWidth.value = 0
  nextTick(() => {
    const pop = rootEl.value && rootEl.value.querySelector('.bp-ports')
    if (!pop) return
    const box = rootEl.value.getBoundingClientRect()
    const room = Math.max(160, box.width - 16)
    if (pop.offsetWidth > room) portsWidth.value = room
    nextTick(() => {
      const r = pop.getBoundingClientRect()
      if (r.left < box.left + 8) portsShift.value = Math.round(box.left + 8 - r.left)
    })
  })
}
function togglePorts() {
  reloadMenu.value = false
  portsTick.value++
  portsOpen.value = !portsOpen.value
  if (portsOpen.value) fitPorts()
}
function openPort(p) {
  closeMenus()
  if (p && p.url) navigate(p.url)
}
// Mustaches cannot sit inside a template's {{ }}: these texts are made here.
const portsCount = computed(() => t('browser.ports.count', '{{count}} active', { count: ports.value.length }))
function portProcess(p) {
  return p.processName || p.label || t('browser.ports.unknownProcess', 'Unknown process')
}

function closeMenus() {
  portsOpen.value = false
  reloadMenu.value = false
}
function onDocMouseDown(e) {
  if (!portsOpen.value && !reloadMenu.value) return
  if (e.target && e.target.closest && e.target.closest('.bp-menu, .bp-menu-anchor')) return
  closeMenus()
}

// --- Zoom (Orca's browser-page-zoom-indicator) ------------------------------------------------
const zoomShown = ref(false)
const zoomText = computed(() => t('browser.zoom.percent', '{{percent}}%', { percent: zoomPercent(props.node.zoom || 0) }))
let zoomTimer = null
function zoom(dir) {
  const level = nextZoom(props.node.zoom || 0, dir)
  props.node.zoom = level
  call('setZoomLevel', level)
  zoomShown.value = true
  clearTimeout(zoomTimer)
  zoomTimer = setTimeout(() => (zoomShown.value = false), 1500)
}

// --- Find in page (Orca's BrowserFind) --------------------------------------------------------
const findEl = ref(null)
const findOpen = ref(false)
const findQuery = ref('')
const findActive = ref(0)
const findTotal = ref(0)
let findSearched = null // the text of the search under way (Electron's findNext: a new one)
let findTimer = null
function openFind() {
  if (isBlank.value) return
  closeMenus()
  findOpen.value = true
  nextTick(() => {
    const input = findEl.value
    if (!input) return
    input.focus()
    input.select()
  })
  // Opened again on a text: its matches again.
  if (findQuery.value && findSearched !== findQuery.value) runFind()
}
function closeFind() {
  clearTimeout(findTimer)
  if (!findOpen.value) return
  findOpen.value = false
  findSearched = null
  findActive.value = 0
  findTotal.value = 0
  call('stopFindInPage', 'clearSelection')
}
function runFind(forward = true) {
  clearTimeout(findTimer)
  const text = findQuery.value
  if (!text) {
    findSearched = null
    findActive.value = 0
    findTotal.value = 0
    call('stopFindInPage', 'clearSelection')
    return
  }
  const fresh = findSearched !== text
  findSearched = text
  call('findInPage', text, { forward, findNext: fresh })
}
function onFindInput() {
  // Searched as it is typed, a moment after the last key (no flashing).
  clearTimeout(findTimer)
  findTimer = setTimeout(() => runFind(), 200)
}
function onFindKeydown(e) {
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    closeFind()
    focusPage()
  } else if (e.key === 'Enter') {
    e.preventDefault()
    e.stopPropagation()
    runFind(!e.shiftKey)
  } else if ((e.ctrlKey || e.metaKey) && !e.altKey && String(e.key).toLowerCase() === 'f') {
    e.preventDefault()
    e.stopPropagation()
    if (findEl.value) findEl.value.select()
  }
}
function onFoundInPage(e) {
  const r = e && e.result
  if (!r || !findOpen.value) return
  if (Number.isFinite(r.activeMatchOrdinal)) findActive.value = r.activeMatchOrdinal
  if (Number.isFinite(r.matches)) findTotal.value = r.matches
}
const findCount = computed(() =>
  findTotal.value ? t('browser.find.count', '{{current}} of {{total}}', { current: findActive.value, total: findTotal.value }) : t('browser.find.none', 'No matches')
)
function focusPage() {
  const el = wv()
  if (el && typeof el.focus === 'function') el.focus()
}

// --- Links opened in a new pane (middle-click, Ctrl+click, the page's menu) --------------------
async function openInNewPane(url) {
  const target = allowedBrowserUrl(url)
  if (!target || target === BLANK_URL) return
  // Opening splits this pane, which builds it again: its scroll comes back.
  await saveScroll()
  if (ctx.openBrowserPane) ctx.openBrowserPane(target, { fromId: props.node.id, activate: false })
  else navigate(target)
}

// --- Shortcuts (here, and from the page through the main process) -----------------------------
function runAction(action) {
  switch (action) {
    case 'focusAddress':
      return focusAddress()
    case 'find':
      return openFind()
    case 'stop':
      return stop()
    case 'reload':
      return reload()
    case 'hardReload':
      return hardReload()
    case 'back':
      return goBack()
    case 'forward':
      return goForward()
    case 'devTools':
      return openDevTools()
    case 'zoomIn':
      return zoom(1)
    case 'zoomOut':
      return zoom(-1)
    case 'zoomReset':
      return zoom(0)
  }
}
function onKeydown(e) {
  if (e.key === 'Escape' && (portsOpen.value || reloadMenu.value)) {
    e.stopPropagation()
    closeMenus()
    return
  }
  // Escape stops a page still loading (a browser's Stop).
  if (e.key === 'Escape' && loading.value && !e.ctrlKey && !e.altKey && !e.metaKey && e.target !== addressEl.value) {
    e.preventDefault()
    e.stopPropagation()
    stop()
    return
  }
  // Fields of Design Mode's cards keep their keys.
  const target = e.target
  if (target && target !== addressEl.value && target.closest && target.closest('input, textarea, select, [contenteditable="true"]')) return
  const action = shortcutAction(e)
  if (!action) return
  e.preventDefault()
  e.stopPropagation()
  runAction(action)
}

// --- Pane (header, focus) --------------------------------------------------------------------
function focusPane() {
  const root = rootEl.value
  if (!root || root.contains(document.activeElement)) return
  if (isBlank.value && !failure.value) focusAddress()
  else if (wv() && typeof wv().focus === 'function') wv().focus()
  else root.focus()
}
watch(isActive, (a) => {
  if (a) nextTick(focusPane)
})
function onPaneMouseDown() {
  ctx.setActive(props.node.id)
}
// Drag the header to move the pane; a click on it activates the pane.
function onNavPointerDown(e) {
  if (e.button !== 0) return
  if (e.target.closest('button, input, label')) return
  ctx.beginPaneDrag(props.node.id, e)
}
function onNavMouseDown(e) {
  if (!e.target.closest('input, label')) e.preventDefault()
  ctx.setActive(props.node.id)
}

// The app asks for the address bar (a counter it bumps), or another page.
watch(
  () => props.node.focusAddress,
  () => focusAddress()
)
watch(
  () => props.node.url,
  (url) => {
    const target = allowedBrowserUrl(url)
    if (target && target !== currentUrl.value) navigate(target)
  }
)

// --- What the main process says about this page --------------------------------------------------
const unsubscribers = []
function forThisPage(fn) {
  return (ev) => {
    if (!ev || guestId.value == null || ev.webContentsId !== guestId.value) return
    fn(ev)
  }
}
function subscribe(api) {
  const on = (name, fn) => {
    if (typeof api[name] !== 'function') return
    const off = api[name](forThisPage(fn))
    if (typeof off === 'function') unsubscribers.push(off)
  }
  // A link to a new window opens here; a middle-click or a Ctrl+click, in a new pane.
  on('onPopup', (ev) => (ev.newPane ? openInNewPane(ev.url) : navigate(ev.url)))
  on('onShortcut', (ev) => runAction(ev.action))
  // The mouse's back/forward buttons while no page has the keyboard: the active pane's.
  if (typeof api.onAppCommand === 'function') {
    const off = api.onAppCommand((ev) => {
      if (!ev || !isActive.value) return
      if (ev.action === 'back' || ev.action === 'forward') runAction(ev.action)
    })
    if (typeof off === 'function') unsubscribers.push(off)
  }
  on('onAgentControl', (ev) => {
    agentControl.value = ev.active ? { agent: String(ev.agent || '').slice(0, 60) } : null
  })
  on('onPermissionDenied', (ev) => {
    if (ctx.toast) ctx.toast(permissionNotice(ev), { timeout: 6000 })
  })
  on('onDownloadBlocked', (ev) => {
    if (!ctx.toast) return
    const url = allowedBrowserUrl(ev.url)
    ctx.toast(downloadNotice(ev), {
      timeout: 10000,
      ...(url ? { action: { label: t('browser.notice.openDefault', 'Open in default browser'), run: () => openExternal(url) } } : {})
    })
  })
}

// The badge's Stop: no agent drives this page again while it is open.
function stopAgent() {
  const api = window.shellApi && window.shellApi.browser
  if (!api || typeof api.agentStop !== 'function' || guestId.value == null) return
  Promise.resolve(api.agentStop(guestId.value))
    .then((ok) => {
      if (!ok) return
      agentControl.value = null
      if (ctx.toast) ctx.toast(t('browser.agent.stopped', 'Agents can no longer drive this page. Close it and open a new one to let them again.'), { timeout: 6000 })
    })
    .catch(() => {})
}

// --- The page's place (browser/pageHost.js) -------------------------------------------------
// The workspace's page layer: a sibling of the split tree in its .ws-layer.
function pageLayer() {
  const layer = rootEl.value && rootEl.value.closest ? rootEl.value.closest('.ws-layer') : null
  if (!layer) return null
  for (const child of layer.children) if (child.classList.contains('browser-host')) return child
  return null
}
const hosted = shallowRef(false)
// Hidden under another pane that is maximized.
const coveredByMaximized = computed(() => !!ctx.maximizedId.value && ctx.maximizedId.value !== props.node.id)
function place() {
  if (page) placePage(page, pageEl.value, { hidden: coveredByMaximized.value })
}
let placeFrame = 0
function placeSoon() {
  if (placeFrame) return
  placeFrame = requestAnimationFrame(() => {
    placeFrame = 0
    place()
  })
}
watch([coveredByMaximized, isMaximized], () => nextTick(place))
let resizeObserver = null
// A click on the page's overlays (the failure page, Design Mode) activates the pane.
function onBoxMouseDown() {
  if (!isActive.value) ctx.setActive(props.node.id)
}
// A page taken back: what it shows now.
function adoptLivePage() {
  ready = page.ready
  if (page.guestId != null) guestId.value = page.guestId
  loading.value = !!call('isLoading')
  syncHistory()
  const url = allowedBrowserUrl(call('getURL'))
  if (url && url !== BLANK_URL) {
    setPage(url)
    setTitle(pageTitleFor(call('getTitle'), url))
  }
  scrollToRestore = null
}
function mountPage() {
  const host = pageLayer()
  if (host) {
    const claimed = claimPage(props.node.id, host, initialSrc, pageOwner)
    page = claimed.page
    webviewEl.value = page.webview
    overlayTarget.value = page.overlay
    hosted.value = true
    page.box.addEventListener('mousedown', onBoxMouseDown)
    if (claimed.adopted) adoptLivePage()
    if (typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(() => place())
      if (pageEl.value) resizeObserver.observe(pageEl.value)
      resizeObserver.observe(host)
    }
    window.addEventListener('resize', placeSoon)
    window.addEventListener('terminal-layout-change', placeSoon)
    place()
    return
  }
  // No page layer (a pane shown on its own): the page in the pane.
  const el = createWebview(initialSrc)
  if (pageEl.value) pageEl.value.insertBefore(el, pageEl.value.firstChild)
  webviewEl.value = el
}

let unregisterWebview = null
onMounted(() => {
  mountPage()
  const el = wv()
  if (el) for (const [name, fn] of Object.entries(WEBVIEW_EVENTS)) el.addEventListener(name, fn)
  unregisterWebview = registerWebview(el)
  const api = window.shellApi && window.shellApi.browser
  if (api) subscribe(api)
  document.addEventListener('mousedown', onDocMouseDown, true)
})

onBeforeUnmount(() => {
  const el = wv()
  if (el) for (const [name, fn] of Object.entries(WEBVIEW_EVENTS)) el.removeEventListener(name, fn)
  if (resizeObserver) resizeObserver.disconnect()
  window.removeEventListener('resize', placeSoon)
  window.removeEventListener('terminal-layout-change', placeSoon)
  if (placeFrame) cancelAnimationFrame(placeFrame)
  if (page) {
    page.box.removeEventListener('mousedown', onBoxMouseDown)
    // Kept a moment: this pane built again elsewhere takes it back as it is.
    releasePage(props.node.id, pageOwner)
    page = null
  }
  for (const off of unsubscribers.splice(0)) {
    try {
      off()
    } catch {
      // Already gone.
    }
  }
  document.removeEventListener('mousedown', onDocMouseDown, true)
  clearTimeout(zoomTimer)
  clearTimeout(findTimer)
  if (unregisterWebview) unregisterWebview()
})

defineExpose({ navigate, focusAddress })
</script>

<template>
  <div
    ref="rootEl"
    class="pane browser-pane"
    :class="{
      hosted,
      'in-side': inSidePanel,
      active: isActive,
      maximized: isMaximized,
      highlighted: ctx.highlightId.value === node.id
    }"
    :data-pane-id="node.id"
    data-pane-kind="browser"
    tabindex="-1"
    @mousedown="onPaneMouseDown"
    @keydown="onKeydown"
  >
    <div v-if="!inSidePanel" class="pane-nav" data-test="pane-header" @mousedown.stop="onNavMouseDown" @pointerdown="onNavPointerDown">
      <div class="pane-nav-left">
        <span class="pane-icon" :title="t('browser.pane.title', 'Browser')">
          <Globe :size="15" aria-hidden="true" />
        </span>
        <span
          class="pane-title"
          data-test="browser-title"
          :title="t('browser.pane.titleHint', '{{url}}\nDrag the header to move the pane', { url: displayUrl(currentUrl) || headerTitle })"
          >{{ headerTitle }}</span
        >
      </div>
      <div class="pane-nav-actions" @mousedown.stop>
        <button
          class="pane-nav-btn"
          :title="isMaximized ? t('editor.pane.restore', 'Restore pane') : t('editor.pane.maximize', 'Maximize pane')"
          @click="ctx.toggleMaximize(node.id)"
        >
          <svg v-if="isMaximized" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M6 2v4H2M14 6h-4V2M10 14v-4h4M2 10h4v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <svg v-else width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
        <button
          class="pane-nav-btn close"
          :title="t('editor.pane.closeHint', 'Close pane (Ctrl+Shift+W)')"
          :aria-label="t('editor.pane.close', 'Close pane')"
          @click="ctx.closeLeaf(node.id)"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
          </svg>
        </button>
      </div>
    </div>

    <div class="bp-body">
      <div class="bp-toolbar" data-test="browser-toolbar">
        <button
          type="button"
          class="bp-btn"
          data-test="browser-back"
          :disabled="!canGoBack"
          :title="t('browser.nav.backHint', 'Back (Alt+Left)')"
          :aria-label="t('browser.nav.back', 'Back')"
          @click="goBack"
        >
          <ArrowLeft :size="16" />
        </button>
        <button
          type="button"
          class="bp-btn"
          data-test="browser-forward"
          :disabled="!canGoForward"
          :title="t('browser.nav.forwardHint', 'Forward (Alt+Right)')"
          :aria-label="t('browser.nav.forward', 'Forward')"
          @click="goForward"
        >
          <ArrowRight :size="16" />
        </button>
        <div class="bp-menu-anchor">
          <button
            type="button"
            class="bp-btn"
            data-test="browser-reload"
            :title="
              loading
                ? reloadLabel
                : t('browser.nav.reloadHint', '{{label}} (Ctrl+R) · right-click for Hard Reload', { label: reloadLabel })
            "
            :aria-label="reloadLabel"
            @click="onReloadClick"
            @contextmenu.prevent="onReloadContext"
          >
            <Loader2 v-if="loading" :size="16" class="bp-spin" />
            <RefreshCw v-else :size="16" />
          </button>
          <div v-if="reloadMenu" class="bp-menu bp-reload-menu" role="menu">
            <button type="button" class="bp-menu-item" role="menuitem" @click="(closeMenus(), reload())">
              <span>{{ t('browser.nav.reload', 'Reload') }}</span>
              <span class="bp-menu-kbd">Ctrl+R</span>
            </button>
            <button type="button" class="bp-menu-item" role="menuitem" data-test="browser-hard-reload" @click="(closeMenus(), hardReload())">
              <span>{{ t('browser.nav.hardReload', 'Hard Reload') }}</span>
              <span class="bp-menu-kbd">Ctrl+Shift+R</span>
            </button>
          </div>
        </div>

        <form class="bp-address" :class="{ invalid: !!addressError }" data-test="browser-address" @submit.prevent="submitAddress" @click="addressEl && addressEl.focus()">
          <Globe :size="15" class="bp-address-icon" aria-hidden="true" />
          <input
            ref="addressEl"
            v-model="addressText"
            class="bp-address-input"
            type="text"
            spellcheck="false"
            autocomplete="off"
            autocapitalize="none"
            :placeholder="t('browser.address.placeholder', 'Search or enter an address')"
            :aria-label="t('browser.address.label', 'Address')"
            :aria-invalid="!!addressError"
            @mousedown="onAddressMouseDown"
            @click="onAddressClick"
            @input="onAddressInput"
            @keydown="onAddressKeydown"
            @blur="onAddressBlur"
          />
          <div v-if="addressError" class="bp-address-error" role="alert" data-test="browser-address-error">{{ addressError }}</div>
        </form>

        <div
          v-if="agentControl"
          class="bp-agent"
          role="status"
          data-test="browser-agent"
          :title="t('browser.agent.hint', 'An agent is reading and clicking in this page (Settings > Agents > Let agents use the browser)')"
        >
          <Bot :size="14" aria-hidden="true" />
          <span class="bp-agent-text">{{ agentText }}</span>
          <button type="button" class="bp-agent-stop" data-test="browser-agent-stop" :title="t('browser.agent.stopHint', 'Stop agents from driving this page')" @click="stopAgent">
            {{ t('browser.agent.stop', 'Stop') }}
          </button>
        </div>

        <div class="bp-menu-anchor">
          <button
            type="button"
            class="bp-btn bp-ports-btn"
            data-test="browser-ports"
            :class="{ on: portsOpen }"
            :title="t('browser.ports.hint', 'Local ports: open a dev server here')"
            :aria-label="t('browser.ports.title', 'Ports')"
            :aria-expanded="portsOpen"
            @click="togglePorts"
          >
            <Plug :size="15" />
            <span v-if="ports.length" class="bp-badge">{{ ports.length }}</span>
          </button>
          <div
            v-if="portsOpen"
            class="bp-menu bp-ports"
            :style="{ transform: portsShift ? `translateX(${portsShift}px)` : null, width: portsWidth ? portsWidth + 'px' : null }"
            data-test="browser-ports-popover"
          >
            <div class="bp-ports-head">
              <span class="bp-ports-title"><Plug :size="12" aria-hidden="true" />{{ t('browser.ports.title', 'Ports') }}</span>
              <span class="bp-ports-count">{{ portsCount }}</span>
            </div>
            <div v-if="!ports.length" class="bp-ports-empty">{{ t('browser.ports.none', 'No workspace ports detected') }}</div>
            <div v-else class="bp-ports-list">
              <button
                v-for="p in ports"
                :key="p.id || p.url || p.port"
                type="button"
                class="bp-port-row"
                data-test="browser-port-row"
                :title="t('browser.ports.openHint', 'Open {{address}} in this pane', { address: portAddress(p) })"
                @click="openPort(p)"
              >
                <span class="bp-port-num">{{ p.port }}</span>
                <span class="bp-port-info">
                  <span class="bp-port-proc">{{ portProcess(p) }}</span>
                  <span class="bp-port-addr">{{ portAddress(p) }}</span>
                </span>
              </button>
            </div>
          </div>
        </div>

        <button
          type="button"
          class="bp-btn"
          data-test="browser-design"
          :class="{ on: designActive }"
          :disabled="isBlank || guestId == null"
          :aria-pressed="designActive"
          :title="t('browser.tools.design', 'Design Mode: pick an element to send to an agent')"
          :aria-label="t('browser.tools.designLabel', 'Design Mode')"
          @click="toggleDesign"
        >
          <Crosshair :size="16" />
        </button>
        <button
          type="button"
          class="bp-btn"
          data-test="browser-screenshot"
          :disabled="isBlank || guestId == null"
          :title="t('browser.tools.screenshot', 'Take a screenshot of the page')"
          :aria-label="t('browser.tools.screenshot', 'Take a screenshot of the page')"
          @click="screenshot"
        >
          <Camera :size="16" />
        </button>
        <button
          type="button"
          class="bp-btn"
          data-test="browser-devtools"
          :disabled="isBlank || guestId == null"
          :title="t('browser.tools.devTools', 'Open browser devtools (F12)')"
          :aria-label="t('browser.tools.devToolsLabel', 'Open browser devtools')"
          @click="openDevTools"
        >
          <SquareCode :size="16" />
        </button>
        <button
          type="button"
          class="bp-btn"
          data-test="browser-clear-data"
          :title="t('browser.tools.clearData', 'Clear browsing data (cookies, site storage, cache)')"
          :aria-label="t('browser.tools.clearDataLabel', 'Clear browsing data')"
          @click="clearData"
        >
          <Eraser :size="16" />
        </button>
        <button
          type="button"
          class="bp-btn"
          data-test="browser-external"
          :disabled="isBlank"
          :title="t('browser.tools.external', 'Open in default browser')"
          :aria-label="t('browser.tools.external', 'Open in default browser')"
          @click="openExternal()"
        >
          <ExternalLink :size="16" />
        </button>
      </div>

      <div ref="pageEl" class="bp-page" :class="{ hosted }" data-test="browser-page" @pointerleave="saveScroll">
        <!-- Over the page: in its box when it lives in the page layer. -->
        <Teleport :to="overlayTarget" :disabled="!overlayTarget">

        <!-- Orca's find bar: top right of the page. -->
        <div v-if="findOpen" class="bp-find" role="search" data-test="browser-find" @mousedown.stop>
          <Search :size="14" class="bp-find-icon" aria-hidden="true" />
          <input
            ref="findEl"
            v-model="findQuery"
            class="bp-find-input"
            type="text"
            spellcheck="false"
            autocomplete="off"
            data-test="browser-find-input"
            :placeholder="t('browser.find.placeholder', 'Find in page...')"
            :aria-label="t('browser.find.label', 'Find in page')"
            @input="onFindInput"
            @keydown="onFindKeydown"
          />
          <span v-if="findQuery" class="bp-find-count" data-test="browser-find-count">{{ findCount }}</span>
          <button
            type="button"
            class="bp-btn bp-find-btn"
            data-test="browser-find-prev"
            :title="t('browser.find.previous', 'Previous match (Shift+Enter)')"
            :aria-label="t('browser.find.previousLabel', 'Previous match')"
            :disabled="!findQuery"
            @click="runFind(false)"
          >
            <ChevronUp :size="14" />
          </button>
          <button
            type="button"
            class="bp-btn bp-find-btn"
            data-test="browser-find-next"
            :title="t('browser.find.next', 'Next match (Enter)')"
            :aria-label="t('browser.find.nextLabel', 'Next match')"
            :disabled="!findQuery"
            @click="runFind(true)"
          >
            <ChevronDown :size="14" />
          </button>
          <button
            type="button"
            class="bp-btn bp-find-btn"
            data-test="browser-find-close"
            :title="t('browser.find.close', 'Close (Esc)')"
            :aria-label="t('browser.find.closeLabel', 'Close find')"
            @click="(closeFind(), focusPage())"
          >
            <X :size="14" />
          </button>
        </div>

        <DesignModePanel
          ref="design"
          :guest-id="guestId"
          :page-url="currentUrl"
          :page-title="pageTitle"
          :pane-id="node.id"
          @active="designActive = $event"
        />

        <!-- Orca's blank tab, with the active local servers one click away. -->
        <div v-if="showEmpty" class="bp-empty" data-test="browser-empty">
          <div class="bp-empty-inner">
            <div class="bp-round"><Globe :size="20" /></div>
            <p class="bp-empty-title">{{ t('browser.empty.title', 'New Tab') }}</p>
            <p class="bp-empty-text">{{ t('browser.empty.text', 'Type a URL above to start browsing.') }}</p>
            <div v-if="ports.length" class="bp-empty-ports">
              <div class="bp-empty-ports-label">{{ t('browser.empty.ports', 'Local servers') }}</div>
              <button
                v-for="p in ports.slice(0, 6)"
                :key="p.id || p.url || p.port"
                type="button"
                class="bp-empty-port"
                data-test="browser-empty-port"
                :title="t('browser.ports.openHint', 'Open {{address}} in this pane', { address: portAddress(p) })"
                @click="openPort(p)"
              >
                <span class="bp-port-num">{{ p.port }}</span>
                <span class="bp-port-proc">{{ portProcess(p) }}</span>
              </button>
            </div>
          </div>
        </div>

        <!-- Orca's load failure overlay. -->
        <div v-if="failureView" class="bp-failure" data-test="browser-failure" aria-live="polite">
          <div class="bp-failure-inner">
            <div class="bp-round">
              <ShieldAlert v-if="failureView.kind === 'certificate'" :size="20" />
              <Globe v-else :size="20" />
            </div>
            <h2 class="bp-failure-title" data-test="browser-failure-title">{{ failureView.title }}</h2>
            <p class="bp-failure-text">{{ failureView.description }}</p>
            <p v-for="h in failureView.hints" :key="h" class="bp-failure-hint">{{ h }}</p>
            <div class="bp-failure-actions">
              <button v-if="failureView.httpsUrl" type="button" class="bp-fbtn primary" data-test="browser-try-https" @click="navigate(failureView.httpsUrl)">
                {{ t('browser.failure.tryHttps', 'Try HTTPS') }}
              </button>
              <button type="button" class="bp-fbtn outline" data-test="browser-retry" @click="retry">
                <RefreshCw :size="15" />{{ t('browser.failure.retry', 'Retry') }}
              </button>
              <button v-if="failure.kind !== 'crash'" type="button" class="bp-fbtn" data-test="browser-copy" @click="copyAddress(failure.url)">
                <Copy :size="15" />{{ t('browser.failure.copyAddress', 'Copy Address') }}
              </button>
              <button
                v-if="failure.kind !== 'crash' && displayUrl(failure.url)"
                type="button"
                class="bp-fbtn"
                data-test="browser-open-external"
                @click="openExternal(failure.url)"
              >
                <ExternalLink :size="15" />{{ t('browser.failure.openExternally', 'Open Externally') }}
              </button>
            </div>
          </div>
        </div>

        <div class="bp-zoom" :class="{ shown: zoomShown }" role="status" aria-live="polite" :aria-hidden="!zoomShown" data-test="browser-zoom">
          {{ zoomText }}
        </div>
        </Teleport>
      </div>
    </div>
  </div>
</template>

<style scoped>
.browser-pane {
  outline: none;
}

/* In the side panel: no header above the toolbar, no active ring. */
.browser-pane.in-side .bp-body {
  top: 0;
}
.browser-pane.in-side::after {
  display: none;
}

.bp-body {
  position: absolute;
  top: 30px;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

/* Orca's navigation control row: back, forward, reload, the address, tools. */
.bp-toolbar {
  position: relative;
  z-index: 5; /* its menus over the page; under the pane's active ring */
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 4px;
  height: 38px;
  padding: 0 8px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}

.bp-btn {
  position: relative;
  display: inline-grid;
  flex: 0 0 auto;
  place-items: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
}

.bp-btn:hover:not(:disabled) {
  background: var(--surface-3);
  color: var(--text-strong);
}

.bp-btn:disabled {
  opacity: 0.35;
  cursor: default;
}

.bp-btn.on {
  background: color-mix(in srgb, var(--accent) 22%, transparent);
  color: var(--accent);
}

.bp-btn:focus-visible,
.bp-fbtn:focus-visible,
.bp-port-row:focus-visible,
.bp-empty-port:focus-visible {
  outline: 1px solid var(--accent);
  outline-offset: 1px;
}

.bp-spin {
  animation: bp-spin 0.9s linear infinite;
}

@keyframes bp-spin {
  to {
    transform: rotate(360deg);
  }
}

/* Orca's address bar: a rounded field with a leading globe. */
.bp-address {
  position: relative;
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  gap: 8px;
  min-width: 44px;
  height: 28px;
  margin: 0 4px;
  padding: 0 10px;
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  background: var(--term);
  cursor: text;
}

.bp-address:focus-within {
  border-color: color-mix(in srgb, var(--accent) 70%, var(--border-strong));
}

.bp-address.invalid {
  border-color: var(--danger);
}

.bp-address-icon {
  flex: 0 0 auto;
  color: var(--text-dim);
}

.bp-address-input {
  flex: 1 1 auto;
  min-width: 0;
  height: 100%;
  padding: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text-strong);
  font: inherit;
  font-size: 13px;
}

.bp-address-input::placeholder {
  color: var(--text-dim);
}

.bp-address-error {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: 20;
  padding: 5px 9px;
  border: 1px solid color-mix(in srgb, var(--danger) 60%, var(--border));
  border-radius: 6px;
  background: var(--surface-2);
  color: var(--text-strong);
  font-size: 12px;
  white-space: nowrap;
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.3);
}

.bp-menu-anchor {
  position: relative;
  flex: 0 0 auto;
}

.bp-agent {
  display: flex;
  align-items: center;
  gap: 5px;
  flex: 0 1 auto;
  min-width: 0;
  height: 24px;
  padding: 0 3px 0 7px;
  border-radius: 12px;
  border: 1px solid var(--accent);
  color: var(--accent);
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}
.bp-agent-text {
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.bp-agent-stop {
  flex: 0 0 auto;
  height: 18px;
  padding: 0 8px;
  border: none;
  border-radius: 9px;
  background: var(--accent);
  color: var(--chrome);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.bp-agent-stop:hover {
  filter: brightness(1.1);
}
.bp-badge {
  position: absolute;
  top: 1px;
  right: 0;
  min-width: 13px;
  height: 13px;
  padding: 0 3px;
  border-radius: 7px;
  background: var(--accent);
  color: var(--chrome);
  font-size: 9px;
  font-weight: 700;
  line-height: 13px;
  text-align: center;
}

.bp-menu {
  position: absolute;
  top: calc(100% + 6px);
  z-index: 30;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  background: var(--surface-2);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.35);
  overflow: hidden;
}

.bp-reload-menu {
  left: -4px;
  min-width: 190px;
  padding: 4px;
}

.bp-menu-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  width: 100%;
  padding: 6px 8px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
}

.bp-menu-item:hover {
  background: var(--surface-3);
  color: var(--text-strong);
}

.bp-menu-kbd {
  color: var(--text-dim);
  font-size: 11px;
}

/* Orca's ports popover: port in mono, then the process and its address. */
.bp-ports {
  right: 0;
  width: 300px;
  max-width: calc(100vw - 32px);
}

.bp-ports-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border);
}

.bp-ports-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-strong);
  font-size: 11px;
  font-weight: 500;
}

.bp-ports-title svg {
  color: var(--text-dim);
}

.bp-ports-count {
  color: var(--text-dim);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.bp-ports-empty {
  padding: 16px 12px;
  color: var(--text-dim);
  font-size: 12px;
  text-align: center;
}

.bp-ports-list {
  max-height: 320px;
  padding: 4px;
  overflow-y: auto;
}

.bp-port-row {
  display: grid;
  grid-template-columns: 4.5rem minmax(0, 1fr);
  align-items: start;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.bp-port-row:hover {
  background: var(--surface-3);
}

.bp-port-num {
  color: var(--text-strong);
  font-family: 'Cascadia Mono', Consolas, monospace;
  font-size: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.bp-port-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.bp-port-proc,
.bp-port-addr {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bp-port-proc {
  color: var(--text-dim);
  font-size: 11px;
}

.bp-port-addr {
  color: color-mix(in srgb, var(--text-dim) 75%, transparent);
  font-size: 10px;
}

/* The page area: the webview fills it (a flex item in a flex box, every
   level allowed to shrink), Design Mode and the overlays sit over it. With
   the page in the workspace's page layer (browser/pageHost.js) it is only a
   place: see-through, so a maximized pane shows its page there. */
.bp-page {
  position: relative;
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--term);
}

.browser-pane.hosted,
.bp-page.hosted {
  background: transparent;
}

.bp-webview {
  display: flex;
  flex: 1 1 auto;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  border: none;
}

/* Orca's find bar. */
.bp-find {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 7;
  display: flex;
  align-items: center;
  gap: 4px;
  width: min(360px, calc(100% - 16px));
  padding: 3px 4px 3px 8px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  background: var(--surface-2);
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.3);
}

.bp-find-icon {
  flex: 0 0 auto;
  color: var(--text-dim);
}

.bp-find-input {
  flex: 1 1 auto;
  min-width: 0;
  height: 24px;
  padding: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text-strong);
  font: inherit;
  font-size: 13px;
}

.bp-find-count {
  flex: 0 0 auto;
  color: var(--text-dim);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.bp-find-btn {
  width: 24px;
  height: 24px;
}

/* A drag over the page must reach Tessel, not the page. Plain descendant
   selectors: in scoped CSS, `:global(body.x) .bp-webview` compiles to just
   `body.x` and made the whole window ignore the pointer during a pane drag. */
body.pane-dragging .bp-webview,
body.ws-resizing .bp-webview,
.split:has(.divider.dragging) .bp-webview {
  pointer-events: none;
}

.bp-empty,
.bp-failure {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 24px;
  background: var(--term);
  overflow: auto;
}

.bp-empty {
  z-index: 3;
  background: radial-gradient(circle at center, rgba(255, 255, 255, 0.02), transparent 58%), var(--term);
}

.bp-failure {
  z-index: 4;
}

.bp-empty-inner,
.bp-failure-inner {
  display: flex;
  flex-direction: column;
  align-items: center;
  max-width: 32rem;
  padding: 32px;
  text-align: center;
}

.bp-round {
  display: grid;
  place-items: center;
  margin-bottom: 16px;
  padding: 12px;
  border: 1px solid var(--border-strong);
  border-radius: 50%;
  background: var(--surface-2);
  color: var(--text-dim);
}

.bp-empty-title,
.bp-failure-title {
  margin: 0;
  color: var(--text-strong);
  font-size: 15px;
  font-weight: 600;
}

.bp-empty-title {
  opacity: 0.85;
}

.bp-empty-text,
.bp-failure-text {
  margin: 8px 0 0;
  color: var(--text-dim);
  font-size: 13px;
}

.bp-failure-hint {
  margin: 8px 0 0;
  color: var(--text-dim);
  font-size: 12px;
}

.bp-empty-ports {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 260px;
  margin-top: 22px;
}

.bp-empty-ports-label {
  margin-bottom: 4px;
  color: var(--text-dim);
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.bp-empty-port {
  display: grid;
  grid-template-columns: 4rem minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--surface);
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.bp-empty-port:hover {
  border-color: var(--border-strong);
  background: var(--surface-3);
}

.bp-failure-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin-top: 20px;
}

.bp-fbtn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 34px;
  padding: 0 12px;
  border: 1px solid transparent;
  border-radius: 7px;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
}

.bp-fbtn:hover {
  background: var(--surface-3);
  color: var(--text-strong);
}

.bp-fbtn.outline {
  border-color: var(--border-strong);
}

.bp-fbtn.primary {
  background: var(--accent);
  color: var(--chrome);
  font-weight: 600;
}

.bp-fbtn.primary:hover {
  background: color-mix(in srgb, var(--accent) 85%, white);
  color: var(--chrome);
}

/* Orca's zoom indicator: top right, fades out. */
.bp-zoom {
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 6;
  padding: 4px 10px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: var(--surface-2);
  color: var(--text-strong);
  font-size: 12px;
  font-weight: 500;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.3s ease-out;
}

.bp-zoom.shown {
  opacity: 1;
}
</style>
