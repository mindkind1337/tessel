<script setup>
// A Claude agent as a chat (no terminal): the main process drives Claude
// Code over stream-json (src/main/chat) and sends the conversation as
// events (chat:event); chatModel.js turns them into rows. The pane redraws
// its history when it mounts, opens the session if it is not running
// (ctx.chatOpen asks the user to trust the folder when needed), and shows
// the status, the model and the rate limits in its header.
// Look after Orca's native chat (src/renderer/src/components/native-chat/:
// NativeChatMessageList.tsx, NativeChatComposer.tsx; MIT, Copyright (c) 2026
// Lovecast Inc.), written for Vue.
import { computed, inject, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import { ArrowDown, FolderLock, LogIn, RotateCcw, TriangleAlert } from 'lucide-vue-next'
import BrandIcon from '../BrandIcon.vue'
import SessionOptionPicker from '../SessionOptionPicker.vue'
import ChatMessage from './ChatMessage.vue'
import ChatToolRow from './ChatToolRow.vue'
import ChatApprovalCard from './ChatApprovalCard.vue'
import ChatComposer from './ChatComposer.vue'
import { chatReducer, initialChatState, isBusy, rateLimitParts, STOPPED_STATES } from '../../chat/chatModel'
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
const modelMenu = reactive({ visible: false, pending: false })
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

// --- Events ----------------------------------------------------------------------------------
function api() {
  const a = typeof window !== 'undefined' && window.shellApi ? window.shellApi.chat : null
  return a && typeof a === 'object' ? a : null
}

function dispatch(event) {
  if (!event || typeof event !== 'object') return
  state.value = chatReducer(state.value, event, { cwd: props.node.cwd || '' })
  if (event.type === 'status') {
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

async function loadHistory() {
  const a = api()
  let res = null
  if (a && typeof a.history === 'function') {
    try {
      res = await a.history({ paneId: props.node.id })
    } catch {
      res = null
    }
  }
  if (!alive) return null
  if (res && res.ok !== false && Array.isArray(res.events)) {
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
  }
  loaded = true
  for (const msg of buffered.splice(0)) applyMessage(msg)
  return res
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

async function send(text) {
  const a = api()
  const body = String(text || '')
  if (!a || typeof a.send !== 'function' || !body.trim()) return
  draft.value = ''
  stick.value = true
  let res
  try {
    res = await a.send({ paneId: props.node.id, text: body })
  } catch (err) {
    res = { ok: false, error: (err && err.message) || String(err) }
  }
  if (res && res.ok !== false) return
  // Not sent: the text comes back unless something else was typed.
  if (!draft.value) draft.value = body
  toast(t('chat.error.send', 'Message not sent: {{error}}', { error: (res && res.error) || t('chat.error.unknown', 'unknown error') }))
}

async function interrupt() {
  const a = api()
  if (!a || typeof a.interrupt !== 'function') return
  try {
    await a.interrupt({ paneId: props.node.id })
  } catch {
    // The status stays; the user can try again.
  }
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
      res = await a.setOption(payload)
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
  modelMenu.visible = false
}
function onDocMouseDown(e) {
  if (!modelMenu.visible) return
  const el = rootEl.value && rootEl.value.querySelector('.chat-model-menu')
  if (el && el.contains(e.target)) return
  if (e.target.closest && e.target.closest('.pane-model-chip')) return
  modelMenu.visible = false
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
  rows,
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

let unsubscribe = null
onMounted(async () => {
  const a = api()
  if (a && typeof a.onEvent === 'function') {
    const off = a.onEvent(onChatEvent)
    if (typeof off === 'function') unsubscribe = off
  }
  document.addEventListener('mousedown', onDocMouseDown, true)
  const res = await loadHistory()
  if (!alive) return
  nextTick(scrollToBottom)
  // A session already running in the main process keeps going.
  if (!(res && (res.open || res.live))) await start()
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

defineExpose({ start, send, interrupt })
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
          class="pane-model-chip"
          type="button"
          data-test="chat-model"
          :aria-label="t('pane.sessionOptions.chipLabel', 'Model: {{model}}. Choose the model', { model: modelText })"
          @mousedown.stop
          @click.stop="modelMenu.visible = !modelMenu.visible"
        >
          {{ modelText }}
        </button>
        <span
          v-if="permissions === 'yolo'"
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

    <div v-if="modelMenu.visible" class="chat-model-menu" data-test="chat-model-menu" @mousedown.stop>
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
          <div v-if="!rows.length" class="chat-empty" data-test="chat-empty">
            <BrandIcon :kind="agentId" :size="28" />
            <span v-if="status === 'starting'">{{ startingText }}</span>
            <span v-else-if="!stopped">{{ t('chat.empty.idle', 'Send a message to start.') }}</span>
          </div>
          <template v-for="row in shownRows" :key="row.key">
            <ChatToolRow v-if="row.kind === 'tool'" :row="row" />
            <ChatApprovalCard v-else-if="row.kind === 'approval'" :row="row" :auto-focus="approvalFocus" :answer="answer" :fetch-input="fetchApprovalInput" />
            <ChatMessage v-else :row="row" />
          </template>
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
        @send="send"
        @interrupt="interrupt"
      />
    </div>
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
</style>
