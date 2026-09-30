<script setup>
// After Orca's composer actions (MIT, Copyright (c) 2026 Lovecast Inc.).
import { computed } from 'vue'
import { Mic, Square } from 'lucide-vue-next'
import { t } from '../../../i18n'
import Button from './ui/Button.vue'
import Tooltip from './ui/Tooltip.vue'
import TooltipTrigger from './ui/TooltipTrigger.vue'
import TooltipContent from './ui/TooltipContent.vue'
const props = defineProps({ dictationDisabled: Boolean, isDictating: Boolean, isDictationHoldMode: Boolean, dictationTitle: String })
const emit = defineEmits(['dictationToggle', 'dictationHoldStart', 'dictationHoldEnd'])
const dictationLabel = computed(() =>
  props.isDictating
    ? t('chat.orca.composer.stopDictation', 'Stop dictation')
    : props.dictationTitle || t('chat.orca.composer.startDictation', 'Start dictation')
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
      <Tooltip>
        <TooltipTrigger as-child>
          <Button
            type="button"
            :variant="isDictating ? 'secondary' : 'ghost'"
            size="icon-sm"
            class="nc-dictation-button"
            :aria-label="dictationLabel"
            data-test="chat-dictation"
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
     
</template>
<style scoped>
.nc-dictation-button { color: var(--nc-muted-foreground); background: transparent; }
.nc-size-4 { width: 16px; height: 16px; stroke-width: 1.5; }
.nc-size-3-5 { width: 14px; height: 14px; }
.nc-fill-current { fill: currentColor; }
</style>
