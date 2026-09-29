<script setup>
// A Claude agent as a chat (no terminal): the main process drives Claude
// Code over stream-json (src/main/chat) and sends the conversation as
// events (chat:event); chatModel.js turns them into rows. The pane redraws
// its history when it mounts, opens the session if it is not running
// (ctx.chatOpen asks the user to trust the folder when needed), and shows
// the status, the model and the rate limits in its header.
// A message the main process refused stays as a "Not sent" entry (copy,
// retry, discard); what was typed since is never overwritten. Send waits
// while the agent starts (the main process refuses it before it is ready),
// except when it wakes from sleep (the message waits for it there). A
// history that could not be read says so, with Retry, instead of an empty
// chat. One polite live region says what happened (the end of a turn,
// sign-in needed; a new request is announced by its card); Alt+A goes to the
// request waiting for an answer. Nothing takes the focus by itself while the
// user types.
// Look after Orca's native chat (src/renderer/src/components/native-chat/:
// NativeChatMessageList.tsx, NativeChatComposer.tsx; MIT, Copyright (c) 2026
// Lovecast Inc.), written for Vue.
import { computed, inject, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, useId, watch } from 'vue'
import { ArrowDown, FolderLock, LogIn, RotateCcw, ShieldQuestion, SquareTerminal, TriangleAlert } from 'lucide-vue-next'
import BrandIcon from '../BrandIcon.vue'
import SessionOptionPicker from '../SessionOptionPicker.vue'
import ChatMessage from './ChatMessage.vue'
import ChatToolRow from './ChatToolRow.vue'
import ChatApprovalCard, { isFocusApprovalKey } from './ChatApprovalCard.vue'
import ChatComposer from './ChatComposer.vue'
import { chatReducer, initialChatState, isBusy, pendingApproval, rateLimitParts, STOPPED_STATES } from '../../chat/chatModel'
import { modelsFor } from '../../agentModels'
import { modelLabel } from '../../../../shared/modelLabel'
import { t } from '../../i18n'

const props = defineProps({
  node: { type: Object, required: true }
})

const ctx = inject('panelCtx')

// Long chats: only the last rows are drawn ("Show earlier" adds more).
const PAGE = 300

const state = shallowRef(initialChatState())
const draft = ref('')
const opening = ref(false)
const limit = ref(PAGE)
const stick = ref(true)
const rootEl = ref(null)
const listEl = ref(null)
const composerRef = ref(null)
const modelBtnEl = ref(null)
const modelMenuEl = ref(null)
const modelMenu = reactive({ visible: false, pending: false })
const modelMenuId = `chat-model-menu-${useId()}` // i18n-ignore
// Messages the main process did not take: { key, text, error, sending }.
const unsent = ref([])
let unsentKey = 0
// The history could not be read: its error ('' = read, or not read yet).
const historyError = ref('')
const historyLoading = ref(false)
// Starting again after sleep: a message waits for it (the main process queues it).
const resuming = ref(false)
// The polite live region's text.
const liveText = ref('')
let alive = true

const isActive = computed(() => ctx.activeId.value === props.node.id)
const isMaximized = computed(() => ctx.maximizedId.value === props.node.id)
const status = computed(() => state.value.status)
const busy = computed(() => isBusy(status.value))
const stopped = computed(() => STOPPED_STATES.has(status.value))
// Which agent: Claude or Codex (the leaf's agentId).
const agentId = computed(() => (props.node.agentId === 'codex' ? 'codex' : 'claude'))
const agentName = computed(() => (agentId.value === 'codex' ? 'Codex' : 'Claude')) // i18n-ignore product names
const title = computed(() => props.node.title || agentName.value)
const startingText = computed(() => t('chat.empty.starting', 'Starting {{agent}}…', { agent: agentName.value }))
// How to sign in again: in a terminal pane of that agent.
const signinText = computed(() =>
  agentId.value === 'codex'
    ? t('chat.state.signinCodex', 'Codex is not signed in. Open a Codex terminal pane and sign in (codex login), then start again.')
    : t('chat.state.signin', 'Claude is not signed in. Open a Claude terminal pane and run /login, then start again.')
)

const statusLabel = computed(() => {
  switch (status.value) {
    case 'starting':
      return t('chat.status.starting', 'Starting')
    case 'idle':
      return t('chat.status.idle', 'Idle')
    case 'working':
      return t('chat.status.working', 'Working')
    case 'approval':
      return t('chat.status.approval', 'Needs approval')
    case 'asleep':
      return t('chat.status.asleep', 'Asleep (wakes on the next message)')
    case 'signin':
      return t('chat.status.signin', 'Not signed in')
    case 'untrusted':
      return t('chat.status.untrusted', 'Not trusted')
    default:
      return t('chat.status.stopped', 'Stopped')
  }
})
const iconState = computed(() => (status.value === 'approval' ? 'attention' : status.value === 'working' ? 'busy' : ''))

const permissions = computed(() => (typeof ctx.chatPermissions === 'function' ? ctx.chatPermissions(props.node) : null))

