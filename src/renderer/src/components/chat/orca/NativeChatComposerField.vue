<script setup>
// After Orca's NativeChatComposerField.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
// The composer's box: pickers above it, the notice, image chips, the prompt
// editor and the actions row. It owns the IME rules: while a composition is
// open the browser owns the value (a stale draft never overwrites it) and a
// draft clear dropped mid-composition is replayed when it settles.
// Props: composerScopeKey, textareaRef (a Vue ref the editor fills), draft,
//   disabled, placeholder, autocomplete, activeSuggestion, notice,
//   imageAttachments, sendButtonDisabled, isWorking, attachDisabled,
//   dictationDisabled, isDictating, isDictationHoldMode, imeEnterGesture,
//   pickerListboxId, sessionOptionsSurface, sessionOptionsSnapshot,
//   contextUsage, sessionOptionsPickerRequest, goalMode; Tessel's:
//   allowImages (default false: no image chips, no Attach), showDictation,
//   sessionOptionsProps, sendBlockedReason (read out with the input and shown
//   as the Send button's title).
// Emits: draftChange(value, input), textareaSelect(input), keyDown(event),
//   imeSettled(input), paste(event), choosePickerItem(item), retrySkills,
//   acceptMention, removeImageAttachment(id), attach, dictationToggle,
//   dictationHoldStart, dictationHoldEnd, send, stop.
// Slot: session-options (passed to the actions row).
// Other attributes and listeners (drag/drop) go to the root.
import { computed, unref, useId, watch } from 'vue'
import { ImageOff } from 'lucide-vue-next'
import { t } from '../../../i18n'
import { NATIVE_FILE_DROP_TARGET } from '../../../chat/orca/shared/native-file-drop.js'
import NativeChatPromptEditor from './NativeChatPromptEditor.vue'
import NativeChatPickerMenu from './NativeChatPickerMenu.vue'
import NativeChatMentionHint from './NativeChatMentionHint.vue'
import NativeChatComposerActions from './NativeChatComposerActions.vue'
import NativeChatImageAttachmentPreview from './NativeChatImageAttachmentPreview.vue'

const props = defineProps({
  composerScopeKey: { type: String, required: true },
  textareaRef: { type: Object, required: true },
  draft: { type: String, default: '' },
  disabled: { type: Boolean, default: false },
  placeholder: { type: String, default: '' },
  autocomplete: { type: Object, default: () => ({ mode: 'none' }) },
  activeSuggestion: { type: Number, default: 0 },
  notice: { type: String, default: null },
  imageAttachments: { type: Array, default: () => [] },
  sendButtonDisabled: { type: Boolean, default: false },
  isWorking: { type: Boolean, default: false },
  attachDisabled: { type: Boolean, default: false },
  dictationDisabled: { type: Boolean, default: true },
  isDictating: { type: Boolean, default: false },
  isDictationHoldMode: { type: Boolean, default: false },
  imeEnterGesture: { type: Object, required: true },
  pickerListboxId: { type: String, required: true },
  sessionOptionsSurface: { type: Object, default: null },
  sessionOptionsSnapshot: { type: Array, default: () => [] },
  contextUsage: { type: Object, default: null },
  sessionOptionsPickerRequest: { type: Object, default: null },
  goalMode: { type: Object, default: undefined },
  allowImages: { type: Boolean, default: false },
  showDictation: { type: Boolean, default: true },
  sessionOptionsProps: { type: Object, default: () => ({}) },
  sendBlockedReason: { type: String, default: '' }
})
const emit = defineEmits([
  'draftChange',
  'textareaSelect',
  'keyDown',
  'imeSettled',
  'paste',
  'choosePickerItem',
  'retrySkills',
  'acceptMention',
  'removeImageAttachment',
  'attach',
  'dictationToggle',
  'dictationHoldStart',
  'dictationHoldEnd',
  'send',
  'stop'
])

// The id of the text that says why Send waits (aria-describedby).
const blockedId = `nc-send-blocked-${useId()}` // i18n-ignore

/**
 * Applies a draft clear that was dropped mid-composition: everything the field held when the
 * IME started is what the clear was meant to erase, so only the composed segment survives.
 * Diffed from both ends because an IME edits at the caret, which need not be the end.
 */
function imeComposedSegment(base, settled) {
  const limit = Math.min(base.length, settled.length)
  let prefix = 0
  while (prefix < limit && base[prefix] === settled[prefix]) {
    prefix += 1
  }
  let suffix = 0
  while (suffix < limit - prefix && base[base.length - 1 - suffix] === settled[settled.length - 1 - suffix]) {
    suffix += 1
  }
  return settled.slice(prefix, settled.length - suffix)
}

// Value the IME started from, and whether a programmatic clear was dropped on top of it.
let compositionBase = ''
let droppedDraftClear = false

