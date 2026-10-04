// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import fs from 'fs'
import os from 'os'
import { join } from 'path'

vi.mock('../browserPicker', () => ({ pickerScript: (a) => `/*${a}*/`, clampPickPayload: (x) => x }))

import { createBrowserGuests, BROWSER_PARTITION, shortcutOf, contextMenuItems, wantsNewPane } from '../browserGuest'

const ev = (extra = {}) => ({ preventDefault: vi.fn(), ...extra })

function fakeSession() {
  const ses = new EventEmitter()
  ses.setPermissionRequestHandler = vi.fn((h) => (ses.request = h))
  ses.setPermissionCheckHandler = vi.fn((h) => (ses.check = h))
  ses.setDisplayMediaRequestHandler = vi.fn((h) => (ses.display = h))
  for (const name of ['clearStorageData', 'clearCache', 'clearAuthCache', 'clearHostResolverCache']) ses[name] = vi.fn(() => Promise.resolve())
  return ses
}

function fakeGuest({ id, host, ses, type = 'webview' }) {
  const g = new EventEmitter()
  g.destroyed = false
  // What the picker's 'arm' script gives back (a promise, or never).
  g.armResult = new Promise(() => {})
  Object.assign(g, {
    id,
    hostWebContents: host,
    session: ses,
    isDestroyed: () => g.destroyed,
    getType: () => type,
    getURL: () => 'https://page.test/now',
    setWindowOpenHandler: vi.fn((h) => (g.openHandler = h)),
    stop: vi.fn(),
    loadURL: vi.fn(() => Promise.resolve()),
    openDevTools: vi.fn(),
    capturePage: vi.fn(),
    executeJavaScript: vi.fn((code) => (code === '/*arm*/' ? g.armResult : Promise.resolve(true)))
  })
  return g
}

// A captured page: `width` x `height` pixels, PNG of `pngBytes` bytes.
function fakeImage(width, height, pngBytes = 16) {
  const img = {
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    toPNG: () => Buffer.alloc(pngBytes, 1),
    crop: vi.fn((r) => fakeImage(r.width, r.height, pngBytes))
  }
  return img
}

