// Conversations of the agents: what the agents of a team said to each other,
// and what you and an agent said to each other through Tessel, as threads
// read from the activity log (src/shared/activity.js). Pure ESM, no Vue: the
// Conversations tab (ConversationsPanel.vue) shows what is built here, tests
// check it.
//
// The events read (recorded by App.vue with recordActivity):
//   message   what Tessel gave an agent: yours (source 'you': typed in its
//             chat, the notes, a review, your decision on a card), a lead's
//             brief (source 'lead'), another agent's through the team channel
//             (source 'agent', scope 'team-chat'), or a Tessel notice
//             (source 'tessel'). paneId is the recipient; from, the sender's
//             name when it is not you.
//   reply     what an agent said that Tessel did not type anywhere: its
//             answer in its chat (kind 'chat'), a decision it asks you
//             (kind 'decision'), its report on a card (kind 'report'). paneId
//             is the speaker; toPaneId/to, the agent it addresses (else you).
//
// What you and an agent said in its terminal (opts.terminal of buildThreads,
// read from the agent's own conversation file by the main process,
// src/main/chat/terminalConversations.js): lines of your thread with it,
// marked via: 'terminal', each with the model and effort it ran with when the
// file says so. One that repeats what Tessel gave the agent (a message it
// typed there, already a line of the log) or Tessel's record of its answer is
// left out.
//
// A line: { key, t, kind: 'message' | 'reply' | 'notice', from: who, to: who,
//           toAll?: [who] (a team message: every recipient, to being the first),
//           text, preview, status, readCount?, replyKind?, taskTitle?, outcome?,
//           wsId, teamId, sender? (who sent it, as Tessel recorded it:
//           senderIdentity.js), via?: 'terminal', run?: { model, modelId,
//           effort } (a terminal line: the model it ran with), images?,
//           imagesMore?, files? (a terminal line's: see terminalLines) }
//   who: { kind: 'you' | 'agent' | 'tessel', label, paneId: string | null,
//          agentId: string | null (the agent program: claude, codex, ..., for its logo) }
// A thread: { key, kind: 'team' | 'user', teamId, paneId, wsId, title,
//             participants: [label], lines, last, count }
//   'team:<teamId>'  everything said between the agents of a team
//   'you:<paneId>'   everything said between you and one agent

import { english } from './i18nText'
import { cleanSender } from './senderIdentity'
import { modelLabel } from './modelLabel'

export const PREVIEW_LENGTH = 160
export const MAX_LINES_PER_THREAD = 2000
// A team message to several teammates ("team", a group) is kept once per
// recipient: copies of the same text by the same sender this close together
// are one message with several recipients.
export const BROADCAST_MS = 5000

export const preview = (text) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, PREVIEW_LENGTH)

const isWho = (w) => !!w && typeof w === 'object'
const you = (t = english) => ({ kind: 'you', label: t('conversations.you', 'You'), paneId: null, agentId: null })
const tessel = () => ({ kind: 'tessel', label: 'Tessel', paneId: null, agentId: null })
const agentWho = (label, paneId, t = english, agentId = null) => ({
  kind: 'agent',
  label: String(label || '').trim() || t('conversations.anAgent', 'An agent'),
  paneId: typeof paneId === 'string' && paneId ? paneId : null,
  agentId: typeof agentId === 'string' && agentId ? agentId : null
})

