// Activity of agents: what Tessel records and the numbers it shows.
//
// Pure ESM, no Vue, no DOM: the renderer records events, the main process
// stores them, tests check the maths. The model follows agent-observability
// tools (OpenTelemetry GenAI, Langfuse): point-in-time *events* (a message,
// a team change) and *spans* derived from state changes (an agent working,
// waiting for your approval, out of usage...).
//
// An event: { t, type, paneId?, agent?: { title, agentId }, ...fields }
//   agent.state      state: 'working' | 'idle' | 'approval' | 'limited' | 'closed'
//   message          status: 'sent' | 'held' | 'delivered' | 'skipped'
//                    source: 'you' | 'tessel'; scope: 'team' | 'workspace' | 'notes'
//                    | 'team-change' | 'task'; teamId?, wsId?, preview
//   agent.team       teamId (null: no team): the pane joined or left a team
//   task             action: 'started' | 'review'; taskId, title, wsId, branch?
//   team             action: 'created' | 'renamed' | 'left' | 'closed' | 'ungrouped'
//                    teamId, wsId, name, detail?
// agent.state and agent.team carry the pane's teamId and wsId at that time.

import { english } from './i18nText'

export const MAX_EVENTS = 20000
export const MAX_AGE_MS = 30 * 24 * 3600 * 1000

// Keep the log bounded: at most MAX_EVENTS, none older than MAX_AGE_MS.
export function trimEvents(events, now = Date.now()) {
  const fresh = events.filter((e) => e && Number.isFinite(e.t) && now - e.t <= MAX_AGE_MS)
  return fresh.length > MAX_EVENTS ? fresh.slice(fresh.length - MAX_EVENTS) : fresh
}

export function isEvent(e) {
  return !!e && typeof e === 'object' && Number.isFinite(e.t) && typeof e.type === 'string'
}

// The log as stored (activity.json) travels between the window and the main
// process as JSON text. At most this long (20000 events are a few MB).
export const MAX_TEXT = 64 * 1024 * 1024

// Text the main process may write as the log: a JSON list, not too long.
// (Reading it back checks every event: parseActivityText.)
export function isActivityText(text) {
  return typeof text === 'string' && text.length <= MAX_TEXT && /^\s*\[/.test(text) && /\]\s*$/.test(text)
}

// The log without exact copies of an event (the first one kept, in order).
// A log loaded twice into the same window (a hot reload of the interface in
// development) once held every event twice; read again, it is whole once.
// Two real events are never identical in every field (time to the
// millisecond, kind, pane, text...). The full comparison runs only for events
// with the same time, kind and pane.
// The events that change after they are recorded (eventIdentity) are one
// event whatever their copies say, one copy kept in the place of the first:
// - a message between agents (msgId): it may have been logged again with
//   other details (by a Tessel that did not have it in memory), or stored
//   unread, then read; the first copy read is kept, else the first;
// - an agent's state: its start (since) is moved after a restart or a sleep,
//   and the moved copy stored after the first; the last copy is kept.
export function dedupeEvents(events) {
  const seen = new Map() // "t|type|paneId" -> [JSON of the events kept]
  const versions = new Map() // identity -> index in out of the copy kept
  const out = []
  for (const e of events) {
    const id = eventIdentity(e)
    if (id) {
      const at = versions.get(id)
      if (at === undefined) {
        versions.set(id, out.length)
        out.push(e)
      } else if (id[0] === 'm' ? e.status === 'read' && out[at].status !== 'read' : JSON.stringify(e) !== JSON.stringify(out[at])) out[at] = e
      continue
    }
    const key = `${e.t}|${e.type}|${e.paneId || ''}` // i18n-ignore
    const json = JSON.stringify(e)
    const same = seen.get(key)
    if (same && same.includes(json)) continue
    if (same) same.push(json)
    else seen.set(key, [json])
    out.push(e)
  }
  return out
}

