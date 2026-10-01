<script setup>
// A terminal agent's conversation as a chat, over its terminal pane, after
// Orca's transcript-view native chat (NativeChatResolvedView.tsx and its
// transcript watch, MIT, Copyright (c) 2026 Lovecast Inc.). The main process
// reads the agent's session file (src/main/chat/transcriptView.js) and sends
// it again while the agent writes; the chat's list shows it.
// Read-only (Grok, OMP): typing stays in the terminal, no composer.
// interactive (Claude Code, OpenClaude, Codex: the pane's chat view): a
// composer whose messages are typed into the terminal (sendMessage, Tessel's
// delivery), Stop (Escape), and the card of what the agent waits for: its
// question (answered with its selector's keys) or its approval (Allow / Deny).
// The agent keeps running in its terminal under this view: nothing is
// restarted to show it or to go back (src/renderer/src/chat/terminalChatBridge.js).
// Props: agent, sessionId ('' = none known yet: waiting for it), agentName,
//   node, isVisible (the file is watched only while the view shows);
//   interactive: paneId, accountId (the main process finds the file in that
//   account's folder), working, waiting ({ approval, input, ask: the
//   question its hook gives, or null }),
//   disabledReason (why nothing can be sent now), sendMessage(text,
//   { onDelivered, onFailed }), writeKeys(bytes) (the cards' keys).
// Emits: close (back to the terminal).
// Exposed: focus() (the composer).
import { computed, onBeforeUnmount, onMounted, provide, ref, shallowRef, watch } from 'vue'
import { MessageCircleQuestion, MessagesSquare, ShieldQuestion, SquareTerminal } from 'lucide-vue-next'
import './orca-tokens.css'
import NativeChatComposer from './NativeChatComposer.vue'
import NativeChatEmptyState from './NativeChatEmptyState.vue'
import NativeChatMessageList from './NativeChatMessageList.vue'
import NativeChatQuestionCard from './NativeChatQuestionCard.vue'
import { Button } from './ui/index.js'
import { createJournalAdapter } from '../../../chat/orca/adapter/journalAdapter.js'
import { reduceStructuredAgentSession, EMPTY_STRUCTURED_AGENT_SESSION } from '../../../chat/orca/shared/structured-agent-session-reducer.js'
import { projectStructuredAgentSessionMessages } from '../../../chat/orca/structured-agent-session-message-projection.js'
import { useNativeChatLinkActions } from '../../../chat/orca/composables/use-native-chat-link-actions.js'
import {
  KEY_ALLOW,
  KEY_ESCAPE,
  answerKeyGroups,
  composerAgent,
  mergePendingSends,
  currentAsk,
  stepKeys,
  tagTesselTurns,
  waitingCard
} from '../../../chat/terminalChatBridge.js'
import { t } from '../../../i18n'

const props = defineProps({
  agent: { type: String, required: true },
  sessionId: { type: String, default: '' },
  agentName: { type: String, default: '' },
  // The pane the view covers (its folder bounds the file links).
  node: { type: Object, default: null },
  isVisible: { type: Boolean, default: true },
  interactive: { type: Boolean, default: false },
  paneId: { type: String, default: '' },
  accountId: { type: String, default: undefined },
  working: { type: Boolean, default: false },
  waiting: { type: Object, default: () => ({}) },
  disabledReason: { type: String, default: '' },
  sendMessage: { type: Function, default: undefined },
  writeKeys: { type: Function, default: undefined }
})
const emit = defineEmits(['close'])

// A session file appears with the agent's first message: looked for again
// meanwhile, while the view shows.
const RETRY_MS = 3000
// A message the agent took but whose turn the file never showed (it may show
// it in another form) stops being shown as sent after this long.
const SENT_SHOWN_MS = 2 * 60 * 1000

const rootRef = ref(null)
const composerRef = ref(null)
const phase = ref('loading') // loading | ready | missing | error
const state = shallowRef(EMPTY_STRUCTURED_AGENT_SESSION)
const truncated = ref(false)
const draft = ref('')
// What the file says (Tessel's own lines marked), and what was sent from
// here and is not in it yet (shown as sent meanwhile).
const fileEvents = shallowRef([])
const pendingSends = shallowRef([])
let viewId = null
let opening = false
let off = null
let retry = null
let alive = true
let nextSend = 0
let answering = null
let answeredTimer = null

function api() {
  const a = typeof window !== 'undefined' && window.shellApi ? window.shellApi.transcriptView : null
  return a && typeof a.open === 'function' ? a : null
}

