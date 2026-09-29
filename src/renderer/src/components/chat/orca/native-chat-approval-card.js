// After Orca's NativeChatApprovalCard.tsx (MIT, Copyright (c) 2026 Lovecast Inc.):
// the approval card's helpers, for the card (NativeChatApprovalCard.vue) and
// the pane that hosts it. The reference card reads a ChatApproval; Tessel's
// journal approval item (chat/orca/adapter/journalAdapter.js) carries its own
// fields under body.tessel, which keep Tessel's protections: the preview and
// how much of the input it hides, the rules "Allow for this session" adds,
// the choices the agent offers.
import { sessionRuleList } from '../../../chat/chatModel.js'

// The key that moves the focus to the pane's pending approval card: Alt+A
// (by its character, not its place: A is where Q is on AZERTY). AltGr is
// Ctrl+Alt, so no character typed with it matches.
export function isFocusApprovalKey(e) {
  return !!e && e.altKey === true && !e.ctrlKey && !e.shiftKey && !e.metaKey && typeof e.key === 'string' && e.key.toLowerCase() === 'a'
}

// The journal's resolution -> Tessel's approval status (what the card says
// once decided). Anything unknown stays pending: never shown as decided.
const RESOLVED_STATUS = { allow: 'allowed', allowSession: 'allowedSession', deny: 'denied' }
export function approvalStatusOf(resolution) {
  if (!resolution || resolution.state === 'pending' || !resolution.state) return 'pending'
  if (resolution.state === 'cancelled') return 'cancelled'
  return RESOLVED_STATUS[resolution.selectedOptionId] || 'resolved'
}

// A journal approval item (or its body) -> the card's row: the reference's
// fields and Tessel's. A body without Tessel's fields (the reference's own
// fixtures) still renders; it has no hidden input and no session rules.
export function approvalRowFromItem(item) {
  const body = item && item.body ? item.body : item || {}
  const tessel = body.tessel && typeof body.tessel === 'object' ? body.tessel : null
  const options = Array.isArray(body.options) ? body.options.filter((o) => o && typeof o.id === 'string') : []
  const hidden = tessel && Number.isSafeInteger(tessel.hidden) && tessel.hidden > 0 ? tessel.hidden : 0
  return {
    itemId: item && item.itemId ? item.itemId : null,
    tessel: !!tessel,
    requestId: tessel ? String(tessel.requestId || '') : '',
    toolName: tessel ? String(tessel.toolName || '') : '',
    title: String(body.title || ''),
    displayName: String(body.displayName || (tessel && tessel.toolName) || ''),
    description: typeof body.description === 'string' ? body.description : '',
    decisionReason: typeof body.decisionReason === 'string' ? body.decisionReason : '',
    blockedPath: typeof body.blockedPath === 'string' ? body.blockedPath : '',
    matchedAskRule: body.matchedAskRule && typeof body.matchedAskRule === 'object' ? body.matchedAskRule : null,
    subject: body.subject && body.subject.kind === 'plan' && typeof body.subject.text === 'string' ? body.subject : null,
    detail: typeof body.detail === 'string' ? body.detail : null,
    input: tessel ? (tessel.input ?? null) : null,
    hidden,
    sessionRules: tessel ? sessionRuleList(tessel.sessionRules) : [],
    options,
    // "Allow for this session" only when the agent offers it (the adapter
    // lists it from the agent's choices).
    sessionAllowed: options.some((o) => o.id === 'allowSession'),
    status: approvalStatusOf(body.resolution)
  }
}

// What the pane's respond(...) returned -> was the answer taken? Only an
// explicit yes counts: nothing, false or { ok: false } bring the buttons back.
export function approvalAnswerSent(result) {
  return result === true || !!(result && typeof result === 'object' && result.ok === true)
}

// The card's fetchInput for a pane: the whole input of a request whose card
// shows only its start, through window.shellApi.chat.approvalInput (which
// also records, in the main process, that it was fetched: Allow is refused
// there until then). -> the input, or null when it could not be read.
export function createApprovalInputFetcher(paneId, api) {
  return async function fetchInput({ requestId }) {
    const chat = api !== undefined ? api : typeof window !== 'undefined' && window.shellApi ? window.shellApi.chat : null
    if (!chat || typeof chat.approvalInput !== 'function') return null
    try {
      const res = await chat.approvalInput({ paneId, requestId })
      return res && res.ok === true && res.input != null ? res.input : null
    } catch {
      return null
    }
  }
}
