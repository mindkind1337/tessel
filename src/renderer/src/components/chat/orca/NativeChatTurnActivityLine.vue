<script setup>
// After Orca's NativeChatTurnActivityLine.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * The live turn's one indicator: a spinner plus whatever the turn can say about
 * itself — the provider's activity text, else that it is reasoning, else how
 * long it has been working. A settled turn keeps its own NativeChatWorkingStatus
 * row; this one is only ever rendered while the turn is in flight.
 * Props: activity ({ kind, text } | null), status (the active turn status
 *   { startedAt, thinking, workedSeconds } | null).
 */
import { computed } from 'vue'
import { Loader2 } from 'lucide-vue-next'
import { t } from '../../../i18n'
import {
  describeNativeChatActiveTurnLabel,
  NATIVE_CHAT_TURN_STATUS_COPY
} from '../../../chat/orca/shared/native-chat-turn-status.js'
import { useNativeChatElapsedSeconds } from '../../../chat/orca/composables/use-native-chat-elapsed-seconds.js'

const props = defineProps({
  activity: { type: Object, default: null },
  status: { type: Object, default: null }
})

const thinking = computed(() => props.status?.thinking === true)
// The clock only ticks when its number is the label; activity text and
// "Thinking" carry no duration.
const counting = computed(() => props.status != null && !thinking.value && !props.activity?.text)
const elapsedSeconds = useNativeChatElapsedSeconds(() => props.status?.startedAt ?? null, counting)

const label = computed(() => {
  const resolved = describeNativeChatActiveTurnLabel({
    activityText: props.activity?.text,
    thinking: thinking.value,
    elapsedSeconds: elapsedSeconds.value
  })
  if (resolved.source === 'activity') return resolved.text
  if (props.status == null) return t('chat.orca.status.working', 'Working…')
  if (resolved.key === 'thinking') {
    return t('chat.orca.status.thinking', NATIVE_CHAT_TURN_STATUS_COPY.thinking)
  }
  return t('chat.orca.status.workingFor', NATIVE_CHAT_TURN_STATUS_COPY.workingFor, {
    value0: resolved.duration
  })
})
</script>

<template>
  <div
    class="nc-turn-activity"
    data-native-chat-turn-activity="true"
    data-native-chat-turn-status="active"
    aria-live="polite"
    aria-atomic="true"
  >
    <Loader2 aria-hidden="true" class="nc-turn-activity__spinner nc-animate-spin" />
    <span class="nc-turn-activity__label">{{ label }}</span>
  </div>
</template>

<style scoped>
.nc-turn-activity {
  display: flex;
  min-height: 24px;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  line-height: 1.625;
  color: var(--nc-muted-foreground);
}
.nc-turn-activity__spinner {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}
.nc-turn-activity__label {
  min-width: 0;
  flex: 1 1 0%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: color-mix(in srgb, var(--nc-foreground) 85%, transparent);
}
</style>
