// Tokens, time and estimated cost of each job an agent does: per pane (its
// current session) and per task card (what its pane spent while the card was
// in Doing). Read from the agents' own session files on this computer
// (jobCostUsage.js); the cost is an estimate at list prices
// (src/shared/modelPricing.js), never a bill.
//
// Which session a pane is in: what its hooks last reported
// (<sessions>/<pane>.json: agent, sessionId, transcriptPath), else a chat
// pane's journal meta (<userData>/chats/<pane>/meta.json). Every session seen
// for a pane is remembered (<userData>/job-cost-panes.json), so a card still
// finds the sessions its pane had before a /clear or a restart of the agent.
//
// Which file: Claude Code and Codex, the session's transcript in one of the
// accounts' folders (the reported path, checked to be inside one; else looked
// up by id), with a Claude session's sub-agent transcripts
// (<id>/subagents/*.jsonl). Other chat agents (OpenCode): the pane's journal.
// Claude Code and Codex in a terminal on an SSH host: the session's file
// there, read over the host's connection (bounded, throttled; its
// sub-agents' files not read). Any other agent, or a pane on another
// computer: status 'unavailable'.
//
// A card: its work periods (taskBoardStore.js workPeriods: [{ start, end,
// paneId }]; for a card from before they were kept, startedAt to doneAt, or
// to now while it is open). Each usage event of a pane goes to the cards that
// were in Doing on that pane at its time; when several were (overlapping
// periods on one pane), each gets an equal share. The card's time is the sum
// of its periods.
//
// The design (match by session id, never guess when it is ambiguous: say
// 'unavailable' with a reason) follows Orca's automation usage attribution
// (github.com/stablyai/orca, src/main/claude-usage/
// claude-usage-automation-attribution.ts, MIT, Copyright (c) 2026 Lovecast Inc.).
import fsp from 'fs/promises'
import { join, isAbsolute, dirname, basename } from 'path'
import { createUsageFileCache } from './jobCostUsage'
import { reportedTranscriptIn } from './chat/transcriptView'
import { claudeTranscriptIn, codexRolloutIn } from './agentModel'
import { estimateCost as defaultEstimate } from '../shared/modelPricing'

const PANE_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/
const CARD_ID = /^(?!\.)(?!.*\.\.)[A-Za-z0-9._-]{1,100}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_IDS = 200
const MAX_SESSIONS_PER_PANE = 20
const MAX_PANES = 500
const MAX_SUBAGENT_FILES = 50
const CALL_BUDGET_BYTES = 128 * 1024 * 1024
const FILE_AGENTS = ['claude', 'codex']
const HOST_ID = /^ssh-[\w-]{1,60}$/
export const PANES_FILE = 'job-cost-panes.json'

// The cache key of a conversation file on an SSH host (never a path read here).
const remoteKey = (hostId, agent, id) => `ssh-file://${hostId}/${agent}/${id}`

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null)
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

// --- Cards: their periods --------------------------------------------------

// A card -> [{ start, end, paneId }] (end: now while it is open).
export function cardWindows(card, now = Date.now()) {
  const c = obj(card)
  if (!c) return []
  const closeOf = () => (c.column === 'doing' ? now : num(c.doneAt) || num(c.columnSince) || now)
  let out = []
  if (Array.isArray(c.workPeriods) && c.workPeriods.length) {
    out = c.workPeriods
      .filter((p) => obj(p) && num(p.start))
      .map((p) => ({ start: p.start, end: num(p.end) ?? closeOf(), paneId: typeof p.paneId === 'string' ? p.paneId : c.paneId || null }))
  } else {
    // A card from before the periods: from its first entry in Doing.
    const start = num(c.startedAt) || (c.column === 'doing' ? num(c.doingSince) || num(c.createdAt) : null)
    if (start) out = [{ start, end: c.column === 'todo' ? num(c.columnSince) || now : closeOf(), paneId: c.paneId || null }]
  }
  return out.map((w) => ({ ...w, end: Math.min(Math.max(w.end, w.start), Math.max(now, w.start)) }))
}

