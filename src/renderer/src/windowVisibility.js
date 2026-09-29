// The page's visibility, made to follow the real window.
//
// Tessel's window runs with background throttling off (main/index.js: a
// minimized window must keep the team loop and reminders on time). Chromium
// then reports the page as "visible" even while minimized: requestAnimationFrame
// keeps running 60 times a second and every "only while visible" check
// (document.visibilityState, the visibilitychange event: the Resource Manager,
// the port scanner, sub-agent lists, clocks) never pauses.
//
// So the main process says when the window is minimized or hidden, and this
// makes document.visibilityState / document.hidden say "hidden" then, with a
// visibilitychange event at each change, as they do in a throttled window
// (Orca polls "only while the window is visible" the same way:
// src/renderer/src/lib/window-visibility-interval.ts, MIT, Copyright (c) 2026
// Lovecast Inc.). The <html> element also gets the class "window-hidden",
// which pauses the page's animations and terminal drawing (style.css).
// Timers keep running: only work that is shown to you waits.

export function installWindowVisibility({ doc = typeof document !== 'undefined' ? document : null, api = typeof window !== 'undefined' ? window.shellApi : null } = {}) {
  if (!doc || !api || typeof api.onWindowShown !== 'function') return () => {}
  const proto = Object.getPrototypeOf(doc)
  const find = (name) => {
    for (let p = proto; p; p = Object.getPrototypeOf(p)) {
      const d = Object.getOwnPropertyDescriptor(p, name)
      if (d) return d
    }
    return null
  }
  const nativeState = find('visibilityState')
  const readNative = () => (nativeState && nativeState.get ? nativeState.get.call(doc) : 'visible')
  let shown = true
  const state = () => (shown ? readNative() : 'hidden')
  try {
    Object.defineProperty(doc, 'visibilityState', { configurable: true, get: state })
    Object.defineProperty(doc, 'hidden', { configurable: true, get: () => state() === 'hidden' })
  } catch {
    return () => {}
  }
  const apply = (value) => {
    const next = value !== false
    if (next === shown) return
    const before = state()
    shown = next
    if (doc.documentElement && doc.documentElement.classList) doc.documentElement.classList.toggle('window-hidden', !shown)
    if (state() !== before) {
      try {
        doc.dispatchEvent(new Event('visibilitychange'))
      } catch {
        /* nothing listens */
      }
    }
  }
  const off = api.onWindowShown(apply)
  if (typeof api.windowShown === 'function') {
    Promise.resolve(api.windowShown())
      .then((value) => apply(value))
      .catch(() => {})
  }
  return () => {
    if (typeof off === 'function') off()
    apply(true)
    try {
      delete doc.visibilityState
      delete doc.hidden
    } catch {
      /* left as is */
    }
  }
}
