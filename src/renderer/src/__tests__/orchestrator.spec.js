// The renderer's coordinator/worker bookkeeping (orchestrator.js), with fake
// panes, cards and team tools: no terminal, no agent is ever started.
import { describe, it, expect, beforeEach } from 'vitest'
import { reactive } from 'vue'
import { createOrchestrator, TURN_END_GRACE_MS, CHAT_REMINDER, FAIL_NOTICES_MAX, FAIL_NOTICES_WINDOW_MS, failureKey } from '../orchestrator'
import { WORKER_START_PROMPT, STALE_MS } from '../../../shared/orchestration'

function world({ confirm = true, max = 2, depth = 1 } = {}) {
  const settings = reactive({ orchestrationConfirmWorkers: confirm, orchestrationMaxWorkers: max, orchestrationMaxDepth: depth })
  const ws = { id: 'ws1', cwd: 'C:\\repo', remote: null }
  const leaves = new Map()
  const addLeaf = (id, num, title, extra = {}) => {
    const l = { id, num, paneName: `Agent ${num}`, title, kind: 'agent', team: 'tm1', ...extra }
    leaves.set(id, l)
    return l
  }
  const lead = addLeaf('lead', 1, 'Claude Code')
  const mate = addLeaf('mate', 2, 'Codex CLI')
  const team = { id: 'tm1', name: 'Team 1', color: '#6c9cff', leadId: 'lead' }
  const otherTeams = []
  const cards = new Map()
  let cardN = 0
  let paneN = 10
  let clock = 1_000_000
  const log = { answers: [], notices: [], activity: [], opened: [], closed: [], toasts: [], attention: [], published: [], reports: [], worktrees: [] }
  const deps = {
    settings,
    teams: () => [team, ...otherTeams],
    now: () => clock,
    findLeaf: (id) => leaves.get(id) || null,
    label: (l) => `${l.paneName} ${l.title}`,
    isLead: (tm, id) => tm.leadId === id,
    wsOfLeaf: () => ws,
    agentAvailable: (id) => (['claude', 'codex'].includes(id) ? { id, name: id, command: id } : null),
    cardColumn: (id) => (cards.has(id) ? cards.get(id).column : null),
    createCard: (c) => {
      const id = `task-${++cardN}`
      cards.set(id, { id, column: 'todo', ...c })
      return id
    },
    updateCard: (id, patch) => cards.has(id) && Object.assign(cards.get(id), patch),
    removeCard: (id) => cards.delete(id),
    reportCard: (id, report, from) => {
      log.reports.push({ id, report, from: from.id })
      if (report.outcome === 'succeeded') cards.get(id).column = 'done'
    },
    createWorktree: async (w, title) => {
      log.worktrees.push(title)
      if (log.slow) clock += 30000 // longer than the tool waits
      return { worktree: { path: `C:\\repo.worktrees\\${title.replace(/\W+/g, '-').toLowerCase()}`, branch: 'agent/x', baseBranch: 'main' } }
    },
    openWorkerPane: async ({ agent, worktree, launchOptions }) => {
      const l = addLeaf(`pane-${++paneN}`, paneN, agent.id === 'codex' ? 'Codex CLI' : 'Claude Code', { team: null })
      log.opened.push({ id: l.id, agent: agent.id, worktree, launchOptions })
      return l
    },
    joinTeam: async (l, tm) => {
      l.team = tm.id
    },
    closePane: (id, opts) => {
      log.closed.push({ id, ...opts })
      leaves.delete(id)
    },
    notice: (list, text, teamId, opts) => log.notices.push({ to: list.map((l) => l.id), text, ...(opts && opts.wake ? { wake: true } : {}) }),
    answer: (tm, rid, ok, text, toId) => log.answers.push({ rid, ok, text, toId }),
    readScreen: (id) => (leaves.has(id) ? 'line 1\nRunning npm test\n' : null),
    activity: (e) => log.activity.push(e),
    attention: (title, body) => log.attention.push({ title, body }),
    toast: (text) => log.toasts.push(text),
    publish: (tm, p) => log.published.push(p)
  }
  const o = createOrchestrator(deps)
  const flush = () => new Promise((r) => setTimeout(r, 0))
  const start = (extra = {}, from = lead, rid = `r-test-${Math.random().toString(36).slice(2, 8)}`) =>
    o.handleRequest(team, from, { action: 'worker-start', rid, agent: 'codex', title: 'Fix the cart', brief: 'Make it right.', isolation: 'worktree', ...extra }, { teams: [team] })
  return { deps, ws, otherTeams, o, team, lead, mate, leaves, cards, log, settings, flush, start, tick: () => o.tick(team, [team]), advance: (ms) => (clock += ms) }
}

