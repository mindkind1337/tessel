// Chat panes' agent processes: one adapter per pane (claudeChat.js for
// Claude, codexChat.js for Codex, opencodeChat.js for OpenCode: the same API
// and events),
// what the window is told (chat:event), the pane's journal, and the pane's
// agent status (agentStateStore), fed from the stream since a chat process
// has no status hooks of its own.
//
// Delivery: one turn at a time. A user message goes at once when the agent
// is idle, else it waits (status 'queued') and goes right after the running
// turn ends, in order, one turn each. Team messages always wait for idle
// with no user message waiting; then all waiting team messages go as ONE
// turn. An interrupt ends the running turn only: waiting messages stay
// queued and go after it.
//
// Idle stop: a chat idle for idleMinutes (open option, 0 = never) has its
// process stopped and turns 'asleep' (no 'ended'). A message sent to it
// waits (queued) and asks the window once to open it again ('wake'); that
// open resumes the same conversation and sends what waited.
import { discoverClaudeSkills, withoutProjectSkills, publicSkillDiscovery } from './skills.js'
import { normalizeCommands } from './commands.js'
import { QUESTION_LIMITS, normalizeQuestions, validateQuestionAnswers } from './questions.js'
import { randomBytes, randomUUID as nodeUUID } from 'crypto'
import fs from 'fs'
import { isAbsolute } from 'path'
import { buildChatEnv } from './chatEnv.js'
import { clipDeep, createChatJournal, validPaneId } from './journal.js'
import { readTranscriptHistory, opencodeHistoryEvents, HISTORY_LIMITS } from './transcriptHistory.js'
import { t } from '../i18n.js'
import { approvalPreview } from '../../shared/chatApproval.js'
import { validOpencodeModel } from './opencodeChat.js'

// teamText: a team message (6000) with the window's "(message <id>, reply to
// <id>) " prefix; a longer one is cut (teamMessageText), never refused.
export const LIMITS = { text: 100000, teamPerCall: 20, teamText: 6400, teamQueue: 200, sessions: 64, historyTail: 2000 }
// As the adapter's (claudeChat.js): the CLI's --permission-mode values.
export const PERMISSION_MODES = ['default', 'bypassPermissions', 'acceptEdits', 'plan', 'auto', 'dontAsk']
// A chat capped at Manual (a worker of a Manual coordinator): never bypass,
// and for Claude never auto (it approves on its own).
export function modeAllowed(agent, mode, maxPermissions) {
  if (maxPermissions !== 'manual') return true
  if (mode === 'bypassPermissions') return false
  return !(agent !== 'codex' && mode === 'auto')
}
export const DECISIONS = ['allow', 'allowSession', 'deny']
export const AGENTS = ['claude', 'codex', 'opencode']
const ID = /^[A-Za-z0-9._:-]{1,120}$/
// Same as the orchestration / automation check; never a flag.
const FLAG = /^[A-Za-z0-9._:[\]-]{1,60}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// A Codex thread id (a UUID v7 today; codexChat's own check, at least 8
// long); never starts with '-'.
const THREAD = /^[A-Za-z0-9][A-Za-z0-9-]{7,99}$/
// An OpenCode session id (ses_ and 26 characters today).
const OPENCODE_SESSION = /^ses_[A-Za-z0-9]{20,40}$/
const STATE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const DENIED = 'The user denied this.' // i18n-ignore sent to the agent

