<script setup>
// After Orca's NativeChatStructuredSession.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
//
// One chat session: the transcript (or its loading / empty / error state),
// the banners under it (messages not sent, the agent to start again, the
// session's status and background tasks), the request waiting for an answer
// and the composer, fed by the pane's session (useStructuredAgentSession).
// Tessel keeps the composer under a request card instead of replacing it: a
// request never takes the text being typed (nor its focus) away.
// Props: node (the pane's leaf), controller (the session), agent, agentName,
//   isVisible, isFocusedGroup (the pane is the active one), disabledReason,
//   sendBlockedReason, permissionMode, unsent ([{ key, text, error,
//   sending }]), launchStatus ('signin' | 'untrusted' | 'crashed' | 'ended' |
//   null), launchError, opening, historyLoading, and the pane's actions:
//   send(text), interrupt(), setOption(payload), respond(item, response,
//   opts), contextMenuActions, dictate() (the composer's mic: Windows voice
//   typing), dictationTitle, compact() (frees the context; null: the agent
//   cannot, the low-context banner then only warns).
// Emits: retry-unsent(entry), discard-unsent(entry), copied-unsent({ entry,
//   ok }), start (Start again / Trust this folder…), history-retry.
// Exposed: focusComposer(), focusPendingApproval(), hasPendingApproval(),
//   insertTypedText(text), setNotice(message), composerEl().
import { computed, nextTick, provide, ref, shallowRef } from 'vue'
import { RotateCcw } from 'lucide-vue-next'
import NativeChatApprovalCard from './NativeChatApprovalCard.vue'
import NativeChatComposer from './NativeChatComposer.vue'
import NativeChatContextMenu from './NativeChatContextMenu.vue'
import NativeChatDeliveryRetry from './NativeChatDeliveryRetry.vue'
import NativeChatEmptyState from './NativeChatEmptyState.vue'
import NativeChatLaunchRetry from './NativeChatLaunchRetry.vue'
import NativeChatMessageList from './NativeChatMessageList.vue'
import NativeChatStructuredSessionStatus from './NativeChatStructuredSessionStatus.vue'
import NativeChatQuestionCard from './NativeChatQuestionCard.vue'
import NativeChatContextBanner from './NativeChatContextBanner.vue'
import { MessageCircleQuestion } from 'lucide-vue-next'
import { Button } from './ui/index.js'
import { createApprovalInputFetcher } from './native-chat-approval-card.js'
import { tesselSessionOptionSnapshot, tesselSessionOptionSurface } from './native-chat-session-option-pickers.js'
import { selectNativeChatViewState } from '../../../chat/orca/native-chat-view-state.js'
import { useNativeChatComposerRevealFocus } from '../../../chat/orca/composables/use-native-chat-composer-reveal-focus.js'
import { useNativeChatFontScale } from '../../../chat/orca/composables/use-native-chat-font-scale.js'
import { useNativeChatFileLinkContext } from '../../../chat/orca/composables/use-native-chat-file-link-context.js'
import { useNativeChatLinkActions } from '../../../chat/orca/composables/use-native-chat-link-actions.js'
import { useNativeChatSessionOptionCommand } from '../../../chat/orca/composables/use-native-chat-session-option-command.js'
import { useStructuredAgentSessionContextUsage } from '../../../chat/orca/composables/use-structured-agent-session-context-usage.js'
import { modelsFor } from '../../../agentModels'
import { t } from '../../../i18n'

