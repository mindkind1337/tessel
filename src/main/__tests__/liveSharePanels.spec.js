// @vitest-environment node
// Live Share phase 2b (liveShare/sharePanels.js, shareRequests.js' Local
// History and review ops, shareHost.js' host-wide topics, liveShare.js): what
// a guest sees of the host's panes beyond their screens, read only. Each
// shared pane's model, effort, state and task go out at most once a second,
// masked, without where its conversation is; a pane's sub-agents are read on
// the host (their ids hashed); the host's usage goes only to a guest with
// the usage right, from readings the host already has (never a provider
// read for it), and goes away with the right; the task history has times and
// tokens, dollars only with the usage right; a file's Local History and a
// task branch's review are scoped to the project (relative paths, hidden
// files counted, caps); a guest asking to delete a card with its own copy
// makes the host confirm. End to end over real WebSockets on 127.0.0.1 (only
// Cloudflare's tunnel is faked), as the phase 2a specs do.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { registerLiveShare } from '../liveShare'
import { createShareHost } from '../liveShare/shareHost'
import { createShareGuest } from '../liveShare/shareGuest'
import { newSecret, newSigningKey, encodeInvite, decodeInvite } from '../liveShare/shareCrypto'
import { createShareRequests } from '../liveShare/shareRequests'
import { createShareScope } from '../liveShare/shareScope'
import { createShareUsage } from '../liveShare/shareUsage'
import { cleanRoots } from '../liveShare/shareChat'
import { registerProviderUsage } from '../providerUsageIpc'
import { createLocalHistory } from '../localHistory'
import { TOPICS, OP_AREAS } from '../liveShare/shareChannel'
import { createGuestReview, splitRawNumstat } from '../liveShare/shareReview'
import { guestPanes, checkPanes, createAgentsFeed, guestChildren, checkChildren, hostHistory, guestHistory, checkHistory, hostTaskCopies, checkUsage, checkReviewInfo, checkReviewDiff, PANE_LIMITS, HISTORY_LIMITS } from '../liveShare/sharePanels'

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 })

const tunnel = vi.hoisted(() => ({ alive: true }))
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
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' }).toString()
const put = (base, rel, text) => {
  const p = join(base, ...rel.split('/'))
  fs.mkdirSync(join(p, '..'), { recursive: true })
  fs.writeFileSync(p, text)
  return p
}
const HOST_ROOTS = cleanRoots(['C:\\Users\\ada\\site'])
const SECRET_KEY = 'sk-ant-api03-abcdefghijklmnopqrstuv'

