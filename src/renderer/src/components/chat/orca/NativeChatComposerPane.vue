<script setup>
// After Orca's NativeChatComposer.tsx, NativeChatComposerPane (MIT, Copyright (c) 2026 Lovecast Inc.)
// The composer of one pane, wired from the composer composables. Enter sends
// (Shift+Enter: new line; an IME composition never sends); Escape first closes
// an open picker/hint, then interrupts only while the agent works; "/" opens
// the command and skill picker when the session offers any; paste is literal
// text, and with allowImages a pasted, dropped or picked (+) image becomes a
// chip sent with the message by id. NativeChatComposer keys this on paneKey
// (a pane switch remounts it).
// Props, emits: native-chat-composer-props.js. Exposed: see NativeChatComposer.
import { computed, ref, shallowRef, watch } from 'vue'
import { t } from '../../../i18n'
import { applyMentionSuggestion, EMPTY_HISTORY } from '../../../chat/orca/native-chat-composer-state.js'
import { useNativeChatDraft } from '../../../chat/orca/composables/use-native-chat-draft.js'
import { useNativeChatCanSend } from '../../../chat/orca/composables/use-native-chat-can-send.js'
import { useNativeChatComposerCatalog } from '../../../chat/orca/composables/use-native-chat-composer-catalog.js'
import { useNativeChatPickerState } from '../../../chat/orca/composables/use-native-chat-picker-state.js'
import { useNativeChatComposerAttachments } from '../../../chat/orca/composables/use-native-chat-composer-attachments.js'
import { useNativeChatTypedInsertion } from '../../../chat/orca/composables/use-native-chat-typed-insertion.js'
import { useNativeChatComposerPaste } from '../../../chat/orca/composables/use-native-chat-composer-paste.js'
import { useNativeChatStructuredComposerSend } from '../../../chat/orca/composables/use-native-chat-structured-composer-send.js'
import { useNativeChatComposerSubmit } from '../../../chat/orca/composables/use-native-chat-composer-submit.js'
import { useNativeChatComposerInterrupt } from '../../../chat/orca/composables/use-native-chat-composer-interrupt.js'
import { useNativeChatPickerCommandDispatch } from '../../../chat/orca/composables/use-native-chat-picker-command-dispatch.js'
import { useNativeChatComposerKeyDown } from '../../../chat/orca/composables/use-native-chat-composer-keydown.js'
import { useNativeChatContextUsageSummary } from '../../../chat/orca/composables/use-native-chat-context-usage-summary.js'
import { useNativeChatWorkspaceFileDrop } from '../../../chat/orca/composables/use-native-chat-workspace-file-drop.js'
import { useImeEnterGestureOwnership } from './ime-composition-keyboard-event.js'
import { nativeChatComposerEmits, nativeChatComposerProps } from './native-chat-composer-props.js'
import NativeChatComposerField from './NativeChatComposerField.vue'
import { CHAT_IMAGE_ACCEPT } from '../../../chat/orca/native-chat-images.js'

const props = defineProps(nativeChatComposerProps)
const emit = defineEmits(nativeChatComposerEmits)

// The draft is kept per pane (a pane switch restores its own text).
const { draft, setDraft } = useNativeChatDraft(() => props.paneKey)
// v-model: the cached draft of this pane wins; else the parent's text is adopted.
if (props.modelValue !== undefined && props.modelValue !== draft.value) {
  if (draft.value === '') setDraft(props.modelValue)
  else emit('update:modelValue', draft.value)
}
watch(
  () => props.modelValue,
  (value) => {
    if (value !== undefined && value !== draft.value) setDraft(value)
  }
)
watch(
  draft,
  (value) => {
    if (props.modelValue !== undefined && value !== props.modelValue) emit('update:modelValue', value)
  },
  { flush: 'sync' }
)

const updater = (target) => (next) => {
  target.value = typeof next === 'function' ? next(target.value) : next
}
const caret = ref(draft.value.length)
const setCaret = updater(caret)
const history = shallowRef(EMPTY_HISTORY)
const setHistory = updater(history)
const activeSuggestion = ref(0)
const setActiveSuggestion = updater(activeSuggestion)
const notice = ref(null)
const setNotice = (value) => {
  notice.value = value || null
}
const imeEnterGesture = useImeEnterGestureOwnership()
const textareaRef = shallowRef(null)
// Templates unwrap top-level refs; the field needs the ref itself (the editor fills it).
const refs = { textarea: textareaRef }

