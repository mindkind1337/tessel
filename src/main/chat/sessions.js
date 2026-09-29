// Chat panes' agent processes: one Claude adapter (claudeChat.js) per pane,
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
import { randomBytes, randomUUID as nodeUUID } from 'crypto'
import fs from 'fs'
import { isAbsolute } from 'path'
import { buildChatEnv } from './chatEnv.js'
import { clipDeep, createChatJournal, validPaneId } from './journal.js'
import { t } from '../i18n.js'
import { approvalPreview } from '../../shared/chatApproval.js'

// teamText: a team message (6000) with the window's "(message <id>, reply to
// <id>) " prefix; a longer one is cut (teamMessageText), never refused.
export const LIMITS = { text: 100000, teamPerCall: 20, teamText: 6400, teamQueue: 200, sessions: 64 }
// As the adapter's (claudeChat.js): the CLI's --permission-mode values.
export const PERMISSION_MODES = ['default', 'bypassPermissions', 'acceptEdits', 'plan', 'auto', 'dontAsk']
export const DECISIONS = ['allow', 'allowSession', 'deny']
const ID = /^[A-Za-z0-9._:-]{1,120}$/
// Same as the orchestration / automation check; never a flag.
const FLAG = /^[A-Za-z0-9._:[\]-]{1,60}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
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
    env: envDeps,
    team,
    state,
    trust,
    trustRoots = () => [],
    log = null,
    now = Date.now,
    randomUUID = nodeUUID
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
      ...(s.model ? { model: s.model } : {}),
      ...(s.sessionId ? { sessionId: s.sessionId } : {}),
      ...(s.launchToken ? { launchToken: s.launchToken } : {}),
      ...extra
    })
  }
  const pendingApprovals = (s) => [...s.approvals.values()].some((a) => a.status === 'pending')
  function workStatus(s) {
    if (s.finished) return
    const st = pendingApprovals(s) ? 'approval' : s.turn ? 'working' : 'idle'
    // Only changes are told (the model is part of the status too).
    if (st === s.status && s.model === s.shownModel) return
    status(s, st)
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
  }

  // Starts the next turn when the agent is free.
  function pump(s) {
    if (!s.ready || s.finished || s.closing || s.turn || pendingApprovals(s)) return
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
      }
      turnStarted(s)
    })
    on('accepted', (e) => {
      if (!s.turn || !e.uuid || e.uuid !== s.turn.uuid) return
      turnStarted(s)
      markAccepted(s, s.turn)
    })
    on('textDelta', (e) => {
      if (!e.messageId || e.parentToolUseId) return
      emit(s.paneId, { type: 'assistantDelta', messageId: e.messageId, text: String(e.text ?? '') })
    })
    on('assistant', (e) => {
      const sub = typeof e.parentToolUseId === 'string' && e.parentToolUseId ? e.parentToolUseId : null
      const blocks = Array.isArray(e.blocks) ? e.blocks : []
      const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('')
      const thinking = blocks.filter((b) => b?.type === 'thinking').map((b) => b.text).join('\n')
      // A subagent's own words stay inside its tool; its tool calls are shown.
      if (!sub && e.messageId && (text || thinking)) {
        // The CLI sends one frame per content block, all with the message's
        // id: the renderer gets the message's text so far, merged.
        let m = s.messages.get(e.messageId)
        if (!m) {
          if (s.messages.size >= 200) s.messages.delete(s.messages.keys().next().value)
          m = { text: '', thinking: '' }
          s.messages.set(e.messageId, m)
        }
        if (thinking) {
          m.thinking = m.thinking ? `${m.thinking}\n${thinking}` : thinking
          emit(s.paneId, { type: 'thinking', messageId: e.messageId, text: m.thinking })
        }
        if (text) {
          m.text = m.text ? `${m.text}\n\n${text}` : text
          emit(s.paneId, { type: 'assistant', messageId: e.messageId, text: m.text })
        }
      }
      for (const b of blocks) {
        if (b?.type !== 'tool_use' || !b.id) continue
        s.tools.add(b.id)
        emit(s.paneId, {
          type: 'tool',
          id: b.id,
          name: String(b.name || ''),
          summary: toolSummary(b.name, b.input),
          input: clipDeep(b.input ?? {}),
          status: 'running',
          ...(sub ? { parentToolUseId: sub } : {})
        })
      }
    })
    on('toolResult', (e) => {
      if (!e.toolUseId) return
      s.tools.delete(e.toolUseId)
      emit(s.paneId, { type: 'toolResult', id: e.toolUseId, isError: e.isError === true, text: String(e.text ?? '') })
    })
    on('permission', (e) => {
      if (!e.requestId || s.approvals.has(e.requestId)) return
      const toolId = stateId(e.toolUseId) || stateId(e.requestId)
      const input = e.input && typeof e.input === 'object' ? e.input : {}
      // What the card shows (its first characters) and how much it hides: an
      // input with hidden characters is allowed only once the window fetched
      // it whole (chat:approvalInput), since the whole input is what runs.
      const { detail, hidden } = approvalPreview(input)
      s.approvals.set(e.requestId, { status: 'pending', toolId, input, hidden, fetched: false })
      turnStarted(s)
      emit(s.paneId, {
        type: 'approval',
        requestId: e.requestId,
        toolName: String(e.toolName || ''),
        displayName: String(e.displayName || e.toolName || ''),
        input: clipDeep(input),
        detail,
        hidden,
        sessionRules: Array.isArray(e.sessionRules) ? e.sessionRules : [],
        description: String(e.description || ''),
        status: 'pending'
      })
      record(s, 'PermissionRequest', { toolId })
      record(s, 'Notification', { toolId, notificationType: 'permission_prompt' })
      workStatus(s)
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
      }
    })
    on('turnEnd', (e) => {
      const turn = s.turn
      if (turn && !turn.accepted) {
        const uuids = Array.isArray(e.userMessageUuids) ? e.userMessageUuids : []
        if (turn.uuid && uuids.includes(turn.uuid)) markAccepted(s, turn)
        else markFailed(s, turn)
      }
      if (turn) turnStarted(s)
      const st = ['completed', 'interrupted', 'failed'].includes(e.status) ? e.status : 'failed'
      s.lastInterrupted = st === 'interrupted'
      emit(s.paneId, {
        type: 'turnEnd',
        status: st,
        ...(e.usage ? { usage: e.usage } : {}),
        ...(typeof e.costUsd === 'number' ? { costUsd: e.costUsd } : {}),
        ...(typeof e.durationMs === 'number' ? { durationMs: e.durationMs } : {}),
        ...(st === 'failed' && e.result ? { error: String(e.result).slice(0, 4000) } : {})
      })
      // Tools of the turn that never reported a result.
      for (const id of s.tools) emit(s.paneId, { type: 'tool', id, status: st === 'completed' ? 'done' : 'error' })
      s.tools.clear()
      s.messages.clear()
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
        text: t('main.chat.authError', 'Claude is not signed in (or its sign-in expired). Sign in, then reopen this chat.')
      })
    })
    on('stderr', (e) => logAt('info', `${s.paneId} stderr: ${String(e.text || '').slice(-500)}`))
    on('exit', (e) => finish(s, e))
  }

  // The process is gone (or given up on): everything tied to it is released.
  function finish(s, e = {}) {
    if (s.finished) return
    s.finished = true
    if (s.turn) markFailed(s, s.turn)
    s.turn = null
    for (const m of s.userQueue) emit(s.paneId, { type: 'userStatus', id: m.id, status: 'failed' })
    s.userQueue = []
    if (s.teamQueue.length) emit(s.paneId, { type: 'teamFailed', ids: s.teamQueue.map((m) => m.id) })
    s.teamQueue = []
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
  function startError(code) {
    if (code === 'signin') return t('main.chat.signin', 'Claude is not signed in. Sign in to Claude Code, then try again.')
    if (code === 'spawn') return t('main.chat.spawnFailed', 'Claude Code could not be started.')
    if (code === 'timeout') return t('main.chat.startTimeout', 'Claude Code did not answer in time.')
    if (code === 'exit') return t('main.chat.exitedAtStart', 'Claude Code stopped while starting.')
    return t('main.chat.startFailed', 'The agent could not start.')
  }

  function current(s) {
    return { ok: true, sessionId: s.sessionId, launchToken: s.launchToken, model: s.model || null }
  }

  async function open(opts = {}) {
    const { paneId, cwd, projectDir, resumeId, model, effort, permissions = 'manual', permissionMode, accountEnv, askTrust, envOpts } = opts
    const agent = opts.agent ?? 'claude'
    if (
      !validPaneId(paneId) ||
      agent !== 'claude' ||
      !validFolder(cwd) ||
      (projectDir != null && projectDir !== '' && !validFolder(projectDir)) ||
      (resumeId != null && (typeof resumeId !== 'string' || !UUID.test(resumeId))) ||
      (model != null && !validFlag(model)) ||
      (effort != null && !validFlag(effort)) ||
      !['yolo', 'manual'].includes(permissions) ||
      (permissionMode != null && !PERMISSION_MODES.includes(permissionMode))
    )
      return { ok: false, code: 'invalid', error: t('main.chat.invalid', 'Invalid chat request.') }

    const existing = sessions.get(paneId)
    if (existing) {
      // Live (a remounted pane opening again): harmless, the running session.
      if (!existing.closing && !existing.finished) return existing.ready ? current(existing) : existing.opening
      return { ok: false, code: 'busy', error: t('main.chat.busy', 'This chat is still closing.') }
    }
    if (resumeId && [...sessions.values()].some((x) => x.sessionId === resumeId))
      return { ok: false, code: 'busy', error: t('main.chat.sessionOpen', 'This conversation is already open in another pane.') }
    if (sessions.size >= LIMITS.sessions)
      return { ok: false, code: 'failed', error: t('main.chat.tooMany', 'Too many chats are open.') }

    // Placeholder first: a second open meanwhile shares this start.
    const s = {
      paneId,
      adapter: null,
      sessionId: resumeId || randomUUID(),
      launchToken: null,
      model: model || null,
      effort: effort || null,
      permissions,
      cwd,
      projectDir: projectDir || null,
      status: 'starting',
      ready: false,
      closing: false,
      finished: false,
      turn: null,
      userQueue: [],
      teamQueue: [],
      approvals: new Map(),
      tools: new Set(),
      messages: new Map(), // messageId -> { text, thinking } merged so far
      lastInterrupted: false,
      started: false
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
      let roots = []
      try {
        roots = trustRoots(cwd) || []
      } catch {
        roots = []
      }
      if (!trust?.isTrusted(cwd, roots)) {
        const yes = askTrust === true && trust?.ask ? await trust.ask(cwd) : false
        if (s.closing) return closedWhileStarting()
        if (!yes) {
          drop()
          emit(paneId, { type: 'status', state: 'untrusted' })
          return { ok: false, code: 'untrusted', error: t('main.chat.untrusted', 'This folder is not trusted for chat agents yet.') }
        }
      }

      if (s.closing) return closedWhileStarting()
      let claude = null
      try {
        claude = await resolveClaude()
      } catch {
        claude = null
      }
      if (s.closing) return closedWhileStarting()
      if (!claude || typeof claude.exe !== 'string' || !claude.exe) {
        drop()
        emit(paneId, { type: 'status', state: 'crashed', error: t('main.chat.noClaude', 'Claude Code was not found. Install it, then try again.') })
        return { ok: false, code: 'no-claude', error: t('main.chat.noClaude', 'Claude Code was not found. Install it, then try again.') }
      }

      emit(paneId, { type: 'status', state: 'starting', sessionId: s.sessionId })
      const teamSecret = team.newSecret()
      let base = envDeps.forPane({ paneId, cwd, projectDir: s.projectDir, accountEnv, ...(envOpts || {}) })
      if (base && typeof base === 'object' && base.env && typeof base.env === 'object') base = base.env
      const childEnv = buildChatEnv(base, { paneId, teamSecret, projectDir: s.projectDir, pathEnv: claude.pathEnv })
      const permissionModeUsed = permissions === 'yolo' ? 'bypassPermissions' : permissionMode && permissionMode !== 'bypassPermissions' ? permissionMode : 'default'

      try {
        s.adapter = createAdapter({
          exe: claude.exe,
          exeArgs: Array.isArray(claude.exeArgs) ? claude.exeArgs : [],
          cwd,
          env: childEnv,
          ...(resumeId ? { resume: resumeId } : { sessionId: s.sessionId }),
          ...(s.model ? { model: s.model } : {}),
          ...(s.effort ? { effort: s.effort } : {}),
          permissionMode: permissionModeUsed,
          log
        })
      } catch (err) {
        drop()
        const error = String(err?.message || err)
        emit(paneId, { type: 'status', state: 'crashed', error })
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
        const error = startError(r?.code)
        // The adapter's own text (stderr tail) is internal English: a detail.
        const detail = typeof r?.error === 'string' && r.error ? r.error.slice(-2000) : undefined
        emit(paneId, { type: 'status', state: signin ? 'signin' : 'crashed', error, ...(detail ? { detail } : {}) })
        return { ok: false, code: signin ? 'signin' : 'failed', error, ...(detail ? { detail } : {}) }
      }
      s.started = true
      s.launchToken = randomBytes(16).toString('hex')
      if (!s.finished) {
        try {
          await state?.register?.({ paneId, provider: 'claude', launchToken: s.launchToken, startedAt: now() })
          record(s, 'SessionStart')
          observe(s, 'ScreenReady')
        } catch (err) {
          logAt('warn', `${paneId}: agent status unavailable: ${err?.message || err}`)
        }
      }
      journalOf(paneId).writeMeta({ sessionId: s.sessionId, agent: 'claude', cwd })
      if (s.finished || s.closing) {
        // Gone (or closed) while its status was being registered.
        if (state?.unregister) Promise.resolve().then(() => state.unregister(paneId, s.launchToken)).catch(() => {})
        if (!s.finished) finish(s, { code: 0 })
        return { ok: false, code: 'failed', error: t('main.chat.startFailed', 'The agent could not start.') }
      }
      s.ready = true
      status(s, 'idle')
      pump(s)
      return { ok: true, sessionId: s.sessionId, launchToken: s.launchToken, model: s.model || null }
    })()
    return s.opening
  }

  function live(paneId) {
    const s = sessions.get(paneId)
    return s && s.ready && !s.finished && !s.closing ? s : null
  }
  const closed = () => ({ ok: false, code: 'closed', error: t('main.chat.notOpen', 'This chat is not running.') })

  // A user message (origin 'user'); team messages go through sendTeam.
  function sendUser({ paneId, text } = {}) {
    const s = live(paneId)
    if (!s) return closed()
    const id = randomUUID()
    const now_ = now()
    const idle = !s.turn && !pendingApprovals(s) && !s.userQueue.length
    emit(paneId, { type: 'user', id, text, origin: 'user', status: idle ? 'sent' : 'queued', at: now_ })
    if (idle) void deliver(s, { kind: 'user', uuid: id, ids: [id], text })
    else s.userQueue.push({ id, text })
    return { ok: true, id, queued: !idle }
  }

  function sendTeam({ paneId, messages } = {}) {
    const s = live(paneId)
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
    return { ok: true, ids: added }
  }

  async function interrupt({ paneId } = {}) {
    const s = live(paneId)
    if (!s) return closed()
    try {
      const r = await s.adapter.interrupt()
      return { ok: !!r?.ok }
    } catch {
      return { ok: false }
    }
  }

  async function approve({ paneId, requestId, decision, message } = {}) {
    const s = live(paneId)
    if (!s) return closed()
    const ap = s.approvals.get(requestId)
    if (!ap || ap.status !== 'pending')
      return { ok: false, code: 'unknown', error: t('main.chat.noApproval', 'This request was already answered or is gone.') }
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
    const s = live(paneId)
    if (!s) return closed()
    const results = []
    if (model != null) {
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
      else results.push(!!(await s.adapter.setPermissionMode(permissionMode).catch(() => ({ ok: false })))?.ok)
    }
    if (model != null && s.ready) workStatus(s)
    return { ok: results.every(Boolean), model: s.model, effort: s.effort }
  }

  // forget: the pane is closed for good (its journal is deleted). kill:
  // Tessel quits (the adapter kills the process tree at once).
  async function close({ paneId, forget = false, kill = false } = {}) {
    const s = sessions.get(paneId)
    if (forget) forgotten.add(paneId)
    if (s && !s.finished) {
      s.closing = true
      try {
        await s.adapter?.close?.(kill ? { kill: true } : undefined)
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

  function history({ paneId } = {}) {
    if (!validPaneId(paneId)) return { ok: false, code: 'invalid', events: [], seq: 0, open: false }
    const j = journalOf(paneId)
    const events = j.read()
    if (!seqs.has(paneId)) seqs.set(paneId, events.length ? events[events.length - 1].seq : 0)
    const s = sessions.get(paneId)
    return {
      ok: true,
      events,
      seq: seqs.get(paneId),
      meta: j.readMeta(),
      // A live session (starting, idle, working, approval): do not open it again.
      open: !!s && !s.finished && !s.closing,
      live: s
        ? { status: s.status, sessionId: s.sessionId, launchToken: s.launchToken, model: s.model, queued: s.userQueue.length + s.teamQueue.length }
        : null
    }
  }

  function list() {
    return [...sessions.values()].map((s) => ({ paneId: s.paneId, sessionId: s.sessionId, status: s.status, model: s.model, launchToken: s.launchToken }))
  }

  // ---- IPC -------------------------------------------------------------------

  const invalid = () => ({ ok: false, code: 'invalid', error: t('main.chat.invalid', 'Invalid chat request.') })
  const obj = (q) => (q && typeof q === 'object' && !Array.isArray(q) ? q : {})
  const okText = (s, max) => typeof s === 'string' && s.trim().length > 0 && s.length <= max

  function register(ipcMain) {
    ipcMain.handle('chat:open', (_e, q) => {
      const o = obj(q)
      // Only these fields: never a command. The variables come as for a
      // terminal pane (pty:create): Settings > Agents and the provider
      // account's, checked by paneEnv (names only, never TESSEL_*).
      return open({
        paneId: o.paneId,
        agent: o.agent,
        cwd: o.cwd,
        projectDir: o.projectDir || undefined,
        resumeId: o.resumeId || undefined,
        model: o.model || undefined,
        effort: o.effort || undefined,
        permissions: o.permissions,
        permissionMode: o.permissionMode || undefined,
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
      if (model != null && !validFlag(model)) return invalid()
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
    ipcMain.handle('chat:history', (_e, q) => {
      const { paneId } = obj(q)
      if (!validPaneId(paneId)) return invalid()
      return history({ paneId })
    })
  }

  return { open, send: sendUser, sendTeam, interrupt, approve, approvalInput, setOption, close, closeAll, history, list, register }
}