// The stored log's text -> its events, checked, without copies, and bounded
// ([] when it is not a list).
export function parseActivityText(text, now = Date.now()) {
  if (typeof text !== 'string' || !text.trim()) return []
  let data
  try {
    data = JSON.parse(text)
  } catch {
    return []
  }
  return Array.isArray(data) ? trimEvents(dedupeEvents(data.filter(isEvent)), now) : []
}

// The log -> the text to store (checked and bounded like the main process
// did before writing it).
export function activityText(events, now = Date.now()) {
  return JSON.stringify(trimEvents(events.filter(isEvent), now))
}

// The id of a message between agents (team chat), logged once per message.
export function messageId(e) {
  return e && e.type === 'message' && typeof e.msgId === 'string' && e.msgId ? e.msgId : null
}

// What makes two copies of an event that changes after it is recorded the same
// event (see dedupeEvents): a team message by its id ("m:..."), an agent's
// state by everything but its start ("s:..."). null: an event that never
// changes (exact copies only are the same).
export function eventIdentity(e) {
  const id = messageId(e)
  if (id) return `m:${id}`
  if (e && e.type === 'agent.state') return `s:${JSON.stringify({ ...e, since: undefined })}`
  return null
}

// --- Stored in pieces ----------------------------------------------------------
// The whole log (up to 8 MB) was written again every 15 s while agents worked.
// Now only the recent events are in activity.json (the live file): an event
// settles SETTLE_MS after its time and after it was last recorded or changed
// in the window, and the settled ones are appended
// once, one line each, to activity-archive/<day>.jsonl (src/main/activityArchive.js).
// The window still holds the whole log: it reads both at start, and knows
// event by event which ones the archive holds (activityStore.js): an event's
// time says neither when it was recorded (a team message is logged with the
// time it was sent) nor whether it was archived.
export const SETTLE_MS = 60 * 60 * 1000
export const ARCHIVE_BATCH = 3000

// The UTC day an event belongs to: "2026-10-19".
export function archiveDay(t) {
  return new Date(t).toISOString().slice(0, 10)
}

// What makes an archived line the same event as another, for the archive's
// own check that it holds each event once (src/main/activityArchive.js): a
// team message by its id and status (read later, it is stored once more,
// read), anything else by its whole line. -> the key, or null: the line.
export function archiveKey(e) {
  const id = messageId(e)
  return id ? `m:${id}:${e.status || ''}` : null
}

// Events of a JSON-lines text (one event per line; a line cut by a kill or
// not an event is skipped).
export function parseActivityLines(text) {
  const out = []
  if (typeof text !== 'string') return out
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line)
      if (isEvent(e)) out.push(e)
    } catch {
      /* a line cut by a kill */
    }
  }
  return out
}

// What was stored -> { events, inArchive, archived }: the archive's events and
// the live file's, checked, without copies, in time order and bounded like
// parseActivityText. inArchive: the events (of `events`) that came from the
// archive, which need no archiving; archived: how many they are. An event in
// both (the live file written while its archiving was on the way) is the
// archive's.
// text: the live file (a JSON list; the older single file is the same);
// archive: the archive's lines.
export function mergeSavedActivity(liveText, archiveText, now = Date.now()) {
  const old = parseActivityLines(archiveText)
  let live = []
  if (typeof liveText === 'string' && liveText.trim()) {
    try {
      const data = JSON.parse(liveText)
      if (Array.isArray(data)) live = data.filter(isEvent)
    } catch {
      /* unreadable: the archive alone */
    }
  }
  const merged = dedupeEvents([...old, ...live])
  // In time order (the archive is read by day, and an event recorded with an
  // older time than the ones before it sits in its own day): a stable sort,
  // only when something is out of order.
  let ordered = true
  for (let i = 1; i < merged.length && ordered; i++) if (merged[i].t < merged[i - 1].t) ordered = false
  const all = ordered ? merged : [...merged].sort((a, b) => a.t - b.t)
  const fresh = all.filter((e) => e && Number.isFinite(e.t) && now - e.t <= MAX_AGE_MS)
  const fromArchive = new Set(old)
  // Past MAX_EVENTS the oldest go, those of the archive first: an event only
  // in the live file (a team message logged late, with an old time) would not
  // be written anywhere any more.
  let events = fresh
  if (fresh.length > MAX_EVENTS) {
    let over = fresh.length - MAX_EVENTS
    events = fresh.filter((e) => {
      if (over > 0 && fromArchive.has(e)) {
        over--
        return false
      }
      return true
    })
    if (over > 0) events = events.slice(over)
  }
  const inArchive = new Set(events.filter((e) => fromArchive.has(e)))
  return { events, inArchive, archived: inArchive.size }
}

