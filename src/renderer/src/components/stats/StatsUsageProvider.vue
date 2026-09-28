<!-- i18n-pending: text here does not go through t() yet -->
<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import StatsStatCard from './StatsStatCard.vue'
import StatsIcon from './StatsIcon.vue'
import StatsUsageChart from './StatsUsageChart.vue'
import StatsUsageShare from './StatsUsageShare.vue'
import { tokens, money, percent, time } from './statsFormat'
const props = defineProps({
  provider: String,
  label: String,
  model: Object,
  supported: Boolean,
  enabled: Boolean,
  loading: Boolean,
  error: String,
  range: String,
  scope: String
})
const emit = defineEmits(['enable', 'refresh', 'filter'])
const filtersOpen = ref(false)
const filterControl = ref(null)
const shareOpen = ref(false)
const RANGES = [
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
  { value: 'all', label: 'All time' }
]
const rangeLabel = computed(
  () => RANGES.find((range) => range.value === props.range)?.label || 'Last 30 days'
)
const scopeLabel = computed(() =>
  props.scope === 'tessel' ? 'Tessel worktrees only' : `All local ${props.label} usage`
)
const summary = computed(() => props.model?.summary || {})
const cards = computed(() =>
  props.provider === 'claude'
    ? [
        { label: 'Input tokens', value: tokens(summary.value.inputTokens), icon: 'tokens' },
        { label: 'Output tokens', value: tokens(summary.value.outputTokens), icon: 'activity' },
        { label: 'Cache read', value: tokens(summary.value.cacheReadTokens), icon: 'cache' },
        { label: 'Cache write', value: tokens(summary.value.cacheWriteTokens), icon: 'waypoints' },
        { label: 'Cache reuse rate', value: percent(summary.value.cacheReuseRate), icon: 'gauge' },
        {
          label: 'Zero-cache-read turns',
          value:
            summary.value.zeroCacheReadTurns !== null && summary.value.activityCount > 0
              ? percent(summary.value.zeroCacheReadTurns / summary.value.activityCount)
              : 'n/a',
          icon: 'cache'
        },
        {
          label: 'Sessions / Turns',
          value: `${summary.value.sessions ?? 'n/a'} / ${summary.value.activityCount ?? 'n/a'}`,
          icon: 'folder'
        },
        {
          label: 'Est. API-equivalent cost',
          value: money(summary.value.estimatedCostUsd),
          icon: 'money'
        }
      ]
    : [
        { label: 'Input tokens', value: tokens(summary.value.inputTokens), icon: 'tokens' },
        { label: 'Output tokens', value: tokens(summary.value.outputTokens), icon: 'activity' },
        { label: 'Cached input', value: tokens(summary.value.cachedInputTokens), icon: 'cache' },
        { label: 'Reasoning output', value: tokens(summary.value.reasoningTokens), icon: 'brain' },
        {
          label: 'Sessions / Events',
          value: `${summary.value.sessions ?? 'n/a'} / ${summary.value.activityCount ?? 'n/a'}`,
          icon: 'folder'
        },
        {
          label: 'Est. API-equivalent cost',
          value: money(summary.value.estimatedCostUsd),
          icon: 'money'
        }
      ]
)
const updated = computed(() =>
  props.model?.updatedAt
    ? `Updated ${new Date(props.model.updatedAt).toLocaleString()}`
    : 'Not scanned yet'
)
const sessions = computed(() =>
  [...(props.model?.sessions || [])].sort((a, b) => (b.last || 0) - (a.last || 0))
)
const groups = computed(() => [
  {
    title: 'By model',
    topLabel: 'Top model:',
    top: props.model?.topModel,
    rows: props.model?.byModel || []
  },
  {
    title: 'By project',
    topLabel: 'Top project:',
    top: props.model?.topProject,
    rows: props.model?.byProject || []
  }
])
function chooseFilter(kind, value) {
  emit('filter', { kind, value })
  filtersOpen.value = false
}
function outside(event) {
  if (!filterControl.value?.contains(event.target)) filtersOpen.value = false
}
onMounted(() => document.addEventListener('pointerdown', outside))
onBeforeUnmount(() => document.removeEventListener('pointerdown', outside))
</script>
<template>
  <section class="su-panel su-provider-pane" :data-test="'stats-pane-' + provider">
    <header class="su-section-head su-tracking-head">
      <div>
        <h3>{{ label }} Usage Tracking</h3>
        <p v-if="!supported" class="su-muted">
          No local {{ label }} usage reader is available in Tessel.
        </p>
        <p v-else-if="!enabled" class="su-muted">
          Reads local {{ label }} usage logs to show token, model, and session stats.
        </p>
        <p v-else class="su-muted">
          {{ updated }}<span v-if="loading"> &middot; Scanning...</span>
        </p>
      </div>
      <div v-if="supported" class="su-actions">
        <template v-if="enabled">
          <button
            v-if="model?.hasData && model.byDay?.length"
            type="button"
            class="su-icon-button"
            aria-label="Share usage"
            data-test="stats-share"
            @click="shareOpen = true"
          >
            <StatsIcon kind="share" />
          </button>
          <div ref="filterControl" class="su-filters-wrap">
            <button
              type="button"
              class="su-icon-button"
              :aria-label="label + ' usage options'"
              :aria-expanded="filtersOpen"
              data-test="stats-filters"
              @click="filtersOpen = !filtersOpen"
            >
              <StatsIcon kind="filters" />
            </button>
            <div
              v-if="filtersOpen"
              class="su-filters-menu"
              @keydown.escape.stop="filtersOpen = false"
            >
              <fieldset>
                <legend>Scope</legend>
                <label
                  ><input
                    type="radio"
                    :name="provider + '-scope'"
                    value="tessel"
                    :checked="scope === 'tessel'"
                    data-test="stats-scope-tessel"
                    @change="chooseFilter('scope', 'tessel')"
                  />Tessel worktrees only</label
                ><label
                  ><input
                    type="radio"
                    :name="provider + '-scope'"
                    value="all"
                    :checked="scope === 'all'"
                    data-test="stats-scope-all"
                    @change="chooseFilter('scope', 'all')"
                  />All local {{ label }} usage</label
                >
              </fieldset>
              <fieldset>
                <legend>Range</legend>
                <label v-for="option in RANGES" :key="option.value"
                  ><input
                    type="radio"
                    :name="provider + '-range'"
                    :value="option.value"
                    :checked="range === option.value"
                    :data-test="'stats-range-' + option.value"
                    @change="chooseFilter('range', option.value)"
                  />{{ option.label }}</label
                >
              </fieldset>
            </div>
          </div>
          <button
            type="button"
            class="su-icon-button"
            :disabled="loading"
            :aria-label="'Refresh ' + label + ' usage'"
            data-test="stats-provider-refresh"
            @click="emit('refresh')"
          >
            <StatsIcon kind="refresh" />
          </button>
        </template>
        <button
          type="button"
          class="su-switch"
          role="switch"
          :aria-checked="enabled"
          :aria-label="'Enable ' + label + ' usage analytics'"
          data-test="stats-tracking-toggle"
          @click="emit('enable', !enabled)"
        >
          <span></span>
        </button>
      </div>
    </header>
    <template v-if="supported && enabled">
      <p class="su-muted su-selection-summary">{{ scopeLabel }} &middot; {{ rangeLabel }}</p>
      <p v-if="error" class="su-error" role="alert">
        Last scan error: {{ error
        }}<span v-if="model?.hasData"> Showing the last successful scan for this scope.</span>
      </p>
      <p v-for="warning in model?.warnings || []" :key="warning" class="su-muted">{{ warning }}</p>
      <div v-if="loading && !model?.hasData" class="su-loading" role="status" aria-live="polite">
        <p>Scanning local usage logs...</p>
        <div class="su-cards" :class="provider === 'claude' ? 'su-cards-four' : 'su-cards-three'">
          <div v-for="n in provider === 'claude' ? 8 : 6" :key="n" class="su-card su-skeleton">
            <span></span><strong></strong>
          </div>
        </div>
      </div>
      <p v-else-if="!model?.hasData && !error" class="su-empty">
        No local {{ label }} usage found yet for this scope.
      </p>
      <template v-else-if="model?.hasData">
        <div
          class="su-cards"
          :class="provider === 'claude' ? 'su-cards-four' : 'su-cards-three'"
          data-test="stats-provider-cards"
        >
          <StatsStatCard
            v-for="card in cards"
            :key="card.label"
            :label="card.label"
            :value="card.value"
            :icon="card.icon"
          />
        </div>
        <p class="su-muted su-metric-note">
          {{
            provider === 'claude'
              ? 'Cache reuse rate is calculated as cache read tokens / (input tokens + cache read tokens).'
              : 'Reasoning tokens are shown for visibility. Cached input and reasoning output are included in input and output totals.'
          }}
        </p>
        <p v-if="provider === 'codex'" class="su-muted">
          API-equivalent cost is unavailable: no verified Codex pricing is provided by this local
          report.
        </p>
        <p v-else class="su-muted">
          API-equivalent cost is an estimate, not your subscription bill.<span
            v-if="summary.hasUnpricedModels"
          >
            Some model prices are unavailable.</span
          >
        </p>
        <p class="su-muted su-source-note">{{ model.scopeLabel }}. {{ model.turnsMeaning }}</p>
        <StatsUsageChart :provider="provider" :daily="model.byDay" />
        <div class="su-breakdowns">
          <section v-for="group in groups" :key="group.title" class="su-panel">
            <h4>{{ group.title }}</h4>
            <p class="su-muted">{{ group.topLabel }} {{ group.top || 'n/a' }}</p>
            <div class="su-breakdown-rows">
              <div v-for="row in group.rows.slice(0, 5)" :key="row.key">
                <div class="su-breakdown-line">
                  <span>{{ row.label }}</span
                  ><span>{{
                    tokens(
                      provider === 'claude' ? row.inputTokens + row.outputTokens : row.totalTokens
                    )
                  }}</span>
                </div>
                <p class="su-muted">
                  {{ row.sessions ?? 'n/a' }} sessions &middot; {{ row.activityCount }}
                  {{ provider === 'claude' ? 'turns' : 'events' }}
                  <span v-if="row.hasInferredPricing"> &middot; inferred pricing</span>
                  <span v-if="row.estimatedCostUsd !== null">
                    &middot; {{ money(row.estimatedCostUsd) }}</span
                  >
                </p>
              </div>
            </div>
          </section>
        </div>
        <section class="su-panel su-sessions">
          <h4>Recent sessions</h4>
          <p class="su-muted">
            {{
              provider === 'claude'
                ? 'Cache reuse rate: ' + percent(summary.cacheReuseRate)
                : 'Most recent local Codex sessions in this scope.'
            }}
          </p>
          <div class="su-table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Last active</th>
                  <th>Project</th>
                  <th>Model</th>
                  <th>{{ provider === 'claude' ? 'Turns' : 'Events' }}</th>
                  <th>Input</th>
                  <th>Output</th>
                  <th>{{ provider === 'claude' ? 'Cache' : 'Total' }}</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="session in sessions.slice(0, 10)"
                  :key="session.key"
                  :title="session.title || session.id"
                >
                  <td>{{ time(session.last) }}</td>
                  <td :title="session.cwd">
                    {{
                      session.projectLabel ||
                      session.cwd?.split(/[\\/]/).filter(Boolean).at(-1) ||
                      'Unknown project'
                    }}
                  </td>
                  <td>{{ session.model || 'Unknown' }}</td>
                  <td>{{ session.activityCount }}</td>
                  <td>{{ tokens(session.inputTokens) }}</td>
                  <td>{{ tokens(session.outputTokens) }}</td>
                  <td>
                    {{ tokens(provider === 'claude' ? session.cacheTokens : session.totalTokens) }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </template>
    </template>
    <StatsUsageShare
      v-if="shareOpen"
      :provider="provider"
      :label="label"
      :model="model"
      :range-label="rangeLabel"
      @close="shareOpen = false"
    />
  </section>
</template>