const disabled = computed(() => !!props.disabledReason)

// Send refusals and option errors: shown under the pickers, and told to the pane.
function reportError(message) {
  setNotice(message)
  emit('error', message ?? null)
}

// The reference's structuredTransport, from Tessel's props.
const structuredTransport = computed(() => ({
  send: props.send,
  setOption: props.setOption,
  sessionCommands: props.commands,
  conversationCommands: props.conversationCommands,
  contextUsage: props.contextUsage,
  onError: reportError,
  sessionId: props.paneKey
}))

const { agentCommands, sessionSkillNames } = useNativeChatComposerCatalog(() => props.agent, structuredTransport)
const picker = useNativeChatPickerState(() => ({
  agent: props.agent,
  terminalTabId: props.paneKey,
  draftScopeKey: props.paneKey,
  draft: draft.value,
  caret: caret.value,
  agentCommands: agentCommands.value,
  sessionSkillNames: sessionSkillNames.value,
  skillsOptions: props.skillsOptions,
  textareaRef: textareaRef.value,
  setDraft,
  setCaret,
  setActiveSuggestion
}))

// Tessel: no picker while the session offers nothing for "/" (the default today).
const pickerEnabled = computed(
  () =>
    agentCommands.value.length > 0 ||
    (sessionSkillNames.value?.length ?? 0) > 0 ||
    typeof props.skillsOptions?.discover === 'function'
)
// Tessel: the "@file" hint can be closed with Escape (then Escape is not an interrupt).
const dismissedMention = ref(null)
const mentionKey = computed(() => {
  const value = picker.autocomplete.value
  return value.mode === 'mention' ? caret.value - value.query.length - 1 : null
})
watch(mentionKey, (key) => {
  if (key === null) dismissedMention.value = null
})
const autocomplete = computed(() => {
  const value = picker.autocomplete.value
  if (value.mode === 'slash' && !pickerEnabled.value) return { mode: 'none' }
  if (value.mode === 'mention' && dismissedMention.value === mentionKey.value) return { mode: 'none' }
  return value
})
const mentionOpen = computed(() => autocomplete.value.mode === 'mention')
function dismissMention() {
  dismissedMention.value = mentionKey.value
}

const composerOptions = () => ({
  scopeKey: props.paneKey,
  agent: props.agent,
  draft: draft.value,
  caret: caret.value,
  disabled: disabled.value,
  disabledReason: props.disabledReason,
  sendBlockedReason: props.sendBlockedReason,
  isWorking: props.isWorking,
  textareaRef: textareaRef.value,
  setDraft,
  setCaret,
  setHistory,
  setActiveSuggestion,
  setNotice
})

const { insertTypedText, focus } = useNativeChatTypedInsertion(composerOptions)

const attachments = useNativeChatComposerAttachments(() => ({
  ...composerOptions(),
  attachmentScopeKey: props.paneKey,
  allowImages: props.allowImages,
  isComposing: imeEnterGesture.isComposing,
  insertTypedText
}))
const { imageAttachments, removeImageAttachment, clearImageAttachments, attachResolvedPaths, attachImages } = attachments

// The attach button (+): the system's file picker, images only. A picked
// file is checked and copied by the main process (as a dropped one).
function pickImages() {
  if (disabled.value || !props.allowImages || typeof document === 'undefined') return
  const input = document.createElement('input')
  input.type = 'file'
  input.multiple = true
  input.accept = CHAT_IMAGE_ACCEPT
  input.addEventListener('change', () => {
    const files = Array.from(input.files || [])
    if (!files.length) return
    const toPath = props.pathForFile || globalThis.window?.shellApi?.pathForFile
    attachImages(
      files.map((file) => {
        let path = ''
        try {
          path = toPath?.(file) || ''
        } catch {
          path = ''
        }
        return { file, name: file.name, ...(path ? { path } : {}) }
      })
    )
    focus()
  })
  input.click()
}

