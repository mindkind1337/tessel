// @vitest-environment node
// Live Share in main (liveShare.js): the window's layout kept to plain data,
// a host pane's id in a guest's window, and registerLiveShare's IPC end to
// end over real WebSockets on 127.0.0.1 (only Cloudflare's tunnel is faked).
import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { cleanLayout, layoutLeaves, guestPaneId, registerLiveShare, visibleScreen } from '../liveShare'
import net from 'net'
import { createShareHost } from '../liveShare/shareHost'
import { newSecret, encodeInvite, decodeInvite, newSigningKey, exportSigningKey } from '../liveShare/shareCrypto'
import { secretId } from '../liveShare/shareAccess'
import { RIGHT_IDS, NO_RIGHTS } from '../../shared/liveShareRights'

// The tunnel to the share server is the server itself here (no cloudflared);
// its PID 4242 runs while `tunnel.alive`; `tunnel.state` is what Windows
// says of it (ours / other / gone / unknown).
const tunnel = vi.hoisted(() => ({ alive: true, state: null, startError: null, gate: null }))
vi.mock('../liveShare/shareTunnel.js', () => ({
  ensureCloudflared: vi.fn(async () => 'cloudflared.exe'),
  startTunnel: vi.fn(async ({ port }) => {
    if (tunnel.startError) throw tunnel.startError
    return { url: `ws://127.0.0.1:${port}/`, stop: vi.fn(), pid: 4242 }
  }),
  waitReachable: vi.fn(async () => true),
  waitRegistered: vi.fn(async () => true),
  tunnelLogTail: vi.fn(() => ''),
  endLeftoverTunnel: vi.fn(async () => false),
  tunnelState: vi.fn(async (pid) => {
    if (tunnel.gate) await tunnel.gate
    if (tunnel.state) return tunnel.state
    return pid === 4242 && tunnel.alive ? 'ours' : 'gone'
  }),
  stopTunnelPid: vi.fn(async () => true),
  stopTunnelLater: vi.fn(),
  processState: vi.fn(async () => null)
}))

// Each Tessel's data folder (its saved share and session).
const dataDirs = []
const newDataDir = () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-ls-'))
  dataDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dataDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  tunnel.alive = true
  tunnel.state = null
  tunnel.startError = null
  tunnel.gate = null
})

const ALL = { ...NO_RIGHTS, type: true, open: true, close: true }
// The share's first invitation's code (made when it starts).
const codeOf = (status) => status.invites[0].code
// What the window does: one right or one project at a time (liveShare:access).
async function setRights(m, subject, rights) {
  let ok = true
  for (const right of RIGHT_IDS) ok = (await m.handle['liveShare:access'](null, { subject, right, on: !!rights[right] })).ok && ok
  return { ok }
}
async function setProjects(m, subject, ids, all = ['ws-1', 'ws-2', 'ws-3']) {
  let ok = true
  for (const project of all) {
    const r = await m.handle['liveShare:access'](null, { subject, project, on: ids.includes(project) })
    // A project not shared can't be given (and is not an error here).
    if (ids.includes(project) && !r.ok && !(m.last('liveShare:host').projectIds || []).includes(project)) continue
    ok = r.ok && ok
  }
  return { ok }
}
const freePort = () =>
  new Promise((resolve) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })

const until = async (fn, ms = 4000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = fn()
    if (v) return v
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('timed out')
}

const leaf = (id, extra = {}) => ({ type: 'leaf', id, view: 'terminal', title: id, kind: 'shell', ...extra })
// The host window's layout of a shared project (liveShare:layouts).
const showLayout = (m, layout, id = 'ws-1') => m.on['liveShare:layouts'](null, [{ id, layout }])

describe('cleanLayout', () => {
  it('keeps the tree, the active and the fullscreen pane, as plain bounded data', () => {
    const layout = cleanLayout({
      project: 'tessel',
      tree: {
        type: 'split',
        dir: 'col',
        sizes: [30, 70],
        children: [
          leaf('pane-1', { kind: 'agent', agentId: 'claude', accent: '#ff8800', secret: 'not copied' }),
          { type: 'split', dir: 'row', sizes: [50, 50], children: [leaf('pane-2', { view: 'editor' }), leaf('pane-3', { view: 'browser' })] }
        ]
      },
      activeId: 'pane-2',
      maximizedId: 'pane-1',
      shown: 'pane-3',
      copy: 'tessel/fix'
    })
    expect(layout).toEqual({
      project: 'tessel',
      tree: {
        type: 'split',
        dir: 'col',
        sizes: [30, 70],
        children: [
          { type: 'leaf', id: 'pane-1', view: 'terminal', title: 'pane-1', kind: 'agent', agentId: 'claude', accent: '#ff8800' },
          {
            type: 'split',
            dir: 'row',
            sizes: [50, 50],
            children: [
              { type: 'leaf', id: 'pane-2', view: 'editor', title: 'pane-2', kind: 'shell', agentId: null, accent: null },
              { type: 'leaf', id: 'pane-3', view: 'browser', title: 'pane-3', kind: 'shell', agentId: null, accent: null }
            ]
          }
        ]
      },
      activeId: 'pane-2',
      maximizedId: 'pane-1',
      shown: 'pane-3',
      copy: 'tessel/fix'
    })
    // A tab shown that is not one of its panes: none.
    expect(cleanLayout({ tree: leaf('pane-1'), shown: '../x' }).shown).toBe(null)
    expect(cleanLayout({ tree: leaf('pane-1'), shown: 'terminal' }).shown).toBe('terminal')
  })

  it('drops what is not a pane, and fixes what it can', () => {
    const layout = cleanLayout({
      project: 42,
      tree: {
        type: 'split',
        dir: 'diagonal',
        sizes: [1, 2, 3],
        children: [
          leaf('pane-ok', { view: 'webview', kind: 'root', accent: 'red; background: url(x)', title: 'x'.repeat(500) }),
          leaf('../../etc/passwd'),
          leaf('pane-2'),
          { type: 'split', children: [] },
          null,
          'pane-4'
        ]
      },
      activeId: 'pane-gone',
      maximizedId: '../../etc/passwd'
    })
    expect(layout.project).toBe(null)
    expect(layout.tree.dir).toBe('row')
    expect(layout.tree.sizes).toEqual([50, 50]) // the sizes did not fit the panes kept
    expect(layout.tree.children.map((c) => c.id)).toEqual(['pane-ok', 'pane-2'])
    expect(layout.tree.children[0]).toMatchObject({ view: 'terminal', kind: 'shell', accent: null })
    expect(layout.tree.children[0].title).toHaveLength(200)
    expect(layout.activeId).toBe(null)
    expect(layout.maximizedId).toBe(null)
  })

  it('a split of one pane is that pane; nothing usable is no tree', () => {
    expect(cleanLayout({ tree: { type: 'split', children: [leaf('pane-1')] } }).tree).toMatchObject({ type: 'leaf', id: 'pane-1' })
    expect(cleanLayout({ tree: { type: 'split', children: [{ type: 'leaf', id: 'a b' }] } })).toEqual({ project: null, tree: null, activeId: null, maximizedId: null, shown: null, copy: null })
    expect(cleanLayout(null)).toBe(null)
    expect(cleanLayout('layout')).toBe(null)
  })

  it('stops at 64 panes and 16 levels', () => {
    const many = cleanLayout({ tree: { type: 'split', children: Array.from({ length: 32 }, (_, i) => ({ type: 'split', children: [leaf(`pane-${i}-a`), leaf(`pane-${i}-b`), leaf(`pane-${i}-c`)] })) } })
    expect(layoutLeaves(many)).toHaveLength(64)
    let deep = leaf('pane-deep')
    for (let i = 0; i < 20; i++) deep = { type: 'split', children: [deep, leaf(`pane-${i}`)] }
    const ids = layoutLeaves(cleanLayout({ tree: deep })).map((l) => l.id)
    expect(ids).not.toContain('pane-deep')
    expect(ids).toContain('pane-19')
  })
})

describe('layoutLeaves', () => {
  it('lists the panes left to right, top to bottom', () => {
    const layout = cleanLayout({ tree: { type: 'split', children: [leaf('pane-1'), { type: 'split', dir: 'col', children: [leaf('pane-2'), leaf('pane-3')] }] } })
    expect(layoutLeaves(layout).map((l) => l.id)).toEqual(['pane-1', 'pane-2', 'pane-3'])
    expect(layoutLeaves(null)).toEqual([])
    expect(layoutLeaves({ tree: null })).toEqual([])
  })
})

describe('guestPaneId', () => {
  it('is a valid pane id of this window, unique per session, that main never starts a shell for', () => {
    expect(guestPaneId(1, 'pane-12-abc')).toBe('pane-ls1-12-abc')
    expect(guestPaneId(2, 'pane-12-abc')).toBe('pane-ls2-12-abc')
    expect(guestPaneId(3, 'odd id/../x')).toBe('pane-ls3-odd_id____x')
    const long = guestPaneId(12, 'pane-' + 'x'.repeat(200))
    expect(long).toHaveLength(80)
    for (const id of [guestPaneId(1, 'pane-1'), long, guestPaneId(3, 'odd id/../x')]) {
      expect(id).toMatch(/^[\w-]{1,80}$/)
      expect(id).toMatch(/^pane-ls\d+-/) // pty:create refuses these (index.js)
    }
  })
})

// The window's side of registerLiveShare: its IPC handlers, what it sends to
// the window, the terminal host client and the window's pty:data / pty:exit.
function fakeMain({ snapshot = (id) => `screen of ${id}`, dataDir = newDataDir(), resume = false, requestLimits } = {}) {
  const m = {
    handle: {},
    on: {},
    sent: [],
    data: [],
    exits: [],
    hostWrites: [],
    logs: [],
    ipcMain: {
      handle: (name, fn) => (m.handle[name] = fn),
      on: (name, fn) => (m.on[name] = fn)
    },
    send: (channel, payload) => m.sent.push([channel, payload]),
    host: {
      // A screen from the terminal host: onReply first, as ptyClient does.
      request: vi.fn(async (op, body, _timeout, onReply) => {
        const msg = op === 'attach' ? { ok: true, buffer: snapshot(body.id) } : { ok: false }
        onReply?.(msg)
        return msg
      }),
      send: vi.fn((op, body) => {
        if (op === 'write') m.hostWrites.push([body.id, body.data])
      })
    },
    events: (channel) => m.sent.filter(([c]) => c === channel).map(([, p]) => p),
    last: (channel) => m.events(channel).at(-1)
  }
  m.api = registerLiveShare({
    ipcMain: m.ipcMain,
    send: m.send,
    host: m.host,
    dataDir,
    queueData: (id, data) => m.data.push([id, data]),
    sendExit: (id, exitCode) => m.exits.push([id, exitCode]),
    log: { info: (_tag, line) => m.logs.push(line), warn: (_tag, line) => m.logs.push(line) },
    kill: vi.fn(),
    pidRunning: () => tunnel.alive,
    resume,
    ...(requestLimits ? { requestLimits } : {})
  })
  m.dataDir = dataDir
  return m
}

