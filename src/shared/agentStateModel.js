// Status evidence only: this model never makes permission decisions or infers
// completion from silence. Keep its serializable state free of CLI content.
export const AGENT_STATE_STALE_MS = 30 * 60 * 1000
// After the agent's Stop hook, the pane's screen confirms it is ready. A pane
// nobody is looking at (another workspace) may never report its screen: with
// no event at all for this long after Stop, the turn is taken as finished.
export const AGENT_SETTLE_MS = 20 * 1000
// Work known only from the screen's running footer (ScreenBusy) after the
// hooks had ended the turn: a stale footer line (an answer quoting it, an
// old spinner left above the prompt) must not show it working forever. The
// footer is seen again while it really runs (SCREEN_BUSY_REFRESH_MS); with
// no such sighting for this long, the work is over.
export const SCREEN_WORK_MS = 60 * 1000
const SCREEN_BUSY_REFRESH_MS = 5 * 1000
// Background work the agent left running when its turn ended (Claude Code's
// Stop hook lists it: background shells, background sub-agents, monitors).
// Its own end starts a follow-up turn whose Stop lists what is left, so a
// finished task is normally seen ending; one never seen ending (a lost hook)
// stops counting this long after the last list that named it.
export const BACKGROUND_MAX_MS = 2 * 60 * 60 * 1000
export const MAX_BACKGROUND = 32
// The agents whose own hooks, plugin or extension report their status
// (teamMcp/server.cjs --hook, agentStatusHooks.js). Claude Code and Codex also
// have their screens read for a positive "ready" prompt; for the others the
// hooks alone decide: their turn's end is their idle state.
export const STATUS_PROVIDERS = [
  'claude',
  'codex',
  'gemini',
  'copilot',
  'kimi',
  'opencode',
  'cursor',
  'droid',
  'grok',
  'antigravity',
  'openclaude',
  'commandcode',
  'amp',
  'pi'
]
export const SCREEN_READY_PROVIDERS = ['claude', 'codex']
export const hooksAlone = (provider) =>
  STATUS_PROVIDERS.includes(provider) && !SCREEN_READY_PROVIDERS.includes(provider)
const MAX_SEEN = 256
const MAX_CHILDREN = 32
const MAX_PENDING = 32
const MAX_ID = 256
const MAX_RESET = 160
const STATES = ['unknown', 'working', 'idle', 'approval', 'limited', 'closed']
const REASONS = [
  'unconfirmed',
  'startup',
  'processing',
  'decision',
  'permission',
  'settling',
  'continuing',
  'ready',
  'error',
  'interrupted',
  'ended',
  'quota',
  'compacting',
  'stale',
  'input'
]
const HOOK_EVENTS = new Set([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'Stop',
  'StopFailure',
  'Interrupt',
  'SessionEnd',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'Elicitation',
  'ElicitationResult'
])
const SCREEN_EVENTS = new Set([
  'ScreenReady',
  'ScreenInterrupted',
  'ScreenApproval',
  'ScreenBusy',
  'ScreenLimit',
  'ScreenClearApproval'
])
// 'rollout': the end of a turn read from Codex's own session file, for a turn
// whose Stop hook never ran (codexTurnEnd.js).
const SOURCES = ['hook', 'screen', 'lifecycle', 'rollout']
const ROLLOUT_ENDS = ['complete', 'error', 'aborted']
const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value)
const isId = (value) => typeof value === 'string' && value.length > 0 && value.length <= MAX_ID
const isTime = (value) => Number.isFinite(value) && value >= 0
const nullable = (value, test) => value === null || test(value)
const exactKeys = (value, keys) =>
  Object.keys(value).every((key) => keys.includes(key)) &&
  keys.every((key) => Object.hasOwn(value, key))

