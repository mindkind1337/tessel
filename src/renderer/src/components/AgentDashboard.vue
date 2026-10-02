<script setup>
// The Dashboard tab of the right side panel: every agent of every project at
// a glance (terminal agents and chat agents). A total with a line per state,
// a thin bar coloured by state, a Status / Project grouping, filter chips, a
// search box, and "Sleep idle" (Tessel's sleep: the conversation is kept,
// opening the pane wakes it). Each agent is a small card; a click brings its
// pane to the front (its project and worktree view too).
// The rows come from the left sidebar's own data (App's sidebarProjects,
// sidebarModel.js paneRow), so both always agree.
import { computed, inject } from 'vue'
import { Search, X, Moon } from 'lucide-vue-next'
import BrandIcon from './BrandIcon.vue'
import AgentStateDot from './sidebar/AgentStateDot.vue'
import { isAgentPane, paneRow } from '../sidebarModel'
import { buildDashboard, dashboardBucket, DASHBOARD_STATES, dashboardView } from '../agentDashboard'
import { t } from '../i18n'
import './agentDashboard.css'

const props = defineProps({
  // App's sidebarProjects: [{ id, name, panes: [...] }].
  projects: { type: Array, default: () => [] },
  now: { type: Number, default: () => Date.now() }
})
const emit = defineEmits(['focus-pane', 'sleep'])

const askConfirm = inject('askConfirm', null)

// Grouping, filter and search: kept while Tessel runs (the tab is created
// again when the panel reopens).
const view = dashboardView

const rows = computed(() => {
  const out = []
  for (const p of props.projects || []) {
    for (const pane of p.panes || []) {
      if (!isAgentPane(pane)) continue
      const row = paneRow(pane, props.now)
      out.push({ ...row, projectId: p.id, projectName: p.name || '', branch: pane.copyBranch || '' })
    }
  }
  return out
})
const board = computed(() => buildDashboard(rows.value, { filter: view.filter, query: view.query, groupBy: view.groupBy }))

function stateName(state) {
  switch (state) {
    case 'waiting':
      return t('agentDashboard.state.waiting', 'Waiting for you')
    case 'working':
      return t('agentDashboard.state.working', 'Working')
    case 'done':
      return t('agentDashboard.state.done', 'Done')
    case 'sleeping':
      return t('agentDashboard.state.sleeping', 'Sleeping')
  }
  return t('agentDashboard.state.idle', 'Idle')
}
function stateWord(state, count) {
  switch (state) {
    case 'waiting':
      return t('agentDashboard.count.waiting', '{{count}} waiting', { count })
    case 'working':
      return t('agentDashboard.count.working', '{{count}} working', { count })
    case 'done':
      return t('agentDashboard.count.done', '{{count}} done', { count })
    case 'sleeping':
      return t('agentDashboard.count.sleeping', '{{count}} sleeping', { count })
  }
  return t('agentDashboard.count.idle', '{{count}} idle', { count })
}
const total = computed(() => rows.value.length)
const totalLabel = computed(() =>
  total.value === 1 ? t('agentDashboard.total', '{{count}} agent', { count: 1 }) : t('agentDashboard.total', '{{count}} agents', { count: total.value })
)
const summary = computed(() =>
  DASHBOARD_STATES.filter((s) => board.value.counts[s])
    .map((s) => stateWord(s, board.value.counts[s]))
    .join(' · ')
)
const bar = computed(() =>
  total.value ? DASHBOARD_STATES.filter((s) => board.value.counts[s]).map((s) => ({ state: s, pct: (board.value.counts[s] / total.value) * 100 })) : []
)
const chips = computed(() => [
  { id: 'all', label: t('agentDashboard.filter.all', 'All'), count: total.value },
  ...DASHBOARD_STATES.filter((s) => s !== 'sleeping' || board.value.counts.sleeping).map((s) => ({ id: s, label: stateName(s), count: board.value.counts[s] || 0 }))
])

