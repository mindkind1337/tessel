// Live Share phase 2b: what a guest sees of the host's panes and finished
// tasks beyond their screens, read only.
//
// - Each shared project's panes as the host's header and Dashboard show them
//   (the 'agents' topic, shareChannel.js): what runs in each (an agent, a chat,
//   a shell), its model and effort as its header says it, its state, the task
//   it works on, whether it waits for its person, when its usage limit
//   resets, its team, and the task copy it works in (by branch). The host's
//   window sends them as they change (liveShare:paneAgents); the guests' copy
//   is made here (guestPanes: the fields above, cut to the limits, every text
//   through guestText: what looks like a secret masked, paths outside the
//   project hidden) and pushed at most once a second per project
//   (createAgentsFeed), apart from the layouts, so a state change never sends
//   a layout again. What the host keeps for itself: a pane's conversation
//   (its agent, session and account), from which its sub-agents are read.
// - A pane's sub-agents ('agents.children', polled by the guest's header):
//   read on the host from that conversation (accountSessions.children), each
//   one's title through guestText, its id replaced by a short hash (the
//   session ids stay on the host).
// - The project's task history ('history.list'): the host's window sends the
//   records of each shared project's finished tasks (liveShare:history), the
//   newest 500; the guests' copy has their times and tokens, and the costs in
//   dollars only for a guest with the usage right ("See my usage"). Figures
//   the window has not read yet are read here (jobCost.forCards), at most
//   once every 30 s per project.
//
// - A task branch's review (shareRequests.js review.info and review.diff):
//   the cards' own copies stay on the host (hostTaskCopies, from the window's
//   board); the guest checks what comes (checkReviewInfo, checkReviewDiff).
//
// A guest's Tessel checks each copy again (checkPanes, checkChildren,
// checkHistory, checkUsage) before its window shows it.
import { createHash } from 'crypto'
import { guestText } from './shareChat.js'
import { isTaskId } from './shareTasks.js'
import { cleanRel } from '../../shared/liveSharePath'

export const PANE_LIMITS = Object.freeze({
  panes: 64, // a project's panes in the copy
  model: 80, // "Opus 4.7 · high"
  task: 300,
  reset: 40, // a usage limit's reset, as the header says it
  team: 60,
  branch: 200,
  children: 50, // a pane's sub-agents
  childTitle: 300,
  childType: 60,
  pushMs: 1000 // a project's panes go out at most this often
})
export const HISTORY_LIMITS = Object.freeze({
  records: 500,
  title: 300,
  agentName: 80,
  project: 120,
  periods: 50,
  models: 6,
  costTtlMs: 30 * 1000
})
// A task branch's review as a guest's Tessel takes it (shareRequests.js
// review.info and review.diff make it on the host).
export const REVIEW_LIMITS = Object.freeze({ files: 5000, commits: 200, body: 20000, diff: 2 * 1024 * 1024 })
// The ops of this file, for the host's server (shareHost.js opInfo): reading
// only. history.list reads figures on the host (jobCost.js): heavy.
export const PANEL_OPS = Object.freeze({
  'agents.children': Object.freeze({ right: 'view', kind: 'light', bulk: false }),
  'history.list': Object.freeze({ right: 'view', kind: 'heavy', bulk: true })
})

// What a pane is in, as Tessel's sidebar says it (sidebarModel.js paneDotState
// reads them): Tessel's own states, nothing else.
export const PANE_STATES = Object.freeze(['working', 'monitoring', 'approval', 'limited', 'waiting', 'ready', 'unknown', 'stopped', 'interrupted'])
const PANE_KINDS = ['agent', 'chat', 'shell']
const CHILD_STATES = ['running', 'quiet', 'done']
const COST_REASONS = ['no-session', 'missing-file', 'remote', 'unsupported-agent', 'invalid-session', 'no-pane', 'not-started', 'no-card', 'error']