function scope(at) {
  return {
    state: 'unknown',
    reason: 'unconfirmed',
    source: null,
    since: at,
    observedAt: null,
    hookSeen: false,
    confirmed: false,
    lastHookAt: null,
    lastScreenAt: null,
    lastScreenEvent: null,
    lastEventAt: at,
    turnId: null,
    stopCandidateAt: null,
    readyReason: null,
    continuing: false,
    pendingDecisions: [],
    pendingApprovals: [],
    decisionOverflow: false,
    approvalOverflow: false,
    turnCompletedAt: null,
    limitedResetAt: null,
    reset: null
  }
}

const SCOPE_KEYS = Object.keys(scope(0))
const ROOT_KEYS = [
  ...SCOPE_KEYS,
  'v',
  'paneId',
  'provider',
  'launchToken',
  'startedAt',
  'sessionId',
  'seenIds',
  'children',
  'childrenTruncated'
]
// Added after the first saved snapshots: a snapshot without them is read as
// "no background work known" (validateAgentState, backgroundOf).
const OPTIONAL_ROOT_KEYS = ['background', 'backgroundAt']

export function createAgentState({ paneId, provider, launchToken, startedAt = Date.now() } = {}) {
  if (![paneId, provider, launchToken].every(isId) || !isTime(startedAt)) {
    throw new TypeError('Agent state requires a pane, provider, launch token and timestamp')
  }
  return {
    ...scope(startedAt),
    v: 1,
    paneId,
    provider,
    launchToken,
    startedAt,
    sessionId: null,
    seenIds: [],
    children: [],
    childrenTruncated: false,
    background: [],
    backgroundAt: null
  }
}

const backgroundOf = (state) => (Array.isArray(state.background) ? state.background : [])
const validBackground = (value) =>
  (value.background === undefined ||
    (Array.isArray(value.background) &&
      value.background.length <= MAX_BACKGROUND &&
      value.background.every(isId))) &&
  (value.backgroundAt === undefined || nullable(value.backgroundAt, isTime))

function validScope(value) {
  return (
    isObject(value) &&
    STATES.includes(value.state) &&
    REASONS.includes(value.reason) &&
    nullable(value.source, (source) => SOURCES.includes(source)) &&
    isTime(value.since) &&
    [
      'observedAt',
      'lastHookAt',
      'lastScreenAt',
      'stopCandidateAt',
      'turnCompletedAt',
      'limitedResetAt'
    ].every((key) => nullable(value[key], isTime)) &&
    isTime(value.lastEventAt) &&
    nullable(value.lastScreenEvent, (event) => SCREEN_EVENTS.has(event)) &&
    nullable(value.reset, (reset) => typeof reset === 'string' && reset.length <= MAX_RESET) &&
    nullable(value.turnId, isId) &&
    nullable(value.readyReason, (reason) => REASONS.includes(reason)) &&
    ['hookSeen', 'confirmed', 'continuing', 'decisionOverflow', 'approvalOverflow'].every(
      (key) => typeof value[key] === 'boolean'
    ) &&
    ['pendingDecisions', 'pendingApprovals'].every(
      (key) =>
        Array.isArray(value[key]) &&
        value[key].length <= MAX_PENDING &&
        value[key].every(
          (entry) =>
            isObject(entry) &&
            exactKeys(entry, ['id', 'toolId', 'turnId']) &&
            isId(entry.id) &&
            nullable(entry.toolId, isId) &&
            nullable(entry.turnId, isId)
        )
    )
  )
}

// The store can reject corrupt/private fields before replaying a disk snapshot.
// Recovery must additionally set confirmed:false; reading disk is not evidence.
export function validateAgentState(value) {
  return (
    validScope(value) &&
    Object.keys(value).every((key) => ROOT_KEYS.includes(key) || OPTIONAL_ROOT_KEYS.includes(key)) &&
    ROOT_KEYS.every((key) => Object.hasOwn(value, key)) &&
    validBackground(value) &&
    value.v === 1 &&
    [value.paneId, value.provider, value.launchToken].every(isId) &&
    isTime(value.startedAt) &&
    nullable(value.sessionId, isId) &&
    Array.isArray(value.seenIds) &&
    value.seenIds.length <= MAX_SEEN &&
    value.seenIds.every(isId) &&
    typeof value.childrenTruncated === 'boolean' &&
    Array.isArray(value.children) &&
    value.children.length <= MAX_CHILDREN &&
    value.children.every(
      (child) =>
        validScope(child) &&
        exactKeys(child, [...SCOPE_KEYS, 'agentId', 'sessionId', 'registered']) &&
        isId(child.agentId) &&
        nullable(child.sessionId, isId) &&
        typeof child.registered === 'boolean'
    )
  )
}