function median(list) {
  if (!list.length) return null
  const s = [...list].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2)
}

// Journal lines of the shared notes: "- 2026-09-24 Codex: text".
export function parseJournal(text) {
  const out = []
  const lines = String(text || '').split(/\r?\n/)
  let inJournal = false
  for (const line of lines) {
    if (/^##\s+Journal\b/i.test(line)) {
      inJournal = true
      continue
    }
    if (/^##\s/.test(line)) {
      inJournal = false
      continue
    }
    if (!inJournal) continue
    const m = /^-\s+(\d{4}-\d{2}-\d{2})\s+([^:()]+?)(?:\s*\([^)]*\))?:\s*(.*)$/.exec(line)
    if (m) out.push({ date: m[1], author: m[2].trim(), text: m[3].trim() })
  }
  return out
}

// Does a journal author ("Codex", "Claude") stand for this agent?
export function authorMatches(author, agent) {
  const a = String(author || '').toLowerCase()
  if (!a || !agent) return false
  const id = String(agent.agentId || '').toLowerCase()
  const title = String(agent.title || '').toLowerCase()
  return (!!id && a.includes(id)) || (!!title && (title.includes(a) || a.includes(title)))
}

// Everything the Activity view shows, for one scope and period.
//   events   the log (any order)
//   opts     { now, from,
//              teamId: count a pane only while it is in this team (membership
//                at the time of each event, from agent.state / agent.team),
//              wsId: count a pane only while it is in this workspace,
//              (neither: every pane)
//              live: { [paneId]: { state, title, agentId, teamId, wsId } } open now,
//              journal: parseJournal() entries }
// A row is shown for an agent open now (and in scope), or one with activity
// in the period; spans started before the period still count their part in it.
export function summarize(events, opts = {}) {
  const now = opts.now ?? Date.now()
  const from = opts.from ?? now - 7 * 24 * 3600 * 1000
  const sorted = events.filter(isEvent).sort((a, b) => a.t - b.t)

  // Is a pane, with this team and workspace, in the scope asked for?
  const counts = (team, ws) => {
    if (opts.teamId) return team === opts.teamId
    if (opts.wsId) return ws === opts.wsId
    return true
  }

  const stats = new Map() // paneId -> row (only shown if visible)
  const visible = new Set()
  // paneId -> { state, since: when this state began, seg: start of the part
  // not counted yet, team, ws }
  const cur = new Map()
  const timeline = []

  const row = (id, agent) => {
    let r = stats.get(id)
    if (!r) {
      r = {
        paneId: id,
        title: 'Agent',
        agentId: null,
        open: false,
        state: 'closed',
        since: null,
        ms: { working: 0, idle: 0, approval: 0, limited: 0 },
        approvals: 0,
        waits: [],
        limits: 0,
        received: 0,
        held: 0,
        skipped: 0,
        journal: 0,
        lastActivity: null
      }
      stats.set(id, r)
    }
    if (agent) {
      r.title = agent.title || r.title
      r.agentId = agent.agentId || r.agentId
    }
    return r
  }

  // Close the running segment of a pane at time t (adds its in-period part).
  const closeSegment = (id, t) => {
    const c = cur.get(id)
    if (!c || !counts(c.team, c.ws)) return
    const a = Math.max(c.seg, from)
    const b = Math.min(t, now)
    if (b > a && row(id).ms[c.state] !== undefined) {
      row(id).ms[c.state] += b - a
      visible.add(id)
    }
  }

  // Every timeline row gets a key of its own: the event's place in the log
  // (the log only grows at the end, so keys stay the same between renders).
  let evIndex = 0
  const push = (item) => timeline.push({ ...item, key: `e${evIndex}:${item.kind}` })

  for (const [ei, e] of sorted.entries()) {
    evIndex = ei
    if (e.t > now) continue
    const id = e.paneId
    const inPeriod = e.t >= from

    if ((e.type === 'agent.state' || e.type === 'agent.team') && id) {
      const r = row(id, e.agent)
      const prev = cur.get(id)
      const team = e.teamId !== undefined ? e.teamId || null : prev?.team ?? null
      const ws = e.wsId !== undefined && e.wsId !== null ? e.wsId : prev?.ws ?? null
      const state = e.type === 'agent.state' ? e.state : prev?.state || 'idle'
      closeSegment(id, e.t)
      const was = prev && counts(prev.team, prev.ws)
      const is = counts(team, ws)
      if (e.type === 'agent.state' && prev && was && inPeriod) {
        if (prev.state === 'approval' && state !== 'approval') {
          r.waits.push(e.t - prev.since)
          visible.add(id)
          push({ t: e.t, kind: 'approval-end', paneId: id, title: r.title, agentId: r.agentId, waited: e.t - prev.since })
        }
        if (prev.state === 'limited' && state !== 'limited') {
          visible.add(id)
          push({ t: e.t, kind: 'limit-end', paneId: id, title: r.title, agentId: r.agentId })
        }
      }
      if (e.type === 'agent.state' && is && inPeriod) {
        if (state === 'approval' && prev?.state !== 'approval') {
          r.approvals++
          visible.add(id)
          push({ t: e.t, kind: 'approval', paneId: id, title: r.title, agentId: r.agentId })
        }
        if (state === 'limited' && prev?.state !== 'limited') {
          r.limits++
          visible.add(id)
          push({ t: e.t, kind: 'limit', paneId: id, title: r.title, agentId: r.agentId, reset: e.reset || '' })
        }
        if (state === 'working' || state === 'approval') {
          r.lastActivity = e.t
          visible.add(id)
        }
        if (state === 'closed') visible.add(id)
      }
      // The state's start moves only when the state changes; the counted part
      // restarts at every event (it was just added up to now).
      const since = !prev || prev.state !== state ? e.t : prev.since
      cur.set(id, { state, since, seg: e.t, team, ws })
      continue
    }

    if (e.type === 'message' && id) {
      const c = cur.get(id)
      const team = c ? c.team : e.teamId || null
      const ws = c ? c.ws : e.wsId || null
      if (!inPeriod || !counts(team, ws)) continue
      const r = row(id, e.agent)
      visible.add(id)
      // Between agents: 'unread' / 'read' (it reached their inbox either way).
      if (e.status === 'sent' || e.status === 'delivered' || e.status === 'unread' || e.status === 'read') r.received++
      if (e.status === 'held') r.held++
      if (e.status === 'skipped') r.skipped++
      r.lastActivity = Math.max(r.lastActivity || 0, e.t)
      if (e.status !== 'delivered') {
        push({
          t: e.t,
          kind: 'message',
          paneId: id,
          title: r.title,
          agentId: r.agentId,
          status: e.status,
          source: e.source || 'you',
          from: e.from || '',
          // Who sent it, as Tessel recorded it (src/shared/senderIdentity.js);
          // older events have none.
          ...(e.sender && typeof e.sender === 'object' ? { sender: e.sender } : {}),
          scope: e.scope || 'workspace',
          preview: e.preview || '',
          text: e.text || e.preview || ''
        })
      }
      continue
    }

    if (e.type === 'task' && inPeriod) {
      const c = id ? cur.get(id) : null
      const inScope = opts.teamId ? !!c && c.team === opts.teamId : opts.wsId ? e.wsId === opts.wsId : true
      if (!inScope) continue
      if (id) {
        const r = row(id, e.agent)
        r.lastActivity = Math.max(r.lastActivity || 0, e.t)
        visible.add(id)
      }
      push({
        t: e.t,
        kind: 'task',
        action: e.action,
        paneId: id || null,
        title: e.agent ? e.agent.title : 'Agent',
        task: e.title || '',
        branch: e.branch || '',
        detail: e.detail || '',
        by: e.by || '',
        // The agent that reported it or asked a decision, as Tessel recorded
        // it (its model and effort then); older events and others have none.
        ...(e.sender && typeof e.sender === 'object' ? { sender: e.sender } : {})
      })
      continue
    }

    if (e.type === 'team' && inPeriod) {
      if (opts.teamId ? e.teamId !== opts.teamId : opts.wsId ? e.wsId !== opts.wsId : false) continue
      push({ t: e.t, kind: 'team', action: e.action, name: e.name, detail: e.detail || '' })
    }
  }

  // Open agents: their running segment lasts until now.
  const live = opts.live || {}
  for (const [id, info] of Object.entries(live)) {
    const c = cur.get(id)
    const team = c ? c.team : info.teamId || null
    const ws = c ? c.ws : info.wsId || null
    if (!counts(team, ws)) continue
    const r = row(id, info)
    r.open = true
    visible.add(id)
    if (c) {
      closeSegment(id, now)
      c.seg = now
      r.state = info.state || c.state
      r.since = r.state === c.state ? c.since : null
    } else {
      r.state = info.state || 'idle'
    }
  }

  // Journal entries of the shared notes, by author.
  const journal = (opts.journal || []).filter((j) => Date.parse(j.date + 'T23:59:59') >= from)
  for (const [k, j] of journal.entries()) {
    for (const id of visible) if (authorMatches(j.author, stats.get(id))) stats.get(id).journal++
    timeline.push({ key: `j${k}`, t: Date.parse(j.date + 'T12:00:00'), day: j.date, kind: 'journal', author: j.author, preview: j.text })
  }

  const rows = [...visible]
    .map((id) => stats.get(id))
    .sort((a, b) => Number(b.open) - Number(a.open) || (b.lastActivity || 0) - (a.lastActivity || 0))
  return {
    from,
    now,
    cards: cardsFor(rows),
    rows,
    timeline: timeline.sort((a, b) => b.t - a.t).slice(0, 300),
    empty: !rows.length && !timeline.length
  }
}