// The whole conversation again (the main process re-reads the file's tail),
// with the messages sent from here that it does not show yet.
function render() {
  const now = Date.now()
  let merged = mergePendingSends(fileEvents.value, pendingSends.value)
  const keep = pendingSends.value.filter((p) => !merged.done.includes(p.id) && !(p.delivered && now - p.at > SENT_SHOWN_MS))
  if (keep.length !== pendingSends.value.length) {
    pendingSends.value = keep
    merged = mergePendingSends(fileEvents.value, keep)
  }
  const adapter = createJournalAdapter({ now: () => 0 })
  adapter.replay(merged.events)
  state.value = reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, { type: 'event', event: adapter.snapshotEvent() }, 0)
}
function show(events) {
  fileEvents.value = tagTesselTurns(events || [])
  render()
}

function stopRetry() {
  if (retry) clearTimeout(retry)
  retry = null
}
function openArgs() {
  if (!props.interactive) return { agent: props.agent, sessionId: props.sessionId }
  return { agent: props.agent, sessionId: props.sessionId, paneId: props.paneId, ...(props.accountId !== undefined ? { accountId: props.accountId } : {}) }
}
async function openView() {
  stopRetry()
  const a = api()
  if (!a || viewId || opening) {
    if (!a) phase.value = 'error'
    return
  }
  // No conversation known yet (a new Codex finds its id after its first
  // message): waiting for it.
  if (!props.sessionId) {
    phase.value = 'missing'
    return
  }
  const asked = props.sessionId
  let res
  opening = true
  try {
    res = await a.open(openArgs())
  } catch {
    res = { ok: false, code: 'error' }
  } finally {
    opening = false
  }
  if (!alive || !props.isVisible || asked !== props.sessionId) {
    if (res && res.ok) a.close({ viewId: res.viewId })
    // Another conversation meanwhile: that one is opened now.
    if (alive && props.isVisible) openView()
    return
  }
  if (!res || !res.ok) {
    phase.value = res && res.code === 'missing' ? 'missing' : 'error'
    if (phase.value === 'missing') retry = setTimeout(openView, RETRY_MS)
    return
  }
  viewId = res.viewId
  truncated.value = !!res.truncated
  show(res.events)
  phase.value = 'ready'
}
function closeView() {
  stopRetry()
  const a = api()
  if (a && viewId) a.close({ viewId })
  viewId = null
}

onMounted(() => {
  const a = api()
  if (a && typeof a.onEvent === 'function') {
    const unsubscribe = a.onEvent((msg) => {
      if (!msg || msg.viewId !== viewId || !viewId) return
      if (msg.ok) {
        truncated.value = !!msg.truncated
        show(msg.events)
        phase.value = 'ready'
      }
    })
    if (typeof unsubscribe === 'function') off = unsubscribe
  }
  if (props.isVisible) openView()
})
onBeforeUnmount(() => {
  alive = false
  closeView()
  if (answering) answering.cancel()
  clearTimeout(answeredTimer)
  if (off) off()
})
// Watched only while it shows.
watch(
  () => props.isVisible,
  (visible) => {
    if (visible) openView()
    else closeView()
  }
)
// Another conversation in the pane (/clear, /resume, its id found later).
watch(
  () => props.sessionId,
  () => {
    closeView()
    fileEvents.value = []
    phase.value = 'loading'
    render()
    if (props.isVisible) openView()
  }
)

const messages = computed(() => projectStructuredAgentSessionMessages(state.value.items, [], state.value.submissions))
const session = computed(() => ({
  messages: messages.value,
  status: messages.value.length ? 'ready' : 'empty',
  sessionId: props.sessionId,
  agent: props.agent,
  hasMore: false,
  loadingEarlier: false,
  olderHistoryGeneration: 0,
  loadEarlier: async () => 'unchanged',
  readPhase: 'ready'
}))
const fileLinkContext = computed(() => {
  const n = props.node
  const folder = n && (n.startDir || n.cwd || n.projectDir)
  return folder ? { worktreeId: n.id, worktreePath: folder, roots: [folder, n.projectDir].filter(Boolean) } : null
})
const { onLinkClick } = useNativeChatLinkActions(fileLinkContext, rootRef, () => ({ isVisible: props.isVisible }))
provide('nativeChatFileLinkContext', fileLinkContext)

// ---- Interactive (the pane's chat view) ---------------------------------------

function keys(bytes) {
  if (props.writeKeys) props.writeKeys(bytes)
}
// (text) -> { ok }: typed into the terminal by Tessel's delivery (it waits
// while the agent asks for approval or a line is typed in the terminal);
// shown as sent until the agent's file has it.
function send(text) {
  const body = String(text || '')
  if (!body.trim()) return { ok: false }
  if (props.disabledReason) return { ok: false, error: props.disabledReason }
  if (!props.sendMessage) return { ok: false }
  const id = ++nextSend
  pendingSends.value = [...pendingSends.value, { id, text: body, at: Date.now(), delivered: false }]
  render()
  props.sendMessage(body, {
    onDelivered: () => {
      pendingSends.value = pendingSends.value.map((p) => (p.id === id ? { ...p, delivered: true } : p))
      render()
    },
    onFailed: () => {
      pendingSends.value = pendingSends.value.filter((p) => p.id !== id)
      render()
    }
  })
  return { ok: true }
}
// Stop: Escape, the terminal's own key (only while a turn runs).
function stop() {
  if (props.working) keys(KEY_ESCAPE)
}

