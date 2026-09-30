// Orchestration: a coordinator agent (a team's lead) starts workers in new
// panes through the team tools (teamMcp/server.cjs: team_worker_start, ...),
// Tessel's take on Orca's coordinator and workers (MIT, Copyright (c) 2026
// Lovecast Inc.: src/main/runtime/orchestration/coordinator.ts, preamble.ts,
// src/shared/nested-worker-depth.ts). Differences, the Tessel way: the lead
// agent is the coordinator (no separate loop decomposes the work); workers
// hear from it through the team tools in the background, never by text
// typed into their terminals; the user confirms each start (a setting).
//
// Pure functions shared by the renderer (App.vue), the main process
// (teamTasks.js validates the requests) and the tests. Text sent to agents
// stays English.

import { validAgentName } from './agentNames'
import { sessionOptionLaunchText } from './agentSessionOptions'

// Agents that can be started as workers: their CLI takes a first prompt on
// its command line (see workerLaunchArgs), so nothing is typed into them.
export const WORKER_AGENTS = ['claude', 'codex', 'gemini', 'qwen']

// Settings > Orchestration (Orca's defaults: 4 at a time, depth 1).
export const MAX_CONCURRENT_DEFAULT = 4
export const MAX_CONCURRENT_LIMIT = 8
export const NESTED_DEPTH_DEFAULT = 1
export const NESTED_DEPTH_LIMIT = 3
// Every worker of every coordinator, at most, whatever the settings say.
export const TOTAL_WORKERS_LIMIT = 12
// Starts asked by one coordinator in 10 minutes (confirmed or not).
export const START_RATE = { max: 8, perMs: 10 * 60 * 1000 }
// Orca's cadence: a heartbeat every 5 minutes; none for 10: said to its
// coordinator once.
export const HEARTBEAT_MIN = 5
export const STALE_MS = 10 * 60 * 1000

export const ISOLATIONS = ['worktree', 'project']
export const HEARTBEAT_PHASES = ['investigating', 'implementing', 'reviewing', 'waiting']
// A worker's life: asked, waiting for the user (confirming) or for a slot or
// the cards before it (queued), starting, running, then one end.
export const WORKER_ACTIVE = ['starting', 'running']
export const WORKER_WAITING = ['confirming', 'queued']
export const WORKER_ENDED = ['done', 'failed', 'stopped', 'released', 'refused']

const MAX_TITLE = 200
const MAX_BRIEF = 4000
const CARD_ID = /^(?!\.)(?!.*\.\.)[A-Za-z0-9._-]{1,100}$/
const REQUEST_ID = /^r-[A-Za-z0-9_-]{4,60}$/

function clampInt(v, lo, hi, def) {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= lo ? Math.min(hi, v) : def
}
// A malformed setting falls back to the default, never to "no limit".
export function resolveMaxConcurrent(v) {
  return clampInt(v, 1, MAX_CONCURRENT_LIMIT, MAX_CONCURRENT_DEFAULT)
}
export function resolveMaxDepth(v) {
  return clampInt(v, 1, NESTED_DEPTH_LIMIT, NESTED_DEPTH_DEFAULT)
}

// Orca's refusal (nestedWorkerDepthExceededMessage): "do it yourself", so a
// worker does not loop on a capability it will never get.
export function depthExceededMessage(childDepth, maxDepth) {
  return (
    `Starting a worker is not permitted at depth ${childDepth} (max ${maxDepth}). ` +
    'Complete this task yourself. (The user can allow deeper nesting in Tessel: Settings > Orchestration.)'
  )
}

const str = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '')
const handle = (v) => {
  const m = /^#?(\d{1,3})$/.exec(String(v == null ? '' : v).trim())
  return m ? `#${m[1]}` : validAgentName(v) ? v.trim() : null
}
// A model or effort name for a command line: plain words only.
const flagValue = (v) => (typeof v === 'string' && /^[A-Za-z0-9._:\[\]-]{1,60}$/.test(v.trim()) ? v.trim() : null)

