// Tessel's IPC channels (window.shellApi: terminals, files, git, opening
// folders and links...) answer only Tessel's own page. The built-in browser
// shows internet pages in other webContents; a page that broke out of its
// renderer must not reach them. guardIpc patches ipcMain once, before any
// channel is registered, so every handler (index.js and the register*(ipcMain)
// modules) checks who is asking first.

// The main window's page itself: its webContents and its main frame (not a
// frame inside it, not another window or a browser page).
export function mainFrameSender(getWindow) {
  return (event) => {
    const win = getWindow()
    if (!win || win.isDestroyed()) return false
    const contents = win.webContents
    if (!contents || !event || event.sender !== contents) return false
    // null when the frame navigated away or was removed meanwhile.
    const frame = event.senderFrame
    const main = contents.mainFrame
    if (!frame || !main) return false
    if (frame === main) return true
    // The same frame seen through another wrapper object.
    return !!frame.frameToken && frame.frameToken === main.frameToken && frame.processId === main.processId
  }
}

// exempt: channels that check their sender themselves ('browser:pick', or
// every channel of a prefix: 'browser:*').
export function guardIpc(ipcMain, { isTrustedSender, log, exempt = [] } = {}) {
  if (typeof isTrustedSender !== 'function') throw new TypeError('guardIpc: isTrustedSender is required') // i18n-ignore programming error
  const exact = new Set()
  const prefixes = []
  for (const e of exempt) {
    if (typeof e !== 'string' || !e) continue
    if (e.endsWith(':*')) prefixes.push(e.slice(0, -1))
    else exact.add(e)
  }
  const isExempt = (channel) => exact.has(channel) || prefixes.some((p) => String(channel).startsWith(p))

  // Logged once per channel and sender (a hostile page could send thousands),
  // and at most a few hundred lines in all.
  const logged = new Set()
  function refused(channel, event) {
    let who = 'unknown sender'
    try {
      const sender = event && event.sender
      const frame = event && event.senderFrame
      const type = sender && typeof sender.getType === 'function' ? sender.getType() : ''
      who = `webContents ${sender ? sender.id : '?'} ${type} ${frame ? String(frame.url || '').slice(0, 200) : '(no frame)'}`
    } catch {
      /* a sender being destroyed: keep the short label */
    }
    const key = `${channel}|${event && event.sender ? event.sender.id : '?'}`
    if (logged.has(key) || logged.size >= 500) return
    logged.add(key)
    try {
      if (log && typeof log.warn === 'function') log.warn('ipc', `refused ${channel} from ${who}`) // i18n-ignore log line
    } catch {
      /* logging never breaks IPC */
    }
  }
  function allowed(channel, event) {
    let ok = false
    try {
      ok = isTrustedSender(event) === true
    } catch {
      ok = false
    }
    if (!ok) refused(channel, event)
    return ok
  }
  // A refused sendSync gets null back instead of waiting forever.
  function drop(event) {
    try {
      if (event && typeof event === 'object') event.returnValue = null
    } catch {
      /* not a sync message */
    }
  }

  const origHandle = ipcMain.handle
  const origHandleOnce = ipcMain.handleOnce
  const origOn = ipcMain.on
  const origOnce = ipcMain.once
  const origPrepend = ipcMain.prependListener
  const origPrependOnce = ipcMain.prependOnceListener

  function guardedHandler(channel, fn, once) {
    return function (event, ...args) {
      // The caller's invoke() fails; the text never reaches a person.
      if (!allowed(channel, event)) return Promise.reject(new Error(`IPC channel ${channel} refused for this sender`)) // i18n-ignore internal
      if (once) ipcMain.removeHandler(channel)
      return fn.call(this, event, ...args)
    }
  }
  function guardedListener(channel, listener, remove) {
    const wrapped = function (event, ...args) {
      if (!allowed(channel, event)) return drop(event)
      if (remove) this.removeListener(channel, wrapped)
      return listener.call(this, event, ...args)
    }
    // removeListener(channel, listener) still finds it, as with once().
    wrapped.listener = listener
    return wrapped
  }

  ipcMain.handle = function (channel, fn) {
    if (isExempt(channel) || typeof fn !== 'function') return origHandle.call(this, channel, fn)
    return origHandle.call(this, channel, guardedHandler(channel, fn, false))
  }
  // Removed only after a trusted call (a refused one does not use it up).
  ipcMain.handleOnce = function (channel, fn) {
    if (isExempt(channel) || typeof fn !== 'function') return origHandleOnce.call(this, channel, fn)
    return origHandle.call(this, channel, guardedHandler(channel, fn, true))
  }
  // exemptOrig: what an exempt channel gets (once() stays once()).
  const listen = (orig, remove, exemptOrig) =>
    function (channel, listener) {
      if (isExempt(channel) || typeof listener !== 'function') return exemptOrig.call(this, channel, listener)
      return orig.call(this, channel, guardedListener(channel, listener, remove))
    }
  // once() through on(): Node's once() calls this.on(), which would wrap twice.
  ipcMain.on = listen(origOn, false, origOn)
  ipcMain.addListener = ipcMain.on
  ipcMain.once = listen(origOn, true, origOnce || origOn)
  if (typeof origPrepend === 'function') {
    ipcMain.prependListener = listen(origPrepend, false, origPrepend)
    ipcMain.prependOnceListener = listen(origPrepend, true, origPrependOnce || origPrepend)
  }
  return { isExempt }
}