// Its hook's question first (shown at once), else the file's.
const ask = computed(() => (props.interactive ? currentAsk((props.waiting || {}).ask, fileEvents.value) : null))
const card = computed(() => {
  if (!props.interactive || props.disabledReason) return null
  const w = props.waiting || {}
  return waitingCard({ approval: !!w.approval, input: !!w.input, working: props.working }, ask.value)
})
const questionSending = ref(false)
function onQuestionAnswer(selections) {
  const c = card.value
  if (!c || c.kind !== 'question' || questionSending.value) return
  const groups = answerKeyGroups(props.agent, c.ask.prompt, selections)
  if (!groups.length) return
  questionSending.value = true
  answering = stepKeys(groups, keys)
  answeredTimer = setTimeout(() => {
    questionSending.value = false
    answering = null
  }, answering.settleAfterMs)
}
function onQuestionCancel() {
  if (answering) answering.cancel()
  answering = null
  clearTimeout(answeredTimer)
  questionSending.value = false
  keys(KEY_ESCAPE)
}
function approve() {
  keys(KEY_ALLOW)
}
function deny() {
  keys(KEY_ESCAPE)
}
const fromAgent = computed(() => props.agentName || props.agent)
const questionHead = computed(() => t('chat.orca.question.from', '{{agent}} asks you', { agent: fromAgent.value }))
const approvalHead = computed(() => t('chat.orca.terminalChat.approvalTitle', '{{agent}} asks for your approval', { agent: fromAgent.value }))
const inTerminalHead = computed(() => t('chat.orca.terminalChat.answerInTerminal', '{{agent}} asks you something: answer it in its terminal.', { agent: fromAgent.value }))

defineExpose({
  focus: () => (composerRef.value && composerRef.value.focus ? composerRef.value.focus() : false)
})

const title = computed(() => t('chat.orca.transcriptView.title', 'Conversation of {{agent}}', { agent: props.agentName || props.agent }))
</script>