// The orchestration requests (an agent's request file, read by Tessel's main
// process): -> the request, normalized, or { error }. null: not one of them.
export function parseWorkerRequest(data) {
  if (!data || typeof data !== 'object') return null
  const rid = typeof data.rid === 'string' && REQUEST_ID.test(data.rid) ? data.rid : null
  const withRid = (r) => (rid ? { ...r, rid } : r)
  switch (data.action) {
    case 'worker-start': {
      const agent = String(data.agent || '').trim().toLowerCase()
      if (!WORKER_AGENTS.includes(agent)) return { error: `"agent" must be one of ${WORKER_AGENTS.join(', ')}` }
      const title = str(data.title, MAX_TITLE + 1)
      if (!title) return { error: 'a worker needs a task "title"' }
      if (title.length > MAX_TITLE) return { error: `the title is too long (at most ${MAX_TITLE} characters)` }
      const brief = typeof data.brief === 'string' ? data.brief.trim() : ''
      if (!brief) return { error: 'a worker needs a "brief": what to do, where, how to check it' }
      if (brief.length > MAX_BRIEF) return { error: `the brief is too long (at most ${MAX_BRIEF} characters)` }
      const isolation = data.isolation == null || data.isolation === '' ? 'worktree' : String(data.isolation).toLowerCase()
      if (!ISOLATIONS.includes(isolation)) return { error: '"isolation" must be "worktree" or "project"' }
      if (data.model != null && data.model !== '' && !flagValue(data.model)) return { error: '"model" must be a plain model name' }
      if (data.effort != null && data.effort !== '' && !flagValue(data.effort)) return { error: '"effort" must be a plain word like "high"' }
      const deps = Array.isArray(data.deps) ? data.deps : []
      if (deps.length > 10 || deps.some((d) => typeof d !== 'string' || !CARD_ID.test(d))) return { error: '"after" must be up to 10 card ids' }
      return withRid({
        action: 'worker-start',
        agent,
        title,
        brief,
        isolation,
        model: flagValue(data.model),
        effort: flagValue(data.effort),
        ...(deps.length ? { deps: [...new Set(deps)] } : {})
      })
    }
    case 'worker-stop':
    case 'worker-release':
    case 'worker-read': {
      const all = data.action === 'worker-stop' && String(data.worker || '').trim().toLowerCase() === 'all'
      const worker = all ? 'all' : handle(data.worker)
      if (!worker) return { error: '"worker" must be a worker like "Ada"' }
      const out = { action: data.action, worker }
      if (data.action === 'worker-stop') out.reason = str(data.reason, 300)
      if (data.action === 'worker-read') out.lines = clampInt(Number(data.lines), 1, 200, 60)
      return withRid(out)
    }
    case 'worker-done': {
      const outcome = data.outcome === 'failed' ? 'failed' : data.outcome === 'succeeded' || data.outcome == null ? 'succeeded' : null
      if (!outcome) return { error: 'the outcome must be "succeeded" or "failed"' }
      const summary = typeof data.summary === 'string' ? data.summary.trim() : ''
      if (!summary || summary.length > 2000) return { error: 'worker_done needs a summary of at most 2000 characters' }
      const files = Array.isArray(data.files) ? data.files.filter((f) => typeof f === 'string' && f.trim() && f.length <= 300).slice(0, 50) : []
      return withRid({ action: 'worker-done', outcome, summary, files })
    }
    case 'heartbeat': {
      const phase = data.phase == null || data.phase === '' ? null : String(data.phase).toLowerCase()
      if (phase !== null && !HEARTBEAT_PHASES.includes(phase)) return { error: `"phase" must be one of ${HEARTBEAT_PHASES.join(', ')}` }
      return withRid({ action: 'heartbeat', phase, note: str(data.note, 200) })
    }
    default:
      return null
  }
}

// May this coordinator start one more worker now?
//   depth: the coordinator's own (0 for the lead, a worker's depth, null for
//     an agent that coordinates nothing), maxDepth, running (its workers
//     starting or running), total (every active worker), maxConcurrent,
//     recent (its start times), now.
// -> { ok: true, queue: bool } (queue: no slot now, it waits) or { error }.
export function decideWorkerStart({ depth, maxDepth, running, total, maxConcurrent, recent = [], now = Date.now() }) {
  if (depth == null) return { error: 'Only the team lead (or a worker allowed to nest) can start workers. Ask your lead instead.' }
  const childDepth = depth + 1
  if (childDepth > resolveMaxDepth(maxDepth)) return { error: depthExceededMessage(childDepth, resolveMaxDepth(maxDepth)) }
  const lately = recent.filter((t) => now - t < START_RATE.perMs).length
  if (lately >= START_RATE.max)
    return { error: `Too many workers asked in the last 10 minutes (${lately}, at most ${START_RATE.max}). Wait, or give the work to workers you already have.` }
  const queue = running >= resolveMaxConcurrent(maxConcurrent) || total >= TOTAL_WORKERS_LIMIT
  return { ok: true, queue, depth: childDepth }
}