// The finished tasks' history (task-board.json "history"): a record whose
// card was deleted from the board is still counted, from its work periods.
export function withHistory(tasks, history) {
  if (!Array.isArray(history) || !history.length) return tasks
  const ids = new Set(tasks.map((t) => t.id))
  const out = [...tasks]
  for (const r of history) {
    if (!obj(r) || typeof r.id !== 'string' || ids.has(r.id)) continue
    ids.add(r.id)
    out.push({ id: r.id, column: 'done', paneId: typeof r.paneId === 'string' ? r.paneId : null, startedAt: num(r.startedAt), doneAt: num(r.doneAt), workPeriods: Array.isArray(r.workPeriods) ? r.workPeriods : [] })
  }
  return out
}

// --- Sums and cost -------------------------------------------------------

function emptySums() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reportedUsd: 0, reported: 0, events: 0 }
}
function addInto(s, ev, share = 1) {
  s.input += ev.input * share
  s.output += ev.output * share
  s.cacheRead += ev.cacheRead * share
  s.cacheWrite += ev.cacheWrite * share
  s.cacheWrite1h += (ev.cacheWrite1h || 0) * share
  if (typeof ev.reportedUsd === 'number') {
    s.reportedUsd += ev.reportedUsd * share
    s.reported += 1
  }
  s.events += 1
}

// A tally: per model segment (provider + model) and per sub-agent.
function newTally() {
  return { byModel: new Map(), bySub: new Map() }
}
function tallyEvent(t, ev, share = 1) {
  const mk = `${ev.provider || ''}\u0000${ev.model || ''}`
  let s = t.byModel.get(mk)
  if (!s) t.byModel.set(mk, (s = { provider: ev.provider || null, model: ev.model || null, ...emptySums() }))
  addInto(s, ev, share)
  if (ev.sub) {
    let x = t.bySub.get(ev.sub)
    if (!x) t.bySub.set(ev.sub, (x = newTally()))
    tallyEvent(x, { ...ev, sub: null }, share)
  }
}

// A tally -> the API's figures (tokens rounded; cost per model segment, summed).
export function summarize(t, durationMs, estimate = defaultEstimate, extra = {}) {
  let input = 0
  let output = 0
  let cacheRead = 0
  let cacheWrite = 0
  let usd = 0
  let anyUsd = false
  let known = true
  let top = null
  const models = []
  for (const s of t.byModel.values()) {
    const seg = { provider: s.provider, model: s.model, inputTokens: Math.round(s.input), outputTokens: Math.round(s.output), cacheReadTokens: Math.round(s.cacheRead), cacheWriteTokens: Math.round(s.cacheWrite) }
    input += s.input
    output += s.output
    cacheRead += s.cacheRead
    cacheWrite += s.cacheWrite
    let r = null
    try {
      r = estimate({ provider: s.provider, model: s.model, inputTokens: s.input, outputTokens: s.output, cacheReadTokens: s.cacheRead, cacheWriteTokens: s.cacheWrite, cacheWrite1hTokens: s.cacheWrite1h })
    } catch {
      r = null
    }
    let segUsd = r && r.known && typeof r.usd === 'number' && Number.isFinite(r.usd) ? r.usd : null
    // No list price, but the agent said what each turn cost (OpenCode).
    if (segUsd === null && s.reported && s.reported === s.events) segUsd = s.reportedUsd
    if (segUsd === null) known = false
    else {
      usd += segUsd
      anyUsd = true
    }
    models.push({ ...seg, usd: segUsd, known: segUsd !== null })
    const weight = s.input + s.output + s.cacheRead + s.cacheWrite
    if (!top || weight > top.weight) top = { weight, model: s.model, provider: s.provider }
  }
  models.sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens))
  const subagents = []
  for (const [id, sub] of t.bySub) {
    const r = summarize(sub, null, estimate)
    subagents.push({ id, inputTokens: r.inputTokens, outputTokens: r.outputTokens, cacheReadTokens: r.cacheReadTokens, cacheWriteTokens: r.cacheWriteTokens, usd: r.usd, known: r.known, model: r.model })
  }
  return {
    status: 'ok',
    inputTokens: Math.round(input),
    outputTokens: Math.round(output),
    cacheReadTokens: Math.round(cacheRead),
    cacheWriteTokens: Math.round(cacheWrite),
    durationMs: Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : null,
    // The sum of the parts whose price is known; null when none is.
    usd: models.length ? (anyUsd ? usd : null) : 0,
    known,
    model: top ? top.model : null,
    provider: top ? top.provider : null,
    estimated: true,
    models,
    ...(subagents.length ? { subagents } : {}),
    ...extra
  }
}

