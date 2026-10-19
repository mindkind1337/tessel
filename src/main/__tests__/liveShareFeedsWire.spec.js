// @vitest-environment node
// Live Share phase 2c end to end over real WebSockets on 127.0.0.1 (only
// Cloudflare's tunnel is faked): the channel's 'links' topic (shareHost.js,
// shareGuest.js: needs "See my browser pages", ends the moment the right
// goes), then two Tessels (liveShare.js): the host's past conversations,
// what its terminal agents said and its activity reach the guest masked,
// with no session id, account or folder; the host's browser pages of a
// shared project's layout (never another page, never a hidden one) reach a
// guest with the right as links: their address (an address with a secret in
// it as its origin only; one only the host's side opens marked local), their
// title, a new address as the host's page navigates (in-page too), and their
// videos' state; never a picture of the page, never an input to it. The
// host's editor tabs reach the guest as paths from the project's folder,
// without a hidden or outside file.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { EventEmitter } from 'events'
import { registerLiveShare } from '../liveShare'
import { createShareHost } from '../liveShare/shareHost'
import { createShareGuest } from '../liveShare/shareGuest'
import { newSecret, newSigningKey, encodeInvite } from '../liveShare/shareCrypto'

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 })

vi.mock('../liveShare/shareTunnel.js', () => ({
  ensureCloudflared: vi.fn(async () => 'cloudflared.exe'),
  startTunnel: vi.fn(async ({ port }) => ({ url: `ws://127.0.0.1:${port}/`, stop: vi.fn(), pid: 4242 })),
  waitReachable: vi.fn(async () => true),
  waitRegistered: vi.fn(async () => true),
  tunnelLogTail: vi.fn(() => ''),
  endLeftoverTunnel: vi.fn(async () => false),
  tunnelState: vi.fn(async () => 'ours'),
  stopTunnelPid: vi.fn(async () => true),
  stopTunnelLater: vi.fn(),
  processState: vi.fn(async () => null)
}))

const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v
    await new Promise((r) => setTimeout(r, 15))
  }
  throw new Error('timed out')
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function jpeg(w, h, bytes = 4000) {
  const head = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xda])
  return Buffer.concat([head, Buffer.alloc(Math.max(0, bytes - head.length))])
}
// A browser page as the host's main process sees it (its debugger answers
// as Chromium's would, enough for the screencast and the input).
function fakePage(id, { url = 'https://mail.example/inbox/42?code=abc', title = 'Inbox', media = [] } = {}) {
  const dbg = new EventEmitter()
  const events = new EventEmitter()
  const state = { url, title, focus: 'none', destroyed: false, inFlight: 0, media }
  dbg.attached = false
  dbg.sent = []
  dbg.isAttached = () => dbg.attached
  dbg.attach = vi.fn(() => (dbg.attached = true))
  dbg.detach = vi.fn(() => {
    dbg.attached = false
    dbg.emit('detach', {}, 'target closed')
  })
  const node = () => (state.focus === 'password' ? 40 : 30)
  const answers = {
    'Page.getFrameTree': () => ({ frameTree: { frame: { id: 'F', loaderId: 'L' } } }),
    'Page.createIsolatedWorld': () => ({ executionContextId: 7 }),
    'Runtime.evaluate': (p) => {
      if (String(p.expression).includes("querySelectorAll('*')")) return { result: {} }
      if (state.focus === 'none') return { result: { type: 'object', subtype: 'null' } }
      return { result: { objectId: `n${node()}` } }
    },
    'Runtime.callFunctionOn': () => ({ result: { value: state.focus === 'password' } }),
    'DOM.describeNode': () => ({ node: { backendNodeId: node(), nodeName: 'INPUT' } }),
    'Page.getLayoutMetrics': () => ({ cssVisualViewport: { clientWidth: 1000, clientHeight: 700, pageX: 0, pageY: 0 }, cssLayoutViewport: { clientWidth: 1000, clientHeight: 700 } }),
    'Page.captureScreenshot': () => ({ data: jpeg(1000, 700).toString('base64') }),
    'Page.startScreencast': () => ((state.inFlight = 0), {}),
    'Page.screencastFrameAck': () => ((state.inFlight = Math.max(0, state.inFlight - 1)), {})
  }
  dbg.sendCommand = vi.fn(async (method, params) => {
    dbg.sent.push([method, params])
    const a = answers[method]
    return typeof a === 'function' ? a(params) : {}
  })
  return {
    id,
    state,
    debugger: dbg,
    on: (ev, fn) => events.on(ev, fn),
    once: (ev, fn) => events.once(ev, fn),
    removeListener: (ev, fn) => events.removeListener(ev, fn),
    // The page went somewhere (a reload, or in the page: pushState, a hash).
    go(next, ev = 'did-navigate') {
      state.url = next
      events.emit(ev, {}, next)
    },
    executeJavaScriptInIsolatedWorld: vi.fn(async () => state.media),
    isDestroyed: () => state.destroyed,
    getURL: () => state.url,
    getTitle: () => state.title,
    capturePage: vi.fn(async () => null),
    sendInputEvent: vi.fn(),
    insertText: vi.fn(async () => {}),
    loadURL: vi.fn(async () => {}),
    reload: vi.fn(),
    navigationHistory: { canGoBack: () => true, canGoForward: () => false, goBack: vi.fn(), goForward: vi.fn() },
    paint() {
      state.inFlight = 0
      dbg.emit('message', {}, 'Page.screencastFrame', { data: jpeg(1000, 700).toString('base64'), metadata: { deviceWidth: 1000, deviceHeight: 700 }, sessionId: 1 })
    },
    sentOf: (method) => dbg.sent.filter(([m]) => m === method).map(([, p]) => p)
  }
}

