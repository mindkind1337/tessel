<script setup>
// One agent or terminal in a workspace card, ported from Orca's
// CompactAgentRow (sidebar/worktree-card-compact-agent-row.tsx; MIT,
// Copyright (c) 2026 Lovecast Inc.): state glyph, agent icon, "prompt -
// what it does", its age; the pane you are in is filled. Tessel adds the
// pane number and its team marks (lead, unread team messages, tools down).
// A Claude Code or Codex row lists its conversation's sub-agents under it
// (each with its type and model as small tags), folded by
// a chevron in the card gutter like Orca's child agents.
// Hovering the row (or a sub-agent) opens a hover card with its details
// instead of a native tooltip (HoverCardContent, AgentHoverDetails).
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { ChevronRight } from 'lucide-vue-next'
import BrandIcon from '../BrandIcon.vue'
import AgentStateDot from './AgentStateDot.vue'
import AgentHoverDetails from './AgentHoverDetails.vue'
import HoverCardContent from '../hover/HoverCardContent.vue'
import { useHoverCard } from '../hover/useHoverCard'
import { acquireChildren, childrenKey, splitChildren, childDotState } from '../../agentChildrenFeed'
import { childTime, formatTokens } from '../../agentChildrenView'
import { modelLabel } from '../../../../shared/modelLabel'
import { childrenFolded, olderShown } from './agentRowState'
import { t } from '../../i18n'

const props = defineProps({
  row: { type: Object, required: true },
  picking: { type: Boolean, default: false },
  picked: { type: Boolean, default: false },
  pickable: { type: Boolean, default: true },
  // Why the row can or cannot be ticked while picking a team.
  pickHint: { type: String, default: '' },
  teamLabel: { type: String, default: '' },
  now: { type: Number, default: () => Date.now() }
})
const emit = defineEmits(['activate', 'context'])

// --- Sub-agents ------------------------------------------------------------
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
const split = computed(() => splitChildren(children.value, clock.value))
const hasChildren = computed(() => children.value.length > 0)
const folded = computed(() => !!childrenFolded[props.row.id])
const showOlder = computed(() => !!olderShown[props.row.id])
const running = computed(() => children.value.filter((c) => c.state === 'running').length)
watch(
  () => running.value > 0 && !folded.value,
  (tick) => {
    clearInterval(clockTimer)
    clockTimer = tick ? setInterval(() => (clock.value = Date.now()), 1000) : 0
  },
  { immediate: true }
)
watch(
  () => [props.now, feed.value && feed.value.state.at],
  () => (clock.value = Date.now())
)
onBeforeUnmount(() => clearInterval(clockTimer))

function toggleChildren(e) {
  e.stopPropagation()
  childrenFolded[props.row.id] = !folded.value
}
function toggleOlder(e) {
  e.stopPropagation()
  olderShown[props.row.id] = !showOlder.value
}
function stateTitle(state) {
  if (state === 'running') return t('sidebar.agentRow.running', 'Running')
  if (state === 'done') return t('sidebar.agentRow.finished', 'Finished')
  if (state === 'quiet') return t('sidebar.agentRow.quiet', 'Quiet: nothing written for a while (a long tool, or stopped)')
  return state
}
function childStats(c) {
  const time = childTime(c, clock.value)
  const tokens = formatTokens(c.tokens)
  return tokens ? t('sidebar.agentRow.stats', '{{time}} · ↓ {{tokens}}', { time, tokens }) : time
}
// In the hover card there is room: the word "tokens" is spelled out.
function childStatsLong(c) {
  const time = childTime(c, clock.value)
  const tokens = formatTokens(c.tokens)
  return tokens ? t('sidebar.agentRow.statsLong', '{{time}} · ↓ {{tokens}} tokens', { time, tokens }) : time
}
function childTitle(c, state) {
  return c.type ? `${c.title || noTitle()}, ${c.type} · ${state}` : `${c.title || noTitle()}, ${state}`
}
function noTitle() {
  return t('sidebar.agentRow.noTitle', '(no title)')
}
const disclosureLabel = computed(() => {
  const count = children.value.length
  if (folded.value)
    return count === 1
      ? t('sidebar.agentRow.showChildren', 'Show {{count}} child agent', { count })
      : t('sidebar.agentRow.showChildren', 'Show {{count}} child agents', { count })
  return count === 1
    ? t('sidebar.agentRow.hideChildren', 'Hide {{count}} child agent', { count })
    : t('sidebar.agentRow.hideChildren', 'Hide {{count}} child agents', { count })
})
function moreLabel(count) {
  return t('sidebar.agentRow.more', '{{count}} more', { count })
}

