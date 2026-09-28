<script setup>
// The toolbar gauge: how much of each agent's subscription quota is used
// (5-hour and weekly windows) and when it resets, read by the main process
// from the agents' own local files (agentUsage.js: no sign-in, no network).
// Amber from 80 %, red from 95 %; an old reading says so.
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import BrandIcon from './BrandIcon.vue'

const NAMES = { claude: 'Claude Code', codex: 'Codex' }
const open = ref(false)
const usage = ref(null) // { agents: [...] } | { error }
const root = ref(null)
let timer = null

async function load() {
  if (!window.shellApi.getUsage) return
  try {
    usage.value = await window.shellApi.getUsage()
  } catch (err) {
    usage.value = { error: err && err.message }
  }
}
const agents = computed(() => (usage.value && Array.isArray(usage.value.agents) ? usage.value.agents : []))
// The highest fresh window, for the icon's colour.
const worst = computed(() => {
  let max = -1
  for (const a of agents.value) for (const w of a.windows || []) if (!w.stale && w.usedPct > max) max = w.usedPct
  return max
})
const level = (pct) => (pct >= 95 ? 'bad' : pct >= 80 ? 'warn' : 'ok')

function resetText(iso) {
  if (!iso) return ''
  const ms = Date.parse(iso) - Date.now()
  if (!(ms > 0)) return 'reset time passed'
  const min = Math.round(ms / 60000)
  if (min < 60) return `resets in ${min} min`
  if (min < 48 * 60) return `resets in ${Math.floor(min / 60)} h ${min % 60} min`
  return `resets ${new Date(iso).toLocaleDateString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`
}
function windowLabel(l) {
  return l === '5h' ? '5-hour' : l === 'week' ? 'Weekly' : l
}

function onDocDown(e) {
  if (open.value && root.value && !root.value.contains(e.target)) open.value = false
}
onMounted(() => {
  document.addEventListener('pointerdown', onDocDown, true)
  load()
  timer = setInterval(load, 60000)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocDown, true)
  clearInterval(timer)
})
function toggle() {
  open.value = !open.value
  if (open.value) load()
}
</script>

<template>
  <div ref="root" class="notif-wrap">
    <button
      class="tb-icon"
      :class="[{ on: open }, worst >= 0 ? 'usage-' + level(worst) : '']"
      :title="worst >= 0 ? `Usage: up to ${Math.round(worst)}% of a quota used` : 'Usage of your agents’ quotas'"
      aria-label="Usage"
      :aria-expanded="open"
      data-test="usage-button"
      @click="toggle"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M2.5 11.5a5.5 5.5 0 1111 0" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
        <path d="M8 11.5l2.6-3.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
      </svg>
    </button>
    <div v-if="open" class="notif-menu usage-menu" role="dialog" aria-label="Usage">
      <div class="notif-head"><span>Usage of your subscriptions</span></div>
      <p v-if="usage && usage.error" class="notif-empty">Could not read the usage: {{ usage.error }}</p>
      <p v-else-if="!agents.length" class="notif-empty">Reading…</p>
      <div v-for="a in agents" :key="a.id" class="usage-agent" data-test="usage-agent">
        <div class="usage-agent-head">
          <BrandIcon :kind="a.id" :size="14" />
          <span class="usage-agent-name">{{ NAMES[a.id] || a.id }}</span>
          <span v-if="a.stale && a.windows && a.windows.length" class="usage-stale">last seen {{ a.observedAt ? new Date(a.observedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '' }}</span>
        </div>
        <p v-if="!a.windows || !a.windows.length" class="usage-none">
          {{ a.error || 'Not available: its quota is not saved on this computer.' }}
        </p>
        <div v-for="w in a.windows" :key="w.label" class="usage-window" :class="{ stale: w.stale }">
          <div class="usage-line">
            <span>{{ windowLabel(w.label) }}</span>
            <span class="usage-pct">{{ Math.round(w.usedPct) }}%</span>
          </div>
          <div class="usage-bar"><div class="usage-fill" :class="level(w.usedPct)" :style="{ width: Math.min(100, w.usedPct) + '%' }"></div></div>
          <div class="usage-reset">{{ resetText(w.resetsAt) }}</div>
        </div>
      </div>
    </div>
  </div>
</template>
