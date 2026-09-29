<script setup>
// After Orca's NativeChatComposerActions.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
// The row under the composer's input: Attach on the left; session option
// pickers, the context ring, dictation and the Send / Stop button on the right.
// Props: attachDisabled, dictationDisabled, sendDisabled, isWorking,
//   isDictating, isDictationHoldMode, sessionOptionsSurface,
//   sessionOptionsSnapshot, sessionOptionsPickerRequest, contextUsage (a
//   summary, or null), and Tessel's: showAttach (default true; the composer
//   hides it unless images are allowed), showDictation (default true; Tessel
//   has no dictation), sessionOptionsProps (more props for the pickers),
//   criticalTitle (the Send / Stop button's title, e.g. why Send waits).
// Emits: attach, dictationToggle, dictationHoldStart, dictationHoldEnd, send, stop.
// Slot: session-options (replaces the default pickers).
// The goal chip (onExitGoalMode) is not ported: Tessel has no goal controller.
import { computed } from 'vue'
import { ArrowUp, Mic, Plus, Square } from 'lucide-vue-next'
import { t } from '../../../i18n'
import Button from './ui/Button.vue'
import Tooltip from './ui/Tooltip.vue'
import TooltipContent from './ui/TooltipContent.vue'
import TooltipTrigger from './ui/TooltipTrigger.vue'
import NativeChatSessionOptionPickers from './NativeChatSessionOptionPickers.vue'
import NativeChatContextUsageRing from './NativeChatContextUsageRing.vue'

const props = defineProps({
  attachDisabled: { type: Boolean, default: false },
  dictationDisabled: { type: Boolean, default: false },
  sendDisabled: { type: Boolean, default: false },
  isWorking: { type: Boolean, default: false },
  isDictating: { type: Boolean, default: false },
  isDictationHoldMode: { type: Boolean, default: false },
  sessionOptionsSurface: { type: Object, default: null },
  sessionOptionsSnapshot: { type: Array, default: () => [] },
  sessionOptionsPickerRequest: { type: Object, default: null },
  sessionOptionsProps: { type: Object, default: () => ({}) },
  contextUsage: { type: Object, default: null },
  showAttach: { type: Boolean, default: true },
  showDictation: { type: Boolean, default: true },
  criticalTitle: { type: String, default: undefined }
})
const emit = defineEmits(['attach', 'dictationToggle', 'dictationHoldStart', 'dictationHoldEnd', 'send', 'stop'])

function handleCriticalAction(event) {
  // A double-click commonly lands after the first send has started and the button has
  // changed to Stop; ignore the second click instead of cancelling the new turn.
  if (event.detail > 1) return
  if (props.isWorking) emit('stop')
  else emit('send')
}

const dictationLabel = computed(() =>
  props.isDictating
    ? t('chat.orca.composer.stopDictation', 'Stop dictation')
    : t('chat.orca.composer.startDictation', 'Start dictation')
)
const attachLabel = computed(() => t('chat.orca.composer.attach', 'Attach file'))
const criticalLabel = computed(() =>
  props.isWorking ? t('chat.orca.stop', 'Stop the agent') : t('chat.orca.composer.send', 'Send')
)

function onDictationClick() {
  if (!props.isDictationHoldMode) emit('dictationToggle')
}
function onDictationPointerDown(event) {
  if (!props.isDictationHoldMode || props.dictationDisabled) return
  event.preventDefault()
  emit('dictationHoldStart')
}
function onDictationPointerUp() {
  if (props.isDictationHoldMode && !props.dictationDisabled) emit('dictationHoldEnd')
}
function onDictationPointerLeave(event) {
  if (props.isDictationHoldMode && event.buttons === 1 && !props.dictationDisabled) emit('dictationHoldEnd')
}
</script>

<template>
  <div class="nc-actions">
    <div class="nc-actions-start">
      <Tooltip v-if="showAttach">
        <TooltipTrigger as-child>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            class="nc-actions-touch"
            :aria-label="attachLabel"
            :disabled="attachDisabled"
            @click="emit('attach')"
          >
            <Plus class="nc-size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" :side-offset="4">{{ attachLabel }}</TooltipContent>
      </Tooltip>
    </div>
    <div class="nc-actions-end">
      <!-- Why: keep session controls beside the actions they affect; the model
      trigger is ordered last so only the context ring separates it from dictation. -->
      <slot name="session-options" :is-working="isWorking">
        <NativeChatSessionOptionPickers
          :surface="sessionOptionsSurface"
          :snapshot="sessionOptionsSnapshot"
          :is-working="isWorking"
          :picker-request="sessionOptionsPickerRequest"
          v-bind="sessionOptionsProps"
        />
      </slot>
      <NativeChatContextUsageRing v-if="contextUsage" :usage="contextUsage" />
      <Tooltip v-if="showDictation">
        <TooltipTrigger as-child>
          <Button
            type="button"
            :variant="isDictating ? 'secondary' : 'ghost'"
            size="icon-sm"
            class="nc-actions-touch"
            :aria-label="dictationLabel"
            :disabled="dictationDisabled"
            @click="onDictationClick"
            @pointerdown="onDictationPointerDown"
            @pointerup="onDictationPointerUp"
            @pointercancel="onDictationPointerUp"
            @pointerleave="onDictationPointerLeave"
          >
            <Square v-if="isDictating" class="nc-size-3-5 nc-fill-current" />
            <Mic v-else class="nc-size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" :side-offset="4">{{ dictationLabel }}</TooltipContent>
      </Tooltip>
      <Button
        type="button"
        :data-native-chat-critical-action="isWorking ? 'stop' : undefined"
        :data-test="isWorking ? 'chat-interrupt' : 'chat-send'"
        :aria-label="criticalLabel"
        :title="criticalTitle"
        :disabled="sendDisabled"
        :variant="isWorking ? 'secondary' : 'default'"
        size="icon"
        class="nc-actions-critical"
        @click="handleCriticalAction"
      >
        <Square v-if="isWorking" class="nc-size-3-5 nc-fill-current" />
        <ArrowUp v-else class="nc-size-4" />
      </Button>
    </div>
  </div>
</template>

<style scoped>
/* flex w-full items-center justify-between gap-2 */
.nc-actions {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
/* flex min-w-0 items-center gap-0.5 */
.nc-actions-start {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 2px;
}
/* ml-auto flex items-center gap-1.5 */
.nc-actions-end {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 6px;
}
.nc-size-4 {
  width: 16px;
  height: 16px;
}
.nc-size-3-5 {
  width: 14px;
  height: 14px;
}
.nc-fill-current {
  fill: currentColor;
}
/* size-8 rounded-full */
.nc-actions-critical {
  width: 32px;
  height: 32px;
  border-radius: 9999px;
}
/* pointer-coarse:size-11 / pointer-coarse:size-10 */
@media (pointer: coarse) {
  .nc-actions-touch {
    width: 44px;
    height: 44px;
  }
  .nc-actions-critical {
    width: 40px;
    height: 40px;
  }
}
</style>
