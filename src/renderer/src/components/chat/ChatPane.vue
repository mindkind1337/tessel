<script setup>
// An agent as a chat (no terminal): the main process drives Claude Code
// (stream-json), Codex (app-server) or OpenCode (serve) (src/main/chat) and sends the
// conversation as events (chat:event). The pane's session
// (chat/orca/composables/useStructuredAgentSession.js) turns them into the
// journal the chat UI reads (components/chat/orca, after Orca's native chat,
// MIT, Copyright (c) 2026 Lovecast Inc.). This pane keeps Tessel's header
// (title, status, badges, rate limits, terminal, maximize, close) and what
// the engine needs: it redraws the history when it mounts, opens the session
// if it is not running (ctx.chatOpen asks the user to trust the folder when
// needed), and answers for sends, interrupts and approvals.
// A message the main process refused stays as a "Not sent" entry (copy,
// retry, discard); what was typed since is never overwritten. Send waits
// while the agent starts (the main process refuses it before it is ready),
// except when it wakes from sleep (the message waits for it there). A
// history that could not be read says so, with Retry, instead of an empty
// chat. One polite live region says what happened (the end of a turn,
// sign-in needed; a new request is announced by its card); Alt+A goes to the
// request waiting for an answer. Nothing takes the focus by itself while the
// user types.
import PaneActionsMenu from '../PaneActionsMenu.vue'
import { settings } from '../../settings'
import { inYoloFolder } from '../../../../shared/agentPrefs'
import { teamNumber } from '../../teamNumber'
import { computed, inject, nextTick, onBeforeUnmount, onMounted, provide, reactive, ref, shallowRef, watch } from 'vue'
import { Ellipsis } from 'lucide-vue-next'
import BrandIcon from '../BrandIcon.vue'
import AgentChildren from '../AgentChildren.vue'
import NativeChatView from './orca/NativeChatView.vue'
import { isFocusApprovalKey } from './orca/native-chat-approval-card.js'
import { useStructuredAgentSession } from '../../chat/orca/composables/useStructuredAgentSession'
import { rateLimitParts } from '../../chat/chatModel'
import { modelLabel } from '../../../../shared/modelLabel'
import { modelsFor } from '../../agentModels'
import { nativeChatSessionChoiceLabel } from '../../chat/orca/native-chat-session-option-labels.js'
import { t } from '../../i18n'

const props = defineProps({
  node: { type: Object, required: true }
})

const ctx = inject('panelCtx')
// Its team (ctx.teamById), and whether it leads it.
const team = computed(() => (ctx.teamById ? ctx.teamById(props.node.team) : null))
const isLead = computed(() => !!(team.value && team.value.leadId === props.node.id))

// Stopped states: the composer cannot send; no agent process runs.
const STOPPED_STATES = new Set(['ended', 'crashed', 'signin', 'untrusted'])

const opening = ref(false)
const rootEl = ref(null)
const viewRef = shallowRef(null)
const headerMenuRef = shallowRef(null)
// The header's … button: the chat's menu, under the button.
let moreButton = null
async function openMore(event) {
  moreButton = event.currentTarget
  const r = event.currentTarget.getBoundingClientRect()
  const selection = window.getSelection()
  headerSelection.value = selection && rootEl.value?.contains(selection.anchorNode) && rootEl.value?.contains(selection.focusNode) ? selection.toString() : ''
  headerMenu.x = r.left
  headerMenu.y = r.bottom + 2
  headerMenu.hasSelection = !!headerSelection.value.trim()
  headerMenu.visible = true
  await nextTick()
  if (headerMenuRef.value) headerMenu.x = Math.max(4, r.right - headerMenuRef.value.getBoundingClientRect().width)
}
// Messages the main process did not take: { key, text, error, sending }.
const unsent = ref([])
let unsentKey = 0
const historyLoading = ref(false)
// Starting again after sleep: a message waits for it (the main process queues it).
const resuming = ref(false)
// The polite live region's text.
const liveText = ref('')
let alive = true

function api() {
  const a = typeof window !== 'undefined' && window.shellApi ? window.shellApi.chat : null
  return a && typeof a === 'object' ? a : null
}

