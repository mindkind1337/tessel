<script setup>
// One agent or terminal in a workspace card, ported from Orca's
// CompactAgentRow (sidebar/worktree-card-compact-agent-row.tsx; MIT,
// Copyright (c) 2026 Lovecast Inc.): state glyph, agent icon, "prompt -
// what it does", its age; the pane you are in is filled. Tessel adds the
// pane number and its team marks (lead, unread team messages, tools down).
// A Claude Code row lists its conversation's sub-agents under it, folded by
// a chevron in the card gutter like Orca's child agents.
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { ChevronRight } from 'lucide-vue-next'
import BrandIcon from '../BrandIcon.vue'
import AgentStateDot from './AgentStateDot.vue'
import { acquireChildren, childrenKey, splitChildren, childDotState } from '../../agentChildrenFeed'
import { childTime, formatTokens } from '../../agentChildrenView'
import { childrenFolded, olderShown } from './agentRowState'
import { t } from '../../i18n'

const props = defineProps({
  row: { type: Object, required: true },
  picking: { type: Boolean, default: false },
  picked: { type: Boolean, default: false },
  pickable: { type: Boolean, default: true },
  title: { type: String, default: '' },
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
  return tokens ? t('sidebar.agentRow.stats', '{{time}} · ↓ {{tokens}} tokens', { time, tokens }) : time
}
function childTitle(c, state) {
  return `${c.title || noTitle()}\n${c.type || ''} · ${state}`
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
function unreadTitle(count) {
  return count > 1
    ? t('sidebar.agentRow.unread', '{{count}} team messages this agent has not read yet (it reads them with its team tools)', { count })
    : t('sidebar.agentRow.unread', '{{count}} team message this agent has not read yet (it reads them with its team tools)', { count })
}
</script>

<template>
  <div
    class="compact-agent-row worktree-agent-row-hover"
    :class="{ picked, unpickable: picking && !pickable, 'worktree-agent-lineage-parent-row': hasChildren }"
    :data-focused-agent-pane="row.focused ? 'true' : undefined"
    :data-pane-id="row.id"
    :title="title"
    role="button"
    tabindex="-1"
    :aria-expanded="hasChildren ? !folded : undefined"
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
    <AgentStateDot :state="row.dotState" />
    <span class="car-icon">
      <BrandIcon :kind="row.iconKind" :accent="row.accent" :label="row.kind === 'agent' ? row.title : null" :size="13" />
    </span>
    <span class="car-text">
      <span class="car-lead" :class="{ unvisited: row.unvisited, focused: row.focused && !row.unvisited }">{{ row.primary }}</span>
      <span v-if="row.secondary" class="car-trail" :class="['track-' + (row.trackLevel || ''), { focused: row.focused }]">
        - {{ row.secondary }}</span
      >
    </span>
    <span v-if="row.lead" class="car-tag" :title="t('sidebar.agentRow.leadHint', 'Leads the team')">{{ t('sidebar.agentRow.lead', 'lead') }}</span>
    <span
      v-if="row.teamUnread"
      class="car-tag"
      :title="unreadTitle(row.teamUnread)"
      >✉ {{ row.teamUnread }}</span
    >
    <span
      v-if="row.toolsDown"
      class="car-tag"
      :title="t('sidebar.agentRow.toolsDownHint', 'Its team tools (tessel-team) are not connected: it cannot read or send team messages. Restart it (right-click its pane, Restart).')"
      >⚠ {{ t('sidebar.agentRow.toolsDown', 'tools') }}</span
    >
    <span v-if="hasChildren && folded" class="car-time" :class="{ focused: row.focused }">+{{ children.length }}</span>
    <span v-if="row.time" class="car-time" :class="{ focused: row.focused }">{{ row.time }}</span>
    <span v-if="row.num" class="car-num" :class="{ focused: row.focused }">{{ row.num }}</span>
  </div>
  <div v-if="hasChildren && !folded" class="worktree-agent-lineage-children" role="group" :aria-label="t('sidebar.agentRow.subAgentsOf', 'Sub-agents of {{name}}', { name: row.title })">
    <div
      v-for="c in split.shown"
      :key="c.id"
      class="compact-agent-row worktree-agent-row-hover worktree-agent-lineage-child-row"
      :class="'child-' + c.state"
      :title="childTitle(c, stateTitle(c.state))"
      data-agent-child=""
      @click.stop="emit('activate', row)"
    >
      <AgentStateDot :state="childDotState(c)" :title="stateTitle(c.state)" />
      <span class="car-text">
        <span class="car-lead">{{ c.title || noTitle() }}</span>
        <span v-if="c.type" class="car-trail"> - {{ c.type }}</span>
      </span>
      <span class="car-time">{{ childStats(c) }}</span>
    </div>
    <template v-if="showOlder">
      <div
        v-for="c in split.older"
        :key="c.id"
        class="compact-agent-row worktree-agent-row-hover worktree-agent-lineage-child-row child-done"
        :title="childTitle(c, t('sidebar.agentRow.finished', 'Finished'))"
        data-agent-child=""
        @click.stop="emit('activate', row)"
      >
        <AgentStateDot :state="childDotState(c)" :title="t('sidebar.agentRow.finished', 'Finished')" />
        <span class="car-text">
          <span class="car-lead">{{ c.title || noTitle() }}</span>
          <span v-if="c.type" class="car-trail"> - {{ c.type }}</span>
        </span>
        <span class="car-time">{{ childStats(c) }}</span>
      </div>
    </template>
    <button v-if="split.older.length" type="button" class="child-more" @click="toggleOlder">
      {{ showOlder ? t('sidebar.agentRow.showLess', 'Show less') : moreLabel(split.older.length) }}
    </button>
  </div>
</template>