// --- Permission mode (header) ------------------------------------------------------------
// What the agent may do without asking. Claude has several modes; Codex two
// (Manual, Yolo). Yolo only for a chat started in Yolo and not capped (a
// worker never gets more than its coordinator); Codex in Manual never goes
// more permissive during a turn (that would stop the turn). Through
// ctx.chatSetOption, so leaf.chatPermissions follows (workers' cap).
const MODES = { claude: ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'], codex: ['default', 'bypassPermissions'] }
const permissionMode = computed(() => props.node.chatPermissionMode || (permissions.value === 'yolo' ? 'bypassPermissions' : 'default'))
function modeLabel(mode) {
  switch (mode) {
    case 'acceptEdits':
      return t('chat.mode.acceptEdits', 'Accept edits')
    case 'plan':
      return t('chat.mode.plan', 'Plan')
    case 'auto':
      return t('chat.mode.auto', 'Auto')
    case 'bypassPermissions':
      return t('chat.mode.yolo', 'Yolo')
    default:
      return t('chat.mode.manual', 'Manual')
  }
}
function modeHint(mode) {
  switch (mode) {
    case 'acceptEdits':
      return t('chat.mode.acceptEditsHint', 'Changes files without asking; still asks before running commands')
    case 'plan':
      return t('chat.mode.planHint', 'Only reads and plans: changes nothing until you accept its plan')
    case 'auto':
      return t('chat.mode.autoHint', 'Claude runs the actions it judges safe and asks for the others')
    case 'bypassPermissions':
      return t('chat.mode.yoloHint', 'Runs commands and changes files without ever asking')
    default:
      return agentId.value === 'codex'
        ? t('chat.mode.manualCodexHint', 'Works in the project folder; asks before anything outside it or with network access')
        : t('chat.mode.manualHint', 'Asks before running commands or changing files')
  }
}
// -> '' when this mode may be chosen now, else why not.
function modeBlocked(mode) {
  if (mode === permissionMode.value) return ''
  if (mode === 'bypassPermissions' && !props.node.chatLaunchYolo)
    return t('chat.mode.yoloOnlyAtStart', 'Yolo only for a chat started in Yolo (Settings > Agents)')
  if ((mode === 'bypassPermissions' || mode === 'auto') && props.node.maxPermissions === 'manual')
    return t('chat.mode.capped', 'Not more than its coordinator allows')
  if (agentId.value === 'codex' && busy.value && mode === 'bypassPermissions')
    return t('chat.mode.codexBusy', 'Wait for the end of the turn: switching now would stop it')
  return ''
}
const modeOptions = computed(() =>
  (MODES[agentId.value] || MODES.claude).map((id) => {
    const why = modeBlocked(id)
    return { id, label: modeLabel(id), title: why ? `${modeHint(id)}. ${why}` : modeHint(id), disabled: !!why }
  })
)
const modeTitle = computed(() => t('chat.mode.current', 'Permission mode: {{mode}}. {{hint}}', { mode: modeLabel(permissionMode.value), hint: modeHint(permissionMode.value) }))
const modePending = ref(false)
async function onModePick(e) {
  const mode = e.target.value
  // Shown as it is until the agent confirms.
  e.target.value = permissionMode.value
  if (!mode || mode === permissionMode.value || modeBlocked(mode) || typeof ctx.chatSetOption !== 'function') return
  modePending.value = true
  let res
  try {
    res = await ctx.chatSetOption(props.node, { permissionMode: mode })
  } catch (err) {
    res = { ok: false, error: (err && err.message) || String(err) }
  }
  modePending.value = false
  if (!res || res.ok === false)
    toast(t('chat.mode.failed', 'The permission mode did not change: {{error}}', { error: (res && res.error) || t('chat.error.unknown', 'unknown error') }))
}

const modelText = computed(() => {
  const m = state.value.model || props.node.model
  if (!m) return ''
  const name = modelLabel(m)
  return props.node.effort ? `${name} · ${props.node.effort}` : name
})

const rateText = computed(() =>
  rateLimitParts(state.value.rateLimit)
    .map((p) => (p.id === 'fiveHour' ? t('chat.rate.fiveHour', '5 h: {{pct}}%', { pct: p.pct }) : t('chat.rate.sevenDay', '7 d: {{pct}}%', { pct: p.pct })))
    .join(' · ')
)

const rows = computed(() => state.value.rows)
const hiddenCount = computed(() => Math.max(0, rows.value.length - limit.value))
const earlierText = computed(() => t('chat.list.showEarlier', 'Show earlier ({{count}})', { count: hiddenCount.value }))
const shownRows = computed(() => (hiddenCount.value ? rows.value.slice(-limit.value) : rows.value))

// The request waiting for an answer (the oldest), or null.
const pendingRow = computed(() => pendingApproval(state.value))

// Why the composer cannot send ('' = it can).
const disabledReason = computed(() => {
  switch (status.value) {
    case 'signin':
      return t('chat.composer.signin', '{{agent}} is not signed in', { agent: agentName.value })
    case 'untrusted':
      return t('chat.composer.untrusted', 'Trust this folder to start')
    case 'ended':
    case 'crashed':
      return t('chat.composer.stopped', 'The agent stopped: start it again')
    default:
      return ''
  }
})
// Why Send waits for now (typing still works; '' = it does not).
const sendBlockedReason = computed(() => {
  if (historyError.value) return t('chat.composer.historyFailed', 'The conversation did not load: retry above')
  if (status.value === 'starting' && !resuming.value) return t('chat.composer.starting', 'Wait until {{agent}} has started', { agent: agentName.value })
  return ''
})

// --- Live region -----------------------------------------------------------------------------
// Emptied first, so the same words said twice are read twice.
function announce(text) {
  liveText.value = ''
  if (!text) return
  nextTick(() => {
    if (alive) liveText.value = text
  })
}

// What a live event is worth saying (a replayed history says nothing). A new
// request is announced by its card (ChatApprovalCard's own live region).
function announceFor(event, prev) {
  switch (event.type) {
    case 'turnEnd':
      if (event.status === 'failed') return t('chat.live.turnFailed', 'The turn failed')
      if (event.status === 'interrupted') return t('chat.live.turnInterrupted', 'Turn interrupted')
      return t('chat.live.turnDone', '{{agent}} finished the turn', { agent: agentName.value })
    case 'status':
      if (event.state === prev.status) return ''
      if (event.state === 'signin') return t('chat.composer.signin', '{{agent}} is not signed in', { agent: agentName.value })
      if (event.state === 'crashed' || event.state === 'ended') return t('chat.state.stopped', 'The agent stopped')
      return ''
    default:
      return ''
  }
}

// --- Events ----------------------------------------------------------------------------------
function api() {
  const a = typeof window !== 'undefined' && window.shellApi ? window.shellApi.chat : null
  return a && typeof a === 'object' ? a : null
}

function dispatch(event) {
  if (!event || typeof event !== 'object') return
  const prev = state.value
  state.value = chatReducer(prev, event, { cwd: props.node.cwd || '' })
  const said = announceFor(event, prev)
  if (said) announce(said)
  if (event.type === 'status') {
    if (event.state !== 'starting') resuming.value = false
    else if (prev.status === 'asleep') resuming.value = true
    if (event.sessionId && props.node.sessionId !== event.sessionId) props.node.sessionId = event.sessionId
    if (event.model && props.node.model !== event.model) props.node.model = event.model
  }
}

// Live events wait until the history is drawn; seq drops what it already had.
let lastSeq = -Infinity
let loaded = false
const buffered = []
function applyMessage(msg) {
  if (typeof msg.seq === 'number') {
    if (msg.seq <= lastSeq) return
    lastSeq = msg.seq
  }
  dispatch(msg.event)
}
function onChatEvent(msg) {
  if (!msg || msg.paneId !== props.node.id) return
  if (!loaded) buffered.push(msg)
  else applyMessage(msg)
}

// Resolves { ok: true, res } once drawn (res null: nothing to read), or
// { ok: false } when the history could not be read (historyError says why;
// the live events wait for a Retry that works).
async function loadHistory() {
  const a = api()
  let res = null
  if (a && typeof a.history === 'function') {
    historyError.value = ''
    historyLoading.value = true
    let error = ''
    try {
      res = await a.history({ paneId: props.node.id })
    } catch (err) {
      res = null
      error = (err && err.message) || String(err)
    }
    historyLoading.value = false
    if (!alive) return { ok: false }
    if (!res || res.ok === false || !Array.isArray(res.events)) {
      historyError.value = error || (res && res.error) || t('chat.error.unknown', 'unknown error')
      return { ok: false }
    }
  }
  if (!alive) return { ok: false }
  if (res) {
    let s = state.value
    for (const item of res.events) {
      const wrapped = item && item.event && !item.type
      const ev = wrapped ? item.event : item
      if (wrapped && typeof item.seq === 'number') lastSeq = Math.max(lastSeq, item.seq)
      s = chatReducer(s, ev, { cwd: props.node.cwd || '' })
    }
    state.value = s
    if (typeof res.seq === 'number') lastSeq = Math.max(lastSeq, res.seq)
    if (s.sessionId && props.node.sessionId !== s.sessionId) props.node.sessionId = s.sessionId
    if (s.model && props.node.model !== s.model) props.node.model = s.model
    // A running session whose journal said nothing of its status yet.
    if (s.status === 'starting' && res.live && typeof res.live.status === 'string') state.value = chatReducer(s, { type: 'status', state: res.live.status })
  }
  loaded = true
  for (const msg of buffered.splice(0)) applyMessage(msg)
  return { ok: true, res }
}

// Draws the history, then opens the session if it is not running.
async function load() {
  const { ok, res } = await loadHistory()
  if (!alive || !ok) return
  nextTick(scrollToBottom)
  // A session already running in the main process keeps going; one asleep
  // (stopped while idle) wakes on its next message, not now.
  if (res && res.asleep) dispatch({ type: 'status', state: 'asleep' })
  else if (!(res && (res.open || res.live))) await start()
}
function retryHistory() {
  if (historyLoading.value) return
  load()
}

// Opens (or starts again) the session through the app.
async function start() {
  if (opening.value || typeof ctx.chatOpen !== 'function') return
  opening.value = true
  dispatch({ type: 'status', state: 'starting' })
  let res
  try {
    res = await ctx.chatOpen(props.node)
  } catch (err) {
    res = { ok: false, code: 'failed', error: (err && err.message) || String(err) }
  }
  opening.value = false
  if (!alive) return
  if (res && res.ok) {
    if (res.sessionId && props.node.sessionId !== res.sessionId) props.node.sessionId = res.sessionId
    // The main process says idle itself; this covers an open that said nothing.
    if (status.value === 'starting') dispatch({ type: 'status', state: 'idle' })
    return
  }
  const code = res && res.code
  if (code === 'busy') return // already opening elsewhere: its events will come
  if (code === 'untrusted') dispatch({ type: 'status', state: 'untrusted' })
  else if (code === 'signin') dispatch({ type: 'status', state: 'signin', error: (res && res.error) || '' })
  else dispatch({ type: 'status', state: 'crashed', error: (res && res.error) || t('chat.error.open', 'Could not start {{agent}}.', { agent: agentName.value }) })
}

// --- Actions ---------------------------------------------------------------------------------
function toast(text) {
  if (typeof ctx.toast === 'function') ctx.toast(text, { timeout: 6000 })
}

function sendable() {
  const a = api()
  return !!(a && typeof a.send === 'function') && !disabledReason.value && !sendBlockedReason.value
}

// Resolves true once the main process took it.
async function send(text) {
  const body = String(text || '')
  if (!body.trim() || !sendable()) return false
  draft.value = ''
  stick.value = true
  return deliver(reactive({ key: ++unsentKey, text: body, error: '', sending: false }))
}

// Sends one message (a new one, or a "Not sent" one again). Refused, it
// stays in the chat as "Not sent"; the composer is left alone.
async function deliver(entry) {
  const a = api()
  entry.sending = true
  let res
  try {
    res = await a.send({ paneId: props.node.id, text: entry.text })
  } catch (err) {
    res = { ok: false, error: (err && err.message) || String(err) }
  }
  entry.sending = false
  if (!alive) return false
  const i = unsent.value.findIndex((u) => u.key === entry.key)
  if (res && res.ok !== false) {
    if (i >= 0) unsent.value.splice(i, 1)
    return true
  }
  entry.error = (res && res.error) || t('chat.error.unknown', 'unknown error')
  if (i < 0) unsent.value.push(entry)
  toast(t('chat.error.send', 'Message not sent: {{error}}', { error: entry.error }))
  return false
}

function hasFocus() {
  const root = rootEl.value
  return !!(root && root.contains(document.activeElement))
}
// The focus left with a removed entry: back to typing.
function refocusAfter(had) {
  if (!had) return
  nextTick(() => {
    const root = rootEl.value
    if (root && !root.contains(document.activeElement) && composerRef.value) composerRef.value.focus()
  })
}
async function retryUnsent(entry) {
  if (entry.sending || !sendable()) return
  const had = hasFocus()
  if (await deliver(entry)) refocusAfter(had)
}
function discardUnsent(entry) {
  const i = unsent.value.findIndex((u) => u.key === entry.key)
  if (i < 0) return
  const had = hasFocus()
  unsent.value.splice(i, 1)
  refocusAfter(had)
}
async function copyUnsent(entry) {
  let ok = true
  try {
    if (window.shellApi && typeof window.shellApi.writeClipboard === 'function') window.shellApi.writeClipboard(entry.text)
    else if (navigator.clipboard) await navigator.clipboard.writeText(entry.text)
    else ok = false
  } catch {
    ok = false
  }
  if (!ok) toast(t('chat.unsent.copyFailed', 'Could not copy the message.'))
  else if (typeof ctx.copied === 'function') ctx.copied(t('chat.unsent.what', 'Message'))
}

// Interrupts the current turn (the queued messages are still sent after it).
async function interrupt() {
  const a = api()
  if (!a || typeof a.interrupt !== 'function') return false
  let res
  try {
    res = await a.interrupt({ paneId: props.node.id })
  } catch (err) {
    res = { ok: false, error: (err && err.message) || String(err) }
  }
  if (res && res.ok === false) {
    toast(t('chat.error.interrupt', 'Could not interrupt the turn: {{error}}', { error: res.error || t('chat.error.unknown', 'unknown error') }))
    return false
  }
  return true
}

async function answer({ requestId, decision, message }) {
  const a = api()
  if (!a || typeof a.approve !== 'function') return false
  let res
  try {
    res = await a.approve({ paneId: props.node.id, requestId, decision, message: message || '' })
  } catch (err) {
    res = { ok: false, error: (err && err.message) || String(err) }
  }
  if (res && res.ok === false) {
    toast(t('chat.error.approve', 'Answer not sent: {{error}}', { error: res.error || t('chat.error.unknown', 'unknown error') }))
    return false
  }
  // Back to typing once the question is answered.
  nextTick(() => composerRef.value && composerRef.value.focus())
  return true
}

// The whole input of a request whose card shows only its start.
async function fetchApprovalInput({ requestId }) {
  const a = api()
  if (!a || typeof a.approvalInput !== 'function') return null
  try {
    const res = await a.approvalInput({ paneId: props.node.id, requestId })
    return res && res.ok ? res.input : null
  } catch {
    return null
  }
}

// --- Model -----------------------------------------------------------------------------------
const modelList = computed(() => (modelMenu.visible ? modelsFor(agentId.value) : []))
const modelValues = computed(() => ({ model: state.value.model || props.node.model || null, effort: props.node.effort || undefined }))
async function onModelPick({ optionId, value }) {
  if (optionId !== 'model' && optionId !== 'effort') return
  const a = api()
  modelMenu.pending = true
  const payload = { paneId: props.node.id, [optionId]: value }
  let res = { ok: true }
  if (a && typeof a.setOption === 'function') {
    try {
      res = typeof ctx.chatSetOption === 'function' ? await ctx.chatSetOption(props.node, payload) : await a.setOption(payload)
    } catch (err) {
      res = { ok: false, error: (err && err.message) || String(err) }
    }
  }
  modelMenu.pending = false
  if (res && res.ok === false) {
    toast(t('chat.error.option', 'Could not change it: {{error}}', { error: res.error || t('chat.error.unknown', 'unknown error') }))
    return
  }
  props.node[optionId] = value
  closeModelMenu(true)
}
// Opens with the focus on its first choice; closes back to the chip (Esc, a
// choice) or leaves the focus where the user went (a click, Tab away).
function openModelMenu() {
  modelMenu.visible = true
  nextTick(() => {
    const el = modelMenuEl.value
    if (!el) return
    const first = el.querySelector('button:not(:disabled), input:not(:disabled), select:not(:disabled)')
    ;(first || el).focus()
  })
}
function closeModelMenu(refocus = false) {
  if (!modelMenu.visible) return
  modelMenu.visible = false
  if (refocus) nextTick(() => modelBtnEl.value && modelBtnEl.value.focus())
}
function toggleModelMenu() {
  if (modelMenu.visible) closeModelMenu(false)
  else openModelMenu()
}
function onModelMenuKeydown(e) {
  if (e.key !== 'Escape') return
  // Only the menu: not an interrupt, nor the app's Escape.
  e.preventDefault()
  e.stopPropagation()
  closeModelMenu(true)
}
function onModelMenuFocusOut(e) {
  const to = e.relatedTarget
  if (!to) return
  if (modelMenuEl.value && modelMenuEl.value.contains(to)) return
  if (modelBtnEl.value && modelBtnEl.value.contains(to)) return
  closeModelMenu(false)
}
function onDocMouseDown(e) {
  if (!modelMenu.visible) return
  if (modelMenuEl.value && modelMenuEl.value.contains(e.target)) return
  if (modelBtnEl.value && modelBtnEl.value.contains(e.target)) return
  closeModelMenu(false)
}

// --- Scrolling -------------------------------------------------------------------------------
function atBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 40
}
function onScroll() {
  const el = listEl.value
  if (el) stick.value = atBottom(el)
}
function scrollToBottom() {
  const el = listEl.value
  if (el) el.scrollTop = el.scrollHeight
}
function jumpToLatest() {
  stick.value = true
  limit.value = PAGE
  nextTick(scrollToBottom)
}
function showEarlier() {
  const el = listEl.value
  const before = el ? el.scrollHeight - el.scrollTop : 0
  limit.value += PAGE
  // The rows in view stay where they were.
  nextTick(() => {
    if (el) el.scrollTop = el.scrollHeight - before
  })
}
watch(
  [rows, () => unsent.value.length],
  () => {
    if (stick.value) nextTick(scrollToBottom)
  },
  { flush: 'post' }
)

