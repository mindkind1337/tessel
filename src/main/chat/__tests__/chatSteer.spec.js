// @vitest-environment node
// A message sent while a turn runs, end to end: the session manager with the
// real adapters against the fake CLIs (fixtures/fake-claude.cjs,
// fixtures/fake-codex.cjs). Nothing real is ever run.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { createChatSessions } from '../sessions'
import { createClaudeChat } from '../claudeChat'
import { createCodexChat } from '../codexChat'

const FAKE_CLAUDE = join(__dirname, 'fixtures', 'fake-claude.cjs')
const FAKE_CODEX = join(__dirname, 'fixtures', 'fake-codex.cjs')
const paneId = 'pane-steer'

let tmp, sent, logFile, chat
function setup(fakeEnv = {}) {
  logFile = join(tmp, 'fake-log.jsonl')
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, FAKE_CLAUDE_LOG: logFile, FAKE_CODEX_LOG: logFile, ...fakeEnv }
  chat = createChatSessions({
    dir: tmp,
    send: (channel, payload) => sent.push(payload),
    createAdapter: (opts) =>
      opts.agent === 'codex'
        ? createCodexChat({ ...opts, exe: process.execPath, exeArgs: [FAKE_CODEX], env })
        : createClaudeChat({ ...opts, exe: process.execPath, exeArgs: [FAKE_CLAUDE], env }),
    resolveClaude: async () => ({ exe: process.execPath, exeArgs: [FAKE_CLAUDE] }),
    resolveCodex: async () => ({ exe: process.execPath, exeArgs: [FAKE_CODEX] }),
    env: { forPane: () => ({ PATH: process.env.PATH }) },
    team: { newSecret: () => 'f'.repeat(64), setSecret: () => {}, revokeSecret: () => {} },
    state: { register: vi.fn(async () => {}), unregister: vi.fn(async () => {}), recordChatEvent: vi.fn(async () => {}), observe: vi.fn(async () => {}) },
    trust: { isTrusted: () => true, ask: async () => true, trust: () => true }
  })
  return chat
}

beforeEach(() => {
  tmp = fs.mkdtempSync(join(os.tmpdir(), 'tessel-chat-steer-'))
  sent = []
})
afterEach(async () => {
  await chat?.close({ paneId, kill: true }).catch(() => {})
  chat = null
  fs.rmSync(tmp, { recursive: true, force: true })
})

const events = (type) => sent.filter((p) => p.paneId === paneId && p.event && (!type || p.event.type === type)).map((p) => p.event)
const fakeIn = () =>
  fs.existsSync(logFile)
    ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.t === 'in').map((r) => r.m)
    : []
async function waitFor(fn, ms = 8000, label = 'condition') {
  const t0 = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for ' + label)
    await new Promise((r) => setTimeout(r, 5))
  }
}
const statuses = () => events('status').map((e) => e.state)
const userStatuses = (id) => events('userStatus').filter((e) => e.id === id).map((e) => e.status)

async function openChat(agent) {
  const r = await chat.open({ paneId, cwd: tmp, permissions: 'manual', agent })
  expect(r.ok).toBe(true)
}

