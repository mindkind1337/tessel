// @vitest-environment node
// Held messages (chat:send with hold): sent while a turn runs, they wait as
// cards (never transcript rows) the user can edit, delete or send now, then
// go out one turn each at the end of the turn.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { createChatSessions } from '../sessions'

const flush = () => new Promise((r) => setImmediate(r))
const paneId = 'pane-held'

class FakeAdapter extends EventEmitter {
  constructor() {
    super()
    this.start = vi.fn(async () => ({ ok: true, pid: 1, info: {} }))
    this.send = vi.fn(async () => ({ ok: true }))
    this.interrupt = vi.fn(async () => ({ ok: true }))
    this.close = vi.fn(async () => this.emit('exit', { code: 0, signal: null, stderrTail: '', crashed: false }))
  }
}

let tmp, sent, adapters, images
function makeChat(agent = 'claude') {
  images = { take: vi.fn((_p, ids) => ({ ok: true, images: ids.map((id) => ({ id, name: `${id}.png`, width: 1, height: 1 })) })), release: vi.fn(), forAgent: (img) => img, register: () => {} }
  const chat = createChatSessions({
    dir: tmp,
    send: (_channel, payload) => sent.push(payload),
    createAdapter: () => {
      const a = new FakeAdapter()
      adapters.push(a)
      return a
    },
    resolveClaude: async () => ({ exe: 'C:\\bin\\claude.exe', exeArgs: [] }),
    resolveCodex: async () => ({ exe: 'C:\\bin\\codex.exe', exeArgs: [] }),
    resolveOpencode: async () => ({ exe: 'C:\\bin\\opencode.exe', exeArgs: [] }),
    env: { forPane: () => ({ Path: 'C:\\Windows' }) },
    team: { newSecret: () => 'f'.repeat(64), setSecret: () => {}, revokeSecret: () => {} },
    state: { register: vi.fn(async () => {}), unregister: vi.fn(async () => {}), recordChatEvent: vi.fn(async () => {}), observe: vi.fn(async () => {}) },
    trust: { isTrusted: () => true, ask: async () => true, trust: () => true },
    images
  })
  return { chat, agent }
}
async function running({ chat, agent }) {
  const r = await chat.open({ paneId, cwd: tmp, permissions: 'manual', agent })
  expect(r.ok).toBe(true)
  await flush()
  const a = adapters[0]
  const first = chat.send({ paneId, text: 'one', hold: true })
  await flush()
  a.emit('state', { state: 'running' })
  a.emit('accepted', { uuid: first.id })
  return { a, first }
}
function ipc(chat) {
  const h = {}
  chat.register({ handle: (name, fn) => (h[name] = (q) => fn({}, q)) })
  return h
}

