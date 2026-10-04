<script setup>
// Task history (a tab of the right side panel): every finished task, from
// its record (taskHistory.js; kept after the card is deleted), with when it
// was done, who did it, the project, its time in Doing, its tokens and its
// estimated cost. Filters (period, project, agent, title), sort (date, cost,
// time), totals of what is shown, a row's details (work periods, cost per
// model) and a CSV export. The figures are read through
// window.shellApi.jobCost.forCards in batches, only while the tab is shown,
// and kept in the records (taskHistoryView.js).
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { History, Download, Search, ChevronRight, ChevronDown, ExternalLink } from 'lucide-vue-next'
import ThemedSelect from './ui/ThemedSelect.vue'
import BrandIcon from './BrandIcon.vue'
import { taskHistory } from '../taskHistory'
import { filterHistory, sortHistory, historyTotals, filterOptions, historyCsv, loadHistoryCosts, forgetAsked, pricedUsd, PERIODS } from '../taskHistoryView'
import { formatTokens, costText } from '../jobCost'
import { formatCost } from '../../../shared/modelPricing'
import { modelLabel } from '../../../shared/modelLabel'
import { formatDuration } from '../timeFormat'
import { t, intlLocale, currentLocale } from '../i18n'

const props = defineProps({
  // App's sidebarProjects: which agent panes still exist.
  projects: { type: Array, default: () => [] },
  // The tab is shown: the figures are read only then.
  active: { type: Boolean, default: false },
  now: { type: Number, default: () => Date.now() }
})
const emit = defineEmits(['focus-pane'])

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