// --- The channel's links topic -------------------------------------------------------
describe('Live Share pages as links: the channel', () => {
  let host
  afterEach(() => host?.stop())

  it('the links need "See my browser pages" on that project, and stop with the right; no page stream any more', async () => {
    const watched = []
    const callbacks = {
      projects: () => [{ id: 'ws-1', layout: { project: 'site', tree: { type: 'leaf', id: 'pane-1', view: 'terminal', title: 't', kind: 'shell' }, activeId: 'pane-1' }, panes: [{ id: 'pane-1', title: 't', kind: 'shell', cols: 80, rows: 24 }] }],
      snapshot: async () => ({ data: '', cols: 80, rows: 24 }),
      write: () => {},
      openPane: () => {},
      closePane: () => {},
      askApproval: async () => true,
      opInfo: () => null,
      request: async () => ({ ok: false }),
      offers: (f) => f === 'links' || f === 'tabs',
      watch: (topic, project, key, on) => watched.push({ topic, project, on })
    }
    const secret = newSecret()
    host = createShareHost({ secret, hostName: 'Ada', callbacks })
    const port = await host.start()
    const r = { pushes: [], rights: [], states: [] }
    const client = createShareGuest({
      url: `ws://127.0.0.1:${port}/`,
      secret,
      name: 'Alex',
      signingKey: newSigningKey(),
      callbacks: { onState: (s) => r.states.push(s), onProjects: (p) => (r.projects = p), onRights: (x) => r.rights.push(x), onPush: (topic, project, key, data) => r.pushes.push({ topic, project, data }) }
    })
    client.connect()
    await until(() => r.states.includes('joined') && r.projects)
    expect(client.speaks('links')).toBe(true)
    expect(client.speaks('tabs')).toBe(true)
    expect(client.speaks('pages')).toBe(false)
    const id = host.guests().find((g) => g.name === 'Alex').id
    // Without the right: the subscription is ignored.
    client.subscribe('links', 'ws-1', null, true)
    await wait(80)
    expect(watched).toEqual([])
    host.setGrant(id, { rights: { pagesView: true } })
    await until(() => r.rights.length === 2)
    client.subscribe('links', 'ws-1', null, false)
    client.subscribe('links', 'ws-1', null, true)
    await until(() => watched.length === 1)
    host.push('links', 'ws-1', null, { pages: [{ id: 'pane-web', url: 'https://a.test/', local: false, title: 'A' }] })
    await until(() => r.pushes.length === 1)
    expect(r.pushes[0]).toMatchObject({ topic: 'links', project: 'ws-1' })
    // The right taken away: nothing more.
    host.change(id, { right: 'pagesView', on: false })
    await until(() => watched.length === 2)
    host.push('links', 'ws-1', null, { pages: [] })
    await wait(80)
    expect(r.pushes).toHaveLength(1)
    client.leave()
  })
})