describe('a message sent mid-turn (Claude)', { timeout: 30000 }, () => {
  it('the CLI folds it: written at once, accepted in the running turn, one turn end, no second send', async () => {
    setup({ FAKE_CLAUDE_FOLD: '1' })
    await openChat('claude')
    const a = chat.send({ paneId, text: 'SLOW count' })
    await waitFor(() => events('assistantDelta').length > 3, 8000, 'first deltas')
    const b = chat.send({ paneId, text: 'also this' })
    expect(b).toMatchObject({ ok: true, queued: false, steered: true })
    expect(events('user').find((u) => u.id === b.id)).toMatchObject({ status: 'sent', origin: 'user' })
    // The frame is on the CLI's stdin while the turn still runs.
    await waitFor(() => fakeIn().some((m) => m.type === 'user' && m.uuid === b.id), 3000, 'frame written')
    expect(events('turnEnd')).toEqual([])
    await waitFor(() => userStatuses(b.id).includes('accepted'), 3000, 'b accepted')
    expect(events('turnEnd')).toEqual([])
    await waitFor(() => statuses().at(-1) === 'idle' && events('turnEnd').length === 1, 10000, 'idle')
    await new Promise((r) => setTimeout(r, 60))
    expect(events('turnEnd')).toHaveLength(1)
    expect(events('turnEnd')[0].status).toBe('completed')
    expect(userStatuses(a.id)).toEqual(['accepted'])
    expect(userStatuses(b.id)).toEqual(['accepted'])
    // Transcript order: the user rows as sent; the reply (with what joined) after them.
    const order = events().filter((e) => ['user', 'assistant', 'turnEnd'].includes(e.type)).map((e) => (e.type === 'user' ? e.text : e.type))
    expect(order[0]).toBe('SLOW count')
    expect(order[1]).toBe('also this')
    expect(order.at(-1)).toBe('turnEnd')
    expect(events('assistant').at(-1).text).toMatch(/\(folded: also this\)$/)
    expect(fakeIn().filter((m) => m.type === 'user').map((m) => m.uuid)).toEqual([a.id, b.id])
  })

  it('the CLI runs it as the next turn: the chat stays working between, accepted after the first end, then idle', async () => {
    setup()
    await openChat('claude')
    const a = chat.send({ paneId, text: 'SLOW count' })
    await waitFor(() => events('assistantDelta').length > 3, 8000, 'first deltas')
    const b = chat.send({ paneId, text: 'then this' })
    expect(b).toMatchObject({ queued: false, steered: true })
    await waitFor(() => fakeIn().some((m) => m.type === 'user' && m.uuid === b.id), 3000, 'frame written')
    // A team message meanwhile waits for the end of it all.
    expect(chat.sendTeam({ paneId, messages: [{ id: 'm1', from: '#2', text: 'team note' }] }).ids).toEqual(['m1'])
    await waitFor(() => events('turnEnd').length === 2, 10000, 'second turn end')
    // No idle between the two turns: the carried one kept it working.
    const turnEndSeq = sent.filter((p) => p.event?.type === 'turnEnd').map((p) => p.seq)
    const idleBetween = sent.filter((p) => p.event?.type === 'status' && p.event.state === 'idle' && p.seq > turnEndSeq[0] && p.seq < turnEndSeq[1])
    expect(idleBetween).toEqual([])
    expect(userStatuses(b.id)).toEqual(['accepted'])
    // Then the team batch as a turn of its own, and idle at the end.
    await waitFor(() => events('turnEnd').length === 3 && statuses().at(-1) === 'idle', 10000, 'team turn and idle')
    const users = fakeIn().filter((m) => m.type === 'user')
    expect(users.map((m) => m.uuid).slice(0, 2)).toEqual([a.id, b.id])
    expect(users).toHaveLength(3)
    expect(users[2].message.content.at(-1).text).toContain('team note')
    expect(events('teamAccepted')).toEqual([{ type: 'teamAccepted', ids: ['m1'] }])
  })

  it('interrupted before the CLI took it: it still runs after the interrupted turn, never sent twice', async () => {
    setup()
    await openChat('claude')
    chat.send({ paneId, text: 'SLOW count' })
    await waitFor(() => events('assistantDelta').length > 3, 8000, 'first deltas')
    const b = chat.send({ paneId, text: 'after the stop' })
    await waitFor(() => fakeIn().some((m) => m.type === 'user' && m.uuid === b.id), 3000, 'frame written')
    expect(await chat.interrupt({ paneId })).toEqual({ ok: true })
    await waitFor(() => events('turnEnd').length === 2 && statuses().at(-1) === 'idle', 10000, 'second turn and idle')
    expect(events('turnEnd').map((e) => e.status)).toEqual(['interrupted', 'completed'])
    expect(userStatuses(b.id)).toEqual(['accepted'])
    expect(fakeIn().filter((m) => m.type === 'user' && m.uuid === b.id)).toHaveLength(1)
  })
})

describe('a message sent mid-turn (Codex)', { timeout: 30000 }, () => {
  it('goes as turn/steer at once and joins the running turn: one turn end, accepted, no second send', async () => {
    setup()
    await openChat('codex')
    const a = chat.send({ paneId, text: 'SLOW count' })
    await waitFor(() => events('assistantDelta').length > 3, 8000, 'first deltas')
    const b = chat.send({ paneId, text: 'also say banana' })
    expect(b).toMatchObject({ ok: true, queued: false, steered: true })
    await waitFor(() => fakeIn().some((m) => m.method === 'turn/steer'), 3000, 'turn/steer written')
    expect(events('turnEnd')).toEqual([])
    await waitFor(() => events('turnEnd').length === 1 && statuses().at(-1) === 'idle', 10000, 'idle')
    await new Promise((r) => setTimeout(r, 60))
    expect(events('turnEnd')).toHaveLength(1)
    expect(userStatuses(a.id)).toEqual(['accepted'])
    expect(userStatuses(b.id)).toEqual(['accepted'])
    expect(fakeIn().filter((m) => m.method === 'turn/start')).toHaveLength(1)
    expect(fakeIn().filter((m) => m.method === 'turn/steer').map((m) => m.params.clientUserMessageId)).toEqual([b.id])
    expect(events('assistant').at(-1).text).toMatch(/steered: also say banana/)
  })
})