// The session (journal, live events, actions), and what a live event is
// worth saying (a replayed history says nothing).
const session = useStructuredAgentSession({ paneId: props.node.id, api: api(), onLive, cwd: () => props.node.cwd || props.node.projectDir || '', agent: () => props.node.agentId || 'claude' })
// A notice's way out (NativeChatNoticeRow): 'newConversation' keeps the pane
// and starts a fresh session (the conversation was too long to go on).
provide('chatNoticeAction', (action) => {
  if (action === 'newConversation') void newConversation()
})
const meta = session.meta

const isActive = computed(() => ctx.activeId.value === props.node.id)
const isMaximized = computed(() => ctx.maximizedId.value === props.node.id)
const status = computed(() => meta.status)
// The sidebar reads the pane's own status (App's copy only hears changes,
// and forgets them on a reload); not saved with the layout.
watch(status, (st) => {
  if (props.node.liveStatus !== st) props.node.liveStatus = st
}, { immediate: true })
const busy = computed(() => status.value === 'working' || status.value === 'approval')
const stopped = computed(() => STOPPED_STATES.has(status.value))
// Its turn is over but its background work (shells, sub-agents, monitors)
// still runs: "monitoring" (the sidebar reads it from the pane too).
const backgroundRunning = computed(() => (status.value === 'idle' && meta.backgroundTasks > 0 ? meta.backgroundTasks : 0))
watch(backgroundRunning, (n) => {
  if ((props.node.liveBackground || 0) !== n) props.node.liveBackground = n
}, { immediate: true })
// Which agent: Claude, Codex or OpenCode (the leaf's agentId).
const AGENT_NAMES = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' } // i18n-ignore product names
const agentId = computed(() => (AGENT_NAMES[props.node.agentId] ? props.node.agentId : 'claude'))
const agentName = computed(() => AGENT_NAMES[agentId.value])
// A chat saved with the old default title ("Claude (chat)", "Codex (chat)"…):
// the agent's name alone (the pane already shows it is a chat).
const title = computed(() => {
  const own = props.node.paneName || props.node.title
  if (!own) return agentName.value
  return /^\s*(claude|codex|opencode)\s*\(chat\)\s*$/i.test(own) ? agentName.value : own
})

const editingName = ref(false)
const nameDraft = ref('')
const nameInput = ref(null)
function beginRename() {
  nameDraft.value = props.node.paneName || title.value
  editingName.value = true
  nextTick(() => { nameInput.value?.focus(); nameInput.value?.select() })
}
function saveName() {
  if (editingName.value && ctx.renameAgent && ctx.renameAgent(props.node.id, nameDraft.value)) editingName.value = false
}