// Which queued workers can start now, in the order they were asked: those
// whose cards before them are done, while their coordinator has a slot.
//   records: [{ id, by, status, deps }], isDone(cardId), maxConcurrent,
//   total (active workers now).
export function workersToStart(records, { isDone = () => true, maxConcurrent, total = 0 } = {}) {
  const max = resolveMaxConcurrent(maxConcurrent)
  const running = {}
  for (const r of records) if (WORKER_ACTIVE.includes(r.status)) running[r.by] = (running[r.by] || 0) + 1
  const out = []
  let all = total
  for (const r of records) {
    if (r.status !== 'queued') continue
    if ((r.deps || []).some((d) => !isDone(d))) continue
    if ((running[r.by] || 0) >= max || all >= TOTAL_WORKERS_LIMIT) continue
    running[r.by] = (running[r.by] || 0) + 1
    all++
    out.push(r)
  }
  return out
}

// Orca's coordinator phases, read from a coordinator's workers and their
// cards (Tessel's lead decides the work itself, so the phase is shown, not
// driven): decomposing (no worker yet), dispatching (some wait to start),
// monitoring (some run), merging (all ended, cards to review), done.
//   records: its workers; cardColumn(cardId) -> column or null.
export function coordinatorPhase(records, cardColumn = () => null) {
  const mine = records.filter((r) => r.status !== 'refused')
  if (!mine.length) return 'decomposing'
  if (mine.some((r) => WORKER_WAITING.includes(r.status) || r.status === 'starting')) return 'dispatching'
  if (mine.some((r) => r.status === 'running')) return 'monitoring'
  const cols = mine.map((r) => (r.taskId ? cardColumn(r.taskId) : null)).filter(Boolean)
  if (cols.some((c) => c !== 'done')) return 'merging'
  return 'done'
}

// The first prompt a worker starts with: fixed, plain words only (safe in
// PowerShell, cmd and POSIX shells between double quotes). Its brief waits
// in team_inbox (a background notice), never typed.
export const WORKER_START_PROMPT =
  'You are a Tessel worker. Call the team_inbox tool now: your worker brief and task are there. Follow it.'

// The single place where a worker's launch options become command-line
// arguments: { model, effort, initialPrompt } -> ' arg arg' ('' when none).
// model and effort: the agent's own flags from its model catalog
// (agentSessionOptions.js, Orca's): --model/--effort for Claude Code,
// -m/-c model_reasoning_effort= for Codex...; none for an agent without a
// catalog, none when the user's own arguments (ownArgs, Settings > Agents)
// set them, none for an id a shell could misread. models: the list the
// model was picked from (the CLI's own listing).
export function workerLaunchArgs(agentId, launchOptions, { ownArgs = '', models = null } = {}) {
  const o = launchOptions || {}
  const args = []
  const model = typeof o.model === 'string' ? o.model.trim() : ''
  if (model) {
    const values = { model, ...(typeof o.effort === 'string' && o.effort.trim() ? { effort: o.effort.trim() } : {}) }
    const flags = sessionOptionLaunchText(agentId, values, ownArgs, models)
    if (flags) args.push(flags)
  }
  const prompt = typeof o.initialPrompt === 'string' ? o.initialPrompt : ''
  if (prompt) {
    // Anything but plain words is refused, never quoted by guesswork.
    if (!/^[A-Za-z0-9 .,:_-]{1,300}$/.test(prompt)) return ''
    if (agentId === 'claude' || agentId === 'codex') args.push(`"${prompt}"`)
    else if (agentId === 'gemini' || agentId === 'qwen') args.push(`-i "${prompt}"`)
  }
  return args.length ? ` ${args.join(' ')}` : ''
}

// The first prompt Tessel gives an agent it launches or relaunches itself
// (resumed in place, restarted for the team tools or after an update, a dead
// pane resumed when Tessel starts) while team messages wait for it: nothing
// is typed, it is on the command line. Fixed, plain words only.
export const WAKE_LAUNCH_PROMPT = 'Tessel: you have team messages waiting. Read them with team_inbox, then continue.' // i18n-ignore

