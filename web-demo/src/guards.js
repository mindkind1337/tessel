// What the Electron main process would stop, and a browser would not. Nothing leaves
// the page: no new windows, no link followed away from it, no page in a <webview>,
// and no storage shared with the site or with the next visit.

// A storage in memory: each visit starts the same, and leaves nothing behind.
export function memoryStorage() {
  const items = new Map()
  return {
    get length() {
      return items.size
    },
    key: (i) => [...items.keys()][i] ?? null,
    getItem: (k) => (items.has(String(k)) ? items.get(String(k)) : null),
    setItem: (k, v) => void items.set(String(k), String(v)),
    removeItem: (k) => void items.delete(String(k)),
    clear: () => items.clear()
  }
}

// A <webview> without Electron: an element that answers what BrowserPane.vue asks of
// one, and never loads anything. The pane itself stays the real one: its address bar,
// its buttons, its empty page. An address "opened" shows a note where the page would be.
function inertWebview(el, t) {
  const fire = (name, fields) => el.dispatchEvent(Object.assign(new Event(name), fields))
  let url = 'about:blank'
  const notice = document.createElement('div')
  notice.hidden = true
  Object.assign(notice.style, { margin: 'auto', padding: '16px', textAlign: 'center', font: '13px/1.5 var(--font-ui, system-ui)', color: 'var(--text-dim, #99a1ae)' })
  const line = document.createElement('div')
  line.textContent = t('demo.browserPage', 'The built-in browser needs the desktop app.')
  const hint = document.createElement('div')
  hint.textContent = t('demo.browserPageHint', 'In this demo no page opens, and nothing leaves this page.')
  hint.style.opacity = '0.75'
  notice.append(line, hint)
  el.append(notice)
  const answers = { canGoBack: false, canGoForward: false, getTitle: '', getWebContentsId: null, getZoomFactor: 1, getZoomLevel: 0, isAudioMuted: false, isCrashed: false, isCurrentlyAudible: false, isDevToolsOpened: false, isLoading: false }
  for (const [name, value] of Object.entries(answers)) el[name] = () => value
  for (const name of ['stop', 'reload', 'reloadIgnoringCache', 'goBack', 'goForward', 'setZoomLevel', 'setZoomFactor', 'setAudioMuted', 'openDevTools', 'closeDevTools', 'stopFindInPage', 'findInPage']) el[name] = () => {}
  for (const name of ['executeJavaScript', 'insertCSS', 'capturePage', 'send']) el[name] = () => Promise.resolve()
  el.getURL = () => url
  el.loadURL = (next) => {
    url = String(next)
    notice.hidden = url === 'about:blank'
    fire('did-navigate', { url })
    fire('did-stop-loading')
    return Promise.resolve()
  }
  // As a real one, once it is in the page and its listeners are on.
  setTimeout(() => {
    const src = el.getAttribute('src')
    fire('dom-ready')
    if (src && src !== 'about:blank') el.loadURL(src)
    else fire('did-stop-loading')
  }, 60)
  return el
}

export function installGuards({ t }) {
  // Storage: never the site's, never kept.
  try {
    Object.defineProperty(window, 'localStorage', { value: memoryStorage(), configurable: true })
    Object.defineProperty(window, 'sessionStorage', { value: memoryStorage(), configurable: true })
  } catch {
    /* the app guards its own reads */
  }
  // Chromium's note that a resize notification was put off to the next frame: harmless,
  // and not an error of the page. Kept out of the console and of Tessel's crash screen.
  window.addEventListener(
    'error',
    (e) => {
      if (!/^ResizeObserver loop/.test(String(e.message || ''))) return
      e.preventDefault()
      e.stopImmediatePropagation()
    },
    true
  )
  // No new windows.
  window.open = () => null
  // No link followed away from the page (Tessel's own handlers still run).
  document.addEventListener(
    'click',
    (e) => {
      const a = e.target && e.target.closest ? e.target.closest('a[href]') : null
      if (!a) return
      const href = a.getAttribute('href') || ''
      if (href && !href.startsWith('#')) e.preventDefault()
    },
    true
  )
  // A form never posts anywhere (the CSP's form-action says the same).
  document.addEventListener('submit', (e) => e.preventDefault(), true)
  // <webview>: an inert element, its methods doing nothing.
  const create = document.createElement.bind(document)
  document.createElement = (tag, options) => {
    const el = create(tag, options)
    return String(tag).toLowerCase() === 'webview' ? inertWebview(el, t) : el
  }
}
