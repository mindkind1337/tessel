<script setup>
// A Dashboard card's sub-agents (Claude Code, Codex, OpenCode, Cline): a
// compact line "3 sub-agents · 2 running" with a small dot per sub-agent,
// and, on hover or focus, the list (name, type, state, time, tokens). Same
// feed and rules as the sidebar's agent row (CompactAgentRow.vue,
// agentChildrenFeed.js): one poll per conversation however many places show
// it, released when the card goes; a sub-agent counts as running only while
// it really can be (childActive). The card's own state is not changed by
// them, as in the sidebar.
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import AgentStateDot from './sidebar/AgentStateDot.vue'
import HoverCardContent from './hover/HoverCardContent.vue'
import { useHoverCard } from './hover/useHoverCard'
import { acquireChildren, childrenKey, splitChildren, childDotState } from '../agentChildrenFeed'
import { childTime, formatTokens, childActive } from '../agentChildrenView'
import { turnEndedSince } from '../agentStatus'
import { modelLabel } from '../../../shared/modelLabel'
import { t } from '../i18n'

const props = defineProps({
  // A sidebarModel.js paneRow (its `children` is the feed spec, or null).
  row: { type: Object, required: true }
})

const MAX_DOTS = 6
const MAX_LISTED = 12

const feed = ref(null)
watch(
  () => childrenKey(props.row.children || {}),
  () => {
    if (feed.value) feed.value.release()
    feed.value = props.row.children ? acquireChildren(props.row.children) : null
  },
  { immediate: true }
)
onBeforeUnmount(() => feed.value && feed.value.release())

const clock = ref(Date.now())
let clockTimer = 0
const children = computed(() => (feed.value ? feed.value.state.list : []))
const parentIdleSince = computed(() => (props.row.kind === 'agent' ? turnEndedSince(props.row.id) : null))
const ctx = computed(() => ({ now: clock.value, parentIdleSince: parentIdleSince.value }))
const split = computed(() => splitChildren(children.value, ctx.value))
const ordered = computed(() => [...split.value.shown, ...split.value.older])
const running = computed(() => children.value.filter((c) => childActive(c, ctx.value)).length)
// Times count while one runs and the list is open.
const hover = useHoverCard()
watch(
  () => running.value > 0 && hover.open.value,
  (tick) => {
    clearInterval(clockTimer)
    clockTimer = tick ? setInterval(() => (clock.value = Date.now()), 1000) : 0
  },
  { immediate: true }
)
watch(
  () => feed.value && feed.value.state.at,
  () => (clock.value = Date.now())
)
onBeforeUnmount(() => clearInterval(clockTimer))

const summary = computed(() => {
  const count = children.value.length
  const head =
    count === 1 ? t('agentDashboard.children.count', '{{count}} sub-agent', { count }) : t('agentDashboard.children.count', '{{count}} sub-agents', { count })
  return running.value ? t('agentDashboard.children.summary', '{{head}} · {{running}} running', { head, running: running.value }) : head
})
const dots = computed(() => ordered.value.slice(0, MAX_DOTS))
const listed = computed(() => ordered.value.slice(0, MAX_LISTED))
const more = computed(() => Math.max(0, ordered.value.length - MAX_LISTED))

function stateWord(state) {
  if (state === 'running') return t('sidebar.agentRow.running', 'Running')
  if (state === 'done') return t('sidebar.agentRow.finished', 'Finished')
  if (state === 'quiet') return t('agentDashboard.children.quiet', 'Quiet')
  return state
}
function childLine(c) {
  const parts = [stateWord(c.state)]
  const time = childTime(c, clock.value)
  if (time) parts.push(time)
  const tokens = formatTokens(c.tokens)
  if (tokens) parts.push(t('agentDashboard.children.tokens', '↓ {{tokens}} tokens', { tokens }))
  if (c.model) parts.push(modelLabel(c.model))
  return parts.join(' · ')
}
function noTitle() {
  return t('sidebar.agentRow.noTitle', '(no title)')
}
</script>

<template>
  <span
    v-if="children.length"
    class="adb-children"
    data-test="adb-children"
    tabindex="-1"
    :aria-label="summary"
    v-on="hover.triggerListeners"
  >
    <span class="adb-children-dots" aria-hidden="true">
      <AgentStateDot v-for="c in dots" :key="c.id" :state="childDotState(c)" :tooltip="false" />
    </span>
    <span class="adb-children-text" v-text="summary"></span>
  </span>
  <HoverCardContent v-if="children.length" :hc="hover" side="bottom" align="start" class="agent-hover-card" data-test="adb-children-card">
    <div class="hc-body adb-children-card">
      <div class="hc-title" v-text="summary"></div>
      <ul class="adb-children-list">
        <li v-for="c in listed" :key="c.id" class="adb-child" data-test="adb-child">
          <AgentStateDot :state="childDotState(c)" :tooltip="false" />
          <span class="adb-child-text">
            <span class="adb-child-title">{{ c.title || noTitle() }}<template v-if="c.type"> · {{ c.type }}</template></span>
            <span class="adb-child-sub" v-text="childLine(c)"></span>
          </span>
        </li>
      </ul>
      <div v-if="more" class="hc-hint" v-text="t('sidebar.agentRow.more', '+ {{count}} more', { count: more })"></div>
    </div>
  </HoverCardContent>
</template>
