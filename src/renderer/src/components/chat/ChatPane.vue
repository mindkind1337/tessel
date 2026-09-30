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
import { computed, inject, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef } from 'vue'
import { SquareTerminal } from 'lucide-vue-next'
import BrandIcon from '../BrandIcon.vue'
import NativeChatView from './orca/NativeChatView.vue'
import { isFocusApprovalKey } from './orca/native-chat-approval-card.js'
import { useStructuredAgentSession } from '../../chat/orca/composables/useStructuredAgentSession'
import { rateLimitParts } from '../../chat/chatModel'
import { modelLabel } from '../../../../shared/modelLabel'
import { modelsFor } from '../../agentModels'
import { t } from '../../i18n'

const props = defineProps({
  node: { type: Object, required: true }
})

const ctx = inject('panelCtx')

// Stopped states: the composer cannot send; no agent process runs.
const STOPPED_STATES = new Set(['ended', 'crashed', 'signin', 'untrusted'])

const opening = ref(false)
const rootEl = ref(null)
const viewRef = shallowRef(null)
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
const session = useStructuredAgentSession({ paneId: props.node.id, api: api(), onLive, cwd: () => props.node.cwd || props.node.projectDir || '' })
const meta = session.meta

const isActive = computed(() => ctx.activeId.value === props.node.id)
const isMaximized = computed(() => ctx.maximizedId.value === props.node.id)
const status = computed(() => meta.status)
const busy = computed(() => status.value === 'working' || status.value === 'approval')
const stopped = computed(() => STOPPED_STATES.has(status.value))
// Which agent: Claude, Codex or OpenCode (the leaf's agentId).
const AGENT_NAMES = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' } // i18n-ignore product names
const agentId = computed(() => (AGENT_NAMES[props.node.agentId] ? props.node.agentId : 'claude'))
const agentName = computed(() => AGENT_NAMES[agentId.value])
// A chat saved with the old default title ("Claude (chat)", "Codex (chat)"…):
// the agent's name alone (the pane already shows it is a chat).
const title = computed(() => {
  const own = props.node.title
  if (!own) return agentName.value
  return /^\s*(claude|codex|opencode)\s*\(chat\)\s*$/i.test(own) ? agentName.value : own
})

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
// What the agent may do without asking (chosen in the composer's options).
const permissionMode = computed(() => props.node.chatPermissionMode || (permissions.value === 'yolo' ? 'bypassPermissions' : 'default'))
const yolo = computed(() => permissionMode.value === 'bypassPermissions' || permissions.value === 'yolo')

// The model's name as its list gives it ("opus" -> "Opus 5.5"), else the
// short name read from its id.
function chatModelName(id) {
  const listed = modelsFor(agentId.value).find((x) => x.id === id)
  const short = modelLabel(id)
  return listed && listed.label && /\d/.test(listed.label) && !/\d/.test(short) ? listed.label : short
}
const modelText = computed(() => {
  const m = meta.model || props.node.model
  if (!m) return ''
  const name = chatModelName(m)
  return props.node.effort ? `${name} · ${props.node.effort}` : name
})

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
}
// The leaf follows the session (a new session id, the model it runs).
function noteStatus(event, previousStatus) {
  if (event.type !== 'status') return
  if (event.state !== 'starting') resuming.value = false
  else if (previousStatus === 'asleep') resuming.value = true
  if (event.sessionId && props.node.sessionId !== event.sessionId) props.node.sessionId = event.sessionId
  if (event.model && props.node.model !== event.model) props.node.model = event.model
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
  // A session already running in the main process keeps going; one asleep
  // (stopped while idle) wakes on its next message, not now.
  if (res && res.asleep) session.dispatchLocal({ type: 'status', state: 'asleep' })
  else if (!(res && (res.open || res.live))) {
    // A journal cut off mid-turn (the app quit during it): no process runs
    // that turn, its tools or its request any more (else the chat would say
    // "Working" with Stop, or show a card nobody can answer).
    if (session.turnId.value !== null || session.prompts.value.length) session.dispatchLocal({ type: 'status', state: 'ended' })
    await start()
  }
}
function retryHistory() {
  if (historyLoading.value) return
  load()
}

// Opens (or starts again) the session through the app.
async function start() {
  if (opening.value || typeof ctx.chatOpen !== 'function') return
  opening.value = true
  session.dispatchLocal({ type: 'status', state: 'starting' })
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
async function send(text) {
  const body = String(text || '')
  if (!body.trim()) return { ok: false }
  if (!sendable()) return { ok: false, error: disabledReason.value || sendBlockedReason.value || undefined }
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
  }
  return res || { ok: false }
}

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

const contextMenuActions = computed(() => ({
  onSplitRight: () => ctx.splitLeaf(props.node.id, 'row'),
  onSplitDown: () => ctx.splitLeaf(props.node.id, 'col'),
  isPaneExpanded: isMaximized.value,
  onToggleExpand: () => ctx.toggleMaximize(props.node.id),
  ...(ctx.switchToTerminal && props.node.sessionId && !busy.value ? { onSwitchToTerminal: () => ctx.switchToTerminal(props.node.id) } : {}),
  onClosePane: () => ctx.closeLeaf(props.node.id)
}))

onMounted(load)
onBeforeUnmount(() => {
  alive = false
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
        <span
          class="pane-icon agent"
          :class="[iconState, { yolo }]"
          :aria-label="title"
          data-test="chat-icon"
          :title="yolo ? t('chat.pane.yoloHint', 'Tools run without asking (Settings)') : undefined"
        >
          <BrandIcon :kind="agentId" :size="15" />
          <span class="pane-status-dot"></span>
        </span>
        <span class="pane-title" data-test="chat-title" :title="t('chat.pane.titleHint', '{{title}}\nDrag the header to move the pane', { title })">{{ title }}</span>
        <span class="chat-status" :class="'st-' + status" data-test="chat-status">
          <span class="chat-status-dot" aria-hidden="true"></span>{{ statusLabel }}
        </span>
        <span v-if="modelText" class="chat-model" data-test="chat-model">{{ modelText }}</span>
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
        :interrupt="interrupt"
        :set-option="ctx.chatSetOption ? setOption : null"
        :respond="respond"
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