function validEvent(state, event, now) {
  if (
    !isObject(event) ||
    event.v !== 1 ||
    !isId(event.id) ||
    !isTime(event.at) ||
    !isTime(now) ||
    event.at > now ||
    event.at < state.startedAt ||
    event.paneId !== state.paneId ||
    event.provider !== state.provider ||
    event.launchToken !== state.launchToken ||
    state.seenIds.includes(event.id)
  )
    return false
  if (
    ['agentId', 'toolId', 'turnId'].some(
      (key) => event[key] !== undefined && event[key] !== null && !isId(event[key])
    )
  )
    return false
  // The background work a lead Stop lists (ids only).
  if (
    event.background !== undefined &&
    (event.event !== 'Stop' ||
      !!event.agentId ||
      !Array.isArray(event.background) ||
      event.background.length > MAX_BACKGROUND ||
      !event.background.every(isId))
  )
    return false
  if (event.source === 'hook') return HOOK_EVENTS.has(event.event) && isId(event.sessionId)
  if (event.source === 'screen')
    return (
      SCREEN_EVENTS.has(event.event) &&
      !event.agentId &&
      (event.sessionId == null || isId(event.sessionId))
    )
  if (event.source === 'rollout')
    return (
      event.event === 'RolloutTurnEnd' &&
      ROLLOUT_ENDS.includes(event.ended) &&
      !event.agentId &&
      isId(event.sessionId) &&
      event.sessionId === state.sessionId
    )
  return event.source === 'lifecycle' && event.event === 'PtyExit' && !event.agentId
}

function transition(target, state, reason, event) {
  if (target.state !== state) target.since = event.at
  target.state = state
  target.reason = reason
  target.source = event.source
}

function clearPending(target) {
  target.pendingDecisions = []
  target.pendingApprovals = []
  target.decisionOverflow = false
  target.approvalOverflow = false
}

function addPending(target, kind, event) {
  const key = kind === 'approval' ? 'pendingApprovals' : 'pendingDecisions'
  const overflow = kind === 'approval' ? 'approvalOverflow' : 'decisionOverflow'
  // Native permission hooks may omit tool IDs. Never correlate those by name,
  // arrival order, or with whichever parallel tool happens to complete next.
  if (
    event.toolId &&
    target[key].some(
      (entry) => entry.toolId === event.toolId && entry.turnId === (event.turnId || null)
    )
  )
    return
  if (target[key].length >= MAX_PENDING) {
    target[overflow] = true
    return
  }
  target[key].push({ id: event.id, toolId: event.toolId || null, turnId: event.turnId || null })
}

function resolveTool(target, event) {
  if (!event.toolId) return
  const matches = (entry) =>
    entry.toolId === event.toolId && (!entry.turnId || entry.turnId === event.turnId)
  target.pendingApprovals = target.pendingApprovals.filter((entry) => !matches(entry))
  target.pendingDecisions = target.pendingDecisions.filter((entry) => !matches(entry))
}

const hasApproval = (target) => target.approvalOverflow || target.pendingApprovals.length > 0
const hasDecision = (target) => target.decisionOverflow || target.pendingDecisions.length > 0

function showWork(target, event, reason = 'processing') {
  if (target.state === 'limited') return
  transition(
    target,
    hasApproval(target) ? 'approval' : 'working',
    hasApproval(target) ? 'permission' : hasDecision(target) ? 'decision' : reason,
    event
  )
}

function cancelCandidate(target) {
  target.stopCandidateAt = null
  target.readyReason = null
  target.continuing = false
}