const options = computed(() => filterOptions(taskHistory))
const shown = computed(() =>
  sortHistory(filterHistory(taskHistory, { period: period.value, project: project.value, agent: agent.value, query: query.value }, props.now), sortBy.value)
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

const dateFmt = computed(() => (currentLocale(), new Intl.DateTimeFormat(intlLocale(), { dateStyle: 'short', timeStyle: 'short' })))
const timeFmt = computed(() => (currentLocale(), new Intl.DateTimeFormat(intlLocale(), { timeStyle: 'short' })))
const when = (ms) => (ms ? dateFmt.value.format(new Date(ms)) : '')
const duration = (ms) => (ms > 0 ? formatDuration(ms) : '—')
const tokensOf = (c) => (c ? (c.inputTokens || 0) + (c.outputTokens || 0) : 0)

function tokensText(r) {
  if (!r.cost) return '…'
  if (r.cost.status !== 'ok') return '—'
  return formatTokens(tokensOf(r.cost))
}
function tokensTitle(c) {
  if (!c || c.status !== 'ok') return undefined
  return [
    t('jobCost.detail.input', 'Input: {{n}}', { n: formatTokens(c.inputTokens) }),
    t('jobCost.detail.output', 'Output: {{n}}', { n: formatTokens(c.outputTokens) }),
    t('jobCost.detail.cacheRead', 'Cache read: {{n}}', { n: formatTokens(c.cacheReadTokens) }),
    t('jobCost.detail.cacheWrite', 'Cache write: {{n}}', { n: formatTokens(c.cacheWriteTokens) })
  ].join('\n')
}
function costCell(r) {
  if (!r.cost) return '…'
  if (pricedUsd(r) === null) return t('taskHistory.unknown', 'unknown')
  return costText(r.cost) || '—'
}
const estimateHint = () => t('jobCost.detail.estimate', 'API-equivalent estimate (subscriptions are not billed per token)')
function usdText(usd) {
  const s = formatCost(usd, intlLocale())
  return s.startsWith('<') ? s : `~${s}` // i18n-ignore
}

const REASONS = {
  'no-session': () => t('taskHistory.reason.noSession', 'No agent session was seen for its pane.'),
  'missing-file': () => t('taskHistory.reason.missingFile', "The agent's session file could not be found."),
  remote: () => t('taskHistory.reason.remote', 'The agent ran on another computer.'),
  'unsupported-agent': () => t('taskHistory.reason.unsupported', 'Tessel cannot read the usage of this agent.'),
  'invalid-session': () => t('taskHistory.reason.invalidSession', 'The session id is not valid.'),
  'no-pane': () => t('taskHistory.reason.noPane', 'No agent pane worked on it.'),
  'not-started': () => t('taskHistory.reason.notStarted', 'It never went through Doing.'),
  'no-card': () => t('taskHistory.reason.noCard', 'Its card is gone and so is its record.'),
  error: () => t('taskHistory.reason.error', 'The figures could not be read.')
}
const reasonText = (c) => (c && REASONS[c.reason] ? REASONS[c.reason]() : t('taskHistory.reason.error', 'The figures could not be read.'))

const unknownText = (n) => t('taskHistory.total.unknown', '{{count}} with an unknown cost (not counted)', { count: n })
const pendingText = (n) => t('taskHistory.total.pending', '{{count}} being read', { count: n })
const subagentsText = (n) => (n === 1 ? t('taskHistory.detail.subagents', '{{count}} sub-agent', { count: 1 }) : t('taskHistory.detail.subagents', '{{count}} sub-agents', { count: n }))

function agentLabel(r) {
  return r.agentName || r.agentKind || t('taskHistory.noAgent', 'No agent')
}

function toggle(id) {
  openId.value = openId.value === id ? null : id
}

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

    <div class="th-list" role="list">
      <div v-if="!taskHistory.length" class="th-empty" data-test="history-empty">
        {{ t('taskHistory.empty', 'No finished task yet. Tasks moved to Done on the task board appear here.') }}
      </div>
      <div v-else-if="!shown.length" class="th-empty" data-test="history-none">{{ t('taskHistory.noMatch', 'No task matches these filters.') }}</div>
      <div v-for="r in shown" :key="r.id" class="th-item" role="listitem" :data-test="'history-row-' + r.id">
        <button type="button" class="th-row" :class="{ open: openId === r.id }" :aria-expanded="openId === r.id" @click="toggle(r.id)">
          <component :is="openId === r.id ? ChevronDown : ChevronRight" :size="12" class="th-chevron" aria-hidden="true" />
          <span class="th-main">
            <span class="th-line1">
              <span class="th-task" :title="r.title">{{ r.title }}</span>
              <span class="th-cost" :class="{ dim: pricedUsd(r) === null }" :title="estimateHint()" data-test="row-cost">{{ costCell(r) }}</span>
            </span>
            <span class="th-line2">
              <span class="th-date" data-test="row-date">{{ when(r.doneAt) }}</span>
              <span class="th-agent" data-test="row-agent"><BrandIcon v-if="r.agentKind" :kind="r.agentKind" :size="12" />{{ agentLabel(r) }}</span>
              <span v-if="r.project" class="th-project" data-test="row-project">{{ r.project }}</span>
              <span class="th-time" data-test="row-time">{{ duration(r.durationMs) }}</span>
              <span class="th-tokens" :title="tokensTitle(r.cost)" data-test="row-tokens">{{ tokensText(r) }}</span>
            </span>
          </span>
        </button>
        <div v-if="openId === r.id" class="th-detail" data-test="history-detail">
          <div class="th-detail-head">
            <span>{{ t('taskHistory.detail.periods', 'Work periods') }}</span>
            <button v-if="paneAlive(r)" type="button" class="th-open-btn" data-test="history-open-pane" @click="emit('focus-pane', r.paneId)">
              <ExternalLink :size="12" aria-hidden="true" />{{ t('taskHistory.detail.openPane', 'Open agent pane') }}
            </button>
          </div>
          <ul v-if="r.workPeriods && r.workPeriods.length" class="th-periods">
            <li v-for="(p, i) in r.workPeriods" :key="i">{{ when(p.start) }} – {{ timeFmt.format(new Date(p.end || p.start)) }} · {{ duration((p.end || p.start) - p.start) }}</li>
          </ul>
          <div v-else class="th-dim">{{ t('taskHistory.detail.noPeriods', 'No time in Doing was recorded.') }}</div>
          <template v-if="r.cost && r.cost.status === 'ok'">
            <div class="th-detail-head">{{ t('taskHistory.detail.models', 'Cost by model') }}</div>
            <table class="th-models" data-test="history-models"><tbody>
              <tr v-for="(m, i) in r.cost.models" :key="i">
                <td>{{ modelLabel(m.model) || m.model || t('taskHistory.detail.unknownModel', 'Unknown model') }}</td>
                <td :title="tokensTitle({ status: 'ok', ...m })">{{ formatTokens((m.inputTokens || 0) + (m.outputTokens || 0)) }}</td>
                <td :title="estimateHint()">{{ m.known && typeof m.usd === 'number' ? usdText(m.usd) : t('taskHistory.unknown', 'unknown') }}</td>
              </tr>
            </tbody></table>
            <div v-if="r.cost.subagents" class="th-dim" data-test="history-subagents">
              {{ subagentsText(r.cost.subagents) }}
            </div>
            <div v-if="r.cost.incomplete" class="th-dim">{{ t('taskHistory.detail.incomplete', 'Some of its panes could not be read: the figures may be low.') }}</div>
          </template>
          <div v-else-if="r.cost" class="th-dim" data-test="history-reason">{{ reasonText(r.cost) }}</div>
          <div v-else class="th-dim">{{ t('taskHistory.detail.reading', 'Reading the figures…') }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
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
.th-item {
  border-bottom: 1px solid var(--border);
}
.th-row {
  display: flex;
  width: 100%;
  align-items: flex-start;
  gap: 4px;
  padding: 6px 10px 6px 6px;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.th-row:hover,
.th-row.open {
  background: var(--surface-2);
}
.th-chevron {
  flex: 0 0 auto;
  margin-top: 2px;
  color: var(--text-dim);
}
.th-main {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-width: 0;
  gap: 2px;
}
.th-line1 {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.th-task {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--text-strong);
  white-space: nowrap;
  text-overflow: ellipsis;
}
.th-cost {
  flex: 0 0 auto;
  font-variant-numeric: tabular-nums;
}
.th-cost.dim {
  color: var(--text-dim);
}
.th-line2 {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 10px;
  color: var(--text-dim);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.th-agent {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.th-detail {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 4px 10px 10px 22px;
  background: var(--surface-2);
  font-size: 11.5px;
}
.th-detail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 4px;
  color: var(--text-strong);
  font-weight: 600;
}
.th-open-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  background: var(--surface-3);
  color: var(--text-strong);
  font: inherit;
  font-weight: 400;
  cursor: pointer;
}
.th-open-btn:hover {
  border-color: var(--accent);
}
.th-periods {
  margin: 0;
  padding-left: 16px;
  color: var(--text);
  font-variant-numeric: tabular-nums;
}
.th-models {
  border-collapse: collapse;
  font-variant-numeric: tabular-nums;
}
.th-models td {
  padding: 1px 12px 1px 0;
}
.th-dim {
  color: var(--text-dim);
}
</style>
