// @vitest-environment node
// Live Share phase 2c: a shared project's past agent conversations, what its
// terminal agents said (liveShare/shareHistory.js) and its activity
// (liveShare/shareActivity.js) as guests get them: listed with the project's
// folder only, each row named by a ref (never the session id, the account,
// the folder or the file), details and terminal texts masked like the chat
// (secrets, paths outside the project, the harness's own turns), bounded;
// the activity's events reduced to the fields the views read, masked, the
// newest 500; and the guest's own checks of what a host sends.
import { describe, it, expect, vi } from 'vitest'
import { createShareHistory, checkSessionList, checkSessionDetails, checkTerminal, listArgs, HISTORY_LIMITS } from '../liveShare/shareHistory'
import { guestActivity, checkActivity, ACTIVITY_LIMITS } from '../liveShare/shareActivity'
import { cleanRoots } from '../liveShare/shareChat'

const ROOT = 'C:\\Users\\ada\\site'
const where = { root: ROOT, roots: cleanRoots([ROOT]), rawRoots: [ROOT] }
const SECRET = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx'
const row = (id, extra = {}) => ({ agent: 'claude', id, cwd: ROOT, started: 1000, updated: 2000, title: `Fix the build ${id}`, accountId: null, ...extra })

function history(rows = [row('s-1')], details = {}) {
  const listSessions = vi.fn(async () => rows)
  const sessionDetails = vi.fn(async (q) => details[q.id] || { ok: false })
  const readTerminal = vi.fn(async () => ({ ok: true, panes: {} }))
  const h = createShareHistory({ listSessions, sessionDetails, readTerminal, key: Buffer.alloc(32, 7) })
  return { h, listSessions, sessionDetails, readTerminal }
}