// --- The copies, field by field ------------------------------------------------------
describe('what a guest gets of the host\u2019s panes (sharePanels.js)', () => {
  it('keeps the fields a header shows, masked and cut; where sub-agents are read stays on the host', () => {
    const { panes, children } = guestPanes(
      [
        {
          id: 'pane-1',
          kind: 'agent',
          agentId: 'claude',
          model: 'Opus 4.7 \u00b7 high',
          state: 'working',
          since: 5,
          task: `Fix C:\\Users\\ada\\private\\notes.txt with ${SECRET_KEY}`,
          attention: true,
          team: { name: 'Team 2', lead: true },
          copy: { branch: 'agent/fix', path: 'C:\\Users\\ada\\site.worktrees\\fix' },
          children: { agent: 'claude', sessionId: 'sess-secret-1', accountId: 'acct-secret', remoteHostId: 'host-secret-7' },
          pid: 4242,
          env: { TOKEN: 'nope' }
        },
        { id: 'pane-2', kind: 'shell', model: 'not a model', task: 'not a task', state: 'working', reset: 'x' },
        { id: 'pane-3', kind: 'agent', state: 'limited', reset: 'in 2 h' },
        { id: 'pane-9', kind: 'agent', model: 'not shared' },
        { id: 'bad id!', kind: 'agent' },
        { id: 'pane-1', kind: 'agent', model: 'twice' }
      ],
      HOST_ROOTS,
      (id) => id !== 'pane-9'
    )
    expect(panes.map((p) => p.id)).toEqual(['pane-1', 'pane-2', 'pane-3'])
    expect(panes[0]).toEqual({
      id: 'pane-1',
      kind: 'agent',
      agentId: 'claude',
      model: 'Opus 4.7 \u00b7 high',
      state: 'working',
      sleeping: false,
      since: 5,
      task: expect.any(String),
      attention: true,
      reset: '',
      team: { name: 'Team 2', lead: true },
      copy: { branch: 'agent/fix' },
      children: true
    })
    expect(panes[0].task).toMatch(/^Fix /)
    expect(panes[0].task).not.toContain('ada')
    expect(panes[0].task).not.toContain(SECRET_KEY)
    // A shell has no model, state or task to show.
    expect(panes[1]).toMatchObject({ kind: 'shell', model: '', state: null, task: '', reset: '', children: false })
    expect(panes[2]).toMatchObject({ state: 'limited', reset: 'in 2 h' })
    // An SSH pane's host stays on the host's side too (its sub-agents are read there).
    expect(children.get('pane-1')).toEqual({ agent: 'claude', sessionId: 'sess-secret-1', accountId: 'acct-secret', remoteHostId: 'host-secret-7' })
    const said = JSON.stringify(panes)
    for (const s of ['sess-secret-1', 'acct-secret', 'host-secret-7', 'worktrees', 'TOKEN', '4242', 'not shared']) expect(said).not.toContain(s)
    // At most PANE_LIMITS.panes of a project.
    expect(guestPanes(Array.from({ length: 80 }, (_, i) => ({ id: `pane-${i}`, kind: 'agent' }))).panes).toHaveLength(PANE_LIMITS.panes)
  })

  it('the guest checks the copy again', () => {
    const { panes } = guestPanes([{ id: 'pane-1', kind: 'agent', model: 'Sonnet', state: 'approval', team: { name: 'T' } }], HOST_ROOTS)
    expect(checkPanes(panes)).toEqual(panes)
    expect(checkPanes('x')).toBe(null)
    expect(checkPanes(Array.from({ length: PANE_LIMITS.panes + 1 }, (_, i) => ({ id: `p-${i}` })))).toBe(null)
    expect(checkPanes([{ id: 'pane-1', kind: 'weird', state: 'nope', model: 5, team: { name: '' }, copy: 'x', children: 'yes' }, { id: '../x' }])).toEqual([
      { id: 'pane-1', kind: 'shell', agentId: null, model: '', state: null, sleeping: false, since: null, task: '', attention: false, reset: '', team: null, copy: null, children: false }
    ])
    expect(checkPanes([{ id: 'pane-1', kind: 'agent', state: 'teleporting', model: 'x'.repeat(500) }])[0]).toMatchObject({ state: null, model: 'x'.repeat(PANE_LIMITS.model) })
  })

  it('goes out at most once a second per project, the latest, never the same twice', () => {
    vi.useFakeTimers()
    try {
      let now = 10_000
      const pushes = []
      const feed = createAgentsFeed({ push: (project, data) => pushes.push([project, data.n]), clock: () => now })
      feed.set('ws-1', { n: 1 })
      expect(pushes).toEqual([['ws-1', 1]])
      now += 100
      feed.set('ws-1', { n: 2 })
      now += 100
      feed.set('ws-1', { n: 3 })
      expect(pushes).toHaveLength(1)
      // Another project is not held back.
      feed.set('ws-2', { n: 1 })
      expect(pushes).toEqual([['ws-1', 1], ['ws-2', 1]])
      // The timer was set for a second after the first push (900 ms after n=2).
      vi.advanceTimersByTime(899)
      expect(pushes).toHaveLength(2)
      now += 800
      vi.advanceTimersByTime(1)
      expect(pushes).toEqual([['ws-1', 1], ['ws-2', 1], ['ws-1', 3]])
      // The same copy again: nothing.
      now += 5000
      feed.set('ws-1', { n: 3 })
      vi.advanceTimersByTime(5000)
      expect(pushes).toHaveLength(3)
      // A guest that starts following gets the latest at once.
      feed.sendNow('ws-1')
      expect(pushes.at(-1)).toEqual(['ws-1', 3])
      expect(feed.current('ws-1')).toEqual({ n: 3 })
      now += 10
      feed.set('ws-1', { n: 4 })
      feed.reset()
      vi.advanceTimersByTime(5000)
      expect(pushes.at(-1)).toEqual(['ws-1', 3])
    } finally {
      vi.useRealTimers()
    }
  })

  it('a pane\u2019s sub-agents: their ids hashed, their titles masked, no session or file', () => {
    const items = guestChildren(
      [
        { id: 'toolu_01ABCDEF', title: `Read C:\\Users\\ada\\private\\x.txt (${SECRET_KEY})`, type: 'Explore', model: 'claude-haiku', effort: 'low', state: 'running', background: true, startedAt: 10, lastAt: 20, tokens: 1234, transcriptPath: 'C:\\Users\\ada\\.claude\\projects\\x.jsonl', sessionId: 'sess-child-1' },
        { id: 7, title: 'second', state: 'weird' }
      ],
      HOST_ROOTS
    )
    expect(items[0].id).toMatch(/^[0-9a-f]{16}$/)
    expect(items[0]).toMatchObject({ type: 'Explore', model: 'claude-haiku', effort: 'low', state: 'running', background: true, startedAt: 10, lastAt: 20, tokens: 1234, endedAt: null })
    expect(items[0].title).not.toContain('ada')
    expect(items[0].title).not.toContain(SECRET_KEY)
    expect(items[1].state).toBe('done')
    const said = JSON.stringify(items)
    for (const s of ['toolu_01ABCDEF', 'x.jsonl', 'sess-child-1']) expect(said).not.toContain(s)
    expect(guestChildren(Array.from({ length: 80 }, (_, i) => ({ id: `c${i}` })))).toHaveLength(PANE_LIMITS.children)
    expect(checkChildren(items)).toEqual(items)
    // An id that is not one of the host's hashes is not taken.
    expect(checkChildren([{ id: 'toolu_01ABCDEF' }])).toEqual([])
    expect(checkChildren('x')).toBe(null)
  })

  it('the task history: times and tokens always, the costs in dollars only with the usage right', () => {
    const cost = { status: 'ok', inputTokens: 100, outputTokens: 50, cacheReadTokens: 5, cacheWriteTokens: 1, usd: 1.25, known: true, models: [{ model: 'claude-opus-4-7', inputTokens: 100, outputTokens: 50, usd: 1.25, known: true }], subagents: 2, final: true, reason: 'x', model: 'claude-opus-4-7', provider: 'anthropic' }
    const records = hostHistory([
      { id: 'task-1', title: 'Fix C:\\Users\\ada\\private\\a.txt', wsId: 'ws-1', paneId: 'pane-1', agentName: 'Claude Code', agentKind: 'claude', project: 'site', doneAt: 20, durationMs: 1000, workPeriods: [{ start: 1, end: 2, paneId: 'pane-1' }], cost },
      { id: 'task-2', title: 'Two', doneAt: 10, durationMs: 5, cost: null },
      { id: 'task-1', title: 'twice', doneAt: 30 },
      { id: '../x', title: 'bad' },
      'nope'
    ])
    expect(records.map((r) => r.id)).toEqual(['task-2', 'task-1'])
    const without = guestHistory(records, { roots: HOST_ROOTS, usd: false })
    expect(without.usd).toBe(false)
    const one = without.records.find((r) => r.id === 'task-1')
    expect(one).toMatchObject({ title: expect.stringMatching(/^Fix /), paneId: 'pane-1', agentName: 'Claude Code', agentKind: 'claude', doneAt: 20, durationMs: 1000, workPeriods: [{ start: 1, end: 2 }] })
    expect(one.title).not.toContain('ada')
    expect(one.cost).toEqual({ status: 'ok', inputTokens: 100, outputTokens: 50, cacheReadTokens: 5, cacheWriteTokens: 1, models: [{ model: 'claude-opus-4-7', inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 }], subagents: 2, incomplete: false })
    expect(JSON.stringify(without.records)).not.toMatch(/usd|known|anthropic/)
    // A model's name is masked like any text of the host's.
    expect(JSON.stringify(guestHistory([{ id: 'task-9', cost: { status: 'ok', models: [{ model: 'C:\\Users\\ada\\models\\local.gguf' }] } }], { roots: HOST_ROOTS }))).not.toContain('ada')
    const withUsd = guestHistory(records, { roots: HOST_ROOTS, usd: true })
    expect(withUsd.usd).toBe(true)
    expect(withUsd.records.find((r) => r.id === 'task-1').cost).toMatchObject({ usd: 1.25, known: true, models: [expect.objectContaining({ usd: 1.25, known: true })] })
    // Figures read on the host for a record the window had none for.
    const read = guestHistory(records, { usd: false, costs: { 'task-2': { status: 'unavailable', reason: 'missing-file', usd: 9 } } })
    expect(read.records.find((r) => r.id === 'task-2').cost).toEqual({ status: 'unavailable', reason: 'missing-file' })
    // The guest drops dollars a host sent without saying it may.
    const checked = checkHistory({ records: withUsd.records, usd: false })
    expect(JSON.stringify(checked.records)).not.toMatch(/usd/)
    expect(checkHistory({ records: withUsd.records, usd: true }).records.find((r) => r.id === 'task-1').cost.usd).toBe(1.25)
    expect(checkHistory({ records: 'x' })).toBe(null)
    // The newest HISTORY_LIMITS.records.
    const many = hostHistory(Array.from({ length: 600 }, (_, i) => ({ id: `task-${i}`, doneAt: i + 1 })))
    expect(many).toHaveLength(HISTORY_LIMITS.records)
    expect(many[0].id).toBe('task-100')
  })

  it('keeps a card\u2019s own copy for the review on the host; the usage copy has nothing of an account', () => {
    const copies = hostTaskCopies([
      { id: 'task-1', worktree: { root: 'C:\\site', path: 'C:\\site.worktrees\\a', branch: 'agent/a', baseBranch: 'dev' } },
      { id: 'task-2', worktree: { path: 'C:\\site.worktrees\\b', branch: 'agent/b' } },
      { id: 'task-3', mergedAt: 5, worktree: { path: 'C:\\x', branch: 'agent/c' } },
      { id: 'task-4', worktree: { path: 'C:\\x', branch: '-bad' } },
      { id: 'task-5' }
    ])
    expect([...copies]).toEqual([
      ['task-1', { path: 'C:\\site.worktrees\\a', branch: 'agent/a', target: 'dev' }],
      ['task-2', { path: 'C:\\site.worktrees\\b', branch: 'agent/b', target: 'main' }]
    ])
    expect(checkUsage({ providers: [{ id: 'claude', plan: 'Max', windows: [{ label: '5-hour', usedPct: 142, resetsAt: 5, accountId: 'a' }], status: 'ok', updatedAt: 9, email: 'ada@example.com', accountId: 'acct-1' }] })).toEqual({
      providers: [{ id: 'claude', plan: 'Max', windows: [{ label: '5-hour', usedPct: 100, resetsAt: 5 }], status: 'ok', updatedAt: 9 }]
    })
    expect(checkUsage({ providers: [{ id: 'x y', windows: [] }] })).toEqual({ providers: [] })
    expect(checkUsage(null)).toBe(null)
  })

  it('declares its topics and ops for the channel', () => {
    expect(TOPICS.agents).toMatchObject({ feature: 'panes2', project: true, keep: true, right: null })
    expect(TOPICS.usage).toMatchObject({ feature: 'usage', project: false, keep: true, right: 'usage', max: 1 })
    expect(OP_AREAS).toMatchObject({ agents: 'panes2', history: 'history', review: 'history' })
  })
})

