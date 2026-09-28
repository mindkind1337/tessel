// Status evidence only: this model never makes permission decisions or infers
// completion from silence. Keep its serializable state free of CLI content.
export const AGENT_STATE_STALE_MS = 30 * 60 * 1000
// After the agent's Stop hook, the pane's screen confirms it is ready. A pane
// nobody is looking at (another workspace) may never report its screen: with
// no event at all for this long after Stop, the turn is taken as finished.
export const AGENT_SETTLE_MS = 20 * 1000
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
  'ScreenApproval',
  'ScreenBusy',
  'ScreenLimit',
  'ScreenClearApproval'
])
const SOURCES = ['hook', 'screen', 'lifecycle']
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
    childrenTruncated: false
  }
}

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
    exactKeys(value, ROOT_KEYS) &&
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
  if (event.source === 'hook') return HOOK_EVENTS.has(event.event) && isId(event.sessionId)
  if (event.source === 'screen')
    return (
      SCREEN_EVENTS.has(event.event) &&
      !event.agentId &&
      (event.sessionId == null || isId(event.sessionId))
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

function applyHook(target, event) {
  switch (event.event) {
    case 'SessionStart':
    case 'SubagentStart':
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

function applyScreen(target, event) {
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
      if (target.hookSeen && target.state === 'working') return false
      cancelCandidate(target)
      transition(target, 'working', 'processing', event)
      return true
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
    pendingDecisions: [...state.pendingDecisions]
  }
  const changedSession = boundary && state.sessionId && event.sessionId !== state.sessionId
  if (changedSession) {
    next = {
      ...next,
      ...scope(event.at),
      sessionId: event.sessionId,
      children: [],
      childrenTruncated: false
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

  if (event.source === 'screen') {
    if (!applyScreen(target, event)) return state
    target.lastScreenAt = event.at
    target.lastScreenEvent = event.event
  } else if (event.event === 'PtyExit') {
    clearPending(target)
    cancelCandidate(target)
    transition(target, 'closed', 'ended', event)
    next.children = []
  } else {
    applyHook(target, event)
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
      } else if (['ScreenReady', 'ScreenClearApproval'].includes(existing.lastScreenEvent)) {
        clearPending(target)
        if (target.state === 'approval' || target.reason === 'decision') showWork(target, event)
      }
    }
    target.hookSeen = true
    target.lastHookAt = event.at
  }
  // A live observation can reconfirm a recovered state, but must not resurrect
  // an old completion notification that disappeared while unconfirmed.
  if (!target.confirmed) target.turnCompletedAt = null
  target.confirmed = true
  target.observedAt = Math.max(target.observedAt ?? event.at, event.at)
  target.lastEventAt = Math.max(target.lastEventAt, event.at)
  if (!changedSession && existing?.state === target.state) target.since = existing.since
  return next
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
  return {
    state: unconfirmed || stale ? 'unknown' : settled ? 'idle' : value.state,
    reason: unconfirmed ? 'unconfirmed' : stale ? 'stale' : settled ? 'ready' : value.reason,
    source: value.source,
    since: value.since,
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
  return {
    paneId: state.paneId,
    provider: state.provider,
    launchToken: state.launchToken,
    sessionId: state.sessionId,
    ...publicScope(state, now),
    children: state.children.map((child) => ({
      agentId: child.agentId,
      sessionId: child.sessionId,
      ...publicScope(state.confirmed ? child : { ...child, confirmed: false }, now)
    })),
    childrenTruncated: state.childrenTruncated
  }
}
