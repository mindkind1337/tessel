// Agents driving the built-in browser's pages: the main process's side of
// the browser_* tools (teamMcp/server.cjs). After Orca's agent browser
// (MIT, Copyright (c) 2026 Lovecast Inc.: src/main/browser/
// agent-browser-bridge*.ts, cdp-bridge.ts, cdp-debugger-events.ts,
// cdp-screenshot.ts, src/main/runtime/runtime-browser-commands*.ts and
// skill-guides/orca-cli/references/browser.md): a snapshot of the page with
// element refs, then click / fill / type / press by ref, re-snapshot after
// the page changes; commands go to the agent's own worktree's page unless it
// names one; console messages are kept per page for the agent to read.
//
// Who may drive what (each request, in this order):
// - The request comes over the tessel command's pipe (cliServer.js: this
//   Windows user only, the per-install token) and is signed with the
//   sending pane's own team secret (teamAuth.js: only a pane Tessel started
//   has it; the MAC covers the pane, the operation and its arguments; a
//   nonce is used once; an old request is refused).
// - "Let agents use the browser" (Settings > Agents) is on.
// - The window says which page (agentBrowserTargets.js): only an agent or
//   chat pane may drive, and only browser panes of its own project and
//   worktree grid (never the side panel's pages, never another project's).
// - The page must be a browser guest of Tessel's window, in the browser's
//   own session (browserGuest.js guestById): never Tessel's window itself
//   or any other webContents.
// - The user's Stop on the page's "Agent" badge revokes it for as long as
//   that page lives.
// - Navigation: only to an address the browser itself allows
//   (allowedBrowserUrl: http(s) and the blank page; no file:, no
//   user:password@). Downloads stay refused for every page (browserGuest.js).
// - No eval, no cookies, no storage, no field values in a snapshot; text and
//   printable keys never go into a password field, nor where Tessel cannot
//   see the focus; no paste (agentBrowserInput.js). browser_wait takes plain
//   selectors only (no [attribute] or :pseudo-class that could read values).
// - Stop or the setting turned off end every command still waiting.
// - Every answer is capped (text, console lines, screenshot size).
import fs from 'fs'
import { join } from 'path'
import crypto from 'crypto'
import { CliError } from './cliServer'
import { allowedBrowserUrl, normalizeBrowserInput, BLANK_URL } from '../shared/browserUrl'
import { buildSnapshot, MAX_SNAPSHOT_CHARS, MAX_FRAMES } from './agentBrowserSnapshot'
import {
  BrowserInputError,
  resolveRef,
  click,
  putText,
  pressKey,
  wheel,
  elementCenter,
  frameElementCenter,
  elementBox,
  frameElementBox,
  focusedField,
  navigationKey,
  parseKeyCombo,
  isolatedWorld,
  rememberSecrets,
  mouseButton,
  viewportPoint,
  pointInBox,
  dragEvents,
  keyTiming,
  moveSoon,
  BUTTON_BITS
} from './agentBrowserInput'
import { shortcutOf, quietContextMenu } from './browserGuest'
import { leaseDebugger } from './pageDebugger'

export const AGENT_OPS = ['pages', 'open', 'navigate', 'snapshot', 'click', 'mouse', 'fill', 'type', 'press', 'scroll', 'screenshot', 'console', 'wait']
// An answer's text, at most (characters).
export const MAX_RESULT_CHARS = 64000
// A screenshot sent back as an image, at most (base64 characters); larger
// ones are scaled down, else only their file is given.
export const MAX_IMAGE_B64 = 600 * 1024
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024
// Console messages kept per page, and one message's length.
export const CONSOLE_KEEP = 300
const CONSOLE_TEXT = 500
// After this long without a command the agent's control lapses: the badge
// goes, the debugger is let go (the next command takes it again).
export const IDLE_MS = 60 * 1000
const COMMAND_TIMEOUT_MS = 45 * 1000
const NAV_TIMEOUT_MS = 30 * 1000
// A page address in an answer, at most (longer: shortened).
const MAX_SHOWN_URL = 2000
const CAPTURE_TIMEOUT_MS = 5000
// A page on screen is captured at once; one out of sight fails at once or
// never answers: this long at first, then the window draws it unseen
// (pageHost.js revealPage) and the capture is tried again for up to
// PAINTED_CAPTURE_MS (harness, 2026-10-25: a drawn page answers in ~80 ms).
export const FIRST_CAPTURE_MS = 1500
export const PAINTED_CAPTURE_MS = 4000
const CAPTURE_RETRY_MS = 60
// Between the moves of a drag.
const DRAG_STEP_MS = 16
export const WAIT_DEFAULT_MS = 10000
export const WAIT_MAX_MS = 30000
const MAX_URL = 4000
const MAX_WAIT_TEXT = 500

const fail = (code, message) => new CliError(code, message)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function withTimeout(promise, ms, onTimeout) {
  let timer
  return Promise.race([promise, new Promise((resolve, reject) => (timer = setTimeout(() => (onTimeout ? resolve(onTimeout()) : reject(fail('timeout', 'The page did not answer in time.'))), ms)))]).finally(() => clearTimeout(timer))
}

export function capText(text, max = MAX_RESULT_CHARS) {
  const s = String(text == null ? '' : text)
  return s.length > max ? `${s.slice(0, max)}\n… (cut at ${max} characters)` : s
}

// An address an agent asked for -> the URL the browser opens, or throws.
// "localhost:5173" and "example.com" are fine (as typed in the address
// bar); a search never (the agent gives an address).
export function agentUrl(raw) {
  const s = String(raw == null ? '' : raw).trim()
  if (!s || s.length > MAX_URL) throw fail('invalid_argument', 'Give the page\'s "url" (http or https).')
  const url = normalizeBrowserInput(s, { search: false })
  const ok = url && allowedBrowserUrl(url)
  if (!ok) throw fail('url_refused', `The browser only opens http(s) pages: ${s.slice(0, 200)}`)
  return ok
}