describe('Live Share history: the past conversations of a shared project', () => {
  it('lists with the project folder only; rows carry a ref, never the id, account, folder or file', async () => {
    const rows = [
      row('3f2504e0-4f89-11d3-9a0c-0305e82c3301', { title: `Deploy with ${SECRET} from C:\\Users\\ada\\other\\x.txt and ${ROOT}\\src\\a.js`, accountId: 'acct-9', accountLabel: 'ada@example.com' }),
      row('s-2', { agent: 'codex', accountId: null, origin: 'ide' }),
      { agent: '../bad', id: 'x' },
      { agent: 'claude', id: '' }
    ]
    const { h, listSessions } = history(rows)
    const res = await h.list('ws-1', { limit: 50 }, where)
    expect(listSessions).toHaveBeenCalledWith({ cwd: ROOT, limit: 50 })
    expect(res.ok).toBe(true)
    const { sessions } = res.data
    expect(sessions).toHaveLength(2)
    expect(sessions[0]).toEqual({ ref: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/), agent: 'claude', title: expect.any(String), started: 1000, updated: 2000 })
    expect(sessions[1].origin).toBe('ide')
    const said = JSON.stringify(res)
    for (const leak of ['3f2504e0', 'acct-9', 'ada@example.com', SECRET, 'C:\\\\Users', 'other', 'cwd', 'accountId']) expect(said).not.toContain(leak)
    expect(sessions[0].title).toContain('src')
    expect(sessions[0].title).toContain('••••')
    // The same conversation in another project, or another share: another ref.
    const again = await h.list('ws-2', {}, where)
    expect(again.data.sessions[0].ref).not.toBe(sessions[0].ref)
    const other = createShareHistory({ listSessions: async () => rows, key: Buffer.alloc(32, 8) })
    expect((await other.list('ws-1', {}, where)).data.sessions[0].ref).not.toBe(sessions[0].ref)
  })

  it('caps the rows and the arguments; no folder (an SSH project) is unavailable', async () => {
    expect(listArgs({ limit: 500 })).toEqual({ limit: 60 })
    expect(listArgs({ limit: 0 })).toEqual({ limit: 60 })
    expect(listArgs({ limit: 200 })).toEqual({ limit: 200 })
    const many = Array.from({ length: 300 }, (_, i) => row(`s-${i}`))
    const { h } = history(many)
    const res = await h.list('ws-1', { limit: 200 }, where)
    expect(res.data.sessions).toHaveLength(HISTORY_LIMITS.rows)
    expect(res.data.truncated).toBe(true)
    expect(await h.list('ws-1', {}, { ...where, root: null })).toEqual({ ok: false, code: 'unavailable' })
  })

  it('gives the details of a listed conversation only, masked like the chat, without the harness turns', async () => {
    const details = {
      's-1': {
        ok: true,
        file: `${ROOT}\\..\\.claude\\projects\\x\\s-1.jsonl`,
        size: 1234,
        firstPrompt: `Use the key ${SECRET} and read C:\\Users\\ada\\secret.txt`,
        turns: [
          { role: 'user', text: '<system-reminder>internal</system-reminder>', at: 5 },
          { role: 'assistant', text: `Done in ${ROOT}\\src\\app.js`, at: 6 },
          { role: 'user', text: 'Thanks', at: 7 }
        ],
        messageCount: 12
      },
      's-2': { ok: true, firstPrompt: '<command-name>/clear</command-name>', turns: [] }
    }
    const { h, sessionDetails } = history([row('s-1'), row('s-2', { accountId: 'acct-1' })], details)
    expect(await h.details('ws-1', { ref: 'x'.repeat(22) }, where)).toEqual({ ok: false, code: 'not-found' })
    const { data } = await h.list('ws-1', {}, where)
    const [a, b] = data.sessions
    // Another project's ref is not this one's.
    expect(await h.details('ws-2', { ref: a.ref }, where)).toEqual({ ok: false, code: 'not-found' })
    const res = await h.details('ws-1', { ref: a.ref }, where)
    expect(sessionDetails).toHaveBeenLastCalledWith({ agent: 'claude', id: 's-1', accountId: null })
    expect(res.ok).toBe(true)
    expect(Object.keys(res.data).sort()).toEqual(['firstPrompt', 'messageCount', 'turns'])
    expect(res.data.firstPrompt).not.toContain(SECRET)
    expect(res.data.firstPrompt).not.toContain('secret.txt')
    expect(res.data.turns).toEqual([
      { role: 'assistant', text: expect.stringContaining('src'), at: 6 },
      { role: 'user', text: 'Thanks', at: 7 }
    ])
    expect(JSON.stringify(res)).not.toContain('C:\\\\Users')
    expect(res.data.messageCount).toBe(12)
    await h.details('ws-1', { ref: b.ref }, where)
    expect(sessionDetails).toHaveBeenLastCalledWith({ agent: 'claude', id: 's-2', accountId: 'acct-1' })
    expect((await h.details('ws-1', { ref: b.ref }, where)).data.firstPrompt).toBe('')
    // A project no longer shared: its refs go.
    h.forget('ws-1')
    expect(await h.details('ws-1', { ref: a.ref }, where)).toEqual({ ok: false, code: 'not-found' })
  })
})