// --- Hover cards (Orca's HoverCard: opens after 250 ms, closes 120 ms) --------
// The row's card; its sub-agents share a second one (their rows own it).
const rowHover = useHoverCard()
const childHover = useHoverCard()
const hoveredChild = ref(null)
function pickChild(e) {
  const id = e.currentTarget && e.currentTarget.dataset.childId
  const c = children.value.find((x) => x.id === id)
  if (c) hoveredChild.value = c
}
const childListeners = {
  ...childHover.triggerListeners,
  pointerover(e) {
    pickChild(e)
    childHover.triggerListeners.pointerover(e)
  },
  focusin(e) {
    pickChild(e)
    childHover.triggerListeners.focusin(e)
  }
}
const childState = computed(() => {
  const c = hoveredChild.value
  if (!c) return ''
  return split.value.older.includes(c) ? t('sidebar.agentRow.finished', 'Finished') : stateTitle(c.state)
})
// What the old native tooltip said, for screen readers.
const rowLabel = computed(() => {
  const r = props.row
  const team = props.teamLabel || r.team
  const parts = [[r.primary, r.subline, r.secondary].filter(Boolean).join(' - ')]
  if (r.stateLabel && r.stateLabel !== r.secondary) parts.push(r.stateLabel)
  if (r.team)
    parts.push(
      r.lead ? t('sidebar.card.teamLead', 'Team: {{team}} (lead)', { team }) : t('sidebar.card.team', 'Team: {{team}}', { team })
    )
  if (r.num) parts.push(t('sidebar.card.pane', 'Pane {{num}}', { num: r.num }))
  if (props.picking && props.pickHint) parts.push(props.pickHint)
  return parts.join(', ')
})
</script>

