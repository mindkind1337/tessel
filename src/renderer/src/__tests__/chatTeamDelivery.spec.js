// Team messages for a chat agent (App.vue pushToChats): never typed; held in
// flight on disk, given to the chat as a turn (window.shellApi.chat.sendTeam),
// marked read once the agent took that turn (teamAccepted), released for a
// later try when it could not (teamFailed, or the send refused). Runs
// App.vue's own functions (as appSettingsBehavior.spec.js does).
import { describe, expect, it, vi, beforeEach } from 'vitest'
import fs from 'fs'
import vm from 'vm'
import { join } from 'path'

const source = fs.readFileSync(join(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')
function slice(from, to) {
  const a = source.indexOf(from)
  const b = source.indexOf(to, a)
  if (a < 0 || b < 0) throw new Error(`App.vue changed: ${from}`)
  return source.slice(a, b)
}

describe('team messages for a chat agent', () => {
  let ctx, channel, chat, leaves
  const team = { id: 'team-1', name: 'Team' }
  const res = (deliveries, held = []) => ({
    participants: [{ id: 'pane-a', num: 1, paneName: 'Ada', title: 'Codex' }],
    deliveries,
    held
  })
  const msg = (id, extra = {}) => ({ id, fromId: 'pane-a', toId: 'pane-c', text: `hello ${id}`, ...extra })

  beforeEach(() => {
    leaves = { 'pane-c': { id: 'pane-c', kind: 'chat' }, 'pane-t': { id: 'pane-t', kind: 'agent' } }
    channel = {
      hold: vi.fn(async () => ({ ok: true })),
      release: vi.fn(async () => ({ ok: true })),
      ack: vi.fn(async () => ({ ok: true }))
    }
    chat = { sendTeam: vi.fn(async () => ({ ok: true })) }
    ctx = {
      window: { shellApi: { channel, chat } },
      paneLabel: (pane) => `${pane.paneName} (${pane.title})`,
      findLeaf: (id) => leaves[id] || null,
      channelQueued: new Set(),
      ackChannel: vi.fn(),
      Map,
      Object,
      Array,
      Promise
    }
    vm.createContext(ctx)
    vm.runInContext(
      slice('const chatTeamPending = new Map()', 'let offChatEvents = null') +
        '\nthis.api = { pushToChats, acceptChatTeam, releaseChatTeam, chatTeamPending }',
      ctx
    )
  })

  it('holds each message, gives them to the chat in one call, and marks them read only once accepted', async () => {
    await ctx.api.pushToChats(team, 'C:\\p\\.tessel', res([msg('m1', { replyTo: 'm0' }), msg('m2')]))
    expect(channel.hold).toHaveBeenCalledTimes(2)
    expect(channel.hold).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1', toId: 'pane-c', state: 'inflight' }))
    expect(chat.sendTeam).toHaveBeenCalledTimes(1)
    const sent = chat.sendTeam.mock.calls[0][0]
    expect(sent.paneId).toBe('pane-c')
    expect(sent.messages.map((m) => m.id)).toEqual(['m1', 'm2'])
    expect(sent.messages[0].from).toBe('Ada (Codex)')
    expect(sent.messages[0].text).toBe('(message m1, reply to m0) hello m1')
    expect(ctx.ackChannel).not.toHaveBeenCalled()
    ctx.api.acceptChatTeam('m1')
    expect(ctx.ackChannel).toHaveBeenCalledTimes(1)
    expect(ctx.ackChannel.mock.calls[0][2].id).toBe('m1')
    // Once only.
    ctx.api.acceptChatTeam('m1')
    expect(ctx.ackChannel).toHaveBeenCalledTimes(1)
  })

  it('a message the chat could not take is released for a later try', async () => {
    await ctx.api.pushToChats(team, 'dir', res([msg('m1')]))
    ctx.api.releaseChatTeam('m1')
    expect(channel.release).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1', toId: 'pane-c' }))
    expect(ctx.channelQueued.size).toBe(0)
    // A refused send releases at once.
    chat.sendTeam.mockResolvedValueOnce({ ok: false })
    await ctx.api.pushToChats(team, 'dir', res([msg('m2')]))
    expect(channel.release).toHaveBeenCalledWith(expect.objectContaining({ id: 'm2' }))
  })

  it('only chat panes; a message it could not hold is left for the next poll; receipts are just acknowledged', async () => {
    channel.hold.mockResolvedValueOnce({ ok: false })
    await ctx.api.pushToChats(
      team,
      'dir',
      res([
        msg('m1'),
        { id: 'm2', fromId: 'pane-a', toId: 'pane-t', text: 'for a terminal agent' },
        { id: 'r1', fromId: 'tessel', toId: 'pane-c', text: 'Delivered to #1' }
      ])
    )
    expect(chat.sendTeam).not.toHaveBeenCalled()
    expect(ctx.ackChannel).toHaveBeenCalledTimes(1)
    expect(ctx.ackChannel.mock.calls[0][2].id).toBe('r1')
    expect(ctx.channelQueued.has('team-1:m1:pane-c')).toBe(false)
  })

  it('a message held by an earlier session is released (given again, never lost)', async () => {
    await ctx.api.pushToChats(team, 'dir', res([], [msg('old')]))
    expect(channel.release).toHaveBeenCalledWith(expect.objectContaining({ id: 'old', toId: 'pane-c' }))
  })
})

// Results for a chat coordinator (App.vue pointChatAtInbox): once its
// notice is written, a team turn points it at team_inbox; one pointer at a
// time per chat, a new one once that turn was taken or failed.
describe('worker results for a chat coordinator', () => {
  let ctx, chat, leaves, clock
  beforeEach(() => {
    leaves = { 'pane-c': { id: 'pane-c', kind: 'chat' }, 'pane-t': { id: 'pane-t', kind: 'agent' } }
    chat = { sendTeam: vi.fn(async () => ({ ok: true })) }
    clock = 1000
    let n = 0
    ctx = {
      window: { shellApi: { chat } },
      findLeaf: (id) => leaves[id] || null,
      newId: (p) => `${p}-${++n}`,
      CHAT_RESULTS_POINTER: 'POINTER',
      Date: { now: () => clock },
      Object,
      Promise
    }
    vm.createContext(ctx)
    vm.runInContext(slice('const chatPointers = {}', 'const noticeId =') + '\nthis.api = { pointChatAtInbox, pointerSettled, chatPointers }', ctx)
  })
  const flush = () => new Promise((r) => setTimeout(r, 0))

  it('points a chat at its inbox once until that turn is taken; never a terminal', async () => {
    ctx.api.pointChatAtInbox('pane-c')
    ctx.api.pointChatAtInbox('pane-c')
    ctx.api.pointChatAtInbox('pane-t')
    ctx.api.pointChatAtInbox('gone')
    await flush()
    expect(chat.sendTeam).toHaveBeenCalledTimes(1)
    expect(chat.sendTeam.mock.calls[0][0]).toEqual({ paneId: 'pane-c', messages: [{ id: 'msg-1', from: 'Tessel', text: 'POINTER' }] })
    // Taken (or failed): the next result points again.
    ctx.api.pointerSettled(['other'])
    ctx.api.pointChatAtInbox('pane-c')
    expect(chat.sendTeam).toHaveBeenCalledTimes(1)
    ctx.api.pointerSettled(['msg-1'])
    ctx.api.pointChatAtInbox('pane-c')
    expect(chat.sendTeam).toHaveBeenCalledTimes(2)
  })

  it('a pointer the chat refused, or one never settled for long, is sent again', async () => {
    chat.sendTeam.mockResolvedValueOnce({ ok: false })
    ctx.api.pointChatAtInbox('pane-c')
    await flush()
    ctx.api.pointChatAtInbox('pane-c')
    await flush()
    expect(chat.sendTeam).toHaveBeenCalledTimes(2)
    clock += 16 * 60 * 1000
    ctx.api.pointChatAtInbox('pane-c')
    expect(chat.sendTeam).toHaveBeenCalledTimes(3)
  })
})
