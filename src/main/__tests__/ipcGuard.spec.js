// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'
import { readFileSync } from 'fs'
import { join } from 'path'
import { guardIpc, mainFrameSender } from '../ipcGuard'

// Like Electron's ipcMain: an EventEmitter plus invoke handlers, where
// handleOnce goes through this.handle().
function fakeIpcMain() {
  const ipc = new EventEmitter()
  ipc.handlers = new Map()
  ipc.handle = function (channel, fn) {
    if (this.handlers.has(channel)) throw new Error(`second handler for ${channel}`)
    this.handlers.set(channel, fn)
  }
  ipc.handleOnce = function (channel, fn) {
    this.handle(channel, (e, ...args) => {
      this.removeHandler(channel)
      return fn(e, ...args)
    })
  }
  ipc.removeHandler = function (channel) {
    this.handlers.delete(channel)
  }
  // What Electron does on invoke(): the handler's result or failure.
  ipc.invoke = async (channel, event, ...args) => ipc.handlers.get(channel)(event, ...args)
  return ipc
}

function fakeWindow() {
  const mainFrame = { frameToken: 'main', processId: 7, url: 'file:///app/index.html' }
  const webContents = { id: 1, mainFrame, getType: () => 'window' }
  return { webContents, destroyed: false, isDestroyed() { return this.destroyed } }
}

let win, ipc, log
const trusted = () => ({ sender: win.webContents, senderFrame: win.webContents.mainFrame })

beforeEach(() => {
  win = fakeWindow()
  ipc = fakeIpcMain()
  log = { warn: vi.fn() }
  guardIpc(ipc, { isTrustedSender: mainFrameSender(() => win), log, exempt: ['browser:*', 'exact:one'] })
})

describe('mainFrameSender', () => {
  it('accepts only the window’s main frame', () => {
    const check = mainFrameSender(() => win)
    expect(check(trusted())).toBe(true)
    // The same frame through another wrapper object.
    expect(check({ sender: win.webContents, senderFrame: { frameToken: 'main', processId: 7 } })).toBe(true)
    expect(check({ sender: { id: 2 }, senderFrame: win.webContents.mainFrame })).toBe(false)
    expect(check({ sender: win.webContents, senderFrame: { frameToken: 'sub', processId: 7 } })).toBe(false)
    expect(check({ sender: win.webContents, senderFrame: null })).toBe(false)
    expect(check(null)).toBe(false)
    win.destroyed = true
    expect(check(trusted())).toBe(false)
    expect(mainFrameSender(() => null)(trusted())).toBe(false)
  })
})