// --- Pane ------------------------------------------------------------------------------------
function focusComposer() {
  const root = rootEl.value
  if (!root || root.contains(document.activeElement)) return
  if (composerRef.value) composerRef.value.focus()
}
watch(isActive, (a) => {
  if (a) nextTick(focusComposer)
})
function onPaneMouseDown() {
  ctx.setActive(props.node.id)
}
function onNavPointerDown(e) {
  if (e.button !== 0) return
  if (e.target.closest('button, input, label')) return
  if (typeof ctx.beginPaneDrag === 'function') ctx.beginPaneDrag(props.node.id, e)
}
function onNavMouseDown(e) {
  if (!e.target.closest('input, label')) e.preventDefault()
  ctx.setActive(props.node.id)
}
// A new question takes the focus when nothing is being typed here.
const approvalFocus = computed(() => isActive.value && !draft.value.trim())

// The approval cards by request id (to focus one).
const cardRefs = new Map()
function setCardRef(requestId, el) {
  if (el) cardRefs.set(requestId, el)
  else cardRefs.delete(requestId)
}
// Alt+A (isFocusApprovalKey; asked for, so it may move the focus): the
// request waiting for an answer, drawn first if "Show earlier" hid it.
async function focusPendingApproval() {
  const row = pendingRow.value
  if (!row) return false
  const i = rows.value.indexOf(row)
  if (i >= 0 && i < rows.value.length - limit.value) limit.value = rows.value.length - i
  await nextTick()
  const card = cardRefs.get(row.requestId)
  if (!card || typeof card.focus !== 'function') return false
  return card.focus() !== false
}
function onPaneKeydown(e) {
  // No request waiting: the key is left alone.
  if (!isFocusApprovalKey(e) || !pendingRow.value) return
  e.preventDefault()
  e.stopPropagation()
  focusPendingApproval()
}
const gotoApprovalText = computed(() =>
  t('chat.pane.gotoApproval', '{{tool}} waits for your answer (Alt+A)', { tool: pendingRow.value ? pendingRow.value.displayName || pendingRow.value.toolName : '' })
)