describe('Live Share history: what the terminal agents said', () => {
  const panes = [
    { id: 'pane-1', agentId: 'claude', sessionId: 'sess-secret-1', accountId: 'acct-2', terminal: true },
    { id: 'pane-2', agentId: 'codex', sessionId: 'sess-2', terminal: false }
  ]
  it('asks for the project terminal agents only, masks each text, and never gives the reader key (it names the session)', async () => {
    const readTerminal = vi.fn(async () => ({
      ok: true,
      panes: {
        'pane-1': {
          key: 'sess-secret-1|stamp|0',
          items: [
            { role: 'user', t: 1, text: `token ${SECRET}`, images: [{ key: 'ab'.repeat(12), name: 'shot.png', mime: 'image/png', bytes: 9, source: 'user' }, { path: 'C:\\Users\\ada\\private\\x.png', missing: true }], imagesMore: 2, files: [{ name: 'a.pdf', path: 'C:\\Users\\ada\\private\\a.pdf' }] },
            // A prompt that was only an image: nothing to give a guest.
            { role: 'user', t: 1.5, text: '', images: [{ key: 'cd'.repeat(12), name: 'image.png', mime: 'image/png', bytes: 9, source: 'user' }] },
            { role: 'agent', t: 2, text: `see C:\\Users\\ada\\private\\notes.md`, model: 'Opus 5.5', effort: 'high' },
            { role: 'system', t: 3, text: 'x' }
          ]
        },
        'pane-9': { key: 'k', items: [] }
      }
    }))
    const h = createShareHistory({ readTerminal, key: Buffer.alloc(32, 1) })
    const res = await h.terminal('ws-1', { from: 10 }, { ...where, panes })
    expect(readTerminal).toHaveBeenCalledWith({ from: 10, known: {}, panes: [{ ask: 'pane-1', paneId: 'pane-1', agent: 'claude', sessionId: 'sess-secret-1', accountId: 'acct-2' }] })
    const said = JSON.stringify(res)
    expect(said).not.toContain('sess-secret-1')
    expect(said).not.toContain(SECRET)
    expect(said).not.toContain('private')
    expect(Object.keys(res.data.panes)).toEqual(['pane-1'])
    const entry = res.data.panes['pane-1']
    expect(entry.key).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(entry.items.map((i) => i.role)).toEqual(['user', 'agent'])
    // No image, image key or file of the host's ever reaches a guest.
    expect(said).not.toContain('images')
    expect(said).not.toContain('ab'.repeat(12))
    expect(said).not.toContain('a.pdf')
    expect(entry.items[1]).toMatchObject({ model: 'Opus 5.5', effort: 'high' })
    // Asked again with that key: turned back into the reader's, "same" goes back.
    readTerminal.mockResolvedValueOnce({ ok: true, panes: { 'pane-1': { key: 'sess-secret-1|stamp|0', same: true } } })
    const again = await h.terminal('ws-1', { from: 10, known: { 'pane-1': entry.key, 'pane-2': 'zz' } }, { ...where, panes })
    expect(readTerminal.mock.calls[1][0].known).toEqual({ 'pane-1': 'sess-secret-1|stamp|0' })
    expect(again.data.panes['pane-1']).toEqual({ key: entry.key, same: true })
  })

  it('keeps the newest items within the bytes cap', async () => {
    const items = Array.from({ length: 150 }, (_, i) => ({ role: 'agent', t: i, text: 'x'.repeat(5000) }))
    const h = createShareHistory({ readTerminal: async () => ({ ok: true, panes: { 'pane-1': { key: 'k', items } } }), key: Buffer.alloc(32, 1) })
    const res = await h.terminal('ws-1', {}, { ...where, panes })
    const got = res.data.panes['pane-1'].items
    expect(got.length).toBeLessThanOrEqual(HISTORY_LIMITS.items)
    expect(got.at(-1).t).toBe(149)
    expect(got.every((i) => i.text.length <= HISTORY_LIMITS.itemText)).toBe(true)
    expect(JSON.stringify(res).length).toBeLessThan(HISTORY_LIMITS.bytes + 10000)
  })
})

describe('Live Share history: the guest checks the host', () => {
  it('keeps known shapes only, cut, with this window pane ids', () => {
    const list = checkSessionList({ sessions: [{ ref: 'a'.repeat(22), agent: 'claude', title: 'x'.repeat(500), updated: 5, cwd: 'C:\\x', id: 'real' }, { ref: 'bad', agent: 'claude' }, { ref: 'b'.repeat(22), agent: '<script>' }] })
    expect(list).toEqual([{ id: 'a'.repeat(22), agent: 'claude', title: expect.any(String), started: null, updated: 5 }])
    expect(list[0].title.length).toBe(HISTORY_LIMITS.title)
    expect(checkSessionList({ sessions: 'x' })).toBe(null)
    expect(checkSessionDetails({ firstPrompt: 'hi', turns: [{ role: 'user', text: 'a', at: 1 }, { role: 'x', text: 'b' }, { text: 3 }], file: 'C:\\f' })).toEqual({ ok: true, firstPrompt: 'hi', turns: [{ role: 'user', text: 'a', at: 1 }, { role: 'assistant', text: 'b', at: null }], messageCount: null })
    const local = (id) => (id === 'pane-1' ? 'pane-ls1-1' : null)
    expect(checkTerminal({ panes: { 'pane-1': { key: 'c'.repeat(22), items: [{ role: 'agent', t: 1, text: 'ok', model: '<b>' }, { role: 'x', t: 2, text: 'no' }] }, 'pane-2': { key: 'd'.repeat(22), items: [] }, 'pane-1x': { key: 'bad' } } }, local)).toEqual({
      panes: { 'pane-ls1-1': { key: 'c'.repeat(22), items: [{ role: 'agent', t: 1, text: 'ok' }] } }
    })
  })
})