describe('registerLiveShare: joining a host', () => {
  let shareHost
  const mains = []
  afterEach(() => {
    for (const m of mains.splice(0)) m.api.stopAll()
    shareHost?.stop()
    shareHost = null
  })

  it('shows the host panes and layout with local ids, attaches, types, and closes on the host', async () => {
    const secret = newSecret()
    const remote = { writes: [], closed: [], opened: [], asked: [], approve: null }
    let panes = [{ id: 'pane-7-abc', title: 'Claude Code', kind: 'agent', agentId: 'claude', accent: '#3366ff', cols: 100, rows: 30 }]
    const hostLayout = {
      project: 'tessel',
      tree: { type: 'split', dir: 'row', sizes: [60, 40], children: [leaf('pane-7-abc', { title: 'Claude Code', kind: 'agent', agentId: 'claude' }), leaf('pane-8-ed', { view: 'editor', title: 'App.vue' })] },
      activeId: 'pane-7-abc',
      maximizedId: null
    }
    shareHost = createShareHost({
      secret,
      hostName: 'Cedric',
      callbacks: {
        projects: () => [{ id: 'ws-1', layout: hostLayout, panes }],
        snapshot: async (id) => ({ data: `screen of ${id}`, cols: 100, rows: 30 }),
        write: (id, data) => remote.writes.push([id, data]),
        openPane: (spec) => remote.opened.push(spec),
        closePane: (id) => remote.closed.push(id),
        agents: () => [{ id: 'codex', name: 'Codex' }],
        askApproval: (g) =>
          new Promise((resolve) => {
            remote.asked.push(g.name)
            remote.approve = resolve
          })
      }
    })
    const port = await shareHost.start()
    const m = fakeMain()
    mains.push(m)

    const invite = encodeInvite({ url: `ws://127.0.0.1:${port}/`, secret })
    expect(await m.handle['liveShare:join'](null, { invite, name: 'Alex' })).toEqual({ ok: true })
    await until(() => remote.approve)
    expect(remote.asked).toEqual(['Alex'])
    await until(() => m.last('liveShare:guest')?.state === 'waiting')
    expect(m.events('liveShare:guest')[0]).toMatchObject({ state: 'connecting', panes: [], projects: [] })
    remote.approve(true)

    const joined = await until(() => m.events('liveShare:guest').find((s) => s.state === 'joined' && s.panes.length))
    const localId = 'pane-ls1-7-abc'
    expect(joined).toMatchObject({ host: 'Cedric', session: 1, reason: null })
    expect(joined.panes).toEqual([{ id: localId, project: 'ws-1', title: 'Claude Code', kind: 'agent', agentId: 'claude', accent: '#3366ff', cols: 100, rows: 30, gen: 0 }])
    expect(joined.projects).toEqual([
      {
        id: 'ws-1',
        layout: {
          project: 'tessel',
          tree: {
            type: 'split',
            dir: 'row',
            sizes: [60, 40],
            children: [
              { type: 'leaf', id: localId, view: 'terminal', title: 'Claude Code', kind: 'agent', agentId: 'claude', accent: null },
              { type: 'leaf', id: 'pane-ls1-8-ed', view: 'editor', title: 'App.vue', kind: 'shell', agentId: null, accent: null }
            ]
          },
          activeId: localId,
          maximizedId: null,
          shown: null,
          copy: null
        }
      }
    ])
    expect((await m.handle['liveShare:state']()).guest).toMatchObject({ state: 'joined', host: 'Cedric' })

    // Its pty calls: the host's pane, never one of this computer.
    expect(m.api.isGuestPane(localId)).toBe(true)
    expect(m.api.isGuestPane('pane-7-abc')).toBe(false)
    expect(m.api.isGuestPane('pane-ls1-8-ed')).toBe(false) // an editor: no terminal
    const attached = await m.api.guestAttach(localId)
    expect(attached).toMatchObject({ ok: true, backend: 'liveshare', shell: { id: 'liveshare', name: 'Cedric' }, pid: null, exited: false, buffer: 'screen of pane-7-abc' })
    expect(await m.api.guestAttach('pane-ls1-nope')).toEqual({ ok: false })

    // Output after the snapshot comes as the window's pty:data.
    shareHost.sendData('pane-7-abc', '\r\nhello')
    await until(() => m.data.length)
    expect(m.data).toEqual([[localId, '\r\nhello']])

    // View only until the host lets it type, open and close.
    expect(m.last('liveShare:guest').rights).toEqual({ ...NO_RIGHTS, type: false, open: false, close: false })
    expect(m.last('liveShare:guest').code).toMatch(/^\d{3} \d{3}$/)
    m.api.guestWrite(localId, 'early\r')
    // Without the right, a host that can be asked is asked (in one of its
    // projects, an agent it lists).
    expect(await m.handle['liveShare:open'](null, { kind: 'terminal' })).toEqual({ ok: false, reason: 'project' })
    expect(await m.handle['liveShare:open'](null, { kind: 'agent', agent: 'calc', project: 'ws-1' })).toEqual({ ok: false, reason: 'agent' })
    expect(await m.handle['liveShare:open'](null, { kind: 'terminal', project: 'ws-1' })).toEqual({ ok: true, asked: true })
    expect(m.last('liveShare:guest').agents).toEqual([{ id: 'codex', name: 'Codex' }])
    // (This host has no one to ask: nothing opens.)
    await new Promise((r) => setTimeout(r, 60))
    expect(remote.opened).toEqual([])
    shareHost.setGrant(shareHost.guests()[0].id, { rights: ALL })
    await until(() => m.last('liveShare:guest').rights?.type)

    m.api.guestWrite(localId, 'ls\r')
    m.api.guestWrite('pane-ls1-nope', 'rm -rf /\r')
    m.api.guestWrite(localId, { not: 'text' })
    await until(() => remote.writes.length)
    expect(remote.writes).toEqual([['pane-7-abc', 'ls\r']])

    // In one of the host's projects it sees.
    expect(await m.handle['liveShare:open'](null, { kind: 'agent', agent: 'codex' })).toEqual({ ok: false, reason: 'project' })
    expect(await m.handle['liveShare:open'](null, { kind: 'agent', agent: 'codex', project: 'ws-9' })).toEqual({ ok: false, reason: 'project' })
    expect(await m.handle['liveShare:open'](null, { kind: 'agent', agent: 'codex', project: 'ws-1' })).toEqual({ ok: true, asked: false })
    await until(() => remote.opened.length)
    expect(remote.opened).toEqual([{ kind: 'agent', agent: 'codex', project: 'ws-1' }])

    // Closing it here closes it on the host (which then removes it).
    m.api.guestKill(localId)
    await until(() => remote.closed.length)
    expect(remote.closed).toEqual(['pane-7-abc'])

    shareHost.sendExit('pane-7-abc', 3)
    await until(() => m.exits.length)
    expect(m.exits).toEqual([[localId, 3]])

    panes = []
    shareHost.panesChanged()
    await until(() => !m.api.isGuestPane(localId))
    expect(m.last('liveShare:guest').panes).toEqual([])
    expect(m.exits).toEqual([[localId, 3], [localId, 0]]) // an attached pane ends in the window

    expect(await m.handle['liveShare:leave']()).toEqual({ ok: true })
    expect(m.last('liveShare:guest')).toMatchObject({ state: 'ended', reason: 'left' })
    await until(() => shareHost.guests().length === 0)
    expect((await m.handle['liveShare:state']()).guest).toMatchObject({ state: 'off', panes: [] })
  })

  it('shows at most 128 of a host’s panes, whatever the host sends', async () => {
    const secret = newSecret()
    const projects = Array.from({ length: 16 }, (_, p) => ({
      id: `ws-${p}`,
      layout: null,
      panes: Array.from({ length: 64 }, (_, i) => ({ id: `pane-${p}-${i}`, title: 'x', kind: 'shell', cols: 80, rows: 24 }))
    }))
    shareHost = createShareHost({ secret, hostName: 'Mallory', callbacks: { projects: () => projects, snapshot: async () => null, write: () => {}, askApproval: async () => true } })
    const port = await shareHost.start()
    const m = fakeMain()
    mains.push(m)
    await m.handle['liveShare:join'](null, { invite: encodeInvite({ url: `ws://127.0.0.1:${port}/`, secret }), name: 'Alex' })
    const joined = await until(() => m.events('liveShare:guest').find((s) => s.state === 'joined' && s.panes.length))
    expect(joined.projects).toHaveLength(16)
    expect(joined.panes).toHaveLength(128)
    expect(m.api.isGuestPane('pane-ls1-1-63')).toBe(true)
    expect(m.api.isGuestPane('pane-ls1-2-0')).toBe(false)
  })

  it('refuses what is not an invite, and ends when the host says no', async () => {
    const m = fakeMain()
    mains.push(m)
    const bad = await m.handle['liveShare:join'](null, { invite: 'hello', name: 'Alex' })
    expect(bad.ok).toBe(false)
    expect(bad.error).toMatch(/invite/)
    // Only to this PC or the local network without TLS.
    expect(await m.handle['liveShare:join'](null, { invite: encodeInvite({ url: 'ws://example.com/', secret: newSecret() }) })).toMatchObject({ ok: false })
    expect(m.events('liveShare:guest')).toEqual([])

    const secret = newSecret()
    shareHost = createShareHost({ secret, hostName: 'Cedric', callbacks: { projects: () => [], snapshot: async () => null, write: () => {}, askApproval: async () => false } })
    const port = await shareHost.start()
    await m.handle['liveShare:join'](null, { invite: encodeInvite({ url: `ws://127.0.0.1:${port}/`, secret }) })
    await until(() => m.last('liveShare:guest')?.state === 'ended')
    expect(m.last('liveShare:guest').reason).toBe('denied')
    expect(await m.handle['liveShare:open'](null, { kind: 'terminal' })).toEqual({ ok: false })
  })
})