let unsubscribe = null
onMounted(async () => {
  const a = api()
  if (a && typeof a.onEvent === 'function') {
    const off = a.onEvent(onChatEvent)
    if (typeof off === 'function') unsubscribe = off
  }
  document.addEventListener('mousedown', onDocMouseDown, true)
  await load()
})

onBeforeUnmount(() => {
  alive = false
  if (unsubscribe) {
    try {
      unsubscribe()
    } catch {
      // Already gone.
    }
  }
  document.removeEventListener('mousedown', onDocMouseDown, true)
})

defineExpose({ start, send, interrupt, focusPendingApproval })
</script>

<template>
  <div
    ref="rootEl"
    class="pane chat-pane"
    :class="{
      active: isActive,
      maximized: isMaximized,
      highlighted: ctx.highlightId.value === node.id,
      'needs-you': status === 'approval'
    }"
    :data-pane-id="node.id"
    data-pane-kind="chat"
    tabindex="-1"
    @mousedown="onPaneMouseDown"
    @keydown="onPaneKeydown"
  >
    <div
      class="pane-nav agent"
      :class="{ busy: status === 'working' }"
      :style="node.accent ? { '--accent': node.accent } : null"
      data-test="pane-header"
      @mousedown.stop="onNavMouseDown"
      @pointerdown="onNavPointerDown"
    >
      <div class="pane-nav-left">
        <span v-if="node.num" class="pane-num" :title="t('editor.pane.number', 'Pane #{{num}}', { num: node.num })">{{ node.num }}</span>
        <span class="pane-icon agent" :class="[iconState, { yolo: permissions === 'yolo' }]" :aria-label="title">
          <BrandIcon :kind="agentId" :size="15" />
          <span class="pane-status-dot"></span>
        </span>
        <span class="pane-title" data-test="chat-title" :title="t('chat.pane.titleHint', '{{title}}\nDrag the header to move the pane', { title })">{{ title }}</span>
        <span class="chat-status" :class="'st-' + status" data-test="chat-status">
          <span class="chat-status-dot" aria-hidden="true"></span>{{ statusLabel }}
        </span>
        <button
          v-if="modelText"
          ref="modelBtnEl"
          class="pane-model-chip"
          type="button"
          data-test="chat-model"
          aria-haspopup="true"
          :aria-expanded="modelMenu.visible ? 'true' : 'false'"
          :aria-controls="modelMenuId"
          :aria-label="t('pane.sessionOptions.chipLabel', 'Model: {{model}}. Choose the model', { model: modelText })"
          @mousedown.stop
          @click.stop="toggleModelMenu"
        >
          {{ modelText }}
        </button>
        <select
          class="chat-mode"
          :class="{ yolo: permissionMode === 'bypassPermissions' }"
          data-test="chat-mode"
          :value="permissionMode"
          :disabled="modePending || stopped || status === 'starting' || !ctx.chatSetOption"
          :title="modeTitle"
          :aria-label="modeTitle"
          @mousedown.stop
          @keydown.esc.stop
          @change="onModePick"
        >
          <option v-for="m in modeOptions" :key="m.id" :value="m.id" :disabled="m.disabled" :title="m.title">{{ m.label }}</option>
        </select>
        <span
          v-if="permissions === 'yolo' && !ctx.chatSetOption"
          class="chat-badge yolo"
          data-test="chat-permissions"
          :title="t('chat.pane.yoloHint', 'Tools run without asking (Settings)')"
          >Yolo</span
        >
        <span
          v-if="agentId === 'codex' && permissions !== 'yolo'"
          class="chat-badge mcp"
          data-test="chat-mcp-unsandboxed"
          :title="
            t(
              'chat.pane.mcpUnsandboxedHint',
              'Manual mode: commands and file changes are sandboxed and ask first. MCP tools from your Codex config are not sandboxed: they run with your rights, and Tessel asks only when Codex asks for approval.'
            )
          "
          >{{ t('chat.pane.mcpUnsandboxed', 'MCP not sandboxed') }}</span
        >
        <span v-if="rateText" class="chat-rate" data-test="chat-rate" :title="t('chat.rate.hint', '{{agent}} usage limits (5 hours, 7 days)', { agent: agentName })">{{ rateText }}</span>
      </div>
      <div class="pane-nav-actions" @mousedown.stop>
        <button
          v-if="ctx.switchToTerminal && node.sessionId"
          class="pane-nav-btn"
          data-test="chat-open-terminal"
          :title="t('chat.pane.openInTerminalHint', 'Continue this conversation in a terminal pane: same pane, same permissions or fewer')"
          :aria-label="t('chat.pane.openInTerminal', 'Open in terminal')"
          :disabled="busy"
          @click="ctx.switchToTerminal(node.id)"
        >
          <SquareTerminal :size="14" aria-hidden="true" />
        </button>
        <button
          class="pane-nav-btn"
          :title="isMaximized ? t('editor.pane.restore', 'Restore pane') : t('editor.pane.maximize', 'Maximize pane')"
          @click="ctx.toggleMaximize(node.id)"
        >
          <svg v-if="isMaximized" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M6 2v4H2M14 6h-4V2M10 14v-4h4M2 10h4v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <svg v-else width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
        <button
          class="pane-nav-btn close"
          :title="t('editor.pane.closeHint', 'Close pane (Ctrl+Shift+W)')"
          :aria-label="t('editor.pane.close', 'Close pane')"
          @click="ctx.closeLeaf(node.id)"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
          </svg>
        </button>
      </div>
    </div>

    <div
      v-if="modelMenu.visible"
      :id="modelMenuId"
      ref="modelMenuEl"
      class="chat-model-menu"
      data-test="chat-model-menu"
      role="dialog"
      tabindex="-1"
      :aria-label="t('pane.sessionOptions.model', 'Model')"
      @mousedown.stop
      @keydown="onModelMenuKeydown"
      @focusout="onModelMenuFocusOut"
    >
      <SessionOptionPicker
        :agent-id="agentId"
        :models="modelList"
        :values="modelValues"
        :live="false"
        :pending="modelMenu.pending"
        :disabled-reason="busy ? t('chat.model.busy', 'Wait for the end of the turn') : ''"
        @set="onModelPick"
      />
    </div>

    <div class="chat-body">
      <div ref="listEl" class="chat-list" data-test="chat-list" @scroll="onScroll">
        <div class="chat-list-inner">
          <button v-if="hiddenCount" type="button" class="chat-earlier" data-test="chat-earlier" @click="showEarlier">
            {{ earlierText }}
          </button>
          <div v-if="!rows.length && !unsent.length" class="chat-empty" data-test="chat-empty">
            <BrandIcon :kind="agentId" :size="28" />
            <template v-if="!historyError">
              <span v-if="status === 'starting'">{{ startingText }}</span>
              <span v-else-if="!stopped">{{ t('chat.empty.idle', 'Send a message to start.') }}</span>
            </template>
          </div>
          <template v-for="row in shownRows" :key="row.key">
            <ChatToolRow v-if="row.kind === 'tool'" :row="row" />
            <ChatApprovalCard
              v-else-if="row.kind === 'approval'"
              :ref="(el) => setCardRef(row.requestId, el)"
              :row="row"
              :agent-id="agentId"
              :cwd="node.cwd || ''"
              :auto-focus="approvalFocus"
              :answer="answer"
              :fetch-input="fetchApprovalInput"
            />
            <ChatMessage v-else :row="row" />
          </template>
          <div
            v-for="u in unsent"
            :key="'unsent-' + u.key"
            class="chat-unsent"
            role="group"
            :aria-label="t('chat.unsent.title', 'Not sent')"
            data-test="chat-unsent"
          >
            <div class="chat-unsent-head">
              <TriangleAlert :size="13" class="chat-unsent-icon" aria-hidden="true" />
              <span class="chat-unsent-title">{{ u.sending ? t('chat.unsent.sending', 'Sending…') : t('chat.unsent.title', 'Not sent') }}</span>
              <span v-if="u.error && !u.sending" class="chat-unsent-error" data-test="chat-unsent-error">{{ u.error }}</span>
            </div>
            <div class="chat-unsent-text" data-test="chat-unsent-text">{{ u.text }}</div>
            <div class="chat-unsent-actions">
              <button
                type="button"
                class="chat-state-btn"
                data-test="chat-unsent-retry"
                :disabled="u.sending || !!disabledReason || !!sendBlockedReason"
                :title="disabledReason || sendBlockedReason || undefined"
                @click="retryUnsent(u)"
              >
                <RotateCcw :size="13" aria-hidden="true" />
                {{ t('chat.unsent.retry', 'Retry') }}
              </button>
              <button type="button" class="chat-state-btn" data-test="chat-unsent-copy" @click="copyUnsent(u)">
                {{ t('chat.unsent.copy', 'Copy') }}
              </button>
              <button type="button" class="chat-state-btn" data-test="chat-unsent-discard" :disabled="u.sending" @click="discardUnsent(u)">
                {{ t('chat.unsent.discard', 'Discard') }}
              </button>
            </div>
          </div>
          <div v-if="status === 'working'" class="chat-working" data-test="chat-working">
            <span class="chat-working-dots" aria-hidden="true"><i></i><i></i><i></i></span>
            {{ t('chat.status.working', 'Working') }}
          </div>
        </div>
      </div>

      <button v-if="!stick" type="button" class="chat-jump" data-test="chat-jump" @click="jumpToLatest">
        <ArrowDown :size="13" aria-hidden="true" />
        {{ t('chat.list.jump', 'Jump to latest') }}
      </button>

      <div v-if="historyError" class="chat-state st-crashed" data-test="chat-history-error">
        <TriangleAlert :size="15" class="chat-state-icon" aria-hidden="true" />
        <div class="chat-state-text">
          <div class="chat-state-title">{{ t('chat.history.failed', 'Could not load the conversation') }}</div>
          <div class="chat-state-error">{{ historyError }}</div>
        </div>
        <button type="button" class="chat-state-btn" data-test="chat-history-retry" :disabled="historyLoading" @click="retryHistory">
          <RotateCcw :size="13" aria-hidden="true" />
          {{ t('chat.history.retry', 'Retry') }}
        </button>
      </div>

      <button
        v-if="pendingRow"
        type="button"
        class="chat-goto-approval"
        data-test="chat-goto-approval"
        aria-keyshortcuts="Alt+A"
        @click="focusPendingApproval"
      >
        <ShieldQuestion :size="13" aria-hidden="true" />
        {{ gotoApprovalText }}
      </button>

      <div v-if="stopped" class="chat-state" :class="'st-' + status" data-test="chat-state">
        <template v-if="status === 'signin'">
          <LogIn :size="15" class="chat-state-icon" aria-hidden="true" />
          <div class="chat-state-text">
            {{ signinText }}
          </div>
          <button type="button" class="chat-state-btn" data-test="chat-start-again" :disabled="opening" @click="start">
            <RotateCcw :size="13" aria-hidden="true" />
            {{ t('chat.state.startAgain', 'Start again') }}
          </button>
        </template>
        <template v-else-if="status === 'untrusted'">
          <FolderLock :size="15" class="chat-state-icon" aria-hidden="true" />
          <div class="chat-state-text">{{ t('chat.state.untrusted', 'This folder is not trusted yet.') }}</div>
          <button type="button" class="chat-state-btn" data-test="chat-trust" :disabled="opening" @click="start">
            {{ t('chat.state.trust', 'Trust this folder…') }}
          </button>
        </template>
        <template v-else>
          <TriangleAlert :size="15" class="chat-state-icon" aria-hidden="true" />
          <div class="chat-state-text">
            <div class="chat-state-title">{{ t('chat.state.stopped', 'The agent stopped') }}</div>
            <div v-if="state.error" class="chat-state-error" data-test="chat-state-error">{{ state.error }}</div>
          </div>
          <button type="button" class="chat-state-btn" data-test="chat-start-again" :disabled="opening" @click="start">
            <RotateCcw :size="13" aria-hidden="true" />
            {{ t('chat.state.startAgain', 'Start again') }}
          </button>
        </template>
      </div>

      <ChatComposer
        ref="composerRef"
        v-model="draft"
        :busy="busy"
        :agent-name="agentName"
        :disabled-reason="disabledReason"
        :send-blocked-reason="sendBlockedReason"
        @send="send"
        @interrupt="interrupt"
      />
    </div>
    <div class="sr-only" role="status" aria-live="polite" aria-atomic="true" data-test="chat-live">{{ liveText }}</div>
  </div>