describe('guardIpc', () => {
  const guest = () => ({ sender: { id: 5, getType: () => 'webview' }, senderFrame: { frameToken: 'g', processId: 9, url: 'https://evil.example/' } })
  const otherWindow = () => ({ sender: { id: 6, getType: () => 'window' }, senderFrame: { frameToken: 'w', processId: 10 } })
  const subframe = () => ({ sender: win.webContents, senderFrame: { frameToken: 'sub', processId: 7, url: 'https://x.example/' } })
  const noFrame = () => ({ sender: win.webContents, senderFrame: null })
  const refusedSenders = { guest, otherWindow, subframe, noFrame }

  it('lets the main frame through (handle and on)', async () => {
    const h = vi.fn((_e, a) => a * 2)
    ipc.handle('files:open', h)
    await expect(ipc.invoke('files:open', trusted(), 21)).resolves.toBe(42)
    const l = vi.fn()
    ipc.on('pty:write', l)
    ipc.emit('pty:write', trusted(), { id: 'p' })
    expect(l).toHaveBeenCalledWith(expect.anything(), { id: 'p' })
    expect(log.warn).not.toHaveBeenCalled()
  })

  for (const [name, make] of Object.entries(refusedSenders)) {
    it(`refuses ${name}`, async () => {
      const h = vi.fn(() => 'secret')
      ipc.handle('files:open', h)
      await expect(ipc.invoke('files:open', make())).rejects.toThrow(/refused/)
      expect(h).not.toHaveBeenCalled()
      const l = vi.fn()
      ipc.on('pty:write', l)
      const event = make()
      ipc.emit('pty:write', event, { id: 'p', data: 'calc\r' })
      expect(l).not.toHaveBeenCalled()
      // A sendSync caller is not left waiting.
      expect(event.returnValue).toBe(null)
    })
  }

  it('refuses everything once the window is destroyed', async () => {
    const h = vi.fn()
    ipc.handle('app:openExternal', h)
    const event = trusted()
    win.destroyed = true
    await expect(ipc.invoke('app:openExternal', event)).rejects.toThrow()
    expect(h).not.toHaveBeenCalled()
  })

  it('leaves exempt channels untouched', async () => {
    const pick = vi.fn(() => 'own check')
    ipc.handle('browser:pick', pick)
    expect(ipc.handlers.get('browser:pick')).toBe(pick)
    await expect(ipc.invoke('browser:pick', guest())).resolves.toBe('own check')
    const one = vi.fn()
    ipc.on('exact:one', one)
    ipc.emit('exact:one', guest())
    expect(one).toHaveBeenCalled()
    // Only the exact name, and prefixes only with ':*'.
    const two = vi.fn()
    ipc.on('exact:onetwo', two)
    ipc.emit('exact:onetwo', guest())
    expect(two).not.toHaveBeenCalled()
  })

  it('wraps listeners registered after the guard, whatever the method', async () => {
    const calls = []
    ipc.once('a', () => calls.push('once'))
    ipc.addListener('b', () => calls.push('add'))
    ipc.prependListener('c', () => calls.push('prepend'))
    ipc.prependOnceListener('d', () => calls.push('prependOnce'))
    for (const ch of ['a', 'b', 'c', 'd']) ipc.emit(ch, guest())
    expect(calls).toEqual([])
    // A refused message does not use up a once() listener or handler.
    for (const ch of ['a', 'b', 'c', 'd']) ipc.emit(ch, trusted())
    expect(calls).toEqual(['once', 'add', 'prepend', 'prependOnce'])
    ipc.emit('a', trusted())
    expect(calls).toHaveLength(4)
    const h = vi.fn(() => 'ok')
    ipc.handleOnce('x', h)
    await expect(ipc.invoke('x', guest())).rejects.toThrow()
    await expect(ipc.invoke('x', trusted())).resolves.toBe('ok')
    expect(ipc.handlers.has('x')).toBe(false)
  })

  it('removeListener still works with the original function', () => {
    const l = vi.fn()
    ipc.on('layout:save', l)
    ipc.removeListener('layout:save', l)
    expect(ipc.listenerCount('layout:save')).toBe(0)
  })

  it('logs once per channel and sender', async () => {
    ipc.handle('files:open', () => {})
    ipc.on('pty:write', () => {})
    for (let i = 0; i < 5; i++) {
      await ipc.invoke('files:open', guest()).catch(() => {})
      ipc.emit('pty:write', guest())
    }
    ipc.emit('pty:write', otherWindow())
    expect(log.warn).toHaveBeenCalledTimes(3)
    expect(log.warn.mock.calls[0][1]).toMatch(/refused files:open from webContents 5 webview https:\/\/evil\.example/)
  })

  it('a throwing check refuses', async () => {
    const ipc2 = fakeIpcMain()
    guardIpc(ipc2, { isTrustedSender: () => { throw new Error('boom') }, log })
    const h = vi.fn()
    ipc2.handle('x', h)
    await expect(ipc2.invoke('x', trusted())).rejects.toThrow()
    expect(h).not.toHaveBeenCalled()
  })
})

// index.js: the guard comes before any channel, and every webContents gets
// the webview and new-window rules.
describe('index.js wiring', () => {
  const src = readFileSync(join(__dirname, '..', 'index.js'), 'utf8')
  const code = src.replace(/^\s*\/\/.*$/gm, '')

  it('installs the guard before the first channel or register call', () => {
    const guard = code.indexOf('guardIpc(ipcMain')
    expect(guard).toBeGreaterThan(0)
    expect(code).toMatch(/guardIpc\(ipcMain, \{ isTrustedSender: mainFrameSender\(\(\) => mainWindow\)/)
    // No channel left out, the browser's included (a frame could not reach them).
    expect(code.slice(guard, code.indexOf('\n', guard))).not.toContain('exempt')
    const firsts = [
      code.indexOf('ipcMain.handle('),
      code.indexOf('ipcMain.on('),
      code.indexOf('ipcMain.once('),
      code.indexOf('ipcMain.handleOnce('),
      code.search(/\bregister\w*\(\{\s*ipcMain\b/),
      code.search(/\bregister\w*\(\s*ipcMain\s*[,)]/),
      code.search(/\.register\(\s*ipcMain\s*\)/),
      code.indexOf('app.whenReady(')
    ].filter((i) => i >= 0)
    expect(firsts.length).toBeGreaterThan(4)
    for (const i of firsts) expect(guard).toBeLessThan(i)
    // Only once: a second patch would check twice.
    expect(code.match(/guardIpc\(/g)).toHaveLength(1)
  })

  it('sets the webview and window-open rules on every webContents', () => {
    const at = code.indexOf("app.on('web-contents-created'")
    expect(at).toBeGreaterThan(0)
    const block = code.slice(at, code.indexOf('\n})', at))
    expect(block).toMatch(/contents\.on\('will-attach-webview'/)
    expect(block).toMatch(/contents !== mainWindow\.webContents\) event\.preventDefault\(\)/)
    expect(block).toMatch(/contents\.setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/)
    // Before any window is made.
    expect(at).toBeLessThan(code.indexOf('function createWindow('))
  })
})