describe('registerLiveShare: one Tessel shares, another joins', () => {
  const mains = []
  afterEach(() => {
    for (const m of mains.splice(0)) m.api.stopAll()
  })

  it('shares the window layout and terminals, asks before letting a guest in, and ends for everyone on stop', async () => {
    const host = fakeMain({ snapshot: () => 'PS C:\\> ' })
    const guest = fakeMain()
    mains.push(host, guest)

    host.api.noteSize('pane-1-ps', 120, 40)
    const started = await host.handle['liveShare:start'](null, { name: 'Cedric', projects: ['ws-1'] })
    showLayout(host, { project: 'site', tree: { type: 'split', children: [leaf('pane-1-ps', { title: 'PowerShell' }), leaf('pane-2-web', { view: 'browser', title: 'localhost' })] }, activeId: 'pane-1-ps' })
    expect(started).toMatchObject({ ok: true, state: 'sharing', guests: [], error: null })
    expect(host.events('liveShare:host').map((s) => s.state)).toEqual(['preparing', 'starting', 'checking', 'sharing'])
    // Its first invitation: at an address of its own on the share.
    const invite = codeOf(started)
    expect(decodeInvite(invite).url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/i\/[\w-]{16}$/)
    expect(started.invites).toEqual([expect.objectContaining({ lifetime: 'hour', projects: ['ws-1'], rights: { ...NO_RIGHTS, type: false, open: false, close: false }, state: 'live', uses: 0 })])
    // Starting again while sharing keeps the same session.
    expect(codeOf(await host.handle['liveShare:start'](null, { projects: ['ws-1'] }))).toBe(invite)

    await guest.handle['liveShare:join'](null, { invite, name: 'Alex' })
    const ask = await until(() => host.last('liveShare:ask'))
    expect(ask).toMatchObject({ name: 'Alex' })
    // The code the host sees is the one the guest's Tessel shows.
    await until(() => guest.last('liveShare:guest')?.code)
    expect(ask.code).toBe(guest.last('liveShare:guest').code)
    expect(await host.handle['liveShare:approve'](null, { guestId: 'g-unknown', yes: true, projects: ['ws-1'] })).toEqual({ ok: false })
    expect(await host.handle['liveShare:approve'](null, { guestId: ask.guestId, yes: true, projects: ['ws-1'] })).toEqual({ ok: true })

    const joined = await until(() => guest.events('liveShare:guest').find((s) => s.state === 'joined' && s.panes.length))
    const localId = 'pane-ls1-1-ps'
    expect(joined).toMatchObject({ host: 'Cedric', panes: [{ id: localId, title: 'PowerShell', kind: 'shell', cols: 120, rows: 40 }] })
    expect(joined.projects.map((p) => p.id)).toEqual(['ws-1'])
    expect(joined.projects[0].layout.tree.children.map((c) => c.id)).toEqual([localId, 'pane-ls1-2-web'])
    expect(joined.projects[0].layout.activeId).toBe(localId)
    await until(() => host.last('liveShare:host').guests.some((g) => g.name === 'Alex' && g.state === 'joined'))

    // The snapshot is the terminal host's screen, taken through ptyClient's onReply.
    expect(await guest.api.guestAttach(localId)).toMatchObject({ ok: true, buffer: 'PS C:\\> ' })
    // Without its scrollback (a terminal host that does not know scrollback
    // sends it all: visibleScreen keeps the screen).
    expect(host.host.request).toHaveBeenCalledWith('attach', { id: 'pane-1-ps', scrollback: 0 }, undefined, expect.any(Function))

    // Typing waits for the host's yes.
    guest.api.guestWrite(localId, 'early\r')
    expect(await setRights(host, ask.guestId, ALL)).toEqual({ ok: true })
    expect(await setRights(host, 'g-unknown', ALL)).toEqual({ ok: false })
    await until(() => guest.last('liveShare:guest').rights?.type)
    expect(host.last('liveShare:host').guests.find((g) => g.name === 'Alex').rights).toEqual(ALL)

    host.api.onPtyData('pane-1-ps', 'dir\r\n')
    host.api.onPtyData('pane-9-not-shown', 'secret\r\n')
    await until(() => guest.data.length)
    expect(guest.data).toEqual([[localId, 'dir\r\n']])

    guest.api.guestWrite(localId, 'exit\r')
    await until(() => host.hostWrites.length)
    expect(host.hostWrites).toEqual([['pane-1-ps', 'exit\r']])

    // A guest's open / close goes to the host's window to do.
    await guest.handle['liveShare:open'](null, { kind: 'terminal', project: 'ws-1' })
    guest.api.guestKill(localId)
    await until(() => host.events('liveShare:hostRequest').length === 2)
    expect(host.events('liveShare:hostRequest')).toEqual([
      { action: 'open', request: expect.stringMatching(/^r\d+$/), spec: { kind: 'terminal', project: 'ws-1' }, guest: expect.objectContaining({ name: 'Alex' }) },
      { action: 'close', id: 'pane-1-ps', guest: expect.objectContaining({ name: 'Alex' }) }
    ])

    // A pane taken out of the shared project: its output stops at once, and
    // the guest drops it without waiting.
    showLayout(host, { project: 'site', tree: leaf('pane-2-web', { view: 'browser' }), activeId: null })
    host.api.onPtyData('pane-1-ps', 'PRIVATE-AFTER-MOVE\r\n')
    await until(() => guest.last('liveShare:guest').panes.length === 0)
    await new Promise((r) => setTimeout(r, 40))
    expect(guest.data.some(([, d]) => d.includes('PRIVATE'))).toBe(false)
    showLayout(host, { project: 'site', tree: { type: 'split', children: [leaf('pane-1-ps', { title: 'PowerShell' }), leaf('pane-2-web', { view: 'browser', title: 'localhost' })] }, activeId: 'pane-1-ps' })
    await until(() => guest.last('liveShare:guest').panes.length === 1)

    // The host's window resized the pane: the guest shows it at that size.
    host.api.noteSize('pane-1-ps', 90, 25)
    await until(() => guest.last('liveShare:guest').panes[0]?.cols === 90)
    expect(guest.last('liveShare:guest').panes[0]).toMatchObject({ cols: 90, rows: 25 })

    host.api.onPtyExit('pane-1-ps', 0)
    await until(() => guest.exits.length)
    expect(guest.exits).toEqual([[localId, 0]])

    expect(await host.handle['liveShare:stop']()).toEqual({ ok: true })
    expect(host.last('liveShare:host')).toMatchObject({ state: 'off', invites: [], guests: [] })
    await until(() => guest.last('liveShare:guest').state === 'ended')
    expect(guest.last('liveShare:guest').reason).toBe('stopped')
    expect(guest.api.isGuestPane(localId)).toBe(false)
  })

  it('a guest the host removes is out; a removal after it was let in makes no one else wait (one while it waited does)', async () => {
    const host = fakeMain()
    const a = fakeMain()
    const b = fakeMain()
    mains.push(host, a, b)
    const invite = codeOf(await host.handle['liveShare:start'](null, { projects: ['ws-1'] }))
    showLayout(host, { tree: leaf('pane-1-ps') })

    await b.handle['liveShare:join'](null, { invite, name: 'Bea' })
    const askB = await until(() => host.events('liveShare:ask').find((q) => q.name === 'Bea'))
    await host.handle['liveShare:approve'](null, { guestId: askB.guestId, yes: true, projects: ['ws-1'] })
    await until(() => b.last('liveShare:guest')?.state === 'joined')
    await host.handle['liveShare:removeGuest'](null, { guestId: askB.guestId })
    await until(() => b.last('liveShare:guest')?.state === 'ended')
    expect(b.last('liveShare:guest').reason).toBe('removed')
    await until(() => host.last('liveShare:host').guests.length === 0)

    // Right after removing someone let in: the next one is still asked.
    await a.handle['liveShare:join'](null, { invite, name: 'Alex' })
    const askA = await until(() => host.events('liveShare:ask').find((q) => q.name === 'Alex'))
    // Removed while it waits (a no): the next one waits a while.
    await host.handle['liveShare:removeGuest'](null, { guestId: askA.guestId })
    await until(() => a.last('liveShare:guest')?.state === 'ended')
    const c = fakeMain()
    mains.push(c)
    await c.handle['liveShare:join'](null, { invite, name: 'Cid' })
    await until(() => c.last('liveShare:guest')?.state === 'ended')
    expect(c.last('liveShare:guest').reason).toBe('busy')
    expect(host.events('liveShare:ask').map((q) => q.name)).toEqual(['Bea', 'Alex'])
  })

  it('a tunnel that never connects, an address that never answers: says why (and logs it)', async () => {
    const st = await import('../liveShare/shareTunnel.js')
    const host = fakeMain()
    mains.push(host)
    st.waitRegistered.mockResolvedValueOnce(false)
    st.tunnelLogTail.mockReturnValueOnce('Failed to dial a quic connection')
    let r = await host.handle['liveShare:start'](null, { projects: ['ws-1'] })
    expect(r.ok).toBe(false)
    expect(r.error).toBe(
      'The Cloudflare tunnel could not connect (Failed to dial a quic connection). Check your internet connection, or whether a firewall or an antivirus blocks Cloudflare.'
    )
    st.waitReachable.mockImplementationOnce(async (_url, { onFail }) => {
      onFail('ENOTFOUND')
      onFail('HTTP 530')
      onFail('ENOTFOUND')
      return false
    })
    r = await host.handle['liveShare:start'](null, { projects: ['ws-1'] })
    expect(r.error).toBe(
      'The tunnel address could not be reached (ENOTFOUND ×2, HTTP 530). Check your internet connection, or whether a firewall, an antivirus or a DNS filter blocks trycloudflare.com.'
    )
    expect(host.last('liveShare:host')).toMatchObject({ state: 'error' })
  })

  it('says why a share could not start, in the user’s language', async () => {
    const host = fakeMain()
    mains.push(host)
    const err = new Error('timeout')
    err.code = 'timeout'
    tunnel.startError = err
    const r = await host.handle['liveShare:start'](null, { projects: ['ws-1'] })
    expect(r).toEqual({ ok: false, error: 'Cloudflare did not give a tunnel address in time. Try again.' })
    expect(host.last('liveShare:host')).toMatchObject({ state: 'error', error: 'Cloudflare did not give a tunnel address in time. Try again.' })
  })
})

describe('registerLiveShare: a restart keeps the share and the session', () => {
  const mains = []
  afterEach(() => {
    for (const m of mains.splice(0)) m.api.stopAll()
  })

  async function shareAndJoin() {
    const host = fakeMain()
    const guest = fakeMain()
    mains.push(host, guest)
    const started = await host.handle['liveShare:start'](null, { name: 'Ada', projects: ['ws-7'] })
    showLayout(host, { project: 'site', tree: leaf('pane-1-ps', { title: 'PowerShell' }), activeId: 'pane-1-ps' }, 'ws-7')
    await guest.handle['liveShare:join'](null, { invite: codeOf(started), name: 'Alex' })
    const ask = await until(() => host.last('liveShare:ask'))
    await host.handle['liveShare:approve'](null, { guestId: ask.guestId, yes: true, projects: ['ws-7'] })
    await until(() => guest.last('liveShare:guest')?.state === 'joined' && guest.last('liveShare:guest').panes.length)
    await setRights(host, ask.guestId, { ...NO_RIGHTS, type: true, open: false, close: false })
    await until(() => guest.last('liveShare:guest').rights?.type)
    return { host, guest, started }
  }

  it('the host Tessel restarts: the same share comes back, and guests reconnect without a question', async () => {
    const { host, guest, started } = await shareAndJoin()
    expect(host.last('liveShare:host')).toMatchObject({ state: 'sharing', projectIds: ['ws-7'] })
    // An update's restart: the share is kept for the next Tessel.
    host.api.suspend()
    host.api.stopAll() // will-quit: nothing more ends
    await until(() => guest.last('liveShare:guest').state === 'reconnecting')
    expect(guest.last('liveShare:guest').panes).toHaveLength(1)
    // The next Tessel, same data folder.
    const next = fakeMain({ dataDir: host.dataDir, resume: true })
    mains.push(next)
    expect(await next.api.resumed).toEqual([true, false])
    const back = next.last('liveShare:host')
    expect(back).toMatchObject({ state: 'sharing', projectIds: ['ws-7'] })
    expect(codeOf(back)).toBe(codeOf(started))
    showLayout(next, { project: 'site', tree: leaf('pane-1-ps', { title: 'PowerShell' }), activeId: 'pane-1-ps' }, 'ws-7')
    const rejoined = await until(() => guest.events('liveShare:guest').find((s, i, all) => s.state === 'joined' && all.slice(0, i).some((x) => x.state === 'reconnecting') && s.panes.length), 15000)
    expect(rejoined.rights).toEqual({ ...NO_RIGHTS, type: true, open: false, close: false })
    // Its panes start again (a new terminal in the window: gen).
    expect(rejoined.panes[0].gen).toBe(1)
    expect(next.events('liveShare:ask')).toEqual([])
    await until(() => next.last('liveShare:host').guests.some((g) => g.name === 'Alex' && g.state === 'joined'))
  }, 20000)

  it('a share whose tunnel stopped meanwhile comes back on a new tunnel, with the same invitations', async () => {
    const { host, started } = await shareAndJoin()
    host.api.suspend()
    tunnel.alive = false
    const next = fakeMain({ dataDir: host.dataDir, resume: true })
    mains.push(next)
    expect(await next.api.resumed).toEqual([true, false])
    const back = (await next.handle['liveShare:state']()).host
    expect(back.state).toBe('sharing')
    expect(back.invites.map((i) => i.id)).toEqual(started.invites.map((i) => i.id))
    expect(decodeInvite(codeOf(back)).secret.equals(decodeInvite(codeOf(started)).secret)).toBe(true)
  })

  it('Stop sharing ends the share for good (nothing taken back); quitting only pauses it', async () => {
    const { host } = await shareAndJoin()
    await host.handle['liveShare:stop']()
    const next = fakeMain({ dataDir: host.dataDir, resume: true })
    mains.push(next)
    expect(await next.api.resumed).toEqual([false, false])
    const other = await shareAndJoin()
    other.host.api.stopAll()
    const after = fakeMain({ dataDir: other.host.dataDir, resume: true })
    mains.push(after)
    expect((await after.api.resumed)[0]).toBe(true)
  })

  it('the guest Tessel restarts: it joins the session again by itself, without a question', async () => {
    const { host, guest } = await shareAndJoin()
    guest.api.suspend()
    await until(() => host.last('liveShare:host').guests.length === 0)
    const next = fakeMain({ dataDir: guest.dataDir, resume: true })
    mains.push(next)
    expect(await next.api.resumed).toEqual([false, true])
    const joined = await until(() => next.events('liveShare:guest').find((s) => s.state === 'joined' && s.panes.length))
    expect(joined.rights).toEqual({ ...NO_RIGHTS, type: true, open: false, close: false })
    expect(host.events('liveShare:ask')).toHaveLength(1)
  })

  it('a guest who leaves is gone for good: no session taken back', async () => {
    const { guest } = await shareAndJoin()
    await guest.handle['liveShare:leave']()
    const next = fakeMain({ dataDir: guest.dataDir, resume: true })
    mains.push(next)
    expect(await next.api.resumed).toEqual([false, false])
  })

  it('an update that did not install: the share comes back at once', async () => {
    const { host, started } = await shareAndJoin()
    const before = host.events('liveShare:host').length
    host.api.suspend()
    host.api.unsuspend()
    await until(() => host.events('liveShare:host').length > before && host.last('liveShare:host').state === 'sharing')
    expect(codeOf(host.last('liveShare:host'))).toBe(codeOf(started))
  })
})

