// Tessel's chat events (src/main/chat/sessions.js, 'chat:event') turned into
// the journal the ported chat UI reads: the render items and submissions of
// the reference's structured agent sessions (after Orca's
// src/shared/agent-session-journal-types.ts and agent-session-wire.ts, MIT,
// Copyright (c) 2026 Lovecast Inc.). The UI's own reducer
// (shared/structured-agent-session-reducer.js) and projections then run
// unchanged: this is the only place that knows both vocabularies.
//
// One adapter per chat pane. It keeps every item it made (by id), bumps an
// item's revision on each change and keeps the sequence it was created with,
// so the reducer's merge (higher revision wins, order by sequence) holds.
// apply(event) returns the subscribe event to feed the reducer: a 'batch'
// with the items and submissions that changed, or null when nothing did.
import { agentJournalSubmissionKey } from '../shared/agent-session-journal-item-key.js'
import { normalizeSubagentState, MAX_SUBAGENT_FIELD_CHARS, subagentGroupFallbackText } from '../shared/native-chat-subagent-summary.js'
import { fileRefBlocks, imageRefBlocks } from '../native-chat-images.js'
import { t } from '../../../i18n'

// Output kept in a tool row: the same bound as the main process's journal.
const MAX_OUTPUT = 8 * 1024

// Our tool status -> the journal's tool-call state.
const TOOL_STATE = { running: 'running', done: 'completed', completed: 'completed', error: 'failed', failed: 'failed', stopped: 'interrupted' }
// Our user row status -> the journal's dispatch state. A failed send stays
// visible ('unknown': delivery not confirmed), never 'rejected', which would
// hide the message; Tessel shows its own "Not sent" entry with Retry.
const DISPATCH = { queued: 'pending', sent: 'pending', accepted: 'accepted', failed: 'unknown' }
// Our approval status -> the chosen option (resolved) or a cancellation.
// The agent's process is gone in these (asleep included); the composer
// cannot send in the stopped ones.
const STOPPED = new Set(['ended', 'crashed', 'signin', 'untrusted'])
const NO_PROCESS = new Set([...STOPPED, 'asleep'])
const APPROVAL_OPTION = { allowed: 'allow', allowedSession: 'allowSession', denied: 'deny' }

function bounded(text) {
  const s = String(text ?? '')
  return { head: s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) : s, byteLength: s.length, digest: '', truncated: s.length > MAX_OUTPUT }
}

// A row a subagent produced: its child id (the roster's agents[].id) and the
// provider's parent reference (provenance only). The session's own rows have
// neither.
function childLinkage(ev) {
  const agentId = ev.agentId ?? ev.parentToolUseId
  if (agentId == null || agentId === '') return {}
  return { agentId: String(agentId), ...(ev.parentToolUseId ? { providerParentRef: String(ev.parentToolUseId) } : {}) }
}

// A child's content never opens (or keeps open) the main agent's turn: a
// background child can go on after it.
function isChild(ev) {
  return ev.agentId != null && ev.agentId !== ''
}
// A message's item id: the engine keys a child's messages by agent and
// message id, so they never meet the parent's.
function messageKey(ev) {
  return isChild(ev) ? `child:${ev.agentId}:${ev.messageId}` : String(ev.messageId) // i18n-ignore
}

// One roster entry from the engine, bounded like the reference's.
function subagentEntry(a) {
  if (!a || typeof a !== 'object' || a.id == null) return null
  const entry = { id: String(a.id), label: String(a.label ?? a.id).slice(0, MAX_SUBAGENT_FIELD_CHARS), state: normalizeSubagentState(String(a.state ?? '')) }
  if (Number.isFinite(a.tokens)) entry.tokens = a.tokens
  if (Number.isFinite(a.startedAt)) entry.startedAt = a.startedAt
  if (Number.isFinite(a.settledAt)) entry.settledAt = a.settledAt
  return entry
}

