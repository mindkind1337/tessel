// The keyboard stays where the user types.
//
// Guard: a browser page (a <webview>) that an agent drives, one out of sight,
// or any page while the user types in a pane, gives the keyboard back when it
// takes it without a click or a shortcut of the user's. An agent clicks a page with Chromium's own mouse
// events (src/main/agentBrowser.js), which took the keyboard from the pane
// the user was typing in, even from a page in another workspace. The page
// keeps believing it has the keyboard (the agent's focus emulation), so the
// agent's typing still reaches it.
//
// Diagnostics: the keyboard leaves a pane while the user types in it, with no
// click or shortcut of theirs. Each time, one "focus:" line in tessel.log says
// where it went: another element (with the code that focused it), the pane's
// input taken off the page (the pane was drawn again), or another window.

const INPUT_SEL = '.xterm-helper-textarea, [contenteditable="true"], textarea, input' // i18n-ignore

function paneIdOf(el) {
  const pane = el && el.closest ? el.closest('.pane') : null
  return pane ? pane.getAttribute('data-pane-id') || '?' : null
}

export function describeEl(el) {
  if (!el) return 'nothing' // i18n-ignore
  if (el.tagName === 'BODY') return 'the page (no element)' // i18n-ignore
  let s = String(el.tagName || '').toLowerCase()
  if (el.id) s += `#${el.id}`
  const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 3) : []
  if (cls.length) s += `.${cls.join('.')}`
  const test = el.getAttribute && el.getAttribute('data-test')
  if (test) s += `[${test}]`
  const pane = paneIdOf(el)
  if (pane) s += ` in ${pane}` // i18n-ignore
  else {
    const box = el.parentElement && el.parentElement.closest('[class]')
    const where = box && typeof box.className === 'string' ? box.className.trim().split(/\s+/)[0] : ''
    if (where) s += ` in .${where}` // i18n-ignore
  }
  return s
}