// The agents an older log names only by name (the sender of a team message
// recorded before the sender's pane was kept): the pane and program they had
// where the log knows them as a pane in the same team (a recipient, a
// speaker, a sender kept since), so their logo and pane are found too. Names
// are reused across projects, so a name is only trusted within its team.
function knownAgents(events) {
  const known = new Map() // "<teamId>|<name>" -> { paneId, agentId }
  const learn = (teamId, label, paneId, agentId) => {
    const name = String(label || '').trim()
    if (!name || typeof paneId !== 'string' || !paneId) return
    const key = `${teamId || ''}|${name}` // i18n-ignore
    const k = known.get(key) || { paneId: null, agentId: null }
    // The latest pane wins (a name can be reused by a later pane).
    k.paneId = paneId
    if (agentId) k.agentId = agentId
    known.set(key, k)
  }
  for (const e of events) {
    if (e.agent) learn(e.teamId, e.agent.title, e.paneId, e.agent.agentId)
    const s = senderOf(e)
    if (s && s.paneId) learn(e.teamId, e.from || s.name, s.paneId, s.agentId)
    else if (e.fromPaneId) learn(e.teamId, e.from, e.fromPaneId, e.fromAgentId)
  }
  return (teamId, label) => known.get(`${teamId || ''}|${String(label || '').trim()}`) || null // i18n-ignore
}

// The sender as Tessel recorded it from the sending pane (src/shared/
// senderIdentity.js: its pane, agent, model…), on team messages since that
// record exists; null on older ones.
const senderOf = (e) => (e && e.sender && typeof e.sender === 'object' ? e.sender : null)

// A Tessel notice as shown: without its "[Tessel] " tag.
const noticeText = (text) => String(text || '').replace(/^\[Tessel\]\s*/, '')

// The lines of the log, oldest first, as what was said and to whom. A held
// message that was then delivered (or seen unconfirmed) stays one line with
// its final status.
// opts.t: the interface's t() (English without it)
export function conversationLines(events, opts = {}) {
  const t = opts.t || english
  const sorted = (events || []).filter((e) => e && Number.isFinite(e.t) && (e.type === 'message' || e.type === 'reply')).sort((a, b) => a.t - b.t)
  const lines = []
  const known = knownAgents(sorted)
  // The sender of a team message: as recorded (its pane, its program), else
  // by its name within the team when an older log has that.
  const sender = (e) => {
    const s = senderOf(e)
    if (s && s.paneId) return agentWho(e.from || s.name, s.paneId, t, s.agentId || (known(e.teamId, e.from) || {}).agentId)
    if (e.fromPaneId) return agentWho(e.from, e.fromPaneId, t, e.fromAgentId || (known(e.teamId, e.from) || {}).agentId)
    const k = known(e.teamId, e.from)
    return k ? agentWho(e.from, k.paneId, t, k.agentId) : agentWho(e.from, null, t)
  }
  // paneId + text -> the line a later status event updates
  const open = new Map()
  // team + sender + text -> the team message its other copies join
  const broadcasts = new Map()
  for (const [i, e] of sorted.entries()) {
    const text = String(e.text || e.preview || '')
    if (!text) continue
    const paneId = typeof e.paneId === 'string' ? e.paneId : null
    const title = e.agent && e.agent.title ? e.agent.title : ''
    const agentId = e.agent && e.agent.agentId ? e.agent.agentId : (known(e.teamId, title) || {}).agentId || null
    const base = { key: `c${i}`, t: e.t, wsId: e.wsId || null, teamId: e.teamId || null } // i18n-ignore
    if (e.type === 'reply') {
      const toAgent = typeof e.toPaneId === 'string' && e.toPaneId ? agentWho(e.to, e.toPaneId, t, (known(e.teamId, e.to) || {}).agentId) : null
      lines.push({
        ...base,
        kind: 'reply',
        replyKind: ['chat', 'decision', 'report'].includes(e.kind) ? e.kind : 'chat',
        from: agentWho(title, paneId, t, agentId),
        to: toAgent || you(t),
        text,
        preview: e.preview || preview(text),
        status: 'sent',
        ...(e.taskTitle ? { taskTitle: String(e.taskTitle) } : {}),
        ...(e.outcome ? { outcome: String(e.outcome) } : {}),
        // Its speaker as Tessel recorded it (the model it ran with).
        ...(senderOf(e) ? { sender: senderOf(e) } : {})
      })
      continue
    }
    const status = typeof e.status === 'string' ? e.status : 'sent'
    const slot = `${paneId}|${text}` // i18n-ignore
    // Confirmation of a message already listed: its status moves on.
    if (status === 'delivered' || status === 'unconfirmed') {
      const line = open.get(slot)
      if (line) {
        line.status = status === 'delivered' ? 'sent' : 'unconfirmed'
        if (status === 'delivered') open.delete(slot)
        continue
      }
      if (status === 'delivered') continue
    }
    const to = agentWho(title, paneId, t, agentId)
    let line
    if (e.source === 'tessel') {
      line = { ...base, kind: 'notice', from: tessel(), to, text: noticeText(text), preview: preview(noticeText(text)), status, scope: e.scope || null }
    } else if (e.scope === 'team-chat') {
      const from = sender(e)
      const key = `${e.teamId || ''}|${from.paneId || from.label}|${text}` // i18n-ignore
      const same = broadcasts.get(key)
      if (same && e.t - same.t <= BROADCAST_MS && !same.toAll.some((w) => w.label === to.label && w.paneId === to.paneId)) {
        same.toAll.push(to)
        if (status === 'read') same.readCount++
        same.status = same.readCount === same.toAll.length ? 'read' : same.readCount ? 'partly' : 'unread'
        continue
      }
      line = { ...base, kind: 'message', from, to, toAll: [to], readCount: status === 'read' ? 1 : 0, text, preview: e.preview || preview(text), status, scope: e.scope, ...(senderOf(e) ? { sender: senderOf(e) } : {}) }
      broadcasts.set(key, line)
    } else if (e.source === 'agent' || e.source === 'lead') {
      line = { ...base, kind: 'message', from: sender(e), to, text, preview: e.preview || preview(text), status, scope: e.scope || null, ...(e.source === 'lead' ? { lead: true } : {}), ...(senderOf(e) ? { sender: senderOf(e) } : {}) }
    } else {
      line = { ...base, kind: 'message', from: you(t), to, text, preview: e.preview || preview(text), status, scope: e.scope || null, ...(e.taskTitle ? { taskTitle: String(e.taskTitle) } : {}) }
    }
    if (status === 'held' || status === 'sent') open.set(slot, line)
    lines.push(line)
  }
  return lines
}

