<script setup>
// Orca's AgentStateDot (agent rows) and StatusIndicator (workspace status
// lane), ported from src/renderer/src/components/AgentStateDot.tsx and
// sidebar/StatusIndicator.tsx (MIT, Copyright (c) 2026 Lovecast Inc.).
// Working is the pane header's flashing green dot (Orca spins a yellow ring;
// the user wanted the pane's dot), waiting / permission a question bubble, done a
// check (rows) or a green dot (status lane), problems a red dot.
import { computed } from 'vue'
import { CircleCheck, CircleDashed, MessageCircleQuestion, Moon } from 'lucide-vue-next'
import { agentStateLabel, getWorktreeStatusLabel } from '../../sidebarModel'
import { t } from '../../i18n'

const props = defineProps({
  state: { type: String, required: true },
  // 'row' = AgentStateDot size sm; 'status' = StatusIndicator (h-3 w-3).
  variant: { type: String, default: 'row' },
  title: { type: String, default: undefined },
  // false inside rows whose hover card tells the state: no native tooltip,
  // the label stays for screen readers.
  tooltip: { type: Boolean, default: true }
})

const status = computed(() => props.variant === 'status')
const label = computed(() => {
  if (props.title !== undefined) return props.title
  if (status.value) return props.state === 'sleeping' ? t('sidebar.status.sleeping', 'Sleeping') : getWorktreeStatusLabel(props.state)
  return agentStateLabel(props.state)
})
const kind = computed(() => {
  const s = props.state
  if (s === 'working') return 'working'
  if (s === 'monitoring') return 'monitoring'
  if (s === 'sleeping') return 'moon'
  if (s === 'permission' || s === 'waiting') return 'question'
  if (!status.value && s === 'done') return 'check'
  if (s === 'unverifiable') return 'dashed'
  return 'dot'
})
const dotClass = computed(() => {
  const s = props.state
  if (s === 'blocked' || s === 'interrupted' || s === 'failed') return 'red'
  if (status.value && (s === 'done' || s === 'active')) return 'green'
  return 'grey'
})
</script>

<template>
  <span
    class="asd"
    :class="[status ? 'asd-status' : 'asd-row']"
    :title="(tooltip && label) || undefined"
    :aria-label="label || undefined"
    role="img"
  >
    <span v-if="kind === 'working'" class="asd-dot asd-working" data-agent-working=""></span>
    <span v-else-if="kind === 'monitoring'" class="asd-dot asd-monitoring" aria-hidden="true"></span>
    <MessageCircleQuestion v-else-if="kind === 'question'" class="asd-icon asd-question" aria-hidden="true" />
    <CircleCheck v-else-if="kind === 'check'" class="asd-icon asd-green" aria-hidden="true" />
    <CircleDashed v-else-if="kind === 'dashed'" class="asd-icon asd-amber" aria-hidden="true" />
    <Moon v-else-if="kind === 'moon'" class="asd-moon" aria-hidden="true" />
    <span v-else class="asd-dot" :class="dotClass"></span>
  </span>
</template>