</template>

<style scoped>
.chat-pane {
  outline: none;
}

.chat-body {
  position: absolute;
  top: 30px;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--term);
}

.chat-status {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 5px;
  color: var(--text-dim);
  font-size: 11px;
  white-space: nowrap;
}

.chat-status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #5b6270;
}

.chat-status.st-working .chat-status-dot {
  background: #3ddc84;
}

.chat-status.st-working {
  color: #6fe3a2;
}

.chat-status.st-approval .chat-status-dot,
.chat-status.st-signin .chat-status-dot,
.chat-status.st-untrusted .chat-status-dot {
  background: var(--warn);
}

.chat-status.st-approval {
  color: #ffd98f;
}

.chat-status.st-ended .chat-status-dot,
.chat-status.st-crashed .chat-status-dot {
  background: var(--danger);
}

.chat-badge {
  flex: 0 0 auto;
  padding: 0 6px;
  border-radius: 9px;
  font-size: 10.5px;
  line-height: 16px;
}

.chat-badge.mcp {
  background: color-mix(in srgb, var(--warn) 16%, transparent);
  color: var(--warn);
  white-space: nowrap;
}

.chat-badge.yolo {
  background: color-mix(in srgb, var(--danger) 18%, transparent);
  color: var(--danger);
}

.chat-rate {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--text-dim);
  font-size: 10.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@container (max-width: 420px) {
  .chat-rate {
    display: none;
  }
}