// The four cards, for a set of rows (the view narrows rows by agent first).
export function cardsFor(rows) {
  const open = rows.filter((r) => r.open)
  const waits = rows.flatMap((r) => r.waits || [])
  return {
    needsApproval: open.filter((r) => r.state === 'approval').length,
    working: open.filter((r) => r.state === 'working').length,
    openAgents: open.length,
    approvalWait: { median: median(waits), count: waits.length },
    messages: rows.reduce(
      (acc, r) => ({ received: acc.received + r.received, held: acc.held + r.held, skipped: acc.skipped + r.skipped }),
      { received: 0, held: 0, skipped: 0 }
    )
  }
}

// A moment as the clock time, with the date when it is not today ("now" =
// the time it is compared with, a reactive clock in views). locale: the
// interface's (the renderer's intlLocale(), see src/renderer/src/timeFormat.js).
export function formatWhen(at, now = Date.now(), locale = []) {
  const d = new Date(at)
  const time = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
  if (d.toDateString() === new Date(now).toDateString()) return time
  return `${d.toLocaleDateString(locale, { month: 'short', day: 'numeric' })} ${time}`
}

// The last folder of a path (C:\Proj\app\ -> app).
export function folderName(p) {
  const parts = String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || String(p || '')
}

// "4 min", "2 h 05", "3 d 4 h": short durations for the table. t: the
// interface's t() (English without it).
export function formatDuration(ms, t = english) {
  if (ms === null || ms === undefined) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return t('activity.duration.seconds', '{{s}} s', { s })
  const m = Math.round(s / 60)
  if (m < 60) return t('activity.duration.minutes', '{{m}} min', { m })
  const h = Math.floor(m / 60)
  if (h < 24) return t('activity.duration.hours', '{{h}} h {{mm}}', { h, mm: String(m % 60).padStart(2, '0') })
  const d = Math.floor(h / 24)
  return t('activity.duration.days', '{{d}} d {{h}} h', { d, h: h % 24 })
}
