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
//   screen sharing: refused, the window says so).
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
// The only permissions a page gets: writing to the clipboard (a "Copy"
// button) and full screen (a video player; it fills the pane, not the screen).
const GRANTED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen'])
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
      if (!ok && shouldTellDenied(wc, permission)) {
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
    delete webPreferences.preload
    delete webPreferences.preloadURL
    delete params.preload
    delete webPreferences.additionalArguments
    // Only the partition below picks the page's session.
    delete webPreferences.session
    webPreferences.nodeIntegration = false
    webPreferences.nodeIntegrationInSubFrames = false
    webPreferences.nodeIntegrationInWorker = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    webPreferences.webSecurity = true
    webPreferences.allowRunningInsecureContent = false
    webPreferences.experimentalFeatures = false
    webPreferences.enableBlinkFeatures = ''
    webPreferences.webviewTag = false
    webPreferences.partition = BROWSER_PARTITION
    webPreferences.disableHtmlFullscreenWindowResize = true
    // alert() in a loop would hold Tessel's whole window: from the second
    // dialog on, the page's dialogs can be turned off.
    webPreferences.safeDialogs = true
    params.src = src
  }

  // did-attach-webview: the page's own rules.
  function onDidAttach(_event, guest) {
    guest.setWindowOpenHandler(({ url }) => {
      // A link to a new window: opened in the same pane (the window decides).
      const target = allowedBrowserUrl(url)
      if (target && target !== BLANK_URL) send('browser:popup', { webContentsId: guest.id, url: target })
      return { action: 'deny' }
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

  // A page of the browser shown in Tessel's window, asked for by the window.
  function guestFor(event, id) {
    const win = getWindow()
    if (!win || win.isDestroyed() || event.sender !== win.webContents) return null
    const guest = Number.isSafeInteger(id) ? webContents.fromId(id) : null
    if (!guest || guest.isDestroyed() || guest.getType() !== 'webview') return null
    if (guest.hostWebContents !== win.webContents) return null
    if (guest.session !== browserSession()) return null
    return guest
  }

  // --- Design Mode ------------------------------------------------------------------
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
    // A screenshot Tessel saved, onto the clipboard (paste it anywhere).
    ipcMain.handle('browser:copyImage', (event, file) => {
      const win = getWindow()
      if (!win || event.sender !== win.webContents) return { ok: false }
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

  return { attachToWindow, register, onWillAttach, onDidAttach, guestFor, capture, pick, shortcutOf, isScreenshot, browserSession }
}

export { shortcutOf }
