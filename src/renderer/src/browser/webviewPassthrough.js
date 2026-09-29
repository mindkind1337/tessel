// The browser's pages during Tessel's own drags (a divider, the sidebar or
// the task panel's edge, a pane moved by its header). A page is its own
// Chromium process: once the pointer is over it, the window no longer gets
// the pointer's moves nor its release, so a drag goes on after the button is
// let go and the page never gets its wheel and clicks back. While a drag
// runs, every page lets the pointer through (pointer-events: none, set on
// the element itself the moment the drag starts); the drag ends on the
// release, a cancel, the window losing focus, or the first move with no
// button held (a release that was missed).
// After Orca's src/renderer/src/components/browser-pane/host-guest/
// webview-drag-passthrough.ts and webview-registry.ts (MIT, Copyright (c)
// 2026 Lovecast Inc.), written for Tessel's Vue panes.

const tokens = new Set()
const webviews = new Set()

export function passthroughActive() {
  return tokens.size > 0
}

function apply(el) {
  if (el && el.style) el.style.pointerEvents = tokens.size ? 'none' : ''
}
function applyAll() {
  // Copied: a page may come or go while this runs.
  for (const el of Array.from(webviews)) apply(el)
}

// A page shown in a pane: it follows the drags from now on. -> unregister
export function registerWebview(el) {
  if (!el) return () => {}
  webviews.add(el)
  apply(el)
  return () => {
    webviews.delete(el)
    if (el.style) el.style.pointerEvents = ''
  }
}

// Pages let the pointer through until the returned release is called (drags
// can overlap: each holds its own; a second release does nothing).
export function acquirePassthrough() {
  const token = Symbol('drag')
  tokens.add(token)
  applyAll()
  let released = false
  return () => {
    if (released) return
    released = true
    tokens.delete(token)
    applyAll()
  }
}

// A pointer drag that always ends. e: the pointerdown; onMove(ev) for each
// move, onEnd(ev) once. -> a function that ends it now.
export function trackPointerDrag(e, { onMove = null, onEnd = null } = {}) {
  const release = acquirePassthrough()
  const target = e && e.currentTarget
  const pointerId = e && e.pointerId
  // The pointer stays with the handle, even over a page or out of the window.
  if (target && typeof target.setPointerCapture === 'function' && pointerId != null) {
    try {
      target.setPointerCapture(pointerId)
    } catch {
      // Not capturable: the window's listeners below still end it.
    }
  }
  let ended = false
  const move = (ev) => {
    // The button was let go where the window did not see it.
    if (ev && ev.pointerType === 'mouse' && ev.buttons === 0) return finish(ev)
    if (onMove) onMove(ev)
  }
  const finish = (ev) => {
    if (ended) return
    ended = true
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', finish)
    window.removeEventListener('pointercancel', finish)
    window.removeEventListener('blur', finish)
    if (target && typeof target.releasePointerCapture === 'function' && pointerId != null) {
      try {
        if (!target.hasPointerCapture || target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId)
      } catch {
        // Already released.
      }
    }
    release()
    if (onEnd) onEnd(ev)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', finish)
  window.addEventListener('pointercancel', finish)
  window.addEventListener('blur', finish)
  return () => finish(null)
}