describe('registerLiveShare: invite codes', () => {
  const mains = []
  afterEach(() => {
    for (const m of mains.splice(0)) m.api.stopAll()
  })

  it('a new code: the old one lets no one in any more, and it works for an hour', async () => {
    const host = fakeMain()
    const late = fakeMain()
    const fresh = fakeMain()
    mains.push(host, late, fresh)
    const started = await host.handle['liveShare:start'](null, { projects: ['ws-1'] })
    showLayout(host, { tree: leaf('pane-1-ps') })
    const first = started.invites[0]
    expect(first.expiresAt).toBeGreaterThan(Date.now() + 59 * 60 * 1000)
    expect(await host.handle['liveShare:rotateInvite'](null, { id: first.id })).toEqual({ ok: true })
    const renewed = host.last('liveShare:host').invites[0]
    expect(renewed).toMatchObject({ id: first.id, label: first.label, projects: ['ws-1'] })
    expect(renewed.code).not.toBe(first.code)

    await late.handle['liveShare:join'](null, { invite: first.code, name: 'Late' })
    await until(() => late.last('liveShare:guest')?.state === 'ended')
    expect(late.last('liveShare:guest').reason).toBe('expired')

    await fresh.handle['liveShare:join'](null, { invite: renewed.code, name: 'Fresh' })
    await until(() => host.events('liveShare:ask').some((q) => q.name === 'Fresh'))
    expect(host.events('liveShare:ask').some((q) => q.name === 'Late')).toBe(false)

    await host.handle['liveShare:stop']()
    expect(await host.handle['liveShare:rotateInvite'](null, { id: first.id })).toEqual({ ok: false, reason: 'not-sharing' })
  })
})

describe('visibleScreen', () => {
  it('keeps the screen as it is, without the scrollback above it', async () => {
    let history = ''
    for (let i = 1; i <= 30; i++) history += `secret line ${i}\r\n`
    const screen = await visibleScreen(history + 'PS> ', 40, 5)
    expect(screen).toBe('secret line 27\r\nsecret line 28\r\nsecret line 29\r\nsecret line 30\r\nPS> ')
    expect(screen).not.toContain('secret line 26')
  })

  it('keeps the colours on screen', async () => {
    const screen = await visibleScreen('old\r\n\x1b[31mred\x1b[0m\r\nok', 20, 3)
    expect(screen).toContain('\x1b[31mred')
    expect(screen.endsWith('ok')).toBe(true)
  })

  it('under a full-screen program, only its screen: not the normal screen hidden under it', async () => {
    const screen = await visibleScreen('SECRET-BEFORE-JOIN\r\n\x1b[?1049h\x1b[HVISIBLE-TUI', 80, 24)
    expect(screen).not.toContain('SECRET-BEFORE-JOIN')
    expect(screen.startsWith('\x1b[?1049h\x1b[H')).toBe(true)
    expect(screen).toContain('VISIBLE-TUI')
    // Back from it: the normal screen again.
    const after = await visibleScreen('SECRET\r\n\x1b[?1049h\x1b[HTUI\x1b[?1049lprompt', 80, 24)
    expect(after).toContain('SECRET')
    expect(after).not.toContain('TUI')
  })

  it('is nothing for nothing', async () => {
    expect(await visibleScreen('', 80, 24)).toBe('')
    expect(await visibleScreen(null, 80, 24)).toBe('')
  })
})

describe('registerLiveShare: taking a share back, carefully', () => {
  const mains = []
  afterEach(() => {
    for (const m of mains.splice(0)) m.api.stopAll()
  })

  async function shared() {
    const host = fakeMain()
    mains.push(host)
    await host.handle['liveShare:start'](null, { name: 'Ada', projects: ['ws-1'] })
    showLayout(host, { project: 'site', tree: leaf('pane-1-ps'), activeId: 'pane-1-ps' })
    host.api.suspend()
    return host
  }

  it('waits to be asked (Tessel asks once it is the only copy running)', async () => {
    const host = await shared()
    const next = fakeMain({ dataDir: host.dataDir })
    mains.push(next)
    expect(await next.api.resumed).toEqual([false, false])
    expect((await next.handle['liveShare:state']()).host.state).toBe('off')
    expect(await next.api.resume()).toEqual([true, false])
    expect((await next.handle['liveShare:state']()).host.state).toBe('sharing')
  })

  it('Stop while it is being taken back: it stays stopped, and its tunnel ends', async () => {
    const host = await shared()
    let release
    tunnel.gate = new Promise((r) => (release = r))
    const next = fakeMain({ dataDir: host.dataDir })
    mains.push(next)
    const taking = next.api.resume()
    await next.handle['liveShare:stop']()
    // Forgotten at once (Tessel may be gone before the check ends).
    expect(fs.existsSync(join(host.dataDir, 'liveshare-host.json'))).toBe(false)
    release()
    expect(await taking).toEqual([false, false])
    expect((await next.handle['liveShare:state']()).host.state).toBe('off')
    const { stopTunnelPid } = await import('../liveShare/shareTunnel.js')
    expect(stopTunnelPid).toHaveBeenCalledWith(host.dataDir, 4242, expect.objectContaining({ queryState: expect.any(Function) }))
    // Nothing left to take back.
    const third = fakeMain({ dataDir: host.dataDir, resume: true })
    mains.push(third)
    expect(await third.api.resumed).toEqual([false, false])
  })

  it('quitting while it is being taken back: let go, kept for the next Tessel', async () => {
    const host = await shared()
    let release
    tunnel.gate = new Promise((r) => (release = r))
    const next = fakeMain({ dataDir: host.dataDir })
    mains.push(next)
    const taking = next.api.resume()
    next.api.stopAll()
    release()
    expect(await taking).toEqual([false, false])
    expect(fs.existsSync(join(host.dataDir, 'liveshare-host.json'))).toBe(true)
    const third = fakeMain({ dataDir: host.dataDir, resume: true })
    mains.push(third)
    expect(await third.api.resumed).toEqual([true, false])
  })

  it('a share saved hours ago is taken back (a share has no age)', async () => {
    const host = await shared()
    const file = join(host.dataDir, 'liveshare-host.json')
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    fs.writeFileSync(file, JSON.stringify({ ...saved, savedAt: Date.now() - 3 * 24 * 60 * 60 * 1000 }))
    const next = fakeMain({ dataDir: host.dataDir, resume: true })
    mains.push(next)
    expect(await next.api.resumed).toEqual([true, false])
  })

  it('a saved share that can not be read is deleted (with the secrets it holds)', async () => {
    const dir = newDataDir()
    const file = join(dir, 'liveshare-host.json')
    fs.writeFileSync(file, JSON.stringify({ v: 1, savedAt: Date.now() - 60 * 60 * 1000, secret: 'x', url: 'ws://127.0.0.1:1/', port: 1, pid: 4242 }))
    const next = fakeMain({ dataDir: dir, resume: true })
    mains.push(next)
    expect(await next.api.resumed).toEqual([false, false])
    expect(fs.existsSync(file)).toBe(false)
  })

  it('lists guests let in who are offline, and Remove keeps one out for good', async () => {
    const host = fakeMain()
    const guest = fakeMain()
    mains.push(host, guest)
    const started = await host.handle['liveShare:start'](null, { name: 'Ada', projects: ['ws-1'] })
    showLayout(host, { project: 'site', tree: leaf('pane-1-ps'), activeId: 'pane-1-ps' })
    await guest.handle['liveShare:join'](null, { invite: codeOf(started), name: 'Alex' })
    const ask = await until(() => host.last('liveShare:ask'))
    await host.handle['liveShare:approve'](null, { guestId: ask.guestId, yes: true, projects: ['ws-1'] })
    await until(() => guest.last('liveShare:guest')?.state === 'joined')
    // Its Tessel restarts: offline on the host's side.
    guest.api.suspend()
    const offline = await until(() => host.last('liveShare:host').offline?.find((g) => g.name === 'Alex'))
    expect(offline.id).toMatch(/^k-[0-9a-f]{24}$/)
    expect(await host.handle['liveShare:removeGuest'](null, { guestId: offline.id })).toEqual({ ok: true })
    expect(host.last('liveShare:host').offline).toEqual([])
    // It comes back: turned away, no question.
    const next = fakeMain({ dataDir: guest.dataDir, resume: true })
    mains.push(next)
    await next.api.resumed
    await until(() => next.last('liveShare:guest')?.state === 'ended')
    expect(next.last('liveShare:guest').reason).toBe('rejoin-refused')
    expect(host.events('liveShare:ask')).toHaveLength(1)
  })

  it('Windows not saying what the PID is: taken back while it runs, never killed on a guess', async () => {
    const host = await shared()
    tunnel.state = 'unknown'
    const next = fakeMain({ dataDir: host.dataDir })
    mains.push(next)
    expect(await next.api.resume()).toEqual([true, false])
    // Its PID running and Windows still not saying: the share goes on.
    expect((await next.handle['liveShare:state']()).host.state).toBe('sharing')
  }, 15000)

  it('a PID that is now another program: never killed; the share comes back on a new tunnel', async () => {
    const host = await shared()
    tunnel.state = 'other'
    const next = fakeMain({ dataDir: host.dataDir })
    mains.push(next)
    const { stopTunnelPid } = await import('../liveShare/shareTunnel.js')
    stopTunnelPid.mockClear()
    expect(await next.api.resume()).toEqual([true, false])
    expect(stopTunnelPid).not.toHaveBeenCalled()
    expect((await next.handle['liveShare:state']()).host.state).toBe('sharing')
  })

  it('an update starting while a share is being taken back: it lets go and keeps the saved share', async () => {
    const host = await shared()
    let release
    tunnel.gate = new Promise((r) => (release = r))
    const next = fakeMain({ dataDir: host.dataDir })
    mains.push(next)
    const taking = next.api.resume()
    next.api.suspend()
    release()
    expect(await taking).toEqual([false, false])
    expect(fs.existsSync(join(host.dataDir, 'liveshare-host.json'))).toBe(true)
    // The next Tessel takes it back.
    const third = fakeMain({ dataDir: host.dataDir, resume: true })
    mains.push(third)
    expect(await third.api.resumed).toEqual([true, false])
  })

  it('quitting before a session is joined again: it is not joined now, and kept for the next Tessel', async () => {
    const host = fakeMain()
    const guest = fakeMain()
    mains.push(host, guest)
    const started = await host.handle['liveShare:start'](null, { name: 'Ada', projects: ['ws-1'] })
    showLayout(host, { project: 'site', tree: leaf('pane-1-ps'), activeId: 'pane-1-ps' })
    await guest.handle['liveShare:join'](null, { invite: codeOf(started), name: 'Alex' })
    const ask = await until(() => host.last('liveShare:ask'))
    await host.handle['liveShare:approve'](null, { guestId: ask.guestId, yes: true, projects: ['ws-1'] })
    await until(() => guest.last('liveShare:guest')?.state === 'joined')
    guest.api.suspend()
    const next = fakeMain({ dataDir: guest.dataDir })
    mains.push(next)
    const taking = next.api.resume()
    next.api.stopAll()
    expect(await taking).toEqual([false, false])
    expect(fs.existsSync(join(guest.dataDir, 'liveshare-guest.json'))).toBe(true)
    expect(next.events('liveShare:guest').some((x) => x.state === 'connecting')).toBe(false)
  })
})