// Browser owns the provisional value; the draft is synchronized only between IME sessions.
watch(
  [() => props.draft, () => props.textareaRef.value],
  () => {
    const textarea = props.textareaRef.value
    if (!textarea) return
    if (props.imeEnterGesture.isComposing()) {
      // Why: a clear (an async structured send confirming) would otherwise be lost outright and
      // the sent text would ride along into the next message. Only clears are carved out of
      // browser ownership; every other programmatic draft still loses to the live composition.
      droppedDraftClear = droppedDraftClear || (props.draft === '' && textarea.value !== '')
      return
    }
    droppedDraftClear = false
    if (textarea.value === props.draft) return
    textarea.value = props.draft
  },
  { flush: 'post' }
)

function settleImeValue(element) {
  if (droppedDraftClear) {
    droppedDraftClear = false
    element.value = imeComposedSegment(compositionBase, element.value)
  }
  emit('imeSettled', element)
}

function onKeyDownCapture(event) {
  if (!props.imeEnterGesture.ownsKeyDown(event)) emit('keyDown', event)
}
// React's onBlur is a bubbling focusout.
function onFocusOut() {
  const compositionWasActive = props.imeEnterGesture.isComposing()
  props.imeEnterGesture.reset()
  if (compositionWasActive && props.textareaRef.value) settleImeValue(props.textareaRef.value)
}
function onCompositionStart() {
  compositionBase = props.textareaRef.value?.value ?? ''
  props.imeEnterGesture.setComposing(true)
}
function onCompositionEnd() {
  const compositionWasActive = props.imeEnterGesture.isComposing()
  props.imeEnterGesture.setComposing(false)
  if (compositionWasActive && props.textareaRef.value) settleImeValue(props.textareaRef.value)
}

const slashOpen = computed(() => props.autocomplete.mode === 'slash')
const activeDescendant = computed(() =>
  slashOpen.value && props.autocomplete.items.length > 0
    ? `${props.pickerListboxId}-option-${Math.min(props.activeSuggestion, props.autocomplete.items.length - 1)}` // i18n-ignore
    : undefined
)
const editorPlaceholder = computed(() =>
  unref(props.goalMode?.active)
    ? t('chat.orca.goal.placeholder', 'Describe your goal, define measurable outcomes for best results')
    : props.placeholder
)
const shownAttachments = computed(() => (props.allowImages ? props.imageAttachments : []))

// The Send / Stop button's title: why Send waits, or (Tessel) what Stop does
// to the queue.
const criticalTitle = computed(() => {
  if (props.isWorking) return t('chat.composer.interruptTurnHint', 'Interrupt the current turn (Esc). Queued messages are still sent afterwards.')
  return props.sendBlockedReason || undefined
})
</script>

<template>
  <div class="nc-composer" data-test="chat-composer">
    <!-- Extra bottom padding keeps the input box off the window rim. -->
    <div class="nc-composer-pad">
      <div class="nc-composer-column">
        <NativeChatPickerMenu
          v-if="autocomplete.mode === 'slash'"
          :autocomplete="autocomplete"
          :active-index="activeSuggestion"
          :listbox-id="pickerListboxId"
          @choose="emit('choosePickerItem', $event)"
          @retry="emit('retrySkills')"
        />
        <NativeChatMentionHint
          v-if="autocomplete.mode === 'mention'"
          :query="autocomplete.query"
          @accept="emit('acceptMention')"
        />
        <div v-if="notice" class="nc-composer-notice" data-test="chat-composer-notice">
          <ImageOff class="nc-composer-notice-icon" />
          <span>{{ notice }}</span>
        </div>
        <!-- Why: always-on hairline (not a focus ring), and paint containment: the
        caret blink repaints only this box, not the transcript. Pickers are
        siblings and every menu and tooltip in here is teleported, so nothing
        floating clips. The attachment remove button overhangs its thumbnail by
        6px and clears this box's padding by 4px — keep that slack. -->
        <div
          class="nc-composer-box"
          :data-native-file-drop-target="NATIVE_FILE_DROP_TARGET.composer"
          :data-composer-scope-key="composerScopeKey"
        >
          <div v-if="shownAttachments.length > 0" class="nc-composer-attachments">
            <NativeChatImageAttachmentPreview
              v-for="attachment in shownAttachments"
              :key="attachment.id"
              :attachment="attachment"
              @remove="emit('removeImageAttachment', $event)"
            />
          </div>
          <NativeChatPromptEditor
            :key="composerScopeKey"
            :scope-key="composerScopeKey"
            :input-ref="textareaRef"
            :initial-value="draft"
            :disabled="disabled"
            :placeholder="editorPlaceholder"
            class="nc-composer-input nc-ui-scrollbar-sleek"
            data-test="chat-input"
            :aria-expanded="slashOpen ? 'true' : 'false'"
            :aria-controls="slashOpen ? pickerListboxId : undefined"
            :aria-activedescendant="activeDescendant"
            :aria-describedby="sendBlockedReason ? blockedId : undefined"
            :aria-disabled="disabled ? 'true' : undefined"
            @change="emit('draftChange', $event.value, $event)"
            @select="emit('textareaSelect', $event)"
            @keydown.capture="onKeyDownCapture"
            @keyup="imeEnterGesture.onKeyUp"
            @focusout="onFocusOut"
            @compositionstart="onCompositionStart"
            @compositionend="onCompositionEnd"
            @paste.capture="emit('paste', $event)"
          />
          <span v-if="sendBlockedReason" :id="blockedId" class="nc-ui-sr-only" data-test="chat-send-blocked">{{
            sendBlockedReason
          }}</span>
          <div class="nc-composer-actions">
            <NativeChatComposerActions
              :attach-disabled="attachDisabled"
              :dictation-disabled="dictationDisabled"
              :send-disabled="sendButtonDisabled"
              :is-working="isWorking"
              :is-dictating="isDictating"
              :is-dictation-hold-mode="isDictationHoldMode"
              :session-options-surface="sessionOptionsSurface"
              :session-options-snapshot="sessionOptionsSnapshot"
              :session-options-picker-request="sessionOptionsPickerRequest"
              :session-options-props="sessionOptionsProps"
              :context-usage="contextUsage"
              :show-attach="allowImages"
              :show-dictation="showDictation"
              :critical-title="criticalTitle"
              @attach="emit('attach')"
              @dictation-toggle="emit('dictationToggle')"
              @dictation-hold-start="emit('dictationHoldStart')"
              @dictation-hold-end="emit('dictationHoldEnd')"
              @send="emit('send')"
              @stop="emit('stop')"
            >
              <template v-if="$slots['session-options']" #session-options="slotProps">
                <slot name="session-options" v-bind="slotProps" />
              </template>
            </NativeChatComposerActions>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* shrink-0 bg-background */