// A tool's paths as the chat shows them: relative to the chat's folder when
// inside it (src/x.js), whole when outside it (the reader must see where).
const PATH_KEYS = ['file_path', 'filePath', 'notebook_path', 'path']
export function relativeToolPath(path, cwd) {
  if (typeof path !== 'string' || !path || !cwd) return path
  const norm = (s) => s.replace(/\\/g, '/').replace(/\/+$/, '')
  const base = norm(cwd)
  const full = norm(path)
  if (base && full.toLowerCase().startsWith(base.toLowerCase() + '/')) return full.slice(base.length + 1)
  return path
}
function relativeToolInput(input, cwd) {
  if (!cwd || !input || typeof input !== 'object' || Array.isArray(input)) return input
  let out = input
  for (const key of PATH_KEYS) {
    const rel = relativeToolPath(input[key], cwd)
    if (rel !== input[key]) out = { ...out, [key]: rel }
  }
  if (Array.isArray(input.changes)) {
    const changes = input.changes.map((c) => (c && typeof c === 'object' && typeof c.path === 'string' ? { ...c, path: relativeToolPath(c.path, cwd) } : c))
    if (changes.some((c, i) => c !== input.changes[i])) out = { ...out, changes }
  }
  return out
}

function parseInput(input) {
  if (typeof input !== 'string') return input ?? null
  try {
    return JSON.parse(input)
  } catch {
    return input
  }
}

// cwd: the chat's folder (a value or a getter): tool paths inside it are shown relative.
// idTag: a mark for the ids this adapter makes up itself (turns, notices),
// so an older page's never meet the chat's own.
// optionText(ev): the words of a model or effort change ({ option, value, ok });
// the pane gives translated ones (chat-option-notice.js).
function defaultOptionText(ev) {
  return `${ev.option}: ${ev.value}${ev.ok === false ? ' (not changed)' : ''}` // i18n-ignore fallback, the pane words it
}