describe('registerLiveShare: round 5', () => {
  const mains = []
  afterEach(() => {
    for (const m of mains.splice(0)) m.api.stopAll()
  })

  async function joinedPair(tree = leaf('pane-1-ps')) {
    const host = fakeMain()
    const guest = fakeMain()
    mains.push(host, guest)
    const started = await host.handle['liveShare:start'](null, { name: 'Ada', projects: ['ws-1'] })
    showLayout(host, { project: 'site', tree, activeId: 'pane-1-ps' })
    await guest.handle['liveShare:join'](null, { invite: codeOf(started), name: 'Alex' })
    const ask = await until(() => host.last('liveShare:ask'))
    await host.handle['liveShare:approve'](null, { guestId: ask.guestId, yes: true, projects: ['ws-1'] })
    await until(() => guest.last('liveShare:guest')?.state === 'joined' && guest.last('liveShare:guest').panes.length)
    return { host, guest }
  }

  it('an update starting before the session is joined again: the saved session is kept for the next Tessel', async () => {
    const { guest } = await joinedPair()
    guest.api.suspend()
    const next = fakeMain({ dataDir: guest.dataDir })
    mains.push(next)
    const taking = next.api.resume()
    next.api.suspend()
    expect(await taking).toEqual([false, false])
    expect(fs.existsSync(join(guest.dataDir, 'liveshare-guest.json'))).toBe(true)
    const third = fakeMain({ dataDir: guest.dataDir, resume: true })
    mains.push(third)
    expect(await third.api.resumed).toEqual([false, true])
  })

  it('a pane the host stops showing and shows again is a new terminal in the guest window (its gen goes on)', async () => {
    const { host, guest } = await joinedPair({ type: 'split', dir: 'row', sizes: [50, 50], children: [leaf('pane-1-ps'), leaf('pane-2-ps')] })
    const gens = () => Object.fromEntries((guest.last('liveShare:guest').panes || []).map((p) => [p.title, p.gen]))
    expect(gens()).toEqual({ 'pane-1-ps': 0, 'pane-2-ps': 0 })
    showLayout(host, { project: 'site', tree: leaf('pane-2-ps'), activeId: 'pane-2-ps' })
    await until(() => guest.last('liveShare:guest').panes.length === 1)
    showLayout(host, { project: 'site', tree: { type: 'split', dir: 'row', sizes: [50, 50], children: [leaf('pane-1-ps'), leaf('pane-2-ps')] }, activeId: 'pane-1-ps' })
    await until(() => guest.last('liveShare:guest').panes.length === 2)
    expect(gens()).toEqual({ 'pane-1-ps': 1, 'pane-2-ps': 0 })
  })
})

