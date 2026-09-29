// The chat pane's session, as the ported chat UI reads it: the same fields as
// the reference's useStructuredAgentSession (Orca's src/renderer/src/
// components/native-chat/use-structured-agent-session.ts, MIT, Copyright (c)
// 2026 Lovecast Inc.), fed by Tessel's engine: the pane's 'chat:event'
// stream and its journal (window.shellApi.chat), turned into journal items by
// the adapter (../adapter/journalAdapter.js), then the reference's reducer
// and projections, unchanged. Actions go to Tessel's IPC.
//
// What Tessel's engine does not provide yet stays empty: conversation
// commands, older history pages, the rail outline, background tasks, the
// provider's activity line, questions (they need an engine answer path).
import { computed, onBeforeUnmount, reactive, shallowRef } from 'vue'
import { createJournalAdapter } from '../adapter/journalAdapter'
import { reduceStructuredAgentSession, EMPTY_STRUCTURED_AGENT_SESSION } from '../shared/structured-agent-session-reducer.js'
import { projectStructuredAgentSessionMessages, pendingStructuredSessionPrompts } from '../structured-agent-session-message-projection.js'
import { activeStructuredAgentSessionTurnId } from '../shared/structured-agent-session-live-turn.js'
import { hasUnansweredStructuredAgentSessionDispatch } from '../shared/structured-agent-session-projection.js'
import { selectStructuredAgentSettledTurns, selectStructuredAgentRunningTurnTiming } from '../shared/structured-agent-session-turn-timing.js'
import { structuredSessionBackgroundTasksView } from '../structured-session-background-tasks-view.js'

// An approval option id -> Tessel's decision.
const DECISIONS = { allow: 'allow', allowSession: 'allowSession', deny: 'deny' }

// paneId: the chat pane; api: window.shellApi.chat (injectable for tests).
export function useStructuredAgentSession({ paneId, api = typeof window !== 'undefined' && window.shellApi ? window.shellApi.chat : null, now = Date.now } = {}) {
  const adapter = createJournalAdapter({ now })
  const state = shallowRef(EMPTY_STRUCTURED_AGENT_SESSION)
  const meta = reactive({ ...adapter.meta, loaded: false, loadError: null, open: false, asleep: false })
  let lastSeq = 0
  let loaded = false
  const buffered = []

  function feed(event) {
    state.value = reduceStructuredAgentSession(state.value, { type: 'event', event }, now())
  }
  function syncMeta() {
    Object.assign(meta, adapter.meta)
  }
  function applyLive(ev, seq) {
    if (typeof seq === 'number') {
      if (seq <= lastSeq) return
      lastSeq = seq
    }
    const out = adapter.apply(ev)
    if (out) feed(out)
    syncMeta()
  }

  // Redraw from the main process's journal, then follow live events (those
  // that came meanwhile wait, and what the journal had is not applied twice).
  async function load() {
    meta.loadError = null
    let res = null
    try {
      res = api && api.history ? await api.history({ paneId }) : { ok: true, events: [], seq: 0 }
    } catch (err) {
      res = { ok: false, error: (err && err.message) || String(err) }
    }
    if (!res || res.ok === false) {
      meta.loadError = (res && res.error) || 'history unavailable' // i18n-ignore shown through t() by the pane
      return res
    }
    const events = []
    for (const item of res.events || []) {
      const wrapped = item && item.event && !item.type
      events.push(wrapped ? item.event : item)
      if (wrapped && typeof item.seq === 'number') lastSeq = Math.max(lastSeq, item.seq)
    }
    if (typeof res.seq === 'number') lastSeq = Math.max(lastSeq, res.seq)
    adapter.replay(events)
    feed(adapter.snapshotEvent())
    syncMeta()
    meta.open = !!(res.open || (res.live && res.live.status && res.live.status !== 'asleep'))
    meta.asleep = !!res.asleep
    loaded = true
    meta.loaded = true
    for (const [ev, seq] of buffered.splice(0)) applyLive(ev, seq)
    return res
  }

  // An event the pane itself knows (e.g. 'starting' while it opens the
  // session, or why the open failed): applied like a live one, without a seq.
  function dispatchLocal(ev) {
    if (!ev || typeof ev !== 'object') return
    const out = adapter.apply(ev)
    if (out) feed(out)
    syncMeta()
  }

  let off = null
  if (api && api.onEvent) {
    off = api.onEvent((msg) => {
      if (!msg || msg.paneId !== paneId || !msg.event) return
      if (!loaded) buffered.push([msg.event, msg.seq])
      else applyLive(msg.event, msg.seq)
    })
  }
  onBeforeUnmount(() => off && off())

  const journalItems = computed(() => state.value.items)
  const submissions = computed(() => state.value.submissions)
  const messages = computed(() => projectStructuredAgentSessionMessages(journalItems.value, [], submissions.value))
  const prompts = computed(() => pendingStructuredSessionPrompts(journalItems.value))
  const turnId = computed(() => activeStructuredAgentSessionTurnId(journalItems.value))
  const isWorking = computed(() => turnId.value !== null || hasUnansweredStructuredAgentSessionDispatch(submissions.value, state.value.fence))
  const settledTurns = computed(() => selectStructuredAgentSettledTurns(journalItems.value, submissions.value))
  const workingStartedAt = computed(() => {
    if (turnId.value === null) return null
    const timing = selectStructuredAgentRunningTurnTiming(journalItems.value, turnId.value)
    return timing && Number.isFinite(timing.startedAt) ? timing.startedAt : null
  })
  const backgroundTasks = computed(() => structuredSessionBackgroundTasksView(null, turnId.value))

  // --- Actions (Tessel's IPC) ---------------------------------------------------------
  async function send(text) {
    if (!api || !api.send) return { ok: false }
    try {
      return (await api.send({ paneId, text })) || { ok: false }
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  }
  async function cancel() {
    if (!api || !api.interrupt) return { ok: false }
    try {
      return (await api.interrupt({ paneId })) || { ok: false }
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  }
  // An approval item and { kind: 'option', optionId } -> Tessel's approve.
  async function respond(item, response, { message } = {}) {
    const requestId = item && item.body && item.body.tessel ? item.body.tessel.requestId : null
    const decision = response && response.kind === 'option' ? DECISIONS[response.optionId] : null
    if (!api || !api.approve || !requestId || !decision) return null
    try {
      return await api.approve({ paneId, requestId, decision, ...(message ? { message } : {}) })
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  }

  return {
    meta,
    load,
    dispatchLocal,
    // The reference's fields.
    conversationCommands: computed(() => []),
    runConversationCommand: async () => null,
    journalItems,
    messages,
    status: computed(() => (meta.loadError ? 'error' : state.value.status)),
    error: computed(() => meta.loadError),
    hasOlder: computed(() => false),
    railOutline: computed(() => null),
    loadingOlder: computed(() => false),
    olderHistoryGeneration: computed(() => 0),
    loadOlder: async () => {},
    prompts,
    outbox: computed(() => []),
    blockedClientMessageId: computed(() => null),
    send,
    retry: async () => false,
    isWorking,
    workingStartedAt,
    settledTurns,
    turnActivity: computed(() => null),
    backgroundTasks,
    turnId,
    cancel,
    stopBackgroundTask: async () => null,
    respond,
    // Tessel's own: the rate limits for the header, the adapter (tests).
    rateLimit: computed(() => meta.rateLimit),
    adapter
  }
}
