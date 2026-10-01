<script setup>
// After Orca's components/AgentStateDot.tsx, AgentWorkingSpinner.tsx and
// AgentQuestionIcon.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * The compact state glyph beside a background task: a yellow spinner while
 * working, a blue dot while monitoring (the user's choice), a check when done, a dashed
 * ring when nothing has been heard (unverifiable), a question glyph when it
 * waits, else a dot (red when blocked / interrupted / failed).
 * Props: state, size 'sm' | 'md' (default 'sm'), title (tooltip text; null
 *   suppresses the tooltip — for rows that already say the state in words),
 *   tooltipSide.
 */
import { computed } from 'vue'
import { CircleCheck, CircleDashed, MessageCircleQuestion } from 'lucide-vue-next'
import { t } from '../../../i18n'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui'

const props = defineProps({
  state: { type: String, required: true },
  size: { type: String, default: 'sm' },
  title: { type: String, default: undefined },
  tooltipSide: { type: String, default: 'top' }
})

/** The accessible label shared by every visual agent-state marker. */
const label = computed(() => {
  switch (props.state) {
    case 'working':
      return t('chat.orca.agentState.working', 'Working')
    case 'monitoring':
      return t('chat.orca.agentState.monitoring', 'Monitoring background tasks')
    case 'blocked':
      return t('chat.orca.agentState.blocked', 'Blocked')
    case 'waiting':
      return t('chat.orca.agentState.waiting', 'Waiting for input')
    case 'interrupted':
      return t('chat.orca.agentState.interrupted', 'Interrupted')
    case 'failed':
      return t('chat.orca.agentState.failed', 'Failed')
    case 'done':
      return t('chat.orca.agentState.done', 'Done')
    case 'idle':
      return t('chat.orca.agentState.idle', 'Idle')
    case 'unverifiable':
      return t('chat.orca.agentState.unverifiable', 'No recent update')
    default:
      return t('chat.orca.agentState.permission', 'Needs attention')
  }
})
const tooltipLabel = computed(() => (props.title === null ? null : (props.title ?? label.value)))
const kind = computed(() => {
  const state = props.state
  if (state === 'working' || state === 'monitoring' || state === 'done' || state === 'unverifiable') return state
  if (state === 'permission' || state === 'waiting') return 'question'
  return 'dot'
})
const alarming = computed(() => ['blocked', 'interrupted', 'failed'].includes(props.state))
</script>

<template>
  <Tooltip v-if="tooltipLabel !== null">
    <TooltipTrigger as-child>
      <span :class="['nc-state-dot', `nc-state-dot--${size}`]" :aria-label="label">
        <span v-if="kind === 'working'" data-agent-spinner="" class="nc-state-dot__spinner nc-state-dot__inner" />
        <span v-else-if="kind === 'monitoring'" aria-hidden="true" class="nc-state-dot__dot nc-state-dot__inner nc-state-dot__dot--monitoring" />
        <CircleCheck v-else-if="kind === 'done'" aria-hidden="true" class="nc-state-dot__icon nc-state-dot__icon--done" />
        <CircleDashed v-else-if="kind === 'unverifiable'" aria-hidden="true" class="nc-state-dot__icon nc-state-dot__icon--unverifiable" />
        <MessageCircleQuestion v-else-if="kind === 'question'" aria-hidden="true" class="nc-state-dot__icon nc-state-dot__icon--question" />
        <span v-else :class="['nc-state-dot__dot', 'nc-state-dot__inner', { 'nc-state-dot__dot--alarm': alarming }]" />
      </span>
    </TooltipTrigger>
    <TooltipContent :side="tooltipSide">{{ tooltipLabel }}</TooltipContent>
  </Tooltip>
  <span v-else :class="['nc-state-dot', `nc-state-dot--${size}`]" :aria-label="label">
    <span v-if="kind === 'working'" data-agent-spinner="" class="nc-state-dot__spinner nc-state-dot__inner" />
    <span v-else-if="kind === 'monitoring'" aria-hidden="true" class="nc-state-dot__dot nc-state-dot__inner nc-state-dot__dot--monitoring" />
    <CircleCheck v-else-if="kind === 'done'" aria-hidden="true" class="nc-state-dot__icon nc-state-dot__icon--done" />
    <CircleDashed v-else-if="kind === 'unverifiable'" aria-hidden="true" class="nc-state-dot__icon nc-state-dot__icon--unverifiable" />
    <MessageCircleQuestion v-else-if="kind === 'question'" aria-hidden="true" class="nc-state-dot__icon nc-state-dot__icon--question" />
    <span v-else :class="['nc-state-dot__dot', 'nc-state-dot__inner', { 'nc-state-dot__dot--alarm': alarming }]" />
  </span>
</template>

<style scoped>
/* inline-flex shrink-0 items-center justify-center; sm h-2.5 w-2.5, md h-3 w-3 */
.nc-state-dot {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
}
.nc-state-dot--sm {
  width: 10px;
  height: 10px;
}
.nc-state-dot--md {
  width: 12px;
  height: 12px;
}
/* inner: sm size-1.5, md size-2 */
.nc-state-dot--sm .nc-state-dot__inner {
  width: 6px;
  height: 6px;
}
.nc-state-dot--md .nc-state-dot__inner {
  width: 8px;
  height: 8px;
}
/* icon: sm size-2.5, md size-3 */
.nc-state-dot--sm .nc-state-dot__icon {
  width: 10px;
  height: 10px;
}
.nc-state-dot--md .nc-state-dot__icon {
  width: 12px;
  height: 12px;
}
/* agent-working-spinner block rounded-full border-2 border-yellow-500 border-t-transparent */
.nc-state-dot__spinner {
  box-sizing: border-box;
  display: block;
  border: 2px solid oklch(0.795 0.184 86.047);
  border-top-color: transparent;
  border-radius: 9999px;
  animation: nc-agent-spinner-rotate 86400s steps(1036800, end) infinite;
}
@keyframes nc-agent-spinner-rotate {
  to {
    transform: rotate(86400turn);
  }
}
@media (prefers-reduced-motion: reduce) {
  .nc-state-dot__spinner {
    animation: none;
    border-top-color: oklch(0.795 0.184 86.047);
  }
}
.nc-state-dot__dot--monitoring {
  background: #3b82f6;
}
.nc-state-dot__icon--done {
  color: oklch(0.696 0.17 162.48);
}
.nc-state-dot__icon--unverifiable {
  color: oklch(0.769 0.188 70.08);
}
/* --agent-question (dark): orange-500 */
.nc-state-dot__icon--question {
  color: oklch(0.705 0.213 47.604);
}
.nc-state-dot__dot {
  display: block;
  border-radius: 9999px;
  background: color-mix(in oklab, oklch(0.556 0 0) 40%, transparent);
}
.nc-state-dot__dot--alarm {
  background: oklch(0.637 0.237 25.331);
}
</style>