describe('registerLiveShare: several projects shared', () => {
  const mains = []
  afterEach(() => {
    for (const m of mains.splice(0)) m.api.stopAll()
  })

  // The host window's layouts of its shared projects: id -> pane ids.
  const showLayouts = (m, projects) =>
    m.on['liveShare:layouts'](
      null,
      Object.entries(projects).map(([id, ids]) => ({ id, layout: { project: `name of ${id}`, tree: ids.length ? { type: 'split', dir: 'row', sizes: ids.map(() => 100 / ids.length), children: ids.map((x) => leaf(x)) } : null, activeId: ids[0] || null } }))
    )
  const status = (m) => m.last('liveShare:guest')
  const projectIds = (m) => (status(m)?.projects || []).map((p) => p.id)

  // A host sharing ws-1 (pane-1-a) and ws-2 (pane-2-b); a guest let in with
  // the projects given (both by default).
  async function sharing({ projects = ['ws-1', 'ws-2'] } = {}) {
    const host = fakeMain()
    const guest = fakeMain()
    mains.push(host, guest)
    const started = await host.handle['liveShare:start'](null, { name: 'Ada', projects: ['ws-1', 'ws-2', 'ws-2', 'bad id'] })
    expect(started.projectIds).toEqual(['ws-1', 'ws-2'])
    showLayouts(host, { 'ws-1': ['pane-1-a'], 'ws-2': ['pane-2-b'] })
    await guest.handle['liveShare:join'](null, { invite: codeOf(started), name: 'Alex' })
    const ask = await until(() => host.last('liveShare:ask'))
    await host.handle['liveShare:approve'](null, { guestId: ask.guestId, yes: true, projects })
    await until(() => status(guest)?.state === 'joined' && status(guest).projects.length)
    return { host, guest, ask, started }
  }

  it('lets a guest in with the projects ticked, and sends it only theirs', async () => {
    const { host, guest, ask } = await sharing({ projects: ['ws-2'] })
    expect(projectIds(guest)).toEqual(['ws-2'])
    expect(status(guest).panes.map((p) => [p.id, p.project])).toEqual([['pane-ls1-2-b', 'ws-2']])
    expect(status(guest).projects[0].layout).toMatchObject({ project: 'name of ws-2', activeId: 'pane-ls1-2-b' })
    expect(host.last('liveShare:host').guests.find((g) => g.id === ask.guestId).projects).toEqual(['ws-2'])
    expect(await guest.api.guestAttach('pane-ls1-2-b')).toMatchObject({ ok: true, buffer: 'screen of pane-2-b' })
    host.api.onPtyData('pane-1-a', 'SECRET-OF-WS-1\r\n')
    host.api.onPtyData('pane-2-b', 'ok\r\n')
    await until(() => guest.data.length)
    await new Promise((r) => setTimeout(r, 40))
    expect(guest.data).toEqual([['pane-ls1-2-b', 'ok\r\n']])
    expect(guest.api.isGuestPane('pane-ls1-1-a')).toBe(false)
    // Opening goes to a project it sees, only.
    await setRights(host, ask.guestId, ALL)
    await until(() => status(guest).rights?.open)
    expect(await guest.handle['liveShare:open'](null, { kind: 'terminal', project: 'ws-1' })).toEqual({ ok: false, reason: 'project' })
    expect(await guest.handle['liveShare:open'](null, { kind: 'terminal', project: 'ws-2' })).toEqual({ ok: true, asked: false })
    await until(() => host.events('liveShare:hostRequest').length)
    expect(host.events('liveShare:hostRequest')).toEqual([{ action: 'open', request: expect.any(String), spec: { kind: 'terminal', project: 'ws-2' }, guest: expect.objectContaining({ name: 'Alex', projects: ['ws-2'] }) }])
  })

  it('adds and takes out projects on the spot; the last one stays', async () => {
    const { host, guest, ask } = await sharing()
    expect(projectIds(guest)).toEqual(['ws-1', 'ws-2'])
    // Taken out: gone for the guest at once, its output stops.
    expect(await host.handle['liveShare:share'](null, { id: 'ws-2', shared: false })).toEqual({ ok: true, projectIds: ['ws-1'] })
    host.api.onPtyData('pane-2-b', 'PRIVATE-AFTER-REMOVAL\r\n')
    await until(() => projectIds(guest).join() === 'ws-1')
    expect(guest.api.isGuestPane('pane-ls1-2-b')).toBe(false)
    expect(host.last('liveShare:host').projectIds).toEqual(['ws-1'])
    expect(host.last('liveShare:host').guests.find((g) => g.id === ask.guestId).projects).toEqual(['ws-1'])
    // The last one stays.
    expect(await host.handle['liveShare:share'](null, { id: 'ws-1', shared: false })).toEqual({ ok: false, reason: 'last' })
    // Added: not given to a guest already in (the window sends its layout
    // once it is shared).
    expect(await host.handle['liveShare:share'](null, { id: 'ws-3', shared: true })).toEqual({ ok: true, projectIds: ['ws-1', 'ws-3'] })
    showLayouts(host, { 'ws-1': ['pane-1-a'], 'ws-3': ['pane-3-c'] })
    expect(await host.handle['liveShare:share'](null, { id: 'ws-3', shared: true })).toEqual({ ok: true, projectIds: ['ws-1', 'ws-3'] })
    expect(await host.handle['liveShare:share'](null, { id: '../x', shared: true })).toEqual({ ok: false })
    host.api.onPtyData('pane-3-c', 'NOT-GIVEN\r\n')
    await new Promise((r) => setTimeout(r, 120))
    expect(projectIds(guest)).toEqual(['ws-1'])
    // Given: there at once.
    expect(await setProjects(host, ask.guestId, ['ws-1', 'ws-3', 'ws-2'])).toEqual({ ok: true })
    await until(() => projectIds(guest).join() === 'ws-1,ws-3')
    expect(await guest.api.guestAttach('pane-ls1-3-c')).toMatchObject({ ok: true, buffer: 'screen of pane-3-c' })
    expect(guest.data.some(([, d]) => /PRIVATE|NOT-GIVEN/.test(d))).toBe(false)
    expect(await setProjects(host, 'g-unknown', ['ws-1'])).toEqual({ ok: false })
  })

  it('a pane moved to another project is checked again: gone for a guest without it, a new terminal for one with it', async () => {
    const { host, guest, ask } = await sharing({ projects: ['ws-1'] })
    await setRights(host, ask.guestId, ALL)
    await until(() => status(guest).rights?.type)
    showLayouts(host, { 'ws-1': ['pane-1-a', 'pane-1-x'], 'ws-2': ['pane-2-b'] })
    await until(() => status(guest).panes.length === 2)
    // pane-1-x moves to ws-2, which the guest does not see.
    showLayouts(host, { 'ws-1': ['pane-1-a'], 'ws-2': ['pane-2-b', 'pane-1-x'] })
    guest.api.guestWrite('pane-ls1-1-x', 'too late\r')
    host.api.onPtyData('pane-1-x', 'PRIVATE-AFTER-MOVE\r\n')
    await until(() => status(guest).panes.length === 1)
    await new Promise((r) => setTimeout(r, 40))
    expect(host.hostWrites).toEqual([])
    expect(guest.data.some(([, d]) => d.includes('PRIVATE'))).toBe(false)
    // Given ws-2 too, then pane-1-a moves there: a new terminal (its gen goes on), in ws-2.
    await setProjects(host, ask.guestId, ['ws-1', 'ws-2'])
    await until(() => status(guest).panes.length === 3)
    showLayouts(host, { 'ws-1': [], 'ws-2': ['pane-2-b', 'pane-1-x', 'pane-1-a'] })
    const moved = await until(() => status(guest).panes.find((p) => p.id === 'pane-ls1-1-a' && p.project === 'ws-2'))
    expect(moved.gen).toBe(1)
    expect(await guest.api.guestAttach('pane-ls1-1-a')).toMatchObject({ ok: true, buffer: 'screen of pane-1-a' })
  })

  it('a restart keeps the projects shared and what each guest sees', async () => {
    const { host, guest } = await sharing({ projects: ['ws-2'] })
    host.api.suspend()
    host.api.stopAll()
    await until(() => status(guest).state === 'reconnecting')
    const saved = JSON.parse(fs.readFileSync(join(host.dataDir, 'liveshare-host.json'), 'utf8'))
    expect(saved.projectIds).toEqual(['ws-1', 'ws-2'])
    expect(saved.format).toBe(2)
    expect(saved.access.people.map((k) => k.grant.projects)).toEqual([['ws-2']])
    expect(saved.secret).toBeUndefined()
    const next = fakeMain({ dataDir: host.dataDir, resume: true })
    mains.push(next)
    expect(await next.api.resumed).toEqual([true, false])
    expect(next.last('liveShare:host').projectIds).toEqual(['ws-1', 'ws-2'])
    showLayouts(next, { 'ws-1': ['pane-1-a'], 'ws-2': ['pane-2-b'] })
    await until(() => guest.events('liveShare:guest').some((s, i, all) => s.state === 'joined' && all.slice(0, i).some((x) => x.state === 'reconnecting') && s.panes.length), 15000)
    expect(projectIds(guest)).toEqual(['ws-2'])
    expect(status(guest).panes.map((p) => p.id)).toEqual(['pane-ls1-2-b'])
  }, 20000)

  it('a share saved before invitations (one code, one project) is taken back: its code still works, its guests come back with what they saw', async () => {
    // What an earlier Tessel saved: one secret at the address itself, one
    // projectId, a guest let in without projects.
    const dataDir = newDataDir()
    const guestDir = newDataDir()
    const port = await freePort()
    const secret = newSecret()
    const hostKey = newSigningKey()
    const guestKey = newSigningKey()
    const url = `ws://127.0.0.1:${port}/`
    fs.writeFileSync(
      join(dataDir, 'liveshare-host.json'),
      JSON.stringify({
        v: 1,
        savedAt: Date.now(),
        secret: secret.toString('base64'),
        url,
        port,
        pid: 4242,
        hostName: 'Ada',
        hostKey: exportSigningKey(hostKey),
        expiresAt: Date.now() + 30 * 60 * 1000,
        projectId: 'ws-1',
        known: [{ key: guestKey.publicRaw.toString('base64'), name: 'Alex', rights: { ...NO_RIGHTS, type: true, open: false, close: false }, sid: secretId(secret), opened: 2, lastSeen: Date.now() }],
        secrets: [],
        guard: { blocked: false, unfinished: [] }
      })
    )
    // The guest's own saved session: the old code, its reconnect key.
    const code = encodeInvite({ url, secret })
    fs.writeFileSync(join(guestDir, 'liveshare-guest.json'), JSON.stringify({ v: 1, savedAt: Date.now(), invite: code, name: 'Alex', key: exportSigningKey(guestKey), hostKey: hostKey.publicRaw.toString('base64') }))
    const host = fakeMain({ dataDir, resume: true })
    mains.push(host)
    expect(await host.api.resumed).toEqual([true, false])
    const back = host.last('liveShare:host')
    expect(back.projectIds).toEqual(['ws-1'])
    // Its one code is a root invitation, offering every shared project.
    expect(back.invites).toEqual([expect.objectContaining({ root: true, projects: ['ws-1'], later: true, state: 'live' })])
    // The same code (now TS2: the same address and secret, with the share's key).
    const now = decodeInvite(back.invites[0].code)
    expect(now.url).toBe(url)
    expect(now.secret.equals(secret)).toBe(true)
    expect(now.hostKey.equals(hostKey.publicRaw)).toBe(true)
    showLayouts(host, { 'ws-1': ['pane-1-a'] })
    const guest = fakeMain({ dataDir: guestDir, resume: true })
    mains.push(guest)
    expect(await guest.api.resumed).toEqual([false, true])
    const joined = await until(() => status(guest)?.state === 'joined' && status(guest).panes.length && status(guest))
    expect(projectIds(guest)).toEqual(['ws-1'])
    expect(joined.rights).toEqual({ ...NO_RIGHTS, type: true, open: false, close: false })
    expect(host.events('liveShare:ask')).toEqual([])
    // A new guest with the old code still gets in (with the host's yes).
    const late = fakeMain()
    mains.push(late)
    await late.handle['liveShare:join'](null, { invite: code, name: 'Bea' })
    const ask = await until(() => host.last('liveShare:ask'))
    expect(ask).toMatchObject({ name: 'Bea', invite: { id: back.invites[0].id, label: '' }, offer: { projects: ['ws-1'], rights: { ...NO_RIGHTS, type: false, open: false, close: false } } })
    // Saved again in the new form.
    const saved = JSON.parse(fs.readFileSync(join(dataDir, 'liveshare-host.json'), 'utf8'))
    expect(saved.format).toBe(2)
    expect(saved.access.people).toEqual([expect.objectContaining({ name: 'Alex', opened: 2, grant: { projects: ['ws-1'], rights: { ...NO_RIGHTS, type: true, open: false, close: false } } })])
  }, 20000)

  it('a layout of a project not shared is never sent, and one the window stops sending keeps its last layout', async () => {
    const { host, guest } = await sharing()
    showLayouts(host, { 'ws-1': ['pane-1-a'], 'ws-2': ['pane-2-b'], 'ws-9': ['pane-9-z'] })
    host.api.onPtyData('pane-9-z', 'NOT-SHARED\r\n')
    await new Promise((r) => setTimeout(r, 120))
    expect(projectIds(guest)).toEqual(['ws-1', 'ws-2'])
    expect(guest.data.some(([, d]) => d.includes('NOT-SHARED'))).toBe(false)
    // Only ws-1 sent (ws-2 not found yet in the window): ws-2 stays as it was.
    showLayouts(host, { 'ws-1': ['pane-1-a', 'pane-1-n'] })
    await until(() => status(guest).panes.length === 3)
    expect(projectIds(guest)).toEqual(['ws-1', 'ws-2'])
  })

  it('keeps no layout of a project not shared (none sent before the share either), so sharing it later shows nothing old', async () => {
    const host = fakeMain()
    const guest = fakeMain()
    mains.push(host, guest)
    showLayouts(host, { 'ws-1': ['pane-1-early'] })
    const started = await host.handle['liveShare:start'](null, { name: 'Ada', projects: ['ws-1'] })
    await guest.handle['liveShare:join'](null, { invite: codeOf(started), name: 'Alex' })
    const ask = await until(() => host.last('liveShare:ask'))
    await host.handle['liveShare:approve'](null, { guestId: ask.guestId, yes: true, projects: ['ws-1'] })
    await until(() => status(guest)?.state === 'joined' && status(guest).projects.length)
    await new Promise((r) => setTimeout(r, 60))
    expect(status(guest).panes).toEqual([])
    showLayouts(host, { 'ws-1': ['pane-1-a'], 'ws-9': ['pane-9-z'] })
    await until(() => status(guest).panes.length)
    expect(status(guest).panes.map((p) => p.id)).toEqual(['pane-ls1-1-a'])
    // ws-9 shared now: its layout sent while it was not shared is not there.
    expect(await host.handle['liveShare:share'](null, { id: 'ws-9', shared: true })).toMatchObject({ ok: true })
    await host.handle['liveShare:access'](null, { subject: ask.guestId, project: 'ws-9', on: true })
    await until(() => projectIds(guest).join() === 'ws-1,ws-9')
    expect(status(guest).panes.map((p) => p.id)).toEqual(['pane-ls1-1-a'])
  })

  it('an answer without a list of projects lets the guest in with none, never every shared one', async () => {
    const host = fakeMain()
    const guest = fakeMain()
    mains.push(host, guest)
    const started = await host.handle['liveShare:start'](null, { name: 'Ada', projects: ['ws-1', 'ws-2'] })
    showLayouts(host, { 'ws-1': ['pane-1-a'], 'ws-2': ['pane-2-b'] })
    await guest.handle['liveShare:join'](null, { invite: codeOf(started), name: 'Alex' })
    const ask = await until(() => host.last('liveShare:ask'))
    expect(await host.handle['liveShare:approve'](null, { guestId: ask.guestId, yes: true })).toEqual({ ok: true })
    await until(() => status(guest)?.state === 'joined')
    await new Promise((r) => setTimeout(r, 60))
    expect(projectIds(guest)).toEqual([])
    expect(status(guest).panes).toEqual([])
    expect(host.last('liveShare:host').guests.find((g) => g.id === ask.guestId).projects).toEqual([])
  })

  it('changes one project or one right at a time: two in a row never undo each other; a guest offline changes too, and comes back with it', async () => {
    const { host, guest, ask } = await sharing()
    // Both clicked before the window heard back (it still showed ws-1 and
    // ws-2): each one made against what the guest has then.
    const answers = await Promise.all([
      host.handle['liveShare:access'](null, { subject: ask.guestId, project: 'ws-1', on: false }),
      host.handle['liveShare:access'](null, { subject: ask.guestId, project: 'ws-2', on: true })
    ])
    expect(answers).toEqual([{ ok: true }, { ok: true }])
    await until(() => projectIds(guest).join() === 'ws-2')
    expect(host.last('liveShare:host').guests.find((g) => g.id === ask.guestId).projects).toEqual(['ws-2'])
    await host.handle['liveShare:access'](null, { subject: ask.guestId, right: 'type', on: true })
    await host.handle['liveShare:access'](null, { subject: ask.guestId, right: 'close', on: true })
    await until(() => status(guest).rights?.close)
    expect(status(guest).rights).toEqual({ ...NO_RIGHTS, type: true, open: false, close: true })
    expect(await host.handle['liveShare:access'](null, { subject: ask.guestId, right: '__proto__', on: true })).toEqual({ ok: false })
    expect(await host.handle['liveShare:access'](null, { subject: ask.guestId, project: 'ws-9', on: true })).toEqual({ ok: false })
    expect(await host.handle['liveShare:access'](null, { subject: 'g-unknown', project: 'ws-1', on: true })).toEqual({ ok: false })
    // Its Tessel restarts: offline, and still changed.
    guest.api.suspend()
    const offline = await until(() => host.last('liveShare:host').offline?.find((g) => g.name === 'Alex'))
    expect(await host.handle['liveShare:access'](null, { subject: offline.id, project: 'ws-2', on: false })).toEqual({ ok: true })
    expect(await host.handle['liveShare:access'](null, { subject: offline.id, project: 'ws-1', on: true })).toEqual({ ok: true })
    expect(await host.handle['liveShare:access'](null, { subject: offline.id, right: 'type', on: false })).toEqual({ ok: true })
    expect(host.last('liveShare:host').offline.find((g) => g.id === offline.id)).toMatchObject({ projects: ['ws-1'], rights: { ...NO_RIGHTS, type: false, open: false, close: true } })
    const next = fakeMain({ dataDir: guest.dataDir, resume: true })
    mains.push(next)
    await next.api.resumed
    const back = await until(() => next.events('liveShare:guest').find((s) => s.state === 'joined' && s.panes.length))
    expect(back.projects.map((p) => p.id)).toEqual(['ws-1'])
    expect(back.rights).toEqual({ ...NO_RIGHTS, type: false, open: false, close: true })
  })
})