// Who a line goes to: every recipient of a team message, else its one.
export const recipients = (line) => (line.toAll && line.toAll.length ? line.toAll : [line.to])

// --- What was said in an agent's terminal ---------------------------------------------
// entries: [{ paneId, group?, wsId, title, agentId, agentName?, sessionId?,
//   host?: 'local' | 'ssh', hostLabel?, items: [{ role: 'user' | 'agent', t,
//   text, model?, effort?, images?, imagesMore?, files? }] }] (group: one
//   conversation of the pane, its pane's id by default: a pane's earlier
//   conversation has its own; images, files: terminalConversations.js
//   attachImages', carried to the line as they are)
// opts.effortLabel(effort) -> its name in the interface ("High"); opts.t.
// A prompt goes from you to the agent, an answer from the agent to you; an
// answer carries the agent as its sender, with the model it ran with (shown
// like a team message's sender); a prompt, that model as run.
export function terminalLines(entries, opts = {}) {
  const t = opts.t || english
  const effortName = typeof opts.effortLabel === 'function' ? opts.effortLabel : (e) => e
  const lines = []
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry.paneId !== 'string' || !entry.paneId || !Array.isArray(entry.items)) continue
    const seen = new Map()
    const group = typeof entry.group === 'string' && entry.group ? entry.group : entry.paneId
    for (const it of entry.items) {
      if (!it || !Number.isFinite(it.t) || typeof it.text !== 'string') continue
      // A prompt that was only an image (or a file) has no text: kept for them.
      const images = Array.isArray(it.images) && it.images.length ? it.images : null
      const files = Array.isArray(it.files) && it.files.length ? it.files : null
      if (!it.text.trim() && !images && !files) continue
      const agent = agentWho(entry.title, entry.paneId, t, entry.agentId || null)
      const mine = it.role === 'user'
      const modelId = typeof it.model === 'string' ? it.model : ''
      const effort = modelId && typeof it.effort === 'string' ? it.effort : ''
      const run = modelId ? { model: `${modelLabel(modelId)}${effort ? ` · ${effortName(effort)}` : ''}`, modelId, ...(effort ? { effort } : {}) } : null
      // The same time twice: the keys stay apart.
      const base = `tm:${group}:${it.t}:${mine ? 'u' : 'a'}` // i18n-ignore
      const n = seen.get(base) || 0
      seen.set(base, n + 1)
      const sender =
        !mine && run
          ? cleanSender({
              paneId: entry.paneId,
              name: agent.label,
              agentId: entry.agentId || '',
              agentName: entry.agentName || '',
              model: run.model,
              modelId: run.modelId,
              effort: run.effort || '',
              sessionId: entry.sessionId || '',
              ...(entry.host === 'ssh' || entry.host === 'local' ? { host: entry.host } : {}),
              hostLabel: entry.hostLabel || ''
            })
          : null
      lines.push({
        key: n ? `${base}:${n}` : base,
        t: it.t,
        wsId: entry.wsId || null,
        teamId: null,
        kind: mine ? 'message' : 'reply',
        ...(mine ? {} : { replyKind: 'chat' }),
        from: mine ? you(t) : agent,
        to: mine ? agent : you(t),
        text: it.text,
        preview: preview(it.text),
        status: 'sent',
        scope: null,
        via: 'terminal',
        group,
        ...(entry.host === 'ssh' ? { remote: true } : {}),
        ...(run ? { run } : {}),
        ...(sender ? { sender } : {}),
        ...(images ? { images } : {}),
        ...(Number.isInteger(it.imagesMore) && it.imagesMore > 0 ? { imagesMore: it.imagesMore } : {}),
        ...(files ? { files } : {})
      })
    }
  }
  return lines
}

