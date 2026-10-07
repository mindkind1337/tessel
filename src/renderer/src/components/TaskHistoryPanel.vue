<script setup>
// Task history (a tab of the right side panel): every finished task, from
// its record (taskHistory.js; kept after the card is deleted), with when it
// was done, who did it, the project, its time in Doing, its tokens and its
// estimated cost. Filters (period, project, agent, title), sort (date, cost,
// time), totals of what is shown, a row's details (work periods, cost per
// model) and a CSV export. The figures are read through
// window.shellApi.jobCost.forCards in batches, only while the tab is shown,
// and kept in the records (taskHistoryView.js). Each row is a component of
// its own (TaskHistoryRow.vue) and only the rows in view are drawn: opening
// one re-renders that row, not hundreds.
import { ref, computed, watch, onBeforeUnmount, onUpdated, nextTick } from 'vue'
import { History, Download, Search } from 'lucide-vue-next'
import ThemedSelect from './ui/ThemedSelect.vue'
import TaskHistoryRow from './TaskHistoryRow.vue'
import { taskHistory } from '../taskHistory'
import { boardState } from '../taskBoardStore'
import PanelState from './ui/PanelState.vue'
import { filterHistory, sortHistory, historyTotals, filterOptions, historyCsv, loadHistoryCosts, forgetAsked, rowTops, visibleRange, PERIODS, ROW_ESTIMATE, VIRTUAL_MIN } from '../taskHistoryView'
import { formatTokens } from '../jobCost'
import { duration, tokensTitle, estimateHint, usdText } from '../taskHistoryText'
import { t } from '../i18n'
import './sessionHistory.css'

const props = defineProps({
  // App's sidebarProjects: which agent panes still exist.
  projects: { type: Array, default: () => [] },
  // The tab is shown: the figures are read only then.
  active: { type: Boolean, default: false },
  now: { type: Number, default: () => Date.now() },
  // The workspace shown: its own tasks by default, All for every workspace.
  workspaceId: { type: String, default: null }
})
const emit = defineEmits(['focus-pane'])

const scope = ref('workspace')
const period = ref('all')
const project = ref('')
const agent = ref('')
const query = ref('')
const sortBy = ref('date')
const openId = ref(null)

const PERIOD_LABELS = {
  today: () => t('taskHistory.period.today', 'Today'),
  '7d': () => t('taskHistory.period.week', 'Last 7 days'),
  '30d': () => t('taskHistory.period.month', 'Last 30 days'),
  all: () => t('taskHistory.period.all', 'All time')
}
const SORT_LABELS = {
  date: () => t('taskHistory.sort.date', 'Newest first'),
  cost: () => t('taskHistory.sort.cost', 'Highest cost'),
  time: () => t('taskHistory.sort.time', 'Longest time')
}

// This workspace's tasks, or all of them (a workspace unknown: all).
const inScope = computed(() =>
  scope.value === 'workspace' && props.workspaceId ? taskHistory.filter((r) => r.wsId === props.workspaceId) : taskHistory
)
const options = computed(() => filterOptions(inScope.value))
const shown = computed(() =>
  sortHistory(filterHistory(inScope.value, { period: period.value, project: project.value, agent: agent.value, query: query.value }, props.now), sortBy.value)
)
const totals = computed(() => historyTotals(shown.value))

const livePanes = computed(() => {
  const ids = new Set()
  for (const p of props.projects || []) for (const pane of p.panes || []) ids.add(pane.id)
  return ids
})
const paneAlive = (r) => !!r.paneId && livePanes.value.has(r.paneId)

// --- Figures ---------------------------------------------------------------------

const api = () => (typeof window !== 'undefined' && window.shellApi && window.shellApi.jobCost) || null
let loading = false
let again = false
async function load() {
  if (!props.active) return
  if (loading) {
    again = true
    return
  }
  loading = true
  try {
    await loadHistoryCosts(taskHistory, { api: api(), isActive: () => props.active })
  } finally {
    loading = false
    if (again) {
      again = false
      void load()
    }
  }
}
let off = null
function listen(on) {
  if (off) {
    try {
      off()
    } catch {
      // gone
    }
    off = null
  }
  const a = api()
  if (!on || !a || typeof a.onChanged !== 'function') return
  try {
    const stop = a.onChanged(() => {
      // Something was written: the figures not final yet are read again.
      forgetAsked(taskHistory.filter((r) => !r.cost || !r.cost.final).map((r) => r.id))
      void load()
    })
    off = typeof stop === 'function' ? stop : null
  } catch {
    off = null
  }
}
watch(
  () => props.active,
  (on) => {
    listen(on)
    if (on) void load()
  },
  { immediate: true }
)
// A task finished while shown: its figures.
watch(
  () => taskHistory.length,
  () => void load()
)
onBeforeUnmount(() => listen(false))

