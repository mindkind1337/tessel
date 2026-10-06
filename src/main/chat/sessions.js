// Chat panes' agent processes: one adapter per pane (claudeChat.js for
// Claude, codexChat.js for Codex, opencodeChat.js for OpenCode: the same API
// and events),
// what the window is told (chat:event), the pane's journal, and the pane's
// agent status (agentStateStore), fed from the stream since a chat process
// has no status hooks of its own.
//
// Delivery: a user message goes at once when the agent is idle. While a
// Claude or Codex turn runs it goes at once too, as in a terminal ('steered'):
// the agent folds it into the running turn (Claude at its next step, Codex
// through turn/steer) or runs it right after as a turn of its own. Otherwise
// (OpenCode, an approval or a question pending, a compaction, a "/command",
// messages already waiting) it waits (status 'queued') and goes right after
// the running turn ends, in order, one turn each. Team messages always wait
// for idle with no user message waiting; then all waiting team messages go as
// ONE turn. An interrupt ends the running turn only: waiting messages stay
// queued and go after it (Claude runs a steered one it had not taken yet
// after it too; Codex drops it with the turn, and its row says failed).
//
// Idle stop: a chat idle for idleMinutes (open option, 0 = never) has its
// process stopped and turns 'asleep' (no 'ended'). A message sent to it
// waits (queued) and asks the window once to open it again ('wake'); that
// open resumes the same conversation and sends what waited.
//
// Held messages (chat:send with hold, the chat pane's): a message sent while
// the agent cannot take it at once waits in userQueue as a card above the
// composer ('queuedMessage', never a transcript row) that the user can edit,
// delete or send now (steered into the running turn, Claude and Codex). It
// becomes a 'user' row only when it goes out (where it goes out), or a failed
// one if the chat ends first. After Orca's host-owned queue of mid-turn
// messages (MIT, Copyright (c) 2026 Lovecast Inc.).
import { discoverClaudeSkills, withoutProjectSkills, publicSkillDiscovery } from './skills.js'
import { normalizeCommands } from './commands.js'
import { QUESTION_LIMITS, normalizeQuestions, validateQuestionAnswers } from './questions.js'
import { randomBytes, randomUUID as nodeUUID } from 'crypto'
import fs from 'fs'
import { isAbsolute } from 'path'
import { buildChatEnv } from './chatEnv.js'
import { clipDeep, createChatJournal, validPaneId } from './journal.js'
import { readTranscriptHistory, readOlderHistory, opencodeHistoryEvents, resolveHistoryAttachments, findTranscript, ATTACHMENT_LIMITS, HISTORY_LIMITS } from './transcriptHistory.js'
import { t } from '../i18n.js'
import { approvalPreview } from '../../shared/chatApproval.js'
import { validOpencodeModel } from './opencodeChat.js'
import { isRemotePath, parseRemotePath, remoteRoot } from '../../shared/remotePath.js'
import { cleanRemoteEnv, killRemoteChild } from './remoteProcess.js'
import { readRemoteHistory, remoteTranscriptExists } from './remoteTranscripts.js'

