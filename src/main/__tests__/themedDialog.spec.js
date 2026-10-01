// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { createThemedDialog, dialogContent, themeVars, DIALOG_HTML, DIALOG_URL, CONTENT_CHANNEL, READY_CHANNEL, ANSWER_CHANNEL } from '../themedDialog'

// A BrowserWindow as far as the dialog uses it.
function fakeWindowClass({ throwOnCreate = false, loadFails = false, noIpc = false } = {}) {
  const made = []
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super()
      if (throwOnCreate) throw new Error('no window')
      this.options = options
      this.destroyed = false
      this.shown = false
      const wc = new EventEmitter()
      wc.ipc = noIpc ? undefined : new EventEmitter()
      wc.sent = []
      wc.send = (channel, payload) => wc.sent.push([channel, payload])
      wc.setWindowOpenHandler = vi.fn((fn) => (wc.openHandler = fn))
      this.webContents = wc
      this.loadURL = vi.fn(() => (loadFails ? Promise.reject(new Error('load')) : Promise.resolve()))
      this.size = [options.width, options.height]
      made.push(this)
    }
    isDestroyed() {
      return this.destroyed
    }
    destroy() {
      if (this.destroyed) return
      this.destroyed = true
      this.emit('closed')
    }
    close() {
      this.destroy()
    }
    removeMenu() {}
    setContentSize(w, h) {
      this.size = [w, h]
    }
    getSize() {
      return this.size
    }
    setPosition(x, y) {
      this.pos = [x, y]
    }
    setBounds(b) {
      this.bounds = b
    }
    center() {
      this.centered = true
    }
    show() {
      this.shown = true
    }
    focus() {}
  }
  FakeWindow.made = made
  return FakeWindow
}

const parentWindow = () => ({
  isDestroyed: () => false,
  isMinimized: () => false,
  getBounds: () => ({ x: 100, y: 50, width: 1000, height: 800 }),
  getContentBounds: () => ({ x: 108, y: 58, width: 984, height: 784 })
})

const OPTS = {
  type: 'warning',
  title: 'Trust this folder for a chat agent?',
  message: 'A chat agent runs in C:\\work',
  detail: 'Trust it only if you know where this folder comes from.',
  buttons: ['Trust this folder', 'Cancel'],
  defaultId: 1,
  cancelId: 1,
  noLink: true
}

let BrowserWindow, dialog, box
const flush = () => new Promise((r) => setImmediate(r))
const ev = (sender) => ({ sender })

// Loads the page and has its preload report ready, as the real one does.
async function open(opts = OPTS, parent = parentWindow()) {
  const result = box(parent, opts)
  const win = BrowserWindow.made.at(-1)
  win.webContents.emit('did-finish-load')
  win.webContents.ipc.emit(READY_CHANNEL, ev(win.webContents), 180)
  await flush()
  return { result, win }
}