.chat-model-menu {
  position: absolute;
  top: 32px;
  left: 40px;
  z-index: 20;
  width: 300px;
  max-width: calc(100% - 48px);
  max-height: calc(100% - 44px);
  overflow: auto;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  background: var(--surface);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
}

.chat-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
}

.chat-list-inner {
  display: flex;
  flex-direction: column;
  gap: 1px;
  max-width: 900px;
  margin: 0 auto;
  padding: 12px 14px 8px;
}

.chat-earlier {
  align-self: center;
  margin-bottom: 8px;
  padding: 3px 10px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface);
  color: var(--text-dim);
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
}

.chat-earlier:hover {
  color: var(--text);
}

.chat-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  margin-top: 18%;
  color: var(--text-dim);
  font-size: 12.5px;
  opacity: 0.85;
}

.chat-working {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  margin: 6px 0 2px;
  color: var(--text-dim);
  font-size: 12px;
}

.chat-working-dots {
  display: inline-flex;
  gap: 3px;
}

.chat-working-dots i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
  animation: chat-dot 1.2s ease-in-out infinite;
}

.chat-working-dots i:nth-child(2) {
  animation-delay: 0.15s;
}

.chat-working-dots i:nth-child(3) {
  animation-delay: 0.3s;
}

@keyframes chat-dot {
  0%,
  80%,
  100% {
    opacity: 0.25;
  }
  40% {
    opacity: 1;
  }
}