<template>
  <div
    class="compact-agent-row worktree-agent-row-hover"
    :class="{ picked, unpickable: picking && !pickable, 'worktree-agent-lineage-parent-row': hasChildren }"
    :data-focused-agent-pane="row.focused ? 'true' : undefined"
    :data-pane-id="row.id"
    role="button"
    tabindex="-1"
    :aria-label="rowLabel"
    :aria-expanded="hasChildren ? !folded : undefined"
    v-on="rowHover.triggerListeners"
    @click.stop="emit('activate', row)"
    @contextmenu.prevent.stop="emit('context', row, $event)"
  >
    <button
      v-if="hasChildren"
      type="button"
      class="compact-agent-child-disclosure-button"
      :aria-label="disclosureLabel"
      :aria-expanded="!folded"
      @click="toggleChildren"
    >
      <ChevronRight :size="12" :class="{ open: !folded }" aria-hidden="true" />
    </button>
    <span v-if="picking" class="car-pick" :class="{ on: picked }" aria-hidden="true"></span>
    <AgentStateDot :state="row.dotState" :tooltip="false" />
    <span class="car-icon">
      <BrandIcon :kind="row.iconKind" :accent="row.accent" :label="row.kind === 'agent' ? row.title : null" :size="13" />
    </span>
    <span class="car-text">
      <span class="car-lead" :class="{ unvisited: row.unvisited, focused: row.focused && !row.unvisited }">{{ row.primary }}</span>
      <span v-if="row.secondary" class="car-trail" :class="['track-' + (row.trackLevel || ''), { focused: row.focused }]">
        - {{ row.secondary }}</span
      >
    </span>
    <span v-if="row.lead" class="car-tag">{{ t('sidebar.agentRow.lead', 'lead') }}</span>
    <span v-if="row.teamUnread" class="car-tag">✉ {{ row.teamUnread }}</span>
    <span v-if="row.toolsDown" class="car-tag">⚠ {{ t('sidebar.agentRow.toolsDown', 'tools') }}</span>
    <span v-if="hasChildren && folded" class="car-time" :class="{ focused: row.focused }">+{{ children.length }}</span>
    <span v-if="row.time" class="car-time" :class="{ focused: row.focused }">{{ row.time }}</span>
    <span v-if="row.num" class="car-num" :class="{ focused: row.focused }">{{ row.num }}</span>
  </div>
  <!-- The task on its own line under the agent (the row keeps its space). -->
  <div
    v-if="row.subline"
    class="car-subline"
    :class="{ focused: row.focused, nested: hasChildren || picking }"
    aria-hidden="true"
    @click.stop="emit('activate', row)"
    @contextmenu.prevent.stop="emit('context', row, $event)"
  >
    {{ row.subline }}
  </div>
  <div v-if="hasChildren && !folded" class="worktree-agent-lineage-children" role="group" :aria-label="t('sidebar.agentRow.subAgentsOf', 'Sub-agents of {{name}}', { name: row.title })">
    <div
      v-for="c in split.shown"
      :key="c.id"
      class="compact-agent-row worktree-agent-row-hover worktree-agent-lineage-child-row"
      :class="'child-' + c.state"
      role="button"
      tabindex="-1"
      :aria-label="childTitle(c, stateTitle(c.state))"
      :data-child-id="c.id"
      data-agent-child=""
      v-on="childListeners"
      @click.stop="emit('activate', row)"
    >
      <AgentStateDot :state="childDotState(c)" :title="stateTitle(c.state)" :tooltip="false" />
      <span class="car-text">
        <span class="car-lead">{{ c.title || noTitle() }}</span>
      </span>
      <span v-if="c.type" class="car-tag car-child-type" data-child-type="">{{ c.type }}</span>
      <span v-if="c.model" class="car-tag car-child-model" data-child-model="">{{ modelLabel(c.model) }}</span>
      <span class="car-time">{{ childStats(c) }}</span>
    </div>
    <template v-if="showOlder">
      <div
        v-for="c in split.older"
        :key="c.id"
        class="compact-agent-row worktree-agent-row-hover worktree-agent-lineage-child-row child-done"
        role="button"
        tabindex="-1"
        :aria-label="childTitle(c, t('sidebar.agentRow.finished', 'Finished'))"
        :data-child-id="c.id"
        data-agent-child=""
        v-on="childListeners"
        @click.stop="emit('activate', row)"
      >
        <AgentStateDot :state="childDotState(c)" :title="t('sidebar.agentRow.finished', 'Finished')" :tooltip="false" />
        <span class="car-text">
          <span class="car-lead">{{ c.title || noTitle() }}</span>
        </span>
        <span v-if="c.type" class="car-tag car-child-type" data-child-type="">{{ c.type }}</span>
        <span v-if="c.model" class="car-tag car-child-model" data-child-model="">{{ modelLabel(c.model) }}</span>
        <span class="car-time">{{ childStats(c) }}</span>
      </div>
    </template>
    <button v-if="split.older.length" type="button" class="child-more" @click="toggleOlder">
      {{ showOlder ? t('sidebar.agentRow.showLess', 'Show less') : moreLabel(split.older.length) }}
    </button>
  </div>
  <HoverCardContent :hc="rowHover" class="agent-hover-card">
    <AgentHoverDetails
      :row="row"
      :team-label="teamLabel"
      :pick-hint="picking ? pickHint : ''"
      :child-count="children.length"
      :running-count="running"
    />
  </HoverCardContent>
  <HoverCardContent v-if="hoveredChild" :hc="childHover" class="agent-hover-card">
    <div class="hc-body" data-agent-child-hover="">
      <div class="hc-identity">
        <div class="hc-title">{{ hoveredChild.title || noTitle() }}</div>
      </div>
      <div class="hc-status">
        <AgentStateDot :state="childDotState(hoveredChild)" :tooltip="false" />
        <span class="hc-status-label" v-text="childState"></span>
      </div>
      <div v-if="hoveredChild.type" class="hc-detail" data-hover-type="" v-text="t('sidebar.agentRow.childType', 'Type: {{type}}', { type: hoveredChild.type })"></div>
      <div v-if="hoveredChild.model" class="hc-detail" data-hover-model="" v-text="t('sidebar.agentRow.childModel', 'Model: {{model}}', { model: modelLabel(hoveredChild.model) })"></div>
      <div class="hc-detail" v-text="childStatsLong(hoveredChild)"></div>
    </div>
  </HoverCardContent>
</template>
