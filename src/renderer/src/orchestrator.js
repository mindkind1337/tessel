// Orchestration in the renderer: a coordinator agent (a team's lead, or a
// worker allowed to nest) starts workers in new panes through the team tools
// (team_worker_start, ...: src/main/teamMcp/server.cjs). Like Orca's
// coordinator (MIT, Copyright (c) 2026 Lovecast Inc.: src/main/runtime/
// orchestration/coordinator.ts): at most N workers at a time per
// coordinator, the rest wait in a queue (and for the cards they come
// after), nesting capped, a heartbeat expected, worker_done settles the
// task. The Tessel way: the lead agent decides the work (no separate loop),
// the user confirms each start (Settings > Orchestration, on by default),
// and nothing is ever typed into a terminal (the brief is a background
// notice; the worker starts with a fixed first prompt on its command line).
//
// Worker records live in their team (team.workers, saved with the layout):
// { id, rid, by (coordinator pane id), agent, title, brief, model, effort,
//   isolation, deps, depth, wsId, status, requestedAt, startedAt, endedAt,
//   paneId, taskId, branch, heartbeatAt, phase, note, reason }
// A chat worker (Settings > Orchestration: workers start as chats) also has
// chat: true, and what its turn ends led to: turnEnds (waiting to be
// settled), lastTurnAt, reminded, silentTold, failsTold (failureKey of each
// failure told), failNoticesAt (when they were told).
//
// App.vue gives it what it needs (deps, below), so it is tested with fakes.
// Text for agents stays English; the user's through t().
import {
  decideWorkerStart,
  workersToStart,
  coordinatorPhase,
  workerPreamble,
  outputTail,
  resolveMaxConcurrent,
  resolveMaxDepth,
  depthExceededMessage,
  WORKER_START_PROMPT,
  WORKER_ACTIVE,
  WORKER_WAITING,
  WORKER_ENDED,
  STALE_MS,
  START_RATE
} from '../../shared/orchestration'
import { t } from './i18n'

const KEEP_ENDED = 40 // ended records kept per team (the latest)
const ANSWER_WINDOW_MS = 25000 // under the 30 s a worker tool waits for its answer
// A chat worker's turn end is judged this long after it: its team_worker_done
// (a request file the team loop applies every few seconds) may come after.
export const TURN_END_GRACE_MS = 8000
const CHAT_AGENTS = ['claude', 'codex']
// Failed-turn notices to a coordinator: at most this many per worker per window.
export const FAIL_NOTICES_MAX = 3
export const FAIL_NOTICES_WINDOW_MS = 10 * 60 * 1000