let dir
let root
let t
beforeEach(() => {
  root = fs.mkdtempSync(join(os.tmpdir(), 'tessel-browser-'))
  dir = join(root, 'paste')
  t = setup()
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function setup() {
  const sent = []
  const ses = fakeSession()
  const winWc = new EventEmitter()
  const win = Object.assign(new EventEmitter(), { webContents: winWc, isDestroyed: () => false, full: false })
  win.isFullScreen = vi.fn(() => win.full)
  win.setFullScreen = vi.fn((flag) => (win.full = flag))
  const guests = new Map()
  const menus = []
  const electron = {
    webContents: { fromId: vi.fn((id) => guests.get(id)), getFocusedWebContents: vi.fn(() => null) },
    clipboard: { writeImage: vi.fn(), writeText: vi.fn() },
    Menu: {
      buildFromTemplate: vi.fn((template) => {
        const menu = { template, popup: vi.fn() }
        menus.push(menu)
        return menu
      })
    },
    nativeImage: { createFromPath: vi.fn(() => ({ isEmpty: () => false })) },
    session: { fromPartition: vi.fn(() => ses) }
  }
  const log = { warn: vi.fn() }
  const openExternal = vi.fn()
  const bg = createBrowserGuests({ getWindow: () => win, send: (ch, payload) => sent.push([ch, payload]), log, screenshotDir: dir, electron, openExternal })
  bg.attachToWindow(win)
  const handlers = {}
  bg.register({ handle: (ch, fn) => (handlers[ch] = fn) })
  const fromWindow = { sender: winWc }
  // A page attached in the window the way Electron does it.
  const attach = (opts = {}) => {
    const g = fakeGuest({ id: 7, host: winWc, ses, ...opts })
    guests.set(g.id, g)
    winWc.emit('did-attach-webview', ev(), g)
    return g
  }
  const call = (ch, ...args) => handlers[ch](fromWindow, ...args)
  // The user's own click in a page (what Electron reports).
  const click = (g) => g.emit('input-event', ev(), { type: 'mouseDown' })
  return { click, sent, ses, winWc, win, guests, electron, log, bg, handlers, fromWindow, attach, call, menus, openExternal }
}

describe('will-attach-webview', () => {
  const attachParams = (params, prefs = {}) => {
    const e = ev()
    t.winWc.emit('will-attach-webview', e, prefs, params)
    return e
  }

  it('locks a page down whatever the window asked for', () => {
    const prefs = {
      preload: 'C:/evil/preload.js',
      preloadURL: 'file:///C:/evil/preload.js',
      additionalArguments: ['--tessel-dev'],
      session: {},
      nodeIntegration: true,
      nodeIntegrationInSubFrames: true,
      nodeIntegrationInWorker: true,
      contextIsolation: false,
      sandbox: false,
      webSecurity: false,
      allowRunningInsecureContent: true,
      experimentalFeatures: true,
      enableBlinkFeatures: 'Everything',
      webviewTag: true,
      partition: 'persist:other',
      // Settings nobody thought of: gone too.
      plugins: true,
      javascript: false,
      enableWebSQL: true,
      navigateOnDragDrop: true,
      offscreen: true,
      someFutureOption: 'x',
      // Kept: they grant nothing.
      zoomFactor: 1.5,
      spellcheck: false,
      disablePopups: false
    }
    const params = { src: 'http://localhost:5173', partition: BROWSER_PARTITION, preload: 'file:///C:/evil/preload.js' }
    const e = attachParams(params, prefs)
    expect(e.preventDefault).not.toHaveBeenCalled()
    expect(params).not.toHaveProperty('preload')
    // Exactly the allow-list and the fixed rules, nothing else.
    expect(prefs).toEqual({
      zoomFactor: 1.5,
      spellcheck: false,
      disablePopups: false,
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
      safeDialogs: true,
      // Opaque, white like a browser: a page without its own background
      // (and its frames) showed black text on Tessel's dark pane.
      transparent: false
    })
    expect(params.src).toBe('http://localhost:5173/')
    // The session's rules are in place before the page loads anything.
    expect(t.electron.session.fromPartition).toHaveBeenCalledWith(BROWSER_PARTITION)
    expect(t.ses.setPermissionRequestHandler).toHaveBeenCalledTimes(1)
  })

  it('refuses a page in another session', () => {
    expect(attachParams({ src: 'https://example.com', partition: 'persist:other' }).preventDefault).toHaveBeenCalled()
    expect(attachParams({ src: 'https://example.com' }).preventDefault).toHaveBeenCalled()
    expect(attachParams({ src: 'https://example.com', partition: '' }).preventDefault).toHaveBeenCalled()
  })

  it('refuses a page on another scheme', () => {
    for (const src of ['file:///C:/Windows/win.ini', 'javascript:alert(1)', 'data:text/html,x', 'chrome://gpu', 'http://u:p@example.com']) {
      expect(attachParams({ src, partition: BROWSER_PARTITION }).preventDefault).toHaveBeenCalled()
    }
  })

  it('a page without src starts blank', () => {
    const params = { partition: BROWSER_PARTITION }
    expect(attachParams(params).preventDefault).not.toHaveBeenCalled()
    expect(params.src).toBe('about:blank')
  })

  it('sets the session up only once', () => {
    attachParams({ src: 'https://a.test', partition: BROWSER_PARTITION })
    attachParams({ src: 'https://b.test', partition: BROWSER_PARTITION })
    expect(t.ses.setPermissionRequestHandler).toHaveBeenCalledTimes(1)
    expect(t.ses.listenerCount('will-download')).toBe(1)
  })
})

describe('a page attached', () => {
  it('opens no window: an http(s) popup right after a click is told to the window', () => {
    const g = t.attach()
    t.click(g)
    expect(g.openHandler({ url: 'https://example.com/new' })).toEqual({ action: 'deny' })
    expect(t.sent).toEqual([['browser:popup', { webContentsId: 7, url: 'https://example.com/new' }]])
    t.sent.length = 0
    for (const url of ['file:///C:/x', 'javascript:alert(1)', 'about:blank', 'data:text/html,x', 'mailto:a@b.com']) {
      t.click(g)
      expect(g.openHandler({ url })).toEqual({ action: 'deny' })
    }
    expect(t.sent).toEqual([])
  })

  it('a popup without the user\'s click or key (an ad frame) is refused silently, logged once', () => {
    const g = t.attach()
    g.emit('input-event', ev(), { type: 'mouseMove' })
    g.emit('input-event', ev(), { type: 'mouseWheel' })
    expect(g.openHandler({ url: 'https://ads.test/1' })).toEqual({ action: 'deny' })
    expect(g.openHandler({ url: 'https://ads.test/2' })).toEqual({ action: 'deny' })
    expect(t.sent).toEqual([])
    expect(t.log.warn).toHaveBeenCalledTimes(1)
  })

  it('one popup per click, and only shortly after it', () => {
    const now = vi.spyOn(Date, 'now')
    try {
      const g = t.attach()
      now.mockReturnValue(10000)
      t.click(g)
      now.mockReturnValue(11500)
      g.openHandler({ url: 'https://example.com/a' })
      g.openHandler({ url: 'https://example.com/b' })
      expect(t.sent.map(([, p]) => p.url)).toEqual(['https://example.com/a'])
      now.mockReturnValue(20000)
      t.click(g)
      now.mockReturnValue(21501)
      g.openHandler({ url: 'https://example.com/late' })
      expect(t.sent).toHaveLength(1)
    } finally {
      now.mockRestore()
    }
  })

  it('a key, a touch or a mouse button counts as the user\'s input', () => {
    const g = t.attach()
    const inputs = [
      ['input-event', { type: 'keyDown' }],
      ['input-event', { type: 'rawKeyDown' }],
      ['input-event', { type: 'touchEnd' }],
      ['input-event', { type: 'gestureTap' }],
      ['before-mouse-event', { type: 'mouseDown' }],
      ['before-mouse-event', { type: 'mouseUp' }],
      ['before-input-event', { type: 'keyDown', key: 'Enter' }]
    ]
    for (const [name, input] of inputs) {
      t.sent.length = 0
      g.emit(name, ev(), input)
      g.openHandler({ url: 'https://example.com/new' })
      expect(t.sent).toHaveLength(1)
    }
  })

  it('never leaves http(s) by a link or a redirect', () => {
    const g = t.attach()
    for (const name of ['will-navigate', 'will-redirect']) {
      for (const url of ['file:///C:/x', 'javascript:alert(1)', 'chrome://settings', 'mailto:a@b.com']) {
        const e = ev({ url })
        g.emit(name, e, url)
        expect(e.preventDefault).toHaveBeenCalled()
      }
      for (const url of ['http://localhost:5173/', 'https://example.com/a']) {
        const e = ev({ url })
        g.emit(name, e, url)
        expect(e.preventDefault).not.toHaveBeenCalled()
      }
    }
  })

  it('frames: no file: nor javascript:, the page\'s own about:/data:/blob: frames stay', () => {
    const g = t.attach()
    for (const url of ['file:///C:/x', 'javascript:alert(1)']) {
      const e = ev({ url, isMainFrame: false })
      g.emit('will-frame-navigate', e)
      expect(e.preventDefault).toHaveBeenCalled()
    }
    for (const url of ['https://embed.test/', 'about:srcdoc', 'data:text/html,x', 'blob:https://page.test/1']) {
      const e = ev({ url, isMainFrame: false })
      g.emit('will-frame-navigate', e)
      expect(e.preventDefault).not.toHaveBeenCalled()
    }
  })

  it('a page loaded on a refused address is stopped and blanked (after the event: inside it, Electron crashes)', async () => {
    const g = t.attach()
    g.emit('did-start-navigation', { url: 'file:///C:/Windows/win.ini', isMainFrame: true, isSameDocument: false })
    expect(g.loadURL).not.toHaveBeenCalled()
    await new Promise((r) => setImmediate(r))
    expect(g.stop).toHaveBeenCalled()
    expect(g.loadURL).toHaveBeenCalledWith('about:blank')
  })

  it('an allowed page, a frame, a same-page move or an error page is left alone', async () => {
    const g = t.attach()
    g.emit('did-start-navigation', { url: 'https://example.com/', isMainFrame: true, isSameDocument: false })
    g.emit('did-start-navigation', { url: 'about:blank', isMainFrame: true, isSameDocument: false })
    g.emit('did-start-navigation', { url: 'file:///C:/x', isMainFrame: false, isSameDocument: false })
    g.emit('did-start-navigation', { url: 'https://example.com/#x', isMainFrame: true, isSameDocument: true })
    g.emit('did-start-navigation', { url: 'chrome-error://chromewebdata/', isMainFrame: true, isSameDocument: false })
    await new Promise((r) => setImmediate(r))
    expect(g.stop).not.toHaveBeenCalled()
    expect(g.loadURL).not.toHaveBeenCalled()
  })

  it('sends the browser\'s shortcuts to the window, not to the page', () => {
    const g = t.attach()
    const cases = [
      [{ key: 'l', control: true }, 'focusAddress'],
      [{ key: 'f', control: true }, 'find'],
      [{ key: 'F5' }, 'reload'],
      [{ key: 'r', control: true }, 'reload'],
      [{ key: 'R', control: true, shift: true }, 'hardReload'],
      [{ key: 'F5', control: true }, 'hardReload'],
      [{ key: 'ArrowLeft', alt: true }, 'back'],
      [{ key: 'ArrowRight', alt: true }, 'forward'],
      [{ key: 'F12' }, 'devTools'],
      [{ key: 'I', control: true, shift: true }, 'devTools'],
      [{ key: '=', control: true }, 'zoomIn'],
      [{ key: '+', control: true, shift: true }, 'zoomIn'],
      [{ key: '-', control: true }, 'zoomOut'],
      [{ key: '0', control: true }, 'zoomReset'],
      [{ key: '`', code: 'Backquote', control: true }, 'app'],
      [{ key: '²', code: 'Backquote', control: true }, 'app']
    ]
    for (const [input, action] of cases) {
      t.sent.length = 0
      const e = ev()
      g.emit('before-input-event', e, { type: 'keyDown', ...input })
      expect(e.preventDefault).toHaveBeenCalled()
      expect(t.sent).toHaveLength(1)
      expect(t.sent[0][0]).toBe('browser:shortcut')
      expect(t.sent[0][1]).toMatchObject({ webContentsId: 7, action })
    }
  })

  it('leaves the page its own keys', () => {
    const g = t.attach()
    const keys = [
      { type: 'keyDown', key: 'a' },
      { type: 'keyDown', key: 'l' },
      { type: 'keyDown', key: 'c', control: true },
      { type: 'keyDown', key: 'v', control: true },
      { type: 'keyDown', key: 'z', control: true },
      { type: 'keyDown', key: 'ArrowLeft' },
      { type: 'keyDown', key: 'Enter' },
      { type: 'keyUp', key: 'l', control: true },
      { type: 'keyUp', key: 'F5' }
    ]
    for (const input of keys) {
      const e = ev()
      g.emit('before-input-event', e, input)
      expect(e.preventDefault).not.toHaveBeenCalled()
    }
    expect(t.sent).toEqual([])
    expect(shortcutOf({ type: 'keyDown', key: 'x' })).toBeNull()
  })
})

describe('the browser session', () => {
  beforeEach(() => t.bg.browserSession())

  it('grants writing to the clipboard, nothing else, and tells the window', () => {
    const wc = { id: 7, isDestroyed: () => false, getURL: () => 'https://page.test/x' }
    const ok = vi.fn()
    t.ses.request(wc, 'clipboard-sanitized-write', ok, { requestingUrl: 'https://page.test/x' })
    expect(ok).toHaveBeenCalledWith(true)
    expect(t.sent).toEqual([])

    for (const permission of ['media', 'geolocation', 'notifications', 'clipboard-read', 'openExternal', 'display-capture']) {
      const cb = vi.fn()
      t.ses.request(wc, permission, cb, { requestingUrl: 'https://cam.test/room?x=1' })
      expect(cb).toHaveBeenCalledWith(false)
    }
    const denied = t.sent.filter(([ch]) => ch === 'browser:permissionDenied').map(([, p]) => p)
    expect(denied[0]).toEqual({ webContentsId: 7, permission: 'media', origin: 'https://cam.test' })
    expect(denied[1]).toEqual({ webContentsId: 7, permission: 'geolocation', origin: 'https://cam.test' })
    expect(denied).toHaveLength(6)
  })

  it('a denied request without a requesting URL names the page\'s origin', () => {
    const wc = { id: 9, isDestroyed: () => false, getURL: () => 'https://page.test/x' }
    t.ses.request(wc, 'media', vi.fn(), {})
    expect(t.sent[0][1]).toEqual({ webContentsId: 9, permission: 'media', origin: 'https://page.test' })
  })

  it('refuses full screen without telling the window', () => {
    const cb = vi.fn()
    t.ses.request({ id: 7, isDestroyed: () => false, getURL: () => 'https://video.test/' }, 'fullscreen', cb, {})
    expect(cb).toHaveBeenCalledWith(false)
    expect(t.sent).toEqual([])
  })

  it('checks agree with requests', () => {
    expect(t.ses.check(null, 'clipboard-sanitized-write')).toBe(true)
    for (const p of ['media', 'geolocation', 'clipboard-read', 'hid', 'serial', 'usb', 'notifications', 'fullscreen']) {
      expect(t.ses.check(null, p)).toBe(false)
    }
  })

  it('refuses screen sharing', () => {
    const cb = vi.fn()
    t.ses.display({ videoRequested: true, audioRequested: false }, cb)
    expect(cb).toHaveBeenCalledTimes(1)
    const streams = cb.mock.calls[0][0]
    expect(streams == null || (!streams.video && !streams.audio)).toBe(true)
  })

  it('downloads nothing and tells the window', () => {
    const e = ev()
    const item = { getURL: () => 'https://files.test/a.zip', getFilename: () => 'a.zip' }
    t.ses.emit('will-download', e, item, { id: 7, isDestroyed: () => false })
    expect(e.preventDefault).toHaveBeenCalled()
    expect(t.sent).toEqual([['browser:downloadBlocked', { webContentsId: 7, url: 'https://files.test/a.zip', name: 'a.zip' }]])
  })

  it('a download from a blob: or data: URL has no URL to offer', () => {
    for (const url of ['blob:https://page.test/1234', 'data:text/plain,x', 'about:blank']) {
      t.sent.length = 0
      const e = ev()
      t.ses.emit('will-download', e, { getURL: () => url, getFilename: () => 'x.txt' }, { id: 7, isDestroyed: () => false })
      expect(e.preventDefault).toHaveBeenCalled()
      expect(t.sent[0][1].url).toBeNull()
    }
  })
})

describe('guestFor', () => {
  it('finds a page of the browser shown in Tessel\'s window', () => {
    const g = t.attach()
    expect(t.bg.guestFor(t.fromWindow, 7)).toBe(g)
  })

  it('refuses another sender', () => {
    t.attach()
    expect(t.bg.guestFor({ sender: new EventEmitter() }, 7)).toBeNull()
    expect(t.bg.guestFor({ sender: t.guests.get(7) }, 7)).toBeNull()
  })

  it('refuses a missing or odd id', () => {
    t.attach()
    for (const id of [8, '7', 7.5, null, undefined, NaN, {}]) expect(t.bg.guestFor(t.fromWindow, id)).toBeNull()
  })

  it('refuses what is not one of its pages', () => {
    t.attach({ type: 'window' })
    expect(t.bg.guestFor(t.fromWindow, 7)).toBeNull()
    t.attach({ host: new EventEmitter() })
    expect(t.bg.guestFor(t.fromWindow, 7)).toBeNull()
    t.attach({ host: null })
    expect(t.bg.guestFor(t.fromWindow, 7)).toBeNull()
    t.attach({ ses: fakeSession() })
    expect(t.bg.guestFor(t.fromWindow, 7)).toBeNull()
    const g = t.attach()
    g.destroyed = true
    expect(t.bg.guestFor(t.fromWindow, 7)).toBeNull()
  })

  it('the IPC answers no-page for a page it refuses', async () => {
    t.attach({ type: 'window' })
    expect(await t.call('browser:pick', 7)).toEqual({ ok: false, code: 'no-page' })
    expect(await t.call('browser:screenshot', 7)).toEqual({ ok: false, code: 'no-page' })
    expect(await t.call('browser:cancelPick', 7)).toEqual({ ok: false })
    expect(await t.call('browser:openDevTools', 7)).toEqual({ ok: false })
    t.attach()
    expect(await t.handlers['browser:pick']({ sender: new EventEmitter() }, 7)).toEqual({ ok: false, code: 'no-page' })
  })

  it('opens DevTools for its page', async () => {
    const g = t.attach()
    expect(await t.call('browser:openDevTools', 7)).toEqual({ ok: true })
    expect(g.openDevTools).toHaveBeenCalled()
  })
})

describe('Design Mode: pick', () => {
  const PAYLOAD = {
    url: 'https://page.test/',
    viewport: { width: 500, height: 400 },
    element: { tag: 'button', rect: { x: 10, y: 20, width: 30, height: 40 } }
  }

  it('cancelled from the window: the picker is taken down', async () => {
    const g = t.attach()
    const res = t.call('browser:pick', 7)
    await Promise.resolve()
    expect(await t.call('browser:cancelPick', 7)).toEqual({ ok: true })
    expect(await res).toEqual({ ok: true, cancelled: true })
    expect(g.executeJavaScript).toHaveBeenCalledWith('/*arm*/', expect.anything())
    expect(g.executeJavaScript).toHaveBeenCalledWith('/*teardown*/', expect.anything())
  })

  it('a new page cancels the pick', async () => {
    const g = t.attach()
    const res = t.call('browser:pick', 7)
    await Promise.resolve()
    g.emit('did-start-navigation', { url: 'https://page.test/other', isMainFrame: true, isSameDocument: false })
    expect(await res).toEqual({ ok: true, cancelled: true })
  })

  it('a page that goes away cancels the pick', async () => {
    const g = t.attach()
    const res = t.call('browser:pick', 7)
    await Promise.resolve()
    g.destroyed = true
    g.emit('destroyed')
    expect(await res).toEqual({ ok: true, cancelled: true })
    expect(g.executeJavaScript).not.toHaveBeenCalledWith('/*teardown*/', expect.anything())
  })

  it('a second pick cancels the first', async () => {
    const g = t.attach()
    const first = t.call('browser:pick', 7)
    await Promise.resolve()
    g.armResult = Promise.resolve(null)
    const second = t.call('browser:pick', 7)
    expect(await first).toEqual({ ok: true, cancelled: true })
    expect(await second).toEqual({ ok: false, code: 'failed' })
  })

  it('the page\'s answer is refused: failed', async () => {
    const g = t.attach()
    g.armResult = Promise.resolve(null)
    expect(await t.call('browser:pick', 7)).toEqual({ ok: false, code: 'failed' })
    g.armResult = Promise.resolve({ error: 'boom' })
    expect(await t.call('browser:pick', 7)).toEqual({ ok: false, code: 'failed' })
    g.armResult = Promise.reject(new Error('Script failed to execute'))
    expect(await t.call('browser:pick', 7)).toEqual({ ok: false, code: 'failed' })
  })

  it('never hands the page a user gesture', async () => {
    const g = t.attach()
    g.armResult = Promise.resolve(PAYLOAD)
    g.capturePage.mockResolvedValue(fakeImage(1000, 800))
    await t.call('browser:pick', 7)
    for (const [, gesture] of g.executeJavaScript.mock.calls) expect(gesture).toBe(false)
  })

  it('a page that never gives its screenshot (window hidden): picked anyway, without one', async () => {
    vi.useFakeTimers()
    try {
      const g = t.attach()
      g.armResult = Promise.resolve(PAYLOAD)
      g.capturePage.mockReturnValue(new Promise(() => {}))
      const res = t.call('browser:pick', 7)
      await vi.advanceTimersByTimeAsync(5000)
      const out = await res
      expect(out.ok).toBe(true)
      expect(out.payload).toBe(PAYLOAD)
      expect(out.screenshot).toBe(null)
    } finally {
      vi.useRealTimers()
    }
  })

  it('picked: the payload and a screenshot of the element', async () => {
    const g = t.attach()
    g.armResult = Promise.resolve(PAYLOAD)
    const img = fakeImage(1000, 800) // twice the CSS pixels (a 200% screen)
    g.capturePage.mockResolvedValue(img)
    const res = await t.call('browser:pick', 7)
    expect(res.ok).toBe(true)
    expect(res.payload).toBe(PAYLOAD)
    expect(img.crop).toHaveBeenCalledWith({ x: 20, y: 40, width: 60, height: 80 })
    expect(res.screenshot).toMatchObject({ width: 60, height: 80 })
    expect(res.screenshot.path.startsWith(dir)).toBe(true)
    expect(res.screenshot.path).toMatch(/[\\/]browser-\d+-[0-9a-f]{6}\.png$/)
    expect(fs.existsSync(res.screenshot.path)).toBe(true)
  })

  it('an element partly off the page is cut to the page', async () => {
    const g = t.attach()
    g.armResult = Promise.resolve({ ...PAYLOAD, element: { rect: { x: 480, y: -10, width: 100, height: 30 } } })
    const img = fakeImage(500, 400)
    g.capturePage.mockResolvedValue(img)
    const res = await t.call('browser:pick', 7)
    expect(img.crop).toHaveBeenCalledWith({ x: 480, y: 0, width: 20, height: 30 })
    expect(res.screenshot).toMatchObject({ width: 20, height: 30 })
  })

  it('an element off the page, or odd numbers: no screenshot, the pick still counts', async () => {
    const g = t.attach()
    g.capturePage.mockResolvedValue(fakeImage(500, 400))
    for (const rect of [{ x: 900, y: 10, width: 10, height: 10 }, { x: NaN, y: 0, width: 10, height: 10 }, { x: 0, y: 0, width: 0, height: 10 }]) {
      g.armResult = Promise.resolve({ ...PAYLOAD, element: { rect } })
      const res = await t.call('browser:pick', 7)
      expect(res.ok).toBe(true)
      expect(res.screenshot).toBeNull()
    }
  })

  it('a failed capture: the pick without a screenshot', async () => {
    const g = t.attach()
    g.armResult = Promise.resolve(PAYLOAD)
    g.capturePage.mockRejectedValue(new Error('gone'))
    const res = await t.call('browser:pick', 7)
    expect(res).toEqual({ ok: true, payload: PAYLOAD, screenshot: null })
  })
})

describe('Design Mode: screenshots', () => {
  it('saves the visible page as a PNG', async () => {
    const g = t.attach()
    g.capturePage.mockResolvedValue(fakeImage(800, 600))
    const res = await t.call('browser:screenshot', 7)
    expect(res.ok).toBe(true)
    expect(res.screenshot).toMatchObject({ width: 800, height: 600 })
    expect(fs.readFileSync(res.screenshot.path).length).toBe(16)
  })

  it('refuses a screenshot too big', async () => {
    const g = t.attach()
    g.capturePage.mockResolvedValue(fakeImage(800, 600, 8 * 1024 * 1024 + 1))
    expect(await t.call('browser:screenshot', 7)).toEqual({ ok: false, code: 'failed' })
    expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([])
  })

  it('an empty capture or a failure: failed', async () => {
    const g = t.attach()
    g.capturePage.mockResolvedValue({ isEmpty: () => true })
    expect(await t.call('browser:screenshot', 7)).toEqual({ ok: false, code: 'failed' })
    g.capturePage.mockRejectedValue(new Error('gone'))
    expect(await t.call('browser:screenshot', 7)).toEqual({ ok: false, code: 'failed' })
  })
})

describe('copyImage', () => {
  const put = (folder, name) => {
    fs.mkdirSync(folder, { recursive: true })
    const file = join(folder, name)
    fs.writeFileSync(file, 'png')
    return file
  }

  it('copies a screenshot Tessel saved', () => {
    const file = put(dir, 'browser-1712345678901-a1b2c3.png')
    expect(t.call('browser:copyImage', file)).toEqual({ ok: true })
    expect(t.electron.clipboard.writeImage).toHaveBeenCalledTimes(1)
  })

  it('refuses any other file', () => {
    put(dir, 'browser-1712345678901-a1b2c3.png') // the good one, reached the wrong way below
    const cases = [
      put(root, 'browser-1712345678901-a1b2c3.png'), // outside the folder
      put(join(root, 'paste-other'), 'browser-1712345678901-a1b2c3.png'), // a folder named alike
      put(join(dir, 'sub'), 'browser-1712345678901-a1b2c3.png'), // below it
      put(dir, 'secret.png'),
      put(dir, 'browser-1712345678901-a1b2c3.png.exe'),
      put(dir, 'browser-12-zzzzzz.png'),
      `${dir}/../paste/browser-1712345678901-a1b2c3.png`, // '..' is never followed
      join(dir, 'browser-1712345678901-ffffff.png'), // does not exist
      42,
      null,
      { path: 'x' }
    ]
    for (const file of cases) expect(t.call('browser:copyImage', file)).toEqual({ ok: false })
    expect(t.electron.clipboard.writeImage).not.toHaveBeenCalled()
    expect(t.electron.nativeImage.createFromPath).not.toHaveBeenCalled()
  })

  it('refuses another sender', () => {
    const file = put(dir, 'browser-1712345678901-a1b2c3.png')
    expect(t.handlers['browser:copyImage']({ sender: new EventEmitter() }, file)).toEqual({ ok: false })
  })

  it('an image that does not load: not copied', () => {
    const file = put(dir, 'browser-1712345678901-a1b2c3.png')
    t.electron.nativeImage.createFromPath.mockReturnValue({ isEmpty: () => true })
    expect(t.call('browser:copyImage', file)).toEqual({ ok: false })
    expect(t.electron.clipboard.writeImage).not.toHaveBeenCalled()
  })
})

describe('a page in full screen anyway', () => {
  it('is taken out of it, and Tessel\'s window put back', async () => {
    const g = t.attach()
    t.click(g) // the page's click, with the window not in full screen
    t.win.full = true // what the page's full screen did to the window
    g.emit('enter-html-full-screen')
    expect(g.executeJavaScript).toHaveBeenCalledWith('document.exitFullscreen && document.exitFullscreen()', false)
    expect(t.win.setFullScreen).toHaveBeenCalledWith(false)
    expect(t.win.full).toBe(false)
  })

  it('the window going full screen a moment later is put back too', async () => {
    vi.useFakeTimers()
    try {
      const g = t.attach()
      t.click(g)
      g.emit('enter-html-full-screen')
      expect(t.win.setFullScreen).not.toHaveBeenCalled()
      t.win.full = true
      await vi.advanceTimersByTimeAsync(300)
      expect(t.win.full).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a window the user had put in full screen stays so', async () => {
    const g = t.attach()
    t.win.full = true
    t.click(g)
    g.emit('enter-html-full-screen')
    expect(g.executeJavaScript).toHaveBeenCalled()
    expect(t.win.setFullScreen).not.toHaveBeenCalled()
  })
})

describe('clearData', () => {
  it('clears the browser session only, asked by the window', async () => {
    expect(await t.call('browser:clearData')).toEqual({ ok: true })
    for (const name of ['clearStorageData', 'clearCache', 'clearAuthCache', 'clearHostResolverCache']) expect(t.ses[name]).toHaveBeenCalledTimes(1)
    expect(t.electron.session.fromPartition.mock.calls.every(([p]) => p === BROWSER_PARTITION)).toBe(true)
  })

  it('refuses another sender', async () => {
    expect(await t.handlers['browser:clearData']({ sender: new EventEmitter() })).toEqual({ ok: false })
    expect(t.ses.clearStorageData).not.toHaveBeenCalled()
  })

  it('a failure: not ok', async () => {
    t.ses.clearCache.mockRejectedValue(new Error('busy'))
    expect(await t.call('browser:clearData')).toEqual({ ok: false })
  })
})

describe('saveFeedback', () => {
  it('saves the message as a UTF-8 file in the screenshot folder', () => {
    const text = '## Design Feedback\n\nMake it blue, café'
    const res = t.call('browser:saveFeedback', text)
    expect(res.ok).toBe(true)
    expect(res.path.startsWith(dir)).toBe(true)
    expect(res.path).toMatch(/[\\/]browser-feedback-\d+-[0-9a-f]{6}\.md$/)
    expect(fs.readFileSync(res.path, 'utf8')).toBe(text)
  })

  it('refuses what is not a message, one too big, another sender', () => {
    for (const text of [42, null, undefined, '', '   ', { text: 'x' }]) {
      expect(t.call('browser:saveFeedback', text)).toEqual({ ok: false, code: 'invalid' })
    }
    // 512 KB counted in UTF-8 bytes: 262145 'é' are 524290 bytes.
    expect(t.call('browser:saveFeedback', 'é'.repeat(262145))).toEqual({ ok: false, code: 'too-big' })
    expect(t.call('browser:saveFeedback', 'x'.repeat(512 * 1024 + 1))).toEqual({ ok: false, code: 'too-big' })
    expect(t.call('browser:saveFeedback', 'x'.repeat(512 * 1024)).ok).toBe(true)
    expect(t.handlers['browser:saveFeedback']({ sender: new EventEmitter() }, 'hello').ok).toBe(false)
    expect(fs.readdirSync(dir)).toHaveLength(1)
  })

  it('is never an image to copy', () => {
    const { path } = t.call('browser:saveFeedback', 'hello')
    expect(t.call('browser:copyImage', path)).toEqual({ ok: false })
  })
})

describe('old screenshots and messages', () => {
  const DAY = 24 * 60 * 60 * 1000
  const put = (name, ageMs) => {
    fs.mkdirSync(dir, { recursive: true })
    const file = join(dir, name)
    fs.writeFileSync(file, 'x')
    const at = new Date(Date.now() - ageMs)
    fs.utimesSync(file, at, at)
    return file
  }
  const files = () => fs.readdirSync(dir).sort()

  const seed = () => {
    put('browser-1000000000000-aaaaaa.png', 2 * DAY)
    put('browser-feedback-1000000000000-bbbbbb.md', 2 * DAY)
    put('browser-1700000000000-cccccc.png', 60 * 1000)
    put('browser-feedback-1700000000000-dddddd.md', 60 * 1000)
    // Not the browser's: never touched, however old.
    put('image-1000000000000.png', 2 * DAY)
    put('browser-notes.txt', 2 * DAY)
    fs.mkdirSync(join(dir, 'browser-1000000000000-eeeeee.png'))
  }
  const kept = [
    'browser-1000000000000-eeeeee.png',
    'browser-1700000000000-cccccc.png',
    'browser-feedback-1700000000000-dddddd.md',
    'browser-notes.txt',
    'image-1000000000000.png'
  ]

  it('go at start', () => {
    seed()
    setup()
    expect(files()).toEqual(kept)
  })

  it('go at each screenshot', async () => {
    const g = t.attach()
    seed()
    g.capturePage.mockResolvedValue(fakeImage(800, 600))
    const res = await t.call('browser:screenshot', 7)
    expect(files()).toEqual([...kept, res.screenshot.path.split(/[\\/]/).pop()].sort())
  })

  it('go at each saved message', () => {
    seed()
    const res = t.call('browser:saveFeedback', 'hello')
    expect(files()).toEqual([...kept, res.path.split(/[\\/]/).pop()].sort())
  })
})

describe("a browser's everyday input", () => {
  it('Escape stops a page still loading (after the event); the page gets its Escape too', async () => {
    const g = t.attach()
    g.isLoading = vi.fn(() => true)
    const e = ev()
    g.emit('before-input-event', e, { type: 'keyDown', key: 'Escape' })
    expect(g.stop).not.toHaveBeenCalled()
    await new Promise((r) => setImmediate(r))
    expect(g.stop).toHaveBeenCalledTimes(1)
    expect(e.preventDefault).not.toHaveBeenCalled()
    g.isLoading = vi.fn(() => false)
    g.emit('before-input-event', ev(), { type: 'keyDown', key: 'Escape' })
    await new Promise((r) => setImmediate(r))
    expect(g.stop).toHaveBeenCalledTimes(1)
    expect(t.sent).toEqual([])
  })

  // The side panel's fullscreen says "Exit fullscreen (Esc)": an Escape the
  // page leaves alone goes to the window too. One the page used (a dialog of
  // its own: defaultPrevented, or stopped before its window) stays the page's.
  it("an Escape the page did not use is told to the window; one it used is not", async () => {
    const g = t.attach()
    g.isLoading = vi.fn(() => false)
    // The page's isolated world: what it saw of the page's Escape keys.
    let seen = null
    g.executeJavaScriptInIsolatedWorld = vi.fn(async (_world, [{ code }]) => (code.includes('addEventListener') ? undefined : seen))
    g.emit('dom-ready')
    await new Promise((r) => setImmediate(r))
    expect(g.executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(1)
    const [world, [{ code }]] = g.executeJavaScriptInIsolatedWorld.mock.calls[0]
    expect(world).not.toBe(0)
    expect(code).toContain("e.key !== 'Escape'")
    expect(code).toContain('e.isTrusted')
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const escape = () => {
      const e = ev()
      g.emit('before-input-event', e, { type: 'keyDown', key: 'Escape' })
      expect(e.preventDefault).not.toHaveBeenCalled()
    }
    // Not used by the page: the window hears it (once).
    escape()
    seen = { n: 1, prevented: false }
    await wait(400)
    expect(t.sent).toEqual([['browser:shortcut', { webContentsId: 7, action: 'escape' }]])
    // Used by the page (its dialog closed, preventDefault).
    escape()
    seen = { n: 2, prevented: true }
    await wait(400)
    // Stopped by the page before its window (stopPropagation): never seen.
    escape()
    await wait(400)
    // With a modifier: not the window's.
    g.emit('before-input-event', ev(), { type: 'keyDown', key: 'Escape', control: true })
    seen = { n: 3, prevented: false }
    await wait(400)
    expect(t.sent).toHaveLength(1)
    // A new document: counted from 0 again.
    g.emit('dom-ready')
    await new Promise((r) => setImmediate(r))
    escape()
    seen = { n: 1, prevented: false }
    await wait(400)
    expect(t.sent).toHaveLength(2)
  })

  it('Ctrl+wheel zooms the pane (Chromium asks, the window zooms), one step per notch', () => {
    const now = vi.spyOn(Date, 'now')
    try {
      const g = t.attach()
      const e = ev()
      now.mockReturnValue(1000)
      g.emit('zoom-changed', e, 'in')
      g.emit('zoom-changed', ev(), 'in') // the same notch, told twice
      now.mockReturnValue(1100)
      g.emit('zoom-changed', ev(), 'in')
      g.emit('zoom-changed', ev(), 'out')
      g.emit('zoom-changed', ev(), 'sideways')
      expect(e.preventDefault).toHaveBeenCalled()
      expect(t.sent).toEqual([
        ['browser:shortcut', { webContentsId: 7, action: 'zoomIn' }],
        ['browser:shortcut', { webContentsId: 7, action: 'zoomIn' }],
        ['browser:shortcut', { webContentsId: 7, action: 'zoomOut' }]
      ])
    } finally {
      now.mockRestore()
    }
  })

  it('a middle-click or a Ctrl+click on a link asks for a new pane; target=_blank stays in the pane', () => {
    const g = t.attach()
    const down = (button, modifiers = []) => g.emit('before-mouse-event', ev(), { type: 'mouseDown', button, modifiers })
    down('middle')
    g.openHandler({ url: 'https://example.com/a', disposition: 'foreground-tab' })
    down('left', ['control'])
    g.openHandler({ url: 'https://example.com/b', disposition: 'foreground-tab' })
    down('left')
    g.openHandler({ url: 'https://example.com/c', disposition: 'background-tab' })
    down('left')
    g.openHandler({ url: 'https://example.com/d', disposition: 'foreground-tab' })
    expect(t.sent).toEqual([
      ['browser:popup', { webContentsId: 7, url: 'https://example.com/a', newPane: true }],
      ['browser:popup', { webContentsId: 7, url: 'https://example.com/b', newPane: true }],
      ['browser:popup', { webContentsId: 7, url: 'https://example.com/c', newPane: true }],
      ['browser:popup', { webContentsId: 7, url: 'https://example.com/d' }]
    ])
    // Still one per click, and never another scheme.
    expect(g.openHandler({ url: 'https://example.com/e', disposition: 'background-tab' })).toEqual({ action: 'deny' })
    t.click(g)
    expect(g.openHandler({ url: 'file:///C:/x', disposition: 'background-tab' })).toEqual({ action: 'deny' })
    expect(t.sent).toHaveLength(4)
    expect(wantsNewPane('new-window', null)).toBe(false)
    expect(wantsNewPane('other', { middle: true })).toBe(false)
  })

  it("the mouse's back/forward buttons: the focused page, else the active pane", () => {
    const g = t.attach()
    t.electron.webContents.getFocusedWebContents.mockReturnValue(g)
    t.win.emit('app-command', ev(), 'browser-backward')
    t.win.emit('app-command', ev(), 'media-play-pause')
    t.electron.webContents.getFocusedWebContents.mockReturnValue(null)
    t.win.emit('app-command', ev(), 'browser-forward')
    // A focused page of another session is not one of the browser's.
    const other = fakeGuest({ id: 9, host: t.winWc, ses: {} })
    t.electron.webContents.getFocusedWebContents.mockReturnValue(other)
    t.win.emit('app-command', ev(), 'browser-backward')
    expect(t.sent).toEqual([
      ['browser:shortcut', { webContentsId: 7, action: 'back' }],
      ['browser:appCommand', { action: 'forward' }],
      ['browser:appCommand', { action: 'back' }]
    ])
  })
})

describe('the right-click menu', () => {
  const ids = (items) => items.map((i) => i.id || '-')

  it('a link: open it in a new pane, in the default browser, copy it; then history, reload, inspect', () => {
    const items = contextMenuItems({ linkURL: 'https://example.com/x' }, { canGoBack: true, canGoForward: false })
    expect(ids(items)).toEqual(['openLinkNewPane', 'openLinkExternal', 'copyLink', '-', 'back', 'forward', 'reload', 'selectAll', '-', 'inspect'])
    expect(items[0].label).toBe('Open Link in New Pane')
    expect(items.find((i) => i.id === 'back').enabled).toBe(true)
    expect(items.find((i) => i.id === 'forward').enabled).toBe(false)
  })

  it('a link on another scheme offers nothing for it', () => {
    for (const linkURL of ['javascript:alert(1)', 'file:///C:/x', 'mailto:a@b.com']) {
      expect(ids(contextMenuItems({ linkURL }))).not.toContain('openLinkNewPane')
    }
  })

  it('a field: undo, redo, cut, copy, paste, select all as the page allows', () => {
    const items = contextMenuItems({ isEditable: true, editFlags: { canUndo: false, canRedo: false, canCut: true, canCopy: true, canPaste: true, canSelectAll: true } })
    expect(ids(items)).toEqual(['undo', 'redo', '-', 'cut', 'copy', 'paste', 'selectAll', '-', 'back', 'forward', 'reload', '-', 'inspect'])
    expect(items[0].enabled).toBe(false)
    expect(items.find((i) => i.id === 'paste').enabled).toBe(true)
  })

  it('selected text: Copy; an image: Copy Image and its address', () => {
    expect(ids(contextMenuItems({ selectionText: 'hello' }))[0]).toBe('copy')
    expect(ids(contextMenuItems({ selectionText: '   ' }))[0]).toBe('back')
    const img = ids(contextMenuItems({ mediaType: 'image', hasImageContents: true, srcURL: 'https://example.com/a.png' }))
    expect(img.slice(0, 2)).toEqual(['copyImage', 'copyImageAddress'])
    expect(ids(contextMenuItems({ mediaType: 'image', srcURL: 'data:image/png;base64,x' })).slice(0, 2)).toEqual(['copyImage', '-'])
  })

  it("a right-click in a page pops the menu in Tessel's window; its items act on that page", () => {
    const g = t.attach()
    Object.assign(g, {
      navigationHistory: { canGoBack: () => true, canGoForward: () => false, goBack: vi.fn(), goForward: vi.fn() },
      reload: vi.fn(),
      copy: vi.fn(),
      inspectElement: vi.fn()
    })
    g.emit('context-menu', ev(), { linkURL: 'https://example.com/x', x: 10.4, y: 20.6 })
    expect(t.menus).toHaveLength(1)
    const menu = t.menus[0]
    expect(menu.popup).toHaveBeenCalledWith({ window: t.win })
    const item = (label) => menu.template.find((i) => i.label === label)
    item('Open Link in New Pane').click()
    item('Copy Link Address').click()
    item('Open Link in Default Browser').click()
    item('Back').click()
    item('Reload').click()
    item('Inspect').click()
    expect(t.sent).toEqual([['browser:popup', { webContentsId: 7, url: 'https://example.com/x', newPane: true }]])
    expect(t.electron.clipboard.writeText).toHaveBeenCalledWith('https://example.com/x')
    expect(t.openExternal).toHaveBeenCalledWith('https://example.com/x')
    expect(g.navigationHistory.goBack).toHaveBeenCalled()
    expect(g.reload).toHaveBeenCalled()
    expect(g.openDevTools).toHaveBeenCalledWith({ mode: 'detach' })
    expect(g.inspectElement).toHaveBeenCalledWith(10, 21)
    expect(item('Forward').enabled).toBe(false)
  })

  it('a menu item on a page gone, or a link on another scheme, does nothing', () => {
    const g = t.attach()
    t.bg.runMenuItem(g, 'openLinkNewPane', { linkURL: 'javascript:alert(1)' })
    t.bg.runMenuItem(g, 'openLinkExternal', { linkURL: 'file:///C:/x' })
    g.reload = vi.fn()
    g.destroyed = true
    t.bg.runMenuItem(g, 'reload', {})
    expect(g.reload).not.toHaveBeenCalled()
    expect(t.sent).toEqual([])
    expect(t.openExternal).not.toHaveBeenCalled()
    expect(t.bg.showContextMenu(g, {})).toBe(null)
  })
})