// --- Text --------------------------------------------------------------------------

const unknownText = (n) => t('taskHistory.total.unknown', '{{count}} with an unknown cost (not counted)', { count: n })
const pendingText = (n) => t('taskHistory.total.pending', '{{count}} being read', { count: n })

function toggle(id) {
  // The rows that open or close are measured again.
  if (openId.value) heights.delete(openId.value)
  heights.delete(id)
  openId.value = openId.value === id ? null : id
}

// --- Rows drawn: only those in view ----------------------------------------------
// Under VIRTUAL_MIN rows all are drawn. Before the list is first measured, as
// many as fill a tall panel; a list measured without a size (never shown) all
// of them; hidden later (the tab left), the size it had is kept. A row drawn
// is measured (ResizeObserver: its details may grow while its
// figures are read); a row never drawn counts as a closed row's height.
const listEl = ref(null)
const scrollTop = ref(0)
const viewport = ref(0)
const listMeasured = ref(false)
const FIRST_VIEWPORT = 1200
const heights = new Map() // record id -> its measured height
const measured = ref(0) // bumped when a height changes
const closedHeight = ref(ROW_ESTIMATE)
const shownIds = computed(() => shown.value.map((r) => r.id))
const tops = computed(() => {
  void measured.value
  return rowTops(shownIds.value, (id) => heights.get(id), closedHeight.value)
})
const windowed = computed(() => {
  const list = shown.value
  const h = viewport.value || (listMeasured.value ? 0 : FIRST_VIEWPORT)
  if (list.length < VIRTUAL_MIN || !h) return { list, before: 0, after: 0, virtual: false }
  const { start, end, before, after } = visibleRange(tops.value, scrollTop.value, h)
  return { list: list.slice(start, end), before, after, virtual: true }
})

function noteHeight(el) {
  const id = el && el.dataset ? el.dataset.id : null
  const h = el ? el.offsetHeight : 0
  if (!id || !(h > 0) || heights.get(id) === h) return false
  heights.set(id, h)
  if (id !== openId.value) closedHeight.value = h
  return true
}
let rowObserver = null
const observed = new Set()
function measureRows() {
  const el = listEl.value
  if (!el) return
  let changed = false
  const items = el.querySelectorAll(':scope > .th-item')
  if (rowObserver) {
    // Rows scrolled out of view are no longer watched.
    for (const item of observed) {
      if (item.isConnected) continue
      rowObserver.unobserve(item)
      observed.delete(item)
    }
    for (const item of items) {
      if (observed.has(item)) continue
      observed.add(item)
      rowObserver.observe(item)
    }
  } else for (const item of items) if (noteHeight(item)) changed = true
  if (changed) measured.value++
}
onUpdated(measureRows)

let scrollQueued = false
const nextFrame = (fn) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(fn, 16))
function onListScroll(ev) {
  const el = ev && ev.target
  if (!el || scrollQueued) return
  scrollQueued = true
  nextFrame(() => {
    scrollQueued = false
    scrollTop.value = el.scrollTop
  })
}
function measureList() {
  const el = listEl.value
  if (!el) return
  listMeasured.value = true
  const h = el.clientHeight || 0
  // Hidden (v-show): the size it had stays, so the rows stay windowed.
  if (h > 0 || !viewport.value) viewport.value = h
  if (h > 0) scrollTop.value = el.scrollTop || 0
}
let listObserver = null
watch(
  listEl,
  (el) => {
    if (listObserver) listObserver.disconnect()
    if (rowObserver) rowObserver.disconnect()
    observed.clear()
    listObserver = null
    rowObserver = null
    measureList()
    if (el && typeof ResizeObserver === 'function') {
      listObserver = new ResizeObserver(() => measureList())
      listObserver.observe(el)
      rowObserver = new ResizeObserver((entries) => {
        let changed = false
        for (const e of entries) if (e.target.isConnected && noteHeight(e.target)) changed = true
        if (changed) measured.value++
      })
    }
    if (el) void nextTick(measureRows)
  },
  { flush: 'post' }
)
onBeforeUnmount(() => {
  if (listObserver) listObserver.disconnect()
  if (rowObserver) rowObserver.disconnect()
})

