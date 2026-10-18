// @vitest-environment node
// Live Share conversations (liveShare/shareChat.js): a guest looks at a
// host's agent pane as a chat, read only, on its own screen. What the guest
// gets is only the conversation (no tool output, thinking, images, paths
// outside the project or secrets), bounded, only for panes of projects it
// sees, stops at once when it loses them or is removed, and never reaches the
// host's pane. A host or a guest of an older Tessel (no 'chat' feature) still
// works together with a newer one, without conversations. Real WebSockets on
// 127.0.0.1 (only Cloudflare's tunnel is faked).
import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { createShareHost } from '../liveShare/shareHost'
import { createShareGuest } from '../liveShare/shareGuest'
import { newSecret, newSigningKey } from '../liveShare/shareCrypto'
import { guestChatPayload, cleanChatMessage, mergeChatEvents, guestText, cleanRoots, CHAT_LIMITS } from '../liveShare/shareChat'
import WebSocket from 'ws'
import { registerLiveShare, cleanHostChats } from '../liveShare'

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

const until = async (fn, ms = 4000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = fn()
    if (v) return v
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('timed out')
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const UUID = '0b8f3c1e-5a2d-4c7b-9e1f-2a3b4c5d6e7f'

// A conversation as the host's own chat view reads it (transcriptView.js).
const hostRead = () => ({
  ok: true,
  truncated: false,
  events: [
    { type: 'user', id: 'hist-u1', text: 'Fix C:\\work\\site\\src\\app.js, my key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz', images: [{ key: 'k', dataUrl: 'data:image/png;base64,AAAA' }], files: [{ path: 'C:\\Users\\ada\\notes.txt' }], at: 1 },
    { type: 'thinking', messageId: 'm1', text: 'PRIVATE THINKING', at: 2 },
    { type: 'assistant', messageId: 'm1', text: 'Reading C:\\Users\\ada\\.ssh\\id_rsa and /etc/shadow, then src/app.js.', at: 3 },
    { type: 'tool', id: 't1', name: 'Write', summary: 'C:\\work\\site\\src\\app.js', input: { file_path: 'C:\\work\\site\\src\\app.js', content: 'FILE CONTENT SECRET' }, status: 'running', at: 4 },
    { type: 'tool', id: 't2', name: 'Bash', input: { command: 'export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789 && npm test' }, status: 'running', at: 5 },
    { type: 'toolResult', id: 't1', isError: false, text: 'COMMAND OUTPUT SECRET', at: 6 },
    { type: 'contextUsage', usedTokens: 1000 },
    { type: 'notice', text: 'x' },
    { type: 'turnEnd', status: 'completed', durationMs: 1200, at: 7 }
  ]
})

describe('shareChat: what a guest gets of a conversation', () => {
  it('only the conversation: no thinking, tool output, file contents, images or attached files', () => {
    const out = guestChatPayload(hostRead(), ['C:\\work\\site'])
    expect(out.ok).toBe(true)
    expect(out.events.map((e) => e.type)).toEqual(['user', 'assistant', 'tool', 'tool', 'toolResult', 'turnEnd'])
    const text = JSON.stringify(out)
    for (const secret of ['PRIVATE THINKING', 'FILE CONTENT SECRET', 'COMMAND OUTPUT SECRET', 'data:image', 'notes.txt']) expect(text).not.toContain(secret)
    expect(out.events[0]).not.toHaveProperty('images')
    expect(out.events[0]).not.toHaveProperty('files')
    expect(out.events[2].input).toEqual({ file_path: 'src/app.js' })
    expect(out.events[4]).toMatchObject({ type: 'toolResult', id: 't1', isError: false, text: '' })
  })

  it('paths outside the project are hidden, inside ones written from the project, secrets masked', () => {
    const out = guestChatPayload(hostRead(), ['C:\\work\\site'])
    const text = JSON.stringify(out)
    expect(out.events[0].text).toBe('Fix src/app.js, my key is ••••')
    expect(out.events[1].text).toBe('Reading … and …, then src/app.js.')
    expect(out.events[3].input.command).toBe('export GITHUB_TOKEN=•••• && npm test')
    for (const leak of ['Users', 'ada', 'id_rsa', 'shadow', 'C:\\\\work', 'ghp_', 'sk-ant']) expect(text).not.toContain(leak)
    // No project folder known: every absolute path is hidden.
    expect(guestChatPayload(hostRead(), []).events[0].text).toBe('Fix …, my key is ••••')
    // Slash commands, web addresses, dates and relative paths stay.
    const roots = cleanRoots(['/home/ada/proj'])
    expect(guestText('/compact then https://example.com/a/b on 10/15/2026 in src/a.js and /home/ada/proj/lib/x.ts', roots, 500)).toBe('/compact then https://example.com/a/b on 10/15/2026 in src/a.js and lib/x.ts')
    expect(guestText('password=hunter22 Bearer abcdefghijklmnop1234 postgres://u:pw1234@db/x', roots, 500)).toBe('password=•••• Bearer •••• postgres://••••@db/x')
  })

  it('is bounded: the latest events that fit the count and the bytes, each text cut', () => {
    const many = { ok: true, events: Array.from({ length: 2000 }, (_, i) => ({ type: 'assistant', messageId: `m${i}`, text: 'x'.repeat(30000) })) }
    const out = guestChatPayload(many, [])
    expect(out.truncated).toBe(true)
    expect(out.events.length).toBeLessThanOrEqual(CHAT_LIMITS.events)
    expect(Buffer.byteLength(JSON.stringify(out.events))).toBeLessThanOrEqual(CHAT_LIMITS.bytes)
    expect(out.events.at(-1).messageId).toBe('m1999')
    expect(out.events[0].text.length).toBeLessThanOrEqual(CHAT_LIMITS.assistant)
    const count = guestChatPayload({ ok: true, events: Array.from({ length: 1000 }, (_, i) => ({ type: 'assistant', messageId: `m${i}`, text: 'hi' })) }, [])
    expect(count.events).toHaveLength(CHAT_LIMITS.events)
  })

  it('the guest checks what comes again: unknown kinds and fields dropped, codes kept to known ones', () => {
    const msg = cleanChatMessage({ ok: true, events: [{ type: 'assistant', messageId: 'm1', text: 'hi', extra: 'x' }, { type: 'approval', requestId: 'r1' }, { type: 'user', id: '../bad id', text: 'x' }], truncated: false })
    // One for one with the host's (what is not known: kept, ignored by the chat).
    expect(msg).toEqual({ ok: true, dropped: 0, from: 0, events: [{ type: 'assistant', messageId: 'm1', text: 'hi', imported: true }, { type: 'skip' }, { type: 'skip' }], total: 3, truncated: false })
    expect(cleanChatMessage({ ok: false, code: 'constructor' })).toEqual({ ok: false, code: 'error' })
    expect(cleanChatMessage({ ok: false, code: 'missing' })).toEqual({ ok: false, code: 'missing' })
    expect(cleanChatMessage(null)).toBe(null)
  })

  it('the host window’s panes with a conversation are checked (agent, session, account, folders)', () => {
    const list = cleanHostChats([
      { id: 'pane-1', agentId: 'claude', sessionId: UUID, accountId: 'acct-1', terminal: true, roots: ['C:\\work\\site', 42] },
      { id: 'pane-2', agentId: 'claude', sessionId: 'not-a-uuid' },
      { id: 'pane-3', agentId: 'bash', sessionId: UUID },
      { id: '../x', agentId: 'claude', sessionId: UUID },
      { id: 'pane-4', agentId: 'codex', sessionId: UUID, accountId: 'bad account!', terminal: false, title: 'Codex' }
    ])
    expect(list).toEqual([
      { id: 'pane-1', agentId: 'claude', sessionId: UUID, accountId: 'acct-1', terminal: true, title: '', roots: ['C:\\work\\site'] },
      { id: 'pane-4', agentId: 'codex', sessionId: UUID, accountId: undefined, terminal: false, title: 'Codex', roots: [] }
    ])
    // An agent on an SSH host (Claude Code, Codex: valid host and session), and a pane that only says why it has none.
    expect(
      cleanHostChats([
        { id: 'a', agentId: 'claude', sessionId: UUID, hostId: 'ssh-1a2b', roots: ['/home/me/app'] },
        { id: 'b', agentId: 'antigravity', sessionId: UUID, hostId: 'ssh-1a2b' },
        { id: 'c', agentId: 'claude', sessionId: UUID, hostId: '../evil' },
        { id: 'd', agentId: 'antigravity', reason: 'ssh', hostId: 'ssh-1a2b', sessionId: 'x', roots: ['/secret'] },
        { id: 'e', agentId: 'aider', reason: 'bogus' },
        { id: 'f', agentId: 'bash!', reason: 'agent' }
      ])
    ).toEqual([
      { id: 'a', agentId: 'claude', sessionId: UUID, hostId: 'ssh-1a2b', terminal: true, title: '', roots: ['/home/me/app'] },
      { id: 'd', agentId: 'antigravity', reason: 'ssh', terminal: true, title: '', roots: [] }
    ])
  })
})

// --- The protocol: shareHost.js and shareGuest.js --------------------------
const chatPane = (id, terminal = true) => ({ id, title: id, agentId: 'claude', accent: null, terminal })
const layoutOf = (name, ids) => ({ project: name, tree: { type: 'split', dir: 'row', sizes: ids.map(() => 100 / ids.length), children: ids.map((id) => ({ type: 'leaf', id, view: 'terminal', title: id, kind: 'agent', agentId: 'claude' })) }, activeId: null, maximizedId: null })

function fakeTessel({ chat = true } = {}) {
  const t = {
    shared: { 'ws-a': ['a1'], 'ws-b': ['b1'] },
    chats: { 'ws-a': [chatPane('a1'), chatPane('a2', false)], 'ws-b': [chatPane('b1')] },
    watching: [],
    writes: [],
    closed: [],
    opened: [],
    callbacks: {
      projects: () => Object.entries(t.shared).map(([id, ids]) => ({ id, layout: layoutOf(id, ids), panes: ids.map((x) => ({ id: x, title: x, kind: 'agent', agentId: 'claude', cols: 80, rows: 24 })), chats: t.chats[id] || [] })),
      snapshot: async (id) => ({ data: `screen of ${id}`, cols: 80, rows: 24 }),
      write: (id, data) => t.writes.push([id, data]),
      openPane: (spec) => t.opened.push(spec),
      closePane: (id) => t.closed.push(id),
      askApproval: async (g) => (t.answers && g.name in t.answers ? t.answers[g.name] : true),
      ...(chat ? { chatWatch: (id, on) => t.watching.push([id, on]) } : {})
    }
  }
  return t
}

function recorder() {
  const r = { states: [], projects: null, chats: [], features: null, closed: null }
  r.callbacks = {
    onState: (s) => r.states.push(s),
    onProjects: (p) => (r.projects = p),
    onFeatures: (f) => (r.features = f),
    onChat: (id, msg) => r.chats.push([id, msg]),
    onSnapshot: () => {},
    onData: () => {},
    onExit: () => {},
    onRestart: () => {},
    onRights: () => {},
    onHostKey: () => {},
    onClosed: (reason) => (r.closed = reason)
  }
  return r
}

describe('Live Share conversations over the wire', () => {
  let host
  afterEach(() => host?.stop())

  async function share(t) {
    const secret = newSecret()
    host = createShareHost({ secret, hostName: 'Ada', callbacks: t.callbacks })
    return { secret, port: await host.start() }
  }
  async function joined({ port, secret }, name, opts = {}) {
    const r = recorder()
    r.client = createShareGuest({ url: `ws://127.0.0.1:${port}/`, secret, name, signingKey: newSigningKey(), callbacks: r.callbacks, ...opts })
    r.client.connect()
    await until(() => r.states.includes('joined') && r.projects)
    return r
  }
  const guestOf = (name) => host.guests().find((g) => g.name === name)

  it('a guest gets the agent panes of its own projects, and their conversation only while it watches', async () => {
    const t = fakeTessel()
    t.answers = { Alex: { yes: true, projects: ['ws-a'] } }
    const conn = await share(t)
    const alex = await joined(conn, 'Alex')
    // What this host speaks (no agents listed, no presence shown here).
    expect(alex.features).toEqual(['chat'])
    expect(alex.projects.map((p) => [p.id, p.chats.map((c) => c.id)])).toEqual([['ws-a', ['a1', 'a2']]])

    // Not asked: nothing read, nothing sent.
    host.sendChat('a1', { ok: true, events: [] })
    await wait(30)
    expect(t.watching).toEqual([])
    expect(alex.chats).toEqual([])

    alex.client.chat('a1', true)
    await until(() => t.watching.length)
    expect(t.watching).toEqual([['a1', true]])
    host.sendChat('a1', { ok: true, events: [{ type: 'assistant', messageId: 'm1', text: 'hello', imported: true }], truncated: false })
    await until(() => alex.chats.length)
    expect(alex.chats[0]).toEqual(['a1', expect.objectContaining({ t: 'chat', id: 'a1', ok: true, events: [expect.objectContaining({ text: 'hello' })] })])

    // A pane of a project it does not see: refused, nothing read.
    alex.client.chat('b1', true)
    await until(() => alex.chats.some(([id]) => id === 'b1'))
    expect(alex.chats.find(([id]) => id === 'b1')[1]).toMatchObject({ ok: false, code: 'unavailable' })
    expect(t.watching).toEqual([['a1', true]])

    // Watching never types, opens or closes anything on the host.
    expect(t.writes).toEqual([])
    expect(t.opened).toEqual([])
    expect(t.closed).toEqual([])

    alex.client.chat('a1', false)
    await until(() => t.watching.length === 2)
    expect(t.watching[1]).toEqual(['a1', false])
    expect(host.chatsWatched()).toEqual([])
  })

  it('one read for every guest watching; a guest that starts later gets the latest at once', async () => {
    const t = fakeTessel()
    const conn = await share(t)
    const alex = await joined(conn, 'Alex')
    const bea = await joined(conn, 'Bea')
    alex.client.chat('a1', true)
    await until(() => t.watching.length)
    host.sendChat('a1', { ok: true, events: [{ type: 'assistant', messageId: 'm1', text: 'first', imported: true }] })
    await until(() => alex.chats.length)
    bea.client.chat('a1', true)
    await until(() => bea.chats.length)
    expect(bea.chats[0][1].events[0].text).toBe('first')
    expect(t.watching).toEqual([['a1', true]])
    expect(host.chatsWatched()).toEqual([{ id: 'a1', guests: [guestOf('Alex').id, guestOf('Bea').id] }])
    // The first leaving keeps it read for the other.
    alex.client.chat('a1', false)
    await wait(40)
    expect(t.watching).toEqual([['a1', true]])
  })

  it('at most one update a second per pane: the latest one goes', async () => {
    const t = fakeTessel()
    const conn = await share(t)
    const alex = await joined(conn, 'Alex')
    alex.client.chat('a1', true)
    await until(() => t.watching.length)
    for (let i = 1; i <= 6; i++) host.sendChat('a1', { ok: true, events: [{ type: 'assistant', messageId: 'm1', text: `v${i}`, imported: true }] })
    await wait(300)
    expect(alex.chats).toHaveLength(1)
    expect(alex.chats[0][1].events[0].text).toBe('v1')
    await until(() => alex.chats.length === 2, 2500)
    expect(alex.chats[1][1].events[0].text).toBe('v6')
  })

  it('one too big is not sent; what is sent is checked', async () => {
    const t = fakeTessel()
    const conn = await share(t)
    const alex = await joined(conn, 'Alex')
    alex.client.chat('a1', true)
    await until(() => t.watching.length)
    host.sendChat('a1', { ok: true, events: [{ type: 'assistant', messageId: 'm1', text: 'x'.repeat(CHAT_LIMITS.bytes + 100000) }] })
    await until(() => alex.chats.length)
    expect(alex.chats[0][1]).toMatchObject({ ok: false, code: 'unavailable' })
    expect(alex.chats[0][1]).not.toHaveProperty('events')
  })

  it('a project taken from the guest, or the guest removed: its conversations stop at once', async () => {
    const t = fakeTessel()
    const conn = await share(t)
    const alex = await joined(conn, 'Alex')
    alex.client.chat('a1', true)
    alex.client.chat('b1', true)
    await until(() => t.watching.length === 2)
    host.setGrant(guestOf('Alex').id, { projects: ['ws-b'] })
    await until(() => t.watching.some(([id, on]) => id === 'a1' && !on))
    const before = alex.chats.length
    host.sendChat('a1', { ok: true, events: [{ type: 'assistant', messageId: 'm1', text: 'AFTER', imported: true }] })
    await wait(60)
    expect(alex.chats.slice(before).some(([, m]) => JSON.stringify(m).includes('AFTER'))).toBe(false)
    expect(host.chatsWatched().map((c) => c.id)).toEqual(['b1'])
    // A pane taken out of the project (closed, moved): the same.
    host.removeGuest(guestOf('Alex').id)
    await until(() => t.watching.some(([id, on]) => id === 'b1' && !on))
    expect(host.chatsWatched()).toEqual([])
  })

  it('an older guest (no chat feature) gets the projects as before and no conversation', async () => {
    const t = fakeTessel()
    const conn = await share(t)
    const old = await joined(conn, 'Old', { features: [] })
    expect(old.projects.every((p) => !('chats' in p))).toBe(true)
    expect(old.projects.map((p) => p.panes.map((x) => x.id))).toEqual([['a1'], ['b1']])
    old.client.chat('a1', true)
    await wait(60)
    expect(t.watching).toEqual([])
    expect(old.chats).toEqual([])
  })

  it('an older host (no chat feature): the guest is told (no features), its asks are ignored', async () => {
    const t = fakeTessel({ chat: false })
    const conn = await share(t)
    const alex = await joined(conn, 'Alex')
    expect(alex.features).toEqual([])
    expect(alex.projects.every((p) => !('chats' in p))).toBe(true)
    alex.client.chat('a1', true)
    await wait(60)
    expect(alex.chats).toEqual([])
    expect(alex.closed).toBe(null)
  })
})

// --- registerLiveShare: one Tessel shares, another looks -------------------
const dataDirs = []
afterEach(() => {
  for (const dir of dataDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})
function fakeMain({ chatViews = null, chatRetry = {} } = {}) {
  const dataDir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-lschat-'))
  dataDirs.push(dataDir)
  const m = {
    handle: {},
    on: {},
    sent: [],
    hostWrites: [],
    ipcMain: { handle: (name, fn) => (m.handle[name] = fn), on: (name, fn) => (m.on[name] = fn) },
    send: (channel, payload) => m.sent.push([channel, payload]),
    host: {
      request: vi.fn(async (op, body, _t, onReply) => {
        const msg = op === 'attach' ? { ok: true, buffer: `screen of ${body.id}` } : { ok: false }
        onReply?.(msg)
        return msg
      }),
      send: vi.fn((op, body) => op === 'write' && m.hostWrites.push([body.id, body.data]))
    },
    events: (channel) => m.sent.filter(([c]) => c === channel).map(([, p]) => p),
    last: (channel) => m.events(channel).at(-1)
  }
  m.api = registerLiveShare({ ipcMain: m.ipcMain, send: m.send, host: m.host, dataDir, queueData: () => {}, sendExit: () => {}, log: { info: () => {} }, kill: vi.fn(), pidRunning: () => true, resume: false, chatViews, chatRetry })
  return m
}
// The host's conversation reader (transcriptView.js createTranscriptViews).
function fakeReader() {
  const r = { opened: [], closed: [], send: null, next: 0 }
  r.factory = (send) => {
    r.send = send
    return {
      openFromWindow: vi.fn(async (q) => {
        r.opened.push(q)
        if (r.missing) return { ok: false, code: 'missing' }
        return { ok: true, viewId: `tv-${++r.next}`, ...hostRead() }
      }),
      close: vi.fn((viewId) => r.closed.push(viewId))
    }
  }
  return r
}

describe('registerLiveShare: a guest looks at a host’s agent pane as a chat', () => {
  const mains = []
  afterEach(() => {
    for (const m of mains.splice(0)) m.api.stopAll()
  })
  const leaf = (id, extra = {}) => ({ type: 'leaf', id, view: 'terminal', title: id, kind: 'agent', agentId: 'claude', ...extra })
  const tree = { type: 'split', dir: 'row', sizes: [50, 50], children: [leaf('pane-1-cc', { title: 'Claude Code' }), leaf('pane-2-chat', { view: 'chat', title: '', kind: 'shell' })] }
  const chats = [
    { id: 'pane-1-cc', agentId: 'claude', sessionId: UUID, accountId: null, terminal: true, title: '', roots: ['C:\\work\\site'] },
    { id: 'pane-2-chat', agentId: 'codex', sessionId: UUID, terminal: false, title: 'Codex chat', roots: ['C:\\work\\site'] }
  ]

  async function sharedAndJoined({ reader = fakeReader(), projects = ['ws-1'], chatRetry = {}, hostChats = chats } = {}) {
    const host = fakeMain({ chatViews: reader.factory, chatRetry })
    const guest = fakeMain()
    mains.push(host, guest)
    const started = await host.handle['liveShare:start'](null, { name: 'Cedric', projects: ['ws-1', 'ws-2'] })
    host.on['liveShare:layouts'](null, [
      { id: 'ws-1', layout: { project: 'site', tree, activeId: 'pane-1-cc' }, chats: hostChats },
      { id: 'ws-2', layout: { project: 'other', tree: leaf('pane-9-cc'), activeId: null }, chats: [{ id: 'pane-9-cc', agentId: 'claude', sessionId: UUID, terminal: true, roots: [] }] }
    ])
    await guest.handle['liveShare:join'](null, { invite: started.invites[0].code, name: 'Alex' })
    const ask = await until(() => host.last('liveShare:ask'))
    await host.handle['liveShare:approve'](null, { guestId: ask.guestId, yes: true, projects })
    const joined = await until(() => guest.events('liveShare:guest').find((s) => s.state === 'joined' && s.chats && s.chats.length))
    return { host, guest, reader, joined, guestId: ask.guestId }
  }

  it('the guest gets those panes by name only, and their conversation made smaller, read only', async () => {
    const { host, guest, reader, joined } = await sharedAndJoined()
    expect(joined.chat).toBe(true)
    expect(joined.chats).toEqual([
      { id: 'pane-ls1-1-cc', project: 'ws-1', title: 'Claude Code', agentId: 'claude', accent: null, terminal: true },
      { id: 'pane-ls1-2-chat', project: 'ws-1', title: 'Codex chat', agentId: 'codex', accent: null, terminal: false }
    ])
    // Where the conversation is never reaches the guest.
    expect(JSON.stringify(guest.sent)).not.toContain(UUID)
    expect(JSON.stringify(guest.sent)).not.toContain('work\\\\site')

    const r = await guest.handle['liveShare:chatWatch'](null, { id: 'pane-ls1-2-chat', on: true })
    expect(r).toEqual({ ok: true, last: null })
    const got = await until(() => guest.last('liveShare:chat'))
    expect(reader.opened).toEqual([{ agent: 'codex', sessionId: UUID, paneId: 'pane-2-chat' }])
    expect(got.id).toBe('pane-ls1-2-chat')
    expect(got.ok).toBe(true)
    const text = JSON.stringify(got)
    for (const leak of ['PRIVATE THINKING', 'FILE CONTENT SECRET', 'COMMAND OUTPUT SECRET', 'id_rsa', 'sk-ant', 'ghp_']) expect(text).not.toContain(leak)
    expect(got.events[0].text).toBe('Fix src/app.js, my key is ••••')
    // The latest is kept for the window (a view opened again).
    expect((await guest.handle['liveShare:chatWatch'](null, { id: 'pane-ls1-2-chat', on: true })).last).toMatchObject({ ok: true })

    // The file grows: the guest gets it again.
    reader.send('transcriptView:event', { viewId: 'tv-1', ok: true, events: [{ type: 'assistant', messageId: 'm9', text: 'later', at: 9 }] })
    await until(() => guest.last('liveShare:chat').events?.[0]?.text === 'later', 3000)

    // Nothing of it typed into the host's terminals.
    expect(host.hostWrites).toEqual([])
    expect(host.events('liveShare:hostRequest')).toEqual([])

    await guest.handle['liveShare:chatWatch'](null, { id: 'pane-ls1-2-chat', on: false })
    await until(() => reader.closed.length)
    expect(reader.closed).toEqual(['tv-1'])
  })

  it('an agent on an SSH host: read over the connection, the guest gets the same smaller copy and never where it is', async () => {
    const hostChats = [{ id: 'pane-1-cc', agentId: 'claude', sessionId: UUID, hostId: 'ssh-1a2b', terminal: true, title: '', roots: ['/home/me/app'] }]
    const { guest, reader, joined } = await sharedAndJoined({ hostChats })
    expect(joined.chats).toEqual([{ id: 'pane-ls1-1-cc', project: 'ws-1', title: 'Claude Code', agentId: 'claude', accent: null, terminal: true }])
    expect(JSON.stringify(guest.sent)).not.toContain('ssh-1a2b')
    expect(JSON.stringify(guest.sent)).not.toContain('/home/me')
    expect((await guest.handle['liveShare:chatWatch'](null, { id: 'pane-ls1-1-cc', on: true })).ok).toBe(true)
    await until(() => guest.last('liveShare:chat'))
    // The reader is asked for the host's file by SSH host, never a local path or account.
    expect(reader.opened).toEqual([{ agent: 'claude', sessionId: UUID, hostId: 'ssh-1a2b' }])
  })

  it('a pane with no conversation to send is listed with why; watching it gets "unavailable", nothing is read', async () => {
    const hostChats = [{ id: 'pane-1-cc', agentId: 'antigravity', terminal: true, reason: 'ssh', sessionId: UUID, hostId: 'ssh-1a2b', roots: ['/home/me'] }]
    const { guest, reader, joined } = await sharedAndJoined({ hostChats })
    expect(joined.chats).toEqual([{ id: 'pane-ls1-1-cc', project: 'ws-1', title: 'Claude Code', agentId: 'antigravity', accent: null, terminal: true, reason: 'ssh' }])
    await guest.handle['liveShare:chatWatch'](null, { id: 'pane-ls1-1-cc', on: true })
    const got = await until(() => guest.last('liveShare:chat'))
    expect(got).toMatchObject({ id: 'pane-ls1-1-cc', ok: false, code: 'unavailable' })
    expect(reader.opened).toEqual([])
    expect(JSON.stringify(guest.sent)).not.toContain('ssh-1a2b')
  })

  it('only the projects the guest sees; a project taken away closes the reader at once', async () => {
    const { host, guest, reader, joined, guestId } = await sharedAndJoined()
    expect(joined.chats.map((c) => c.id)).not.toContain('pane-ls1-9-cc')
    expect(await guest.handle['liveShare:chatWatch'](null, { id: 'pane-ls1-9-cc', on: true })).toEqual({ ok: false, code: 'missing' })
    await guest.handle['liveShare:chatWatch'](null, { id: 'pane-ls1-1-cc', on: true })
    await until(() => reader.opened.length)
    expect(reader.opened[0]).toEqual({ agent: 'claude', sessionId: UUID, paneId: 'pane-1-cc', accountId: null })
    await host.handle['liveShare:access'](null, { subject: guestId, project: 'ws-1', on: false })
    await until(() => reader.closed.length)
    await until(() => guest.last('liveShare:guest').chats.length === 0)
    expect(await guest.handle['liveShare:chatWatch'](null, { id: 'pane-ls1-1-cc', on: true })).toEqual({ ok: false, code: 'missing' })
  })

  it('the guest’s Tessel puts the updates together; the host sees who reads which conversation', { timeout: 15000 }, async () => {
    const { host, guest, reader, guestId } = await sharedAndJoined()
    await guest.handle['liveShare:chatWatch'](null, { id: 'pane-ls1-1-cc', on: true })
    const first = await until(() => guest.last('liveShare:chat'))
    const n = first.events.length
    await until(() => host.last('liveShare:presence')?.length)
    expect(host.last('liveShare:presence')).toEqual([{ id: 'pane-1-cc', guests: [{ id: guestId, watching: false, typing: false, reading: true }] }])
    // The file grows by one answer: the window gets the whole conversation.
    reader.send('transcriptView:event', { viewId: 'tv-1', ...hostRead(), events: [...hostRead().events, { type: 'assistant', messageId: 'm9', text: 'one more', at: 9 }] })
    const next = await until(() => guest.events('liveShare:chat').find((m) => m.events && m.events.length === n + 1), 3000)
    expect(next.events.at(-1).text).toBe('one more')
    expect(next.events.slice(0, n)).toEqual(first.events)
    await guest.handle['liveShare:chatWatch'](null, { id: 'pane-ls1-1-cc', on: false })
    await until(() => host.last('liveShare:presence').length === 0)
  })

  it('guests starting and stopping a watch over and over: the host’s window is told at most every 250 ms', async () => {
    const { host, guest } = await sharedAndJoined()
    const before = host.events('liveShare:presence').length
    for (let i = 0; i < 10; i++) {
      await guest.handle['liveShare:chatWatch'](null, { id: 'pane-ls1-1-cc', on: true })
      await guest.handle['liveShare:chatWatch'](null, { id: 'pane-ls1-1-cc', on: false })
    }
    await wait(700)
    const told = host.events('liveShare:presence').length - before
    expect(told).toBeGreaterThan(0)
    expect(told).toBeLessThanOrEqual(4)
    expect(host.last('liveShare:presence')).toEqual([])
  })

  it('a conversation file not there: read again a few times, less and less often, then left alone', async () => {
    const reader = fakeReader()
    reader.missing = true
    const { guest } = await sharedAndJoined({ reader, chatRetry: { firstMs: 20, maxMs: 80, tries: 3 } })
    await guest.handle['liveShare:chatWatch'](null, { id: 'pane-ls1-1-cc', on: true })
    await until(() => reader.opened.length === 4, 2000)
    await wait(400)
    expect(reader.opened).toHaveLength(4)
    // Said once, not at every try.
    expect(guest.events('liveShare:chat')).toEqual([{ id: 'pane-ls1-1-cc', ok: false, code: 'missing' }])
  })

  it('a host without conversations (an older Tessel): the guest’s window is told so', async () => {
    const host = fakeMain() // no reader: no 'chat' feature
    const guest = fakeMain()
    mains.push(host, guest)
    const started = await host.handle['liveShare:start'](null, { name: 'Cedric', projects: ['ws-1'] })
    host.on['liveShare:layouts'](null, [{ id: 'ws-1', layout: { project: 'site', tree, activeId: null }, chats }])
    await guest.handle['liveShare:join'](null, { invite: started.invites[0].code, name: 'Alex' })
    const ask = await until(() => host.last('liveShare:ask'))
    await host.handle['liveShare:approve'](null, { guestId: ask.guestId, yes: true, projects: ['ws-1'] })
    const joined = await until(() => guest.events('liveShare:guest').find((s) => s.state === 'joined' && s.panes.length))
    expect(joined.chat).toBe(false)
    expect(joined.chats).toEqual([])
    expect(await guest.handle['liveShare:chatWatch'](null, { id: 'pane-ls1-1-cc', on: true })).toEqual({ ok: false, code: 'outdated-host' })
  })
})

describe('review fixes: what never reaches a guest', () => {
  it('the harness’s own turns: background task reports, shell input and output, reminders, other sessions, summaries, Tessel’s notes', () => {
    const turns = [
      '<task-notification><task-id>b1</task-id><result>FULL REPORT of a background agent</result></task-notification>',
      '<bash-input>cat ~/.aws/credentials</bash-input>',
      '<bash-stdout>aws_secret=AAAA</bash-stdout>',
      '<bash-stderr>oops</bash-stderr>',
      '  <system-reminder>REMINDER</system-reminder>',
      '<teammate-message from="Bob">TEAM SECRET</teammate-message>',
      '<cross-session-message>OTHER SESSION</cross-session-message>',
      'This session is being continued from a previous conversation that ran out of context. SUMMARY',
      'Another Claude session sent a message:\n<cross-session-message from="s2">OTHER</cross-session-message>',
      '[Tessel] Ada finished the task "x": REPORT',
      '(message m-1, reply to m-0) WORKER WORDS'
    ]
    const events = turns.map((text, i) => ({ type: 'user', id: `hist-u${i}`, text }))
    events.push({ type: 'user', id: 'hist-mine', text: 'fix it <system-reminder>HIDDEN</system-reminder> please' })
    const out = guestChatPayload({ ok: true, events }, [])
    expect(out.events).toEqual([expect.objectContaining({ id: 'hist-mine', text: 'fix it  please' })])
  })

  it('paths that tried to slip through: spaces, hosts, flags, terminal codes, long-path and share prefixes, %-encoding, ..', () => {
    const roots = cleanRoots(['C:\\Proj\\app', '/home/ada/proj'])
    const g = (x) => guestText(x, roots, 4000)
    expect(g('C:\\Users\\jean claude\\secret\\key.pem and more')).toBe('… and more')
    expect(g('open "C:\\Users\\jean claude\\secret\\key.pem" now')).toBe('open "…" now')
    expect(g('scp user@host:/home/jean/.ssh/id_rsa .')).toBe('scp user@host:… .')
    expect(g('gcc -I/home/jean/include')).toBe('gcc -I…')
    expect(g('cl -IC:\\Users\\x\\inc')).toBe('cl -I…')
    expect(g('configure --prefix=/opt/secret/x')).toBe('configure --prefix=…')
    expect(g('\x1b[31m/home/jean/secret/x\x1b[0m')).toBe('…')
    expect(g('\\\\?\\C:\\Users\\jean\\x | \\\\?\\UNC\\srv\\share\\x | //server/share/f.txt | \\\\server\\share\\f.txt')).toBe('… | … | … | …')
    expect(g('C%3A%5CUsers%5Cjean%5Csecret.txt')).toBe('…')
    expect(g('C:\\Proj\\app\\..\\..\\Users\\jean\\x and C:\\Proj\\app\\src\\..\\lib\\a.js')).toBe('… and lib/a.js')
    expect(g('../../secret/x and /home/ada/proj/../other/y and ~/notes.txt and ssh://host/home/x')).toBe('… and … and … and …')
    // What is not a path stays.
    expect(g('// a comment, https://example.com/a/b, http://h:8080/x/y, /compact, src/a.js')).toBe('// a comment, https://example.com/a/b, http://h:8080/x/y, /compact, src/a.js')
  })

  it('keys and passwords in their usual forms are masked', () => {
    const cases = ['npm_abcdefghijklmnopqrstuvwxyz0123', 'sk_live_abcdefghijklmnop', 'sk_test_abcdefghijklmnop', 'rk_live_abcdefghijklmnop', 'hf_abcdefghijklmnopqrstuvwxyz', 'ya29.a0AfH6SMBxyz123', 'xoxb-12345-abcdef', 'xoxp-12345-abcdef', 'glpat-abcdefghij1234', 'AKIAIOSFODNN7EXAMPLE', 'ASIAIOSFODNN7EXAMPLE', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIx']
    for (const secret of cases) expect(guestText(`use ${secret} here`, [], 500)).toBe('use •••• here')
    expect(guestText('DefaultEndpointsProtocol=https;AccountName=x;AccountKey=abc+def/ghi==;EndpointSuffix=y', [], 500)).toBe('DefaultEndpointsProtocol=https;AccountName=x;AccountKey=••••;EndpointSuffix=y')
    expect(guestText(`password: hunter and secret=abc and token="hello world" and api_key: 'qwerty'`, [], 500)).toBe(`password: •••• and secret=•••• and token="••••" and api_key: '••••'`)
    // A commit id is not a key.
    expect(guestText('commit 3f2a9c8e1b7d6f5a4c3b2a1908f7e6d5c4b3a291', [], 500)).toBe('commit 3f2a9c8e1b7d6f5a4c3b2a1908f7e6d5c4b3a291')
  })
})

describe('review fixes: conversation updates over the wire', () => {
  let host
  afterEach(() => host?.stop())
  const ev = (i, text = `m${i}`) => ({ type: 'assistant', messageId: `m${i}`, text, imported: true })
  async function share(t) {
    const secret = newSecret()
    host = createShareHost({ secret, hostName: 'Ada', callbacks: t.callbacks })
    return { secret, port: await host.start() }
  }
  async function joined({ port, secret }, name) {
    const r = recorder()
    r.client = createShareGuest({ url: `ws://127.0.0.1:${port}/`, secret, name, signingKey: newSigningKey(), callbacks: r.callbacks })
    r.client.connect()
    await until(() => r.states.includes('joined') && r.projects)
    return r
  }

  it('a guest gets only what changed since what it has, and nothing when nothing changed', async () => {
    const t = fakeTessel()
    const alex = await joined(await share(t), 'Alex')
    alex.client.chat('a1', true)
    await until(() => t.watching.length)
    host.sendChat('a1', { ok: true, events: [ev(1), ev(2)] })
    await until(() => alex.chats.length === 1)
    expect(alex.chats[0][1]).toMatchObject({ from: 0, events: [ev(1), ev(2)] })
    await wait(1050)
    host.sendChat('a1', { ok: true, events: [ev(1), ev(2, 'm2 longer'), ev(3)] })
    await until(() => alex.chats.length === 2)
    expect(alex.chats[1][1]).toMatchObject({ from: 1, events: [ev(2, 'm2 longer'), ev(3)] })
    await wait(1050)
    host.sendChat('a1', { ok: true, events: [ev(1), ev(2, 'm2 longer'), ev(3)] })
    await wait(300)
    expect(alex.chats).toHaveLength(2)
    const merged = mergeChatEvents(mergeChatEvents(null, cleanChatMessage(alex.chats[0][1])), cleanChatMessage(alex.chats[1][1]))
    expect(merged.map((e) => e.text)).toEqual(['m1', 'm2 longer', 'm3'])
    // An update that does not fit what the guest has: it asks for all again.
    expect(mergeChatEvents(merged, { ok: true, from: 9, events: [] })).toBe(null)
  })

  it('a guest whose connection is behind gets no update until it caught up, then the latest', async () => {
    const t = fakeTessel()
    const alex = await joined(await share(t), 'Alex')
    alex.client.chat('a1', true)
    await until(() => t.watching.length)
    const desc = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'bufferedAmount')
    let behind = true
    Object.defineProperty(WebSocket.prototype, 'bufferedAmount', {
      configurable: true,
      get() {
        return behind ? 2 * 1024 * 1024 : desc.get.call(this)
      }
    })
    try {
      host.sendChat('a1', { ok: true, events: [ev(1, 'first')] })
      await wait(300)
      host.sendChat('a1', { ok: true, events: [ev(1, 'latest')] })
      await wait(1300)
      expect(alex.chats).toEqual([])
      behind = false
      await until(() => alex.chats.length === 1, 3000)
      expect(alex.chats[0][1].events[0].text).toBe('latest')
      expect(alex.closed).toBe(null)
    } finally {
      Object.defineProperty(WebSocket.prototype, 'bufferedAmount', desc)
    }
  })

  it('every ask counts against the minute’s limit, answered or not', async () => {
    const t = fakeTessel()
    t.answers = { Alex: { yes: true, projects: ['ws-a'] } }
    const alex = await joined(await share(t), 'Alex')
    // Not its project: each answered "unavailable", up to the limit; then
    // "busy" once for that pane, and nothing more.
    for (let i = 0; i < 40; i++) alex.client.chat('b1', true)
    await wait(300)
    expect(alex.chats).toHaveLength(31)
    expect(alex.chats.slice(0, 30).every(([, m]) => m.code === 'unavailable')).toBe(true)
    expect(alex.chats[30][1]).toMatchObject({ ok: false, code: 'busy' })
    // Past the limit: not even watched.
    alex.client.chat('a1', true)
    await wait(100)
    expect(t.watching).toEqual([])
  })
})

describe('second review: what never reaches a guest, and what does', () => {
  const roots = cleanRoots(['C:\\Proj\\app'])
  const g = (x) => guestText(x, roots, 4000)
  const user = (text) => guestChatPayload({ ok: true, events: [{ type: 'user', id: 'hist-u1', text }] }, ['C:\\Proj\\app']).events.map((e) => e.text)

  it('%-encoding is undone on the host until nothing changes', () => {
    expect(g('C%253A%255CUsers%255Cjean%255Csecret.txt')).toBe('…')
    expect(g('C%25253A%25255CUsers%25255Cjean')).toBe('…')
  })

  it('a drive path stuck to the text before it is still a path; an address is not', () => {
    expect(g('Error:C:\\Users\\jean\\x.txt')).toBe('Error:…')
    expect(g('\x1b[1mxC:\\Users\\jean\\x\x1b[0m')).toBe('x…')
    expect(g('C:\\\\Users\\\\jean\\\\x')).toBe('…')
    expect(g('see https://example.com/a/b and http://localhost:8080/x/y')).toBe('see https://example.com/a/b and http://localhost:8080/x/y')
  })

  it('a path with spaces whose last part is a file name', () => {
    expect(g('C:\\Users\\jean\\My Files\\plan 2026.docx')).toBe('…')
    expect(g('C:\\Proj\\app\\docs\\plan 2026.docx, then more')).toBe('docs/plan 2026.docx, then more')
  })

  it('a harness block inside a prompt is cut to its last closing tag; one never closed only when it starts a line', () => {
    expect(user('please check\n<task-notification>REPORT </task-notification> MORE REPORT</task-notification>')).toEqual(['please check'])
    expect(user('fix this\n<system-reminder>SECRET never closed')).toEqual(['fix this'])
    expect(user('what does <system-reminder> mean in Claude Code?')).toEqual(['what does <system-reminder> mean in Claude Code?'])
  })

  it('a prompt that only starts like the harness is kept; the harness’s exact forms are not', () => {
    expect(user('A message arrived from my colleague: can you check?')).toEqual(['A message arrived from my colleague: can you check?'])
    expect(user('No response requested. Just read the file.')).toEqual(['No response requested. Just read the file.'])
    expect(user('(message 42) is the error I get')).toEqual(['(message 42) is the error I get'])
    expect(user('Another Claude session sent a message:\n<cross-session-message from="s2">OTHER</cross-session-message>')).toEqual([])
    expect(user('No response requested.')).toEqual([])
    expect(user('(message 1760000000-pane-3, reply to 1759-pane-1) WORKER WORDS')).toEqual([])
    expect(user('[Request interrupted by user]')).toEqual([])
  })

  it('more keys masked: Grafana, DigitalOcean, xAI, a password stuck to -p', () => {
    for (const secret of ['glsa_abcdefghijklmnopqrstuvwxyz012345', 'dop_v1_abcdefghijklmnopqrstuvwxyz0123456789', 'xai-abcdefghijklmnopqrstuvwxyz0123']) expect(g(`use ${secret} here`)).toBe('use •••• here')
    expect(g('mysql -uroot -pS3cretPw shop')).toBe('mysql -uroot -p•••• shop')
    expect(g('mkdir -p build && cp -r a b')).toBe('mkdir -p build && cp -r a b')
  })

  it('the guest takes the host’s events as they are, one for one, and never decodes them again', () => {
    const msg = cleanChatMessage({ ok: true, events: [{ type: 'user', id: 'hist-u1', text: 'C%3A%5CUsers' }, { type: 'approval', requestId: 'r' }, { type: 'assistant', messageId: 'm1', text: 'ok' }] })
    expect(msg.events).toHaveLength(3)
    expect(msg.events[0].text).toBe('C%3A%5CUsers')
    expect(msg.events[1]).toEqual({ type: 'skip' })
    expect(msg.total).toBe(3)
  })

  it('an update that does not line up is never merged: its counts must match', () => {
    const have = [1, 2, 3].map((i) => ({ type: 'assistant', messageId: `m${i}`, text: `t${i}`, imported: true }))
    const add = { type: 'assistant', messageId: 'm4', text: 't4', imported: true }
    expect(mergeChatEvents(have, { ok: true, dropped: 1, from: 2, events: [add], total: 3 }).map((e) => e.text)).toEqual(['t2', 't3', 't4'])
    expect(mergeChatEvents(have, { ok: true, dropped: 0, from: 2, events: [add], total: 4 })).toBe(null)
    expect(mergeChatEvents(have, { ok: true, dropped: 2, from: 2, events: [add], total: 3 })).toBe(null)
    expect(mergeChatEvents(have.slice(0, 2), { ok: true, dropped: 0, from: 3, events: [add], total: 4 })).toBe(null)
  })
})

describe('second review: over the wire', () => {
  let host
  afterEach(() => host?.stop())
  const ev = (i, text = `m${i}`) => ({ type: 'assistant', messageId: `m${i}`, text, imported: true })
  async function share(t) {
    const secret = newSecret()
    host = createShareHost({ secret, hostName: 'Ada', callbacks: t.callbacks })
    return { secret, port: await host.start() }
  }
  async function joined({ port, secret }, name) {
    const r = recorder()
    r.client = createShareGuest({ url: `ws://127.0.0.1:${port}/`, secret, name, signingKey: newSigningKey(), callbacks: r.callbacks })
    r.client.connect()
    await until(() => r.states.includes('joined') && r.projects)
    return r
  }

  it('a stop for a conversation the guest does not watch changes nothing (no flood of the host’s window)', async () => {
    const t = fakeTessel()
    let changes = 0
    t.callbacks.onChatsWatched = () => changes++
    const conn = await share(t)
    const alex = await joined(conn, 'Alex')
    const bea = await joined(conn, 'Bea')
    bea.client.chat('a1', true)
    await until(() => changes === 1)
    for (let i = 0; i < 300; i++) alex.client.chat('a1', false)
    await wait(200)
    expect(changes).toBe(1)
    expect(host.chatsWatched()).toEqual([{ id: 'a1', guests: [host.guests().find((x) => x.name === 'Bea').id] }])
  })

  it('when the window slides, a guest gets how many of its oldest events go, and only the new ones', async () => {
    const t = fakeTessel()
    const alex = await joined(await share(t), 'Alex')
    alex.client.chat('a1', true)
    await until(() => t.watching.length)
    host.sendChat('a1', { ok: true, events: [1, 2, 3, 4, 5].map((i) => ev(i)) })
    await until(() => alex.chats.length === 1)
    await wait(1050)
    host.sendChat('a1', { ok: true, events: [3, 4, 5, 6, 7].map((i) => ev(i)) })
    await until(() => alex.chats.length === 2)
    expect(alex.chats[1][1]).toMatchObject({ dropped: 2, from: 3, events: [ev(6), ev(7)], total: 5 })
    const merged = mergeChatEvents(mergeChatEvents([], cleanChatMessage(alex.chats[0][1])), cleanChatMessage(alex.chats[1][1]))
    expect(merged.map((e) => e.text)).toEqual(['m3', 'm4', 'm5', 'm6', 'm7'])
  })

  it('all of it again, on its own small limit; past the asks’ limit, “busy” once per pane', async () => {
    const t = fakeTessel()
    t.answers = { Alex: { yes: true, projects: ['ws-a'] } }
    const alex = await joined(await share(t), 'Alex')
    alex.client.chat('a1', true)
    await until(() => t.watching.length)
    host.sendChat('a1', { ok: true, events: [ev(1), ev(2)] })
    await until(() => alex.chats.length === 1)
    // Use up the asks (not its project: "unavailable" each time).
    for (let i = 0; i < 29; i++) alex.client.chat('b1', true)
    await until(() => alex.chats.length === 30)
    alex.client.chat('b1', true)
    alex.client.chat('b1', true)
    alex.client.chat('a2', true)
    await wait(200)
    const busy = alex.chats.slice(30)
    expect(busy.map(([id, m]) => [id, m.code])).toEqual([
      ['b1', 'busy'],
      ['a2', 'busy']
    ])
    // A resync still works: the whole conversation again.
    alex.client.resyncChat('a1')
    await until(() => alex.chats.length === 33)
    expect(alex.chats[32][1]).toMatchObject({ ok: true, dropped: 0, from: 0, events: [ev(1), ev(2)], total: 2 })
  })
})