// --- The channel: a host-wide topic, an answer that shows what a right lets see -------
describe('the channel’s usage topic and the rights an answer shows (shareHost.js)', () => {
  let host
  afterEach(() => host?.stop())
  const pane = (id) => ({ id, title: id, kind: 'shell', cols: 80, rows: 24 })
  function tessel() {
    const t = {
      calls: [],
      watches: [],
      answer: async () => ({ ok: true, data: {} }),
      callbacks: {
        projects: () => [{ id: 'ws-a', layout: { project: 'a', tree: { type: 'leaf', id: 'a1', view: 'terminal', title: 'a1', kind: 'shell' }, activeId: 'a1' }, panes: [pane('a1')] }],
        snapshot: async (id) => ({ data: `screen of ${id}`, cols: 80, rows: 24 }),
        write: () => {},
        openPane: () => {},
        closePane: () => {},
        askApproval: async () => true,
        opInfo: (op) => (op === 'history.list' ? { right: 'view', kind: 'heavy', bulk: false } : null),
        request: (req, ctx) => {
          t.calls.push({ req, ctx })
          // The history's dollars: shown only with the usage right.
          if (ctx.rights.usage) ctx.uses('usage')
          return t.answer(req, ctx)
        },
        watch: (topic, project, key, on) => t.watches.push([topic, project, key, on]),
        offers: () => true
      }
    }
    return t
  }
  async function share(t) {
    const secret = newSecret()
    host = createShareHost({ secret, hostName: 'Ada', callbacks: t.callbacks })
    return { secret, port: await host.start() }
  }
  async function join(conn, name) {
    const r = { states: [], projects: null, pushes: [], rights: [] }
    r.client = createShareGuest({
      url: `ws://127.0.0.1:${conn.port}/`,
      secret: conn.secret,
      name,
      signingKey: newSigningKey(),
      callbacks: {
        onState: (s) => r.states.push(s),
        onProjects: (p) => (r.projects = p),
        onRights: (x) => r.rights.push(x),
        onPush: (topic, project, key, data) => r.pushes.push({ topic, project, key, data })
      }
    })
    r.client.connect()
    await until(() => r.states.includes('joined') && r.projects)
    return r
  }
  const idOf = (name) => host.guests().find((g) => g.name === name && g.state === 'joined').id
  const give = async (r, name, rights) => {
    host.setGrant(idOf(name), { rights })
    await until(() => r.rights.length && !!r.rights.at(-1).usage === !!rights.usage)
  }

  it('the usage topic: refused without the right, ended when it goes, never pushed to a guest without it', async () => {
    const t = tessel()
    const conn = await share(t)
    const alex = await join(conn, 'Alex')
    const ben = await join(conn, 'Ben')
    expect(alex.client.speaks('usage')).toBe(true)
    expect(alex.client.subscribe('usage')).toBe(true)
    await wait(100)
    expect(t.watches).toEqual([])
    await give(alex, 'Alex', { usage: true })
    alex.client.subscribe('usage')
    await until(() => t.watches.length === 1)
    expect(t.watches).toEqual([['usage', null, null, true]])
    host.push('usage', null, null, { providers: [{ id: 'claude' }] })
    await until(() => alex.pushes.length === 1)
    expect(alex.pushes[0]).toEqual({ topic: 'usage', project: null, key: null, data: { providers: [{ id: 'claude' }] } })
    // Ben has no right: its subscription is refused, it gets nothing.
    ben.client.subscribe('usage')
    await wait(100)
    host.push('usage', null, null, { providers: [] })
    await until(() => alex.pushes.length === 2)
    expect(ben.pushes).toEqual([])
    // Alex loses it: its subscription ends (the host's watch stops), nothing more comes.
    await give(alex, 'Alex', {})
    await until(() => t.watches.length === 2)
    expect(t.watches[1]).toEqual(['usage', null, null, false])
    host.push('usage', null, null, { providers: [{ id: 'codex' }] })
    await wait(100)
    expect(alex.pushes).toHaveLength(2)
  })

  it('a heavy answer two guests share leaves for each only while each still has the right it shows', async () => {
    const t = tessel()
    let release = null
    t.answer = () => new Promise((r) => (release = () => r({ ok: true, data: { usd: true } })))
    const conn = await share(t)
    const alex = await join(conn, 'Alex')
    const ben = await join(conn, 'Ben')
    await give(alex, 'Alex', { usage: true })
    await give(ben, 'Ben', { usage: true })
    const a = alex.client.request('history.list', 'ws-a', {})
    const b = ben.client.request('history.list', 'ws-a', {})
    await until(() => release)
    await wait(50)
    // One run for both.
    expect(t.calls).toHaveLength(1)
    await give(ben, 'Ben', {})
    release()
    expect(await a).toEqual({ ok: true, data: { usd: true } })
    expect(await b).toEqual({ ok: false, code: 'revoked' })
  })
})