// --- CSV ---------------------------------------------------------------------------

function exportCsv() {
  const blob = new Blob(['﻿' + historyCsv(shown.value)], { type: 'text/csv;charset=utf-8' }) // i18n-ignore
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `task-history-${new Date().toISOString().slice(0, 10)}.csv` // i18n-ignore
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
</script>

<template>
  <div class="th-panel" data-test="task-history">
    <div class="th-head">
      <History :size="14" aria-hidden="true" class="th-head-icon" />
      <div class="th-title">{{ t('taskHistory.title', 'Task history') }}</div>
      <button
        type="button"
        class="th-icon-btn"
        :disabled="!shown.length"
        :title="t('taskHistory.export', 'Export as CSV')"
        :aria-label="t('taskHistory.export', 'Export as CSV')"
        data-test="history-export"
        @click="exportCsv"
      >
        <Download :size="14" aria-hidden="true" />
      </button>
    </div>

    <div class="sh-scope th-scope" role="group" :aria-label="t('taskHistory.scope.aria', 'Which tasks')" data-test="history-scopes">
      <button
        v-for="sc in ['workspace', 'all']"
        :key="sc"
        type="button"
        class="sh-scope-btn"
        :class="{ on: scope === sc }"
        :disabled="sc === 'workspace' && !workspaceId"
        :aria-pressed="scope === sc ? 'true' : 'false'"
        :data-test="'history-scope-' + sc"
        @click="scope = sc"
      >
        {{ sc === 'workspace' ? t('taskHistory.scope.workspace', 'This workspace') : t('taskHistory.scope.all', 'All workspaces') }}
      </button>
    </div>

    <div class="th-totals" data-test="history-totals">
      <div class="th-stat">
        <span class="th-stat-value" data-test="total-tasks">{{ totals.tasks }}</span>
        <span class="th-stat-label">{{ totals.tasks === 1 ? t('taskHistory.total.tasks', 'task', { count: 1 }) : t('taskHistory.total.tasks', 'tasks', { count: totals.tasks }) }}</span>
      </div>
      <div class="th-stat">
        <span class="th-stat-value" data-test="total-time">{{ duration(totals.durationMs) }}</span>
        <span class="th-stat-label">{{ t('taskHistory.total.time', 'time') }}</span>
      </div>
      <div class="th-stat" :title="tokensTitle({ status: 'ok', ...totals })">
        <span class="th-stat-value" data-test="total-tokens">{{ formatTokens(totals.tokens) }}</span>
        <span class="th-stat-label">{{ t('taskHistory.total.tokens', 'tokens') }}</span>
      </div>
      <div class="th-stat" :title="estimateHint()">
        <span class="th-stat-value" data-test="total-cost">{{ totals.priced ? usdText(totals.usd) : '—' }}</span>
        <span class="th-stat-label">{{ t('taskHistory.total.cost', 'est. cost') }}</span>
      </div>
      <div v-if="totals.unknown || totals.pending" class="th-totals-note" data-test="total-note">
        <span v-if="totals.unknown">{{ unknownText(totals.unknown) }}</span>
        <span v-if="totals.pending">{{ pendingText(totals.pending) }}</span>
      </div>
    </div>

    <div class="th-filters">
      <ThemedSelect v-model="period" class="th-select" :title="t('taskHistory.filter.period', 'Period')" data-test="history-period">
        <option v-for="p in PERIODS" :key="p" :value="p">{{ PERIOD_LABELS[p]() }}</option>
      </ThemedSelect>
      <ThemedSelect v-model="project" class="th-select" :title="t('taskHistory.filter.project', 'Project')" data-test="history-project">
        <option value="">{{ t('taskHistory.filter.allProjects', 'All projects') }}</option>
        <option v-for="p in options.projects" :key="p" :value="p">{{ p }}</option>
      </ThemedSelect>
      <ThemedSelect v-model="agent" class="th-select" :title="t('taskHistory.filter.agent', 'Agent')" data-test="history-agent">
        <option value="">{{ t('taskHistory.filter.allAgents', 'All agents') }}</option>
        <option v-for="a in options.agents" :key="a" :value="a">{{ a }}</option>
      </ThemedSelect>
      <ThemedSelect v-model="sortBy" class="th-select" :title="t('taskHistory.filter.sort', 'Sort')" data-test="history-sort">
        <option v-for="s in ['date', 'cost', 'time']" :key="s" :value="s">{{ SORT_LABELS[s]() }}</option>
      </ThemedSelect>
      <label class="th-search">
        <Search :size="12" aria-hidden="true" />
        <input
          v-model="query"
          type="search"
          :placeholder="t('taskHistory.search', 'Search titles')"
          :aria-label="t('taskHistory.search', 'Search titles')"
          data-test="history-search"
        />
      </label>
    </div>

    <div ref="listEl" class="th-list" role="list" data-test="history-list" @scroll="onListScroll">
      <PanelState v-if="!boardState.loaded" data-test="history-loading" />
      <PanelState
        v-else-if="boardState.error && !taskHistory.length"
        kind="error"
        :retry="false"
        :text="t('tasks.board.loadFailed', 'The saved task board could not be read: {{error}}', { error: boardState.error })"
        data-test="history-error"
      />
      <div v-else-if="!taskHistory.length" class="th-empty" data-test="history-empty">
        {{ t('taskHistory.empty', 'No finished task yet. Tasks moved to Done on the task board appear here.') }}
      </div>
      <div v-else-if="!shown.length" class="th-empty" data-test="history-none">{{ t('taskHistory.noMatch', 'No task matches these filters.') }}</div>
      <div v-if="windowed.before" class="th-spacer" aria-hidden="true" :style="{ height: windowed.before + 'px' }"></div>
      <TaskHistoryRow
        v-for="r in windowed.list"
        :key="r.id"
        :record="r"
        :open="openId === r.id"
        :alive="paneAlive(r)"
        @toggle="toggle"
        @focus-pane="(id) => emit('focus-pane', id)"
      />
      <div v-if="windowed.after" class="th-spacer" aria-hidden="true" :style="{ height: windowed.after + 'px' }"></div>
    </div>
  </div>
</template>

<style scoped>
.th-scope {
  flex: 0 0 auto;
  margin: 0 0 8px;
}
.th-panel {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
  background: var(--surface);
  color: var(--text);
  font-size: 12.5px;
}
.th-head {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
}
.th-head-icon {
  color: var(--text-dim);
}
.th-title {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--text-strong);
  font-size: 12px;
  font-weight: 600;
}
.th-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
}
.th-icon-btn:hover:not(:disabled) {
  background: var(--surface-3);
  color: var(--text-strong);
}
.th-icon-btn:disabled {
  opacity: 0.4;
  cursor: default;
}
.th-totals {
  display: grid;
  flex: 0 0 auto;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
}
.th-stat {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.th-stat-value {
  overflow: hidden;
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.th-stat-label,
.th-totals-note {
  color: var(--text-dim);
  font-size: 11px;
}
.th-totals-note {
  display: flex;
  grid-column: 1 / -1;
  flex-wrap: wrap;
  gap: 8px;
}
.th-filters {
  display: flex;
  flex: 0 0 auto;
  flex-wrap: wrap;
  gap: 4px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
}
.th-select {
  flex: 1 1 100px;
  min-width: 0;
}
.th-search {
  display: flex;
  flex: 1 1 100%;
  align-items: center;
  gap: 4px;
  padding: 0 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-2);
  color: var(--text-dim);
}
.th-search input {
  flex: 1 1 auto;
  min-width: 0;
  height: 24px;
  border: 0;
  background: transparent;
  color: var(--text);
  font: inherit;
  outline: none;
}
.th-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}
.th-empty {
  padding: 16px 12px;
  color: var(--text-dim);
}
.th-spacer {
  flex: 0 0 auto;
}
</style>