describe('Live Share activity: a shared project activity for guests', () => {
  const roots = cleanRoots([ROOT])
  it('keeps the fields the views read, masks every text, drops sessions, accounts, hosts and folders', () => {
    const events = [
      {
        t: 10,
        type: 'message',
        status: 'delivered',
        source: 'you',
        scope: 'team',
        teamId: 'team-1',
        paneId: 'pane-1',
        wsId: 'ws-1',
        text: `Use ${SECRET} in C:\\Users\\ada\\other\\x and ${ROOT}\\src`,
        preview: 'p',
        from: 'Ada',
        sender: { name: 'Ada', agentId: 'claude', model: 'Opus 5.5', effort: 'high', paneId: 'pane-1', sessionId: 'sess-9', accountId: 'acct-9', hostAddress: '10.0.0.5', remotePath: '/home/ada', worktree: 'C:\\wt\\x', num: 3 },
        secretField: 'nope'
      },
      { t: 11, type: 'agent.state', state: 'limited', reset: 'in 5 min', paneId: 'pane-2', agent: { title: 'Codex', agentId: 'codex', cwd: 'C:\\x' } },
      { t: 12, type: '<bad>' },
      { type: 'task' }
    ]
    const teams = [{ id: 'team-1', name: `Team ${SECRET}`, color: '#ff0000', secret: 1 }, { id: 'team-1', name: 'dup' }, { id: '../x', name: 'bad' }]
    const out = guestActivity(events, teams, 'ws-1', roots)
    expect(out.events).toHaveLength(2)
    const [m, st] = out.events
    expect(Object.keys(m).sort()).toEqual(['from', 'paneId', 'preview', 'scope', 'sender', 'source', 'status', 't', 'teamId', 'text', 'type', 'wsId'])
    expect(m.wsId).toBe('ws-1')
    expect(m.text).not.toContain(SECRET)
    expect(m.text).not.toContain('other')
    expect(m.text).toContain('src')
    expect(m.sender).toEqual({ name: 'Ada', agentId: 'claude', model: 'Opus 5.5', effort: 'high', paneId: 'pane-1', num: 3 })
    expect(st).toMatchObject({ type: 'agent.state', state: 'limited', reset: 'in 5 min', agent: { title: 'Codex', agentId: 'codex' } })
    expect(out.teams).toEqual([{ id: 'team-1', name: expect.not.stringContaining(SECRET), color: '#ff0000' }])
    const said = JSON.stringify(out)
    for (const leak of ['sess-9', 'acct-9', '10.0.0.5', '/home/ada', 'C:\\\\wt', 'secretField', 'nope']) expect(said).not.toContain(leak)
  })

  it('the newest 500 events at most', () => {
    const events = Array.from({ length: 900 }, (_, i) => ({ t: i, type: 'task', action: 'started', title: `t${i}` }))
    const out = guestActivity(events, [], 'ws-1', roots)
    expect(out.events).toHaveLength(ACTIVITY_LIMITS.events)
    expect(out.events[0].t).toBe(400)
    expect(out.events.at(-1).t).toBe(899)
  })

  it('the guest checks it again and gives pane ids its own names', () => {
    const data = { events: [{ t: 1, type: 'message', paneId: 'pane-1', toPaneId: 'pane-2', sender: { paneId: 'pane-1', sessionId: 'x' }, text: 'x'.repeat(9000), wsId: 'ws-1' }, { t: 'x' }], teams: [{ id: 't1', name: 'T', color: 'red' }] }
    const out = checkActivity(data, { paneId: (id) => `ls-${id}`, wsId: 'ws-9' })
    expect(out.events).toEqual([{ t: 1, type: 'message', paneId: 'ls-pane-1', toPaneId: 'ls-pane-2', sender: { paneId: 'ls-pane-1' }, text: expect.any(String), wsId: 'ws-9' }])
    expect(out.events[0].text.length).toBe(ACTIVITY_LIMITS.text)
    expect(out.teams).toEqual([{ id: 't1', name: 'T', color: null }])
    expect(checkActivity({ events: 'x' })).toBe(null)
  })
})
