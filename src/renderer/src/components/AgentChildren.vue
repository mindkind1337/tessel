<script setup>
// The sub-agents a Claude Code pane's conversation started (its Task / Agent
// tool), like Claude Code's own list: each one's kind, title, time and
// tokens, running ones first. A chip in the pane header; click for the list.
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { childTime, formatTokens, childrenSummary } from '../agentChildrenView'

const props = defineProps({
  agentId: { type: String, default: null },
  sessionId: { type: String, default: null },
  accountId: { type: [String, null], default: undefined }
})

const list = ref([])
const open = ref(false)
const now = ref(Date.now())
let pollTimer = 0
let clockTimer = 0

async function refresh() {
  if (props.agentId !== 'claude' || !props.sessionId || !window.shellApi.agentChildren) {
    list.value = []
    return
  }
  if (document.visibilityState !== 'visible') return
  try {
    const res = await window.shellApi.agentChildren({
      agent: props.agentId,
      sessionId: props.sessionId,
      ...(props.accountId !== undefined ? { accountId: props.accountId } : {})
    })
    list.value = Array.isArray(res) ? res : []
  } catch {
    // next time
  }
}
const summary = computed(() => childrenSummary(list.value, now.value))
const shown = computed(() => summary.value.running > 0 || summary.value.recent > 0)
// Running first, then newest.
const rows = computed(() =>
  [...list.value].sort((a, b) => (b.state === 'running') - (a.state === 'running') || (b.startedAt || 0) - (a.startedAt || 0))
)

// Every 5 s while some run (else every 20 s); the clock ticks while shown.
function schedule() {
  clearTimeout(pollTimer)
  pollTimer = setTimeout(async () => {
    await refresh()
    schedule()
  }, summary.value.running ? 5000 : 20000)
}
watch(
  () => summary.value.running > 0 || open.value,
  (tick) => {
    clearInterval(clockTimer)
    if (tick) clockTimer = setInterval(() => (now.value = Date.now()), 1000)
  }
)
watch(() => props.sessionId, refresh)
function onDocClick(e) {
  if (open.value && !e.target.closest('.agent-children')) open.value = false
}
onMounted(() => {
  refresh().then(schedule)
  document.addEventListener('mousedown', onDocClick, true)
})
onBeforeUnmount(() => {
  clearTimeout(pollTimer)
  clearInterval(clockTimer)
  document.removeEventListener('mousedown', onDocClick, true)
})
const MARK = { running: '◌', done: '✓', stopped: '■' }
</script>

<template>
  <span v-if="shown" class="agent-children" @mousedown.stop>
    <button
      class="agent-children-chip"
      :class="{ running: summary.running }"
      type="button"
      :aria-expanded="open"
      :title="`Sub-agents this conversation started: ${summary.running} running`"
      data-test="agent-children"
      @click.stop="(open = !open), refresh()"
    >
      <span class="agent-children-dot" aria-hidden="true"></span>
      {{ summary.running ? `${summary.running} running` : `${summary.recent} done` }}
    </button>
    <div v-if="open" class="agent-children-list" role="list" data-test="agent-children-list">
      <div class="agent-children-head">Sub-agents ({{ list.length }})</div>
      <div v-for="c in rows" :key="c.id" class="agent-child" :class="c.state" role="listitem">
        <span class="agent-child-mark" :title="c.state">{{ MARK[c.state] || '·' }}</span>
        <span class="agent-child-type">{{ c.type }}</span>
        <span class="agent-child-title" :title="c.title">{{ c.title || '(no title)' }}</span>
        <span class="agent-child-stats">{{ childTime(c, now) }}<template v-if="formatTokens(c.tokens)"> · ↓ {{ formatTokens(c.tokens) }} tokens</template></span>
      </div>
    </div>
  </span>
</template>
