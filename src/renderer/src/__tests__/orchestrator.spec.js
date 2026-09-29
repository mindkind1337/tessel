// The renderer's coordinator/worker bookkeeping (orchestrator.js), with fake
// panes, cards and team tools: no terminal, no agent is ever started.
import { describe, it, expect, beforeEach } from 'vitest'
import { reactive } from 'vue'
import { createOrchestrator } from '../orchestrator'
import { WORKER_START_PROMPT, STALE_MS } from '../../../shared/orchestration'

function world({ confirm = true, max = 2, depth = 1 } = {}) {
  const settings = reactive({ orchestrationConfirmWorkers: confirm, orchestrationMaxWorkers: max, orchestrationMaxDepth: depth })
  const ws = { id: 'ws1', cwd: 'C:\\repo', remote: null }
  const leaves = new Map()
  const addLeaf = (id, num, title, extra = {}) => {
    const l = { id, num, title, kind: 'agent', team: 'tm1', ...extra }
    leaves.set(id, l)
    return l
  }
  const lead = addLeaf('lead', 1, 'Claude Code')
  const mate = addLeaf('mate', 2, 'Codex CLI')
  const team = { id: 'tm1', name: 'Team 1', color: '#6c9cff', leadId: 'lead' }
  const cards = new Map()
  let cardN = 0
  let paneN = 10
  let clock = 1_000_000
  const log = { answers: [], notices: [], activity: [], opened: [], closed: [], toasts: [], attention: [], published: [], reports: [], worktrees: [] }
  const deps = {
    settings,
    now: () => clock,
    findLeaf: (id) => leaves.get(id) || null,
    label: (l) => `#${l.num} ${l.title}`,
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
    notice: (list, text) => log.notices.push({ to: list.map((l) => l.id), text }),
    answer: (tm, rid, ok, text) => log.answers.push({ rid, ok, text }),
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
  return { o, team, lead, mate, leaves, cards, log, settings, flush, start, tick: () => o.tick(team, [team]), advance: (ms) => (clock += ms) }
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
    expect(brief.text).toMatch(/Your coordinator is #1 Claude Code/)
    expect(brief.text).toMatch(new RegExp(`Your task card is ${rec.taskId}\\. Your dispatch id is ${rec.id}\\.`))
    // The coordinator hears it started (its tool's answer was already given).
    expect(w.log.notices.some((n) => n.to[0] === 'lead' && /Started worker #11 \(codex\)/.test(n.text))).toBe(true)
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
    expect(w.log.answers.find((x) => x.rid === 'r-a-000001').text).toMatch(/^Started worker #11 \(codex\) on card task-1 "A"/)
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
    expect(pub.phases['#1']).toBe('merging')
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
    expect(s.coordinators).toEqual([{ id: 'lead', label: '#1 Claude Code', phase: 'monitoring' }])
    expect(s.workers[0]).toMatchObject({ status: 'running', label: '#11 Codex CLI', byLabel: '#1 Claude Code' })
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