describe('orchestrator', () => {
  let w
  beforeEach(() => {
    w = world()
  })

  it('asks the user first (default): the card waits, nothing starts until allowed', async () => {
    w.start({}, w.lead, 'r-a-000001')
    const rec = w.team.workers[0]
    expect(rec.status).toBe('confirming')
    expect(w.cards.get(rec.taskId)).toMatchObject({ column: 'todo', by: 'lead', teamId: 'tm1' })
    expect(w.log.answers[0]).toMatchObject({ rid: 'r-a-000001', ok: true })
    expect(w.log.answers[0].text).toMatch(/waits for the user's confirmation/)
    expect(w.log.attention).toHaveLength(1)
    expect(w.log.opened).toHaveLength(0)
    expect(w.log.activity.map((e) => e.action)).toEqual(['worker-requested'])

    w.o.allow(w.team, rec.id, [w.team])
    await w.flush()
    await w.flush()
    expect(rec.status).toBe('running')
    const opened = w.log.opened[0]
    expect(opened.agent).toBe('codex')
    expect(opened.worktree.branch).toBe('agent/x')
    // The worker's first prompt is its launch argument; the brief a notice.
    expect(opened.launchOptions).toEqual({ model: null, effort: null, initialPrompt: WORKER_START_PROMPT })
    expect(w.cards.get(rec.taskId)).toMatchObject({ column: 'doing', paneId: opened.id })
    expect(w.leaves.get(opened.id).team).toBe('tm1')
    const brief = w.log.notices.find((n) => n.to[0] === opened.id)
    expect(brief.text).toMatch(/\[Tessel worker brief\]/)
    expect(brief.text).toMatch(/Your coordinator is Agent 1 Claude Code/)
    expect(brief.text).toMatch(new RegExp(`Your task card is ${rec.taskId}\\. Your dispatch id is ${rec.id}\\.`))
    // The coordinator hears it started (its tool's answer was already given).
    expect(w.log.notices.some((n) => n.to[0] === 'lead' && /Started worker Agent 11 \(codex\)/.test(n.text))).toBe(true)
    expect(w.log.activity.map((e) => e.action)).toContain('worker-started')
  })

  it('refused by the user: nothing starts, the waiting card goes, the lead is told', () => {
    w.start()
    const rec = w.team.workers[0]
    w.o.refuse(w.team, rec.id)
    expect(rec.status).toBe('refused')
    expect(w.cards.has(rec.taskId)).toBe(false)
    expect(w.log.opened).toHaveLength(0)
    expect(w.log.notices.at(-1)).toMatchObject({ to: ['lead'] })
    expect(w.log.notices.at(-1).text).toMatch(/The user refused/)
  })

  it('without confirmation: starts at once, answers with the handle; the rest queue at the limit', async () => {
    w = world({ confirm: false, max: 2 })
    w.start({ title: 'A' }, w.lead, 'r-a-000001')
    w.start({ title: 'B' }, w.lead, 'r-b-000002')
    w.start({ title: 'C' }, w.lead, 'r-c-000003')
    await w.flush()
    await w.flush()
    const [a, b, c] = w.team.workers
    expect([a.status, b.status, c.status]).toEqual(['running', 'running', 'queued'])
    expect(w.log.answers.find((x) => x.rid === 'r-a-000001').text).toMatch(/^Started worker Agent 11 \(codex\) on card task-1 "A"/)
    expect(w.log.answers.find((x) => x.rid === 'r-c-000003').text).toMatch(/is queued: you already have 2 workers running/)
    // A worker reports done: its slot goes to the queued one.
    w.o.handleRequest(w.team, w.leaves.get(a.paneId), { action: 'worker-done', outcome: 'succeeded', summary: 'Done.', files: [] })
    await w.flush()
    await w.flush()
    expect(a.status).toBe('done')
    expect(w.log.reports[0]).toMatchObject({ id: a.taskId, from: a.paneId })
    expect(c.status).toBe('running')
  })

  it('a queued worker waits for the cards before it', async () => {
    w = world({ confirm: false })
    const pre = w.cards.set('task-pre', { id: 'task-pre', column: 'doing' })
    expect(pre).toBeTruthy()
    w.start({ deps: ['task-pre'] }, w.lead, 'r-d-000001')
    await w.flush()
    const rec = w.team.workers[0]
    expect(rec.status).toBe('queued')
    expect(w.log.answers[0].text).toMatch(/it waits for card task-pre/)
    w.cards.get('task-pre').column = 'done'
    w.tick()
    await w.flush()
    await w.flush()
    expect(rec.status).toBe('running')
    // Unknown cards to wait for: refused at once.
    w.start({ deps: ['task-nope'] }, w.lead, 'r-e-000001')
    expect(w.log.answers.at(-1)).toMatchObject({ ok: false })
  })

  it('only the lead coordinates; a worker cannot nest past the depth limit', async () => {
    w = world({ confirm: false, depth: 1 })
    w.start({}, w.mate, 'r-m-000001')
    expect(w.log.answers[0]).toMatchObject({ ok: false })
    expect(w.log.answers[0].text).toMatch(/Only the team lead/)
    w.start({}, w.lead, 'r-l-000001')
    await w.flush()
    await w.flush()
    const worker = w.leaves.get(w.team.workers[0].paneId)
    w.start({}, worker, 'r-w-000001')
    expect(w.log.answers.at(-1).text).toMatch(/not permitted at depth 2 \(max 1\)/)
    // Depth 2 allowed: the worker may start one of its own.
    w.settings.orchestrationMaxDepth = 2
    w.start({}, worker, 'r-w-000002')
    await w.flush()
    await w.flush()
    expect(w.team.workers.at(-1)).toMatchObject({ by: worker.id, depth: 2, status: 'running' })
  })

  it('refuses agents that are not available', () => {
    w.start({ agent: 'gemini' }, w.lead, 'r-g-000001')
    expect(w.log.answers[0]).toMatchObject({ ok: false })
    expect(w.team.workers || []).toHaveLength(0)
  })

  it('stop, release, read; closed and silent workers', async () => {
    w = world({ confirm: false, max: 4 })
    w.start({ title: 'A' })
    w.start({ title: 'B' })
    w.start({ title: 'C' })
    await w.flush()
    await w.flush()
    const [a, b, c] = w.team.workers
    const handle = (r) => `#${w.leaves.get(r.paneId).num}`

    w.o.handleRequest(w.team, w.lead, { action: 'worker-read', rid: 'r-read-00001', worker: handle(a), lines: 20 })
    expect(w.log.answers.at(-1).text).toMatch(/is running\. No heartbeat yet\. Its screen now:\nline 1\nRunning npm test$/)
    // Not its worker: another agent cannot read or stop it.
    w.o.handleRequest(w.team, w.mate, { action: 'worker-stop', rid: 'r-stop-0001', worker: handle(a) })
    expect(w.log.answers.at(-1)).toMatchObject({ ok: false })

    w.o.handleRequest(w.team, w.lead, { action: 'worker-stop', rid: 'r-stop-0002', worker: handle(a), reason: 'not needed' })
    expect(a.status).toBe('stopped')
    expect(w.log.closed.at(-1)).toMatchObject({ id: a.paneId, byUser: false })

    const bPane = b.paneId
    w.o.handleRequest(w.team, w.lead, { action: 'worker-release', rid: 'r-rel-00001', worker: handle(b) })
    expect(b.status).toBe('released')
    expect(w.leaves.has(bPane)).toBe(true) // stays open
    expect(w.log.notices.some((n) => n.to[0] === bPane && /released you/.test(n.text))).toBe(true)

    // Heartbeats; then silence for longer than Orca's threshold: told once.
    w.o.handleRequest(w.team, w.leaves.get(c.paneId), { action: 'heartbeat', phase: 'implementing', note: '' })
    expect(c.phase).toBe('implementing')
    w.advance(STALE_MS + 1000)
    w.tick()
    w.tick()
    expect(w.log.notices.filter((n) => /sent no heartbeat/.test(n.text))).toHaveLength(1)
    // Its pane is closed by hand: ended, the lead told.
    w.leaves.delete(c.paneId)
    w.tick()
    expect(c.status).toBe('stopped')
    expect(w.log.notices.at(-1).text).toMatch(/ended before it reported: its pane was closed/)
    // The workers list the tools read.
    const pub = w.log.published.at(-1)
    expect(pub.limits).toEqual({ maxConcurrent: 4, maxDepth: 1, confirm: false })
    expect(pub.workers.map((x) => x.status)).toEqual(['stopped', 'released', 'stopped'])
    expect(pub.phases['Agent 1']).toBe('merging')
  })

  it('the user stops a running worker through the normal close, or cancels a waiting one', async () => {
    w = world({ confirm: false, max: 1 })
    w.start({ title: 'A' })
    w.start({ title: 'B' })
    await w.flush()
    await w.flush()
    const [a, b] = w.team.workers
    w.o.stopByUser(w.team, b.id)
    expect(b.status).toBe('stopped')
    expect(w.cards.has(b.taskId)).toBe(false)
    w.o.stopByUser(w.team, a.id)
    expect(w.log.closed.at(-1)).toMatchObject({ id: a.paneId, byUser: true })
    w.tick()
    expect(a.status).toBe('stopped')
    expect(a.reason).toBe('stopped by the user')
  })

  it('a start slower than the tool waits is told as a notice', async () => {
    w = world({ confirm: false })
    w.log.slow = true
    w.start({}, w.lead, 'r-slow-00001')
    await w.flush()
    await w.flush()
    expect(w.team.workers[0].status).toBe('running')
    expect(w.log.answers.filter((a) => a.rid === 'r-slow-00001')).toHaveLength(0)
    expect(w.log.notices.some((n) => n.to[0] === 'lead' && /^\[Tessel\] Started worker/.test(n.text))).toBe(true)
  })

  it('worker_done from an agent that is no worker is refused kindly', () => {
    w.o.handleRequest(w.team, w.mate, { action: 'worker-done', outcome: 'succeeded', summary: 'x', files: [] })
    expect(w.log.notices.at(-1).text).toMatch(/team_worker_done is for workers/)
  })

  it('the Tasks panel summary and sidebar worker info', async () => {
    w = world({ confirm: false })
    w.start()
    await w.flush()
    await w.flush()
    const rec = w.team.workers[0]
    const s = w.o.summary(w.team)
    expect(s).toMatchObject({ teamId: 'tm1', running: 1, waiting: 0, limits: { maxConcurrent: 2 } })
    expect(s.coordinators).toEqual([{ id: 'lead', label: 'Agent 1 Claude Code', phase: 'monitoring' }])
    expect(s.workers[0]).toMatchObject({ status: 'running', label: 'Agent 11 Codex CLI', byLabel: 'Agent 1 Claude Code' })
    expect(w.o.workerInfo(w.team, rec.paneId)).toEqual({ coordinatorId: 'lead', status: 'running', taskId: rec.taskId, depth: 1 })
    expect(w.o.workerInfo(w.team, 'mate')).toBeNull()
  })

  it('after a restart, a worker caught starting is running (pane there) or queued again', () => {
    w.team.workers = [
      { id: 'w-1', by: 'lead', status: 'starting', paneId: 'mate', taskId: null, deps: [] },
      { id: 'w-2', by: 'lead', status: 'starting', paneId: null, taskId: null, deps: [] }
    ]
    w.settings.orchestrationMaxWorkers = 1
    w.tick()
    expect(w.team.workers.map((r) => r.status)).toEqual(['running', 'queued'])
  })
})

// Codex's review of d370980 (C:/Tessel-codex/stabilize/design/check-orchestration-review.cjs).
describe('orchestrator: review fixes', () => {
  const active = (w) =>
    [w.team, ...w.otherTeams].reduce((n, tm) => n + (tm.workers || []).filter((x) => ['starting', 'running'].includes(x.status)).length, 0)

  it('the global cap holds on every path: a worker_done in one team never starts past it', async () => {
    const w = world({ confirm: false, max: 4 })
    w.start({ isolation: 'project' })
    w.start({ isolation: 'project' })
    await w.flush()
    w.otherTeams.push({ id: 'other', workers: Array.from({ length: 10 }, (_, i) => ({ id: `other-${i}`, by: 'x', status: 'running' })) })
    w.start({ title: 'q0', isolation: 'project' })
    w.start({ title: 'q1', isolation: 'project' })
    expect(w.team.workers.slice(2).map((x) => x.status)).toEqual(['queued', 'queued'])
    const first = w.team.workers[0]
    w.o.handleRequest(w.team, w.leaves.get(first.paneId), { action: 'worker-done', outcome: 'succeeded', summary: 'fixture', files: [] })
    await w.flush()
    await w.flush()
    expect(w.team.workers.slice(2).map((x) => x.status)).toEqual(['running', 'queued'])
    expect(active(w)).toBe(12)
    w.tick()
    await w.flush()
    expect(active(w)).toBe(12)
  })

  it('a queued request is checked again when it leaves the queue: lead revoked', async () => {
    const q = world({ confirm: false })
    q.cards.set('dependency', { id: 'dependency', column: 'doing' })
    q.start({ deps: ['dependency'], isolation: 'project' })
    q.team.leadId = 'mate'
    q.cards.get('dependency').column = 'done'
    q.tick()
    await q.flush()
    expect(q.log.opened).toHaveLength(0)
    expect(q.team.workers[0]).toMatchObject({ status: 'failed', reason: expect.stringMatching(/no longer leads/) })
  })

  it('confirmation turned on meanwhile: back to the user, who must allow it', async () => {
    const q = world({ confirm: false })
    q.cards.set('dependency', { id: 'dependency', column: 'doing' })
    q.start({ deps: ['dependency'], isolation: 'project' })
    q.settings.orchestrationConfirmWorkers = true
    q.cards.get('dependency').column = 'done'
    q.tick()
    await q.flush()
    const r = q.team.workers[0]
    expect(r.status).toBe('confirming')
    expect(q.log.opened).toHaveLength(0)
    expect(q.log.attention).toHaveLength(1)
    q.o.allow(q.team, r.id)
    await q.flush()
    await q.flush()
    expect(r.status).toBe('running')
    expect(r.approval).toMatchObject({ by: 'user' })
  })

  it('the approved context is frozen: another folder, a remote project or workspace is refused', async () => {
    for (const change of [(w) => (w.ws.cwd = 'D:\\other'), (w) => (w.ws.remote = { hostId: 'ssh-1' }), (w) => (w.ws.id = 'ws2')]) {
      const q = world({ confirm: true })
      q.start({ isolation: 'project' })
      const r = q.team.workers[0]
      change(q)
      q.o.allow(q.team, r.id)
      await q.flush()
      expect(q.log.opened).toHaveLength(0)
      expect(r).toMatchObject({ status: 'failed', reason: expect.stringMatching(/project changed/) })
    }
  })

  it("the coordinator's role is frozen too: a worker asking for a sub-worker, then made lead, is refused", async () => {
    const q = world({ confirm: false, depth: 2 })
    q.start({ isolation: 'project' })
    await q.flush()
    await q.flush()
    const worker = q.leaves.get(q.team.workers[0].paneId)
    q.cards.set('dep', { id: 'dep', column: 'doing' })
    q.start({ deps: ['dep'], isolation: 'project' }, worker)
    q.team.leadId = worker.id
    q.cards.get('dep').column = 'done'
    q.tick()
    await q.flush()
    expect(q.team.workers.at(-1)).toMatchObject({ status: 'failed', reason: expect.stringMatching(/role changed/) })
  })

  it('checked again after every wait: the folder changes while its copy is made, no pane opens', async () => {
    const q = world({ confirm: false })
    const make = q.deps.createWorktree
    q.deps.createWorktree = async (ws, title) => {
      const res = await make(ws, title)
      q.ws.cwd = 'D:\\moved'
      return res
    }
    q.start()
    await q.flush()
    await q.flush()
    expect(q.log.opened).toHaveLength(0)
    expect(q.team.workers[0]).toMatchObject({ status: 'failed', reason: expect.stringMatching(/project changed.*copy .* is kept/) })
  })

  it('a worker that moved to another team: its old lead can neither stop nor read it; it is released', async () => {
    const s = world({ confirm: false })
    s.start()
    await s.flush()
    await s.flush()
    const r = s.team.workers[0]
    const worker = s.leaves.get(r.paneId)
    worker.team = 'another-team'
    s.o.handleRequest(s.team, s.lead, { action: 'worker-stop', worker: `#${worker.num}`, rid: 'r-test-stop1' })
    s.o.handleRequest(s.team, s.lead, { action: 'worker-read', worker: `#${worker.num}`, rid: 'r-test-read1' })
    expect(s.log.closed).toEqual([])
    expect(s.log.answers.slice(-2).map((a) => a.ok)).toEqual([false, false])
    s.tick()
    expect(r).toMatchObject({ status: 'released', reason: 'it left the team' })
  })

  it('a former lead cannot stop the workers it started; the current lead can', async () => {
    const t = world({ confirm: false })
    t.start()
    await t.flush()
    await t.flush()
    const tw = t.leaves.get(t.team.workers[0].paneId)
    t.team.leadId = 'mate'
    t.o.handleRequest(t.team, t.lead, { action: 'worker-stop', worker: `#${tw.num}`, rid: 'r-test-stop2' })
    expect(t.log.closed).toEqual([])
    t.o.handleRequest(t.team, t.mate, { action: 'worker-stop', worker: `#${tw.num}`, rid: 'r-test-stop3' })
    expect(t.log.closed.map((c) => c.id)).toEqual([tw.id])
  })

  it('answers go to the requester only (sealed for it by the main process)', () => {
    const w = world({ confirm: true })
    w.start({}, w.lead, 'r-test-to0001')
    expect(w.log.answers[0]).toMatchObject({ rid: 'r-test-to0001', toId: 'lead' })
  })
})

// Workers started as chats (Settings > Orchestration): Claude and Codex only.
describe('orchestrator: chat workers', () => {
  function chatWorld(opts = {}) {
    const w = world({ confirm: false, ...opts })
    w.settings.orchestrationWorkerMode = 'chat'
    w.log.chats = []
    w.log.turns = []
    w.log.order = []
    w.log.reads = []
    w.working = new Set()
    let n = 20
    w.deps.openWorkerChat = async (o) => {
      w.log.chats.push(o)
      if (w.chatFails !== undefined) return w.chatFails
      const l = { id: `chat-${++n}`, num: n, paneName: `Agent ${n}`, title: o.agent.id === 'codex' ? 'Codex' : 'Claude', kind: 'chat', team: null }
      w.leaves.set(l.id, l)
      return l
    }
    w.deps.sendChatTurn = async (paneId, text) => {
      w.log.turns.push({ paneId, text })
      w.log.order.push('turn')
      return w.sendFails || { ok: true }
    }
    const notice = w.deps.notice
    w.deps.notice = (list, text, teamId, opts) => {
      w.log.order.push('notice')
      notice(list, text, teamId, opts)
    }
    w.deps.readChat = async (paneId, lines) => {
      w.log.reads.push({ paneId, lines })
      return w.leaves.has(paneId) ? '> User: go\n▸ Bash: npm test (done)\nAll green.' : null
    }
    w.deps.chatWorking = (paneId) => w.working.has(paneId)
    return w
  }
  const started = async (w, extra = {}) => {
    w.start({ model: 'claude-sonnet-5', effort: 'high', agent: 'claude', ...extra }, w.lead, 'r-chat-000001')
    await w.flush()
    await w.flush()
    await w.flush()
    return w.team.workers.at(-1)
  }
  const told = (w, re) => w.log.notices.filter((x) => x.to[0] === 'lead' && re.test(x.text))
  const turnEnd = (w, r, ev) => {
    w.o.chatTurnEnded(r.paneId, ev)
    w.advance(TURN_END_GRACE_MS + 1)
    w.tick()
  }

  it('starts a chat with the worker model, effort and coordinator; the first prompt is a turn, then the brief', async () => {
    const w = chatWorld()
    const r = await started(w)
    expect(w.log.opened).toHaveLength(0) // no terminal pane
    expect(w.log.chats).toHaveLength(1)
    const o = w.log.chats[0]
    expect(o).toMatchObject({ ws: w.ws, model: 'claude-sonnet-5', effort: 'high', coordinator: w.lead })
    expect(o.agent.id).toBe('claude')
    expect(o.worktree.branch).toBe('agent/x')
    expect(r).toMatchObject({ status: 'running', chat: true, paneId: 'chat-21' })
    expect(w.leaves.get('chat-21').team).toBe('tm1')
    expect(w.log.turns).toEqual([{ paneId: 'chat-21', text: WORKER_START_PROMPT }])
    // The turn first, then the brief (a team turn), then the coordinator told.
    expect(w.log.order.slice(0, 2)).toEqual(['turn', 'notice'])
    expect(w.log.notices[0]).toMatchObject({ to: ['chat-21'] })
    expect(w.log.notices[0].text).toMatch(/\[Tessel worker brief\]/)
    expect(w.log.answers.at(-1)).toMatchObject({ rid: 'r-chat-000001', ok: true })
    expect(w.log.answers.at(-1).text).toMatch(/^Started worker Agent 21 \(claude\)/)
    expect(w.cards.get(r.taskId)).toMatchObject({ column: 'doing', paneId: 'chat-21' })
    expect(w.o.summary(w.team).workers[0]).toMatchObject({ chat: true })
    w.tick()
    expect(w.log.published.at(-1).workers[0]).toMatchObject({ chat: true })
  })

  it('a chat that cannot start: the worker fails, its slot is free, its coordinator told', async () => {
    const w = chatWorld()
    w.chatFails = { error: 'the folder is not approved', code: 'untrusted' }
    const r = await started(w)
    expect(r).toMatchObject({ status: 'failed', reason: 'its chat could not start (the folder is not approved)' })
    expect(w.log.answers.at(-1)).toMatchObject({ rid: 'r-chat-000001', ok: false })
    expect(w.log.answers.at(-1).text).toMatch(/was not started: its chat could not start \(the folder is not approved\)/)
    expect(w.cards.get(r.taskId).column).toBe('todo')
    expect(w.log.turns).toHaveLength(0)
    // null too.
    w.chatFails = null
    const r2 = await started(w, { title: 'Other' })
    expect(r2).toMatchObject({ status: 'failed', reason: 'its chat could not start (unknown error)' })
  })

  it('its first turn not sent: the chat is closed and the worker fails', async () => {
    const w = chatWorld()
    w.sendFails = { ok: false, error: 'the agent exited' }
    const r = await started(w)
    expect(r).toMatchObject({ status: 'failed', reason: 'its chat could not start (the agent exited)' })
    expect(w.log.closed.at(-1)).toMatchObject({ id: 'chat-21', byUser: false })
    expect(w.log.notices.some((x) => /worker brief/.test(x.text))).toBe(false)
  })

  it('other agents stay terminals in chat mode; terminal mode (the default) never opens a chat', async () => {
    const w = chatWorld()
    w.deps.agentAvailable = (id) => ({ id, name: id, command: id })
    const r = await started(w, { agent: 'gemini' })
    expect(w.log.chats).toHaveLength(0)
    expect(w.log.opened[0].launchOptions.initialPrompt).toBe(WORKER_START_PROMPT)
    expect(r.chat).toBeUndefined()
    const t = chatWorld()
    t.settings.orchestrationWorkerMode = 'terminal'
    const r2 = await started(t)
    expect(t.log.chats).toHaveLength(0)
    expect(t.log.opened).toHaveLength(1)
    // Not a chat worker: its turn ends mean nothing here.
    t.o.chatTurnEnded(r2.paneId, { status: 'completed' })
    t.advance(TURN_END_GRACE_MS + 1)
    t.tick()
    expect(t.log.notices.some((x) => x.text === CHAT_REMINDER)).toBe(false)
    expect(r2.turnEnds).toBeUndefined()
  })

  it('a turn ended without a report: one reminder, then its coordinator told once, then nothing', async () => {
    const w = chatWorld()
    const r = await started(w)
    w.o.chatTurnEnded(r.paneId, { status: 'completed' })
    w.tick() // too soon: its team_worker_done may still come
    expect(w.log.notices.filter((x) => x.text === CHAT_REMINDER)).toHaveLength(0)
    w.advance(TURN_END_GRACE_MS + 1)
    w.tick()
    expect(w.log.notices.filter((x) => x.text === CHAT_REMINDER)).toEqual([{ to: ['chat-21'], text: CHAT_REMINDER }])
    expect(r.reminded).toBe(true)
    turnEnd(w, r, { status: 'completed' })
    const silent = told(w, /stopped without reporting/)
    expect(silent).toHaveLength(1)
    expect(silent[0].text).toBe(
      '[Tessel] Worker Agent 21 "Fix the cart" (card task-1) stopped without reporting, even after a reminder. Look at it (team_worker_read), ask it (team_ask), or stop it (team_worker_stop).'
    )
    turnEnd(w, r, { status: 'completed' })
    turnEnd(w, r, { status: 'completed' })
    expect(w.log.notices.filter((x) => x.text === CHAT_REMINDER)).toHaveLength(1)
    expect(told(w, /stopped without reporting/)).toHaveLength(1)
    expect(r.status).toBe('running') // nothing reset or stopped by itself
  })

  it('a failed turn: its coordinator told with the error, once per error', async () => {
    const w = chatWorld()
    const r = await started(w)
    turnEnd(w, r, { status: 'failed', error: 'usage limit reached' })
    turnEnd(w, r, { status: 'failed', error: 'usage limit reached' })
    const failed = told(w, /its turn failed/)
    expect(failed.map((x) => x.text)).toEqual(['[Tessel] Worker Agent 21 "Fix the cart" (card task-1): its turn failed: usage limit reached.'])
    turnEnd(w, r, { status: 'failed', error: 'content filtered' })
    expect(told(w, /its turn failed/)).toHaveLength(2)
    // A failure is no silence: no reminder for it.
    expect(w.log.notices.some((x) => x.text === CHAT_REMINDER)).toBe(false)
  })

  it('the same failure with other ids, numbers or times is told once', async () => {
    const w = chatWorld()
    const r = await started(w)
    turnEnd(w, r, { status: 'failed', error: 'API error 529 (request req_011CXa9Zk2) at 2026-09-29T10:00:01Z' })
    turnEnd(w, r, { status: 'failed', error: 'API error 529 (request req_022DYb8Yj3) at 2026-09-29T10:00:09Z' })
    turnEnd(w, r, { status: 'failed', error: 'API Error 503 (request 3f1c2a9e-1b2c-4d5e-8f90-123456789abc) at 10:01:17' })
    expect(told(w, /its turn failed/)).toHaveLength(1)
    expect(failureKey('Rate limit: retry in 42s, id abc123def')).toBe(failureKey('Rate limit: retry in 7s, id 99ffee00aa'))
    expect(failureKey('usage limit reached')).not.toBe(failureKey('content filtered'))
  })

  it('failure notices: at most 3 per worker per 10 minutes, whatever the errors', async () => {
    const w = chatWorld()
    const r = await started(w)
    for (const e of ['one', 'two', 'three', 'four', 'five']) turnEnd(w, r, { status: 'failed', error: 'failure ' + e })
    expect(told(w, /its turn failed/)).toHaveLength(FAIL_NOTICES_MAX)
    w.advance(FAIL_NOTICES_WINDOW_MS)
    turnEnd(w, r, { status: 'failed', error: 'failure six' })
    expect(told(w, /its turn failed/)).toHaveLength(FAIL_NOTICES_MAX + 1)
  })

  it('a heartbeat or a report resets the reminder flags: a later silence is reminded again', async () => {
    const w = chatWorld()
    const r = await started(w)
    turnEnd(w, r, { status: 'completed' })
    turnEnd(w, r, { status: 'completed' })
    expect(r).toMatchObject({ reminded: true, silentTold: true })
    w.o.handleRequest(w.team, w.leaves.get(r.paneId), { action: 'heartbeat', phase: 'testing', note: '' })
    expect(r).toMatchObject({ reminded: false, silentTold: false })
    turnEnd(w, r, { status: 'completed' })
    expect(w.log.notices.filter((x) => x.text === CHAT_REMINDER)).toHaveLength(2)
    turnEnd(w, r, { status: 'completed' })
    expect(told(w, /stopped without reporting/)).toHaveLength(2)
    w.o.handleRequest(w.team, w.leaves.get(r.paneId), { action: 'worker-done', outcome: 'succeeded', summary: 'Done.', files: [] })
    expect(r).toMatchObject({ reminded: false, silentTold: false })
  })

  it('reported (even just after its turn ended), interrupted or working again: nothing is said', async () => {
    const w = chatWorld()
    const r = await started(w)
    const before = w.log.notices.length
    // Interrupted (the user or a stop).
    turnEnd(w, r, { status: 'interrupted' })
    // Working again when judged: the next turn end is the one that counts.
    w.o.chatTurnEnded(r.paneId, { status: 'completed' })
    w.working.add(r.paneId)
    w.advance(TURN_END_GRACE_MS + 1)
    w.tick()
    expect(w.log.notices.length).toBe(before)
    w.working.delete(r.paneId)
    // Its team_worker_done arrives after the turn end, within the grace.
    w.o.chatTurnEnded(r.paneId, { status: 'completed' })
    w.o.handleRequest(w.team, w.leaves.get(r.paneId), { action: 'worker-done', outcome: 'succeeded', summary: 'Done.', files: [] })
    expect(r.status).toBe('done')
    w.advance(TURN_END_GRACE_MS + 1)
    w.tick()
    turnEnd(w, r, { status: 'completed' })
    const said = w.log.notices.slice(before).filter((x) => x.text === CHAT_REMINDER || /stopped without reporting|turn failed/.test(x.text))
    expect(said).toEqual([])
  })

  it('team_worker_read of a chat worker reads its conversation', async () => {
    const w = chatWorld()
    const r = await started(w)
    w.o.handleRequest(w.team, w.lead, { action: 'worker-read', rid: 'r-read-chat01', worker: 'Agent 21', lines: 20 })
    await w.flush()
    expect(w.log.reads).toEqual([{ paneId: r.paneId, lines: 20 }])
    expect(w.log.answers.at(-1)).toMatchObject({ rid: 'r-read-chat01', ok: true, toId: 'lead' })
    expect(w.log.answers.at(-1).text).toBe('Agent 21 "Fix the cart" is running. No heartbeat yet. Its conversation now:\n> User: go\n▸ Bash: npm test (done)\nAll green.')
    // Not open (readChat -> null).
    w.deps.readChat = async () => null
    w.o.handleRequest(w.team, w.lead, { action: 'worker-read', rid: 'r-read-chat02', worker: 'Agent 21' })
    await w.flush()
    expect(w.log.answers.at(-1)).toMatchObject({ rid: 'r-read-chat02', ok: false, text: "Agent 21's chat is not open." })
    // Another agent may not read it; nothing is read for it.
    const reads = w.log.reads.length
    w.o.handleRequest(w.team, w.mate, { action: 'worker-read', rid: 'r-read-chat03', worker: 'Agent 21' })
    await w.flush()
    expect(w.log.answers.at(-1)).toMatchObject({ rid: 'r-read-chat03', ok: false })
    expect(w.log.reads).toHaveLength(reads)
  })

  it('stop closes it the usual way; a chat at work is never "silent"', async () => {
    const w = chatWorld({ max: 3 })
    const r = await started(w)
    const r2 = await started(w, { title: 'B' })
    w.working.add(r.paneId)
    w.advance(STALE_MS + 1000)
    w.tick()
    const stale = w.log.notices.filter((x) => /sent no heartbeat/.test(x.text))
    expect(stale).toHaveLength(1)
    expect(stale[0].text).toMatch(/"B"/)
    w.o.handleRequest(w.team, w.lead, { action: 'worker-stop', rid: 'r-stop-chat1', worker: `#${w.leaves.get(r.paneId).num}` })
    expect(r.status).toBe('stopped')
    expect(w.log.closed.at(-1)).toMatchObject({ id: r.paneId, byUser: false })
    expect(r2.status).toBe('running')
  })

  // A chat coordinator hears of its workers as turns (App points it at
  // team_inbox for notices sent with wake); every worker is told its own
  // address and its coordinator's.
  it('a chat coordinator: told results come as a turn; its notices wake it; the worker knows both addresses', async () => {
    const w = chatWorld({ max: 1 })
    w.lead.kind = 'chat'
    const r = await started(w)
    const brief = w.log.notices.find((x) => x.to[0] === r.paneId && /worker brief/.test(x.text))
    expect(brief.wake).toBeUndefined()
    expect(brief.text).toMatch(/Your address in the team is "Agent 21": your coordinator and teammates reach you with team_send \{"to":"Agent 21"\}\. Your coordinator's address is "Agent 1"\./)
    expect(brief.text).toMatch(/You are a chat: a message that arrives while you are idle starts a new turn/)
    expect(brief.text).toMatch(/team_ask \{"to":"Agent 1"/)
    expect(w.log.answers.at(-1).text).toMatch(/Its report comes to you as a new turn of this chat/)
    // At the limit: queued, and told how it will hear.
    w.start({ agent: 'claude', title: 'B' }, w.lead, 'r-chat-000002')
    expect(w.log.answers.at(-1).text).toMatch(/is queued: .* You will hear as a new turn of this chat/)
    // Its worker's pane closed: the coordinator's notice wakes it.
    w.leaves.delete(r.paneId)
    w.tick()
    const ended = told(w, /ended before it reported/)
    expect(ended).toHaveLength(1)
    expect(ended[0].wake).toBe(true)
  })

  it('a terminal coordinator: same notices, no turn wording; a terminal worker is not told it is a chat', async () => {
    const w = world({ confirm: false })
    w.start({}, w.lead, 'r-term-000001')
    await w.flush()
    await w.flush()
    const r = w.team.workers[0]
    expect(w.log.answers.at(-1).text).not.toMatch(/new turn/)
    const brief = w.log.notices.find((x) => x.to[0] === r.paneId)
    expect(brief.text).toMatch(/Your address in the team is "Agent 11"/)
    expect(brief.text).not.toMatch(/You are a chat/)
  })
})
