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
import { agentJournalSubmissionKey } from '../shared/agent-session-journal-item-key.js'
import { reduceStructuredAgentSession, EMPTY_STRUCTURED_AGENT_SESSION } from '../shared/structured-agent-session-reducer.js'
import { projectStructuredAgentSessionMessages, pendingStructuredSessionPrompts } from '../structured-agent-session-message-projection.js'
import { activeStructuredAgentSessionTurnId } from '../shared/structured-agent-session-live-turn.js'
import { hasUnansweredStructuredAgentSessionDispatch } from '../shared/structured-agent-session-projection.js'
import { selectStructuredAgentSettledTurns, selectStructuredAgentRunningTurnTiming } from '../shared/structured-agent-session-turn-timing.js'
import { structuredSessionBackgroundTasksView } from '../structured-session-background-tasks-view.js'

// An approval option id -> Tessel's decision.
const DECISIONS = { allow: 'allow', allowSession: 'allowSession', deny: 'deny' }

// paneId: the chat pane; api: window.shellApi.chat (injectable for tests).
// onLive(event, previousStatus): each live event once applied (never the
// replayed history), e.g. for the pane's announcements.
export function useStructuredAgentSession({ paneId, api = typeof window !== 'undefined' && window.shellApi ? window.shellApi.chat : null, now = Date.now, onLive = null } = {}) {
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
    // An imported history (sessions.js emitHistory): its events, each with
    // its own seq, drawn in one batch and never announced.
    if (ev && ev.type === 'history') {
      const fresh = []
      for (const item of Array.isArray(ev.events) ? ev.events : []) {
        if (!item || !item.event || typeof item.seq !== 'number' || item.seq <= lastSeq) continue
        lastSeq = item.seq
        fresh.push(item.event)
      }
      if (typeof seq === 'number') lastSeq = Math.max(lastSeq, seq)
      const out = fresh.length ? adapter.applyMany(fresh) : null
      if (out) feed(out)
      syncMeta()
      return
    }
    if (typeof seq === 'number') {
      if (seq <= lastSeq) return
      lastSeq = seq
    }
    const previousStatus = adapter.meta.status
    const out = adapter.apply(ev)
    if (out) feed(out)
    syncMeta()
    if (typeof onLive === 'function') onLive(ev, previousStatus)
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
      // The journal's write time orders and dates the redrawn rows.
      events.push(wrapped && Number.isFinite(item.at) && !Number.isFinite(item.event.at) ? { ...item.event, at: item.at } : wrapped ? item.event : item)
      if (wrapped && typeof item.seq === 'number') lastSeq = Math.max(lastSeq, item.seq)
    }
    if (typeof res.seq === 'number') lastSeq = Math.max(lastSeq, res.seq)
    adapter.replay(events)
    // The last "/" catalog, kept apart from the journal (a short tail can miss it).
    if (adapter.meta.commands === null && Array.isArray(res.commands)) adapter.apply({ type: 'commands', commands: res.commands })
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
  // The user messages whose delivery was not confirmed (refused, or a
  // teammate's not delivered yet), by message id: their rows say so.
  const failedDeliveryMessageIds = computed(() => {
    const ids = new Set()
    for (const s of submissions.value) if (s.dispatchState === 'unknown') ids.add(agentJournalSubmissionKey(s.clientMessageId))
    return ids
  })
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
  // Skill discovery for the composer's menu: the engine scans the pane's
  // trusted folders (opaque references, never paths); a refusal is an error.
  async function discoverSkills({ refresh } = {}) {
    if (!api || !api.skills) throw new Error('skills unavailable') // i18n-ignore the menu words it
    const res = await api.skills({ paneId, ...(refresh ? { refresh: true } : {}) })
    if (!res || res.ok === false || !res.result) throw new Error((res && res.error) || 'skills unavailable') // i18n-ignore shown through the menu
    return res.result
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
    submissions,
    failedDeliveryMessageIds,
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
    // The session's "/" commands and skills as the engine reports them
    // (undefined until it did), and its skills on disk (discover()).
    sessionCommands: computed(() => (Array.isArray(meta.commands) ? meta.commands : undefined)),
    discoverSkills,
    adapter
  }
}