describe('registerLiveShare: invitations, trusted people, opening and presence', () => {
  const mains = []
  afterEach(() => {
    for (const m of mains.splice(0)) m.api.stopAll()
  })
  const status = (m) => m.last('liveShare:guest')

  // A host sharing ws-1 (pane-1-a) and ws-2 (pane-2-b).
  async function host(dataDir) {
    const h = fakeMain(dataDir ? { dataDir } : {})
    mains.push(h)
    const started = await h.handle['liveShare:start'](null, { name: 'Ada', projects: ['ws-1', 'ws-2'], invite: { label: 'Simpa', lifetime: 'day', rights: { type: true } } })
    h.on['liveShare:layouts'](null, [
      { id: 'ws-1', layout: { project: 'one', tree: leaf('pane-1-a'), activeId: 'pane-1-a' } },
      { id: 'ws-2', layout: { project: 'two', tree: leaf('pane-2-b'), activeId: 'pane-2-b' } }
    ])
    return { h, started }
  }
  function guestMain(dataDir) {
    const g = fakeMain(dataDir ? { dataDir } : {})
    mains.push(g)
    return g
  }

  it('starting makes the first invitation (its label, lifetime and rights, every shared project); more are made, changed, duplicated, given a new code and revoked, none of their codes logged', async () => {
    const { h, started } = await host()
    expect(started.invites).toEqual([expect.objectContaining({ label: 'Simpa', lifetime: 'day', projects: ['ws-1', 'ws-2'], rights: { ...NO_RIGHTS, type: true, open: false, close: false }, maxUses: 0 })])
    const made = await h.handle['liveShare:createInvite'](null, { label: 'Dev team', lifetime: 'never', maxUses: 5, projects: ['ws-2', 'ws-9'], later: true })
    expect(made).toMatchObject({ ok: true, invite: { label: 'Dev team', lifetime: 'never', expiresAt: null, maxUses: 5, projects: ['ws-2'], later: true } })
    expect(decodeInvite(made.invite.code).url).not.toBe(decodeInvite(codeOf(started)).url)
    expect(await h.handle['liveShare:createInvite'](null, { lifetime: 'never', autoAllow: true })).toEqual({ ok: false, reason: 'auto-allow' })
    expect(await h.handle['liveShare:createInvite'](null, { lifetime: 'year' })).toEqual({ ok: false, reason: 'lifetime' })
    const id = made.invite.id
    expect(await h.handle['liveShare:updateInvite'](null, { id, patch: { label: 'Team', projects: ['ws-1', 'ws-2'] } })).toEqual({ ok: true, applied: 0 })
    const copy = await h.handle['liveShare:duplicateInvite'](null, { id })
    expect(copy.invite).toMatchObject({ label: 'Team', projects: ['ws-1', 'ws-2'], lifetime: 'never' })
    const before = h.last('liveShare:host').invites.find((i) => i.id === id).code
    expect(await h.handle['liveShare:rotateInvite'](null, { id })).toEqual({ ok: true })
    const after = h.last('liveShare:host').invites.find((i) => i.id === id).code
    expect(after).not.toBe(before)
    expect(await h.handle['liveShare:revokeInvite'](null, { id: copy.invite.id })).toEqual({ ok: true, removed: 0 })
    expect(h.last('liveShare:host').invites.map((i) => i.label)).toEqual(['Simpa', 'Team'])
    expect(await h.handle['liveShare:updateInvite'](null, { id: '../x', patch: {} })).toEqual({ ok: false, reason: 'missing' })
    // The log names invitations by id, never by their code, secret or address.
    const log = h.logs.join('\n')
    expect(log).toContain(`invitation ${id}`)
    for (const code of [codeOf(started), made.invite.code, before, after, copy.invite.code]) {
      const { url, secret } = decodeInvite(code)
      expect(log).not.toContain(secret.toString('base64url'))
      expect(log).not.toContain(new URL(url).pathname.slice(3))
    }
  })

  it('the prompt comes with the invitation and its offer; trusted from it, the guest gets in without asking later, in a new share and after this Tessel restarts', async () => {
    const { h, started } = await host()
    const guestDir = newDataDir()
    const g = guestMain(guestDir)
    await g.handle['liveShare:join'](null, { invite: codeOf(started), name: 'Simpa' })
    const ask = await until(() => h.last('liveShare:ask'))
    expect(ask).toMatchObject({ name: 'Simpa', invite: { id: started.invites[0].id, label: 'Simpa' }, offer: { projects: ['ws-1', 'ws-2'], rights: { ...NO_RIGHTS, type: true, open: false, close: false } }, trustable: true })
    await h.handle['liveShare:approve'](null, { guestId: ask.guestId, yes: true, projects: ['ws-1'], rights: { close: true }, trust: true })
    await until(() => status(g)?.state === 'joined' && status(g).panes.length)
    expect(status(g).rights).toEqual({ ...NO_RIGHTS, type: false, open: false, close: true })
    await until(() => h.last('liveShare:host').trusted.some((x) => x.online))
    expect(h.last('liveShare:host').trusted).toEqual([expect.objectContaining({ name: 'Simpa', projects: ['ws-1'], rights: { ...NO_RIGHTS, type: false, open: false, close: true }, online: true })])
    // The guest names its trusted entry.
    await until(() => h.last('liveShare:host').guests.some((x) => x.trusted))
    expect(h.last('liveShare:host').guests.find((x) => x.trusted).trustId).toBe(h.last('liveShare:host').trusted[0].id)
    // Kept in the host's data folder, public keys only; the guest's identity in its own.
    const file = JSON.parse(fs.readFileSync(join(h.dataDir, 'liveshare-trusted.json'), 'utf8'))
    expect(file.trusted).toHaveLength(1)
    const identity = fs.readFileSync(join(guestDir, 'liveshare-identity.json'), 'utf8')
    await g.handle['liveShare:leave']()
    await h.handle['liveShare:stop']()
    // A new share (a new address and code): in without a question.
    const again = await h.handle['liveShare:start'](null, { name: 'Ada', projects: ['ws-1'] })
    h.on['liveShare:layouts'](null, [{ id: 'ws-1', layout: { project: 'one', tree: leaf('pane-1-a'), activeId: 'pane-1-a' } }])
    const asks = h.events('liveShare:ask').length
    await g.handle['liveShare:join'](null, { invite: codeOf(again), name: 'Simpa' })
    await until(() => status(g)?.state === 'joined' && status(g).panes.length)
    expect(h.events('liveShare:ask')).toHaveLength(asks)
    expect(fs.readFileSync(join(guestDir, 'liveshare-identity.json'), 'utf8')).toBe(identity)
    await h.handle['liveShare:stop']()
    // This Tessel restarts (same data folder): trusted still.
    const next = fakeMain({ dataDir: h.dataDir })
    mains.push(next)
    expect((await next.handle['liveShare:state']()).host.trusted).toHaveLength(1)
    const third = await next.handle['liveShare:start'](null, { name: 'Ada', projects: ['ws-1'] })
    next.on['liveShare:layouts'](null, [{ id: 'ws-1', layout: { project: 'one', tree: leaf('pane-1-a'), activeId: 'pane-1-a' } }])
    const g2 = guestMain(guestDir)
    await g2.handle['liveShare:join'](null, { invite: codeOf(third), name: 'Simpa' })
    await until(() => status(g2)?.state === 'joined' && status(g2).panes.length)
    expect(next.events('liveShare:ask')).toEqual([])
    // Not sharing: the trusted list is still edited, and trust taken back.
    await next.handle['liveShare:stop']()
    const tid = (await next.handle['liveShare:state']()).host.trusted[0].id
    expect(await next.handle['liveShare:access'](null, { subject: tid, project: 'ws-7', on: true })).toEqual({ ok: true })
    expect(await next.handle['liveShare:access'](null, { subject: 'k-123', project: 'ws-7', on: true })).toEqual({ ok: false })
    expect(await next.handle['liveShare:renameTrusted'](null, { id: tid, name: 'Simpa (laptop)' })).toEqual({ ok: true })
    expect((await next.handle['liveShare:state']()).host.trusted[0]).toMatchObject({ name: 'Simpa (laptop)', projects: ['ws-1', 'ws-7'] })
    expect(await next.handle['liveShare:untrust'](null, { id: tid })).toEqual({ ok: true })
    expect((await next.handle['liveShare:state']()).host.trusted).toEqual([])
  }, 20000)

  it('removing a trusted guest can also stop trusting it', async () => {
    const { h, started } = await host()
    const g = guestMain()
    await g.handle['liveShare:join'](null, { invite: codeOf(started), name: 'Simpa' })
    const ask = await until(() => h.last('liveShare:ask'))
    await h.handle['liveShare:approve'](null, { guestId: ask.guestId, yes: true, projects: ['ws-1'], trust: true })
    await until(() => h.last('liveShare:host').guests.some((x) => x.trusted && x.state === 'joined'))
    expect(await h.handle['liveShare:removeGuest'](null, { guestId: ask.guestId, untrust: true })).toEqual({ ok: true })
    await until(() => status(g)?.state === 'ended')
    expect(h.last('liveShare:host').trusted).toEqual([])
  })

  it('a guest without the right asks the host to open (the host’s window is asked); with it, it opens; only agents the host lists', async () => {
    const { h, started } = await host()
    // The host's window lists its agents (checked).
    h.on['liveShare:agents'](null, [{ id: 'claude', name: 'Claude Code' }, { id: 'bad id' }, { id: 'codex' }])
    const g = guestMain()
    await g.handle['liveShare:join'](null, { invite: codeOf(started), name: 'Bob' })
    const ask = await until(() => h.last('liveShare:ask'))
    await h.handle['liveShare:approve'](null, { guestId: ask.guestId, yes: true, projects: ['ws-1'] })
    await until(() => status(g)?.state === 'joined' && status(g).agents)
    expect(status(g).agents).toEqual([
      { id: 'claude', name: 'Claude Code' },
      { id: 'codex', name: 'codex' }
    ])
    expect(await g.handle['liveShare:open'](null, { kind: 'agent', agent: 'opencode', project: 'ws-1' })).toEqual({ ok: false, reason: 'agent' })
    expect(await g.handle['liveShare:open'](null, { kind: 'agent', agent: 'claude', project: 'ws-1' })).toEqual({ ok: true, asked: true })
    await until(() => h.events('liveShare:hostRequest').length)
    const asked = h.events('liveShare:hostRequest')
    expect(asked).toEqual([{ action: 'ask-open', request: expect.any(String), spec: { kind: 'agent', agent: 'claude', project: 'ws-1' }, guest: expect.objectContaining({ name: 'Bob' }) }])
    // Its project taken away while the host is asked: the ask is called off.
    await h.handle['liveShare:access'](null, { subject: ask.guestId, project: 'ws-1', on: false })
    await until(() => h.events('liveShare:hostRequest').length === 2)
    expect(h.events('liveShare:hostRequest')[1]).toEqual({ action: 'cancel', request: asked[0].request })
    await h.handle['liveShare:access'](null, { subject: ask.guestId, project: 'ws-1', on: true })
    await until(() => status(g).projects.length === 1)
    await h.handle['liveShare:access'](null, { subject: ask.guestId, right: 'open', on: true })
    await until(() => status(g).rights?.open)
    expect(await g.handle['liveShare:open'](null, { kind: 'terminal', project: 'ws-1' })).toEqual({ ok: true, asked: false })
    await until(() => h.events('liveShare:hostRequest').length === 3)
    const opened = h.events('liveShare:hostRequest')[2]
    expect(opened).toMatchObject({ action: 'open', spec: { kind: 'terminal', project: 'ws-1' } })
    // The window is done with it: taking the right away later calls off nothing.
    h.on['liveShare:requestDone'](null, opened.request)
    await h.handle['liveShare:access'](null, { subject: ask.guestId, right: 'open', on: false })
    await new Promise((r) => setTimeout(r, 60))
    expect(h.events('liveShare:hostRequest')).toHaveLength(3)
  })

  it('a request opened with the right is called off when that right is taken away before the window is done', async () => {
    const { h, started } = await host()
    h.on['liveShare:agents'](null, [{ id: 'claude', name: 'Claude Code' }])
    const g = guestMain()
    await g.handle['liveShare:join'](null, { invite: codeOf(started), name: 'Bob' })
    const ask = await until(() => h.last('liveShare:ask'))
    await h.handle['liveShare:approve'](null, { guestId: ask.guestId, yes: true, projects: ['ws-1'], rights: { open: true } })
    await until(() => status(g)?.state === 'joined' && status(g).rights?.open)
    await g.handle['liveShare:open'](null, { kind: 'agent', agent: 'claude', project: 'ws-1' })
    const req = await until(() => h.last('liveShare:hostRequest'))
    await h.handle['liveShare:access'](null, { subject: ask.guestId, right: 'open', on: false })
    await until(() => h.events('liveShare:hostRequest').length === 2)
    expect(h.last('liveShare:hostRequest')).toEqual({ action: 'cancel', request: req.request })
  })

  it('trusting needs room in the list: a full list is said (the guest let in untrusted), and so is a trusted person’s project cap', async () => {
    const { h, started } = await host()
    // Fifty trusted already (as saved by this Tessel).
    const { newSigningKey: makeKey } = await import('../liveShare/shareCrypto')
    const trusted = Array.from({ length: 50 }, (_, i) => ({ key: makeKey().publicRaw.toString('base64'), name: `p${i}`, grant: { projects: [], rights: {} } }))
    fs.writeFileSync(join(h.dataDir, 'liveshare-trusted.json'), JSON.stringify({ v: 1, trusted }))
    const h2 = fakeMain({ dataDir: h.dataDir })
    mains.push(h2)
    await h.handle['liveShare:stop']()
    const again = await h2.handle['liveShare:start'](null, { name: 'Ada', projects: ['ws-1'] })
    const g = guestMain()
    await g.handle['liveShare:join'](null, { invite: codeOf(again), name: 'Simpa' })
    const ask = await until(() => h2.last('liveShare:ask'))
    expect(await h2.handle['liveShare:approve'](null, { guestId: ask.guestId, yes: true, projects: ['ws-1'], trust: true })).toEqual({ ok: true, reason: 'trust-full', max: 50 })
    await until(() => status(g)?.state === 'joined')
    await until(() => h2.last('liveShare:host').guests.some((x) => x.state === 'joined'))
    expect(h2.last('liveShare:host').guests[0]).toMatchObject({ trusted: false, trustId: null, trustable: true })
    expect(h2.last('liveShare:host').trusted).toHaveLength(50)
    // Trusting it later: the same.
    expect(await h2.handle['liveShare:trust'](null, { guestId: ask.guestId })).toEqual({ ok: false, reason: 'trust-full', max: 50 })
    expect(started.invites).toHaveLength(1)
    // A trusted person at 64 projects: the 65th is refused, said as such.
    const tid = h2.last('liveShare:host').trusted[0].id
    await h2.handle['liveShare:stop']()
    for (let i = 0; i < 64; i++) expect(await h2.handle['liveShare:access'](null, { subject: tid, project: `ws-${i}`, on: true })).toEqual({ ok: true })
    expect(await h2.handle['liveShare:access'](null, { subject: tid, project: 'ws-x', on: true })).toEqual({ ok: false, reason: 'trust-projects', max: 64 })
    expect(await h2.handle['liveShare:access'](null, { subject: tid, project: 'ws-0', on: false })).toEqual({ ok: true })
  })

  it('presence: the host window hears which pane a guest looks at and types in, at most 4 times a second', async () => {
    const { h, started } = await host()
    const g = guestMain()
    await g.handle['liveShare:join'](null, { invite: codeOf(started), name: 'Bob' })
    const ask = await until(() => h.last('liveShare:ask'))
    await h.handle['liveShare:approve'](null, { guestId: ask.guestId, yes: true, projects: ['ws-1', 'ws-2'], rights: { type: true } })
    await until(() => status(g)?.state === 'joined' && status(g).panes.length === 2 && status(g).rights?.type)
    await g.api.guestAttach('pane-ls1-1-a')
    const before = h.events('liveShare:presence').length
    const t0 = Date.now()
    // Looking from pane to pane, and typing, for a second.
    while (Date.now() - t0 < 1000) {
      g.on['liveShare:focus'](null, 'pane-ls1-1-a')
      g.api.guestWrite('pane-ls1-1-a', 'x')
      await new Promise((r) => setTimeout(r, 30))
      g.on['liveShare:focus'](null, 'pane-ls1-2-b')
      await new Promise((r) => setTimeout(r, 30))
    }
    const pushes = h.events('liveShare:presence').length - before
    expect(pushes).toBeGreaterThan(0)
    expect(pushes).toBeLessThanOrEqual(5)
    await until(() => (h.last('liveShare:presence') || []).some((p) => p.guests.some((x) => x.watching)))
    expect((h.last('liveShare:presence') || []).some((p) => p.id === 'pane-1-a' && p.guests.some((x) => x.typing))).toBe(true)
    // A pane id it does not have (the host's own name for it): nothing.
    g.on['liveShare:focus'](null, 'pane-1-a')
    await until(() => !(h.last('liveShare:presence') || []).some((p) => p.guests.some((x) => x.watching)), 2000)
  })

  it('a share with a no-expiry invitation comes back after a restart as it was', async () => {
    const { h } = await host()
    const made = await h.handle['liveShare:createInvite'](null, { label: 'Dev team', lifetime: 'never', projects: ['ws-1'] })
    h.api.suspend()
    h.api.stopAll()
    const saved = JSON.parse(fs.readFileSync(join(h.dataDir, 'liveshare-host.json'), 'utf8'))
    expect(saved.access.invites.find((i) => i.id === made.invite.id).expiresAt).toBe(null)
    const next = fakeMain({ dataDir: h.dataDir, resume: true })
    mains.push(next)
    expect(await next.api.resumed).toEqual([true, false])
    expect(next.last('liveShare:host').invites.find((i) => i.id === made.invite.id)).toMatchObject({ label: 'Dev team', expiresAt: null, code: made.invite.code })
  })
})

