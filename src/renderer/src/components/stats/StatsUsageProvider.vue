<script setup>
import { ref, computed, onMounted, onBeforeUnmount, useId } from 'vue'
import { Info } from 'lucide-vue-next'
import StatsStatCard from './StatsStatCard.vue'
import StatsIcon from './StatsIcon.vue'
import StatsUsageChart from './StatsUsageChart.vue'
import StatsUsageShare from './StatsUsageShare.vue'
import { tokens, money, percent, time } from './statsFormat'
import { t, intlLocale } from '../../i18n'
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
// About these numbers: the notes on the metrics, the cost and the source,
// in one tooltip by the selection (hover, or a click that keeps it open).
const tipHover = ref(false)
const tipPinned = ref(false)
const tipShown = computed(() => tipHover.value || tipPinned.value)
const tipId = `${useId()}-about` // i18n-ignore
function closeTip() {
  tipHover.value = false
  tipPinned.value = false
}
const RANGES = computed(() => [
  { value: '7d', label: t('stats.range.last7', 'Last 7 days') },
  { value: '30d', label: t('stats.range.last30', 'Last 30 days') },
  { value: '90d', label: t('stats.range.last90', 'Last 90 days') },
  { value: 'all', label: t('stats.range.all', 'All time') }
])
const rangeLabel = computed(
  () =>
    RANGES.value.find((range) => range.value === props.range)?.label ||
    t('stats.range.last30', 'Last 30 days')
)
const allLocal = computed(() =>
  t('stats.provider.scopeAll', 'All local {{name}} usage', { name: props.label })
)
const scopeLabel = computed(() =>
  props.scope === 'tessel' ? t('stats.provider.scopeTessel', 'Tessel projects only') : allLocal.value
)
const na = () => t('stats.na', 'n/a')
const summary = computed(() => props.model?.summary || {})
const cards = computed(() =>
  props.provider === 'claude'
    ? [
        {
          label: t('stats.provider.inputTokens', 'Input tokens'),
          value: tokens(summary.value.inputTokens),
          icon: 'tokens'
        },
        {
          label: t('stats.provider.outputTokens', 'Output tokens'),
          value: tokens(summary.value.outputTokens),
          icon: 'activity'
        },
        {
          label: t('stats.series.cacheRead', 'Cache read'),
          value: tokens(summary.value.cacheReadTokens),
          icon: 'cache'
        },
        {
          label: t('stats.series.cacheWrite', 'Cache write'),
          value: tokens(summary.value.cacheWriteTokens),
          icon: 'waypoints'
        },
        {
          label: t('stats.provider.cacheReuse', 'Cache reuse rate'),
          value: percent(summary.value.cacheReuseRate),
          icon: 'gauge'
        },
        {
          label: t('stats.provider.zeroCache', 'Zero-cache-read turns'),
          value:
            summary.value.zeroCacheReadTurns !== null && summary.value.activityCount > 0
              ? percent(summary.value.zeroCacheReadTurns / summary.value.activityCount)
              : na(),
          icon: 'cache'
        },
        {
          label: t('stats.provider.sessionsTurns', 'Sessions / Turns'),
          value: `${summary.value.sessions ?? na()} / ${summary.value.activityCount ?? na()}`,
          icon: 'folder'
        },
        {
          label: t('stats.provider.apiCost', 'Est. API-equivalent cost'),
          value: money(summary.value.estimatedCostUsd),
          icon: 'money'
        }
      ]
    : [
        {
          label: t('stats.provider.inputTokens', 'Input tokens'),
          value: tokens(summary.value.inputTokens),
          icon: 'tokens'
        },
        {
          label: t('stats.provider.outputTokens', 'Output tokens'),
          value: tokens(summary.value.outputTokens),
          icon: 'activity'
        },
        {
          label: t('stats.series.cachedInput', 'Cached input'),
          value: tokens(summary.value.cachedInputTokens),
          icon: 'cache'
        },
        {
          label: t('stats.provider.reasoningOutput', 'Reasoning output'),
          value: tokens(summary.value.reasoningTokens),
          icon: 'brain'
        },
        {
          label: t('stats.provider.sessionsEvents', 'Sessions / Events'),
          value: `${summary.value.sessions ?? na()} / ${summary.value.activityCount ?? na()}`,
          icon: 'folder'
        },
        {
          label: t('stats.provider.apiCost', 'Est. API-equivalent cost'),
          value: money(summary.value.estimatedCostUsd),
          icon: 'money'
        }
      ]
)
const updated = computed(() =>
  props.model?.updatedAt
    ? t('stats.updated', 'Updated {{time}}', {
        time: new Date(props.model.updatedAt).toLocaleString(intlLocale())
      })
    : t('stats.notScanned', 'Not scanned yet')
)
const sessions = computed(() =>
  [...(props.model?.sessions || [])].sort((a, b) => (b.last || 0) - (a.last || 0))
)
const groups = computed(() => [
  {
    id: 'model',
    title: t('stats.provider.byModel', 'By model'),
    topLabel: t('stats.provider.topModel', 'Top model:'),
    top: props.model?.topModel,
    rows: props.model?.byModel || []
  },
  {
    id: 'project',
    title: t('stats.provider.byProject', 'By project'),
    topLabel: t('stats.provider.topProject', 'Top project:'),
    top: props.model?.topProject,
    rows: props.model?.byProject || []
  }
])
function rowMeta(row) {
  return props.provider === 'claude'
    ? t('stats.provider.rowTurns', '{{sessions}} sessions · {{count}} turns', {
        sessions: row.sessions ?? na(),
        count: row.activityCount
      })
    : t('stats.provider.rowEvents', '{{sessions}} sessions · {{count}} events', {
        sessions: row.sessions ?? na(),
        count: row.activityCount
      })
}
const titleText = () =>
  t('stats.provider.title', '{{name}} Usage Tracking', { name: props.label })
