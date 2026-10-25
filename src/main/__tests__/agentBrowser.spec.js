import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRequire } from 'module'
import { join } from 'path'
import fs from 'fs'
import os from 'os'
import { createAgentBrowser, agentUrl, capText, consoleEntry, reservedKey, safeSelector, pruneScreenshots, MAX_IMAGE_B64, CONSOLE_KEEP } from '../agentBrowser'
import { handleRequestLine, validateParams, CLI_PROTOCOL } from '../cliServer'
import { setTeamSecret, verifyRequest, _resetTeamAuth } from '../teamAuth'
import { leaseDebugger, debuggerHolders } from '../pageDebugger'
import { contextMenuQuiet } from '../browserGuest'

// Run inside a Tessel pane, these tests would sign as that pane.
delete process.env.TESSEL_TEAM_SECRET
delete process.env.TESSEL_PANE_ID

const require = createRequire(import.meta.url)
const mcp = require(join(__dirname, '..', 'teamMcp', 'server.cjs'))

const PANE = 'pane-7-agent'
const SECRET = 'a'.repeat(64)
const TOKEN = 'b'.repeat(64)

// A browser page as the main process sees it: its debugger answers from `cdp`.
// `sessions`: the debugger sessions of frames from other sites (session id ->
// its own `cdp`); `guest.cdpEvent` sends the debugger's events.
function fakeGuest(id, { cdp = {}, url = 'http://localhost:5173/', image = null, sessions = {} } = {}) {
  const on = {}
  const sent = []
  const listeners = []
  let current = url
  const guest = {
    id,
    sent,
    isDestroyed: () => false,
    isLoading: () => false,
    getURL: () => current,
    getTitle: () => 'App',
    on: (ev, fn) => (on[ev] = on[ev] || []).push(fn),
    once: (ev, fn) => (on[ev] = on[ev] || []).push(fn),
    removeListener: () => {},
    emit: (ev, ...args) => (on[ev] || []).forEach((fn) => fn(...args)),
    loadURL: vi.fn(async (u) => {
      current = u
    }),
    reload: vi.fn(),
    navigationHistory: { canGoBack: () => false, canGoForward: () => false, goBack: vi.fn(), goForward: vi.fn() },
    capturePage: async () => image,
    executeJavaScriptInIsolatedWorld: vi.fn(async () => true),
    debugger: {
      attached: false,
      isAttached() {
        return this.attached
      },
      attach() {
        this.attached = true
      },
      detach() {
        this.attached = false
      },
      on: (ev, fn) => ev === 'message' && listeners.push(fn),
      once: () => {},
      removeListener: () => {},
      sendCommand: async (method, params, sessionId) => {
        sent.push(sessionId ? [method, params, sessionId] : [method, params])
        const map = sessionId ? sessions[sessionId] : cdp
        if (!map) throw new Error('Session with given id not found.')
        const h = map[method]
        if (typeof h === 'function') return h(params)
        return h || {}
      }
    }
  }
  guest.cdpEvent = (method, params, sessionId) => listeners.forEach((fn) => fn({}, method, params, sessionId))
  return guest
}

// A small page: a heading, a text field, a password field, a button.
const AX = {
  nodes: [
    { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'App' }, childIds: ['2', '3', '4', '5', '6'] },
    { nodeId: '2', role: { value: 'heading' }, name: { value: 'Sign in' } },
    { nodeId: '3', role: { value: 'textbox' }, name: { value: 'Email' }, backendDOMNodeId: 30 },
    { nodeId: '4', role: { value: 'textbox' }, name: { value: 'Password' }, backendDOMNodeId: 40 },
    { nodeId: '5', role: { value: 'button' }, name: { value: 'Go' }, backendDOMNodeId: 50 },
    { nodeId: '6', role: { value: 'button' }, name: { value: 'Go' }, backendDOMNodeId: 60 }
  ]
}
// The page's elements as the isolated world sees them: backend id ->
// { secret (password / dots), closed (closed shadow root) }. DOM.focus moves
// the keyboard; `page.focusOpaque` puts it in a cross-origin frame;
// `page.focusTo` sends it elsewhere (a host delegating focus).
function pageModel() {
  return {
    elements: { 30: { secret: false }, 40: { secret: true }, 50: {}, 60: {} },
    focused: null,
    focusOpaque: false,
    focusTo: {},
    loaderId: 'L1',
    worlds: 0
  }
}
const idOf = (objectId) => Number(String(objectId).slice(1))
const pageCdp = (extra = {}, page = pageModel()) => ({
  'Accessibility.getFullAXTree': AX,
  'Page.getFrameTree': () => ({ frameTree: { frame: { id: 'F', loaderId: page.loaderId } } }),
  'Page.createIsolatedWorld': () => ({ executionContextId: ++page.worlds }),
  'Runtime.evaluate': (p) => {
    const ex = String(p.expression)
    if (ex.includes("querySelectorAll('*')")) return { result: { objectId: 'scan' } }
    if (ex.includes('document.activeElement')) {
      if (page.unfocused && ex.includes('document.hasFocus()')) return { result: { type: 'string', value: 'elsewhere' } }
      if (page.focusOpaque) return { result: { type: 'string', value: 'opaque' } }
      return { result: page.focused == null ? { type: 'object', subtype: 'null' } : { objectId: `n${page.focused}` } }
    }
    return { result: {} }
  },
  'Runtime.getProperties': (p) =>
    p.objectId === 'scan'
      ? {
          result: Object.entries(page.elements)
            .filter(([, e]) => e.type === 'password')
            .map(([id], i) => ({ name: String(i), value: { objectId: `n${id}` } }))
        }
      : { result: [] },
  'Runtime.callFunctionOn': (p) => (String(p.functionDeclaration).includes('webkitTextSecurity') ? { result: { value: !!(page.elements[idOf(p.objectId)] || {}).secret } } : { result: {} }),
  'Page.getNavigationHistory': { currentIndex: 0, entries: [{ id: 1 }] },
  'DOM.describeNode': (p) => {
    const id = p.objectId ? idOf(p.objectId) : p.backendNodeId
    const e = page.elements[id]
    if (!e) throw new Error('No node with given id found')
    return { node: { backendNodeId: id, nodeName: e.tag || 'INPUT', ...(e.frameId ? { frameId: e.frameId } : {}), ...(e.closed ? { shadowRoots: [{ shadowRootType: 'closed' }] } : {}) } }
  },
  'DOM.focus': (p) => {
    page.focused = page.focusTo[p.backendNodeId] || p.backendNodeId
    return {}
  },
  'DOM.getContentQuads': { quads: [[10, 20, 110, 20, 110, 60, 10, 60]] },
  'DOM.resolveNode': (p) => ({ object: { objectId: `n${p.backendNodeId}` } }),
  ...extra
})

function signed(op, args = {}) {
  process.env.TESSEL_PANE_ID = PANE
  process.env.TESSEL_TEAM_SECRET = SECRET
  return mcp.browserRequest(op, args)
}

function setup({ guest = fakeGuest(11, { cdp: pageCdp() }), enabled = true, enabledFn = null, target = {}, onAsk = null, windowState = undefined, nativeImage = null } = {}) {
  const sentToWindow = []
  const ask = vi.fn(async (_m, p) => {
    if (onAsk) {
      const r = await onAsk(p)
      if (r !== undefined) return r
    }
    if (p.op === 'list') return { agent: 'Gauss', pages: [{ page: 'pane-b', url: guest.getURL(), title: 'App', ready: true, current: true }] }
    return { agent: 'Gauss', page: 'pane-b', guestId: guest ? guest.id : null, ...target }
  })
  const ab = createAgentBrowser({
    verify: (body, pane) => verifyRequest(body, pane, 'browser'),
    enabled: enabledFn || (() => enabled),
    ask,
    guestById: (id) => (guest && id === guest.id ? guest : null),
    send: (ch, payload) => sentToWindow.push([ch, payload]),
    ...(windowState ? { windowState } : {}),
    nativeImage,
    screenshotDir: null
  })
  // As the pipe hands it over: checked by cliServer first.
  const call = (op, args) => ab.handle(validateParams('browser', signed(op, args)))
  return { ab, ask, guest, call, sentToWindow }
}