function groupTitle(g) {
  return view.groupBy === 'project' ? g.label || t('agentDashboard.noProject', 'No project') : stateName(g.key)
}
function cardTitle(r) {
  return r.subline || r.primary
}
function cardSub(r) {
  const agent = r.typeLabel && r.typeLabel !== cardTitle(r) ? r.typeLabel : r.subline ? r.primary : ''
  const where = r.branch ? t('agentDashboard.card.where', '{{project}} · {{branch}}', { project: r.projectName, branch: r.branch }) : r.projectName
  return agent ? t('agentDashboard.card.sub', '{{agent}} · {{project}}', { agent, project: where }) : where
}
function pill(r) {
  const name = stateName(r.bucket)
  return r.time && r.bucket !== 'idle' && r.bucket !== 'sleeping'
    ? t('agentDashboard.card.pill', '{{state}} {{time}}', { state: name, time: r.time })
    : name
}

// Idle terminal agents that can sleep (a chat has no sleep; the pane you are
// in stays awake: App's sleepPanes says why when it skips one).
const sleepable = computed(() => rows.value.filter((r) => dashboardBucket(r) === 'idle' && !r.chat && !r.focused))
// Esc in the search box clears it first (then a fullscreen panel restores).
function clearOnEsc(e) {
  if (!view.query) return
  e.preventDefault()
  view.query = ''
}
const sleepLabel = computed(() => t('agentDashboard.sleep.button', 'Sleep idle ({{count}})', { count: sleepable.value.length }))
async function sleepIdle() {
  const ids = sleepable.value.map((r) => r.id)
  if (!ids.length) return
  const ok = askConfirm
    ? await askConfirm({
        title: t('agentDashboard.sleep.title', 'Put idle agents to sleep?'),
        text:
          ids.length === 1
            ? t('agentDashboard.sleep.textOne', '1 idle agent goes to sleep: its terminal closes, its conversation is kept. Open its pane to wake it.')
            : t('agentDashboard.sleep.text', '{{count}} idle agents go to sleep: their terminals close, their conversations are kept. Open a pane to wake it.', {
                count: ids.length
              }),
        confirmLabel: t('agentDashboard.sleep.confirm', 'Sleep')
      })
    : true
  if (ok === true) emit('sleep', ids)
}
</script>