.chat-jump {
  position: absolute;
  left: 50%;
  bottom: 70px;
  z-index: 4;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 11px;
  transform: translateX(-50%);
  border: 1px solid var(--border-strong);
  border-radius: 14px;
  background: var(--surface);
  color: var(--text);
  font: inherit;
  font-size: 11.5px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.3);
  cursor: pointer;
}

.chat-unsent {
  align-self: flex-end;
  max-width: min(85%, 640px);
  margin: 4px 0;
  padding: 7px 10px;
  border: 1px dashed color-mix(in srgb, var(--danger) 55%, var(--border-strong));
  border-radius: 8px;
  background: var(--surface);
  font-size: 12.5px;
}

.chat-unsent-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  color: var(--danger);
  font-size: 11.5px;
}

.chat-unsent-icon {
  flex: 0 0 auto;
}

.chat-unsent-title {
  font-weight: 600;
}

.chat-unsent-error {
  min-width: 0;
  color: var(--text-dim);
  word-break: break-word;
}

.chat-unsent-text {
  margin: 5px 0 7px;
  color: var(--text-strong);
  white-space: pre-wrap;
  word-break: break-word;
  user-select: text;
}

.chat-unsent-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.chat-goto-approval {
  display: inline-flex;
  align-self: center;
  align-items: center;
  gap: 6px;
  max-width: calc(100% - 20px);
  margin: 0 10px 6px;
  padding: 3px 10px;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--warn) 55%, var(--border-strong));
  border-radius: 12px;
  background: var(--surface);
  color: var(--text);
  font: inherit;
  font-size: 11.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}