export function createJournalAdapter({ now = Date.now, epoch = 'tessel', fence = 1, cwd = '', idTag = '', optionText = defaultOptionText } = {}) {
  const folder = () => (typeof cwd === 'function' ? cwd() : cwd) || ''
  const items = new Map() // itemId -> render item
  const submissions = new Map() // clientMessageId -> submission
  let sequence = 0
  let turnSeq = 0
  // The open turn item's id (null between turns), and the newest user item id.
  let openTurn = null
  let retryItemId = null
  let retryAttempt = 0
  let lastUserItemId = null
  // Session facts the UI reads outside the journal (header, pickers).
  // subagents: the children this conversation started, by id ({ id, title,
  // type, model, state: 'running' | 'done' | 'quiet', startedAt, endedAt,
  // tokens, lastAt }), as the pane header's list shows them (AgentChildren).
  const meta = { agent: null, model: null, sessionId: null, status: 'starting', error: '', rateLimit: null, commands: null, queuedIds: [], subagents: {}, backgroundTasks: 0 }

  let changedItems = new Set()
  let changedSubs = new Set()
  let removedItems = new Set()

  // Rows are ordered by time, then id: a new item's time never goes back nor
  // ties with the previous one (events of one millisecond keep their order).
  let lastObservedAt = -Infinity
  let olderPages = 0
  // The last failed turn's error: a notice saying the same is not shown twice.
  let lastTurnError = ''
  function put(itemId, body, extra = {}, at = now()) {
    const prior = items.get(itemId)
    let observedAt = at
    if (!prior) {
      observedAt = Math.max(Number.isFinite(at) ? at : 0, lastObservedAt + 1)
      lastObservedAt = observedAt
    }
    const item = prior
      ? { ...prior, ...extra, body, revision: prior.revision + 1 }
      : { itemId, revision: 1, body, sequence: ++sequence, observedAt, ...extra }
    items.set(itemId, item)
    changedItems.add(itemId)
    removedItems.delete(itemId)
    return item
  }
  function revise(itemId, patch) {
    const prior = items.get(itemId)
    if (!prior) return null
    return put(itemId, { ...prior.body, ...patch })
  }
  function submit(clientMessageId, dispatchState, at = now()) {
    const prior = submissions.get(clientMessageId)
    const next = {
      clientMessageId,
      fence,
      payloadFingerprint: '',
      dispatchState,
      providerItemId: null,
      reason: null,
      submittedAt: prior ? prior.submittedAt : at,
      resolvedAt: dispatchState === 'pending' ? null : at
    }
    if (prior && prior.dispatchState === next.dispatchState) return
    submissions.set(clientMessageId, next)
    changedSubs.add(clientMessageId)
  }

  // Messages waiting in the engine's queue for the end of the turn (Tessel's
  // "Queued" chip), by client message id.
  function setQueued(id, queued) {
    const has = meta.queuedIds.includes(id)
    if (queued && !has) meta.queuedIds = [...meta.queuedIds, id]
    else if (!queued && has) meta.queuedIds = meta.queuedIds.filter((x) => x !== id)
  }

  // A turn opens once the agent took a message (its echo) or starts working
  // on its own; its row comes after the user message and before the answer.
  function openTurnFor(userItemId, at = now()) {
    if (openTurn) return
    const turnId = `${idTag}tessel-turn-${++turnSeq}` // i18n-ignore
    openTurn = `turn:${turnId}` // i18n-ignore
    put(openTurn, { kind: 'turn', turnId, state: 'running', ...(userItemId ? { userItemId } : {}), startedAt: at, requestedAt: at }, {}, at)
  }
  function closeTurn({ state = 'completed', outcome, durationMs, usage } = {}, at = now()) {
    if (!openTurn) return
    const prior = items.get(openTurn)
    const patch = { state, completedAt: at }
    if (outcome) patch.outcome = outcome
    if (Number.isFinite(durationMs)) patch.durationMs = durationMs
    // A turn's usage is its total over every request: not the context. Only
    // when nothing better said it (the engine's contextUsage follows).
    const estimate = prior.body.contextUsage && prior.body.contextUsage.used ? null : usageEstimate(usage, at)
    if (estimate) patch.contextUsage = { ...(prior.body.contextUsage || {}), used: estimate }
    revise(openTurn, patch)
    openTurn = null
  }

  function usageEstimate(usage, at) {
    if (!usage || typeof usage !== 'object') return null
    const n = (v) => (Number.isFinite(v) ? v : 0)
    return {
      kind: 'estimate',
      usage: {
        inputTokens: n(usage.input_tokens ?? usage.inputTokens),
        cacheCreationInputTokens: n(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens),
        cacheReadInputTokens: n(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens),
        outputTokens: n(usage.output_tokens ?? usage.outputTokens)
      },
      capturedAt: at
    }
  }

  // The text of an assistant message so far (deltas, then the final text).
  const streamed = new Map()

  // Context facts go on the open turn, else the newest turn held (like the
  // reference's writeClaudeTurnRow); none yet: nothing to carry them.
  function newestTurnId() {
    if (openTurn) return openTurn
    let best = null
    for (const item of items.values()) if (item.body.kind === 'turn' && (!best || item.sequence > best.sequence)) best = item
    return best ? best.itemId : null
  }
  function writeContext(facts) {
    const id = newestTurnId()
    if (!id) return
    const prior = items.get(id)
    revise(id, { contextUsage: { ...(prior.body.contextUsage || {}), ...facts } })
  }

  // The header's list of sub-agents: the roster's snapshots (state, times,
  // tokens) and the lifecycle events (kind, model, full description).
  const CHILD_STATE = { working: 'running', unverifiable: 'quiet' }
  function noteChild(id, patch, at) {
    if (id == null || id === '') return
    const key = String(id)
    const prior = meta.subagents[key] || { id: key, title: '', type: '', model: '', state: 'running' }
    const next = { ...prior, lastAt: at }
    for (const [k, v] of Object.entries(patch)) if (v !== undefined && v !== null && v !== '') next[k] = v
    const ids = Object.keys(meta.subagents)
    // Bounded like the engine's tracker (32 groups of 64).
    const rest = !meta.subagents[key] && ids.length >= 512 ? Object.fromEntries(ids.slice(1).map((k) => [k, meta.subagents[k]])) : meta.subagents
    meta.subagents = { ...rest, [key]: next }
  }
  function childState(state) {
    return CHILD_STATE[state] || (state ? 'done' : undefined)
  }

  function applyEvent(ev) {
    const at = Number.isFinite(ev.at) ? ev.at : now()
    // A successful response or a turn boundary ends the retry burst. Status
    // updates between attempts do not multiply its warning in the transcript.
    if (['user', 'assistant', 'assistantDelta', 'tool', 'turnEnd'].includes(ev.type) ||
        (ev.type === 'status' && ['starting', 'idle', 'ended', 'crashed', 'asleep'].includes(ev.state))) retryItemId = null
    if (ev.type === 'retry') {
      if (!retryItemId) {
        retryItemId = `status:${idTag}retry-${sequence + 1}` // i18n-ignore
        retryAttempt = 0
      }
      retryAttempt = Number.isSafeInteger(ev.attempt) && ev.attempt > 0 ? ev.attempt : retryAttempt + 1
      const message = typeof ev.message === 'string' ? ev.message.trim().slice(0, 2000) : ''
      const progress = t('chat.retry.attempt', 'Reconnecting… attempt {{attempt}}', { attempt: retryAttempt })
      const text = message
        ? `${progress} — ${message}`
        : progress
      put(retryItemId, { kind: 'status', text, tone: 'warning' }, {}, at)
      return
    }
    switch (ev.type) {
      case 'status': {
        if (ev.agent) meta.agent = ev.agent
        if (ev.model) meta.model = ev.model
        if (ev.sessionId) meta.sessionId = ev.sessionId
        if (typeof ev.state === 'string') {
          meta.status = ev.state
          // The error of a stopped agent stays until it runs again.
          meta.error = ev.error ? String(ev.error) : STOPPED.has(ev.state) ? meta.error : ''
        }
        if (ev.state === 'working' || ev.state === 'approval') openTurnFor(lastUserItemId, at)
        // No process any more: nothing it started still runs (its tools
        // stopped, its questions can no longer be answered), and a turn still
        // open did not end on its own.
        if (NO_PROCESS.has(ev.state) || ev.state === 'starting') meta.backgroundTasks = 0
        if (NO_PROCESS.has(ev.state)) {
          for (const item of [...items.values()]) {
            if (item.body.kind === 'tool-call' && item.body.state === 'running') revise(item.itemId, { state: 'interrupted' })
            else if ((item.body.kind === 'approval' || item.body.kind === 'question') && item.body.resolution && item.body.resolution.state === 'pending') revise(item.itemId, { resolution: resolutionOf('cancelled', at) })
          }
          closeTurn({ state: 'interrupted', outcome: 'cancellation' }, at)
          // Nor its sub-agents (they ran in its process).
          for (const [id, c] of Object.entries(meta.subagents)) if (c.state === 'running') noteChild(id, { state: 'quiet' }, c.lastAt)
        }
        break
      }
      case 'user': {
        if (!ev.id) break
        const itemId = agentJournalSubmissionKey(String(ev.id))
        const body = { kind: 'message', role: 'user', blocks: [{ type: 'text', text: String(ev.text ?? '') }] }
        // Tessel's addition: its attached images (thumbnails while this window has them).
        // A history message: its images (data: URLs) and its other files (chips).
        const pictures = ev.origin === 'team' ? [] : [...imageRefBlocks(ev.images), ...fileRefBlocks(ev.files)]
        if (pictures.length) body.blocks = [...pictures, ...(body.blocks[0].text ? body.blocks : [])]
        // Tessel's addition: a teammate's message, labelled as such. Its
        // "(message <id>, reply to <id>) " header is for the agent (to answer
        // with reply_to): the chat shows the message alone.
        if (ev.origin === 'team') {
          body.blocks[0].text = body.blocks[0].text.replace(/^(?:\(message [\w.:-]{1,120}(?:, reply to [\w.:-]{1,120})?\)\s*)+/, '')
          body.sentAs = 'team'
          if (ev.from) body.from = String(ev.from)
        }
        put(itemId, body, {}, at)
        lastUserItemId = itemId
        setQueued(String(ev.id), ev.status === 'queued')
        submit(String(ev.id), DISPATCH[ev.status] || 'pending', at)
        if (ev.status === 'accepted') openTurnFor(itemId, at)
        break
      }
      case 'userStatus': {
        if (!ev.id) break
        setQueued(String(ev.id), ev.status === 'queued')
        submit(String(ev.id), DISPATCH[ev.status] || 'pending', at)
        if (ev.status === 'accepted') openTurnFor(agentJournalSubmissionKey(String(ev.id)), at)
        break
      }
      case 'teamAccepted':
      case 'teamFailed': {
        for (const id of Array.isArray(ev.ids) ? ev.ids : []) setQueued(String(id), false)
        for (const id of Array.isArray(ev.ids) ? ev.ids : []) submit(String(id), ev.type === 'teamAccepted' ? 'accepted' : 'unknown', at)
        break
      }
      case 'assistantDelta': {
        if (!ev.messageId) break
        const key = messageKey(ev)
        const text = (streamed.get(key) || '') + String(ev.text ?? '')
        streamed.set(key, text)
        if (!isChild(ev)) openTurnFor(lastUserItemId, at)
        put(key, { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }, childLinkage(ev), at)
        break
      }
      case 'assistant': {
        if (!ev.messageId) break
        const key = messageKey(ev)
        const text = String(ev.text ?? '')
        streamed.set(key, text)
        if (!isChild(ev)) openTurnFor(lastUserItemId, at)
        put(key, { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }, childLinkage(ev), at)
        break
      }
      case 'thinking': {
        if (!ev.messageId || !ev.text) break
        put(`reasoning:${messageKey(ev)}`, { kind: 'message', role: 'reasoning', blocks: [{ type: 'text', text: String(ev.text) }] }, childLinkage(ev), at) // i18n-ignore
        break
      }
      case 'tool': {
        if (!ev.id) break
        const itemId = `tool:${ev.id}` // i18n-ignore
        const prior = items.get(itemId)
        const state = TOOL_STATE[ev.status] || (prior ? prior.body.state : 'running')
        if (prior && ev.name == null) {
          // A status-only update (end of turn, stopped): keep its call.
          revise(itemId, { state })
          break
        }
        const linkage = childLinkage(ev)
        if (!isChild(ev)) openTurnFor(lastUserItemId, at)
        put(itemId, { kind: 'tool-call', name: String(ev.name ?? ''), input: relativeToolInput(parseInput(ev.input), folder()), callId: String(ev.id), state, ...(prior && prior.body.output ? { output: prior.body.output } : {}) }, linkage, at)
        break
      }
      case 'toolResult': {
        if (!ev.id) break
        const itemId = `tool:${ev.id}` // i18n-ignore
        if (!items.has(itemId)) put(itemId, { kind: 'tool-call', name: '', input: null, callId: String(ev.id), state: 'running' }, childLinkage(ev), at)
        revise(itemId, { state: ev.isError ? 'failed' : 'completed', output: bounded(ev.text) })
        break
      }
      case 'approval': {
        if (!ev.requestId) break
        const status = ev.status || 'pending'
        const body = {
          kind: 'approval',
          // The card words the title itself (translated); this stays data.
          title: String(ev.displayName || ev.toolName || ''),
          displayName: String(ev.displayName || ev.toolName || ''),
          ...(ev.description ? { description: String(ev.description) } : {}),
          detail: typeof ev.detail === 'string' ? ev.detail : null,
          options: [
            { id: 'allow', label: 'Allow' }, // i18n-ignore
            ...(sessionOffered(ev.choices) ? [{ id: 'allowSession', label: 'Allow for this session' }] : []), // i18n-ignore
            { id: 'deny', label: 'Deny' } // i18n-ignore
          ],
          resolution: resolutionOf(status, at),
          // Tessel's own fields (its approval card keeps its protections).
          tessel: {
            requestId: String(ev.requestId),
            toolName: String(ev.toolName || ''),
            input: ev.input ?? null,
            hidden: Number.isSafeInteger(ev.hidden) ? ev.hidden : 0,
            sessionRules: Array.isArray(ev.sessionRules) ? ev.sessionRules : [],
            choices: Array.isArray(ev.choices) ? ev.choices : null
          }
        }
        put(`approval:${ev.requestId}`, body, {}, at) // i18n-ignore
        break
      }
      case 'question': {
        // An agent's question (Claude's AskUserQuestion, Codex's user input):
        // a prompt card until answered here, cancelled, or its process gone.
        if (!ev.requestId || !Array.isArray(ev.questions) || !ev.questions.length) break
        const questions = ev.questions
          .filter((q) => q && typeof q === 'object')
          .map((q) => ({
            id: String(q.id ?? ''),
            question: String(q.question ?? ''),
            ...(q.header ? { header: String(q.header) } : {}),
            multiSelect: q.multiSelect === true,
            options: (Array.isArray(q.options) ? q.options : []).filter((o) => o && typeof o === 'object').map((o) => ({ id: String(o.id ?? ''), label: String(o.label ?? ''), ...(o.description ? { description: String(o.description) } : {}) })),
            ...(q.freeTextQuestionId ? { freeTextQuestionId: String(q.freeTextQuestionId) } : {})
          }))
        if (!questions.length) break
        openTurnFor(lastUserItemId, at)
        put(
          `question:${ev.requestId}`, // i18n-ignore
          {
            kind: 'question',
            question: questions[0].question,
            options: questions[0].options,
            questions,
            resolution: resolutionOf(ev.status === 'cancelled' ? 'cancelled' : ev.status === 'answered' ? 'answered' : 'pending', at),
            tessel: { requestId: String(ev.requestId) }
          },
          {},
          at
        )
        break
      }
      case 'questionStatus': {
        const itemId = `question:${ev.requestId}` // i18n-ignore
        if (!items.has(itemId)) break
        revise(itemId, { resolution: resolutionOf(ev.status === 'answered' ? 'answered' : 'cancelled', at), ...(Array.isArray(ev.answers) ? { answers: ev.answers } : {}) })
        break
      }
      case 'approvalStatus': {
        const itemId = `approval:${ev.requestId}` // i18n-ignore
        if (!items.has(itemId)) break
        revise(itemId, { resolution: resolutionOf(ev.status, at) })
        break
      }
      case 'turnEnd': {
        const outcome = ev.status === 'failed' ? 'failure' : ev.status === 'interrupted' ? 'cancellation' : 'success'
        closeTurn({ state: ev.status === 'interrupted' ? 'interrupted' : 'completed', outcome, durationMs: ev.durationMs, usage: ev.usage }, at)
        lastTurnError = ev.error ? String(ev.error) : ''
        if (ev.error) put(`status:${idTag}turn-${sequence + 1}`, { kind: 'status', text: String(ev.error), tone: 'error' }, {}, at) // i18n-ignore
        break
      }
      case 'notice': {
        if (!ev.text) break
        const tone = ev.kind === 'error' ? 'error' : ev.kind === 'warning' ? 'warning' : 'notice'
        if (tone === 'error' && String(ev.text) === lastTurnError) break
        // action: what the notice offers (a button): 'newConversation'.
        const action = typeof ev.action === 'string' && ev.action ? { action: ev.action } : {}
        // An interruption stays in view when its turn folds (a session notice).
        const presentation = ev.presentation === 'interrupted' ? { presentation: 'interrupted' } : {}
        put(`status:${idTag}notice-${sequence + 1}`, { kind: 'status', text: String(ev.text), tone, ...action, ...presentation }, {}, at) // i18n-ignore
        break
      }
      case 'subagents': {
        // The engine's full roster of one spawn group, revised in place; the
        // session's own row (never a child's). An empty roster removes it.
        if (ev.groupId == null) break
        const itemId = `subagents:${ev.groupId}` // i18n-ignore
        const agents = (Array.isArray(ev.agents) ? ev.agents : []).map(subagentEntry).filter(Boolean)
        for (const a of agents) {
          noteChild(a.id, { title: meta.subagents[a.id] && meta.subagents[a.id].title ? undefined : a.label, state: childState(a.state), startedAt: a.startedAt, endedAt: a.state === 'working' ? undefined : a.settledAt, tokens: a.tokens }, at)
        }
        if (!agents.length) {
          if (items.delete(itemId)) {
            changedItems.delete(itemId)
            removedItems.add(itemId)
          }
          break
        }
        put(itemId, { kind: 'message', role: 'system', blocks: [{ type: 'text', text: subagentGroupFallbackText(agents) }, { type: 'subagent-group', groupId: String(ev.groupId), agents }] }, {}, at)
        break
      }
      case 'subagent': {
        // One child's lifecycle (start, progress, end): its kind, model and description.
        if (ev.id == null) break
        const str = (v, max = MAX_SUBAGENT_FIELD_CHARS) => (typeof v === 'string' && v ? v.slice(0, max) : undefined)
        const settled = ev.phase === 'end' || (ev.status && ev.status !== 'working')
        noteChild(
          ev.id,
          {
            title: str(ev.description),
            type: str(ev.subagentType, 120),
            model: str(ev.model, 200),
            ...(ev.phase === 'start' ? { state: 'running' } : settled ? { state: childState(normalizeSubagentState(String(ev.status ?? ''))) } : {}),
            startedAt: Number.isFinite(ev.startedAt) ? ev.startedAt : undefined,
            endedAt: settled ? (Number.isFinite(ev.settledAt) ? ev.settledAt : Number.isFinite(ev.endedAt) ? ev.endedAt : at) : undefined,
            tokens: Number.isFinite(ev.tokens) ? ev.tokens : undefined
          },
          at
        )
        break
      }
      case 'contextUsage': {
        // The engine's newest context facts: what the last response read,
        // in the model's window (unknown: after a compaction).
        const used = Number.isFinite(ev.usedTokens) && ev.usedTokens > 0 ? ev.usedTokens : null
        const window = Number.isFinite(ev.windowTokens) && ev.windowTokens > 0 ? ev.windowTokens : null
        writeContext({
          used: used === null ? { kind: 'unknown', capturedAt: at } : { kind: 'estimate', usage: { inputTokens: used, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 }, capturedAt: at },
          ...(window ? { window: { tokens: window, capturedAt: at } } : {})
        })
        break
      }
      case 'compacted': {
        // The reference's compaction separator; what the context holds is unknown until the next response.
        put(`status:${idTag}compacted-${sequence + 1}`, { kind: 'status', text: 'Context compacted', presentation: 'compaction' }, {}, at) // i18n-ignore
        writeContext({ used: { kind: 'unknown', capturedAt: at } })
        break
      }
      case 'option': {
        // A model or effort change the agent took (or refused).
        if (ev.option !== 'model' && ev.option !== 'effort') break
        const text = optionText(ev, meta.agent)
        if (text) put(`status:${idTag}option-${sequence + 1}`, { kind: 'status', text: String(text), tone: ev.ok === false ? 'error' : 'notice', presentation: 'session-option' }, {}, at) // i18n-ignore
        break
      }
      case 'commands':
        // The session's "/" catalog: a full snapshot each time (outside the journal).
        if (Array.isArray(ev.commands)) meta.commands = ev.commands.filter((c) => c && typeof c.name === 'string' && c.name)
        break
      case 'rateLimit':
        meta.rateLimit = { fiveHour: ev.fiveHour || null, sevenDay: ev.sevenDay || null }
        break
      // Its background work still running (the main process counts it).
      case 'backgroundTasks':
        meta.backgroundTasks = Number.isSafeInteger(ev.running) && ev.running > 0 ? ev.running : 0
        break
      default:
        break
    }
  }

  function sessionOffered(choices) {
    if (!Array.isArray(choices) || !choices.length) return true
    return choices.some((c) => c === 'acceptForSession' || (c && typeof c === 'object' && 'acceptForSession' in c))
  }
  function resolutionOf(status, at) {
    if (status === 'pending' || !status) return { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    if (status === 'cancelled') return { state: 'cancelled', selectedOptionId: null, resolvedBy: null, resolvedAt: at }
    return { state: 'resolved', selectedOptionId: APPROVAL_OPTION[status] || null, resolvedBy: 'local', resolvedAt: at }
  }

  function cursor() {
    return { epoch, sequence }
  }

  return {
    meta,
    // The reducer's first event: every item made so far.
    snapshotEvent() {
      changedItems = new Set()
      changedSubs = new Set()
      removedItems = new Set()
      const list = [...items.values()].sort((a, b) => a.sequence - b.sequence)
      return {
        type: 'snapshot',
        fence,
        page: {
          epoch,
          fence,
          items: list,
          removedItemIds: [],
          submissions: [...submissions.values()],
          window: { nextCursor: cursor() },
          liveCursor: cursor(),
          hasOlder: false,
          hasNewer: false
        }
      }
    },
    // One chat event -> the batch for the reducer, or null.
    apply(ev) {
      if (!ev || typeof ev !== 'object') return null
      return this.applyMany([ev])
    },
    // Several live events (an imported history) -> ONE batch, or null.
    applyMany(events) {
      for (const ev of events || []) if (ev && typeof ev === 'object') applyEvent(ev)
      if (!changedItems.size && !changedSubs.size && !removedItems.size) return null
      const batch = {
        cursor: cursor(),
        items: [...changedItems].map((id) => items.get(id)),
        removedItemIds: [...removedItems],
        submissions: [...changedSubs].map((id) => submissions.get(id))
      }
      changedItems = new Set()
      changedSubs = new Set()
      removedItems = new Set()
      return { type: 'batch', fence, batch }
    },
    // Several events (a history replay) into items, without batches.
    replay(events) {
      for (const ev of events || []) if (ev && typeof ev === 'object') applyEvent(ev)
      changedItems = new Set()
      changedSubs = new Set()
      removedItems = new Set()
    },
    items: () => [...items.values()].sort((a, b) => a.sequence - b.sequence),
    // An older page of the conversation (events read again from the agent's
    // own history): its items go BEFORE everything held, in their order, with
    // earlier sequences and times. -> { items, submissions } for the
    // reducer's 'older-page'.
    olderPage(events) {
      const page = createJournalAdapter({ now, epoch, fence, cwd, optionText, idTag: `older${++olderPages}:` }) // i18n-ignore
      page.replay(events)
      const fresh = page.items().filter((item) => !items.has(item.itemId))
      if (!fresh.length) return { items: [], submissions: [] }
      let floorSeq = Infinity
      let floorAt = Infinity
      for (const item of items.values()) {
        if (item.sequence < floorSeq) floorSeq = item.sequence
        if (item.observedAt < floorAt) floorAt = item.observedAt
      }
      if (!Number.isFinite(floorSeq)) floorSeq = 1
      const placed = new Array(fresh.length)
      let ceiling = floorAt
      for (let i = fresh.length - 1; i >= 0; i--) {
        const at = Number.isFinite(ceiling) ? Math.min(fresh[i].observedAt, ceiling - 1) : fresh[i].observedAt
        ceiling = at
        placed[i] = { ...fresh[i], sequence: floorSeq - (fresh.length - i), observedAt: at }
      }
      for (const item of placed) items.set(item.itemId, item)
      const subs = page.submissions().filter((sub) => !submissions.has(sub.clientMessageId))
      for (const sub of subs) submissions.set(sub.clientMessageId, sub)
      return { items: placed, submissions: subs }
    },
    submissions: () => [...submissions.values()],
    openTurnId: () => (openTurn ? items.get(openTurn).body.turnId : null)
  }
}