export function unavailable(reason, extra = {}) {
  return { status: 'unavailable', reason, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, durationMs: null, usd: null, known: false, model: null, provider: null, estimated: true, models: [], ...extra }
}

// Events of one pane -> per card tallies (cards: [{ id, windows }] of the
// windows on that pane). Overlapping cards share an event equally.
export function attribute(events, cards) {
  const out = new Map(cards.map((c) => [c.id, newTally()]))
  const spans = []
  for (const c of cards) for (const w of c.windows) spans.push({ id: c.id, start: w.start, end: w.end })
  if (!spans.length) return out
  for (const ev of events) {
    const at = ev.at
    if (!Number.isFinite(at)) continue
    const ids = new Set()
    for (const s of spans) if (at >= s.start && at <= s.end) ids.add(s.id)
    if (!ids.size) continue
    const share = 1 / ids.size
    for (const id of ids) tallyEvent(out.get(id), ev, share)
  }
  return out
}

// --- The service ------------------------------------------------------------

// userDataDir: Tessel's userData (task-board.json, chats/, job-cost-panes.json)
// sessionsDir(): where the panes' hooks report their sessions
// homes(agent) -> Promise<[folder]>: the Claude Code or Codex folders of every
//   account (~/.claude, CLAUDE_CONFIG_DIR...)
// isRemote(path) -> true for a file on another computer (not read)
// send(channel, payload): to the window ('jobCost:changed')
// A terminal agent on an SSH host (Claude Code, Codex): its conversation
// file there, read over the host's connection:
//   hostOfPane(paneId) -> the SSH host a running pane is on, or null (its
//     sessions remember it, so a card still finds them once it closed);
//   readAgentFile(hostId, { agent, id, offset, cap }) (remoteFs.js): a bounded
//     window of that file. Only what was added since the last read is asked
//     for, at most remoteBudgetBytes per call, each file at most once per
//     remoteGapMs; files asked about in the last remoteWatchMs are checked
//     every remotePollMs for the change notice (only while someone looks).
export function createJobCost({
  userDataDir,
  sessionsDir = () => null,
  homes = async () => [],
  isRemote = () => false,
  send = () => {},
  estimate = defaultEstimate,
  now = Date.now,
  fs = fsp,
  cache = createUsageFileCache({ fs, now }),
  budgetBytes = CALL_BUDGET_BYTES,
  pollMs = 5000,
  debounceMs = 1500,
  hostOfPane = () => null,
  readAgentFile = null,
  remoteBudgetBytes = 8 * 1024 * 1024,
  remoteGapMs = 5000,
  remotePollMs = 15000,
  remoteWatchMs = 2 * 60 * 1000,
  log = null
} = {}) {
  const paneLog = new Map() // paneId -> [{ agent, sessionId, transcriptPath, hostId?, seenAt }]
  const remoteWatched = new Map() // key -> { hostId, agent, id, until, stamp }
  let remotePoller = null
  let logLoaded = false
  let logDirty = false
  let saveTimer = null
  const resolved = new Map() // agent|sessionId -> { file, subDir } | null (missing)
  const watched = new Map() // file -> { stamp, until }
  let changedTimer = null
  let poller = null
  let board = { stamp: '', tasks: [] }

  const warn = (what, err) => {
    try {
      log?.warn?.('jobCost', `${what}: ${err?.code || err?.message || err}`) // i18n-ignore log line
    } catch {
      // no log
    }
  }

  async function readJson(file) {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'))
    } catch {
      return null
    }
  }

  async function loadLog() {
    if (logLoaded) return
    logLoaded = true
    const data = obj(await readJson(join(userDataDir, PANES_FILE)))
    const panes = obj(data && data.panes) || {}
    for (const [id, list] of Object.entries(panes)) {
      if (!PANE_ID.test(id) || !Array.isArray(list)) continue
      const clean = list.filter((s) => obj(s) && typeof s.agent === 'string' && typeof s.sessionId === 'string').slice(-MAX_SESSIONS_PER_PANE)
      if (clean.length && !paneLog.has(id)) paneLog.set(id, clean)
    }
  }

  function scheduleSave() {
    logDirty = true
    if (saveTimer) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      void saveLog()
    }, 2000)
    saveTimer.unref?.()
  }
  async function saveLog() {
    if (!logDirty) return
    logDirty = false
    const panes = {}
    for (const [id, list] of [...paneLog].slice(-MAX_PANES)) panes[id] = list
    const file = join(userDataDir, PANES_FILE)
    const tmp = `${file}.${process.pid}.tmp`
    try {
      await fs.writeFile(tmp, JSON.stringify({ version: 1, panes }), 'utf8')
      await fs.rename(tmp, file)
    } catch (err) {
      warn('save', err)
    }
  }

  // The session a pane is in now -> { agent, sessionId, transcriptPath, chat } | null
  async function currentSession(paneId) {
    const dir = sessionsDir()
    if (typeof dir === 'string' && isAbsolute(dir)) {
      const r = obj(await readJson(join(dir, `${paneId}.json`)))
      if (r && typeof r.agent === 'string' && typeof r.sessionId === 'string' && r.sessionId)
        return { agent: r.agent, sessionId: r.sessionId, transcriptPath: typeof r.transcriptPath === 'string' ? r.transcriptPath : null, chat: false }
    }
    const meta = obj(await readJson(join(userDataDir, 'chats', paneId, 'meta.json')))
    // safeJson may wrap the data: { data } or the object itself.
    const m = meta && typeof meta.agent === 'string' ? meta : obj(meta && meta.data)
    if (m && typeof m.agent === 'string' && typeof m.sessionId === 'string' && m.sessionId)
      return { agent: m.agent, sessionId: m.sessionId, transcriptPath: null, chat: true }
    return null
  }

  function paneHost(paneId) {
    try {
      const h = hostOfPane(paneId)
      return typeof h === 'string' && HOST_ID.test(h) ? h : null
    } catch {
      return null
    }
  }

  async function noteSession(paneId) {
    await loadLog()
    const s = await currentSession(paneId)
    if (!s) return paneLog.get(paneId)?.at(-1) || null
    // A terminal agent on an SSH host: its session is a file there.
    const hostId = s.chat ? null : paneHost(paneId)
    const list = paneLog.get(paneId) || []
    const last = list[list.length - 1]
    if (!last || last.sessionId !== s.sessionId || last.agent !== s.agent || (s.transcriptPath && last.transcriptPath !== s.transcriptPath) || (hostId && last.hostId !== hostId)) {
      const others = list.filter((x) => !(x.sessionId === s.sessionId && x.agent === s.agent))
      others.push({ agent: s.agent, sessionId: s.sessionId, transcriptPath: s.transcriptPath, chat: s.chat, ...(hostId ? { hostId } : {}), seenAt: now() })
      paneLog.delete(paneId)
      paneLog.set(paneId, others.slice(-MAX_SESSIONS_PER_PANE))
      while (paneLog.size > MAX_PANES) paneLog.delete(paneLog.keys().next().value)
      scheduleSave()
    }
    return paneLog.get(paneId).at(-1)
  }

  async function exists(file) {
    try {
      return (await fs.stat(file)).isFile()
    } catch {
      return false
    }
  }

  // A pane whose figures could not be read yet (no session reported, or its
  // transcript not written yet: Claude Code writes it with the first prompt):
  // its session report and the transcript it named are watched, so the window
  // is told when they appear.
  function watchPending(paneId, s) {
    const dir = sessionsDir()
    if (typeof dir === 'string' && isAbsolute(dir)) watch(join(dir, `${paneId}.json`))
    const p = s && s.transcriptPath
    if (typeof p === 'string' && isAbsolute(p) && p.length <= 1024 && !p.includes('\0') && p.toLowerCase().endsWith('.jsonl') && !isRemote(p)) watch(p)
  }

  // A session -> its files [{ file, kind, sub }] | { reason }
  async function filesOf(paneId, s) {
    // On an SSH host: its file there (its sub-agents' files are not read).
    if (s.hostId && !s.chat) {
      if (!FILE_AGENTS.includes(s.agent)) return { reason: 'remote' }
      if (!UUID.test(s.sessionId) || !HOST_ID.test(s.hostId)) return { reason: 'invalid-session' }
      if (typeof readAgentFile !== 'function') return { reason: 'remote' }
      return { files: [{ file: remoteKey(s.hostId, s.agent, s.sessionId), kind: s.agent, sub: null, remote: { hostId: s.hostId, agent: s.agent, id: s.sessionId } }] }
    }
    if (FILE_AGENTS.includes(s.agent)) {
      if (!UUID.test(s.sessionId)) return { reason: 'invalid-session' }
      const key = `${s.agent}|${s.sessionId}|${s.transcriptPath || ''}`
      const known = resolved.get(key)
      // A file not found is looked for again after a while (not yet written).
      let hit = known && known.file ? known.file : undefined
      if (hit === undefined) {
        hit = null
        let folders = []
        try {
          folders = (await homes(s.agent)) || []
        } catch {
          folders = []
        }
        const sub = s.agent === 'codex' ? 'sessions' : 'projects'
        // The reported path: checked every time (cheap), so a transcript
        // written after the session started is found as soon as it exists.
        for (const home of folders) {
          if (typeof home !== 'string' || !isAbsolute(home)) continue
          if (isRemote(home)) continue
          const f = s.transcriptPath ? reportedTranscriptIn(home, sub, s.transcriptPath) : null
          if (f && (await exists(f))) {
            hit = f
            break
          }
        }
        if (!hit && s.transcriptPath && folders.length && isRemote(s.transcriptPath)) return { reason: 'remote' }
        // The search by id (reads folders): not again for a while.
        if (!hit && !(known && now() - known.at < 30000)) {
          for (const home of folders) {
            if (typeof home !== 'string' || !isAbsolute(home) || isRemote(home)) continue
            hit = s.agent === 'codex' ? codexRolloutIn(home, s.sessionId) : claudeTranscriptIn(home, s.sessionId)
            if (hit) break
          }
          resolved.set(key, { file: hit, at: now() })
        } else if (hit) resolved.set(key, { file: hit, at: now() })
        if (resolved.size > 2000) resolved.delete(resolved.keys().next().value)
      }
      if (hit) {
        const files = [{ file: hit, kind: s.agent, sub: null }]
        if (s.agent === 'claude') files.push(...(await subagentFiles(hit)))
        return { files }
      }
      if (!s.chat) return { reason: 'missing-file' }
    }
    // A chat pane: its journal (this one and the rotated one before it).
    if (s.chat) {
      const dir = join(userDataDir, 'chats', paneId)
      return {
        files: [
          { file: join(dir, 'journal.1.jsonl'), kind: 'journal', sub: null, agent: s.agent },
          { file: join(dir, 'journal.jsonl'), kind: 'journal', sub: null, agent: s.agent }
        ]
      }
    }
    return { reason: 'unsupported-agent' }
  }

  // <dir>/<id>.jsonl -> <dir>/<id>/subagents/*.jsonl
  async function subagentFiles(file) {
    const dir = join(dirname(file), basename(file, '.jsonl'), 'subagents')
    let names = []
    try {
      names = (await fs.readdir(dir)).filter((x) => x.endsWith('.jsonl')).slice(0, MAX_SUBAGENT_FILES)
    } catch {
      return []
    }
    return names.map((x) => ({ file: join(dir, x), kind: 'claude', sub: basename(x, '.jsonl') }))
  }

  // The events of a set of files, each event once (a resumed or forked session
  // copies earlier lines into its new file: the same keys).
  async function eventsOf(files, budget, seen = new Set(), remoteBudget = { bytes: remoteBudgetBytes }) {
    const events = []
    let first = null
    let last = null
    let partial = false
    let any = false
    for (const f of files) {
      let r
      if (f.remote) {
        r = await readRemoteFile(f, remoteBudget)
        if (!r) continue
        watchRemote(f)
      } else {
        if (isRemote(f.file)) continue
        r = await cache.read(f.file, f.kind, budget, { agent: f.agent || null })
        if (!r) continue
        watch(f.file)
      }
      any = true
      if (!r.done) partial = true
      if (r.first !== null && (first === null || r.first < first)) first = r.first
      if (r.last !== null && (last === null || r.last > last)) last = r.last
      for (const ev of r.events) {
        const key = f.sub ? `${f.sub}:${ev.key}` : ev.key
        if (seen.has(key)) continue
        seen.add(key)
        events.push(f.sub ? { ...ev, sub: f.sub } : ev)
      }
    }
    return { events, first, last, partial, any }
  }

  async function forPanes(paneIds) {
    const ids = Array.isArray(paneIds) ? [...new Set(paneIds.filter((id) => typeof id === 'string' && PANE_ID.test(id)))].slice(0, MAX_IDS) : []
    const budget = { bytes: budgetBytes }
    const remoteBudget = { bytes: remoteBudgetBytes }
    const out = {}
    for (const id of ids) {
      try {
        const s = await noteSession(id)
        if (!s) {
          watchPending(id, null)
          out[id] = unavailable('no-session')
          continue
        }
        const where = await filesOf(id, s)
        if (!where.files) {
          if (where.reason === 'missing-file') watchPending(id, s)
          out[id] = unavailable(where.reason, { sessionId: s.sessionId, agent: s.agent })
          continue
        }
        const r = await eventsOf(where.files, budget, new Set(), remoteBudget)
        if (!r.any) {
          watchPending(id, s)
          out[id] = unavailable('missing-file', { sessionId: s.sessionId, agent: s.agent })
          continue
        }
        const t = newTally()
        for (const ev of r.events) tallyEvent(t, ev)
        const duration = r.first !== null && r.last !== null ? r.last - r.first : null
        out[id] = summarize(t, duration, estimate, { sessionId: s.sessionId, agent: s.agent, ...(r.partial ? { partial: true } : {}) })
        if (r.partial) changedSoon()
      } catch (err) {
        warn(`pane ${id}`, err)
        out[id] = unavailable('error')
      }
    }
    return out
  }

  async function loadBoard() {
    const file = join(userDataDir, 'task-board.json')
    let st
    try {
      st = await fs.stat(file)
    } catch {
      board = { stamp: '', tasks: [] }
      return board.tasks
    }
    const stamp = `${st.size}:${st.mtimeMs}`
    if (stamp === board.stamp) return board.tasks
    const data = await readJson(file)
    const tasks = Array.isArray(data) ? data : obj(data) && Array.isArray(data.tasks) ? data.tasks : null
    // A board being written (unreadable a moment): the last good one.
    if (tasks) board = { stamp, tasks: withHistory(tasks.filter((t) => obj(t) && typeof t.id === 'string'), obj(data) && data.history) }
    watch(file)
    return board.tasks
  }

  async function forCards(cardIds) {
    const ids = Array.isArray(cardIds) ? [...new Set(cardIds.filter((id) => typeof id === 'string' && CARD_ID.test(id)))].slice(0, MAX_IDS) : []
    const out = {}
    if (!ids.length) return out
    const tasks = await loadBoard()
    const t = now()
    const byId = new Map(tasks.map((c) => [c.id, c]))
    // Every card's windows, by pane (all the board's cards: an overlap with a
    // card not asked about still shares the pane's usage).
    const byPane = new Map()
    const winOf = new Map()
    for (const c of tasks) {
      const wins = cardWindows(c, t)
      winOf.set(c.id, wins)
      for (const w of wins) {
        if (!w.paneId || !PANE_ID.test(w.paneId)) continue
        if (!byPane.has(w.paneId)) byPane.set(w.paneId, new Map())
        const m = byPane.get(w.paneId)
        if (!m.has(c.id)) m.set(c.id, [])
        m.get(c.id).push(w)
      }
    }
    const wanted = new Set()
    for (const id of ids) for (const w of winOf.get(id) || []) if (w.paneId && byPane.has(w.paneId)) wanted.add(w.paneId)
    const budget = { bytes: budgetBytes }
    const remoteBudget = { bytes: remoteBudgetBytes }
    const tallies = new Map() // card -> [tally]
    const reasons = new Map() // card -> reason when none of its panes could be read
    let partial = false
    for (const paneId of wanted) {
      let res = null
      try {
        await noteSession(paneId)
        const sessions = paneLog.get(paneId) || []
        const files = []
        let reason = sessions.length ? null : 'no-session'
        for (const s of sessions) {
          const where = await filesOf(paneId, s)
          if (where.files) files.push(...where.files)
          else {
            reason = reason || where.reason
            if (where.reason === 'missing-file') watchPending(paneId, s)
          }
        }
        if (files.length) {
          const r = await eventsOf(files, budget, new Set(), remoteBudget)
          if (r.partial) partial = true
          if (r.any) res = attribute(r.events, [...byPane.get(paneId)].map(([id, windows]) => ({ id, windows })))
          else reason = reason || 'missing-file'
        }
        if (!res) {
          const why = reason || 'missing-file'
          if (why === 'missing-file' || why === 'no-session') watchPending(paneId, sessions.at(-1))
          for (const id of byPane.get(paneId).keys()) if (!reasons.has(id)) reasons.set(id, why)
        }
      } catch (err) {
        warn(`pane ${paneId}`, err)
      }
      if (!res) continue
      for (const [id, tally] of res) {
        if (!tallies.has(id)) tallies.set(id, [])
        tallies.get(id).push(tally)
      }
    }
    for (const id of ids) {
      const card = byId.get(id)
      if (!card) {
        out[id] = unavailable('no-card')
        continue
      }
      const wins = winOf.get(id) || []
      const duration = wins.reduce((a, w) => a + (w.end - w.start), 0)
      if (!wins.length) {
        out[id] = unavailable('not-started', { durationMs: 0 })
        continue
      }
      const parts = tallies.get(id)
      if (!parts) {
        out[id] = unavailable(wins.some((w) => w.paneId) ? reasons.get(id) || 'missing-file' : 'no-pane', { durationMs: duration })
        continue
      }
      const merged = newTally()
      for (const p of parts) mergeTally(merged, p)
      // Some of its panes could not be read: what could be, flagged.
      const missing = reasons.has(id)
      out[id] = summarize(merged, duration, estimate, { ...(partial ? { partial: true } : {}), ...(missing ? { incomplete: true, reason: reasons.get(id) } : {}) })
    }
    if (partial) changedSoon()
    return out
  }

  // --- Files on an SSH host ---------------------------------------------------

  function readerOf(f) {
    const { hostId, agent, id } = f.remote
    return async ({ offset, cap }) => {
      try {
        const r = await readAgentFile(hostId, { agent, id, offset, cap })
        return r && typeof r === 'object' ? r : { ok: false }
      } catch {
        return { ok: false }
      }
    }
  }

  async function readRemoteFile(f, remoteBudget) {
    try {
      return await cache.readRemote(f.file, f.kind, readerOf(f), remoteBudget, { minGapMs: remoteGapMs })
    } catch (err) {
      warn('remote read', err)
      return null
    }
  }

  // Asked about: checked now and then for a while (the change notice), at
  // most every remotePollMs, one file at a time.
  function watchRemote(f) {
    const w = remoteWatched.get(f.file)
    const until = now() + remoteWatchMs
    if (w) w.until = until
    else remoteWatched.set(f.file, { f, until, stamp: null })
    if (!remotePoller && remotePollMs > 0) {
      remotePoller = setInterval(() => void pollRemote(), remotePollMs)
      remotePoller.unref?.()
    }
  }

  let remotePolling = false
  async function pollRemote() {
    if (remotePolling) return
    remotePolling = true
    let changed = false
    try {
      const t = now()
      for (const [key, w] of remoteWatched) {
        if (w.until < t) {
          remoteWatched.delete(key)
          continue
        }
        const r = await readRemoteFile(w.f, { bytes: remoteBudgetBytes })
        const stamp = r ? `${r.events.length}:${r.last ?? ''}:${r.done}` : ''
        if (w.stamp !== null && w.stamp !== stamp) changed = true
        w.stamp = stamp
      }
    } finally {
      remotePolling = false
    }
    if (!remoteWatched.size && remotePoller) {
      clearInterval(remotePoller)
      remotePoller = null
    }
    if (changed) changedSoon()
  }

  // --- Change notices: the files the window asked about, stat'ed ------------

  function watch(file) {
    const w = watched.get(file)
    const until = now() + 10 * 60 * 1000
    if (w) w.until = until
    else watched.set(file, { stamp: null, until })
    if (!poller && pollMs > 0) {
      poller = setInterval(() => void poll(), pollMs)
      poller.unref?.()
    }
  }

  async function poll() {
    const t = now()
    let changed = false
    for (const [file, w] of watched) {
      if (w.until < t) {
        watched.delete(file)
        continue
      }
      let stamp = ''
      try {
        const st = await fs.stat(file)
        stamp = `${st.size}:${st.mtimeMs}`
      } catch {
        stamp = ''
      }
      if (w.stamp !== null && w.stamp !== stamp) changed = true
      w.stamp = stamp
    }
    if (!watched.size && poller) {
      clearInterval(poller)
      poller = null
    }
    if (changed) changedSoon()
  }

  function changedSoon() {
    if (changedTimer) return
    changedTimer = setTimeout(() => {
      changedTimer = null
      try {
        send('jobCost:changed', {})
      } catch {
        // no window
      }
    }, debounceMs)
    changedTimer.unref?.()
  }

  function register(ipcMain) {
    ipcMain.handle('jobCost:forCards', (_e, ids) => forCards(ids))
    ipcMain.handle('jobCost:forPanes', (_e, ids) => forPanes(ids))
  }

  async function close() {
    if (poller) clearInterval(poller)
    poller = null
    if (remotePoller) clearInterval(remotePoller)
    remotePoller = null
    remoteWatched.clear()
    if (changedTimer) clearTimeout(changedTimer)
    changedTimer = null
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    await saveLog()
  }

  return { forCards, forPanes, register, close, poll, pollRemote, sessionsOf: (id) => paneLog.get(id) || [] }
}

function mergeTally(into, from) {
  for (const [k, s] of from.byModel) {
    let d = into.byModel.get(k)
    if (!d) into.byModel.set(k, (d = { provider: s.provider, model: s.model, ...emptySums() }))
    for (const f of ['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h', 'reportedUsd', 'reported', 'events']) d[f] += s[f]
  }
  for (const [k, sub] of from.bySub) {
    if (!into.bySub.has(k)) into.bySub.set(k, newTally())
    mergeTally(into.bySub.get(k), sub)
  }
}