// A hooks-only agent (hooksAlone): an approval with no tool id (a screen
// prompt, a permission notice) cannot be matched to the tool that ends it; the
// agent moving on is the proof it was answered.
function dropUnmatched(target) {
  target.pendingApprovals = target.pendingApprovals.filter((entry) => entry.toolId)
  target.pendingDecisions = target.pendingDecisions.filter((entry) => entry.toolId)
  target.approvalOverflow = false
  target.decisionOverflow = false
}

// A hooks-only agent's turn ended (Stop, a failure, an interrupt): idle at
// once, since no screen confirms it (the hooks are the evidence).
function endTurn(target, event, reason) {
  clearPending(target)
  cancelCandidate(target)
  target.readyReason = reason
  if (reason === 'ready') target.turnCompletedAt = event.at
  if (target.state !== 'limited') transition(target, 'idle', reason, event)
}

function applyHook(target, event, alone = false) {
  if (alone && ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop'].includes(event.event))
    dropUnmatched(target)
  switch (event.event) {
    case 'SessionStart':
    case 'SubagentStart':
      // Its session opened, before any prompt: ready for one.
      if (
        alone &&
        event.event === 'SessionStart' &&
        !event.agentId &&
        event.startSource !== 'compact' &&
        ['unknown', 'closed'].includes(target.state)
      ) {
        cancelCandidate(target)
        clearPending(target)
        target.readyReason = 'startup'
        transition(target, 'idle', 'startup', event)
        return
      }
      if (
        event.startSource !== 'compact' &&
        target.state === 'unknown' &&
        target.readyReason === null &&
        !target.turnId
      ) {
        target.readyReason = 'startup'
        transition(target, 'unknown', 'startup', event)
      }
      return
    case 'UserPromptSubmit':
      cancelCandidate(target)
      clearPending(target)
      target.turnId = event.turnId || null
      // Explicit new work is evidence that the previous quota wait ended.
      target.limitedResetAt = null
      target.reset = null
      transition(target, 'working', 'processing', event)
      return
    case 'PermissionRequest':
      cancelCandidate(target)
      addPending(target, 'decision', event)
      showWork(target, event, 'decision')
      return
    case 'Notification':
      if (event.notificationType === 'permission_prompt') {
        if (target.stopCandidateAt === null) target.readyReason = null
        addPending(target, 'approval', event)
        if (target.state !== 'limited') transition(target, 'approval', 'permission', event)
      }
      return
    case 'Elicitation':
      cancelCandidate(target)
      addPending(target, 'approval', event)
      if (target.state !== 'limited') transition(target, 'approval', 'permission', event)
      return
    case 'ElicitationResult':
      resolveTool(target, event)
      showWork(target, event)
      return
    case 'PreToolUse':
    case 'PostToolUse':
    case 'PostToolUseFailure':
      cancelCandidate(target)
      if (event.event !== 'PreToolUse') resolveTool(target, event)
      target.turnId = event.turnId || target.turnId
      if (
        event.event === 'PreToolUse' &&
        ['AskUserQuestion', 'request_user_input'].includes(event.toolName)
      ) {
        addPending(target, 'approval', event)
        if (target.state !== 'limited') transition(target, 'approval', 'input', event)
        return
      }
      showWork(target, event)
      return
    case 'PreCompact':
    case 'PostCompact':
      cancelCandidate(target)
      showWork(target, event, 'compacting')
      return
    case 'Stop':
    case 'SubagentStop':
      if (alone && event.continuing !== true && !hasApproval(target)) return endTurn(target, event, 'ready')
      target.continuing = event.continuing === true
      target.stopCandidateAt = target.continuing ? null : event.at
      target.readyReason = target.continuing ? null : 'ready'
      // A pending permission retains its priority over a candidate boundary.
      if (target.state !== 'limited')
        transition(
          target,
          hasApproval(target) ? 'approval' : 'working',
          hasApproval(target) ? 'permission' : target.continuing ? 'continuing' : 'settling',
          event
        )
      return
    case 'StopFailure':
    case 'Interrupt':
      if (alone) return endTurn(target, event, event.event === 'StopFailure' ? 'error' : 'interrupted')
      clearPending(target)
      cancelCandidate(target)
      target.readyReason = event.event === 'StopFailure' ? 'error' : 'interrupted'
      if (target.state !== 'limited') transition(target, 'unknown', target.readyReason, event)
      return
    case 'SessionEnd':
      clearPending(target)
      cancelCandidate(target)
      transition(target, 'closed', 'ended', event)
  }
}

// Codex's rollout says the turn ended: complete is a finished turn (no
// settling wait: the client wrote it), error and aborted end it like
// StopFailure and Interrupt. It also orders later hooks: an older hook
// delivered late cannot bring the finished turn back.
function applyRollout(target, event) {
  clearPending(target)
  cancelCandidate(target)
  if (event.ended === 'complete') {
    target.readyReason = 'ready'
    target.turnCompletedAt = event.at
    if (target.state !== 'limited') transition(target, 'idle', 'ready', event)
  } else {
    target.readyReason = event.ended === 'error' ? 'error' : 'interrupted'
    if (target.state !== 'limited') transition(target, 'unknown', target.readyReason, event)
  }
  target.lastHookAt = Math.max(target.lastHookAt ?? event.at, event.at)
}

// Working because the screen showed a running footer, not because a hook said so.
const screenWork = (value) =>
  value.hookSeen &&
  value.state === 'working' &&
  value.reason === 'processing' &&
  value.source === 'screen' &&
  value.lastScreenEvent === 'ScreenBusy'

function applyScreen(target, event, alone = false) {
  switch (event.event) {
    case 'ScreenLimit':
      target.limitedResetAt = isTime(event.reset) ? event.reset : null
      target.reset =
        typeof event.reset === 'string'
          ? event.reset
              .replace(/[\u0000-\u001f\u007f]/g, '')
              .trim()
              .slice(0, MAX_RESET) || null
          : null
      transition(target, 'limited', 'quota', event)
      return true
    case 'ScreenApproval':
      if (target.stopCandidateAt === null) target.readyReason = null
      addPending(target, 'approval', event)
      if (target.state !== 'limited') transition(target, 'approval', 'permission', event)
      return true
    case 'ScreenClearApproval':
      if (!hasApproval(target) && !hasDecision(target)) return false
      clearPending(target)
      showWork(target, event, target.stopCandidateAt !== null ? 'settling' : 'processing')
      return true
    case 'ScreenBusy':
      // This event means an actual running/interrupt footer, not arbitrary
      // output. Partial hook trust can omit UserPromptSubmit after SessionStart:
      // visible running evidence must revoke an otherwise stale idle state.
      // Keep a Stop candidate pending through its old footer; a later positive
      // ready prompt can still confirm it. No permission is resolved here.
      if (['approval', 'limited'].includes(target.state)) return false
      // Work only the screen showed: seeing its footer again keeps it alive
      // (at most every few seconds, see SCREEN_WORK_MS).
      if (screenWork(target)) return event.at - (target.lastScreenAt ?? 0) >= SCREEN_BUSY_REFRESH_MS
      // A hooks-only agent's hooks say when it works and when it is done.
      if (target.hookSeen && (target.state === 'working' || alone)) return false
      cancelCandidate(target)
      transition(target, 'working', 'processing', event)
      return true
    case 'ScreenInterrupted':
      // Claude Code runs no hook when you interrupt its turn (Esc): its
      // screen says "Interrupted" above a ready prompt. Hooked work with no
      // Stop ends there; anything else is an ordinary ready prompt (an old
      // "Interrupted" line still in view after a later turn).
      if (
        target.hookSeen &&
        target.readyReason === null &&
        ['working', 'approval'].includes(target.state)
      ) {
        clearPending(target)
        cancelCandidate(target)
        target.readyReason = 'interrupted'
        target.limitedResetAt = null
        target.reset = null
        transition(target, 'idle', 'interrupted', event)
        return true
      }
    // falls through
    case 'ScreenReady': {
      // Positive ready evidence can resolve a prompt, but cannot manufacture a
      // completed turn when hooks still say work is underway.
      const permitted = !target.hookSeen || target.readyReason !== null
      const pending = hasApproval(target) || hasDecision(target)
      if (!permitted && !pending) return false
      clearPending(target)
      if (!permitted) {
        showWork(target, event)
        return true
      }
      const completed = target.confirmed && target.stopCandidateAt !== null && !target.continuing
      if (completed) target.turnCompletedAt = event.at
      const reason =
        target.readyReason === 'error' || target.readyReason === 'interrupted'
          ? target.readyReason
          : 'ready'
      target.limitedResetAt = null
      target.reset = null
      transition(target, 'idle', reason, event)
      target.stopCandidateAt = null
      target.continuing = false
      // Repeated ready observations preserve the completed timestamp.
      target.readyReason = reason
      return true
    }
    default:
      return false
  }
}

// A Stop that no ready screen confirmed, with no event at all since for
// AGENT_SETTLE_MS: publicScope already shows it idle. The next event first
// makes that end real, so a pane whose screen never reports (another
// workspace, a prompt the observer cannot read) does not stay "working" from
// one turn to the next, its next turn counting from the first one's start.
// The Stop candidate is kept: a later ready screen still marks the turn
// completed, as it would have while settling.
const settledAt = (value, at) =>
  value.state === 'working' &&
  value.reason === 'settling' &&
  value.stopCandidateAt != null &&
  !value.continuing &&
  at - Math.max(value.stopCandidateAt, value.lastEventAt ?? 0) > AGENT_SETTLE_MS

function settle(target) {
  clearPending(target)
  target.state = 'idle'
  target.reason = 'ready'
  target.readyReason = 'ready'
  target.since = target.stopCandidateAt
}

export function reduceAgentState(state, event, now = Date.now()) {
  if (!validateAgentState(state)) throw new TypeError('Invalid agent state')
  if (!validEvent(state, event, now)) return state
  const childEvent = !!event.agentId
  if (['SubagentStart', 'SubagentStop'].includes(event.event) && !childEvent) return state
  const boundary = event.source === 'hook' && event.event === 'SessionStart' && !childEvent
  const knownChild = childEvent
    ? state.children.find((child) => child.agentId === event.agentId)
    : null
  // Claude children can have their own session IDs. Accept that relationship
  // only after the lead announced the exact agent ID through SubagentStart.
  if (
    childEvent &&
    (!state.sessionId ||
      (event.sessionId !== state.sessionId &&
        (!knownChild?.registered ||
          (knownChild.sessionId && knownChild.sessionId !== event.sessionId))))
  ) {
    return state
  }
  if (
    !childEvent &&
    event.sessionId &&
    state.sessionId &&
    event.sessionId !== state.sessionId &&
    !boundary
  )
    return state
  // Nested CLIs inherit pane environment. An unrelated startup cannot claim an
  // established pane; a deliberate clear/resume is an explicit session change.
  if (
    boundary &&
    state.sessionId &&
    event.sessionId !== state.sessionId &&
    !['clear', 'resume'].includes(event.startSource)
  )
    return state
  if (
    event.source === 'hook' &&
    event.event === 'Notification' &&
    event.notificationType !== 'permission_prompt'
  )
    return state

  const existing = childEvent ? knownChild : state
  const orderedAfter = event.source === 'hook' ? existing?.lastHookAt : existing?.lastEventAt
  if (event.at < (orderedAfter ?? state.startedAt)) return state
  // A turn end read from the rollout must be newer than everything known,
  // and only ends work still shown.
  if (
    event.source === 'rollout' &&
    (state.state !== 'working' ||
      event.at <= state.lastEventAt ||
      (state.lastHookAt !== null && event.at <= state.lastHookAt))
  )
    return state
  if (
    existing?.turnId &&
    event.turnId &&
    existing.turnId !== event.turnId &&
    !boundary &&
    !['UserPromptSubmit', 'SessionEnd', 'PtyExit'].includes(event.event)
  )
    return state
  if (state.state === 'closed' && !boundary && event.event !== 'PtyExit') return state
  let next = {
    ...state,
    seenIds: [...state.seenIds, event.id].slice(-MAX_SEEN),
    children: state.children.map((child) => ({
      ...child,
      pendingApprovals: [...child.pendingApprovals],
      pendingDecisions: [...child.pendingDecisions]
    })),
    pendingApprovals: [...state.pendingApprovals],
    pendingDecisions: [...state.pendingDecisions],
    background: [...backgroundOf(state)],
    backgroundAt: state.backgroundAt ?? null
  }
  const changedSession = boundary && state.sessionId && event.sessionId !== state.sessionId
  if (changedSession) {
    next = {
      ...next,
      ...scope(event.at),
      sessionId: event.sessionId,
      children: [],
      childrenTruncated: false,
      // Another conversation: the old one's list says nothing of it.
      background: [],
      backgroundAt: null
    }
  }
  let target = next
  if (childEvent) {
    target = next.children.find((child) => child.agentId === event.agentId)
    if (!target) {
      if (next.children.length === MAX_CHILDREN) {
        next.childrenTruncated = true
        return next
      }
      target = { ...scope(event.at), agentId: event.agentId, sessionId: null, registered: false }
      next.children.push(target)
    }
    if (event.event === 'SubagentStart' && event.sessionId === state.sessionId)
      target.registered = true
    if (event.sessionId !== state.sessionId) target.sessionId = event.sessionId
  } else if (!next.sessionId && event.source === 'hook') {
    next.sessionId = event.sessionId
  }
  if (!changedSession && settledAt(target, event.at)) settle(target)
  // Its state before this event (a settled turn already ended).
  const prior = { state: target.state, since: target.since }

  if (event.source === 'screen') {
    if (!applyScreen(target, event, hooksAlone(state.provider))) return state
    target.lastScreenAt = event.at
    target.lastScreenEvent = event.event
  } else if (event.source === 'rollout') {
    applyRollout(target, event)
  } else if (event.event === 'PtyExit') {
    clearPending(target)
    cancelCandidate(target)
    transition(target, 'closed', 'ended', event)
    next.children = []
    next.background = []
    next.backgroundAt = null
  } else {
    applyHook(target, event, hooksAlone(state.provider))
    // A spool scan can deliver a hook after newer screen evidence. Its hook
    // ordering is still valid, but it cannot erase a currently visible prompt
    // or restore a permission already visibly resolved. Never reuse a cached
    // ScreenReady here to confirm Stop: a subsequent ready observation must do it.
    if (!changedSession && existing?.lastScreenAt > event.at && target.state !== 'closed') {
      const screen = { source: 'screen', at: existing.lastScreenAt }
      if (existing.lastScreenEvent === 'ScreenApproval') {
        target.pendingApprovals = [...existing.pendingApprovals]
        target.approvalOverflow = existing.approvalOverflow
        if (target.state !== 'limited') transition(target, 'approval', 'permission', screen)
      } else if (existing.lastScreenEvent === 'ScreenLimit') {
        target.reset = existing.reset
        target.limitedResetAt = existing.limitedResetAt
        transition(target, 'limited', 'quota', screen)
      } else if (
        existing.lastScreenEvent === 'ScreenInterrupted' &&
        existing.state === 'idle' &&
        existing.reason === 'interrupted' &&
        event.event !== 'UserPromptSubmit'
      ) {
        // A hook of the interrupted turn, delivered after its screen showed
        // the interruption: the turn stays over.
        clearPending(target)
        cancelCandidate(target)
        target.readyReason = 'interrupted'
        if (target.state !== 'limited') transition(target, 'idle', 'interrupted', screen)
      } else if (['ScreenReady', 'ScreenClearApproval'].includes(existing.lastScreenEvent)) {
        clearPending(target)
        if (target.state === 'approval' || target.reason === 'decision') showWork(target, event)
      }
    }
    target.hookSeen = true
    target.lastHookAt = event.at
    trackBackground(next, event)
  }
  // A live observation can reconfirm a recovered state, but must not resurrect
  // an old completion notification that disappeared while unconfirmed.
  if (!target.confirmed) target.turnCompletedAt = null
  target.confirmed = true
  target.observedAt = Math.max(target.observedAt ?? event.at, event.at)
  target.lastEventAt = Math.max(target.lastEventAt, event.at)
  if (!changedSession && existing && prior.state === target.state) target.since = prior.since
  return next
}

// The lead's background work from its hooks: a lead Stop's list replaces what
// was known (an absent list, from an older CLI, changes nothing); a background
// sub-agent's own SubagentStop ends it; the session ending ends all of it.
function trackBackground(next, event) {
  if (event.event === 'SessionEnd' && !event.agentId) {
    next.background = []
    next.backgroundAt = null
  } else if (event.event === 'Stop' && !event.agentId && Array.isArray(event.background)) {
    next.background = [...new Set(event.background)].slice(0, MAX_BACKGROUND)
    next.backgroundAt = event.at
  } else if (event.event === 'SubagentStop' && event.agentId && next.background.includes(event.agentId)) {
    next.background = next.background.filter((id) => id !== event.agentId)
  }
}

// The agent ended its turn (idle) while its own background work goes on:
// the number of tasks, or 0.
function backgroundRunning(state, shown, now) {
  const list = backgroundOf(state)
  if (!list.length || shown.state !== 'idle' || shown.stale || !shown.confirmed) return 0
  if (!isTime(state.backgroundAt) || now - state.backgroundAt > BACKGROUND_MAX_MS) return 0
  return list.length
}

function publicScope(value, now) {
  // Explicit screen approval/readiness is live evidence too. Ignored redraws
  // never reach observedAt and cannot keep stale hooked work alive.
  const lastEvidence = value.observedAt
  const stale =
    value.state !== 'closed' && lastEvidence !== null && now - lastEvidence > AGENT_STATE_STALE_MS
  const unconfirmed = !value.confirmed
  const settled =
    !unconfirmed &&
    !stale &&
    value.state === 'working' &&
    value.reason === 'settling' &&
    value.stopCandidateAt != null &&
    !value.continuing &&
    now - Math.max(value.stopCandidateAt, value.lastEventAt ?? 0) > AGENT_SETTLE_MS
  // Screen-only work whose running footer has not been seen for a while.
  const screenOver =
    !unconfirmed && !stale && screenWork(value) && now - (value.lastEventAt ?? 0) > SCREEN_WORK_MS
  const done = settled || screenOver
  return {
    state: unconfirmed || stale ? 'unknown' : done ? 'idle' : value.state,
    reason: unconfirmed ? 'unconfirmed' : stale ? 'stale' : done ? 'ready' : value.reason,
    source: value.source,
    // Idle since its turn ended, not since the work began.
    since: settled ? value.stopCandidateAt : screenOver ? value.lastEventAt : value.since,
    observedAt: value.observedAt,
    hookSeen: value.hookSeen,
    confirmed: value.confirmed,
    stale,
    ...(value.state === 'limited' && !unconfirmed && !stale && value.reset
      ? { reset: value.reset }
      : {}),
    ...(value.turnCompletedAt !== null && !unconfirmed && !stale
      ? { turnCompletedAt: value.turnCompletedAt }
      : {})
  }
}

export function publicAgentState(state, now = Date.now()) {
  if (!validateAgentState(state) || !isTime(now)) throw new TypeError('Invalid agent state')
  const lead = publicScope(state, now)
  const background = backgroundRunning(state, lead, now)
  return {
    paneId: state.paneId,
    provider: state.provider,
    launchToken: state.launchToken,
    sessionId: state.sessionId,
    ...lead,
    // Idle, but its own background work still runs: "monitoring".
    ...(background ? { monitoring: true, backgroundTasks: background } : {}),
    children: state.children.map((child) => ({
      agentId: child.agentId,
      sessionId: child.sessionId,
      ...publicScope(state.confirmed ? child : { ...child, confirmed: false }, now)
    })),
    childrenTruncated: state.childrenTruncated
  }
}
