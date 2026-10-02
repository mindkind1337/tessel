import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRequire } from 'module'
import { join } from 'path'
import { createAgentBrowser, agentUrl, capText, consoleEntry, reservedKey, MAX_IMAGE_B64, CONSOLE_KEEP } from '../agentBrowser'
import { handleRequestLine, validateParams, CLI_PROTOCOL } from '../cliServer'
import { setTeamSecret, verifyRequest, _resetTeamAuth } from '../teamAuth'

// Run inside a Tessel pane, these tests would sign as that pane.
delete process.env.TESSEL_TEAM_SECRET
delete process.env.TESSEL_PANE_ID

const require = createRequire(import.meta.url)
const mcp = require(join(__dirname, '..', 'teamMcp', 'server.cjs'))

const PANE = 'pane-7-agent'
const SECRET = 'a'.repeat(64)
const TOKEN = 'b'.repeat(64)

// A browser page as the main process sees it: its debugger answers from `cdp`.
function fakeGuest(id, { cdp = {}, url = 'http://localhost:5173/', image = null } = {}) {
  const on = {}
  const sent = []
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
      on: () => {},
      once: () => {},
      removeListener: () => {},
      sendCommand: async (method, params) => {
        sent.push([method, params])
        const h = cdp[method]
        if (typeof h === 'function') return h(params)
        return h || {}
      }
    }
  }
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
const pageCdp = (extra = {}) => ({
  'Accessibility.getFullAXTree': AX,
  'Page.getFrameTree': { frameTree: { frame: { id: 'F' } } },
  'Page.createIsolatedWorld': { executionContextId: 9 },
  'Runtime.evaluate': { result: {} },
  'Page.getNavigationHistory': { currentIndex: 0, entries: [{ id: 1 }] },
  'DOM.describeNode': (p) => ({ node: p.backendNodeId === 40 ? { nodeName: 'INPUT', attributes: ['type', 'password'] } : { nodeName: 'INPUT', attributes: ['type', 'email'], backendNodeId: p.backendNodeId } }),
  'DOM.getContentQuads': { quads: [[10, 20, 110, 20, 110, 60, 10, 60]] },
  'DOM.resolveNode': { object: { objectId: 'o1' } },
  ...extra
})

function signed(op, args = {}) {
  process.env.TESSEL_PANE_ID = PANE
  process.env.TESSEL_TEAM_SECRET = SECRET
  return mcp.browserRequest(op, args)
}

function setup({ guest = fakeGuest(11, { cdp: pageCdp() }), enabled = true, target = {} } = {}) {
  const sentToWindow = []
  const ask = vi.fn(async (_m, p) => {
    if (p.op === 'list') return { agent: 'Gauss', pages: [{ page: 'pane-b', url: guest.getURL(), title: 'App', ready: true, current: true }] }
    return { agent: 'Gauss', page: 'pane-b', guestId: guest ? guest.id : null, ...target }
  })
  const ab = createAgentBrowser({
    verify: (body, pane) => verifyRequest(body, pane, 'browser'),
    enabled: () => enabled,
    ask,
    guestById: (id) => (guest && id === guest.id ? guest : null),
    send: (ch, payload) => sentToWindow.push([ch, payload]),
    nativeImage: null,
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
    expect(() => validateParams('browser', { ...req, args: { text: 'x'.repeat(40000) } })).toThrow()
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

  it('fill types into a text field, never into a password field', async () => {
    const { call, guest } = setup()
    await call('snapshot')
    await call('fill', { ref: '@e1', text: 'me@example.com' })
    expect(guest.sent).toContainEqual(['Input.insertText', { text: 'me@example.com' }])
    await expect(call('fill', { ref: '@e2', text: 'hunter2' })).rejects.toMatchObject({ code: 'password_field' })
    await expect(call('type', { ref: '@e2', text: 'x' })).rejects.toMatchObject({ code: 'password_field' })
    expect(guest.sent.filter(([m, p]) => m === 'Input.insertText' && p.text === 'hunter2')).toEqual([])
  })

  it('a printable key is refused while a password field has the keyboard; Enter is not', async () => {
    const guest = fakeGuest(11, {
      cdp: pageCdp({
        'Runtime.evaluate': { result: { objectId: 'active' } },
        'DOM.describeNode': (p) => (p.objectId === 'active' ? { node: { nodeName: 'INPUT', attributes: ['type', 'PASSWORD'] } } : { node: {} })
      })
    })
    const { call } = setup({ guest })
    await expect(call('press', { key: 'a' })).rejects.toMatchObject({ code: 'password_field' })
    await expect(call('press', { key: 'Enter' })).resolves.toMatchObject({ text: 'Pressed Enter.' })
    await expect(call('press', { key: 'Hyper+q' })).rejects.toMatchObject({ code: 'invalid_argument' })
    await expect(call('press', { key: 'Control+Shift+w' })).rejects.toMatchObject({ code: 'reserved_key' })
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

  it('lists the browser tools with descriptions', () => {
    const names = mcp.BROWSER_TOOLS.map((t) => t.name)
    expect(names).toEqual([
      'browser_pages',
      'browser_open',
      'browser_navigate',
      'browser_snapshot',
      'browser_click',
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