// teamText: a team message (6000) with the window's "(message <id>, reply to
// <id>) " prefix; a longer one is cut (teamMessageText), never refused.
// A steered message the agent never starts: failed after this (its row can
// still turn 'accepted' if the agent takes it later).
export const STEER_WAIT_MS = 60000
// OpenCode's history with its user messages' images and files (resolved per page).
const OPENCODE_HISTORY = { ...HISTORY_LIMITS, attachments: ATTACHMENT_LIMITS }
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
// A folder on an SSH host (ssh://<hostId>/path) -> { hostId, path, root }
// (root: its normalized virtual path), or null.
export function remoteFolder(dir) {
  const p = isRemotePath(dir) ? parseRemotePath(dir) : null
  if (!p) return null
  const root = remoteRoot(p.hostId, p.path)
  return root ? { hostId: p.hostId, path: p.path, root } : null
}
// Variables a remote chat's agent gets from Settings > Agents: never this
// PC's own (PATH, HOME…), which mean nothing on the host.
const NOT_FOR_HOST = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'PWD', 'TMPDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'])
export function remoteAgentEnv({ paneId, agent, extraEnv } = {}) {
  const extra = cleanRemoteEnv(extraEnv)
  for (const k of Object.keys(extra)) if (NOT_FOR_HOST.has(k.toUpperCase()) || k.toUpperCase().startsWith('TESSEL_')) delete extra[k]
  return { ...extra, TESSEL_PANE_ID: paneId, TESSEL_AGENT_PROVIDER: agent }
}
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
    // Before a Codex chat starts in its (trusted) folder: Codex's own folder
    // trust (agentFolderTrust.js apply; never throws).
    preTrust = null,
    discoverSkills = discoverClaudeSkills,
    log = null,
    now = Date.now,
    randomUUID = nodeUUID,
    // The folder the agent keeps its conversations in, from its variables
    // (transcriptHistory.js transcriptHomeFor): null reads no earlier history.
    transcriptHome = () => null,
    readHistory = readTranscriptHistory,
    // Whether the agent wrote that conversation's file in that folder (a
    // Claude chat closed before its first message never did).
    transcriptExists = (agent, id, home) => !!findTranscript(agent, id, home),
    readOlder = readOlderHistory,
    // Attached images (chatImages.js): chat:send names them by id.
    images = null,
    // The rate-limit windows a Claude or Codex chat reports, for the usage
    // indicator ({ provider, env, since, rateLimit }; providerUsageIpc.js
    // keeps them only for the account it shows). Never a token.
    onRateLimit = null,
    // How long a message steered into a turn that ended before the agent took
    // it waits for the agent to start it as a turn of its own.
    steerWaitMs = STEER_WAIT_MS,
    // Chats on an SSH host (remoteProcess.js, remoteTranscripts.js):
    // { available(), spawnFor({ hostId, cwd, env }), resolveAgent(agent, hostId)
    //   -> { exe, exeArgs? } | { error } | null, readAgentFile(hostId, q),
    //   hostLabel(hostId) }. null: a remote folder is refused.
    remote = null
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
  // A Claude chat closed before its first message (the app quit, it slept)
  // has an id Claude never wrote: --resume would stop it at once ("No
  // conversation found"). It starts again under the same id. Unknown folder:
  // resumed as before.
  function claudeNeverWritten(id, home) {
    if (!id || !home) return false
    try {
      return !transcriptExists('claude', id, home)
    } catch {
      return false
    }
  }

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

  const hostName = (hostId) => {
    try {
      return String(remote?.hostLabel?.(hostId) || hostId)
    } catch {
      return hostId
    }
  }

  // importHistory for a chat on an SSH host: the agent's file there, read
  // over the connection (remoteTranscripts.js). Once, like importHistory.
  async function importRemoteHistory(s) {
    if (!s.sessionId || !s.remote || typeof remote?.readAgentFile !== 'function') return
    const j = journalOf(s.paneId)
    const meta = j.readMeta()
    if (meta && meta.sessionId === s.sessionId) return
    let res = null
    try {
      res = await readRemoteHistory({ readAgentFile: remote.readAgentFile, hostId: s.remote.hostId, agent: s.agent, sessionId: s.sessionId })
    } catch (err) {
      logAt('warn', `${s.paneId}: earlier remote history not read: ${err?.message || err}`) // i18n-ignore log line
    }
    // Not read (the host did not answer): asked again at the next open.
    if (!res?.ok && res?.code !== 'empty') return
    j.writeMeta({ sessionId: s.sessionId, agent: s.agent, cwd: s.cwd })
    if (!res.ok || !Array.isArray(res.events) || !res.events.length || s.closing) return
    const agentName = PRODUCT[s.agent] || 'Claude' // i18n-ignore product names
    const first = res.events[0].at
    const text = res.truncated
      ? t('main.chat.historyImportedPart', 'Earlier conversation, from the history {{agent}} keeps (only its most recent part).', { agent: agentName })
      : t('main.chat.historyImported', 'Earlier conversation, from the history {{agent}} keeps.', { agent: agentName })
    emitHistory(s.paneId, [{ type: 'notice', kind: 'info', text, imported: true, ...(Number.isFinite(first) ? { at: first } : {}) }, ...res.events])
  }

  // A chat on an SSH host lost its connection (remoteProcess.js): its
  // process is gone with it. The chat says so and waits, asleep: its next
  // message (or the window, once the host is back) opens it again on the
  // same conversation (--resume / thread resume).
  function dropped(s, e) {
    if (s.finished || s.closing || !s.started || !s.sessionId) return finish(s, e)
    s.asleep = true
    s.ready = false
    s.adapter = null
    s.wakeAsked = false
    s.disconnected = true
    if (s.idleTimer) clearTimeout(s.idleTimer)
    s.idleTimer = null
    cancelQuestions(s)
    if (s.turn) markFailed(s, s.turn)
    if (s.turn && s.turn.timer) clearTimeout(s.turn.timer)
    s.turn = null
    s.compaction = null
    for (const [requestId, ap] of s.approvals) {
      if (ap.status !== 'pending') continue
      ap.status = 'cancelled'
      ap.input = null
      emit(s.paneId, { type: 'approvalStatus', requestId, status: 'cancelled' })
    }
    s.approvals.clear()
    s.tools.clear()
    s.toolAgents.clear()
    s.messages.clear()
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
    const host = hostName(s.remote?.hostId || '')
    const text = t('main.chat.remoteDisconnected', 'The connection to {{host}} was lost. The conversation goes on once it is back (send a message, or wait for Tessel to reconnect).', { host })
    emit(s.paneId, { type: 'notice', kind: 'warning', text })
    status(s, 'asleep', { reason: 'disconnected', error: text })
    logAt('warn', `${s.paneId}: remote agent disconnected`) // i18n-ignore log line
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
    let events = opencodeHistoryEvents(res.messages, OPENCODE_HISTORY)
    let truncated = res.truncated === true
    if (events.length > HISTORY_LIMITS.events) {
      events = events.slice(-HISTORY_LIMITS.events)
      truncated = true
    }
    // Its images and files, for the events kept only.
    resolveHistoryAttachments(events, ATTACHMENT_LIMITS)
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
    !(s.backgroundRunning > 0) &&
    !pendingApprovals(s) &&
    !pendingQuestions(s) &&
    !s.userQueue.length &&
    !s.teamQueue.length &&
    !steeredPending(s).length

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
    // A carried turn's messages are the steered ones: settled with them.
    if (turn.accepted || turn.failed || turn.carried) return
    turn.failed = true
    if (turn.kind === 'user') for (const id of turn.ids) emit(s.paneId, { type: 'userStatus', id, status: 'failed' })
    else if (turn.kind === 'team') emit(s.paneId, { type: 'teamFailed', ids: [...turn.ids] })
  }

  async function deliver(s, turn) {
    s.turn = turn
    if (turn.images?.length) (s.sentImages ||= []).push(...turn.images.map((img) => img.id))
    idleCheck(s)
    // A held card becomes its row now, where it goes out.
    if (turn.held) emitHeldRow(s, turn.held, 'sent')
    else if (turn.kind === 'user') for (const id of turn.ids) if (turn.wasQueued) emit(s.paneId, { type: 'userStatus', id, status: 'sent' })
    workStatus(s)
    let r
    try {
      const pics = turn.images?.length && images ? turn.images.map((img) => images.forAgent(img)) : null
      r = await s.adapter.send({ uuid: turn.uuid, text: turn.text, ...(pics ? { images: pics } : {}) })
    } catch (err) {
      r = { ok: false, error: err?.message }
    }
    if (r?.ok || s.turn !== turn) return
    // Never written: the agent is not working on it.
    markFailed(s, turn)
    s.turn = null
    workStatus(s)
    if (turn.kind === 'compact') return giveUpCompaction(s, r?.error)
    // The message resent after a compaction could not be written: that
    // compaction is over (else the next turn would be taken for its resend).
    if (s.compaction && s.compaction.phase === 'retrying') s.compaction = null
    pump(s)
    idleCheck(s)
  }

  // ---- a conversation too long for the model ----------------------------------
  // The model refused the turn for its length ("Prompt is too long", a context
  // window overflow): the conversation is compacted, then the message sent
  // again, once. Failing that, the user is told to start a new conversation.

  // After 'compacted', how long a compaction turn's own end is waited for.
  const COMPACT_SETTLE_MS = 1500
  const COMPACT_WAIT_MS = 120000
  const TOO_LONG = /prompt is too long|context.?(window|length)|too many tokens|maximum context|context_length_exceeded|contextoverflow|ran out of room/i
  const isTooLong = (error) => TOO_LONG.test(String(error || ''))
  const agentLabel = (s) => ({ claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' })[s.agent] || s.agent // i18n-ignore

  function startCompaction(s) {
    if (s.agent === 'claude') {
      // Claude's own command, as a turn of its own (no row in the chat).
      void deliver(s, { kind: 'compact', uuid: randomUUID(), ids: [], text: '/compact' })
      return
    }
    // Codex (thread/compact/start) and OpenCode (summarize): the request is
    // taken at once; the agent says 'compacted' when it is done (Codex runs
    // it as a turn of its own, whose failure ends the wait).
    const compact = s.adapter?.compact
    if (typeof compact !== 'function') return giveUpCompaction(s)
    const turn = { kind: 'compact', uuid: null, ids: [], accepted: true, timer: null }
    s.turn = turn
    workStatus(s)
    Promise.resolve()
      .then(() => compact.call(s.adapter))
      .then(
        (r) => {
          if (s.turn !== turn) return // closed meanwhile
          if (!(r && r.ok)) {
            s.turn = null
            return giveUpCompaction(s, r && r.error)
          }
          turn.timer = setTimeout(() => {
            if (s.turn !== turn) return
            s.turn = null
            giveUpCompaction(s, 'timeout')
          }, COMPACT_WAIT_MS)
          if (typeof turn.timer.unref === 'function') turn.timer.unref()
        },
        (err) => {
          if (s.turn !== turn) return
          s.turn = null
          giveUpCompaction(s, err?.message)
        }
      )
  }
  function compactionDone(s, ok, error, opts) {
    const turn = s.turn
    if (!turn || turn.kind !== 'compact' || s.agent === 'claude') return false
    if (turn.timer) clearTimeout(turn.timer)
    s.turn = null
    if (ok) resendAfterCompaction(s)
    else giveUpCompaction(s, error, opts)
    return true
  }
  function resendAfterCompaction(s) {
    const c = s.compaction
    if (!c || s.finished || s.closing) return pump(s)
    c.phase = 'retrying'
    void deliver(s, { kind: c.kind, uuid: randomUUID(), ids: c.ids, text: c.text, wasQueued: true })
  }
  // quiet: the user stopped it (Stop): the message is not sent, nothing to explain.
  function giveUpCompaction(s, error = '', { quiet = false } = {}) {
    const c = s.compaction
    s.compaction = null
    if (c && c.kind === 'user') for (const id of c.ids) emit(s.paneId, { type: 'userStatus', id, status: 'failed' })
    else if (c && c.kind === 'team') emit(s.paneId, { type: 'teamFailed', ids: [...c.ids] })
    if (!s.finished && !quiet) {
      emit(s.paneId, {
        type: 'notice',
        kind: 'error',
        text: t('main.chat.tooLong', 'The conversation is too long for {{agent}} and could not be compacted: start a new conversation.', { agent: agentLabel(s) }),
        action: 'newConversation',
        ...(error ? { detail: String(error).slice(0, 500) } : {})
      })
    }
    workStatus(s)
    pump(s)
    idleCheck(s)
  }

  // ---- a message sent while a turn runs (Claude, Codex) -----------------------
  // Written at once, never queued here: the agent owns it from the write.
  // s.steered: id -> { id, text, gaveUp } until the agent echoes it.

  const STEER_AGENTS = new Set(['claude', 'codex'])
  const steeredPending = (s) => [...(s.steered?.values() || [])].filter((m) => !m.gaveUp)
  // Whether a running turn can take a message now (a card's Send now too).
  function steerable(s, text) {
    return (
      STEER_AGENTS.has(s.agent) &&
      s.ready &&
      !s.asleep &&
      !!s.turn &&
      s.turn.kind !== 'compact' &&
      !s.compaction &&
      !pendingApprovals(s) &&
      !pendingQuestions(s) &&
      // A command never joins a running turn: it waits for its end.
      !String(text || '').trim().startsWith('/')
    )
  }
  // A new message: never ahead of one already waiting (order kept).
  const canSteer = (s, text) => steerable(s, text) && !s.userQueue.length

  async function steer(s, m) {
    const a = s.adapter
    s.steered.set(m.id, { id: m.id, text: m.text, gaveUp: false })
    if (m.images?.length) (s.sentImages ||= []).push(...m.images.map((img) => img.id))
    let r
    try {
      const pics = m.images?.length && images ? m.images.map((img) => images.forAgent(img)) : null
      r = await a.send({ uuid: m.id, text: m.text, ...(pics ? { images: pics } : {}) })
    } catch (err) {
      r = { ok: false, error: err?.message }
    }
    if (r?.ok || !s.steered.has(m.id) || s.finished) return
    // Never written: the agent is not working on it.
    s.steered.delete(m.id)
    emit(s.paneId, { type: 'userStatus', id: m.id, status: 'failed' })
    const turn = s.turn
    if (turn?.carried && turn.ids.includes(m.id)) {
      turn.ids = turn.ids.filter((id) => id !== m.id)
      if (!turn.ids.length) endCarried(s, turn)
    }
  }

  // The agent echoed a steered message: joined to the running turn, or the
  // start of the turn carried over from the previous one.
  function steeredAccepted(s, uuid) {
    const m = s.steered?.get(uuid)
    if (!m) return false
    s.steered.delete(uuid)
    emit(s.paneId, { type: 'userStatus', id: m.id, status: 'accepted' })
    const turn = s.turn
    if (turn?.carried) {
      if (turn.timer) clearTimeout(turn.timer)
      turn.timer = null
      turn.accepted = true
      turnStarted(s)
    } else if (turn) {
      ;(turn.joined ||= []).push({ id: m.id, text: m.text })
    } else if (!s.finished && !s.closing) {
      // Taken after the wait gave up: a turn of its own.
      s.turn = { kind: 'user', uuid, ids: [m.id], text: m.text, accepted: true }
      turnStarted(s)
      workStatus(s)
      idleCheck(s)
    }
    return true
  }

  // The turn ended before the agent took what was steered into it: the agent
  // runs it next (Claude's own queue, what an interrupt left), so the chat
  // stays working for it, never sending anything else meanwhile.
  function carrySteered(s) {
    const pending = steeredPending(s)
    if (!pending.length || s.finished || s.closing) return false
    if (s.agent !== 'claude') {
      // Codex takes a steer before its turn completes: one the turn ended
      // without (interrupted, failed) is dropped. Said at once; a late
      // echo still shows it accepted (steeredAccepted).
      for (const m of pending) {
        m.gaveUp = true
        emit(s.paneId, { type: 'userStatus', id: m.id, status: 'failed' })
      }
      return false
    }
    const turn = { kind: 'user', carried: true, uuid: pending[0].id, ids: pending.map((m) => m.id), text: pending[0].text, accepted: false, timer: null }
    turn.timer = setTimeout(() => {
      if (s.turn !== turn || turn.accepted) return
      for (const id of turn.ids) {
        const m = s.steered.get(id)
        if (!m || m.gaveUp) continue
        m.gaveUp = true
        emit(s.paneId, { type: 'userStatus', id, status: 'failed' })
      }
      endCarried(s, turn)
    }, steerWaitMs)
    if (typeof turn.timer.unref === 'function') turn.timer.unref()
    s.turn = turn
    return true
  }
  function endCarried(s, turn) {
    if (s.turn !== turn) return
    if (turn.timer) clearTimeout(turn.timer)
    s.turn = null
    workStatus(s)
    pump(s)
    idleCheck(s)
  }

  // Starts the next turn when the agent is free.
  function pump(s) {
    // The images of turns that ended are no longer needed (the agent has them).
    if (!s.turn) releaseSentImages(s)
    if (!s.ready || s.finished || s.closing || s.turn || pendingApprovals(s) || pendingQuestions(s)) return
    if (s.userQueue.length) {
      const m = s.userQueue.shift()
      void deliver(s, { kind: 'user', uuid: m.id, ids: [m.id], text: m.text, images: m.images, wasQueued: true, ...(m.held ? { held: m } : {}) })
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
    // A new process: the old one's background work ended with it.
    if (s.backgroundRunning) {
      s.backgroundRunning = 0
      emit(s.paneId, { type: 'backgroundTasks', running: 0 })
    }
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
      if (!e.uuid || steeredAccepted(s, e.uuid)) return
      if (!s.turn || e.uuid !== s.turn.uuid) return
      turnStarted(s)
      markAccepted(s, s.turn)
    })
    const provenance = e => ({ ...(e.agentId ? { agentId: e.agentId } : {}), ...(e.parentToolUseId ? { parentToolUseId: e.parentToolUseId } : {}) })
    on('commands', e => emit(s.paneId, { type: 'commands', commands: normalizeCommands(e.commands) }))
    on('retry', e => emit(s.paneId, {
      type: 'retry',
      message: String(e.message || '').slice(0, 2000),
      ...(Number.isSafeInteger(e.attempt) && e.attempt > 0 ? { attempt: e.attempt } : {})
    }))
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
    // Its background work still running (shells, sub-agents, monitors): with
    // its turn over, the pane is "monitoring", and it is not put to sleep
    // (stopping its process would stop that work).
    on('backgroundTasks', (e) => {
      const running = Number.isSafeInteger(e.running) && e.running > 0 ? e.running : 0
      if (running === (s.backgroundRunning || 0)) return
      s.backgroundRunning = running
      emit(s.paneId, { type: 'backgroundTasks', running })
      idleCheck(s)
    })
    // The context window: the newest of what the agent reported (Claude and
    // OpenCode: contextUsage; Codex: its token usage, the last request's
    // total in the model's window). Journaled once a turn is over, only
    // when it changed.
    on('contextUsage', (e) => noteContext(s, e.usedTokens, e.windowTokens))
    on('usage', (e) => {
      const last = e.last && typeof e.last === 'object' ? e.last : null
      const n = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
      const used = last ? n(last.totalTokens) || n(last.inputTokens) + n(last.outputTokens) : 0
      noteContext(s, used || null, e.contextWindow)
    })
    on('compacted', (e) => {
      // Its content is gone: unknown until the next response says it again.
      s.context = { usedTokens: null, windowTokens: s.context?.windowTokens ?? null }
      s.contextSent = s.context
      emit(s.paneId, { type: 'compacted', ...(e.trigger ? { trigger: e.trigger } : {}), ...(Number.isFinite(e.preTokens) ? { preTokens: e.preTokens } : {}) })
    })
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
    // The API's own error message (Claude: "Prompt is too long"): kept for
    // the turn's end, never shown as the assistant's words.
    on('apiError', (e) => {
      if (!e.parentToolUseId && !e.agentId) s.apiError = { code: String(e.code || ''), message: String(e.message || '') }
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
    on('compacted', () => {
      // Codex reports its compaction as a turn of its own and ends that turn
      // right after: the message goes again once that end came (else it would
      // be taken for the resent message's end), or after a moment when no
      // turn end follows (OpenCode's summary).
      const turn = s.turn
      if (turn && turn.kind === 'compact' && s.agent !== 'claude') {
        turn.compacted = true
        if (turn.timer) clearTimeout(turn.timer)
        turn.timer = setTimeout(() => {
          if (s.turn === turn) compactionDone(s, true)
        }, COMPACT_SETTLE_MS)
        if (typeof turn.timer.unref === 'function') turn.timer.unref()
      }
      askContext(s)
    })
    on('turnEnd', (e) => {
      cancelQuestions(s)
      const turn = s.turn
      // Codex's compaction runs as a turn of its own, not one of the chat:
      // done at 'compacted'; failed, the wait ends here.
      if (turn && turn.kind === 'compact' && s.agent !== 'claude') {
        if (e.status !== 'completed') compactionDone(s, false, e.error && typeof e.error === 'object' ? e.error.message : e.error || e.result, { quiet: e.status === 'interrupted' })
        else if (turn.compacted) compactionDone(s, true)
        return
      }
      const uuids = Array.isArray(e.userMessageUuids) ? e.userMessageUuids : []
      // Steered messages the turn's end says it took (never echoed before).
      for (const u of uuids) if (typeof u === 'string') steeredAccepted(s, u)
      // Not taken: failed, unless a compaction sends it again (decided below;
      // failed now, the window would release a team message and offer it
      // again, and it would arrive twice).
      let notTaken = false
      if (turn && !turn.accepted) {
        if (turn.uuid && uuids.includes(turn.uuid)) markAccepted(s, turn)
        else notTaken = true
      }
      if (turn) turnStarted(s)
      const st = ['completed', 'interrupted', 'failed'].includes(e.status) ? e.status : 'failed'
      s.lastInterrupted = st === 'interrupted'
      const apiError = s.apiError
      s.apiError = null
      // Claude's failed result may carry only errors[], without a result string.
      const resultErrors = Array.isArray(e.errors) ? e.errors.filter((message) => typeof message === 'string' && message.trim()).slice(0, 32).map((message) => message.slice(0, 4000)).join('\n') : ''
      const why = e.result || e.error || (apiError && apiError.message) || resultErrors
      const error = st === 'failed' && why ? String(typeof why === 'object' ? why.message || JSON.stringify(why) : why).slice(0, 4000) : ''
      // The error is shown once, by the turn's end (the window's one red
      // notice): never again as a notice, never as the assistant's words.
      let shown = error
      let after = null
      if (turn && turn.kind === 'compact') {
        // Claude's /compact turn: done, the message goes again; failed, said below.
        shown = ''
        after = st === 'completed' ? () => resendAfterCompaction(s) : () => giveUpCompaction(s, error, { quiet: st === 'interrupted' })
      } else if (s.compaction) {
        // The message sent again after the compaction.
        if (st === 'failed' && isTooLong(error)) {
          shown = ''
          after = () => giveUpCompaction(s, error)
        } else s.compaction = null
      } else if (st === 'failed' && isTooLong(error) && turn && (turn.kind === 'user' || turn.kind === 'team')) {
        // What was steered into the turn goes again with it.
        const text = [turn.text, ...(turn.joined || []).map((j) => j.text)].filter(Boolean).join('\n\n')
        s.compaction = { kind: turn.kind, ids: [...turn.ids], text, phase: 'compacting' }
        shown = ''
        emit(s.paneId, { type: 'notice', kind: 'info', text: t('main.chat.compacting', 'Conversation too long: compacting, then your message is sent again…') })
        after = () => startCompaction(s)
        notTaken = false
      }
      if (notTaken) markFailed(s, turn)
      emit(s.paneId, {
        type: 'turnEnd',
        status: st,
        ...(e.usage ? { usage: e.usage } : {}),
        ...(typeof e.costUsd === 'number' ? { costUsd: e.costUsd } : {}),
        ...(typeof e.durationMs === 'number' ? { durationMs: e.durationMs } : {}),
        ...(shown ? { error: shown } : {})
      })
      // A turn can fail with no text of its own (content
      // filter, usage limit, a provider error): said plainly; the queue goes
      // on below.
      if (st === 'failed' && !error && !after) {
        emit(s.paneId, { type: 'notice', kind: 'error', text: t('main.chat.turnFailedNoReason', 'The turn failed.') })
      }
      // An interrupted turn (Stop, Esc) says so in the conversation (not the
      // compaction's own turn, which ends the way it was asked to).
      if (st === 'interrupted' && !(turn && turn.kind === 'compact')) {
        emit(s.paneId, { type: 'notice', kind: 'info', presentation: 'interrupted', text: t('main.chat.interrupted', 'Interrupted') })
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
      if (turn?.timer) clearTimeout(turn.timer)
      s.turn = null
      if (!after) carrySteered(s)
      flushContext(s)
      askContext(s)
      workStatus(s)
      if (after) after()
      else pump(s)
      idleCheck(s)
    })
    on('rateLimit', (e) => {
      emit(s.paneId, {
        type: 'rateLimit',
        ...(e.fiveHour ? { fiveHour: e.fiveHour } : {}),
        ...(e.sevenDay ? { sevenDay: e.sevenDay } : {})
      })
      // A host's account is not one this PC shows: its limits are not told.
      if (onRateLimit && !s.remote && (s.agent === 'claude' || s.agent === 'codex')) {
        try {
          onRateLimit({
            provider: s.agent,
            env: { ...(s.usageEnv || {}) },
            since: s.startedAt ?? null,
            rateLimit: { fiveHour: e.fiveHour || null, sevenDay: e.sevenDay || null }
          })
        } catch (err) {
          logAt('warn', `usage update failed: ${err?.message || err}`)
        }
      }
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
    on('exit', (e) => (e.disconnected && s.remote ? dropped(s, e) : finish(s, e)))
  }

  // Claude: its own context count, asked when the chat is ready, after each
  // turn and each compaction (the others report it as they go).
  function askContext(s) {
    if (s.finished || typeof s.adapter?.refreshContext !== 'function') return
    Promise.resolve()
      .then(() => s.adapter.refreshContext())
      .catch(() => {})
  }
  // The newest context facts (a window not given keeps the last one known).
  function noteContext(s, usedTokens, windowTokens) {
    const pos = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : null)
    const used = pos(usedTokens)
    const window = pos(windowTokens) ?? s.context?.windowTokens ?? null
    if (used === null && window === null) return
    s.context = { usedTokens: used ?? s.context?.usedTokens ?? null, windowTokens: window }
    if (!s.turn) flushContext(s)
  }
  function flushContext(s) {
    const c = s.context
    if (!c || (s.contextSent && s.contextSent.usedTokens === c.usedTokens && s.contextSent.windowTokens === c.windowTokens)) return
    s.contextSent = c
    emit(s.paneId, { type: 'contextUsage', usedTokens: c.usedTokens, windowTokens: c.windowTokens })
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
    if (s.turn && s.turn.timer) clearTimeout(s.turn.timer)
    s.turn = null
    s.compaction = null
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
    // A folder on an SSH host: the agent runs there (Claude, Codex).
    const onHost = remoteFolder(cwd)
    const hostProject = onHost && projectDir != null && projectDir !== '' ? remoteFolder(projectDir) : null
    if (
      !Number.isInteger(idleMinutes) ||
      idleMinutes < 0 ||
      idleMinutes > 1440 ||
      !validPaneId(paneId) ||
      !AGENTS.includes(agent) ||
      (onHost ? !remote || agent === 'opencode' : !validFolder(cwd)) ||
      (projectDir != null && projectDir !== '' && (onHost ? !hostProject || hostProject.hostId !== onHost.hostId : !validFolder(projectDir))) ||
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
      cwd: onHost ? onHost.root : cwd,
      projectDir: onHost ? (hostProject ? hostProject.root : null) : projectDir || null,
      // On an SSH host: { hostId, path } (path: the host's own).
      remote: onHost ? { hostId: onHost.hostId, path: onHost.path } : null,
      worker: opts.worker === true,
      status: 'starting',
      ready: false,
      closing: false,
      finished: false,
      turn: null,
      // A wake goes on with what was sent while it was asleep.
      userQueue: from ? from.userQueue : [],
      steered: new Map(), // id -> { id, text, gaveUp }: sent mid-turn, not echoed yet
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
        // A copy Tessel made counts as its project: local folders only.
        roots = onHost ? [] : trustRoots(cwd, { worker: opts.worker === true }) || []
      } catch {
        roots = []
      }
      if (!trust?.isTrusted(s.cwd, roots)) {
        const yes = askTrust === true && trust?.ask ? await trust.ask(s.cwd) : false
        if (s.closing) return closedWhileStarting()
        if (!yes) {
          drop()
          emit(paneId, { type: 'status', state: 'untrusted', agent })
          return { ok: false, code: 'untrusted', error: t('main.chat.untrusted', 'This folder is not trusted for chat agents yet.') }
        }
      }

      if (s.closing) return closedWhileStarting()
      if (onHost && !remote.available()) {
        drop()
        const error = t('main.chat.remoteUnavailable', 'Chat agents on an SSH host are not available in this version of Tessel yet. Open a terminal agent on the host instead.')
        emit(paneId, { type: 'status', state: 'crashed', agent, error })
        return { ok: false, code: 'remote-unavailable', error }
      }
      let found = null
      try {
        found = onHost
          ? await remote.resolveAgent(agent, onHost.hostId)
          : await (agent === 'codex' ? resolveCodex() : agent === 'opencode' ? resolveOpencode() : resolveClaude())
      } catch {
        found = null
      }
      if (s.closing) return closedWhileStarting()
      if (onHost && found && typeof found.error === 'string') {
        // The host could not be asked (not connected, signed out).
        drop()
        const error = t('main.chat.remoteNoAnswer', '{{host}} did not answer: {{error}}', { host: hostName(onHost.hostId), error: found.error })
        emit(paneId, { type: 'status', state: 'crashed', agent, error })
        return { ok: false, code: 'remote-unreachable', error }
      }
      if (!found || typeof found.exe !== 'string' || !found.exe) {
        drop()
        const error = onHost
          ? agent === 'codex'
            ? t('main.chat.noCodexOnHost', 'Codex was not found on {{host}}. Install it there, then try again.', { host: hostName(onHost.hostId) })
            : t('main.chat.noClaudeOnHost', 'Claude Code was not found on {{host}}. Install it there, then try again.', { host: hostName(onHost.hostId) })
          : agent === 'codex'
            ? t('main.chat.noCodex', 'Codex was not found. Install it, then try again.')
            : agent === 'opencode'
              ? t('main.chat.noOpencode', 'OpenCode was not found. Install it, then try again.')
              : t('main.chat.noClaude', 'Claude Code was not found. Install it, then try again.')
        emit(paneId, { type: 'status', state: 'crashed', agent, error })
        return { ok: false, code: `no-${agent}`, error }
      }

      emit(paneId, { type: 'status', state: 'starting', agent, ...(s.sessionId ? { sessionId: s.sessionId } : {}) })
      const teamSecret = team.newSecret()
      let childEnv
      if (onHost) {
        // The host's own environment (its login shell's), plus Tessel's few
        // variables and Settings > Agents ones: never this PC's, never an
        // account's local folders.
        childEnv = remoteAgentEnv({ paneId, agent, extraEnv: envOpts?.extraEnv })
      } else {
        let base = envDeps.forPane({ paneId, cwd, projectDir: s.projectDir, accountEnv, ...(envOpts || {}) })
        if (base && typeof base === 'object' && base.env && typeof base.env === 'object') base = base.env
        childEnv = buildChatEnv(base, { agent, paneId, teamSecret, projectDir: s.projectDir, pathEnv: found.pathEnv })
      }
      // Which login's limits this chat reports: its config folder only (none
      // on a host: its account is the host's, not one this PC shows).
      s.usageEnv = {}
      if (!onHost)
        for (const name of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME'])
          if (typeof childEnv?.[name] === 'string' && childEnv[name]) s.usageEnv[name] = childEnv[name]
      s.startedAt = now()
      // Where this agent keeps its conversations (for the older pages too);
      // on a host, its files there are read over the connection.
      try {
        s.historyHome = onHost ? null : transcriptHome(agent, childEnv) || null
      } catch {
        s.historyHome = null
      }
      // A resumed conversation: its earlier turns first (never on a wake).
      if (resumeId && !from) {
        if (onHost) await importRemoteHistory(s)
        else importHistory(s, childEnv)
        if (s.closing) return closedWhileStarting()
      }
      // Codex trusts the folder itself only when the chat may write there: a
      // Manual (read-only) chat would ignore the project's .codex settings.
      // A chat's Claude (-p) never asks, so only Codex (local folders only).
      if (agent === 'codex' && typeof preTrust === 'function' && !onHost) {
        try {
          await preTrust({ agentId: 'codex', cwd, env: childEnv, enabled: opts.agentFolderTrust === true })
        } catch {
          // The folder stays as Codex has it.
        }
        if (s.closing) return closedWhileStarting()
      }
      const common = {
        agent,
        exe: found.exe,
        exeArgs: Array.isArray(found.exeArgs) ? found.exeArgs : [],
        cwd: onHost ? onHost.path : cwd,
        env: childEnv,
        ...(s.model ? { model: s.model } : {}),
        ...(s.effort ? { effort: s.effort } : {}),
        log
      }
      // On a host: the process starts there (the adapters talk to it as to a
      // local child) and is ended there.
      if (onHost) {
        try {
          Object.assign(common, { spawn: remote.spawnFor({ hostId: onHost.hostId, cwd: onHost.path, env: childEnv }), killTree: killRemoteChild, remote: true })
        } catch (err) {
          drop()
          const error = String(err?.message || err)
          emit(paneId, { type: 'status', state: 'crashed', agent, error })
          return { ok: false, code: 'failed', error }
        }
      }
      // A Claude conversation never written (closed before its first
      // message): started again under its id, on a host as locally.
      const neverWritten =
        agent === 'claude' && resumeId
          ? onHost
            ? (await remoteTranscriptExists({ readAgentFile: remote.readAgentFile, hostId: onHost.hostId, agent, sessionId: resumeId })) === false
            : claudeNeverWritten(resumeId, s.historyHome)
          : false
      if (s.closing) return closedWhileStarting()
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
              : { ...common, ...(resumeId && !neverWritten ? { resume: resumeId } : { sessionId: s.sessionId }), permissionMode: permissionModeUsed }
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
      journalOf(paneId).writeMeta({ sessionId: s.sessionId, agent, cwd: s.cwd })
      if (s.finished || s.closing) {
        // Gone (or closed) while its status was being registered.
        if (state?.unregister) Promise.resolve().then(() => state.unregister(paneId, s.launchToken)).catch(() => {})
        if (!s.finished) finish(s, { code: 0 })
        return { ok: false, code: 'failed', error: t('main.chat.startFailed', 'The agent could not start.') }
      }
      s.ready = true
      status(s, 'idle')
      askContext(s)
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

  // Delivered images, removed once their turn is over.
  function releaseSentImages(s) {
    if (!s.sentImages?.length) return
    images?.release(s.sentImages.splice(0))
  }
  function failQueued(s) {
    releaseSentImages(s)
    images?.release(s.userQueue.flatMap((m) => (m.images || []).map((img) => img.id)))
    for (const m of s.userQueue) {
      if (m.held) emitHeldRow(s, m, 'failed')
      else emit(s.paneId, { type: 'userStatus', id: m.id, status: 'failed' })
    }
    s.userQueue = []
    for (const m of steeredPending(s)) emit(s.paneId, { type: 'userStatus', id: m.id, status: 'failed' })
    s.steered?.clear()
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
  // imageIds: images saved for this pane (chatImages.js), in order.
  // hold: a message that cannot go at once waits as an editable card.
  function sendUser({ paneId, text, imageIds, hold = false } = {}) {
    const s = live(paneId) || waiting(paneId)
    if (!s) return closed()
    let pics = []
    if (imageIds?.length) {
      const r = images ? images.take(paneId, imageIds) : { ok: false, error: t('main.chat.invalid', 'Invalid chat request.') }
      if (!r.ok) return { ok: false, code: 'image', error: r.error }
      pics = r.images
    }
    const id = randomUUID()
    const now_ = now()
    const idle = s.ready && !s.turn && !pendingApprovals(s) && !pendingQuestions(s) && !s.userQueue.length
    // A turn runs: Claude and Codex take it now (see steer), unless it is held.
    const steered = !idle && !hold && canSteer(s, text)
    // The journal keeps each image's name and size, never its data.
    const shown = pics.map((img) => ({ id: img.id, name: img.name, width: img.width, height: img.height }))
    if (!idle && hold) {
      const m = { id, text, at: now_, held: true, shown, ...(pics.length ? { images: pics } : {}) }
      s.userQueue.push(m)
      emitCard(s, m)
      askWake(s)
      idleCheck(s)
      return { ok: true, id, queued: true, held: true }
    }
    emit(paneId, { type: 'user', id, text, origin: 'user', status: idle || steered ? 'sent' : 'queued', at: now_, ...(shown.length ? { images: shown } : {}) })
    if (idle) void deliver(s, { kind: 'user', uuid: id, ids: [id], text, ...(pics.length ? { images: pics } : {}) })
    else if (steered) void steer(s, { id, text, ...(pics.length ? { images: pics } : {}) })
    else s.userQueue.push({ id, text, ...(pics.length ? { images: pics } : {}) })
    askWake(s)
    idleCheck(s)
    return { ok: true, id, queued: !idle && !steered, ...(steered ? { steered: true } : {}) }
  }

  // ---- held messages (the cards above the composer) ---------------------------
  // All synchronous: a card is either still in userQueue (it can change) or
  // already taken out by pump or Send now ('gone'), never in between.

  const heldCard = (m) => ({ id: m.id, text: m.text, at: m.at, ...(m.shown?.length ? { imageCount: m.shown.length } : {}) })
  function emitCard(s, m) {
    emit(s.paneId, { type: 'queuedMessage', ...heldCard(m) })
  }
  function emitHeldRow(s, m, status) {
    emit(s.paneId, { type: 'user', id: m.id, text: m.text, origin: 'user', status, at: now(), ...(m.shown?.length ? { images: m.shown } : {}) })
  }
  function heldOf(paneId, id) {
    const s = live(paneId) || waiting(paneId)
    if (!s) return { error: closed() }
    const i = s.userQueue.findIndex((m) => m.held && m.id === id)
    if (i < 0) return { error: { ok: false, code: 'gone', error: t('main.chat.queuedGone', 'This message was already sent.') } }
    return { s, i, m: s.userQueue[i] }
  }
  function queuedEdit({ paneId, id, text } = {}) {
    const h = heldOf(paneId, id)
    if (h.error) return h.error
    if (!String(text || '').trim() && !h.m.shown?.length) return invalid()
    h.m.text = text
    emitCard(h.s, h.m)
    return { ok: true }
  }
  function queuedDelete({ paneId, id } = {}) {
    const h = heldOf(paneId, id)
    if (h.error) return h.error
    h.s.userQueue.splice(h.i, 1)
    images?.release((h.m.images || []).map((img) => img.id))
    emit(paneId, { type: 'queuedRemoved', id })
    idleCheck(h.s)
    return { ok: true }
  }
  // Send now: steered into the running turn (Claude, Codex), ahead of the others.
  function queuedSend({ paneId, id } = {}) {
    const h = heldOf(paneId, id)
    if (h.error) return h.error
    const { s, m } = h
    if (!steerable(s, m.text)) return { ok: false, code: 'cannot', error: t('main.chat.queuedCannot', 'It cannot take a message now: this one goes when the turn ends.') }
    s.userQueue.splice(h.i, 1)
    emitHeldRow(s, m, 'sent')
    void steer(s, { id: m.id, text: m.text, ...(m.images?.length ? { images: m.images } : {}) })
    idleCheck(s)
    return { ok: true, steered: true }
  }

  function sendTeam({ paneId, messages } = {}) {
    const s = live(paneId) || waiting(paneId)
    if (!s) return closed()
    // Queued, in the turn, or waiting for its resend after a compaction.
    const known = new Set([...s.teamQueue.map((m) => m.id), ...(s.turn?.kind === 'team' ? s.turn.ids : []), ...(s.compaction?.kind === 'team' ? s.compaction.ids : [])])
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

  // The value an option had before a change, for the window's "from → to".
  const fromOf = (value) => (typeof value === 'string' && value ? { from: value.slice(0, 200) } : {})
  async function setOption({ paneId, model, effort, permissionMode } = {}) {
    const z = sessions.get(paneId)
    if (z?.asleep && permissionMode == null) {
      // Kept for the wake (a model or effort the caller does not give then).
      const was = { model: z.model, effort: z.effort }
      if (model != null) z.model = model
      if (effort != null) z.effort = effort
      if (model != null && model !== was.model) emit(paneId, { type: 'option', option: 'model', value: String(model).slice(0, 200), ok: true, ...fromOf(was.model) })
      if (effort != null && effort !== was.effort) emit(paneId, { type: 'option', option: 'effort', value: String(effort).slice(0, 200), ok: true, ...fromOf(was.effort) })
      return { ok: true, model: z.model, effort: z.effort }
    }
    const s = live(paneId)
    if (!s) return closed()
    const results = []
    // The chat says what changed (or did not), from what to what: a row of
    // its own, worded by the window. The same value again changes nothing.
    const was = { model: s.model, effort: s.effort }
    const said = (option, value, ok) => emit(paneId, { type: 'option', option, value: String(value).slice(0, 200), ok, ...fromOf(was[option]) })
    if (model != null && model === s.model) model = null
    if (effort != null && effort === s.effort) effort = null
    if (model != null && !validModel(s.agent, model)) {
      results.push(false)
      said('model', model, false)
    } else if (model != null) {
      const r = await s.adapter.setModel(model).catch(() => ({ ok: false }))
      if (r?.ok) s.model = model
      results.push(!!r?.ok)
      said('model', model, !!r?.ok)
    }
    if (effort != null) {
      const r = await s.adapter.setEffort(effort).catch(() => ({ ok: false }))
      if (r?.ok) s.effort = effort
      results.push(!!r?.ok)
      said('effort', effort, !!r?.ok)
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

  // Compacts the conversation to free its context: Claude's own /compact (a
  // message like any other), Codex's thread/compact/start, OpenCode's
  // summarize. The agent says when it is done ('compacted').
  async function compact({ paneId } = {}) {
    const s = live(paneId)
    if (!s) return closed()
    if (s.agent === 'claude') return sendUser({ paneId, text: '/compact' })
    if (typeof s.adapter.compact !== 'function') return { ok: false, code: 'unsupported', error: t('main.chat.compactUnsupported', 'This agent cannot compact its conversation.') }
    if (s.turn || pendingApprovals(s) || pendingQuestions(s)) return { ok: false, code: 'busy', error: t('main.chat.compactBusy', 'Wait for the end of the turn to compact.') }
    let r
    try {
      r = await s.adapter.compact()
    } catch (err) {
      r = { ok: false, error: err?.message || String(err) }
    }
    if (!r?.ok) return { ok: false, error: r?.error || t('main.chat.compactFailed', 'The conversation was not compacted.') }
    emit(paneId, { type: 'notice', kind: 'notice', text: t('main.chat.compacting', 'Compacting the conversation…') })
    return { ok: true }
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
    if (forget && validPaneId(paneId)) images?.releasePane(paneId)
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
      // Older turns than these can be asked for (chat:historyOlder).
      older: !!olderSource(s),
      // Authoritative live requests for remounts, even after journal rotation.
      // Empty after restart: recorded questions can never become answerable again.
      questions: s && !s.closing && !s.finished ? [...s.questions].map(([requestId, q]) => ({ type: 'question', requestId, questions: q.questions, status: 'pending' })) : [],
      // The held messages in order (their cards), as authoritative.
      queuedMessages: s && !s.closing && !s.finished ? s.userQueue.filter((m) => m.held).map(heldCard) : [],
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

  // Can this chat show older turns than its journal holds (read again from
  // the agent's own history, a page at a time)?
  function olderSource(s) {
    if (!s || s.closing || s.finished || !s.sessionId) return null
    if (s.agent === 'opencode') return typeof s.adapter?.history === 'function' ? 'opencode' : null
    return s.historyHome ? 'file' : null
  }
  // The time of the oldest event the pane's journal holds.
  function journalStart(paneId) {
    // An imported part carries its own (older) times, written after the
    // chat's first status: the oldest time, not the first row's.
    let first = null
    for (const row of journalOf(paneId).read()) {
      const at = Number.isFinite(row.event?.at) ? row.event.at : row.at
      if (Number.isFinite(at) && (first === null || at < first)) first = at
    }
    return first
  }
  // One page of older history: { ok, events, cursor, done }. cursor: what the
  // next call gives back (opaque to the window: an offset or an index here,
  // never a path). Nothing is written to the journal.
  const OLDER_PAGE_EVENTS = 500
  async function historyOlder({ paneId, cursor = null } = {}) {
    const s = sessions.get(paneId)
    const source = olderSource(s)
    if (!source) return { ok: false, code: 'closed' }
    const from = cursor == null ? null : cursor
    if (from && !(typeof from === 'object' && Number.isSafeInteger(from.n) && from.n >= 0 && from.k === source)) return { ok: false, code: 'invalid' }
    const beforeAt = from ? null : journalStart(paneId)
    if (!from && !Number.isFinite(beforeAt)) return { ok: true, events: [], cursor: null, done: true }
    try {
      if (source === 'file') {
        const res = readOlder({ agent: s.agent, sessionId: s.sessionId, home: s.historyHome, before: from ? from.n : null, beforeAt, now: now() })
        if (!res?.ok) return { ok: false, code: res?.code || 'missing' }
        return { ok: true, events: res.events, cursor: res.cursor == null ? null : { k: source, n: res.cursor }, done: res.done === true }
      }
      // OpenCode: from its server again; the turns before the journal's, the last ones first.
      const res = await s.adapter.history()
      if (!res?.ok || sessions.get(paneId) !== s) return { ok: false, code: 'missing' }
      const all = opencodeHistoryEvents(res.messages, OPENCODE_HISTORY)
      let end = from ? Math.min(from.n, all.length) : all.findIndex((e) => Number.isFinite(e.at) && e.at >= journalStart(paneId))
      if (end < 0) end = all.length
      // A page starts at a prompt when it can (no turn cut in two).
      let start = Math.max(0, end - OLDER_PAGE_EVENTS)
      while (start > 0 && start < end && all[start].type !== 'user') start++
      if (start >= end) start = Math.max(0, end - OLDER_PAGE_EVENTS)
      // The page's own images and files (its own image budget).
      const page = resolveHistoryAttachments(all.slice(start, end), ATTACHMENT_LIMITS)
      return { ok: true, events: page, cursor: start > 0 ? { k: source, n: start } : null, done: start <= 0 }
    } catch (err) {
      logAt('warn', `${paneId}: older history not read: ${err?.message || err}`) // i18n-ignore log line
      return { ok: false, code: 'missing' }
    }
  }

  async function skills({ paneId, refresh = false }) {
    const s = sessions.get(paneId)
    const unavailable = () => ({ ok: false, error: t('main.chat.skillsUnavailable', 'Skill discovery is unavailable.') })
    if (!s || s.closing || s.finished) return unavailable()
    // On an SSH host, Claude's skills are files there: listed there over the
    // connection (chat/remoteSkills.js), never read from this PC (Codex
    // lists its own through its server).
    if (s.remote && s.agent === 'claude') {
      if (typeof remote?.skills !== 'function') return unavailable()
      try {
        if (!trust?.isTrusted(s.cwd, [])) return unavailable()
      } catch { return unavailable() }
      if (s.skillScan) return s.skillScan
      s.skillScan = Promise.resolve().then(async () => {
        try {
          const r = await remote.skills({ hostId: s.remote.hostId, project: s.remote.path, refresh })
          if (!r?.ok || sessions.get(paneId) !== s || s.closing || s.finished) return unavailable()
          return { ok: true, result: publicSkillDiscovery(r.result) }
        } catch { return unavailable() }
        finally { s.skillScan = null }
      })
      return s.skillScan
    }
    const rootsOf = () => (s.remote ? [] : trustRoots(s.cwd, { worker: s.worker === true }) || [])
    let roots
    try {
      roots = rootsOf()
      if (!trust?.isTrusted(s.cwd, roots)) return unavailable()
    } catch { return unavailable() }
    const checked = value => {
      try {
        const currentRoots = rootsOf()
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
        agentFolderTrust: o.agentFolderTrust === true,
        envOpts: { extraEnv: o.extraEnv, accountEnv: o.accountEnv, unsetEnv: Array.isArray(o.unsetEnv) ? o.unsetEnv.filter((n) => typeof n === 'string').slice(0, 50) : [] }
      })
    })
    ipcMain.handle('chat:send', (_e, q) => {
      const { paneId, text, images: imageIds, hold } = obj(q)
      if (!validPaneId(paneId) || (hold != null && typeof hold !== 'boolean')) return invalid()
      if (imageIds != null && (!Array.isArray(imageIds) || imageIds.some((id) => typeof id !== 'string'))) return invalid()
      const withImages = Array.isArray(imageIds) && imageIds.length > 0
      // With images, the text may be empty.
      if (!(okText(text, LIMITS.text) || (withImages && typeof text === 'string' && text.length <= LIMITS.text))) return invalid()
      return sendUser({ paneId, text, ...(withImages ? { imageIds } : {}), ...(hold ? { hold: true } : {}) })
    })
    // A held message (its card): edit its text, delete it, or send it now.
    ipcMain.handle('chat:queuedEdit', (_e, q) => {
      const { paneId, id, text } = obj(q)
      if (!validPaneId(paneId) || !validId(id) || typeof text !== 'string' || text.length > LIMITS.text) return invalid()
      return queuedEdit({ paneId, id, text })
    })
    ipcMain.handle('chat:queuedDelete', (_e, q) => {
      const { paneId, id } = obj(q)
      if (!validPaneId(paneId) || !validId(id)) return invalid()
      return queuedDelete({ paneId, id })
    })
    ipcMain.handle('chat:queuedSend', (_e, q) => {
      const { paneId, id } = obj(q)
      if (!validPaneId(paneId) || !validId(id)) return invalid()
      return queuedSend({ paneId, id })
    })
    images?.register(ipcMain, validPaneId)
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
    ipcMain.handle('chat:compact', (_e, q) => {
      const { paneId } = obj(q)
      if (!validPaneId(paneId)) return invalid()
      return compact({ paneId })
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
    ipcMain.handle('chat:historyOlder', (_e, q) => {
      const { paneId, cursor } = obj(q)
      if (!validPaneId(paneId)) return invalid()
      if (cursor != null && (typeof cursor !== 'object' || Array.isArray(cursor))) return invalid()
      return historyOlder({ paneId, cursor: cursor ?? null })
    })
    ipcMain.handle('chat:history', (_e, q) => {
      const { paneId, tail } = obj(q)
      if (!validPaneId(paneId)) return invalid()
      if (tail != null && !(Number.isSafeInteger(tail) && tail > 0 && tail <= LIMITS.historyTail)) return invalid()
      return history({ paneId, ...(tail ? { tail } : {}) })
    })
  }

  return { historyOlder, open, send: sendUser, sendTeam, queuedEdit, queuedDelete, queuedSend, interrupt, answer, approve, approvalInput, setOption, compact, close, closeAll, history, skills, list, register }
}