const drop = useNativeChatWorkspaceFileDrop(() => ({
  paneKey: props.paneKey,
  disabled: disabled.value,
  attachResolvedPaths,
  setNotice,
  pathForFile: props.pathForFile
}))

const { handlePaste, pasteFromClipboard } = useNativeChatComposerPaste(() => ({
  ...composerOptions(),
  allowImages: props.allowImages,
  attachImages,
  insertTypedText,
  readClipboardText: props.readClipboardText
}))

const sendStructured = useNativeChatStructuredComposerSend(() => ({
  ...composerOptions(),
  imageAttachments: imageAttachments.value,
  structuredTransport: structuredTransport.value,
  clearSkillOrigin: picker.clearSkillOrigin,
  clearImageAttachments,
  onError: reportError,
  onAccepted,
  setOption: props.setOption,
  onOptionCommand: props.onOptionCommand,
  chatLaunchYolo: props.chatLaunchYolo,
  maxPermissions: props.maxPermissions
}))

// What stays in the composer once a send is confirmed while the user kept
// typing: the sent text goes, what was typed around it stays (diffed from both
// ends, like the field's IME replay).
function keptAfterSend(sent, current) {
  const limit = Math.min(sent.length, current.length)
  let prefix = 0
  while (prefix < limit && sent[prefix] === current[prefix]) prefix += 1
  let suffix = 0
  while (suffix < limit - prefix && sent[sent.length - 1 - suffix] === current[current.length - 1 - suffix]) {
    suffix += 1
  }
  return current.slice(prefix, current.length - suffix)
}
// The sender clears only an unchanged draft (a changed one would otherwise be
// lost). Like the reference, a confirmed message still leaves the composer:
// mid-composition the clear is dropped and the field replays it at settlement
// (keeping only the composed text); otherwise the sent text is removed and
// what was typed since is kept. A host command ("/model x") keeps an edited draft.
function onAccepted(text) {
  emit('sent', text)
  const current = draft.value
  if (current === text || !current || text.trimStart().startsWith('/')) return
  if (imeEnterGesture.isComposing()) setDraft('')
  else setDraft(keptAfterSend(text, current))
  setCaret(draft.value.length)
}

const { send, goalMode } = useNativeChatComposerSubmit(() => ({
  ...composerOptions(),
  imageAttachments: imageAttachments.value,
  structuredTransport: structuredTransport.value,
  sendStructured,
  isComposing: imeEnterGesture.isComposing
}))

function onStop() {
  emit('interrupt')
  return true
}
const interrupt = useNativeChatComposerInterrupt(() => ({
  isWorking: props.isWorking,
  menuOpen: mentionOpen.value,
  autocomplete: autocomplete.value,
  onStop
}))

const dispatchPickerCommand = useNativeChatPickerCommandDispatch(() => ({
  ...composerOptions(),
  sendStructured,
  onOptionCommand: props.onOptionCommand,
  onSlashCommand: (command) => emit('slashCommand', command)
}))

const completePickerItem = goalMode.interceptPick(picker.completeItem)
const dispatchPicked = goalMode.interceptPick(dispatchPickerCommand)
const handleKeyDown = useNativeChatComposerKeyDown(() => ({
  ...composerOptions(),
  autocomplete: autocomplete.value,
  activeSuggestion: activeSuggestion.value,
  history: history.value,
  isComposing: imeEnterGesture.isComposing,
  completePickerItem,
  dispatchPickerCommand: dispatchPicked,
  dismissPicker: picker.dismiss,
  interrupt,
  send,
  menuOpen: mentionOpen.value,
  closeMenu: dismissMention
}))

const canSend = useNativeChatCanSend(() => ({
  draft: draft.value,
  disabled: disabled.value,
  disabledReason: props.disabledReason,
  sendBlockedReason: props.sendBlockedReason,
  isSending: sendStructured.isSending.value,
  hasImages: imageAttachments.value.length > 0
}))
// A pasted image has no agent-readable path until its save lands; sending
// mid-save would ship the message without the image the chip promises.
const hasPendingAttachment = computed(() => imageAttachments.value.some((attachment) => attachment.pending))
// While a turn runs the button is Stop (Enter still sends: the message waits for the turn).
const sendButtonDisabled = computed(() => (props.isWorking ? false : !canSend.value || hasPendingAttachment.value))

