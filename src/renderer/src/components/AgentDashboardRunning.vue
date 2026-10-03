<script setup>
// A Dashboard card's sub-agents at work right now ("4 sub-agents working"),
// counted as the sidebar and the pane header count them; nothing when none
// works (finished ones are not the live view's business).
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { acquireChildren, childrenKey } from '../agentChildrenFeed'
import { childActive } from '../agentChildrenView'
import { turnEndedSince } from '../agentStatus'
import { t } from '../i18n'

const props = defineProps({
  // The card's row (sidebarModel.js paneRow): its `children` feed spec.
  row: { type: Object, required: true }
})

const feed = ref(null)
watch(
  () => childrenKey(props.row.children || {}),
  () => {
    if (feed.value) feed.value.release()
    feed.value = props.row.children ? acquireChildren(props.row.children) : null
  },
  { immediate: true }
)
const clock = ref(Date.now())
const timer = setInterval(() => (clock.value = Date.now()), 5000)
onBeforeUnmount(() => {
  clearInterval(timer)
  if (feed.value) feed.value.release()
})

const running = computed(() => {
  const list = feed.value ? feed.value.state.list : []
  const parentIdleSince = props.row.kind === 'agent' ? turnEndedSince(props.row.id) : null
  return list.filter((c) => childActive(c, { now: clock.value, parentIdleSince })).length
})
const label = computed(() =>
  running.value === 1
    ? t('agentDashboard.running.one', '1 sub-agent working')
    : t('agentDashboard.running.many', '{{count}} sub-agents working', { count: running.value })
)
</script>

<template>
  <!-- As in the pane header (AgentChildren.vue): its icon and the number. -->
  <span v-if="running > 0" class="adb-running" data-test="adb-running" :title="label" :aria-label="label">
    <svg class="adb-running-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <!-- lucide "workflow" (ISC) -->
      <rect width="8" height="8" x="3" y="3" rx="2" />
      <path d="M7 11v4a2 2 0 0 0 2 2h4" />
      <rect width="8" height="8" x="13" y="13" rx="2" />
    </svg>
    <span class="adb-running-count">{{ running }}</span>
  </span>
</template>

<style scoped>
.adb-running {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: var(--accent);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.adb-running-icon {
  animation: adb-running-pulse 1.2s steps(4) infinite;
}
@keyframes adb-running-pulse {
  50% {
    opacity: 0.45;
  }
}
@media (prefers-reduced-motion: reduce) {
  .adb-running-icon {
    animation: none;
  }
}
</style>