describe('agent browser: who may call', () => {
  beforeEach(() => {
    _resetTeamAuth()
    setTeamSecret(PANE, SECRET)
  })
  afterEach(() => {
    delete process.env.TESSEL_TEAM_SECRET
    delete process.env.TESSEL_PANE_ID
    _resetTeamAuth()
  })

  it('a request signed by the pane passes the pipe and is answered', async () => {
    const { ab } = setup()
    const req = signed('snapshot', {})
    const line = `${CLI_PROTOCOL} ${Buffer.from(JSON.stringify({ token: TOKEN, method: 'browser', params: req })).toString('base64')}`
    const reply = JSON.parse(await handleRequestLine(line, { token: TOKEN, handlers: { browser: (p) => ab.handle(p) } }))
    expect(reply.ok).toBe(true)
    expect(reply.result.text).toContain('[@e1] text input "Email"')
  })

  it('refuses an unsigned request, a forged one, a replay and an unknown pane', async () => {
    const { ab } = setup()
    await expect(ab.handle({ pane: PANE, op: 'snapshot', args: {} })).rejects.toMatchObject({ code: 'unauthorized' })
    const req = signed('snapshot', {})
    await expect(ab.handle({ ...req, args: { page: 'other' } })).rejects.toMatchObject({ code: 'unauthorized' })
    await ab.handle(validateParams('browser', req))
    await expect(ab.handle(validateParams('browser', req))).rejects.toMatchObject({ code: 'unauthorized' })
    const other = signed('snapshot', {})
    await expect(ab.handle({ ...other, pane: 'pane-9-unknown' })).rejects.toMatchObject({ code: 'unknown_pane' })
  })

  it('refuses while "Let agents use the browser" is off', async () => {
    const { call, ask } = setup({ enabled: false })
    await expect(call('snapshot')).rejects.toMatchObject({ code: 'disabled' })
    expect(ask).not.toHaveBeenCalled()
  })

  it('only a page Tessel\'s browser vouches for (guestById), never another webContents', async () => {
    const { call } = setup({ target: { guestId: 999 } })
    await expect(call('snapshot')).rejects.toMatchObject({ code: 'page_not_ready' })
  })

  it('the pipe refuses unknown or nested arguments', () => {
    const req = signed('click', { ref: '@e1' })
    expect(() => validateParams('browser', { ...req, args: { ref: '@e1', evil: 1 } })).toThrow()
    expect(() => validateParams('browser', { ...req, args: { ref: { a: 1 } } })).toThrow()
    expect(() => validateParams('browser', { ...req, pane: '../x' })).toThrow()
    expect(() => validateParams('browser', { ...req, auth: null })).toThrow()
    expect(() => validateParams('browser', { ...req, args: { text: 'x'.repeat(140000) } })).toThrow()
  })

  // fill takes up to 20,000 characters: whatever they are (accents, CJK,
  // quotes, line breaks), such a request goes through the pipe whole.
  it('a fill of 20,000 characters goes through the pipe, whatever the characters', async () => {
    const { ab } = setup()
    await ab.handle(validateParams('browser', signed('snapshot', {})))
    for (const ch of ['é', '日', '"', '\n', '\u0001']) {
      const req = signed('fill', { ref: '@e1', text: ch.repeat(20000) })
      const line = `${CLI_PROTOCOL} ${Buffer.from(JSON.stringify({ token: TOKEN, method: 'browser', params: req })).toString('base64')}`
      const reply = JSON.parse(await handleRequestLine(line, { token: TOKEN, handlers: { browser: (p) => ab.handle(p) } }))
      expect(reply.error && reply.error.code).not.toBe('too_large')
    }
  })

  it('the user\'s Stop revokes the page and hides the badge', async () => {
    const { ab, call, guest, sentToWindow } = setup()
    await call('snapshot')
    expect(sentToWindow).toContainEqual(['browser:agentControl', { webContentsId: guest.id, active: true, agent: 'Gauss' }])
    expect(ab.stop(guest.id)).toBe(true)
    expect(sentToWindow).toContainEqual(['browser:agentControl', { webContentsId: guest.id, active: false, stopped: true }])
    expect(guest.debugger.attached).toBe(false)
    await expect(call('snapshot')).rejects.toMatchObject({ code: 'stopped_by_user' })
    expect(ab.stop(12345)).toBe(false)
  })

  // Live Share watching the page holds its debugger too (pageDebugger.js):
  // the agents letting it go leave it attached, undo what they turned on, and
  // stop answering the page's dialogs.
  it("the page's debugger stays attached for another holder when the agent lets it go", async () => {
    const { call, ab, guest } = setup()
    const other = leaseDebugger(guest, 'live-share')
    await call('snapshot')
    expect(debuggerHolders(guest).sort()).toEqual(['agent', 'live-share'])
    guest.sent.length = 0
    ab.release(guest.id)
    expect(guest.debugger.attached).toBe(true)
    expect(debuggerHolders(guest)).toEqual(['live-share'])
    expect(guest.sent).toContainEqual(['Emulation.setFocusEmulationEnabled', { enabled: false }])
    guest.sent.length = 0
    guest.cdpEvent('Page.javascriptDialogOpening', { type: 'confirm', message: 'Sure?' })
    expect(guest.sent.some(([m]) => m === 'Page.handleJavaScriptDialog')).toBe(false)
    // The agent again, then Live Share leaves: the agent keeps it.
    await call('snapshot')
    other.release()
    expect(guest.debugger.attached).toBe(true)
    guest.cdpEvent('Page.javascriptDialogOpening', { type: 'alert', message: 'Hi' })
    expect(guest.sent).toContainEqual(['Page.handleJavaScriptDialog', { accept: true }])
    ab.release(guest.id)
    expect(guest.debugger.attached).toBe(false)
    expect(debuggerHolders(guest)).toEqual([])
  })

  // The page's view is rebuilt (moved to another workspace, the window
  // reloaded): a new guest under the same page. The user's Stop still holds.
  it("the user's Stop holds for the page when its view is rebuilt under a new guest", async () => {
    const first = fakeGuest(11, { cdp: pageCdp() })
    const second = fakeGuest(12, { cdp: pageCdp() })
    let current = first
    const ask = vi.fn(async () => ({ agent: 'Gauss', page: 'pane-b', guestId: current.id }))
    const ab = createAgentBrowser({ verify: (body, pane) => verifyRequest(body, pane, 'browser'), enabled: () => true, ask, guestById: (id) => [first, second].find((g) => g.id === id) || null, send: () => {} })
    const call = (op, args) => ab.handle(validateParams('browser', signed(op, args)))
    await call('snapshot')
    expect(ab.stop(11)).toBe(true)
    current = second
    await expect(call('snapshot')).rejects.toMatchObject({ code: 'stopped_by_user' })
  })
})