beforeEach(() => {
  tmp = fs.mkdtempSync(join(os.tmpdir(), 'tessel-chat-held-'))
  sent = []
  adapters = []
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

const events = (type) => sent.filter((p) => p.paneId === paneId && (!type || p.event.type === type)).map((p) => p.event)
const userRows = () => events('user').map((u) => [u.text, u.status])

describe('held messages', () => {
  it('idle: goes at once as a row; mid-turn: waits as a card, then goes alone at the end of the turn', async () => {
    const env = makeChat()
    const { a } = await running(env)
    expect(userRows()).toEqual([['one', 'sent']])
    const second = env.chat.send({ paneId, text: 'two', hold: true })
    expect(second).toMatchObject({ ok: true, queued: true, held: true })
    expect(events('queuedMessage')).toEqual([{ type: 'queuedMessage', id: second.id, text: 'two', at: expect.any(Number) }])
    // Not a row, not written to the agent.
    expect(userRows()).toEqual([['one', 'sent']])
    await flush()
    expect(a.send).toHaveBeenCalledTimes(1)
    expect(env.chat.history({ paneId }).queuedMessages).toEqual([{ id: second.id, text: 'two', at: expect.any(Number) }])
    a.emit('turnEnd', { status: 'completed' })
    await flush()
    // Its row now, where it goes out; then sent as a turn of its own.
    expect(userRows()).toEqual([['one', 'sent'], ['two', 'sent']])
    expect(a.send).toHaveBeenLastCalledWith({ uuid: second.id, text: 'two' })
    expect(env.chat.history({ paneId }).queuedMessages).toEqual([])
  })

  it('edited and deleted while waiting: the edit goes out, the deleted one never does', async () => {
    const env = makeChat()
    const { a } = await running(env)
    const h = ipc(env.chat)
    const keep = env.chat.send({ paneId, text: 'draft', hold: true })
    const drop = env.chat.send({ paneId, text: 'never', hold: true, imageIds: ['img1'] })
    expect(await h['chat:queuedEdit']({ paneId, id: keep.id, text: 'final words' })).toEqual({ ok: true })
    expect(events('queuedMessage').at(-1)).toMatchObject({ id: keep.id, text: 'final words' })
    expect(await h['chat:queuedDelete']({ paneId, id: drop.id })).toEqual({ ok: true })
    expect(events('queuedRemoved')).toEqual([{ type: 'queuedRemoved', id: drop.id }])
    expect(images.release).toHaveBeenCalledWith(['img1'])
    a.emit('turnEnd', { status: 'completed' })
    await flush()
    a.emit('turnEnd', { status: 'completed' })
    await flush()
    expect(a.send.mock.calls.map((c) => c[0].text)).toEqual(['one', 'final words'])
    expect(userRows().map((r) => r[0])).not.toContain('never')
    // Gone (already sent): said, nothing changed.
    expect(await h['chat:queuedEdit']({ paneId, id: keep.id, text: 'late' })).toMatchObject({ ok: false, code: 'gone' })
    expect(await h['chat:queuedDelete']({ paneId, id: keep.id })).toMatchObject({ ok: false, code: 'gone' })
    // Refused input.
    for (const bad of [null, { paneId, id: 'bad id' }, { paneId: '../x', id: keep.id }]) expect(await h['chat:queuedDelete'](bad)).toMatchObject({ code: 'invalid' })
    expect(await h['chat:queuedEdit']({ paneId, id: keep.id, text: 5 })).toMatchObject({ code: 'invalid' })
    expect(await h['chat:send']({ paneId, text: 'x', hold: 'yes' })).toMatchObject({ code: 'invalid' })
  })

  it('Send now steers it into the running turn ahead of the others (Claude, Codex); OpenCode cannot', async () => {
    const env = makeChat()
    const { a } = await running(env)
    const h = ipc(env.chat)
    const b = env.chat.send({ paneId, text: 'b', hold: true })
    const c = env.chat.send({ paneId, text: 'c', hold: true })
    expect(await h['chat:queuedSend']({ paneId, id: c.id })).toEqual({ ok: true, steered: true })
    await flush()
    expect(a.send).toHaveBeenLastCalledWith({ uuid: c.id, text: 'c' })
    expect(userRows()).toEqual([['one', 'sent'], ['c', 'sent']])
    expect(env.chat.history({ paneId }).queuedMessages.map((m) => m.id)).toEqual([b.id])
    await env.chat.close({ paneId })

    adapters = []
    sent = []
    const oc = makeChat('opencode')
    await running(oc)
    const d = oc.chat.send({ paneId, text: 'd', hold: true })
    expect(await ipc(oc.chat)['chat:queuedSend']({ paneId, id: d.id })).toMatchObject({ ok: false, code: 'cannot' })
    expect(oc.chat.history({ paneId }).queuedMessages.map((m) => m.id)).toEqual([d.id])
  })

  it('the chat ending first: each card becomes a failed row (its text kept), nothing is sent', async () => {
    const env = makeChat()
    const { a } = await running(env)
    const b = env.chat.send({ paneId, text: 'too late', hold: true })
    await env.chat.close({ paneId })
    expect(events('user').find((u) => u.id === b.id)).toMatchObject({ text: 'too late', status: 'failed', origin: 'user' })
    expect(a.send).toHaveBeenCalledTimes(1)
  })

  it('without hold, a mid-turn message still steers at once', async () => {
    const env = makeChat()
    await running(env)
    expect(env.chat.send({ paneId, text: 'now' })).toMatchObject({ queued: false, steered: true })
    expect(events('queuedMessage')).toEqual([])
  })
})