function pageLine(p) {
  return `${p.current ? '* ' : '  '}${p.page}  ${String(p.title || '').slice(0, 120) || '(no title)'} — ${p.url || BLANK_URL}${p.ready === false ? '  (loading)' : ''}`
}

// A key combination an agent may not press: the ones Tessel's browser keeps
// for itself (browserGuest.js), and paste (Ctrl/Meta+V, Shift+Insert: the
// clipboard would go into the page, where the agent can read it).
export function reservedKey(combo) {
  const { def, modifiers } = parseKeyCombo(combo)
  const k = String(def.key).toLowerCase()
  if ((modifiers & 6) && k === 'v') return true
  if ((modifiers & 8) && k === 'insert') return true
  // The window's own keys (its default menu and the system's): a key the page
  // leaves unhandled can reach the window, which would close (Ctrl+W, Alt+F4),
  // minimize (Ctrl+M), go full screen (F11) or quit (Ctrl+Q).
  if ((modifiers & 6) && ['w', 'm', 'q'].includes(k)) return true
  if ((modifiers & 1) && k === 'f4') return true
  if (k === 'f11') return true
  return !!shortcutOf({ type: 'keyDown', key: def.key, control: !!(modifiers & 2), meta: !!(modifiers & 4), alt: !!(modifiers & 1), shift: !!(modifiers & 8) })
}