describe('agent browser: commands', () => {
  beforeEach(() => {
    _resetTeamAuth()
    setTeamSecret(PANE, SECRET)
  })
  afterEach(() => {
    delete process.env.TESSEL_TEAM_SECRET
    delete process.env.TESSEL_PANE_ID
    _resetTeamAuth()
  })

  // A command the page never answers (a script call that hangs): the user's
  // Stop ends it at once, and the page's next command is not stuck behind it.
  it("Stop ends a command still waiting on the page; a hung command does not block the next one", async () => {
    const { call, ab, guest } = setup()
    guest.executeJavaScriptInIsolatedWorld = vi.fn(() => new Promise(() => {}))
    const started = Date.now()
    const hung = call('wait', { text: 'never', timeout_ms: 30000 })
    await new Promise((r) => setTimeout(r, 50))
    ab.stop(guest.id)
    await expect(hung).rejects.toMatchObject({ code: 'stopped_by_user' })
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('a hung command times out and the page answers the next command', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const { call, guest } = setup()
      guest.executeJavaScriptInIsolatedWorld = vi.fn(() => new Promise(() => {}))
      const hung = call('wait', { text: 'never', timeout_ms: 1000 })
      const hungResult = hung.catch((e) => e)
      await vi.advanceTimersByTimeAsync(46000)
      expect(await hungResult).toMatchObject({ code: expect.stringMatching(/timeout/) })
      const next = call('console', {})
      await vi.advanceTimersByTimeAsync(10)
      expect((await next).text).toContain('No console messages')
    } finally {
      vi.useRealTimers()
    }
  })

  it('snapshot lists refs; click dispatches a click at the element centre', async () => {
    const { call, guest } = setup()
    const snap = await call('snapshot')
    expect(snap.text).toContain('heading "Sign in"')
    expect(snap.text).toContain('[@e3] button "Go"')
    expect(snap.text).toContain('[@e4] button "Go (2nd)"')
    const r = await call('click', { ref: '@e3' })
    expect(r.text).toContain('Clicked @e3')
    const mouse = guest.sent.filter(([m]) => m === 'Input.dispatchMouseEvent').map(([, p]) => [p.type, p.x, p.y])
    expect(mouse).toEqual([
      ['mouseMoved', 60, 40],
      ['mousePressed', 60, 40],
      ['mouseReleased', 60, 40]
    ])
  })

  // The page's tree has an "Iframe" node without children: the frame's own
  // tree is read (by its frame id: same process) and listed under it.
  it('snapshot lists what a frame of the same site holds; its refs click', async () => {
    const page = pageModel()
    page.elements[70] = { tag: 'IFRAME', frameId: 'F2' }
    page.elements[80] = {}
    const tree = { nodes: [{ ...AX.nodes[0], childIds: [...AX.nodes[0].childIds, '7'] }, ...AX.nodes.slice(1), { nodeId: '7', role: { value: 'Iframe' }, name: { value: 'Checkout' }, backendDOMNodeId: 70, childIds: [] }] }
    const inner = { nodes: [{ nodeId: '1', role: { value: 'RootWebArea' }, childIds: ['2'] }, { nodeId: '2', role: { value: 'button' }, name: { value: 'Pay' }, backendDOMNodeId: 80 }] }
    const { call, guest } = setup({ guest: fakeGuest(11, { cdp: pageCdp({ 'Accessibility.getFullAXTree': (p) => (p && p.frameId === 'F2' ? inner : tree) }, page) }) })
    const snap = await call('snapshot')
    expect(snap.text).toContain('frame "Checkout"\n  [@e5] button "Pay"')
    await call('click', { ref: '@e5' })
    expect(guest.sent.filter(([m]) => m === 'DOM.getContentQuads').map(([, p]) => p.backendNodeId)).toEqual([80])
    expect(guest.sent.filter(([m]) => m === 'Input.dispatchMouseEvent').map(([, p]) => [p.type, p.x, p.y])[1]).toEqual(['mousePressed', 60, 40])
  })

  // A frame from another site lives in another process: the debugger attaches
  // to it (its own session), reads its tree there, clicks at its place in the
  // page (the frame's box + the element's place in the frame) and types into
  // it with the same password rules, the keyboard found inside that frame.
  describe('a frame from another site', () => {
    function crossSite() {
      const page = pageModel()
      page.elements[71] = { tag: 'IFRAME', frameId: 'T1' }
      const frame = pageModel()
      frame.elements = { 5: {}, 6: {}, 7: { secret: true } }
      frame.unfocused = true
      const tree = { nodes: [{ ...AX.nodes[0], childIds: [...AX.nodes[0].childIds, '7'] }, ...AX.nodes.slice(1), { nodeId: '7', role: { value: 'Iframe' }, name: { value: 'Card form' }, backendDOMNodeId: 71, childIds: [] }] }
      const frameTree = {
        nodes: [
          { nodeId: '1', role: { value: 'RootWebArea' }, childIds: ['2', '3', '4'] },
          { nodeId: '2', role: { value: 'button' }, name: { value: 'Pay now' }, backendDOMNodeId: 5 },
          { nodeId: '3', role: { value: 'textbox' }, name: { value: 'Card' }, backendDOMNodeId: 6 },
          { nodeId: '4', role: { value: 'textbox' }, name: { value: 'PIN' }, backendDOMNodeId: 7 }
        ]
      }
      let guest = null
      const cdp = pageCdp(
        {
          'Accessibility.getFullAXTree': tree,
          'Target.setAutoAttach': () => {
            guest.cdpEvent('Target.attachedToTarget', { sessionId: 'S1', targetInfo: { type: 'iframe', targetId: 'T1' } })
            return {}
          },
          'DOM.getBoxModel': (p) => (p.backendNodeId === 71 ? { model: { content: [100, 200, 300, 200, 300, 300, 100, 300] } } : {})
        },
        page
      )
      const frameBase = pageCdp({ 'Accessibility.getFullAXTree': frameTree, 'DOM.getContentQuads': { quads: [[0, 0, 20, 0, 20, 10, 0, 10]] } }, frame)
      const frameCdp = {
        ...frameBase,
        // The keyboard goes into the frame: the page sees only its <iframe>.
        'DOM.focus': (p) => {
          frame.unfocused = false
          page.focusOpaque = true
          return frameBase['DOM.focus'](p)
        }
      }
      guest = fakeGuest(11, { cdp, sessions: { S1: frameCdp } })
      guest.insertText = vi.fn(async () => {})
      return { guest, page, frame }
    }

    it('snapshot lists its controls; click lands on them in the page', async () => {
      const { guest } = crossSite()
      const { call } = setup({ guest })
      const snap = await call('snapshot')
      expect(snap.text).toContain('frame "Card form"\n  [@e5] button "Pay now"\n  [@e6] text input "Card" (empty)\n  [@e7] text input "PIN" (empty)')
      await call('click', { ref: '@e5' })
      expect(guest.sent.filter(([m]) => m === 'DOM.getContentQuads').map(([, p, sid]) => [p.backendNodeId, sid])).toEqual([[5, 'S1']])
      // In the page's own session: the frame's box (100, 200) + the button's centre in the frame (10, 5).
      expect(guest.sent.filter(([m]) => m === 'Input.dispatchMouseEvent').map(([, p, sid]) => [p.type, p.x, p.y, sid])).toEqual([
        ['mouseMoved', 110, 205, undefined],
        ['mousePressed', 110, 205, undefined],
        ['mouseReleased', 110, 205, undefined]
      ])
    })

    it('fill types into its field (never through insertText of the page: it crashes a frame from another site)', async () => {
      const { guest } = crossSite()
      const { call } = setup({ guest })
      await call('snapshot')
      const r = await call('fill', { ref: '@e6', text: '4242' })
      expect(r.text).toContain('Filled @e6')
      expect(guest.sent.filter(([m]) => m === 'DOM.focus')).toEqual([['DOM.focus', { backendNodeId: 6 }, 'S1']])
      expect(guest.sent.filter(([m]) => m === 'Input.insertText')).toEqual([['Input.insertText', { text: '4242' }]])
      expect(guest.insertText).not.toHaveBeenCalled()
      // A key typed while the keyboard is in that field: allowed too.
      expect((await call('press', { key: 'x' })).text).toContain('Pressed x')
    })

    it('its password field is refused, by fill and by a typed key', async () => {
      const { guest, page, frame } = crossSite()
      const { call } = setup({ guest })
      await call('snapshot')
      await expect(call('fill', { ref: '@e7', text: '1234' })).rejects.toMatchObject({ code: 'password_field' })
      // The keyboard put there another way (a click): a typed key is refused.
      page.focusOpaque = true
      frame.unfocused = false
      frame.focused = 7
      await expect(call('press', { key: '1' })).rejects.toMatchObject({ code: 'password_field' })
      // In a frame no session shows (its debugger went away): refused too.
      guest.cdpEvent('Target.detachedFromTarget', { sessionId: 'S1' })
      await expect(call('press', { key: '1' })).rejects.toMatchObject({ code: 'field_not_visible' })
      expect(guest.sent.filter(([m]) => m === 'Input.insertText' || m === 'Input.dispatchKeyEvent')).toEqual([])
    })
  })

  // Two agents on one page: refs are numbered again by each snapshot, so a ref
  // read by one agent must never act on what another agent's snapshot listed.
  it("another agent's snapshot of the same page makes this agent's refs stale", async () => {
    const OTHER = 'pane-8-agent'
    setTeamSecret(OTHER, 'c'.repeat(64))
    const { call, ab } = setup()
    await call('snapshot')
    process.env.TESSEL_PANE_ID = OTHER
    process.env.TESSEL_TEAM_SECRET = 'c'.repeat(64)
    await ab.handle(validateParams('browser', mcp.browserRequest('snapshot', {})))
    await expect(call('click', { ref: '@e3' })).rejects.toMatchObject({ code: 'stale_ref' })
    // Its own new snapshot: its refs work again.
    await call('snapshot')
    expect((await call('click', { ref: '@e3' })).text).toContain('Clicked @e3')
  })

  it('a ref before any snapshot, or an unknown one, says to snapshot', async () => {
    const { call } = setup()
    await expect(call('click', { ref: '@e1' })).rejects.toMatchObject({ code: 'stale_ref' })
    await call('snapshot')
    await expect(call('click', { ref: '@e99' })).rejects.toMatchObject({ code: 'ref_not_found' })
    await expect(call('click', { ref: 'button' })).rejects.toMatchObject({ code: 'invalid_argument' })
  })

  it('refs are stale after the page navigated', async () => {
    let entry = 1
    const guest = fakeGuest(11, { cdp: pageCdp({ 'Page.getNavigationHistory': () => ({ currentIndex: 0, entries: [{ id: entry }] }) }) })
    const { call } = setup({ guest })
    await call('snapshot')
    entry = 2
    await expect(call('click', { ref: '@e1' })).rejects.toMatchObject({ code: 'stale_ref' })
  })

  // The page moves the keyboard after Tessel looked (a focus handler's timer,
  // auto-advance): the text never lands in the password field it moved to.
  it('the keyboard moved to a password field between the check and the text: refused, nothing typed', async () => {
    const page = pageModel()
    const base = pageCdp({}, page)
    const cdp = {
      ...base,
      'Runtime.callFunctionOn': (p) => {
        // Selecting the field's text (fill): the page moves the focus meanwhile.
        if (String(p.functionDeclaration).includes('this.select()')) page.focused = 40
        return base['Runtime.callFunctionOn'](p)
      }
    }
    const { call, guest } = setup({ guest: fakeGuest(11, { cdp }) })
    await call('snapshot')
    await expect(call('fill', { ref: '@e1', text: 'my text' })).rejects.toMatchObject({ code: 'password_field' })
    expect(guest.sent.filter(([m]) => m === 'Input.insertText')).toEqual([])
  })

  // A list (<select>): text typed into it changes nothing (found in a real
  // page: "Filled" was answered and the list kept its option). fill picks the
  // option by its label or value instead; an unknown one names the options.
  it('fill on a list picks the option by its label; an unknown option is refused with the choices', async () => {
    const page = pageModel()
    page.elements[30] = { tag: 'SELECT' }
    const options = [
      { label: 'Red', value: 'r' },
      { label: 'Green', value: 'g' },
      { label: 'Blue', value: 'b' }
    ]
    let selected = 'g'
    const base = pageCdp({}, page)
    const cdp = {
      ...base,
      'Runtime.callFunctionOn': (p) => {
        if (!String(p.functionDeclaration).includes('this.options')) return base['Runtime.callFunctionOn'](p)
        const want = String(p.arguments[0].value).trim().toLowerCase()
        const o = options.find((x) => x.label.toLowerCase() === want) || options.find((x) => x.value === want)
        if (!o) return { result: { value: { ok: false, labels: options.map((x) => x.label) } } }
        selected = o.value
        return { result: { value: { ok: true, label: o.label } } }
      }
    }
    const { call, guest } = setup({ guest: fakeGuest(11, { cdp }) })
    await call('snapshot')
    const r = await call('fill', { ref: '@e1', text: 'Blue' })
    expect(selected).toBe('b')
    expect(r.text).toContain('Blue')
    expect(guest.sent.filter(([m]) => m === 'Input.insertText')).toEqual([])
    await expect(call('fill', { ref: '@e1', text: 'Purple' })).rejects.toMatchObject({ code: 'no_option', message: expect.stringContaining('Red, Green, Blue') })
    expect(selected).toBe('b')
  })

  it('fill types into a text field, never into a password field', async () => {
    const { call, guest } = setup()
    await call('snapshot')
    await call('fill', { ref: '@e1', text: 'me@example.com' })
    expect(guest.sent).toContainEqual(['Input.insertText', { text: 'me@example.com' }])
    await expect(call('fill', { ref: '@e2', text: 'hunter2' })).rejects.toMatchObject({ code: 'password_field' })
    await expect(call('type', { ref: '@e2', text: 'x' })).rejects.toMatchObject({ code: 'password_field' })
    expect(guest.sent.filter(([m, p]) => m === 'Input.insertText' && p.text === 'hunter2')).toEqual([])
  })

  // Re-rendered: the element is found again by role, name and occurrence, or not at all.
  it('a re-rendered page with fewer matches: the 2nd "Go" is stale, never the first one clicked instead', async () => {
    const page = pageModel()
    let tree = AX
    const { call, guest } = setup({ guest: fakeGuest(11, { cdp: pageCdp({ 'Accessibility.getFullAXTree': () => tree }, page) }) })
    await call('snapshot')
    // The list re-rendered with one "Go" left (new node ids).
    delete page.elements[50]
    delete page.elements[60]
    page.elements[70] = {}
    tree = { nodes: [...AX.nodes.slice(0, 4).map((n) => (n.nodeId === '1' ? { ...n, childIds: ['2', '3', '4', '7'] } : n)), { nodeId: '7', role: { value: 'button' }, name: { value: 'Go' }, backendDOMNodeId: 70 }] }
    await expect(call('click', { ref: '@e4' })).rejects.toMatchObject({ code: 'stale_ref' })
    expect(guest.sent.filter(([m]) => m === 'Input.dispatchMouseEvent')).toEqual([])
  })

  // Removed from the page but not yet freed: describeNode still answers.
  it('an element the page removed (detached, not yet freed) is stale, not "hidden"', async () => {
    const page = pageModel()
    let tree = AX
    const base = pageCdp({ 'Accessibility.getFullAXTree': () => tree }, page)
    const cdp = {
      ...base,
      'Runtime.callFunctionOn': (p) => (String(p.functionDeclaration).includes('isConnected') ? { result: { value: !(page.elements[idOf(p.objectId)] || {}).detached } } : base['Runtime.callFunctionOn'](p)),
      'DOM.getContentQuads': (p) => ((page.elements[p.backendNodeId] || {}).detached ? Promise.reject(new Error('Could not compute content quads.')) : { quads: [[10, 20, 110, 20, 110, 60, 10, 60]] }),
      'DOM.getBoxModel': () => Promise.reject(new Error('Could not compute box model.'))
    }
    const { call } = setup({ guest: fakeGuest(11, { cdp }) })
    await call('snapshot')
    // The list re-rendered: the old "Go" nodes detached, none left.
    page.elements[50].detached = true
    page.elements[60].detached = true
    tree = { nodes: AX.nodes.slice(0, 4).map((n) => (n.nodeId === '1' ? { ...n, childIds: ['2', '3', '4'] } : n)) }
    await expect(call('click', { ref: '@e3' })).rejects.toMatchObject({ code: 'stale_ref' })
  })

  it('a re-rendered element still there once is found again', async () => {
    const page = pageModel()
    let tree = AX
    const { call, guest } = setup({ guest: fakeGuest(11, { cdp: pageCdp({ 'Accessibility.getFullAXTree': () => tree }, page) }) })
    await call('snapshot')
    delete page.elements[30]
    page.elements[31] = {}
    tree = { nodes: AX.nodes.map((n) => (n.nodeId === '3' ? { ...n, backendDOMNodeId: 31 } : n)) }
    expect((await call('fill', { ref: '@e1', text: 'a' })).text).toContain('@e1')
    // Each read of the tree (the snapshot, finding the element again) turns
    // the page's accessibility off after it: left on, it slows the page.
    const ax = guest.sent.map(([m]) => m).filter((m) => m.startsWith('Accessibility.'))
    expect(ax).toEqual(['Accessibility.enable', 'Accessibility.getFullAXTree', 'Accessibility.disable', 'Accessibility.getFullAXTree', 'Accessibility.disable'])
  })

  it('fill with an empty text clears the field (the tool keeps an empty "text")', async () => {
    const { call, guest } = setup()
    await call('snapshot')
    expect(mcp.browserRequest('fill', { ref: '@e1', text: '' }).args).toEqual({ ref: '@e1', text: '' })
    const r = await call('fill', { ref: '@e1', text: '' })
    expect(r.text).toContain('@e1')
    expect(guest.sent).toContainEqual(['Input.dispatchKeyEvent', expect.objectContaining({ type: 'keyDown', key: 'Delete' })])
  })

  it('a printable key is refused while a password field has the keyboard; Enter is not', async () => {
    const page = pageModel()
    page.focused = 40
    const { call } = setup({ guest: fakeGuest(11, { cdp: pageCdp({}, page) }) })
    await expect(call('press', { key: 'a' })).rejects.toMatchObject({ code: 'password_field' })
    await expect(call('press', { key: 'Enter' })).resolves.toMatchObject({ text: 'Pressed Enter.' })
    await expect(call('press', { key: 'Hyper+q' })).rejects.toMatchObject({ code: 'invalid_argument' })
    await expect(call('press', { key: 'Control+Shift+w' })).rejects.toMatchObject({ code: 'reserved_key' })
    page.focused = 30
    await expect(call('press', { key: 'a' })).resolves.toMatchObject({ text: 'Pressed a.' })
    page.focused = null
    await expect(call('press', { key: 'a' })).resolves.toBeTruthy()
  })

  // M3: the guard fails closed.
  it('focus Tessel cannot see (a cross-origin frame, a closed shadow root, an error) refuses typing', async () => {
    const page = pageModel()
    page.focusOpaque = true
    const { call, guest } = setup({ guest: fakeGuest(11, { cdp: pageCdp({}, page) }) })
    await expect(call('press', { key: 'x' })).rejects.toMatchObject({ code: 'field_not_visible' })
    await expect(call('press', { key: 'Enter' })).resolves.toBeTruthy()
    await call('snapshot')
    await expect(call('type', { ref: '@e1', text: 'a' })).rejects.toMatchObject({ code: 'field_not_visible' })
    page.focusOpaque = false
    page.elements[30].closed = true
    page.focused = 30
    await expect(call('press', { key: 'x' })).rejects.toMatchObject({ code: 'field_not_visible' })
    const broken = setup({ guest: fakeGuest(12, { cdp: pageCdp({ 'Page.getFrameTree': () => Promise.reject(new Error('gone')) }) }) })
    await expect(broken.call('press', { key: 'x' })).rejects.toMatchObject({ code: 'field_not_visible' })
    expect(guest.sent.filter(([m]) => m === 'Input.insertText')).toEqual([])
  })

  it('a field that hands its focus to an inner password field is refused after focusing', async () => {
    const page = pageModel()
    page.focusTo[30] = 40
    const { call, guest } = setup({ guest: fakeGuest(11, { cdp: pageCdp({}, page) }) })
    await call('snapshot')
    await expect(call('fill', { ref: '@e1', text: 'hunter2' })).rejects.toMatchObject({ code: 'password_field' })
    expect(guest.sent.filter(([m]) => m === 'Input.insertText')).toEqual([])
  })

  it('paste is reserved (Ctrl+V, Meta+V, Shift+Insert)', async () => {
    const { call } = setup()
    for (const key of ['Control+v', 'Control+Shift+V', 'Meta+v', 'Shift+Insert']) await expect(call('press', { key })).rejects.toMatchObject({ code: 'reserved_key' })
  })

  // M4: a "show password" toggle turns the field into text; it stays a secret.
  it('a field seen once as a password stays one for the page', async () => {
    const page = pageModel()
    page.elements[40] = { secret: true, type: 'password' }
    const { call } = setup({ guest: fakeGuest(11, { cdp: pageCdp({}, page) }) })
    await call('snapshot')
    page.elements[40] = { secret: false, type: 'text' }
    await expect(call('fill', { ref: '@e2', text: 'hunter2' })).rejects.toMatchObject({ code: 'password_field' })
    page.focused = 40
    await expect(call('press', { key: 'a' })).rejects.toMatchObject({ code: 'password_field' })
  })

  // L4: one isolated world per document.
  it('the isolated world is made once per document, again after navigation', async () => {
    const page = pageModel()
    const { call } = setup({ guest: fakeGuest(11, { cdp: pageCdp({}, page) }) })
    await call('snapshot')
    await call('snapshot')
    await call('fill', { ref: '@e1', text: 'x' })
    expect(page.worlds).toBe(1)
    page.loaderId = 'L2'
    await call('snapshot')
    expect(page.worlds).toBe(2)
  })

  // M2: a command waiting behind another one when the user presses Stop.
  it('Stop and the setting turned off end waiting commands; nothing re-attaches', async () => {
    let release
    const slow = new Promise((r) => (release = r))
    const page = pageModel()
    let enabled = true
    const guest = fakeGuest(11, { cdp: pageCdp({ 'Accessibility.getFullAXTree': async () => (await slow, AX) }, page) })
    const { ab } = setup({ guest, enabledFn: () => enabled })
    const first = ab.handle(validateParams('browser', signed('snapshot', {})))
    await new Promise((r) => setTimeout(r, 20))
    const second = ab.handle(validateParams('browser', signed('snapshot', {})))
    await new Promise((r) => setTimeout(r, 20))
    ab.stop(guest.id)
    release()
    await first.catch(() => {})
    await expect(second).rejects.toMatchObject({ code: 'stopped_by_user' })
    expect(guest.debugger.attached).toBe(false)

    const g2 = fakeGuest(12, { cdp: pageCdp() })
    const s2 = setup({ guest: g2, enabledFn: () => enabled })
    await s2.call('snapshot')
    expect(g2.debugger.attached).toBe(true)
    enabled = false
    s2.ab.releaseAll()
    expect(g2.debugger.attached).toBe(false)
    expect(s2.sentToWindow).toContainEqual(['browser:agentControl', { webContentsId: 12, active: false }])
  })

  it('navigate only to addresses the browser allows', async () => {
    const { call, guest } = setup()
    for (const bad of ['file:///C:/Windows/win.ini', 'javascript:alert(1)', 'http://user:pw@example.com/', 'chrome://settings', 'data:text/html,hi'])
      await expect(call('navigate', { url: bad })).rejects.toMatchObject({ code: 'url_refused' })
    expect(guest.loadURL).not.toHaveBeenCalled()
    const r = await call('navigate', { url: 'localhost:3000/x' })
    expect(guest.loadURL).toHaveBeenCalledWith('http://localhost:3000/x')
    expect(r.text).toContain('http://localhost:3000/x')
    await expect(call('navigate', { action: 'back' })).rejects.toMatchObject({ code: 'no_history' })
  })

  it('open asks the window for a new page in the agent\'s project', async () => {
    const { call, ask } = setup()
    const r = await call('open', { url: 'https://example.com' })
    expect(ask).toHaveBeenCalledWith('browserTarget', { agent: PANE, op: 'open', url: 'https://example.com/' })
    expect(r.text).toContain('Opened page pane-b')
    await expect(call('open', { url: 'file:///C:/x' })).rejects.toMatchObject({ code: 'url_refused' })
  })

  // A page redirected to a huge address: the answer stays small (the address shortened).
  it('a very long page address is shortened in the answers (open, navigate)', async () => {
    const long = `https://example.com/${'a'.repeat(2 * 1024 * 1024)}`
    const guest = fakeGuest(11, { cdp: pageCdp(), url: long })
    const { call } = setup({ guest })
    const opened = await call('open', { url: 'https://example.com' })
    expect(opened.text.length).toBeLessThan(5000)
    expect(opened.text).toContain('…')
    const moved = await call('navigate', { action: 'reload' })
    expect(moved.text.length).toBeLessThan(5000)
  })

  it('the last page used is the default target next time', async () => {
    const { call, ask } = setup()
    await call('snapshot', { page: 'pane-b' })
    await call('snapshot')
    expect(ask.mock.calls[1][1]).toMatchObject({ op: 'resolve', page: null, last: 'pane-b' })
  })

  it('console keeps the latest messages, capped, filtered by level', async () => {
    const { ab, call, guest } = setup()
    ab.watchGuest(guest)
    for (let i = 0; i < CONSOLE_KEEP + 20; i++) guest.emit('console-message', { level: i % 2 ? 'error' : 'info', message: `m${i} ${'x'.repeat(100)}`, lineNumber: 3, sourceId: 'http://localhost/app.js' })
    const all = await call('console', { limit: 1000 })
    expect(all.text.split('\n')).toHaveLength(CONSOLE_KEEP)
    expect(all.text).not.toContain('m0 ')
    guest.emit('console-message', { level: 'error', message: 'y'.repeat(5000), lineNumber: 1, sourceId: '' })
    const errors = await call('console', { level: 'error', limit: 2 })
    expect(errors.text.split('\n')).toHaveLength(2)
    expect(errors.text.split('\n')[1].length).toBeLessThan(600)
    // The whole answer is capped too.
    for (let i = 0; i < CONSOLE_KEEP; i++) guest.emit('console-message', { level: 'info', message: 'z'.repeat(1000) })
    expect((await call('console', { limit: 1000 })).text).toContain('cut at')
  })

  it('wait: one of text, selector or url, within its time', async () => {
    const { call, guest } = setup()
    await expect(call('wait', { text: 'Welcome' })).resolves.toMatchObject({ text: expect.stringContaining('Found the text') })
    await expect(call('wait', { url: 'localhost:5173' })).resolves.toBeTruthy()
    await expect(call('wait', {})).rejects.toMatchObject({ code: 'invalid_argument' })
    await expect(call('wait', { text: 'a', selector: 'b' })).rejects.toMatchObject({ code: 'invalid_argument' })
    guest.executeJavaScriptInIsolatedWorld.mockResolvedValue(false)
    await expect(call('wait', { selector: '#never', timeout_ms: 300 })).rejects.toMatchObject({ code: 'wait_timeout' })
  })

  it('wait: the user\'s Stop or the setting turned off ends a wait still polling the page', async () => {
    let on = true
    const { ab, call, guest } = setup({ enabledFn: () => on })
    guest.executeJavaScriptInIsolatedWorld.mockResolvedValue(false)
    const stopped = call('wait', { text: 'Welcome', timeout_ms: 5000 })
    await new Promise((r) => setTimeout(r, 50))
    ab.stop(guest.id)
    guest.executeJavaScriptInIsolatedWorld.mockResolvedValue(true)
    await expect(stopped).rejects.toMatchObject({ code: 'stopped_by_user' })

    const other = setup({ guest: fakeGuest(12, { cdp: pageCdp() }), enabledFn: () => on })
    other.guest.executeJavaScriptInIsolatedWorld.mockResolvedValue(false)
    const turnedOff = other.call('wait', { url: 'never-there', timeout_ms: 5000 })
    await new Promise((r) => setTimeout(r, 50))
    on = false
    await expect(turnedOff).rejects.toMatchObject({ code: 'disabled' })
  })

  // H1: a selector could read a field's value one character at a time.
  it('wait takes plain selectors only: no attributes, no pseudo-classes', async () => {
    const { call, guest } = setup()
    for (const sel of ['input[type=password][value^="a"]', '#pw:autofill', 'input:placeholder-shown', 'input:invalid', '[data-x]', String.raw`a\:b`, '#x:has(input)'])
      await expect(call('wait', { selector: sel })).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(guest.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled()
    await expect(call('wait', { selector: 'main > form .row, #submit ~ button + *' })).resolves.toBeTruthy()
  })

  it('a screenshot too large to show is scaled down or given as a file only', async () => {
    const big = 'A'.repeat(MAX_IMAGE_B64 + 10)
    const img = {
      isEmpty: () => false,
      getSize: () => ({ width: 2000, height: 1000 }),
      toPNG: () => Buffer.from(big, 'base64'),
      resize: () => img,
      toJPEG: () => Buffer.from(big, 'base64')
    }
    const guest = fakeGuest(11, { cdp: pageCdp(), image: img })
    const { call } = setup({ guest })
    const r = await call('screenshot')
    expect(r.image).toBeUndefined()
    expect(r.text).toContain('too large')
    const small = { ...img, toPNG: () => Buffer.from('iVBORw0KGgo=', 'base64') }
    const r2 = await setup({ guest: fakeGuest(11, { cdp: pageCdp(), image: small }) }).call('screenshot')
    expect(r2.image.mimeType).toBe('image/png')
  })
})

describe('agent browser: helpers', () => {
  it('agentUrl allows http(s) and local dev addresses only', () => {
    expect(agentUrl('https://example.com')).toBe('https://example.com/')
    expect(agentUrl('localhost:5173')).toBe('http://localhost:5173/')
    expect(() => agentUrl('react hooks')).toThrow()
    expect(() => agentUrl('file:///etc/passwd')).toThrow()
    expect(() => agentUrl('')).toThrow()
    expect(() => agentUrl(`https://x.com/${'a'.repeat(5000)}`)).toThrow()
  })

  it('Tessel and browser shortcuts are reserved keys', () => {
    for (const k of ['Control+Shift+w', 'Control+r', 'F12', 'F5', 'Control+l', 'Alt+ArrowLeft', 'F1', 'Control+Shift+p']) expect(reservedKey(k)).toBe(true)
    for (const k of ['Enter', 'a', 'Control+a', 'Tab', 'Shift+Tab', 'ArrowDown']) expect(reservedKey(k)).toBe(false)
    // The window's own keys (its default menu: close, minimize, full screen, quit).
    for (const k of ['Control+w', 'Control+m', 'F11', 'Control+q', 'Alt+F4', 'Meta+w']) expect(reservedKey(k)).toBe(true)
  })

  it('safeSelector: tags, #id, .class, *, combinators and commas', () => {
    expect(safeSelector('div.card > #title, ul li + li ~ *')).toBe('div.card > #title, ul li + li ~ *')
    for (const bad of ['', 'a[href]', 'input:checked', 'a::before', 'x'.repeat(600), String.raw`a\61`]) expect(safeSelector(bad)).toBe(null)
  })

  // L2: agent screenshots do not pile up.
  it('only the newest agent screenshots are kept', () => {
    const dir = fs.mkdtempSync(join(os.tmpdir(), 'agent-shots-'))
    try {
      for (let i = 1; i <= 25; i++) fs.writeFileSync(join(dir, `browser-${1000 + i}-abcdef.png`), 'x')
      fs.writeFileSync(join(dir, 'other.txt'), 'keep')
      pruneScreenshots(dir, 20)
      const left = fs.readdirSync(dir).sort()
      expect(left).toHaveLength(21)
      expect(left).toContain('other.txt')
      expect(left).not.toContain('browser-1005-abcdef.png')
      expect(left).toContain('browser-1006-abcdef.png')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  // L3: until the window reports the setting, agents are refused.
  it('main starts with the setting off until the window reports it, and lets pages go when it turns off', () => {
    const src = fs.readFileSync(join(__dirname, '..', 'index.js'), 'utf8')
    expect(src).toMatch(/let agentBrowserEnabled = false/)
    expect(src).toMatch(/agentBrowserEnabled = !!\(opts && opts\.enabled === true\)/)
    // Off, or the agents' session changed: every driven page let go first.
    expect(src).toMatch(/if \(!agentBrowserEnabled \|\| separate !== agentBrowserSeparate\) agentBrowser\.releaseAll\(\)\s+agentBrowserSeparate = separate/)
    expect(src).toMatch(/let agentBrowserSeparate = false/)
    expect(src).toMatch(/agentSessionOnly: \(\) => agentBrowserSeparate/)
    expect(src).toMatch(/screenshotDir: join\(PASTE_DIR, 'agent-browser'\)/)
  })

  // M5: the shared cookie jar is said plainly.
  it('the setting says agents use the sites you are signed into (EN and FR)', () => {
    const vue = fs.readFileSync(join(__dirname, '..', '..', 'renderer', 'src', 'components', 'settings', 'SettingsAgents.vue'), 'utf8')
    expect(vue).toContain("All pages share the browser\\'s cookies: agents can use the sites you are signed into in Tessel\\'s browser.")
    const fr = JSON.parse(fs.readFileSync(join(__dirname, '..', '..', 'renderer', 'src', 'i18n', 'locales', 'fr', 'settings.json'), 'utf8'))
    expect(fr.settings.agents.browserHint).toMatch(/cookies du navigateur : les agents peuvent utiliser les sites auxquels vous êtes connecté/)
  })

  it('capText cuts long answers and says so', () => {
    expect(capText('abc', 10)).toBe('abc')
    const cut = capText('x'.repeat(50), 10)
    expect(cut.startsWith('x'.repeat(10))).toBe(true)
    expect(cut).toContain('cut at 10')
  })

  it('consoleEntry reads both Electron console-message signatures', () => {
    expect(consoleEntry([{ level: 'warning', message: 'w', lineNumber: 2, sourceId: 's' }])).toMatchObject({ level: 'warning', text: 'w', line: 2, source: 's' })
    expect(consoleEntry([{}, 3, 'boom', 7, 'a.js'])).toMatchObject({ level: 'error', text: 'boom', line: 7, source: 'a.js' })
  })
})

describe('browser tools in the MCP server', () => {
  afterEach(() => {
    delete process.env.TESSEL_TEAM_SECRET
    delete process.env.TESSEL_PANE_ID
  })

  it('refuses without the pane identity Tessel gives', async () => {
    const r = await mcp.browserTool('snapshot', {}, { runtimes: () => [], call: vi.fn() })
    expect(r.isError).toBe(true)
  })

  it('tries the next Tessel when one does not know the pane; passes images on', async () => {
    process.env.TESSEL_PANE_ID = PANE
    process.env.TESSEL_TEAM_SECRET = SECRET
    const call = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: { code: 'unknown_pane', message: 'no' } })
      .mockResolvedValueOnce({ ok: true, result: { text: 'shot', image: { data: 'AAAA', mimeType: 'image/png' } } })
    const r = await mcp.browserTool('screenshot', { page: 'p1', me: 'x' }, { runtimes: () => [{ pipe: 'a' }, { pipe: 'b' }], call })
    expect(r).toEqual({ text: 'shot', image: { data: 'AAAA', mimeType: 'image/png' } })
    const params = call.mock.calls[1][2]
    expect(params.args).toEqual({ page: 'p1' })
    // Each try is signed anew (a nonce is used once).
    expect(call.mock.calls[0][2].auth.nonce).not.toBe(params.auth.nonce)
  })

  it('stops at a real refusal and reports its code', async () => {
    process.env.TESSEL_PANE_ID = PANE
    process.env.TESSEL_TEAM_SECRET = SECRET
    const call = vi.fn().mockResolvedValue({ ok: false, error: { code: 'disabled', message: 'Off.' } })
    const r = await mcp.browserTool('snapshot', {}, { runtimes: () => [{ pipe: 'a' }, { pipe: 'b' }], call })
    expect(r).toEqual({ text: 'Off. [disabled]', isError: true })
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('on an SSH host, an address on localhost says the browser is on the PC (once, with the result)', async () => {
    process.env.TESSEL_PANE_ID = PANE
    process.env.TESSEL_TEAM_SECRET = SECRET
    process.env.TESSEL_REMOTE = '1'
    process.env.TESSEL_REMOTE_HOST = 'dev.example'
    try {
      const call = vi.fn().mockResolvedValue({ ok: true, result: { text: 'Opened.' } })
      const deps = { runtimes: () => [{ pipe: 'a' }], call }
      const r = await mcp.browserTool('open', { url: 'localhost:3000' }, deps)
      expect(r.text).toMatch(/^Opened\.\nNote: this browser runs on the user's PC, not on dev\.example/)
      const echoed = (await mcp.browserTool('open', { url: 'localhost:3000/"\u0001x\ny' }, deps)).text
      expect(echoed).toContain('"localhost:3000/  x y" is')
      expect((await mcp.browserTool('open', { url: 'https://example.com' }, deps)).text).toBe('Opened.')
      expect((await mcp.browserTool('snapshot', {}, deps)).text).toBe('Opened.')
      delete process.env.TESSEL_REMOTE
      expect((await mcp.browserTool('open', { url: 'localhost:3000' }, deps)).text).toBe('Opened.')
    } finally {
      delete process.env.TESSEL_REMOTE
      delete process.env.TESSEL_REMOTE_HOST
    }
  })

  it('lists the browser tools with descriptions', () => {
    const names = mcp.BROWSER_TOOLS.map((t) => t.name)
    expect(names).toEqual([
      'browser_pages',
      'browser_open',
      'browser_navigate',
      'browser_snapshot',
      'browser_click',
      'browser_mouse',
      'browser_fill',
      'browser_type',
      'browser_press',
      'browser_scroll',
      'browser_screenshot',
      'browser_console',
      'browser_wait'
    ])
    for (const name of names) expect(mcp.TOOLS.some((t) => t.name === name)).toBe(true)
  })
})

describe('agent browser: pages out of sight, canvas and games', () => {
  beforeEach(() => {
    _resetTeamAuth()
    setTeamSecret(PANE, SECRET)
  })
  afterEach(() => {
    vi.useRealTimers()
    delete process.env.TESSEL_TEAM_SECRET
    delete process.env.TESSEL_PANE_ID
    _resetTeamAuth()
  })

  // A picture as Electron's NativeImage gives it (device pixels).
  const picture = (width, height) => {
    const img = {
      isEmpty: () => false,
      getSize: () => ({ width, height }),
      toPNG: () => Buffer.from('iVBORw0KGgo=', 'base64'),
      toJPEG: () => Buffer.from('x'),
      resize: vi.fn(({ width: w, height: h }) => picture(w, h))
    }
    return img
  }
  // The page's viewport, as Tessel's isolated world reads it: 640x480 CSS
  // pixels at devicePixelRatio 2, scrolled down 340.
  const viewportCdp = (extra = {}, page = pageModel()) => {
    const base = pageCdp(extra, page)
    return { ...base, 'Runtime.evaluate': (p) => (String(p.expression).startsWith('[innerWidth') ? { result: { value: [640, 480, 2, 0, 340] } } : base['Runtime.evaluate'](p)) }
  }
  const mouseEvents = (guest) => guest.sent.filter(([m]) => m === 'Input.dispatchMouseEvent').map(([, e]) => e)

  it('a page on screen is captured at once, one image pixel per CSS pixel, with its coordinate system said', async () => {
    const shot = picture(1280, 960)
    const guest = fakeGuest(11, { cdp: viewportCdp(), image: shot })
    const { call, ask } = setup({ guest })
    const r = await call('screenshot')
    expect(ask.mock.calls.some(([, p]) => p.op === 'paint')).toBe(false)
    expect(shot.resize).toHaveBeenCalledWith({ width: 640, height: 480, quality: 'best' })
    expect(r.text).toContain("640x480 pixels = the page's viewport in CSS pixels (devicePixelRatio 2, scrolled to 0,340)")
    expect(r.text).toContain('browser_click / browser_mouse {x, y}')
    expect(r.image.mimeType).toBe('image/png')
  })

  it('out of sight: the window draws it unseen for the capture, then puts it back', async () => {
    let painted = false
    const guest = fakeGuest(11, { cdp: viewportCdp() })
    // Not drawn: Electron rejects (UnknownVizError); drawn: a picture.
    guest.capturePage = vi.fn(async () => {
      if (!painted) throw new Error('UnknownVizError')
      return picture(1280, 960)
    })
    const paints = []
    const { call } = setup({
      guest,
      onAsk: (p) => {
        if (p.op !== 'paint') return undefined
        paints.push([p.page, p.on, p.agent, p.token])
        painted = p.on
        return { agent: 'Gauss', page: p.page, moved: true, why: 'layer', project: 'Game' }
      }
    })
    const r = await call('screenshot')
    expect(r.image).toBeTruthy()
    expect(paints.map((x) => x.slice(0, 3))).toEqual([
      ['pane-b', true, PANE],
      ['pane-b', false, PANE]
    ])
    // The same capture's name both times (the window ends that capture only).
    expect(paints[0][3]).toMatch(/^[\w-]{6,}$/)
    expect(paints[1][3]).toBe(paints[0][3])
    expect(guest.capturePage.mock.calls.length).toBe(2)
  })

  it('the end of a capture is always asked for, even when the window refused or lost the start', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const guest = fakeGuest(11, { cdp: viewportCdp({ 'Page.captureScreenshot': {} }) })
    guest.capturePage = vi.fn(async () => null)
    const paints = []
    const { call } = setup({
      guest,
      onAsk: (p) => {
        if (p.op !== 'paint') return undefined
        paints.push([p.on, p.token])
        if (p.on) throw new Error('The window did not answer in time.')
        return { page: p.page, moved: true }
      }
    })
    const out = call('screenshot').catch((e) => e)
    await vi.advanceTimersByTimeAsync(30000)
    const err = await out
    expect(err.code).toBe('capture_failed')
    expect(err.message).toContain('did not draw it for the capture (The window did not answer in time.)')
    expect(paints.map(([on]) => on)).toEqual([true, false])
    expect(paints[1][1]).toBe(paints[0][1])
  })

  it('the viewport is read in Tessel\'s isolated world only, and a screenshot is only ever made smaller', async () => {
    // No isolated world: no viewport (never the page's own numbers).
    const noWorld = fakeGuest(11, { cdp: viewportCdp({ 'Page.createIsolatedWorld': () => Promise.reject(new Error('no frame')) }) })
    const one = setup({ guest: noWorld })
    await expect(one.call('click', { x: 10, y: 10 })).rejects.toMatchObject({ code: 'page_error' })
    // A page zoomed out (devicePixelRatio 0.8): not enlarged; the scale is said.
    const shot = picture(512, 384)
    const base = viewportCdp()
    const zoomedOut = fakeGuest(12, { cdp: { ...base, 'Runtime.evaluate': (p) => (String(p.expression).startsWith('[innerWidth') ? { result: { value: [640, 480, 0.8, 0, 0] } } : base['Runtime.evaluate'](p)) }, image: shot })
    const r = await setup({ guest: zoomedOut }).call('screenshot')
    expect(shot.resize).not.toHaveBeenCalled()
    expect(r.text).toContain('at 0.8 image pixels per CSS pixel')
    expect(r.text).toContain('divide a point read on it by 0.8')
  })

  it('no picture at all: the debugger is tried too, and the answer says where the page is (no guess about minimizing)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const guest = fakeGuest(11, { cdp: viewportCdp({ 'Page.captureScreenshot': {} }) })
    guest.capturePage = vi.fn(async () => null)
    const onAsk = (p) => (p.op === 'paint' ? { agent: 'Gauss', page: p.page, moved: p.on, why: 'layer', project: 'Game' } : undefined)
    const { call } = setup({ guest, onAsk, windowState: () => ({ minimized: false, visible: true }) })
    const out = call('screenshot').catch((e) => e)
    await vi.advanceTimersByTimeAsync(30000)
    const err = await out
    expect(err.code).toBe('capture_failed')
    expect(err.message).toContain('The page is out of sight (its project "Game" or its tab is not the one shown)')
    expect(err.message).not.toMatch(/minimized/)
    expect(guest.sent.some(([m]) => m === 'Page.captureScreenshot')).toBe(true)
    // The window minimized: said, with what the user can do.
    const g2 = fakeGuest(12, { cdp: viewportCdp({ 'Page.captureScreenshot': {} }) })
    g2.capturePage = vi.fn(async () => null)
    const min = setup({ guest: g2, onAsk, windowState: () => ({ minimized: true, visible: false }) })
    const out2 = min.call('screenshot').catch((e) => e)
    await vi.advanceTimersByTimeAsync(30000)
    const err2 = await out2
    expect(err2.message).toContain("Tessel's window is minimized")
    expect(err2.message).toContain("Restore Tessel's window")
  })

  it('click by x/y: at that point of the viewport; a point outside or not a number is refused', async () => {
    const guest = fakeGuest(11, { cdp: viewportCdp() })
    const { call } = setup({ guest })
    const r = await call('click', { x: 170, y: 120 })
    expect(r.text).toContain('Clicked at (170, 120)')
    expect(mouseEvents(guest).map((e) => [e.type, e.x, e.y, e.button || null])).toEqual([
      ['mouseMoved', 170, 120, null],
      ['mousePressed', 170, 120, 'left'],
      ['mouseReleased', 170, 120, 'left']
    ])
    await expect(call('click', { x: 5000, y: 10 })).rejects.toMatchObject({ code: 'out_of_viewport' })
    await expect(call('click', { x: 'left', y: 10 })).rejects.toMatchObject({ code: 'invalid_argument' })
    await expect(call('click', {})).rejects.toMatchObject({ code: 'invalid_argument' })
    // A pixel past the edge (a scaled screenshot rounds): the edge.
    await call('click', { x: 641, y: 479.6 })
    expect(mouseEvents(guest).pop()).toMatchObject({ type: 'mouseReleased', x: 639, y: 479 })
  })

  it('click by ref and x/y: that point inside the element; double and middle clicks', async () => {
    const guest = fakeGuest(11, { cdp: viewportCdp() })
    const { call } = setup({ guest })
    await call('snapshot')
    // @e1's box: (10, 20), 100x40 (DOM.getContentQuads of pageCdp).
    const r = await call('click', { ref: '@e1', x: 5, y: 6, double: true, button: 'middle' })
    expect(r.text).toContain('at (15, 26) with the middle button')
    const presses = mouseEvents(guest).filter((e) => e.type === 'mousePressed')
    expect(presses.map((e) => [e.x, e.y, e.button, e.buttons, e.clickCount])).toEqual([
      [15, 26, 'middle', 4, 1],
      [15, 26, 'middle', 4, 2]
    ])
    await expect(call('click', { ref: '@e1', x: 500, y: 6 })).rejects.toMatchObject({ code: 'out_of_element' })
  })

  it("a right-click goes to the page: Tessel's own page menu stays closed for it", async () => {
    const guest = fakeGuest(31, { cdp: viewportCdp() })
    const { call } = setup({ guest })
    expect(contextMenuQuiet(31, { x: 100, y: 100 })).toBe(false)
    await call('click', { x: 100, y: 100, button: 'right' })
    // Not for a menu somewhere else (the user's own right-click), once for the agent's point.
    expect(contextMenuQuiet(31, { x: 300, y: 20 })).toBe(false)
    expect(contextMenuQuiet(31, { x: 101, y: 99 })).toBe(true)
    expect(contextMenuQuiet(31, { x: 100, y: 100 })).toBe(false)
    // The page zoomed in: the menu's point is in zoomed pixels.
    await call('click', { x: 100, y: 100, button: 'right' })
    expect(contextMenuQuiet(31, { x: 150, y: 150 }, 1.5)).toBe(true)
    expect(mouseEvents(guest).find((e) => e.type === 'mousePressed')).toMatchObject({ button: 'right', buttons: 2 })
  })

  it('Stop during a held key: the key goes up and nothing more is pressed', async () => {
    const guest = fakeGuest(11, { cdp: viewportCdp() })
    const events = []
    guest.sendInputEvent = vi.fn((ev) => events.push(`${ev.type}:${ev.keyCode}`))
    const { call, ab } = setup({ guest })
    const pressing = call('press', { key: 'ArrowRight', hold_ms: 5000, repeat: 3 }).catch((e) => e)
    await new Promise((r) => setTimeout(r, 150))
    expect(events).toEqual(['keyDown:Right'])
    ab.stop(11)
    const err = await pressing
    expect(err.code).toBe('stopped_by_user')
    await new Promise((r) => setTimeout(r, 120))
    expect(events).toEqual(['keyDown:Right', 'keyUp:Right'])
  })

  it('a button still held when the agent lets go (or the user stops it) is released first', async () => {
    const guest = fakeGuest(11, { cdp: viewportCdp() })
    const { call, ab } = setup({ guest })
    await call('mouse', { action: 'down', x: 30, y: 40 })
    ab.release(11)
    await new Promise((r) => setTimeout(r, 10))
    expect(mouseEvents(guest).at(-1)).toMatchObject({ type: 'mouseReleased', x: 30, y: 40, button: 'left', buttons: 0 })
  })

  it('a drag the page starts stays in the page (intercepted, played as drag events, dropped at the end)', async () => {
    const guest = fakeGuest(11, { cdp: viewportCdp() })
    const { call } = setup({ guest })
    await call('snapshot')
    expect(guest.sent).toContainEqual(['Input.setInterceptDrags', { enabled: true }])
    // The page starts a drag at the first move with the button held.
    const base = guest.debugger.sendCommand
    let started = false
    guest.debugger.sendCommand = async (method, params, sessionId) => {
      const r = await base.call(guest.debugger, method, params, sessionId)
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseMoved' && params.buttons && !started) {
        started = true
        guest.cdpEvent('Input.dragIntercepted', { data: { items: [{ mimeType: 'text/plain', data: 'card' }], dragOperationsMask: 1 } })
      }
      return r
    }
    const r = await call('mouse', { action: 'drag', x: 20, y: 20, to_x: 220, to_y: 120, steps: 3 })
    expect(r.text).toContain('the page took it as a drag and drop')
    const seq = guest.sent.filter(([m]) => m === 'Input.dispatchDragEvent' || m === 'Input.dispatchMouseEvent').map(([m, p]) => `${m === 'Input.dispatchDragEvent' ? 'drag' : 'mouse'}:${p.type}:${p.x},${p.y}`)
    expect(seq).toContain('drag:dragEnter:87,53')
    expect(seq.indexOf('drag:dragEnter:87,53')).toBe(seq.indexOf('mouse:mouseMoved:87,53') + 1)
    expect(seq.at(-2)).toBe('drag:drop:220,120')
    expect(seq.at(-1)).toBe('mouse:mouseReleased:220,120')
    expect(seq.filter((x) => x.startsWith('drag:')).map((x) => x.split(':')[1])).toEqual(['dragEnter', 'dragOver', 'dragOver', 'dragOver', 'drop'])
  })

  it('browser_mouse drag: pointer to the start, press, moves with the button held, release at the end', async () => {
    const guest = fakeGuest(11, { cdp: viewportCdp() })
    const { call } = setup({ guest })
    const r = await call('mouse', { action: 'drag', x: 40, y: 40, to_x: 200, to_y: 150, steps: 4 })
    expect(r.text).toBe('Dragged from (40, 40) to (200, 150) in 4 steps.')
    expect(mouseEvents(guest).map((e) => `${e.type}:${e.x},${e.y}:${e.buttons}`)).toEqual([
      'mouseMoved:40,40:0',
      'mousePressed:40,40:1',
      'mouseMoved:80,68:1',
      'mouseMoved:120,95:1',
      'mouseMoved:160,123:1',
      'mouseMoved:200,150:1',
      'mouseReleased:200,150:0'
    ])
    await expect(call('mouse', { action: 'drag', x: 40, y: 40, to_x: 900, to_y: 150 })).rejects.toMatchObject({ code: 'out_of_viewport' })
    await expect(call('mouse', { action: 'hover', x: 1, y: 1 })).rejects.toMatchObject({ code: 'invalid_argument' })
  })

  it('browser_mouse down / move / up: the button stays held between commands', async () => {
    const guest = fakeGuest(11, { cdp: viewportCdp() })
    const { call } = setup({ guest })
    await call('mouse', { action: 'down', x: 10, y: 10 })
    await call('mouse', { action: 'move', x: 60, y: 30 })
    expect((await call('mouse', { action: 'up' })).text).toBe('Released the left button at (60, 30).')
    expect(mouseEvents(guest).map((e) => `${e.type}:${e.x},${e.y}:${e.button}:${e.buttons}`)).toEqual([
      'mouseMoved:10,10:none:0',
      'mousePressed:10,10:left:1',
      'mouseMoved:60,30:left:1',
      'mouseReleased:60,30:left:0'
    ])
  })

  it('browser_press: hold_ms and repeat checked', async () => {
    const guest = fakeGuest(11, { cdp: viewportCdp() })
    const { call } = setup({ guest })
    expect((await call('press', { key: 'ArrowUp', repeat: 2 })).text).toBe('Pressed ArrowUp 2 times.')
    expect((await call('press', { key: 'ArrowUp', hold_ms: 20 })).text).toBe('Pressed ArrowUp held 20 ms.')
    await expect(call('press', { key: 'ArrowUp', hold_ms: 20000 })).rejects.toMatchObject({ code: 'invalid_argument' })
    await expect(call('press', { key: 'ArrowUp', repeat: 0 })).rejects.toMatchObject({ code: 'invalid_argument' })
  })

  it('a page an agent drives runs as if on screen (background throttling off); its own setting comes back at release', async () => {
    const guest = fakeGuest(11, { cdp: viewportCdp() })
    guest.getBackgroundThrottling = () => true
    guest.setBackgroundThrottling = vi.fn()
    const { call, ab } = setup({ guest })
    await call('snapshot')
    await call('snapshot')
    expect(guest.setBackgroundThrottling.mock.calls).toEqual([[false], [false]])
    ab.release(11)
    expect(guest.setBackgroundThrottling.mock.calls.at(-1)).toEqual([true])
    // A page that did not throttle is left so.
    const g2 = fakeGuest(12, { cdp: viewportCdp() })
    g2.getBackgroundThrottling = () => false
    g2.setBackgroundThrottling = vi.fn()
    const two = setup({ guest: g2 })
    await two.call('snapshot')
    two.ab.release(12)
    expect(g2.setBackgroundThrottling.mock.calls).toEqual([[false]])
  })

  it('the pipe takes the new arguments (x, y, to_x, to_y, steps, button, hold_ms, repeat)', () => {
    expect(validateParams('browser', signed('mouse', { action: 'drag', x: 1, y: 2, to_x: 3, to_y: 4, steps: 5, button: 'left' })).args).toMatchObject({ x: 1, to_y: 4 })
    expect(validateParams('browser', signed('press', { key: 'a', hold_ms: 100, repeat: 3 })).args).toMatchObject({ hold_ms: 100, repeat: 3 })
  })
})

describe('the tools server reading stdin', () => {
  it('refuses a line over 4 MB that never ends, and exits', async () => {
    const { spawn } = await import('child_process')
    const child = spawn(process.execPath, [join(__dirname, '..', 'teamMcp', 'server.cjs')], { stdio: ['pipe', 'pipe', 'ignore'] })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    const done = new Promise((r) => child.on('exit', r))
    child.stdin.on('error', () => {})
    child.stdin.write('x'.repeat(5 * 1024 * 1024))
    expect(await done).toBe(1)
    expect(out).toMatch(/too large/)
  })
})
