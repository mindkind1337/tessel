<script setup>
// The sub-agents a Claude Code pane's conversation started (its Task / Agent
// tool), like Claude Code's own list: each one's kind, title, time and
// tokens, running ones first. A compact indicator in the pane header (a
// count, like Orca's); click for the list. The list opens in the page's top
// layer (teleported to <body>, placed next to the indicator and kept inside
// the window), so it is never hidden under a neighbouring pane or clipped.
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { childTime, formatTokens, childrenSummary } from '../agentChildrenView'

const props = defineProps({
  agentId: { type: String, default: null },
  sessionId: { type: String, default: null },
  accountId: { type: [String, null], default: undefined }
})

const list = ref([])
const open = ref(false)
const now = ref(Date.now())
const chipEl = ref(null)
const listEl = ref(null)
const pos = ref({ left: 0, top: 0, maxHeight: 340 })
let pollTimer = 0
let clockTimer = 0
let disposed = false
// Which conversation the list is of (agent, session, account): an answer for
// another one, or older than the last request, is dropped.
let seq = 0
let shownKey = null
const keyOf = () => JSON.stringify([props.agentId, props.sessionId, props.accountId === undefined ? null : props.accountId])

async function refresh() {
  if (disposed) return
  const key = keyOf()
  // Another conversation: its old list goes at once.
  if (key !== shownKey) {
    shownKey = key
    list.value = []
  }
  const my = ++seq
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
    if (disposed || my !== seq || keyOf() !== key) return
    list.value = Array.isArray(res) ? res : []
    // The clock moves with each answer too (not only while one runs), so the
    // "done" count forgets the ones finished more than 30 min ago.
    now.value = Date.now()
  } catch {
    // next time
  }
}
const summary = computed(() => childrenSummary(list.value, now.value))
const shown = computed(() => summary.value.running > 0 || summary.value.quiet > 0 || summary.value.recent > 0)
// The indicator: a number, its state in words for screen readers and tests.
const count = computed(() => summary.value.running || summary.value.quiet || summary.value.recent)
const countWord = computed(() => (summary.value.running ? 'running' : summary.value.quiet ? 'quiet' : 'done'))
const chipTitle = computed(() => {
  const s = summary.value
  const parts = []
  if (s.running) parts.push(`${s.running} running`)
  if (s.quiet) parts.push(`${s.quiet} quiet`)
  if (s.recent) parts.push(`${s.recent} done`)
  return `Sub-agents this conversation started: ${parts.join(', ') || 'none'}. Click for the list`
})
// Running first, then newest.
const rows = computed(() =>
  [...list.value].sort((a, b) => (b.state === 'running') - (a.state === 'running') || (b.startedAt || 0) - (a.startedAt || 0))
)

// Placed under the indicator (above it when there is more room there), its
// right edge on the indicator's when it would leave the window.
const GAP = 6
const MARGIN = 8
function place() {
  if (!open.value || !chipEl.value) return
  const r = chipEl.value.getBoundingClientRect()
  const vw = window.innerWidth
  const vh = window.innerHeight
  const el = listEl.value
  const w = el ? el.offsetWidth : Math.min(640, vw * 0.7)
  const h = el ? el.scrollHeight : 340
  const below = vh - r.bottom - GAP - MARGIN
  const above = r.top - GAP - MARGIN
  const up = h > below && above > below
  const maxHeight = Math.max(80, Math.min(340, up ? above : below))
  let left = r.left
  if (left + w > vw - MARGIN) left = Math.max(MARGIN, Math.min(r.right, vw - MARGIN) - w)
  const top = up ? Math.max(MARGIN, r.top - GAP - Math.min(h, maxHeight)) : r.bottom + GAP
  pos.value = { left: Math.round(left), top: Math.round(top), maxHeight: Math.round(maxHeight) }
}
async function toggle() {
  open.value = !open.value
  refresh()
  if (open.value) {
    place()
    await nextTick()
    place()
  }
}
watch([rows, open], () => nextTick(place))

// Every 5 s while some run (else every 20 s); the clock ticks while shown.
function schedule() {
  clearTimeout(pollTimer)
  if (disposed) return
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
watch(keyOf, refresh)
function onDocDown(e) {
  if (!open.value) return
  const t = e.target
  if ((chipEl.value && chipEl.value.contains(t)) || (listEl.value && listEl.value.contains(t))) return
  open.value = false
}
function onKey(e) {
  if (e.key === 'Escape' && open.value) open.value = false
}
function onWinBlur() {
  open.value = false
}
function onLayout() {
  if (open.value) place()
}
onMounted(() => {
  refresh().then(schedule)
  document.addEventListener('mousedown', onDocDown, true)
  window.addEventListener('keydown', onKey)
  window.addEventListener('blur', onWinBlur)
  window.addEventListener('resize', onLayout)
  window.addEventListener('terminal-layout-change', onLayout)
})
onBeforeUnmount(() => {
  disposed = true
  clearTimeout(pollTimer)
  clearInterval(clockTimer)
  document.removeEventListener('mousedown', onDocDown, true)
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('blur', onWinBlur)
  window.removeEventListener('resize', onLayout)
  window.removeEventListener('terminal-layout-change', onLayout)
})
const MARK = { running: '◌', done: '✓', quiet: '…' }
const STATE_TITLE = { running: 'Running', done: 'Finished', quiet: 'Quiet: nothing written for a while (a long tool, or stopped)' }
</script>

<template>
  <span v-if="shown" class="agent-children" @mousedown.stop>
    <button
      ref="chipEl"
      class="agent-children-chip"
      :class="{ running: summary.running, open }"
      type="button"
      :aria-expanded="open"
      aria-haspopup="true"
      :title="chipTitle"
      data-test="agent-children"
      @click.stop="toggle"
    >
      <svg class="agent-children-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <!-- lucide "workflow" (ISC) -->
        <rect width="8" height="8" x="3" y="3" rx="2" />
        <path d="M7 11v4a2 2 0 0 0 2 2h4" />
        <rect width="8" height="8" x="13" y="13" rx="2" />
      </svg>
      <span class="agent-children-count">{{ count }}</span><span class="sr-only">{{ ' ' + countWord }}</span>
    </button>
    <Teleport to="body">
      <div
        v-if="open"
        ref="listEl"
        class="agent-children-list"
        role="list"
        data-test="agent-children-list"
        :style="{ left: pos.left + 'px', top: pos.top + 'px', maxHeight: pos.maxHeight + 'px' }"
        @mousedown.stop
        @contextmenu.stop
      >
        <div class="agent-children-head">Sub-agents ({{ list.length }})</div>
        <div v-for="c in rows" :key="c.id" class="agent-child" :class="c.state" role="listitem">
          <span class="agent-child-mark" :title="STATE_TITLE[c.state] || c.state">{{ MARK[c.state] || '·' }}</span>
          <span class="agent-child-type">{{ c.type }}</span>
          <span class="agent-child-title" :title="c.title">{{ c.title || '(no title)' }}</span>
          <span class="agent-child-stats">{{ childTime(c, now) }}<template v-if="formatTokens(c.tokens)"> · ↓ {{ formatTokens(c.tokens) }} tokens</template></span>
        </div>
      </div>
    </Teleport>
  </span>
</template>