const props = defineProps({
  node: { type: Object, required: true },
  controller: { type: Object, required: true },
  agent: { type: String, default: 'claude' },
  agentName: { type: String, default: 'Claude' }, // i18n-ignore product name
  isVisible: { type: Boolean, default: true },
  isFocusedGroup: { type: Boolean, default: false },
  disabledReason: { type: String, default: '' },
  sendBlockedReason: { type: String, default: '' },
  // Tessel: image attachments in the composer (send(text, { images })).
  allowImages: { type: Boolean, default: false },
  permissionMode: { type: String, default: 'default' },
  unsent: { type: Array, default: () => [] },
  launchStatus: { type: String, default: null },
  launchError: { type: String, default: '' },
  opening: { type: Boolean, default: false },
  historyLoading: { type: Boolean, default: false },
  send: { type: Function, required: true },
  interrupt: { type: Function, required: true },
  setOption: { type: Function, default: null },
  respond: { type: Function, required: true },
  contextMenuActions: { type: Object, default: () => ({}) },
  dictate: { type: Function, default: undefined },
  dictationTitle: { type: String, default: undefined },
  compact: { type: Function, default: null }
})
const emit = defineEmits(['retry-unsent', 'discard-unsent', 'copied-unsent', 'start', 'history-retry'])

const rootRef = ref(null)
const composerRef = shallowRef(null)
const approvalRef = shallowRef(null)
const contextMenuRef = shallowRef(null)
const draft = ref('')
const composerError = ref(null)
const optionPickerRequest = ref(null)

const c = props.controller
const paneKey = computed(() => props.node.id)
const isWorking = computed(() => c.isWorking.value)
// Stop, not status: only a running turn can be interrupted.
const turnRunning = computed(() => c.turnId.value !== null || c.meta.status === 'working')

// The reference's live session shape, which the list and the view state read.
const session = computed(() => {
  const loaded = c.meta.loaded
  const status = c.status.value
  return {
    messages: c.messages.value,
    status: status === 'error' ? 'error' : !loaded ? 'loading' : isWorking.value ? 'working' : c.messages.value.length === 0 ? 'empty' : 'ready',
    sessionId: c.meta.sessionId || null,
    agent: props.agent,
    ...(c.error.value ? { error: c.error.value } : {}),
    hasMore: c.hasOlder.value,
    loadingEarlier: c.loadingOlder.value,
    olderHistoryGeneration: c.olderHistoryGeneration.value,
    loadEarlier: c.loadOlder,
    readPhase: status === 'error' ? 'error' : !loaded ? 'loading' : 'ready'
  }
})
const viewState = computed(() => selectNativeChatViewState(session.value))
const fontScale = useNativeChatFontScale(() => props.isFocusedGroup && viewState.value.kind === 'ready', () => ({ target: rootRef.value }))
const fileLinkContext = useNativeChatFileLinkContext(() => props.node)
// The chat's folders, for inline code that names a file (ChatMarkdown).
provide('nativeChatFileLinkContext', fileLinkContext)
const { onLinkClick } = useNativeChatLinkActions(fileLinkContext, rootRef, () => ({ isVisible: props.isVisible }))