beforeEach(() => {
  BrowserWindow = fakeWindowClass()
  dialog = { showMessageBox: vi.fn(async () => ({ response: 0, checkboxChecked: false, native: true })) }
  box = createThemedDialog({ BrowserWindow, dialog, preload: 'C:/app/out/preload/themedDialog.js', getTheme: () => 'nord', readyTimeoutMs: 1000 })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('themedMessageBox', () => {
  it('makes a locked-down modal child window and sends it the question', async () => {
    const parent = parentWindow()
    const { result, win } = await open(OPTS, parent)
    const o = win.options
    expect(o.parent).toBe(parent)
    expect(o.modal).toBe(true)
    expect(o.show).toBe(false)
    expect(o.resizable).toBe(false)
    expect(o.frame).toBe(false)
    expect(o.webPreferences).toMatchObject({ preload: 'C:/app/out/preload/themedDialog.js', sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, devTools: false })
    expect(win.loadURL).toHaveBeenCalledWith(DIALOG_URL)
    expect(win.webContents.openHandler()).toEqual({ action: 'deny' })
    const nav = { preventDefault: vi.fn() }
    win.webContents.emit('will-navigate', nav, 'https://example.com')
    expect(nav.preventDefault).toHaveBeenCalled()
    const [channel, content] = win.webContents.sent[0]
    expect(channel).toBe(CONTENT_CHANNEL)
    expect(content).toMatchObject({ type: 'warning', title: OPTS.title, message: OPTS.message, detail: OPTS.detail, buttons: OPTS.buttons, defaultId: 1, cancelId: 1 })
    // The theme's colours (Nord's chrome here).
    expect(content.vars['--chrome']).toBe('#242933')
    // Shown once ready, over its parent's content (see-through: the page
    // dims it and draws the card in the middle).
    expect(o.transparent).toBe(true)
    expect(content).toMatchObject({ cover: true, theme: 'classic' })
    expect(win.shown).toBe(true)
    expect(win.bounds).toEqual({ x: 108, y: 58, width: 984, height: 784 })
    win.webContents.ipc.emit(ANSWER_CHANNEL, ev(win.webContents), 0)
    await expect(result).resolves.toEqual({ response: 0, checkboxChecked: false })
    expect(win.destroyed).toBe(true)
    expect(dialog.showMessageBox).not.toHaveBeenCalled()
  })

  it('takes the answer only from its own window, once', async () => {
    const { result, win } = await open()
    const other = new EventEmitter()
    win.webContents.ipc.emit(ANSWER_CHANNEL, ev(other), 0)
    win.webContents.ipc.emit(ANSWER_CHANNEL, {}, 0)
    win.webContents.ipc.emit(ANSWER_CHANNEL, null, 0)
    // Not a button.
    win.webContents.ipc.emit(ANSWER_CHANNEL, ev(win.webContents), 7)
    win.webContents.ipc.emit(ANSWER_CHANNEL, ev(win.webContents), '0')
    let done = false
    result.then(() => (done = true))
    await flush()
    expect(done).toBe(false)
    win.webContents.ipc.emit(ANSWER_CHANNEL, ev(win.webContents), 1)
    win.webContents.ipc.emit(ANSWER_CHANNEL, ev(win.webContents), 0)
    await expect(result).resolves.toEqual({ response: 1, checkboxChecked: false })
    expect(win.webContents.ipc.listenerCount(ANSWER_CHANNEL)).toBe(0)
  })

  it('ignores an answer before the window is shown, and a ready from elsewhere', async () => {
    const result = box(parentWindow(), OPTS)
    const win = BrowserWindow.made.at(-1)
    win.webContents.ipc.emit(READY_CHANNEL, ev(new EventEmitter()), 100)
    expect(win.shown).toBe(false)
    win.webContents.ipc.emit(ANSWER_CHANNEL, ev(win.webContents), 0)
    win.webContents.ipc.emit(READY_CHANNEL, ev(win.webContents), 100)
    win.close()
    await expect(result).resolves.toEqual({ response: 1, checkboxChecked: false })
  })

  it('closing the window is Cancel', async () => {
    const { result, win } = await open()
    win.close()
    await expect(result).resolves.toEqual({ response: 1, checkboxChecked: false })
  })

  it('falls back to the native dialog when the window cannot be made', async () => {
    BrowserWindow = fakeWindowClass({ throwOnCreate: true })
    box = createThemedDialog({ BrowserWindow, dialog, preload: 'p.js' })
    const parent = parentWindow()
    await expect(box(parent, OPTS)).resolves.toMatchObject({ native: true })
    expect(dialog.showMessageBox).toHaveBeenCalledWith(parent, OPTS)
    await expect(box(OPTS)).resolves.toMatchObject({ native: true })
    expect(dialog.showMessageBox).toHaveBeenLastCalledWith(OPTS)
  })

  it('falls back to the native dialog when the page does not load or never gets ready', async () => {
    BrowserWindow = fakeWindowClass({ loadFails: true })
    box = createThemedDialog({ BrowserWindow, dialog, preload: 'p.js' })
    await expect(box(OPTS)).resolves.toMatchObject({ native: true })
    expect(BrowserWindow.made[0].destroyed).toBe(true)

    vi.useFakeTimers()
    BrowserWindow = fakeWindowClass()
    box = createThemedDialog({ BrowserWindow, dialog, preload: 'p.js', readyTimeoutMs: 1000 })
    const result = box(OPTS)
    vi.advanceTimersByTime(1001)
    await expect(result).resolves.toMatchObject({ native: true })
    expect(BrowserWindow.made[0].destroyed).toBe(true)

    BrowserWindow = fakeWindowClass({ noIpc: true })
    box = createThemedDialog({ BrowserWindow, dialog, preload: 'p.js' })
    await expect(box(OPTS)).resolves.toMatchObject({ native: true })
  })

  it('a window without a parent is centred on the screen, not modal', async () => {
    const result = box(OPTS)
    const win = BrowserWindow.made.at(-1)
    expect(win.options.modal).toBe(false)
    expect(win.options.parent).toBeUndefined()
    win.webContents.ipc.emit(READY_CHANNEL, ev(win.webContents), 200)
    expect(win.centered).toBe(true)
    win.close()
    await expect(result).resolves.toEqual({ response: 1, checkboxChecked: false })
  })
})

describe('dialogContent', () => {
  it('keeps text as plain strings, without control characters', () => {
    const c = dialogContent({ title: 'a\u0007b\nc', message: '<img src=x onerror=alert(1)>\r\nline', buttons: ['<b>Yes</b>', 'No'] })
    expect(c.title).toBe('a b c')
    expect(c.message).toBe('<img src=x onerror=alert(1)>\nline')
    expect(c.buttons).toEqual(['<b>Yes</b>', 'No'])
    // As Electron: the "No" button cancels; the default is that safe one.
    expect(c.cancelId).toBe(1)
    expect(c.defaultId).toBe(1)
  })

  it('bounds the buttons and ids', () => {
    expect(dialogContent({}).buttons).toEqual(['OK'])
    const c = dialogContent({ buttons: ['A', 'B'], cancelId: 9, defaultId: -1 })
    expect(c.cancelId).toBe(0)
    expect(c.defaultId).toBe(0)
    expect(dialogContent({ buttons: Array(10).fill('x') }).buttons).toHaveLength(6)
    expect(dialogContent({ message: 'x'.repeat(10000) }).message).toHaveLength(2000)
  })
})

describe('themeVars', () => {
  it('gives each theme its colours, hex only', () => {
    expect(themeVars('classic')['--surface']).toBe('#181b21')
    expect(themeVars('warp')['--accent']).toBe('#aed5b2')
    expect(themeVars('dracula')['--accent']).toBe('#bd93f9')
    expect(themeVars('__proto__')['--surface']).toBe('#181b21')
    for (const value of Object.values(themeVars('gruvbox'))) expect(value).toMatch(/^#[0-9a-f]+$/i)
  })
})

describe('the page', () => {
  it('runs no script: CSP default-src none, inline style only', () => {
    expect(DIALOG_HTML).toContain(`content="default-src 'none'; style-src 'unsafe-inline'"`)
    expect(DIALOG_HTML).not.toMatch(/<script|\son[a-z]+=|javascript:/i)
    expect(DIALOG_URL.startsWith('data:text/html;charset=utf-8,')).toBe(true)
  })
})