// The frames that called focus() or blur(), without this file's own and the
// dev server's address.
export function shortStack(stack, max = 5) {
  return String(stack || '')
    .split('\n')
    .slice(1)
    .map((l) => l.trim().replace(/^at\s+/, ''))
    .filter((l) => l && !/focusWatch/.test(l))
    .slice(0, max)
    .map((l) => l.replace(/\(?https?:\/\/[^/]+\//, '(').replace(/\?[^:)]*/, ''))
    .join(' < ')
}

export function installFocusWatch({ win = typeof window !== 'undefined' ? window : null, doc = typeof document !== 'undefined' ? document : null, log, now = () => Date.now(), typingMs = 3000, gestureMs = 600, settleMs = 60, maxLines = 200, pointerSlack = 48 } = {}) {
  if (!win || !doc || typeof log !== 'function') return () => {}
  let lastKey = { at: 0, pane: null, el: null }
  let lastGesture = -Infinity
  let lastCall = null
  let lastLine = -Infinity
  let lines = 0

  function report({ from, pane, to, keyAt, how }) {
    const t = now()
    if (lines >= maxLines || t - lastLine < 2000) return
    lastLine = t
    lines++
    lastKey = { at: 0, pane: null, el: null }
    const parts = [`focus: the keyboard left ${pane} while typing (${how}, ${Math.round((t - keyAt) / 100) / 10} s after a key there)`] // i18n-ignore
    parts.push(`now in ${describeEl(to)}`) // i18n-ignore
    if (!doc.hasFocus()) parts.push('the Tessel window lost the focus to another window') // i18n-ignore
    if (!from.isConnected) parts.push('its input was taken off the page (pane drawn again)') // i18n-ignore
    else if (from.getClientRects && !from.getClientRects().length) parts.push('its input is hidden') // i18n-ignore
    if (lastCall && lastCall.at >= keyAt) parts.push(`last ${lastCall.what}() on ${describeEl(lastCall.el)} from ${shortStack(lastCall.stack)}`) // i18n-ignore
    try {
      log(parts.join('; '))
    } catch {
      /* the log is gone */
    }
  }
  const typedLately = (t) => !!lastKey.el && t - lastKey.at <= typingMs && t - lastGesture >= gestureMs && lastGesture < lastKey.at

  const onPointer = () => (lastGesture = now())
  const onKey = (e) => {
    // Shortcuts and Tab move the keyboard on purpose.
    if (e.key === 'Tab' || e.key === 'Escape' || e.ctrlKey || e.altKey || e.metaKey || /^F\d+$/.test(e.key)) {
      lastGesture = now()
      return
    }
    const t = e.target
    const pane = t && t.matches && t.matches(INPUT_SEL) ? paneIdOf(t) : null
    if (pane && (pane === lastKey.pane || !typedLately(now()))) {
      lastKey = { at: now(), pane, el: t }
      return
    }
    // A key that reaches something else right after typing in a pane, with no
    // click or shortcut between (Chromium sends no focusout when the focused
    // input is taken off the page).
    if (typedLately(now())) report({ from: lastKey.el, pane: lastKey.pane, to: doc.activeElement, keyAt: lastKey.at, how: 'a key went elsewhere' }) // i18n-ignore
  }
  win.addEventListener('pointerdown', onPointer, true)
  win.addEventListener('keydown', onKey, true)

  // Who called focus() or blur() last (the stack says which code).
  const proto = win.HTMLElement && win.HTMLElement.prototype
  const origFocus = proto && proto.focus
  const origBlur = proto && proto.blur
  if (proto) {
    proto.focus = function (...args) {
      lastCall = { at: now(), what: 'focus', el: this, stack: new Error().stack }
      return origFocus.apply(this, args)
    }
    proto.blur = function (...args) {
      lastCall = { at: now(), what: 'blur', el: this, stack: new Error().stack }
      return origBlur.apply(this, args)
    }
  }

  const onFocusOut = (e) => {
    const from = e.target
    if (!from || from !== lastKey.el || !typedLately(now())) return
    const { pane, at } = lastKey
    win.setTimeout(() => {
      const to = doc.activeElement
      // Still there and the window still has the keyboard: nothing was lost.
      if (to === from && doc.hasFocus()) return
      if (lastKey.el !== from || !typedLately(now())) return
      // A page that took it unasked gives it back (the guard below says so).
      if (isPage(to) && giveBack(to)) return
      report({ from, pane, to, keyAt: at, how: 'focus moved' }) // i18n-ignore
    }, settleMs)
  }
  doc.addEventListener('focusout', onFocusOut, true)

  // --- Guard: a page that takes the keyboard unasked gives it back ---------------
  let lastFocused = null
  let lastPointer = null
  let pointerIn = null
  let windowFocusAt = -Infinity
  const onWindowFocus = () => (windowFocusAt = now())
  const isPage = (el) => !!el && el.tagName === 'WEBVIEW'
  // A page lives in its pane's box of the page layer (browser/pageHost.js),
  // not in the pane: the box names the pane.
  function pagePaneId(page) {
    const box = page.closest ? page.closest('.bp-box') : null
    return (box && box.dataset && box.dataset.browserPage) || paneIdOf(page)
  }
  function pagePane(page) {
    const id = pagePaneId(page)
    if (id && /^[\w-]+$/.test(id)) {
      const el = doc.querySelector(`.pane[data-pane-id="${id}"]`) // i18n-ignore
      if (el) return el
    }
    return page.closest ? page.closest('.browser-pane') : null
  }
  function pageHidden(page) {
    if (!page.getClientRects().length) return true
    if (page.closest && page.closest('.ws-layer.hidden')) return true
    // Drawn unseen for an agent (browser/pageHost.js): out of sight all the same.
    if (page.closest && page.closest('.bp-unseen')) return true
    const style = win.getComputedStyle ? win.getComputedStyle(page) : null
    return !!style && (style.visibility === 'hidden' || style.display === 'none')
  }
  const onPointerMove = (e) => {
    lastPointer = { x: e.clientX, y: e.clientY }
    pointerIn = isPage(e.target) ? e.target : null
  }
  const onMouseOver = (e) => {
    if (isPage(e.target)) pointerIn = e.target
  }
  const onMouseOut = (e) => {
    if (isPage(e.target) && pointerIn === e.target && !isPage(e.relatedTarget)) pointerIn = null
  }
  // Could the mouse be over this page (the window gets no events from inside
  // a page: its last position next to the page's edge counts)?
  function pointerOver(page) {
    if (pointerIn === page) return true
    if (!lastPointer || !page.getBoundingClientRect) return false
    const r = page.getBoundingClientRect()
    if (!r.width || !r.height) return false
    const s = pointerSlack
    return lastPointer.x >= r.left - s && lastPointer.x <= r.right + s && lastPointer.y >= r.top - s && lastPointer.y <= r.bottom + s
  }
  function shouldGiveBack(page) {
    const back = lastFocused
    if (!back || !back.isConnected || back === page || back === doc.body) return false
    const t = now()
    // Asked for: Tessel's own code focused the page, or a shortcut or a click
    // of the user's just now, or the mouse is on the page (a click in it).
    if (lastCall && lastCall.el === page && lastCall.what === 'focus' && t - lastCall.at < 500) return false
    // Only a page an agent drives (its badge shows), one out of sight, or any
    // page while the user is typing in a pane (a page focusing one of its
    // fields as it reloads): otherwise a page the user may have clicked keeps
    // the keyboard.
    const pane = pagePane(page)
    const driven = !!(pane && pane.querySelector('[data-test="browser-agent"]'))
    const hidden = pageHidden(page)
    const typing = !!lastKey.el && t - lastKey.at <= typingMs
    if (!driven && !hidden && !typing) return false
    if (t - lastGesture < gestureMs) return false
    // The window just came back (a click on the page from another program,
    // or Chromium putting the keyboard back where it was).
    if (t - windowFocusAt < 1000) return false
    if (!hidden && pointerOver(page)) return false
    if (back.getClientRects && !back.getClientRects().length) return false
    return true
  }
  function giveBack(page) {
    if (!shouldGiveBack(page)) return false
    const back = lastFocused
    const t = now()
    origFocus.call(back, { preventScroll: true })
    if (lines < maxLines && t - lastLine >= 2000) {
      lastLine = t
      lines++
      try {
        log(`focus: a browser page (${pagePaneId(page) || '?'}${pageHidden(page) ? ', out of sight' : ''}) took the keyboard without a click; given back to ${describeEl(back)}`) // i18n-ignore
      } catch {
        /* the log is gone */
      }
    }
    return true
  }
  const onFocusIn = (e) => {
    const el = e.target
    if (isPage(el)) {
      if (origFocus) win.setTimeout(() => doc.activeElement === el && giveBack(el), 0)
      return
    }
    if (el && el !== doc.body) lastFocused = el
  }
  win.addEventListener('pointermove', onPointerMove, true)
  win.addEventListener('focus', onWindowFocus)
  win.addEventListener('mouseover', onMouseOver, true)
  win.addEventListener('mouseout', onMouseOut, true)
  doc.addEventListener('focusin', onFocusIn, true)

  return () => {
    win.removeEventListener('pointerdown', onPointer, true)
    win.removeEventListener('keydown', onKey, true)
    doc.removeEventListener('focusout', onFocusOut, true)
    win.removeEventListener('pointermove', onPointerMove, true)
    win.removeEventListener('focus', onWindowFocus)
    win.removeEventListener('mouseover', onMouseOver, true)
    win.removeEventListener('mouseout', onMouseOut, true)
    doc.removeEventListener('focusin', onFocusIn, true)
    if (proto) {
      proto.focus = origFocus
      proto.blur = origBlur
    }
  }
}