const contextUsageSummary = useNativeChatContextUsageSummary(structuredTransport)

const placeholder = computed(() => {
  if (props.disabledReason) return props.disabledReason
  if (props.sendBlockedReason) return props.sendBlockedReason
  if (props.isWorking) {
    return t('chat.composer.placeholderBusy', 'Message {{agent}} (sent when the turn ends)…', { agent: props.agentName })
  }
  return t('chat.composer.placeholder', 'Message {{agent}}…', { agent: props.agentName })
})

function syncCaret(element) {
  setCaret(element.selectionStart ?? element.value.length)
}

function handleDraftChange(value, element) {
  // The picker compares with the draft before this edit (React read it from its closure).
  picker.handleDraftOrCaretChange(value, element.selectionStart ?? value.length)
  setDraft(value)
  setHistory((previous) => ({ entries: previous.entries, index: null }))
  syncCaret(element)
  setActiveSuggestion(0)
}

function onTextareaSelect(element) {
  syncCaret(element)
  picker.handleDraftOrCaretChange(element.value, element.selectionStart ?? element.value.length)
  setActiveSuggestion(0)
}

function onImeSettled(element) {
  if (element.value !== draft.value) handleDraftChange(element.value, element)
  attachments.flushPendingAttachments()
}

function onAcceptMention() {
  const value = autocomplete.value
  if (value.mode !== 'mention') return
  const result = applyMentionSuggestion(draft.value, caret.value, value.query)
  setDraft(result.draft)
  setCaret(result.caret)
  const textarea = textareaRef.value
  textarea?.focus()
  requestAnimationFrame(() => textarea?.setSelectionRange(result.caret, result.caret))
}

// Tessel: the Stop button always interrupts a running turn (the interrupt hook
// also ignores it while a picker is open, which only suits the Escape key).
function onStopButton() {
  if (props.isWorking) onStop()
}

defineExpose({
  focus,
  insertTypedText,
  handlePasteEvent: handlePaste,
  pasteFromClipboard,
  // Tessel's additions.
  draft,
  setDraft,
  send,
  attachResolvedPaths,
  attachImages,
  pickImages,
  el: () => textareaRef.value?.element ?? null
})
</script>

<template>
  <NativeChatComposerField
    :composer-scope-key="paneKey"
    :textarea-ref="refs.textarea"
    :draft="draft"
    :disabled="disabled"
    :placeholder="placeholder"
    :autocomplete="autocomplete"
    :active-suggestion="activeSuggestion"
    :notice="notice"
    :image-attachments="imageAttachments"
    :send-button-disabled="sendButtonDisabled"
    :is-working="isWorking"
    :attach-disabled="disabled"
    :dictation-disabled="true"
    :is-dictating="false"
    :is-dictation-hold-mode="false"
    :show-dictation="false"
    :ime-enter-gesture="imeEnterGesture"
    :picker-listbox-id="picker.listboxId"
    :session-options-surface="sessionOptionsSurface"
    :session-options-snapshot="sessionOptionsSnapshot"
    :session-options-picker-request="sessionOptionsPickerRequest"
    :session-options-props="sessionOptionsProps"
    :context-usage="contextUsageSummary"
    :goal-mode="goalMode"
    :allow-images="allowImages"
    :send-blocked-reason="sendBlockedReason"
    @draft-change="handleDraftChange"
    @textarea-select="onTextareaSelect"
    @key-down="handleKeyDown"
    @ime-settled="onImeSettled"
    @paste="handlePaste"
    @choose-picker-item="completePickerItem"
    @retry-skills="picker.retrySkills"
    @accept-mention="onAcceptMention"
    @remove-image-attachment="removeImageAttachment"
    @attach="pickImages"
    @send="send"
    @stop="onStopButton"
    @dragover.capture="drop.onDragOverCapture"
    @drop.capture="drop.onDropCapture"
  >
    <template v-if="$slots['session-options']" #session-options="slotProps">
      <slot name="session-options" v-bind="slotProps" />
    </template>
  </NativeChatComposerField>
</template>
