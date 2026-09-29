// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import fs from 'fs'
import os from 'os'
import { join } from 'path'

vi.mock('../browserPicker', () => ({ pickerScript: (a) => `/*${a}*/`, clampPickPayload: (x) => x }))

import { createBrowserGuests, BROWSER_PARTITION, shortcutOf } from '../browserGuest'

const ev = (extra = {}) => ({ preventDefault: vi.fn(), ...extra })

function fakeSession() {
  const ses = new EventEmitter()
  ses.setPermissionRequestHandler = vi.fn((h) => (ses.request = h))
  ses.setPermissionCheckHandler = vi.fn((h) => (ses.check = h))
  ses.setDisplayMediaRequestHandler = vi.fn((h) => (ses.display = h))
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
  const win = { webContents: winWc, isDestroyed: () => false }
  const guests = new Map()
  const electron = {
    webContents: { fromId: vi.fn((id) => guests.get(id)) },
    clipboard: { writeImage: vi.fn() },
    nativeImage: { createFromPath: vi.fn(() => ({ isEmpty: () => false })) },
    session: { fromPartition: vi.fn(() => ses) }
  }
  const log = { warn: vi.fn() }
  const bg = createBrowserGuests({ getWindow: () => win, send: (ch, payload) => sent.push([ch, payload]), log, screenshotDir: dir, electron })
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
  return { sent, ses, winWc, win, guests, electron, log, bg, handlers, fromWindow, attach, call }
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
      partition: 'persist:other'
    }
    const params = { src: 'http://localhost:5173', partition: BROWSER_PARTITION, preload: 'file:///C:/evil/preload.js' }
    const e = attachParams(params, prefs)
    expect(e.preventDefault).not.toHaveBeenCalled()
    expect(prefs).not.toHaveProperty('preload')
    expect(prefs).not.toHaveProperty('preloadURL')
    expect(prefs).not.toHaveProperty('additionalArguments')
    expect(prefs).not.toHaveProperty('session')
    expect(params).not.toHaveProperty('preload')
    expect(prefs).toMatchObject({
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      enableBlinkFeatures: '',
      webviewTag: false,
      partition: BROWSER_PARTITION
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
  it('opens no window: an http(s) popup is told to the window', () => {
    const g = t.attach()
    expect(g.openHandler({ url: 'https://example.com/new' })).toEqual({ action: 'deny' })
    expect(t.sent).toEqual([['browser:popup', { webContentsId: 7, url: 'https://example.com/new' }]])
    t.sent.length = 0
    for (const url of ['file:///C:/x', 'javascript:alert(1)', 'about:blank', 'data:text/html,x', 'mailto:a@b.com']) {
      expect(g.openHandler({ url })).toEqual({ action: 'deny' })
    }
    expect(t.sent).toEqual([])
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
      [{ key: '0', control: true }, 'zoomReset']
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

  it('checks agree with requests', () => {
    expect(t.ses.check(null, 'clipboard-sanitized-write')).toBe(true)
    for (const p of ['media', 'geolocation', 'clipboard-read', 'hid', 'serial', 'usb', 'notifications']) {
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