// --- A real project: Local History and a task branch ---------------------------------
let tmp
let repo
let wt
beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(join(os.tmpdir(), 'tessel-lspanels-')))
  repo = join(tmp, 'site')
  fs.mkdirSync(repo, { recursive: true })
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'host-secret@example.com')
  git(repo, 'config', 'user.name', 'Host Person')
  git(repo, 'config', 'core.autocrlf', 'false')
  put(repo, 'src/app.js', 'one\n')
  put(repo, 'apps/web/index.js', 'web\n')
  put(repo, '.gitignore', 'dist/\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'first')
  // A task's own copy, on its branch, with the agent's work committed.
  wt = join(tmp, 'site.worktrees', 'fix')
  git(repo, 'worktree', 'add', '-q', '-b', 'agent/fix', wt)
  put(wt, 'src/app.js', 'one\ntwo\n')
  put(wt, 'src/new.js', 'new\n')
  put(wt, '.env', 'API_KEY=hunter2\n')
  put(wt, 'config/.env', 'NESTED_SECRET=abc123\n')
  put(wt, 'config/server.pem', '-----BEGIN PRIVATE KEY-----\nnot a real key\n')
  put(wt, 'config/app.json', '{}\n')
  put(wt, 'apps/web/index.js', 'web\nmore\n')
  put(wt, 'big.txt', `${'x'.repeat(99)}\n`.repeat(7000))
  git(wt, 'add', '-A')
  git(wt, '-c', 'user.name=Host Person', '-c', 'user.email=host-secret@example.com', 'commit', '-q', '-m', 'agent work', '-m', 'Reported by ada@example.com')
  put(wt, 'src/unsaved.js', 'later\n')
})
afterEach(() => {
  try {
    git(repo, 'worktree', 'remove', '--force', wt)
  } catch {
    /* gone */
  }
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('a file\u2019s Local History and a task branch\u2019s review (shareRequests.js)', () => {
  const ask = (requests, op, args, extra = {}, project = 'ws-1') =>
    requests.handle({ op, project, args }, { roots: { 'ws-1': repo, 'ws-2': join(repo, 'apps', 'web') }, rights: {}, settings: { hideIgnored: true }, ...extra })

  it('reads the host\u2019s saved versions of a project\u2019s file, never a hidden one', async () => {
    const lh = createLocalHistory({ dir: join(tmp, 'History') })
    lh.add({ path: join(repo, 'src', 'app.js'), text: 'first save\n' })
    lh.add({ path: join(repo, 'src', 'app.js'), text: 'second save\n' })
    lh.add({ path: join(repo, '.env'), text: 'API_KEY=hunter2\n' })
    const requests = createShareRequests({ scope: createShareScope() })
    const list = await ask(requests, 'history.local', { path: 'src/app.js' }, { localHistory: lh })
    expect(list.ok).toBe(true)
    expect(list.data.rel).toBe('src/app.js')
    expect(list.data.entries).toHaveLength(2)
    expect(list.data.entries[0]).toEqual({ id: expect.stringMatching(/^[a-z0-9]{6,32}$/), source: 'save', timestamp: expect.any(Number) })
    const read = await ask(requests, 'history.localRead', { path: 'src/app.js', id: list.data.entries[0].id }, { localHistory: lh })
    expect(read).toEqual({ ok: true, data: { text: 'second save\n' } })
    expect(await ask(requests, 'history.local', { path: '.env' }, { localHistory: lh })).toEqual({ ok: false, code: 'not-found' })
    expect(await ask(requests, 'history.localRead', { path: '.env', id: list.data.entries[0].id }, { localHistory: lh })).toEqual({ ok: false, code: 'not-found' })
    expect(await ask(requests, 'history.localRead', { path: 'src/app.js', id: '../x' }, { localHistory: lh })).toEqual({ ok: false, code: 'bad-args' })
    expect(await ask(requests, 'history.local', { path: 'C:\\Windows\\win.ini' }, { localHistory: lh })).toEqual({ ok: false, code: 'bad-args' })
    expect(await ask(requests, 'history.local', { path: 'src/app.js' })).toEqual({ ok: false, code: 'unavailable' })
    expect(JSON.stringify(list)).not.toContain(tmp)
  })

  it('a task branch: its files relative to the project, the hidden ones counted, no author email, each diff capped', async () => {
    const requests = createShareRequests({ scope: createShareScope() })
    const taskCopy = (project, id) => (id === 'task-1' ? { path: wt, branch: 'agent/fix', target: 'main' } : null)
    const info = await ask(requests, 'review.info', { task: 'task-1' }, { taskCopy })
    expect(info.ok).toBe(true)
    expect(info.data.files.map((f) => f.path).sort()).toEqual(['apps/web/index.js', 'big.txt', 'config/app.json', 'src/app.js', 'src/new.js'])
    expect(info.data.hidden).toBe(3) // .env, config/.env, config/server.pem
    expect(info.data.files.find((f) => f.path === 'src/app.js')).toMatchObject({ status: 'M', added: 1, removed: 0, binary: false })
    // No email, not even in a commit's message.
    expect(info.data.commits).toEqual([{ sha: expect.stringMatching(/^[0-9a-f]{40}$/), author: 'Host Person', time: expect.any(Number), subject: 'agent work', body: 'Reported by …' }])
    expect(info.data).toMatchObject({ branch: 'agent/fix', target: 'main', uncommitted: ['src/unsaved.js'], conflicts: [], mergeCheck: 'done', behind: 0, copyExists: true })
    const said = JSON.stringify(info)
    expect(said).not.toContain('host-secret@example.com')
    expect(said).not.toContain('ada@example.com')
    expect(said).not.toContain(tmp)
    expect(said).not.toContain(tmp.replace(/\\/g, '\\\\'))
    // The guest takes it as it is (and drops what it does not know).
    expect(checkReviewInfo(info.data)).toEqual(info.data)
    expect(checkReviewInfo({ ...info.data, files: [{ path: 'C:\\x' }, { path: '../y' }] }).files).toEqual([])

    const diff = await ask(requests, 'review.diff', { task: 'task-1', file: 'src/app.js' }, { taskCopy })
    expect(diff.ok).toBe(true)
    expect(diff.data.text.startsWith('@@ ')).toBe(true)
    expect(diff.data.text).toContain('+two')
    expect(diff.data).toMatchObject({ truncated: false, rel: 'src/app.js' })
    expect(checkReviewDiff(diff.data)).toEqual({ text: diff.data.text, truncated: false })
    // A long diff is cut (review.js: 600 KB), never over the 2 MB a guest takes.
    const big = await ask(requests, 'review.diff', { task: 'task-1', file: 'big.txt' }, { taskCopy })
    expect(big.ok).toBe(true)
    expect(big.data.truncated).toBe(true)
    expect(big.data.text.length).toBeLessThanOrEqual(600 * 1024)
    // Hidden files, folders, git's patterns, files the branch did not
    // change, other tasks, other shapes: refused, git never asked.
    for (const file of ['.env', '[.]env', 'config', 'config/server.pe[m]', 'src', 'src/unchanged.js', 'config/.env'])
      expect(await ask(requests, 'review.diff', { task: 'task-1', file }, { taskCopy })).toEqual({ ok: false, code: 'not-found' })
    expect(await ask(requests, 'review.diff', { task: 'task-1', file: 'config/*.pem' }, { taskCopy })).toEqual({ ok: false, code: 'bad-args' })
    const ok = await ask(requests, 'review.diff', { task: 'task-1', file: 'config/app.json' }, { taskCopy })
    expect(ok.data.text).toContain('+{}')
    expect(ok.data.text).not.toMatch(/SECRET|PRIVATE KEY/)
    expect(await ask(requests, 'review.info', { task: 'task-9' }, { taskCopy })).toEqual({ ok: false, code: 'not-found' })
    expect(await ask(requests, 'review.info', { task: 'task-1' })).toEqual({ ok: false, code: 'not-found' })
    expect(await ask(requests, 'review.diff', { task: 'task-1', file: '../site/src/app.js' }, { taskCopy })).toEqual({ ok: false, code: 'bad-args' })
    expect(checkReviewDiff({ text: 'x'.repeat(3 * 1024 * 1024) })).toBe(null)
  })

  it('every git command is a guest\u2019s: literal paths, its settings, counted in its budget, kept a while; one file per diff', async () => {
    const calls = []
    const outputs = []
    const fakeGit = vi.fn(async (file, args) => {
      calls.push(args)
      const out = outputs.find((o) => o.when(args)) || { ok: true, code: 0, stdout: '' }
      return { ok: out.ok !== false, code: out.code || 0, stdout: out.stdout || '', stderr: '' }
    })
    outputs.push(
      { when: (a) => a.includes('--show-toplevel'), stdout: `${repo}\n` },
      { when: (a) => a.includes('worktree'), stdout: '' },
      { when: (a) => a.includes('rev-parse'), stdout: `${'a'.repeat(40)}\n${'b'.repeat(40)}\n` },
      { when: (a) => a.includes('merge-base'), stdout: `${'c'.repeat(40)}\n` },
      { when: (a) => a.includes('--raw'), stdout: `:100644 100644 ${'1'.repeat(40)} ${'2'.repeat(40)} M\tsrc/app.js\n1\t0\tsrc/app.js\n` },
      { when: (a) => a.includes('-U3'), stdout: 'diff --git a/src/app.js b/src/app.js\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/src/x b/src/x\n@@ -1 +1 @@\n-c\n+d\n' }
    )
    let budget = 100
    const charge = vi.fn(() => budget-- > 0)
    const review = createGuestReview({ git: fakeGit, gitArgs: async () => ['-c', 'core.hooksPath=/empty'] })
    const copy = { root: repo, path: null, branch: 'agent/fix', target: 'main' }
    const info = await review.info(copy, charge)
    expect(info).toMatchObject({ ok: true, repo, head: 'a'.repeat(40), base: 'c'.repeat(40), files: [expect.objectContaining({ path: 'src/app.js', status: 'M', added: 1 })] })
    // Each git process: literal paths, the guest's settings, one charge.
    for (const args of calls) {
      expect(args[0]).toBe('--literal-pathspecs')
      expect(args).toContain('core.hooksPath=/empty')
    }
    expect(charge).toHaveBeenCalledTimes(calls.length)
    expect(calls.find((a) => a.includes('--raw'))).toEqual(expect.arrayContaining(['--no-ext-diff', '--no-textconv']))
    // Asked again soon: kept, no git.
    const n = calls.length
    expect(await review.info(copy, charge)).toBe(info)
    expect(calls).toHaveLength(n)
    // A diff naming two files (a folder, a file become a folder): refused.
    expect(await review.diff(info, 'src', charge)).toEqual({ ok: false, code: 'not-found' })
    outputs.splice(outputs.length - 1, 1, { when: (a) => a.includes('-U3'), stdout: 'diff --git a/src/app.js b/src/app.js\n@@ -1 +1 @@\n-a\n+b\n' })
    const one = await review.diff(info, 'src/app.js', charge)
    expect(one).toEqual({ ok: true, text: expect.stringContaining('+b'), truncated: false })
    expect(calls.at(-1)).toEqual(expect.arrayContaining(['--', 'src/app.js', '--no-ext-diff', '--no-textconv']))
    // The same file of the same branch again: kept.
    const m = calls.length
    expect(await review.diff(info, 'src/app.js', charge)).toBe(one)
    expect(calls).toHaveLength(m)
    // Over the guest's budget: refused as busy, git not run.
    budget = 0
    await expect(review.diff(info, 'src/other.js', charge)).rejects.toMatchObject({ code: 'busy' })
    expect(calls).toHaveLength(m)
    expect(splitRawNumstat(':100644 100644 aa bb A\tnew.txt\n3\t0\tnew.txt\n')).toEqual({ ns: 'A\tnew.txt', numstat: '3\t0\tnew.txt', raw: ':100644 100644 aa bb A\tnew.txt' })
  })

  it('over the guest\u2019s git budget, a review answers busy', async () => {
    const requests = createShareRequests({ scope: createShareScope() })
    const taskCopy = () => ({ path: wt, branch: 'agent/fix', target: 'main' })
    expect(await ask(requests, 'review.info', { task: 'task-1' }, { taskCopy, spend: () => false })).toEqual({ ok: false, code: 'busy' })
  })

  it('a project below its repository\u2019s top sees only its own files, relative to it', async () => {
    const requests = createShareRequests({ scope: createShareScope() })
    const taskCopy = () => ({ path: wt, branch: 'agent/fix', target: 'main' })
    const info = await ask(requests, 'review.info', { task: 'task-1' }, { taskCopy }, 'ws-2')
    expect(info.ok).toBe(true)
    expect(info.data.files.map((f) => f.path)).toEqual(['index.js'])
    expect(info.data.hidden).toBe(0)
    expect(info.data.uncommitted).toEqual([])
    const diff = await ask(requests, 'review.diff', { task: 'task-1', file: 'index.js' }, { taskCopy }, 'ws-2')
    expect(diff.data.text).toContain('+more')
    expect(JSON.stringify(diff)).not.toContain('apps/web')
  })
})

// --- End to end ------------------------------------------------------------------------------
const dataDirs = []
const newDataDir = () => {
  const d = fs.mkdtempSync(join(os.tmpdir(), 'tessel-lspanels-data-'))
  dataDirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dataDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function fakeMain(extra = {}) {
  const m = {
    handle: {},
    on: {},
    sent: [],
    ipcMain: { handle: (name, fn) => (m.handle[name] = fn), on: (name, fn) => (m.on[name] = fn) },
    send: (channel, payload) => m.sent.push([channel, payload]),
    host: { request: vi.fn(async (op, body, _t, onReply) => (onReply?.({ ok: true, buffer: '' }), { ok: true, buffer: '' })), send: vi.fn() },
    events: (channel) => m.sent.filter(([c]) => c === channel).map(([, p]) => p),
    last: (channel) => m.events(channel).at(-1)
  }
  m.api = registerLiveShare({
    ipcMain: m.ipcMain,
    send: m.send,
    host: m.host,
    dataDir: newDataDir(),
    queueData: () => {},
    sendExit: () => {},
    log: { info: () => {}, warn: () => {} },
    kill: vi.fn(),
    pidRunning: () => tunnel.alive,
    resume: false,
    trashItem: async () => {},
    watchProject: () => () => {},
    makeFileWatcher: () => ({ set: (paths) => paths.length, close: () => {} }),
    ...extra
  })
  return m
}
const leaf = (id, extra = {}) => ({ type: 'leaf', id, view: 'terminal', title: id, kind: 'shell', ...extra })
const LAYOUT = { project: 'site', tree: { type: 'split', id: 'split-1', dir: 'row', sizes: [50, 50], children: [leaf('pane-1-ps', { kind: 'agent', agentId: 'claude' }), leaf('pane-2-ps')] }, activeId: 'pane-1-ps' }

// The host's usage service as index.js registers it (the provider reads are
// counted), with Live Share's copy fed by its hooks.
function hostUsage() {
  const service = {
    read: vi.fn(async ({ provider, accountId }) => ({ ok: true, provider, accountId, source: 'live', observedAt: Date.now(), plan: 'Max 20x', email: 'ada@example.com', windows: [{ label: '5-hour', usedPct: 42, resetsAt: Date.now() + 3_600_000, lockedReason: 'Sign in again as ada@example.com' }] })),
    invalidate: vi.fn()
  }
  const accounts = {
    list: vi.fn(async () => ({ ok: true, providers: ['claude', 'codex'].map((provider) => ({ provider, selectedId: null, system: { status: 'ready', label: 'Work laptop account', email: 'ada@example.com' }, accounts: [] })) })),
    usageScope: vi.fn(async (_provider, accountId) => ({ ok: true, accountId, env: {} })),
    select: vi.fn(async () => ({ ok: true }))
  }
  const handlers = new Map()
  const localUsage = vi.fn(async () => ({ agents: [] }))
  const usage = createShareUsage({ localUsage })
  registerProviderUsage({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    accounts,
    service,
    send: () => {},
    onResult: (r) => usage.onResult(r),
    onCache: (fn) => usage.setCache(fn)
  })
  return { service, handlers, usage, localUsage }
}

describe('Live Share phase 2b end to end', () => {
  const mains = []
  afterEach(() => {
    for (const m of mains.splice(0)) m.api.stopAll()
  })

  async function session(hostExtra = {}) {
    const host = fakeMain(hostExtra)
    const guest = fakeMain()
    mains.push(host, guest)
    const started = await host.handle['liveShare:start'](null, { name: 'Cedric', projects: ['ws-1'] })
    host.on['liveShare:layouts'](null, [{ id: 'ws-1', layout: LAYOUT, chats: [], root: repo }])
    await guest.handle['liveShare:join'](null, { invite: started.invites[0].code, name: 'Alex' })
    const ask = await until(() => host.last('liveShare:ask'))
    await host.handle['liveShare:approve'](null, { guestId: ask.guestId, yes: true, projects: ['ws-1'] })
    await until(() => guest.events('liveShare:guest').find((s) => s.state === 'joined' && s.projects.length && s.panes.length === 2))
    const give = async (right, on = true) => {
      expect(await host.handle['liveShare:access'](null, { subject: ask.guestId, right, on })).toEqual({ ok: true })
      await until(() => guest.last('liveShare:guest').rights?.[right] === on)
    }
    const localId = (remote) => guest.last('liveShare:guest').panes.find((p) => p.id.endsWith(`-${remote.replace(/^pane-/, '')}`)).id
    const request = (op, args) => guest.handle['liveShare:request'](null, { op, project: 'ws-1', args })
    return { host, guest, give, guestId: ask.guestId, localId, request, invite: started.invites[0].code }
  }
  const agentPushes = (guest) => guest.events('liveShare:push').filter((p) => p.topic === 'agents')
  const PANE_1 = { id: 'pane-1-ps', kind: 'agent', agentId: 'claude', model: 'Opus 4.7 \u00b7 high', state: 'working', task: 'Fix the login', children: { agent: 'claude', sessionId: 'sess-secret-1', accountId: null } }

  it('each pane\u2019s model, effort and state go to the guest with its own pane ids, at most once a second, nothing host-only', async () => {
    const { host, guest, localId } = await session()
    expect(guest.last('liveShare:guest').features).toEqual(expect.arrayContaining(['panes2', 'history']))
    host.on['liveShare:paneAgents'](null, [
      { project: 'ws-1', panes: [PANE_1, { id: 'pane-2-ps', kind: 'shell' }, { id: 'pane-elsewhere', kind: 'agent', model: 'not in this project' }] },
      { project: 'ws-9', panes: [{ id: 'pane-9', kind: 'agent', model: 'not shared' }] }
    ])
    const first = await until(() => agentPushes(guest)[0])
    expect(first.project).toBe('ws-1')
    expect(first.data.panes.map((p) => p.id)).toEqual([localId('pane-1-ps'), localId('pane-2-ps')])
    expect(first.data.panes[0]).toMatchObject({ kind: 'agent', agentId: 'claude', model: 'Opus 4.7 \u00b7 high', state: 'working', task: 'Fix the login', children: true })
    const said = JSON.stringify(guest.sent)
    for (const s of ['sess-secret-1', 'not in this project', 'not shared', repo]) expect(said).not.toContain(s)
    // What came last is the window's at once (a reload).
    expect(await guest.handle['liveShare:subscribe'](null, { topic: 'agents', project: 'ws-1', on: true })).toMatchObject({ ok: true, outdated: false, data: { panes: first.data.panes } })
    // Several changes within a second: the latest goes once.
    for (const state of ['waiting', 'approval', 'working', 'monitoring']) host.on['liveShare:paneAgents'](null, [{ project: 'ws-1', panes: [{ ...PANE_1, state }, { id: 'pane-2-ps', kind: 'shell' }] }])
    await wait(400)
    expect(agentPushes(guest)).toHaveLength(1)
    const second = await until(() => agentPushes(guest)[1], 3000)
    expect(second.data.panes[0].state).toBe('monitoring')
    await wait(1300)
    expect(agentPushes(guest)).toHaveLength(2)
    // A layout change (a pane taken out of the project): made again.
    host.on['liveShare:layouts'](null, [{ id: 'ws-1', layout: { project: 'site', tree: leaf('pane-2-ps'), activeId: 'pane-2-ps' }, chats: [], root: repo }])
    const third = await until(() => agentPushes(guest)[2], 3000)
    expect(third.data.panes.map((p) => p.id)).toEqual([localId('pane-2-ps')])
  })

  // Guests' agents rules (liveShareAgents.js), with what really runs in a
  // pane looked at on the host (agentDetect.js agentsInTrees).
  const NO_CODEX = { deny: ['codex'], later: true, known: ['claude', 'codex'], models: {} }
  const hostWrites = (host, id) => host.host.send.mock.calls.filter(([op, b]) => op === 'write' && b.id === id).map(([, b]) => b.data)
  it('a guest whose rule leaves an agent out types in a launched agent pane only while what runs there is allowed, looked at again after each Enter', async () => {
    let procs = [{ pid: 200, ppid: 100, name: 'claude.exe', cmd: 'claude' }]
    const listProcs = vi.fn(async () => procs)
    const { host, guest, give, guestId, localId } = await session({ listProcs })
    await give('type')
    expect(await host.handle['liveShare:access'](null, { subject: guestId, agents: NO_CODEX })).toEqual({ ok: true })
    await until(() => guest.last('liveShare:guest').rights?.agents)
    host.on['liveShare:paneAgents'](null, [{ project: 'ws-1', panes: [{ ...PANE_1, pid: 100, local: true, modelIds: ['opus'] }, { id: 'pane-2-ps', kind: 'shell' }] }])
    await wait(50)
    const one = localId('pane-1-ps')
    // Looked at as soon as the window said what runs there: Claude, allowed.
    await until(() => listProcs.mock.calls.length >= 1)
    await wait(50)
    guest.api.guestWrite(one, 'hi\r')
    await until(() => hostWrites(host, 'pane-1-ps').length === 1)
    // After that Enter, until looked at again: refused ("checking").
    procs = [...procs, { pid: 300, ppid: 200, name: 'codex.exe', cmd: 'codex' }]
    guest.api.guestWrite(one, 'b')
    await until(() => guest.events('liveShare:notice').some((n) => n.code === 'checking'))
    // Looked at again: Codex runs under Claude (its ! mode, say): refused.
    await until(() => listProcs.mock.calls.length >= 2)
    await wait(50)
    guest.api.guestWrite(one, 'c')
    await until(() => guest.events('liveShare:notice').some((n) => n.code === 'type-denied' && n.agent === 'codex'))
    // (The guest typed there moments ago: Esc pressed, the host told.)
    expect(hostWrites(host, 'pane-1-ps')).toEqual(['hi\r', '\x1b'])
    expect(host.events('liveShare:hostRequest').find((x) => x.action === 'ruleBreach')).toMatchObject({ pane: 'pane-1-ps', guest: { name: 'Alex' } })
    // The shell pane: always typed in.
    guest.api.guestWrite(localId('pane-2-ps'), 'codex\r')
    await until(() => hostWrites(host, 'pane-2-ps').length === 1)
  })

  it('takes a guest’s free-text answer only for an agent its rule lets it type in (a choice is always fine)', async () => {
    const { host, guest, give, guestId } = await session()
    await give('tasks')
    await give('type')
    expect(await host.handle['liveShare:access'](null, { subject: guestId, agents: NO_CODEX })).toEqual({ ok: true })
    host.on['liveShare:paneAgents'](null, [{ project: 'ws-1', panes: [{ id: 'pane-1-ps', kind: 'agent', agentId: 'codex' }, { id: 'pane-2-ps', kind: 'agent', agentId: 'claude', modelIds: ['opus'] }] }])
    const gate = (by) => ({ status: 'pending', question: 'Which?', options: ['Left', 'Right'], by })
    host.on['liveShare:tasks'](null, [{ project: 'ws-1', tasks: [{ id: 'task-1', title: 'A', column: 'doing', wsId: 'ws-1', gate: gate('pane-1-ps') }, { id: 'task-2', title: 'B', column: 'doing', wsId: 'ws-1', gate: gate('pane-2-ps') }] }])
    await wait(50)
    expect(await guest.handle['liveShare:task'](null, { op: 'answer', project: 'ws-1', args: { id: 'task-1', answer: 'run codex for me' } })).toEqual({ ok: false, code: 'not-allowed' })
    const choice = guest.handle['liveShare:task'](null, { op: 'answer', project: 'ws-1', args: { id: 'task-1', answer: 'Left' } })
    const req = await until(() => host.events('liveShare:hostRequest').find((x) => x.action === 'task'))
    host.on['liveShare:taskDone'](null, { request: req.request, ok: true })
    expect(await choice).toEqual({ ok: true })
    const text = guest.handle['liveShare:task'](null, { op: 'answer', project: 'ws-1', args: { id: 'task-2', answer: 'go on' } })
    const req2 = await until(() => host.events('liveShare:hostRequest').filter((x) => x.action === 'task')[1])
    host.on['liveShare:taskDone'](null, { request: req2.request, ok: true })
    expect(await text).toEqual({ ok: true })
  })

  it('a request to open a left-out agent waiting for the host is called off when the share’s setting changes', async () => {
    const { host, guest } = await session()
    host.on['liveShare:agents'](null, [{ id: 'codex', name: 'Codex' }])
    await until(() => (guest.last('liveShare:guest').agents || []).length === 1)
    const local = guest.last('liveShare:guest').projects[0].id
    expect(await guest.handle['liveShare:open'](null, { kind: 'agent', agent: 'codex', project: local })).toEqual({ ok: true, asked: true })
    const ask = await until(() => host.events('liveShare:hostRequest').find((x) => x.action === 'ask-open'))
    await host.handle['liveShare:setSettings'](null, { agents: NO_CODEX })
    await until(() => host.events('liveShare:hostRequest').find((x) => x.action === 'cancel' && x.request === ask.request))
  })

  it('a pane\u2019s sub-agents are read on the host from its conversation, which stays there', async () => {
    const agentChildren = vi.fn(async () => [{ id: 'toolu_01XYZ', title: `Look at ${repo}\\src\\app.js`, state: 'running', startedAt: 5, tokens: 10 }])
    const { host, request, localId } = await session({ agentChildren })
    host.on['liveShare:paneAgents'](null, [{ project: 'ws-1', panes: [PANE_1, { id: 'pane-2-ps', kind: 'agent', agentId: 'codex' }] }])
    await wait(100)
    const res = await request('agents.children', { pane: localId('pane-1-ps') })
    expect(agentChildren).toHaveBeenCalledWith({ agent: 'claude', sessionId: 'sess-secret-1', accountId: null })
    expect(res).toEqual({ ok: true, data: { items: [expect.objectContaining({ id: expect.stringMatching(/^[0-9a-f]{16}$/), title: 'Look at src/app.js', state: 'running', tokens: 10 })] } })
    // A pane whose conversation the host did not give, one this window does
    // not show: nothing read.
    expect(await request('agents.children', { pane: localId('pane-2-ps') })).toEqual({ ok: false, code: 'not-found' })
    expect(await request('agents.children', { pane: 'pane-1-ps' })).toEqual({ ok: false, code: 'bad-args' })
    // Asked again (or by another guest) within a few seconds: read once on
    // the host, whatever the guests' own pace.
    const again = await Promise.all([request('agents.children', { pane: localId('pane-1-ps') }), request('agents.children', { pane: localId('pane-1-ps') })])
    expect(again.map((r) => r.ok)).toEqual([true, true])
    expect(agentChildren).toHaveBeenCalledTimes(1)
  })

  it('the host\u2019s usage only with the usage right: its own readings, never a provider read for it; gone with the right', async () => {
    const u = hostUsage()
    // The host's own refresh read once (the window's).
    await u.handlers.get('providerUsage:read')(null, { provider: 'claude', accountId: null })
    expect(u.service.read).toHaveBeenCalledTimes(1)
    const { guest, give } = await session({ usage: u.usage })
    expect(guest.last('liveShare:guest').features).toContain('usage')
    await wait(300)
    expect(guest.events('liveShare:push').filter((p) => p.topic === 'usage')).toEqual([])
    expect(await guest.handle['liveShare:subscribe'](null, { topic: 'usage', on: true })).toEqual({ ok: true, outdated: false })
    await give('usage')
    const pushed = await until(() => guest.events('liveShare:push').find((p) => p.topic === 'usage' && p.data))
    expect(pushed.data.providers).toEqual([{ id: 'claude', plan: 'Max 20x', windows: [{ label: '5-hour', usedPct: 42, resetsAt: expect.any(Number) }], status: 'ok', updatedAt: expect.any(Number) }])
    expect(JSON.stringify(guest.sent)).not.toMatch(/ada@example\.com|Work laptop|accountId|Sign in again/)
    expect((await guest.handle['liveShare:subscribe'](null, { topic: 'usage', on: true })).data).toEqual(pushed.data)
    // Following it never read a provider; the local readings at most once.
    expect(u.service.read).toHaveBeenCalledTimes(1)
    expect(u.localUsage.mock.calls.length).toBeLessThanOrEqual(1)
    // The right taken away: the readings go, nothing more comes.
    await give('usage', false)
    await until(() => guest.events('liveShare:push').some((p) => p.topic === 'usage' && p.data === null))
    expect(await guest.handle['liveShare:subscribe'](null, { topic: 'usage', on: true })).toEqual({ ok: true, outdated: false })
    const count = guest.events('liveShare:push').filter((p) => p.topic === 'usage').length
    await u.handlers.get('providerUsage:read')(null, { provider: 'codex', accountId: null })
    u.usage.onResult({ ok: true, provider: 'claude', accountId: null, observedAt: Date.now(), windows: [{ label: '5-hour', usedPct: 90 }] })
    await wait(300)
    expect(guest.events('liveShare:push').filter((p) => p.topic === 'usage')).toHaveLength(count)
    // Given again: it comes again.
    await give('usage')
    await until(() => guest.events('liveShare:push').filter((p) => p.topic === 'usage' && p.data).length >= 2)
  })

  it('a host without usage readings does not offer it', async () => {
    const { guest } = await session()
    expect(guest.last('liveShare:guest').features).not.toContain('usage')
    expect(await guest.handle['liveShare:subscribe'](null, { topic: 'usage', on: true })).toEqual({ ok: true, outdated: true })
  })

  it('the task history: times and tokens with the project, dollars only with the usage right', async () => {
    const cardCosts = vi.fn(async (ids) => Object.fromEntries(ids.map((id) => [id, { status: 'ok', inputTokens: 7, outputTokens: 3, usd: 0.5, known: true, models: [] }])))
    const { host, guest, give, request, localId, invite } = await session({ cardCosts })
    host.on['liveShare:history'](null, [
      { project: 'ws-1', records: [{ id: 'task-1', title: `Done in ${repo}\\src`, wsId: 'ws-1', paneId: 'pane-1-ps', doneAt: 20, durationMs: 60000, cost: { status: 'ok', inputTokens: 100, outputTokens: 50, usd: 1.25, known: true, models: [], final: true } }, { id: 'task-2', title: 'Second', wsId: 'ws-1', paneId: 'pane-gone', doneAt: 30, durationMs: 5 }] },
      { project: 'ws-9', records: [{ id: 'task-9', title: 'not shared', doneAt: 1 }] }
    ])
    const plain = await request('history.list', {})
    expect(plain.ok).toBe(true)
    expect(plain.data.usd).toBe(false)
    expect(plain.data.records.map((r) => r.id)).toEqual(['task-1', 'task-2'])
    expect(plain.data.records[0]).toMatchObject({ title: 'Done in src', paneId: localId('pane-1-ps'), durationMs: 60000, cost: { status: 'ok', inputTokens: 100, outputTokens: 50 } })
    // A pane this window does not show: none.
    expect(plain.data.records[1]).toMatchObject({ paneId: null, cost: { inputTokens: 7, outputTokens: 3 } })
    expect(JSON.stringify(plain)).not.toMatch(/"usd":[0-9]|known|not shared/)
    expect(cardCosts).toHaveBeenCalledWith(['task-2'])
    // Read again within 30 s: the figures read are kept.
    await request('history.list', {})
    expect(cardCosts).toHaveBeenCalledTimes(1)
    await give('usage')
    const rich = await request('history.list', {})
    expect(rich.data.usd).toBe(true)
    expect(rich.data.records[0].cost).toMatchObject({ usd: 1.25, known: true })
    expect(rich.data.records[1].cost).toMatchObject({ usd: 0.5 })
    expect(JSON.stringify(guest.sent)).not.toContain(repo)
    // The host itself never sends a pane its guests do not see (another
    // guest's Tessel could keep it): a guest's raw answer.
    const { url, secret } = decodeInvite(invite)
    const raw = { states: [], projects: null }
    const client = createShareGuest({ url, secret, name: 'Raw', signingKey: newSigningKey(), callbacks: { onState: (st) => raw.states.push(st), onProjects: (p) => (raw.projects = p) } })
    client.connect()
    const ask2 = await until(() => host.events('liveShare:ask').find((x) => x.name === 'Raw'))
    await host.handle['liveShare:approve'](null, { guestId: ask2.guestId, yes: true, projects: ['ws-1'] })
    await until(() => raw.states.includes('joined') && raw.projects)
    const answer = await client.request('history.list', 'ws-1', {})
    expect(answer.data.records.map((r) => r.paneId)).toEqual(['pane-1-ps', null])
    client.leave()
  })

  it('the right taken away while the history is on its way: its dollars never leave', async () => {
    // The first read waits until the test lets it go; any later one answers at once.
    let release = () => {}
    const figures = { 'task-2': { status: 'ok', inputTokens: 1, outputTokens: 1, usd: 9, known: true, models: [] } }
    const cardCosts = vi.fn(() => (cardCosts.mock.calls.length === 1 ? new Promise((r) => (release = () => r(figures))) : Promise.resolve(figures)))
    const { host, give, request } = await session({ cardCosts })
    host.on['liveShare:history'](null, [{ project: 'ws-1', records: [{ id: 'task-2', title: 'Second', doneAt: 30 }] }])
    await give('usage')
    const pending = request('history.list', {})
    await until(() => cardCosts.mock.calls.length === 1)
    await give('usage', false)
    release()
    expect(await pending).toEqual({ ok: false, code: 'revoked' })
    // Asked again: without them.
    const again = await request('history.list', {})
    expect(again.data.usd).toBe(false)
    expect(JSON.stringify(again)).not.toMatch(/"usd":[0-9]/)
  })

  it('the Timeline: the host\u2019s Local History of a project\u2019s file, through the guest\u2019s usual calls', async () => {
    const localHistory = createLocalHistory({ dir: join(tmp, 'History') })
    localHistory.add({ path: join(repo, 'src', 'app.js'), text: 'kept on the host\n' })
    localHistory.add({ path: join(repo, '.env'), text: 'API_KEY=hunter2\n' })
    const { guest } = await session({ localHistory })
    const list = await guest.api.guestFs.localHistoryList({ path: 'lshare://ws-1\\src\\app.js' })
    expect(list).toEqual({ ok: true, entries: [{ id: expect.any(String), source: 'save', timestamp: expect.any(Number) }] })
    expect(await guest.api.guestFs.localHistoryRead({ path: 'lshare://ws-1\\src\\app.js', id: list.entries[0].id })).toEqual({ ok: true, text: 'kept on the host\n' })
    expect(await guest.api.guestFs.localHistoryList({ path: 'lshare://ws-1\\.env' })).toMatchObject({ ok: false, code: 'not-found' })
    expect(await guest.api.guestFs.localHistoryList({ path: 'C:\\local\\file.txt' })).toMatchObject({ ok: false, code: 'outside' })
    expect(await guest.api.guestFs.localHistoryRead({ path: 'lshare://ws-1\\src\\app.js', id: 'BAD!' })).toMatchObject({ ok: false, code: 'not-found' })
  })

  it('the review of a card\u2019s branch, read only, from the host\u2019s board; never another project\u2019s card', async () => {
    const { host, request } = await session()
    host.on['liveShare:tasks'](null, [
      { project: 'ws-1', tasks: [{ id: 'task-1', title: 'Fix', column: 'review', wsId: 'ws-1', worktree: { root: repo, path: wt, branch: 'agent/fix', baseBranch: 'main' } }, { id: 'task-2', title: 'Merged', column: 'done', wsId: 'ws-1', mergedAt: 5, worktree: { root: repo, path: wt, branch: 'agent/fix' } }] },
      { project: 'ws-9', tasks: [{ id: 'task-9', title: 'x', column: 'review', worktree: { root: repo, path: wt, branch: 'agent/fix' } }] }
    ])
    const info = await request('review.info', { task: 'task-1' })
    expect(info.ok).toBe(true)
    expect(info.data.files.map((f) => f.path)).toContain('src/app.js')
    expect(info.data.files.map((f) => f.path)).not.toContain('.env')
    expect(info.data.hidden).toBe(3)
    const diff = await request('review.diff', { task: 'task-1', file: 'src/new.js' })
    expect(diff).toEqual({ ok: true, data: { text: expect.stringContaining('+new'), truncated: false } })
    expect(await request('review.info', { task: 'task-2' })).toEqual({ ok: false, code: 'not-found' })
    expect(await request('review.info', { task: 'task-9' })).toEqual({ ok: false, code: 'not-found' })
    expect(await request('review.diff', { task: 'task-1', file: '..\\x' })).toEqual({ ok: false, code: 'bad-args' })
    expect(JSON.stringify([info, diff])).not.toContain(tmp)
  })

  it('a card with its own copy: the host is asked to confirm a guest\u2019s delete, and the guest hears it', async () => {
    const { host, guest, give } = await session()
    host.on['liveShare:tasks'](null, [{ project: 'ws-1', tasks: [{ id: 'task-1', title: 'Fix', column: 'review', wsId: 'ws-1', worktree: { path: wt, branch: 'agent/fix' } }] }])
    await give('tasks')
    const removing = guest.handle['liveShare:task'](null, { op: 'remove', project: 'ws-1', args: { id: 'task-1' } })
    const req = await until(() => host.events('liveShare:hostRequest').find((x) => x.action === 'task'))
    host.on['liveShare:taskDone'](null, { request: req.request, ok: false, code: 'confirm' })
    expect(await removing).toEqual({ ok: false, code: 'confirm' })
    // Nothing happened yet: no audit entry.
    expect(host.events('liveShare:guestAction')).toEqual([])
  })

  it('an older host: the guest\u2019s panels fall back without asking', async () => {
    const secret = newSecret()
    const old = createShareHost({
      secret,
      hostName: 'Old',
      callbacks: {
        projects: () => [{ id: 'ws-1', layout: { project: 'site', tree: leaf('pane-1'), activeId: 'pane-1' }, panes: [{ id: 'pane-1', title: 'x', kind: 'agent', cols: 80, rows: 24 }] }],
        snapshot: async () => ({ data: '', cols: 80, rows: 24 }),
        write: () => {},
        openPane: () => {},
        closePane: () => {},
        askApproval: async () => true,
        // Phase 2a's channel, without phase 2b's features.
        opInfo: () => ({ right: 'view', kind: 'light', bulk: false }),
        request: async () => ({ ok: true, data: {} })
      }
    })
    const port = await old.start()
    const guest = fakeMain()
    mains.push(guest)
    try {
      await guest.handle['liveShare:join'](null, { invite: encodeInvite({ url: `ws://127.0.0.1:${port}/`, secret }), name: 'Alex' })
      await until(() => guest.events('liveShare:guest').find((s) => s.state === 'joined' && s.panes.length))
      const features = guest.last('liveShare:guest').features
      expect(features).toEqual(expect.arrayContaining(['files', 'scm', 'tasks']))
      for (const f of ['panes2', 'usage', 'history']) expect(features).not.toContain(f)
      const pane = guest.last('liveShare:guest').panes[0].id
      expect(await guest.handle['liveShare:request'](null, { op: 'history.list', project: 'ws-1', args: {} })).toEqual({ ok: false, code: 'bad-op' })
      expect(await guest.handle['liveShare:request'](null, { op: 'agents.children', project: 'ws-1', args: { pane } })).toEqual({ ok: false, code: 'bad-op' })
      expect(await guest.handle['liveShare:subscribe'](null, { topic: 'agents', project: 'ws-1', on: true })).toEqual({ ok: true, outdated: true })
      expect(await guest.api.guestFs.localHistoryList({ path: 'lshare://ws-1\\a.txt' })).toMatchObject({ ok: false, code: 'bad-op' })
      // Nothing of the new topics was asked of it.
      expect(old.watched()).toEqual([])
    } finally {
      old.stop()
    }
  })
})