<template>
  <div ref="rootRef" class="nc-root nc-transcript-view" data-test="transcript-view">
    <div class="nc-transcript-head">
      <MessagesSquare class="nc-transcript-icon" aria-hidden="true" />
      <span class="nc-transcript-title">{{ title }}</span>
      <span v-if="!interactive" class="nc-transcript-note">{{ t('chat.orca.transcriptView.readOnly', 'Read only: type in the terminal') }}</span>
      <span v-if="truncated" class="nc-transcript-note" data-test="transcript-view-truncated">{{ t('chat.orca.transcriptView.truncated', 'Latest part only') }}</span>
      <Button variant="ghost" size="sm" class="nc-transcript-back" data-test="transcript-view-close" @click="emit('close')">
        <SquareTerminal />
        {{ interactive ? t('chat.orca.terminalChat.showTerminal', 'Show terminal') : t('chat.orca.transcriptView.back', 'Back to terminal') }}
      </Button>
    </div>
    <div class="nc-transcript-body">
      <NativeChatEmptyState v-if="phase === 'loading'" kind="loading" />
      <div v-else-if="phase === 'missing' && !messages.length" class="nc-transcript-state" data-test="transcript-view-missing">
        <NativeChatEmptyState kind="empty" :agent="agent" />
        <p>
          {{
            interactive
              ? t('chat.orca.terminalChat.awaiting', 'Waiting for the conversation: it appears with the first message.')
              : t('chat.orca.transcriptView.missing', 'No conversation file yet: it appears with the first message.')
          }}
        </p>
      </div>
      <div v-else-if="phase === 'error'" class="nc-transcript-state" data-test="transcript-view-error">
        <NativeChatEmptyState kind="error" :message="t('chat.orca.transcriptView.error', 'The conversation could not be read.')" />
      </div>
      <NativeChatEmptyState v-else-if="!messages.length" kind="empty" :agent="agent" />
      <NativeChatMessageList
        v-else
        :session="session"
        :journal-items="state.items"
        :is-visible="isVisible"
        :is-working="interactive && working"
        :expand-signal="false"
        :show-live-turn-activity="false"
        :on-link-click="onLinkClick"
        :allow-file-uri-links="true"
      />
    </div>
    <template v-if="interactive">
      <div v-if="card && card.kind === 'question'" class="nc-term-card nc-term-question" data-test="terminal-chat-question">
        <p class="nc-term-card-head">
          <MessageCircleQuestion class="nc-term-card-icon" aria-hidden="true" />
          <span>{{ questionHead }}</span>
        </p>
        <NativeChatQuestionCard
          :key="card.ask.id"
          :prompt="card.ask.prompt"
          :allow-other="true"
          :is-submitting="questionSending"
          @answer="onQuestionAnswer"
          @cancel="onQuestionCancel"
        />
      </div>
      <div v-else-if="card && card.kind === 'approval'" class="nc-term-card nc-term-approval" data-test="terminal-chat-approval">
        <p class="nc-term-card-head">
          <ShieldQuestion class="nc-term-card-icon" aria-hidden="true" />
          <span>{{ approvalHead }}</span>
        </p>
        <p class="nc-term-card-note">{{ t('chat.orca.terminalChat.approvalNote', 'What it wants to do is shown in its terminal.') }}</p>
        <div class="nc-term-card-actions">
          <Button size="sm" data-test="terminal-chat-allow" @click="approve">{{ t('chat.orca.approval.allow', 'Allow') }}</Button>
          <Button size="sm" variant="outline" data-test="terminal-chat-deny" @click="deny">{{ t('chat.orca.approval.deny', 'Deny') }}</Button>
          <Button size="sm" variant="ghost" data-test="terminal-chat-see" @click="emit('close')">
            <SquareTerminal />
            {{ t('chat.orca.terminalChat.showTerminal', 'Show terminal') }}
          </Button>
        </div>
      </div>
      <div v-else-if="card && card.kind === 'terminal'" class="nc-term-card" data-test="terminal-chat-in-terminal">
        <p class="nc-term-card-head">
          <MessageCircleQuestion class="nc-term-card-icon" aria-hidden="true" />
          <span>{{ inTerminalHead }}</span>
        </p>
        <div class="nc-term-card-actions">
          <Button size="sm" variant="outline" @click="emit('close')">
            <SquareTerminal />
            {{ t('chat.orca.terminalChat.showTerminal', 'Show terminal') }}
          </Button>
        </div>
      </div>
      <NativeChatComposer
        ref="composerRef"
        v-model="draft"
        :pane-key="`terminal-chat-${paneId}`"
        :agent="composerAgent(agent)"
        :agent-name="fromAgent"
        :is-working="working"
        :disabled-reason="disabledReason"
        :send="send"
        @interrupt="stop"
      />
    </template>
  </div>
</template>

<style scoped>
.nc-transcript-view {
  display: flex;
  height: 100%;
  min-height: 0;
  width: 100%;
  flex-direction: column;
  font-size: 14px;
}
.nc-transcript-head {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 8px;
  padding: 4px 8px 4px 12px;
  border-bottom: 1px solid var(--nc-border);
  background: color-mix(in srgb, var(--nc-muted) 60%, transparent);
  font-size: 12px;
}
.nc-transcript-icon {
  width: 14px;
  height: 14px;
  color: var(--nc-muted-foreground);
}
.nc-transcript-title {
  font-weight: 500;
  white-space: nowrap;
}
.nc-transcript-note {
  min-width: 0;
  overflow: hidden;
  color: var(--nc-muted-foreground);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nc-transcript-back {
  margin-left: auto;
}
.nc-transcript-body {
  display: flex;
  min-height: 0;
  flex: 1 1 0%;
  flex-direction: column;
}
.nc-transcript-state {
  display: flex;
  flex: 1 1 0%;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--nc-muted-foreground);
  font-size: 12px;
}
/* What the agent waits for: an accent line for its question, a warning line
   for its approval (as the chat pane sets them apart). */
.nc-term-card {
  flex-shrink: 0;
  padding: 6px 16px 8px;
  border-top: 2px solid color-mix(in srgb, var(--nc-muted-foreground) 50%, transparent);
  font-size: 12px;
}
.nc-term-question {
  padding: 0;
  border-top-color: color-mix(in srgb, var(--accent, #6aa0ff) 70%, transparent);
}
.nc-term-question .nc-term-card-head {
  padding: 0 16px;
}
.nc-term-approval {
  border-top-color: color-mix(in srgb, #e0a030 70%, transparent);
}
.nc-term-card-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  max-width: 56rem;
  margin: 6px auto 0;
  font-weight: 500;
}
.nc-term-card-icon {
  width: 14px;
  height: 14px;
  color: var(--accent, #6aa0ff);
}
.nc-term-card-note {
  max-width: 56rem;
  margin: 4px auto 0;
  color: var(--nc-muted-foreground);
}
.nc-term-card-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-width: 56rem;
  margin: 6px auto 0;
}
</style>