// --- Two Tessels ------------------------------------------------------------------------
let tmp
const dataDirs = []
beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(join(os.tmpdir(), 'tessel-lsfeeds-')))
  fs.mkdirSync(join(tmp, 'site', 'src'), { recursive: true })
})
afterEach(() => {
  for (const d of dataDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  fs.rmSync(tmp, { recursive: true, force: true })
})
const SECRET = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx'
const SESSION = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'

function fakeMain({ pages = [] } = {}) {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-lsfeeds-data-'))
  dataDirs.push(dir)
  const byId = new Map(pages.map((p) => [p.id, p]))
  const m = {
    handle: {},
    on: {},
    sent: [],
    ipcMain: { handle: (name, fn) => (m.handle[name] = fn), on: (name, fn) => (m.on[name] = fn) },
    send: (channel, payload) => m.sent.push([channel, payload]),
    host: { request: vi.fn(async (op, body, _t, onReply) => (onReply?.({ ok: true, buffer: '' }), { ok: true, buffer: '' })), send: vi.fn() },
    events: (channel) => m.sent.filter(([c]) => c === channel).map(([, p]) => p),
    last: (channel) => m.events(channel).at(-1),
    sessions: {
      list: vi.fn(async () => [{ agent: 'claude', id: SESSION, cwd: join(tmp, 'site'), started: 1, updated: 2, title: `Ship it with ${SECRET}`, accountId: 'acct-7', accountLabel: 'ada@example.com' }]),
      details: vi.fn(async () => ({ ok: true, file: join(tmp, 'x.jsonl'), firstPrompt: `Read ${join(tmp, 'site', 'src', 'a.js')}, ${join(tmp, 'site', '.env')} and C:\\Users\\ada\\private.txt`, turns: [{ role: 'assistant', text: 'Done', at: 3 }], messageCount: 2 }))
    },
    readTerminal: vi.fn(async (q) => ({ ok: true, panes: Object.fromEntries(q.panes.map((p) => [p.ask, { key: `${p.sessionId}|s|0`, items: [{ role: 'user', t: 5, text: `my key ${SECRET}` }, { role: 'agent', t: 6, text: 'ok' }] }])) }))
  }
  m.api = registerLiveShare({
    ipcMain: m.ipcMain,
    send: m.send,
    host: m.host,
    dataDir: dir,
    queueData: () => {},
    sendExit: () => {},
    log: { info: () => {}, warn: () => {} },
    kill: vi.fn(),
    pidRunning: () => true,
    resume: false,
    watchProject: () => () => {},
    makeFileWatcher: () => ({ set: () => 0, close: () => {} }),
    sessionHistory: m.sessions,
    readTerminal: m.readTerminal,
    pageById: (id) => byId.get(id) || null
  })
  return m
}

const term = (id, extra = {}) => ({ type: 'leaf', id, view: 'terminal', title: id, kind: 'shell', ...extra })
const web = (id) => ({ type: 'leaf', id, view: 'browser', title: '' })

describe('Live Share phase 2c: two Tessels', () => {
  const mains = []
  afterEach(() => {
    for (const m of mains.splice(0)) m.api.stopAll()
  })

  async function session({ pages = [] } = {}) {
    const host = fakeMain({ pages })
    const guest = fakeMain()
    mains.push(host, guest)
    const started = await host.handle['liveShare:start'](null, { name: 'Cedric', projects: ['ws-1', 'ws-2'] })
    const tree = { type: 'split', dir: 'row', sizes: [40, 30, 30], children: [term('pane-1-ag', { kind: 'agent', agentId: 'claude' }), web('pane-web'), web('pane-web2')] }
    host.on['liveShare:layouts'](null, [
      { id: 'ws-1', layout: { project: 'site', tree, activeId: 'pane-1-ag' }, chats: [{ id: 'pane-1-ag', agentId: 'claude', sessionId: SESSION, accountId: 'acct-7', terminal: true, roots: [join(tmp, 'site')] }], root: join(tmp, 'site') },
      { id: 'ws-2', layout: { project: 'other', tree: { type: 'split', dir: 'row', sizes: [50, 50], children: [term('pane-2'), web('pane-web3')] }, activeId: 'pane-2' }, chats: [], root: null }
    ])
    await guest.handle['liveShare:join'](null, { invite: started.invites[0].code, name: 'Alex' })
    const ask = await until(() => host.last('liveShare:ask'))
    // The guest sees ws-1 only.
    await host.handle['liveShare:approve'](null, { guestId: ask.guestId, yes: true, projects: ['ws-1'] })
    await until(() => guest.events('liveShare:guest').find((s) => s.state === 'joined' && s.projects.length))
    const give = async (right, on = true) => {
      expect(await host.handle['liveShare:access'](null, { subject: ask.guestId, right, on })).toEqual({ ok: true })
      await until(() => guest.last('liveShare:guest').rights?.[right] === on)
    }
    const status = guest.last('liveShare:guest')
    const leaves = status.projects[0].layout.tree.children.map((c) => c.id)
    return { host, guest, give, guestId: ask.guestId, local: { agent: leaves[0], web: leaves[1], web2: leaves[2] } }
  }

  it('past conversations, terminal agents and activity reach the guest masked, without ids, accounts or folders', async () => {
    const { host, guest, local } = await session()
    expect(guest.last('liveShare:guest').features).toEqual(expect.arrayContaining(['history', 'links', 'tabs']))
    expect(guest.last('liveShare:guest').features).not.toContain('pages')
    const list = await guest.handle['liveShare:sessions'](null, { op: 'list', project: 'ws-1', args: { limit: 30 } })
    expect(host.sessions.list).toHaveBeenCalledWith({ cwd: join(tmp, 'site'), limit: 30 })
    expect(list.ok).toBe(true)
    expect(list.sessions).toEqual([{ id: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/), agent: 'claude', title: expect.stringContaining('••••'), started: 1, updated: 2 }])
    const details = await guest.handle['liveShare:sessions'](null, { op: 'details', project: 'ws-1', args: { ref: list.sessions[0].id } })
    expect(host.sessions.details).toHaveBeenCalledWith({ agent: 'claude', id: SESSION, accountId: 'acct-7' })
    expect(details).toEqual({ ok: true, firstPrompt: expect.stringContaining('src'), turns: [{ role: 'assistant', text: 'Done', at: 3 }], messageCount: 2 })
    expect(details.firstPrompt).not.toContain('private')
    // A hidden file of the project is never named (as in its Files tab).
    expect(details.firstPrompt).not.toContain('.env')
    // Another project of the host's: not this guest's.
    expect(await guest.handle['liveShare:sessions'](null, { op: 'list', project: 'ws-2', args: {} })).toEqual({ ok: false, code: 'no-project' })
    const terminal = await guest.handle['liveShare:sessions'](null, { op: 'terminal', project: 'ws-1', args: { from: 0 } })
    expect(Object.keys(terminal.panes)).toEqual([local.agent])
    expect(terminal.panes[local.agent].items.map((i) => i.role)).toEqual(['user', 'agent'])
    expect(terminal.panes[local.agent].items[0].text).not.toContain(SECRET)
    const again = await guest.handle['liveShare:sessions'](null, { op: 'terminal', project: 'ws-1', args: { from: 0, known: { [local.agent]: terminal.panes[local.agent].key } } })
    expect(host.readTerminal.mock.calls[1][0].known).toEqual({ 'pane-1-ag': `${SESSION}|s|0` })
    expect(again.ok).toBe(true)

    // Activity: sent by the host's window only while a guest follows it.
    expect(host.events('liveShare:feeds')).toEqual([])
    const sub = await guest.handle['liveShare:subscribe'](null, { topic: 'activity', project: 'ws-1', on: true })
    expect(sub).toMatchObject({ ok: true, outdated: false })
    await until(() => host.last('liveShare:feeds')?.activity?.includes('ws-1'))
    host.on['liveShare:activity'](null, [
      { project: 'ws-1', events: [{ t: 1, type: 'message', paneId: 'pane-1-ag', text: `use ${SECRET} from .tessel/team/tok999/inbox.json`, sender: { name: 'Ada', sessionId: SESSION, accountId: 'acct-7' } }], teams: [{ id: 'team-1', name: 'Builders', color: '#00ff00' }] },
      { project: 'ws-2', events: [{ t: 1, type: 'message', text: 'not for this guest' }] }
    ])
    const pushed = await until(() => guest.events('liveShare:push').find((p) => p.topic === 'activity'))
    expect(pushed.project).toBe('ws-1')
    expect(pushed.data.events).toEqual([{ t: 1, type: 'message', paneId: local.agent, text: expect.not.stringContaining(SECRET), sender: { name: 'Ada' }, wsId: 'ws-1' }])
    expect(pushed.data.events[0].text).toMatch(/from …$/)
    expect(pushed.data.teams).toEqual([{ id: 'team-1', name: 'Builders', color: '#00ff00' }])
    await guest.handle['liveShare:subscribe'](null, { topic: 'activity', project: 'ws-1', on: false })
    await until(() => host.last('liveShare:feeds')?.activity?.length === 0)

    const said = JSON.stringify(guest.sent)
    for (const leak of [SESSION, 'acct-7', 'ada@example.com', SECRET, tmp, tmp.replace(/\\/g, '\\\\'), 'not for this guest', 'x.jsonl', 'tok999']) expect(said).not.toContain(leak)
  })

  it('pages as links: only the shared project pages, never a hidden one, with the right; their address followed (in-page too) and their videos; no picture', async () => {
    const video = [{ kind: 'video', i: 0, paused: false, ended: false, t: 3, rate: 1 }]
    const p11 = fakePage(11, { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30s', title: 'Song', media: video })
    const p12 = fakePage(12, { url: 'http://localhost:5173/', title: 'Dev' })
    const p13 = fakePage(13, { url: 'https://docs.example.com/side', title: 'Side' })
    const p14 = fakePage(14)
    const p15 = fakePage(15, { url: 'https://bank.example.com/accounts', title: 'Bank' })
    const { host, guest, give, local } = await session({ pages: [p11, p12, p13, p14, p15] })
    host.on['liveShare:pages'](null, [
      { project: 'ws-1', paneId: 'pane-web', webContentsId: 11 },
      { project: 'ws-1', paneId: 'pane-web2', webContentsId: 12 },
      // The side panel's page (the window puts it in the project on screen),
      // a pane of no layout, and another project's.
      { project: 'ws-1', paneId: 'web-side1', webContentsId: 13, side: true, optIn: true },
      // A side panel page the host did not share itself: never.
      { project: 'ws-1', paneId: 'web-side2', webContentsId: 15, side: true },
      { project: 'ws-1', paneId: 'pane-nowhere', webContentsId: 14 },
      { project: 'ws-2', paneId: 'pane-web3', webContentsId: 14 }
    ])
    // Without "See my browser pages": nothing.
    await wait(400)
    expect(guest.events('liveShare:push').some((p) => p.topic === 'links' && p.data.pages.length)).toBe(false)
    await give('pagesView')
    const first = await until(() => guest.events('liveShare:push').find((p) => p.topic === 'links' && p.data.pages.length === 3))
    const byId = Object.fromEntries(first.data.pages.map((x) => [x.id, x]))
    expect(byId[local.web]).toMatchObject({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30s', local: false, title: 'Song', side: false })
    expect(byId[local.web2]).toMatchObject({ url: 'http://localhost:5173/', local: true, title: 'Dev' })
    expect(Object.values(byId).find((x) => x.side)).toMatchObject({ url: 'https://docs.example.com/side', title: 'Side', side: true })
    // Its video, read only once the guest has that page on screen.
    await wait(1500)
    expect(p11.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled()
    expect(await guest.handle['liveShare:pageMedia'](null, { id: local.web, on: true })).toEqual({ ok: true })
    await until(() => guest.events('liveShare:push').some((p) => p.topic === 'links' && p.data.pages.some((x) => x.id === local.web && x.media)))
    expect(p11.executeJavaScriptInIsolatedWorld).toHaveBeenCalled()
    // A page only the host's side opens: nothing of it is read.
    expect(p12.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled()
    // The host's page navigates in the page (a single-page app): the new address.
    p11.go('https://www.youtube.com/watch?v=9bZkp7q19f0', 'did-navigate-in-page')
    await until(() => guest.events('liveShare:push').some((p) => p.topic === 'links' && p.data.pages.some((x) => x.url === 'https://www.youtube.com/watch?v=9bZkp7q19f0')))
    // An address with a secret in it: its origin only.
    p11.go('https://mail.example/reset?token=abc123&user=ada')
    const trimmed = await until(() => guest.events('liveShare:push').map((p) => p.topic === 'links' && p.data.pages.find((x) => x.id === local.web)).filter(Boolean).find((x) => x.url === 'https://mail.example/'))
    expect(trimmed.trimmed).toBe(true)
    // Hidden by the host: gone from the links.
    host.on['liveShare:pages'](null, [
      { project: 'ws-1', paneId: 'pane-web', webContentsId: 11, hidden: true },
      { project: 'ws-1', paneId: 'pane-web2', webContentsId: 12 }
    ])
    await until(() => guest.events('liveShare:push').filter((p) => p.topic === 'links').at(-1).data.pages.length === 1)
    expect(guest.events('liveShare:push').filter((p) => p.topic === 'links').at(-1).data.pages[0].id).toBe(local.web2)
    // Never a picture of a page, never the debugger.
    expect(guest.events('liveShare:pageFrame')).toEqual([])
    for (const page of [p11, p12, p13, p14, p15]) expect(page.debugger.attach).not.toHaveBeenCalled()
    // Ids of links: never a terminal's.
    expect(local.web).toMatch(/^lnk-/)
    // The right taken away: the links go.
    await give('pagesView', false)
    await until(() => guest.events('liveShare:push').filter((p) => p.topic === 'links').at(-1).data.pages.length === 0)
    const said = JSON.stringify(guest.sent)
    expect(said).not.toContain('token=abc123')
    expect(said).not.toContain('pane-web3')
    expect(said).not.toContain('bank.example.com')
  })

  it('editor tabs: the host files open in the shared project, as paths from it, never a hidden or an outside one', async () => {
    const { host, guest } = await session()
    const site = join(tmp, 'site')
    fs.writeFileSync(join(site, 'src', 'a.js'), 'a')
    fs.writeFileSync(join(site, '.env'), 'SECRET=1')
    host.on['liveShare:layouts'](null, [
      {
        id: 'ws-1',
        layout: { project: 'site', tree: { type: 'split', dir: 'row', sizes: [50, 50], children: [term('pane-1-ag', { kind: 'agent', agentId: 'claude' }), { type: 'leaf', id: 'pane-ed', view: 'editor', title: '' }] }, activeId: 'pane-1-ag', shown: 'pane-ed' },
        chats: [],
        root: site,
        tabs: { files: [join(site, 'src', 'a.js'), join(site, '.env'), join(site, '.git', 'config'), join(tmp, 'elsewhere.txt'), 'C:\\Windows\\win.ini'], active: join(site, 'src', 'a.js') }
      }
    ])
    const got = await until(() => guest.events('liveShare:push').filter((p) => p.topic === 'tabs' && p.data.tabs.length).at(-1))
    expect(got).toEqual({ topic: 'tabs', project: 'ws-1', data: { tabs: ['src/a.js'], active: 'src/a.js' } })
    // The tab the host shows: an editor (its id here).
    const lay = guest.last('liveShare:guest').projects[0].layout
    expect(lay.shown).toMatch(/^pane-ls\d+-ed$/)
    // The host closes it: gone here too.
    host.on['liveShare:layouts'](null, [{ id: 'ws-1', layout: { project: 'site', tree: term('pane-1-ag', { kind: 'agent', agentId: 'claude' }), activeId: 'pane-1-ag', shown: 'terminal' }, chats: [], root: site, tabs: { files: [], active: null } }])
    await until(() => guest.events('liveShare:push').filter((p) => p.topic === 'tabs').at(-1).data.tabs.length === 0)
    const said = JSON.stringify(guest.sent)
    expect(said).not.toContain('.env')
    expect(said).not.toContain('elsewhere')
    expect(said).not.toContain(tmp.replace(/\\/g, '\\\\'))
  })

  it('an older host: no page and no history, said as such', async () => {
    const secret = newSecret()
    const old = createShareHost({
      secret,
      hostName: 'Old',
      callbacks: {
        projects: () => [{ id: 'ws-1', layout: { project: 'site', tree: { type: 'split', dir: 'row', sizes: [50, 50], children: [term('pane-1'), web('pane-web')] }, activeId: 'pane-1' }, panes: [{ id: 'pane-1', title: 'x', kind: 'shell', cols: 80, rows: 24 }] }],
        snapshot: async () => ({ data: '', cols: 80, rows: 24 }),
        write: () => {},
        openPane: () => {},
        closePane: () => {},
        askApproval: async () => ({ yes: true, projects: ['ws-1'], rights: { pagesView: true } })
      }
    })
    const port = await old.start()
    const guest = fakeMain()
    mains.push(guest)
    try {
      await guest.handle['liveShare:join'](null, { invite: encodeInvite({ url: `ws://127.0.0.1:${port}/`, secret }), name: 'Alex' })
      const s = await until(() => guest.events('liveShare:guest').find((x) => x.state === 'joined' && x.projects.length))
      expect(s.features).not.toContain('pages')
      expect(s.features).not.toContain('history')
      expect(s.features).not.toContain('links')
      expect(await guest.handle['liveShare:subscribe'](null, { topic: 'links', project: 'ws-1', on: true })).toMatchObject({ outdated: true })
      expect(await guest.handle['liveShare:sessions'](null, { op: 'list', project: 'ws-1', args: {} })).toEqual({ ok: false, code: 'outdated-host' })
      expect(await guest.handle['liveShare:subscribe'](null, { topic: 'activity', project: 'ws-1', on: true })).toMatchObject({ outdated: true })
    } finally {
      old.stop()
    }
  })
})