const PANE_ID = /^[\w-]{1,80}$/
const AGENT_ID = /^[\w.-]{1,40}$/
const SESSION_ID = /^[\w.:-]{1,200}$/
const ACCOUNT_ID = /^[\w.-]{1,80}$/
// The SSH host a pane runs on (its sub-agents are read there: remoteAgentChildren.js).
const HOST_ID = /^[0-9A-Za-z_-]{1,100}$/
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v) => (typeof v === 'string' ? v : '')
// eslint-disable-next-line no-control-regex -- control characters are what it removes
const oneLine = (v, max) => str(v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
const time = (v) => (Number.isFinite(v) && v > 0 && v < 8.64e15 ? Math.round(v) : null)
const count = (v) => (Number.isFinite(v) && v >= 0 ? Math.min(Math.round(v), 1e15) : 0)
// A text of the host's as a guest may read it: one line, secrets masked,
// paths outside the project hidden (roots null: the guest's own check).
const text = (v, roots, max) => (roots ? oneLine(guestText(oneLine(v, max + 256), roots, max), max) : oneLine(v, max))

// --- Panes ---------------------------------------------------------------------
// One pane as the host's window sends it -> { pane (the guests' copy),
// children (where its sub-agents are read: host-only) } | null.
function hostPane(p, roots) {
  if (!isObj(p) || typeof p.id !== 'string' || !PANE_ID.test(p.id)) return null
  const pane = guestPane(p, roots)
  const c = isObj(p.children) ? p.children : null
  const children =
    pane.kind === 'agent' && c && AGENT_ID.test(str(c.agent)) && SESSION_ID.test(str(c.sessionId))
      ? { agent: c.agent, sessionId: c.sessionId, ...(c.accountId === null || (typeof c.accountId === 'string' && ACCOUNT_ID.test(c.accountId)) ? { accountId: c.accountId } : {}), ...(typeof c.remoteHostId === 'string' && HOST_ID.test(c.remoteHostId) ? { remoteHostId: c.remoteHostId } : {}) }
      : null
  pane.children = !!children
  return { pane, children }
}
// The fields a guest gets of a pane (roots: the project's folders; null on
// the guest's side).
function guestPane(p, roots) {
  const kind = PANE_KINDS.includes(p.kind) ? p.kind : 'shell'
  const agent = kind !== 'shell'
  const pane = {
    id: p.id,
    kind,
    agentId: typeof p.agentId === 'string' && AGENT_ID.test(p.agentId) ? p.agentId : null,
    model: agent ? text(p.model, roots, PANE_LIMITS.model) : '',
    state: agent && PANE_STATES.includes(p.state) ? p.state : null,
    sleeping: p.sleeping === true,
    since: time(p.since),
    task: agent ? text(p.task, roots, PANE_LIMITS.task) : '',
    attention: p.attention === true,
    reset: agent && p.state === 'limited' ? text(p.reset, roots, PANE_LIMITS.reset) : '',
    team: null,
    copy: null,
    children: p.children === true
  }
  if (isObj(p.team)) {
    const name = text(p.team.name, roots, PANE_LIMITS.team)
    if (name) pane.team = { name, lead: p.team.lead === true }
  }
  if (isObj(p.copy)) {
    const branch = text(p.copy.branch, roots, PANE_LIMITS.branch)
    if (branch) pane.copy = { branch }
  }
  return pane
}

// The window's panes of one project -> { panes (the guests' copy), children
// (pane id -> where its sub-agents are read, host-only) }. Only the panes
// that project shares (shared(id): its terminals and chat panes), the
// first PANE_LIMITS.panes.
export function guestPanes(list, roots = [], shared = () => true) {
  const panes = []
  const children = new Map()
  for (const p of Array.isArray(list) ? list : []) {
    if (panes.length >= PANE_LIMITS.panes) break
    const got = hostPane(p, roots)
    if (!got || panes.some((x) => x.id === got.pane.id) || !shared(got.pane.id)) continue
    panes.push(got.pane)
    if (got.children) children.set(got.pane.id, got.children)
  }
  return { panes, children }
}

// The host's copy, checked on the guest's side: the known fields, their
// shapes and limits. null when it is not a list of panes.
export function checkPanes(list) {
  if (!Array.isArray(list) || list.length > PANE_LIMITS.panes) return null
  const out = []
  for (const p of list) {
    if (!isObj(p) || typeof p.id !== 'string' || !PANE_ID.test(p.id) || out.some((x) => x.id === p.id)) continue
    out.push(guestPane(p, null))
  }
  return out
}

// A project's panes for its guests, at most once every everyMs per project:
// the latest goes when its time comes, the same copy twice never. push(
// project, data); current(project) for a guest that starts following.
export function createAgentsFeed({ push, clock = Date.now, timers = globalThis, everyMs = PANE_LIMITS.pushMs } = {}) {
  const projects = new Map() // project -> { data, json, at, timer, sent }
  function flush(project) {
    const e = projects.get(project)
    if (!e) return
    e.timer = null
    if (e.sent === e.json) return
    e.sent = e.json
    e.at = clock()
    push(project, e.data)
  }
  return {
    // A project's copy, as made now ({ panes }).
    set(project, data) {
      let json
      try {
        json = JSON.stringify(data)
      } catch {
        return
      }
      let e = projects.get(project)
      if (!e) projects.set(project, (e = { data: null, json: null, at: -Infinity, timer: null, sent: null }))
      if (e.json === json) return
      e.data = data
      e.json = json
      if (e.timer) return
      const wait = e.at + everyMs - clock()
      if (wait <= 0) flush(project)
      else {
        e.timer = timers.setTimeout(() => flush(project), wait)
        e.timer?.unref?.()
      }
    },
    current: (project) => projects.get(project)?.data || null,
    // A guest starts following: what there is now, at once.
    sendNow(project) {
      const e = projects.get(project)
      if (!e || !e.data) return
      if (e.timer) timers.clearTimeout(e.timer)
      e.timer = null
      e.sent = e.json
      e.at = clock()
      push(project, e.data)
    },
    drop(project) {
      const e = projects.get(project)
      if (e && e.timer) timers.clearTimeout(e.timer)
      projects.delete(project)
    },
    projects: () => [...projects.keys()],
    reset() {
      for (const e of projects.values()) if (e.timer) timers.clearTimeout(e.timer)
      projects.clear()
    }
  }
}

// --- Sub-agents ------------------------------------------------------------------
// A sub-agent's id on the host (a tool call's, a session's) -> a short hash
// that names it for the guest's list, never the id.
const childKey = (id) => createHash('sha256').update(String(id)).digest('hex').slice(0, 16)

// The host's list (agentChildren.js rows) -> the guests' copy.
export function guestChildren(list, roots = []) {
  const out = []
  for (const c of Array.isArray(list) ? list : []) {
    if (out.length >= PANE_LIMITS.children) break
    if (!isObj(c) || (typeof c.id !== 'string' && !Number.isFinite(c.id))) continue
    out.push(childRow(c, roots, childKey(c.id)))
  }
  return out
}
function childRow(c, roots, id) {
  return {
    id,
    title: text(c.title, roots, PANE_LIMITS.childTitle),
    type: text(c.type, roots, PANE_LIMITS.childType),
    model: text(c.model, roots, PANE_LIMITS.model),
    effort: text(c.effort, roots, 20),
    state: CHILD_STATES.includes(c.state) ? c.state : 'done',
    background: c.background === true,
    startedAt: time(c.startedAt),
    endedAt: time(c.endedAt),
    lastAt: time(c.lastAt),
    tokens: Number.isFinite(c.tokens) && c.tokens >= 0 ? count(c.tokens) : null
  }
}
// The guest's check of the host's list.
export function checkChildren(list) {
  if (!Array.isArray(list) || list.length > PANE_LIMITS.children) return null
  const out = []
  for (const c of list) {
    if (!isObj(c) || typeof c.id !== 'string' || !/^[0-9a-f]{16}$/.test(c.id) || out.some((x) => x.id === c.id)) continue
    out.push(childRow(c, null, c.id))
  }
  return out
}

// --- Task history ---------------------------------------------------------------
// One record's figures as a guest may read them (usd: the costs in dollars
// too, for a guest with the usage right).
function guestCost(c, usd, roots) {
  if (!isObj(c)) return null
  const tokens = (m) => ({ inputTokens: count(m.inputTokens), outputTokens: count(m.outputTokens), cacheReadTokens: count(m.cacheReadTokens), cacheWriteTokens: count(m.cacheWriteTokens) })
  const money = (m) => (usd ? { known: m.known !== false, ...(Number.isFinite(m.usd) && m.usd >= 0 ? { usd: m.usd } : {}) } : {})
  if (c.status !== 'ok') return { status: 'unavailable', reason: COST_REASONS.includes(c.reason) ? c.reason : 'error' }
  return {
    status: 'ok',
    ...tokens(c),
    ...money(c),
    models: (Array.isArray(c.models) ? c.models : [])
      .filter(isObj)
      .slice(0, HISTORY_LIMITS.models)
      .map((m) => ({ model: text(m.model, roots, PANE_LIMITS.model), ...tokens(m), ...money(m) })),
    subagents: count(c.subagents),
    incomplete: c.incomplete === true
  }
}
// One record -> the guests' copy (roots null: the guest's own check).
function historyRecord(r, roots, usd) {
  const periods = (Array.isArray(r.workPeriods) ? r.workPeriods : [])
    .filter((p) => isObj(p) && time(p.start))
    .slice(-HISTORY_LIMITS.periods)
    .map((p) => ({ start: time(p.start), end: time(p.end) || time(p.start) }))
  return {
    id: r.id,
    title: text(r.title, roots, HISTORY_LIMITS.title),
    paneId: typeof r.paneId === 'string' && PANE_ID.test(r.paneId) ? r.paneId : null,
    agentName: text(r.agentName, roots, HISTORY_LIMITS.agentName) || null,
    agentKind: typeof r.agentKind === 'string' && AGENT_ID.test(r.agentKind) ? r.agentKind : null,
    project: text(r.project, roots, HISTORY_LIMITS.project) || null,
    createdAt: time(r.createdAt),
    startedAt: time(r.startedAt),
    doneAt: time(r.doneAt),
    durationMs: count(r.durationMs),
    workPeriods: periods,
    cost: guestCost(r.cost, usd, roots)
  }
}

// The window's records of one project -> what the host keeps of them (the
// newest HISTORY_LIMITS.records with a valid id, one each).
export function hostHistory(list) {
  const seen = new Set()
  const out = []
  for (const r of Array.isArray(list) ? list : []) {
    if (!isObj(r) || !isTaskId(r.id) || seen.has(r.id)) continue
    seen.add(r.id)
    out.push(r)
  }
  out.sort((a, b) => (time(a.doneAt) || 0) - (time(b.doneAt) || 0))
  return out.slice(-HISTORY_LIMITS.records)
}

// What the host keeps -> the guests' copy: { records, usd }. costs: figures
// read here for records the window has none for ({ [id]: cost }).
export function guestHistory(records, { roots = [], usd = false, costs = null } = {}) {
  return {
    // Figures read just now win over the window's (not final yet, or none).
    records: (Array.isArray(records) ? records : []).slice(-HISTORY_LIMITS.records).map((r) => historyRecord({ ...r, cost: (costs && isObj(costs[r.id]) ? costs[r.id] : null) || r.cost }, roots, usd)),
    usd: usd === true
  }
}

// The guest's check of the host's copy: costs in dollars only when the host
// says this guest may see them.
export function checkHistory(data) {
  if (!isObj(data) || !Array.isArray(data.records) || data.records.length > HISTORY_LIMITS.records) return null
  const usd = data.usd === true
  const seen = new Set()
  const records = []
  for (const r of data.records) {
    if (!isObj(r) || !isTaskId(r.id) || seen.has(r.id)) continue
    seen.add(r.id)
    records.push(historyRecord(r, null, usd))
  }
  return { records, usd }
}

// Records whose figures may still change (none yet, or not final): read on
// the host for the guests.
export const needsFigures = (r) => !r.cost || r.cost.final === false

// --- A task's own copy (the review) ------------------------------------------------
// The window's cards of one project -> the copies of those with one, not
// merged yet (card id -> { path, branch, target }): host-only, what
// shareRequests.js' review ops read with.
const BRANCH = /^(?!-)[A-Za-z0-9._/-]{1,200}$/
export function hostTaskCopies(cards) {
  const out = new Map()
  for (const c of Array.isArray(cards) ? cards : []) {
    if (!isObj(c) || !isTaskId(c.id) || c.mergedAt || !isObj(c.worktree)) continue
    const w = c.worktree
    if (typeof w.path !== 'string' || !w.path || w.path.length > 1024 || !BRANCH.test(str(w.branch))) continue
    const target = BRANCH.test(str(w.baseBranch)) ? w.baseBranch : 'main'
    out.set(c.id, { path: w.path, branch: w.branch, target })
  }
  return out
}

// The host's review of a task branch, checked on the guest's side.
const isRel = (v) => typeof v === 'string' && !!v && cleanRel(v) === v
const rels = (list, max) => (Array.isArray(list) ? list.filter(isRel).slice(0, max) : [])
export function checkReviewInfo(d) {
  if (!isObj(d) || !Array.isArray(d.files) || d.files.length > REVIEW_LIMITS.files || !Array.isArray(d.commits) || d.commits.length > REVIEW_LIMITS.commits) return null
  const commit = (v) => (typeof v === 'string' && /^[0-9a-f]{7,64}$/.test(v) ? v : null)
  return {
    branch: oneLine(d.branch, 200),
    target: oneLine(d.target, 200),
    head: commit(d.head),
    files: d.files
      .filter((f) => isObj(f) && isRel(f.path))
      .map((f) => ({ path: f.path, status: /^[AMDUX]$/.test(str(f.status)) ? f.status : 'M', added: count(f.added), removed: count(f.removed), binary: f.binary === true, ...(commit(f.blob) ? { blob: f.blob } : {}) })),
    hidden: count(d.hidden),
    truncated: d.truncated === true,
    commits: d.commits.filter((c) => isObj(c) && commit(c.sha)).map((c) => ({ sha: c.sha, author: oneLine(c.author, 200), time: time(c.time) || 0, subject: oneLine(c.subject, 1000), body: str(c.body).slice(0, REVIEW_LIMITS.body) })),
    conflicts: rels(d.conflicts, REVIEW_LIMITS.files),
    uncommitted: rels(d.uncommitted, REVIEW_LIMITS.files),
    mergeCheck: d.mergeCheck === 'failed' ? 'failed' : 'done',
    behind: count(d.behind),
    copyExists: d.copyExists === true
  }
}
export function checkReviewDiff(d) {
  if (!isObj(d) || typeof d.text !== 'string' || d.text.length > REVIEW_LIMITS.diff) return null
  return { text: d.text, truncated: d.truncated === true }
}

// --- Usage, guest side -----------------------------------------------------------
// The host's usage copy (shareUsage.js), checked again field by field: the
// window shows only these (src/renderer/src/hostUsage.js checks once more).
const USAGE_STATUSES = ['ok', 'stale', 'signin', 'unsupported', 'error']
export function checkUsage(data) {
  if (!isObj(data) || !Array.isArray(data.providers)) return null
  const providers = []
  for (const p of data.providers.slice(0, 16)) {
    if (!isObj(p) || typeof p.id !== 'string' || !/^[\w-]{1,40}$/.test(p.id) || providers.some((x) => x.id === p.id)) continue
    const windows = []
    for (const w of (Array.isArray(p.windows) ? p.windows : []).slice(0, 16)) {
      if (!isObj(w) || typeof w.usedPct !== 'number' || !Number.isFinite(w.usedPct)) continue
      windows.push({ label: oneLine(w.label, 70), usedPct: Math.min(100, Math.max(0, w.usedPct)), resetsAt: time(w.resetsAt) })
    }
    providers.push({ id: p.id, plan: oneLine(p.plan, 40) || null, windows, status: USAGE_STATUSES.includes(p.status) ? p.status : 'error', updatedAt: time(p.updatedAt) })
  }
  return { providers }
}
