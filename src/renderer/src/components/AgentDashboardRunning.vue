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
  <span v-if="running > 0" class="adb-running" data-test="adb-running">{{ label }}</span>
</template>

<style scoped>
.adb-running {
  display: block;
  margin-top: 2px;
  color: var(--adb-working, var(--text-dim));
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
