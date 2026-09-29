// The built-in browser's pages (main process). The window shows each page in
// a <webview> (BrowserPane.vue); everything that decides what such a page
// may do is here, never in the window. After Orca's browser guest policies
// (MIT, Copyright (c) 2026 Lovecast Inc.: src/main/window/main-window-
// webview-security.ts, src/main/browser/browser-manager-guest-navigation-
// policy.ts, browser-manager-guest-popup-policy.ts, browser-session-
// partition-policies.ts, browser-grab-screenshot.ts).
//
// - A page is attached only in Tessel's window, only in the browser's own
//   session (BROWSER_PARTITION: its cookies and storage apart from Tessel's),
//   only on an http(s) page or the blank page, and always with: no preload
//   (the page never sees Tessel's shellApi), sandbox, context isolation, no
//   Node, web security on.
// - It only goes to http(s) pages (a link, a redirect); a new window opens in
//   the same pane instead (the window is told); nothing is downloaded (the
//   window offers the system browser instead); no permission is granted but
//   writing to the clipboard (camera, microphone, location, notifications,
//   screen sharing: refused, the window says so; full screen: refused
//   silently, it would put all of Tessel's window in full screen).
// - A new window only right after the user clicked or typed in the page (an
//   ad frame opening one on its own is refused).
// - Design Mode (pick an element, a screenshot) runs a script in the page
//   (browserPicker.js); what comes back is untrusted and checked again here.
import fs from 'fs'
import { join, relative } from 'path'
import crypto from 'crypto'
import { allowedBrowserUrl, BLANK_URL } from '../shared/browserUrl'
import { pickerScript, clampPickPayload } from './browserPicker'

export const BROWSER_PARTITION = 'persist:tessel-browser'
// A picked element's screenshot, a page's: at most this big (PNG).
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024
// A screenshot the page never gives.
const CAPTURE_TIMEOUT_MS = 4000
// Waiting for a click on the page.
const PICK_TIMEOUT_MS = 10 * 60 * 1000
// The only permission a page gets: writing to the clipboard (a "Copy"
// button). Not full screen: it put the whole of Tessel's window in full screen.
const GRANTED_PERMISSIONS = new Set(['clipboard-sanitized-write'])
// Refused without telling the window: every video player asks for it.
const SILENT_DENIALS = new Set(['fullscreen'])
// A new window counts only this soon after the user's own click or key in
// the page (a popup blocker's rule); later, or with none, it is refused.
const POPUP_GESTURE_MS = 1500
// The user's input that may open a window (what browsers call an activation).
const GESTURE_INPUTS = new Set(['mouseDown', 'mouseUp', 'keyDown', 'rawKeyDown', 'touchStart', 'touchEnd', 'gestureTap', 'pointerDown', 'pointerUp'])
// What the window may still choose for a page, the rest of its
// webPreferences is dropped: display settings that grant nothing (zoom, spell
// check, default text encoding, throttling when hidden) and two switches that
// only take away (no dialogs, no popups).
const KEPT_WEB_PREFERENCES = new Set(['zoomFactor', 'spellcheck', 'defaultEncoding', 'backgroundThrottling', 'disableDialogs', 'disablePopups'])
// Screenshots and Design Mode messages (screenshotDir) kept this long.
const KEEP_FILES_MS = 24 * 60 * 60 * 1000
const OWN_FILE = /^browser-(?:\d+-[0-9a-f]{6}\.png|feedback-\d+-[0-9a-f]{6}\.md)$/i
// A Design Mode message saved for an agent: at most this big (UTF-8).
const MAX_FEEDBACK_BYTES = 512 * 1024
// A page asking again and again: said once a minute per page and permission.
const DENIED_NOTICE_MS = 60 * 1000
// Keys the page keeps from the window (they would go to the page): the
// browser's own shortcuts are sent to the window.
function shortcutOf(input) {
  if (input.type !== 'keyDown') return null
  const ctrl = input.control || input.meta
  const key = String(input.key || '')
  const k = key.toLowerCase()
  if (ctrl && !input.alt && k === 'l') return 'focusAddress'
  if ((ctrl && !input.shift && k === 'r') || (key === 'F5' && !ctrl)) return 'reload'
  if ((ctrl && input.shift && k === 'r') || (key === 'F5' && ctrl)) return 'hardReload'
  if (input.alt && !ctrl && key === 'ArrowLeft') return 'back'
  if (input.alt && !ctrl && key === 'ArrowRight') return 'forward'
  if (key === 'F12' || (ctrl && input.shift && k === 'i')) return 'devTools'
  if (ctrl && !input.alt && (key === '=' || key === '+')) return 'zoomIn'
  if (ctrl && !input.alt && key === '-') return 'zoomOut'
  if (ctrl && !input.alt && key === '0') return 'zoomReset'
  // Tessel's own shortcuts (Ctrl+Shift+P, Ctrl+Shift+W, Ctrl+PageDown, F1...):
  // the window runs them as if the page were not there.
  if (ctrl && input.shift && !input.alt && APP_KEYS.includes(k)) return 'app'
  if (ctrl && !input.shift && !input.alt && (key === 'PageUp' || key === 'PageDown' || key === ',')) return 'app'
  if (key === 'F1') return 'app'
  return null
}
const APP_KEYS = ['e', 'o', 'w', 'b', 'k', 'x', 'g', 'n', 't', ' ', 'p', 'j']