describe('registerLiveShare: identity and trust files that can not be read are kept', () => {
  const mains = []
  afterEach(() => {
    for (const m of mains.splice(0)) m.api.stopAll()
  })

  it('a guest whose identity file can not be read joins without an identity (asked, untrusted), and the file stays as it was', async () => {
    const host = fakeMain()
    mains.push(host)
    const started = await host.handle['liveShare:start'](null, { name: 'Ada', projects: ['ws-1'] })
    const guestDir = newDataDir()
    fs.writeFileSync(join(guestDir, 'liveshare-identity.json'), '{ not json')
    const g = fakeMain({ dataDir: guestDir })
    mains.push(g)
    await g.handle['liveShare:join'](null, { invite: codeOf(started), name: 'Simpa' })
    const ask = await until(() => host.last('liveShare:ask'))
    expect(ask.trustable).toBe(false)
    expect(fs.readFileSync(join(guestDir, 'liveshare-identity.json'), 'utf8')).toBe('{ not json')
    expect(g.logs.join('\n')).toContain('identity file can not be read')
    // Asked to trust it anyway: let in, not trusted, and said why.
    expect(await host.handle['liveShare:approve'](null, { guestId: ask.guestId, yes: true, projects: ['ws-1'], trust: true })).toEqual({ ok: true, reason: 'not-trustable' })
    await until(() => g.last('liveShare:guest')?.state === 'joined')
    expect(host.last('liveShare:host').trusted).toEqual([])
  })

  it('requests to open kept too long, or past the most kept, are called off in the window', async () => {
    const host = fakeMain({ requestLimits: { keepMs: 1500, max: 2 } })
    mains.push(host)
    const started = await host.handle['liveShare:start'](null, { name: 'Ada', projects: ['ws-1'] })
    host.on['liveShare:layouts'](null, [{ id: 'ws-1', layout: { project: 'one', tree: leaf('pane-1-a'), activeId: 'pane-1-a' } }])
    const g = fakeMain()
    mains.push(g)
    await g.handle['liveShare:join'](null, { invite: codeOf(started), name: 'Bob' })
    const ask = await until(() => host.last('liveShare:ask'))
    await host.handle['liveShare:approve'](null, { guestId: ask.guestId, yes: true, projects: ['ws-1'], rights: { open: true } })
    await until(() => g.last('liveShare:guest')?.rights?.open)
    for (let i = 0; i < 3; i++) await g.handle['liveShare:open'](null, { kind: 'terminal', project: 'ws-1' })
    await until(() => host.events('liveShare:hostRequest').length === 4)
    const [r1, r2, cancel1, r3] = host.events('liveShare:hostRequest')
    expect([r1.action, r2.action, r3.action]).toEqual(['open', 'open', 'open'])
    expect(cancel1).toEqual({ action: 'cancel', request: r1.request })
    // A while later, the next request (another guest asking) calls off the
    // ones kept too long (Bob still has his project and his right).
    await new Promise((r) => setTimeout(r, 1600))
    const c = fakeMain()
    mains.push(c)
    await c.handle['liveShare:join'](null, { invite: codeOf(started), name: 'Cid' })
    const askC = await until(() => host.events('liveShare:ask').find((q) => q.name === 'Cid'))
    await host.handle['liveShare:approve'](null, { guestId: askC.guestId, yes: true, projects: ['ws-1'] })
    await until(() => c.last('liveShare:guest')?.state === 'joined' && c.last('liveShare:guest').agents)
    expect(await c.handle['liveShare:open'](null, { kind: 'terminal', project: 'ws-1' })).toEqual({ ok: true, asked: true })
    await until(() => host.events('liveShare:hostRequest').length === 7)
    const after = host.events('liveShare:hostRequest').slice(4)
    expect(after.slice(0, 2)).toEqual([
      { action: 'cancel', request: r2.request },
      { action: 'cancel', request: r3.request }
    ])
    expect(after[2]).toMatchObject({ action: 'ask-open', guest: expect.objectContaining({ name: 'Cid' }) })
  })

  it('a trusted people file that can not be read is never written over', async () => {
    const dir = newDataDir()
    fs.writeFileSync(join(dir, 'liveshare-trusted.json'), '{ broken')
    const host = fakeMain({ dataDir: dir })
    mains.push(host)
    expect((await host.handle['liveShare:state']()).host.trusted).toEqual([])
    const started = await host.handle['liveShare:start'](null, { name: 'Ada', projects: ['ws-1'] })
    const g = fakeMain()
    mains.push(g)
    await g.handle['liveShare:join'](null, { invite: codeOf(started), name: 'Simpa' })
    const ask = await until(() => host.last('liveShare:ask'))
    await host.handle['liveShare:approve'](null, { guestId: ask.guestId, yes: true, projects: ['ws-1'], trust: true })
    await until(() => g.last('liveShare:guest')?.state === 'joined')
    expect(fs.readFileSync(join(dir, 'liveshare-trusted.json'), 'utf8')).toBe('{ broken')
    expect(host.logs.join('\n')).toContain('trusted people file can not be read')
  })
})