// A message Tessel typed into a terminal is a line of the log (logged when it
// was queued: it may wait hours before it is typed) and a prompt in the
// agent's file; an answer Tessel recorded (a chat's) is in both too. Same
// pane, same words (spaces and image marks aside: the file says "[Image #1]",
// the log does not; the first 2000 characters: the log keeps 8000), typed
// from just before to ECHO_AFTER_MS after it was logged: one line, the log's.
// The closest pairs go first (a "continue" you typed at 9:00 is not the one
// Tessel sent at 13:00), each logged message pairs once. When that message
// was not yours (a lead's brief, a teammate's, a Tessel notice), the agent's
// answer to it in its terminal is theirs, not yours: left out too.
// An agent on an SSH host writes its host's clock, which may be off by a few
// minutes: its prompt may come up to SKEW_MAX_MS before the message it
// repeats. When at least SKEW_MATCHES of its prompts repeat Tessel's own
// deliveries (never your messages: you may type the same words) and agree
// within SKEW_SPREAD_MS on how far behind the host is, its lines move by that
// (the lower middle of those gaps, SKEW_MAX_MS at most, never past now),
// keeping their order among themselves.
export const ECHO_BEFORE_MS = 2 * 60 * 1000
export const ECHO_AFTER_MS = 12 * 3600 * 1000
export const SKEW_MAX_MS = 30 * 60 * 1000
export const SKEW_SPREAD_MS = 2 * 60 * 1000
export const SKEW_MATCHES = 3
const echoKey = (s) =>
  String(s || '')
    .replace(/\[Image #\d+\]|\[image\]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2000)
// opts.now: no line moves past it (Date.now() by default).
export function withoutEchoes(terminal, logged, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now()
  const pool = new Map() // "<u|a>|<paneId>|<words>" -> [{ at, yours, tessel, used }]
  const add = (key, entry) => {
    const list = pool.get(key)
    if (list) list.push(entry)
    else pool.set(key, [entry])
  }
  for (const l of logged || []) {
    if (l.via === 'terminal') continue
    const words = echoKey(l.text)
    if (!words) continue
    if (l.kind === 'reply') {
      if (l.from.paneId) add(`a|${l.from.paneId}|${words}`, { at: l.t, yours: true, tessel: false, used: false }) // i18n-ignore
      continue
    }
    if (l.status === 'skipped' || l.status === 'failed') continue
    const yours = l.from.kind === 'you'
    for (const w of recipients(l)) if (w.paneId) add(`u|${w.paneId}|${words}`, { at: l.t, yours, tessel: !yours, used: false }) // i18n-ignore
  }
  const listOf = (l) => {
    const words = echoKey(l.text)
    return words ? pool.get(`${l.kind === 'reply' ? 'a' : 'u'}|${l.kind === 'reply' ? l.from.paneId : l.to.paneId}|${words}`) : null // i18n-ignore
  }
  // Each conversation's lines, in their order.
  const groups = new Map()
  for (const l of terminal || []) {
    const g = l.group || (l.kind === 'reply' ? l.from.paneId : l.to.paneId)
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g).push(l)
  }
  const out = []
  for (const lines of groups.values()) {
    // gap: the line's time less the log's (a host's may be behind).
    const pairs = []
    lines.forEach((l, i) => {
      for (const m of listOf(l) || []) {
        const gap = l.t - m.at
        const earliest = l.remote ? -(SKEW_MAX_MS + ECHO_BEFORE_MS) : -ECHO_BEFORE_MS
        if (gap >= earliest && gap <= ECHO_AFTER_MS) pairs.push({ i, m, gap })
      }
    })
    pairs.sort((a, b) => Math.abs(a.gap) - Math.abs(b.gap))
    const matched = new Map() // line index -> { m, gap }
    for (const pair of pairs) {
      if (matched.has(pair.i) || pair.m.used) continue
      pair.m.used = true
      matched.set(pair.i, pair)
    }
    let shift = 0
    if (lines[0].remote) {
      const behind = [...matched.values()]
        .filter((x) => x.m.tessel && x.gap < -ECHO_BEFORE_MS)
        .map((x) => -x.gap)
        .sort((a, b) => a - b)
      for (let k = 0; k + SKEW_MATCHES <= behind.length; k++) {
        let last = k
        while (last + 1 < behind.length && behind[last + 1] - behind[k] <= SKEW_SPREAD_MS) last++
        if (last - k + 1 < SKEW_MATCHES) continue
        shift = Math.min(SKEW_MAX_MS, behind[k + Math.floor((last - k) / 2)])
        break
      }
      if (shift) {
        const latest = Math.max(...lines.map((l) => l.t))
        shift = Math.max(0, Math.min(shift, now - latest))
      }
    }
    // Its latest prompt was someone else's message: its answers go.
    let notYours = false
    lines.forEach((raw, i) => {
      const hit = matched.get(i)
      if (raw.kind !== 'reply') notYours = !!hit && !hit.m.yours
      if (hit || (raw.kind === 'reply' && notYours)) return
      out.push(shift ? { ...raw, t: raw.t + shift } : raw)
    })
  }
  return out
}

// Which thread a line belongs to: the team's when it goes between agents in
// a team (or is a team notice), else yours with the agent concerned.
export function threadKeyOf(line) {
  const betweenAgents = line.from.kind === 'agent' && line.to.kind === 'agent'
  if (line.kind === 'notice') return line.teamId ? `team:${line.teamId}` : `you:${line.to.paneId || ''}` // i18n-ignore
  if (betweenAgents && line.teamId) return `team:${line.teamId}` // i18n-ignore
  const pane = line.from.kind === 'agent' ? line.from.paneId : line.to.paneId
  return `you:${pane || ''}` // i18n-ignore
}

// The threads, latest first.
//   opts.t         the interface's t()
//   opts.teams     [{ id, name }] for the team threads' titles
//   opts.panes     { [paneId]: { title, agentId } } open now: their names
//                  win over the ones recorded
//   opts.wsId      only what happened in this workspace (null: everywhere)
//   opts.from      only lines from this time on
//   opts.notices   keep Tessel's notices (false: left out)
//   opts.terminal  what was said in the agents' terminals (terminalLines'
//                  entries), merged in time with the log's lines
//   opts.effortLabel: see terminalLines; opts.now: see withoutEchoes
export function buildThreads(events, opts = {}) {
  const t = opts.t || english
  const panes = opts.panes || {}
  const teams = new Map((opts.teams || []).map((x) => [x.id, x]))
  const threads = new Map()
  const logged = conversationLines(events, { t })
  const said = opts.terminal && opts.terminal.length ? withoutEchoes(terminalLines(opts.terminal, opts), logged, { now: opts.now }) : []
  // Oldest first; the log's line first at the same time.
  const all = said.length ? [...logged, ...said].sort((a, b) => a.t - b.t) : logged
  for (const line of all) {
    if (opts.wsId && line.wsId && line.wsId !== opts.wsId) continue
    if (Number.isFinite(opts.from) && line.t < opts.from) continue
    if (line.kind === 'notice' && !opts.notices) continue
    for (const who of [line.from, ...recipients(line)]) {
      const pane = who.paneId ? panes[who.paneId] : null
      if (!pane) continue
      if (pane.title) who.label = pane.title
      if (pane.agentId && !who.agentId) who.agentId = pane.agentId
    }
    const key = threadKeyOf(line)
    let thread = threads.get(key)
    if (!thread) {
      const team = key.startsWith('team:') ? key.slice(5) : null
      const paneId = team ? null : key.slice(4) || null
      thread = {
        key,
        kind: team ? 'team' : 'user',
        teamId: team,
        paneId,
        wsId: line.wsId || null,
        title: '',
        participants: [],
        lines: [],
        last: 0,
        count: 0
      }
      threads.set(key, thread)
    }
    thread.lines.push(line)
    thread.last = Math.max(thread.last, line.t)
    if (!thread.wsId && line.wsId) thread.wsId = line.wsId
    for (const who of [line.from, ...recipients(line)]) if (who.kind === 'agent' && !thread.participants.includes(who.label)) thread.participants.push(who.label)
  }
  const out = []
  for (const thread of threads.values()) {
    if (thread.lines.length > MAX_LINES_PER_THREAD) thread.lines = thread.lines.slice(-MAX_LINES_PER_THREAD)
    thread.count = thread.lines.length
    if (thread.kind === 'team') {
      const team = teams.get(thread.teamId)
      thread.title = team && team.name ? team.name : t('conversations.formerTeam', 'A former team')
      thread.color = team && team.color ? team.color : null
    } else {
      const agent = thread.lines.map((l) => (l.from.kind === 'agent' ? l.from : l.to)).find((w) => w.kind === 'agent')
      thread.agent = agent ? agent.label : t('conversations.anAgent', 'An agent')
      // Its pane open now, else the program the lines name (a pane closed).
      thread.agentId = (agent && agent.paneId && panes[agent.paneId] && panes[agent.paneId].agentId) || (agent && agent.agentId) || null
      thread.title = t('conversations.withAgent', 'You and {{agent}}', { agent: thread.agent })
    }
    out.push(thread)
  }
  return out.sort((a, b) => b.last - a.last)
}

// The threads whose lines match: a text (in what was said, who said it, the
// thread's title) and a participant's name. A thread keeps only its
// matching lines when a query is given.
export function filterThreads(threads, { query = '', participant = '' } = {}) {
  const q = String(query || '').trim().toLowerCase()
  const who = String(participant || '').trim()
  if (!q && !who) return threads
  const out = []
  for (const thread of threads) {
    if (who && !thread.participants.includes(who)) continue
    if (!q) {
      out.push(thread)
      continue
    }
    const titleHit = thread.title.toLowerCase().includes(q)
    const lines = thread.lines.filter((l) => titleHit || l.text.toLowerCase().includes(q) || l.from.label.toLowerCase().includes(q) || recipients(l).some((w) => w.label.toLowerCase().includes(q)))
    if (!lines.length) continue
    out.push({ ...thread, lines, count: lines.length, matched: !titleHit })
  }
  return out
}

// Every agent named in the threads, for a filter.
export function participantsOf(threads) {
  const set = new Set()
  for (const thread of threads) for (const p of thread.participants) set.add(p)
  return [...set].sort((a, b) => a.localeCompare(b))
}

// How many lines, across the threads.
export const lineCount = (threads) => threads.reduce((n, th) => n + th.lines.length, 0)

// The model a line was said with ("Opus 5.5 · High"): its sender's as Tessel
// recorded it (a team message, an answer in a terminal), else the one a
// terminal line ran with; '' when unknown.
export function modelOf(line) {
  const s = line && line.sender && typeof line.sender === 'object' ? line.sender : null
  const r = line && line.run && typeof line.run === 'object' ? line.run : null
  return (s && (s.model || s.modelId)) || (r && (r.model || r.modelId)) || ''
}

// A line's status as text ('' when it reached its reader normally).
export function statusText(line, t = english) {
  switch (line.status) {
    case 'held':
      return t('conversations.status.held', 'waiting to be sent')
    case 'skipped':
      return t('conversations.status.skipped', 'not sent: usage limit')
    case 'failed':
      return t('conversations.status.failed', 'not sent')
    case 'unconfirmed':
      return t('conversations.status.unconfirmed', 'sent, not seen taken')
    case 'unread':
      return t('conversations.status.unread', 'not read yet')
    case 'partly':
      return t('conversations.status.partly', 'read by {{read}} of {{total}}', { read: line.readCount, total: recipients(line).length })
    default:
      return ''
  }
}

// What a reply is, as text ('' for a plain chat answer).
export function replyText(line, t = english) {
  if (line.kind !== 'reply') return ''
  if (line.replyKind === 'decision') return t('conversations.reply.decision', 'asks you to decide')
  if (line.replyKind === 'report')
    return line.outcome === 'failed' ? t('conversations.reply.reportFailed', 'reports: could not finish') : t('conversations.reply.report', 'reports: done')
  return ''
}

// A thread as plain text, to copy: one line per message, oldest first.
// locale: for the times (the interface's intlLocale()).
export function threadText(thread, { t = english, locale = [] } = {}) {
  const when = (at) => {
    const d = new Date(at)
    return `${d.toLocaleDateString(locale, { year: 'numeric', month: '2-digit', day: '2-digit' })} ${d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}`
  }
  const head = thread.kind === 'team' ? t('conversations.export.team', 'Team "{{name}}"', { name: thread.title }) : thread.title
  const body = thread.lines.map((l) => {
    const note = [
      replyText(l, t),
      statusText(l, t),
      l.taskTitle ? t('conversations.onCard', 'on "{{title}}"', { title: l.taskTitle }) : '',
      l.via === 'terminal' ? t('conversations.terminal.note', 'in its terminal') : '',
      modelOf(l)
    ]
      .filter(Boolean)
      .join(', ')
    return `[${when(l.t)}] ${l.from.label} → ${recipients(l).map((w) => w.label).join(', ')}${note ? ` (${note})` : ''}:\n${l.text}`
  })
  return [head, '', ...body].join('\n')
}