// A CSS selector browser_wait accepts: tags, #ids, .classes, *, the
// combinators (space > + ~) and commas only. No attribute selector and no
// pseudo-class: input[value^="a"], :autofill, :placeholder-shown or :invalid
// would let an agent read a field's value one character at a time.
export function safeSelector(raw) {
  const s = String(raw == null ? '' : raw).trim()
  if (!s || s.length > MAX_WAIT_TEXT || !/^[A-Za-z0-9_\s#.>+~*,-]+$/.test(s)) return null
  return s
}

// Agent screenshots kept (the newest), in their own folder.
export const KEEP_AGENT_SCREENSHOTS = 20
const AGENT_SHOT = /^browser-\d+-[0-9a-f]{6}\.png$/
export function pruneScreenshots(dir, keep = KEEP_AGENT_SCREENSHOTS, fsImpl = fs) {
  let names = []
  try {
    names = fsImpl.readdirSync(dir).filter((n) => AGENT_SHOT.test(n))
  } catch {
    return
  }
  names.sort((a, b) => Number(a.split('-')[1]) - Number(b.split('-')[1]) || a.localeCompare(b))
  for (const n of names.slice(0, Math.max(0, names.length - keep))) {
    try {
      fsImpl.unlinkSync(join(dir, n))
    } catch {
      // in use: next time
    }
  }
}

// One message from the page's console (Electron 42 passes an event object,
// older ones arguments). -> { level, text, source, line }
export function consoleEntry(args) {
  const [first, levelArg, messageArg, lineArg, sourceArg] = args
  const e = first && typeof first === 'object' && 'message' in first ? first : null
  const levelNames = ['debug', 'info', 'warning', 'error']
  const rawLevel = e ? e.level : levelArg
  const level = typeof rawLevel === 'number' ? levelNames[rawLevel] || 'info' : String(rawLevel || 'info')
  return {
    level: level === 'warn' ? 'warning' : level,
    text: String(e ? e.message : messageArg || '').slice(0, CONSOLE_TEXT),
    source: String(e ? e.sourceId || '' : sourceArg || '').slice(0, 300),
    line: Number(e ? e.lineNumber : lineArg) || 0,
    at: Date.now()
  }
}

// deps:
//   verify(body, paneId) -> { ok } | { unsigned } | { error }   (teamAuth, team key "browser")
//   enabled() -> bool          Settings > Agents > Let agents use the browser
//   ask(method, params)        the window (cliBridge): 'browserTarget'
//   guestById(id) -> webContents | null   (browserGuest.js: only the browser's pages)
//   send(channel, payload)     to the window: 'browser:agentControl'
//   windowState() -> { minimized, visible } | null   Tessel's window (for the answer when a capture fails)
//   nativeImage, screenshotDir, log
export function createAgentBrowser({ verify, enabled = () => true, ask, guestById, send = () => {}, windowState = () => null, nativeImage = null, screenshotDir = null, log = null }) {
  // guest id -> { refMap, navKey, queue, idle, agent, console: [], attached, listener }
  const pages = new Map()
  const revoked = new Set() // guest ids the user stopped
  // Browser page (pane) ids the user stopped: a page's view can be rebuilt
  // under a new guest (moved to another workspace, the window reloaded).
  const revokedPages = new Set()
  const lastPage = new Map() // agent pane id -> browser pane id it drove last
  const warn = (msg) => log && log.warn('agent-browser', msg)

  function stateOf(guest) {
    let s = pages.get(guest.id)
    if (!s) {
      s = { refMap: null, navKey: null, queue: Promise.resolve(), idle: null, agent: null, console: [], attached: false, lease: null, listener: null, world: null, secretIds: new Set(), frames: new Map(), guest, throttle: undefined, mouse: null }
      pages.set(guest.id, s)
      guest.once('destroyed', () => forget(guest.id))
    }
    return s
  }

  function forget(id) {
    const s = pages.get(id)
    if (s && s.idle) clearTimeout(s.idle)
    if (s && s.lease) s.lease.release()
    pages.delete(id)
    revoked.delete(id)
  }

  // Every page's console, from when it attached (browserGuest.js calls this).
  function watchGuest(guest) {
    if (!guest || typeof guest.on !== 'function') return
    const s = stateOf(guest)
    guest.on('console-message', (...args) => {
      s.console.push(consoleEntry(args))
      if (s.console.length > CONSOLE_KEEP) s.console.splice(0, s.console.length - CONSOLE_KEEP)
    })
  }

  // --- The debugger -------------------------------------------------------------
  // The page's debugger is shared (pageDebugger.js: Live Share may watch the
  // page too): the agents hold a lease on it while one drives the page, and
  // letting it go detaches it only if nobody else holds it.
  function sender(guest, sessionId = null) {
    return sessionId ? (method, params = {}) => guest.debugger.sendCommand(method, params, sessionId) : (method, params = {}) => guest.debugger.sendCommand(method, params)
  }
  // Frames from other sites run in their own process: the debugger attaches
  // to each (Target.setAutoAttach, flat sessions) and keeps them in
  // s.frames: session id -> { send, targetId, owner (its <iframe> in the
  // parent, learnt by a snapshot), parent (frame or null: the page), and
  // its own isolated world and remembered secret fields }.
  const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: 'iframe' }] }
  function frameAttached(guest, s, params, parentSession) {
    const info = (params && params.targetInfo) || {}
    if (!params || !params.sessionId || info.type !== 'iframe') return
    const send = sender(guest, params.sessionId)
    s.frames.set(params.sessionId, { send, targetId: info.targetId, owner: null, parent: (parentSession && s.frames.get(parentSession)) || null, world: null, secretIds: new Set() })
    // Page: its navigations and dialogs (answered as the page's, above).
    send('Page.enable').catch(() => {})
    send('DOM.enable').catch(() => {})
    send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
    // Its own frames from yet another site.
    send('Target.setAutoAttach', AUTO_ATTACH).catch(() => {})
  }
  // The page's frames from other sites, as focusedField takes them.
  const frameList = (s) => [...s.frames.values()].map((f) => ({ send: f.send, cache: f }))
  // An entry's frame from another site, or null (the page's own document).
  function frameOf(s, entry) {
    if (!entry.session) return null
    const f = s.frames.get(entry.session)
    if (!f) throw new BrowserInputError('stale_ref', 'The frame of this element is gone: call browser_snapshot again.')
    return f
  }
  // Stopped by the user, or the setting turned off (while a command waited):
  // nothing more is done to the page.
  function allowed(guest) {
    if (revoked.has(guest.id)) throw fail('stopped_by_user', 'The user stopped agents from driving this page. Ask them, or open another page with browser_open.')
    if (!enabled()) throw fail('disabled', 'The user turned off "Let agents use the browser" (Tessel Settings > Agents).')
  }
  // The debugger went away on its own (the page closed, its devtools opened).
  function dropped(s) {
    s.lease = null
    s.listener = null
    s.attached = false
    s.world = null
    s.frames.clear()
  }
  async function attach(guest, s) {
    allowed(guest)
    if (!s.lease || !s.lease.active) {
      s.lease = null
      s.listener = null
      s.attached = false
      try {
        s.lease = leaseDebugger(guest, 'agent', { onDetach: () => dropped(s) })
      } catch (err) {
        throw fail('debugger_busy', `Tessel could not take this page's debugger (${String(err && err.message).slice(0, 120)}). Close its devtools and try again.`)
      }
    }
    if (!s.listener) {
      s.listener = (_event, method, params, sessionId) => {
        if (method === 'Target.attachedToTarget') return frameAttached(guest, s, params, sessionId)
        if (method === 'Target.detachedFromTarget') return params && s.frames.delete(params.sessionId)
        // A frame from another site: its own document changed.
        if (sessionId) {
          const f = s.frames.get(sessionId)
          if (f && (method === 'Runtime.executionContextsCleared' || method === 'Page.frameNavigated')) f.world = null
          if (method !== 'Page.javascriptDialogOpening') return
        }
        if (method === 'Page.frameNavigated' && params && params.frame && !params.frame.parentId) {
          s.refMap = null
          s.navKey = null
          s.world = null
        }
        if (method === 'Runtime.executionContextsCleared') s.world = null
        // An unanswered dialog blocks every command: an alert is closed, a
        // confirm or prompt refused (never accepted for the agent).
        if (method === 'Page.javascriptDialogOpening') {
          s.console.push({ level: 'dialog', text: `[${params && params.type}] ${String((params && params.message) || '').slice(0, CONSOLE_TEXT)} (dismissed)`, source: '', line: 0, at: Date.now() })
          sender(guest, sessionId)('Page.handleJavaScriptDialog', { accept: !!params && params.type === 'alert' }).catch(() => {})
        }
      }
      s.lease.on(s.listener)
    }
    if (!s.attached) {
      const cdp = sender(guest)
      await cdp('Page.enable')
      await cdp('DOM.enable')
      // Frames from other sites (their content in the snapshot, their refs).
      await cdp('Target.setAutoAttach', AUTO_ATTACH).catch(() => {})
      // A page whose pane is not the focused one (another pane, another
      // window, a grid out of sight) still takes the agent's typing: it
      // behaves as focused while the agent drives it (undone on detach).
      await cdp('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
      s.attached = true
    }
    return sender(guest)
  }
  // The agents let the page's debugger go. Another holder keeps it attached:
  // what the agents turned on is undone as a detach would (the page no longer
  // behaves as focused, no more frames attached for them); their listener
  // goes with their lease (dialogs are the page's own again).
  function detach(guest, s) {
    const lease = s && s.lease
    if (lease) {
      s.lease = null
      if (lease.active && !lease.alone && guest && !guest.isDestroyed()) {
        lease.send('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {})
        lease.send('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }).catch(() => {})
        for (const sessionId of s.frames.keys()) lease.send('Target.detachFromTarget', { sessionId }).catch(() => {})
      }
      try {
        lease.release()
      } catch {
        // gone
      }
    }
    if (s) {
      s.listener = null
      s.attached = false
      s.world = null
      s.frames.clear()
    }
  }

  // --- A page out of sight keeps running ------------------------------------------
  // Out of sight (another project or tab shown, a pane maximized over it, the
  // window minimized or behind others) a page is not drawn: no
  // requestAnimationFrame, its animations stopped, and a mouse move sent to it
  // never arrives (bare Electron 42 harness, 2026-10-25: rAF 0/s and
  // Input.dispatchMouseEvent mouseMoved unanswered). While an agent drives it,
  // it runs as if on screen: with Electron's background throttling off its
  // view keeps drawing (rAF 60/s, timers on time, input delivered), whatever
  // the window shows. Set again at each command (a navigation can bring a new
  // view); the page's own setting comes back when the agent lets it go.
  function keepRunning(guest, s) {
    if (typeof guest.setBackgroundThrottling !== 'function') return
    try {
      if (s.throttle === undefined) s.throttle = typeof guest.getBackgroundThrottling === 'function' ? guest.getBackgroundThrottling() !== false : true
      guest.setBackgroundThrottling(false)
    } catch (err) {
      warn(`background throttling not changed: ${err && err.message}`)
    }
  }
  // Only a page that throttled before is set back (setting "off" again would
  // change nothing).
  function letRest(s) {
    const was = s.throttle
    s.throttle = undefined
    const guest = s.guest
    if (was !== true || !guest || guest.isDestroyed() || typeof guest.setBackgroundThrottling !== 'function') return
    try {
      guest.setBackgroundThrottling(true)
    } catch {
      // gone
    }
  }

  // --- The badge on the page ("Agent controlling · Stop") ---------------------------
  function controlled(guest, s, agent) {
    if (s.idle) clearTimeout(s.idle)
    else send('browser:agentControl', { webContentsId: guest.id, active: true, agent })
    s.agent = agent
    keepRunning(guest, s)
    s.idle = setTimeout(() => release(guest.id), IDLE_MS)
  }
  function release(id, { stopped = false } = {}) {
    const s = pages.get(id)
    if (s && s.idle) clearTimeout(s.idle)
    if (s) s.idle = null
    if (s) letRest(s)
    if (s) s.mouse = null
    // The lease goes even when the window no longer names the page.
    if (s) detach(guestById(id) || null, s)
    send('browser:agentControl', { webContentsId: id, active: false, ...(stopped ? { stopped: true } : {}) })
  }

  // The setting turned off: every page an agent drives is let go now.
  function releaseAll() {
    for (const [id, s] of pages) if (s.idle || s.attached) release(id)
  }

  // The user's Stop on a page's badge: no agent drives it again while it lives.
  function stop(id) {
    if (!Number.isSafeInteger(id) || !guestById(id)) return false
    revoked.add(id)
    const s = pages.get(id)
    if (s && s.page) revokedPages.add(s.page)
    // Commands still waiting on this page end now, not when the page answers.
    if (s && s.cancels) for (const cancel of [...s.cancels]) cancel(fail('stopped_by_user', 'The user stopped agents from driving this page.'))
    release(id, { stopped: true })
    return true
  }

  // --- Commands --------------------------------------------------------------------
  // One command at a time per page. A command the page never answers does
  // not hold the page: the next one starts once it timed out, and the user's
  // Stop ends every command still waiting on the page at once.
  function queued(s, guest, fn) {
    const go = () => {
      allowed(guest)
      return fn()
    }
    let cancel
    const cancelled = new Promise((_resolve, reject) => (cancel = reject))
    cancelled.catch(() => {})
    const run = s.queue.then(go, go)
    const answer = withTimeout(Promise.race([run, cancelled]), COMMAND_TIMEOUT_MS)
    if (!s.cancels) s.cancels = new Set()
    s.cancels.add(cancel)
    s.queue = answer.catch(() => {}).finally(() => s.cancels.delete(cancel))
    return answer
  }

  function waitLoaded(guest, ms = NAV_TIMEOUT_MS) {
    return new Promise((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        clearTimeout(timer)
        guest.removeListener('did-stop-loading', finish)
        resolve()
      }
      const timer = setTimeout(finish, ms)
      guest.on('did-stop-loading', finish)
      setTimeout(() => {
        if (!guest.isDestroyed() && !guest.isLoading()) finish()
      }, 300)
    })
  }

  // The page's address and title as answers show them (an address can be
  // huge after a redirect: shortened, so an answer is never too large).
  function where(guest) {
    const url = allowedBrowserUrl(guest.getURL()) || BLANK_URL
    return { url: url.length > MAX_SHOWN_URL ? `${url.slice(0, MAX_SHOWN_URL)}…` : url, title: String(guest.getTitle() || '').slice(0, 200) }
  }

  async function snapshot(guest, s, pane) {
    const cdp = await attach(guest, s)
    let contextId = null
    try {
      contextId = await isolatedWorld(cdp, s)
    } catch {
      contextId = null
    }
    // The page's password fields, remembered even if one is later shown as text.
    await rememberSecrets(cdp, s)
    for (const f of [...s.frames.values()].slice(0, MAX_FRAMES)) await rememberSecrets(f.send, f)
    // A frame's <iframe> -> where its document is read: the page's session
    // for a frame of the same process (by its frame id), the frame's own
    // session for one from another site (its target id is its frame id).
    const openFrame = async ({ session, backendNodeId }) => {
      const parent = session ? s.frames.get(session) : null
      if (session && !parent) return null
      const send = parent ? parent.send : cdp
      const { node } = await send('DOM.describeNode', { backendNodeId })
      const frameId = node && node.frameId
      if (!frameId) return null
      for (const [id, f] of s.frames) {
        if (f.targetId !== frameId) continue
        f.owner = backendNodeId
        f.parent = parent
        return { session: id, send: f.send, frameId: null }
      }
      return { session, send, frameId }
    }
    const result = await buildSnapshot(cdp, { contextId, maxChars: MAX_SNAPSHOT_CHARS, openFrame })
    s.refMap = result.refMap
    // Whose refs these are: a snapshot by another agent numbers them again.
    s.refOwner = pane
    s.navKey = await navigationKey(cdp)
    const { url, title } = where(guest)
    return { text: `Page: ${title || '(no title)'} — ${url}\n${result.snapshot || '(nothing readable on this page yet)'}` }
  }

  // The page's viewport, CSS pixels: { width, height, dpr, scrollX, scrollY }
  // (read in Tessel's isolated world: the page's scripts cannot change it).
  async function viewportOf(cdp, s) {
    let contextId = null
    try {
      contextId = await isolatedWorld(cdp, s)
    } catch {
      contextId = null
    }
    const r = await cdp('Runtime.evaluate', { expression: '[innerWidth, innerHeight, devicePixelRatio, scrollX, scrollY]', ...(contextId ? { contextId } : {}), returnByValue: true })
    const v = r && r.result && Array.isArray(r.result.value) ? r.result.value.map(Number) : []
    if (!(v[0] > 0 && v[1] > 0 && v[0] < 100000 && v[1] < 100000)) throw new BrowserInputError('not_laid_out', 'The page has no viewport yet (still loading?): try again in a moment.')
    return { width: Math.round(v[0]), height: Math.round(v[1]), dpr: v[2] > 0 && v[2] < 20 ? v[2] : 1, scrollX: Math.round(v[3]) || 0, scrollY: Math.round(v[4]) || 0 }
  }

  const usable = (img) => !!img && typeof img.isEmpty === 'function' && !img.isEmpty()
  const capturePage = (guest, ms) =>
    withTimeout(
      Promise.resolve().then(() => guest.capturePage()),
      ms,
      () => null
    ).catch(() => null)
  async function debuggerCapture(guest, s) {
    try {
      const cdp = await attach(guest, s)
      const r = await withTimeout(cdp('Page.captureScreenshot', { format: 'png' }), CAPTURE_TIMEOUT_MS, () => null)
      return r && r.data && nativeImage ? nativeImage.createFromBuffer(Buffer.from(r.data, 'base64')) : null
    } catch {
      return null
    }
  }
  // The page as it is drawn. Out of sight it is not drawn and no capture
  // answers (bare Electron 42 harness, 2026-10-25: capturePage rejects
  // "UnknownVizError" or never answers, the debugger's Page.captureScreenshot
  // never answers, for a page in a hidden project or tab, under a maximized
  // pane, of no size or with the window minimized; background throttling off
  // does not change it). So the window draws it, unseen, for the moment of
  // the capture (pageHost.js revealPage): then both answer, even minimized.
  // -> { img, painted } (painted: the window's answer, if it was asked)
  const windowHidden = () => {
    try {
      const w = windowState()
      return !!w && (!!w.minimized || w.visible === false)
    } catch {
      return false
    }
  }
  async function capturePageImage(guest, s, pane) {
    // The window minimized: nothing is drawn, the window draws it for the capture at once.
    let img = windowHidden() ? null : await capturePage(guest, FIRST_CAPTURE_MS)
    if (usable(img)) return { img, painted: null }
    let painted = null
    try {
      painted = (await ask('browserTarget', { agent: pane, op: 'paint', page: s.page, on: true })) || {}
    } catch (err) {
      painted = { error: String((err && err.message) || err).slice(0, 200) }
    }
    try {
      const until = Date.now() + PAINTED_CAPTURE_MS
      for (;;) {
        allowed(guest)
        img = await capturePage(guest, Math.max(200, Math.min(1000, until - Date.now())))
        if (usable(img)) return { img, painted }
        if (Date.now() >= until) break
        await sleep(CAPTURE_RETRY_MS)
      }
      img = await debuggerCapture(guest, s)
      return { img: usable(img) ? img : null, painted }
    } finally {
      // Put back as it was, before the answer (the next command finds it so).
      if (painted && painted.moved) await Promise.resolve(ask('browserTarget', { agent: pane, op: 'paint', page: s.page, on: false })).catch(() => {})
    }
  }

  // Why no capture came, and what the user or the agent can do.
  function captureFailure(painted) {
    let win = null
    try {
      win = windowState() || null
    } catch {
      win = null
    }
    const why = painted && painted.why
    const where =
      why === 'layer'
        ? `The page is out of sight (its project${painted.project ? ` "${painted.project}"` : ''} or its tab is not the one shown)`
        : why === 'covered'
          ? 'The page is out of sight (another pane is maximized over it)'
          : why
            ? 'The page is out of sight'
            : null
    if (win && (win.minimized || win.visible === false))
      return `${where ? `${where}, and ` : ''}Tessel's window is ${win.minimized ? 'minimized' : 'hidden'}: Windows did not let it draw the page for the capture. Restore Tessel's window (it may stay behind other windows, the page need not be shown) and call browser_screenshot again; browser_snapshot reads the page meanwhile.`
    if (painted && painted.error) return `${where ? `${where}. ` : ''}Tessel's window did not draw it for the capture (${painted.error}). Try again in a moment; browser_snapshot reads the page meanwhile.`
    return `${where ? `${where}. Tessel drew it unseen for the capture, but ` : ''}the page gave no picture (it may be frozen by a long script, or crashed). Try again in a moment, or read it with browser_snapshot.`
  }

  async function screenshot(guest, s, pane) {
    // Its viewport first (CSS pixels): coordinates an agent reads on the
    // screenshot are those browser_click / browser_mouse take.
    let vp = null
    try {
      vp = await viewportOf(await attach(guest, s), s)
    } catch {
      // Its debugger taken (devtools open): the capture alone.
      vp = null
    }
    const { img: shot, painted } = await capturePageImage(guest, s, pane)
    if (!shot) throw fail('capture_failed', captureFailure(painted))
    let img = shot
    // One image pixel per CSS pixel (a HiDPI screen or the page's zoom give more).
    const raw = img.getSize()
    if (vp && vp.dpr !== 1 && typeof img.resize === 'function') {
      const width = Math.max(1, Math.round(raw.width / vp.dpr))
      const height = Math.max(1, Math.round(raw.height / vp.dpr))
      if (width !== raw.width || height !== raw.height) img = img.resize({ width, height, quality: 'best' })
    }
    const png = img.toPNG()
    if (png.length > MAX_SCREENSHOT_BYTES) throw fail('too_large', 'The screenshot is too large.')
    let file = null
    if (screenshotDir) {
      try {
        fs.mkdirSync(screenshotDir, { recursive: true })
        pruneScreenshots(screenshotDir, KEEP_AGENT_SCREENSHOTS - 1)
        file = join(screenshotDir, `browser-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.png`)
        fs.writeFileSync(file, png)
      } catch (err) {
        warn(`screenshot not saved: ${err.message}`)
        file = null
      }
    }
    const size = img.getSize()
    let image = { data: png.toString('base64'), mimeType: 'image/png' }
    let shownWidth = size.width
    if (image.data.length > MAX_IMAGE_B64) {
      // Smaller: half the width at most twice, as JPEG.
      let small = img
      image = null
      for (let i = 0; i < 3 && !image; i++) {
        small = small.resize({ width: Math.max(320, Math.round(small.getSize().width * (i === 0 ? 1 : 0.6))) })
        const jpg = small.toJPEG(70).toString('base64')
        if (jpg.length <= MAX_IMAGE_B64) {
          image = { data: jpg, mimeType: 'image/jpeg' }
          shownWidth = small.getSize().width
        }
      }
    }
    const { url } = where(guest)
    // The coordinate system, for a canvas or a game clicked by x/y.
    let coords = ''
    if (vp) {
      coords = ` ${size.width}x${size.height} pixels = the page's viewport in CSS pixels (devicePixelRatio ${Math.round(vp.dpr * 100) / 100}, scrolled to ${vp.scrollX},${vp.scrollY}): a point (x, y) on it is browser_click / browser_mouse {x, y}.`
      const k = shownWidth / size.width
      if (image && Math.abs(k - 1) > 0.01) coords += ` The image shown here is scaled to ${Math.round(k * 100)}%: divide what you read on it by ${Math.round(k * 1000) / 1000} (the saved file is full size).`
    } else coords = ` ${size.width}x${size.height} pixels (the page's scale could not be read: divide by the page's devicePixelRatio to get CSS pixels).`
    return {
      text: `Screenshot of ${url}.${coords}${file ? ` Saved to ${file}.` : ''}${image ? '' : ' It is too large to show here: read the file.'}`,
      ...(image ? { image } : {}),
      ...(file ? { file } : {})
    }
  }

  function consoleText(s, args) {
    const limit = Math.min(CONSOLE_KEEP, Math.max(1, Math.round(Number(args.limit) || 50)))
    const level = args.level ? String(args.level).toLowerCase() : null
    let list = s.console
    if (level) list = list.filter((e) => e.level === level || (level === 'warn' && e.level === 'warning'))
    list = list.slice(-limit)
    if (!list.length) return { text: level ? `No ${level} console messages.` : 'No console messages.' }
    return { text: list.map((e) => `[${e.level}] ${e.text}${e.source ? ` (${e.source}${e.line ? `:${e.line}` : ''})` : ''}`).join('\n') }
  }

  // Waits for text on the page, a CSS selector, or the address to contain a part.
  async function waitFor(guest, args) {
    const ms = Math.min(WAIT_MAX_MS, Math.max(100, Math.round(Number(args.timeout_ms) || WAIT_DEFAULT_MS)))
    const text = args.text != null ? String(args.text) : null
    const selector = args.selector != null ? String(args.selector) : null
    const urlPart = args.url != null ? String(args.url) : null
    const given = [text, selector, urlPart].filter((v) => v != null)
    if (given.length !== 1 || !given[0] || given[0].length > MAX_WAIT_TEXT) throw fail('invalid_argument', 'Give one of "text", "selector" or "url" (at most 500 characters).')
    if (selector != null && !safeSelector(selector))
      throw fail('invalid_argument', 'browser_wait takes a simple selector only: tags, #id, .class, *, combinators (space > + ~) and commas. No [attributes] and no :pseudo-classes.')
    const until = Date.now() + ms
    for (;;) {
      if (guest.isDestroyed()) throw fail('page_gone', 'The page was closed.')
      allowed(guest) // stopped, or the setting turned off, while it waits
      // The user's Stop, or the setting turned off, while it waits: no more
      // looking at the page, and no answer from it.
      allowed(guest)
      let hit = false
      if (urlPart) hit = String(guest.getURL()).includes(urlPart)
      else {
        const code = text
          ? `(() => { const b = document.body; return !!b && b.innerText.includes(${JSON.stringify(text)}) })()`
          : `(() => { try { return !!document.querySelector(${JSON.stringify(selector)}) } catch { return 'bad' } })()`
        let v = false
        try {
          v = typeof guest.executeJavaScriptInIsolatedWorld === 'function' ? await guest.executeJavaScriptInIsolatedWorld(1999, [{ code }]) : false
        } catch {
          v = false
        }
        if (v === 'bad') throw fail('invalid_argument', `Not a valid CSS selector: ${selector.slice(0, 200)}`)
        hit = v === true
      }
      allowed(guest)
      if (hit) return { text: `Found ${text ? 'the text' : selector ? 'the selector' : 'the address'} on ${where(guest).url}.` }
      if (Date.now() >= until) throw fail('wait_timeout', `Not found after ${ms} ms.`)
      await sleep(250)
    }
  }

  async function navigate(guest, s, args) {
    const action = args.action ? String(args.action).toLowerCase() : null
    if (action && !['back', 'forward', 'reload'].includes(action)) throw fail('invalid_argument', '"action" must be back, forward or reload.')
    if (!action && args.url == null) throw fail('invalid_argument', 'Give a "url" or an "action" (back, forward, reload).')
    s.refMap = null
    const h = guest.navigationHistory
    if (action === 'back') {
      if (!(h && h.canGoBack())) throw fail('no_history', 'There is no page to go back to.')
      h.goBack()
    } else if (action === 'forward') {
      if (!(h && h.canGoForward())) throw fail('no_history', 'There is no page to go forward to.')
      h.goForward()
    } else if (action === 'reload') guest.reload()
    else {
      const url = agentUrl(args.url)
      // A refused or failed load still answers with where the page is.
      guest.loadURL(url).catch(() => {})
    }
    await waitLoaded(guest)
    const w = where(guest)
    return { text: `Now on ${w.url} — ${w.title || '(no title)'}. Call browser_snapshot to read it.` }
  }

  async function run(op, guest, s, args, pane) {
    // A ref in a frame from another site: its frame's session, its place in the page.
    const sendOf = (entry) => {
      const f = frameOf(s, entry)
      return f ? f.send : sender(guest)
    }
    const centerOf = (cdp, entry) => {
      const f = frameOf(s, entry)
      return f ? frameElementCenter(cdp, f, entry.backendDOMNodeId) : elementCenter(cdp, entry.backendDOMNodeId)
    }
    const boxOf = (cdp, entry) => {
      const f = frameOf(s, entry)
      return f ? frameElementBox(cdp, f, entry.backendDOMNodeId) : elementBox(cdp, entry.backendDOMNodeId)
    }
    // The pointer as the page last saw it from the agent (a button held down by browser_mouse "down").
    const mouse = () => s.mouse || (s.mouse = { x: null, y: null, buttons: 0, button: 'none' })
    const pointerText = (at, button) => `(${at.x}, ${at.y})${button !== 'left' ? ` with the ${button} button` : ''}`
    // A ref is this agent's only if its own snapshot gave it (two agents on
    // one page: the other's snapshot listed other elements under the same refs).
    if (args.ref != null && s.refMap && s.refOwner !== pane) {
      throw new BrowserInputError('stale_ref', 'Another agent read this page since your snapshot: call browser_snapshot again.')
    }
    switch (op) {
      case 'snapshot':
        return snapshot(guest, s, pane)
      case 'navigate':
        return navigate(guest, s, args)
      case 'screenshot':
        return screenshot(guest, s, pane)
      case 'console':
        return consoleText(s, args)
      case 'wait':
        return waitFor(guest, args)
      case 'click': {
        const button = mouseButton(args.button)
        const point = args.x != null || args.y != null
        if (args.ref == null && !point) throw new BrowserInputError('invalid_argument', 'Give a "ref" from browser_snapshot, or "x" and "y" (CSS pixels of the page\'s viewport, as on browser_screenshot).')
        const cdp = await attach(guest, s)
        const clickCount = args.double ? 2 : 1
        // An agent's right-click is for the page (a game's own menu): Tessel's
        // page menu does not open on the user's screen for it.
        if (button === 'right') quietContextMenu(guest.id)
        if (args.ref == null) {
          const at = viewportPoint(args.x, args.y, await viewportOf(cdp, s))
          await click(cdp, null, { button, clickCount, at: async () => at })
          Object.assign(mouse(), { x: at.x, y: at.y })
          await sleep(150)
          return { text: `Clicked at ${pointerText(at, button)}${clickCount > 1 ? ' twice' : ''}. If the page changed, take a browser_screenshot or browser_snapshot again.` }
        }
        const entry = await resolveRef(cdp, s, args.ref, sendOf)
        const at = point ? pointInBox(await boxOf(cdp, entry), args.x, args.y, await viewportOf(cdp, s)) : null
        await click(cdp, entry.backendDOMNodeId, { button, clickCount, at: at ? async () => at : () => centerOf(cdp, entry) })
        await sleep(150)
        return { text: `Clicked ${args.ref} (${entry.role} "${entry.name}")${at ? ` at ${pointerText(at, button)}` : button !== 'left' ? ` with the ${button} button` : ''}. If the page changed, call browser_snapshot again.` }
      }
      case 'mouse': {
        const action = String(args.action || '').toLowerCase()
        if (!['move', 'down', 'up', 'drag'].includes(action)) throw new BrowserInputError('invalid_argument', '"action" must be move, down, up or drag.')
        const button = mouseButton(args.button)
        const cdp = await attach(guest, s)
        const vp = await viewportOf(cdp, s)
        const m = mouse()
        // down / up without x and y: where the pointer is.
        const at = args.x == null && args.y == null && action !== 'drag' && action !== 'move' && m.x != null ? { x: m.x, y: m.y } : viewportPoint(args.x, args.y, vp)
        // Moves: not waited for longer than a moment (moveSoon), presses and releases fully.
        const dispatch = (ev, ms = 250) => (ev.type === 'mouseMoved' ? moveSoon(cdp, ev, ms) : cdp('Input.dispatchMouseEvent', ev))
        if (button === 'right' && action !== 'move') quietContextMenu(guest.id)
        if (action === 'drag') {
          const to = viewportPoint(args.to_x, args.to_y, vp, ['to_x', 'to_y'])
          const events = dragEvents(at, to, { button, steps: args.steps })
          for (const ev of events) {
            allowed(guest)
            await dispatch(ev, 50)
            if (ev.type === 'mouseMoved') await sleep(DRAG_STEP_MS)
          }
          Object.assign(m, { x: to.x, y: to.y, buttons: 0, button: 'none' })
          await sleep(100)
          return { text: `Dragged from (${at.x}, ${at.y}) to (${to.x}, ${to.y}) in ${events.length - 3} steps${button !== 'left' ? ` with the ${button} button` : ''}.` }
        }
        if (action === 'move') {
          await dispatch({ type: 'mouseMoved', x: at.x, y: at.y, button: m.buttons ? m.button : 'none', buttons: m.buttons })
          Object.assign(m, { x: at.x, y: at.y })
          return { text: `Moved the pointer to (${at.x}, ${at.y})${m.buttons ? ` with the ${m.button} button held` : ''}.` }
        }
        if (action === 'down') {
          if (m.x !== at.x || m.y !== at.y) await dispatch({ type: 'mouseMoved', x: at.x, y: at.y, button: m.buttons ? m.button : 'none', buttons: m.buttons })
          const buttons = m.buttons | BUTTON_BITS[button]
          await dispatch({ type: 'mousePressed', x: at.x, y: at.y, button, buttons, clickCount: 1 })
          Object.assign(m, { x: at.x, y: at.y, buttons, button })
          return { text: `Pressed the ${button} button at (${at.x}, ${at.y}); browser_mouse "move" drags with it held, "up" releases it.` }
        }
        if (m.x !== at.x || m.y !== at.y) await dispatch({ type: 'mouseMoved', x: at.x, y: at.y, button: m.buttons ? m.button : 'none', buttons: m.buttons })
        const buttons = m.buttons & ~BUTTON_BITS[button]
        await dispatch({ type: 'mouseReleased', x: at.x, y: at.y, button, buttons, clickCount: 1 })
        Object.assign(m, { x: at.x, y: at.y, buttons, button: buttons ? m.button : 'none' })
        await sleep(100)
        return { text: `Released the ${button} button at (${at.x}, ${at.y}).` }
      }
      case 'fill':
      case 'type': {
        const cdp = await attach(guest, s)
        const entry = await resolveRef(cdp, s, args.ref, sendOf)
        const frame = frameOf(s, entry)
        const put = await putText(frame ? frame.send : cdp, entry.backendDOMNodeId, args.text, {
          clear: op === 'fill',
          cache: frame || s,
          keys: cdp,
          focusNow: () => focusedField(cdp, s, frameList(s)),
          insert: typeof guest.insertText === 'function' ? (t) => guest.insertText(t) : null
        })
        if (put && put.option) return { text: `Chose "${put.option}" in ${args.ref} (${entry.role} "${entry.name}").` }
        return { text: `${op === 'fill' ? 'Filled' : 'Typed into'} ${args.ref} (${entry.role} "${entry.name}").` }
      }
      case 'press': {
        // Keys the browser or Tessel itself would act on (Ctrl+Shift+W closes
        // a pane, Ctrl+R reloads, F12 opens devtools...): never from an agent.
        if (reservedKey(args.key)) throw fail('reserved_key', `${String(args.key).slice(0, 40)} is a Tessel or browser shortcut, or paste: agents cannot press it.`)
        const timing = keyTiming(args.hold_ms, args.repeat)
        const cdp = await attach(guest, s)
        const key = await pressKey(cdp, args.key, typeof guest.sendInputEvent === 'function' ? (ev) => guest.sendInputEvent(ev) : null, s, frameList(s), timing)
        const how = `${timing.holdMs ? ` held ${timing.holdMs} ms` : ''}${timing.repeat > 1 ? ` ${timing.repeat} times` : ''}`
        return { text: `Pressed ${String(args.key).slice(0, 40) || key}${how}.` }
      }
      case 'scroll': {
        const cdp = await attach(guest, s)
        let at = null
        if (args.ref) {
          const entry = await resolveRef(cdp, s, args.ref, sendOf)
          at = await centerOf(cdp, entry)
          if (!args.direction) return { text: `Scrolled ${args.ref} into view.` }
        }
        const px = await wheel(cdp, args.direction, args.amount, at)
        await sleep(100)
        return { text: `Scrolled ${String(args.direction || 'down').toLowerCase()} by ${px}px.` }
      }
      default:
        throw fail('unknown_method', `Unknown browser operation: ${String(op).slice(0, 40)}`)
    }
  }

  // The window's answer about pages -> checked.
  function targetFrom(reply) {
    if (!reply || typeof reply !== 'object') throw fail('no_page', 'Tessel\'s window did not name a page.')
    return reply
  }

  // params: { pane, op, args, auth } (checked by cliServer.js) -> { text, image?, file? }
  async function handle(params) {
    const { pane, op, args = {}, auth } = params || {}
    const v = verify({ op, args, auth }, pane)
    if (!v || v.unsigned) throw fail('unauthorized', 'This request is not signed by a pane Tessel started: restart the agent from Tessel.')
    if (v.error) throw fail(/no team secret/.test(v.error) ? 'unknown_pane' : 'unauthorized', `Refused: ${v.error}.`)
    if (!AGENT_OPS.includes(op)) throw fail('unknown_method', `Unknown browser operation: ${String(op).slice(0, 40)}`)
    if (!enabled()) throw fail('disabled', 'The user turned off "Let agents use the browser" (Tessel Settings > Agents).')

    if (op === 'pages') {
      const r = targetFrom(await ask('browserTarget', { agent: pane, op: 'list', last: lastPage.get(pane) || null }))
      const list = Array.isArray(r.pages) ? r.pages : []
      if (!list.length) return { text: 'No browser page in your project yet: open one with browser_open.' }
      return { text: capText(`Browser pages of your project (* = the one commands go to by default):\n${list.map(pageLine).join('\n')}`) }
    }
    if (op === 'open') {
      const url = args.url == null || args.url === '' ? BLANK_URL : agentUrl(args.url)
      const r = targetFrom(await ask('browserTarget', { agent: pane, op: 'open', url }))
      lastPage.set(pane, r.page)
      const guest = r.guestId != null ? guestById(r.guestId) : null
      if (guest) {
        const s = stateOf(guest)
        s.page = r.page
        controlled(guest, s, r.agent)
        await waitLoaded(guest)
      }
      const w = guest ? where(guest) : { url, title: '' }
      return { text: `Opened page ${r.page} next to you: ${w.url}${w.title ? ` — ${w.title}` : ''}. Commands now go to it. Call browser_snapshot to read it.` }
    }

    const r = targetFrom(await ask('browserTarget', { agent: pane, op: 'resolve', page: args.page || null, last: lastPage.get(pane) || null }))
    const guest = r.guestId != null ? guestById(r.guestId) : null
    if (!guest) throw fail('page_not_ready', 'That browser page is not ready yet: try again in a moment.')
    if (revoked.has(guest.id) || revokedPages.has(r.page)) throw fail('stopped_by_user', 'The user stopped agents from driving this page. Ask them, or open another page with browser_open.')
    lastPage.set(pane, r.page)
    const s = stateOf(guest)
    s.page = r.page
    controlled(guest, s, r.agent)
    try {
      const out = await queued(s, guest, () => run(op, guest, s, args, pane))
      return { ...out, text: capText(out.text) }
    } catch (err) {
      if (err instanceof CliError) throw err
      if (err instanceof BrowserInputError) {
        // Keys refused where Tessel cannot see the focus: said once per page in the log.
        if (err.code === 'field_not_visible' && !s.opaqueLogged) {
          s.opaqueLogged = true
          warn(`${op}: refused characters, the keyboard is where Tessel cannot look (a frame it cannot inspect, or a closed component) on ${where(guest).url.slice(0, 200)}`)
        }
        throw fail(err.code, err.message)
      }
      warn(`${op} failed: ${err && err.message}`)
      throw fail('page_error', `The page refused: ${String((err && err.message) || err).slice(0, 300)}`)
    }
  }

  return { handle, stop, watchGuest, release, releaseAll, isRevoked: (id) => revoked.has(id), _pages: pages }
}