export const validFlag = (v) => typeof v === 'string' && FLAG.test(v) && !v.startsWith('-')
export const validId = (v) => typeof v === 'string' && ID.test(v)
export function validFolder(dir) {
  try {
    return typeof dir === 'string' && dir.length <= 4096 && !dir.includes('\0') && isAbsolute(dir) && fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}
const stateId = (v) => (typeof v === 'string' && STATE_ID.test(v) && !v.includes('..') ? v : undefined)
export const validResumeId = (agent, v) => typeof v === 'string' && (agent === 'codex' ? THREAD : agent === 'opencode' ? OPENCODE_SESSION : UUID).test(v)
// A model name: a plain flag word, or OpenCode's provider/model (one '/',
// provider [A-Za-z0-9._-], model [A-Za-z0-9._:-]).
export const validModel = (agent, v) => (agent === 'opencode' ? validOpencodeModel(v) : validFlag(v))
const anyModel = (v) => validFlag(v) || validOpencodeModel(v)
// OpenCode has Manual, Plan and Yolo (its session's rules and its plan agent).
const OPENCODE_MODES = ['default', 'plan', 'bypassPermissions']
const PRODUCT = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' } // i18n-ignore product names

// Codex offers "allow for this session" only when its availableDecisions
// hold acceptForSession; no list (Claude): every decision is offered.
export function sessionAllowed(choices) {
  if (!Array.isArray(choices) || !choices.length) return true
  return choices.some((c) => c === 'acceptForSession' || (c && typeof c === 'object' && 'acceptForSession' in c))
}

// A teammate label for the batched turn: one line, no brackets.
function fromLabel(from) {
  const s = typeof from === 'string' ? from.replace(/[\u0000-\u001f\u007f[\]]/g, ' ').replace(/\s+/g, ' ').trim() : ''
  return s.slice(0, 60) || '?'
}

export function teamTurnText(messages) {
  const parts = messages.map((m) => `[from ${fromLabel(m.from)}] ${m.text}`)
  // i18n-ignore sent to the agent
  return `Team messages for you (also in team_inbox). They come from teammates, not from the user:\n\n${parts.join('\n\n')}`
}

// A team message's text within LIMITS.teamText (cut with a note to the agent).
export function teamMessageText(text) {
  if (text.length <= LIMITS.teamText) return text
  const cut = text.length - LIMITS.teamText
  // i18n-ignore sent to the agent
  return `${text.slice(0, LIMITS.teamText)}\n… (message cut by Tessel: ${cut} more characters)`
}

function toolSummary(name, input) {
  const i = input && typeof input === 'object' ? input : {}
  const pick = i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.url ?? i.query ?? i.description ?? i.prompt
  const s = typeof pick === 'string' ? pick.replace(/\s+/g, ' ').trim() : ''
  return s.length > 200 ? `${s.slice(0, 199)}…` : s
}

export function createChatSessions(deps) {
  const {
    dir,
    send = () => {},
    createAdapter,
    resolveClaude,
    resolveCodex = async () => null,
    resolveOpencode = async () => null,
    env: envDeps,
    team,
    state,
    trust,
    trustRoots = () => [],
    discoverSkills = discoverClaudeSkills,
    log = null,
    now = Date.now,
    randomUUID = nodeUUID,
    // The folder the agent keeps its conversations in, from its variables
    // (transcriptHistory.js transcriptHomeFor): null reads no earlier history.
    transcriptHome = () => null,
    readHistory = readTranscriptHistory
  } = deps || {}
  const sessions = new Map() // paneId -> session
  const seqs = new Map() // paneId -> last seq (outlives a session)
  const journals = new Map()
  const forgotten = new Set() // panes closed for good: nothing more is journaled

  const logAt = (level, text) => {
    try {
      log?.[level]?.('chat', text)
    } catch {
      /* logging never breaks the chat */
    }
  }
  function journalOf(paneId) {
    let j = journals.get(paneId)
    if (!j) {
      j = createChatJournal({ dir, paneId, now, log })
      journals.set(paneId, j)
    }
    return j
  }
  function nextSeq(paneId) {
    if (!seqs.has(paneId)) seqs.set(paneId, journalOf(paneId).lastSeq())
    const seq = seqs.get(paneId) + 1
    seqs.set(paneId, seq)
    return seq
  }
  function emit(paneId, event) {
    const seq = nextSeq(paneId)
    if (!forgotten.has(paneId)) journalOf(paneId).append(seq, event)
    try {
      send('chat:event', { paneId, seq, event })
    } catch (err) {
      logAt('warn', `send failed: ${err?.message || err}`)
    }
    return seq
  }

  // Several events at once (an imported history): each journaled with its
  // own seq, and sent to the window as ONE 'history' event holding them
  // (never announced one by one: no turn-end reminders, one redraw).
  function emitHistory(paneId, list) {
    const out = []
    for (const event of list) {
      const seq = nextSeq(paneId)
      if (!forgotten.has(paneId)) journalOf(paneId).append(seq, event)
      out.push({ seq, event })
    }
    if (!out.length) return
    try {
      send('chat:event', { paneId, seq: out[out.length - 1].seq, event: { type: 'history', events: out } })
    } catch (err) {
      logAt('warn', `send failed: ${err?.message || err}`)
    }
  }

  // A chat opened on a conversation this pane's journal does not hold yet
  // (a terminal's conversation, "Open in chat"; a resumed session id): its
  // earlier turns, read from the agent's own transcript, go into the journal
  // first, marked imported. Once: the journal's meta then names the session,
  // so a reload or a later open replays the journal, never the file again.
  function importHistory(s, env) {
    if (!s.sessionId) return
    const j = journalOf(s.paneId)
    const meta = j.readMeta()
    if (meta && meta.sessionId === s.sessionId) return
    let home = null
    try {
      home = transcriptHome(s.agent, env)
    } catch {
      home = null
    }
    if (!home) return
    let res = null
    try {
      res = readHistory({ agent: s.agent, sessionId: s.sessionId, home, now: now() })
    } catch (err) {
      logAt('warn', `${s.paneId}: earlier history not read: ${err?.message || err}`) // i18n-ignore log line
    }
    j.writeMeta({ sessionId: s.sessionId, agent: s.agent, cwd: s.cwd })
    if (!res?.ok || !Array.isArray(res.events) || !res.events.length) return
    const agentName = PRODUCT[s.agent] || 'Claude' // i18n-ignore product names
    const first = res.events[0].at
    const text = res.truncated
      ? t('main.chat.historyImportedPart', 'Earlier conversation, from the history {{agent}} keeps (only its most recent part).', { agent: agentName })
      : t('main.chat.historyImported', 'Earlier conversation, from the history {{agent}} keeps.', { agent: agentName })
    emitHistory(s.paneId, [{ type: 'notice', kind: 'info', text, imported: true, ...(Number.isFinite(first) ? { at: first } : {}) }, ...res.events])
    logAt('info', `${s.paneId}: ${res.events.length} earlier events imported${res.truncated ? ' (the most recent part)' : ''}`) // i18n-ignore log line
  }

  // OpenCode keeps its conversations in its own database: a resumed chat
  // reads its earlier turns from the server it just started (the chat's
  // password), once, like importHistory: the journal's meta then names the
  // session, so a reload or a later open replays the journal only.
  async function importOpencodeHistory(s) {
    if (!s.sessionId || typeof s.adapter?.history !== 'function') return
    const j = journalOf(s.paneId)
    const meta = j.readMeta()
    if (meta && meta.sessionId === s.sessionId) return
    let res = null
    try {
      res = await s.adapter.history()
    } catch (err) {
      logAt('warn', `${s.paneId}: earlier history not read: ${err?.message || err}`) // i18n-ignore log line
    }
    if (!res?.ok) return
    let events = opencodeHistoryEvents(res.messages)
    let truncated = res.truncated === true
    if (events.length > HISTORY_LIMITS.events) {
      events = events.slice(-HISTORY_LIMITS.events)
      truncated = true
    }
    j.writeMeta({ sessionId: s.sessionId, agent: s.agent, cwd: s.cwd })
    if (!events.length || s.finished || s.closing) return
    const first = events[0].at
    const text = truncated
      ? t('main.chat.historyImportedPart', 'Earlier conversation, from the history {{agent}} keeps (only its most recent part).', { agent: 'OpenCode' })
      : t('main.chat.historyImported', 'Earlier conversation, from the history {{agent}} keeps.', { agent: 'OpenCode' })
    emitHistory(s.paneId, [{ type: 'notice', kind: 'info', text, imported: true, ...(Number.isFinite(first) ? { at: first } : {}) }, ...events])
    logAt('info', `${s.paneId}: ${events.length} earlier OpenCode events imported${truncated ? ' (the most recent part)' : ''}`) // i18n-ignore log line
  }

  // The pane's agent status. Calls are serialized by the store in call order.
  function record(s, name, extra = {}) {
    if (!s.launchToken || !state?.recordChatEvent) return
    Promise.resolve()
      .then(() => state.recordChatEvent(s.paneId, s.launchToken, name, { sessionId: s.sessionId, ...extra }))
      .catch(() => {})
  }
  function observe(s, name) {
    if (!s.launchToken || !state?.observe) return
    Promise.resolve()
      .then(() => state.observe(s.paneId, s.launchToken, name))
      .catch(() => {})
  }

  function status(s, st, extra = {}) {
    s.status = st
    s.shownModel = s.model
    emit(s.paneId, {
      type: 'status',
      state: st,
      agent: s.agent,
      ...(s.model ? { model: s.model } : {}),
      ...(s.sessionId ? { sessionId: s.sessionId } : {}),
      ...(s.launchToken ? { launchToken: s.launchToken } : {}),
      ...extra
    })
  }
  const pendingApprovals = (s) => [...s.approvals.values()].some((a) => a.status === 'pending')
  const pendingQuestions = (s) => s.questions.size > 0
  function workStatus(s) {
    if (s.finished) return
    const st = pendingApprovals(s) ? 'approval' : s.turn || pendingQuestions(s) ? 'working' : 'idle'
    // Only changes are told (the model is part of the status too).
    if (st === s.status && s.model === s.shownModel) return
    status(s, st)
  }

  // ---- idle stop -------------------------------------------------------------
  // An idle chat's process is stopped after idleMinutes (0 = never); the
  // session stays as 'asleep' and a later open() resumes its conversation.

  const idleStoppable = (s) =>
    s.idleMinutes > 0 &&
    s.started &&
    s.ready &&
    !s.finished &&
    !s.closing &&
    !s.asleep &&
    !!s.sessionId && // nothing to resume otherwise
    !s.turn &&
    !pendingApprovals(s) &&
    !pendingQuestions(s) &&
    !s.userQueue.length &&
    !s.teamQueue.length

  // Called after every change: any activity restarts (or stops) the count.
  function idleCheck(s) {
    if (s.idleTimer) clearTimeout(s.idleTimer)
    s.idleTimer = null
    if (!idleStoppable(s)) return
    s.idleTimer = setTimeout(() => void sleep(s), s.idleMinutes * 60000)
    // Never what keeps Tessel (or a test run) alive.
    s.idleTimer.unref?.()
  }

  // Released as on a normal exit (status store, team secret), but the
  // session stays in the map and no 'ended' is told.
  async function sleep(s) {
    s.idleTimer = null
    if (!idleStoppable(s)) return
    const a = s.adapter
    s.asleep = true
    s.ready = false
    // Its exit, and anything else it still says, is ignored from now on.
    s.adapter = null
    s.wakeAsked = false
    s.tools.clear()
    s.toolAgents.clear()
    s.messages.clear()
    s.approvals.clear()
    if (s.launchToken && state?.unregister) {
      const token = s.launchToken
      Promise.resolve().then(() => state.unregister(s.paneId, token)).catch(() => {})
    }
    s.launchToken = null
    try {
      team?.revokeSecret?.(s.paneId)
    } catch {
      /* nothing to revoke */
    }
    status(s, 'asleep')
    // A wake waits for this: never two processes on one conversation.
    s.sleptAdapter = a
    s.stopping = (async () => {
      try {
        await a?.close?.()
      } catch {
        /* already gone */
      }
      s.sleptAdapter = null
    })()
    await s.stopping
  }

  // ---- turns ---------------------------------------------------------------

  function turnStarted(s) {
    if (!s.turn || s.turn.stateStarted) return
    s.turn.stateStarted = true
    record(s, 'UserPromptSubmit')
  }

  function markAccepted(s, turn) {
    if (turn.accepted) return
    turn.accepted = true
    if (turn.kind === 'user') {
      for (const id of turn.ids) emit(s.paneId, { type: 'userStatus', id, status: 'accepted' })
    } else if (turn.kind === 'team') {
      emit(s.paneId, { type: 'teamAccepted', ids: [...turn.ids] })
    }
  }
  function markFailed(s, turn) {
    if (turn.accepted || turn.failed) return
    turn.failed = true
    if (turn.kind === 'user') for (const id of turn.ids) emit(s.paneId, { type: 'userStatus', id, status: 'failed' })
    else if (turn.kind === 'team') emit(s.paneId, { type: 'teamFailed', ids: [...turn.ids] })
  }

  async function deliver(s, turn) {
    s.turn = turn
    idleCheck(s)
    if (turn.kind === 'user') for (const id of turn.ids) if (turn.wasQueued) emit(s.paneId, { type: 'userStatus', id, status: 'sent' })
    workStatus(s)
    let r
    try {
      r = await s.adapter.send({ uuid: turn.uuid, text: turn.text })
    } catch (err) {
      r = { ok: false, error: err?.message }
    }
    if (r?.ok || s.turn !== turn) return
    // Never written: the agent is not working on it.
    markFailed(s, turn)
    s.turn = null
    workStatus(s)
    pump(s)
    idleCheck(s)
  }

  // Starts the next turn when the agent is free.
  function pump(s) {
    if (!s.ready || s.finished || s.closing || s.turn || pendingApprovals(s) || pendingQuestions(s)) return
    if (s.userQueue.length) {
      const m = s.userQueue.shift()
      void deliver(s, { kind: 'user', uuid: m.id, ids: [m.id], text: m.text, wasQueued: true })
      return
    }
    if (s.teamQueue.length) {
      const batch = s.teamQueue.splice(0)
      void deliver(s, { kind: 'team', uuid: randomUUID(), ids: batch.map((m) => m.id), text: teamTurnText(batch) })
    }
  }

  // ---- adapter events --------------------------------------------------------

  function wire(s) {
    const a = s.adapter
    const on = (name, fn) =>
      a.on(name, (payload) => {
        if (s.adapter !== a) return
        try {
          fn(payload || {})
        } catch (err) {
          logAt('warn', `${name} handler: ${err?.message || err}`)
        }
      })

    on('init', (e) => {
      if (typeof e.model === 'string' && e.model && e.model !== s.model) {
        s.model = e.model
        if (s.ready) workStatus(s)
      }
    })
    on('state', (e) => {
      if (e.state !== 'running' || !s.ready) return
      if (!s.turn) {
        // A turn the agent started by itself (e.g. a background task ended).
        s.turn = { kind: 'auto', uuid: null, ids: [], accepted: true }
        workStatus(s)
        idleCheck(s)
      }
      turnStarted(s)
    })
    on('accepted', (e) => {
      if (!s.turn || !e.uuid || e.uuid !== s.turn.uuid) return
      turnStarted(s)
      markAccepted(s, s.turn)
    })
    const provenance = e => ({ ...(e.agentId ? { agentId: e.agentId } : {}), ...(e.parentToolUseId ? { parentToolUseId: e.parentToolUseId } : {}) })
    on('commands', e => emit(s.paneId, { type: 'commands', commands: normalizeCommands(e.commands) }))
    on('subagent', e => {
      emit(s.paneId, { ...e, type: 'subagent' })
      if (e.phase !== 'end' || !e.id) return
      // A settled child's tools that never reported are over too.
      for (const id of [...s.tools]) {
        const owner = s.toolAgents.get(id)
        if (owner?.agentId !== e.id) continue
        emit(s.paneId, { type: 'tool', id, status: e.status === 'completed' ? 'done' : 'error', ...owner })
        s.tools.delete(id)
        s.toolAgents.delete(id)
      }
      for (const [key, m] of [...s.messages]) if (m.agentId === e.id) s.messages.delete(key)
    })
    on('subagents', e => emit(s.paneId, { ...e, type: 'subagents' }))
    on('textDelta', (e) => {
      if (!e.messageId || (e.parentToolUseId && !e.agentId)) return
      emit(s.paneId, { type: 'assistantDelta', messageId: e.messageId, text: String(e.text ?? ''), ...provenance(e) })
    })
    on('assistant', (e) => {
      const sub = typeof e.parentToolUseId === 'string' && e.parentToolUseId ? e.parentToolUseId : null
      const blocks = Array.isArray(e.blocks) ? e.blocks : []
      const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('')
      const thinking = blocks.filter((b) => b?.type === 'thinking').map((b) => b.text).join('\n')
      // Canonical child provenance lets the renderer group these separately.
      if ((!sub || e.agentId) && e.messageId && (text || thinking)) {
        // The CLI sends one frame per content block, all with the message's
        // id: the renderer gets the message's text so far, merged.
        const messageKey = JSON.stringify([e.agentId || '', e.messageId])
        let m = s.messages.get(messageKey)
        if (!m) {
          if (s.messages.size >= 200) s.messages.delete(s.messages.keys().next().value)
          m = { text: '', thinking: '', ...(e.agentId ? { agentId: e.agentId } : {}) }
          s.messages.set(messageKey, m)
        }
        if (thinking) {
          m.thinking = m.thinking ? `${m.thinking}\n${thinking}` : thinking
          emit(s.paneId, { type: 'thinking', messageId: e.messageId, text: m.thinking, ...provenance(e) })
        }
        if (text) {
          m.text = m.text ? `${m.text}\n\n${text}` : text
          emit(s.paneId, { type: 'assistant', messageId: e.messageId, text: m.text, ...provenance(e) })
        }
      }
      for (const b of blocks) {
        if (b?.type !== 'tool_use' || !b.id) continue
        s.tools.add(b.id)
        if (e.agentId) s.toolAgents.set(b.id, provenance(e))
        emit(s.paneId, {
          type: 'tool',
          id: b.id,
          name: String(b.name || ''),
          summary: toolSummary(b.name, b.input),
          input: clipDeep(b.input ?? {}),
          status: 'running',
          ...provenance(e)
        })
      }
    })
    on('toolResult', (e) => {
      if (!e.toolUseId) return
      s.tools.delete(e.toolUseId)
      const owner = s.toolAgents.get(e.toolUseId) || provenance(e)
      s.toolAgents.delete(e.toolUseId)
      emit(s.paneId, { type: 'toolResult', id: e.toolUseId, isError: e.isError === true, text: String(e.text ?? ''), ...owner })
    })
    on('question', (e) => {
      if (!validId(e.requestId) || s.questions.has(e.requestId)) return
      const questions = normalizeQuestions(e.questions, 'normalized')
      if (!questions || s.closing || s.finished || s.questions.size >= QUESTION_LIMITS.pending) {
        void a.answerQuestion?.(e.requestId, { cancel: true })
        return
      }
      s.questions.set(e.requestId, { questions, sending: false })
      turnStarted(s)
      emit(s.paneId, { type: 'question', requestId: e.requestId, questions, status: 'pending' })
      workStatus(s)
      idleCheck(s)
    })
    on('questionStatus', (e) => {
      settleQuestion(s, e.requestId, e.status, e.answers)
    })
    on('permission', (e) => {
      if (!e.requestId || s.approvals.has(e.requestId)) return
      const toolId = stateId(e.toolUseId) || stateId(e.requestId)
      const input = e.input && typeof e.input === 'object' ? e.input : {}
      // What the card shows (its first characters) and how much it hides: an
      // input with hidden characters is allowed only once the window fetched
      // it whole (chat:approvalInput), since the whole input is what runs.
      const { detail, hidden } = approvalPreview(input)
      // Codex's availableDecisions: the window offers only these.
      const choices = Array.isArray(e.choices) ? clipDeep(e.choices.slice(0, 20)) : null
      s.approvals.set(e.requestId, { status: 'pending', toolId, input, hidden, fetched: false, choices })
      turnStarted(s)
      emit(s.paneId, {
        type: 'approval',
        requestId: e.requestId,
        toolName: String(e.toolName || ''),
        displayName: String(e.displayName || e.toolName || ''),
        input: clipDeep(input),
        detail,
        hidden,
        sessionRules: Array.isArray(e.sessionRules) ? clipDeep(e.sessionRules.slice(0, 50)) : [],
        description: String(e.description || ''),
        ...(choices ? { choices } : {}),
        status: 'pending'
      })
      record(s, 'PermissionRequest', { toolId })
      record(s, 'Notification', { toolId, notificationType: 'permission_prompt' })
      workStatus(s)
      idleCheck(s)
    })
    on('permissionCancelled', (e) => {
      const ap = s.approvals.get(e.requestId)
      if (!ap || ap.status !== 'pending') return
      ap.status = 'cancelled'
      ap.input = null
      emit(s.paneId, { type: 'approvalStatus', requestId: e.requestId, status: 'cancelled' })
      if (!s.finished) {
        record(s, 'PostToolUse', { toolId: ap.toolId })
        workStatus(s)
        idleCheck(s)
      }
    })
    on('turnEnd', (e) => {
      cancelQuestions(s)
      const turn = s.turn
      if (turn && !turn.accepted) {
        const uuids = Array.isArray(e.userMessageUuids) ? e.userMessageUuids : []
        if (turn.uuid && uuids.includes(turn.uuid)) markAccepted(s, turn)
        else markFailed(s, turn)
      }
      if (turn) turnStarted(s)
      const st = ['completed', 'interrupted', 'failed'].includes(e.status) ? e.status : 'failed'
      s.lastInterrupted = st === 'interrupted'
      const why = e.result || e.error
      const error = st === 'failed' && why ? String(typeof why === 'object' ? why.message || JSON.stringify(why) : why).slice(0, 4000) : ''
      emit(s.paneId, {
        type: 'turnEnd',
        status: st,
        ...(e.usage ? { usage: e.usage } : {}),
        ...(typeof e.costUsd === 'number' ? { costUsd: e.costUsd } : {}),
        ...(typeof e.durationMs === 'number' ? { durationMs: e.durationMs } : {}),
        ...(error ? { error } : {})
      })
      // A Codex or OpenCode turn can fail with no text of its own (content
      // filter, usage limit, a provider error): said plainly; the queue goes
      // on below.
      if (st === 'failed' && (s.agent === 'codex' || s.agent === 'opencode')) {
        emit(s.paneId, {
          type: 'notice',
          kind: 'error',
          text: error
            ? t('main.chat.turnFailed', 'The turn failed: {{error}}', { error })
            : t('main.chat.turnFailedNoReason', 'The turn failed.')
        })
      }
      // Tools of the turn that never reported a result. A sub-agent's
      // (agentId) are left open: a background child goes on after the
      // parent's turn and reports them later (or its roster settles it).
      for (const id of [...s.tools]) {
        if (s.toolAgents.get(id)?.agentId) continue
        emit(s.paneId, { type: 'tool', id, status: st === 'completed' ? 'done' : 'error', ...s.toolAgents.get(id) })
        s.tools.delete(id)
        s.toolAgents.delete(id)
      }
      for (const [key, m] of [...s.messages]) if (!m.agentId) s.messages.delete(key)
      for (const [requestId, ap] of s.approvals) {
        if (ap.status !== 'pending') continue
        ap.status = 'cancelled'
        ap.input = null
        emit(s.paneId, { type: 'approvalStatus', requestId, status: 'cancelled' })
      }
      record(s, st === 'completed' ? 'Stop' : st === 'interrupted' ? 'Interrupt' : 'StopFailure')
      // No settling wait: the result frame is the turn's end.
      observe(s, 'ScreenReady')
      s.turn = null
      workStatus(s)
      pump(s)
      idleCheck(s)
    })
    on('rateLimit', (e) => {
      emit(s.paneId, {
        type: 'rateLimit',
        ...(e.fiveHour ? { fiveHour: e.fiveHour } : {}),
        ...(e.sevenDay ? { sevenDay: e.sevenDay } : {})
      })
    })
    on('authError', () => {
      if (!s.ready) return // the start result reports it
      emit(s.paneId, {
        type: 'notice',
        kind: 'error',
        text:
          s.agent === 'codex'
            ? t('main.chat.codexAuthError', 'Codex is not signed in (or its sign-in expired). Sign in, then reopen this chat.')
            : s.agent === 'opencode'
              ? t('main.chat.opencodeAuthError', 'OpenCode has no working sign-in for this provider. Run opencode auth login, then reopen this chat.')
              : t('main.chat.authError', 'Claude is not signed in (or its sign-in expired). Sign in, then reopen this chat.')
      })
    })
    // Manual: Codex reported another posture mid-chat (the adapter closes it).
    on('postureError', () => {
      emit(s.paneId, {
        type: 'notice',
        kind: 'error',
        text:
          s.agent === 'opencode'
            ? t('main.chat.opencodePostureChanged', 'OpenCode no longer applied the Manual permissions (ask before changes and commands): the turn was stopped and the chat closed.')
            : t('main.chat.codexPostureChanged', 'Codex no longer applied the Manual permissions (ask first, sandboxed): the turn was stopped and the chat closed.')
      })
    })
    on('stderr', (e) => logAt('info', `${s.paneId} stderr: ${String(e.text || '').slice(-500)}`))
    on('exit', (e) => finish(s, e))
  }

  // The process is gone (or given up on): everything tied to it is released.
  function settleQuestion(s, requestId, status, answers) {
    const q = s.questions.get(requestId)
    if (!q || !['answered', 'cancelled'].includes(status)) return
    const clean = status === 'answered' ? validateQuestionAnswers(q.questions, answers) : null
    s.questions.delete(requestId)
    emit(s.paneId, { type: 'questionStatus', requestId, status: clean ? 'answered' : 'cancelled', ...(clean ? { answers: clean } : {}) })
    workStatus(s)
    idleCheck(s)
  }

  function cancelQuestions(s) {
    for (const requestId of [...s.questions.keys()]) {
      // Resolve even an adapter request whose provider turn id did not match
      // the turnEnd. Settle locally first so a synchronous callback is harmless.
      settleQuestion(s, requestId, 'cancelled')
      try {
        Promise.resolve(s.adapter?.answerQuestion?.(requestId, { cancel: true })).catch(() => {})
      } catch { /* adapter already stopped */ }
    }
  }

  function finish(s, e = {}) {
    if (s.finished) return
    s.finished = true
    cancelQuestions(s)
    if (s.idleTimer) clearTimeout(s.idleTimer)
    s.idleTimer = null
    if (s.turn) markFailed(s, s.turn)
    s.turn = null
    failQueued(s)
    for (const [requestId, ap] of s.approvals) {
      if (ap.status !== 'pending') continue
      ap.status = 'cancelled'
      ap.input = null
      emit(s.paneId, { type: 'approvalStatus', requestId, status: 'cancelled' })
    }
    if (s.launchToken && state?.unregister) Promise.resolve().then(() => state.unregister(s.paneId, s.launchToken)).catch(() => {})
    if (sessions.get(s.paneId) === s) {
      sessions.delete(s.paneId)
      try {
        team?.revokeSecret?.(s.paneId)
      } catch {
        /* nothing to revoke */
      }
    }
    if (!s.started) return // a failed start reports its own status
    const normal =
      s.closing || (typeof e.crashed === 'boolean' ? !e.crashed : e.code === 0 || (e.code === 1 && s.lastInterrupted))
    if (normal) status(s, 'ended')
    else {
      const tail = typeof e.stderrTail === 'string' ? e.stderrTail.trim().slice(-2000) : ''
      status(s, 'crashed', {
        error: t('main.chat.crashed', 'The agent stopped unexpectedly (exit code {{code}}).', { code: String(e.code ?? e.signal ?? '?') }),
        ...(tail ? { detail: tail } : {})
      })
    }
  }

  // ---- API -------------------------------------------------------------------

  // Shown text by the adapter's start failure code (its own text is English).
  function startError(code, agent) {
    if (agent === 'opencode') {
      if (code === 'signin') return t('main.chat.opencodeSignin', 'OpenCode has no provider signed in. Run opencode auth login, then try again.')
      if (code === 'spawn') return t('main.chat.opencodeSpawnFailed', 'OpenCode could not be started.')
      if (code === 'timeout') return t('main.chat.opencodeStartTimeout', 'OpenCode did not answer in time.')
      if (code === 'exit') return t('main.chat.opencodeExitedAtStart', 'OpenCode stopped while starting.')
      if (code === 'posture') return t('main.chat.opencodePosture', 'OpenCode did not confirm the Manual permissions (ask before changes and commands, for every agent): the chat was not opened.')
      if (code === 'auth') return t('main.chat.opencodeAuthNotEnforced', 'OpenCode answered without its password: the chat was not opened.')
      if (code === 'version') return t('main.chat.opencodeVersion', 'This OpenCode is older than {{version}}, the version Tessel was tested with. Update OpenCode, then try again.', { version: '1.18.33' })
      return t('main.chat.startFailed', 'The agent could not start.')
    }
    if (agent === 'codex') {
      if (code === 'signin') return t('main.chat.codexSignin', 'Codex is not signed in. Sign in to Codex, then try again.')
      if (code === 'spawn') return t('main.chat.codexSpawnFailed', 'Codex could not be started.')
      if (code === 'timeout') return t('main.chat.codexStartTimeout', 'Codex did not answer in time.')
      if (code === 'exit') return t('main.chat.codexExitedAtStart', 'Codex stopped while starting.')
      if (code === 'posture') return t('main.chat.codexPosture', 'Codex did not confirm the Manual permissions (ask first, sandboxed): the chat was not opened.')
      return t('main.chat.startFailed', 'The agent could not start.')
    }
    if (code === 'signin') return t('main.chat.signin', 'Claude is not signed in. Sign in to Claude Code, then try again.')
    if (code === 'spawn') return t('main.chat.spawnFailed', 'Claude Code could not be started.')
    if (code === 'timeout') return t('main.chat.startTimeout', 'Claude Code did not answer in time.')
    if (code === 'exit') return t('main.chat.exitedAtStart', 'Claude Code stopped while starting.')
    return t('main.chat.startFailed', 'The agent could not start.')
  }

  function current(s) {
    return { ok: true, agent: s.agent, sessionId: s.sessionId, launchToken: s.launchToken, model: s.model || null }
  }

  // from: internal, the asleep session this open wakes (see below).
  async function open(opts = {}, from = null) {
    const { paneId, cwd, projectDir, resumeId, model, effort, accountEnv, askTrust, envOpts } = opts
    let { permissions = 'manual', permissionMode } = opts
    const agent = opts.agent ?? 'claude'
    const idleMinutes = opts.idleMinutes ?? 30
    const asleep = !from && validPaneId(paneId) ? sessions.get(paneId) : null
    if (asleep?.asleep) {
      // Waking: its own conversation, folder and agent; the permissions and
      // variables are the caller's (read again from the settings at each open).
      if ((opts.agent != null && opts.agent !== asleep.agent) || (resumeId != null && resumeId !== asleep.sessionId))
        return { ok: false, code: 'busy', error: t('main.chat.asleepOther', 'This pane holds another conversation (asleep). Close it first.') }
      return open(
        {
          ...opts,
          agent: asleep.agent,
          cwd: asleep.cwd,
          projectDir: asleep.projectDir || undefined,
          resumeId: asleep.sessionId,
          model: model ?? (validModel(asleep.agent, asleep.model) ? asleep.model : undefined),
          effort: effort ?? (validFlag(asleep.effort) ? asleep.effort : undefined)
        },
        asleep
      )
    }
    // A worker never runs with more than its coordinator (maxPermissions).
    // A wake keeps the cap of the session it wakes.
    const capped = opts.maxPermissions === 'manual' || from?.maxPermissions === 'manual'
    if (opts.maxPermissions != null && !capped)
      return { ok: false, code: 'invalid', error: t('main.chat.invalid', 'Invalid chat request.') }
    if (capped) {
      if (permissions === 'yolo') permissions = 'manual'
      if (permissionMode != null && !modeAllowed(agent, permissionMode, 'manual')) permissionMode = 'default'
    }
    if (
      !Number.isInteger(idleMinutes) ||
      idleMinutes < 0 ||
      idleMinutes > 1440 ||
      !validPaneId(paneId) ||
      !AGENTS.includes(agent) ||
      !validFolder(cwd) ||
      (projectDir != null && projectDir !== '' && !validFolder(projectDir)) ||
      (resumeId != null && !validResumeId(agent, resumeId)) ||
      (model != null && !validModel(agent, model)) ||
      (effort != null && !validFlag(effort)) ||
      !['yolo', 'manual'].includes(permissions) ||
      (permissionMode != null && !PERMISSION_MODES.includes(permissionMode))
    )
      return { ok: false, code: 'invalid', error: t('main.chat.invalid', 'Invalid chat request.') }

    const existing = sessions.get(paneId)
    if (existing && existing !== from) {
      // Live (a remounted pane opening again): harmless, the running session.
      if (!existing.closing && !existing.finished) return existing.ready ? current(existing) : existing.opening
      return { ok: false, code: 'busy', error: t('main.chat.busy', 'This chat is still closing.') }
    }
    if (resumeId && [...sessions.values()].some((x) => x !== from && x.agent === agent && x.sessionId === resumeId))
      return { ok: false, code: 'busy', error: t('main.chat.sessionOpen', 'This conversation is already open in another pane.') }
    // A wake takes its asleep session's place.
    if (!from && sessions.size >= LIMITS.sessions)
      return { ok: false, code: 'failed', error: t('main.chat.tooMany', 'Too many chats are open.') }

    // Placeholder first: a second open meanwhile shares this start.
    const s = {
      paneId,
      agent,
      adapter: null,
      // Codex and OpenCode name a new conversation themselves: known once it started.
      sessionId: resumeId || (agent === 'codex' || agent === 'opencode' ? null : randomUUID()),
      launchToken: null,
      model: model || null,
      effort: effort || null,
      permissions,
      maxPermissions: capped ? 'manual' : null,
      permissionMode: null,
      cwd,
      projectDir: projectDir || null,
      worker: opts.worker === true,
      status: 'starting',
      ready: false,
      closing: false,
      finished: false,
      turn: null,
      // A wake goes on with what was sent while it was asleep.
      userQueue: from ? from.userQueue : [],
      teamQueue: from ? from.teamQueue : [],
      approvals: new Map(),
      questions: new Map(),
      tools: new Set(),
      toolAgents: new Map(),
      messages: new Map(), // messageId -> { text, thinking } merged so far
      lastInterrupted: false,
      started: false,
      idleMinutes,
      idleTimer: null,
      asleep: false,
      resumed: !!from
    }
    sessions.set(paneId, s)
    forgotten.delete(paneId)
    const closedWhileStarting = () => ({
      ok: false,
      code: 'failed',
      error: t('main.chat.closedWhileStarting', 'The chat was closed while it started.')
    })
    const drop = () => {
      if (sessions.get(paneId) === s) sessions.delete(paneId)
    }

    // One start per pane: a second open while it starts gets the same result.
    s.opening = (async () => {
      // The asleep process first ends: never two on one conversation.
      if (from?.stopping) await from.stopping
      let roots = []
      try {
        roots = trustRoots(cwd, { worker: opts.worker === true }) || []
      } catch {
        roots = []
      }
      if (!trust?.isTrusted(cwd, roots)) {
        const yes = askTrust === true && trust?.ask ? await trust.ask(cwd) : false
        if (s.closing) return closedWhileStarting()
        if (!yes) {
          drop()
          emit(paneId, { type: 'status', state: 'untrusted', agent })
          return { ok: false, code: 'untrusted', error: t('main.chat.untrusted', 'This folder is not trusted for chat agents yet.') }
        }
      }

      if (s.closing) return closedWhileStarting()
      let found = null
      try {
        found = await (agent === 'codex' ? resolveCodex() : agent === 'opencode' ? resolveOpencode() : resolveClaude())
      } catch {
        found = null
      }
      if (s.closing) return closedWhileStarting()
      if (!found || typeof found.exe !== 'string' || !found.exe) {
        drop()
        const error =
          agent === 'codex'
            ? t('main.chat.noCodex', 'Codex was not found. Install it, then try again.')
            : agent === 'opencode'
              ? t('main.chat.noOpencode', 'OpenCode was not found. Install it, then try again.')
              : t('main.chat.noClaude', 'Claude Code was not found. Install it, then try again.')
        emit(paneId, { type: 'status', state: 'crashed', agent, error })
        return { ok: false, code: `no-${agent}`, error }
      }

      emit(paneId, { type: 'status', state: 'starting', agent, ...(s.sessionId ? { sessionId: s.sessionId } : {}) })
      const teamSecret = team.newSecret()
      let base = envDeps.forPane({ paneId, cwd, projectDir: s.projectDir, accountEnv, ...(envOpts || {}) })
      if (base && typeof base === 'object' && base.env && typeof base.env === 'object') base = base.env
      const childEnv = buildChatEnv(base, { agent, paneId, teamSecret, projectDir: s.projectDir, pathEnv: found.pathEnv })
      // A resumed conversation: its earlier turns first (never on a wake).
      if (resumeId && !from) importHistory(s, childEnv)
      const common = {
        agent,
        exe: found.exe,
        exeArgs: Array.isArray(found.exeArgs) ? found.exeArgs : [],
        cwd,
        env: childEnv,
        ...(s.model ? { model: s.model } : {}),
        ...(s.effort ? { effort: s.effort } : {}),
        log
      }
      const permissionModeUsed = permissions === 'yolo' ? 'bypassPermissions' : permissionMode && permissionMode !== 'bypassPermissions' ? permissionMode : 'default'
      s.permissionMode = permissionModeUsed

      try {
        // Codex: the adapter maps yolo/manual to its approval policy and
        // sandbox, sent explicitly with every thread and turn.
        // OpenCode: yolo/manual set the session's own rules (Yolo is then
        // the only way to its bypass); Plan is its plan agent.
        s.adapter = createAdapter(
          agent === 'codex'
            ? { ...common, ...(resumeId ? { threadId: resumeId } : {}), permissions }
            : agent === 'opencode'
              ? { ...common, ...(resumeId ? { sessionId: resumeId } : {}), permissions, ...(permissionModeUsed === 'plan' ? { permissionMode: 'plan' } : {}) }
              : { ...common, ...(resumeId ? { resume: resumeId } : { sessionId: s.sessionId }), permissionMode: permissionModeUsed }
        )
      } catch (err) {
        drop()
        const error = String(err?.message || err)
        emit(paneId, { type: 'status', state: 'crashed', agent, error })
        return { ok: false, code: 'failed', error }
      }
      // Before the start: the team tools may call in as soon as they are up.
      team.setSecret(paneId, teamSecret)
      wire(s)

      let r
      try {
        r = await s.adapter.start()
      } catch (err) {
        r = { ok: false, code: 'failed', error: String(err?.message || err) }
      }
      if (s.closing) {
        // close() ran meanwhile and already reported the end.
        if (!s.finished) finish(s, { code: 0 })
        return { ok: false, code: 'failed', error: t('main.chat.closedWhileStarting', 'The chat was closed while it started.') }
      }
      if (!r?.ok) {
        s.finished = true
        if (sessions.get(paneId) === s) {
          sessions.delete(paneId)
          try {
            team.revokeSecret(paneId)
          } catch {
            /* nothing to revoke */
          }
        }
        try {
          await s.adapter.close?.()
        } catch {
          /* already gone */
        }
        const signin = r?.code === 'signin'
        const error = startError(r?.code, agent)
        // The adapter's own text (stderr tail) is internal English: a detail.
        const detail = typeof r?.error === 'string' && r.error ? r.error.slice(-2000) : undefined
        emit(paneId, { type: 'status', state: signin ? 'signin' : 'crashed', agent, error, ...(detail ? { detail } : {}) })
        return { ok: false, code: signin ? 'signin' : 'failed', error, ...(detail ? { detail } : {}) }
      }
      s.started = true
      if (agent === 'codex') {
        const info = r.info && typeof r.info === 'object' ? r.info : {}
        // The thread Codex runs (a resume keeps its id): what a reopen resumes.
        if (validResumeId('codex', info.threadId)) s.sessionId = info.threadId
        else if (!s.sessionId) logAt('warn', `${paneId}: codex gave no thread id; this chat cannot be resumed`)
        if (typeof info.model === 'string' && validFlag(info.model)) s.model = info.model
      }
      if (agent === 'opencode') {
        const info = r.info && typeof r.info === 'object' ? r.info : {}
        // The session OpenCode runs (a resume keeps its id): what a reopen resumes.
        if (validResumeId('opencode', info.sessionId)) s.sessionId = info.sessionId
        else if (!s.sessionId) logAt('warn', `${paneId}: opencode gave no session id; this chat cannot be resumed`)
        if (typeof info.model === 'string' && validOpencodeModel(info.model)) s.model = info.model
        if (typeof info.version === 'string') logAt('info', `${paneId}: opencode ${info.version.slice(0, 40)}`) // i18n-ignore log line
        // A resumed conversation: its earlier turns first (never on a wake).
        if (resumeId && !from) await importOpencodeHistory(s)
      }
      s.launchToken = randomBytes(16).toString('hex')
      if (!s.finished) {
        try {
          await state?.register?.({ paneId, provider: agent, launchToken: s.launchToken, startedAt: now() })
          record(s, 'SessionStart')
          observe(s, 'ScreenReady')
        } catch (err) {
          logAt('warn', `${paneId}: agent status unavailable: ${err?.message || err}`)
        }
      }
      journalOf(paneId).writeMeta({ sessionId: s.sessionId, agent, cwd })
      if (s.finished || s.closing) {
        // Gone (or closed) while its status was being registered.
        if (state?.unregister) Promise.resolve().then(() => state.unregister(paneId, s.launchToken)).catch(() => {})
        if (!s.finished) finish(s, { code: 0 })
        return { ok: false, code: 'failed', error: t('main.chat.startFailed', 'The agent could not start.') }
      }
      s.ready = true
      status(s, 'idle')
      pump(s)
      idleCheck(s)
      return current(s)
    })().then((r) => {
      // A failed wake: what waited for it will not go.
      if (!r?.ok) failQueued(s)
      return r
    })
    return s.opening
  }

  function failQueued(s) {
    for (const m of s.userQueue) emit(s.paneId, { type: 'userStatus', id: m.id, status: 'failed' })
    s.userQueue = []
    if (s.teamQueue.length) emit(s.paneId, { type: 'teamFailed', ids: s.teamQueue.map((m) => m.id) })
    s.teamQueue = []
  }

  function live(paneId) {
    const s = sessions.get(paneId)
    return s && s.ready && !s.finished && !s.closing ? s : null
  }
  const closed = () => ({ ok: false, code: 'closed', error: t('main.chat.notOpen', 'This chat is not running.') })
  // Asleep, or woken and still starting: a message waits for the process.
  function waiting(paneId) {
    const s = sessions.get(paneId)
    return s && !s.finished && !s.closing && (s.asleep || (s.resumed && !s.ready)) ? s : null
  }
  // Told once per sleep: the window opens the chat again (chat:open).
  function askWake(s) {
    if (!s.asleep || s.wakeAsked) return
    s.wakeAsked = true
    emit(s.paneId, { type: 'wake' })
  }

  // A user message (origin 'user'); team messages go through sendTeam.
  function sendUser({ paneId, text } = {}) {
    const s = live(paneId) || waiting(paneId)
    if (!s) return closed()
    const id = randomUUID()
    const now_ = now()
    const idle = s.ready && !s.turn && !pendingApprovals(s) && !pendingQuestions(s) && !s.userQueue.length
    emit(paneId, { type: 'user', id, text, origin: 'user', status: idle ? 'sent' : 'queued', at: now_ })
    if (idle) void deliver(s, { kind: 'user', uuid: id, ids: [id], text })
    else s.userQueue.push({ id, text })
    askWake(s)
    idleCheck(s)
    return { ok: true, id, queued: !idle }
  }

  function sendTeam({ paneId, messages } = {}) {
    const s = live(paneId) || waiting(paneId)
    if (!s) return closed()
    const known = new Set([...s.teamQueue.map((m) => m.id), ...(s.turn?.kind === 'team' ? s.turn.ids : [])])
    const added = []
    for (const m of messages) {
      if (known.has(m.id) || s.teamQueue.length >= LIMITS.teamQueue) continue
      known.add(m.id)
      s.teamQueue.push({ id: m.id, from: m.from, text: m.text })
      added.push(m.id)
      emit(paneId, { type: 'user', id: m.id, text: m.text, origin: 'team', from: fromLabel(m.from), status: 'queued', at: now() })
    }
    pump(s)
    if (added.length) askWake(s)
    idleCheck(s)
    return { ok: true, ids: added }
  }

  async function interrupt({ paneId } = {}) {
    const s = live(paneId)
    if (!s) return closed()
    cancelQuestions(s)
    try {
      const r = await s.adapter.interrupt()
      return { ok: !!r?.ok }
    } catch {
      return { ok: false }
    }
  }

  async function answer({ paneId, requestId, answers, cancel = false } = {}) {
    if (!validPaneId(paneId) || !validId(requestId) || typeof cancel !== 'boolean' || (cancel && answers !== undefined)) return invalid()
    const s = live(paneId)
    if (!s) return closed()
    const q = s.questions.get(requestId)
    if (!q || q.sending) return { ok: false, code: 'unknown', error: t('main.chat.noQuestion', 'This question was already answered or is gone.') }
    const clean = cancel ? null : validateQuestionAnswers(q.questions, answers)
    if (!cancel && !clean) return invalid()
    q.sending = true
    let r
    try { r = await s.adapter.answerQuestion(requestId, cancel ? { cancel: true } : { answers: clean }) } catch { r = { ok: false } }
    // The adapter usually emitted its terminal event already. A close/turn end
    // during the write wins: never resurrect a stale question or retry its reply.
    if (s.questions.get(requestId) === q) settleQuestion(s, requestId, r?.ok && !cancel ? 'answered' : 'cancelled', clean)
    pump(s)
    if (!r?.ok) return { ok: false, code: 'failed', error: t('main.chat.answerFailed', 'The answer could not be sent.') }
    return { ok: true }
  }

  async function approve({ paneId, requestId, decision, message } = {}) {
    const s = live(paneId)
    if (!s) return closed()
    const ap = s.approvals.get(requestId)
    if (!ap || ap.status !== 'pending')
      return { ok: false, code: 'unknown', error: t('main.chat.noApproval', 'This request was already answered or is gone.') }
    if (decision === 'allowSession' && !sessionAllowed(ap.choices))
      return { ok: false, code: 'invalid', error: t('main.chat.notOffered', 'The agent does not offer this choice here.') }
    if (decision !== 'deny' && ap.hidden > 0 && !ap.fetched)
      return { ok: false, code: 'unseen', error: t('main.chat.inputUnseen', 'Show the whole input before allowing it.') }
    const answer =
      decision === 'deny'
        ? { behavior: 'deny', session: false, message: typeof message === 'string' && message.trim() ? message.trim() : DENIED }
        : { behavior: 'allow', session: decision === 'allowSession' }
    // Marked first: a second click while this one is on its way is refused.
    ap.status = decision === 'deny' ? 'denied' : decision === 'allowSession' ? 'allowedSession' : 'allowed'
    let r
    try {
      r = await s.adapter.answerPermission(requestId, answer)
    } catch (err) {
      r = { ok: false, error: err?.message }
    }
    if (!r?.ok) {
      if (ap.status !== 'cancelled') ap.status = 'pending'
      return { ok: false, code: 'failed', error: r?.error || t('main.chat.answerFailed', 'The answer could not be sent.') }
    }
    ap.input = null
    emit(paneId, { type: 'approvalStatus', requestId, status: ap.status })
    // PostToolUse with the request's tool id resolves the pending approval in
    // the status reducer (PreToolUse would leave it pending).
    record(s, 'PostToolUse', { toolId: ap.toolId })
    workStatus(s)
    pump(s)
    idleCheck(s)
    return { ok: true }
  }

  // A pending approval's whole input (the card shows its first characters).
  function approvalInput({ paneId, requestId } = {}) {
    const s = live(paneId)
    if (!s) return closed()
    const ap = s.approvals.get(requestId)
    if (!ap || ap.status !== 'pending' || !ap.input)
      return { ok: false, code: 'unknown', error: t('main.chat.noApproval', 'This request was already answered or is gone.') }
    ap.fetched = true
    return { ok: true, input: ap.input }
  }

  async function setOption({ paneId, model, effort, permissionMode } = {}) {
    const z = sessions.get(paneId)
    if (z?.asleep && permissionMode == null) {
      // Kept for the wake (a model or effort the caller does not give then).
      if (model != null) z.model = model
      if (effort != null) z.effort = effort
      return { ok: true, model: z.model, effort: z.effort }
    }
    const s = live(paneId)
    if (!s) return closed()
    const results = []
    if (model != null && !validModel(s.agent, model)) results.push(false)
    else if (model != null) {
      const r = await s.adapter.setModel(model).catch(() => ({ ok: false }))
      if (r?.ok) s.model = model
      results.push(!!r?.ok)
    }
    if (effort != null) {
      const r = await s.adapter.setEffort(effort).catch(() => ({ ok: false }))
      if (r?.ok) s.effort = effort
      results.push(!!r?.ok)
    }
    if (permissionMode != null) {
      // Bypass needs the launch flag: only a 'yolo' launch may switch to it.
      if (permissionMode === 'bypassPermissions' && s.permissions !== 'yolo') results.push(false)
      // A worker capped at its coordinator's Manual: never a permissive mode.
      else if (!modeAllowed(s.agent, permissionMode, s.maxPermissions)) results.push(false)
      // Codex has two (the adapter maps them): bypassPermissions = yolo,
      // default = manual; plan / acceptEdits do not exist there.
      else if (s.agent === 'codex' && !['bypassPermissions', 'default'].includes(permissionMode)) results.push(false)
      else if (s.agent === 'opencode' && !OPENCODE_MODES.includes(permissionMode)) results.push(false)
      else {
        const ok = !!(await s.adapter.setPermissionMode(permissionMode).catch(() => ({ ok: false })))?.ok
        if (ok) s.permissionMode = permissionMode
        results.push(ok)
      }
    }
    if (model != null && s.ready) workStatus(s)
    // permissions: what the chat runs with now (a coordinator's workers get no more).
    return { ok: results.every(Boolean), model: s.model, effort: s.effort, permissionMode: s.permissionMode, permissions: s.permissionMode === 'bypassPermissions' ? 'yolo' : 'manual' }
  }

  // forget: the pane is closed for good (its journal is deleted). kill:
  // Tessel quits (the adapter kills the process tree at once).
  async function close({ paneId, forget = false, kill = false } = {}) {
    const s = sessions.get(paneId)
    if (forget) forgotten.add(paneId)
    if (s && !s.finished) {
      s.closing = true
      cancelQuestions(s)
      try {
        await s.adapter?.close?.(kill ? { kill: true } : undefined)
        // Asleep: no process, unless Tessel quits while it still stops.
        if (kill) await s.sleptAdapter?.close?.({ kill: true })
      } catch {
        /* killed or already gone */
      }
      // An adapter normally reports its exit; the chat ends here either way.
      if (!s.started) {
        s.finished = true
        if (sessions.get(paneId) === s) {
          sessions.delete(paneId)
          try {
            team?.revokeSecret?.(paneId)
          } catch {
            /* nothing to revoke */
          }
        }
        emit(paneId, { type: 'status', state: 'ended' })
      } else finish(s, { code: 0 })
    }
    // Unless a new chat opened in this pane meanwhile.
    if (forget && validPaneId(paneId) && forgotten.has(paneId) && !sessions.has(paneId)) {
      journalOf(paneId).remove()
      journals.delete(paneId)
      seqs.delete(paneId)
    }
    return { ok: true }
  }

  function closeAll({ kill = true } = {}) {
    return Promise.all([...sessions.keys()].map((paneId) => close({ paneId, kill })))
  }

  // tail: only the last N events, read from the end of the journal
  // (team_worker_read needs no more).
  function history({ paneId, tail } = {}) {
    if (!validPaneId(paneId)) return { ok: false, code: 'invalid', events: [], seq: 0, open: false }
    const j = journalOf(paneId)
    const events = tail ? j.readTail(tail) : j.read()
    if (!seqs.has(paneId)) seqs.set(paneId, events.length ? events[events.length - 1].seq : 0)
    const s = sessions.get(paneId)
    return {
      ok: true,
      events,
      seq: seqs.get(paneId),
      meta: j.readMeta(),
      commands: j.readCommands(),
      // Authoritative live requests for remounts, even after journal rotation.
      // Empty after restart: recorded questions can never become answerable again.
      questions: s && !s.closing && !s.finished ? [...s.questions].map(([requestId, q]) => ({ type: 'question', requestId, questions: q.questions, status: 'pending' })) : [],
      // A live session (starting, idle, working, approval): do not open it again.
      open: !!s && !s.finished && !s.closing && !s.asleep,
      // Asleep (its process stopped when idle): open false, live set (status
      // 'asleep'), so a remounted pane does not start it; chat:open resumes
      // it when needed (a message sent to it asks with a 'wake' event).
      asleep: !!s?.asleep,
      live: s
        ? { status: s.status, agent: s.agent, sessionId: s.sessionId, launchToken: s.launchToken, model: s.model, queued: s.userQueue.length + s.teamQueue.length }
        : null
    }
  }

  async function skills({ paneId, refresh = false }) {
    const s = sessions.get(paneId)
    const unavailable = () => ({ ok: false, error: t('main.chat.skillsUnavailable', 'Skill discovery is unavailable.') })
    if (!s || s.closing || s.finished) return unavailable()
    let roots
    try {
      roots = trustRoots(s.cwd, { worker: s.worker === true }) || []
      if (!trust?.isTrusted(s.cwd, roots)) return unavailable()
    } catch { return unavailable() }
    const checked = value => {
      try {
        const currentRoots = trustRoots(s.cwd, { worker: s.worker === true }) || []
        if (sessions.get(paneId) !== s || s.closing || s.finished || !trust.isTrusted(s.cwd, currentRoots)) return unavailable()
        const result = s.projectDir && !trust.isTrusted(s.projectDir, currentRoots)
          ? withoutProjectSkills(value.result, s.projectDir, s.cwd) : value.result
        s.skillCache = { ok: true, result }
        return { ok: true, result: publicSkillDiscovery(result) }
      } catch { return unavailable() }
    }
    if (s.skillScan) return s.skillScan
    if (!refresh && s.skillCache) return checked(s.skillCache)
    s.skillScan = Promise.resolve().then(async () => {
      try {
        const result = s.agent === 'codex' || s.agent === 'opencode'
          ? await s.adapter?.skills?.({ refresh })
          : { ok: true, result: await discoverSkills({ cwd: s.cwd, projectDir: s.projectDir && trust.isTrusted(s.projectDir, roots) ? s.projectDir : undefined }) }
        if (!result?.ok) return unavailable()
        return checked(result)
      } catch (error) {
        return error.code === 'SKILL_SCAN_BUSY' && s.skillCache ? checked(s.skillCache) : unavailable()
      }
      finally { s.skillScan = null }
    })
    return s.skillScan
  }

  function list() {
    return [...sessions.values()].map((s) => ({ paneId: s.paneId, agent: s.agent, sessionId: s.sessionId, status: s.status, model: s.model, launchToken: s.launchToken }))
  }

  // ---- IPC -------------------------------------------------------------------

  const invalid = () => ({ ok: false, code: 'invalid', error: t('main.chat.invalid', 'Invalid chat request.') })
  const obj = (q) => (q && typeof q === 'object' && !Array.isArray(q) ? q : {})
  const okText = (s, max) => typeof s === 'string' && s.trim().length > 0 && s.length <= max

  function register(ipcMain) {
    ipcMain.handle('chat:open', (_e, q) => {
      const o = obj(q)
      // Minutes idle before its process is stopped (0 = never).
      if (o.idleMinutes != null && !(Number.isInteger(o.idleMinutes) && o.idleMinutes >= 0 && o.idleMinutes <= 1440)) return invalid()
      // Only these fields: never a command. The variables come as for a
      // terminal pane (pty:create): Settings > Agents and the provider
      // account's, checked by paneEnv (names only, never TESSEL_*).
      return open({
        idleMinutes: o.idleMinutes ?? undefined,
        paneId: o.paneId,
        agent: o.agent,
        cwd: o.cwd,
        projectDir: o.projectDir || undefined,
        resumeId: o.resumeId || undefined,
        model: o.model || undefined,
        effort: o.effort || undefined,
        permissions: o.permissions,
        permissionMode: o.permissionMode || undefined,
        maxPermissions: o.maxPermissions === 'manual' ? 'manual' : undefined,
        worker: o.worker === true,
        askTrust: o.askTrust === true,
        envOpts: { extraEnv: o.extraEnv, accountEnv: o.accountEnv, unsetEnv: Array.isArray(o.unsetEnv) ? o.unsetEnv.filter((n) => typeof n === 'string').slice(0, 50) : [] }
      })
    })
    ipcMain.handle('chat:send', (_e, q) => {
      const { paneId, text } = obj(q)
      if (!validPaneId(paneId) || !okText(text, LIMITS.text)) return invalid()
      return sendUser({ paneId, text })
    })
    ipcMain.handle('chat:sendTeam', (_e, q) => {
      const { paneId, messages } = obj(q)
      if (!validPaneId(paneId) || !Array.isArray(messages) || !messages.length || messages.length > LIMITS.teamPerCall) return invalid()
      // One bad message is skipped (a long one is cut): never the whole
      // batch, which the window would send again and again.
      const clean = []
      for (const m of messages) {
        const x = obj(m)
        if (!validId(x.id) || !okText(x.text, LIMITS.text) || (x.from != null && typeof x.from !== 'string')) continue
        clean.push({ id: x.id, from: typeof x.from === 'string' ? x.from.slice(0, 200) : '', text: teamMessageText(x.text) })
      }
      if (!clean.length) return invalid()
      return sendTeam({ paneId, messages: clean })
    })
    ipcMain.handle('chat:interrupt', (_e, q) => {
      const { paneId } = obj(q)
      if (!validPaneId(paneId)) return invalid()
      return interrupt({ paneId })
    })
    ipcMain.handle('chat:answer', (_e, q) => {
      const { paneId, requestId, answers, cancel } = obj(q)
      return answer({ paneId, requestId, answers, cancel })
    })
    ipcMain.handle('chat:approve', (_e, q) => {
      const { paneId, requestId, decision, message } = obj(q)
      if (!validPaneId(paneId) || !validId(requestId) || !DECISIONS.includes(decision)) return invalid()
      if (message != null && (typeof message !== 'string' || message.length > LIMITS.teamText)) return invalid()
      return approve({ paneId, requestId, decision, message })
    })
    ipcMain.handle('chat:approvalInput', (_e, q) => {
      const { paneId, requestId } = obj(q)
      if (!validPaneId(paneId) || !validId(requestId)) return invalid()
      return approvalInput({ paneId, requestId })
    })
    ipcMain.handle('chat:setOption', (_e, q) => {
      const { paneId, model, effort, permissionMode } = obj(q)
      if (!validPaneId(paneId)) return invalid()
      if (model != null && !anyModel(model)) return invalid()
      if (effort != null && !validFlag(effort)) return invalid()
      if (permissionMode != null && !PERMISSION_MODES.includes(permissionMode)) return invalid()
      if (model == null && effort == null && permissionMode == null) return invalid()
      return setOption({ paneId, model, effort, permissionMode })
    })
    ipcMain.handle('chat:close', (_e, q) => {
      const { paneId, forget } = obj(q)
      if (!validPaneId(paneId)) return invalid()
      return close({ paneId, forget: forget === true })
    })
    ipcMain.handle('chat:skills', (_e, q) => {
      const { paneId, refresh } = obj(q)
      if (!validPaneId(paneId) || (refresh != null && typeof refresh !== 'boolean')) return invalid()
      return skills({ paneId, refresh: refresh === true })
    })
    ipcMain.handle('chat:history', (_e, q) => {
      const { paneId, tail } = obj(q)
      if (!validPaneId(paneId)) return invalid()
      if (tail != null && !(Number.isSafeInteger(tail) && tail > 0 && tail <= LIMITS.historyTail)) return invalid()
      return history({ paneId, ...(tail ? { tail } : {}) })
    })
  }

  return { open, send: sendUser, sendTeam, interrupt, answer, approve, approvalInput, setOption, close, closeAll, history, skills, list, register }
}
