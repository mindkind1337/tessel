<script setup>
// After Orca's NativeChatBackgroundTaskRun.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * One background task's durable row: what it was, how it ended, and the
 * provider's own sentence about it.
 *
 * The state is drawn exactly as the journal recorded it. Turn state is NOT
 * consulted — a backgrounded task is explicitly told to outlive the turn that
 * started it, so a turn boundary is no evidence about the task. Only the host
 * that watched it can say it stopped reporting, and one does.
 *
 * Props: block ({ type: 'background-task', taskId, kind, label, state,
 *   summary?, error?, tokens?, startedAt?, settledAt?, outputFile? }).
 * Tessel: the name (often a command line) is shown through maskSecrets.
 */
import { computed } from 'vue'
import { t } from '../../../i18n'
import {
  isSettledBackgroundTaskState,
  normalizeBackgroundTaskKind,
  normalizeBackgroundTaskState
} from '../../../chat/orca/shared/native-chat-background-task-row.js'
import {
  backgroundTaskStateReason,
  backgroundTaskStateWord,
  formatBackgroundTaskTokens,
  resolveBackgroundTaskName
} from '../../../chat/orca/background-task-roster.js'
import { formatNativeChatDuration } from '../../../chat/orca/shared/native-chat-turn-status.js'
import { maskToolText } from '../../../chat/orca/lib/native-chat-tool-secrets.js'
import { KIND_ICONS } from './native-chat-background-task-icons.js'
import AgentStateDot from './AgentStateDot.vue'

const props = defineProps({
  block: { type: Object, required: true }
})

const kind = computed(() => normalizeBackgroundTaskKind(props.block.kind))
const icon = computed(() => KIND_ICONS[kind.value])
const state = computed(() => normalizeBackgroundTaskState(props.block.state))
const settled = computed(() => isSettledBackgroundTaskState(state.value))
// Same name resolution the strip above the composer uses, so one task does
// not read as two different things on the two surfaces.
const label = computed(() =>
  maskToolText(resolveBackgroundTaskName({ id: props.block.taskId, kind: kind.value, description: props.block.label }))
)
// The sentence the provider itself wrote. It is the row's whole reason for
// existing when a task fails, and it is dropped from the prose above as the
// block's twin, so it has to be drawn here.
const sentence = computed(() => props.block.summary?.trim() || props.block.error?.trim() || null)
// Every attention state states its reason on the row; `unverifiable` ("no
// contact") must never be silently dropped. A settled row keeps a fixed
// duration; a live one shows none rather than a frozen clock.
const stateText = computed(() => {
  const block = props.block
  const reason = backgroundTaskStateReason(state.value)
  const duration =
    settled.value && block.startedAt !== undefined && block.settledAt !== undefined
      ? formatNativeChatDuration(Math.max(0, (block.settledAt - block.startedAt) / 1000))
      : null
  const meta = [block.tokens === undefined ? null : formatBackgroundTaskTokens(block.tokens), duration].filter(
    (part) => part !== null
  )
  return `${backgroundTaskStateWord(state.value)}${reason === null ? '' : ` · ${reason}`}${meta.length > 0 ? ` · ${meta.join(' · ')}` : ''}`
})
const outputText = computed(() =>
  t('chat.orca.backgroundTasks.outputFile', 'Output: {{value0}}', { value0: props.block.outputFile })
)
</script>

<template>
  <div class="nc-bg-task-run">
    <div class="nc-bg-task-run__line">
      <component :is="icon" aria-hidden="true" class="nc-bg-task-run__icon" />
      <AgentStateDot :state="state" size="sm" :title="null" />
      <span :class="['nc-bg-task-run__label', { 'nc-bg-task-run__label--live': !settled }]">{{ label }}</span>
      <span class="nc-bg-task-run__state">{{ stateText }}</span>
    </div>
    <p
      v-if="sentence !== null"
      :class="['nc-bg-task-run__sentence', { 'nc-bg-task-run__sentence--blocked': state === 'blocked' }]"
    >{{ sentence }}</p>
    <p v-if="block.outputFile" class="nc-bg-task-run__output">{{ outputText }}</p>
  </div>
</template>

<style scoped>
/* min-w-0 py-0.5 text-sm leading-relaxed text-muted-foreground */
.nc-bg-task-run {
  min-width: 0;
  padding: 2px 0;
  font-size: 14px;
  line-height: 1.625;
  color: var(--nc-muted-foreground);
}
/* flex min-h-6 min-w-0 items-center gap-1.5 */
.nc-bg-task-run__line {
  display: flex;
  min-height: 24px;
  min-width: 0;
  align-items: center;
  gap: 6px;
}
.nc-bg-task-run__icon {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  color: var(--nc-muted-foreground);
}
.nc-bg-task-run__label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nc-bg-task-run__label--live {
  color: color-mix(in srgb, var(--nc-foreground) 85%, transparent);
}
.nc-bg-task-run__state {
  flex-shrink: 0;
  font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
  font-size: 11px;
  color: var(--nc-muted-foreground);
}
/* mt-0.5 pl-7 text-xs */
.nc-bg-task-run__sentence {
  margin: 2px 0 0;
  padding-left: 28px;
  font-size: 12px;
  line-height: 16px;
}
.nc-bg-task-run__sentence--blocked {
  color: var(--nc-destructive);
}
/* mt-0.5 truncate pl-7 font-mono text-[11px] text-muted-foreground/80 */
.nc-bg-task-run__output {
  margin: 2px 0 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding-left: 28px;
  font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
  font-size: 11px;
  color: color-mix(in srgb, var(--nc-muted-foreground) 80%, transparent);
}
</style>