// The request waiting for an answer (the oldest); Tessel's engine asks
// approvals only (its questions have no answer path yet).
const prompt = computed(() => c.prompts.value[0] ?? null)
const approvalItem = computed(() => (prompt.value && prompt.value.body.kind === 'approval' ? prompt.value : null))
// An agent's question (Claude's AskUserQuestion, Codex's user input): its
// card waits above the composer until answered or cancelled.
const questionItem = computed(() => (prompt.value && prompt.value.body.kind === 'question' ? prompt.value : null))
const questionList = computed(() => (questionItem.value ? questionItem.value.body.questions || [] : []))
const questionPrompt = computed(() => ({
  questions: questionList.value.map((q) => ({
    question: q.question,
    ...(q.header ? { header: q.header } : {}),
    multiSelect: q.multiSelect === true,
    options: (q.options || []).map((o) => ({ label: o.label, ...(o.description ? { description: o.description } : {}) }))
  }))
}))
const questionAllowOther = computed(() => questionList.value.map((q) => !!q.freeTextQuestionId))
const questionSending = ref(false)
const questionFrom = computed(() => t('chat.orca.question.from', '{{agent}} asks you', { agent: props.agentName }))
// The main process accepts at most 8 KB of typed answer per question.
const MAX_OTHER_BYTES = 8 * 1024
async function onQuestionAnswer(selections) {
  const item = questionItem.value
  if (!item || questionSending.value) return
  const answers = questionList.value.map((q, i) => {
    const pick = selections[i] || {}
    const other = typeof pick.other === 'string' ? pick.other.trim() : ''
    const optionIds = (pick.indices || []).map((n) => q.options[n] && q.options[n].id).filter(Boolean)
    return { questionId: q.id, optionIds, ...(other && q.freeTextQuestionId ? { other } : {}) }
  })
  if (!answers.every((a) => a.optionIds.length > 0 || a.other)) {
    composerError.value = t('chat.orca.question.incomplete', 'Answer every question before sending.')
    return
  }
  if (answers.some((a) => a.other && new TextEncoder().encode(a.other).length > MAX_OTHER_BYTES)) {
    composerError.value = t('chat.orca.question.tooLong', 'An answer is too long (8 KB at most).')
    return
  }
  composerError.value = null
  questionSending.value = true
  try {
    await props.respond(item, { kind: 'answers', answers })
  } finally {
    questionSending.value = false
  }
}
async function onQuestionCancel() {
  const item = questionItem.value
  if (!item || questionSending.value) return
  questionSending.value = true
  try {
    await props.respond(item, { kind: 'cancel' })
  } finally {
    questionSending.value = false
  }
}
const fetchApprovalInput = computed(() => createApprovalInputFetcher(props.node.id))
// A new request takes the focus only in the active pane, and never from text
// being typed.
const approvalShouldFocus = computed(() => props.isVisible && props.isFocusedGroup && !draft.value.trim())

useNativeChatComposerRevealFocus({
  rootRef,
  composerRef,
  isVisible: () => props.isVisible,
  isFocusedGroup: () => props.isFocusedGroup,
  composerReady: () => !props.disabledReason
})

// --- Session options (the composer's pickers) -----------------------------------------------
const optionCommand = useNativeChatSessionOptionCommand({
  scopeKey: paneKey,
  node: () => props.node,
  agent: () => props.agent,
  isWorking: turnRunning,
  // The effort chosen in the pane, else the one its header shows (the agent's
  // own settings or conversation, ChatPane's shownEffort).
  values: () => {
    const effort = props.node.effort || props.node.shownEffort
    return { model: c.meta.model || props.node.model || undefined, ...(effort ? { effort } : {}) }
  },
  permissionMode: () => props.permissionMode,
  chatLaunchYolo: () => !!props.node.chatLaunchYolo,
  maxPermissions: () => props.node.maxPermissions,
  setOption: (payload) => (props.setOption ? props.setOption(payload) : { ok: false }),
  onError: (message) => {
    composerError.value = message
  }
})
const optionSnapshot = computed(() =>
  tesselSessionOptionSnapshot({
    agent: props.agent,
    models: modelsFor(props.agent),
    values: optionCommand.confirmedValues.value,
    modeBlocked: optionCommand.modeBlocked
  })
)
const optionSurface = computed(() => (props.setOption ? tesselSessionOptionSurface(optionCommand.dispatch) : null))
function onOptionCommand(name) {
  const current = optionPickerRequest.value
  optionPickerRequest.value = { id: name, sequence: (current ? current.sequence : 0) + 1 }
  return { ok: true }
}
const contextUsage = useStructuredAgentSessionContextUsage(c.journalItems, null)
// The composer's skills menu: the engine's discovery (none without it).
const skillsOptions = computed(() => (c.discoverSkills ? { discover: (q) => c.discoverSkills(q) } : undefined))

// --- The pane's actions ---------------------------------------------------------------------
function onComposerError(message) {
  composerError.value = message
}
function onRespond(item, response, opts) {
  return props.respond(item, response, opts)
}
const menuActions = computed(() => ({
  ...props.contextMenuActions,
  onPaste: () => composerRef.value && composerRef.value.pasteFromClipboard()
}))
function onContextMenu(event) {
  if (contextMenuRef.value) contextMenuRef.value.onContextMenu(event)
}
function onSelectionCapture() {
  if (contextMenuRef.value) contextMenuRef.value.rememberSelection()
}
function onPointerDownCapture(event) {
  if (event.button === 2) onSelectionCapture()
}