export function createBrowserGuests({ getWindow, send, log = null, screenshotDir, electron }) {
  const { webContents, clipboard, nativeImage, session: electronSession } = electron
  // guest id -> { cancel } while an element is being picked.
  const picking = new Map()
  let sessionReady = false

  const warn = (msg) => log && log.warn('browser', msg)

  // The browser's session: its permissions and downloads (once).
  function browserSession() {
    const ses = electronSession.fromPartition(BROWSER_PARTITION)
    if (sessionReady) return ses
    sessionReady = true
    ses.setPermissionRequestHandler((wc, permission, callback, details) => {
      const ok = GRANTED_PERMISSIONS.has(permission)
      if (!ok && !SILENT_DENIALS.has(permission) && shouldTellDenied(wc, permission)) {
        send('browser:permissionDenied', {
          webContentsId: wc && !wc.isDestroyed() ? wc.id : null,
          permission: String(permission).slice(0, 60),
          origin: originOf((details && details.requestingUrl) || (wc && !wc.isDestroyed() ? wc.getURL() : ''))
        })
      }
      callback(ok)
    })
    ses.setPermissionCheckHandler((_wc, permission) => GRANTED_PERMISSIONS.has(permission))
    // Screen sharing: never. null refuses it (an object without the video
    // asked for makes Electron throw a TypeError in the main process).
    if (typeof ses.setDisplayMediaRequestHandler === 'function') ses.setDisplayMediaRequestHandler((_req, callback) => callback(null))
    // Nothing is saved on its own: the window offers the system browser.
    ses.on('will-download', (event, item, wc) => {
      event.preventDefault()
      const url = allowedBrowserUrl(item.getURL())
      send('browser:downloadBlocked', {
        webContentsId: wc && !wc.isDestroyed() ? wc.id : null,
        url: url && url !== BLANK_URL ? url : null,
        name: String(item.getFilename() || '').slice(0, 200)
      })
    })
    return ses
  }

  const deniedAt = new Map()
  function shouldTellDenied(wc, permission) {
    const key = `${wc && !wc.isDestroyed() ? wc.id : 0}:${permission}`
    const at = Date.now()
    if (at - (deniedAt.get(key) || 0) < DENIED_NOTICE_MS) return false
    deniedAt.set(key, at)
    if (deniedAt.size > 500) deniedAt.clear()
    return true
  }

  function originOf(url) {
    try {
      const origin = new URL(String(url)).origin
      return origin === 'null' ? '' : origin.slice(0, 300)
    } catch {
      return ''
    }
  }

  // --- Attaching a page in the window --------------------------------------------
  // will-attach-webview of Tessel's window: refused unless it is the
  // browser's, and always locked down.
  function onWillAttach(event, webPreferences, params) {
    const src = params.src ? allowedBrowserUrl(params.src) : BLANK_URL
    if (params.partition !== BROWSER_PARTITION || !src) {
      warn(`refused a page: ${String(params.partition || '').slice(0, 60)} ${String(params.src || '').slice(0, 200)}`)
      event.preventDefault()
      return
    }
    browserSession()
    // Rebuilt from an allow-list rather than cleaned key by key: a setting
    // Electron adds later (or one forgotten here) never reaches the page.
    // Gone with it: preload, preloadURL, additionalArguments, session (only
    // the partition below picks the page's session), enableBlinkFeatures...
    for (const key of Object.keys(webPreferences)) {
      if (!KEPT_WEB_PREFERENCES.has(key)) delete webPreferences[key]
    }
    delete params.preload
    Object.assign(webPreferences, {
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
      plugins: false,
      javascript: true,
      partition: BROWSER_PARTITION,
      disableHtmlFullscreenWindowResize: true,
      // alert() in a loop would hold Tessel's whole window: from the second
      // dialog on, the page's dialogs can be turned off.
      safeDialogs: true
    })
    params.src = src
  }

  // did-attach-webview: the page's own rules.
  function onDidAttach(_event, guest) {
    // When the user last clicked or typed in the page, and whether Tessel's
    // window was in full screen then (a page needs that click to ask for full
    // screen, so it is the window's state from before the page's).
    let gestureAt = 0
    let windowWasFull = null
    let popupWarned = false
    const noteGesture = (type) => {
      if (!GESTURE_INPUTS.has(type)) return
      gestureAt = Date.now()
      const win = getWindow()
      windowWasFull = win && !win.isDestroyed() && typeof win.isFullScreen === 'function' ? win.isFullScreen() : null
    }
    guest.on('input-event', (_event, input) => noteGesture(input && input.type))
    guest.on('before-mouse-event', (_event, mouse) => noteGesture(mouse && mouse.type))

    guest.setWindowOpenHandler(({ url }) => {
      // A link to a new window: opened in the same pane (the window decides).
      const target = allowedBrowserUrl(url)
      if (!target || target === BLANK_URL) return { action: 'deny' }
      // Only right after the user's own click or key, once per input: an ad
      // frame opening windows on its own would take the pane away.
      if (Date.now() - gestureAt > POPUP_GESTURE_MS) {
        if (!popupWarned) warn(`blocked a new window without a click: ${target.slice(0, 200)}`)
        popupWarned = true
        return { action: 'deny' }
      }
      gestureAt = 0
      send('browser:popup', { webContentsId: guest.id, url: target })
      return { action: 'deny' }
    })

    // Full screen is refused (the permission); a page that gets there anyway
    // is taken out, and Tessel's window put back as it was.
    const undoFullScreen = () => {
      const win = getWindow()
      if (!win || win.isDestroyed() || typeof win.isFullScreen !== 'function') return
      if (windowWasFull !== true && win.isFullScreen()) win.setFullScreen(false)
    }
    guest.on('enter-html-full-screen', () => {
      warn('a page went full screen: taken out of it')
      if (!guest.isDestroyed()) guest.executeJavaScript('document.exitFullscreen && document.exitFullscreen()', false).catch(() => {})
      undoFullScreen()
      // The window may only get there a moment later.
      setTimeout(undoFullScreen, 250)
    })
    const guard = (event, url) => {
      if (!allowedBrowserUrl(url)) {
        event.preventDefault()
        warn(`blocked a navigation to ${String(url).slice(0, 200)}`)
      }
    }
    guest.on('will-navigate', guard)
    guest.on('will-redirect', guard)
    guest.on('will-frame-navigate', (event) => {
      // Frames too: never another scheme (a frame on javascript: or file:).
      if (event.url && !allowedBrowserUrl(event.url) && !/^(about:|data:|blob:)/i.test(event.url)) event.preventDefault()
    })
    guest.on('before-input-event', (event, input) => {
      if (input) noteGesture(input.type)
      const action = shortcutOf(input)
      if (!action) return
      event.preventDefault()
      const keys = action === 'app' ? { key: String(input.key).slice(0, 20), ctrl: !!(input.control || input.meta), shift: !!input.shift } : {}
      send('browser:shortcut', { webContentsId: guest.id, action, ...keys })
    })
    // A new page: an element being picked on the old one is dropped. A page
    // loaded some other way than a link (loadURL) is held to the same rule.
    guest.on('did-start-navigation', (details) => {
      if (!details || !details.isMainFrame || details.isSameDocument) return
      cancelPick(guest.id)
      if (!allowedBrowserUrl(details.url) && !/^(about:blank|data:text\/html,?$|chrome-error:)/i.test(String(details.url))) {
        warn(`stopped a page on ${String(details.url).slice(0, 200)}`)
        // Not from inside this event: loading another page there crashes
        // the main process (seen with Electron 42).
        setImmediate(() => {
          if (guest.isDestroyed()) return
          guest.stop()
          guest.loadURL(BLANK_URL).catch(() => {})
        })
      }
    })
    guest.on('destroyed', () => cancelPick(guest.id))
  }

  function attachToWindow(win) {
    win.webContents.on('will-attach-webview', onWillAttach)
    win.webContents.on('did-attach-webview', onDidAttach)
  }

  // Asked by Tessel's window, nothing else (browser:* channels are exempt
  // from index.js's IPC guard: each handler checks here).
  function fromWindow(event) {
    const win = getWindow()
    return !!(win && !win.isDestroyed() && event && event.sender === win.webContents)
  }

  // A page of the browser shown in Tessel's window, asked for by the window.
  function guestFor(event, id) {
    const win = getWindow()
    if (!fromWindow(event)) return null
    const guest = Number.isSafeInteger(id) ? webContents.fromId(id) : null
    if (!guest || guest.isDestroyed() || guest.getType() !== 'webview') return null
    if (guest.hostWebContents !== win.webContents) return null
    if (guest.session !== browserSession()) return null
    return guest
  }

  // --- Design Mode ------------------------------------------------------------------
  // Screenshots and saved messages older than a day go (they are only for
  // pasting now): at start and at each new one.
  function purgeOldFiles(now = Date.now()) {
    let names
    try {
      names = fs.readdirSync(screenshotDir)
    } catch {
      return
    }
    for (const name of names) {
      if (!OWN_FILE.test(name)) continue
      const file = join(screenshotDir, name)
      try {
        const st = fs.lstatSync(file)
        if (st.isFile() && now - st.mtimeMs > KEEP_FILES_MS) fs.unlinkSync(file)
      } catch {}
    }
  }

  // The Design Mode message, saved as a file the agent is told to read
  // (rather than the page's text typed into its terminal).
  // -> { ok: true, path } | { ok: false, code }
  function saveFeedback(text) {
    if (typeof text !== 'string' || !text.trim()) return { ok: false, code: 'invalid' }
    if (text.length > MAX_FEEDBACK_BYTES || Buffer.byteLength(text, 'utf8') > MAX_FEEDBACK_BYTES) return { ok: false, code: 'too-big' }
    try {
      fs.mkdirSync(screenshotDir, { recursive: true })
      purgeOldFiles()
      const file = join(screenshotDir, `browser-feedback-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.md`)
      fs.writeFileSync(file, text, { encoding: 'utf8', flag: 'wx' })
      return { ok: true, path: file }
    } catch (err) {
      warn(`saving a Design Mode message failed: ${err.message}`)
      return { ok: false, code: 'failed' }
    }
  }

  // Everything the browser's pages kept: cookies, storage, cache, HTTP
  // authentication. Tessel's own session is not touched.
  async function clearData() {
    const ses = browserSession()
    try {
      await ses.clearStorageData()
      await ses.clearCache()
      await ses.clearAuthCache()
      if (typeof ses.clearHostResolverCache === 'function') await ses.clearHostResolverCache()
      return { ok: true }
    } catch (err) {
      warn(`clearing the browser data failed: ${err.message}`)
      return { ok: false }
    }
  }

  function cancelPick(id) {
    const p = picking.get(id)
    if (p) p.cancel()
  }

  // A screenshot of the page (all it shows, or the part `rect` in CSS
  // pixels), saved as a PNG file. -> { path, width, height } | null
  async function capture(guest, rect = null, viewportWidth = 0) {
    // A page that is not painted (its window hidden or minimized) never
    // answers: no screenshot then, rather than a pick that never ends.
    const img = await Promise.race([guest.capturePage(), new Promise((r) => setTimeout(() => r(null), CAPTURE_TIMEOUT_MS))])
    if (!img || img.isEmpty()) return null
    let out = img
    if (rect) {
      const size = img.getSize()
      // The picture's pixels per CSS pixel (zoom and screen scaling alike).
      const scale = viewportWidth > 0 ? size.width / viewportWidth : 1
      const x = Math.max(0, Math.floor(rect.x * scale))
      const y = Math.max(0, Math.floor(rect.y * scale))
      const w = Math.min(size.width - x, Math.ceil(rect.width * scale))
      const h = Math.min(size.height - y, Math.ceil(rect.height * scale))
      if (!(w > 0 && h > 0)) return null
      out = img.crop({ x, y, width: w, height: h })
    }
    const png = out.toPNG()
    if (png.length > MAX_SCREENSHOT_BYTES) return null
    fs.mkdirSync(screenshotDir, { recursive: true })
    purgeOldFiles()
    const file = join(screenshotDir, `browser-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.png`)
    fs.writeFileSync(file, png)
    const size = out.getSize()
    return { path: file, width: size.width, height: size.height }
  }

  // Waits for the page to paint once more (the picker's overlay gone), at
  // most a moment: a page never holds this up.
  async function settle(guest) {
    const painted = guest
      .executeJavaScript('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))', false)
      .catch(() => false)
    await Promise.race([painted, new Promise((r) => setTimeout(r, 400))])
  }

  // Pick an element: -> { ok, payload, screenshot } | { ok: true, cancelled } | { ok: false, error }
  async function pick(guest) {
    cancelPick(guest.id)
    let cancel
    const cancelled = new Promise((resolve) => {
      cancel = () => resolve({ cancelled: true })
    })
    const timer = setTimeout(() => cancel(), PICK_TIMEOUT_MS)
    const entry = { cancel: () => cancel() }
    picking.set(guest.id, entry)
    let raw
    try {
      // No user gesture: it would hand the page a user activation of its own
      // (popups, clipboard writes, fullscreen) without a real click.
      raw = await Promise.race([guest.executeJavaScript(pickerScript('arm'), false), cancelled])
    } catch (err) {
      raw = { error: (err && err.message) || '' }
    } finally {
      clearTimeout(timer)
      if (picking.get(guest.id) === entry) picking.delete(guest.id)
    }
    if (raw && raw.cancelled) {
      if (!guest.isDestroyed()) guest.executeJavaScript(pickerScript('teardown'), false).catch(() => {})
      return { ok: true, cancelled: true }
    }
    if (raw && raw.error !== undefined && !raw.element) return { ok: false, code: 'failed' }
    const payload = clampPickPayload(raw)
    if (!payload || payload.cancelled) return { ok: false, code: 'failed' }
    let screenshot = null
    try {
      await settle(guest)
      if (!guest.isDestroyed()) screenshot = await capture(guest, payload.element.rect, payload.viewport.width)
    } catch (err) {
      warn(`element screenshot failed: ${err.message}`)
    }
    return { ok: true, payload, screenshot }
  }

  function register(ipcMain) {
    ipcMain.handle('browser:pick', async (event, id) => {
      const guest = guestFor(event, id)
      return guest ? pick(guest) : { ok: false, code: 'no-page' }
    })
    ipcMain.handle('browser:cancelPick', (event, id) => {
      const guest = guestFor(event, id)
      if (guest) cancelPick(guest.id)
      return { ok: !!guest }
    })
    ipcMain.handle('browser:screenshot', async (event, id) => {
      const guest = guestFor(event, id)
      if (!guest) return { ok: false, code: 'no-page' }
      try {
        const shot = await capture(guest)
        return shot ? { ok: true, screenshot: shot } : { ok: false, code: 'failed' }
      } catch (err) {
        warn(`page screenshot failed: ${err.message}`)
        return { ok: false, code: 'failed' }
      }
    })
    ipcMain.handle('browser:openDevTools', (event, id) => {
      const guest = guestFor(event, id)
      if (!guest) return { ok: false }
      guest.openDevTools({ mode: 'detach' })
      return { ok: true }
    })
    ipcMain.handle('browser:clearData', (event) => (fromWindow(event) ? clearData() : { ok: false }))
    ipcMain.handle('browser:saveFeedback', (event, text) => (fromWindow(event) ? saveFeedback(text) : { ok: false, code: 'invalid' }))
    // A screenshot Tessel saved, onto the clipboard (paste it anywhere).
    ipcMain.handle('browser:copyImage', (event, file) => {
      if (!fromWindow(event)) return { ok: false }
      if (!isScreenshot(file)) return { ok: false }
      const img = nativeImage.createFromPath(file)
      if (img.isEmpty()) return { ok: false }
      clipboard.writeImage(img)
      return { ok: true }
    })
  }

  function isScreenshot(file) {
    if (typeof file !== 'string' || file.includes('..')) return false
    // Right in the screenshot folder (not in a folder whose name only starts
    // the same, like "paste-other").
    return /^browser-\d+-[0-9a-f]{6}\.png$/i.test(relative(screenshotDir, file)) && fs.existsSync(file)
  }

  purgeOldFiles()

  return { attachToWindow, register, onWillAttach, onDidAttach, guestFor, capture, pick, shortcutOf, isScreenshot, browserSession, purgeOldFiles, saveFeedback, clearData }
}

export { shortcutOf }