// A failed turn's error without what changes from one try to the next (ids,
// UUIDs, times, numbers), so the same failure is told once.
export function failureKey(error) {
  return String(error ?? '')
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '#')
    .replace(/\d{4}-\d{2}-\d{2}[t ]\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?(z|[+-]\d{2}:?\d{2})?/g, '#')
    .replace(/\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?(\s*[ap]m)?/g, '#')
    .replace(/\b(?=[a-z_-]*\d)[a-z0-9_-]{6,}\b/g, '#')
    .replace(/\d+/g, '#')
    .replace(/[\s#.,:;]*#[\s#.,:;]*/g, ' # ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300)
}
export const CHAT_REMINDER =
  '[Tessel] Your turn ended but you have not reported. When the work is finished call team_worker_done (outcome, summary, files); if you are blocked, say why with team_worker_done outcome failed or ask your coordinator with team_ask.'

// deps: {
//   settings, t,
//   findLeaf(id), label(leaf) "#2 Claude Code", isLead(team, leafId),
//   wsOfLeaf(id) -> { id, cwd, remote }, agentAvailable(agentId) -> agent | null,
//   cardColumn(taskId), createCard({ title, brief, wsId, by, teamId, deps, workerId }) -> taskId,
//   updateCard(taskId, patch), removeCard(taskId), reportCard(taskId, report, fromLeaf, teamId),
//   createWorktree(ws, title) -> { worktree } | { error },
//   openWorkerPane({ ws, agent, worktree, launchOptions }) -> leaf | null,
//   joinTeam(leaf, team) -> Promise, closePane(paneId, { byUser }),
//   notice(leaves, text, teamId), answer(team, rid, ok, text),
//   readScreen(paneId, lines) -> string | null,
//   activity(event), attention(title, body, paneId), toast(text, opts),
//   publish(team, { workers, limits, phases }), now(),
//   chat workers (settings.orchestrationWorkerMode 'chat', Claude or Codex):
//   openWorkerChat({ ws, agent, worktree, model, effort, coordinator })
//     -> Promise<leaf | { error, code } | null>,
//   sendChatTurn(paneId, text) -> Promise<{ ok, error }> (a user turn),
//   readChat(paneId, lines) -> Promise<string | null> (formatChatTranscript),
//   chatWorking(paneId) -> boolean (optional: a turn is running)
// }
export function createOrchestrator(deps) {
  const now = () => (deps.now ? deps.now() : Date.now())
  const starts = {} // coordinator pane id -> start request times (rate)
  const startingNow = new Set() // records being started in this session


  const limits = () => ({
    maxConcurrent: resolveMaxConcurrent(deps.settings.orchestrationMaxWorkers),
    maxDepth: resolveMaxDepth(deps.settings.orchestrationMaxDepth),
    confirm: deps.settings.orchestrationConfirmWorkers !== false
  })
  const records = (team) => {
    if (!Array.isArray(team.workers)) team.workers = []
    return team.workers
  }
  // Started as a chat? Only Claude and Codex have one; the rest stay terminals.
  const chatMode = (r) => deps.settings.orchestrationWorkerMode === 'chat' && CHAT_AGENTS.includes(r.agent)
  const handleOf = (leaf) => leaf ? leaf.paneName || null : null
  const labelOf = (id) => {
    const leaf = id ? deps.findLeaf(id) : null
    return leaf ? deps.label(leaf) : 'a closed agent'
  }

  // A pane's worker record (running or not) in this team.
  function recordOfPane(team, paneId) {
    return records(team).find((r) => r.paneId === paneId && !['refused'].includes(r.status)) || null
  }
  // 0: the lead; a worker's depth; null: coordinates nothing.
  function depthOf(team, paneId) {
    if (deps.isLead(team, paneId)) return 0
    const r = records(team).find((x) => x.paneId === paneId && WORKER_ACTIVE.includes(x.status))
    return r ? r.depth : null
  }
  // Every team Tessel has now: the global cap and the queue are one
  // scheduler for all of them, whoever calls it.
  const allTeams = () => (deps.teams ? deps.teams() : []) || []
  function activeTotal() {
    let n = 0
    for (const tm of allTeams()) for (const r of records(tm)) if (WORKER_ACTIVE.includes(r.status)) n++
    return n
  }
  // The worker "#5" of this team (an active or waiting record), only while
  // its pane is still in this team.
  function recordByHandle(team, handle) {
    return (
      records(team).find((r) => {
        if (!r.paneId || WORKER_ENDED.includes(r.status)) return false
        const leaf = deps.findLeaf(r.paneId)
        return !!leaf && leaf.team === team.id && (String(handleOf(leaf) || '').toLowerCase() === String(handle).toLowerCase() || `#${leaf.num}` === handle)
      }) || null
    )
  }

  // One answer to the tool that waits for it (30 s at most), then notices.
  function tell(team, r, ok, text) {
    if (r.rid && !r.answered && now() - (r.requestedAt || 0) < ANSWER_WINDOW_MS) {
      r.answered = true
      deps.answer(team, r.rid, ok, text, r.by)
      return
    }
    const coord = deps.findLeaf(r.by)
    if (coord) deps.notice([coord], `[Tessel] ${text}`, team.id)
  }
  // Sealed by Tessel's main process for the requester only (teamAuth.js).
  const answerNow = (team, req, from, ok, text) => {
    if (req.rid) deps.answer(team, req.rid, ok, text, from.id)
  }

  function prune(team) {
    const list = records(team)
    const ended = list.filter((r) => WORKER_ENDED.includes(r.status))
    if (ended.length <= KEEP_ENDED) return
    const drop = new Set(ended.slice(0, ended.length - KEEP_ENDED))
    team.workers = list.filter((r) => !drop.has(r))
  }

  // --- Requests from agents (the team's request files) ----------------------------
  // -> true when it was an orchestration request (handled here).
  function handleRequest(team, from, req, ctx = {}) {
    if (req.worker && req.worker !== 'all') {
      const candidates = records(team).map((r) => r.paneId && deps.findLeaf(r.paneId)).filter((l) => l && l.team === team.id)
      const matches = candidates.filter((l) => String(l.paneName || '').toLowerCase() === String(req.worker).toLowerCase() || `#${l.num}` === req.worker)
      if (matches.length === 1 && matches[0].paneName) req = { ...req, worker: matches[0].paneName }
    }
    switch (req.action) {
      case 'worker-start':
        requestStart(team, from, req, ctx)
        return true
      case 'worker-stop':
        stopRequest(team, from, req)
        return true
      case 'worker-release':
        releaseRequest(team, from, req)
        return true
      case 'worker-read':
        readRequest(team, from, req)
        return true
      case 'worker-done':
        doneRequest(team, from, req)
        return true
      case 'heartbeat':
        heartbeatRequest(team, from, req)
        return true
      default:
        return false
    }
  }

  function requestStart(team, from, req, ctx) {
    const lim = limits()
    const depth = depthOf(team, from.id)
    const list = records(team)
    const running = list.filter((r) => r.by === from.id && WORKER_ACTIVE.includes(r.status)).length
    const recent = (starts[from.id] = (starts[from.id] || []).filter((x) => now() - x < START_RATE.perMs))
    const decision = decideWorkerStart({
      depth,
      maxDepth: lim.maxDepth,
      running,
      total: activeTotal(),
      maxConcurrent: lim.maxConcurrent,
      recent,
      now: now()
    })
    if (decision.error) return answerNow(team, req, from, false, decision.error)
    if (!deps.agentAvailable(req.agent))
      return answerNow(team, req, from, false, `The agent "${req.agent}" is not installed or is turned off in Tessel (Settings > Agents). Pick another one.`) // i18n-ignore
    const ws = deps.wsOfLeaf(from.id)
    if (!ws || !ws.cwd) return answerNow(team, req, from, false, 'Your workspace has no project folder: a worker cannot be started there.') // i18n-ignore
    if (ws.remote) return answerNow(team, req, from, false, 'Workers cannot be started in a remote project yet. Do this work yourself.') // i18n-ignore
    const unknown = (req.deps || []).filter((d) => deps.cardColumn(d) == null)
    if (unknown.length) return answerNow(team, req, from, false, `No card ${unknown.join(', ')} on your team's board to wait for (see team_tasks).`) // i18n-ignore
    recent.push(now())
    // The context the request is approved in (by the settings or by the
    // user), frozen: at the start it must still be the same.
    const context = { wsId: ws.id, cwd: ws.cwd, remote: !!ws.remote, coordinatorId: from.id, role: depth === 0 ? 'lead' : 'worker', coordDepth: depth }
    const r = {
      id: `w-${now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      rid: req.rid || null,
      by: from.id,
      agent: req.agent,
      title: req.title,
      brief: req.brief,
      model: req.model || null,
      effort: req.effort || null,
      isolation: req.isolation || 'worktree',
      deps: req.deps || [],
      depth: decision.depth,
      wsId: ws.id,
      context,
      // The proof it may start: given by the settings (confirmation off) or
      // by the user (Allow), for this context.
      approval: lim.confirm ? null : { by: 'settings', at: now(), context: contextKey(context) },
      status: lim.confirm ? 'confirming' : 'queued',
      requestedAt: now(),
      startedAt: null,
      endedAt: null,
      paneId: null,
      taskId: null
    }
    // On the board from the start: the card waits in To do.
    r.taskId = deps.createCard({ title: r.title, brief: r.brief, wsId: ws.id, by: from.id, teamId: team.id, deps: r.deps, workerId: r.id })
    list.push(r)
    prune(team)
    const how = `${r.agent}, ${r.isolation === 'worktree' ? 'own copy' : 'project folder'}` // i18n-ignore
    deps.activity({ type: 'task', action: 'worker-requested', paneId: from.id, title: r.title, wsId: ws.id, by: deps.label(from), detail: how })
    if (r.status === 'confirming') {
      r.answered = true
      answerNow(
        team,
        req,
        from,
        true,
        `Worker request ${r.id} for "${r.title}" (card ${r.taskId}) waits for the user's confirmation in Tessel. You will hear in team_inbox when it starts or is refused; meanwhile go on with other work.` // i18n-ignore
      )
      askUser(r, from)
      return
    }
    pump()
    if (r.status === 'queued') {
      r.answered = true
      answerNow(team, req, from, true, queuedText(team, r))
    }
  }

  function askUser(r, from) {
    const title = t('tasks.orch.confirm.title', '{{pane}} wants to start a worker', { pane: deps.label(from) })
    deps.attention(title, r.title, from.id)
    deps.toast(t('tasks.orch.confirm.toast', '{{pane}} wants to start a worker ({{agent}}) for "{{title}}". Allow or refuse it in the Tasks panel.', { pane: deps.label(from), agent: r.agent, title: r.title }), {
      kind: 'attention',
      timeout: 15000,
      showTasks: true
    })
  }

  function queuedText(team, r) {
    const waiting = (r.deps || []).filter((d) => deps.cardColumn(d) !== 'done')
    const why = waiting.length
      ? `it waits for card ${waiting.join(', ')}` // i18n-ignore
      : `you already have ${limits().maxConcurrent} workers running (the limit): it starts when one ends` // i18n-ignore
    return `Worker request ${r.id} for "${r.title}" (card ${r.taskId}) is queued: ${why}. You will hear in team_inbox when it starts.` // i18n-ignore
  }

  // May `from` act on this worker now? Both still in this team, and `from`
  // its coordinator still coordinating (the lead, or a running worker), or
  // the team's current lead.
  function mayControl(team, from, r) {
    if (!from || from.team !== team.id) return false
    if (r.paneId) {
      const leaf = deps.findLeaf(r.paneId)
      if (!leaf || leaf.team !== team.id) return false
    }
    if (deps.isLead(team, from.id)) return true
    return r.by === from.id && depthOf(team, from.id) !== null
  }

  function stopRequest(team, from, req) {
    const list =
      req.worker === 'all'
        ? records(team).filter((r) => r.by === from.id && !WORKER_ENDED.includes(r.status) && mayControl(team, from, r))
        : [recordByHandle(team, req.worker)].filter(Boolean)
    if (req.worker !== 'all' && !list.length) return answerNow(team, req, from, false, `${req.worker} is not a worker of your team (see team_worker_list).`) // i18n-ignore
    if (list.some((r) => !mayControl(team, from, r))) return answerNow(team, req, from, false, `${req.worker} is not your worker: only its coordinator (or the lead) can stop it.`) // i18n-ignore
    const done = []
    for (const r of list) {
      endWorker(team, r, 'stopped', req.reason || 'stopped by its coordinator', from) // i18n-ignore
      done.push(r.paneId ? handleOf(deps.findLeaf(r.paneId)) || r.id : r.id)
    }
    pump()
    answerNow(team, req, from, true, done.length ? `Stopped: ${done.join(', ')}. Their cards and copies stay for review.` : 'You have no worker to stop.') // i18n-ignore
  }

  function releaseRequest(team, from, req) {
    const r = recordByHandle(team, req.worker)
    if (!r || !WORKER_ACTIVE.includes(r.status)) return answerNow(team, req, from, false, `${req.worker} is not a running worker of your team (see team_worker_list).`) // i18n-ignore
    if (!mayControl(team, from, r)) return answerNow(team, req, from, false, `${req.worker} is not your worker.`) // i18n-ignore
    r.status = 'released'
    r.endedAt = now()
    const leaf = deps.findLeaf(r.paneId)
    if (leaf)
      deps.notice(
        [leaf],
        `[Tessel] ${deps.label(from)} released you: you are no longer its worker, just a teammate in the team. Finish or report card ${r.taskId} as it asks (team_task_done).`, // i18n-ignore
        team.id
      )
    deps.activity({ type: 'task', action: 'worker-released', paneId: r.paneId, title: r.title, wsId: r.wsId, by: deps.label(from) })
    pump()
    answerNow(team, req, from, true, `Released ${req.worker}: it stays in the team as an ordinary teammate; its slot is free.`) // i18n-ignore
  }

  function readRequest(team, from, req) {
    const r =
      recordByHandle(team, req.worker) ||
      records(team).find((x) => {
        const leaf = x.paneId ? deps.findLeaf(x.paneId) : null
        return !!leaf && leaf.team === team.id && handleOf(leaf) === req.worker
      }) ||
      null
    if (!r) return answerNow(team, req, from, false, `${req.worker} is not a worker of your team (see team_worker_list).`) // i18n-ignore
    if (!mayControl(team, from, r)) return answerNow(team, req, from, false, `${req.worker} is not your worker: only its coordinator (or the lead) can read it.`) // i18n-ignore
    const lines = req.lines || 60
    const hb = () => (r.heartbeatAt ? ` Last heartbeat ${Math.round((now() - r.heartbeatAt) / 60000)} min ago${r.phase ? ` (${r.phase})` : ''}.` : ' No heartbeat yet.') // i18n-ignore
    if (r.chat) {
      // A chat has no screen: its conversation, as text (chatTranscript.js).
      const read = r.paneId ? Promise.resolve(deps.readChat(r.paneId, lines)).catch(() => null) : Promise.resolve(null)
      return read.then((text) => {
        // Checked again after the wait: still its coordinator's to read.
        if (!mayControl(team, from, r)) return answerNow(team, req, from, false, `${req.worker} is not your worker: only its coordinator (or the lead) can read it.`) // i18n-ignore
        if (text == null) return answerNow(team, req, from, false, `${req.worker}'s chat is not open.`) // i18n-ignore
        const tail = outputTail(text, lines)
        answerNow(team, req, from, true, `${req.worker} "${r.title}" is ${r.status}.${hb()} Its conversation now:\n${tail || '(empty)'}`) // i18n-ignore
      })
    }
    const screen = r.paneId ? deps.readScreen(r.paneId, lines) : null
    if (screen == null) return answerNow(team, req, from, false, `${req.worker}'s terminal is not open (its pane was closed or is asleep).`) // i18n-ignore
    const tail = outputTail(screen, lines)
    answerNow(team, req, from, true, `${req.worker} "${r.title}" is ${r.status}.${hb()} Its screen now:\n${tail || '(empty)'}`) // i18n-ignore
  }

  function doneRequest(team, from, req) {
    const r = records(team).find((x) => x.paneId === from.id && WORKER_ACTIVE.includes(x.status))
    if (!r) {
      deps.notice([from], '[Tessel] team_worker_done is for workers: you are not one now. Finish your card with team_task_done instead.', team.id)
      return
    }
    r.status = req.outcome === 'failed' ? 'failed' : 'done'
    r.endedAt = now()
    r.reason = req.outcome
    // It reported: a later silence starts a fresh reminder.
    r.reminded = false
    r.silentTold = false
    if (r.taskId) deps.reportCard(r.taskId, { outcome: req.outcome, summary: req.summary, files: req.files || [] }, from, team.id)
    pump()
  }

  function heartbeatRequest(team, from, req) {
    const r = records(team).find((x) => x.paneId === from.id && WORKER_ACTIVE.includes(x.status))
    if (!r) return
    r.heartbeatAt = now()
    r.phase = req.phase || r.phase || null
    r.note = req.note || ''
    r.staleTold = false
    // A sign of life: the no-report reminder may come again after a later turn.
    r.reminded = false
    r.silentTold = false
  }

  // --- Ending and starting ----------------------------------------------------
  // A worker ends: its pane (if any) is closed the normal way, its slot freed.
  function endWorker(team, r, status, reason, by = null, { byUser = false } = {}) {
    const was = r.status
    r.status = status
    r.endedAt = now()
    r.reason = reason
    if (WORKER_WAITING.includes(was)) {
      // Never started: its waiting card goes.
      if (r.taskId) deps.removeCard(r.taskId)
    } else if (r.paneId && deps.findLeaf(r.paneId)) deps.closePane(r.paneId, { byUser })
    deps.activity({
      type: 'task',
      action: status === 'refused' ? 'worker-refused' : 'worker-stopped',
      paneId: r.paneId || r.by,
      title: r.title,
      wsId: r.wsId,
      by: by ? deps.label(by) : null,
      detail: reason
    })
  }

  const contextKey = (c) => (c ? [c.wsId, c.cwd, c.remote ? 'remote' : 'local', c.coordinatorId, c.role, c.coordDepth].join('\n') : '')

  // May this request start now, as it was approved? Checked when it leaves
  // the queue and again after every wait while it starts: the coordinator
  // still in the team with the same role, the depth allowed, the same
  // project (workspace, folder, local), the agent available, and a proof of
  // approval that still counts (confirmation on: only the user's Allow for
  // this very context). -> { ok, coord, ws, agent } | { confirm: true } |
  // { error }.
  function validate(team, r) {
    const c = r.context
    if (!c) return { error: 'it was asked before an update of Tessel: ask again' } // i18n-ignore
    const coord = deps.findLeaf(r.by)
    if (!coord) return { error: 'its coordinator was closed' } // i18n-ignore
    if (coord.team !== team.id) return { error: 'its coordinator left the team' } // i18n-ignore
    const depth = depthOf(team, r.by)
    if (depth == null) return { error: 'its coordinator no longer leads (nor is a running worker)' } // i18n-ignore
    if ((depth === 0 ? 'lead' : 'worker') !== c.role || depth !== c.coordDepth) return { error: "its coordinator's role changed since it was asked" } // i18n-ignore
    const lim = limits()
    if (depth + 1 > lim.maxDepth) return { error: depthExceededMessage(depth + 1, lim.maxDepth) }
    const ws = deps.wsOfLeaf(r.by)
    if (!ws || ws.remote || ws.id !== c.wsId || ws.cwd !== c.cwd || !!ws.remote !== c.remote) return { error: 'the project changed since it was asked' } // i18n-ignore
    const agent = deps.agentAvailable(r.agent)
    if (!agent) return { error: `the agent "${r.agent}" is not available` } // i18n-ignore
    const proof = r.approval
    if (!proof || proof.context !== contextKey(c) || (lim.confirm && proof.by !== 'user')) return { confirm: true }
    return { ok: true, coord, ws, agent }
  }

  // Start what can start now, for every team at once: slots per
  // coordinator, the global cap (reserved as soon as one is starting), the
  // cards before them done; each checked again as it leaves the queue.
  function pump() {
    let total = activeTotal()
    for (const tm of allTeams()) {
      const ready = workersToStart(records(tm), {
        isDone: (id) => deps.cardColumn(id) === 'done',
        maxConcurrent: limits().maxConcurrent,
        total
      })
      for (const r of ready) {
        const v = validate(tm, r)
        if (v.confirm) {
          // Confirmation is on now, or the approval was for another context.
          r.status = 'confirming'
          r.approval = null
          const coord = deps.findLeaf(r.by)
          if (coord) askUser(r, coord)
          tell(tm, r, true, `Worker request ${r.id} for "${r.title}" now waits for the user's confirmation.`) // i18n-ignore
          continue
        }
        if (v.error) {
          fail(tm, r, v.error)
          continue
        }
        r.status = 'starting'
        total++
        startingNow.add(r.id)
        startWorker(tm, r)
          .catch((err) => fail(tm, r, (err && err.message) || 'unknown error'))
          .finally(() => startingNow.delete(r.id))
      }
    }
  }

  function fail(team, r, why) {
    if (WORKER_ENDED.includes(r.status)) return
    r.status = 'failed'
    r.endedAt = now()
    r.reason = why
    if (r.taskId && deps.cardColumn(r.taskId) != null) deps.updateCard(r.taskId, { column: 'todo' })
    deps.activity({ type: 'task', action: 'worker-failed', paneId: r.by, title: r.title, wsId: r.wsId, detail: why })
    tell(team, r, false, `Worker "${r.title}" was not started: ${why}.`) // i18n-ignore
    deps.toast(t('tasks.orch.failed', 'The worker for "{{title}}" was not started: {{why}}', { title: r.title, why }), { kind: 'error', timeout: 9000 })
  }

  // After a wait: still allowed (see validate)? Else it ends here; a pane
  // it opened is closed (a copy it made is kept, said in the reason).
  function stillValid(team, r, leaf, worktree) {
    if (r.status !== 'starting' && r.status !== 'running') {
      if (leaf) deps.closePane(leaf.id, { byUser: false })
      return false
    }
    const v = validate(team, r)
    if (v.ok) return true
    if (leaf) deps.closePane(leaf.id, { byUser: false })
    const why = v.confirm ? 'its approval no longer holds' : v.error // i18n-ignore
    fail(team, r, worktree ? `${why} (its copy ${worktree.path} is kept)` : why) // i18n-ignore
    return false
  }

  async function startWorker(team, r) {
    const v = validate(team, r)
    if (!v.ok) return fail(team, r, v.confirm ? 'its approval no longer holds' : v.error) // i18n-ignore
    const { coord, ws, agent } = v
    let worktree = null
    if (r.isolation === 'worktree') {
      const res = await deps.createWorktree(ws, r.title)
      if (!stillValid(team, r, null, res && res.worktree)) return
      if (!res || res.error || !res.worktree) return fail(team, r, `its own copy could not be made (${(res && res.error) || 'unknown error'})`) // i18n-ignore
      worktree = res.worktree
      r.branch = worktree.branch || null
    }
    const chat = chatMode(r)
    let leaf
    if (chat) {
      // A chat worker: no command line; its first prompt is its first turn.
      r.chat = true
      const res = await deps.openWorkerChat({ ws, agent, worktree, model: r.model, effort: r.effort, coordinator: coord })
      if (!res || res.error || !res.id) return fail(team, r, `its chat could not start (${(res && res.error) || 'unknown error'})`) // i18n-ignore
      leaf = res
    } else {
      leaf = await deps.openWorkerPane({
        ws,
        agent,
        worktree,
        launchOptions: { model: r.model, effort: r.effort, initialPrompt: WORKER_START_PROMPT }
      })
      if (!leaf) return fail(team, r, 'its pane could not be opened') // i18n-ignore
    }
    if (!stillValid(team, r, leaf, worktree)) return
    r.paneId = leaf.id
    r.status = 'running'
    r.startedAt = now()
    if (r.taskId) deps.updateCard(r.taskId, { paneId: leaf.id, column: 'doing', ...(worktree ? { worktree } : {}) })
    await deps.joinTeam(leaf, team)
    if (!stillValid(team, r, leaf, worktree)) return
    if (chat) {
      // Sent at once (a user turn); the brief below follows as a team turn.
      let sent
      try {
        sent = await deps.sendChatTurn(leaf.id, WORKER_START_PROMPT)
      } catch (err) {
        sent = { ok: false, error: (err && err.message) || 'unknown error' } // i18n-ignore
      }
      if (sent && sent.ok === false) {
        deps.closePane(leaf.id, { byUser: false })
        return fail(team, r, `its chat could not start (${sent.error || 'its first message was not sent'})`) // i18n-ignore
      }
      if (!stillValid(team, r, leaf, worktree)) return
    }
    const lim = limits()
    const handle = handleOf(leaf) || deps.label(leaf)
    deps.notice(
      [leaf],
      workerPreamble({
        workerHandle: `${handle} ${leaf.title || ''}`.trim(),
        coordinatorHandle: deps.label(coord),
        taskId: r.taskId,
        dispatchId: r.id,
        title: r.title,
        brief: r.brief,
        teamName: team.name,
        where: worktree,
        projectDir: ws.cwd,
        canDispatch: r.depth < lim.maxDepth
      }),
      team.id
    )
    deps.activity({
      type: 'task',
      action: 'worker-started',
      paneId: leaf.id,
      title: r.title,
      wsId: r.wsId,
      by: deps.label(coord),
      branch: r.branch || null,
      detail: r.model ? `${r.agent} · ${r.model}` : r.agent
    })
    tell(
      team,
      r,
      true,
      `Started worker ${handle} (${r.agent}) on card ${r.taskId} "${r.title}"${r.branch ? `, branch ${r.branch}` : ''}. It reports with team_worker_done; follow it with team_worker_list or team_worker_read ${handle}.` // i18n-ignore
    )
  }

  // --- Chat workers' turns ------------------------------------------------------
  // App calls it on each turnEnd of a chat pane ({ status: 'completed' |
  // 'interrupted' | 'failed', error }). Judged in tick once TURN_END_GRACE_MS
  // passed, so a team_worker_done sent at the end of that turn counts.
  function chatTurnEnded(paneId, { status, error } = {}) {
    for (const team of allTeams()) {
      const r = records(team).find((x) => x.paneId === paneId && x.chat && x.status === 'running')
      if (!r) continue
      r.lastTurnAt = now()
      // Interrupted: by the user or a stop; nothing to tell.
      if (status !== 'completed' && status !== 'failed') return
      if (!Array.isArray(r.turnEnds)) r.turnEnds = []
      if (r.turnEnds.length < 10) r.turnEnds.push({ status, error: error ? String(error).slice(0, 500) : '', at: now() })
      return
    }
  }

  // A failed turn: its coordinator told (once per error). A turn ended with
  // no report: one reminder to the worker, then its coordinator told once;
  // never more (no loop).
  function settleTurnEnds(team, r) {
    if (!Array.isArray(r.turnEnds) || !r.turnEnds.length) return
    if (r.status !== 'running') {
      r.turnEnds = []
      return
    }
    const leaf = deps.findLeaf(r.paneId)
    const h = handleOf(leaf)
    const who = `Worker ${h ? `${h} ` : ''}"${r.title}" (card ${r.taskId})` // i18n-ignore
    while (r.turnEnds.length && now() - r.turnEnds[0].at >= TURN_END_GRACE_MS) {
      const end = r.turnEnds.shift()
      if (end.status === 'failed') {
        const why = end.error || 'no reason given' // i18n-ignore
        // The same error with other ids, numbers or times is the same error;
        // and never more than FAIL_NOTICES_MAX notices per window (no loop).
        const key = failureKey(why)
        const told = r.failsTold || (r.failsTold = [])
        if (told.includes(key)) continue
        const at = now()
        const recent = (r.failNoticesAt = (r.failNoticesAt || []).filter((x) => at - x < FAIL_NOTICES_WINDOW_MS))
        if (recent.length >= FAIL_NOTICES_MAX) continue
        recent.push(at)
        told.push(key)
        if (told.length > 10) told.shift()
        tell(team, r, false, `${who}: its turn failed: ${why}.`) // i18n-ignore
        continue
      }
      // Working again (a message it got): that turn's end is the one to judge.
      if (deps.chatWorking && deps.chatWorking(r.paneId)) continue
      if (!r.reminded) {
        r.reminded = true
        if (leaf) deps.notice([leaf], CHAT_REMINDER, team.id)
      } else if (!r.silentTold) {
        r.silentTold = true
        tell(team, r, true, `${who} stopped without reporting, even after a reminder. Look at it (team_worker_read), ask it (team_ask), or stop it (team_worker_stop).`) // i18n-ignore
      }
    }
  }

  // A worker's last sign of life: its heartbeat (a chat's turn end too).
  const lastSign = (r) =>
    r.chat ? Math.max(r.heartbeatAt || 0, r.lastTurnAt || 0) || r.startedAt || now() : r.heartbeatAt || r.startedAt || now()
  // A chat at work is never "silent"; one already told as silent, not twice.
  const chatBusyOrTold = (r) => !!r.silentTold || !!(deps.chatWorking && deps.chatWorking(r.paneId))

  // --- Every round (App's team loop) ---------------------------------------------
  // Closed workers, silent ones, coordinators gone; then the queue; then the
  // list the tools read.
  function tick(team) {
    const list = records(team)
    for (const r of list) {
      // A worker moved to another team (or out of any): no longer this
      // coordinator's; it stays open where it is.
      if (WORKER_ACTIVE.includes(r.status) && r.paneId) {
        const leaf = deps.findLeaf(r.paneId)
        if (leaf && leaf.team !== team.id) {
          r.status = 'released'
          r.endedAt = now()
          r.reason = 'it left the team' // i18n-ignore
          deps.activity({ type: 'task', action: 'worker-released', paneId: r.paneId, title: r.title, wsId: r.wsId, detail: r.reason })
          tell(team, r, false, `Worker "${r.title}" (card ${r.taskId}) left your team: it is no longer your worker.`) // i18n-ignore
          continue
        }
      }
      // Tessel stopped while it was starting one: running if its pane is
      // there, else back in the queue.
      if (r.status === 'starting' && !startingNow.has(r.id)) {
        if (r.paneId && deps.findLeaf(r.paneId)) {
          r.status = 'running'
          r.startedAt = r.startedAt || now()
        } else r.status = 'queued'
      }
      if (r.status === 'running' && !deps.findLeaf(r.paneId)) {
        r.status = 'stopped'
        r.endedAt = now()
        r.reason = r.userStop ? 'stopped by the user' : 'its pane was closed' // i18n-ignore
        deps.activity({ type: 'task', action: 'worker-stopped', paneId: r.paneId, title: r.title, wsId: r.wsId, detail: r.reason })
        tell(team, r, false, `Worker "${r.title}" (card ${r.taskId}) ended before it reported: ${r.reason}.`) // i18n-ignore
        continue
      }
      if (r.chat) settleTurnEnds(team, r)
      if (r.status === 'running' && !r.staleTold && now() - lastSign(r) > STALE_MS && !(r.chat && chatBusyOrTold(r))) {
        r.staleTold = true
        const leaf = deps.findLeaf(r.paneId)
        tell(
          team,
          r,
          true,
          `Worker ${handleOf(leaf) || ''} "${r.title}" sent no heartbeat for ${Math.round(STALE_MS / 60000)} minutes. Look at it (team_worker_read), ask it (team_ask), or stop it (team_worker_stop).` // i18n-ignore
        )
      }
      if (WORKER_WAITING.includes(r.status)) {
        const coord = deps.findLeaf(r.by)
        if (!coord || coord.team !== team.id) endWorker(team, r, 'stopped', 'its coordinator was closed or left the team') // i18n-ignore
      }
    }
    pump()
    publish(team)
  }

  function phases(team) {
    const by = {}
    for (const r of records(team)) (by[r.by] = by[r.by] || []).push(r)
    const out = {}
    for (const [id, list] of Object.entries(by)) {
      const h = handleOf(deps.findLeaf(id))
      if (h) out[h] = coordinatorPhase(list, (c) => deps.cardColumn(c))
    }
    return out
  }

  function publish(team) {
    const lim = limits()
    deps.publish(team, {
      workers: records(team).map((r) => ({
        id: r.id,
        handle: r.paneId ? handleOf(deps.findLeaf(r.paneId)) : null,
        coordinator: handleOf(deps.findLeaf(r.by)),
        title: r.title,
        card: r.taskId,
        agent: r.agent,
        status: r.status,
        isolation: r.isolation,
        branch: r.branch || null,
        depth: r.depth,
        startedAt: r.startedAt,
        heartbeatAt: r.heartbeatAt || null,
        phase: r.phase || null,
        note: r.note || null,
        ...(r.chat ? { chat: true } : {})
      })),
      limits: lim,
      phases: phases(team)
    })
  }

  // --- The user's side (Tasks panel) ------------------------------------------------
  function allow(team, id) {
    const r = records(team).find((x) => x.id === id && x.status === 'confirming')
    if (!r) return false
    // The user's Allow: the proof, for the context shown when it was asked.
    r.approval = { by: 'user', at: now(), context: contextKey(r.context) }
    r.status = 'queued'
    deps.activity({ type: 'task', action: 'worker-allowed', paneId: r.by, title: r.title, wsId: r.wsId })
    pump()
    if (r.status === 'queued') tell(team, r, true, queuedText(team, r))
    return true
  }
  function refuse(team, id) {
    const r = records(team).find((x) => x.id === id && x.status === 'confirming')
    if (!r) return false
    endWorker(team, r, 'refused', 'refused by the user') // i18n-ignore
    tell(team, r, false, `The user refused to start the worker for "${r.title}". Do this work yourself or ask the user.`) // i18n-ignore
    return true
  }
  // The user stops a worker (its pane closes the usual way, asked first when
  // Settings say so) or cancels one still waiting.
  function stopByUser(team, id) {
    const r = records(team).find((x) => x.id === id && !WORKER_ENDED.includes(x.status))
    if (!r) return false
    if (WORKER_ACTIVE.includes(r.status) && r.paneId && deps.findLeaf(r.paneId)) {
      // Closed by the user's own close flow; the next round sees it gone.
      r.userStop = true
      deps.closePane(r.paneId, { byUser: true })
      return true
    }
    endWorker(team, r, 'stopped', 'cancelled by the user') // i18n-ignore
    tell(team, r, false, `The user cancelled the worker for "${r.title}".`) // i18n-ignore
    return true
  }

  // What the Tasks panel shows for a workspace: each team with workers.
  function summary(team) {
    const list = records(team)
    const lim = limits()
    const coords = [...new Set(list.map((r) => r.by))]
    return {
      teamId: team.id,
      name: team.name,
      color: team.color,
      limits: lim,
      coordinators: coords.map((id) => ({
        id,
        label: labelOf(id),
        phase: coordinatorPhase(
          list.filter((r) => r.by === id),
          (c) => deps.cardColumn(c)
        )
      })),
      workers: list.map((r) => {
        const leaf = r.paneId ? deps.findLeaf(r.paneId) : null
        return {
          id: r.id,
          title: r.title,
          agent: r.agent,
          status: r.status,
          isolation: r.isolation,
          branch: r.branch || null,
          model: r.model || null,
          paneId: leaf ? leaf.id : null,
          label: leaf ? deps.label(leaf) : null,
          by: r.by,
          byLabel: labelOf(r.by),
          taskId: r.taskId,
          heartbeatAt: r.heartbeatAt || null,
          phase: r.phase || null,
          reason: r.reason || null,
          requestedAt: r.requestedAt,
          ...(r.chat ? { chat: true } : {})
        }
      }),
      running: list.filter((r) => WORKER_ACTIVE.includes(r.status)).length,
      waiting: list.filter((r) => WORKER_WAITING.includes(r.status)).length
    }
  }

  // A pane that is a worker: { coordinatorId, status, taskId } or null.
  function workerInfo(team, paneId) {
    const r = team ? recordOfPane(team, paneId) : null
    if (!r || !(WORKER_ACTIVE.includes(r.status) || ['done', 'failed'].includes(r.status))) return null
    return { coordinatorId: r.by, status: r.status, taskId: r.taskId, depth: r.depth }
  }

  return { handleRequest, tick, allow, refuse, stopByUser, summary, workerInfo, depthOf, limits, chatTurnEnded }
}
