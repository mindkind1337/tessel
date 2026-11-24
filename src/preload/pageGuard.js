// Preload of the pages of Tessel's browser (registered on their sessions by
// src/main/browserGuest.js), run in each page's main frame before the page's
// own scripts. It exposes nothing to the page.
//
// window.print() opens Windows' print dialog over Tessel. A page may call it
// on its own (Gmail's print view calls it when it loads): such a page, kept
// in a pane and loaded again when Tessel starts, opened the dialog at every
// start, and an agent opening such a page opened it too. As Chromium does for
// a popup, print now works only right after the user's own click or key
// (transient user activation); a call without one does nothing, and the
// page's right-click menu has Print… for the user. It covers a page's own
// scripted print in its main frame, not a page set on getting around it.
import { contextBridge } from 'electron'

try {
  contextBridge.executeInMainWorld({
    func: () => {
      const realPrint = window.print
      if (typeof realPrint !== 'function') return
      // Taken now, before the page's scripts: a page that redefines
      // userActivation later cannot fake the click.
      const activation = navigator.userActivation
      const isActive = activation && Object.getOwnPropertyDescriptor(Object.getPrototypeOf(activation), 'isActive')
      const clicked = () => !!(isActive && isActive.get && Reflect.apply(isActive.get, activation, []))
      const print = function print() {
        if (clicked()) return Reflect.apply(realPrint, window, [])
        console.warn('Tessel: window.print() without a click was blocked (right-click > Print… prints the page).')
      }
      Object.defineProperty(window, 'print', { value: print, writable: true, configurable: true })
    }
  })
} catch {
  // An older Electron without executeInMainWorld: the page as it is.
}