<template>
  <div class="adb" data-test="agent-dashboard">
    <div class="adb-head">
      <div class="adb-head-row">
        <div class="adb-head-text">
          <div class="adb-total" data-test="adb-total">{{ totalLabel }}</div>
          <div v-if="summary" class="adb-summary" data-test="adb-summary">{{ summary }}</div>
        </div>
        <div class="adb-group-switch" role="radiogroup" :aria-label="t('agentDashboard.groupBy', 'Group by')">
          <button
            type="button"
            class="adb-group-btn"
            :class="{ on: view.groupBy === 'status' }"
            role="radio"
            :aria-checked="view.groupBy === 'status'"
            data-test="adb-group-status"
            @click="view.groupBy = 'status'"
          >
            {{ t('agentDashboard.byStatus', 'Status') }}
          </button>
          <button
            type="button"
            class="adb-group-btn"
            :class="{ on: view.groupBy === 'project' }"
            role="radio"
            :aria-checked="view.groupBy === 'project'"
            data-test="adb-group-project"
            @click="view.groupBy = 'project'"
          >
            {{ t('agentDashboard.byProject', 'Project') }}
          </button>
        </div>
      </div>
      <div v-if="bar.length" class="adb-bar" aria-hidden="true" data-test="adb-bar">
        <span v-for="seg in bar" :key="seg.state" class="adb-bar-seg" :class="'adb-' + seg.state" :style="{ width: seg.pct + '%' }"></span>
      </div>
      <div class="adb-chips" role="tablist" :aria-label="t('agentDashboard.filterLabel', 'Show')">
        <button
          v-for="c in chips"
          :key="c.id"
          type="button"
          class="adb-chip"
          :class="{ on: view.filter === c.id }"
          role="tab"
          :aria-selected="view.filter === c.id"
          :data-test="'adb-chip-' + c.id"
          @click="view.filter = c.id"
        >
          <span v-if="c.id !== 'all'" class="adb-chip-dot" :class="'adb-' + c.id" aria-hidden="true"></span>
          {{ c.label }}
          <span class="adb-chip-count">{{ c.count }}</span>
        </button>
      </div>
      <div class="adb-tools">
        <label class="adb-search">
          <Search :size="13" class="adb-search-icon" aria-hidden="true" />
          <input
            v-model="view.query"
            class="adb-search-input"
            type="search"
            spellcheck="false"
            :placeholder="t('agentDashboard.search', 'Search agents, tasks, projects')"
            :aria-label="t('agentDashboard.search', 'Search agents, tasks, projects')"
            data-test="adb-search"
            @keydown.escape="clearOnEsc"
          />
          <button
            v-if="view.query"
            type="button"
            class="adb-search-clear"
            :aria-label="t('agentDashboard.clearSearch', 'Clear search')"
            @click="view.query = ''"
          >
            <X :size="12" aria-hidden="true" />
          </button>
        </label>
        <button
          type="button"
          class="adb-sleep"
          :disabled="!sleepable.length"
          :title="t('agentDashboard.sleep.hint', 'Puts idle terminal agents to sleep: their conversations are kept, opening a pane wakes it')"
          data-test="adb-sleep-idle"
          @click="sleepIdle"
        >
          <Moon :size="12" aria-hidden="true" />
          <span v-text="sleepLabel"></span>
        </button>
      </div>
    </div>

    <div class="adb-body">
      <div v-if="!total" class="adb-empty" data-test="adb-empty">
        <div class="adb-empty-title">{{ t('agentDashboard.empty', 'No agents yet') }}</div>
        <div class="adb-empty-hint">{{ t('agentDashboard.emptyHint', 'Agents you start in any project show up here.') }}</div>
      </div>
      <div v-else-if="!board.groups.length" class="adb-empty" data-test="adb-no-match">
        <div class="adb-empty-hint">{{ t('agentDashboard.noMatch', 'No agent matches.') }}</div>
      </div>
      <section v-for="g in board.groups" :key="g.key" class="adb-group" :data-test="'adb-section-' + g.key">
        <h3 class="adb-group-title">
          <span v-if="view.groupBy === 'status'" class="adb-chip-dot" :class="'adb-' + g.key" aria-hidden="true"></span>
          <span class="adb-group-name">{{ groupTitle(g) }}</span>
          <span class="adb-group-count">{{ g.rows.length }}</span>
        </h3>
        <div class="adb-grid">
          <button
            v-for="r in g.rows"
            :key="r.id"
            type="button"
            class="adb-card"
            :class="{ focused: r.focused, unvisited: r.unvisited }"
            :title="[cardTitle(r), cardSub(r), pill(r)].join('\n')"
            data-test="adb-card"
            :data-pane-id="r.id"
            @click="emit('focus-pane', r.id)"
          >
            <span class="adb-card-icon">
              <BrandIcon :kind="r.iconKind" :accent="r.accent" :label="r.title" :size="18" />
              <span class="adb-card-dot"><AgentStateDot :state="r.sleeping ? 'sleeping' : r.dotState" :tooltip="false" /></span>
            </span>
            <span class="adb-card-text">
              <span class="adb-card-title">{{ cardTitle(r) }}</span>
              <span class="adb-card-sub">{{ cardSub(r) }}</span>
            </span>
            <span class="adb-pill" :class="'adb-pill-' + r.bucket" data-test="adb-pill">{{ pill(r) }}</span>
          </button>
        </div>
      </section>
    </div>
  </div>
</template>