// The launch prompt's arguments: ' "prompt"' when `waiting` > 0 and the
// agent's CLI takes a first prompt that starts a turn, fresh and resumed
// alike; '' otherwise (never when nothing waits). Checked with the CLIs:
// Codex takes it as its positional prompt both ways (`codex [OPTIONS]
// [PROMPT]`, `codex resume [OPTIONS] [SESSION_ID] [PROMPT]`). The others are
// left out: Claude Code has its own inbox for this, and Gemini CLI (-i),
// Qwen Code and OpenCode (--prompt) are not known to take one with their
// resume flag.
export function wakeLaunchArgs(agentId, waiting) {
  if (!(Number(waiting) > 0)) return ''
  if (agentId === 'codex') return ` "${WAKE_LAUNCH_PROMPT}"`
  return ''
}

// The last lines a terminal shows, for team_worker_read: no control codes,
// no trailing blanks, at most `lines` lines and 6000 characters.
export function outputTail(text, lines = 60) {
  const clean = String(text || '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ''))
  while (clean.length && !clean[clean.length - 1]) clean.pop()
  const out = clean.slice(-Math.max(1, Math.min(200, lines))).join('\n')
  return out.length > 6000 ? out.slice(-6000) : out
}

// Orca's dispatch preamble (preamble.ts), adapted: who the worker is, who
// its coordinator is, its card, and how to report through the team tools.
//   { workerHandle "#5", coordinatorHandle "#2 Claude Code", taskId,
//     dispatchId, title, brief, teamName, where: { path, branch, baseBranch }
//     (its own copy) or null (the project folder), projectDir, canDispatch }
export function workerPreamble(p) {
  const where = p.where
    ? `You work in your own copy of the project: ${p.where.path} (git branch ${p.where.branch}, made from ${p.where.baseBranch || 'the main branch'}). ` +
      'Commit your work on that branch. Do not merge it and do not push: your coordinator reviews it and the user merges it. ' +
      'If the project needs its dependencies installed, install them in this copy; never link them to another folder.'
    : `You work directly in the project folder ${p.projectDir || ''}. Other agents may work there too: check with your coordinator before editing files it did not give you.`
  const sub = p.canDispatch
    ? '\n\n=== SUB-WORKERS ===\nYou may start sub-workers for this task with team_worker_start. You own them: wait for their reports and settle them (team_worker_list, team_worker_stop) before you send your own worker_done. Nesting is capped: a sub-worker of yours may not be able to start more.'
    : ''
  return `[Tessel worker brief]
You are working inside Tessel. You are a worker started by your coordinator.
You are ${p.workerHandle}. Your coordinator is ${p.coordinatorHandle}${p.teamName ? `, in team "${p.teamName}"` : ''}.
Your task card is ${p.taskId}. Your dispatch id is ${p.dispatchId}.

Your coordinator cannot see this terminal: reach it only with the team tools below. A question or a result left only in this terminal never gets to it. Do not post to other channels during the work.

=== TEAM TOOLS ===
- team_worker_done {"outcome":"succeeded","summary":"...","files":[...]}: report the outcome, required, exactly once. The summary is 3 sentences: what you did, what you found, what is left. Use "failed" when the work is not done; never encode failure only in prose and never stop silently.
- team_heartbeat {"phase":"investigating|implementing|reviewing|waiting"}: every ${HEARTBEAT_MIN} minutes while you work, so your coordinator can tell "still thinking" from "stuck". Not needed while you wait inside team_ask.
- team_ask {"to":"${String(p.coordinatorHandle).split(' ')[0]}","question":"..."}: ask your coordinator and wait for the answer. Use it instead of asking in this terminal: nobody watches it.
- team_task_gate {"id":"${p.taskId}","question":"..."}: a decision only the user makes; the card waits for it.
- team_inbox: read your coordinator's follow-ups at each checkpoint (before a new file, after a test run) and once more right before worker_done.

=== WHERE ===
${where}${sub}

=== AFTER team_worker_done ===
worker_done ends your turn for this task: stop, return to an idle prompt, and take no further actions. Do not start new or unrelated work, and do not poll. A direct instruction from the user comes first: follow it as new work of the user's.

=== TASK: ${p.title} ===
${p.brief}`
}