const noReaderText = () =>
  t('stats.noReader', 'No local {{name}} usage reader is available in Tessel.', { name: props.label })
const introText = () =>
  t('stats.provider.intro', 'Reads local {{name}} usage logs to show token, model, and session stats.', { name: props.label })
const readFailedText = () =>
  t('stats.provider.readFailed', 'Could not read the {{name}} usage.', { name: props.label })
const emptyText = () =>
  t('stats.provider.empty', 'No local {{name}} usage found yet for this scope.', { name: props.label })
const recentHint = () =>
  props.provider === 'claude'
    ? t('stats.provider.cacheReuseValue', 'Cache reuse rate: {{value}}', {
        value: percent(summary.value.cacheReuseRate)
      })
    : props.provider === 'codex'
      ? t('stats.provider.recentCodex', 'Most recent local Codex sessions in this scope.')
      : t('stats.provider.recentOther', 'Most recent local {{name}} sessions in this scope.', { name: props.label })
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
        <h3>{{ titleText() }}</h3>
        <p v-if="!supported" class="su-muted">{{ noReaderText() }}</p>
        <p v-else-if="!enabled" class="su-muted">{{ introText() }}</p>
        <p v-else class="su-muted">
          {{ updated }}<span v-if="loading">
            &middot; {{ t('stats.provider.scanning', 'Scanning...') }}</span
          >
        </p>
      </div>
      <div v-if="supported" class="su-actions">
        <template v-if="enabled">
          <button
            v-if="model?.hasData && model.byDay?.length"
            type="button"
            class="su-icon-button"
            :aria-label="t('stats.share.title', 'Share usage')"
            data-test="stats-share"
            @click="shareOpen = true"
          >
            <StatsIcon kind="share" />
          </button>
          <div ref="filterControl" class="su-filters-wrap">
            <button
              type="button"
              class="su-icon-button"
              :aria-label="t('stats.provider.options', '{{name}} usage options', { name: label })"
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
                <legend>{{ t('stats.provider.scope', 'Scope') }}</legend>
                <label
                  ><input
                    type="radio"
                    :name="provider + '-scope'"
                    value="tessel"
                    :checked="scope === 'tessel'"
                    data-test="stats-scope-tessel"
                    @change="chooseFilter('scope', 'tessel')"
                  />{{ t('stats.provider.scopeTessel', 'Tessel projects only') }}</label
                ><label
                  ><input
                    type="radio"
                    :name="provider + '-scope'"
                    value="all"
                    :checked="scope === 'all'"
                    data-test="stats-scope-all"
                    @change="chooseFilter('scope', 'all')"
                  />{{ allLocal }}</label
                >
              </fieldset>
              <fieldset>
                <legend>{{ t('stats.provider.range', 'Range') }}</legend>
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
            :aria-label="t('stats.provider.refresh', 'Refresh {{name}} usage', { name: label })"
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
          :aria-label="t('stats.provider.enable', 'Enable {{name}} usage analytics', { name: label })"
          data-test="stats-tracking-toggle"
          @click="emit('enable', !enabled)"
        >
          <span></span>
        </button>
      </div>
    </header>
    <template v-if="supported && enabled">
      <div class="su-selection">
        <p class="su-muted su-selection-summary">{{ scopeLabel }} &middot; {{ rangeLabel }}</p>
        <span v-if="model?.hasData" class="su-info" @mouseenter="tipHover = true" @mouseleave="tipHover = false">
          <button
            type="button"
            class="su-icon-button su-info-btn"
            :aria-label="t('stats.provider.about', 'About these numbers')"
            :aria-describedby="tipId"
            :aria-expanded="tipShown"
            data-test="stats-about"
            @click="tipPinned = !tipPinned"
            @blur="tipPinned = false"
            @keydown.escape.stop="closeTip"
          >
            <Info :size="14" aria-hidden="true" />
          </button>
          <span :id="tipId" role="tooltip" class="su-tip" :hidden="!tipShown">
            <span>{{
              provider === 'claude'
                ? t('stats.provider.claudeMetricNote', 'Cache reuse rate is calculated as cache read tokens / (input tokens + cache read tokens).'
                  )
                : t('stats.provider.codexMetricNote', 'Reasoning tokens are shown for visibility. Cached input and reasoning output are included in input and output totals.'
                  )
            }}</span>
            <span v-if="provider === 'codex'">{{
              t('stats.provider.codexCost', 'API-equivalent cost is unavailable: no verified Codex pricing is provided by this local report.'
              )
            }}</span>
            <span v-else-if="provider === 'opencode'">{{
              t('stats.provider.opencodeCost', 'The cost is the one OpenCode recorded for each reply, not your subscription bill.')
            }}</span>
            <span v-else-if="provider === 'muse'">{{
              t('stats.provider.museCost', 'Muse Code records no price for its calls (your subscription covers them), so no cost is shown.')
            }}</span>
            <span v-else-if="provider === 'grok'">{{
              t('stats.provider.grokCost', 'The cost is the one Grok Build recorded for each turn (API prices), not your SuperGrok subscription bill.')
            }}</span>
            <span v-else
              >{{ t('stats.provider.claudeCost', 'API-equivalent cost is an estimate, not your subscription bill.')
              }}<template v-if="summary.hasUnpricedModels">
                {{ t('stats.provider.unpriced', 'Some model prices are unavailable.') }}</template
              ></span
            >
            <span class="su-source-note">{{ model.scopeLabel }}. {{ model.turnsMeaning }}</span>
          </span>
        </span>
      </div>
      <div v-if="error" class="set-callout warn" role="alert">
        <span class="set-callout-text"
          >{{ readFailedText()
          }}<template v-if="model?.hasData">
            {{
              t('stats.provider.lastScan', 'Showing the last successful scan for this scope.')
            }}</template
          ></span
        >
        <details class="set-more su-callout-more">
          <summary>{{ t('stats.details', 'Details') }}</summary>
          <p>{{ error }}</p>
        </details>
      </div>
      <p v-for="warning in model?.warnings || []" :key="warning" class="su-muted">{{ warning }}</p>
      <div v-if="loading && !model?.hasData" class="su-loading" role="status" aria-live="polite">
        <p>{{ t('stats.scanning', 'Scanning local usage logs...') }}</p>
        <div class="su-cards" :class="provider === 'claude' ? 'su-cards-four' : 'su-cards-three'">
          <div v-for="n in provider === 'claude' ? 8 : 6" :key="n" class="su-card su-skeleton">
            <span></span><strong></strong>
          </div>
        </div>
      </div>
      <p v-else-if="!model?.hasData && !error" class="su-empty">
        {{ emptyText() }}
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
        <StatsUsageChart :provider="provider" :daily="model.byDay" />
        <div class="su-breakdowns">
          <section v-for="group in groups" :key="group.id" class="su-panel">
            <h4>{{ group.title }}</h4>
            <p class="su-muted">{{ group.topLabel }} {{ group.top || na() }}</p>
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
                  {{ rowMeta(row) }}
                  <span v-if="row.hasInferredPricing">
                    &middot; {{ t('stats.provider.inferred', 'inferred pricing') }}</span
                  >
                  <span v-if="row.estimatedCostUsd !== null">
                    &middot; {{ money(row.estimatedCostUsd) }}</span
                  >
                </p>
              </div>
            </div>
          </section>
        </div>
        <section class="su-panel su-sessions">
          <h4>{{ t('stats.provider.recent', 'Recent sessions') }}</h4>
          <p class="su-muted">
            {{ recentHint() }}
          </p>
          <div class="su-table-scroll">
            <table>
              <thead>
                <tr>
                  <th>{{ t('stats.provider.lastActive', 'Last active') }}</th>
                  <th>{{ t('stats.provider.project', 'Project') }}</th>
                  <th>{{ t('stats.provider.model', 'Model') }}</th>
                  <th>
                    {{
                      provider === 'claude'
                        ? t('stats.provider.turns', 'Turns')
                        : t('stats.provider.events', 'Events')
                    }}
                  </th>
                  <th>{{ t('stats.series.input', 'Input') }}</th>
                  <th>{{ t('stats.series.output', 'Output') }}</th>
                  <th>
                    {{
                      provider === 'claude'
                        ? t('stats.mix.cache', 'Cache')
                        : t('stats.provider.total', 'Total')
                    }}
                  </th>
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
                      t('stats.provider.unknownProject', 'Unknown project')
                    }}
                  </td>
                  <td>{{ session.model || t('stats.provider.unknown', 'Unknown') }}</td>
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