.nc-composer {
  flex-shrink: 0;
  background: var(--nc-background);
}
/* px-3 pt-2 pb-4 sm:px-4 */
.nc-composer-pad {
  padding: 8px 12px 16px;
}
@media (min-width: 640px) {
  .nc-composer-pad {
    padding-left: 16px;
    padding-right: 16px;
  }
}
/* relative mx-auto w-full max-w-4xl */
.nc-composer-column {
  position: relative;
  margin: 0 auto;
  width: 100%;
  max-width: 56rem;
}
/* mb-1.5 flex items-center gap-1.5 text-xs text-muted-foreground */
.nc-composer-notice {
  margin-bottom: 6px;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  line-height: 16px;
  color: var(--nc-muted-foreground);
}
/* size-3.5 shrink-0 */
.nc-composer-notice-icon {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}
/* rounded-lg border border-border p-1.5 shadow-xs bg-muted/50 dark:bg-input/40 [contain:paint] */
.nc-composer-box {
  box-sizing: border-box;
  border: 1px solid var(--nc-border);
  border-radius: 8px;
  padding: 6px;
  box-shadow: 0 1px 2px 0 rgb(0 0 0 / 0.05);
  background: color-mix(in srgb, var(--nc-input) 40%, transparent);
  contain: paint;
}
/* mb-2 flex flex-wrap gap-2 px-1 pt-1.5 */
.nc-composer-attachments {
  margin-bottom: 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 6px 4px 0;
}
/* The editable element (ProseMirror builds it: :deep).
   min-h-12 w-full bg-transparent px-2 py-1 text-sm outline-none pointer-coarse:min-h-14
   max-h-[calc(8lh+0.5rem)] overflow-y-auto scrollbar-sleek
   placeholder:text-muted-foreground/60 disabled:cursor-not-allowed disabled:opacity-50.
   Why: the content grows naturally; the 8lh cap (plus py-1) turns further growth
   into internal scrolling, layout-driven, so a re-wrap on resize needs no measure pass. */
.nc-composer-box :deep(.nc-composer-input) {
  box-sizing: border-box;
  min-height: 48px;
  width: 100%;
  max-height: calc(8lh + 0.5rem);
  overflow-y: auto;
  background: transparent;
  padding: 4px 8px;
  font-size: 14px;
  line-height: 20px;
  color: var(--nc-foreground);
  outline: none;
}
@media (pointer: coarse) {
  .nc-composer-box :deep(.nc-composer-input) {
    min-height: 56px;
  }
}
.nc-composer-box :deep(.nc-composer-input[contenteditable='false']) {
  cursor: not-allowed;
  opacity: 0.5;
}
/* flex flex-wrap items-center gap-2 pt-0.5 */
.nc-composer-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding-top: 2px;
}
</style>