const statusLabel = computed(() => {
  switch (status.value) {
    case 'starting':
      return t('chat.status.starting', 'Starting')
    case 'idle':
      return backgroundRunning.value ? t('chat.status.monitoring', 'Monitoring background tasks') : t('chat.status.idle', 'Idle')
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
const iconState = computed(() =>
  status.value === 'approval'
    ? 'attention'
    : status.value === 'working'
      ? 'busy'
      : backgroundRunning.value
        ? 'monitoring'
        : typeof ctx.chatInterrupted === 'function' && ctx.chatInterrupted(props.node.id)
          ? 'interrupted'
          : ''
)

const permissions = computed(() => (typeof ctx.chatPermissions === 'function' ? ctx.chatPermissions(props.node) : null))
// What the agent may do without asking (chosen in the composer's options).
const permissionMode = computed(() => props.node.chatPermissionMode || (permissions.value === 'yolo' ? 'bypassPermissions' : 'default'))
const yolo = computed(() => permissionMode.value === 'bypassPermissions' || permissions.value === 'yolo')

// The model's name as its list gives it ("opus" -> "Opus 5.5"), else the
// short name read from its id.
// The same words as the composer's pills: the model's name from its list
// (by id, or by the alias the agent's full id stands for), else its short
// name.
function chatModelName(id) {
  const list = modelsFor(agentId.value)
  const short = modelLabel(id)
  const listed = list.find((x) => x.id === id) || list.find((x) => x.label && x.label === short)
  return listed && listed.label ? listed.label : short
}
// The effort when the pane chose none: what the agent's own settings or its
// conversation say (the same lookup as a terminal pane's header).
const settledEffort = ref(null)
let effortBusy = false
async function refreshEffort() {
  const ask = typeof window !== 'undefined' && window.shellApi ? window.shellApi.agentModel : null
  if (typeof ask !== 'function' || effortBusy || agentId.value === 'opencode') return
  effortBusy = true
  try {
    const model = meta.model || props.node.model
    const res = await ask({
      agentId: agentId.value,
      sessionId: props.node.sessionId || undefined,
      cwd: props.node.cwd || undefined,
      chosenModel: typeof model === 'string' ? model : undefined
    })
    if (!alive) return
    const effort = res && (res.chosenEffort || res.effort)
    settledEffort.value = typeof effort === 'string' && effort ? effort : null
    // The composer's effort picker shows it too (not saved with the layout).
    props.node.shownEffort = settledEffort.value || undefined
  } catch {
    /* keep what it showed */
  } finally {
    effortBusy = false
  }
}
const modelText = computed(() => {
  const m = meta.model || props.node.model
  if (!m) return ''
  const name = chatModelName(m)
  const effort = props.node.effort || settledEffort.value
  // The effort as the options pill words it ("Extra high", in your language).
  return effort ? `${name} · ${nativeChatSessionChoiceLabel({ value: effort, label: effort })}` : name
})

// The sidebar shows the same text (sidebarModel.js); not saved with the layout.
watch(modelText, (text) => {
  if (props.node.headerModel !== text) props.node.headerModel = text
}, { immediate: true })

const rateText = computed(() =>
  rateLimitParts(meta.rateLimit)
    .map((p) => (p.id === 'fiveHour' ? t('chat.rate.fiveHour', '5 h: {{pct}}%', { pct: p.pct }) : t('chat.rate.sevenDay', '7 d: {{pct}}%', { pct: p.pct })))
    .join(' · ')
)

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
  if (meta.loadError) return t('chat.composer.historyFailed', 'The conversation did not load: retry above')
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
function announceFor(event, previousStatus) {
  switch (event.type) {
    case 'turnEnd':
      if (event.status === 'failed') return t('chat.live.turnFailed', 'The turn failed')
      if (event.status === 'interrupted') return t('chat.live.turnInterrupted', 'Turn interrupted')
      return t('chat.live.turnDone', '{{agent}} finished the turn', { agent: agentName.value })
    case 'status':
      if (event.state === previousStatus) return ''
      if (event.state === 'signin') return t('chat.composer.signin', '{{agent}} is not signed in', { agent: agentName.value })
      if (event.state === 'crashed' || event.state === 'ended') return t('chat.state.stopped', 'The agent stopped')
      return ''
    default:
      return ''
  }
}
function onLive(event, previousStatus) {
  const said = announceFor(event, previousStatus)
  if (said) announce(said)
  noteStatus(event, previousStatus)
  if (event.type === 'turnEnd') refreshEffort()
}
// The leaf follows the session (a new session id, the model it runs).
function noteStatus(event, previousStatus) {
  if (event.type !== 'status') return
  if (event.state !== 'starting') resuming.value = false
  else if (previousStatus === 'asleep') resuming.value = true
  if (event.sessionId && props.node.sessionId !== event.sessionId) props.node.sessionId = event.sessionId
  if (event.model && props.node.model !== event.model) props.node.model = event.model
  if (event.state === 'ready' || event.state === 'idle') refreshEffort()
}

// --- History and start -----------------------------------------------------------------------
async function loadHistory() {
  historyLoading.value = true
  const res = await session.load()
  historyLoading.value = false
  if (!alive || !res || res.ok === false) return { ok: false }
  if (meta.sessionId && props.node.sessionId !== meta.sessionId) props.node.sessionId = meta.sessionId
  if (meta.model && props.node.model !== meta.model) props.node.model = meta.model
  // A running session whose journal said nothing of its status yet.
  if (meta.status === 'starting' && res.live && typeof res.live.status === 'string') session.dispatchLocal({ type: 'status', state: res.live.status })
  return { ok: true, res }
}

// Draws the history, then opens the session if it is not running.
async function load() {
  const { ok, res } = await loadHistory()
  if (!alive || !ok) return
  // A chat already open (a reload, a remount) sends no new status: its
  // effort is looked up now.
  refreshEffort()
  // A session already running in the main process keeps going; one asleep
  // (stopped while idle) wakes on its next message, not now.
  if (res && res.asleep) session.dispatchLocal({ type: 'status', state: 'asleep' })
  else if (!(res && (res.open || res.live))) {
    // A journal cut off mid-turn (the app quit during it): no process runs
    // that turn, its tools or its request any more (else the chat would say
    // "Working" with Stop, or show a card nobody can answer).
    if (session.turnId.value !== null || session.prompts.value.length) session.dispatchLocal({ type: 'status', state: 'ended' })
    // A conversation restored with the app (it has one already) does not ask
    // to trust its folder by itself: it waits for "Trust this folder…".
    await start({ askTrust: !props.node.sessionId })
  }
}
function retryHistory() {
  if (historyLoading.value) return
  load()
}

// The same pane, a new session: the old one is closed and its history left
// behind; the agent starts again with an empty conversation.
let renewing = false
async function newConversation() {
  const a = api()
  if (renewing || !a || typeof a.close !== 'function') return
  renewing = true
  try {
    const result = await a.close({ paneId: props.node.id, forget: true })
    if (!result || !result.ok) throw new Error(result?.error || '')
  } catch {
    ctx.toast(t('chat.newConversation.failed', 'Could not start a new conversation. Try again.'))
    return
  } finally {
    renewing = false
  }
  if (!alive) return
  session.reset()
  props.node.sessionId = null
  await load()
}

// Opens (or starts again) the session through the app.
async function start({ askTrust = true } = {}) {
  if (opening.value || typeof ctx.chatOpen !== 'function') return
  opening.value = true
  session.dispatchLocal({ type: 'status', state: 'starting' })
  let res
  try {
    res = await ctx.chatOpen(props.node, { askTrust })
  } catch (err) {
    res = { ok: false, code: 'failed', error: (err && err.message) || String(err) }
  }
  opening.value = false
  if (!alive) return
  if (res && res.ok) {
    if (res.sessionId && props.node.sessionId !== res.sessionId) props.node.sessionId = res.sessionId
    // The main process says idle itself; this covers an open that said nothing.
    if (status.value === 'starting') session.dispatchLocal({ type: 'status', state: 'idle' })
    return
  }
  const code = res && res.code
  if (code === 'busy') return // already opening elsewhere: its events will come
  if (code === 'untrusted') session.dispatchLocal({ type: 'status', state: 'untrusted' })
  else if (code === 'signin') session.dispatchLocal({ type: 'status', state: 'signin', error: (res && res.error) || '' })
  else session.dispatchLocal({ type: 'status', state: 'crashed', error: (res && res.error) || t('chat.error.open', 'Could not start {{agent}}.', { agent: agentName.value }) })
}

// --- Actions ---------------------------------------------------------------------------------
function toast(text) {
  if (typeof ctx.toast === 'function') ctx.toast(text, { timeout: 6000 })
}

function sendable() {
  const a = api()
  return !!(a && typeof a.send === 'function') && !disabledReason.value && !sendBlockedReason.value
}

// The composer's send: { ok: true } once the pane has the message (sent, or
// kept as "Not sent" when the main process refused it: the composer is then
// free for what comes next); { ok: false } when it cannot be sent now.
// With images (their ids, from the main process): a refusal keeps the draft
// and its chips in the composer (a "Not sent" entry holds text only).
async function send(text, opts = {}) {
  const body = String(text || '')
  const images = Array.isArray(opts?.images) ? opts.images.filter((id) => typeof id === 'string') : []
  if (!body.trim() && !images.length) return { ok: false }
  if (!sendable()) return { ok: false, error: disabledReason.value || sendBlockedReason.value || undefined }
  if (images.length) {
    let res
    try {
      res = await api().send({ paneId: props.node.id, text: body, images })
    } catch (err) {
      res = { ok: false, error: (err && err.message) || String(err) }
    }
    if (res && res.ok !== false) return { ok: true }
    return { ok: false, error: (res && res.error) || t('chat.error.unknown', 'unknown error') }
  }
  await deliver(reactive({ key: ++unsentKey, text: body, error: '', sending: false }))
  return { ok: true }
}

// Sends one message (a new one, or a "Not sent" one again). Refused, it
// stays in the chat as "Not sent".
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
    if (root && !root.contains(document.activeElement) && viewRef.value) viewRef.value.focusComposer()
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
function copiedUnsent({ ok }) {
  if (!ok) toast(t('chat.unsent.copyFailed', 'Could not copy the message.'))
  else if (typeof ctx.copied === 'function') ctx.copied(t('chat.unsent.what', 'Message'))
}

// Interrupts the current turn (the queued messages are still sent after it).
async function interrupt() {
  const res = await session.cancel()
  if (res && res.ok === false) {
    toast(t('chat.error.interrupt', 'Could not interrupt the turn: {{error}}', { error: res.error || t('chat.error.unknown', 'unknown error') }))
    return false
  }
  return true
}

// An answer to a request (the card's choice): a failure says so and the
// card offers its buttons again; an answer taken puts the focus back in the
// composer.
async function respond(item, response, opts) {
  const res = await session.respond(item, response, opts)
  if (!res || res.ok === false) {
    toast(t('chat.error.approve', 'Answer not sent: {{error}}', { error: (res && res.error) || t('chat.error.unknown', 'unknown error') }))
    return res || { ok: false }
  }
  nextTick(() => viewRef.value && viewRef.value.focusComposer())
  return res
}

// A model, effort or permission mode, through the app (so the leaf and a
// worker's cap follow); shown as changed only once the agent confirmed it.
async function setOption(payload) {
  if (typeof ctx.chatSetOption !== 'function') return { ok: false }
  let res
  try {
    res = await ctx.chatSetOption(props.node, payload)
  } catch (err) {
    res = { ok: false, error: (err && err.message) || String(err) }
  }
  if (res && res.ok) {
    for (const key of ['model', 'effort']) if (payload[key] != null) props.node[key] = payload[key]
    // Another model: its own default effort.
    if (payload.model != null && payload.effort == null) refreshEffort()
  }
  return res || { ok: false }
}

// --- Voice typing, compaction, sub-agents ------------------------------------------------------
// The composer's mic: Windows voice typing (Win+H, the terminal panes' own),
// into the composer, which has the focus first.
function dictate() {
  if (viewRef.value) viewRef.value.focusComposer()
  if (typeof ctx.voiceTyping === 'function') ctx.voiceTyping(props.node.id)
}
const dictationTitle = computed(() =>
  ctx.voiceName && ctx.voiceName.value
    ? t('pane.voice.label', 'Voice typing ({{language}})', { language: ctx.voiceName.value })
    : t('chat.orca.composer.startDictation', 'Start dictation')
)

// Compacting frees the context: Claude's /compact is a message like any
// other; Codex and OpenCode have their own (asked through the engine).
const COMPACTS = new Set(['claude', 'codex', 'opencode'])
const canCompact = computed(() => COMPACTS.has(agentId.value) && (agentId.value === 'claude' || !!(api() && typeof api().compact === 'function')))
async function compact() {
  if (agentId.value === 'claude') return send('/compact')
  const res = await session.compact()
  if (!res || res.ok === false) toast(t('chat.compact.failed', 'Could not compact the conversation: {{error}}', { error: (res && res.error) || t('chat.error.unknown', 'unknown error') }))
  return res || { ok: false }
}

// The sub-agents this conversation started (the engine's roster), for the
// header's list like a terminal pane's.
const children = computed(() => Object.values(meta.subagents || {}))

// --- Pane ------------------------------------------------------------------------------------
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

// Alt+A (asked for, so it may move the focus): the request waiting for an answer.
function focusPendingApproval() {
  return viewRef.value ? viewRef.value.focusPendingApproval() : false
}
function onPaneKeydown(e) {
  // No request waiting: the key is left alone.
  if (!isFocusApprovalKey(e) || !session.prompts.value.length) return
  e.preventDefault()
  e.stopPropagation()
  focusPendingApproval()
}

// Right-click keeps the original lightweight chat menu.
const contextMenuActions = computed(() => ({
  onSplitRight: () => ctx.splitLeaf(props.node.id, 'row'),
  onSplitDown: () => ctx.splitLeaf(props.node.id, 'col'),
  isPaneExpanded: isMaximized.value,
  onToggleExpand: () => ctx.toggleMaximize(props.node.id),
  ...(ctx.switchToTerminal && props.node.sessionId ? { onSwitchToTerminal: () => ctx.switchToTerminal(props.node.id) } : {}),
  onClosePane: () => ctx.closeLeaf(props.node.id)
}))
const headerMenu = reactive({ visible: false, x: 0, y: 0, hasSelection: false })
const headerSelection = ref('')
function closeHeaderMenu() { headerMenu.visible = false; if (ctx.highlightId) ctx.highlightId.value = null }
// A press outside the … menu (and not on its button) closes it, as in a terminal pane.
function onDocPointerDownHeaderMenu(e) {
  if (!headerMenu.visible) return
  if (headerMenuRef.value && headerMenuRef.value.contains(e.target)) return
  if (moreButton && moreButton.contains(e.target)) return
  closeHeaderMenu()
}
onMounted(() => window.addEventListener('pointerdown', onDocPointerDownHeaderMenu, true))
onBeforeUnmount(() => window.removeEventListener('pointerdown', onDocPointerDownHeaderMenu, true))
function headerAction(action) { return (...args) => { closeHeaderMenu(); return action(...args) } }
const headerMenuBindings = computed(() => {
  const folder = ctx.paneFolder ? ctx.paneFolder(props.node) : props.node.projectDir
  const terminalOnly = t('pane.menu.terminalOnly', 'Only available in terminal mode')
  return {
    ctxMenu: headerMenu,
    paneTitle: title.value,
    node: { ...props.node, launchYolo: yolo.value, sleeping: status.value === 'asleep' },
    ctx: { ...ctx, voiceName: ctx.voiceName || ref(''), voiceLabel: ctx.voiceLabel || ref(''), voiceLanguages: ctx.voiceLanguages || ref([]) },
    settings,
    isChat: true,
    isAgent: true,
    team: team.value,
    isLead: isLead.value,
    isMaximized: isMaximized.value,
    statusTitle: statusLabel.value,
    agentStatus: status.value === 'working' ? 'busy' : status.value,
    exited: STOPPED_STATES.has(status.value),
    asksApproval: session.prompts.value.length > 0,
    teamFactTitle: () => team.value?.name || '',
    yoloTitle: () => t('chat.pane.yoloHint', 'Tools run without asking (Settings)'),
    closeCtxMenu: closeHeaderMenu,
    // Esc: closed, the … button focused again.
    closeCtxMenuAndRefocus: () => {
      closeHeaderMenu()
      if (moreButton && moreButton.isConnected) moreButton.focus()
    },
    menuCopy: headerAction(() => window.shellApi.writeClipboard(headerSelection.value)),
    menuPaste: headerAction(() => viewRef.value?.pasteFromClipboard()),
    menuCopySession: headerAction(() => window.shellApi.writeClipboard(props.node.sessionId)),
    hasModelChoice: true,
    modelText: modelText.value,
    sessionPillLabel: () => '',
    menuModel: headerAction(() => viewRef.value?.openModelPicker()),
    menuVoice: headerAction(dictate),
    menuPickVoice: headerAction(tip => ctx.voiceTypingIn?.(props.node.id, tip)),
    otherPanes: ctx.otherPanes ? ctx.otherPanes(props.node.id) : [],
    menuSendSelection: headerAction(target => ctx.sendToPane?.(props.node.id, target, 'selection', headerSelection.value)),
    menuAskReview: headerAction(target => ctx.sendToPane?.(props.node.id, target, 'review')),
    leadToggleText: () => isLead.value ? t('pane.team.stopLeading', 'Stop leading {{team}}', { team: team.value.name }) : t('pane.team.makeLeadOf', 'Make lead of {{team}}', { team: team.value.name }),
    leaveTeamText: () => t('pane.team.leave', 'Leave {{team}}', { team: team.value.name }),
    startEditTitle: beginRename,
    menuOpenHere: headerAction(() => ctx.openLauncherAt?.({ left: headerMenu.x, bottom: headerMenu.y }, props.node.id)),
    menuSplit: headerAction(dir => ctx.splitLeaf(props.node.id, dir)),
    menuRestart: headerAction(() => ctx.restartLeaf?.(props.node.id)),
    canOpenAsChat: true,
    menuOpenAsChat: headerAction(() => ctx.switchToTerminal?.(props.node.id)),
    canSwitchYolo: true,
    yoloFolder: folder,
    yoloFolderOn: !!folder && inYoloFolder(folder, settings.yoloFolders),
    folderName: dir => String(dir || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop(),
    menuYoloFolder: headerAction(() => ctx.toggleYoloFolder?.(folder)),
    menuClose: headerAction(() => ctx.closeLeaf(props.node.id)),
    disabledReasons: {
      menuCopyOutput: terminalOnly,
      menuClear: terminalOnly,
      menuFind: terminalOnly,
      menuSwitchYolo: t('pane.menu.chatPermissions', 'Change permissions in the chat composer'),
      menuOpenAsChat: props.node.sessionId && ctx.switchToTerminal ? '' : t('pane.menu.noSession', 'Start a conversation first'),
      menuModel: ctx.chatSetOption ? '' : t('pane.menu.modelUnavailable', 'Model selection is unavailable for this agent')
    }
  }
})

onMounted(load)
onBeforeUnmount(() => {
  alive = false
})

defineExpose({ start, send, interrupt, focusPendingApproval, focusComposer: () => (viewRef.value ? viewRef.value.focusComposer() : false) })
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
        <!-- Its team, as a number (the lead's in the accent). -->
        <span v-if="team" class="pane-team-num" :class="{ lead: isLead }" data-test="chat-team-num" aria-hidden="true">{{ teamNumber(team.name) }}</span>
        <span
          class="pane-icon agent"
          :class="[iconState, { yolo }]"
          :aria-label="`${title} (${agentName})`"
          data-test="chat-icon"
          :title="yolo ? t('chat.pane.yoloHint', 'Tools run without asking (Settings)') : undefined"
        >
          <BrandIcon :kind="agentId" :size="15" />
          <span class="pane-status-dot"></span>
        </span>
        <input v-if="editingName" ref="nameInput" v-model="nameDraft" class="pane-tab-input" :aria-label="t('pane.renameAgent', 'Agent name')" @mousedown.stop @click.stop @keydown.enter.prevent="saveName" @keydown.esc="editingName = false" @blur="saveName" />
        <span v-else tabindex="0" @dblclick.stop="beginRename" @keydown.enter.prevent="beginRename" class="pane-title" data-test="chat-title" :title="t('chat.pane.titleHint', '{{title}}\nDrag the header to move the pane', { title })">{{ title }}</span>
        <!-- The state is the dot on the agent's logo; its words stay for screen readers. -->
        <span class="chat-status chat-status-sr" :class="'st-' + status" data-test="chat-status">{{ statusLabel }}</span>
        <span
          v-if="agentId === 'codex' && !yolo"
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
        <AgentChildren v-if="children.length" :agent-id="agentId" :items="children" />
        <span v-if="rateText" class="chat-rate" data-test="chat-rate" :title="t('chat.rate.hint', '{{agent}} usage limits (5 hours, 7 days)', { agent: agentName })">{{ rateText }}</span>
      </div>
      <div class="pane-nav-actions" @mousedown.stop>
        <!-- More options: the chat's menu (as a right-click in it). -->
        <button
          class="pane-nav-btn"
          data-test="chat-more"
          :title="t('chat.pane.moreHint', 'More options (or right-click in the chat)')"
          :aria-label="t('pane.more', 'More options')"
          aria-haspopup="menu"
          @click="openMore"
        >
          <Ellipsis :size="14" aria-hidden="true" />
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

    <div class="chat-body">
      <NativeChatView
        ref="viewRef"
        :node="node"
        :controller="session"
        :agent="agentId"
        :agent-name="agentName"
        :is-visible="true"
        :is-focused-group="isActive"
        :disabled-reason="disabledReason"
        :send-blocked-reason="sendBlockedReason"
        :permission-mode="permissionMode"
        :unsent="unsent"
        :launch-status="stopped ? status : null"
        :launch-error="meta.error || ''"
        :opening="opening"
        :history-loading="historyLoading"
        :send="send"
        :allow-images="true"
        :interrupt="interrupt"
        :set-option="ctx.chatSetOption ? setOption : null"
        :respond="respond"
        :dictate="dictate"
        :dictation-title="dictationTitle"
        :compact="canCompact ? compact : null"
        :context-menu-actions="contextMenuActions"
        @retry-unsent="retryUnsent"
        @discard-unsent="discardUnsent"
        @copied-unsent="copiedUnsent"
        @start="start"
        @history-retry="retryHistory"
      />
    </div>
    <div class="sr-only" role="status" aria-live="polite" aria-atomic="true" data-test="chat-live">{{ liveText }}</div>
  </div>
  <Teleport to="body"><PaneActionsMenu ref="headerMenuRef" v-bind="headerMenuBindings" data-test="chat-header-menu" /></Teleport>
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

.chat-status-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
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

.chat-model {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--text-dim);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  .chat-rate,
  .chat-model {
    display: none;
  }
}
</style>