function focusComposer() {
  return composerRef.value ? composerRef.value.focus() : false
}
// Alt+A: the request waiting for an answer.
async function focusPendingApproval() {
  // A question waiting: its first choice.
  if (questionItem.value) {
    await nextTick()
    const first = rootRef.value && rootRef.value.querySelector('[data-test="chat-question"] button:not(:disabled)')
    if (first) first.focus()
    return !!first
  }
  if (!approvalItem.value) return false
  await nextTick()
  return approvalRef.value ? approvalRef.value.focus() !== false : false
}

// Header actions use the same composer operations as the chat menu.
function openModelPicker() { focusComposer(); onOptionCommand('model') }
function pasteFromClipboard() { return composerRef.value?.pasteFromClipboard() }
defineExpose({
  openModelPicker,
  pasteFromClipboard,
  focusComposer,
  focusPendingApproval,
  hasPendingApproval: () => !!approvalItem.value,
  insertTypedText: (text) => (composerRef.value ? composerRef.value.insertTypedText(text) : false),
  setNotice: (message) => {
    composerError.value = message
  },
  composerEl: () => (composerRef.value ? composerRef.value.el() : null)
})
</script>

<template>
  <div
    ref="rootRef"
    class="nc-session"
    data-native-chat-root="true"
    :data-native-chat-working="isWorking ? 'true' : 'false'"
    tabindex="-1"
    @pointerdown.capture="onPointerDownCapture"
    @mouseup.capture="onSelectionCapture"
    @keyup.capture="onSelectionCapture"
    @contextmenu.capture="onContextMenu"
  >
    <div class="nc-session-body">
      <NativeChatEmptyState v-if="viewState.kind === 'loading'" kind="loading" />
      <div v-else-if="viewState.kind === 'error'" class="nc-session-error" data-test="chat-history-error">
        <NativeChatEmptyState kind="error" :message="viewState.message" />
        <Button variant="outline" size="sm" data-test="chat-history-retry" :disabled="historyLoading" @click="emit('history-retry')">
          <RotateCcw />
          {{ t('chat.history.retry', 'Retry') }}
        </Button>
      </div>
      <NativeChatEmptyState v-else-if="viewState.kind === 'empty'" kind="empty" :agent="agent" />
      <NativeChatMessageList
        v-else
        :session="session"
        :journal-items="c.journalItems.value"
        :rail-outline="c.railOutline.value"
        :is-visible="isVisible"
        :is-working="isWorking"
        :expand-signal="false"
        :font-scale="fontScale.scale.value"
        :working-started-at="c.workingStartedAt.value"
        :settled-turns="c.settledTurns.value"
        :show-turn-status="true"
        :show-live-turn-activity="prompt === null"
        :turn-activity="c.turnActivity.value"
        :on-link-click="onLinkClick"
        :allow-file-uri-links="true"
        :failed-delivery-message-ids="c.failedDeliveryMessageIds ? c.failedDeliveryMessageIds.value : undefined"
        :queued-message-ids="c.queuedMessageIds ? c.queuedMessageIds.value : undefined"
      />
    </div>
    <NativeChatDeliveryRetry
      :unsent="unsent"
      :retry-disabled-reason="disabledReason || sendBlockedReason"
      @retry-unsent="(entry) => emit('retry-unsent', entry)"
      @discard="(entry) => emit('discard-unsent', entry)"
      @copied="(payload) => emit('copied-unsent', payload)"
    />
    <NativeChatLaunchRetry :status="launchStatus" :agent-id="agent" :error="launchError" :opening="opening" @retry="emit('start')" />
    <NativeChatStructuredSessionStatus
      :session-id="c.meta.sessionId || ''"
      :agent-label="agentName"
      :composer-error="composerError"
      :is-visible="isVisible"
      :background-tasks="c.backgroundTasks.value"
      :stop-background-task="c.stopBackgroundTask"
    />
    <NativeChatApprovalCard
      v-if="approvalItem"
      :key="approvalItem.itemId"
      ref="approvalRef"
      :item="approvalItem"
      :agent-id="agent"
      :cwd="node.cwd || ''"
      :fetch-input="fetchApprovalInput"
      :should-focus="approvalShouldFocus"
      :on-respond="onRespond"
      :allow-file-uri-links="true"
      @link-click="onLinkClick"
    />
    <div v-if="questionItem" class="nc-session-question" data-test="chat-question">
      <!-- Set apart from an approval: the agent asks, it does not ask permission. -->
      <p class="nc-session-question-head">
        <MessageCircleQuestion class="nc-session-question-icon" aria-hidden="true" />
        <span>{{ questionFrom }}</span>
        <span class="nc-session-question-note">{{ t('chat.orca.question.kept', 'Your answer is kept in this chat’s history.') }}</span>
      </p>
      <NativeChatQuestionCard
        :key="questionItem.itemId"
        :prompt="questionPrompt"
        :allow-other="questionAllowOther"
        :is-submitting="questionSending"
        @answer="onQuestionAnswer"
        @cancel="onQuestionCancel"
      />
    </div>
    <NativeChatContextBanner
      :usage="contextUsage"
      :compact="compact"
      :busy="turnRunning || !!prompt"
      :disabled="!!disabledReason"
      :agent-name="agentName"
    />
    <NativeChatComposer
      ref="composerRef"
      v-model="draft"
      :pane-key="paneKey"
      :agent="agent"
      :agent-name="agentName"
      :is-working="turnRunning"
      :disabled-reason="disabledReason"
      :send-blocked-reason="sendBlockedReason"
      :send="send"
      :allow-images="allowImages"
      :set-option="setOption ? (payload) => optionCommand.dispatch({ optionId: Object.keys(payload)[0], value: Object.values(payload)[0] }) : undefined"
      :on-option-command="onOptionCommand"
      :chat-launch-yolo="!!node.chatLaunchYolo"
      :max-permissions="node.maxPermissions"
      :context-usage="contextUsage"
      :commands="c.sessionCommands ? c.sessionCommands.value : undefined"
      :skills-options="skillsOptions"
      :session-options-surface="optionSurface"
      :session-options-snapshot="optionSnapshot"
      :session-options-picker-request="optionPickerRequest"
      :dictate="dictate"
      :dictation-title="dictationTitle"
      @interrupt="interrupt()"
      @error="onComposerError"
    />
    <NativeChatContextMenu ref="contextMenuRef" :root-el="rootRef" :enabled="isVisible" :actions="menuActions" />
  </div>
</template>

<style scoped>
/* The question's own line: an accent border, not an approval's warning. */
.nc-session-question {
  flex-shrink: 0;
  border-top: 2px solid color-mix(in srgb, var(--accent, #6aa0ff) 70%, transparent);
}
.nc-session-question-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  max-width: 56rem;
  margin: 6px auto 0;
  padding: 0 16px;
  font-size: 12px;
  font-weight: 500;
}
.nc-session-question-icon {
  width: 14px;
  height: 14px;
  color: var(--accent, #6aa0ff);
}
.nc-session-question-note {
  font-weight: 400;
  color: var(--nc-muted-foreground);
}
/* flex h-full min-h-0 w-full flex-col bg-background focus:outline-none */
.nc-session {
  display: flex;
  height: 100%;
  min-height: 0;
  width: 100%;
  flex-direction: column;
  background: var(--nc-background);
}
.nc-session:focus {
  outline: none;
}
/* flex min-h-0 flex-1 flex-col */
.nc-session-body {
  display: flex;
  min-height: 0;
  flex: 1 1 0%;
  flex-direction: column;
}
/* Tessel's history failure: the reference's error state, then Retry. */
.nc-session-error {
  display: flex;
  flex: 1 1 0%;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
}
</style>
