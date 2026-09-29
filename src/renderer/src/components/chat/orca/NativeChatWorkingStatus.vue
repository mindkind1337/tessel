<script>
// After Orca's NativeChatWorkingStatus.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
export { formatNativeChatDuration } from '../../../chat/orca/shared/native-chat-turn-status.js'
</script>

<script setup>
/**
 * A turn's status line under its prompt: "Worked for 3s" once settled (a
 * button that folds / unfolds the turn when onToggleExpanded is given),
 * "Thinking" while reasoning, else "Working for 12s" with a live clock.
 * Props: startedAt (ms | null), thinking, workedSeconds (null while live),
 *   expanded, onToggleExpanded (a function prop, so its presence decides the
 *   button; `@toggle-expanded` binds it too).
 */
import { computed } from 'vue'
import { ChevronRight } from 'lucide-vue-next'
import { t } from '../../../i18n'
import {
  describeNativeChatTurnStatus,
  NATIVE_CHAT_TURN_STATUS_COPY
} from '../../../chat/orca/shared/native-chat-turn-status.js'
import { useNativeChatElapsedSeconds } from '../../../chat/orca/composables/use-native-chat-elapsed-seconds.js'

const props = defineProps({
  startedAt: { type: Number, default: null },
  thinking: { type: Boolean, default: false },
  workedSeconds: { type: Number, default: null },
  expanded: { type: Boolean, default: false },
  onToggleExpanded: { type: Function, default: undefined }
})

const counting = computed(() => !props.thinking && props.workedSeconds == null)
const elapsedSeconds = useNativeChatElapsedSeconds(() => props.startedAt, counting)

const label = computed(() => {
  const { key, duration } = describeNativeChatTurnStatus({
    thinking: props.thinking,
    workedSeconds: props.workedSeconds,
    elapsedSeconds: elapsedSeconds.value
  })
  if (key === 'workedFor') {
    return t('chat.orca.status.workedFor', NATIVE_CHAT_TURN_STATUS_COPY.workedFor, { value0: duration })
  }
  if (key === 'thinking') return t('chat.orca.status.thinking', NATIVE_CHAT_TURN_STATUS_COPY.thinking)
  return t('chat.orca.status.workingFor', NATIVE_CHAT_TURN_STATUS_COPY.workingFor, { value0: duration })
})
const toggleLabel = computed(() =>
  t('chat.orca.status.toggleDetails', NATIVE_CHAT_TURN_STATUS_COPY.toggleDetails)
)
const respondingLabel = computed(() =>
  t('chat.orca.status.responding', NATIVE_CHAT_TURN_STATUS_COPY.responding)
)
const toggles = computed(() => props.workedSeconds != null && typeof props.onToggleExpanded === 'function')
</script>

<template>
  <button
    v-if="toggles"
    type="button"
    data-native-chat-turn-status="settled"
    :class="['nc-working-status', 'nc-working-status--toggle', { 'nc-working-status--ruled': !thinking }]"
    :aria-label="toggleLabel"
    :aria-expanded="expanded ? 'true' : 'false'"
    @click="onToggleExpanded()"
  >
    <span>{{ label }}</span>
    <ChevronRight
      :class="['nc-working-status__caret', { 'nc-working-status__caret--open': expanded }]"
      aria-hidden="true"
    />
  </button>
  <div
    v-else
    :class="['nc-working-status', { 'nc-working-status--ruled': !thinking }]"
    :data-native-chat-turn-status="workedSeconds == null ? 'active' : 'settled'"
    :aria-label="respondingLabel"
    aria-live="polite"
  >
    <!-- `tabular-nums`: the live clock reflows its own label every second otherwise. -->
    <span :class="{ 'nc-animate-pulse': thinking }">{{ label }}</span>
  </div>
</template>

<style scoped>
.nc-working-status {
  box-sizing: border-box;
  display: flex;
  min-height: 32px;
  align-items: center;
  gap: 4px;
  font-size: 14px;
  line-height: 20px;
  color: var(--nc-muted-foreground);
  font-variant-numeric: tabular-nums;
}
.nc-working-status--ruled {
  border-bottom: 1px solid var(--nc-border);
}
.nc-working-status--toggle {
  width: 100%;
  margin: 0;
  padding: 0;
  border-top: 0;
  border-left: 0;
  border-right: 0;
  background: transparent;
  font-family: inherit;
  text-align: left;
  cursor: default;
}
.nc-working-status--toggle:not(.nc-working-status--ruled) {
  border-bottom: 0;
}
.nc-working-status--toggle:hover {
  color: var(--nc-foreground);
}
.nc-working-status--toggle:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--nc-ring) 70%, transparent);
}
.nc-working-status__caret {
  width: 14px;
  height: 14px;
  transition: transform 150ms cubic-bezier(0.4, 0, 0.2, 1);
}
.nc-working-status__caret--open {
  transform: rotate(90deg);
}
</style>