.chat-goto-approval svg {
  flex: 0 0 auto;
  color: var(--warn);
}

.chat-goto-approval:hover {
  background: var(--surface-2);
}

.chat-state {
  display: flex;
  align-items: center;
  gap: 9px;
  margin: 0 10px 8px;
  padding: 8px 10px;
  border: 1px solid var(--border-strong);
  border-radius: 7px;
  background: var(--surface);
  color: var(--text);
  font-size: 12.5px;
}

.chat-state.st-crashed,
.chat-state.st-ended {
  border-color: color-mix(in srgb, var(--danger) 45%, var(--border-strong));
}

.chat-state.st-signin,
.chat-state.st-untrusted {
  border-color: color-mix(in srgb, var(--warn) 45%, var(--border-strong));
}

.chat-state-icon {
  flex: 0 0 auto;
  color: var(--warn);
}

.st-crashed .chat-state-icon,
.st-ended .chat-state-icon {
  color: var(--danger);
}

.chat-state-text {
  flex: 1 1 auto;
  min-width: 0;
}

.chat-state-title {
  font-weight: 600;
}

.chat-state-error {
  margin-top: 2px;
  color: var(--text-dim);
  font-family: 'Cascadia Mono', Consolas, monospace;
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-word;
}

.chat-state-btn {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--border-strong);
  border-radius: 5px;
  background: var(--surface-2);
  color: var(--text-strong);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.chat-state-btn:hover:not(:disabled) {
  background: var(--surface-3);
}

.chat-state-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.chat-mode {
  flex: none;
  max-width: 140px;
  height: 20px;
  padding: 0 4px;
  font-size: 11px;
  color: var(--muted, inherit);
  background: transparent;
  border: 1px solid var(--border, rgba(127, 127, 127, 0.35));
  border-radius: 4px;
  cursor: pointer;
}
.chat-mode.yolo {
  color: var(--danger, #e5484d);
  border-color: currentColor;
}
.chat-mode:focus-visible {
  outline: 2px solid var(--accent, #4c8dff);
  outline-offset: 1px;
}
.chat-mode:disabled {
  cursor: default;
  opacity: 0.6;
}
</style>
